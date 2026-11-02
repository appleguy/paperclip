# SCO-337 Block 3: Paperclip dispatch to one Antigravity Remote Control instance

Date: 2026-11-02 (US Pacific)
Owner intent: Paperclip assigns independent issues to Gemini 3.8 Flash Low through agy 1.4.12 on the Mac Pro. The owner sees every thread and can steer it from **one** stable Remote Control URL, without paying for additional inference or consuming Claude/GPT agy capacity.

## Decision and tested behavior

**Use one long-lived interactive `agy --remote-control` process in one dedicated tmux pane.** That single agy process supports many sequential conversations under its stable Remote Control instance; `/new` creates a new conversation while the `/r/<instance>` URL stays unchanged. Current implementation intentionally **serializes** all Paperclip tasks, so there is only one active agy conversation at once. This proves one URL and many independent task conversations, **not** parallel execution of many tasks by one TUI.

Scratch workspace: `/Volumes/NVM/Paperclip/tmp/agy-rc-paperclip-scratch`, own tmux socket `pc-agy-exp`, session `agy`. The process is deliberately separate from the owner's pre-existing agy Remote Control session and is the only session used by this adapter. In the scratch experiment, `agy --version` returned `1.4.12`; `agy models` listed `gemini-3.8-flash-low`. Initially the folder required an explicit trusted-folder confirmation; it was approved only for the scratch workspace.

**Direct observations:**

| Test | Result | Evidence |
| --- | --- | --- |
| Interactive RC start | PASS | TUI showed `Remote control on for this session` and stable `https://antigravity.google.com/r/<private-instance-id>` |
| Prompt from interactive pane | PASS | Exact response `AGY_TMUX_TASK_ONE_518` |
| New task conversation | PASS | `/new` changed the workspace's `last_conversations.json` ID; a question about prior-turn token answered `NEW_ISOLATED_519`, not the prior token |
| RC URL continuity | PASS | `/remote-control` after `/new` gave the same base `/r/fb274ae1-...` with a new `?p=c%2F<conversation>` suffix |
| File tool writes for completion | PASS | Live `write_to_file` created `agy-write-probe.json` with `{\"hello\":\"AGY_TOOL_OK_20261102\"}` under scratch workspace |
| Headless stream-json | PASS for a one-off turn | Separate `agy --print --output-format stream-json` returned `status: SUCCESS`, exact `AGY_PROBE_A_417`, conversation ID `8ce2fdf3-77e9-44ce-a31c-a896b4a9ab1f`, no shared TUI RC |
| Daemon | NOT suitable / not tested for injection | `agy remote-control status` was `not running`; `start` merely registers daemon and no documented command queues prompts into a chosen daemon conversation |
| Embedded newline with tmux paste | FAIL (corrected) | Multiline `paste-buffer` submitted only the first line prematurely. Adapter collapses line breaks and whitespace before one paste/Enter |
| Adapter unit tests | PASS | `vitest run server/src/adapters/agy/execute.test.ts`, 4/4 |
| Adapter-specific TypeScript diagnostics | PASS (scoped), full build BLOCKED | `tsc -p server/tsconfig.build.json --noEmit`: zero errors under `server/src/adapters/agy/`; five pre-existing unrelated `environment-runtime`, `environment-task-runtime`, `sandbox-creation-operations` type errors remain |

The headless `--input-format stream-json` protocol reads multiple NDJSON messages as **turns in one conversation**, not many session-addressed conversations; it cannot give Paperclip one live interactive TUI to supervise. A per-task `agy --print --conversation <id>` is also not a transparent way to inject into a running interactive RC pane. A separate daemon start risks creating an unrelated owner-visible entry point rather than sharing the same conversation. The tmux-pane approach matches the observed UI and has no reverse-engineered private agy RPCs.

## Implemented adapter

`agy_local` is a built-in legacy Paperclip adapter. Its execution path is:

1. Read task issue ID / run ID from Paperclip-owned context. Require Mac Pro local execution, hard-allow only `gemini-3.8-flash-low`.
2. Acquire a private filesystem mutex to serialize dispatch. Reuse a fixed tmux session or launch `/opt/homebrew/bin/agy --remote-control --dangerously-skip-permissions --model gemini-3.8-flash-low`. Reject non-agy panes, trust prompts, non-idle sessions and unexpected Remote Control URLs.
3. Send `/new` to isolate the task conversation; compose task markdown, run and issue identifiers, saved instructions, and explicit receipt contract as **one** literal terminal line. The TUI executes visibly on the same instance and can be steered in Remote Control. Capture the conversation ID from agy's own workspace-scoped cache after completion.
4. Maintain a private `active.json` checkpoint. Require the agent to finish actual work and then create a JSON receipt with matching `runId`, `issueId`, `status: done`, summary and report body of at least 250 characters. Never interpret merely closing the terminal as task completion.
5. **Inside the server adapter only**, use the run-scoped Paperclip token, not shared with agy, to PUT `/api/issues/:id/documents/report` then PATCH issue status to `done`. Only after both succeed clear the active checkpoint and return success and RC URL as run metadata.
6. On interrupted/ambiguous outcomes, leave the checkpoint and issue unresolved. A subsequent run fails closed instead of replaying previously executed tool actions. Reconciliation requires inspecting the original agy conversation and existing Paperclip issue/report before clearing the checkpoint.

