# agy status-line input guard: install note

This adapter deliberately does **not** edit `~/.gemini/antigravity-cli/settings.json`.
The operator must merge **only** the `statusLine` object from
`statusline.settings.template.json` into that existing settings file, retaining
all unrelated settings. Do not replace the entire settings file.

- The command runs `statusline.cjs` using Node. It reads the official agy
  `statusLine` JSON payload on stdin and atomically writes only
  `agentState`, `observedAt`, `idleSince`, `conversationId`, `cwd`,
  `pendingInputCount` and `toolConfirmationPending` to a private
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
- The adapter fails closed if the status file is missing, not idle, does not
  match the cwd or expected conversation, or has a stale idle signal younger
  than five minutes. It additionally requires a visibly empty `>` input box
  in tmux immediately before any paste. Busy and half-typed screens are never
  eligible, including after five minutes. No screen scrape is a perfect
  ownership lock against simultaneous phone typing.
- After an operator explicitly installs this template, validate it with a
  harmless idle TUI and inspect that agent's status-line.json. The operator
  owns any agy restart needed to apply settings. This implementation does
  **not** restart, send to, or modify an existing agy session.

Schema reference: https://antigravity.google/docs/cli/statusline/ .
The command receives `agent_state` as one of idle / working / tool_use /
reviewing / authenticating / initializing / error and an optional
`conversation_id`. Unrecognized states do not authorize input.

Status-line callbacks happen on state changes, not guaranteed heartbeats. An
idle state older than five minutes can be admitted **only** with an empty input
box and no visible busy marker. If the callback fails without updating the
state file, that remains a legacy-TUI uncertainty: monitor stale callbacks and
keep the provider graded `emitted_local`, not acknowledged.
