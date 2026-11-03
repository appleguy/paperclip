# SCO-469: Fact-check of ARCHITECTURE_HANDOFF.md against source

Read-only review, 2026-11-02 (PST). Scope per issue: `ARCHITECTURE_HANDOFF.md` (live copy at
`/Volumes/NVM/Paperclip/ops/research/runner-control/experiments/unified-native-mission/ARCHITECTURE_HANDOFF.md`)
against the source under the master checkout (`packages/paperclip-runner/src/drivers`,
`server/src/services/native-runtime`). Method: direct file listing, grep and targeted reads of every
file the handoff names, plus the surrounding ingress code. No processes were restarted or woken.

Location note: the handoff file itself exists only in the live ops directory, which is **not a git
repository**; the master checkout's `unified-native-mission/` copy contains only the deploy scripts.
This corrections file is therefore committed under the master checkout copy, the only path `pc-ship`
can commit.

## Verdict

The handoff is substantially accurate on file names and behavior that matter for operations. Of its
named service files, 3 of 24 do not exist as implementations (tests only), one adapter type is
missing entirely, and one interface claim (`turn/start` under native-runtime) is real but lives in a
different package than stated. All line references checked were within a few lines of actual. No
claim was found to be fabricated.

## Gaps by backend

### Cross-cutting (§2, §4)

- **`ARCHITECTURE_HANDOFF.md` is not in the versioned tree.** The master checkout's
  `ops/research/runner-control/experiments/unified-native-mission/` holds only the deploy scripts;
  the handoff and its cited evidence (`audit-20261102/NEXT.md`, `ROLLBACKS.md`, etc.) live only in
  the unversioned ops directory. The handoff's own record is not `pc-ship`-reachable as written.
- **Heartbeat gate: verified, line slightly off.** The atomic conditional UPDATE requiring an
  invokable status and `lifecycleState='ready'` is at `server/src/services/heartbeat.ts:3146`
  (handoff says ~3141). The recovery half of the claim ("marks assigned issues `blocked` … flips
  them back once requeued") is only partially in heartbeat.ts: line 711 shows wake accepts a
  `blocked` issue status; the marking-blocked logic lives elsewhere (recovery contract files), so
  that half is unverified by this review.
- **Settlement reserve has no dedicated file.** Settlement logic is embedded in
  `packages/paperclip-runner/src/control-plane/durable-prp-control-plane.ts`
  (`settlementCommandTypes` at :66). The handoff's "control-plane/ (durable PRP control plane,
  settlement reserve, private state)" is backed in substance, not as separate files.
