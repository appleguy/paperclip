# Native runner capability index (W6)

Evidence snapshot: **2026-11-02 Pacific**. Running checkout SHA initially **`d31bd964fe7f4cb1e60d5a79a4afd5d1f877aba5`**; concurrent writer advanced HEAD to **`7880ba307d7f59476f3982b3ec8ac8f519c15648`** on recheck. Both obtained with **`git -C /Volumes/NVM/Paperclip/master rev-parse HEAD`**; `git log --oneline -40` inspected. Only agy adapter/test paths changed between these SHAs; this is the *checkout* SHA, **not** a claimed deployed SHA.

**Scope and proof bar.** Each status describes the indicated Paperclip/native integration, not what a vendor could theoretically do. Statuses are exclusively `PROVEN-LIVE`, `SHIPPED-UNPROVEN`, `UNSUPPORTED`, `OPEN`. `PROVEN-LIVE` requires a live result, run ID, native session/thread ID, commit/payload SHA and a heading in the named integration cursor. Historical successes are labeled **legacy** and do not certify NAR v0.3. IDs abbreviated in the cursor remain visibly labeled *prefix*, not expanded or invented.

**Source map.** `IC` = `INTEGRATION_CURSOR.md`, found in `/Volumes/NVM/AI_Agent_Runtime/tmp/sco337-handoff-pkg/mission-docs/INTEGRATION_CURSOR.md`; the specified checkout copy at `ops/research/runner-control/experiments/unified-native-mission/INTEGRATION_CURSOR.md` is **missing**. IC is thus a packaged historical snapshot, not a fresh acceptance run. `S` = `doc/spec/native-agent-runtime.md` v0.3 (§§2–8, 10–12); `OC` = `packages/adapters/opencode-local/src/server/nar/{nar-attempt,opencode-http-driver}.ts`; `N` = `packages/paperclip-runner/src/nar/{core,capabilities,driver}.ts`; `C` = `server/src/adapters/claude-rc/execute.ts` and `packages/claude-channel-bridge/{server.cjs,lib/bridge.cjs,lib/ledger.cjs}`; `A` = `server/src/adapters/agy/execute.ts`; `X` = `packages/paperclip-runner/src/drivers/codex/shared-daemon-transport.ts`; `U` = `server/src/services/native-runtime/native-usage-accounting.ts`. Commit evidence: `5076463a0` (fake NAR Core), `c8593b370` (OpenCode driver), `456e4f20f` (opt-in OpenCode NAR), `e2771a59d` (in-flight rejoin), `d31bd964f` (spec), `7880ba307` (agy hard-wrapped RC conversation-ID parse fix; live admission not yet proven).

**Critical boundary.** NAR `NarStore` in `N/core.ts` uses in-memory Maps; no production `native_ops`/`native_receipts` persistence was found in the inspected server/runner source. The opt-in OpenCode `nar-attempt.ts` invokes the HTTP driver directly and supplies a nominal fence; the HTTP driver does not enforce that fence. `log.synced` is a watermark, not evidence that the v2.2.5 public log exposes every inbox/execution event. A provider idle/outcome read is **not** a validated `finish`/`block` receipt (S §2.3).

## OpenCode GLM on Mac Pro (:19403)

