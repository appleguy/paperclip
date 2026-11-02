import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agents, environmentLeases, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { and, eq, gt, isNull, notInArray, or, sql } from "drizzle-orm";
import { validatePrpStructuredRunResult, type PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";
import type { NativeControllerIdentity } from "./native-restart-recovery.js";
import { assertClaudeNoTerminalIntent, countUnsettledClaudeSemanticCalls, readUnsettledClaudeReplayCalls, reserveClaudeSemanticCall, settleClaudeSemanticCall, type ClaudeSemanticJournalBinding } from "./claude-native-semantic-journal.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPLETION_TOOLS = new Set(["paperclip_finish", "paperclip_block"]);
const MAX_TRACKED_CALLS = 2000;
const INACTIVE_AGENT_STATUSES = ["paused", "terminated", "pending_approval", "error"];

/** Exactly the scope Runner's `openClaudeNativeMcpBinding` carries and hands to `dispatch`. */
export type ClaudeNativeScope = Readonly<{
  companyId: string; runId: string; taskId: string; leaseId: string; nativeSessionId: string;
}>;
export type ClaudeNativeToolCall = Readonly<{ tool: string; callId: string; arguments: unknown; signal: AbortSignal }>;

/** `PaperclipRunnerToolAuthority` satisfies this structurally. Its durable
 * receipts, run-state checks and privacy checks stay the owner of every effect. */
export interface ClaudeNativeTaskTools {
  definitions(): Array<Record<string, unknown>>;
  execute(call: { tool: string; callId: string; arguments: unknown }): Promise<unknown>;
}

/** Existing completion-feedback boundary for this admitted run, supplied by the
 * controller. Without it the completion tools are neither advertised nor callable.
 * Native Stop and visible text never reach this path. */
export interface ClaudeNativeCompletion {
  definitions: ReadonlyArray<Readonly<Record<string, unknown>>>;
  contract: { revision: string | number; criterionIds: readonly string[] };
  feedback(result: PrpStructuredRunResult): Promise<string>;
}

export type ClaudeNativeAuthorityInput = {
  scope: ClaudeNativeScope;
  /** The claimed controller owner: lease owner, attempt, and process identity. */
  controller: { leaseOwner: string; attempt: number; identity: NativeControllerIdentity };
  /** Throws when the controller no longer owns the run (shutdown/restart). */
  assertControllerActive: () => void;
  tools: ClaudeNativeTaskTools;
  completion?: ClaudeNativeCompletion;
  /** Tools whose own durable receipt makes a repeat after an unknown outcome safe (e.g.
   * idempotency-keyed writes, pure reads). Only these may free a call ID after dispatch. */
  replaySafeTools?: ReadonlySet<string>;
  /** Every other tool (and both completion tools) is reserved in the durable semantic journal before its
   * effect and settled after, so an unknown outcome survives restart and is never replayed. Default true. */
  durableJournal?: boolean;
  /** Tools with no effect; the only calls still allowed once finish/block intent exists. Default: none. */
  readOnlyTools?: ReadonlySet<string>;
};

/** Everything below is derived from server rows, never from the model or a hook. */
export type ClaudeNativeBinding = Readonly<{
  companyId: string; projectId: string | null; issueId: string; agentId: string; runId: string;
  nativeSessionId: string; environmentLeaseId: string; executionWorkspaceId: string;
  leaseOwner: string; attempt: number; writerGeneration: number;
}>;

export type ClaudeNativeAuthority = Readonly<{
  binding: ClaudeNativeBinding;
  /** Advertised catalog; pass to `openClaudeNativeMcpBinding({ tools })`. */
  definitions(): Array<Record<string, unknown>>;
  /** Pass to `openClaudeNativeMcpBinding({ dispatch })`. */
  dispatch(scope: ClaudeNativeScope, call: ClaudeNativeToolCall): Promise<unknown>;
  /** True only while every live authority row still matches the pinned binding. */
  admit(): Promise<boolean>;
  /** Waits (bounded) until no mutating tool call is in flight. */
  settled(timeoutMs: number): Promise<boolean>;
  /** Durable count of journaled calls with no recorded outcome. */
  unsettled(): Promise<number>;
}>;

function fail(code: string): never { throw new Error(code); }

function requireScope(scope: ClaudeNativeScope): void {
  for (const key of ["companyId", "runId", "taskId", "leaseId", "nativeSessionId"] as const) {
    if (typeof scope?.[key] !== "string" || !UUID.test(scope[key])) fail("claude_native_scope_invalid");
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** One statement, so the six authorities are read from a single snapshot. */
async function readLiveAuthority(db: Db, input: ClaudeNativeAuthorityInput): Promise<ClaudeNativeBinding | null> {
  const { scope, controller } = input;
  const [row] = await db.select({
    projectId: issues.projectId, agentId: heartbeatRuns.agentId, executionWorkspaceId: environmentLeases.executionWorkspaceId,
    writerGeneration: nativeRunFinalizations.controllerGeneration,
  }).from(heartbeatRuns)
    .innerJoin(issues, and(eq(issues.id, heartbeatRuns.nativeIssueId), eq(issues.companyId, heartbeatRuns.companyId)))
    .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, heartbeatRuns.companyId)))
    .innerJoin(environmentLeases, and(eq(environmentLeases.heartbeatRunId, heartbeatRuns.id), eq(environmentLeases.companyId, heartbeatRuns.companyId)))
    .innerJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.runId, heartbeatRuns.id), eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId)))
    .where(and(
      eq(heartbeatRuns.id, scope.runId), eq(heartbeatRuns.companyId, scope.companyId),
      eq(heartbeatRuns.nativeIssueId, scope.taskId), eq(heartbeatRuns.nativeSessionId, scope.nativeSessionId),
      eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "running"),
      eq(issues.assigneeAgentId, heartbeatRuns.agentId), eq(issues.executionRunId, heartbeatRuns.id),
      notInArray(agents.status, INACTIVE_AGENT_STATUSES),
      eq(environmentLeases.id, scope.leaseId), eq(environmentLeases.issueId, scope.taskId), eq(environmentLeases.status, "active"),
      or(isNull(environmentLeases.expiresAt), gt(environmentLeases.expiresAt, sql`clock_timestamp()`)),
      eq(nativeRunFinalizations.issueId, scope.taskId), eq(nativeRunFinalizations.phase, "observed"),
      eq(nativeRunFinalizations.leaseOwner, controller.leaseOwner), eq(nativeRunFinalizations.attempt, controller.attempt),
      eq(nativeRunFinalizations.controllerBootId, controller.identity.bootId), eq(nativeRunFinalizations.controllerPid, controller.identity.pid),
      eq(nativeRunFinalizations.controllerProcessStartedAt, controller.identity.processStartedAt),
      gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`),
    )).limit(1);
  if (!row || !row.executionWorkspaceId || row.writerGeneration < 1) return null;
  return Object.freeze({
    companyId: scope.companyId, projectId: row.projectId, issueId: scope.taskId, agentId: row.agentId, runId: scope.runId,
    nativeSessionId: scope.nativeSessionId, environmentLeaseId: scope.leaseId, executionWorkspaceId: row.executionWorkspaceId,
    leaseOwner: controller.leaseOwner, attempt: controller.attempt, writerGeneration: row.writerGeneration,
  });
}

function sameBinding(a: ClaudeNativeBinding, b: ClaudeNativeBinding | null): boolean {
  return b !== null && (Object.keys(a) as Array<keyof ClaudeNativeBinding>).every((key) => a[key] === b[key]);
}

/** A tool may prove its failure happened before any effect by throwing an error that
 * carries this marker. A status code alone (even 4xx) proves nothing: the tool may have
 * committed before it failed. */
export const CLAUDE_NATIVE_PRE_EFFECT = "claudeNativePreEffect";
function isExplicitPreEffectRejection(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as Record<string, unknown>)[CLAUDE_NATIVE_PRE_EFFECT] === true;
}

/** Bind the genuine Claude interactive session's scoped MCP tools to one admitted
 * Paperclip run. Fails closed unless the exact environment lease, native session
 * and writer generation are live; rechecks them immediately before every dispatch. */
export async function createClaudeNativeAuthority(db: Db, input: ClaudeNativeAuthorityInput): Promise<ClaudeNativeAuthority> {
  requireScope(input.scope);
  const scope = Object.freeze({ ...input.scope });
  const { leaseOwner, attempt, identity } = input.controller;
  if (!leaseOwner || !Number.isSafeInteger(attempt) || attempt < 0 || !identity?.bootId || !Number.isSafeInteger(identity.pid)
    || !(identity.processStartedAt instanceof Date) || !Number.isFinite(identity.processStartedAt.getTime())) fail("claude_native_controller_invalid");
  if (typeof input.tools?.execute !== "function" || typeof input.tools?.definitions !== "function") fail("claude_native_tools_invalid");
  const live = { ...input, scope };
  try { input.assertControllerActive(); } catch { fail("claude_native_controller_inactive"); }
  const binding = await readLiveAuthority(db, live);
  if (!binding) fail("claude_native_authority_unavailable");

  const admit = async () => {
    try { input.assertControllerActive(); } catch { return false; }
    return sameBinding(binding, await readLiveAuthority(db, live));
  };

  const advertised = () => {
    const tools = input.tools.definitions();
    const completion = input.completion?.definitions ?? [];
    const seen = new Set<string>();
    return [...tools, ...completion].map((tool) => ({ ...tool })).filter((tool) => {
      const name = String(tool.name);
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
  };
  const advertisedNames = () => new Set(advertised().map((tool) => String(tool.name)));

  // callId -> state. In-flight duplicates join the one dispatch. After a started
  // dispatch ends without a proven result the ID is poisoned and never re-sent.
  const calls = new Map<string, { digest: string; state: "running" | "unknown" | "done"; promise?: Promise<unknown> }>();

  // Everything before `effectBoundary()` is this layer's own validation and re-admission:
  // those failures provably had no effect. After it, only an explicit marker or a tool the
  // owner declared replay-safe frees the ID. This map is process-local, so this layer does
  // NOT give at-most-once semantics across close/restart; durable receipts live in the tools.
  const journalBinding: ClaudeSemanticJournalBinding = Object.freeze({
    companyId: scope.companyId, issueId: scope.taskId, runId: scope.runId, nativeSessionId: scope.nativeSessionId,
    leaseOwner, attempt, writerGeneration: binding.writerGeneration, identity,
  });
  const journaled = (tool: string) => input.durableJournal !== false && (COMPLETION_TOOLS.has(tool) || input.readOnlyTools?.has(tool) !== true);
  const reserve = async (call: ClaudeNativeToolCall) => {
    if (!journaled(call.tool)) return;
    try { await reserveClaudeSemanticCall(db, journalBinding, call, { replaySafe: input.replaySafeTools?.has(call.tool) === true }); }
    catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "claude_semantic_outcome_unknown") fail("claude_native_outcome_unknown");
      if (message === "claude_semantic_authority_lost") fail("claude_native_authority_lost");
      if (message === "claude_semantic_terminal_pending") fail("claude_native_terminal_pending");
      if (message === "claude_semantic_effects_unsettled") fail("claude_native_effects_unsettled");
      throw error;
    }
  };
  // Process-local mirror of the durable terminal intent, closing the window before the reservation commits.
  let terminalIntent = false;
  let inflightEffects = 0;
  const gateEffect = async (call: ClaudeNativeToolCall) => {
    if (input.readOnlyTools?.has(call.tool)) return;
    if (terminalIntent) fail("claude_native_terminal_pending");
    if (!journaled(call.tool)) {
      try { await assertClaudeNoTerminalIntent(db, journalBinding); }
      catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "claude_semantic_terminal_pending") fail("claude_native_terminal_pending");
        if (message === "claude_semantic_authority_lost") fail("claude_native_authority_lost");
        throw error;
      }
    }
  };
  const settle = (call: ClaudeNativeToolCall, outcome: Parameters<typeof settleClaudeSemanticCall>[3]) =>
    journaled(call.tool) ? settleClaudeSemanticCall(db, journalBinding, call, outcome) : Promise.resolve();

  // Replay-safe tools carry their own durable idempotency receipts, but their reservation is still journaled: an earlier
  // call with no recorded outcome (crash, abort, restart) is replayed here under its own receipt, and only then may the
  // terminal call proceed. Anything that cannot be reconciled leaves the reservation and refuses finish/block.
  const reconcileReplaySafe = async () => {
    let pending;
    try { pending = await readUnsettledClaudeReplayCalls(db, journalBinding); }
    catch (error) { if (error instanceof Error && error.message === "claude_semantic_authority_lost") fail("claude_native_authority_lost"); throw error; }
    for (const call of pending) {
      if (!input.replaySafeTools?.has(call.tool)) continue;
      if (!await admit()) fail("claude_native_authority_lost");
      let result: unknown;
      try { result = await input.tools.execute({ tool: call.tool, callId: call.callId, arguments: call.arguments }); }
      catch { fail("claude_native_effects_unsettled"); }
      await settleClaudeSemanticCall(db, journalBinding, call, { kind: "returned", result });
    }
  };

  const run = async (call: ClaudeNativeToolCall, effectBoundary: () => void): Promise<unknown> => {
    if (COMPLETION_TOOLS.has(call.tool)) {
      const completion = input.completion;
      if (!completion) fail("claude_native_completion_unsupported");
      const validated = validatePrpStructuredRunResult(call.arguments);
      if (!validated.ok) fail("claude_native_result_invalid");
      const semantic = validated.result;
      const received = semantic.completionClaim.criteria.map((criterion) => criterion.criterionId);
      const expected = completion.contract.criterionIds;
      if ((call.tool === "paperclip_block") !== (semantic.reportedWorkDisposition === "blocked")
        || semantic.completionClaim.contractRevision !== completion.contract.revision
        || received.length !== expected.length || new Set(received).size !== received.length
        || received.some((id) => !expected.includes(id))) fail("claude_native_contract_mismatch");
      // Revalidated after local validation, immediately before the effect boundary.
      if (!await admit()) fail("claude_native_authority_lost");
      // Native tool effects must have settled before the run can end; a second terminal call is refused by the journal.
      if (inflightEffects > 0) fail("claude_native_effects_unsettled");
      if (terminalIntent) fail("claude_native_terminal_pending");
      terminalIntent = true;
      try { await reconcileReplaySafe(); await reserve(call); }
      catch (error) { terminalIntent = false; throw error; }
      effectBoundary();
      const feedback = await completion.feedback(semantic);
      if (typeof feedback !== "string" || !feedback.trim()) fail("claude_native_feedback_invalid");
      const result = { feedback, result: semantic };
      await settle(call, { kind: "returned", result });
      return result;
    }
    const effectful = !input.readOnlyTools?.has(call.tool);
    if (effectful) inflightEffects += 1;
    try {
      if (!await admit()) fail("claude_native_authority_lost");
      await gateEffect(call);
      await reserve(call);
      effectBoundary();
      let result: unknown;
      try { result = await input.tools.execute({ tool: call.tool, callId: call.callId, arguments: call.arguments }); }
      catch (error) {
        // Only explicit proof of "nothing happened" may clear the reservation; anything else stays unknown.
        if (isExplicitPreEffectRejection(error)) await settle(call, { kind: "rejected" }).catch(() => {});
        throw error;
      }
      await settle(call, { kind: "returned", result });
      return result;
    } finally { if (effectful) inflightEffects -= 1; }
  };

  const dispatch = async (requested: ClaudeNativeScope, call: ClaudeNativeToolCall): Promise<unknown> => {
    requireScope(requested);
    for (const key of Object.keys(scope) as Array<keyof ClaudeNativeScope>) if (requested[key] !== scope[key]) fail("claude_native_scope_mismatch");
    if (call.signal?.aborted) fail("claude_native_cancelled");
    if (typeof call.tool !== "string" || !call.tool || typeof call.callId !== "string" || !call.callId || call.callId.length > 500) fail("claude_native_call_invalid");
    if (!advertisedNames().has(call.tool)) fail("claude_native_tool_unknown");
    const digest = createHash("sha256").update(canonicalJson({ tool: call.tool, arguments: call.arguments })).digest("hex");
    const prior = calls.get(call.callId);
    if (prior) {
      if (prior.digest !== digest) fail("claude_native_call_id_reused");
      if (prior.state === "unknown") fail("claude_native_outcome_unknown");
      // Running or finished: join the one dispatch; a finished call never executes again.
      return prior.promise;
    } else if (calls.size >= MAX_TRACKED_CALLS) fail("claude_native_call_limit");
    const entry: { digest: string; state: "running" | "unknown" | "done"; promise?: Promise<unknown> } = { digest, state: "running" };
    calls.set(call.callId, entry);
    entry.promise = (async () => {
      let dispatched = false;
      try {
        const result = await run(call, () => { dispatched = true; });
        entry.state = "done";
        return result;
      } catch (error) {
        // Pre-boundary failures prove no effect; after it, only explicit proof does.
        const noEffect = !dispatched || isExplicitPreEffectRejection(error) || input.replaySafeTools?.has(call.tool) === true;
        if (noEffect) calls.delete(call.callId);
        else entry.state = "unknown";
        throw error;
      }
    })();
    return entry.promise;
  };

  /** Resolves once no mutating call is in flight; the executor waits on this before it closes the session. */
  const settled = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (inflightEffects > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    return inflightEffects === 0;
  };

  /** Durable count of journaled calls with no recorded outcome; close/finalize must see 0. */
  const unsettled = () => countUnsettledClaudeSemanticCalls(db, journalBinding);

  return Object.freeze({ binding, definitions: advertised, dispatch, admit, settled, unsettled });
}
