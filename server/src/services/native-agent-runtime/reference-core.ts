/**
 * Reference Core for the UNIVERSAL conformance suite (NAR spec section 8).
 *
 * Conformance-only test double. It implements the Core obligations a driver is
 * tested against (section 3.1): lease/fence authority, the durable op ledger,
 * at-most-once transport push, no-replay holds, and exactly-once Receipt
 * application. It never touches a real database, provider, process or Board.
 */

import type {
  ConvScope,
  Fence,
  Grade,
  HostHandle,
  ObserveEvent,
  Op,
  OpState,
  ProviderDriver,
  Receipt,
  SubmitResult,
} from "./types.js";
import { GRADE_ORDER } from "./types.js";

export type CoreRefusalCode =
  | "authority_lost"
  | "identity_conflict"
  | "duplicate_intent"
  | "invalid_receipt"
  | "already_terminal"
  | "invalid_state"
  | "conversation_mismatch"
  | "invalid_event";

export type CoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: CoreRefusalCode; detail: string };

export interface Lease {
  runId: string;
  issueId: string;
  conversationId?: string;
  leaseGeneration: number;
  controllerId: string;
  hostEpoch: number;
  /** ms since epoch; a lease at or past this instant is expired. */
  expiresAt: number;
}

export interface Caller {
  controllerId: string;
}

export interface OpMeta {
  issueId: string;
  conversationId: string;
  /** One client intent per run; a second op id for the same intent is refused. */
  clientIntent: string;
}

export interface OpRecord {
  op: Op;
  runId: string;
  issueId: string;
  conversationId: string;
  clientIntent: string;
  fence: Fence;
  state: OpState;
  payloadSha256: string;
  stateAt: string;
  grade?: Grade;
  submitResult?: SubmitResult;
  evidence?: string;
}

export interface AppliedReceipt {
  receipt: Receipt;
  appliedAt: string;
}

export interface CoreSnapshot {
  leases: [string, Lease][];
  ops: [string, OpRecord][];
  intents: [string, string][];
  terminals: [string, AppliedReceipt][];
  staged: [string, Receipt][];
  restarts: number;
}

export interface SubmitOutcome {
  opId: string;
  runId: string;
  state: OpState;
  reused: boolean;
  grade?: Grade;
  result?: SubmitResult;
}

export interface RecoveredOp {
  opId: string;
  state: OpState;
  /** What recovery may do; only a provably-unsent reservation may become a new op. */
  action:
    | "reject_and_allow_new_op"
    | "hold_unknown"
    | "await_late_receipt"
    | "settle_staged_receipt"
    | "already_terminal";
}

const HEX64 = /^[0-9a-f]{64}$/;

export function validateReceiptShape(receipt: Partial<Receipt> | null | undefined): string | null {
  if (!receipt || typeof receipt !== "object") return "receipt is not an object";
  const strings: (keyof Receipt)[] = [
    "receiptId",
    "runId",
    "issueId",
    "conversationId",
    "opId",
    "controllerId",
    "payloadSha256",
    "at",
  ];
  for (const key of strings) {
    if (typeof receipt[key] !== "string" || (receipt[key] as string).length === 0) {
      return `missing or empty ${key}`;
    }
  }
  if (receipt.kind !== "finish" && receipt.kind !== "block") return "kind must be finish or block";
  if (!HEX64.test(receipt.payloadSha256 as string)) return "payloadSha256 must be 64 lowercase hex chars";
  if (receipt.kind === "finish" && receipt.result === undefined) return "finish receipt needs a result";
  if (receipt.kind === "block" && (typeof receipt.reason !== "string" || receipt.reason.length === 0)) {
    return "block receipt needs a reason";
  }
  if (!Number.isInteger(receipt.hostEpoch) || (receipt.hostEpoch as number) < 1) {
    return "hostEpoch must be a positive integer";
  }
  if (!Number.isInteger(receipt.leaseGeneration) || (receipt.leaseGeneration as number) < 1) {
    return "leaseGeneration must be a positive integer";
  }
  return null;
}

export class ReferenceCore {
  private leases = new Map<string, Lease>();
  private ops = new Map<string, OpRecord>();
  private intents = new Map<string, string>();
  private terminals = new Map<string, AppliedReceipt>();
  private staged = new Map<string, Receipt>();
  private restarts = 0;

