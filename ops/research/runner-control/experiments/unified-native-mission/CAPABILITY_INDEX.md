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
| Restart rejoin without replay | PROVEN-LIVE | Tensor64 Runtime (GLM, agent `a4222e05`, `nativeRuntime: nar`), SCO-489, native session **`ses_65bbaab03e751251c917c690ec`** survived three deploys (00:33, 00:44, 01:09 PST; final payload `33739668c7a8`). Successor runs `1249b358`, `0d55944e` and **`529558ec-2280-4c76-8db3-1e768cf6c16a`** each logged `NAR rejoined in-flight message msg_98b7baf2…; prompt not resent`. Completion of owned work is still pending (SCO-489 in progress). |
| TUI co-presence in Herdr | PROVEN-LIVE (agent side) | 2026-11-03 01:23 PST: native `opencode --server :19403 --session ses_65bbaab03e751251c917c690ec` (pid 94843) runs in Herdr `sco337-native` tab `w1:t7`, opened by `herdr-opencode-panes.sh` from `/api/session/active`. Pane capture shows the Paperclip-driven SCO-489 turn live (`esc interrupt`, 37.5K context) while NAR run `529558ec` is running on the same session. Owner phone view (Moshi mirror) awaits owner confirmation. |
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
| Restart rejoin without replay | PROVEN-LIVE | Tensor64 Lead (DeepSeek, agent `bddd515a`, `nativeRuntime: nar`), SCO-488, native session **`ses_06179247e7e07fb9529543845f`** survived the same three deploys. Successor runs `6d2a9842`, `05ca1eff` and **`0da45b99-a908-4d45-a870-d92005d40fd3`** logged `NAR rejoined in-flight message msg_ec05215f…; prompt not resent`. SCO-488 is in progress. Separate SCO-396 run `d4f240a7` failed (`OpenCode session outcome: failed`); this is Tensor64's own lane. |
| TUI co-presence in Herdr | PROVEN-LIVE (agent side) | 2026-11-03 01:23 PST: native `opencode --server :19402 --session ses_06179247e7e07fb9529543845f` runs in Herdr `sco337-native` tab `w1:tC` (pane `w1:pC`), opened automatically once the session became active. Pane capture shows the Paperclip SCO-488 wake prompt and the live turn (`esc interrupt`) of NAR run `9ee7e813` on that same session. Owner phone view awaits owner confirmation. Precondition fix: the session read a PNG and the text-only DeepSeek server rejected every resend (`provider.invalid-request ... without the vision encoder`, runs `0da45b99`..`9e72a957`). The model is now declared `modalities.input=["text"]`, `attachment:false` in the backend config, reloaded in place via `POST /api/location/reload` (no restart, no revert). |
| Remote Control/phone | OPEN | Herdr TUI and phone attachment are separate claims; native same-session phone path not receipted (S Q10). |
| Owner steer | SHIPPED-UNPROVEN | IC SCO-421 second-client `STEERED` evidence has no full qualifying run/session/SHA tuple. |
| Usage reporting | SHIPPED-UNPROVEN | `OC` reads assistant token/cost totals; successful complete NAR accounting not receipted in IC. |

## Claude Code (interactive Remote Control/channel target)

Live update 2026-11-03 00:55 PST (cloud lead). Deployed payload **`569f89e25aea`**; agent `37c15613-2f74-454e-9794-5aa17782be7d`; IC heading '2026-11-03 … Claude Code (item 5) TUI-side co-presence PROVEN-LIVE on 569f89e25'.

| Capability | Status | Evidence / boundary |
|---|---|---|
| Admission | PROVEN-LIVE | Channel push `notifications/claude/channel` with op_id = run ID: run **`21094c57-b98d-4d63-9a92-235c74e9c455`** (SCO-490), bridge ledger stage `hook_observed`; no tmux typing. |
| Session identity | PROVEN-LIVE | Per-issue `/clear` gives a new conversation: SCO-490 → **`838310a7-14f1-4884-95ab-e3355ea80d19`**, SCO-487 → **`6dd7938a-c032-4e53-8f35-9e6800202413`**; same RC session. |
| Durable op ids | PROVEN-LIVE | fsynced bridge ledger keyed by run ID; duplicate op_id refused (`already exists`, unit-tested and ledger-enforced). No cross-run Core DB ledger (NAR store gap remains). |
| Receipt settlement | PROVEN-LIVE | `receipt-21094c57…json` status done → run succeeded, issue done (`issueClosed:true`). |
| One-writer | SHIPPED-UNPROVEN | Adapter `acquire()` serializes one tmux host; no lease/epoch writer fence. Steering-race conformance is out of scope (Amendment 1). |
| Duplicate/stale/foreign refusal | SHIPPED-UNPROVEN | Duplicate op refusal is live-enforced; stale/foreign checks are out of scope per Amendment 1. |
| Unknown-effect handling | PROVEN-LIVE | Run `86fb71c6` was held (misclassified inbox_pending, fixed in `569f89e25`); recovery hold `259b2519` was released only with ledger + receipt evidence (outcome false_positive). |
| Restart rejoin without replay | PROVEN-LIVE | Run **`707a6a09-4b08-49ac-bdee-1acd79b8b4a2`** adopted the `86fb71c6` checkpoint/receipt and sent no prompt (transcript `6dd7938a` untouched after 00:36). Deploy shutdown uses the `server_shutdown_rejoin` lane (`05e5f599c`, live). |
| TUI co-presence in Herdr | PROVEN-LIVE (agent side) | Native TUI `tmux -L pc-claude-rc` session `claude` shown in Herdr `sco337-native` w1:p8 (tab claude-rc) during both runs. Owner phone view: pending owner confirmation. |
| Remote Control/phone | SHIPPED-UNPROVEN | RC session `https://claude.ai/code/session_01QMN4wcQRS53LUMcwR9jkjv` pinned in `rc-url.json` (previous:null); owner confirms the phone view. |
| Owner steer | SHIPPED-UNPROVEN | The hook labels owner-origin prompts; awaiting owner phone/TUI steer. |
| Usage reporting | UNSUPPORTED | Vendor limit: the subscription TUI exposes no per-run token totals to the adapter; reported as `subscription/unpriced`. |

