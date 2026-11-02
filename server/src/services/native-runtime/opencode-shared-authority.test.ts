import { beforeEach, describe, expect, it, vi } from "vitest";
import { commitOpenCodeSharedLog, validateOpenCodeLogItem, type OpenCodeSharedBinding } from "./opencode-shared-authority.js";

const append = vi.hoisted(() => vi.fn());
vi.mock("../heartbeat-run-events.js", () => ({ appendHeartbeatRunEvent: append }));
const binding: OpenCodeSharedBinding = { companyId: "company", projectId: "project", issueId: "issue", agentId: "agent", runId: "run", taskSessionId: "task-session", normalizedSessionId: "native-session", runnerInstanceId: "runner", providerSessionId: "ses_test", generation: "generation", epoch: "epoch", version: "2.2.5", model: "glm", effort: "high", leaseOwner: "lease", leaseAttempt: 1, controllerBootId: "boot", controllerPid: 123, controllerProcessStartedAt: new Date(1), controllerGeneration: 1 };
const keys = ["companyId", "projectId", "issueId", "agentId", "runId", "taskSessionId", "normalizedSessionId", "runnerInstanceId", "providerSessionId", "generation", "epoch", "version", "model", "effort"] as const;
const event = { id: "evt_test", type: "session.execution.started", created: 1, data: { sessionID: "ses_test" }, durable: { aggregateID: "ses_test", seq: 2, version: 1 } };
function fixture() {
  const native = Object.fromEntries(keys.map(k => [k, binding[k]]));
  let persisted: Record<string, unknown> = { unrelated: "preserved", opencodeSharedV2: { ...native, cursor: null } };
  let lease = true, failUpdate = false;
  const db = { transaction: async (fn: (tx: unknown) => Promise<void>) => {
    let selectIndex = 0, staged = persisted;
    const results = [[{}], lease ? [{}] : [], [{}], [{}], [{ sessionParamsJson: persisted }], lease ? [{}] : []];
    const tx = {
      select: () => {
        const rows = results[selectIndex++] ?? [];
        const chain: any = { from: () => chain, where: () => chain, for: () => chain, limit: async () => rows, then: (resolve: (v: unknown) => void) => resolve(rows) };
        return chain;
      },
      update: () => ({ set: (v: { sessionParamsJson: Record<string, unknown> }) => ({ where: async () => { if (failUpdate) throw new Error("write failure"); staged = v.sessionParamsJson; } }) }),
    };
    await fn(tx); persisted = staged;
  } };
  return { db: db as any, get state() { return persisted; }, disableLease: () => { lease = false; }, failUpdate: () => { failUpdate = true; }, alterBinding: () => { (persisted.opencodeSharedV2 as any).model = "foreign"; } };
}
beforeEach(() => { append.mockReset(); append.mockResolvedValue({}); });
describe("OpenCode shared durable server authority", () => {
  it("appends the exact external event and advances the cursor in the same transaction", async () => {
    const f = fixture(); await commitOpenCodeSharedLog(f.db, binding, { previous: null, next: 2, item: event });
    expect(append).toHaveBeenCalledOnce(); expect(append.mock.calls[0]![1].payload.opencodeSharedV2.item).toEqual(event);
    expect(f.state).toMatchObject({ unrelated: "preserved", opencodeSharedV2: { cursor: 2, model: "glm" } });
  });
  it("rejects stale lease and foreign binding before appending", async () => {
    const a = fixture(); a.disableLease(); await expect(commitOpenCodeSharedLog(a.db, binding, { previous: null, next: 2, item: event })).rejects.toThrow("lease_lost");
    const b = fixture(); b.alterBinding(); await expect(commitOpenCodeSharedLog(b.db, binding, { previous: null, next: 2, item: event })).rejects.toThrow("identity_mismatch");
    expect(append).not.toHaveBeenCalled();
  });
  it("does not publish a cursor if the transaction fails after append", async () => {
    const f = fixture(); f.failUpdate(); await expect(commitOpenCodeSharedLog(f.db, binding, { previous: null, next: 2, item: event })).rejects.toThrow("write failure");
    expect(f.state).toMatchObject({ opencodeSharedV2: { cursor: null } });
  });
  it("rejects foreign identities, regressing cursors, and oversized provider data", () => {
    expect(() => validateOpenCodeLogItem("ses_other", null, 2, event)).toThrow();
    expect(() => validateOpenCodeLogItem("ses_test", 2, 2, event)).toThrow();
    expect(() => validateOpenCodeLogItem("ses_test", null, 2, { ...event, extra: "x".repeat(1_048_577) })).toThrow("oversized");
    expect(validateOpenCodeLogItem("ses_test", 2, 3, { type: "log.synced", aggregateID: "ses_test", seq: 3 })).toMatchObject({ seq: 3 });
  });
});

