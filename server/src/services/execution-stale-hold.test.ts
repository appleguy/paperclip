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

  async function seed(adapterType: string, errorCode: string, reconciled = false) {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Hold company", issuePrefix: `H${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType, status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Held", status: "todo", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: "failed", errorCode,
      runnerProfileJson: { adapterDispatch: { adapterType } }, contextSnapshot: { issueId }, finishedAt: new Date() });
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "resolved", outcome: "blocked",
      ownerType: "board", cause: "legacy_execution_requires_reconciliation", fingerprint: randomUUID(),
      nextAction: "Preserved", resolvedAt: new Date(),
      evidence: { runId, automaticRecovery: { policy: "preserve_without_replay_v1", runId, replay: "blocked", actionOutcome: "unknown" },
        ...(reconciled ? { executionReconciliation: { runId } } : {}) },
    }).returning();
    return { companyId, issueId, action };
  }

  it("releases the hold of a deploy-interrupted claude_rc run, idempotently", async () => {
    const { companyId, issueId, action } = await seed("claude_rc", "server_shutdown_interrupted");
    expect(await getExecutionBlocker(db, companyId, issueId)).not.toBeNull();
    await settleUnrecoverableExecutions(db);
    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
    const [after] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect((after.evidence.automaticRecovery as { replay: string }).replay).toBe("allowed");
    await settleUnrecoverableExecutions(db);
    const [again] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(again.evidence).toEqual(after.evidence);
  });

  it("keeps the hold for other adapters and other failures", async () => {
    for (const [adapter, code] of [["paperclip_runner", "server_shutdown_interrupted"], ["claude_rc", "adapter_failed"]]) {
      const { companyId, issueId } = await seed(adapter, code);
      await settleUnrecoverableExecutions(db);
      expect(await getExecutionBlocker(db, companyId, issueId)).not.toBeNull();
    }
  });
});
