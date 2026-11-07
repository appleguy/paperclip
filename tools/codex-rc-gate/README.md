# Opt-in Codex agent gate

This launcher is a cooperative boundary for clients that resolve this program
through their agent PATH. It is not a system execution policy. Absolute Homebrew
paths, managed release copies, another CODEX_HOME, and direct app-server clients
remain outside its enforcement.

## Admission

The gate refuses every native agent invocation, including bare interactive
starts, prompts, resume, fork, agents, exec, app-server, remote-control lifecycle,
self-update, embedded --no-daemon, and unknown future commands. Its only pass-through
commands are exact help/version forms and completion for a known shell.
Callers must use standalone NAR for new agent turns.

NAR checks RC on its existing WebSocket before thread/start and turn/start.
The RC watcher repairs an already-running disabled daemon in place. Neither the
gate nor the NAR launcher starts, stops, restarts, or updates a Codex daemon.

The only Codex executable this gate invokes for help/version/completion is
/opt/homebrew/bin/codex. Homebrew owns that file and its symlink. The gate never
renames, copies, replaces, updates, or relinks Codex. Brew upgrades need no gate
re-link; future commands remain refused until explicitly reviewed.

## Limits

The owner and agents both run as tech and can execute the original binary or
change user-owned files. The gate is deliberately opt-in so the owner's terminal
and ChatGPT.app's bundled Codex retain their existing launch paths. Running
sessions are not changed. User-owned permissions and codesign alone do not
distinguish an owner process from an agent with the same operating-system identity.

NAR's RC check and request are not one native server transaction. RC can disconnect
after admission, and already-running turns are not interrupted. Neither this
program nor a watcher proves that every session on the Mac is always RC-connected.

## Verification

    go test ./...

The final tests cover the tiny read-only allowlist and rejection of all agent,
lifecycle, embedded, unknown, and help-suffix paths. The focused new policy test
failed before tightening with nine native start forms accepted (including bare
interactive, resume, fork, agents, and an unknown command), then passed.

Live c31 evidence is retained under /Volumes/NVM/AI_Agent_Runtime/tmp/c31.
Disposable non-RC probes contain no credentials and never send turn/start.