| Capability | Status | Evidence / boundary |
|---|---|---|
| Admission | SHIPPED-UNPROVEN | `OC` attests v2.2.5 and submits a client-ID prompt; opt-in wired by `456e4f20f`. IC 'v7 OpenCode wiring' is legacy only. |
| Session identity | SHIPPED-UNPROVEN | `OC` derives `ses_` from agent/issue and reads back ID, cwd and model; no current NAR receipt in IC. |
| Durable op ids | SHIPPED-UNPROVEN | `nar-run-<runId>` maps to stable `msg_` ID and provider-side dedupe; there is no durable Core op row. |
| Receipt settlement | OPEN | `readOutcomeMsg` and `collectOutcome` settle via provider state, not an authenticated Core `finish`/`block` receipt. |
| One-writer | OPEN | `OC` ignores transport fence arguments; legacy shared-host leases do not establish this NAR path's authority. |
| Duplicate/stale/foreign refusal | OPEN | HTTP 409/message and cwd/model checks exist; no end-to-end stale lease/foreign writer refusal. |
| Unknown-effect handling | SHIPPED-UNPROVEN | Ambiguous submit is held; some exceptions during bind are labeled pre-submit, requiring crash-window audit. |
| Restart rejoin without replay | SHIPPED-UNPROVEN | `inflightMessage()` reuses a busy message without re-prompt (`e2771a59d`); no live restart NAR tuple in IC. |
| TUI co-presence in Herdr | SHIPPED-UNPROVEN | IC 'v7 OpenCode wiring' reports SCO-427 visible/steered in a legacy pane; not proof for NAR's same session. |
| Remote Control/phone | OPEN | Generic Herdr/Moshi visibility is not a verified OpenCode phone attachment (S §3.3, Q10). |
| Owner steer | SHIPPED-UNPROVEN | IC 'v7 OpenCode wiring' reports SCO-427 `MAYA-STEERED`, but lacks run+session+SHA receipt. |
| Usage reporting | SHIPPED-UNPROVEN | `OC/nar-attempt.ts` aggregates message tokens/cost; completeness and subscription accounting need live checks. |

## OpenCode DeepSeek on WRX80 (:19402)

| Capability | Status | Evidence / boundary |
|---|---|---|
| Admission | SHIPPED-UNPROVEN | Same opt-in `OC` HTTP path (`456e4f20f`); IC's managed SCO-421 run predates that path. |
| Session identity | SHIPPED-UNPROVEN | Deterministic `ses_` ID plus ID/cwd/model verification in `OC`; no qualifying NAR tuple in IC. |
| Durable op ids | SHIPPED-UNPROVEN | Stable `nar-run-<runId>`/`msg_` ID, but no persisted `native_ops` reservation. |
| Receipt settlement | OPEN | Completion projected from inbox, active, idle and outcome; does not validate an `N` Core receipt. |
| One-writer | OPEN | HTTP `submit` and `bindConversation` do not consume the passed fence; no NAR writer CAS. |
| Duplicate/stale/foreign refusal | OPEN | Duplicate prompt and mismatched session checks are partial; stale/foreign lease checks unintegrated. |
| Unknown-effect handling | SHIPPED-UNPROVEN | Ambiguous POST held; bind/create errors and incomplete public log are residual gaps. |
| Restart rejoin without replay | SHIPPED-UNPROVEN | In-flight session lookup and no-resend path shipped in `e2771a59d`; restart live proof absent from IC. |
| TUI co-presence in Herdr | SHIPPED-UNPROVEN | IC 'v4: OpenCode live visibility/steering PROVEN (DeepSeek); Herdr clean' reports legacy TUI view; no run/session tuple. |
| Remote Control/phone | OPEN | Herdr TUI and phone attachment are separate claims; native same-session phone path not receipted (S Q10). |
| Owner steer | SHIPPED-UNPROVEN | IC SCO-421 second-client `STEERED` evidence has no full qualifying run/session/SHA tuple. |
| Usage reporting | SHIPPED-UNPROVEN | `OC` reads assistant token/cost totals; successful complete NAR accounting not receipted in IC. |

## Claude Code (interactive Remote Control/channel target)

| Capability | Status | Evidence / boundary |
|---|---|---|
| Admission | SHIPPED-UNPROVEN | `C` channel bridge emits `notifications/claude/channel`; the current `claude-rc` adapter still types into tmux. S §4 probe is not an IC production receipt. |
| Session identity | SHIPPED-UNPROVEN | RC URL/name and conversation ID are observed by `claude-rc`; new-issue bind and same-URL rotation remain open (S Q1). |
| Durable op ids | SHIPPED-UNPROVEN | `C/lib/ledger.cjs` fsyncs an append-only op journal; no cross-run Core DB ledger binding. |
| Receipt settlement | SHIPPED-UNPROVEN | Channel `paperclip_finish`/`paperclip_block` and legacy file receipt are coded; dynamic run/lease validation not yet end-to-end. |
| One-writer | OPEN | Legacy adapter serializes pane dispatch, but persistent channel-to-lease writer authority is not implemented (S C5/C10). |
| Duplicate/stale/foreign refusal | OPEN | Channel duplicate op ID is refused locally; stale run, epoch and foreign sender checks remain incomplete. |
| Unknown-effect handling | SHIPPED-UNPROVEN | Bridge marks ambiguous restart pushes `held_unknown_effect`; no terminal can be inferred from Stop alone. |
| Restart rejoin without replay | SHIPPED-UNPROVEN | Same-issue legacy checkpoint adoption and S §4 `--resume` probe exist; production persistent-channel rebind lacks IC receipt. |
| TUI co-presence in Herdr | OPEN | tmux interactive adapter exists; exact Herdr-hosted native session with channel and same phone history not accepted. |
| Remote Control/phone | SHIPPED-UNPROVEN | RC launch and URL checks shipped; S §4 [L] phone probe lacks run/session/SHA tuple in IC. |
| Owner steer | SHIPPED-UNPROVEN | Channel hook parser labels owner input; no IC live managed turn/phone steering tuple. |
| Usage reporting | UNSUPPORTED | `claude-rc` reports `subscription/unpriced` without token totals; S Q13 remains open for future channel accounting. |

