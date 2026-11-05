import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb,
  heartbeatRuns, issueThreadInteractions, issues, type Db,
} from "@paperclipai/db";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createHeartbeatQueueDrive, QUEUE_DRIVE_WAKE_REASON } from "../services/heartbeat/queue-drive.js";
import { createHeartbeatRunState } from "../services/heartbeat/run-state.js";
import { evaluateAgentInvokabilityFromDb } from "../services/agent-invokability.js";
import { issueService } from "../services/issues.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";

const execute = vi.hoisted(() => vi.fn<(context: AdapterExecutionContext) => Promise<{
  exitCode: number; signal: null; timedOut: boolean; errorMessage: null; summary: string; provider: string; model: string;
}>>());
vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
  return { ...actual, getServerAdapter: vi.fn((type: string) => ({ type, supportsLocalAgentJwt: false, execute })) };
});

const postgres = await getEmbeddedPostgresTestSupport();
describe.skipIf(!postgres.supported)("heartbeat completion queue-drive", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let heartbeat: ReturnType<typeof heartbeatService>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("heartbeat-queue-drive-integration-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
    await db.insert(authUsers).values({ id: "queue-owner", name: "Queue owner", email: "queue@example.test",
      createdAt: new Date(), updatedAt: new Date() });
  }, 30_000);
  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    await database?.cleanup();
  });

  async function fixture(adapterType = "http") {
    const [company] = await db.insert(companies).values({ name: "Completion queue", status: "active",
      issuePrefix: `Q${randomUUID().slice(0, 6).toUpperCase()}`, defaultResponsibleUserId: "queue-owner" }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: "queue-owner",
      membershipRole: "member", status: "active" });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Queue worker", role: "engineer",
      status: "idle", adapterType, adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } }).returning();
    const addIssue = async (title: string, priority: string, age = 1) => {
      const [issue] = await db.insert(issues).values({ companyId: company.id, assigneeAgentId: agent.id, title, priority,
        status: "todo", responsibleUserId: "queue-owner", createdAt: new Date(age) }).returning();
      return issue;
    };
    const executed: string[] = [];
    execute.mockImplementation(async input => {
      const issueId = String(input.context.issueId);
      executed.push(issueId);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Delivered assigned work.", provider: "test", model: "test-model" };
    });
    return { company, agent, addIssue, executed };
  }

  it("drains unqueued assigned work by priority and age with timers disabled", async () => {
    const f = await fixture();
    const seed = await f.addIssue("Initial run", "low");
    const low = await f.addIssue("Later low priority", "low");
    const newer = await f.addIssue("Newer high priority", "high", 3);
    const older = await f.addIssue("Older high priority", "high", 2);
    const gated = await f.addIssue("Owner decision", "critical");
    await db.insert(issueThreadInteractions).values({ companyId: f.company.id, issueId: gated.id,
      kind: "request_confirmation", status: "pending", effectiveResolverPolicy: "human_only",
      payload: { version: 1, prompt: "Approve delivery?" } });
    await heartbeat.wakeup(f.agent.id, { source: "assignment", reason: "issue_assigned", payload: { issueId: seed.id },
      contextSnapshot: { issueId: seed.id } });
    await heartbeat.drainActiveRunExecutions();
    expect(f.executed).toEqual([seed.id, older.id, newer.id, low.id]);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.company.id)).orderBy(asc(heartbeatRuns.createdAt));
    expect(runs).toHaveLength(4);
    expect(runs.every(run => run.status === "succeeded")).toBe(true);
    const wakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.company.id),
      eq(agentWakeupRequests.reason, QUEUE_DRIVE_WAKE_REASON)));
    expect(wakes).toHaveLength(3);
    expect(wakes.every(wake => wake.idempotencyKey?.startsWith("queue-drive:"))).toBe(true);
  }, 30_000);

  it("atomically debounces concurrent completion callbacks using real admission", async () => {
    const f = await fixture();
    const target = await f.addIssue("Single successor", "high");
    const [source] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      invocationSource: "assignment", status: "succeeded", finishedAt: new Date() }).returning();
    const deps = {
      getAgent: createHeartbeatRunState(db).getAgent,
      getAgentInvokability: (agent: Parameters<typeof evaluateAgentInvokabilityFromDb>[1]) => evaluateAgentInvokabilityFromDb(db, agent),
      getSchedulingSuppression: async () => ({ suppressed: false, reason: null }),
      getWorktreeExecutionCutoff: async () => null,
      issuesSvc: issueService(db), treeControlSvc: issueTreeControlService(db), enqueueWakeup: heartbeat.wakeup,
    } as const;
    await Promise.all([
      createHeartbeatQueueDrive(db, deps).wakeNextAssignedIssueAfterRun(source),
      createHeartbeatQueueDrive(db, deps).wakeNextAssignedIssueAfterRun(source),
    ]);
    await heartbeat.drainActiveRunExecutions();
    expect(f.executed).toEqual([target.id]);
    const receipts = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.company.id),
      eq(agentWakeupRequests.idempotencyKey, `queue-drive:${source.id}:${target.id}`)));
    expect(receipts).toHaveLength(1);
  }, 30_000);

  it("does not drive a local adapter without process-tree settlement evidence", async () => {
    const f = await fixture("codex_local");
    const seed = await f.addIssue("Initial run", "low");
    await f.addIssue("Work held for cleanup", "critical");
    await heartbeat.wakeup(f.agent.id, { source: "assignment", reason: "issue_assigned",
      payload: { issueId: seed.id }, contextSnapshot: { issueId: seed.id } });
    await heartbeat.drainActiveRunExecutions();
    expect(f.executed).toEqual([seed.id]);
  }, 30_000);

  it.each(["cancelled", "interrupted"])("drives assigned work after a system %s run", async status => {
    const f = await fixture();
    const target = await f.addIssue("Resume held assignment", "critical");
    const [source] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      invocationSource: "assignment", status, errorCode: "issue_assignee_changed", finishedAt: new Date() }).returning();
    const drive = createHeartbeatQueueDrive(db, {
      getAgent: createHeartbeatRunState(db).getAgent,
      getAgentInvokability: agent => evaluateAgentInvokabilityFromDb(db, agent),
      getSchedulingSuppression: async () => ({ suppressed: false, reason: null }),
      getWorktreeExecutionCutoff: async () => null,
      issuesSvc: issueService(db), treeControlSvc: issueTreeControlService(db), enqueueWakeup: heartbeat.wakeup,
    });
    await drive.wakeNextAssignedIssueAfterRun(source);
    await heartbeat.drainActiveRunExecutions();
    expect(f.executed).toEqual([target.id]);
  }, 30_000);

  it("fills a free slot while another issue is still running", async () => {
    const f = await fixture();
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 2 } } })
      .where(eq(agents.id, f.agent.id));
    const busy = await f.addIssue("Existing busy issue", "critical");
    const target = await f.addIssue("Work for free slot", "high");
    const [active] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      invocationSource: "assignment", status: "running", issueId: busy.id, contextSnapshot: { issueId: busy.id } }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      invocationSource: "assignment", status: "succeeded", finishedAt: new Date() }).returning();
    const drive = createHeartbeatQueueDrive(db, {
      getAgent: createHeartbeatRunState(db).getAgent,
      getAgentInvokability: agent => evaluateAgentInvokabilityFromDb(db, agent),
      getSchedulingSuppression: async () => ({ suppressed: false, reason: null }),
      getWorktreeExecutionCutoff: async () => null,
      issuesSvc: issueService(db), treeControlSvc: issueTreeControlService(db), enqueueWakeup: heartbeat.wakeup,
    });
    try {
      await drive.wakeNextAssignedIssueAfterRun(source);
      await heartbeat.drainActiveRunExecutions();
      expect(f.executed).toEqual([target.id]);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, active.id)))[0].status).toBe("running");
    } finally {
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, active.id));
    }
  }, 30_000);

  it("preserves a human cancellation", async () => {
    const f = await fixture();
    await f.addIssue("Stopped work", "critical");
    const [source] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      invocationSource: "assignment", status: "cancelled", finishedAt: new Date(),
      resultJson: { cancelledByActorType: "user" } }).returning();
    const enqueueWakeup = vi.fn();
    await createHeartbeatQueueDrive(db, {
      getAgent: createHeartbeatRunState(db).getAgent,
      getAgentInvokability: agent => evaluateAgentInvokabilityFromDb(db, agent),
      getSchedulingSuppression: async () => ({ suppressed: false, reason: null }),
      getWorktreeExecutionCutoff: async () => null,
      issuesSvc: issueService(db), treeControlSvc: issueTreeControlService(db), enqueueWakeup,
    }).wakeNextAssignedIssueAfterRun(source);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("promotes a deferred assignment left behind by a cancelled former owner", async () => {
    const f = await fixture();
    const target = await f.addIssue("Reassigned held work", "critical");
    const [former] = await db.insert(agents).values({ companyId: f.company.id, name: "Former owner",
      status: "idle", adapterType: "http" }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: former.id,
      invocationSource: "assignment", status: "cancelled", errorCode: "issue_assignee_changed",
      finishedAt: new Date(), runtimeMode: "legacy", issueId: target.id, contextSnapshot: { issueId: target.id },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }).returning();
    await db.update(issues).set({ executionRunId: source.id }).where(eq(issues.id, target.id));
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id,
      source: "assignment", reason: "issue_assigned", status: "deferred_issue_execution",
      payload: { issueId: target.id } }).returning();
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.company.id, skipRelatedRecovery: true });
    await heartbeat.drainActiveRunExecutions();
    expect(f.executed).toEqual([target.id]);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0].status)
      .not.toBe("deferred_issue_execution");
  }, 30_000);

  it("does not wake successors when the agent is paused during the finishing run", async () => {
    const f = await fixture();
    const seed = await f.addIssue("Initial run", "low");
    await f.addIssue("Work held while paused", "critical");
    const executeTurn = execute.getMockImplementation()!;
    execute.mockImplementation(async input => {
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agent.id));
      return executeTurn(input);
    });
    await heartbeat.wakeup(f.agent.id, { source: "assignment", reason: "issue_assigned",
      payload: { issueId: seed.id }, contextSnapshot: { issueId: seed.id } });
    await heartbeat.drainActiveRunExecutions();
    expect(f.executed).toEqual([seed.id]);
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
    expect(agent.status).toBe("paused");
  }, 30_000);
});