// A disposable database exercises the real append and PostgreSQL rollback.
const { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } = await import("../../__tests__/helpers/embedded-postgres.js");
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("OpenCode shared PostgreSQL transaction", () => {
  it("commits event and cursor together and rolls both back on failure", async () => {
    const { randomUUID } = await import("node:crypto");
    const { eq, sql } = await import("drizzle-orm");
    const { createDb, companies, agents, projects, issues, heartbeatRuns, agentTaskSessions, nativeRunFinalizations, heartbeatRunEvents } = await import("@paperclipai/db");
    const database = await startEmbeddedPostgresTestDatabase("paperclip-opencode-authority-");
    const db = createDb(database.connectionString);
    try {
      const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), taskSessionId = randomUUID(), normalizedSessionId = randomUUID(), runnerInstanceId = randomUUID();
      const b: OpenCodeSharedBinding = { ...binding, companyId, agentId, projectId, issueId, runId, taskSessionId, normalizedSessionId, runnerInstanceId };
      const native = Object.fromEntries(keys.map(k => [k, b[k]]));
      await db.insert(companies).values({ id: companyId, name: "Test", issuePrefix: "OPC" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Test", role: "engineer", adapterType: "paperclip_runner" });
      await db.insert(projects).values({ id: projectId, companyId, name: "Project" });
      await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Test" });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: normalizedSessionId, runnerInstanceId, status: "running", runtimeMode: "native" });
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      await db.insert(agentTaskSessions).values({ id: taskSessionId, companyId, agentId, adapterType: "paperclip_runner", taskKey: "task", lastRunId: runId, sessionParamsJson: { opencodeSharedV2: { ...native, cursor: null } } });
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "running", leaseOwner: b.leaseOwner, attempt: b.leaseAttempt, leaseExpiresAt: new Date(Date.now() + 60_000), controllerBootId: b.controllerBootId, controllerPid: b.controllerPid, controllerProcessStartedAt: b.controllerProcessStartedAt, controllerGeneration: b.controllerGeneration });
      const actual = await vi.importActual<typeof import("../heartbeat-run-events.js")>("../heartbeat-run-events.js");
      append.mockImplementation(actual.appendHeartbeatRunEvent);
      await commitOpenCodeSharedLog(db, b, { previous: null, next: 2, item: event });
      expect((await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId)))).toHaveLength(1);
      expect((await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, taskSessionId)))[0]!.sessionParamsJson).toMatchObject({ opencodeSharedV2: { cursor: 2 } });
      const nextEvent = { ...event, id: "evt_next", durable: { ...event.durable, seq: 3 } };
      for (const changed of [{ ...b, generation: "other" }, { ...b, model: "other" }, { ...b, effort: "other" }, { ...b, epoch: "other" }, { ...b, projectId: randomUUID() }, { ...b, leaseOwner: "other" }]) {
        await expect(commitOpenCodeSharedLog(db, changed, { previous: 2, next: 3, item: nextEvent })).rejects.toThrow();
      }
      expect((await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId)))).toHaveLength(1);
      // Simulate existing paths holding rows in another order. Each attempt
      // must fail without waiting for this outer transaction to release its
      // lock; a waiting implementation times out instead of passing.
      for (const target of [
        { table: nativeRunFinalizations, column: nativeRunFinalizations.runId, id: runId },
        { table: heartbeatRuns, column: heartbeatRuns.id, id: runId },
        { table: issues, column: issues.id, id: issueId },
        { table: agentTaskSessions, column: agentTaskSessions.id, id: taskSessionId },
      ]) {
        await db.transaction(async holder => {
          await holder.select().from(target.table).where(eq(target.column, target.id)).for("update");
          let failure: unknown;
          try {
            await commitOpenCodeSharedLog(db, b, { previous: 2, next: 3, item: nextEvent });
          } catch (error) { failure = error; }
          expect(failure).toBeDefined();
          const codes: unknown[] = [];
          for (let error = failure as { code?: unknown; cause?: unknown } | undefined; error; error = error.cause as typeof error) codes.push(error.code);
          expect(codes).toContain("55P03");
        });
      }
      expect((await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId)))).toHaveLength(1);
      expect((await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, taskSessionId)))[0]!.sessionParamsJson).toMatchObject({ opencodeSharedV2: { cursor: 2 } });
      // Force failure after append inside the same transaction; real rollback must remove it.
      append.mockImplementation(async (...args) => { await actual.appendHeartbeatRunEvent(...args as Parameters<typeof actual.appendHeartbeatRunEvent>); throw new Error("injected failure"); });
      const second = { ...event, id: "evt_two", durable: { ...event.durable, seq: 3 } };
      await expect(commitOpenCodeSharedLog(db, b, { previous: 2, next: 3, item: second })).rejects.toThrow("injected failure");
      expect((await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId)))).toHaveLength(1);
      expect((await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, taskSessionId)))[0]!.sessionParamsJson).toMatchObject({ opencodeSharedV2: { cursor: 2 } });
      await db.execute(sql`select 1`);
    } finally { await database.cleanup(); }
  }, 60_000);
});
