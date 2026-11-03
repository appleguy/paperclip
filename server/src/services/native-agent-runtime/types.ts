/**
 * Paperclip Native Agent Runtime (NAR) v0.2 - section 3 driver contract.
 *
 * Transport-neutral ProviderDriver interface plus the op/receipt types from
 * section 2.1/2.3. Copied from doc/spec/native-agent-runtime.md at 6d9a992f0.
 *
 * Design only: nothing here wires an executor, opens a transport or writes
 * Paperclip state. A driver owns provider transport only (section 3.1); Core
 * owns leases, fences, the op ledger and receipt validation.
 */

export type Provider = "claude" | "agy" | "opencode" | "codex";
export type Grade = "queued_local" | "emitted_local" | "accepted_provider" | "outcome_unknown";
export type Proof = "PROVEN-LIVE" | "SHIPPED-UNPROVEN" | "UNSUPPORTED" | "OPEN";

export interface Capabilities {
  provider: Provider;
  inputKind: "mcp_channel" | "http_api" | "rpc" | "pane_text";
  ackGrade: Grade; // strongest grade submit() can honestly return
  receiptKinds: ("mcp_tool" | "file" | "provider_event")[];
  ownerPhone: { path: string; proof: Proof };
  permission: { route: "channel_relay" | "provider_policy" | "none"; proof: Proof };
  resume: { byId: boolean; proof: Proof };
  interrupt: { scoped: boolean; proof: Proof };
  needsPane: boolean; // true => HerdrHost layer (section 6)
  observeCoverage: "complete" | "incomplete"; // driver must say incomplete when true
}

export interface HostHandle {
  provider: Provider;
  hostEpoch: number;
  attested: boolean;
  detail: unknown;
}

export interface ConvScope {
  agentId: string;
  issueId: string;
  cwd: string;
  model?: string;
  /** Human-readable conversation title; drivers may apply it on create and when resuming. */
  title?: string;
}

export interface Fence {
  runId: string;
  leaseGeneration: number;
  hostEpoch: number;
}

export interface Op {
  opId: string;
  kind: "prompt" | "interrupt";
  payloadSha256: string;
  text?: string;
}

export interface SubmitResult {
  grade: Grade;
  evidence: string;
  at: string;
}

export interface ObserveEvent {
  cursor: string;
  kind: string;
  opId?: string;
  raw: unknown;
}

export interface ProviderDriver {
  capabilities(): Capabilities;
  // Attach to or re-attest an EXISTING host. Creating one needs an explicit admission flag.
  attestHost(agentId: string, opts?: { create?: boolean }): Promise<HostHandle>;
  // Create (new issue) or resume (same issue) a conversation; verify id + cwd + model.
  bindConversation(
    h: HostHandle,
    s: ConvScope,
    mode: "new" | "resume",
    f: Fence,
  ): Promise<{ conversationId: string }>;
  // The ONLY transport-specific send. Core records push_started first; driver never retries.
  submit(h: HostHandle, conversationId: string, op: Op, f: Fence): Promise<SubmitResult>;
  observe(
    conversationId: string,
    cursor?: string,
  ): Promise<{ events: ObserveEvent[]; next: string; coverage: "complete" | "incomplete" }>;
  readOutcome(
    conversationId: string,
    opId: string,
  ): Promise<"receipted" | "hook_observed" | "working" | "unknown">;
  interrupt?(conversationId: string, op: Op, f: Fence): Promise<"requested" | "uncertain">; // only when scoped and verified
  // Optional extensions, never forced on a provider:
  relayPermission?(req: PermissionRequest, decision: PermissionDecision): Promise<void>;
}

export interface PermissionRequest {
  requestId: string;
  tool: string;
  inputDigest: string;
  opId?: string;
  hostEpoch: number;
}

export type PermissionDecision = { behavior: "allow" | "deny"; reason: string };

/**
 * Section 2.1/2.3: a Receipt is validated terminal evidence for one run.
 * Zero or one per run; finish OR block, never both. The identity fields are
 * the fence carried by every Core write, so a stale, foreign or partial receipt
 * can be rejected before it becomes a terminal.
 */
export type ReceiptKind = "finish" | "block";

export interface Receipt {
  receiptId: string;
  kind: ReceiptKind;
  runId: string;
  issueId: string;
  conversationId: string;
  opId: string;
  hostEpoch: number;
  leaseGeneration: number;
  controllerId: string;
  payloadSha256: string;
  at: string;
  /** finish: the Paperclip-validated result body. */
  result?: unknown;
  /** block: the human-readable blocker. */
  reason?: string;
}

/** Section 2.3 evidence rungs plus explicit side states. */
export type OpState =
  | "reserved"
  | "push_started"
  | "emitted_local"
  | "hook_observed"
  | "terminal"
  | "rejected"
  | "unknown"
  | "interrupted";

export const OP_STATE_ORDER: readonly OpState[] = [
  "reserved",
  "push_started",
  "emitted_local",
  "hook_observed",
  "terminal",
];

export const GRADE_ORDER: Record<Grade, number> = {
  outcome_unknown: 0,
  queued_local: 1,
  emitted_local: 2,
  accepted_provider: 3,
};
