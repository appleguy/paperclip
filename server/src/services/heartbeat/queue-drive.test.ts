import { randomUUID } from "node:crypto";
import {
  agents, agentWakeupRequests, approvals, companies, createDb, heartbeatRuns,
  issueApprovals, issueRelations, issueThreadInteractions, issueTreeHolds, issues, type Db,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { issueService } from "../issues.js";
import { issueTreeControlService } from "../issue-tree-control.js";
import { createHeartbeatRunState } from "./run-state.js";
import { createHeartbeatQueueDrive, QUEUE_DRIVE_WAKE_REASON } from "./queue-drive.js";

type Dependencies = Parameters<typeof createHeartbeatQueueDrive>[1];

function dependencies(db: Db) {
  return {
    getAgent: createHeartbeatRunState(db).getAgent,
    getAgentInvokability: (agent: Parameters<Dependencies["getAgentInvokability"]>[0]) => evaluateAgentInvokabilityFromDb(db, agent),
    getSchedulingSuppression: vi.fn<Dependencies["getSchedulingSuppression"]>(async () => ({ suppressed: false, reason: null })),
    getWorktreeExecutionCutoff: vi.fn<Dependencies["getWorktreeExecutionCutoff"]>(async () => null),
    issuesSvc: issueService(db),
    treeControlSvc: issueTreeControlService(db),
    enqueueWakeup: vi.fn<Dependencies["enqueueWakeup"]>(),
  } satisfies Dependencies;
}

describe("queue drive lifecycle boundary", () => {
  it("stays quiet during construction and scheduling suppression", async () => {
    const access = vi.fn(() => { throw new Error("Unexpected database access"); });
    const db = new Proxy({}, { get: access }) as Db;
    const deps = dependencies(db);
    const drive = createHeartbeatQueueDrive(db, deps);
    expect(access).not.toHaveBeenCalled();
    deps.getSchedulingSuppression.mockResolvedValue({ suppressed: true, reason: "server_shutdown" });
    await drive.wakeNextAssignedIssueAfterRun({ id: "run", companyId: "company", agentId: "agent" });
    expect(access).not.toHaveBeenCalled();
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });
});

const postgres = await getEmbeddedPostgresTestSupport();
describe.skipIf(!postgres.supported)("queue drive persisted selection and debounce", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let deps: ReturnType<typeof dependencies>;
  let source: typeof heartbeatRuns.$inferSelect;
  let drive: ReturnType<typeof createHeartbeatQueueDrive>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-queue-drive-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    const [company] = await db.insert(companies).values({ name: "Queue Drive Co", status: "active",
      issuePrefix: `Q${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Queue worker", role: "engineer",
      status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {} }).returning();
    [source] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, invocationSource: "assignment",
      status: "succeeded", finishedAt: new Date() }).returning();
    deps = dependencies(db);
    // Persist the same receipt as real admission, without starting a provider.
    deps.enqueueWakeup.mockImplementation(async (agentId, opts = {}) => {
      await db.insert(agentWakeupRequests).values({ companyId: source.companyId, agentId, source: opts.source!,
        reason: opts.reason, status: "queued", idempotencyKey: opts.idempotencyKey, payload: opts.payload });
      return null;
    });
    drive = createHeartbeatQueueDrive(db, deps);
  });

  async function issue(overrides: Partial<typeof issues.$inferInsert> = {}) {
    const [row] = await db.insert(issues).values({ companyId: source.companyId, title: "Work",
      assigneeAgentId: source.agentId, status: "todo", priority: "medium", ...overrides }).returning();
    return row;
  }
  async function attempt(issueId: string, status: string, at: number) {
    const [row] = await db.insert(heartbeatRuns).values({ companyId: source.companyId, agentId: source.agentId,
      invocationSource: "assignment", status, contextSnapshot: { issueId },
      createdAt: new Date(at), finishedAt: new Date(at + 1000) }).returning();
    return row;
  }
  function picked() { return deps.enqueueWakeup.mock.calls[0]?.[1]?.payload?.issueId; }

  it("picks by priority then issue age, across todo and in-progress work", async () => {
    await issue({ priority: "low", createdAt: new Date(1) });
    await issue({ priority: "high", status: "in_progress", createdAt: new Date(2) });
    await issue({ priority: "critical", createdAt: new Date(4) });
    const oldestCritical = await issue({ priority: "critical", createdAt: new Date(3) });
    await drive.wakeNextAssignedIssueAfterRun(source);
    expect(picked()).toBe(oldestCritical.id);
    expect(deps.enqueueWakeup).toHaveBeenCalledWith(source.agentId, expect.objectContaining({
      reason: QUEUE_DRIVE_WAKE_REASON, source: "assignment", requestedByActorType: "system",
      issueStateGuard: { assigneeAgentId: source.agentId, statuses: ["todo", "in_progress"], statusVersion: oldestCritical.statusVersion },
    }));
  });

  it("skips blocked status, unresolved dependencies, owner decisions and approvals", async () => {
    const blocked = await issue({ status: "blocked", priority: "critical" });
    const dependent = await issue({ priority: "critical" });
    await db.insert(issueRelations).values({ companyId: source.companyId, issueId: blocked.id,
      relatedIssueId: dependent.id, type: "blocks" });
    const ownerGated = await issue({ priority: "critical" });
    await db.insert(issueThreadInteractions).values({ companyId: source.companyId, issueId: ownerGated.id,
      kind: "request_confirmation", status: "pending", effectiveResolverPolicy: "human_only",
      payload: { version: 1, prompt: "Approve?" } });
    const approvalGated = await issue({ priority: "critical" });
    const [approval] = await db.insert(approvals).values({ companyId: source.companyId, type: "hire_agent", status: "pending", payload: {} }).returning();
    await db.insert(issueApprovals).values({ companyId: source.companyId, issueId: approvalGated.id, approvalId: approval.id });
    const ready = await issue({ priority: "low" });
    await drive.wakeNextAssignedIssueAfterRun(source);
    expect(picked()).toBe(ready.id);
  });

  it.each([null, new Date()])("does not treat an unanswered historical question as an owner gate (dismissed: %s)", async dismissedAt => {
    const ready = await issue();
    await db.insert(issueThreadInteractions).values({ companyId: source.companyId, issueId: ready.id,
      kind: "ask_user_questions", status: "pending", effectiveResolverPolicy: "human_only",
      dismissedAt, payload: { version: 1, questions: [] } });
    await drive.wakeNextAssignedIssueAfterRun(source);
    expect(picked()).toBe(ready.id);
  });

  it("skips hidden, harness and backlog containers", async () => {
    await issue({ priority: "critical", hiddenAt: new Date() });
    await issue({ priority: "critical", harnessKind: "skill_test" });
    await issue({ priority: "critical", status: "backlog" });
    const ready = await issue({ priority: "low" });
    await drive.wakeNextAssignedIssueAfterRun(source);
    expect(picked()).toBe(ready.id);
  });

  it("debounces replayed completion callbacks across service instances", async () => {
    await issue();
    await issue();
    const other = createHeartbeatQueueDrive(db, deps);
    await drive.wakeNextAssignedIssueAfterRun(source);
    await other.wakeNextAssignedIssueAfterRun(source);
    expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, source.companyId))).toHaveLength(1);
  });

  it("tries the next candidate after admission refuses one, without replaying either receipt", async () => {
    const refused = await issue({ priority: "critical" });
    const ready = await issue({ priority: "low" });
    const enqueue = deps.enqueueWakeup.getMockImplementation()!;
    deps.enqueueWakeup.mockImplementation(async (agentId, opts = {}) => {
      if (opts.payload?.issueId !== refused.id) return enqueue(agentId, opts);
      await db.insert(agentWakeupRequests).values({ companyId: source.companyId, agentId,
        source: opts.source!, reason: "issue_rewake_throttled", status: "skipped",
        idempotencyKey: opts.idempotencyKey, payload: opts.payload });
      return null;
    });
    await drive.wakeNextAssignedIssueAfterRun(source);
    await createHeartbeatQueueDrive(db, deps).wakeNextAssignedIssueAfterRun(source);
    expect(deps.enqueueWakeup.mock.calls.map(call => call[1]?.payload?.issueId)).toEqual([refused.id, ready.id]);
  });

  it("after two consecutive per-issue failures skips to the next issue", async () => {
    const failing = await issue({ priority: "critical" });
    await attempt(failing.id, "failed", 1000);
    const ready = await issue({ priority: "low" });
    await attempt(ready.id, "succeeded", 2000); // Interleaved work cannot reset the failed issue.
    await attempt(failing.id, "timed_out", 3000);
    await drive.wakeNextAssignedIssueAfterRun(source);
    expect(picked()).toBe(ready.id);
  });

  it("permits one retry and resets the failure bound after a success", async () => {
    const retryable = await issue({ priority: "critical" });
    await attempt(retryable.id, "failed", 1000);
    await attempt(retryable.id, "succeeded", 2000);
    await attempt(retryable.id, "failed", 3000);
    await drive.wakeNextAssignedIssueAfterRun(source);
    expect(picked()).toBe(retryable.id);
  });

  it("stops when all issues have failed twice", async () => {
    const failing = await issue();
    await attempt(failing.id, "failed", 1000);
    await attempt(failing.id, "failed", 2000);
    await drive.wakeNextAssignedIssueAfterRun(source);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("skips inherited pause holds and retains pending cleanup ownership", async () => {
    const parent = await issue({ status: "blocked" });
    await issue({ priority: "critical", parentId: parent.id });
    await db.insert(issueTreeHolds).values({ companyId: source.companyId, rootIssueId: parent.id, mode: "pause", status: "active" });
    const ready = await issue({ priority: "low" });
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceFinalizationOwner: "cleanup-owner" } }).where(eq(heartbeatRuns.id, source.id));
    await drive.wakeNextAssignedIssueAfterRun(source);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ runnerProfileJson: {} }).where(eq(heartbeatRuns.id, source.id));
    await drive.wakeNextAssignedIssueAfterRun(source);
    expect(picked()).toBe(ready.id);
  });

  it.each(["paused", "terminated", "pending_approval"])("never wakes a %s agent", async status => {
    await issue();
    await db.update(agents).set({ status }).where(eq(agents.id, source.agentId));
    await drive.wakeNextAssignedIssueAfterRun(source);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it.each(["queued", "running", "scheduled_retry"])("leaves existing %s work in charge on a single-slot seat", async status => {
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, source.agentId));
    await issue();
    await db.insert(heartbeatRuns).values({ companyId: source.companyId, agentId: source.agentId,
      status, invocationSource: "assignment" });
    await drive.wakeNextAssignedIssueAfterRun(source);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it.each(["queued", "running", "scheduled_retry"])("drives an available slot around existing %s work", async status => {
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } } }).where(eq(agents.id, source.agentId));
    const busy = await issue({ priority: "critical" });
    const ready = await issue({ priority: "low" });
    await db.insert(heartbeatRuns).values({ companyId: source.companyId, agentId: source.agentId,
      status, invocationSource: "assignment", contextSnapshot: { issueId: busy.id } });
    await drive.wakeNextAssignedIssueAfterRun(source);
    expect(picked()).toBe(ready.id);
    expect(deps.enqueueWakeup).toHaveBeenCalledOnce();
  });

  it.each([
    { resultJson: { cancelledByActorType: "user" }, errorCode: null },
    { resultJson: { cancelledByActorType: "board" }, errorCode: null },
    { resultJson: {}, errorCode: "operator_interrupted" },
    { resultJson: {}, errorCode: null },
  ])("does not continue an operator cancellation: $resultJson $errorCode", async ({ resultJson, errorCode }) => {
    const held = await issue();
    await db.update(heartbeatRuns).set({ status: "cancelled", resultJson, errorCode,
      contextSnapshot: { issueId: held.id } }).where(eq(heartbeatRuns.id, source.id));
    await drive.wakeNextAssignedIssueAfterRun(source);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it.each(["chat_control_completed_source", "chat_control_recovery_proof_unresolved"])(
    "skips a nonretrying chat recovery outcome %s while driving other work", async errorCode => {
      const held = await issue({ priority: "critical" });
      const ready = await issue({ priority: "low" });
      await db.update(heartbeatRuns).set({ status: errorCode === "chat_control_completed_source" ? "cancelled" : "failed",
        errorCode, contextSnapshot: { issueId: held.id } }).where(eq(heartbeatRuns.id, source.id));
      await drive.wakeNextAssignedIssueAfterRun(source);
      expect(picked()).toBe(ready.id);
      expect(deps.enqueueWakeup).toHaveBeenCalledOnce();
    },
  );

  it.each(["cancelled", "interrupted"])("continues after a system %s", async status => {
    const ready = await issue();
    await db.update(heartbeatRuns).set({ status, resultJson: { cancelledByActorType: "system" } }).where(eq(heartbeatRuns.id, source.id));
    await drive.wakeNextAssignedIssueAfterRun(source);
    expect(picked()).toBe(ready.id);
    expect(deps.enqueueWakeup).toHaveBeenCalledOnce();
  });

  it("does not continue a running source", async () => {
    await issue();
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, source.id));
    await drive.wakeNextAssignedIssueAfterRun(source);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("revalidates company status and workspace cutoff", async () => {
    await issue({ createdAt: new Date(1) });
    deps.getWorktreeExecutionCutoff.mockResolvedValue(new Date(2));
    await drive.wakeNextAssignedIssueAfterRun(source);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
    deps.getWorktreeExecutionCutoff.mockResolvedValue(null);
    await db.update(companies).set({ status: "paused" }).where(eq(companies.id, source.companyId));
    await drive.wakeNextAssignedIssueAfterRun(source);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });
});
