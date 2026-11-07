# Paperclip Native Agent Runtime (NAR) - specification v0.3

Status: REVISED DRAFT for owner review, except the dated c31 standalone Codex slice below. Other sections remain design only and are not a deployment or security-acceptance claim.
Date: 2026-11-03. Supersedes v0.1 (836 lines).
Scope: Claude Code, agy, OpenCode (local lanes: WRX80 DeepSeek :19402, Mac GLM :19403) and Codex. ChatGPT Web is manual Chat-mode copy/paste only and is outside the runtime.

## c31 implementation slice — standalone Codex (2026-11-06 local / 2026-11-07 UTC)

This narrow slice is implemented in `packages/paperclip-runner`; the rest of v0.3 remains a draft. It runs a single direct Codex turn with the existing NAR `CodexAppServerDriver`, without a Paperclip server, database, dispatch, or control-plane credentials. The source-checkout entrypoint is `packages/paperclip-runner/scripts/run-standalone-codex.mjs` (Node 24.11+ and workspace development dependencies). Its resolver prefers tracked TypeScript over generated JavaScript siblings.

```sh
node packages/paperclip-runner/scripts/run-standalone-codex.mjs \
  --codex-home /absolute/existing/codex-home --cwd /absolute/workspace \
  --model <model-id> --effort <effort> --sandbox read-only \
  --prompt 'Your exact user prompt' --receipt-dir /absolute/new/receipt-directory
```

