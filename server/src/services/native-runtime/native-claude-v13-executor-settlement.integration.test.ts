import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, completionContracts, createDb, environmentLeases, executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { isNativeRunnerOwnershipHeld, NativeRunnerOwnershipUnverifiedError } from "./native-runner-ownership.js";
import type { NativeExecutionInputV13 } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";

// Root finding: the real Claude session is launched before ClaudeInteractiveNativeBackend.openSession, so any failure between
// launch and a returned NativeSession (here: the backend factory refusing the admitted port) must be settled by the executor's finally.
const started = vi.hoisted(() => ({ close: undefined as undefined | ReturnType<typeof vi.fn>, agentId: "", guard: undefined as undefined | (() => unknown) }));
// Terra's OpenCode retention guard: the real function unless a test arms a hold (or a mismatch throw).
vi.mock("./opencode-managed-admission.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./opencode-managed-admission.js")>();
  return { ...original, getOpenCodeRetainedOwnership: (...args: Parameters<typeof original.getOpenCodeRetainedOwnership>) => started.guard ? started.guard() : original.getOpenCodeRetainedOwnership(...args) };
});
vi.mock("./claude-native-port.js", () => ({
  startClaudeNativeSession: vi.fn(async (_db: unknown, input: { execution: { binding: Record<string, string>; session: { normalizedSessionId: string } } }) => {
    started.close = vi.fn(async () => {});
    // Identity deliberately mismatches the run's agent, so createNativeSessionBackend refuses it AFTER the (fake) launch.
    const identity = { runId: input.execution.binding.runId, sessionId: input.execution.session.normalizedSessionId, companyId: input.execution.binding.companyId, issueId: input.execution.binding.issueId, agentId: randomUUID() };
    const port = { identity, runnerInstanceId: "r", nativeSessionId: identity.sessionId, verify: async () => {}, readReceipt: async () => null, dispatch: async () => {}, waitForReceipt: async () => { throw new Error("unused"); }, close: started.close };
    return { port, authorizeWorkSessionResult: async () => false, control: {}, admission: {} };
  }),
}));

