import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { startRunnerToolBridge } from "@paperclipai/paperclip-runner";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { HttpError } from "../../errors.js";
import { CLAUDE_INTERACTIVE_DRIVER_KIND, createClaudeNativeAdmission } from "./claude-native-admission.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Claude native admission with the real Paperclip task tools", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("claude-admission-"); db = createDb(temporary.connectionString); }, 30_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  const identity = { bootId: "boot-1", pid: 4242, processStartedAt: new Date("2026-10-31T12:00:00Z") };
  async function seed(driverKind: string | null = CLAUDE_INTERACTIVE_DRIVER_KIND) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), workspaceId = randomUUID(), leaseId = randomUUID(), nativeSessionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Admission", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "paperclip_runner" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, mode: "local", strategyType: "local", name: "workspace", cwd: "/Volumes/NVM/AI_Agent_Runtime/tmp" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Original", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId, runtimeMode: "native", status: "running", driverKind });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: runId, issueId, executionWorkspaceId: workspaceId, status: "active" });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed", leaseOwner: "owner", attempt: 1, controllerGeneration: 3,
      controllerBootId: identity.bootId, controllerPid: identity.pid, controllerProcessStartedAt: identity.processStartedAt, leaseExpiresAt: new Date(Date.now() + 60_000) });
    return { companyId, runId, issueId, leaseId, nativeSessionId, agentId };
  }
  const admit = () => createClaudeNativeAdmission(db, { controller: async () => identity });
  const title = async (issueId: string) => (await db.select({ title: issues.title }).from(issues).where(eq(issues.id, issueId)))[0]!.title;
  const receipts = async (runId: string) => ((await db.select({ r: heartbeatRuns.resultJson }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!.r as Record<string, any> | null)?.taskTitleReceipts ?? {};

  it("derives the admitted scope from existing rows and writes a durable receipt through the real task tools", async () => {
    const f = await seed();
    const admission = await admit()({ companyId: f.companyId, actorId: "board", runId: f.runId });
    expect(admission.scope).toEqual({ companyId: f.companyId, runId: f.runId, taskId: f.issueId, leaseId: f.leaseId, nativeSessionId: f.nativeSessionId });
    expect(admission.definitions().map(tool => tool.name)).toEqual(expect.arrayContaining(["get_task_context", "set_task_title"]));
    // Completion tools are absent without a completion boundary; native Stop/text never complete a task.
    expect(admission.definitions().map(tool => tool.name)).not.toContain("paperclip_finish");
    const bridge = await startRunnerToolBridge({ tools: admission.definitions(), preserveToolNames: true, preloadClaudeTaskTools: true, timeoutMs: null,
      handler: call => admission.dispatch(admission.scope, call) });
    const rpc = async (id: string, name: string, args: object) => (await (await fetch(bridge.url, { method: "POST",
      headers: { authorization: `Bearer ${bridge.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) })).json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
    try {
      expect((await rpc("ctx", "get_task_context", {})).isError).not.toBe(true);
      const set = await rpc("t1", "set_task_title", { title: "Claude title", onlyIfProvisional: false, idempotencyKey: "claude-1" });
      expect(set.isError, JSON.stringify(set.content)).not.toBe(true);
      expect(await title(f.issueId)).toBe("Claude title");
      const stored = await receipts(f.runId);
      expect(stored["title:claude-1"]).toMatchObject({ issueId: f.issueId, title: "Claude title" });
      // A repeat under a new call id replays the durable receipt instead of writing again.
      await db.update(issues).set({ title: "User edit" }).where(eq(issues.id, f.issueId));
      expect((await rpc("t2", "set_task_title", { title: "Claude title", onlyIfProvisional: false, idempotencyKey: "claude-1" })).isError).not.toBe(true);
      expect(await title(f.issueId)).toBe("User edit");
      // The same key with different arguments is refused.
      expect((await rpc("t3", "set_task_title", { title: "Other", onlyIfProvisional: false, idempotencyKey: "claude-1" })).isError).toBe(true);
      expect(await title(f.issueId)).toBe("User edit");
      // Writer generation moves: nothing further is dispatched.
      await db.update(nativeRunFinalizations).set({ controllerGeneration: 4 }).where(eq(nativeRunFinalizations.runId, f.runId));
      expect((await rpc("t4", "set_task_title", { title: "Stale", onlyIfProvisional: false, idempotencyKey: "claude-2" })).isError).toBe(true);
      expect(await title(f.issueId)).toBe("User edit");
      expect(Object.keys(await receipts(f.runId))).toEqual(["title:claude-1"]);
    } finally { await bridge.close(); await admission.close(); }
  });

  it("refuses unknown, foreign, unclaimed, ineligible and duplicate admissions with typed 4xx errors", async () => {
    const f = await seed();
    const refused = async (input: { companyId: string; runId: string }, status: number) => {
      const error = await admit()({ ...input, actorId: "board" }).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(status);
      expect((error as HttpError).message).not.toMatch(/boot-1|owner|[0-9a-f]{8}-/);
    };
    await refused({ companyId: f.companyId, runId: randomUUID() }, 409);
    await refused({ companyId: randomUUID(), runId: f.runId }, 409);
    const other = await seed("codex_app_server");
    await refused({ companyId: other.companyId, runId: other.runId }, 422);
    const unmarked = await seed(null);
    await refused({ companyId: unmarked.companyId, runId: unmarked.runId }, 422);
    const released = await seed();
    await db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.heartbeatRunId, released.runId));
    await refused({ companyId: released.companyId, runId: released.runId }, 409);
    const foreignController = await seed();
    await db.update(nativeRunFinalizations).set({ controllerPid: 1 }).where(eq(nativeRunFinalizations.runId, foreignController.runId));
    await refused({ companyId: foreignController.companyId, runId: foreignController.runId }, 409);
    // The live run cannot carry two Claude sessions; close() frees it, including after a refusal.
    const first = admit();
    const a = await first({ companyId: f.companyId, actorId: "board", runId: f.runId });
    await expect(first({ companyId: f.companyId, actorId: "board", runId: f.runId })).rejects.toMatchObject({ status: 409 });
    await a.close();
    await a.close();
    await (await first({ companyId: f.companyId, actorId: "board", runId: f.runId })).close();
  });

  it("closes the real tool authority exactly once", async () => {
    const f = await seed();
    const close = vi.fn();
    const make = createClaudeNativeAdmission(db, { controller: async () => identity, tools: () => ({ definitions: () => [{ name: "get_task_context", inputSchema: { type: "object" } }], execute: async () => ({}), close }) });
    const admission = await make({ companyId: f.companyId, actorId: "board", runId: f.runId });
    await admission.close();
    await admission.close();
    expect(close).toHaveBeenCalledTimes(1);
    // A refused admission also releases the tools it built.
    const closedOnRefusal = vi.fn();
    const refusing = createClaudeNativeAdmission(db, { controller: async () => ({ ...identity, pid: 9 }), tools: () => ({ definitions: () => [{ name: "x", inputSchema: {} }], execute: async () => ({}), close: closedOnRefusal }) });
    await expect(refusing({ companyId: f.companyId, actorId: "board", runId: f.runId })).rejects.toMatchObject({ status: 409 });
    expect(closedOnRefusal).toHaveBeenCalledTimes(1);
  });
});
