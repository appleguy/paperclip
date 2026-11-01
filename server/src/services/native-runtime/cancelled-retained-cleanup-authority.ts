/** SCO-162: exact cancelled native owner, Board-controlled *authorization* gate.
 *
 * Server-only; it cannot manufacture a RetainedRunnerdCleanupProof and it never
 * modifies the runner/provider journal. A separate authenticated maintenance
 * settlement must generate a current nonserializable proof before quarantine
 * can be retired. This module never accepts proof JSON from an HTTP client.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { retainedRunnerdCleanupProofIsCurrent, type RetainedRunnerdCleanupProof } from "../../vendor/paperclip-runner/index.js";
import { validatePrpEvent, type NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";
import { cancelledResumeLineageIsAuthentic, type CancelledResumeLineage } from "./cancelled-recovery-epoch.js";

export const exactCancelledOwner = Object.freeze({
  companyId: "55cef09f-ec08-4e71-8e7f-2afb4a912ce8",
  agentId: "c9d553f6-6452-42e0-8d6f-b7e8f541d77e",
  issueId: "fd08274c-2caf-444b-bd73-bc844f8c636f",
  runId: "dd0889d7-95e8-4809-93c1-e13ea21ef865",
  nativeSessionId: "7a78c37c-862a-4aa7-a7cb-9e52e02e1501",
  runnerInstanceId: "c800be53-f9a1-4323-bf44-33dabcebc219",
  environmentLeaseId: "992e433c-9fff-40f4-b7fe-399bd33f8a03",
  providerSessionId: "01a186df-7add-7ff0-a709-b65b4a54f439",
  runnerPid: 5943,
  providerPid: 5967,
  stateDirectory: "/Volumes/NVM/Paperclip/instances/main/runtime/paperclip-runner/durable-sessions/26242968875d33a57a82a48c08c716438446dac8965af379fc69034cbfb9e48c",
  sourceFingerprint: "cbec76340a72e253e2383eacd89c46584f3595f8e813a3f88f52f3d860c648d7",
  sourceDigests: [
    "a1d19d207fa9a68fa59d4a17e4d349d03af4a8e7d103f7c248e0abe7660d5f03",
    "2627eb9232403c5a6f5e45baf23f5c38bd544b9438f10fa6ed55b09620464275",
    "9c4008d7959032515a245318614c96a9bc180634a6e5e90fe7439e195571f6a5",
  ],
} as const);
type CancelledOwner = { readonly [K in keyof typeof exactCancelledOwner]:
  K extends "sourceDigests" ? readonly string[] : typeof exactCancelledOwner[K] extends number ? number : string };

/** The generic activation fence accepts only a prepared provider. A closed
 * provider is valid solely for this original owner and the exact durable
 * receipt-reconciliation lineage recorded in both marker and settled history. */
function exactCancelledClosedActivationMatchesForOwner(o: CancelledOwner,
  marker: Record<string, unknown>, receipt: Record<string, unknown>,
  runner: Record<string, unknown>, provider: Record<string, unknown>,
): boolean {
  const bridge = provider.toolBridge as Record<string, unknown> | undefined;
  const pending = bridge?.pending;
  const resumed = marker.resumedFromFingerprint !== undefined || marker.resumedToolCallsDigest !== undefined ||
    marker.resumedFromRequestId !== undefined || receipt.resumedFromFingerprint !== undefined ||
    receipt.resumedToolCallsDigest !== undefined || receipt.resumedFromRequestId !== undefined;
  return marker.companyId === o.companyId && marker.issueId === o.issueId &&
    marker.runId === o.runId && marker.nativeSessionId === o.nativeSessionId &&
    marker.runnerInstanceId === o.runnerInstanceId && marker.providerSessionId === o.providerSessionId &&
    marker.sourceFingerprint === o.sourceFingerprint &&
    marker.stagedSourceFingerprint === o.sourceFingerprint &&
    typeof marker.reconciledToolCallsDigest === "string" && /^[0-9a-f]{64}$/.test(marker.reconciledToolCallsDigest) &&
    receipt.phase === "settled" && receipt.requestId === marker.requestId &&
    receipt.nativeSessionId === marker.nativeSessionId && receipt.runnerInstanceId === marker.runnerInstanceId &&
    receipt.providerSessionId === marker.providerSessionId && receipt.sourceFingerprint === marker.sourceFingerprint &&
    receipt.stagedSourceFingerprint === marker.stagedSourceFingerprint &&
    receipt.reconciledToolCallsDigest === marker.reconciledToolCallsDigest &&
    (!resumed || (typeof marker.resumedFromFingerprint === "string" && /^[0-9a-f]{64}$/.test(marker.resumedFromFingerprint) &&
      typeof marker.resumedToolCallsDigest === "string" && /^[0-9a-f]{64}$/.test(marker.resumedToolCallsDigest) &&
      typeof marker.resumedFromRequestId === "string" && marker.resumedFromRequestId.startsWith("native-cleanup:") &&
      receipt.resumedFromFingerprint === marker.resumedFromFingerprint &&
      receipt.resumedToolCallsDigest === marker.resumedToolCallsDigest && receipt.resumedFromRequestId === marker.resumedFromRequestId)) &&
    receipt.settledFingerprint === marker.settledFingerprint &&
    runner.runId === o.runId && runner.normalizedSessionId === o.nativeSessionId &&
    runner.runnerInstanceId === o.runnerInstanceId && runner.lifecycle === "suspended" &&
    provider.threadId === o.providerSessionId && provider.lifecycle === "closed" &&
    bridge?.turnClosed === true && !!pending && typeof pending === "object" &&
    !Array.isArray(pending) && Object.keys(pending).length === 0;
}
export function exactCancelledClosedActivationMatches(...input: Parameters<typeof exactCancelledClosedActivationMatchesForOwner> extends [CancelledOwner, ...infer Rest] ? Rest : never): boolean {
  return exactCancelledClosedActivationMatchesForOwner(exactCancelledOwner, ...input);
}
const stateFiles = [
  "control-plane/control-plane-state.json",
  "runner/runner-state.json",
  "runner/codex-provider-state.json",
] as const;