`--inspect` is read-only: it reports effective model/effort (falling back to the provider's declared default model), configured MCP server names, and RC status. It never prints full configuration, credential values, URLs, or MCP environment values. `--timeout-ms` bounds the observation period; timeout or disconnect detaches only this client, retains durable identity, and never retries or interrupts a provider turn.

### Admission and context

- The existing transport remains exact-resume-only by default. Explicit `newThread: true` admits one fresh thread, binds the provider-returned thread ID and exact workspace, and refuses a second create attempt. It never invents a persisted identity.
- Before each `thread/start` and `turn/start`, the same live WebSocket must return `remoteControl/status/read.status = "connected"`. Socket identity is checked on every admitted operation. A missing socket, changed socket generation, failed status RPC, or other RC state fails closed for this client.
- This is client admission, with a check/send race; it is not an atomic Codex server policy and cannot fence a different client or absolute binary execution. A running turn is not interrupted if RC later disconnects.
- The direct request has empty base/developer instructions, no Paperclip task envelope, completion contract, dynamic tools, or output schema. Skills/app/collaboration instructions, apps/plugins/memories/multi-agent/image generation, ordinary configurable hooks, project-document bytes, and web search are disabled per thread. Built-in executor hooks are separate native behavior.
- Effective configuration is read for the exact workspace; each configured MCP name receives an explicit disabled override. Configuration contents are never retained. The standalone path does not write any Codex configuration.
- Native sandbox policy is selected explicitly and verified against the provider response before a turn. Private NAR permission-profile names are not sent to an existing daemon. The lane launcher preserves its previously authorized `danger-full-access` mode; the canary used `read-only`.
- The local receipt captures the actual outgoing RPC parameters plus selected responses, not provider-bound model bytes. Stock provider/system behavior and full zero-context at the model boundary remain **unverified** without provider-bound capture.

### Evidence and limits

The focused regression `opens a standalone direct session only with RC and refuses a disconnected next turn` failed before the change with `shared daemon requires matching persisted session`. After the change, all 16 shared-daemon transport tests passed, including the existing exact-resume and foreign-thread cases.

The one live canary on the existing zero-home daemon 0.167.0 returned `C31_NAR_RC_OK`. Thread `01a1b454-63f2-76b3-a274-53aa3563d2b0`, turn `01a1b454-6471-76e3-b0ea-c28476ab1bdc`, completed; RC was connected before both starts, and that daemon's `thread/list` contained the thread. Native `thread/read(includeTurns:true)` contained exactly one user message and one agent message, with no tool items. Receipts, pre-turn identity, and native transcript are in `/Volumes/NVM/AI_Agent_Runtime/tmp/c31/nar/canary/`. The initial optional transcript helper was absent; this was caught during artifact verification and corrected to exact native thread/read, without another model turn.

A credential-free disposable 0.167.0 server with RC `disabled` refused standalone NAR before any `thread/start` or `turn/start` (both counts zero), exit 1: `Remote Control not connected; standalone start refused`. The standalone command and the real lane launcher each passed this live negative probe. Evidence: `/Volumes/NVM/AI_Agent_Runtime/tmp/c31/nar-nonrc/result.json` and `/Volumes/NVM/AI_Agent_Runtime/tmp/c31/nar-nonrc-lane/result.json`. Only the two disposable servers were closed, cleanly by EOF. The final `features.hooks=false` flag was added after the canary based on pinned source review and the focused regression; that added flag is **not live-turn-tested**.

The external `lanes/run-codex.sh` now invokes this one-turn NAR path for subsequent launches. Existing sessions are untouched. The owner's phone visibility and full provider-bound first-turn input are **unverified**; a connected daemon and thread-list presence do not substitute for the owner's phone observation.

This does not globally replace every Codex start. The Paperclip native backend still accepts an optional transport factory and otherwise starts its own process transport. The codex-local legacy `execute.ts`/ACP paths and `quota.ts` app-server probe are unchanged while Paperclip remains paused. Global enforcement and adoption remain open.

Rollback: restore the c31 runner/spec commit's listed paths from its parent; restore the external launcher with `cp -p /Volumes/NVM/Paperclip/workspaces/platform-lead-outside/lanes/run-codex.sh.before-20261106-c31 /Volumes/NVM/Paperclip/workspaces/platform-lead-outside/lanes/run-codex.sh`. This does not close or delete the completed canary thread.

## Changelog v0.3 (owner, 2026-11-03)

1. Done bar is co-presence (owner amendment): Paperclip drives a real native session while the owner's phone (Remote Control) and TUI stay attached and live on the same session with one history; restarts rejoin and never replay.
2. ACP core plus draft RFD #533 "Multi-Client Session Attach" adopted as the naming and semantics for the driver surface and Paperclip's co-presence layer, matched as closely as the draft allows (new section 3.4).
3. Steering-race, arbitration and dedupe conformance (U11, C6) moved out of scope; they stay listed for history only.

## Changelog vs v0.1

1. Core is transport-neutral. The universal "type text into a Herdr pane" `submitTurn/written` contract is replaced by `submit(op, fence)` returning an evidence grade (section 3).
2. Claude driver rebuilt around the proven-live MCP channel (interactive Remote Control + `notifications/claude/channel`), not keystroke injection (section 4).
3. Op state machine reduced to five evidence rungs; "lost" is never inferred from absence; automatic retry flag O-N9 is OFF (section 2.3).
4. Dedicated permission/approval subsection with a single decision owner and CAS (section 5).
5. Storage shrunk: reuse existing tables; add only `native_ops` and `native_receipts`. `native_agent_hosts`, `native_conversations`, `native_owner_inputs` are deferred (section 7).
6. Capability matrix made truthful per provider; agy is "legacy/pane transport, structured input OPEN"; Herdr is required only where a pane is needed (sections 3.3, 6).
7. Same-UID isolation downgraded from design goal to an honest residual risk; Seatbelt/Keychain/PID-microsecond work removed from v1 and listed as an optional hardening track (section 9).
8. Conformance suite split into universal vs transport-capability tests, plus six new tests from the review (section 8).
9. Big-bang cleanup and the one-week zero-hold gate replaced by per-agent feature flags with rollback; old lanes are deleted only after a measured side-by-side gate (section 10).
10. HerdrHost folded in as one host layer (Claude, agy), with its gaps; OpenCode and Codex do not require Herdr and their healthy services are not relocated (section 6).

## 0. Conventions

Evidence grades attached to claims:
- **[L]** PROVEN-LIVE: observed in a live probe on the owner's machine (Claude channel probe, 2026-11-02; logs cited in section 13).
- **[V]** VERIFIED: read in code, or observed by a read-only command, by a research pass. Code is a dirty live checkout; this is not a claim about the deployed build.
- **[D]** FROM-DOC: stated in a document or changelog, not exercised.
- **[I]** INFERRED: design reasoning, not exercised.

Capability status (matrix only): **PROVEN-LIVE**, **SHIPPED-UNPROVEN** (code exists, not shown to work end to end), **UNSUPPORTED**, **OPEN** (unknown; needs an experiment).

Evidence boundary for the Claude channel [L]: the probe proves that a Claude Code 2.1.309 channel notification enters an interactive Remote Control session, is seen by the UserPromptSubmit hook, and leads to an MCP tool reply; that `--resume` keeps URL, history and channels across two restarts; and that permission relay works in both directions. It does NOT prove durable exactly-once delivery, authentic origin of hook text, Paperclip completion, behaviour of the experimental flag in future versions, or the phone-versus-channel approval race.

Abbreviated source paths (under `/Volumes/NVM/Paperclip/master`): NR = `server/src/services/native-runtime`; CL = `packages/paperclip-runner/src/drivers/claude`; AGY = `server/src/adapters/agy/execute.ts`.

## 1. Goals, fixed decisions, non-goals

### 1.1 Fixed owner decisions (not reopened here)
D1. One persistent Herdr-hosted session per Paperclip agent where a pane is needed.
D2. A NEW provider conversation per issue. Restart RESUMES that conversation and never replays a prompt.
D3. Everything runs under macOS user `tech`.
D4. One provider-driver interface and one conformance suite.
D5. No paid services. Codex work waits for a usage reset.
D6. ChatGPT Web is manual copy/paste only.

Recorded concern (review edit #6, kept as risk R1, section 11): for Claude, a per-issue conversation in a persistent per-agent host means relaunching or clearing inside the pane; the review preferred serial issues in one per-agent session. D2 stands; the cost is the OPEN questions Q1 and Q2.

### 1.2 Goals
G1. One runtime, one driver interface; adding a provider touches only its driver.
G2. No replay, ever: ambiguous sends are held, not resent (section 2.3).
G3. One writer per conversation via leases and fences.
G4. One completion contract: a Paperclip-validated `finish` or `block` result, one terminal per run.
G5. Owner steering from the phone through the vendor surface; Paperclip observes, never relays.
G6. Smaller than v0.1: reuse existing tables, recovery and Board machinery.

### 1.3 Non-goals
N1. ChatGPT Web. N2. Drivers outside the four (they stay on the old path). N3. Remote/sandbox execution targets. N4. A new phone UI. N5. Relaying owner input. N6. Guaranteed same-UID process isolation (section 9). N7. Availability before GUI login after reboot (Keychain/TCC limits [D]).

## 2. Entities and the minimal state machine

### 2.1 Entities

| Entity | Definition | Key |
|---|---|---|
| Agent | Existing `agents` row with one provider. | 1 |
| Host | The long-lived provider endpoint for an agent: a Herdr pane process (Claude, agy), an `opencode serve` endpoint, or a shared Codex daemon. Not necessarily one process or pane per agent for OpenCode/Codex. | 1 logical per agent |
| Conversation | Provider-native session for ONE issue (Claude session uuid; agy conversation id; OpenCode `ses_...`; Codex thread id). | unique(agent, issue) |
| Run | One Paperclip execution attempt (`heartbeat_runs`), at most one `running` per conversation. | many |
| Op | A durable, idempotency-keyed work-causing effect: `prompt`, `resume`, `interrupt`, `new_conversation`. Safe reads (attest, discover, list) are NOT ops. | full random UUID |
| Receipt | Validated terminal evidence for an op: `finish` or `block`. | 0..1 per run |
| Lease / fence | Existing run lease (`native_run_finalizations`) with controller identity and generation; every write carries the fence. | 1 per run |

Identity: the conversation id is minted by Paperclip before the provider call and persisted first (Claude: fresh uuid per issue; OpenCode: client-chosen `ses_` id; agy/Codex: provider-assigned, persisted from the first verified read) [V]. A run may change its native session id only while it is an unused bootstrap [V].

### 2.2 Host/conversation states
Reused from existing code rather than re-specified: host `ready | degraded | dead` is derived from attestation (section 6.2); conversation `open | foreign | unknown_open` follows existing OpenCode semantics (`opencode_creation_outcome_unknown`, never retried) [V]. No `parked` state: with one conversation per issue, a conversation is resumed only for the same issue. A relaunch after process death is a new host epoch, never a direct `dead -> ready`.

### 2.3 Op evidence ladder (the minimal state machine)

States are monotonic evidence rungs, each with source and timestamp:

```
reserved      Core DB intent: full op_id, payload digest, run/issue/conversation/host epoch, lease generation.
              Transport NOT invoked. Only here may the same intent be rescheduled as a NEW op.
push_started  Durable mark written immediately BEFORE crossing the transport boundary.
              Crash or timeout from here is UNKNOWN. It does not certify bytes left the process.
emitted_local Driver observed its own write (channel JSON-RPC write, HTTP 2xx accepted, RPC response, terminal write ack).
              Means "attempted", NOT "the provider received it".
hook_observed Provider-side observation bound to the op: UserPromptSubmit with channel source + op_id (+ prompt_id),
              transcript entry, or provider event. Means the prompt entered the lifecycle, not that work ran or finished.
terminal      Validated Receipt (finish|block) applied once, or board reconciliation recorded.
```

Side states: `rejected` (reserved -> rejected; provably nothing sent), `unknown` (anything from push_started on without a terminal; left only by a late Receipt or board reconciliation), `interrupted`.

Rules:
- R-N1. NEVER infer "lost" or "not delivered" from an absent hook, transcript gap or idle screen. Absence is `unknown`. Hold; do not resend the same op_id. [I, from review A2]
- R-N2. Automatic retry after absent marker (draft flag O-N9) is OFF by default; it may be enabled per provider only after transcript completeness is demonstrated (Q8).
- R-N3. A successful send, a hook, a Stop event, a phone reply, or Herdr `idle/done` never completes a run. Only a validated Receipt does.
- R-N4. "Exactly once" is split: at-most-once automatic push attempt per op_id, plus exactly-once Receipt application under unique keys. Exactly-once ingestion into the model is NOT achievable: MCP notifications have no acknowledgment and no receiver-side dedupe [L: probe pushes carry no response; V: review].
- R-N5. Idempotency keys: unique(op_id); unique(run, client_intent); immutable payload digest. Same op_id + same digest returns the stored state without re-effect; different digest returns `identity_conflict`. Tool calls additionally unique(run, op_id, tool_call_id). One terminal (finish OR block) per run, enforced in the same transaction as receipt validation. A stale run's op_id cannot settle a successor's work.
- R-N6. Apply the no-replay hold only to work-causing ambiguity (prompts, interrupts, conversation creation). Read-only attest/discover calls are freely retried.

Run states map onto existing `heartbeat_runs.status`; `held` is `failed|interrupted` plus an open `issue_recovery_actions` row (existing Board reconciliation; no new approval queue) [V].

Crash windows and required outcome:

| Crash point | Outcome |
|---|---|
| Only `reserved` persisted, transport provably not invoked | `rejected`; a NEW op may be scheduled. |
| Between channel inbox dequeue and stdout write, or after write before log | `unknown`; not safely retryable. |
| After `emitted_local`, before any hook | `unknown`; hold, inspect transcript/receipt on recovery, never resend the old op_id. |
| After `hook_observed`, before tool/finish | Accepted, outcome uncertain; wait while busy, accept a late correlated Receipt. Idle/Stop with no Receipt is a hold. |
| Tool accepted, before Core commit | Idempotent completion transaction from a durable reservation; query the journal, do not trust a model retry. |

## 3. Provider driver interface

### 3.1 Layering
Core owns: leases and fences, op ledger, receipt validation, recovery, Board integration. A driver owns only provider transport. A driver never writes Paperclip state, never holds run-scoped Paperclip tokens, and never retries an ambiguous send.

### 3.2 TypeScript interface (transport-neutral)

```ts
type Provider = "claude" | "agy" | "opencode" | "codex";
type Grade = "queued_local" | "emitted_local" | "accepted_provider" | "outcome_unknown";
type Proof = "PROVEN-LIVE" | "SHIPPED-UNPROVEN" | "UNSUPPORTED" | "OPEN";

interface Capabilities {
  provider: Provider;
  inputKind: "mcp_channel" | "http_api" | "rpc" | "pane_text";
  ackGrade: Grade;                 // strongest grade submit() can honestly return
  receiptKinds: ("mcp_tool" | "file" | "provider_event")[];
  ownerPhone: { path: string; proof: Proof };
  permission: { route: "channel_relay" | "provider_policy" | "none"; proof: Proof };
  resume: { byId: boolean; proof: Proof };
  interrupt: { scoped: boolean; proof: Proof };
  needsPane: boolean;              // true => HerdrHost layer (section 6)
  observeCoverage: "complete" | "incomplete"; // driver must say incomplete when true
}

interface HostHandle { provider: Provider; hostEpoch: number; attested: boolean; detail: unknown }
interface ConvScope { agentId: string; issueId: string; cwd: string; model?: string }
interface Fence { runId: string; leaseGeneration: number; hostEpoch: number }
interface Op { opId: string; kind: "prompt" | "interrupt"; payloadSha256: string; text?: string }
interface SubmitResult { grade: Grade; evidence: string; at: string }
interface ObserveEvent { cursor: string; kind: string; opId?: string; raw: unknown }

interface ProviderDriver {
  capabilities(): Capabilities;
  // Attach to or re-attest an EXISTING host. Creating one needs an explicit admission flag.
  attestHost(agentId: string, opts?: { create?: boolean }): Promise<HostHandle>;
  // Create (new issue) or resume (same issue) a conversation; verify id + cwd + model.
  bindConversation(h: HostHandle, s: ConvScope, mode: "new" | "resume", f: Fence): Promise<{ conversationId: string }>;
  // The ONLY transport-specific send. Core records push_started first; driver never retries.
  submit(h: HostHandle, conversationId: string, op: Op, f: Fence): Promise<SubmitResult>;
  observe(conversationId: string, cursor?: string): Promise<{ events: ObserveEvent[]; next: string; coverage: "complete" | "incomplete" }>;
  readOutcome(conversationId: string, opId: string): Promise<"receipted" | "hook_observed" | "working" | "unknown">;
  interrupt?(conversationId: string, op: Op, f: Fence): Promise<"requested" | "uncertain">; // only when scoped and verified
  // Optional extensions, never forced on a provider:
  relayPermission?(req: PermissionRequest, decision: PermissionDecision): Promise<void>;
}
interface PermissionRequest { requestId: string; tool: string; inputDigest: string; opId?: string; hostEpoch: number }
type PermissionDecision = { behavior: "allow" | "deny"; reason: string };
```

Contract notes [I]: `submit` never returns a universal `written: true`; the grade names what was actually observed. Lease checks live in Core; peer/host attestation stays at the specific RPC boundary. A driver that cannot return a grade stronger than `queued_local` is marked degraded and is not eligible for automated dispatch.

### 3.3 Capability matrix

| | Claude Code 2.1.309 | agy 1.4.x | OpenCode (WRX DeepSeek :19402, Mac GLM :19403) | Codex |
|---|---|---|---|---|
| Transport | MCP channel notification into an interactive Remote Control session; pane only hosts the process | tmux/Herdr pane text paste (legacy transport) | Structured HTTP API: client-chosen `ses_` id, `POST /api/session`, managed prompt via shared host [V] | Shared app-server JSON-RPC: `thread/resume`, `turn/start`; `thread/start` refused in shared transport, separate bootstrap path [V] |
| Input proof | PROVEN-LIVE (push, hook, tool reply) [L] | OPEN: no verified structured push into a running RC session; changelog silent [D] | SHIPPED-UNPROVEN [V] | SHIPPED-UNPROVEN [V]; official ACP adapter with `_session/steering` exists [D] |
| Owner-phone path | PROVEN-LIVE: same Remote Control URL/history, phone text reaches the same session [L] | PROVEN in prior notes (Remote Control URL) [D]; steering is plain pane input | OPEN: Herdr/Moshi pane generic only | OPEN: iPhone thread visibility unverified [D] |
| Permission path | PROVEN-LIVE channel relay allow/deny [L]; phone-vs-channel race OPEN | UNSUPPORTED structured (adapter runs permission bypass) [V] | OPEN | SHIPPED-UNPROVEN: policy fixed to never-ask by admission [V] |
| Resume | PROVEN-LIVE `--resume <uuid>` keeps URL, history, channels across 2 restarts [L] | OPEN after pane death; `--conversation` per prior notes [D] | SHIPPED-UNPROVEN: session survives in server DB; verify by id [V] | SHIPPED-UNPROVEN: `thread/resume` exact thread [V] |
| New conversation in live host | OPEN (relaunch with new `--session-id`; RC URL for a new id unproven, Q1) | PROVEN `/new` verified by id read [V] | SHIPPED-UNPROVEN | SHIPPED-UNPROVEN (bootstrap path) |
| Receipt | MCP finish/block tool (probe `pc_reply` proves plumbing only; production schema exists in code) [L/V] | File receipt, adopted after restart [V]; no structured block | MCP bridge + durable event log with cursor [V] | PRP authorized tools + JSON-RPC notifications [V] |
| Needs Herdr pane | Yes | Yes | No | No |
| Overall status | PROVEN-LIVE (input, resume, permission relay); SHIPPED-UNPROVEN (production completion via persistent bridge) | LEGACY pane transport; structured input OPEN | SHIPPED-UNPROVEN | SHIPPED-UNPROVEN; blocked by usage reset (D5) |

Rules that follow: agy's screen/paste path is never marked equivalent to a structured transport; it is "legacy, degraded" until a real inbound interface is shown (candidate evidence: agy 1.4.11 `finished_reason` in stream-json for headless runs, 1.4.7 hook `lastUserInput`, 1.4.4 MCP `_meta` root conversation id [D]; none gives push into a running RC session). ACP v2 draft insertion/`messageId` and `state_update` semantics [D] are cited as a compatible receipt model, not a dependency. OpenCode phone steering and Codex thread visibility are not proven by a Herdr screenshot.

### 3.4 ACP alignment (ACP core + draft RFD #533 multi-client attach)

Decision (owner, 2026-11-03): adopt ACP method names and the draft RFD #533 attach model wherever they fit, so a future ACP-native agent or client plugs in without a translation layer. Tracked source: agentclientprotocol RFD PR #533 (opened 2026-02-18, draft, approved by one maintainer 2026-03-06, not merged as of 2026-11-03), with Message ID RFD #536 for `afterMessageId`. If the merged text diverges, follow the merged text and record the delta here.

Roles. Paperclip is the multiplexer: it holds the one upstream session per conversation and is the only party that talks to the provider driver. Paperclip's own run executor is an attached client. Vendor-native surfaces (Claude Remote Control and TUI, agy TUI/RC, OpenCode TUI/web, Codex TUI) do not speak ACP; they are external co-present clients attached through the vendor's own mechanism and are reported in `connectedClients` with `clientInfo.name` set to the vendor surface and `external: true` (Paperclip extension).

Driver mapping (section 3.2 names stay as the TypeScript surface; the wire and docs use ACP names):

| NAR driver call | ACP method / notification |
|---|---|
| `bindConversation(mode=new)` | `session/new` |
| `bindConversation(mode=resume)` | `session/load` |
| `submit(op)` | `session/prompt` (op_id carried as the prompt's message id, RFD #536) |
| `observe(cursor)` | `session/update` stream |
| `interrupt` | `session/cancel` |
| `relayPermission` | `session/request_permission` |
| `readOutcome(opId)` | `turn_complete` for that message id, else history read |

Co-presence layer (RFD #533 shapes):

- `session/attach {sessionId, clientInfo, clientId?, historyPolicy: full | pending_only | none | after_message, afterMessageId?}` returns `{connectedClients, history}`. Default `full`.
- `session/detach {sessionId, clientId}`.
- Notifications to every attached client: all `session/update` traffic, plus `prompt_received` (echo of a prompt from any client, including owner prompts typed on the phone or TUI when the vendor exposes them), `turn_complete`, `permission_resolved`, `client_disconnected`.
- Permissions: an unresolved `session/request_permission` is re-issued to a newly attaching client; the first valid answer wins; a late answer is discarded and gets `permission_resolved`. This matches Claude's channel permission relay (first valid answer wins) and replaces the CAS arbitration language in section 5 for co-presence purposes.
- Any attached client may prompt (RFD #533 has no role field). Paperclip does not arbitrate between its prompts and the owner's; see the native-copresence rule below.

Restart rejoin is attach. When a Paperclip run restarts, it calls the equivalent of `session/attach` with `historyPolicy: after_message` and `afterMessageId` = the deterministic message id of its last submitted prompt. If that message is in flight or answered, it rejoins and reads the outcome; it never re-sends. This is what the shipped NAR rejoin fix (e2771a59d, `driver.inflightMessage()`) already does for OpenCode and is the contract for every driver.

Per-runtime transport under this model:

| Runtime | Upstream path used by Paperclip | Owner co-presence surface |
|---|---|---|
| OpenCode GLM/DeepSeek | server HTTP API (session/message/event) | OpenCode TUI/web/phone attached to the same server session |
| Claude Code | MCP channel (`notifications/claude/channel`, channel permission relay) | Remote Control and TUI on the same session |
| agy | headless stream-json on the same conversation if it resumes it; else shared input written only when empty or idle 5+ minutes | agy TUI / Remote Control |
| Codex (after 2026-11-05) | one shared app-server; Paperclip is the only client that calls `turn/start` | Codex TUI (read view) on the same app-server thread |

Native-copresence rule: prefer a non-typing path; if Paperclip must write the shared input field, it may do so only when the field is empty or idle 5+ minutes. Steering races, arbitration and dedupe of concurrent owner/Paperclip prompts are out of scope.

Capability discovery: RFD #533 has no capability flag; clients detect support by calling attach and handling an error. Paperclip additionally advertises `agentCapabilities.sessionCapabilities.attach: true` (the acp-mux convention) on its own surface.

## 4. Claude driver (first implementation)

### 4.1 Control plane
- C1. One interactive Claude Code process per agent with native Remote Control, a stable name and fixed cwd, hosted in a Herdr pane (section 6). Launch with `--session-id <fresh uuid>` for a new issue conversation and `--resume <uuid>` for a validated continuation of the same issue. Never headless `-p`/stream-json for the phone-attached lane: it does NOT appear on the phone [L, negative]. `claude remote-control --session-id <local uuid>` cannot reattach [L, negative].
- C2. Input is a per-host **MCP channel server** started with `--strict-mcp-config`, a private MCP config and `--dangerously-load-development-channels server:<name>`, declaring capabilities experimental `claude/channel` and `claude/channel/permission`. Core sends `notifications/claude/channel {content, meta:{op_id}}` [L]. No keystroke injection on the primary path.
- C3. The model replies through MCP tools carrying `op_id`. Production uses the existing structured `paperclip_finish`/`paperclip_block` validator; the probe's free-form `pc_reply` ("recorded") is NOT a completion [L/V].
- C4. Hooks are independent observation signals only: UserPromptSubmit, PostToolUse, Stop, SessionStart. They never complete a run.
- C5. Persistent host means persistent channel and completion ingress, but run authority is resolved dynamically on every tool call: (host epoch, session id, op_id) -> active run/issue/lease checked against the DB. The existing MCP binding captures one run scope at startup and closes with the session, so it cannot be carried into a successor run; use a per-host bridge or an atomic authenticated rebind, and retire old run rights immediately [V].
- C6. Paperclip reaches the already-running channel child through an authenticated, reconnectable local path (a channel-owned Unix socket with process/epoch attestation), backed by the Core intent ledger. The probe's one-second inbox polling and rename-before-send are diagnostic scaffolding, not a crash-safe broker [L/V]. No database credentials or run write grants inside the agent process.

### 4.2 Sequence for one prompt
1. Core: reserve op (section 2.3); verify lease, host epoch, attested process and conversation id.
2. Core: write `push_started`, then call the channel child. The channel child writes the notification and returns `emitted_local`.
3. Hook ingress: normalize UserPromptSubmit; if source is the Paperclip channel and op_id plus prompt_id correlate with the outbound full op_id, content digest, session id, cwd, process generation and current lease, record `hook_observed`. Phone text (plain, no channel tag) is a distinct owner event [L: phone input appeared as plain text "1"; channel input as `<channel source="...">`].
4. Model calls finish/block; the bridge resolves op -> run -> lease, validates the schema and payload digest, records the Receipt under the unique constraints, and Core applies the report and status transition idempotently.
5. Stop or idle without a Receipt: hold, not success [L: a denied op reached a hook and Stop but produced no reply].

### 4.3 Hook normalization (change required)
Current observation records event and prompt id but not prompt content, channel source or op_id, so origin classification is not implemented [V]. Parse and validate a bounded `<channel source=... op_id=...>` marker and prompt_id BEFORE discarding raw text. The marker is correlation evidence, never a credential: a phone or TTY user can type the same text (test T-C6). Register SessionStart for both `startup` and `resume` (currently `startup` only) and live-test the resumed source and timeout before removing any launch/hook binding [V/I].

### 4.4 Lifecycle
- New issue: with the pane idle and no unsettled op, relaunch the process in the same pane with a fresh `--session-id`, or use the qualified native new-chat path and wait for SessionStart to report the new uuid before binding. Relaunching restarts the channel child; startup must re-prove the capability handshake. OPEN: whether a new session id under the same Remote Control name keeps one phone URL (Q1).
- Paperclip restart: if the attested process still hosts the conversation, send nothing; re-attach to the channel child and adopt ops by ledger.
- Provider process death: relaunch `--resume <uuid>` with the same Remote Control name and approved flags only at a safe boundary; reconcile with the ledger before opening any other issue [L for resume].

### 4.5 Experimental-flag risk and fallback
`--dangerously-load-development-channels` is a vendor experimental extension, not general MCP behaviour; the flag, schema or permission semantics may change; it requires a one-time startup confirmation and printed a misleading "no MCP server configured" message while connecting fine [L]. Treat 2.1.309 as a measured compatibility pin. Feature-flag the channel per agent; startup must prove capability handshake, channel-child binding, hook observation, permission policy and a usable Remote Control URL before dispatch. Fallback order: (1) interactive Remote Control + channel; (2) explicitly authorized compatibility mode using journaled pane input with process fencing and hooks, every uncertain write held; (3) pause automated Claude work and keep phone control. No headless swap; no scrape-only success criterion.

## 5. Permission and approval authority

Evidence: after a channel push the server received `permission_request` and replied deny; the model then ran no reply tool. On the next op it replied allow and the model called the reply tool. Both behaviours work in the channel [L]. The initial probe launch disabled prompts; the resumed launch used default permission mode, so the two must not be conflated [L]. Not proven: precedence against a simultaneous approval on the owner's phone.

Policy order (single decision owner) [I]:
1. Hard Paperclip/host prohibitions (secret exposure, cross-agent or cross-host access, session spoofing, destructive actions outside the admitted issue, unapproved spend) deny regardless of wording.
2. Narrow preauthorized operations may be allowed automatically: the exact finish/block tool when run+op+lease validate; explicitly admitted read-only tools. Never blanket-allow shell, MCP wildcards, network, git push, service control or secrets.
3. Elevated or ambiguous requests become `pending_owner` with request_id, tool, digest of exact arguments, run/op/session/epoch, deadline and origin, routed to ONE authoritative approval route. Timeout means deny or hold, never allow. Phone text such as "yes" is steering, not a signed decision.
4. Race rule: persist one terminal decision by CAS on (host epoch, session id, request_id, tool, input digest) before replying `notifications/claude/channel/permission {request_id, behavior}`. A duplicate identical request gets the stored decision; changed arguments are denied. If a native phone approval is not observable, do NOT send a competing channel decision for that class: choose channel OR native UI as authoritative per class and hold on ambiguity.
5. Owner-originated turns outside an admitted run must not inherit managed auto-allow; classify against the active turn's source, not the persistent session. Revocation and expiry fence delayed approvals.

The default is no longer unconditional permission bypass; the interim bypass remains only for lanes with no relay (agy) and is recorded as a residual risk (section 9).

## 6. Host layer

### 6.1 Principle
The common resource is an attested control handle, not a Herdr pane. Herdr (0.9.5, named session allowlist, e.g. `paperclip-native`) hosts only providers that need an interactive pane: Claude and agy. OpenCode and Codex do not require Herdr; healthy OpenCode services and the Codex daemon are not relocated into panes merely for observability [I].

### 6.2 HerdrHost contract [I unless noted]
- One workspace and pane per Paperclip agent, stable sanitized name and fixed cwd; record returned session/workspace/pane/terminal ids. Never use the default session, focused pane, guessed ids or existing panes (`claude`, `agy`, `fleet`, `sco337-native`) without a ledger match [V: those sessions are occupied by other owners].
- Provision only into a recorded idle shell pane with no foreign agent; store the full argv vector and hash; env is a strict nonsecret allowlist (no board tokens, API keys, passwords).
- Attest after every create/restart/reattach by joining `agent get`, `pane list` and `pane process-info` on the same pane id: pid, process birth time, argv hash, cwd, uid, foreground provider. Name or pid alone is insufficient. A coarse (1 s) birth time is provisional and cannot authorize destructive control.
- Observation is bounded: `agent get/explain/wait` are classifier output, `idle/done` may miss subagents and dialogs, `read` is a screen tail with no stable cursor [V/D]. The native transcript and Receipt are authoritative.
- Herdr `agent prompt` acknowledges terminal input, not turn acceptance [D]. It is the compatibility-mode send for Claude and the primary send for agy, graded `emitted_local` at best.
- Interrupt: one Ctrl+C only under an exact process+conversation fence, recorded as a request, never proof of stopped side effects. Never kill, close or detach a pane as a routine cancel; `detachObserver` never terminates the native agent.
- Keep Herdr `agent_resume.argv` correct on every conversation transition (restore must keep `--remote-control`, name, model, effort, approved permission flags and the current issue's id), or restore may revive an older issue.

### 6.3 Herdr gaps and mitigations

| Gap | Mitigation |
|---|---|
| No durable turn-correlated prompt receipt or idempotency key | Core ledger + at-most-once dispatch + provider Receipt; no uncertain retry. |
| No atomic pane-ownership token or expected-pid precondition | Stable session/pane + SQL lease + attestation; fail closed on ambiguous concurrent input. |
| Idle/done are classifiers, not completion | Receipt is the only completion; detector is corroborative. |
| No provider-agnostic new/resume conversation API | Provider-specific `bindConversation` (Claude relaunch or SessionStart-verified new chat; agy `/new` with id check). |
| Snapshot restore can drop flags or keep a stale session | Update resume argv per transition; restore test T-H4. |
| Different origin of phone vs local typing | Single-writer admission; mark competing native activity uncertain. |
| Launchd/GUI/Keychain context differs at boot | Provider connection proof after login; no TCC or login bypass (N7). |

### 6.4 agy host
agy remains a pane transport: one-line prompts, paste-settle delay, idle regex, Remote Control URL regexes [V]. Preserve in-flight `active.json` and receipts during migration; reconcile the old tmux owner to terminal before any Herdr cutover, and never run two input owners on one conversation. Admit the next issue only after the prior op and receipt settle, then `/new` once and verify a NEW id via Remote Control output. `block` has no structured representation, so an idle-without-receipt agy run is a Board hold (Q4).

### 6.5 OpenCode and Codex hosts
OpenCode: attest the loopback endpoint by pid+start+exe+cwd and the listening tuple before sending credentials; keep version pin, env allowlist and per-dispatch model/variant checks [V]. Codex: keep the double peer inspection of the daemon identity and the thread-config-equals-policy check [V]; thread creation stays on its existing bootstrap path.

## 7. Minimal storage

### 7.1 Reused as-is [V]
`agents`; `issues` (execution_run_id, status_version, conversation boundary comment); `heartbeat_runs` (native_session_id, runtime_mode, driver_kind, process fields, controller lease fields, result_json); `native_run_finalizations` (run lease and fenced finalization phases); `issue_recovery_actions` (Board holds, executionReconciliation evidence); `agent_task_sessions` (per-issue session JSON, still the conversation-id store for providers on the old path; one writer only); `heartbeat_run_events` (audit, including owner-input observations as `nar.owner_input` events); `environment_leases`. Existing recovery cause/policy strings are kept; add new causes only (renaming is a cross-file migration).

### 7.2 Added now: two tables

```sql
-- Op ledger: idempotency and no-replay. One row per work-causing effect.
create table native_ops (
  op_id uuid primary key,                      -- full random uuid, minted by Core before any effect
  company_id uuid not null,
  run_id uuid not null references heartbeat_runs(id),
  conversation_ref text not null,              -- provider conversation id (uuid | ses_... | thread id | agy id)
  host_ref text not null,                      -- logical host key + epoch string; no secrets
  kind text not null check (kind in ('prompt','interrupt','new_conversation','resume')),
  client_intent text not null,                 -- run + sequence
  payload_sha256 text not null,
  state text not null check (state in
    ('reserved','push_started','emitted_local','hook_observed','terminal','rejected','unknown','interrupted')),
  host_epoch integer not null, lease_generation integer not null,
  evidence_json jsonb not null default '{}',   -- per-rung source + timestamp, bounded
  reserved_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index native_ops_run_intent on native_ops (run_id, client_intent) where state <> 'rejected';
create index on native_ops (run_id, state);

-- Receipt store: one validated terminal per run.
create table native_receipts (
  id uuid primary key,
  op_id uuid not null references native_ops(op_id),
  run_id uuid not null, issue_id uuid not null,
  channel text not null check (channel in ('mcp','file','provider_event')),
  kind text not null check (kind in ('finish','block')),
  payload_sha256 text not null, payload_json jsonb not null,
  tool_call_id text,
  host_epoch integer not null, lease_generation integer not null,
  state text not null check (state in ('claimed','validated','applied','rejected')),
  reject_code text, recorded_at timestamptz not null default now(), applied_at timestamptz,
  unique (op_id, kind)
);
create unique index native_receipts_one_terminal_per_run
  on native_receipts (run_id) where state in ('validated','applied');
create unique index native_receipts_tool_call
  on native_receipts (run_id, op_id, tool_call_id) where tool_call_id is not null;
```
Migration is additive; rollback is to stop using the tables. Within a transaction every write re-verifies the run lease row (`FOR UPDATE NOWAIT`, expiry re-checked after lock) and run/issue state [V].

### 7.3 Deferred until proven needed
`native_agent_hosts`, `native_conversations`, `native_owner_inputs`, a duplicate host lease, and many status variants. Host identity is attested live and recorded in `native_ops.host_ref` plus run fields; conversation uniqueness uses a unique index on `(agent_id, issue_id)` where the existing task-session store allows, otherwise add a single unique index on `(host_ref, conversation_ref)` to `native_ops`-adjacent state only if the 'no unique native_session_id' gap bites [V gap, I fix]. Add a table only when an existing journal cannot express the op_id semantics.

### 7.4 Never stored
Endpoint passwords, bearer or provider tokens, run-scoped Paperclip tokens (only secret id/version through the existing secret service). Prompts: store the digest and the issue-context snapshot already kept on the run; bounded excerpts only.

## 8. Conformance suite

One suite, parameterized by driver. Tests run against fake providers/TUIs first, with mocked Herdr sockets and throwaway named sessions; no model calls and no paid inference. A provider is marked supported for a capability only when its tests in both groups pass. Status 2026-11-02: U1-U13 implemented in `packages/paperclip-runner/src/nar/nar-conformance.test.ts` against the reference ledger `src/nar/core.ts` and `FakeDriver` for all four providers (76 cases, green, killed by targeted mutants of core). This proves Core ledger semantics only; no live driver exists yet, so no capability cell changes. C/H/A groups are not yet written.

Amendments found while implementing (v0.2.1):
- `unique (run_id, client_intent)` must be a partial unique index `where state <> 'rejected'`, otherwise a reserved-then-rejected intent can never be rescheduled as a NEW op (2.3 crash table row 1).
- `bindConversation(h, s, mode, f, existingId?)` returns `{conversationId, cwd, model?}`: resume needs the stored id, and Core must compare the provider-reported cwd/model against the scope (U9) instead of trusting the driver.
- Creation is ledgered as a `new_conversation` op. A throw after `push_started` leaves the (agent, issue) conversation `unknown`; later binds are refused with `conversation_unknown` until Board reconciliation (A1).
- A hook observed for an op already `unknown` is recorded as evidence only; `unknown` is left only by a Receipt or reconciliation.

### 8.1 Universal tests (every driver)
- U1 Lease and fence: a write with an expired lease, lower epoch or foreign controller is refused; late tool result from a dead run is rejected (`authority_lost`).
- U2 Duplicate op_id, same digest: returns stored state, transport not invoked; different digest returns `identity_conflict`.
- U3 Duplicate intent (new op_id, same client_intent): refused.
- U4 Crash windows: crash at reserved, at push_started, after emitted_local, after hook/event, after tool accepted before commit, after receipt before apply. Every case yields zero automatic replays and at most one applied Receipt. Only "reserved, transport provably not invoked" permits a new op.
- U5 No inference of loss: absent hook/transcript/event never moves an op to `rejected`; it stays `unknown` and held (R-N1, R-N2).
- U6 Receipt idempotency: duplicate finish returns stored receipt; finish then block, or block then finish, for one run yields exactly one terminal.
- U7 Receipt fences: receipt from another issue, run, conversation, host epoch or lease generation, malformed or partial payload cannot complete the issue.
- U8 Stop/idle/phone reply/transport success never completes a run.
- U9 Conversation identity: new issue gets a different id; same-issue re-entry adopts the same id with no new-conversation op and no prompt; foreign cwd/agent/model conversation is refused.
- U10 Paperclip restart mid-turn: reattach to the live host, settle the original op from the ledger, no resend.
- U11 (OUT OF SCOPE v0.3, native-copresence) Concurrent owner steering: owner input during a run is recorded as competing activity, never attributed to an op, never causes replay.
- U12 Secrets hygiene: no token, password or key in argv, env, logs, events or receipts.
- U13 Non-interference: unrelated panes, sessions, listeners and launch jobs are untouched by provision, recovery and cancel.

### 8.2 Transport-capability tests (only for drivers declaring the capability)

Channel input (Claude):
- C1 Capability handshake: refuse dispatch and mark the lane unavailable if the channel capability, child binding or Remote Control URL is missing; never treat a local write as acceptance.
- C2 Push-before-hook crash: kill Paperclip (and separately the host) after `push_started`/`emitted_local` and before UserPromptSubmit; assert `unknown`, hold, no resend, and that a late correlated Receipt is accepted.
- C3 Channel-server restart under a preserved host process: reconnect through the authenticated local path, re-prove epoch, no loss of ledger, no duplicate delivery of an `emitted_local` op.
- C4 Duplicate op_id across channel and hook: the same full op_id arriving twice produces one `hook_observed` and one Receipt application.
- C5 Denied permission without receipt: deny a request; assert a Stop/hook may occur but no Receipt is applied and the run holds (mirrors the live deny case).
- C6 (OUT OF SCOPE v0.3, native-copresence; first valid answer wins per section 3.4) Phone/channel race: owner approves on the phone while the channel decides the same request; per-class single authority holds, ambiguity holds, a later conflicting decision never undoes a native action.
- C7 Hook-origin spoof: owner types text imitating the channel marker and an op_id; it is classified as owner input, not a Paperclip op; a marker alone never authorizes a managed tool.
- C8 Resumed traffic: `--resume` keeps session, Remote Control URL, channel, hooks (SessionStart `resume` source tested) and owner text still arrives as plain text.
- C9 Duplicate/reused permission request_id on resume, delayed allow after lease loss, completion tool requested during an owner-only turn: all denied or held.
- C10 Dynamic authority: persistent bridge resolves op -> run -> lease per call; a prior run's rights are retired immediately; successor run cannot use them.

Pane host (Claude, agy):
- H1 Provision idempotence: two concurrent ensure-host calls create one workspace, pane, name and process; no focus change.
- H2 Foreign safety: same name in another session, focused pane, occupied shell, unknown foreground all fail without write.
- H3 Attestation and pid reuse: recycled pid with different birth time is rejected; 1 s birth time never authorizes destructive control.
- H4 Restore argv: resume argv updates per conversation transition; restore keeps Remote Control, name, model, effort, permission flags and current issue.
- H5 Slash-command false stall: `/new` finishing without a "working" state neither replays nor records a new id unless independently verified.
- H6 Busy/dialog: working, blocked, unknown, idle-with-subagents or an unrecognized dialog all prohibit next-issue admission; no auto-approval.
- H7 Stale Herdr registration (dead process, live name): fail closed.
- H8 Output bounds: ANSI, wrapping, alternate screen, scrollback eviction; results come from receipt/transcript, not screen bytes.

HTTP/RPC (OpenCode, Codex):
- A1 Creation outcome unknown is never retried; resume by exact id verifies cwd/model.
- A2 Event cursor: monotonic durable cursor survives restart; coverage incomplete is reported.
- A3 Endpoint attestation: foreign process on the expected port gets no credentials.
- A4 Codex daemon peer double-inspection and thread-policy equality.

Provider matrix (each provider, independently): create-id, resume-id, Receipt, blocked UI, restart, no-replay, owner visibility. A capability cell turns PROVEN-LIVE only when its test ran against the live provider.

## 9. Security model and residual risks

In scope (logical safeguards): run and host leases with fences; the op ledger and unique keys; scoped per-run authorization and constant-time bearer checks; process attestation (pid, birth time, argv, cwd) before sending any credential or input; pane ownership ledger; refusal matrix for duplicate, stale and foreign actors; no secrets in agent environments; channel/permission decisions via CAS.

NOT guaranteed: isolation between processes that run as the same macOS user. Everything runs as `tech` (D3). Observed [V]: all runtime listeners (OpenCode loopback ports, Paperclip, PostgreSQL) belong to `tech`; password files are mode 0600 but any `tech` process can read them. A synthetic unix-socket peer check returned correct pid and audit-token [V], and a synthetic Seatbelt profile denied a test port and path [V], but neither proves containment of existing agents. File modes, random localhost ports, inherited environment secrets and Keychain ACLs alone do not stop an arbitrary same-UID process from impersonating Paperclip [I]. Herdr names and markers are correlation, not authentication. Hook text, including channel markers, is spoofable by any phone or TTY user. The Claude channel is an experimental vendor extension. Unconditional permission bypass remains on lanes with no relay (agy).

Residual risk statement: a malicious or compromised same-UID process, or an over-privileged agent, can read the secrets it can reach, write the ledger sockets and files it can open, and drive sibling panes. v1 does not defend against this and must not claim to.

Owner decision 2026-11-02 PT: v1 ships logical fences only (leases, op ledger, duplicate/stale/foreign-writer refusal, auth) and names same-UID bypass as a residual risk. Optional later hardening track (NOT v1 requirements, no work scheduled): (a) one Paperclip-owned, peer-attested write broker (Unix socket with peer pid and audit-token checks) fronting all mutations, with bypassing native endpoints made non-writable; (b) sandboxing agent subtrees (Seatbelt profiles) so agents cannot reach other agents' secrets or endpoints; (c) a distinct service identity if the threat model demands a true boundary; (d) finer process birth time via a small helper. Open risks of this track: Seatbelt vs the providers' own sandboxes, Keychain unavailability before GUI login, and breaking live sessions.

## 10. Per-agent rollout and rollback

Principles: additive DB migration; per-agent feature flag `native_runtime = legacy | nar` (default `legacy`), checked inside the lease CAS so an agent never has two writers; hosts are independent of the runtime flag; no cutover while any run of that agent is `running` or `held`; owner-coordinated per AGENTS.md (affected agents prepare handoff first).

Implementation and rollout order (from the independent review; each step is measured, not calendar-gated):
1. Core ledger + receipt store + channel compatibility shim on ONE low-risk Claude agent with no change to live sessions or global permissions. Prove hook classification (4.3), crash windows (U4, C2), resumed Remote Control + owner input, allow/deny paths.
2. Integrate the existing finish/block schema through the persistent per-host bridge with dynamic authorization (C5, C10); prove one completed issue is idempotent across Paperclip restart.
3. Expose the common interface on the already-structured OpenCode and Codex paths and prove their separate phone and owner-visibility constraints. Codex live tests wait for the usage reset (D5).
4. Gate agy on a verified structured transport, or formally keep it as legacy pane transport with a documented exception; do not cut it over otherwise.
5. Retire duplicated legacy machinery lane by lane, only after the side-by-side gate below.

Per-agent gate: universal suite green on the fake provider; the transport-capability tests for that driver green; live lane green on that agent for a bounded set of issues with every `held` run explained by genuine provider failure. The gate is measured per agent, with no fixed one-week rule.

Rollback (per agent): set flag to `legacy`. NAR rows stay (no deletes). Open ops stay `unknown` and the issue stays held until the Board resolves; the legacy path never auto-replays (`automaticRecovery.replay=blocked`) [V]. Hosts are unaffected. Keep the old Claude hook/semantic journal, the interim Remote Control adapter and the agy tmux adapter in the tree, behind the flag, until the gate passes; the 10k-line executor and shared helpers have not been exhaustively inventoried (Q9), so no deletion is scheduled in v0.2. Drop new tables only after a full release cycle and an export of `native_ops`.

Observability at cutover: ops by state, held runs, receipt rejects by code, host epoch bumps, attestation failures by reason, channel handshake failures, owner inputs per hour; transitions appended to `heartbeat_run_events` as `nar.*`.

## 11. Risks

R1. Per-issue conversation vs persistent session (review edit #6 recorded). For Claude, starting a new conversation inside a persistent pane means relaunch or native new-chat; cwd-keyed resume, per-issue workspaces and Remote Control URL continuity are unproven (Q1, Q2, Q6). If these fail, a serial per-agent conversation serving issues in sequence is the documented alternative; this is an owner decision, not made here.
R2. Experimental channel flag: may change or vanish; pinned to 2.1.309; fallback ladder in 4.5.
R3. Exactly-once model ingestion is impossible; the design only bounds attempts and holds ambiguity. More Board holds are the price.
R4. Same-UID isolation is not provided (section 9).
R5. Hook text is spoofable; hook evidence is corroboration only.
R6. One host is inherently serial per agent; throughput per agent is 1 (Q7).
R7. Phone-vs-channel approval races are untested; per-class single authority is the mitigation.
R8. Herdr classifier states can mislead (`idle` while visible not idle) [V]; never used as completion.
R9. Source gaps: the cleanup inventory, the executor body and several status-arbiter files were not read; cutover must not delete code on the strength of this spec.

## 12. Open questions

Q1. Does a new `--session-id` under the same Remote Control name keep one phone URL, or does the phone list multiple sessions per name? (Proven only for resume of the same session.)
Q2. Does `UserPromptSubmit`-plus-SessionStart bind work on `resume` in production (matcher currently `startup` only)? Test C8.
Q3. Can a persistent per-host channel/bridge be rebound atomically between runs without dropping the owner's live process (C5/C10)? Is a channel-owned Unix socket with epoch attestation sufficient?
Q4. agy: a verified structured inbound interface (MCP push, ACP, or equivalent), resume after pane death, durable transcript for op evidence, and a structured `block`. Until shown, legacy.
Q5. Phone-vs-channel approval precedence, and whether Remote Control exposes an observable native approval. Which route is authoritative per request class (owner decision)?
Q6. cwd model: Claude resume is cwd-keyed; per-issue execution workspaces vs a fixed per-agent host cwd. Weaker file isolation between issues is a product consequence.
Q7. Is serial one-issue-at-a-time per agent acceptable, or should additional hosts be separately authorized?
Q8. Transcript completeness: can a provider transcript miss an accepted prompt? Decides whether the automatic retry flag may ever be enabled.
Q9. Inventory of shared helpers inside the large executor before any lane removal.
Q10. OpenCode and Codex owner-phone paths (vendor surface, thread visibility), and who writes across hosts for the WRX80 OpenCode lane.
Q11. Owner policy: pause Paperclip watchdogs when the owner steers mid-turn? Notify or wait when owner work is running and Paperclip work is queued?
Q12. RESOLVED 2026-11-02 PT: logical fences now; broker + sandbox hardening stays optional and unscheduled (section 9).
Q13. Usage and cost visibility under subscriptions (Claude/agy report unpriced).
Q14. Whether to cite or adopt ACP v2 insertion/`messageId` and `state_update` semantics as the Receipt wire shape for providers that speak ACP (compatible model only today).

## 13. Sources

Probe evidence [L]: `/Volumes/NVM/AI_Agent_Runtime/tmp/sco337-cloudlead/note-chan.md`; `/Volumes/NVM/Paperclip/tmp/claude-chan-probe/` (`chan.cjs`, `chan.log`, `hooks.log`, `run.sh`, `run-resume.sh`, `policy.json`). Findings reflected: channel push + MCP tool reply, hook source tagging, phone steering in the same session, resume keeping URL/history/channels across two restarts, permission relay allow and deny, negative results for headless `-p` and `claude remote-control --session-id`.

Reviews and research (all under `/Volumes/NVM/AI_Agent_Runtime/tmp/sco337-cloudlead/research/` unless noted):
- `native-agent-runtime-spec-draft.md` (v0.1, base).
- `spec-review-chatgpt.md` (independent review; sections E and F and the implementation order applied).
- `herdr-host-driver.md` (Herdr 0.9.5 surface, gaps, conformance tests; read-only live inspection [V]).
- `same-uid-isolation.md` (same-UID review; conclusion in section 9).
- `claude-per-agent-session-plan.md` (used only where consistent; its single per-agent Claude session is not adopted, see R1).
- `/Volumes/NVM/AI_Agent_Runtime/research-loops/agy-opencode-acp/REPORT.md` (agy changelog through 1.4.12, official Codex ACP adapter with steering, ACP v2 draft lifecycle; all [D]).

Code consulted by the above (under `/Volumes/NVM/Paperclip/master`, dirty live checkout): `server/src/adapters/agy/execute.ts`, `server/src/adapters/claude-rc/execute.ts`, `server/src/services/native-runtime/*` (claude-native-*, opencode-*, codex-shared-*), `packages/paperclip-runner/src/drivers/{claude,codex}/*`.

Not read: the main executor body, status-arbiter and committer files, OpenCode/Herdr zagent docs beyond those cited. Their absence limits cleanup claims (R9).