describe("executor settles a launched Claude session when no NativeSession is returned", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID();
  const saved = { dir: process.env.PAPERCLIP_CLAUDE_INTERACTIVE_STATE_DIR, helper: process.env.PAPERCLIP_CLAUDE_HOOK_HELPER };
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-claude-v13-settle-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Claude v13 settle", issuePrefix: "CV14" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Claude agent", status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "claude_interactive", model: "claude-sonnet-5-5", effort: "high" } });
  });
  afterAll(async () => {
    if (saved.dir === undefined) delete process.env.PAPERCLIP_CLAUDE_INTERACTIVE_STATE_DIR; else process.env.PAPERCLIP_CLAUDE_INTERACTIVE_STATE_DIR = saved.dir;
    if (saved.helper === undefined) delete process.env.PAPERCLIP_CLAUDE_HOOK_HELPER; else process.env.PAPERCLIP_CLAUDE_HOOK_HELPER = saved.helper;
    await temporary?.cleanup();
  });

  async function seed(overrides: { cwd?: string | null } = {}) {
    const issueId = randomUUID(), runId = randomUUID();
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Claude v13", status: "in_progress", workMode: "standard", assigneeAgentId: agentId }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId, invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId } }).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    // Mirror runtime-selection: it records the v13 session driver on the run and holds one active local lease.
    await db.update(heartbeatRuns).set({ driverKind: "claude_interactive_v1" }).where(eq(heartbeatRuns.id, runId));
    await db.insert(executionWorkspaces).values({ id: runId, companyId, mode: "local", strategyType: "local", name: "workspace", cwd: "/tmp" });
    await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId, issueId, executionWorkspaceId: runId, provider: "local", status: "active" });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const completionInput = buildNativeCompletionContract(issue, { revision: contract.revision });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const execution = {
      schema: "paperclip.native-execution-input.v13",
      binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "claude_interactive", model: "claude-sonnet-5-5", effort: "high", autoCompactTokens: 200000 },
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Call get_task_context then stop.", workMode: "standard" },
      workspace: { cwd: overrides.cwd === undefined ? "/tmp" : overrides.cwd, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "claude_interactive_v1", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1", contract: completionInput },
      interactionResponses: [], credentialBindings: [],
    } as unknown as NativeExecutionInputV13;
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
    return { execution, runId, runnerInstanceId: native.runnerInstanceId };
  }


  const durable = async (runId: string, issueId: string) => {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const leases = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, runId));
    return { run, issue, leases };
  };

  it("settled cleanup follows the normal failure disposition and surfaces the original error", async () => {
    process.env.PAPERCLIP_CLAUDE_INTERACTIVE_STATE_DIR = "/Volumes/NVM/AI_Agent_Runtime/tmp"; process.env.PAPERCLIP_CLAUDE_HOOK_HELPER = "/trusted/helper";
    const { execution, runId, runnerInstanceId } = await seed();
    const error = await executePaperclipNativeSession({ db, execution, runnerInstanceId }).then(() => null, (reason: unknown) => reason);
    expect(String((error as Error)?.message ?? error)).toContain("Claude interactive v13 requires an admitted server-owned native backend");
    expect(started.close).toHaveBeenCalled();
    const { run } = await durable(runId, execution.binding.issueId);
    expect(isNativeRunnerOwnershipHeld(run)).toBe(false);
    expect(run.status).not.toBe("running");
  }, 60_000);

  it("a refused settlement (unsettled effects) retains run/task/lease ownership with the original failure as evidence", async () => {
    process.env.PAPERCLIP_CLAUDE_INTERACTIVE_STATE_DIR = "/Volumes/NVM/AI_Agent_Runtime/tmp"; process.env.PAPERCLIP_CLAUDE_HOOK_HELPER = "/trusted/helper";
    const { execution, runId, runnerInstanceId } = await seed();
    const { startClaudeNativeSession } = await import("./claude-native-port.js");
    const original = vi.mocked(startClaudeNativeSession).getMockImplementation()!;
    vi.mocked(startClaudeNativeSession).mockImplementationOnce(async (...args: Parameters<typeof startClaudeNativeSession>) => {
      const result = await original(...args);
      started.close!.mockRejectedValue(new Error("claude_native_effects_unsettled"));
      return result;
    });
    const error = await executePaperclipNativeSession({ db, execution, runnerInstanceId }).then(() => null, (reason: unknown) => reason);
    // Heartbeat's recognized held-ownership signal, not the raw cleanup refusal.
    expect(error).toBeInstanceOf(NativeRunnerOwnershipUnverifiedError);
    expect(started.close).toHaveBeenCalled();
    const { run, issue, leases } = await durable(runId, execution.binding.issueId);
    expect(run.status).toBe("running");
    expect(run.finishedAt).toBeNull();
    expect(run.nativePhase).toBe("terminal_failure");
    expect(run.errorCode).toBe("native_execution_ownership_unverified");
    expect(isNativeRunnerOwnershipHeld(run)).toBe(true); // the persisted marker heartbeat teardown and claims consult
    expect(run.error).toContain("Claude interactive v13 requires an admitted server-owned native backend"); // original failure kept
    const retained = (run.resultJson as { claudeRetainedOwnership?: { nativeSessionId?: string; originalError?: string } } | null)?.claudeRetainedOwnership;
    expect(retained?.nativeSessionId).toBe(execution.session.normalizedSessionId);
    expect(retained?.originalError).toContain("requires an admitted server-owned native backend");
    expect(issue.status).toBe("in_progress"); // not blocked: the task is still owned by the live session
    expect(issue.executionRunId).toBe(runId);
    expect(leases.map((lease) => lease.status)).toEqual(["active"]);
    started.close!.mockReset(); started.close!.mockResolvedValue(undefined);
  }, 60_000);

  const armClaudeRefusal = async () => {
    const { startClaudeNativeSession } = await import("./claude-native-port.js");
    const original = vi.mocked(startClaudeNativeSession).getMockImplementation()!;
    vi.mocked(startClaudeNativeSession).mockImplementationOnce(async (...args: Parameters<typeof startClaudeNativeSession>) => {
      const result = await original(...args);
      started.close!.mockRejectedValue(new Error("claude_native_effects_unsettled"));
      return result;
    });
  };
  const heldAssertions = async (runId: string, issueId: string) => {
    const { run, issue, leases } = await durable(runId, issueId);
    expect(run.status).toBe("running"); expect(run.finishedAt).toBeNull();
    expect(isNativeRunnerOwnershipHeld(run)).toBe(true);
    expect(issue.status).toBe("in_progress"); expect(issue.executionRunId).toBe(runId);
    expect(leases.map((lease) => lease.status)).toEqual(["active"]);
    return run;
  };

  it("an OpenCode host retained by this controller holds ownership before the normal failure disposition (non-durable create intent is still a hold)", async () => {
    process.env.PAPERCLIP_CLAUDE_INTERACTIVE_STATE_DIR = "/Volumes/NVM/AI_Agent_Runtime/tmp"; process.env.PAPERCLIP_CLAUDE_HOOK_HELPER = "/trusted/helper";
    const { execution, runId, runnerInstanceId } = await seed();
    started.guard = () => ({ binding: { providerSessionId: "ses_held", taskSessionId: "task-session" }, durable: false, cause: new Error("opencode_catalog_shutdown_failed") });
    try {
      const error = await executePaperclipNativeSession({ db, execution, runnerInstanceId }).then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(NativeRunnerOwnershipUnverifiedError);
      const run = await heldAssertions(runId, execution.binding.issueId);
      expect(run.nativePhase).toBe("terminal_failure");
      expect(run.error).toContain("Claude interactive v13 requires an admitted server-owned native backend");
      const held = (run.resultJson as { openCodeRetainedOwnership?: Record<string, unknown> } | null)?.openCodeRetainedOwnership;
      expect(held).toMatchObject({ durable: false, providerSessionId: "ses_held", cause: "opencode_catalog_shutdown_failed" });
      expect((run.resultJson as Record<string, unknown>).claudeRetainedOwnership).toBeUndefined();
    } finally { started.guard = undefined; }
  }, 60_000);

  it("a guard owner mismatch (throw) holds rather than releases", async () => {
    process.env.PAPERCLIP_CLAUDE_INTERACTIVE_STATE_DIR = "/Volumes/NVM/AI_Agent_Runtime/tmp"; process.env.PAPERCLIP_CLAUDE_HOOK_HELPER = "/trusted/helper";
    const { execution, runId, runnerInstanceId } = await seed();
    started.guard = () => { throw new Error("opencode_retained_owner_mismatch"); };
    try {
      const error = await executePaperclipNativeSession({ db, execution, runnerInstanceId }).then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(NativeRunnerOwnershipUnverifiedError);
      const run = await heldAssertions(runId, execution.binding.issueId);
      expect((run.resultJson as { openCodeRetainedOwnership?: { cause?: string } } | null)?.openCodeRetainedOwnership?.cause).toBe("opencode_retained_owner_mismatch");
    } finally { started.guard = undefined; }
  }, 60_000);

  it("combined: Claude unsettled effects and a retained OpenCode host record both identities in one held run, with no successor claim", async () => {
    process.env.PAPERCLIP_CLAUDE_INTERACTIVE_STATE_DIR = "/Volumes/NVM/AI_Agent_Runtime/tmp"; process.env.PAPERCLIP_CLAUDE_HOOK_HELPER = "/trusted/helper";
    const { execution, runId, runnerInstanceId } = await seed();
    await armClaudeRefusal();
    started.guard = () => ({ binding: { providerSessionId: "ses_both", taskSessionId: "task-both" }, durable: true });
    try {
      const error = await executePaperclipNativeSession({ db, execution, runnerInstanceId }).then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(NativeRunnerOwnershipUnverifiedError);
      const run = await heldAssertions(runId, execution.binding.issueId);
      const result = run.resultJson as { claudeRetainedOwnership?: { nativeSessionId?: string }; openCodeRetainedOwnership?: { providerSessionId?: string; durable?: boolean } };
      expect(result.claudeRetainedOwnership?.nativeSessionId).toBe(execution.session.normalizedSessionId);
      expect(result.openCodeRetainedOwnership).toMatchObject({ providerSessionId: "ses_both", durable: true });
      // Successor refusal: the persisted marker keeps the claim predicate false, and a repeat start never relaunches.
      const again = await executePaperclipNativeSession({ db, execution, runnerInstanceId }).then(() => null, (reason: unknown) => reason);
      expect(again).toBeTruthy();
      const { run: after } = await durable(runId, execution.binding.issueId);
      expect(isNativeRunnerOwnershipHeld(after)).toBe(true);
    } finally { started.guard = undefined; started.close!.mockReset(); started.close!.mockResolvedValue(undefined); }
  }, 60_000);
});
