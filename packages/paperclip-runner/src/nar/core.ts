// NAR Core: leases and fences, op ledger, receipt validation, recovery.
// Spec: doc/spec/native-agent-runtime.md sections 2.3, 3.1, 7.2, 8.1.
// This is the reference ledger the conformance suite runs against. The in-memory
// store mirrors the native_ops / native_receipts tables (7.2) one-to-one so the
// Postgres adapter can be swapped in behind the same NarCore calls.
import { createHash, randomUUID } from "node:crypto";
import { isDispatchEligible } from "./capabilities.js";
import type { ConvScope, Fence, HostHandle, Provider, ProviderDriver } from "./driver.js";

export type OpState =
  | "reserved"
  | "push_started"
  | "emitted_local"
  | "hook_observed"
  | "terminal"
  | "rejected"
  | "unknown"
  | "interrupted";
export type OpKind = "prompt" | "interrupt" | "new_conversation" | "resume";
export type RunStatus = "running" | "held" | "done" | "blocked" | "superseded";

export type NarErrorCode =
  | "authority_lost"
  | "identity_conflict"
  | "duplicate_intent"
  | "driver_degraded"
  | "foreign_conversation"
  | "conversation_unknown"
  | "receipt_fence"
  | "receipt_invalid"
  | "terminal_exists"
  | "unknown_run"
  | "invalid_transition";

export class NarError extends Error {
  constructor(
    readonly code: NarErrorCode,
    message?: string,
  ) {
    super(message ? `${code}: ${message}` : code);
    this.name = "NarError";
  }
}

export interface Evidence {
  rung: OpState;
  source: string;
  at: string;
}
export interface OpRow {
  opId: string;
  runId: string;
  conversationRef: string;
  hostRef: string;
  kind: OpKind;
  clientIntent: string;
  payloadSha256: string;
  state: OpState;
  held: boolean;
  hostEpoch: number;
  leaseGeneration: number;
  evidence: Evidence[];
}
export interface RunRow {
  runId: string;
  issueId: string;
  agentId: string;
  provider: Provider;
  controller: string;
  leaseGeneration: number;
  leaseExpiresAt: number;
  hostEpoch: number;
  status: RunStatus;
  conversationId?: string;
}
export interface ReceiptRow {
  id: string;
  opId: string;
  runId: string;
  issueId: string;
  channel: "mcp" | "file" | "provider_event";
  kind: "finish" | "block";
  payloadSha256: string;
  payload: Record<string, unknown>;
  toolCallId?: string;
  hostEpoch: number;
  leaseGeneration: number;
  state: "applied";
}
export interface ConversationRow {
  agentId: string;
  issueId: string;
  provider: Provider;
  conversationId?: string;
  cwd: string;
  model?: string;
  state: "bound" | "unknown";
}
export interface NarEvent {
  type: string;
  at: string;
  runId?: string;
  opId?: string;
  data: Record<string, string | number | boolean>;
}

export class NarStore {
  runs = new Map<string, RunRow>();
  ops = new Map<string, OpRow>();
  receipts = new Map<string, ReceiptRow>();
  conversations = new Map<string, ConversationRow>(); // key agentId\0issueId
  issueStatus = new Map<string, "todo" | "in_progress" | "done" | "blocked">();
  issueGeneration = new Map<string, number>();
  events: NarEvent[] = [];

  toJSON() {
    return {
      runs: [...this.runs.values()],
      ops: [...this.ops.values()],
      receipts: [...this.receipts.values()],
      conversations: [...this.conversations.values()],
      issueStatus: Object.fromEntries(this.issueStatus),
      issueGeneration: Object.fromEntries(this.issueGeneration),
      events: this.events,
    };
  }
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export interface StartRunInput {
  runId: string;
  issueId: string;
  agentId: string;
  provider: Provider;
  controller: string;
  leaseGeneration: number;
  leaseTtlMs: number;
  host: HostHandle;
}
export interface DispatchInput {
  opId: string;
  clientIntent: string;
  kind: "prompt" | "interrupt";
  text: string;
}
export interface DispatchResult {
  op: OpRow;
  transportInvoked: boolean;
}
export interface ReceiptInput {
  opId: string;
  runId: string;
  issueId: string;
  conversationId: string;
  hostEpoch: number;
  leaseGeneration: number;
  controller: string;
  channel: ReceiptRow["channel"];
  kind: ReceiptRow["kind"];
  payload: unknown;
  toolCallId?: string;
}

export class NarCore {
  private readonly now: () => number;