export interface CancelledRunIdentity {
  id: string;
  companyId: string;
  agentId: string;
  nativeIssueId: string | null;
  nativeSessionId: string | null;
  runnerInstanceId: string | null;
  status: string;
  errorCode: string | null;
  runtimeMode: string | null;
  processPid?: number | null;
  processGroupId?: number | null;
}

/** Verify the cancelled result against the immutable Runner source and the
 * persisted native identity. Cancellation is never promoted to success. */
function exactCancelledCleanupJournalMatchesForOwner(o: CancelledOwner, input: {
  run: CancelledRunIdentity & { completionContractId: string | null; completionContractSha256: string | null };
  execution: NativeExecutionInput;
  accepted: { schemaStatus: string; resultJson: unknown; turnId: string | null; canonicalSha256: string; serverFingerprint: string };
  control: Record<string, unknown>;
  providerSessionId: string;
  providerAccountSessionId?: string | null;
  persistedEvents: Array<{ eventType: string; payload: unknown; sourceInstanceId: string | null;
    sourceEventId: string | null; sourceSeq: number | null; sourcePayloadSha256: string | null }>;
}): boolean {
  const rec = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  try {
    const { run, accepted, control, execution } = input;
    if (!exactOwnerIdentityMatchesForOwner(o, run) || input.providerSessionId !== o.providerSessionId ||
        execution.binding.companyId !== o.companyId || execution.binding.issueId !== o.issueId ||
        execution.binding.agentId !== o.agentId || execution.binding.runId !== o.runId ||
        accepted.schemaStatus !== "accepted" || !accepted.turnId ||
        !Array.isArray(control.committedEvents) || !Array.isArray(control.commands)) return false;
    const envelope = rec(accepted.resultJson), terminal = rec(envelope.terminal);
    if (terminal.turnTerminalState !== "interrupted" || terminal.runTerminalState !== "cancelled" ||
        terminal.reportedWorkDisposition !== "needs_review") return false;
    const canonical = { result: envelope.result, terminal: envelope.terminal, turnId: accepted.turnId };
    const fingerprint = nativeSha256({ runId: run.id, completionContractSha256: run.completionContractSha256,
      canonicalSha256: accepted.canonicalSha256 });
    const validRows = input.persistedEvents.filter((row) => {
      const parsed = validatePrpEvent(rec(row.payload).prpEvent);
      return parsed.ok && parsed.event.runId === o.runId && parsed.event.normalizedSessionId === o.nativeSessionId &&
        parsed.event.sourceInstanceId === row.sourceInstanceId && parsed.event.sourceEventId === row.sourceEventId &&
        parsed.event.sourceSeq === row.sourceSeq && row.sourcePayloadSha256 === nativeSha256(parsed.event);
    });
    const identities = validRows.filter(row => ["session.started", "session.resumed"].includes(row.eventType) && row.sourceInstanceId === o.runnerInstanceId);
    if (identities.length !== 1) return false;
    const identityEvent = rec(rec(identities[0]!.payload).prpEvent), identityPayload = rec(identityEvent.payload);
    if (identityEvent.eventType !== identities[0]!.eventType || identityEvent.sourceKind !== "runner" ||
        identityEvent.sourceEventId !== `${o.runnerInstanceId}:${o.runId}:${identityEvent.sourceSeq}` ||
        identityPayload.driverSessionId !== o.providerSessionId ||
        identityPayload.providerSessionId !== (input.providerAccountSessionId ?? o.providerSessionId)) return false;
    const boundDigest = validRows.some(row => {
      const event = rec(rec(row.payload).prpEvent);
      return event.sourceKind === "control_plane" && nativeSha256({ binding: {
        companyId: run.companyId, issueId: run.nativeIssueId, agentId: run.agentId, runId: run.id,
        sessionId: run.nativeSessionId, sourceInstanceId: run.runnerInstanceId,
        controlPlaneSourceInstanceId: row.sourceInstanceId, completionContractId: run.completionContractId,
        completionContractSha256: run.completionContractSha256 }, ...canonical }) === accepted.canonicalSha256;
    });
    if (!((accepted.canonicalSha256 === `sha256:${nativeSha256(canonical)}` && accepted.serverFingerprint === `sha256:${fingerprint}`) ||
        (accepted.serverFingerprint === fingerprint && boundDigest))) return false;
    const identity = rec(control.identity), commands = control.commands.map(rec);
    if (identity.runId !== o.runId || identity.normalizedSessionId !== o.nativeSessionId ||
        identity.runnerInstanceId !== o.runnerInstanceId || identity.environmentLeaseId !== o.environmentLeaseId) return false;
    const contract = execution.completionContract.contract;
    if (!commands.some(c => c.type === "run.prepare" && c.status === "completed" &&
        canonicalInput(rec(c.payload).completionContract) === canonicalInput({ revision: contract.revision, criterionIds: contract.criteria.map(x => x.id) })) ||
        !commands.some(c => c.type === "turn.start" && c.status === "completed" && rec(rec(c.result).result).providerTurnId === accepted.turnId)) return false;
    const events = control.committedEvents.map(entry => rec(rec(rec(entry).envelope).payload));
    const bound = (event: Record<string, unknown>, type: string) => validatePrpEvent(event).ok &&
      event.eventType === type && event.sourceKind === "runner" && event.runId === o.runId &&
      event.normalizedSessionId === o.nativeSessionId && event.sourceInstanceId === o.runnerInstanceId &&
      event.turnId === identity.turnId && event.itemId === identity.itemId;
    const acceptedTurn = events.filter(e => bound(e, "turn.accepted") && rec(e.payload).providerSessionId === o.providerSessionId && rec(e.payload).providerTurnId === accepted.turnId);
    const interrupted = events.filter(e => bound(e, "turn.interrupted") && rec(e.payload).status === "interrupted" && rec(e.payload).providerTurnId === accepted.turnId);
    const proposed = events.filter(e => bound(e, "run.result.proposed") && canonicalInput(e.payload) === canonicalInput(envelope.result));
    const terminals = events.filter(e => {
      if (!bound(e, "run.terminal")) return false;
      const raw = rec(e.payload);
      if (raw.provider !== "codex" || Object.keys(raw).sort().join(",") !==
          "provider,reportedWorkDisposition,runTerminalState,schema,turnTerminalState" ||
          Object.keys(terminal).sort().join(",") !== "reportedWorkDisposition,runTerminalState,schema,turnTerminalState") return false;
      return canonicalInput({ schema: raw.schema, turnTerminalState: raw.turnTerminalState,
        runTerminalState: raw.runTerminalState, reportedWorkDisposition: raw.reportedWorkDisposition }) === canonicalInput(terminal);
    });
    return acceptedTurn.length === 1 && interrupted.length === 1 && proposed.length === 1 && terminals.length === 1 &&
      Number(acceptedTurn[0]!.sourceSeq) < Number(proposed[0]!.sourceSeq) &&
      Number(proposed[0]!.sourceSeq) < Number(interrupted[0]!.sourceSeq) &&
      Number(interrupted[0]!.sourceSeq) < Number(terminals[0]!.sourceSeq);
  } catch { return false; }
}
export function exactCancelledCleanupJournalMatches(input: Parameters<typeof exactCancelledCleanupJournalMatchesForOwner>[1]): boolean {
  return exactCancelledCleanupJournalMatchesForOwner(exactCancelledOwner, input);
}
type Verdict = {
  code: "identity_mismatch" | "source_mismatch" | "process_ownership_unknown" |
    "unsettled_tool_inputs" | "other_journal_obligations" | "ready_for_authorized_staging";
  runId: string;
  sourceFingerprintMatching: boolean;
  pendingToolCalls: number | null;
  pendingToolReceipts: PendingApiReceiptSummary | null;
  canClearQuarantine: false;
  canLaunchNativeProbe: false;
};
function sha(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function shaSource(digests: string[]): string {
  return sha(JSON.stringify(digests));
}
function canonicalInput(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalInput).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj=value as Record<string,unknown>;
    return `{${Object.keys(obj).sort().map(k=>`${JSON.stringify(k)}:${canonicalInput(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export type PendingApiReceiptSummary = {
  total: number;
  readOnlyPending: number;
  mutationsWithCompletedExactReceipts: number;
  mutationOutcomesUnknown: number;
  malformedOrUnknown: number;
  allSideEffectsReconciled: boolean;
};
/** Validates pending bridge identities against the same exact call-ID and
 * canonical API-input digest used by PaperclipRunnerToolAuthority. No GET is
 * executed here and a completed PUT is never called again.
 */
export function classifyCancelledBridgeReceipts(
  pending: unknown, apiReceipts: unknown,
): PendingApiReceiptSummary {
  const out: PendingApiReceiptSummary = {total:0,readOnlyPending:0,
    mutationsWithCompletedExactReceipts:0,mutationOutcomesUnknown:0,
    malformedOrUnknown:0,allSideEffectsReconciled:false};
  if (!pending || typeof pending!=="object" || Array.isArray(pending) ||
      !apiReceipts || typeof apiReceipts!=="object" || Array.isArray(apiReceipts)) {
    out.malformedOrUnknown=1;
    return out;
  }
  const receipts=apiReceipts as Record<string,unknown>;
  for (const [id, raw] of Object.entries(pending as Record<string,unknown>)) {
    out.total++;
    const call=raw && typeof raw==="object" && !Array.isArray(raw)
      ? raw as Record<string,unknown> : null;
    const input=call?.input && typeof call.input==="object" && !Array.isArray(call.input)
      ? call.input as Record<string,unknown> : null;
    if (!call || !input || call.callId!==id || call.operationId!=="call_api" ||
        typeof input.operationId!=="string") {
      out.malformedOrUnknown++;
      continue;
    }
    const method=input.operationId.split(" ",1)[0]!;
    if (["GET","HEAD","OPTIONS"].includes(method)) {
      out.readOnlyPending++;
      continue;
    }
    if (!["POST","PUT","PATCH","DELETE"].includes(method)) {
      out.malformedOrUnknown++;
      continue;
    }
    const key=sha(id);
    const v=receipts[key];
    const r=v && typeof v==="object" && !Array.isArray(v)
      ? v as Record<string,unknown> : null;
    const digest=sha(canonicalInput(input));
    if (r?.state==="completed" && r.operationId===input.operationId &&
        r.digest===digest &&
        (Object.hasOwn(r,"result") || Object.hasOwn(r,"encryptedResult"))) {
      out.mutationsWithCompletedExactReceipts++;
    } else {
      out.mutationOutcomesUnknown++;
    }
  }
  out.allSideEffectsReconciled=out.mutationOutcomesUnknown===0 &&
    out.malformedOrUnknown===0;
  return out;
}

export interface CancelledBridgeSettlement {
  callId: string;
  operationId: string;
  inputDigest: string;
  disposition: "completed_api_receipt" | "read_cancelled";
  result: unknown;
  isError: boolean;
}

/** SHA-256 of the exact JSON settlement array using the same sorted-key
 * canonical representation as Runner's durable command digest. */
export function cancelledBridgeSettlementDigest(plan: readonly CancelledBridgeSettlement[]): string {
  const encoded = JSON.stringify(plan, (_key, value: unknown) => {
    if (value === undefined || typeof value === "function" || typeof value === "symbol" ||
        typeof value === "bigint" || (typeof value === "number" && !Number.isFinite(value)) ||
        (value !== null && typeof value === "object" && !Array.isArray(value) &&
          Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
      throw new Error("invalid cancelled settlement plan");
    return value;
  });
  if (encoded === undefined) throw new Error("invalid cancelled settlement plan");
  const jsonValue: unknown = JSON.parse(encoded);
  const canonical = canonicalInput(plan);
  if (canonical !== canonicalInput(jsonValue)) throw new Error("invalid cancelled settlement plan");
  return sha(canonical);
}

/** Builds Runner results only from exact persisted receipts. It never invokes
 * an API operation. The caller must already hold the exact Board recovery
 * authorization and retain the original journal unchanged. */
export async function buildCancelledBridgeSettlementPlan(input: {
  pending: unknown;
  apiToolReceipts: unknown;
  resolveEncryptedResult?: (material: unknown) => Promise<unknown>;
}): Promise<CancelledBridgeSettlement[] | null> {
  const pending = input.pending && typeof input.pending === "object" && !Array.isArray(input.pending)
    ? input.pending as Record<string, unknown> : null;
  const receipts = input.apiToolReceipts && typeof input.apiToolReceipts === "object" && !Array.isArray(input.apiToolReceipts)
    ? input.apiToolReceipts as Record<string, unknown> : null;
  if (!pending || !receipts) return null;
  const summary = classifyCancelledBridgeReceipts(pending, receipts);
  if (!summary.allSideEffectsReconciled ||
      summary.total !== summary.readOnlyPending + summary.mutationsWithCompletedExactReceipts)
    return null;
  const settlements: CancelledBridgeSettlement[] = [];
  for (const [id, raw] of Object.entries(pending)) {
    const call = raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, unknown> : null;
    const apiInput = call?.input && typeof call.input === "object" && !Array.isArray(call.input)
      ? call.input as Record<string, unknown> : null;
    if (!call || !apiInput || call.callId !== id || call.operationId !== "call_api" ||
        typeof apiInput.operationId !== "string") return null;
    const method = apiInput.operationId.split(" ", 1)[0]!;
    const inputDigest = sha(canonicalInput(apiInput));
    if (["GET", "HEAD", "OPTIONS"].includes(method)) {
      settlements.push({callId:id,operationId:call.operationId,inputDigest,
        disposition:"read_cancelled",isError:true,result:{ok:false,status:null,
          error:"native_cleanup_read_cancelled",outcome:"cancelled",
          guidance:"This read was not repeated during retained cleanup. A fresh run may read current state."}});
      continue;
    }
    const receipt = receipts[sha(id)] as Record<string, unknown>;
    let apiResult: unknown;
    if (Object.hasOwn(receipt,"encryptedResult")) {
      if (!input.resolveEncryptedResult) return null;
      try { apiResult=await input.resolveEncryptedResult(receipt.encryptedResult); }
      catch { return null; }
    } else if (Object.hasOwn(receipt,"result")) {
      apiResult=receipt.result;
    } else return null;
    const apiRecord=apiResult && typeof apiResult==="object" && !Array.isArray(apiResult)
      ? apiResult as Record<string,unknown> : null;
    if (!apiRecord || apiRecord.outcome==="unknown" || apiRecord.error==="api_outcome_unknown")
      return null;
    const {operationId:_operationId,...response}=apiRecord;
    settlements.push({callId:id,operationId:call.operationId,inputDigest,
      disposition:"completed_api_receipt",isError:false,
      result:{...response,apiOperationId:apiRecord.operationId ?? receipt.operationId}});
  }
  return settlements;
}

function absent(pid: number): boolean {
  if (process.platform === "win32" || !Number.isSafeInteger(pid) || pid <= 1) return false;
  return [pid, -pid].every((target) => {
    try { process.kill(target, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  });
}
function exactOwnerIdentityMatchesForOwner(b: CancelledOwner, run: CancelledRunIdentity): boolean {
  return !!run && run.id === b.runId && run.companyId === b.companyId &&
    run.agentId === b.agentId && run.nativeIssueId === b.issueId &&
    run.nativeSessionId === b.nativeSessionId && run.runnerInstanceId === b.runnerInstanceId &&
    run.status === "cancelled" && run.errorCode === "native_session_interrupted" &&
    run.runtimeMode === "native" && run.processPid == null && run.processGroupId == null;
}
export function exactOwnerIdentityMatches(run: CancelledRunIdentity): boolean {
  return exactOwnerIdentityMatchesForOwner(exactCancelledOwner, run);
}
function assessCancelledNativeOwnerForOwner(b: CancelledOwner, input: {
  run: CancelledRunIdentity; expectedFingerprint: string;
  apiToolReceipts?: unknown;
  stateDirectory?: string; processAbsent?: (pid: number) => boolean;
}): Verdict {
  const output = (code: Verdict["code"], sourceFingerprintMatching = false,
    pendingToolCalls: number | null = null,
    pendingToolReceipts: PendingApiReceiptSummary | null = null): Verdict => ({
    code, runId: b.runId, sourceFingerprintMatching, pendingToolCalls,
    pendingToolReceipts,canClearQuarantine: false, canLaunchNativeProbe: false,
  });
  if (!exactOwnerIdentityMatchesForOwner(b, input.run) || input.expectedFingerprint !== b.sourceFingerprint)
    return output("identity_mismatch");
  const root = input.stateDirectory ?? b.stateDirectory;
  // Callers cannot inject a different production state path. Tests supply an
  // explicit sandbox; the route never exposes this override.
  try {
    const digests: string[] = [];
    const states: Record<string,unknown>[] = [];
    for (const name of stateFiles) {
      const file = join(root, name);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32*1024*1024)
        return output("source_mismatch");
      const bytes = readFileSync(file);
      digests.push(sha(bytes));
      const decoded: unknown = JSON.parse(bytes.toString("utf8"));
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
        return output("source_mismatch");
      states.push(decoded as Record<string,unknown>);
    }
    if (digests.some((value,i) => value !== b.sourceDigests[i]) ||
      shaSource(digests) !== b.sourceFingerprint)
      return output("source_mismatch");
    const [control, runner, provider] = states;
    const identity = control!.identity as Record<string,unknown> | undefined;
    if (!identity || identity.runId !== b.runId ||
      identity.normalizedSessionId !== b.nativeSessionId ||
      identity.runnerInstanceId !== b.runnerInstanceId ||
      identity.environmentLeaseId !== b.environmentLeaseId ||
      runner!.runId !== b.runId || runner!.runnerInstanceId !== b.runnerInstanceId ||
      runner!.normalizedSessionId !== b.nativeSessionId ||
      provider!.threadId !== b.providerSessionId)
      return output("source_mismatch",true);
    const absentCheck = input.processAbsent ?? absent;
    if (!absentCheck(b.runnerPid) || !absentCheck(b.providerPid))
      return output("process_ownership_unknown",true);
    const toolBridge = provider!.toolBridge as Record<string,unknown> | undefined;
    const pending = toolBridge?.pending;
    if (!pending || typeof pending !== "object" || Array.isArray(pending))
      return output("other_journal_obligations",true);
    const pendingCount = Object.keys(pending).length;
    const toolReceipts = pendingCount && input.apiToolReceipts
      ? classifyCancelledBridgeReceipts(pending,input.apiToolReceipts) : null;
    if (pendingCount) {
      // Staging is allowed only after every mutation has an exact completed
      // receipt and every remaining call is a read-only operation. The stage
      // runner still has to apply those receipts/cancellations to the closed
      // bridge before it can mint cleanup proof; this preflight does not
      // settle calls or clear quarantine.
      const safelyClassified = toolReceipts?.allSideEffectsReconciled === true &&
        toolReceipts.total === toolReceipts.readOnlyPending +
          toolReceipts.mutationsWithCompletedExactReceipts;
      if (!safelyClassified || toolBridge.turnClosed !== true)
        return output("unsettled_tool_inputs",true,pendingCount,toolReceipts);
    }
    const commands = control!.commands;
    const pendingEvents = provider!.pendingEvents;
    const queuedEvents = provider!.queuedEvents;
    if (!Array.isArray(commands) || commands.length !== 500 ||
      commands.some(x => !!x && typeof x === "object" && (x as Record<string,unknown>).status === "pending") ||
      !Array.isArray(pendingEvents) || pendingEvents.length !== 0 ||
      !Array.isArray(queuedEvents) || queuedEvents.length !== 0 ||
      provider!.ambiguousTurnStartPending === true)
      return output("other_journal_obligations",true,0);
    return output("ready_for_authorized_staging",true,pendingCount,toolReceipts);
  } catch {
    return output("source_mismatch");
  }
}
export function assessCancelledNativeOwner(input: Parameters<typeof assessCancelledNativeOwnerForOwner>[1]): Verdict {
  return assessCancelledNativeOwnerForOwner(exactCancelledOwner, input);
}
export interface ExactRecoveryIntent {
  schema: "paperclip.cancelled_recovery_intent.v1";
  requestId: string;
  runId: string;
  nativeSessionId: string;
  runnerInstanceId: string;
  originalFingerprint: string;
  preparedAt: string;
  status: "prepared";
}
/** Server-only exclusive durable record. Preparing never clears quarantine. */
function prepareExactCancelledRecoveryIntentForOwner(exactCancelledOwner: CancelledOwner, input: {
  run: CancelledRunIdentity;
  expectedFingerprint: string;
  apiToolReceipts?: unknown;
  root?: string;
  stateDirectory?: string;
  processAbsent?: (pid:number)=>boolean;
  requestId?: string;
}): { code: "operator_required" | "intent_prepared" | "already_prepared"; verdict: Verdict;
  intentId?: string } {
  const verdict = assessCancelledNativeOwnerForOwner(exactCancelledOwner, input);
  if (verdict.code !== "ready_for_authorized_staging")
    return {code:"operator_required",verdict};
  const root = input.root ?? "/Volumes/NVM/Paperclip/instances/main/runtime/paperclip-runner/board-cancelled-recovery";
  mkdirSync(root,{recursive:true,mode:0o700});
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077))
    throw new Error("unsafe recovery intent directory");
  const base = join(root,exactCancelledOwner.runId+".json");
  if (existsSync(base) || existsSync(base+".started") || existsSync(base+".used"))
    return {code:"already_prepared",verdict};
  const requestId = input.requestId ?? randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(requestId))
    throw new Error("invalid owner recovery request ID");
  const receipt: ExactRecoveryIntent = {
    schema:"paperclip.cancelled_recovery_intent.v1", requestId,
    runId:exactCancelledOwner.runId,
    nativeSessionId:exactCancelledOwner.nativeSessionId,
    runnerInstanceId:exactCancelledOwner.runnerInstanceId,
    originalFingerprint:exactCancelledOwner.sourceFingerprint,
    preparedAt:new Date().toISOString(), status:"prepared",
  };
  const fd = openSync(base, constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {
    writeSync(fd,JSON.stringify(receipt)+"\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return {code:"intent_prepared",verdict,intentId:sha(requestId)};
}
export function prepareExactCancelledRecoveryIntent(input: Parameters<typeof prepareExactCancelledRecoveryIntentForOwner>[1]): ReturnType<typeof prepareExactCancelledRecoveryIntentForOwner> {
  return prepareExactCancelledRecoveryIntentForOwner(exactCancelledOwner, input);
}
/** Atomically reserve the one-use authorization before launching maintenance.
 * An interrupted attempt remains started and must be investigated, never replayed. */
function reservePreparedCancelledIntentForOwner(exactCancelledOwner: CancelledOwner, input: {root: string; requestId: string}): boolean {
  const path = join(input.root, exactCancelledOwner.runId + ".json");
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) return false;
    const d = JSON.parse(readFileSync(path, "utf8")) as ExactRecoveryIntent;
    if (d.schema !== "paperclip.cancelled_recovery_intent.v1" || d.status !== "prepared" ||
        d.requestId !== input.requestId || d.runId !== exactCancelledOwner.runId ||
        d.nativeSessionId !== exactCancelledOwner.nativeSessionId ||
        d.runnerInstanceId !== exactCancelledOwner.runnerInstanceId ||
        d.originalFingerprint !== exactCancelledOwner.sourceFingerprint ||
        existsSync(path + ".started") || existsSync(path + ".used")) return false;
    linkSync(path, path + ".started");
    const dir = openSync(input.root, constants.O_RDONLY);
    try { fsyncSync(dir); } finally { closeSync(dir); }
    unlinkSync(path);
    return true;
  } catch { return false; }
}
export function reservePreparedCancelledIntent(input: {root: string; requestId: string}): boolean {
  return reservePreparedCancelledIntentForOwner(exactCancelledOwner, input);
}
/** An exact maintenance operation may consume this only after obtaining its
 * own authentic in-process settler proof. Never called from an HTTP route.
 * A consumed intent cannot be replayed, including after a crash.
 */
function consumePreparedCancelledIntentForOwner(b: CancelledOwner, input: {root: string; runId: string; requestId: string;
  originalFingerprint: string; expectedReconciledToolCallsDigest: string;
  settledProof: RetainedRunnerdCleanupProof; resumeLineage?: CancelledResumeLineage}): boolean {
  const proof = input.settledProof;
  const lineage = input.resumeLineage;
  const validLineage = lineage && cancelledResumeLineageIsAuthentic(lineage) &&
    lineage.boardRequestId === input.requestId && lineage.originalFingerprint === b.sourceFingerprint &&
    lineage.fullPlanDigest === input.expectedReconciledToolCallsDigest &&
    lineage.priorRetiredEpoch.finalFingerprint === proof?.sourceFingerprint &&
    proof.stagedSourceFingerprint === proof.sourceFingerprint &&
    proof.reconciledToolCallsDigest === cancelledBridgeSettlementDigest(lineage.semanticToolResults);
  if (!proof || !retainedRunnerdCleanupProofIsCurrent(proof) ||
    proof.binding.runId !== b.runId || proof.binding.companyId !== b.companyId ||
    proof.binding.agentId !== b.agentId || proof.binding.issueId !== b.issueId ||
    proof.binding.sessionId !== b.nativeSessionId ||
    proof.identity.runnerInstanceId !== b.runnerInstanceId ||
    proof.activationDirectory !== b.stateDirectory ||
    proof.providerSessionId !== b.providerSessionId ||
    proof.backend.kind !== "runner" || proof.backend.name !== "codex_app_server" ||
    (!validLineage && (proof.sourceFingerprint !== b.sourceFingerprint ||
      proof.stagedSourceFingerprint !== b.sourceFingerprint)) ||
    typeof proof.reconciledToolCallsDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(proof.reconciledToolCallsDigest) ||
    (!validLineage && proof.reconciledToolCallsDigest !== input.expectedReconciledToolCallsDigest) ||
    (lineage !== undefined && !validLineage) ||
    input.runId !== b.runId || input.originalFingerprint !== b.sourceFingerprint) return false;
  const path = join(input.root,b.runId+".json.started");
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) return false;
    const d = JSON.parse(readFileSync(path,"utf8")) as ExactRecoveryIntent;
    if (d.schema !== "paperclip.cancelled_recovery_intent.v1" ||
        d.runId !== b.runId || d.nativeSessionId !== b.nativeSessionId ||
        d.runnerInstanceId !== b.runnerInstanceId ||
        d.originalFingerprint !== b.sourceFingerprint ||
        d.status !== "prepared" || d.requestId !== input.requestId) return false;
    // Hard-link creation is atomic and refuses overwrite of an existing
    // consumed record. A crash before unlink leaves BOTH names; .used then
    // permanently prevents a second consumption even after a crash.
    const used = join(input.root, b.runId+".json.used");
    if (existsSync(used)) return false;
    linkSync(path,used);
    const dir = openSync(input.root, constants.O_RDONLY);
    try { fsyncSync(dir); } finally { closeSync(dir); }
    unlinkSync(path);
    return true;
  } catch { return false; }
}
export function consumePreparedCancelledIntent(input: Parameters<typeof consumePreparedCancelledIntentForOwner>[1]): boolean {
  return consumePreparedCancelledIntentForOwner(exactCancelledOwner, input);
}

/** Internal test seam. Production exports above always use the frozen exact owner;
 * no route or request can choose this factory's owner. */
export function createCancelledCleanupAuthorityForTest(owner: CancelledOwner) {
  if (process.env.NODE_ENV !== "test") throw new Error("test-only cancelled cleanup authority");
  const bound = Object.freeze({ ...owner, sourceDigests: Object.freeze([...owner.sourceDigests]) });
  return {
    exactCancelledClosedActivationMatches: (...input: Parameters<typeof exactCancelledClosedActivationMatches>) => exactCancelledClosedActivationMatchesForOwner(bound, ...input),
    exactOwnerIdentityMatches: (run: CancelledRunIdentity) => exactOwnerIdentityMatchesForOwner(bound, run),
    assessCancelledNativeOwner: (input: Parameters<typeof assessCancelledNativeOwnerForOwner>[1]) => assessCancelledNativeOwnerForOwner(bound, input),
    exactCancelledCleanupJournalMatches: (input: Parameters<typeof exactCancelledCleanupJournalMatchesForOwner>[1]) => exactCancelledCleanupJournalMatchesForOwner(bound, input),
    prepareExactCancelledRecoveryIntent: (input: Parameters<typeof prepareExactCancelledRecoveryIntentForOwner>[1]) => prepareExactCancelledRecoveryIntentForOwner(bound, input),
    reservePreparedCancelledIntent: (input: Parameters<typeof reservePreparedCancelledIntentForOwner>[1]) => reservePreparedCancelledIntentForOwner(bound, input),
    consumePreparedCancelledIntent: (input: Parameters<typeof consumePreparedCancelledIntentForOwner>[1]) => consumePreparedCancelledIntentForOwner(bound, input),
  };
}
