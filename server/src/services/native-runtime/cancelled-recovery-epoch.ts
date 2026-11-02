/** Internal-only reader of already persisted Board intent and locked recovery
 * history. The returned receipt is evidence for Runner, never a cleanup proof. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { cancelledBridgeSettlementDigest, exactCancelledOwner as owner,
  type CancelledBridgeSettlement } from "./cancelled-retained-cleanup-authority.js";
import { canonicalNativeJson, nativeSha256 } from "./canonical.js";

const rec = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const same = (a: unknown, b: unknown) => canonicalNativeJson(a) === canonicalNativeJson(b);
type Snapshot = { fingerprint: string; control: Record<string, unknown>; runner: Record<string, unknown>; provider: Record<string, unknown> };
export interface CancelledResumeLineage {
  priorRetiredEpoch: Record<string, unknown>;
  semanticToolResults: CancelledBridgeSettlement[];
  originalFingerprint: string;
  fullPlanDigest: string;
  boardRequestId: string;
  stagedDirectory: string;
}
const authenticLineages = new WeakMap<CancelledResumeLineage, string>();
/** Authentication is process-local and fails after serialization or mutation. */
export function cancelledResumeLineageIsAuthentic(lineage: CancelledResumeLineage): boolean {
  try { return authenticLineages.get(lineage) === nativeSha256(lineage); } catch { return false; }
}

/** Call only inside the existing run/coordinator lock, with history read from
 * the database and fullPlan freshly derived from original encrypted receipts.
 * `staged` is read by the existing bounded, no-symlink snapshot reader. */
