import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "./execution-blocker.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("execution blocker recovery lifetime", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("execution-blocker-lifetime-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(input: {
    status?: string;
    adapterType?: string;
    run?: Partial<typeof heartbeatRuns.$inferInsert>;
    evidence?: Record<string, unknown>;
  } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Hold lifetime", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: input.adapterType ?? "process", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Held task", status: "todo", assigneeAgentId: agentId });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId,
      status: "failed", runtimeMode: "legacy", errorCode: "adapter_failed", contextSnapshot: { issueId },
      startedAt: new Date("2020-01-01T00:00:00Z"), finishedAt: new Date("2020-01-01T00:01:00Z"),
      runnerProfileJson: { adapterDispatch: { adapterType: "process" } }, ...input.run,
    }).returning();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: run.id,
      status: input.status ?? "active", nextAction: "Inspect the source execution.",
      evidence: { runId: run.id, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" }, ...input.evidence },
    }).returning();
    return { companyId, agentId, issueId, run, action };
  }

  it.each(["resolved", "cancelled"])("does not park repeated reads behind a %s recovery action", async status => {
    const f = await fixture({ status });
    for (let i = 0; i < 3; i++) expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.action.id)))[0]).toEqual(f.action);
  });

  it.each(["active", "escalated"])("keeps an unresolved %s action effective", async status => {
    const f = await fixture({ status });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.action.id, runId: f.run.id });
    expect(await getExecutionBlocker(db, randomUUID(), f.issueId)).toBeNull();
  });

  it("releases an active action as soon as it resolves, without mutating its replay evidence", async () => {
    const f = await fixture();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    await db.update(issueRecoveryActions).set({ status: "resolved" }).where(eq(issueRecoveryActions.id, f.action.id));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it.each(["claude_rc", "claude_rc_local"])("does not resurrect a deploy-interrupted %s hold after adapter migration", async adapterType => {
    const f = await fixture({ adapterType: "codex_local", run: { status: "interrupted",
      errorCode: "server_shutdown_interrupted", runnerProfileJson: { adapterDispatch: { adapterType } } } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it("does not apply the current Claude adapter's exemption to a different source adapter", async () => {
    const f = await fixture({ adapterType: "claude_rc_local", run: { status: "interrupted", errorCode: "server_shutdown_interrupted" } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.action.id });
  });

  it("uses retained invocation evidence when the source has no dispatch claim", async () => {
    const f = await fixture({ adapterType: "codex_local", run: { status: "interrupted",
      errorCode: "server_shutdown_interrupted", runnerProfileJson: null } });
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId, runId: f.run.id,
      seq: 1, eventType: "adapter.invoke", payload: { adapterType: "claude_rc_local" } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it("retains the historical fallback for old runs without either adapter receipt", async () => {
    const f = await fixture({ adapterType: "claude_rc_local", run: { status: "interrupted",
      errorCode: "server_shutdown_interrupted", runnerProfileJson: null } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it("retains unverified failures from a retired adapter while recovery is active", async () => {
    const f = await fixture({ adapterType: "codex_local", run: { runnerProfileJson: { adapterDispatch: { adapterType: "claude_rc" } } } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.action.id });
  });

  it("keeps explicit unfinished workspace recovery effective after bookkeeping resolves", async () => {
    const f = await fixture({ status: "resolved", evidence: {
      workspaceRestoreFailure: "restore_unsafe_archive",
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [] },
    } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.action.id, workspaceRepairRequired: true });
  });

  it("does not exempt an interrupted former Claude run from unfinished workspace repair", async () => {
    const f = await fixture({ adapterType: "codex_local", run: { status: "interrupted",
      errorCode: "server_shutdown_interrupted", runnerProfileJson: { adapterDispatch: { adapterType: "claude_rc" } } },
      evidence: { workspaceRestoreFailure: "restore_unsafe_archive" } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.action.id, workspaceRepairRequired: true });
  });
});
