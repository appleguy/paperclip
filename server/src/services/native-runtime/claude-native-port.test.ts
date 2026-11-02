import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { ClaudeInteractiveNativeBackend } from "@paperclipai/paperclip-runner";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT } from "../../vendor/paperclip-runner/testing.js";
import { ClaudeManagedSessions } from "../claude-native-presence.js";
import { CLAUDE_INTERACTIVE_DRIVER_KIND } from "./claude-native-admission.js";
import { ClaudeLiveSessionRegistry } from "./claude-native-live-sessions.js";
import { startClaudeNativeSession } from "./claude-native-port.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Claude native port over a real admitted run (zero inference)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let stateDirectory: string;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("claude-port-"); db = createDb(temporary.connectionString);
    stateDirectory = await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/claude-port-state-"); await chmod(stateDirectory, 0o700);
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); await rm(stateDirectory, { recursive: true, force: true }); });

  const controller = { bootId: "boot-1", pid: 4242, processStartedAt: new Date("2026-10-31T12:00:00Z") };
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), workspaceId = randomUUID(), nativeSessionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Port", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "paperclip_runner" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, mode: "local", strategyType: "local", name: "workspace", cwd: "/Volumes/NVM/AI_Agent_Runtime/tmp" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Task", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId, runtimeMode: "native", status: "running", driverKind: CLAUDE_INTERACTIVE_DRIVER_KIND });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    await db.insert(environmentLeases).values({ id: randomUUID(), companyId, heartbeatRunId: runId, issueId, executionWorkspaceId: workspaceId, status: "active" });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed", leaseOwner: "owner", attempt: 1, controllerGeneration: 3,
      controllerBootId: controller.bootId, controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt, leaseExpiresAt: new Date(Date.now() + 60_000) });
    const execution = { binding: { companyId, issueId, agentId, runId }, workspace: { cwd: "/Volumes/NVM/AI_Agent_Runtime/tmp" }, session: { normalizedSessionId: nativeSessionId },
      provider: { kind: "claude_interactive", model: "sonnet", effort: "high", autoCompactTokens: 200000 },
      completionContract: { contract: { revision: "standalone-v1", criteria: [{ id: "objective" }] } } } as never;
    return { companyId, agentId, issueId, runId, nativeSessionId, execution };
  }
  function start(f: Awaited<ReturnType<typeof seed>>, extra: Record<string, unknown> = {}) {
    const registry = new ClaudeLiveSessionRegistry();
    const control = { identity: vi.fn(async () => ({ pid: 1 })), ownerInput: vi.fn(async () => ({ write: "attempted", delivery: "unknown", completion: "unproven" })),
      interrupt: vi.fn(async () => ({})), settlement: () => ({}), capabilities: () => ({ tools: "scoped_admitted_run" }), detach: vi.fn(async () => {}) };
    const launched: Array<Record<string, any>> = [];
    const launch = vi.fn(async (options: Record<string, unknown>) => { launched.push(options); return control; });
    const feedback = vi.fn(async () => "accepted");
    const started = startClaudeNativeSession(db, { execution: f.execution, runnerInstanceId: "runner-1", leaseOwner: "owner", attempt: 1, controller,
      assertControllerActive: () => {}, completionFeedback: feedback, host: { claudeExecutable: "/trusted/claude", home: "/trusted", stateDirectory, hookHelperExecutable: "/trusted/helper" },
      launch, registry, pollMs: 20, settleTimeoutMs: 100, ...extra });
    return { started, registry, control, launch, launched, feedback };
  }
  const rpc = (s: Awaited<ReturnType<typeof start>["started"]>, launched: Array<Record<string, any>>, tool: string, callId: string, args: unknown) =>
    launched[0]!.mcp.dispatch(launched[0]!.mcp.scope, { tool, callId, arguments: args, signal: new AbortController().signal });

  it("launches once on the admitted native session, completes only through the authenticated finish receipt, and shares the session with the managed service", async () => {
    const f = await seed();
    const h = start(f);
    const { port, authorizeWorkSessionResult } = await h.started;
    expect(h.launch).toHaveBeenCalledTimes(1);
    expect(h.launched[0]).toMatchObject({ sessionId: f.nativeSessionId, model: "sonnet", effort: "high", autoCompactTokens: 200000 });
    expect(h.launched[0]!.mcp.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(["get_task_context", "set_task_title"]));
    // The Runner bridge publishes the completion tools itself and rejects them as caller tools.
    expect(h.launched[0]!.mcp.tools.map((tool: { name: string }) => tool.name)).not.toEqual(expect.arrayContaining(["paperclip_finish"]));
    expect(h.registry.has(f.companyId, f.runId)).toBe(true);
    // A repeated start for the same run never launches a second session.
    await expect(start(f).started).rejects.toThrow("claude_session_already_launched");
    expect(h.launch).toHaveBeenCalledTimes(1);

    // Managed service adopts the SAME live control (no admission, no launch).
    const managed = new ClaudeManagedSessions({ resolveWorkspace: async () => stateDirectory, resolveHostSettings: async () => ({ claudeExecutable: "/x", home: "/x" }),
      stateDirectory, hookHelperExecutable: "/trusted/helper", model: "sonnet", effort: "high", liveSessions: h.registry,
      launch: async () => { throw new Error("must not launch"); } });
    const request = randomUUID();
    await managed.start({ companyId: f.companyId, actorId: "board", requestId: request, workspaceId: randomUUID(), runId: f.runId });
    await managed.input(f.companyId, "board", request, "owner-1", "hello from owner");
    expect(h.control.ownerInput).toHaveBeenCalledWith({ operationId: "owner-1", text: "hello from owner" });
    await expect(new ClaudeManagedSessions({ resolveWorkspace: async () => stateDirectory, resolveHostSettings: async () => ({ claudeExecutable: "/x", home: "/x" }),
      stateDirectory, hookHelperExecutable: "/trusted/helper", model: "sonnet", effort: "high", liveSessions: new ClaudeLiveSessionRegistry() })
      .start({ companyId: f.companyId, actorId: "board", requestId: randomUUID(), workspaceId: randomUUID(), runId: f.runId })).rejects.toMatchObject({ status: 409 });

    const session = await new ClaudeInteractiveNativeBackend(port).openSession({ identity: port.identity });
    const events: Array<{ eventType: string; payload: unknown; sourceEventId: string }> = [];
    const reading = (async () => { for await (const event of session.events()) events.push(event as never); })();
    await session.startTurn({ message: { role: "user", text: "do the task" } } as never);
    expect(h.control.ownerInput).toHaveBeenCalledWith(expect.objectContaining({ text: "do the task" }));
    // Visible text, owner input and Stop are not completion: nothing is emitted until finish is journaled.
    await new Promise((done) => setTimeout(done, 80));
    expect(events).toEqual([]);
    await rpc(h.started as never, h.launched, "paperclip_finish", "fin-1", CONTROL_PLANE_CONFORMANCE_RESULT);
    await reading;
    expect(h.feedback).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.eventType)).toEqual(["run.result.proposed"]);
    expect(events[0]!.sourceEventId).toMatch(/^claude:[0-9a-f-]+:[a-f0-9]{64}$/);
    expect(await authorizeWorkSessionResult({ event: { schema: "paperclip.prp.event.v1", sourceKind: "runner", sourceInstanceId: "runner-1", runId: f.runId,
      normalizedSessionId: f.nativeSessionId, eventType: "run.result.proposed", sourceEventId: events[0]!.sourceEventId, sourceSeq: 1, payload: events[0]!.payload,
      emittedAt: (await port.readReceipt())!.recordedAt } as never, result: events[0]!.payload as never, signal: new AbortController().signal })).toBe(true);
    // A forged event with the same payload but another source is refused.
    expect(await authorizeWorkSessionResult({ event: { sourceKind: "runner", sourceInstanceId: "other", runId: f.runId, normalizedSessionId: f.nativeSessionId,
      eventType: "run.result.proposed", sourceEventId: events[0]!.sourceEventId, sourceSeq: 1, payload: events[0]!.payload, emittedAt: "x" } as never,
      result: events[0]!.payload as never, signal: new AbortController().signal })).toBe(false);
    await session.close({ reason: "test" });
    expect(h.control.detach).toHaveBeenCalledTimes(1);
    expect(h.registry.has(f.companyId, f.runId)).toBe(false);
    // Adoption dies with the executor session.
    await expect(managed.input(f.companyId, "board", request, "owner-2", "late")).rejects.toMatchObject({ status: 404 });
  }, 30_000);

  it("close refuses while a native tool effect is in flight or unrecorded, and never tears the conversation down", async () => {
    const f = await seed();
    let release!: () => void;
    const execute = vi.fn(() => new Promise((resolve) => { release = () => resolve({ ok: true }); }));
    const h = start(f, { admission: { tools: () => ({ definitions: () => [{ name: "report_progress", inputSchema: { type: "object" } }], execute }) } });
    const { port } = await h.started;
    const running = rpc(h.started as never, h.launched, "report_progress", "slow", { n: 1 });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await expect(port.close()).rejects.toThrow("claude_native_effects_unsettled");
    expect(h.control.detach).not.toHaveBeenCalled();
    expect(h.registry.has(f.companyId, f.runId)).toBe(true);
    release(); await running;
    await port.close();
    expect(h.control.detach).toHaveBeenCalledTimes(1);
    expect(h.registry.has(f.companyId, f.runId)).toBe(false);
  }, 30_000);

  it("settles the launched session when backend verification fails after launch (no NativeSession is returned)", async () => {
    const f = await seed();
    const h = start(f);
    const { port } = await h.started;
    expect(h.registry.has(f.companyId, f.runId)).toBe(true);
    h.control.identity.mockRejectedValueOnce(new Error("claude_process_identity_changed"));
    await expect(new ClaudeInteractiveNativeBackend(port).openSession({ identity: port.identity })).rejects.toThrow("claude_process_identity_changed");
    expect(h.control.detach).toHaveBeenCalledTimes(1);
    expect(h.registry.has(f.companyId, f.runId)).toBe(false);
    // Idempotent: the executor's fallback close must not detach again.
    await port.close();
    expect(h.control.detach).toHaveBeenCalledTimes(1);
    // The relaunch of a run that may have partially run stays refused.
    await expect(start(f).started).rejects.toThrow("claude_session_already_launched");
  }, 30_000);

  it("settles on a backend identity mismatch and on an aborted open as well", async () => {
    const mismatch = await seed();
    const a = start(mismatch);
    const { port: mismatchPort } = await a.started;
    await expect(new ClaudeInteractiveNativeBackend(mismatchPort).openSession({ identity: { ...mismatchPort.identity, runId: randomUUID() } })).rejects.toThrow("claude_interactive_backend_identity_mismatch");
    expect(a.control.detach).toHaveBeenCalledTimes(1);
    const aborted = await seed();
    const b = start(aborted);
    const { port: abortedPort } = await b.started;
    const controller = new AbortController(); controller.abort(new Error("shutdown"));
    await expect(new ClaudeInteractiveNativeBackend(abortedPort).openSession({ identity: abortedPort.identity, signal: controller.signal })).rejects.toThrow("shutdown");
    expect(b.control.detach).toHaveBeenCalledTimes(1);
    expect(b.registry.has(aborted.companyId, aborted.runId)).toBe(false);
  }, 30_000);

  it("keeps the launched session retained, and surfaces the original error, when a tool effect is unsettled during a verification failure", async () => {
    const f = await seed();
    let release!: () => void;
    const execute = vi.fn(() => new Promise((resolve) => { release = () => resolve({ ok: true }); }));
    const h = start(f, { admission: { tools: () => ({ definitions: () => [{ name: "report_progress", inputSchema: { type: "object" } }], execute }) } });
    const { port } = await h.started;
    const running = rpc(h.started as never, h.launched, "report_progress", "slow", { n: 1 });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    h.control.identity.mockRejectedValueOnce(new Error("claude_process_identity_changed"));
    // The original verification error wins; the refused settlement is not reported over it.
    await expect(new ClaudeInteractiveNativeBackend(port).openSession({ identity: port.identity })).rejects.toThrow("claude_process_identity_changed");
    expect(h.control.detach).not.toHaveBeenCalled();
    expect(h.registry.has(f.companyId, f.runId)).toBe(true);
    release(); await running;
    await port.close();
    expect(h.control.detach).toHaveBeenCalledTimes(1);
    expect(h.registry.has(f.companyId, f.runId)).toBe(false);
  }, 30_000);

  it("refuses a run that is not admitted for the Claude driver and leaves no launch", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ driverKind: "codex_app_server" }).where(eq(heartbeatRuns.id, f.runId));
    const h = start(f);
    await expect(h.started).rejects.toThrow();
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.registry.has(f.companyId, f.runId)).toBe(false);
  });
});
