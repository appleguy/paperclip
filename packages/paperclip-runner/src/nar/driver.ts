// Native Agent Runtime (NAR) provider-driver interface.
// Source of truth: doc/spec/native-agent-runtime.md section 3.2 (v0.2).
// A driver owns only provider transport. It never writes Paperclip state,
// never holds run-scoped Paperclip tokens and never retries an ambiguous send.

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
  needsPane: boolean; // true => HerdrHost layer (spec section 6)
  observeCoverage: "complete" | "incomplete";
}

// detail is driver-private and may hold transport secrets: Core never persists it.
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
export type OutcomeRead = "receipted" | "hook_observed" | "working" | "unknown";

export interface PermissionRequest {
  requestId: string;
  tool: string;
  inputDigest: string;
  opId?: string;
  hostEpoch: number;
}
export type PermissionDecision = { behavior: "allow" | "deny"; reason: string };

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
    existingId?: string,
  ): Promise<{ conversationId: string; cwd: string; model?: string }>;
  // The ONLY transport-specific send. Core records push_started first; driver never retries.
  submit(h: HostHandle, conversationId: string, op: Op, f: Fence): Promise<SubmitResult>;
  observe(
    conversationId: string,
    cursor?: string,
  ): Promise<{ events: ObserveEvent[]; next: string; coverage: "complete" | "incomplete" }>;
  readOutcome(conversationId: string, opId: string): Promise<OutcomeRead>;
  interrupt?(conversationId: string, op: Op, f: Fence): Promise<"requested" | "uncertain">;
  relayPermission?(req: PermissionRequest, decision: PermissionDecision): Promise<void>;
}