function readCancelledRecoveryEpochForOwner(owner: typeof import("./cancelled-retained-cleanup-authority.js").exactCancelledOwner extends infer T ? { readonly [K in keyof T]: K extends "sourceDigests" ? readonly string[] : T[K] extends number ? number : string } : never, input: {
  intentRoot: string; boardRequestId: string; history: readonly Record<string, unknown>[];
  original: Snapshot; staged: Snapshot; stagedDirectory: string;
  fullPlan: readonly CancelledBridgeSettlement[];
}): CancelledResumeLineage | null {
  try {
    const intentPath = resolve(input.intentRoot, `${owner.runId}.json.started`);
    if (lstatSync(resolve(input.intentRoot, `${owner.runId}.json.used`), { throwIfNoEntry: false }) ||
        lstatSync(resolve(input.intentRoot, `${owner.runId}.json`), { throwIfNoEntry: false })) return null;
    const fd = openSync(intentPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let intent: Record<string, unknown>;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 8192) return null;
      intent = rec(JSON.parse(readFileSync(fd, "utf8")));
    } finally { closeSync(fd); }
    if (intent.schema !== "paperclip.cancelled_recovery_intent.v1" || intent.status !== "prepared" ||
        intent.requestId !== input.boardRequestId || intent.runId !== owner.runId ||
        intent.nativeSessionId !== owner.nativeSessionId || intent.runnerInstanceId !== owner.runnerInstanceId ||
        intent.originalFingerprint !== owner.sourceFingerprint || input.original.fingerprint !== owner.sourceFingerprint)
      return null;
    const path = resolve(input.stagedDirectory);
    if (dirname(path) !== dirname(owner.stateDirectory) ||
        !basename(path).startsWith(`${basename(owner.stateDirectory)}.cleanup-`)) return null;
    const identity = rec(input.original.control.identity);
    for (const key of ["runnerInstanceId", "environmentLeaseId", "runId", "normalizedSessionId", "turnId", "itemId"]) {
      if (typeof identity[key] !== "string" || !identity[key] || input.original.runner[key] !== identity[key] ||
          rec(input.staged.control.identity)[key] !== identity[key] || input.staged.runner[key] !== identity[key]) return null;
    }
    if (identity.runnerInstanceId !== owner.runnerInstanceId || identity.environmentLeaseId !== owner.environmentLeaseId ||
        identity.runId !== owner.runId || identity.normalizedSessionId !== owner.nativeSessionId ||
        input.staged.provider.threadId !== owner.providerSessionId || input.staged.provider.lifecycle !== "closed") return null;
    const fullPlanDigest = cancelledBridgeSettlementDigest(input.fullPlan);
    const auth = input.history.filter((entry) => entry.kind === "native_cleanup_board_authorization");
    if (auth.length !== 1 || auth[0]!.version !== 1 || auth[0]!.requestId !== input.boardRequestId ||
        auth[0]!.sourceFingerprint !== owner.sourceFingerprint || auth[0]!.reconciledToolCallsDigest !== fullPlanDigest ||
        typeof auth[0]!.requestLease !== "string" || !auth[0]!.requestLease.startsWith("native-cleanup:")) return null;
    const requestId = auth[0]!.requestLease as string;
    const started = input.history.filter((entry) => entry.kind === "native_cleanup_maintenance" && entry.phase === "started");
    if (started.length !== 1 || started[0]!.version !== 1 || started[0]!.requestId !== requestId ||
        started[0]!.sourceFingerprint !== owner.sourceFingerprint || input.history.some((entry) =>
          entry.kind === "native_cleanup_maintenance" && ["settled", "activation_prepared"].includes(String(entry.phase)))) return null;
    const stages = input.history.filter((entry) => entry.kind === "native_cleanup_maintenance" && entry.phase === "staged");
    if (stages.length !== 1 || stages[0]!.version !== 1 || stages[0]!.requestId !== requestId ||
        stages[0]!.sourceFingerprint !== owner.sourceFingerprint || stages[0]!.stagingName !== basename(path)) return null;
    const epochs = input.history.filter((entry) => entry.kind === "native_cleanup_runner_epoch");
    if (epochs.length !== 3 || epochs.map((e) => e.phase).join(",") !== "launch_intent,spawned,retired") return null;
    const [launch, spawned, retired] = epochs as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    if (!(input.history.indexOf(auth[0]!) < input.history.indexOf(stages[0]!) &&
          input.history.indexOf(started[0]!) < input.history.indexOf(stages[0]!) &&
          input.history.indexOf(stages[0]!) < input.history.indexOf(launch))) return null;
    for (const entry of epochs) {
      if (entry.version !== 1 || entry.schema !== "paperclip.native_cleanup_runner_epoch.v1" ||
          entry.requestId !== requestId || entry.epoch !== 0 || entry.stateDirectory !== path ||
          typeof entry.launchId !== "string" || !entry.launchId || entry.launchId !== launch.launchId ||
          entry.initialFingerprint !== launch.initialFingerprint || !same(entry.runnerArtifact, launch.runnerArtifact)) return null;
    }
    for (const key of ["pid", "processGroupId", "processStartedAt", "spawnedAt"]) if (spawned[key] !== retired[key]) return null;
    if (!Number.isSafeInteger(retired.pid) || Number(retired.pid) <= 0 || retired.processGroupId !== retired.pid ||
        typeof retired.processStartedAt !== "string" || !retired.processStartedAt ||
        typeof retired.spawnedAt !== "string" || !retired.spawnedAt || typeof retired.retiredAt !== "string" || !retired.retiredAt ||
        retired.processGroupAbsent !== true || retired.finalFingerprint !== input.staged.fingerprint) return null;
    const bridge = rec(input.staged.provider.toolBridge), pending = rec(bridge.pending), settled = rec(bridge.settledResults);
    if (bridge.turnClosed !== true || !Array.isArray(input.staged.control.commands)) return null;
    const planById = new Map(input.fullPlan.map((result) => [result.callId, result]));
    if (planById.size !== input.fullPlan.length || !input.fullPlan.length) return null;
    const originalPending = rec(rec(input.original.provider.toolBridge).pending);
    if (Object.keys(originalPending).length !== input.fullPlan.length) return null;
    const required = new Set(Object.keys(pending));
    const journaled = new Set<string>();
    for (const raw of input.staged.control.commands) {
      const command = rec(raw), payload = rec(command.payload);
      if (command.type !== "semantic_tool.result") {
        if (command.status === "pending" && command.type !== "runner.drain") return null;
        continue;
      }
      if (!["pending", "completed"].includes(String(command.status)) ||
          typeof payload.callId !== "string" || !planById.has(payload.callId)) return null;
      if (journaled.has(payload.callId)) return null;
      journaled.add(payload.callId);
      const result = planById.get(payload.callId)!;
      if (command.commandId !== `command_reconcile_${nativeSha256Raw(`${requestId}\0${payload.callId}`)}` ||
          !same(payload, { callId: result.callId, operationId: result.operationId, result: result.result, isError: result.isError })) return null;
      if (command.status === "completed" && Object.hasOwn(pending, payload.callId)) return null;
      if (command.status === "completed") {
        const receipt = rec(command.result);
        const stored = rec(rec(input.staged.runner.processedCommands)[String(command.commandId)]);
        if (!Number.isSafeInteger(command.controllerSeq) || Number(command.controllerSeq) <= 0 ||
            receipt.commandId !== command.commandId || receipt.commandType !== command.type ||
            receipt.controllerSeq !== command.controllerSeq || receipt.status !== "completed" ||
            !same(receipt, stored) || rec(receipt.result).callId !== payload.callId ||
            !["settled_after_turn", "duplicate"].includes(String(rec(receipt.result).status))) return null;
      }
      if (command.status === "pending") required.add(payload.callId);
    }
    if (!required.size || journaled.size !== planById.size) return null;
    for (const result of input.fullPlan) {
      const originalCall = rec(originalPending[result.callId]);
      if (originalCall.callId !== result.callId || originalCall.operationId !== result.operationId ||
          nativeSha256(originalCall.input) !== result.inputDigest) return null;
      const item = rec(pending[result.callId] ?? rec(settled[result.callId]).call);
      if (item.callId !== result.callId || item.operationId !== result.operationId || nativeSha256(item.input) !== result.inputDigest) return null;
      if (!pending[result.callId] && !same(rec(settled[result.callId]).result,
        { callId: result.callId, operationId: result.operationId, result: result.result, isError: result.isError })) return null;
    }
    if ([...required].some((id) => !planById.has(id))) return null;
    const lineage = { priorRetiredEpoch: structuredClone(retired), semanticToolResults: structuredClone(input.fullPlan.filter((result) => required.has(result.callId))),
      originalFingerprint: owner.sourceFingerprint, fullPlanDigest, boardRequestId: input.boardRequestId, stagedDirectory: path };
    authenticLineages.set(lineage, nativeSha256(lineage));
    return lineage;
  } catch { return null; }
}

export function readCancelledRecoveryEpoch(input: Parameters<typeof readCancelledRecoveryEpochForOwner>[1]): CancelledResumeLineage | null {
  return readCancelledRecoveryEpochForOwner(owner, input);
}

/** Synthetic-owner isolation for tests; production callers remain pinned to the exact owner. */
export function createCancelledRecoveryEpochReaderForTest(syntheticOwner: Parameters<typeof readCancelledRecoveryEpochForOwner>[0]) {
  if (process.env.NODE_ENV !== "test") throw new Error("test-only cancelled recovery epoch reader");
  const bound = Object.freeze({ ...syntheticOwner, sourceDigests: Object.freeze([...syntheticOwner.sourceDigests]) });
  return (input: Parameters<typeof readCancelledRecoveryEpochForOwner>[1]) => readCancelledRecoveryEpochForOwner(bound, input);
}

function nativeSha256Raw(value: string) { return createHash("sha256").update(value).digest("hex"); }
