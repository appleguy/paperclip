import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { badRequest } from "../../errors.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT } from "../../vendor/paperclip-runner/testing.js";
import { readClaudeTerminalReceipt } from "./claude-native-semantic-journal.js";
import { CLAUDE_NATIVE_PRE_EFFECT, createClaudeNativeAuthority, type ClaudeNativeScope } from "./claude-native-authority.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Claude native authority", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("claude-native-authority-"); db = createDb(temporary.connectionString); }, 30_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  const identity = { bootId: "boot-1", pid: 4242, processStartedAt: new Date("2026-10-31T12:00:00Z") };
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), projectId = randomUUID();
    const workspaceId = randomUUID(), leaseId = randomUUID(), nativeSessionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Claude native", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "paperclip_runner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Project" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, mode: "local", strategyType: "local", name: "workspace", cwd: "/Volumes/NVM/AI_Agent_Runtime/tmp" });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Task", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId, runtimeMode: "native", status: "running" });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: runId, issueId, executionWorkspaceId: workspaceId, status: "active" });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed", leaseOwner: "owner", attempt: 1, controllerGeneration: 3,
      controllerBootId: identity.bootId, controllerPid: identity.pid, controllerProcessStartedAt: identity.processStartedAt, leaseExpiresAt: new Date(Date.now() + 60_000) });
    const scope: ClaudeNativeScope = { companyId, runId, taskId: issueId, leaseId, nativeSessionId };
    return { companyId, agentId, issueId, runId, projectId, workspaceId, leaseId, nativeSessionId, scope };
  }
  function harness(scope: ClaudeNativeScope, over: Record<string, unknown> = {}) {
    const execute = vi.fn(async (call: { tool: string; callId: string; arguments: unknown }): Promise<unknown> => ({ ok: true, echoed: call }));
    const tools = { definitions: () => [{ name: "get_task_context", inputSchema: { type: "object" } }, { name: "report_progress", inputSchema: { type: "object" } }], execute };
    const input = { scope, controller: { leaseOwner: "owner", attempt: 1, identity }, assertControllerActive: () => {}, tools, ...over };
    return { execute, input: input as Parameters<typeof createClaudeNativeAuthority>[1] };
  }
  const signal = () => new AbortController().signal;
  const call = (tool: string, callId: string, args: unknown = {}) => ({ tool, callId, arguments: args, signal: signal() });

  it("derives authority from server rows and routes an advertised tool to the existing authority", async () => {
    const f = await seed();
    const h = harness(f.scope);
    const authority = await createClaudeNativeAuthority(db, h.input);
    expect(authority.binding).toEqual({ companyId: f.companyId, projectId: f.projectId, issueId: f.issueId, agentId: f.agentId, runId: f.runId,
      nativeSessionId: f.nativeSessionId, environmentLeaseId: f.leaseId, executionWorkspaceId: f.workspaceId, leaseOwner: "owner", attempt: 1, writerGeneration: 3 });
    expect(authority.definitions().map((tool) => tool.name)).toEqual(["get_task_context", "report_progress"]);
    const result = await authority.dispatch(f.scope, call("get_task_context", "c1", { a: 1 }));
    expect(result).toEqual({ ok: true, echoed: { tool: "get_task_context", callId: "c1", arguments: { a: 1 } } });
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["foreign company", (f: Awaited<ReturnType<typeof seed>>) => ({ scope: { ...f.scope, companyId: randomUUID() } })],
    ["unknown run", (f: Awaited<ReturnType<typeof seed>>) => ({ scope: { ...f.scope, runId: randomUUID() } })],
    ["foreign task", (f: Awaited<ReturnType<typeof seed>>) => ({ scope: { ...f.scope, taskId: randomUUID() } })],
    ["unknown lease", (f: Awaited<ReturnType<typeof seed>>) => ({ scope: { ...f.scope, leaseId: randomUUID() } })],
    ["foreign native session", (f: Awaited<ReturnType<typeof seed>>) => ({ scope: { ...f.scope, nativeSessionId: randomUUID() } })],
    ["non-UUID scope", (f: Awaited<ReturnType<typeof seed>>) => ({ scope: { ...f.scope, leaseId: "lease" } })],
    ["other lease owner", () => ({ controller: { leaseOwner: "intruder", attempt: 1, identity } })],
    ["other attempt", () => ({ controller: { leaseOwner: "owner", attempt: 2, identity } })],
    ["other controller process", () => ({ controller: { leaseOwner: "owner", attempt: 1, identity: { ...identity, pid: 1 } } })],
    ["inactive controller", () => ({ assertControllerActive: () => { throw new Error("stopped"); } })],
  ])("refuses to bind: %s", async (_name, change) => {
    const f = await seed();
    await expect(createClaudeNativeAuthority(db, { ...harness(f.scope).input, ...change(f) } as never)).rejects.toThrow(/claude_native_/);
  });

  it.each([
    ["released environment lease", (f: Awaited<ReturnType<typeof seed>>) => db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.id, f.leaseId))],
    ["expired environment lease", (f: Awaited<ReturnType<typeof seed>>) => db.update(environmentLeases).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(environmentLeases.id, f.leaseId))],
    ["expired controller lease", (f: Awaited<ReturnType<typeof seed>>) => db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(nativeRunFinalizations.runId, f.runId))],
    ["finished run", (f: Awaited<ReturnType<typeof seed>>) => db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId))],
    ["reassigned task", (f: Awaited<ReturnType<typeof seed>>) => db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId))],
    ["superseded execution run", (f: Awaited<ReturnType<typeof seed>>) => db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId))],
    ["paused agent", (f: Awaited<ReturnType<typeof seed>>) => db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId))],
    ["finalization moved on", (f: Awaited<ReturnType<typeof seed>>) => db.update(nativeRunFinalizations).set({ phase: "arbitrating" }).where(eq(nativeRunFinalizations.runId, f.runId))],
  ])("refuses to bind: %s", async (_name, mutate) => {
    const f = await seed();
    await mutate(f);
    await expect(createClaudeNativeAuthority(db, harness(f.scope).input)).rejects.toThrow("claude_native_authority_unavailable");
  });

  it("rechecks live authority immediately before dispatch and refuses stale writer generations, lost leases and lost controllers", async () => {
    const f = await seed();
    const h = harness(f.scope);
    let active = true;
    const authority = await createClaudeNativeAuthority(db, { ...h.input, assertControllerActive: () => { if (!active) throw new Error("stopped"); } });
    await authority.dispatch(f.scope, call("report_progress", "ok"));
    await db.update(nativeRunFinalizations).set({ controllerGeneration: 4 }).where(eq(nativeRunFinalizations.runId, f.runId));
    await expect(authority.dispatch(f.scope, call("report_progress", "stale"))).rejects.toThrow("claude_native_authority_lost");
    await db.update(nativeRunFinalizations).set({ controllerGeneration: 3 }).where(eq(nativeRunFinalizations.runId, f.runId));
    await authority.dispatch(f.scope, call("report_progress", "restored")); // a rolled-back generation is the same exact binding again
    await db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.id, f.leaseId));
    await expect(authority.dispatch(f.scope, call("report_progress", "released"))).rejects.toThrow("claude_native_authority_lost");
    await db.update(environmentLeases).set({ status: "active" }).where(eq(environmentLeases.id, f.leaseId));
    active = false;
    await expect(authority.dispatch(f.scope, call("report_progress", "stopped"))).rejects.toThrow("claude_native_authority_lost");
    expect(h.execute.mock.calls.map(([c]) => c.callId)).toEqual(["ok", "restored"]);
    expect(await authority.admit()).toBe(false);
  });

  it("rejects foreign scope, unknown tools, invalid and aborted calls without dispatching", async () => {
    const f = await seed(), other = await seed();
    const h = harness(f.scope);
    const authority = await createClaudeNativeAuthority(db, h.input);
    await expect(authority.dispatch(other.scope, call("report_progress", "x"))).rejects.toThrow("claude_native_scope_mismatch");
    await expect(authority.dispatch({ ...f.scope, leaseId: other.leaseId }, call("report_progress", "x"))).rejects.toThrow("claude_native_scope_mismatch");
    await expect(authority.dispatch(f.scope, call("delete_everything", "x"))).rejects.toThrow("claude_native_tool_unknown");
    await expect(authority.dispatch(f.scope, call("workspace_run", "x"))).rejects.toThrow("claude_native_tool_unknown");
    await expect(authority.dispatch(f.scope, call("report_progress", ""))).rejects.toThrow("claude_native_call_invalid");
    const controller = new AbortController(); controller.abort();
    await expect(authority.dispatch(f.scope, { ...call("report_progress", "x"), signal: controller.signal })).rejects.toThrow("claude_native_cancelled");
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("joins in-flight duplicates, rejects a reused call ID, and never replays an unknown outcome", async () => {
    const f = await seed();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness(f.scope);
    h.execute.mockImplementation(async (c) => {
      if (c.callId === "slow") { await gate; return { done: true }; }
      if (c.callId === "lost") throw new Error("connection reset after send");
      if (c.callId === "invalid") throw badRequest("bad arguments");
      return { ok: true } as never;
    });
    const authority = await createClaudeNativeAuthority(db, h.input);
    const first = authority.dispatch(f.scope, call("report_progress", "slow", { n: 1 }));
    const second = authority.dispatch(f.scope, call("report_progress", "slow", { n: 1 }));
    await expect(authority.dispatch(f.scope, call("report_progress", "slow", { n: 2 }))).rejects.toThrow("claude_native_call_id_reused");
    await vi.waitFor(() => expect(h.execute).toHaveBeenCalledTimes(1));
    release();
    expect(await first).toEqual({ done: true });
    expect(await second).toEqual({ done: true });
    expect(h.execute).toHaveBeenCalledTimes(1);

    await expect(authority.dispatch(f.scope, call("report_progress", "lost"))).rejects.toThrow("connection reset");
    await expect(authority.dispatch(f.scope, call("report_progress", "lost"))).rejects.toThrow("claude_native_outcome_unknown");
    expect(h.execute.mock.calls.filter(([c]) => c.callId === "lost")).toHaveLength(1);

    // A finished call never executes again under the same ID, even for side-effecting tools.
    expect(await authority.dispatch(f.scope, call("report_progress", "slow", { n: 1 }))).toEqual({ done: true });
    expect(await authority.dispatch(f.scope, call("report_progress", "slow", { n: 1 }))).toEqual({ done: true });
    expect(h.execute.mock.calls.filter(([c]) => c.callId === "slow")).toHaveLength(1);

    // A 4xx from the tool is NOT proof of no effect (it may have committed first): unknown, never replayed.
    await expect(authority.dispatch(f.scope, call("report_progress", "invalid", { n: 1 }))).rejects.toThrow("bad arguments");
    await expect(authority.dispatch(f.scope, call("report_progress", "invalid", { n: 1 }))).rejects.toThrow("claude_native_outcome_unknown");
    expect(h.execute.mock.calls.filter(([c]) => c.callId === "invalid")).toHaveLength(1);

    // Only an explicit pre-effect marker, or a tool declared replay-safe, frees the ID.
    h.execute.mockImplementation(async (c) => { throw c.callId === "marked" ? Object.assign(badRequest("rejected"), { [CLAUDE_NATIVE_PRE_EFFECT]: true }) : badRequest("rejected"); });
    await expect(authority.dispatch(f.scope, call("report_progress", "marked", { n: 1 }))).rejects.toThrow("rejected");
    await expect(authority.dispatch(f.scope, call("report_progress", "marked", { n: 1 }))).rejects.toThrow("rejected");
    expect(h.execute.mock.calls.filter(([c]) => c.callId === "marked")).toHaveLength(2);
    const safe = await createClaudeNativeAuthority(db, { ...h.input, replaySafeTools: new Set(["report_progress"]) });
    await expect(safe.dispatch(f.scope, call("report_progress", "safe"))).rejects.toThrow("rejected");
    await expect(safe.dispatch(f.scope, call("report_progress", "safe"))).rejects.toThrow("rejected");
    expect(h.execute.mock.calls.filter(([c]) => c.callId === "safe")).toHaveLength(2);
  });

  describe("completion", () => {
    const completion = (f: Awaited<ReturnType<typeof seed>>, over: Record<string, unknown> = {}) => {
      const feedback = vi.fn(async () => "accepted");
      return { feedback, completion: { definitions: [{ name: "paperclip_finish", inputSchema: { type: "object" } }, { name: "paperclip_block", inputSchema: { type: "object" } }],
        contract: { revision: "standalone-v1", criterionIds: ["objective"] }, feedback, ...over } };
    };

    it("is neither advertised nor callable without a controller-supplied feedback boundary", async () => {
      const f = await seed();
      const authority = await createClaudeNativeAuthority(db, harness(f.scope).input);
      expect(authority.definitions().map((tool) => tool.name)).not.toContain("paperclip_finish");
      await expect(authority.dispatch(f.scope, call("paperclip_finish", "x", CONTROL_PLANE_CONFORMANCE_RESULT))).rejects.toThrow("claude_native_tool_unknown");
    });

    it("validates against the admitted contract, then calls feedback once and never the task tools", async () => {
      const f = await seed();
      const h = harness(f.scope), c = completion(f);
      const authority = await createClaudeNativeAuthority(db, { ...h.input, completion: c.completion });
      await expect(authority.dispatch(f.scope, call("paperclip_finish", "bad", { nope: true }))).rejects.toThrow("claude_native_result_invalid");
      await expect(authority.dispatch(f.scope, call("paperclip_block", "wrong-tool", CONTROL_PLANE_CONFORMANCE_RESULT))).rejects.toThrow("claude_native_contract_mismatch");
      const stale = { ...CONTROL_PLANE_CONFORMANCE_RESULT, completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: "old" } };
      await expect(authority.dispatch(f.scope, call("paperclip_finish", "stale", stale))).rejects.toThrow("claude_native_contract_mismatch");
      expect(c.feedback).not.toHaveBeenCalled();
      expect(await authority.dispatch(f.scope, call("paperclip_finish", "good", CONTROL_PLANE_CONFORMANCE_RESULT))).toMatchObject({ feedback: "accepted" });
      expect(c.feedback).toHaveBeenCalledTimes(1);
      expect(h.execute).not.toHaveBeenCalled();
    });

    it("does not reach feedback after authority loss and treats a feedback failure as unknown", async () => {
      const f = await seed();
      const c = completion(f);
      const authority = await createClaudeNativeAuthority(db, { ...harness(f.scope).input, completion: c.completion });
      await db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.id, f.leaseId));
      await expect(authority.dispatch(f.scope, call("paperclip_finish", "lost", CONTROL_PLANE_CONFORMANCE_RESULT))).rejects.toThrow("claude_native_authority_lost");
      expect(c.feedback).not.toHaveBeenCalled();

      const g = await seed(), failing = completion(g, { feedback: vi.fn(async () => { throw new Error("feedback transport lost"); }) });
      const second = await createClaudeNativeAuthority(db, { ...harness(g.scope).input, completion: failing.completion });
      await expect(second.dispatch(g.scope, call("paperclip_finish", "f", CONTROL_PLANE_CONFORMANCE_RESULT))).rejects.toThrow("feedback transport lost");
      await expect(second.dispatch(g.scope, call("paperclip_finish", "f", CONTROL_PLANE_CONFORMANCE_RESULT))).rejects.toThrow("claude_native_outcome_unknown");
    });
  });
  describe("durable semantic journal", () => {
    const fin = () => ({ definitions: [{ name: "paperclip_finish", inputSchema: { type: "object" } }, { name: "paperclip_block", inputSchema: { type: "object" } }],
      contract: { revision: "standalone-v1", criterionIds: ["objective"] }, feedback: vi.fn(async () => "accepted") });

    it("keeps an unknown outcome unknown across a new authority instance (restart) and never re-executes", async () => {
      const f = await seed();
      const h = harness(f.scope);
      h.execute.mockImplementation(async () => { throw new Error("connection reset after send"); });
      const before = await createClaudeNativeAuthority(db, h.input);
      await expect(before.dispatch(f.scope, call("report_progress", "r1", { n: 1 }))).rejects.toThrow("connection reset");
      // Simulated restart: the in-memory call map is gone, the durable reservation is not.
      const after = await createClaudeNativeAuthority(db, h.input);
      await expect(after.dispatch(f.scope, call("report_progress", "r1", { n: 1 }))).rejects.toThrow("claude_native_outcome_unknown");
      expect(h.execute).toHaveBeenCalledTimes(1);
    });

    it("a completed side-effecting call is recorded once and a restart never executes it again", async () => {
      const f = await seed();
      const h = harness(f.scope);
      const before = await createClaudeNativeAuthority(db, h.input);
      await before.dispatch(f.scope, call("report_progress", "ok1", { n: 1 }));
      const after = await createClaudeNativeAuthority(db, h.input);
      await expect(after.dispatch(f.scope, call("report_progress", "ok1", { n: 1 }))).rejects.toThrow("claude_native_outcome_unknown");
      await expect(after.dispatch(f.scope, call("report_progress", "ok1", { n: 2 }))).rejects.toThrow("claude_semantic_identity_conflict");
      expect(h.execute).toHaveBeenCalledTimes(1);
    });

    it("records the authenticated terminal receipt once and refuses a second finish", async () => {
      const f = await seed();
      const c = fin();
      const input = { ...harness(f.scope).input, completion: c };
      const authority = await createClaudeNativeAuthority(db, input);
      const journal = { companyId: f.companyId, issueId: f.issueId, runId: f.runId, nativeSessionId: f.nativeSessionId, leaseOwner: "owner", attempt: 1, writerGeneration: 3, identity };
      expect(await readClaudeTerminalReceipt(db, journal)).toBeNull();
      await authority.dispatch(f.scope, call("paperclip_finish", "t1", CONTROL_PLANE_CONFORMANCE_RESULT));
      expect((await readClaudeTerminalReceipt(db, journal))?.result).toEqual(CONTROL_PLANE_CONFORMANCE_RESULT);
      const restarted = await createClaudeNativeAuthority(db, input);
      await expect(restarted.dispatch(f.scope, call("paperclip_finish", "t2", CONTROL_PLANE_CONFORMANCE_RESULT))).rejects.toThrow("claude_semantic_terminal_already_recorded");
      expect(c.feedback).toHaveBeenCalledTimes(1);
    });

    it("an unknown terminal outcome survives restart and blocks any second terminal call", async () => {
      const f = await seed();
      const c = fin();
      c.feedback.mockRejectedValue(new Error("feedback transport lost"));
      const authority = await createClaudeNativeAuthority(db, { ...harness(f.scope).input, completion: c });
      await expect(authority.dispatch(f.scope, call("paperclip_finish", "u1", CONTROL_PLANE_CONFORMANCE_RESULT))).rejects.toThrow("feedback transport lost");
      const restarted = await createClaudeNativeAuthority(db, { ...harness(f.scope).input, completion: c });
      await expect(restarted.dispatch(f.scope, call("paperclip_finish", "u2", CONTROL_PLANE_CONFORMANCE_RESULT))).rejects.toThrow("claude_native_outcome_unknown");
      expect(c.feedback).toHaveBeenCalledTimes(1);
    });

    it("finish/block intent durably blocks every later mutating call, even across restart, but not pure reads", async () => {
      const f = await seed();
      const c = fin();
      c.feedback.mockRejectedValue(new Error("feedback transport lost"));
      const h = harness(f.scope, { completion: c, readOnlyTools: new Set(["get_task_context"]) });
      const authority = await createClaudeNativeAuthority(db, h.input);
      await expect(authority.dispatch(f.scope, call("paperclip_finish", "i1", CONTROL_PLANE_CONFORMANCE_RESULT))).rejects.toThrow("feedback transport lost");
      // Same process: the in-memory intent refuses; restart: the durable reservation refuses.
      await expect(authority.dispatch(f.scope, call("report_progress", "after1", { n: 1 }))).rejects.toThrow("claude_native_terminal_pending");
      const restarted = await createClaudeNativeAuthority(db, h.input);
      await expect(restarted.dispatch(f.scope, call("report_progress", "after2", { n: 2 }))).rejects.toThrow("claude_native_terminal_pending");
      expect(h.execute).not.toHaveBeenCalled();
      await restarted.dispatch(f.scope, call("get_task_context", "read1"));
      expect(h.execute).toHaveBeenCalledTimes(1);
    });

    it("a replay-safe mutating tool (own receipt, journaled reservation) is also refused after a recorded finish", async () => {
      const f = await seed();
      const c = fin();
      const h = harness(f.scope, { completion: c, replaySafeTools: new Set(["report_progress"]) });
      const authority = await createClaudeNativeAuthority(db, h.input);
      await authority.dispatch(f.scope, call("report_progress", "pre", { n: 0 }));
      await authority.dispatch(f.scope, call("paperclip_finish", "done", CONTROL_PLANE_CONFORMANCE_RESULT));
      const restarted = await createClaudeNativeAuthority(db, h.input);
      await expect(restarted.dispatch(f.scope, call("report_progress", "late", { n: 1 }))).rejects.toThrow("claude_native_terminal_pending");
      expect(h.execute).toHaveBeenCalledTimes(1);
    });

    it("an idempotent replay-safe call left in flight across restart blocks finish until it is reconciled by replay", async () => {
      const f = await seed();
      const c = fin();
      const h = harness(f.scope, { completion: c, replaySafeTools: new Set(["report_progress"]) });
      const first = await createClaudeNativeAuthority(db, h.input);
      h.execute.mockImplementationOnce(() => new Promise(() => {})); // crashed mid-effect: never settles
      void first.dispatch(f.scope, call("report_progress", "crashy", { n: 7 })).catch(() => {});
      await vi.waitFor(() => expect(h.execute).toHaveBeenCalledTimes(1));
      expect(await first.unsettled()).toBe(1);
      // Restarted controller: replay fails, so the idempotent effect is still unknown and finish is refused.
      const restarted = await createClaudeNativeAuthority(db, h.input);
      h.execute.mockRejectedValueOnce(new Error("still unreachable"));
      await expect(restarted.dispatch(f.scope, call("paperclip_finish", "f1", CONTROL_PLANE_CONFORMANCE_RESULT))).rejects.toThrow("claude_native_effects_unsettled");
      expect(c.feedback).not.toHaveBeenCalled();
      expect(await restarted.unsettled()).toBe(1);
      // Replay under the original call ID and arguments reconciles through the tool's own receipt, then finish passes.
      await restarted.dispatch(f.scope, call("paperclip_finish", "f2", CONTROL_PLANE_CONFORMANCE_RESULT));
      expect(h.execute).toHaveBeenLastCalledWith({ tool: "report_progress", callId: "crashy", arguments: { n: 7 } });
      expect(c.feedback).toHaveBeenCalledTimes(1);
      expect(await restarted.unsettled()).toBe(0);
    });

    it("an unknown non-replayable effect is never reconciled by finish", async () => {
      const f = await seed();
      const c = fin();
      const h = harness(f.scope, { completion: c });
      const first = await createClaudeNativeAuthority(db, h.input);
      h.execute.mockImplementationOnce(() => new Promise(() => {}));
      void first.dispatch(f.scope, call("report_progress", "lost", { n: 1 })).catch(() => {});
      await vi.waitFor(() => expect(h.execute).toHaveBeenCalledTimes(1));
      const restarted = await createClaudeNativeAuthority(db, h.input);
      await expect(restarted.dispatch(f.scope, call("paperclip_finish", "f", CONTROL_PLANE_CONFORMANCE_RESULT))).rejects.toThrow("claude_native_effects_unsettled");
      expect(h.execute).toHaveBeenCalledTimes(1);
      expect(await restarted.unsettled()).toBe(1);
    });

    it("refuses finish while a mutating call is in flight, then allows it once effects settle", async () => {
      const f = await seed();
      const c = fin();
      const h = harness(f.scope, { completion: c });
      let release!: () => void;
      h.execute.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ ok: true }); }));
      const authority = await createClaudeNativeAuthority(db, h.input);
      const running = authority.dispatch(f.scope, call("report_progress", "slow", { n: 1 }));
      await vi.waitFor(() => expect(h.execute).toHaveBeenCalledTimes(1));
      await expect(authority.dispatch(f.scope, call("paperclip_finish", "early", CONTROL_PLANE_CONFORMANCE_RESULT))).rejects.toThrow("claude_native_effects_unsettled");
      expect(await authority.settled(50)).toBe(false);
      expect(c.feedback).not.toHaveBeenCalled();
      release();
      await running;
      expect(await authority.settled(1000)).toBe(true);
      // The refusal was provably pre-effect: the same call ID may finish now.
      await authority.dispatch(f.scope, call("paperclip_finish", "early", CONTROL_PLANE_CONFORMANCE_RESULT));
      expect(c.feedback).toHaveBeenCalledTimes(1);
    });

    it("an earlier mutating call with an unknown outcome blocks finish (effects unsettled) after restart", async () => {
      const f = await seed();
      const c = fin();
      const h = harness(f.scope, { completion: c });
      h.execute.mockRejectedValueOnce(new Error("connection reset after send"));
      const before = await createClaudeNativeAuthority(db, h.input);
      await expect(before.dispatch(f.scope, call("report_progress", "u", { n: 1 }))).rejects.toThrow("connection reset");
      const restarted = await createClaudeNativeAuthority(db, h.input);
      await expect(restarted.dispatch(f.scope, call("paperclip_finish", "blocked", CONTROL_PLANE_CONFORMANCE_RESULT))).rejects.toThrow("claude_native_effects_unsettled");
      expect(c.feedback).not.toHaveBeenCalled();
    });

    it("a stale writer generation cannot reserve", async () => {
      const f = await seed();
      const h = harness(f.scope);
      const authority = await createClaudeNativeAuthority(db, h.input);
      await db.update(nativeRunFinalizations).set({ controllerGeneration: 9 }).where(eq(nativeRunFinalizations.runId, f.runId));
      await expect(authority.dispatch(f.scope, call("report_progress", "s1"))).rejects.toThrow("claude_native_authority_lost");
      expect(h.execute).not.toHaveBeenCalled();
    });
  });
});
