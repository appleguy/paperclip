import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, issueRecoveryActions } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";

/** SCO-602: a resolved recovery action must not keep holding an issue the system can safely redispatch. */
describe("stale resolved no-replay holds", () => {
  let postgres: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    postgres = await startEmbeddedPostgresTestDatabase("stale-hold-");
    db = createDb(postgres.connectionString);
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await postgres?.cleanup(); });

  async function seed(adapterType: string, errorCode: string, reconciled = false, resultJson?: Record<string, unknown>) {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Hold company", issuePrefix: `H${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType, status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Held", status: "todo", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: "failed", errorCode,
      runnerProfileJson: { adapterDispatch: { adapterType } }, contextSnapshot: { issueId }, finishedAt: new Date(), ...(resultJson ? { resultJson } : {}) });
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "resolved", outcome: "blocked",
      ownerType: "board", cause: "legacy_execution_requires_reconciliation", fingerprint: randomUUID(),
      nextAction: "Preserved", resolvedAt: new Date(),
      evidence: { runId, automaticRecovery: { policy: "preserve_without_replay_v1", runId, replay: "blocked", actionOutcome: "unknown" },
        ...(reconciled ? { executionReconciliation: { runId } } : {}) },
    }).returning();
    return { companyId, issueId, agentId, action };
  }

  it("releases the hold of a deploy-interrupted claude_rc run, idempotently", async () => {
    const { companyId, issueId, action } = await seed("claude_rc", "server_shutdown_interrupted");
    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
    await settleUnrecoverableExecutions(db);
    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
    const [after] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect((after.evidence.automaticRecovery as { replay: string }).replay).toBe("allowed");
    await settleUnrecoverableExecutions(db);
    const [again] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(again.evidence).toEqual(after.evidence);
  });

  it("releases the hold of an opencode run whose interruption the adapter verified (SCO-679)", async () => {
    const verified = { executionCancellation: { state: "acknowledged", proof: "server_restarted" },
      executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" } };
    const { companyId, issueId } = await seed("opencode_local", "cancelled", false, verified);
    await settleUnrecoverableExecutions(db);
    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
    const unverified = await seed("opencode_local", "cancelled", false, { executionRecovery: { kind: "interrupted" } });
    await settleUnrecoverableExecutions(db);
    expect(await getExecutionBlocker(db, unverified.companyId, unverified.issueId)).toBeNull();
  });

  it.each([false, true])("preserves an unverified OpenCode conversation action when local started is %s", async (started) => {
    const { companyId, issueId, action } = await seed("opencode_local", "process_lost", false, {
      conversationContinuation: "continue_conversation_v1",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: started, providerWorkEvidence: "unverified",
        reason: "reattach_message_missing", providerSessionId: "session-original", providerMessageId: "message-original" },
    });
    expect(await getExecutionBlocker(db, companyId, issueId)).not.toBeNull();
    await settleUnrecoverableExecutions(db);
    const [after] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(after.outcome).toBe("blocked");
    expect(after.evidence).toEqual(action.evidence);
    expect(await getExecutionBlocker(db, companyId, issueId)).not.toBeNull();
  });

  it("does not settle an active unverified OpenCode action as a conversation continuation", async () => {
    const { companyId, issueId, agentId, action } = await seed("opencode_local", "process_lost", false, {
      conversationContinuation: "continue_conversation_v1",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false, providerWorkEvidence: "unverified",
        reason: "reattach_message_missing", providerSessionId: "session-original", providerMessageId: "message-original" },
    });
    await db.update(issueRecoveryActions).set({ status: "active", outcome: null, resolvedAt: null, returnOwnerAgentId: agentId }).where(eq(issueRecoveryActions.id, action.id));
    await settleUnrecoverableExecutions(db);
    const [after] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(after.outcome).not.toBe("cancelled");
    expect((after.evidence.automaticRecovery as { replay: string }).replay).toBe("blocked");
    expect(await getExecutionBlocker(db, companyId, issueId)).not.toBeNull();
  });

  it("releases resolved actions for other failures while retaining active recovery", async () => {
    for (const [adapter, code] of [["paperclip_runner", "server_shutdown_interrupted"], ["claude_rc", "adapter_failed"]]) {
      const { companyId, issueId } = await seed(adapter, code);
      await settleUnrecoverableExecutions(db);
      expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
      await db.update(issueRecoveryActions).set({ status: "active" }).where(eq(issueRecoveryActions.sourceIssueId, issueId));
      expect(await getExecutionBlocker(db, companyId, issueId)).not.toBeNull();
    }
  });

  /** SCO-648: status follows the live claude_rc conversation, in both directions. */
  async function seedRc(status: "todo" | "blocked" | "in_progress", actionStatus: "resolved" | "active") {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Rc company", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Claude Worker", adapterType: "claude_rc_local", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Sweep", status, assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: "interrupted",
      errorCode: "server_shutdown_interrupted", runnerProfileJson: { adapterDispatch: { adapterType: "claude_rc" } },
      contextSnapshot: { issueId }, finishedAt: new Date() });
    await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: actionStatus,
      outcome: actionStatus === "resolved" ? "blocked" : null, ownerType: "board", returnOwnerAgentId: agentId,
      cause: "legacy_execution_requires_reconciliation", fingerprint: randomUUID(), nextAction: "Preserved",
      evidence: { runId }, ...(actionStatus === "resolved" ? { resolvedAt: new Date() } : {}),
    });
    return { issueId, agentId };
  }
  const statusOf = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0].status;
  const liveFor = (id: string | null) => async () => (id ? { issueId: id } : null);

  it("promotes a todo or blocked issue whose claude_rc conversation is still live", async () => {
    for (const status of ["todo", "blocked"] as const) {
      const { issueId } = await seedRc(status, "resolved");
      await settleUnrecoverableExecutions(db, new Date(), { rcCheckpoint: liveFor(issueId) });
      expect(await statusOf(issueId)).toBe("in_progress");
    }
  });

  it("leaves todo alone when the conversation is not live or belongs to another issue", async () => {
    const a = await seedRc("todo", "resolved");
    await settleUnrecoverableExecutions(db, new Date(), { rcCheckpoint: liveFor(null) });
    expect(await statusOf(a.issueId)).toBe("todo");
    await settleUnrecoverableExecutions(db, new Date(), { rcCheckpoint: liveFor(randomUUID()) });
    expect(await statusOf(a.issueId)).toBe("todo");
  });

  it("settling a deploy-interrupted run keeps a live conversation in_progress, and blocks a dead one", async () => {
    const live = await seedRc("in_progress", "active");
    const dead = await seedRc("in_progress", "active");
    await settleUnrecoverableExecutions(db, new Date(), {
      rcCheckpoint: liveFor(null), rcLive: async (_c, issueId) => issueId === live.issueId,
    });
    expect(await statusOf(live.issueId)).toBe("in_progress");
    expect(await statusOf(dead.issueId)).toBe("blocked");
  });
});