- **Adapter list omits `claude_rc`/`claude_rc_local`.** `server/src/adapters/claude-rc/` exists
  (execute.ts/index.ts) and the newest commit on the deploy branch (203e24dd3, "claude_rc_local:
  drive one persistent interactive Claude RC session") adds it as a real adapter path. §2 and §3.2
  do not mention it. `packages/adapters/` also contains cursor-local/cursor-cloud, gemini-local,
  grok-local, hermes, hermes-gateway, kimi-local, openclaw-gateway, pi-local, codex-local that §2's
  "per agent type" list does not enumerate (the named ones do all exist).

### 3.1 Codex (shared app-server daemon)

- **`codex-shared-executor` does not exist as source.** Only
  `codex-shared-executor.integration.test.ts` and `codex-shared-executor-refusal.integration.test.ts`
  exist in `server/src/services/native-runtime/`; there is no `codex-shared-executor.ts`. The
  handoff lists it among the native-runtime services — claim not backed by source.
- **`turn/start` is real but in the runner driver, not native-runtime.**
  `server/src/services/native-runtime/codex-shared-daemon.ts` is read-only discovery only ("It
  neither authorizes a run nor asserts that a thread belongs to the task", header comment); the
  actual `turn/start` request and its guards live in
  `packages/paperclip-runner/src/drivers/codex/shared-daemon-transport.ts:245-249` (rejects model/
  effort and cwd/workspace mismatch). The handoff attributes turn-driving to the daemon layer.
- Verified: `pausedAdmission` at `codex-shared-goal-authority.ts:181`, with ACTIVE denied (line 171
  computes the wanted status as `paused` for create/edit); `shared-thread-config` backed by
  `createSharedCodexThreadConfig` (vendor re-export) and `threadConfig` enforcement in
  `codex-shared-admission.ts:37-121`; daemon 0.166 pin at `codex-shared-daemon.ts:14-17`;
  `codex-shared-{admission,daemon,goal-authority,goal-controller,registration,observation,overrun-pause,thread-name}`
  all exist; `codex-native-delegation.ts`, `cancelled-retained-cleanup-authority.ts`,
  `assigned-mcp-tools.ts`, `acpx-qualification.ts` all exist.

### 3.2 Claude Code (`claude_local`)

- **Missing adapter (above).** The tmux-based `claude_rc_local` path is absent from the handoff; §3.2
  documents only the PTY named-RC launch. Its existence materially changes the Claude ingress story
  (see bypass paths 1–2).
- Verified: stop-latch behavior at
  `packages/paperclip-runner/src/drivers/claude/native-interactive-controller.ts:116` and
  `native-pty-factory.ts:93` ("`stopped` latches only on a confirmed exit"). The `claude` driver
  contains the claimed admission/authority/journal surface (`native-interactive-*.ts`,
  `native-owner-command-journal.ts`, `native-hook-*.ts`). `claude-managed` driver exists
  (`environment.ts` only — thinner than the §3.6 grouping implies).

### 3.3 agy / Antigravity (`agy_local`)

- **`antigravity-headless-builder` and `antigravity-headless-selection` do not exist as source.**
  Only `antigravity-headless-builder.test.ts` and `antigravity-headless-selection.test.ts` exist;
  `antigravity-headless-authority.ts` is the sole implementation. The handoff lists all three — two
  claims not backed by source.
- Verified: adapter behavior at `server/src/adapters/agy/execute.ts` — tmux paste-buffer
  (:94-97), `/remote-control` before/after guard comparing live IDs (:111-118),
  `--remote-control --dangerously-skip-permissions` launch (:128). TUI-instability and paste-settle
  caveats are real (`pasteSettleMs` at :31).

### 3.4 OpenCode

- **`/api/` route prefix: verified.** The handoff's `GET /api/session/active` and
  `POST /api/session/<id>/interrupt` match source once the adapter's `/api` prefix is applied
  (`shared-session-recovery.ts:58` prepends `/api`; `GET /session/active` at :74;
  `POST /session/<id>/interrupt` at :126).
- **Preflight: verified, line slightly off.** `sharedServerRecoveryConfigPath` requirement at
  `packages/adapters/opencode-local/src/server/execute.ts:522`; exit 75 "unresolved active sessions"
  at :542 (handoff says ~533). Task-less preflight failure does return exit 75 as claimed.
- **Driver pin: verified.** `QUALIFIED_OPENCODE_VERSION = "1.18.34"` at
  `packages/paperclip-runner/src/drivers/opencode/opencode-server-driver.ts:98`; queue/no-steer
  declared at :242 (`steering: false`) and :253 (`unsupported: ["steering", "goals",
  "threadLineage"]`).
- Not verifiable from this source scope: Herdr herdr.sock path, WRX llama-swap 429-not-queue
  behavior, live WRX admission state. `backends/opencode-glm-flash/bin/admission.py` exists and is
  fail-closed with the Hy-Memory GPU2 sidecar rule as described (route table pins GLM concurrency 2,
  DeepSeek 0 — a detail the handoff omits).

### 3.5 ChatGPT Web

- Verified: the Go process adapter exists (`zagent/go/cmd/paperclip-chatgpt-web`,
  `go/internal/runnerweb` with MANUAL_PROTOCOL.md). Claims about the manual protocol are consistent
  with the adapter docs; no source contradiction found. OpenRig trial path and the missing M2 tunnel
  launchd job are ops-level and outside this source scope.

### 3.6 Others

- Verified: `muse`, `acpx`, `external`, `dot`, `claude-managed` driver directories all exist under
  `packages/paperclip-runner/src/drivers/`. `bin/pc-ship`, `bin/pcc`, `M/accept-unattended.sh`,
  `M/goal-clear.sh` all exist. The handoff's "treat as SHIPPED/unverified" stance for live proof is
  honest and unchanged by this review (this review covered source, not live runs).

## Top 5 provider-ingress bypass paths (file:line)

1. **Claude named-RC session — owner/other clients are second writers with no origin fence.**
   Paperclip's own ingress labels hook events only `owned-descendant-attributed` and states "This
   interface never claims provider-authenticated events or PRP settlement"
   (`packages/paperclip-runner/src/drivers/claude/native-hook-event-ingress.ts:11-13`); the PTY stop
   path likewise stays retriable on uncertainty (`native-pty-factory.ts:93`). Local or remote typing
   into the same session cannot be rejected by Paperclip.
2. **`claude_rc_local` drives the exact TUI the owner steers.** The adapter "drives the SAME
   interactive process the owner sees and steers under a stable session name" and detects idle by
   screen-scraping heuristics (`server/src/adapters/claude-rc/execute.ts:7-9`, `isClaudeIdle` at
   :30-40, reusing agy's `paste`/`send`/`tmux` helpers). No one-writer lease; the owner can type
   mid-turn and Paperclip cannot distinguish origin.
3. **agy adapter: paste-buffer + `/remote-control` ID comparison is the only guard.**
   `server/src/adapters/agy/execute.ts:94-97` (paste-buffer write), :111-118 (`/remote-control`
   before/after guard comparing live `?p=` IDs), :128 (launch with
   `--dangerously-skip-permissions`). Mid-turn owner steering and shared TUI input are unbocked; the
   stale-cache caveat confirms the guard depends on vendor CLI behavior.
4. **OpenCode shared server HTTP: Basic credential holders can steer.** Any client with the shared
   Basic credential can call `GET /api/session/active` and steer/interrupt sessions
   (`packages/adapters/opencode-local/src/server/shared-session-recovery.ts:58` sends the
   authorization header; :74 lists active sessions). Paperclip only ever interrupts its exact bound
   session (:121-126) and cannot reject second clients — consistent with the handoff's SCO-421
   observed second-client steer.
5. **Codex shared daemon: read-only discovery, turn/start guards check identity fields only.**
   `server/src/services/native-runtime/codex-shared-daemon.ts` header: "It neither authorizes a run
   nor asserts that a thread belongs to the task" (:7-9); the daemon pins version 0.166 (:14-17).
   The `turn/start` guard rejects only model/effort/cwd mismatch
   (`packages/paperclip-runner/src/drivers/codex/shared-daemon-transport.ts:245-249`) — nothing
   authenticates the caller's origin, so vendor mobile clients remain a second writer Paperclip
   cannot reject (matching the handoff's own key rule).

Honorable mention: `native-owner-command-journal.ts`
(`packages/paperclip-runner/src/drivers/claude/native-owner-command-journal.ts:13-16`) journals owner
attempts append-only but has no prevention ability — the reconciliation-not-quarantine design the
handoff describes is what the code actually implements.

## Bottom line

Adopt the handoff for operations, with three corrections: (1) `codex-shared-executor`,
`antigravity-headless-builder`, `antigravity-headless-selection` are test-only, not services; (2)
add the `claude_rc_local` adapter to §2/§3.2; (3) attribute `turn/start` to the runner's
`shared-daemon-transport.ts`, not the native-runtime daemon layer. The handoff's central admission —
that provider-ingress fencing is not real and the design reconciles rather than quarantines — is
corroborated by every ingress surface examined above.