  constructor(
    readonly store: NarStore,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private event(type: string, data: NarEvent["data"], runId?: string, opId?: string) {
    this.store.events.push({ type, at: this.iso(), runId, opId, data });
  }

  private run(runId: string): RunRow {
    const r = this.store.runs.get(runId);
    if (!r) throw new NarError("unknown_run", runId);
    return r;
  }

  private advance(op: OpRow, to: OpState, source: string) {
    op.state = to;
    op.evidence.push({ rung: to, source, at: this.iso() });
    this.event("nar.op_state", { state: to, source }, op.runId, op.opId);
  }

  private hold(op: OpRow, source: string) {
    if (op.state !== "unknown") this.advance(op, "unknown", source);
    op.held = true;
    const r = this.store.runs.get(op.runId);
    if (r && r.status === "running") r.status = "held";
  }

  private hostRef(r: RunRow, epoch = r.hostEpoch): string {
    return `${r.provider}:${r.agentId}:${epoch}`;
  }

  // ---- leases and fences -------------------------------------------------

  startRun(i: StartRunInput): RunRow {
    const current = this.store.issueGeneration.get(i.issueId) ?? 0;
    if (i.leaseGeneration <= current) throw new NarError("authority_lost", "lease generation not newer");
    if (!i.host.attested || i.host.provider !== i.provider) throw new NarError("authority_lost", "host not attested");
    for (const r of this.store.runs.values()) {
      if (r.issueId === i.issueId && (r.status === "running" || r.status === "held")) r.status = "superseded";
    }
    this.store.issueGeneration.set(i.issueId, i.leaseGeneration);
    this.store.issueStatus.set(i.issueId, "in_progress");
    const row: RunRow = {
      runId: i.runId,
      issueId: i.issueId,
      agentId: i.agentId,
      provider: i.provider,
      controller: i.controller,
      leaseGeneration: i.leaseGeneration,
      leaseExpiresAt: this.now() + i.leaseTtlMs,
      hostEpoch: i.host.hostEpoch,
      status: "running",
    };
    this.store.runs.set(i.runId, row);
    this.event("nar.run_started", { generation: i.leaseGeneration }, i.runId);
    return row;
  }

  checkFence(f: Fence, controller: string): RunRow {
    const r = this.run(f.runId);
    const gen = this.store.issueGeneration.get(r.issueId);
    if (
      r.status !== "running" ||
      r.controller !== controller ||
      f.leaseGeneration !== r.leaseGeneration ||
      gen !== r.leaseGeneration ||
      f.hostEpoch !== r.hostEpoch ||
      this.now() >= r.leaseExpiresAt
    ) {
      throw new NarError("authority_lost", `run ${f.runId}`);
    }
    return r;
  }

  // ---- conversations: new per issue, resume on re-entry ------------------

  async bindConversation(
    driver: ProviderDriver,
    h: HostHandle,
    s: ConvScope,
    f: Fence,
    controller: string,
  ): Promise<{ conversationId: string; mode: "new" | "resume" }> {
    const r = this.checkFence(f, controller);
    if (s.agentId !== r.agentId || s.issueId !== r.issueId) throw new NarError("foreign_conversation", "scope/run mismatch");
    const key = `${s.agentId}\u0000${s.issueId}`;
    const existing = this.store.conversations.get(key);
    if (existing?.state === "unknown") {
      // Creation outcome unknown: never retried automatically (R-N6, A1).
      throw new NarError("conversation_unknown", "creation outcome unknown; board reconciliation required");
    }
    if (existing) {
      if (existing.provider !== r.provider || existing.cwd !== s.cwd || existing.model !== s.model) {
        throw new NarError("foreign_conversation", "cwd/model/provider differ from bound conversation");
      }
      const got = await driver.bindConversation(h, s, "resume", f, existing.conversationId);
      if (got.conversationId !== existing.conversationId || got.cwd !== s.cwd || got.model !== s.model) {
        throw new NarError("foreign_conversation", "resume returned a different conversation");
      }
      r.conversationId = existing.conversationId;
      this.event("nar.conversation_resumed", {}, r.runId);
      return { conversationId: got.conversationId, mode: "resume" };
    }

    const op = this.reserveRow(r, {
      opId: randomUUID(),
      kind: "new_conversation",
      clientIntent: `${r.runId}:new_conversation`,
      payloadSha256: sha256(canonicalJson(s)),
      conversationRef: "pending",
    });
    const conv: ConversationRow = { agentId: s.agentId, issueId: s.issueId, provider: r.provider, cwd: s.cwd, model: s.model, state: "unknown" };
    this.store.conversations.set(key, conv);
    this.advance(op, "push_started", "core");
    let got: { conversationId: string; cwd: string; model?: string };
    try {
      got = await driver.bindConversation(h, s, "new", f);
    } catch (e) {
      this.hold(op, "driver_threw");
      throw new NarError("conversation_unknown", `creation threw: ${(e as Error).message}`);
    }
    for (const c of this.store.conversations.values()) {
      if (c !== conv && c.conversationId === got.conversationId) {
        this.hold(op, "id_collision");
        throw new NarError("foreign_conversation", "provider returned an id bound to another issue");
      }
    }
    if (got.cwd !== s.cwd || got.model !== s.model) {
      this.hold(op, "scope_mismatch");
      throw new NarError("foreign_conversation", "created conversation has foreign cwd/model");
    }
    op.conversationRef = got.conversationId;
    this.advance(op, "emitted_local", "provider_returned_id");
    conv.conversationId = got.conversationId;
    conv.state = "bound";
    r.conversationId = got.conversationId;
    return { conversationId: got.conversationId, mode: "new" };
  }

  // ---- op ledger ----------------------------------------------------------

  private reserveRow(
    r: RunRow,
    o: { opId: string; kind: OpKind; clientIntent: string; payloadSha256: string; conversationRef: string },
  ): OpRow {
    const op: OpRow = {
      ...o,
      runId: r.runId,
      hostRef: this.hostRef(r),
      state: "reserved",
      held: false,
      hostEpoch: r.hostEpoch,
      leaseGeneration: r.leaseGeneration,
      evidence: [{ rung: "reserved", source: "core", at: this.iso() }],
    };
    this.store.ops.set(op.opId, op);
    this.event("nar.op_state", { state: "reserved", source: "core" }, r.runId, op.opId);
    return op;
  }

  /** Step 1: durable intent. Idempotent on (op_id, digest); refuses duplicate intent (R-N5). */
  reserve(driver: ProviderDriver, d: DispatchInput, f: Fence, controller: string): DispatchResult {
    const digest = sha256(d.text);
    const prior = this.store.ops.get(d.opId);
    if (prior) {
      if (prior.runId === f.runId && prior.payloadSha256 === digest && prior.clientIntent === d.clientIntent) {
        return { op: prior, transportInvoked: false };
      }
      throw new NarError("identity_conflict", d.opId);
    }
    const r = this.checkFence(f, controller);
    for (const o of this.store.ops.values()) {
      if (o.runId === r.runId && o.clientIntent === d.clientIntent && o.state !== "rejected") {
        throw new NarError("duplicate_intent", d.clientIntent);
      }
    }
    if (!r.conversationId) throw new NarError("conversation_unknown", "no bound conversation for run");
    const op = this.reserveRow(r, {
      opId: d.opId,
      kind: d.kind,
      clientIntent: d.clientIntent,
      payloadSha256: digest,
      conversationRef: r.conversationId,
    });
    if (!isDispatchEligible(driver.capabilities())) {
      this.advance(op, "rejected", "driver_degraded");
      throw new NarError("driver_degraded", driver.capabilities().provider);
    }
    return { op, transportInvoked: false };
  }

  /** Step 2: durable mark immediately before the transport boundary. */
  pushStarted(opId: string, f: Fence, controller: string): OpRow {
    const op = this.store.ops.get(opId);
    if (!op || op.state !== "reserved") throw new NarError("invalid_transition", `push_started from ${op?.state}`);
    this.checkFence(f, controller);
    this.advance(op, "push_started", "core");
    return op;
  }

  /** Step 3: the single transport call. Never retried; any ambiguity is unknown + hold. */
  async transmit(driver: ProviderDriver, h: HostHandle, opId: string, text: string, f: Fence): Promise<OpRow> {
    const op = this.store.ops.get(opId);
    if (!op || op.state !== "push_started") throw new NarError("invalid_transition", `transmit from ${op?.state}`);
    if (sha256(text) !== op.payloadSha256) throw new NarError("identity_conflict", "payload digest changed");
    try {
      const res = await driver.submit(
        h,
        op.conversationRef,
        { opId: op.opId, kind: op.kind as "prompt" | "interrupt", payloadSha256: op.payloadSha256, text },
        f,
      );
      if (res.grade === "emitted_local" || res.grade === "accepted_provider") {
        this.advance(op, "emitted_local", `submit:${res.grade}`);
      } else {
        this.hold(op, `submit:${res.grade}`);
      }
    } catch {
      this.hold(op, "submit_threw");
    }
    return op;
  }

  async dispatch(
    driver: ProviderDriver,
    h: HostHandle,
    d: DispatchInput,
    f: Fence,
    controller: string,
  ): Promise<DispatchResult> {
    const res = this.reserve(driver, d, f, controller);
    if (res.op.state !== "reserved") return res; // stored state, transport not invoked
    this.pushStarted(d.opId, f, controller);
    const op = await this.transmit(driver, h, d.opId, d.text, f);
    return { op, transportInvoked: true };
  }

  /** Provider-side observation bound to an op (hook, transcript entry, provider event). */
  observeHook(o: { opId: string; conversationId: string; hostEpoch: number; source: string }): OpRow {
    const op = this.store.ops.get(o.opId);
    if (!op || op.conversationRef !== o.conversationId || op.hostEpoch !== o.hostEpoch) {
      throw new NarError("foreign_conversation", "hook does not match op conversation/epoch");
    }
    if (op.state === "push_started" || op.state === "emitted_local") {
      this.advance(op, "hook_observed", o.source);
    } else if (op.state === "unknown") {
      // Evidence only: unknown is left only by a Receipt or board reconciliation.
      op.evidence.push({ rung: "hook_observed", source: o.source, at: this.iso() });
    }
    return op;
  }

  // ---- recovery: reattach, settle from the ledger, never resend -----------

  async recover(driver: ProviderDriver, runId: string): Promise<{ host: HostHandle; ops: OpRow[] }> {
    const r = this.run(runId);
    const host = await driver.attestHost(r.agentId); // no create: attach to EXISTING host only
    const ops = [...this.store.ops.values()].filter((o) => o.runId === runId);
    const epochChanged = host.hostEpoch !== r.hostEpoch;
    for (const op of ops) {
      if (op.state === "reserved") {
        this.advance(op, "rejected", "recovery:transport_not_invoked");
        continue;
      }
      if (op.state === "terminal" || op.state === "rejected" || op.state === "interrupted") continue;
      if (epochChanged) {
        this.hold(op, "recovery:host_epoch_changed");
        continue;
      }
      if (op.kind === "new_conversation") {
        if (op.state === "push_started") this.hold(op, "recovery:creation_unknown");
        continue;
      }
      const seen = await driver.readOutcome(op.conversationRef, op.opId);
      if (op.state === "unknown") {
        op.evidence.push({ rung: "unknown", source: `recovery:read:${seen}`, at: this.iso() });
        op.held = true;
        continue;
      }
      if (seen === "unknown") this.hold(op, "recovery:read_unknown");
      else if (op.state !== "hook_observed") this.advance(op, "hook_observed", `recovery:read:${seen}`);
    }
    if (epochChanged) this.event("nar.host_epoch_changed", { from: r.hostEpoch, to: host.hostEpoch }, runId);
    this.event("nar.recovered", { ops: ops.length }, runId);
    return { host, ops };
  }

  // ---- receipts: the only path to a terminal run (R-N3) ------------------

  applyReceipt(i: ReceiptInput): { receipt: ReceiptRow; duplicate: boolean } {
    const op = this.store.ops.get(i.opId);
    if (!op) throw new NarError("receipt_fence", "unknown op");
    const digest = sha256(canonicalJson(i.payload));
    for (const rc of this.store.receipts.values()) {
      if (rc.runId !== i.runId && rc.opId !== i.opId) continue;
      if (rc.opId === i.opId && rc.kind === i.kind && rc.payloadSha256 === digest && rc.runId === i.runId) {
        return { receipt: rc, duplicate: true };
      }
      if (i.toolCallId && rc.toolCallId === i.toolCallId && rc.opId === i.opId) {
        throw new NarError("identity_conflict", "tool_call_id reused with different payload");
      }
      throw new NarError("terminal_exists", rc.runId);
    }
    const r = this.store.runs.get(i.runId);
    if (
      !r ||
      op.runId !== i.runId ||
      r.issueId !== i.issueId ||
      op.conversationRef !== i.conversationId ||
      op.hostEpoch !== i.hostEpoch ||
      op.leaseGeneration !== i.leaseGeneration ||
      (op.kind !== "prompt" && op.kind !== "interrupt") ||
      !["push_started", "emitted_local", "hook_observed", "unknown"].includes(op.state)
    ) {
      this.event("nar.receipt_rejected", { code: "receipt_fence" }, i.runId, i.opId);
      throw new NarError("receipt_fence");
    }
    const live = r.status === "running" && this.now() < r.leaseExpiresAt;
    if (
      this.store.issueGeneration.get(r.issueId) !== r.leaseGeneration ||
      r.controller !== i.controller ||
      !(live || r.status === "held")
    ) {
      this.event("nar.receipt_rejected", { code: "authority_lost" }, i.runId, i.opId);
      throw new NarError("authority_lost", "receipt from a run without authority");
    }
    const p = i.payload as Record<string, unknown> | null;
    const field = i.kind === "finish" ? "summary" : "reason";
    if (!p || typeof p !== "object" || Array.isArray(p) || typeof p[field] !== "string" || !(p[field] as string).trim()) {
      this.event("nar.receipt_rejected", { code: "receipt_invalid" }, i.runId, i.opId);
      throw new NarError("receipt_invalid", `${i.kind} requires non-empty ${field}`);
    }
    const receipt: ReceiptRow = {
      id: randomUUID(),
      opId: i.opId,
      runId: i.runId,
      issueId: i.issueId,
      channel: i.channel,
      kind: i.kind,
      payloadSha256: digest,
      payload: p,
      toolCallId: i.toolCallId,
      hostEpoch: i.hostEpoch,
      leaseGeneration: i.leaseGeneration,
      state: "applied",
    };
    this.store.receipts.set(receipt.id, receipt);
    this.advance(op, "terminal", `receipt:${i.channel}:${i.kind}`);
    op.held = false;
    r.status = i.kind === "finish" ? "done" : "blocked";
    this.store.issueStatus.set(r.issueId, i.kind === "finish" ? "done" : "blocked");
    return { receipt, duplicate: false };
  }

  /** Stop, idle, phone reply and transport success are observations only (R-N3, U8). */
  signal(runId: string, kind: "stop" | "idle" | "phone_reply" | "transport_success"): RunStatus {
    const r = this.run(runId);
    this.event("nar.signal", { kind }, runId);
    return r.status;
  }

  /** Owner steering is competing activity: digest + length only, never an op (U11). */
  recordOwnerInput(runId: string, text: string): void {
    this.run(runId);
    this.event("nar.owner_input", { sha256: sha256(text), length: text.length }, runId);
  }
}
