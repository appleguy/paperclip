import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { startRunnerToolBridge } from "@paperclipai/paperclip-runner";
import { ClaudeManagedSessions } from "../claude-native-presence.js";
import { createClaudeNativeAuthority } from "./claude-native-authority.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Claude managed session to admitted authority", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("claude-admitted-"); db = createDb(temporary.connectionString); }, 30_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  const identity = { bootId: "boot-1", pid: 4242, processStartedAt: new Date("2026-10-31T12:00:00Z") };
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), workspaceId = randomUUID(), leaseId = randomUUID(), nativeSessionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Admitted", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "paperclip_runner" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, mode: "local", strategyType: "local", name: "workspace", cwd: "/Volumes/NVM/AI_Agent_Runtime/tmp" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Task", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId, runtimeMode: "native", status: "running" });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: runId, issueId, executionWorkspaceId: workspaceId, status: "active" });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed", leaseOwner: "owner", attempt: 1, controllerGeneration: 1,
      controllerBootId: identity.bootId, controllerPid: identity.pid, controllerProcessStartedAt: identity.processStartedAt, leaseExpiresAt: new Date(Date.now() + 60_000) });
    return { companyId, runId, issueId, leaseId, nativeSessionId, scope: { companyId, runId, taskId: issueId, leaseId, nativeSessionId } };
  }

  it("serves real MCP calls through the authority and stops dispatching when the writer generation moves", async () => {
    const f = await seed();
    const execute = vi.fn(async (call: { tool: string; callId: string }): Promise<unknown> => ({ receipt: `${call.tool}:${call.callId}` }));
    const authority = await createClaudeNativeAuthority(db, { scope: f.scope, controller: { leaseOwner: "owner", attempt: 1, identity }, assertControllerActive: () => {},
      tools: { definitions: () => [{ name: "report_progress", inputSchema: { type: "object" } }], execute } });
    // Same bridge options as the Runner's openClaudeNativeMcpBinding (not exported from the package index; see result artifact wiring note).
    const bridge = await startRunnerToolBridge({ tools: authority.definitions(), preserveToolNames: true, preloadClaudeTaskTools: true, timeoutMs: null,
      handler: (call) => authority.dispatch(f.scope, call) });
    const server = { url: bridge.url, headers: { Authorization: `Bearer ${bridge.secret}` } };
    const rpc = async (id: string, name: string, args: object = {}) => (await (await fetch(server.url, { method: "POST", headers: { authorization: server.headers.Authorization, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) })).json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
    try {
      const ok = await rpc("a", "report_progress", { note: "x" });
      expect(ok.isError).not.toBe(true);
      expect(ok.content[0]!.text).toContain("report_progress");
      expect(execute).toHaveBeenCalledTimes(1);
      // Native Stop / text are not tools; the model-visible completion tools have no feedback boundary here.
      expect((await rpc("b", "paperclip_finish", {})).isError).toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
      await db.update(nativeRunFinalizations).set({ controllerGeneration: 2 }).where(eq(nativeRunFinalizations.runId, f.runId));
      expect((await rpc("c", "report_progress", { note: "stale" })).isError).toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally { await bridge.close(); }
  });

  it("launches an admitted managed session on the server-admitted native session and refuses unbound or mismatched admissions", async () => {
    const f = await seed();
    const stateDirectory = await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/claude-admitted-state-");
    const { chmod } = await import("node:fs/promises"); await chmod(stateDirectory, 0o700);
    try {
      const control = { identity: async () => ({}), ownerInput: async () => ({}), interrupt: async () => ({}), settlement: () => ({}), capabilities: () => ({ tools: "scoped_admitted_run" }), detach: async () => {} };
      const launch = vi.fn(async (_options: Record<string, unknown>) => control);
      const authority = await createClaudeNativeAuthority(db, { scope: f.scope, controller: { leaseOwner: "owner", attempt: 1, identity }, assertControllerActive: () => {},
        tools: { definitions: () => [{ name: "report_progress", inputSchema: { type: "object" } }], execute: async () => ({}) } });
      const options = { resolveWorkspace: async () => stateDirectory, resolveHostSettings: async () => ({ claudeExecutable: "/trusted/claude", home: "/trusted" }),
        stateDirectory, hookHelperExecutable: "/trusted/helper", model: "sonnet", effort: "high", launch };
      const admission = { scope: f.scope, definitions: authority.definitions, dispatch: authority.dispatch };
      const input = (requestId = randomUUID()) => ({ companyId: f.companyId, actorId: "board", requestId, workspaceId: randomUUID(), runId: f.runId });

      await expect(new ClaudeManagedSessions(options).start(input())).rejects.toThrow("admitted-run authority unavailable");
      await expect(new ClaudeManagedSessions({ ...options, admitRun: async () => ({ ...admission, scope: { ...f.scope, runId: randomUUID() } }) }).start(input())).rejects.toThrow("scope mismatch");
      expect(launch).not.toHaveBeenCalled();

      await new ClaudeManagedSessions({ ...options, admitRun: async () => admission }).start(input());
      const launched = launch.mock.calls[0]![0] as { sessionId: string; mcp: { scope: unknown; tools: unknown[]; dispatch: unknown } };
      expect(launched.sessionId).toBe(f.nativeSessionId);
      expect(launched.mcp).toMatchObject({ scope: f.scope, tools: [{ name: "report_progress" }] });
      expect(launched.mcp.dispatch).toBe(authority.dispatch);

      // Lifecycle: repeat launches are typed conflicts, unknown sessions typed 404s, and tool authority closes on detach.
      const close = vi.fn(async () => {});
      const sessions = new ClaudeManagedSessions({ ...options, admitRun: async () => ({ ...admission, close }) });
      const request = randomUUID();
      await sessions.start(input(request));
      await expect(sessions.start(input(request))).rejects.toMatchObject({ status: 409 });
      await expect(sessions.read(f.companyId, "board", randomUUID())).rejects.toMatchObject({ status: 404 });
      await expect(sessions.read(randomUUID(), "board", request)).rejects.toMatchObject({ status: 404 });
      expect(close).not.toHaveBeenCalled();
      await sessions.detach(f.companyId, "board", request);
      expect(close).toHaveBeenCalledTimes(1);
      // A failed launch also closes the admitted authority and surfaces the launch error.
      const failing = new ClaudeManagedSessions({ ...options, launch: async () => { throw new Error("launch failed"); }, admitRun: async () => ({ ...admission, close }) });
      await expect(failing.start(input())).rejects.toThrow("launch failed");
      expect(close).toHaveBeenCalledTimes(2);
      await expect(new ClaudeManagedSessions({ ...options, admitRun: async () => admission }).start({ ...input(), runId: "not-a-uuid" })).rejects.toMatchObject({ status: 422 });
    } finally { await rm(stateDirectory, { recursive: true, force: true }); }
  });
});