  constructor(
    private readonly driver: ProviderDriver,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // ---- leases and fences -------------------------------------------------

  registerLease(lease: Lease): void {
    this.leases.set(lease.runId, { ...lease });
  }

  bindLeaseToConversation(runId: string, conversationId: string): void {
    const lease = this.leases.get(runId);
    if (!lease) throw new Error(`no lease for run ${runId}`);
    lease.conversationId = conversationId;
  }

  expireLease(runId: string): void {
    const lease = this.leases.get(runId);
    if (lease) lease.expiresAt = this.now();
  }

  revokeLease(runId: string): void {
    this.leases.delete(runId);
  }

  getLease(runId: string): Lease | undefined {
    const lease = this.leases.get(runId);
    return lease ? { ...lease } : undefined;
  }

  private checkFence(fence: Fence, caller: Caller): CoreResult<Lease> {
    const lease = this.leases.get(fence.runId);
    if (!lease) return { ok: false, code: "authority_lost", detail: "no live lease for run" };
    if (lease.expiresAt <= this.now()) {
      return { ok: false, code: "authority_lost", detail: "lease expired" };
    }
    if (lease.leaseGeneration !== fence.leaseGeneration) {
      return { ok: false, code: "authority_lost", detail: "lease generation is stale" };
    }
    if (lease.hostEpoch !== fence.hostEpoch) {
      return { ok: false, code: "authority_lost", detail: "host epoch is stale" };
    }
    if (lease.controllerId !== caller.controllerId) {
      return { ok: false, code: "authority_lost", detail: "foreign controller" };
    }
    return { ok: true, value: { ...lease } };
  }

  // ---- host and conversation --------------------------------------------

  async attestHost(agentId: string, opts?: { create?: boolean }): Promise<CoreResult<HostHandle>> {
    const handle = await this.driver.attestHost(agentId, opts);
    if (!handle.attested) {
      return { ok: false, code: "authority_lost", detail: "host attestation failed" };
    }
    return { ok: true, value: handle };
  }

  async bindConversation(
    host: HostHandle,
    scope: ConvScope,
    mode: "new" | "resume",
    fence: Fence,
    caller: Caller,
  ): Promise<CoreResult<{ conversationId: string; host: HostHandle }>> {
    const fenceCheck = this.checkFence(fence, caller);
    if (!fenceCheck.ok) return fenceCheck;
    const { conversationId } = await this.driver.bindConversation(host, scope, mode, fence);
    this.bindLeaseToConversation(fence.runId, conversationId);
    return { ok: true, value: { conversationId, host } };
  }

  // ---- op ledger --------------------------------------------------------

  private findByIntent(runId: string, clientIntent: string): string | undefined {
    return this.intents.get(`${runId}:${clientIntent}`);
  }

  private existingOp(opId: string, op: Op, fence: Fence, meta: OpMeta): CoreResult<OpRecord> {
    const record = this.ops.get(opId);
    if (!record) return { ok: false, code: "invalid_state", detail: "no op" };
    if (record.payloadSha256 !== op.payloadSha256) {
      return { ok: false, code: "identity_conflict", detail: "same op_id with a different payload digest" };
    }
    if (
      record.runId !== fence.runId ||
      record.issueId !== meta.issueId ||
      record.conversationId !== meta.conversationId
    ) {
      return { ok: false, code: "identity_conflict", detail: "op_id belongs to a different run or scope" };
    }
    return { ok: true, value: record };
  }

  reserve(op: Op, fence: Fence, meta: OpMeta, caller: Caller): CoreResult<OpRecord> {
    const fenceCheck = this.checkFence(fence, caller);
    if (!fenceCheck.ok) return fenceCheck;
    if (fenceCheck.value.issueId !== meta.issueId) {
      return { ok: false, code: "conversation_mismatch", detail: "lease is for another issue" };
    }
    if (fenceCheck.value.conversationId && fenceCheck.value.conversationId !== meta.conversationId) {
      return { ok: false, code: "conversation_mismatch", detail: "lease is for another conversation" };
    }
    const existing = this.ops.get(op.opId);
    if (existing) {
      return this.existingOp(op.opId, op, fence, meta);
    }
    const intentOp = this.findByIntent(fence.runId, meta.clientIntent);
    if (intentOp && intentOp !== op.opId) {
      return { ok: false, code: "duplicate_intent", detail: "this run already reserved another op for that intent" };
    }
    const record: OpRecord = {
      op: { ...op },
      runId: fence.runId,
      issueId: meta.issueId,
      conversationId: meta.conversationId,
      clientIntent: meta.clientIntent,
      fence: { ...fence },
      state: "reserved",
      payloadSha256: op.payloadSha256,
      stateAt: new Date(this.now()).toISOString(),
    };
    this.ops.set(op.opId, record);
    this.intents.set(`${fence.runId}:${meta.clientIntent}`, op.opId);
    return { ok: true, value: record };
  }

  markPushStarted(opId: string, fence: Fence, caller: Caller): CoreResult<OpRecord> {
    const fenceCheck = this.checkFence(fence, caller);
    if (!fenceCheck.ok) return fenceCheck;
    const record = this.ops.get(opId);
    if (!record) return { ok: false, code: "invalid_state", detail: "no op" };
    if (record.state !== "reserved") {
      return { ok: false, code: "invalid_state", detail: `cannot push_started from ${record.state}` };
    }
    record.state = "push_started";
    record.stateAt = new Date(this.now()).toISOString();
    return { ok: true, value: record };
  }

  completeSubmit(opId: string, fence: Fence, result: SubmitResult, caller: Caller): CoreResult<OpRecord> {
    const fenceCheck = this.checkFence(fence, caller);
    if (!fenceCheck.ok) return fenceCheck;
    const record = this.ops.get(opId);
    if (!record) return { ok: false, code: "invalid_state", detail: "no op" };
    if (record.state !== "push_started") {
      return { ok: false, code: "invalid_state", detail: `cannot complete submit from ${record.state}` };
    }
    record.grade = result.grade;
    record.submitResult = result;
    record.evidence = result.evidence;
    record.state =
      result.grade === "outcome_unknown"
        ? "unknown"
        : result.grade === "emitted_local" || result.grade === "accepted_provider"
          ? "emitted_local"
          : "push_started";
    record.stateAt = new Date(this.now()).toISOString();
    return { ok: true, value: record };
  }

  /**
   * Core-side send: fence check -> ledger dedupe -> durable push_started ->
   * the single driver.submit call. A repeated op_id returns the stored state and
   * never invokes the transport.
   */
  async submit(op: Op, fence: Fence, meta: OpMeta, caller: Caller): Promise<CoreResult<SubmitOutcome>> {
    const existing = this.ops.get(op.opId);
    if (existing) {
      // Duplicate op_id: stored state is returned; the transport is NOT invoked.
      const dup = this.existingOp(op.opId, op, fence, meta);
      if (!dup.ok) return dup;
      const fenceCheck = this.checkFence(fence, caller);
      if (!fenceCheck.ok) return fenceCheck;
      return {
        ok: true,
        value: {
          opId: dup.value.op.opId,
          runId: dup.value.runId,
          state: dup.value.state,
          reused: true,
          grade: dup.value.grade,
          result: dup.value.submitResult,
        },
      };
    }
    const reserved = this.reserve(op, fence, meta, caller);
    if (!reserved.ok) return reserved;
    const started = this.markPushStarted(op.opId, fence, caller);
    if (!started.ok) return started;

    let result: SubmitResult;
    try {
      result = await this.driver.submit(
        { provider: this.driver.capabilities().provider, hostEpoch: fence.hostEpoch, attested: true, detail: {} },
        meta.conversationId,
        op,
        fence,
      );
    } catch (error) {
      const record = this.ops.get(op.opId);
      if (record) {
        record.state = "unknown";
        record.stateAt = new Date(this.now()).toISOString();
      }
      return {
        ok: false,
        code: "invalid_state",
        detail: `transport threw after push_started: ${(error as Error).message}`,
      };
    }
    const completed = this.completeSubmit(op.opId, fence, result, caller);
    if (!completed.ok) return completed;
    return {
      ok: true,
      value: {
        opId: op.opId,
        runId: fence.runId,
        state: completed.value.state,
        reused: false,
        grade: result.grade,
        result,
      },
    };
  }

  recordHook(opId: string, evidence: string): CoreResult<OpRecord> {
    const record = this.ops.get(opId);
    if (!record) return { ok: false, code: "invalid_state", detail: "no op" };
    if (record.state === "terminal" || record.state === "rejected") {
      return { ok: false, code: "invalid_state", detail: `cannot observe a hook in ${record.state}` };
    }
    record.state = "hook_observed";
    record.stateAt = new Date(this.now()).toISOString();
    record.evidence = evidence;
    return { ok: true, value: record };
  }

  readOp(opId: string): OpRecord | undefined {
    const record = this.ops.get(opId);
    return record ? { ...record, op: { ...record.op }, fence: { ...record.fence } } : undefined;
  }

  rejectReserved(opId: string): CoreResult<OpRecord> {
    const record = this.ops.get(opId);
    if (!record) return { ok: false, code: "invalid_state", detail: "no op" };
    if (record.state !== "reserved") {
      return { ok: false, code: "invalid_state", detail: `only a reserved op may be rejected (not ${record.state})` };
    }
    record.state = "rejected";
    record.stateAt = new Date(this.now()).toISOString();
    this.intents.delete(`${record.runId}:${record.clientIntent}`);
    return { ok: true, value: record };
  }

  recover(opId: string): RecoveredOp | undefined {
    const record = this.ops.get(opId);
    if (!record) return undefined;
    const staged = [...this.staged.values()].find((receipt) => receipt.opId === opId);
    if (record.state === "terminal") {
      return { opId, state: record.state, action: "already_terminal" };
    }
    if (record.state === "reserved") {
      return { opId, state: record.state, action: "reject_and_allow_new_op" };
    }
    if (staged) {
      return { opId, state: record.state, action: "settle_staged_receipt" };
    }
    if (record.state === "hook_observed") {
      return { opId, state: record.state, action: "await_late_receipt" };
    }
    return { opId, state: record.state, action: "hold_unknown" };
  }

  // ---- observation ------------------------------------------------------

  async observe(
    conversationId: string,
    cursor?: string,
  ): Promise<{ events: ObserveEvent[]; next: string; coverage: "complete" | "incomplete" }> {
    return this.driver.observe(conversationId, cursor);
  }

  async readOutcome(
    conversationId: string,
    opId: string,
  ): Promise<"receipted" | "hook_observed" | "working" | "unknown"> {
    const byReceipt = this.terminalsForOp(opId);
    if (byReceipt) return "receipted";
    return this.driver.readOutcome(conversationId, opId);
  }

  /** U11: owner steering is competing activity, never attributed to an op. */
  ingestEvents(events: ObserveEvent[]): CoreResult<{ accepted: number; rejected: string[] }> {
    const rejected: string[] = [];
    const ownerKinds = new Set(["owner_text", "owner_input", "phone_text", "phone_input"]);
    for (const event of events) {
      if (ownerKinds.has(event.kind) && event.opId) {
        rejected.push(`${event.kind} at ${event.cursor} must not carry opId ${event.opId}`);
      }
    }
    if (rejected.length > 0) {
      return { ok: false, code: "invalid_event", detail: rejected.join("; ") };
    }
    return { ok: true, value: { accepted: events.length, rejected } };
  }

  // ---- receipts ---------------------------------------------------------

  private terminalsForOp(opId: string): AppliedReceipt | undefined {
    for (const applied of this.terminals.values()) {
      if (applied.receipt.opId === opId) return applied;
    }
    return undefined;
  }

  readTerminal(runId: string): AppliedReceipt | undefined {
    return this.terminals.get(runId);
  }

  /** A receipt is a fence plus the controller that produced it; both must match. */
  private checkReceiptFence(receipt: Receipt, caller: Caller): CoreResult<Lease> {
    const fenceCheck = this.checkFence(receipt, caller);
    if (!fenceCheck.ok) return fenceCheck;
    if (receipt.controllerId !== caller.controllerId) {
      return { ok: false, code: "authority_lost", detail: "receipt names a foreign controller" };
    }
    return fenceCheck;
  }

  stageReceipt(receipt: Receipt, caller: Caller): CoreResult<Receipt> {
    const shapeError = validateReceiptShape(receipt);
    if (shapeError) return { ok: false, code: "invalid_receipt", detail: shapeError };
    const fenceCheck = this.checkReceiptFence(receipt, caller);
    if (!fenceCheck.ok) return fenceCheck;
    const record = this.ops.get(receipt.opId);
    if (!record) return { ok: false, code: "invalid_receipt", detail: "receipt names an unknown op" };
    if (
      record.runId !== receipt.runId ||
      record.issueId !== receipt.issueId ||
      record.conversationId !== receipt.conversationId ||
      record.payloadSha256 !== receipt.payloadSha256
    ) {
      return { ok: false, code: "invalid_receipt", detail: "receipt does not match the op it names" };
    }
    this.staged.set(receipt.receiptId, { ...receipt });
    return { ok: true, value: { ...receipt } };
  }

  commitStagedReceipt(receiptId: string, caller: Caller): CoreResult<AppliedReceipt> {
    const receipt = this.staged.get(receiptId);
    if (!receipt) return { ok: false, code: "invalid_receipt", detail: "no staged receipt" };
    const applied = this.applyReceipt(receipt, caller);
    if (applied.ok) this.staged.delete(receiptId);
    return applied;
  }

  /** Exactly one terminal per run; duplicate identical receipts are idempotent. */
  applyReceipt(receipt: Receipt, caller: Caller): CoreResult<AppliedReceipt> {
    const shapeError = validateReceiptShape(receipt);
    if (shapeError) return { ok: false, code: "invalid_receipt", detail: shapeError };
    const fenceCheck = this.checkReceiptFence(receipt, caller);
    if (!fenceCheck.ok) return fenceCheck;
    const record = this.ops.get(receipt.opId);
    if (!record) return { ok: false, code: "invalid_receipt", detail: "receipt names an unknown op" };
    if (
      record.runId !== receipt.runId ||
      record.issueId !== receipt.issueId ||
      record.conversationId !== receipt.conversationId ||
      record.payloadSha256 !== receipt.payloadSha256
    ) {
      return { ok: false, code: "invalid_receipt", detail: "receipt does not match the op it names" };
    }
    const existing = this.terminals.get(receipt.runId);
    if (existing) {
      if (
        existing.receipt.receiptId === receipt.receiptId &&
        existing.receipt.kind === receipt.kind &&
        existing.receipt.payloadSha256 === receipt.payloadSha256
      ) {
        return { ok: true, value: existing };
      }
      return { ok: false, code: "already_terminal", detail: "run already has one terminal receipt" };
    }
    if (record.state === "rejected") {
      return { ok: false, code: "invalid_state", detail: "cannot receive a receipt for a rejected op" };
    }
    const appliedAt = new Date(this.now()).toISOString();
    record.state = "terminal";
    record.stateAt = appliedAt;
    const applied: AppliedReceipt = { receipt: { ...receipt }, appliedAt };
    this.terminals.set(receipt.runId, applied);
    this.staged.delete(receipt.receiptId);
    return { ok: true, value: applied };
  }

  // ---- restart ----------------------------------------------------------

  snapshot(): CoreSnapshot {
    return {
      leases: [...this.leases.entries()].map(([k, v]) => [k, { ...v }]),
      ops: [...this.ops.entries()].map(([k, v]) => [k, { ...v, op: { ...v.op }, fence: { ...v.fence } }]),
      intents: [...this.intents.entries()],
      terminals: [...this.terminals.entries()].map(([k, v]) => [k, { ...v, receipt: { ...v.receipt } }]),
      staged: [...this.staged.entries()].map(([k, v]) => [k, { ...v }]),
      restarts: this.restarts,
    };
  }

  /** Simulate a Paperclip process restart: durable tables survive, memory does not. */
  static fromSnapshot(snapshot: CoreSnapshot, driver: ProviderDriver, now: () => number = () => Date.now()): ReferenceCore {
    const core = new ReferenceCore(driver, now);
    core.leases = new Map(snapshot.leases.map(([k, v]) => [k, v]));
    core.ops = new Map(snapshot.ops.map(([k, v]) => [k, v]));
    core.intents = new Map(snapshot.intents);
    core.terminals = new Map(snapshot.terminals.map(([k, v]) => [k, v]));
    core.staged = new Map(snapshot.staged.map(([k, v]) => [k, v]));
    core.restarts = snapshot.restarts + 1;
    return core;
  }

  restart(): ReferenceCore {
    return ReferenceCore.fromSnapshot(this.snapshot(), this.driver, this.now);
  }
}