**Source file list:**
- `server/src/adapters/agy/execute.ts`: tmux/TUI transport, serialized receipt-aware execution and scoped finalization.
- `server/src/adapters/agy/index.ts`: adapter registration, schema, model allowlist and prerequisite probe.
- `server/src/adapters/agy/execute.test.ts`: protocol and failure checks.
- `server/src/adapters/registry.ts`: register built-in.
- `server/src/adapters/builtin-adapter-types.ts`: reserve type.
- `packages/shared/src/constants.ts`: expose adapter type.
- `docs/agy-adapter-design.md`: tracked research, design and evidence. Mirrored to canonical `/Volumes/NVM/Paperclip/ops/research/runner-control/agy-adapter-design.md`.

**Config for validated scratch TUI:** `{ "model":"gemini-3.8-flash-low", "cwd":"/Volumes/NVM/Paperclip/tmp/agy-rc-paperclip-scratch", "tmuxSocket":"pc-agy-exp", "tmuxSession":"agy", "stateDir":"/Volumes/NVM/Paperclip/tmp/agy-rc-paperclip-scratch/.paperclip-adapter-state", "expectedRemoteControlUrl":"https://antigravity.google.com/r/<private-instance-id>", "timeoutSec":600 }`. Production should prefer a separately owned workspace and process rather than reusing the scratch test unless migrating owner-live links intentionally.

## Important boundaries and risks

- **Single process means serial execution**. Independent conversation histories share the same filesystem workspace and potentially auth/plugin global state. Task-specific workspaces, long-term context compaction, parallel task processing and per-task user access are future features, not proven here. No concurrent sends, no silently overriding live steering.
- **Textual TUI is an unstable integration contract**. Screen readiness and prompts can change between versions. Upgrade agy only with a fresh regression. The adapter fails closed on an unrecognized TUI or changed URL. Wrap risk: tmux paste of literal multi-line text can cause partial prompts; production flattens each prompt.
- **Steering is user-visible but shared**, not a second agent process: typing into the RC while Paperclip dispatches another task can overlap. A one-writer lease, owner-visible active issue label and an explicit mid-turn steering acceptance test are still recommended.
- **Crash/restart**: Paperclip process can restart while agy continues in tmux. `active.json` intentionally prevents duplicate work, but currently requires an operator to reconcile an interrupted issue. This is conservative safe continuation, not automatic restart recovery.
- **Agent auth never enters the TUI**. Its output receipt is untrusted until verified against exact issue/run IDs. Finalization still requires Paperclip permission checks; 401/403/404 or stale checkout leave the checkpoint and task unresolved.
- **Observability/accounting**: the live TUI supplies visible tool activity and conversation history, but no structured per-turn agy usage receipt to Paperclip; returns unpriced subscription accounting, not invented token/cost estimates. The app is logged into an existing Google AI Pro subscription. No paid API key is introduced.
- **Permissions and model guard**: `--dangerously-skip-permissions` is explicitly owner-authorized only for a dedicated scratch workspace; there is real risk of broader local file writes. Constrain agent instructions and don't supply privileged secrets. The adapter fails if the config selects Claude, GPT or another model.
- **Data retention**: report receipts and the RC link are in private local state; completed receipts should be culled after seven days (preserve unresolved checkpoints). Do not archive raw TUI logs or secrets to Git.
- **Remote Control audience**: the URL and conversation are tied to the signed-in Google account. A URL is not authentication; test user browser access separately.

## Deployment and acceptance

Implementation owner: Block 3, not the SCO-337 Sonnet integration lead. Existing Sonnet lead remains integration authority. Commit only the paths above with `pc-ship`; after commit deploy via `pc-deploy` per the owner's revised Block 3 instruction. The acceptance criterion is a real SCO issue assigned to an `agy_local` agent, same RC instance, model Gemini 3.8 Flash Low, report document present and issue closed. Record the exact commit and issue identifier below after verification.

**Live acceptance receipt:** pending.