## agy (Antigravity CLI 1.4.x)

| Capability | Status | Evidence / boundary |
|---|---|---|
| Admission | SHIPPED-UNPROVEN | `A` tmux paste/Enter transport exists; no supported structured admission into the same live TUI (S §3.3). |
| Session identity | SHIPPED-UNPROVEN | `/remote-control` reads live conversation ID and `/new` verifies changed ID; `7880ba307` fixes hard-wrapped URL parsing after failed runs, with no new live bind receipt. |
| Durable op ids | UNSUPPORTED | A local active run checkpoint is not a provider-ingested, idempotent op ID for pane input. |
| Receipt settlement | SHIPPED-UNPROVEN | `A` checks file receipt run/issue IDs and report then publishes; no structured `block` or NAR Core receipt. |
| One-writer | SHIPPED-UNPROVEN | `acquire()` serializes one tmux host; this is not a provider-level fenced writer. |
| Duplicate/stale/foreign refusal | OPEN | Active checkpoint and RC-URL mismatch checks exist; complete op/epoch/foreign refusal does not. |
| Unknown-effect handling | SHIPPED-UNPROVEN | Same-issue active checkpoint is adopted, uncertain idle-without-receipt held; no blind re-paste on retry. |
| Restart rejoin without replay | SHIPPED-UNPROVEN | `adoptableActive` avoids same-issue redispatch while pane survives; resume after pane death is OPEN. |
| TUI co-presence in Herdr | OPEN | tmux interactive session shipped; Herdr per-agent host identity/owner co-presence not receipted in IC. |
| Remote Control/phone | SHIPPED-UNPROVEN | `agy --remote-control` and live URL read exist; phone side not proven by an IC tuple. |
| Owner steer | OPEN | Shared input/phone steering can collide; no verified owner-origin attribution or idle-five-minute guard. |
| Usage reporting | UNSUPPORTED | `A` reports `subscription/unpriced` and no per-run token totals (S Q13). |

## Codex (shared app-server)

