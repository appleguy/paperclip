import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Db } from "@paperclipai/db";
import type { ClaudeInteractiveNativePort, NativeExecutionInputV13, PrpEvent, PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";
import { PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA, PRP_COMPLETION_TOOL_DESCRIPTION } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";
import { createClaudeNativeAdmission, type ClaudeNativeAdmissionOptions } from "./claude-native-admission.js";
import { claudeLiveSessions, type ClaudeLiveSessionControl, type ClaudeLiveSessionRegistry } from "./claude-native-live-sessions.js";
import { readClaudeTerminalReceipt, type ClaudeSemanticJournalBinding } from "./claude-native-semantic-journal.js";

export interface ClaudeNativeHost {
  claudeExecutable: string; home: string; claudeConfigDir?: string;
  /** Private (0700, owned) directory holding one exclusive journal directory per run. */
  stateDirectory: string; hookHelperExecutable: string;
}
export interface ClaudeLaunchedControl extends ClaudeLiveSessionControl { detach(): Promise<void> }
export interface StartClaudeNativeSessionInput {
  execution: NativeExecutionInputV13; runnerInstanceId: string; leaseOwner: string; attempt: number;
  controller: { bootId: string; pid: number; processStartedAt: Date };
  assertControllerActive(): void;
  completionFeedback(result: PrpStructuredRunResult): Promise<string>;
  host: ClaudeNativeHost;
  /** Test seam; production loads the Runner's concrete `ClaudeInteractiveRunner`. */
  launch?: (options: Record<string, unknown>) => Promise<ClaudeLaunchedControl>;
  registry?: ClaudeLiveSessionRegistry;
  admission?: Pick<ClaudeNativeAdmissionOptions, "tools" | "replaySafeTools" | "readOnlyTools">;
  settleTimeoutMs?: number;
  pollMs?: number;
}

async function defaultLaunch(options: Record<string, unknown>): Promise<ClaudeLaunchedControl> {
  const runner = await import("@paperclipai/paperclip-runner");
  const klass = (runner as unknown as { ClaudeInteractiveRunner?: { launch(input: Record<string, unknown>): Promise<ClaudeLaunchedControl> } }).ClaudeInteractiveRunner;
  if (!klass) throw new Error("claude_interactive_runner_unavailable");
  return klass.launch(options);
}

/**
 * Launches the ONE genuine Claude interactive session for an admitted v13 run and exposes it to the executor as a native
 * port. The same live control is registered for the managed service (owner input / interrupt / Remote Control), so there
 * is never a second launch. The relaunch of a run is refused (exclusive per-run journal directory): a native session that
 * may have partially run is never re-prompted from here.
 */
export async function startClaudeNativeSession(db: Db, input: StartClaudeNativeSessionInput) {
  const { execution } = input, registry = input.registry ?? claudeLiveSessions;
  const b = execution.binding, cwd = execution.workspace.cwd, nativeSessionId = execution.session.normalizedSessionId;
  if (execution.provider.kind !== "claude_interactive" || !cwd || !isAbsolute(cwd) || !nativeSessionId) throw new Error("claude_admission_unavailable");
  const { stateDirectory, hookHelperExecutable } = input.host;
  if (!isAbsolute(stateDirectory) || !isAbsolute(hookHelperExecutable)) throw new Error("claude_host_configuration_unavailable");
  const base = resolve(stateDirectory), stat = await lstat(base);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error("claude_state_directory_not_private");
  if (registry.has(b.companyId, b.runId)) throw new Error("claude_session_already_live");

  const identity = Object.freeze({ runId: b.runId, sessionId: nativeSessionId, companyId: b.companyId, issueId: b.issueId, agentId: b.agentId });
  const admit = createClaudeNativeAdmission(db, {
    controller: async () => ({ ...input.controller }), assertControllerActive: input.assertControllerActive, ...input.admission,
    completion: () => ({
      definitions: ["paperclip_finish", "paperclip_block"].map((name) => ({ name, description: PRP_COMPLETION_TOOL_DESCRIPTION, inputSchema: PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA })),
      contract: { revision: execution.completionContract.contract.revision, criterionIds: execution.completionContract.contract.criteria.map((criterion) => criterion.id) },
      feedback: async (result) => { input.assertControllerActive(); return input.completionFeedback(result); },
    }),
  });
  // Admission first (a refusal leaves no reservation); then the exclusive per-run reservation: a repeated start never launches again.
  let directory = "";
  const admitted = await admit({ companyId: b.companyId, actorId: "executor", runId: b.runId });
  if (admitted.scope.nativeSessionId !== nativeSessionId || admitted.scope.runId !== b.runId) { await admitted.close(); throw new Error("claude_admission_session_mismatch"); }
  try {
    directory = join(base, createHash("sha256").update(`${b.companyId}\0${b.runId}`).digest("hex").slice(0, 16));
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("claude_session_already_launched"); throw error; }
    const record = await open(join(directory, "launch.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await record.writeFile(JSON.stringify({ version: 1, runId: b.runId, companyId: b.companyId, sessionId: nativeSessionId, workspace: resolve(cwd), state: "launch_reserved" })); await record.sync(); }
    finally { await record.close(); }

  } catch (error) { await admitted.close(); throw error; }
  const journal: ClaudeSemanticJournalBinding = Object.freeze({ companyId: b.companyId, issueId: b.issueId, runId: b.runId, nativeSessionId,
    leaseOwner: input.leaseOwner, attempt: input.attempt, writerGeneration: admitted.binding.writerGeneration, identity: { ...input.controller } });
  const waiters = new Set<() => void>();
  const wake = () => { for (const resolveWaiter of [...waiters]) resolveWaiter(); };
  const active = { value: true };
  let control: ClaudeLaunchedControl;
  try {
    control = await (input.launch ?? defaultLaunch)({
      executable: input.host.claudeExecutable, cwd: resolve(cwd), sessionId: nativeSessionId, model: execution.provider.model,
      effort: execution.provider.effort, autoCompactTokens: execution.provider.autoCompactTokens, journalDirectory: directory,
      ownerAuthority: { authorize: async () => active.value }, home: input.host.home, claudeConfigDir: input.host.claudeConfigDir,
      sdk: await import("@anthropic-ai/claude-agent-sdk").then(({ getSessionInfo }) => ({ getSessionInfo, namespace: { home: input.host.home, claudeConfigDir: input.host.claudeConfigDir } })),
      hookHelperExecutable,
      mcp: { scope: admitted.scope,
        // The Runner bridge publishes paperclip_finish/paperclip_block itself and rejects them as caller tools; their calls still reach dispatch.
        tools: admitted.definitions().filter((tool) => tool.name !== "paperclip_finish" && tool.name !== "paperclip_block"), dispatch: async (scope: typeof admitted.scope, call: Parameters<typeof admitted.dispatch>[1]) => {
        try { return await admitted.dispatch(scope, call); } finally { wake(); }
      } },
    });
  } catch (error) { active.value = false; await admitted.close(); throw error; }
  const unregister = registry.register({ companyId: b.companyId, runId: b.runId, nativeSessionId, control });

  const readReceipt = () => readClaudeTerminalReceipt(db, journal);
  let closed = false;
  const port: ClaudeInteractiveNativePort = Object.freeze({
    identity, runnerInstanceId: input.runnerInstanceId, nativeSessionId,
    async verify() { await readReceipt(); await control.identity(); },
    readReceipt,
    async dispatch(prompt: { id: string; text: string }) { await control.ownerInput({ operationId: prompt.id, text: prompt.text }); },
    async waitForReceipt(signal: AbortSignal) {
      for (;;) {
        signal.throwIfAborted();
        const receipt = await readReceipt();
        if (receipt) return receipt;
        await new Promise<void>((done, reject) => {
          const finish = () => { clearTimeout(timer); waiters.delete(onWake); signal.removeEventListener("abort", onAbort); };
          const onWake = () => { finish(); done(); };
          const onAbort = () => { finish(); reject(signal.reason ?? new Error("aborted")); };
          const timer = setTimeout(onWake, input.pollMs ?? 1000);
          waiters.add(onWake);
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    },
    /** Never assumes a native tool stopped: finalizes only when no tool effect is in flight and the durable journal has
     * no reservation without a recorded outcome. Otherwise it throws and leaves session, authority and registry intact. */
    async close() {
      if (closed) return;
      if (!await admitted.settled(input.settleTimeoutMs ?? 5000)) throw new Error("claude_native_effects_unsettled");
      if (await admitted.unsettled() !== 0) throw new Error("claude_native_effects_unsettled");
      closed = true;
      unregister(); active.value = false;
      try { await control.detach(); } finally { await admitted.close(); wake(); }
    },
  });
  const authorizeWorkSessionResult = async ({ event, result, signal }: { event: PrpEvent; result: PrpStructuredRunResult; signal: AbortSignal }) => {
    signal.throwIfAborted();
    const receipt = await readReceipt();
    signal.throwIfAborted();
    return !!receipt && event.eventType === "run.result.proposed" && event.sourceKind === "runner" && event.sourceInstanceId === input.runnerInstanceId
      && event.runId === b.runId && event.normalizedSessionId === nativeSessionId && event.turnId == null
      && event.sourceEventId === `claude:${b.runId}:${receipt.operationId}` && event.sourceSeq === 1 && event.emittedAt === receipt.recordedAt
      && nativeSha256(event.payload) === nativeSha256(receipt.result) && nativeSha256(result) === nativeSha256(receipt.result);
  };
  return { port, authorizeWorkSessionResult, control, admission: admitted };
}