## agy (Antigravity CLI 1.4.x)

Live update 2026-11-03 01:16 PST (cloud lead). Agent `4a180a05-e7a4-48f7-8610-190d38f9fdd5`, one persistent TUI `tmux -L pc-agy-exp` session `agy` (Herdr p5), RC URL `https://antigravity.google.com/r/3649148d-fcbc-4129-a4ea-e64933637e78-v2` unchanged across both issues. SCO-491 on payload `569f89e25aea`; SCO-492 on payload **`33739668c7a8`** (stale-idle guard fix). IC heading '2026-11-03 … agy (item 6) re-proven on the new runtime'.

| Capability | Status | Evidence / boundary |
|---|---|---|
| Admission | PROVEN-LIVE | Typed only into an empty editor (Amendment 1): SCO-491 run **`3993475f-e22d-45fd-951c-4f3925325a69`**; SCO-492 run **`1bf933e6-1c21-4810-a25b-d7d772059b34`** was admitted on a stale idle statusLine plus an empty editor that stayed the same across two captures (`STALE_IDLE`, `33739668c`). Before the fix, runs `258cf1d6`/`fd902e96`/`7a4d3a1f` were refused, which was safe but unlive. |
| Session identity | PROVEN-LIVE | `/new` per issue with read-back: SCO-491 → **`32331df0-9a7c-496d-a335-f2dd15aacd06`**, SCO-492 → **`5a9ecbce-eb84-471c-8280-26744e9d446b`**; same RC URL. |
| Durable op ids | UNSUPPORTED | Pane input has no provider-ingested idempotent op ID; the run-ID-keyed `active.json` checkpoint and `receipt-<runId>.json` stand in at the adapter boundary. |
| Receipt settlement | PROVEN-LIVE | `receipt-3993475f…json` and `receipt-1bf933e6…json` matched the exact run and issue; report published; both issues done. |
| One-writer | SHIPPED-UNPROVEN | `acquire()` serializes one tmux host; steering-race conformance is out of scope (Amendment 1). |
| Duplicate/stale/foreign refusal | SHIPPED-UNPROVEN | A different-issue checkpoint throws; a stale checkpoint (`ebcf8e1d`, SCO-486 done) blocked dispatch until it was archived. The full triad is out of scope (Amendment 1). |
| Unknown-effect handling | PROVEN-LIVE | Cancel of `1bf933e6` mid-turn → watchdog `0c1ecb63` recorded `replay: blocked`, `actionOutcome: unknown`; it was released only with checkpoint plus receipt evidence. |
| Restart rejoin without replay | PROVEN-LIVE | Successor run **`4d770cf4-e5f7-4cec-afad-8dba4b5661d2`** logged `Adopting dispatched run 1bf933e6…; no re-dispatch`. The pane's SCO-492 mention count was 6 before and after (no re-paste); it settled the original receipt and SCO-492 is done. Resume after pane death: OPEN. |
| TUI co-presence in Herdr | PROVEN-LIVE (agent side) | The same TUI is shown in Herdr p5 throughout both runs; the controller and the typed steer share one conversation. The owner phone view awaits owner confirmation. |
| Remote Control/phone | SHIPPED-UNPROVEN | `agy --remote-control` URL pinned in `rc-url.json` and unchanged; the owner confirms the phone view. |
| Owner steer | PROVEN-LIVE (TUI) | A mid-run steer typed into the same TUI during SCO-491 ("put … OWNER-STEER-491 in the receipt summary") was obeyed: the receipt summary contains `OWNER-STEER-491`. It was typed by the lead as a stand-in for the owner; an owner-phone steer is pending. |
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
| Duplicate/stale/foreign refusal | PROVEN-LIVE | `chatgpt-handoff.mjs` (`33739668c`), SCO-493: handoff `7e790b93-c43b-4504-9dea-680af2874df1` was pasted in Chat mode (`https://chatgpt.com/c/6ae9a276-6efc-83e8-8bca-2e5203f9d13e`) and the reply was imported and **accepted** (sha256 `7adcc60c…`). Rejected with exit 3 and logged in `ledger.rejections`: the same reply again (**duplicate**), the superseded h1 `7bc77eed` marker (**stale**), an `evil.example` URL and a marker naming SCO-337 (**wrong-origin**). |
| Unknown-effect handling | SHIPPED-UNPROVEN | `chatgpt-beta-run send` refuses a resend via an O_EXCL marker, and the import accepts each handoff once. A human reconciles any ambiguous manual send. |
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
