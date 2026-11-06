import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveExternalTestDatabaseUrl } from "../../../__tests__/helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { createHeartbeatQueueTestDependencies } from "../../../__tests__/helpers/heartbeat-queue.js";
import { createHeartbeatQueue, shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake } from "../../../services/heartbeat/queue.js";
import { mergeCoalescedContextSnapshot } from "../../../services/heartbeat/run-preparation.js";
import { issueService } from "../../../services/issues.js";
import { createWakeQueue } from "../index.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_WAKE_QUEUE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("process wake admission and release", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("paperclip-process-wake-");
    db = createDb(external ?? database!.connectionString, { maxConnections: 4 });
  }, 20_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  beforeEach(async () => { await db.execute(sql`truncate table companies restart identity cascade`); });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Web", issuePrefix: "WEB", defaultResponsibleUserId: "owner" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Web dispatch", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Web reply", status: "in_progress", assigneeAgentId: agent.id, responsibleUserId: "owner" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "running", startedAt: new Date(), responsibleUserId: "owner", contextSnapshot: { issueId: issue.id } }).returning();
    await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, issue.id));
    const deps = createHeartbeatQueueTestDependencies(db);
    deps.getAgent.mockResolvedValue(agent);
    deps.liveRunExecutions.has.mockReturnValue(true);
    deps.instanceSettings.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false, enableNativeRunner: false } as never);
    deps.issuesSvc.listDependencyReadiness.mockImplementation(issueService(db).listDependencyReadiness);
    const wakeQueue = createWakeQueue(db, {
      resolveResponsibleUserId: async () => "owner",
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
      wakeAdmissionHelpers: { filterZombieCoalesceTarget: deps.filterZombieCoalesceTarget, mergeCoalescedContextSnapshot, shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake },
      recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
    });
    deps.wakeQueue.createAdmissionTransactionScope.mockImplementation(wakeQueue.createAdmissionTransactionScope);
    deps.wakeQueue.admitWakeBehindIssueExecution.mockImplementation(wakeQueue.admitWakeBehindIssueExecution);
    return { company, agent, issue, run, deps, wakeQueue, queue: createHeartbeatQueue(db, deps) };
  }

  it.each(["reply", "event"])("preserves a %s received during a running process and promotes it on completion", async kind => {
    const f = await fixture();
    const [comment] = kind === "reply" ? await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id, body: "Reply", authorUserId: "owner" }).returning() : [null];
    const context = { issueId: f.issue.id, ...(comment ? { wakeCommentId: comment.id } : {}) };
    await f.queue.enqueueWakeup(f.agent.id, { source: "on_demand", triggerDetail: "manual", reason: comment ? "issue_reopened_via_comment" : "process_event", requestedByActorType: "user", requestedByActorId: "owner", payload: { issueId: f.issue.id, ...(comment ? { commentId: comment.id } : {}) }, contextSnapshot: context });
    if (!comment) await f.queue.enqueueWakeup(f.agent.id, { source: "on_demand", triggerDetail: "manual", reason: "process_event", requestedByActorType: "user", requestedByActorId: "owner", payload: { issueId: f.issue.id }, contextSnapshot: context });
    const [pending] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agent.id));
    expect(pending).toMatchObject({ status: "deferred_issue_execution", runId: null });
    if (!comment) expect(pending.coalescedCount).toBe(1);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    const result = await f.wakeQueue.releaseIssueExecution({ companyId: f.company.id, runId: f.run.id, now: new Date() });
    expect(result.outcome.kind).toBe("promoted");
    const [delivered] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, pending.id));
    expect(delivered).toMatchObject({ status: "queued", runId: expect.any(String) });
    const [next] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, delivered.runId!));
    expect(next).toMatchObject({ status: "queued", agentId: f.agent.id, contextSnapshot: { issueId: f.issue.id } });
    expect(result.postCommitEffects).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "run_queued", run: expect.objectContaining({ id: next.id }) })]));
  });

  it("reconstructs an event left behind by a completed process after restart", async () => {
    const f = await fixture();
    await f.queue.enqueueWakeup(f.agent.id, { source: "on_demand", triggerDetail: "manual", reason: "process_event", requestedByActorType: "user", requestedByActorId: "owner", payload: { issueId: f.issue.id }, contextSnapshot: { issueId: f.issue.id } });
    const [pending] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agent.id));
    expect(pending.status).toBe("deferred_issue_execution");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issue.id));
    f.deps.releaseIssueExecutionAndPromote.mockImplementation(async (run, options) => {
      await f.wakeQueue.releaseIssueExecution({ companyId: run.companyId, runId: run.id, now: new Date(), ...options });
    });
    await f.queue.resumeQueuedRuns();
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), { suppressImmediateRecovery: true, resumeStrandedQueue: true });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, pending.id)))[0]).toMatchObject({ status: "queued", runId: expect.any(String) });
  });

  it("preserves a deferred process wake while its agent is paused", async () => {
    const f = await fixture();
    await f.queue.enqueueWakeup(f.agent.id, { source: "on_demand", reason: "process_event", payload: { issueId: f.issue.id }, contextSnapshot: { issueId: f.issue.id } });
    const [pending] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agent.id));
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agent.id));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    await f.wakeQueue.releaseIssueExecution({ companyId: f.company.id, runId: f.run.id, now: new Date() });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, pending.id)))[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id))).toHaveLength(1);
  });

  it("keeps a reply saved when a stopped process has an unresolved execution outcome", async () => {
    const f = await fixture();
    const [comment] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id, body: "Reply", authorUserId: "owner" }).returning();
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId: f.company.id, sourceIssueId: f.issue.id,
      kind: "active_run_watchdog", ownerType: "board", cause: "legacy_execution_requires_reconciliation", status: "open",
      fingerprint: f.run.id, evidence: { automaticRecovery: { replay: "blocked" } }, nextAction: "Reconcile the external execution." }).returning();
    const [pending] = await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id, source: "automation",
      reason: "issue_reopened_via_comment", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "owner",
      payload: { issueId: f.issue.id, commentId: comment.id, executionWait: { reason: "execution_recovery", recoveryActionId: hold.id },
        _paperclipWakeContext: { issueId: f.issue.id, wakeReason: "issue_reopened_via_comment", wakeCommentIds: [comment.id] } } }).returning();
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "agent_paused", finishedAt: new Date(),
      resultJson: { executionCancellation: { state: "acknowledged" } } }).where(eq(heartbeatRuns.id, f.run.id));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issue.id));
    await f.wakeQueue.releaseIssueExecution({ companyId: f.company.id, runId: f.run.id, now: new Date(), resumeStrandedQueue: true });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, pending.id)))[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id))).toHaveLength(1);
  });
});
