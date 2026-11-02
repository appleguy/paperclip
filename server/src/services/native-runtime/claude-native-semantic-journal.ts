import type { Db } from "@paperclipai/db";
import { heartbeatRuns, nativeRunFinalizations } from "@paperclipai/db";
import { and, eq, gt, sql } from "drizzle-orm";
import { validatePrpStructuredRunResult, type PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";
import type { NativeControllerIdentity } from "./native-restart-recovery.js";

/**
 * Durable reservation/receipt journal for Claude semantic MCP calls, the run-scoped
 * counterpart of the OpenCode `semanticCalls` journal (that one lives in
 * `agent_task_sessions`, which a Claude interactive run does not have). Entries live in
 * `heartbeat_runs.result_json.claudeSemanticCalls` and every transition is fenced by the
 * exact claimed finalization row (owner, attempt, controller identity, writer generation,
 * unexpired lease), so a stale controller can neither reserve nor settle.
 *
 * A `reserved` entry whose outcome was never recorded is unknown forever: it is never
 * replayed, across process restarts as well. Only an explicit pre-effect rejection
 * (`rejected`) lets the same call ID be reserved again.
 */
export type ClaudeSemanticJournalBinding = Readonly<{
  companyId: string; issueId: string; runId: string; nativeSessionId: string;
  leaseOwner: string; attempt: number; writerGeneration: number; identity: NativeControllerIdentity;
}>;
type Call = { callId: string; tool: string; arguments: unknown };
type State = "reserved" | "returned" | "succeeded" | "failed" | "rejected";
const STATES: readonly State[] = ["reserved", "returned", "succeeded", "failed", "rejected"];
const TERMINAL_TOOLS = new Set(["paperclip_finish", "paperclip_block"]);
const MAX_ENTRIES = 2048;
const MAX_REPLAY_ARGUMENT_BYTES = 16 * 1024;
const ID = /^[A-Za-z0-9._:-]{1,200}$/;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const operationId = (binding: ClaudeSemanticJournalBinding, callId: string) =>
  nativeSha256({ nativeSessionId: binding.nativeSessionId, callId });
const digestOf = (call: Call) => nativeSha256({ tool: call.tool, arguments: call.arguments });

async function withFencedRun<T>(db: Db, binding: ClaudeSemanticJournalBinding,
  body: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0], resultJson: Record<string, unknown>, entries: Record<string, unknown>[]) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const [lease] = await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.runId, binding.runId), eq(nativeRunFinalizations.companyId, binding.companyId), eq(nativeRunFinalizations.issueId, binding.issueId),
      eq(nativeRunFinalizations.phase, "observed"), eq(nativeRunFinalizations.leaseOwner, binding.leaseOwner), eq(nativeRunFinalizations.attempt, binding.attempt),
      eq(nativeRunFinalizations.controllerBootId, binding.identity.bootId), eq(nativeRunFinalizations.controllerPid, binding.identity.pid),
      eq(nativeRunFinalizations.controllerProcessStartedAt, binding.identity.processStartedAt),
      eq(nativeRunFinalizations.controllerGeneration, binding.writerGeneration),
      gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`),
    )).for("update", { noWait: true }).limit(1);
    if (!lease) throw new Error("claude_semantic_authority_lost");
    const [run] = await tx.select({ resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.nativeSessionId, binding.nativeSessionId),
      eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "running"))).for("update").limit(1);
    if (!run) throw new Error("claude_semantic_authority_lost");
    const resultJson = object(run.resultJson);
    const history = resultJson.claudeSemanticCalls ?? [];
    if (!Array.isArray(history) || history.length > MAX_ENTRIES) throw new Error("claude_semantic_history_invalid");
    const entries = history.map(object);
    if (entries.some((entry) => typeof entry.operationId !== "string" || typeof entry.digest !== "string" || typeof entry.tool !== "string" || !STATES.includes(entry.state as State))) {
      throw new Error("claude_semantic_history_invalid");
    }
    return body(tx, resultJson, entries);
  });
}

const save = (tx: Parameters<Parameters<Db["transaction"]>[0]>[0], binding: ClaudeSemanticJournalBinding, resultJson: Record<string, unknown>, entries: unknown[]) =>
  tx.update(heartbeatRuns).set({ resultJson: { ...resultJson, claudeSemanticCalls: entries } }).where(eq(heartbeatRuns.id, binding.runId));

function checkCall(call: Call) {
  if (!ID.test(call.callId) || !ID.test(call.tool)) throw new Error("claude_semantic_call_invalid");
}

/** Durable reservation, written before any effect. Throws `claude_semantic_outcome_unknown` for a repeat. */
export async function reserveClaudeSemanticCall(db: Db, binding: ClaudeSemanticJournalBinding, call: Call, options: { replaySafe?: boolean } = {}): Promise<void> {
  checkCall(call);
  const id = operationId(binding, call.callId), digest = digestOf(call);
  await withFencedRun(db, binding, async (tx, resultJson, entries) => {
    const prior = entries.find((entry) => entry.operationId === id);
    // A replay-safe tool (own durable idempotency receipt) may be re-reserved with the identical call after any outcome,
    // but the reservation stays durable so a restart can never pass an in-flight or unknown effect.
    const replayable = options.replaySafe === true && prior !== undefined && prior.digest === digest && !TERMINAL_TOOLS.has(call.tool);
    if (prior && prior.state !== "rejected" && !replayable) throw new Error(prior.digest === digest ? "claude_semantic_outcome_unknown" : "claude_semantic_identity_conflict");
    if (!prior && entries.length >= MAX_ENTRIES) throw new Error("claude_semantic_capacity_exhausted");
    const terminalIntent = entries.some((entry) => TERMINAL_TOOLS.has(String(entry.tool)) && (entry.state === "reserved" || entry.state === "succeeded"));
    // After finish/block intent no other mutating call may start: the terminal call owns the end of the run.
    if (!TERMINAL_TOOLS.has(call.tool) && terminalIntent) throw new Error("claude_semantic_terminal_pending");
    if (TERMINAL_TOOLS.has(call.tool)) {
      // Finish/block only after every earlier journaled effect has a recorded outcome.
      if (entries.some((entry) => !TERMINAL_TOOLS.has(String(entry.tool)) && entry.state === "reserved")) throw new Error("claude_semantic_effects_unsettled");
      if (entries.some((entry) => TERMINAL_TOOLS.has(String(entry.tool)) && entry.state === "succeeded")) throw new Error("claude_semantic_terminal_already_recorded");
      // A terminal call whose outcome is unknown blocks any other terminal call.
      if (entries.some((entry) => TERMINAL_TOOLS.has(String(entry.tool)) && entry.state === "reserved")) throw new Error("claude_semantic_outcome_unknown");
    }
    const replayArguments = options.replaySafe === true && JSON.stringify(call.arguments ?? null).length <= MAX_REPLAY_ARGUMENT_BYTES ? call.arguments ?? null : undefined;
    const next = { operationId: id, digest, tool: call.tool, state: "reserved" as State,
      ...(replayArguments !== undefined ? { replayCallId: call.callId, replayArguments } : {}) };
    await save(tx, binding, resultJson, prior ? entries.map((entry) => entry === prior ? next : entry) : [...entries, next]);
  });
}

/** Gate for tools that are not journaled (own durable receipts): refused once finish/block intent exists. */
export async function assertClaudeNoTerminalIntent(db: Db, binding: ClaudeSemanticJournalBinding): Promise<void> {
  await withFencedRun(db, binding, async (_tx, _resultJson, entries) => {
    if (entries.some((entry) => TERMINAL_TOOLS.has(String(entry.tool)) && (entry.state === "reserved" || entry.state === "succeeded"))) throw new Error("claude_semantic_terminal_pending");
  });
}

/** Records the settled outcome of a reserved call. `rejected` = explicit pre-effect refusal. */
export async function settleClaudeSemanticCall(db: Db, binding: ClaudeSemanticJournalBinding, call: Call,
  outcome: { kind: "returned"; result: unknown } | { kind: "failed" } | { kind: "rejected" }): Promise<void> {
  checkCall(call);
  const id = operationId(binding, call.callId), digest = digestOf(call);
  await withFencedRun(db, binding, async (tx, resultJson, entries) => {
    const prior = entries.find((entry) => entry.operationId === id);
    if (!prior || prior.digest !== digest || prior.state !== "reserved") throw new Error("claude_semantic_receipt_mismatch");
    if (outcome.kind === "returned" && TERMINAL_TOOLS.has(call.tool)) {
      const validated = validatePrpStructuredRunResult(object(outcome.result).result);
      if (!validated.ok || (call.tool === "paperclip_block") !== (validated.result.reportedWorkDisposition === "blocked")) throw new Error("claude_semantic_result_invalid");
      prior.state = "succeeded";
      prior.semanticResult = validated.result;
      prior.semanticResultDigest = nativeSha256(validated.result);
      prior.recordedAt = new Date().toISOString();
    } else prior.state = outcome.kind;
    if (outcome.kind === "returned") prior.resultDigest = nativeSha256(outcome.result);
    await save(tx, binding, resultJson, entries);
  });
}

/** The authenticated semantic receipt for the work session: the recorded finish/block, if any. */
export async function readClaudeTerminalReceipt(db: Db, binding: ClaudeSemanticJournalBinding):
  Promise<{ result: PrpStructuredRunResult; operationId: string; recordedAt: string } | null> {
  return withFencedRun(db, binding, async (_tx, _resultJson, entries) => {
    const terminal = entries.filter((entry) => TERMINAL_TOOLS.has(String(entry.tool)) && entry.state === "succeeded");
    if (terminal.length > 1) throw new Error("claude_semantic_history_invalid");
    const entry = terminal[0];
    if (!entry) return null;
    const validated = validatePrpStructuredRunResult(entry.semanticResult);
    if (!validated.ok || nativeSha256(validated.result) !== entry.semanticResultDigest || typeof entry.recordedAt !== "string") throw new Error("claude_semantic_history_invalid");
    return { result: validated.result, operationId: String(entry.operationId), recordedAt: entry.recordedAt };
  });
}

/** Reserved replay-safe calls whose outcome was never recorded (the reconcile set); the terminal call replays them first. */
export async function readUnsettledClaudeReplayCalls(db: Db, binding: ClaudeSemanticJournalBinding): Promise<Call[]> {
  return withFencedRun(db, binding, async (_tx, _resultJson, entries) => entries
    .filter((entry) => entry.state === "reserved" && !TERMINAL_TOOLS.has(String(entry.tool)) && typeof entry.replayCallId === "string")
    .map((entry) => ({ callId: String(entry.replayCallId), tool: String(entry.tool), arguments: entry.replayArguments })));
}

/** Durable count of reserved calls with no recorded outcome; close/finalize must see 0 (a native tool is never assumed stopped). */
export async function countUnsettledClaudeSemanticCalls(db: Db, binding: ClaudeSemanticJournalBinding): Promise<number> {
  return withFencedRun(db, binding, async (_tx, _resultJson, entries) => entries.filter((entry) => entry.state === "reserved").length);
}
