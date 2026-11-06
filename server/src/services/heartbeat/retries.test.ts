import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agents, agentWakeupRequests, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRunEvents, heartbeatRuns, issueComments, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { writePaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { HttpError } from "../../errors.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createRunDispatch, isResolvedInteractionContinuationWakeContext, type PostCommitEffect } from "../../modules/run-dispatch/index.js";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import * as legacy from "../heartbeat.js";
import { createHeartbeatRunState } from "./run-state.js";
import { pendingCaseHandoffForRun } from "./case-handoff-lifecycle.js";
import * as extracted from "./retries.js";
import { isLocalOpenCodeAdmissionDecline, isLocalOpenCodePreInferenceRateLimit, localOpenCodeAdmissionRetryOptions } from "../local-opencode-admission-retry.js";
import { legacyExecutionNeedsReconciliation } from "../legacy-execution-recovery.js";
import type { HeartbeatRetryDependencies } from "./retries.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Agent = typeof agents.$inferSelect;

function callbacks() {
  return {
    hasCaseHandoffForRun: vi.fn<HeartbeatRetryDependencies["hasCaseHandoffForRun"]>(async () => false),
    getRun: vi.fn<HeartbeatRetryDependencies["getRun"]>(async () => null),
    getAgent: vi.fn<HeartbeatRetryDependencies["getAgent"]>(async () => undefined),
    resolveSessionBeforeForWakeup: vi.fn(async () => null),
    resolveResponsibleUserIdForRunContext: vi.fn(async () => "retry-user"),
    getAgentInvokability: vi.fn<HeartbeatRetryDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
    appendRunEvent: vi.fn<HeartbeatRetryDependencies["appendRunEvent"]>(async () => undefined),
    escalatePlanApprovalResumeFailureNeedsAttention: vi.fn(async () => null),
    recordPlanApprovalResumeFailureRetry: vi.fn(async () => null),
    setRunStatusIfRunning: vi.fn<HeartbeatRetryDependencies["setRunStatusIfRunning"]>(async () => ({ updated: false, run: null })),
    setWakeupStatus: vi.fn(async () => undefined),
    releaseIssueExecutionAndPromote: vi.fn(async () => undefined),
    finalizeAgentStatus: vi.fn(async () => undefined),
    getWorktreeExecutionCutoff: vi.fn(async (): Promise<Date | null> => null),
    applyRunDispatchPostCommitEffects: vi.fn<(effects: PostCommitEffect[]) => void>(),
    runDispatch: {
      nextScheduledRetryAt: vi.fn(async () => null),
      evaluateScheduledRetryGate: vi.fn<HeartbeatRetryDependencies["runDispatch"]["evaluateScheduledRetryGate"]>(async () => ({ allowed: true })),
      promoteDueScheduledRetries: vi.fn<HeartbeatRetryDependencies["runDispatch"]["promoteDueScheduledRetries"]>(async () => ({ promoted: 0, runIds: [], postCommitEffects: [] })),
      promoteScheduledRetry: vi.fn<HeartbeatRetryDependencies["runDispatch"]["promoteScheduledRetry"]>(async () => ({ outcome: "not_promoted" })),
    },
  } satisfies HeartbeatRetryDependencies;
}

// These tests must never query: only the injected lifecycle callbacks may run.
function guardedDatabase() {
  const access = vi.fn(() => { throw new Error("Unexpected retry database access"); });
  return { db: new Proxy({}, { get: access }) as Db, access };
}

function unitRun(): Run {
  const run: Partial<Run> = {
    id: "run", companyId: "company", agentId: "agent", status: "running",
    scopeKind: "issue", issueId: "issue",
    wakeupRequestId: "wake", scheduledRetryAttempt: 0,
    contextSnapshot: { issueId: "issue", timerClaimWasFirstHeartbeat: true },
  };
  return run as Run;
}

function deferral() {
  return new extracted.WorkspaceBusyDeferral({
    holder: { runId: "holder", agentId: "other-agent", issueId: "other-issue", issueIdentifier: "T-2" },
    projectWorkspaceId: "workspace", deferralAttempt: 0, wasIssueAssignee: true,
  });
}

describe("local OpenCode admission retry", () => {
  const busy = {
    errorCode: "adapter_failed", exitCode: 75,
    error: "WRX80 admission declined (BUSY:GPU); no inference sent",
    runnerProfileJson: { adapterDispatch: { adapterType: "opencode_local" } },
    contextSnapshot: { executionRetryAccounting: { version: 1, failureRetries: 2, maxTurnContinuations: 0 } },
  };
  it("backs off six times, bounded below 30 minutes", () => {
    expect(isLocalOpenCodeAdmissionDecline(busy)).toBe(true);
    const opts = localOpenCodeAdmissionRetryOptions(busy, () => 1);
    expect(opts).toEqual({ maxAttempts: 6, delayMs: 165_000 });
    const totalMs = [60, 90, 150, 240, 360, 600].reduce((sum, ms) => sum + ms * 1.1, 0);
    expect(totalMs).toBeLessThan(1800);
  });
  it("does not require a reconciliation hold after two proven admission declines", () => {
    expect(legacyExecutionNeedsReconciliation({
      ...busy, runtimeMode: "legacy", status: "failed", resultJson: null,
    })).toBe(false);
    expect(legacyExecutionNeedsReconciliation({
      ...busy, runtimeMode: "legacy", status: "failed", resultJson: null,
      exitCode: 1,
    })).toBe(true);
  });
  it("recognizes all local host admission declines without broadening other failures", () => {
    for (const error of [
      "WRX80 admission declined (BUSY:external-engine); no inference sent",
      "WRX80 admission declined (BUSY:other-model-or-loading); no inference sent",
      "Mac Maya already serving another Paperclip run; no second request",
      "OpenCode shared server has unresolved active sessions; no inference sent",
      "Mac Pro Maya-L admission refused: Model not advertised",
    ]) expect(isLocalOpenCodeAdmissionDecline({ ...busy, error })).toBe(true);
  });
  it("backs off a positively observed pre-inference 429, not arbitrary rate-limit text", () => {
    const capacity = {
      ...busy, exitCode: 1, error: "Too many requests",
      resultJson: { adapterPreInferenceAdmission: {
        kind: "opencode_capacity_refusal_v1", providerWorkStarted: false,
      } },
    };
    expect(isLocalOpenCodePreInferenceRateLimit(capacity)).toBe(true);
    expect(localOpenCodeAdmissionRetryOptions(capacity, () => 0)).toEqual({ maxAttempts: 6, delayMs: 150_000 });
    expect(legacyExecutionNeedsReconciliation({
      ...capacity, runtimeMode: "legacy", status: "failed",
    })).toBe(false);
    for (const failed of [
      { ...capacity, resultJson: {} },
      { ...capacity, resultJson: { adapterPreInferenceAdmission: { kind: "opencode_capacity_refusal_v1", providerWorkStarted: true } } },
      { ...capacity, resultJson: { adapterPreInferenceAdmission: { kind: "other", providerWorkStarted: false } } },
      { ...capacity, runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } } },
      { ...capacity, exitCode: 75 },
      { ...capacity, errorCode: "setup_failed" },
    ]) {
      expect(isLocalOpenCodePreInferenceRateLimit(failed)).toBe(false);
      expect(localOpenCodeAdmissionRetryOptions(failed, () => 0)).toBeNull();
      expect(legacyExecutionNeedsReconciliation({
        ...failed, runtimeMode: "legacy", status: "failed",
      })).toBe(true);
    }
  });
  it("rejects non-local errors and post-dispatch failures", () => {
    expect(isLocalOpenCodeAdmissionDecline({ ...busy, error: "Too many requests", exitCode: 1 })).toBe(false);
    expect(isLocalOpenCodeAdmissionDecline({ ...busy, error: "WRX80 admission declined (BUSY:GPU); no inference sent", runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } } })).toBe(false);
    expect(isLocalOpenCodeAdmissionDecline({ ...busy, exitCode: 1 })).toBe(false);
    expect(isLocalOpenCodeAdmissionDecline({ ...busy, error: "unexpected Python traceback" })).toBe(false);
  });
});

