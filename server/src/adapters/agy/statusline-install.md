# agy status line: install note

This adapter deliberately does **not** edit `~/.gemini/antigravity-cli/settings.json`.
The operator must merge **only** the `statusLine` object from
`statusline.settings.template.json` into that existing settings file, retaining
all unrelated settings. Do not replace the entire settings file.

- The command runs `statusline.cjs` using Node. It reads the official agy
  `statusLine` JSON payload on stdin and atomically writes only
  `agentState`, `observedAt`, `idleSince`, `conversationId`, `cwd`,
  `pendingInputCount`, `toolConfirmationPending` and `contextTokens` to a private
  `status-line.json` (mode 0600) in that agent's `stateDir` (mode 0700).
- Set the first argument to **that agent's** absolute `stateDir/status-line.json`
  and the second to the exact absolute `cwd` configured in Paperclip.
  The template uses the adapter's Mac Pro defaults. If agents have different
  state directories, each dedicated agy instance must route to its own file;
  this single-path template is intended for one persistent TUI.
- agy's `statusLine.command` is a global CLI setting. The helper ignores
  snapshots from a different `cwd`. It adds a visible status indicator while
  keeping the built-in footer (`stack_with_default`). Do not install a
  conflicting status-line command.
- The status file supplies context usage for the 200k compaction threshold;
  its state, age and presence do not authorize or block dispatch. Immediately
  before each paste, the adapter checks only the current `>` editor for text.
  Busy turns and queued work are eligible with an empty editor, including when
  a running-task strip appears beneath it. Half-typed, wrapped or unrecognizable
  editors are refused once, without waiting for idle. No screen scrape is a
  perfect ownership lock against simultaneous phone typing.
- After an operator explicitly installs this template, validate it with a
  harmless idle TUI and inspect that agent's status-line.json. The operator
  owns any agy restart needed to apply settings. This implementation does
  **not** restart, send to, or modify an existing agy session.

Schema reference: https://antigravity.google/docs/cli/statusline/ .
The command receives `agent_state` as one of idle / working / tool_use /
reviewing / authenticating / initializing / error and an optional
`conversation_id`. These fields are diagnostic, not delivery gates.

Status-line callbacks happen on state changes, not guaranteed heartbeats.
The adapter never waits for idle, clears the live conversation before a wake,
or requires a status callback to finish. A validated run/issue-scoped receipt
completes the run even while the TUI continues working or its editor contains
text. Missing receipts retain the active checkpoint; an empty editor alone
does not prove interrupted work has ended and must not trigger redispatch.

The live agy 1.5.1 probe for [SCO-948](/SCO/issues/SCO-948) submitted a wake
while `Working...` / `esc to cancel` were visible and the editor was empty.
agy queued the wake after the current response and wrote its requested receipt.
This is native busy-input delivery; Paperclip still permits only one adapter
run per agent. Keep transport graded `emitted_local` until receipt validation.

## Several agy_local agents

statusLine is one global agy setting. List every agent's `ABSOLUTE_STATE_FILE ABSOLUTE_AGY_CWD` pair
after the script path (state file is `<stateDir>/status-line.json`); the snapshot is written to the pair
whose cwd matches the TUI. Agents sharing a cwd share the first matching pair, so give each its own cwd.
