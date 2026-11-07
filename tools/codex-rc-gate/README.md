# Opt-in Codex RC gate

This launcher is a cooperative admission layer for clients that resolve this
program through their agent PATH. It is not a system execution policy. The
absolute Homebrew path, managed release copies, another CODEX_HOME, and callers
connecting directly to an app-server remain outside its enforcement.

## Admission

The only Codex executable this gate invokes is /opt/homebrew/bin/codex. Homebrew
owns that file and its symlink. The gate never renames, copies, replaces, updates,
or relinks Codex.

Before forwarding an interactive or resume invocation, the gate runs the
read-only checker:

    /Volumes/NVM/AI_Agent_Runtime/bin/codex-rc-watch --check --home CODEX_HOME

The checker must return connected and the exact canonical Unix socket for that
home. Missing homes, sockets, checker binaries, malformed output, and any other
RC state refuse admission. The client receives an explicit unix://PATH endpoint;
it cannot use the unix:// shorthand to bootstrap a replacement daemon after the
check. This check never starts, stops, restarts, or updates a daemon.

All app-server and remote-control lifecycle commands, direct exec/review/queue
execution, embedded --no-daemon execution, and self-update are refused through
the gate. The RC watcher recovers an existing daemon in place. New automated lane
turns use standalone NAR. Ordinary help/version and non-agent management commands
continue to use Homebrew Codex.

## Limits

The check and the subsequent client connection are not one native transaction.
RC can disconnect after admission, and already-running turns are not interrupted.
Neither this program nor a watcher can prove that every session on a same-user
Mac is always RC-connected. The owner and agents both run as tech and can execute
the original binary or change user-owned files.

The gate is deliberately opt-in so the owner's terminal and ChatGPT.app's bundled
Codex retain their existing launch paths. User-owned file permissions and codesign
alone do not create a distinction between an owner process and an agent with the
same operating-system identity.

## Verification

    go test ./...

The tests cover argument refusals and socket-specific admission, including a
disabled/connecting daemon, a mismatched socket, a missing checker, and a relative
home. Live c31 evidence is retained under
/Volumes/NVM/AI_Agent_Runtime/tmp/c31. Those disposable probes contain no credentials
and never send turn/start; remove that scratch directory after acceptance if it
is no longer needed.