| Capability | Status | Evidence / boundary |
|---|---|---|
| Admission | PROVEN-LIVE | **Legacy shared-daemon pilot only**: IC 'PILOT LIVE-PROVEN on the live service (Luna Low Runner Probe, SCO-406)': run **`d267452c`** (cursor prefix), session **`01a19a98`** (prefix), deployed SHA **`f5469e6a83e8`**; `PILOT-OK`. Not proof of v0.3. |
| Session identity | PROVEN-LIVE | **Legacy**: same IC 'PILOT LIVE-PROVEN ...' receipt: run **`d267452c`** (prefix), session/rollout **`01a19a98`** (prefix), SHA **`f5469e6a83e8`**; read-back connected run and thread. |
| Durable op ids | OPEN | Codex thread/turn IDs exist, but v0.3 `native_ops` reservations are not persisted. |
| Receipt settlement | SHIPPED-UNPROVEN | Managed run finalization and tool results shipped; no live v0.3 `native_receipts` validation against the new Core. |
| One-writer | SHIPPED-UNPROVEN | `X` has an issuer/writer check and exact-thread RPC policy; live competing-writer conformance not recorded. |
| Duplicate/stale/foreign refusal | SHIPPED-UNPROVEN | `X` refuses wrong thread, cwd/model/effort and unsupported RPCs; full negative triad not receipted. |
| Unknown-effect handling | SHIPPED-UNPROVEN | Existing shared-turn path journals ambiguous send before effect, holds reconciliation; no v0.3 crash-window live receipt. |
| Restart rejoin without replay | SHIPPED-UNPROVEN | `thread/resume` and prior second wake exist (IC 'LIVE: second wake on SCO-406'); in-flight v0.3 no-replay remains unproven. |
| TUI co-presence in Herdr | OPEN | Phone thread/view and daemon control do not prove the native Codex TUI displays the same concurrent thread in Herdr. |
| Remote Control/phone | OPEN | IC 'Owner: saw the pilot thread in Remote Control' is **owner-confirmed, not agent-confirmed** and lacks a complete run/session/SHA phone-view receipt. |
| Owner steer | PROVEN-LIVE | **Second-client steer, not phone steer**: IC 'v4: steer (e) + MCP absence (c) PROVEN' and preceding 'v4: concurrency + MCP disable LIVE': run **`7bd92230`** (prefix), thread **`01a19b04`** (prefix), payload SHA **`57737122a34e`**; `steer_accepted`, `DONE. STEERED`. |
| Usage reporting | SHIPPED-UNPROVEN | IC C1 canary has usage checkpoints and legacy pilot a subscription cost row (`0.00`); complete accurate run token/cost accounting not accepted (S Q13). |

## ChatGPT Web (manual Chat-mode handoff)

| Capability | Status | Evidence / boundary |
|---|---|---|
| Admission | UNSUPPORTED | S D6/N1 explicitly excludes an automatic native driver: manual copy/paste only. |
| Session identity | OPEN | Browser chat identity is not a Paperclip-attested provider conversation/epoch binding. |
| Durable op ids | UNSUPPORTED | No NAR provider op ID or automatic durable admission protocol in S. |
| Receipt settlement | UNSUPPORTED | Manual human reply/copy is outside `finish`/`block` Core receipt semantics. |
| One-writer | UNSUPPORTED | No native Paperclip one-writer lease for a browser session. |
| Duplicate/stale/foreign refusal | OPEN | Manual handoff markers, if any, require separate importer evidence; none qualifies in IC for this NAR matrix. |
| Unknown-effect handling | OPEN | Ambiguous manual send/import requires an explicit human reconciliation boundary, not an inferred loss. |
| Restart rejoin without replay | UNSUPPORTED | No native driver to attach/reconcile a pending browser prompt after controller restart. |
| TUI co-presence in Herdr | UNSUPPORTED | A browser chat is not a Herdr-native agent TUI. |
| Remote Control/phone | UNSUPPORTED | Normal ChatGPT phone/web access is not vendor Remote Control into a shared native-runner process. |
| Owner steer | OPEN | Manual chat input is possible, but same-session managed steering has no accepted NAR contract. |
| Usage reporting | UNSUPPORTED | No native run-scoped token/cost receipt from the manual browser path. |

## Acceptance risks and next evidence

1. **Canonical cursor absent.** Reconcile the packaged IC with the integration lead's current source, and preserve complete run/session IDs plus the exact tested/deployed SHA in future headings. No cell was promoted from the separate cloud-lead cursor or the spec's unbound `[L]` notes.
2. **NAR data plane incomplete.** Persist Core ops/receipts and enforce real lease/epoch fences; a fake conformance suite or provider-side `msg_` dedupe alone cannot prove exactly-once settlement.
3. **OpenCode events and lifecycle.** v2.2.5 returns only public `log.synced` watermarks; prove live state fallback and no-resend across restart, plus scoped pause/abort. `nar-attempt.ts` currently holds on `signal.aborted` without interrupting the provider.
4. **Native co-presence and usage.** Qualify same-thread TUI + phone/owner writes independently per runtime; verify completion authority and accurate usage. Codex further live tests await the **2026-11-05 ~02:04 PST** quota reset; do not use old pilot success as a current-quota guarantee.

**Status methodology:** `SHIPPED-UNPROVEN` means a concrete code path exists, not that it passed live acceptance. `OPEN` means required evidence or an essential part is missing. `UNSUPPORTED` applies only to an unavailable current native mechanism, not to the possibility of future implementation.