describe("dispatch-deferred target_busy backoff", () => {
  it("backs off 2, 4, 8, 16, 30 minutes and never exceeds the cap", () => {
    const delays = [0, 1, 2, 3, 4, 5, 50].map(extracted.computeTargetBusyRetryDelayMs);
    expect(delays).toEqual([2, 4, 8, 16, 30, 30, 30].map(minutes => minutes * 60_000));
  });
});

describe("heartbeat retry module callbacks", () => {
  it("preserves legacy helper and error-class identity", () => {
    expect(legacy.computeBoundedTransientHeartbeatRetrySchedule).toBe(extracted.computeBoundedTransientHeartbeatRetrySchedule);
    expect(legacy.computeWorkspaceBusyRetryDelayMs).toBe(extracted.computeWorkspaceBusyRetryDelayMs);
    expect(legacy.BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS).toBe(extracted.BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS);
    expect(legacy.WorkspaceBusyDeferral).toBe(extracted.WorkspaceBusyDeferral);
    expect(deferral()).toBeInstanceOf(legacy.WorkspaceBusyDeferral);
  });

  it("constructs without database access or lifecycle effects", () => {
    const database = guardedDatabase();
    const deps = callbacks();
    extracted.createHeartbeatRetries(database.db, deps);
    expect(database.access).not.toHaveBeenCalled();
    for (const callback of Object.values(deps)) {
      if (typeof callback === "function") expect(callback).not.toHaveBeenCalled();
    }
    for (const callback of Object.values(deps.runDispatch)) expect(callback).not.toHaveBeenCalled();
  });

  it.each(["missing_run", "missing_agent"] as const)("keeps %s lookup behavior and requests the full source result", async (outcome) => {
    const database = guardedDatabase();
    const deps = callbacks();
    if (outcome === "missing_agent") deps.getRun.mockResolvedValue(unitRun());
    expect(await extracted.createHeartbeatRetries(database.db, deps).scheduleBoundedRetry("run")).toEqual({ outcome });
    expect(deps.getRun).toHaveBeenCalledWith("run", { unsafeFullResultJson: true });
    expect(deps.getAgent).toHaveBeenCalledTimes(outcome === "missing_agent" ? 1 : 0);
    expect(database.access).not.toHaveBeenCalled();
  });

  it("records exhaustion before escalating a plan-resume failure", async () => {
    const database = guardedDatabase();
    const deps = callbacks();
    const run = unitRun();
    const retry = await extracted.createHeartbeatRetries(database.db, deps).scheduleBoundedRetryForRun(
      run, { adapterType: "codex_local" } as Agent,
      { retryReason: legacy.INTERACTION_CONTINUATION_INFRA_RETRY_REASON, maxAttempts: 0 },
    );
    expect(retry).toMatchObject({ outcome: "retry_exhausted", attempt: 1, maxAttempts: 0 });
    expect(deps.appendRunEvent).toHaveBeenCalledWith(run, expect.objectContaining({
      retryExhaustion: { retryReason: legacy.INTERACTION_CONTINUATION_INFRA_RETRY_REASON, scheduledRetryAttempt: 0, maxAttempts: 0 },
    }));
    expect(deps.escalatePlanApprovalResumeFailureNeedsAttention).toHaveBeenCalledAfter(deps.appendRunEvent);
    expect(database.access).not.toHaveBeenCalled();
  });

  it("gives every caller the Runner wait budget for a Runner mismatch and reports its exhaustion", async () => {
    const database = guardedDatabase();
    const deps = callbacks();
    const run = { ...unitRun(), status: "failed", errorCode: "runner_revision_mismatch", scheduledRetryReason: "runner_revision_wait", scheduledRetryAttempt: 10,
      contextSnapshot: { issueId: "issue", executionRetryAccounting: { version: 1, failureRetries: 0, maxTurnContinuations: 0 } } } as Run;
    const retry = await extracted.createHeartbeatRetries(database.db, deps).scheduleBoundedRetryForRun(run, { adapterType: "codex_local" } as Agent);
    expect(retry).toMatchObject({ outcome: "retry_exhausted", attempt: 11, maxAttempts: 10 });
    expect(deps.appendRunEvent).toHaveBeenCalledWith(run, expect.objectContaining({
      retryExhaustion: { retryReason: "runner_revision_wait", scheduledRetryAttempt: 10, maxAttempts: 10 },
    }));
    expect(extracted.failedRunRetryBudgetSpent(run)).toBe(true);
    expect(extracted.failedRunRetryBudgetSpent({ ...run, scheduledRetryAttempt: 9 })).toBe(false);
    expect(extracted.failedRunRetryBudgetSpent({ ...run, errorCode: "setup_failed" })).toBe(false);
    expect(database.access).not.toHaveBeenCalled();
  });

  it("leaves successor work to the committed case handoff without retry escalation", async () => {
    const database = guardedDatabase();
    const deps = callbacks();
    deps.hasCaseHandoffForRun.mockResolvedValue(true);
    const run = unitRun();
    const retry = await extracted.createHeartbeatRetries(database.db, deps).scheduleBoundedRetryForRun(
      run, { adapterType: "codex_local" } as Agent,
      { retryReason: legacy.INTERACTION_CONTINUATION_INFRA_RETRY_REASON, maxAttempts: 0 },
    );
    expect(retry).toMatchObject({ outcome: "not_scheduled", issueId: "issue" });
    expect(deps.hasCaseHandoffForRun).toHaveBeenCalledWith(run);
    expect(deps.appendRunEvent).not.toHaveBeenCalled();
    expect(deps.escalatePlanApprovalResumeFailureNeedsAttention).not.toHaveBeenCalled();
    expect(database.access).not.toHaveBeenCalled();
  });

  it("passes the service's worktree cutoff and publishes only returned effects", async () => {
    const database = guardedDatabase();
    const deps = callbacks();
    const now = new Date("2026-10-08T12:00:00Z");
    const cutoff = new Date("2026-10-08T11:00:00Z");
    const effect: PostCommitEffect = {
      kind: "run_queued", runId: "retry", companyId: "company", agentId: "agent",
      invocationSource: "automation", triggerDetail: "system", wakeupRequestId: "wake",
    };
    deps.getWorktreeExecutionCutoff.mockResolvedValue(cutoff);
    deps.runDispatch.promoteDueScheduledRetries.mockResolvedValue({ promoted: 1, runIds: ["retry"], postCommitEffects: [effect] });
    expect(await extracted.createHeartbeatRetries(database.db, deps).promoteDueScheduledRetries(now)).toEqual({ promoted: 1, runIds: ["retry"] });
    expect(deps.runDispatch.promoteDueScheduledRetries).toHaveBeenCalledWith({ now, cutoff });
    expect(deps.applyRunDispatchPostCommitEffects).toHaveBeenCalledWith([effect]);
    expect(deps.applyRunDispatchPostCommitEffects).toHaveBeenCalledAfter(deps.runDispatch.promoteDueScheduledRetries);
    expect(database.access).not.toHaveBeenCalled();
  });

  it("does not publish effects when promotion rejects", async () => {
    const deps = callbacks();
    deps.runDispatch.promoteDueScheduledRetries.mockRejectedValue(new Error("promotion failed"));
    await expect(extracted.createHeartbeatRetries(guardedDatabase().db, deps).promoteDueScheduledRetries()).rejects.toThrow("promotion failed");
    expect(deps.applyRunDispatchPostCommitEffects).not.toHaveBeenCalled();
  });

  it.each(["workspace", "connection"] as const)("leaves a %s cancellation race winner alone", async (kind) => {
    const database = guardedDatabase();
    const deps = callbacks();
    const retries = extracted.createHeartbeatRetries(database.db, deps);
    if (kind === "workspace") await retries.finalizeWorkspaceBusyDeferral(unitRun(), deferral());
    else await retries.finalizeAiConnectionBusyDeferral(unitRun(), new HttpError(409, "busy"), true);
    expect(deps.setRunStatusIfRunning).toHaveBeenCalledTimes(1);
    expect(deps.setWakeupStatus).not.toHaveBeenCalled();
    expect(deps.getAgent).not.toHaveBeenCalled();
    expect(deps.releaseIssueExecutionAndPromote).not.toHaveBeenCalled();
    expect(deps.finalizeAgentStatus).not.toHaveBeenCalled();
    expect(database.access).not.toHaveBeenCalled();
  });

  it.each(["workspace", "connection"] as const)("settles the agent after a %s deferral cannot keep its issue lock", async (kind) => {
    const database = guardedDatabase();
    const deps = callbacks();
    const run = { ...unitRun(), status: "cancelled" };
    deps.setRunStatusIfRunning.mockResolvedValue({ updated: true, run });
    deps.releaseIssueExecutionAndPromote.mockRejectedValue(new Error("release failed"));
    const retries = extracted.createHeartbeatRetries(database.db, deps);
    if (kind === "workspace") await retries.finalizeWorkspaceBusyDeferral(run, deferral());
    else await expect(retries.finalizeAiConnectionBusyDeferral(run, new HttpError(409, "busy"), true)).rejects.toThrow("release failed");
    expect(deps.setWakeupStatus).toHaveBeenCalledWith("wake", "cancelled", expect.any(Object));
    expect(deps.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(run);
    expect(deps.finalizeAgentStatus).toHaveBeenCalledWith("agent", "cancelled", null, { wasFirstHeartbeat: true });
    expect(deps.finalizeAgentStatus).toHaveBeenCalledAfter(deps.releaseIssueExecutionAndPromote);
    expect(database.access).not.toHaveBeenCalled();
  });
});

import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
const external = resolveExternalTestDatabaseUrl("PAPERCLIP_HEARTBEAT_RETRIES_TEST_DATABASE_URL");
const support = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping retry PostgreSQL tests: ${support.reason ?? "unsupported host"}`);

describePostgres("heartbeat retry module database wiring", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const now = new Date("2026-10-08T12:00:00Z");

  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("heartbeat-retries-");
    db = createDb(external ?? database.connectionString, { maxConnections: 6 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  function boundRetries() {
    const state = createHeartbeatRunState(db);
    const deps = {
      ...callbacks(), getRun: state.getRun, getAgent: state.getAgent,
      hasCaseHandoffForRun: async (run: Pick<Run, "id" | "companyId">) => Boolean(await pendingCaseHandoffForRun(db, run.id, run.companyId)),
      resolveSessionBeforeForWakeup: state.resolveSessionBeforeForWakeup,
      getAgentInvokability: (agent: Agent | null | undefined) => evaluateAgentInvokabilityFromDb(db, agent),
      runDispatch: createRunDispatch(db),
    };
    return { retries: extracted.createHeartbeatRetries(db, deps), deps };
  }

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retries", issuePrefix: `R${companyId.slice(0, 8)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Retry agent", adapterType: "codex_local", status: "active" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Retry task", status: "in_progress", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent.id, scopeKind: "issue", issueId: issue.id,
      status: "failed", errorCode: "codex_transient_upstream", finishedAt: now,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { issueId: issue.id },
    }).returning();
    await db.update(issues).set({ executionRunId: run.id, checkoutRunId: run.id }).where(eq(issues.id, issue.id));
    return { companyId, agent, issue, run };
  }

  async function refuseDispatch(run: Run) {
    const [refused] = await db.update(heartbeatRuns).set({
      status: "cancelled", errorCode: "target_busy", error: "previous task unresolved",
      finishedAt: now, resultJson: { errorFamily: "target_busy",
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    }).where(eq(heartbeatRuns.id, run.id)).returning();
    if (run.wakeupRequestId) await db.update(agentWakeupRequests).set({ status: "cancelled" })
      .where(eq(agentWakeupRequests.id, run.wakeupRequestId));
    return refused!;
  }

  it.each(["todo", "in_progress", "in_review", "blocked"])("three consecutive deferrals retain one pending wake and unchanged %s status", async status => {
    const f = await fixture();
    await db.update(issues).set({ status }).where(eq(issues.id, f.issue.id));
    let current = f.run;
    for (let attempt = 1; attempt <= 3; attempt++) {
      current = await refuseDispatch(current);
      // Use no options: restart recovery must select the same lane and backoff.
      const result = await boundRetries().retries.scheduleBoundedRetryForRun(current, f.agent, { now });
      expect(result.outcome).toBe("scheduled");
      const pending = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.issueId, f.issue.id),
        eq(heartbeatRuns.agentId, f.agent.id), inArray(heartbeatRuns.status, ["scheduled_retry", "queued"]),
      ));
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ scheduledRetryAttempt: attempt, scheduledRetryReason: "target_busy",
        scheduledRetryAt: new Date(now.getTime() + 2 ** attempt * 60_000),
        contextSnapshot: { executionRetryAccounting: { failureRetries: 0 } } });
      const wakes = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.status, "queued"),
      ));
      expect(wakes).toHaveLength(1);
      expect(wakes[0].runId).toBe(pending[0].id);
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
      expect(issue.status).toBe(status);
      current = pending[0];
    }
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).toHaveLength(0);
  });

  it("coalesces different refused runs concurrently by agent and issue, including queued retries", async () => {
    const f = await fixture();
    const first = await refuseDispatch(f.run);
    const [other] = await db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: f.agent.id, scopeKind: "issue", issueId: f.issue.id,
      status: "cancelled", errorCode: "target_busy", finishedAt: now,
      resultJson: first.resultJson, contextSnapshot: first.contextSnapshot,
    }).returning();
    const results = await Promise.all([first, other].map(run =>
      boundRetries().retries.scheduleBoundedRetryForRun(run, f.agent, { now })));
    expect(results.every(result => result.outcome === "scheduled")).toBe(true);
    const pending = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "scheduled_retry"),
    ));
    expect(pending).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(1);
    await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, pending[0].id));
    expect(await boundRetries().retries.scheduleBoundedRetryForRun(other, f.agent, { now }))
      .toMatchObject({ reusedExisting: true, run: { id: pending[0].id, status: "queued" } });
  });

  it("defers two issues on one agent independently", async () => {
    const f = await fixture();
    const [secondIssue] = await db.insert(issues).values({ companyId: f.companyId,
      title: "Independent wait", status: "todo", assigneeAgentId: f.agent.id }).returning();
    const first = await refuseDispatch(f.run);
    const [second] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id,
      scopeKind: "issue", issueId: secondIssue.id, status: "cancelled", errorCode: "target_busy", finishedAt: now,
      resultJson: first.resultJson, contextSnapshot: { issueId: secondIssue.id } }).returning();
    await Promise.all([first, second].map(run => boundRetries().retries.scheduleBoundedRetryForRun(run, f.agent, { now })));
    const pending = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "scheduled_retry"),
    ));
    expect(pending).toHaveLength(2);
    expect(new Set(pending.map(run => run.issueId))).toEqual(new Set([f.issue.id, secondIssue.id]));
    expect(pending.map(run => run.scheduledRetryAttempt)).toEqual([1, 1]);
  });

  it("starts the busy backoff at two minutes while retaining prior failure debits", async () => {
    const f = await fixture();
    const source = await refuseDispatch(f.run);
    source.scheduledRetryReason = "transient_failure";
    source.scheduledRetryAttempt = 2;
    await db.update(heartbeatRuns).set({ scheduledRetryReason: source.scheduledRetryReason,
      scheduledRetryAttempt: source.scheduledRetryAttempt }).where(eq(heartbeatRuns.id, source.id));
    expect(await boundRetries().retries.scheduleBoundedRetryForRun(source, f.agent, { now })).toMatchObject({
      outcome: "scheduled", run: { scheduledRetryAttempt: 1,
        scheduledRetryAt: new Date(now.getTime() + 2 * 60_000),
        contextSnapshot: { executionRetryAccounting: { failureRetries: 2 } } },
    });
  });

  it("posts exactly one seat-busy notice on the sixth deferral and stays quiet afterwards", async () => {
    const f = await fixture();
    let current = f.run;
    for (let attempt = 1; attempt <= 8; attempt++) {
      current = await refuseDispatch(current);
      const result = await boundRetries().retries.scheduleBoundedRetryForRun(current, f.agent, { now });
      expect(result.outcome).toBe("scheduled");
      if (result.outcome !== "scheduled") throw new Error("Expected deferred wake");
      // A second recovery pass on the same predecessor cannot repeat the notice.
      await boundRetries().retries.scheduleBoundedRetryForRun(current, f.agent, { now });
      const notices = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id));
      expect(notices).toHaveLength(attempt >= 6 ? 1 : 0);
      if (notices[0]) expect(notices[0]).toMatchObject({ authorType: "system", body: expect.stringContaining("seat is still busy") });
      expect(result.run.scheduledRetryAt!.getTime() - now.getTime()).toBe(Math.min(2 ** attempt, 30) * 60_000);
      current = result.run;
    }
  });

  it.each([false, true])("records a workspace wait only for the deferral's workspace (task moved after cancel: %s)", async (moved) => {
    const { run, agent, issue, companyId } = await fixture();
    const [project] = await db.insert(projects).values({ companyId, name: "Shared" }).returning();
    const [deferredOn, movedTo] = await db.insert(projectWorkspaces).values([
      { companyId, projectId: project.id, name: "Deferred", sourceType: "local_path", cwd: "/tmp/deferred" },
      { companyId, projectId: project.id, name: "Moved", sourceType: "local_path", cwd: "/tmp/moved" },
    ]).returning();
    try {
      await db.update(issues).set({ projectId: project.id, projectWorkspaceId: deferredOn.id }).where(eq(issues.id, issue.id));
      await db.update(heartbeatRuns).set({ status: "running", finishedAt: null, errorCode: null }).where(eq(heartbeatRuns.id, run.id));
      const { retries, deps } = boundRetries();
      // The move lands in the gap after the cancellation commits, as a user edit can.
      deps.setRunStatusIfRunning.mockImplementation(async (runId, status, patch) => {
        const [cancelled] = await db.update(heartbeatRuns).set({ status, ...patch }).where(eq(heartbeatRuns.id, runId)).returning();
        if (moved) await db.update(issues).set({ projectWorkspaceId: movedTo.id }).where(eq(issues.id, issue.id));
        return { updated: true, run: cancelled! };
      });
      await retries.finalizeWorkspaceBusyDeferral({ ...run, status: "running" }, new extracted.WorkspaceBusyDeferral({
        holder: { runId: randomUUID(), agentId: agent.id, issueId: randomUUID(), issueIdentifier: null },
        projectWorkspaceId: deferredOn.id, deferralAttempt: 0, wasIssueAssignee: true,
      }));
      const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run.id));
      expect(successor?.status).toBe("scheduled_retry");
      const wait = (successor!.contextSnapshot as Record<string, unknown>).workspaceBusyWait;
      if (moved) expect(wait).toBeUndefined();
      else expect(wait).toMatchObject({ key: `project:${deferredOn.id}`, issueProjectWorkspaceId: deferredOn.id, issueExecutionWorkspaceId: null });
    } finally {
      await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, companyId));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      await db.delete(issues).where(eq(issues.companyId, companyId));
      await db.delete(projectWorkspaces).where(eq(projectWorkspaces.companyId, companyId));
      await db.delete(projects).where(eq(projects.companyId, companyId));
    }
  });

  it("waits for a Runner update without spending failure retries and keeps an answered interaction", async () => {
    const { run, agent } = await fixture();
    const snapshot = { ...run.contextSnapshot, interactionId: "interaction-1", interactionStatus: "answered", interactionKind: "ask_user_questions",
      mutation: "interaction", wakeReason: "issue_commented", executionRetryAccounting: { version: 1, failureRetries: 1, maxTurnContinuations: 0 } };
    const [failed] = await db.update(heartbeatRuns).set({ errorCode: "runner_revision_mismatch", contextSnapshot: snapshot })
      .where(eq(heartbeatRuns.id, run.id)).returning();
    const result = await boundRetries().retries.scheduleBoundedRetryForRun(failed!, agent, { now });
    expect(result.outcome).toBe("scheduled");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run.id));
    expect(successor).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "runner_revision_wait", scheduledRetryAttempt: 1 });
    expect(successor!.contextSnapshot).toMatchObject({ mutation: "interaction", interactionId: "interaction-1",
      executionRetryAccounting: { failureRetries: 1 } });
    expect(isResolvedInteractionContinuationWakeContext(successor!.contextSnapshot)).toBe(true);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, successor!.wakeupRequestId!));
    expect(wake!.payload).toMatchObject({ mutation: "interaction", interactionId: "interaction-1", retryReason: "runner_revision_wait" });
  });

  it("resolves current skills on a retry while retaining the failed attempt snapshot", async () => {
    const {run,agent}=await fixture();
    const snapshot={...run.contextSnapshot,skillVersions:{"company/review":"v1"},skillSelectionSnapshot:true,shadowedSkills:[{key:"old",shadowedBy:"company/review"}]};
    await db.update(heartbeatRuns).set({contextSnapshot:snapshot}).where(eq(heartbeatRuns.id,run.id));
    await db.update(agents).set({adapterConfig:writePaperclipSkillSyncPreference({},[{key:"company/review",versionId:"v2"}])}).where(eq(agents.id,agent.id));
    const result=await boundRetries().retries.scheduleBoundedRetryForRun({...run,contextSnapshot:snapshot},agent,{now,random:()=>0});
    expect(result.outcome).toBe("scheduled");
    const [successor]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId,run.id));
    expect(successor!.contextSnapshot).not.toHaveProperty("skillVersions");
    expect(successor!.contextSnapshot).not.toHaveProperty("skillSelectionSnapshot");
    expect(successor!.contextSnapshot).not.toHaveProperty("shadowedSkills");
    const [history]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,run.id));
    expect(history!.contextSnapshot).toEqual(snapshot);
  });

  it("reuses one successor across concurrent factories and keeps writes committed before callbacks", async () => {
    const { run, agent, issue, companyId } = await fixture();
    const first = boundRetries(), second = boundRetries();
    for (const binding of [first, second]) {
      binding.deps.appendRunEvent.mockImplementation(async (_source, event) => {
        const retryId = event.payload?.retryRunId;
        expect(typeof retryId).toBe("string");
        expect(await binding.deps.getRun(retryId as string)).toMatchObject({ retryOfRunId: run.id });
      });
    }
    const results = await Promise.all([
      first.retries.scheduleBoundedRetryForRun(run, agent, { now, random: () => 0 }),
      second.retries.scheduleBoundedRetryForRun(run, agent, { now, random: () => 0 }),
    ]);
    expect(results.every((result) => result.outcome === "scheduled")).toBe(true);
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, run.id)));
    expect(successors).toHaveLength(1);
    const successor = successors[0];
    expect(successor).toMatchObject({
      status: "scheduled_retry", issueId: issue.id, responsibleUserId: "retry-user",
      scheduledRetryAttempt: 1, scheduledRetryReason: "transient_failure",
    });
    expect(successor.contextSnapshot).toMatchObject({ retryOfRunId: run.id, codexTransientFallbackMode: "same_session" });
    expect(first.deps.resolveResponsibleUserIdForRunContext).toHaveBeenCalledWith(run, expect.objectContaining({ retryOfRunId: run.id }));
    const [locked] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(locked).toMatchObject({ executionRunId: successor.id, checkoutRunId: null });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, successor.id))).toHaveLength(1);
    expect(await boundRetries().retries.scheduleBoundedRetry(run.id, { now })).toMatchObject({ outcome: "scheduled", run: { id: successor.id }, reusedExisting: true });
    expect(first.deps.appendRunEvent).toHaveBeenCalledTimes(1);
    expect(second.deps.appendRunEvent).toHaveBeenCalledTimes(1);
  });

  it("promotes only due retries and publishes after commit", async () => {
    const { run } = await fixture();
    const { retries, deps } = boundRetries();
    const scheduled = await retries.scheduleBoundedRetry(run.id, { now, delayMs: 60_000 });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") throw new Error("Expected retry");
    expect(await retries.promoteDueScheduledRetries(now)).toEqual({ promoted: 0, runIds: [] });
    deps.applyRunDispatchPostCommitEffects.mockClear();
    const committedStatuses: string[] = [];
    const reads: Promise<void>[] = [];
    deps.applyRunDispatchPostCommitEffects.mockImplementation(() => {
      // Read outside the dispatch transaction after the callback is invoked.
      // The assertion below waits for that read without making publication async.
      reads.push(deps.getRun(scheduled.run.id).then((row) => { committedStatuses.push(row!.status); }));
    });
    expect(await retries.promoteDueScheduledRetries(scheduled.dueAt)).toEqual({ promoted: 1, runIds: [scheduled.run.id] });
    await Promise.all(reads);
    expect(committedStatuses).toEqual(["queued"]);
    expect(deps.applyRunDispatchPostCommitEffects).toHaveBeenCalledWith([expect.objectContaining({ kind: "run_queued", runId: scheduled.run.id })]);
  });

  it("binds retry-now to the requested issue and persists its actor before promotion", async () => {
    const selected = await fixture(), other = await fixture();
    const { retries, deps } = boundRetries();
    const scheduled = await retries.scheduleBoundedRetry(selected.run.id, { now, delayMs: 60_000 });
    const foreign = await retries.scheduleBoundedRetry(other.run.id, { now, delayMs: 60_000 });
    if (scheduled.outcome !== "scheduled" || foreign.outcome !== "scheduled") throw new Error("Expected retries");
    expect(await retries.retryScheduledRetryNow({ issueId: selected.issue.id, actor: { actorType: "user", actorId: "retry-user" }, now })).toMatchObject({
      outcome: "promoted", scheduledRetry: { runId: scheduled.run.id, status: "queued" },
    });
    expect(await deps.getRun(scheduled.run.id)).toMatchObject({ contextSnapshot: {
      retryNowRequestedByActorType: "user", retryNowRequestedByActorId: "retry-user", retryNowRequestedAt: now.toISOString(),
    } });
    expect(await deps.getRun(foreign.run.id)).toMatchObject({ status: "scheduled_retry", scheduledRetryAt: foreign.dueAt });
    expect(await retries.retryScheduledRetryNow({ issueId: selected.issue.id, now })).toMatchObject({ outcome: "already_promoted" });
  });
});
