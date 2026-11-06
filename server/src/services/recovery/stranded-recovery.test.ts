import { randomUUID } from "node:crypto";
import { activityLog, agents, agentTaskSessions, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issueRelations, issueTreeHolds, issues } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { recoveryService } from "./service.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("stranded assigned issue recovery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("stranded-assignment-");
    db = createDb(database.connectionString);
    await db.insert(authUsers).values({ id: "stranded-owner", name: "Owner", email: "stranded@example.test",
      createdAt: new Date(), updatedAt: new Date() });
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(status = "failed", errorCode = "acpx_turn_failed") {
    const [company] = await db.insert(companies).values({ name: "Stranded recovery", status: "active",
      issuePrefix: `S${randomUUID().slice(0, 6)}`, defaultResponsibleUserId: "stranded-owner" }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: "stranded-owner",
      membershipRole: "member", status: "active" });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Stranded worker", role: "engineer",
      status: "idle", adapterType: "http", runtimeConfig: { heartbeat: { wakeOnDemand: true } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, assigneeAgentId: agent.id,
      responsibleUserId: "stranded-owner", title: "Continue held work", status: "in_progress" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
      invocationSource: "assignment", status, errorCode, finishedAt: new Date(), runtimeMode: "legacy",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { issueId: issue.id }, livenessState: status === "succeeded" ? "advanced" : null }).returning();
    const enqueueWakeup = vi.fn(async () => run);
    const scheduleRecoveryRetry = vi.fn(async () => null);
    const service = recoveryService(db, { enqueueWakeup, scheduleRecoveryRetry, transientRetryBudgetSpent: () => false });
    const sweep = () => service.reconcileStrandedAssignedIssues({ companyId: company.id, skipRelatedRecovery: true });
    return { company, agent, issue, run, enqueueWakeup, scheduleRecoveryRetry, sweep };
  }

  it.each(["company", "tree"])("leaves %s-held stranded work untouched until resumed", async scope => {
    const f = await fixture();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agent.id));
    let holdId: string | undefined;
    if (scope === "company") {
      await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.company.id));
    } else {
      const [hold] = await db.insert(issueTreeHolds).values({ companyId: f.company.id, rootIssueId: f.issue.id, mode: "pause" }).returning();
      holdId = hold.id;
    }
    expect(await f.sweep()).toMatchObject({ escalated: 0, continuationRequeued: 0 });
    expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].status).toBe("in_progress");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).toHaveLength(0);
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agent.id));
    if (holdId) await db.update(issueTreeHolds).set({ status: "released" }).where(eq(issueTreeHolds.id, holdId));
    else await db.update(companies).set({ status: "active" }).where(eq(companies.id, f.company.id));
    expect(await f.sweep()).toMatchObject({ continuationRequeued: 1, escalated: 0 });
  });

  it.each(["company", "tree", "setup", "invalid_chain", "none"])("only assigns an eligible orphan blocker after %s clears", async gate => {
    const f = await fixture();
    const [parent] = await db.insert(issues).values({ companyId: f.company.id, title: "Parent", status: "todo", responsibleUserId: "stranded-owner" }).returning();
    const [blocker] = await db.insert(issues).values({ companyId: f.company.id, parentId: parent.id, title: "Orphan blocker", status: "todo", createdByAgentId: f.agent.id, responsibleUserId: "stranded-owner" }).returning();
    await db.insert(issueRelations).values({ companyId: f.company.id, issueId: blocker.id, relatedIssueId: f.issue.id, type: "blocks" });
    let holdId: string | undefined;
    if (gate === "company") await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.company.id));
    if (gate === "tree") {
      const [hold] = await db.insert(issueTreeHolds).values({ companyId: f.company.id, rootIssueId: parent.id, mode: "pause" }).returning();
      holdId = hold.id;
    }
    if (gate === "setup") await db.update(agents).set({ lifecycleState: "preparing", lifecycleHolds: [] }).where(eq(agents.id, f.agent.id));
    if (gate === "invalid_chain") {
      const [manager] = await db.insert(agents).values({ companyId: f.company.id, name: "Former manager", role: "engineer", status: "terminated" }).returning();
      await db.update(agents).set({ reportsTo: manager.id }).where(eq(agents.id, f.agent.id));
    }
    const service = recoveryService(db, { enqueueWakeup: f.enqueueWakeup });
    const sweep = () => service.reconcileUnassignedBlockingIssues({ companyId: f.company.id });
    expect((await sweep()).assigned).toBe(gate === "none" ? 1 : 0);
    if (gate !== "none") {
      expect((await db.select().from(issues).where(eq(issues.id, blocker.id)))[0].assigneeAgentId).toBeNull();
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, blocker.id))).toHaveLength(0);
      expect(f.enqueueWakeup).not.toHaveBeenCalled();
      if (gate === "company") await db.update(companies).set({ status: "active" }).where(eq(companies.id, f.company.id));
      if (holdId) await db.update(issueTreeHolds).set({ status: "released" }).where(eq(issueTreeHolds.id, holdId));
      if (gate === "setup") await db.update(agents).set({ lifecycleState: "ready", lifecycleHolds: [] }).where(eq(agents.id, f.agent.id));
      if (gate === "invalid_chain") await db.update(agents).set({ reportsTo: null }).where(eq(agents.id, f.agent.id));
      expect((await sweep()).assigned).toBe(1);
    }
    expect((await db.select().from(issues).where(eq(issues.id, blocker.id)))[0].assigneeAgentId).toBe(f.agent.id);
    expect(f.enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "cancelled", "timed_out", "interrupted"])("admits a successor when %s has no eligible infrastructure retry", async status => {
    const f = await fixture(status);
    expect(await f.sweep()).toMatchObject({ continuationRequeued: 1 });
    expect(f.enqueueWakeup).toHaveBeenCalledWith(f.agent.id, expect.objectContaining({ reason: "issue_continuation_needed" }));
  });

  it("queues a fresh continuation only after the foreign OpenCode turn was verified idle", async () => {
    const f = await fixture("failed", "adapter_failed");
    f.enqueueWakeup.mockImplementation(async () => {
      const [queued] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
        issueId: f.issue.id, invocationSource: "automation", status: "queued", runtimeMode: "legacy",
        contextSnapshot: { issueId: f.issue.id } }).returning();
      await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id,
        source: "automation", status: "queued", runId: queued.id, payload: { issueId: f.issue.id } });
      return queued;
    });
    await db.update(agents).set({ adapterType: "opencode_local" }).where(eq(agents.id, f.agent.id));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { adapterDispatch: { adapterType: "opencode_local" } },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: true, reason: "unowned_turn_verified_idle", providerSessionId: "session-original", providerMessageId: "message-original" } } }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await f.sweep()).toMatchObject({ continuationRequeued: 1, escalated: 0 });
    expect(f.enqueueWakeup).toHaveBeenCalledWith(f.agent.id, expect.objectContaining({ reason: "issue_continuation_needed",
      contextSnapshot: expect.objectContaining({ paperclipForeignTurnContinuation: true, paperclipForeignTurnSessionId: "session-original" }) }));
    expect(f.scheduleRecoveryRetry).not.toHaveBeenCalled();
    await f.sweep();
    expect(f.enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("keeps an unverified settled foreign turn held for reconciliation", async () => {
    const f = await fixture("failed", "adapter_failed");
    await db.update(agents).set({ adapterType: "opencode_local" }).where(eq(agents.id, f.agent.id));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { adapterDispatch: { adapterType: "opencode_local" } },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: true, reason: "unowned_turn_settled" } } }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await f.sweep()).toMatchObject({ continuationRequeued: 0, escalated: 1 });
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("reports and preserves operator cancellation", async () => {
    const f = await fixture("cancelled");
    await db.update(heartbeatRuns).set({ resultJson: { cancelledByActorType: "user" } }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await f.sweep()).toMatchObject({ operatorCancelExempted: 1,
      skipGates: [{ issueId: f.issue.id, gate: "operator_cancelled" }] });
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
    await f.sweep();
    const gates = await db.select({ details: activityLog.details }).from(activityLog).where(and(
      eq(activityLog.entityId, f.issue.id), eq(activityLog.action, "issue.recovery_skipped"),
    ));
    expect(gates).toEqual([{ details: { gate: "operator_cancelled" } }]);
  });

  it.each(["active", "paused"])("reconciles an unfinished %s goal using goal authority", async state => {
    const f = await fixture();
    await db.insert(agentTaskSessions).values({ companyId: f.company.id, agentId: f.agent.id, adapterType: "http",
      taskKey: f.issue.id, goalStatus: state, goalDesiredState: state });
    const result = await f.sweep();
    if (state === "active") {
      expect(result.continuationRequeued).toBe(1);
      expect(f.enqueueWakeup).toHaveBeenCalledWith(f.agent.id, expect.objectContaining({ reason: "goal_control",
        contextSnapshot: expect.objectContaining({ resumeSessionGoalHeartbeat: true }) }));
    } else {
      expect(result.skipGates).toEqual([{ issueId: f.issue.id, gate: "session_goal_paused" }]);
      expect(f.enqueueWakeup).not.toHaveBeenCalled();
    }
  });

  it("continues an advanced legacy run with no owned next path", async () => {
    const f = await fixture("succeeded", "");
    expect(await f.sweep()).toMatchObject({ continuationRequeued: 1, dispositionRepairRequeued: 1 });
    expect(f.enqueueWakeup).toHaveBeenCalled();
  });

  it("reconciles a deferred assignment through the existing release path", async () => {
    const f = await fixture("cancelled", "issue_assignee_changed");
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id,
      source: "assignment", status: "deferred_issue_execution", payload: { issueId: f.issue.id } }).returning();
    const settle = vi.fn(async () => {
      await db.update(agentWakeupRequests).set({ status: "skipped" }).where(eq(agentWakeupRequests.id, wake.id));
    });
    const service = recoveryService(db, { enqueueWakeup: f.enqueueWakeup, settleExplicitContinuationRetry: settle });
    const result = await service.reconcileStrandedAssignedIssues({ companyId: f.company.id, skipRelatedRecovery: true });
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }),
      { suppressImmediateRecovery: true, resumeStrandedQueue: true });
    expect(result.continuationRequeued).toBe(1);
  });
});
