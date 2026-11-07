# Codex RC watcher and read-only admission check

Implemented and verified on Scott's Mac Pro on 2026-11-06 local time
(2026-11-07 UTC). This is a restorative user-level service. It does not prevent
arbitrary direct Codex execution, and it cannot make RC admission atomic with
a later thread start. The separate opt-in gate consumes its read-only check.

## Contract

`codex-rc-watch --check --home /absolute/CODEX_HOME` performs only
`initialize`, the `initialized` notification, and
`remoteControl/status/read` against the existing control socket.
It writes one JSON object to stdout and exits 0 only for exact `connected`:

```json
{"status":"connected","socket_path":"/canonical/socket/path"}
```

All other states and connection/protocol errors exit nonzero. Diagnostics are
fixed error classes, not server messages. Socket symlinks are resolved before
dialing, matching the native client's long-path indirection on macOS. The checker
does not write settings, logs, thread data, or start a daemon.

`codex-rc-watch --config /absolute/config.json` monitors the explicit homes in
`config.example.json`. Every pass opens each existing socket, initializes a
control connection, and reads RC status. Only exact `disabled` triggers
`remoteControl/enable {"ephemeral":true}` on that same connection. It then
waits up to approximately ten seconds, plus an RPC timeout, for `connected`.
A socket closing during the operation fails the attempt; it does not reconnect
and send an enable to a replacement server.

- `connected`: quiet, no mutation.
- Missing socket or refused Unix connection: quiet, no daemon start.
- `disabled`: enable in place, report one exception with the resulting state.
- `connecting` or `errored`: report a deduplicated exception, do not enable.
- Malformed responses, unknown states, handshake failures, permission errors:
  fail closed for checks and report an exception for the watcher.

`--once --config ...` runs one watcher pass and **may enable disabled RC**.
It is not a read-only status command. Exit 0 means the pass completed; inspect
the exception log for daemon-level outcomes. Use `--check` for admission.

No executable subprocess, signal to another process, daemon lifecycle command,
model invocation, thread mutation, auth-file read, or network TCP dial exists in
the implementation. The only transport is Unix-domain WebSocket. Frames and
messages are bounded to 1 MiB, HTTP upgrade headers to 8 KiB, RPC waits have
deadlines, and notification/frame loops have limits.

## Persistence and limitations

The repair uses `ephemeral:true`: native daemon preferences remain untouched.
If a home already saves `remoteControlEnabled:true`, native startup may restore
RC; the watcher covers an observed disabled controller after a restart. If saved
enablement is false, the watcher will repair each detected disabled start in
memory and report that exception. It does not silently rewrite owner settings.

The poll interval defaults to 15 seconds. There is a detection window after a
restart or disconnection. The watcher cannot guarantee that an arbitrary client
will refuse to start a turn during that window, after a check, or after the
controller loses connectivity mid-turn. It covers only the configured homes and
runs while this user's launchd session is active. Same-user code can bypass or
modify this service. Unknown homes and alternate binaries remain outside this
watcher's coverage.

`exceptions.jsonl` holds changes in exception state, deduplicated in memory per
home. Healthy/absent homes produce no log entry. Rotation retains the current
file and one `.1` generation, each normally at most 1 MiB. The cache is bounded
by the configuration's maximum of 32 homes. `launchd-errors.log` records fixed
startup/configuration/storage errors and rotates at 64 KiB with one generation.
A failing log filesystem can prevent durable reporting; stderr remains the
fallback. No periodic healthy output is written.

## Install boundary

Build and test from this directory:

```sh
TMPDIR=/Volumes/NVM/AI_Agent_Runtime/tmp go test -v ./...
go build -o /Volumes/NVM/AI_Agent_Runtime/tmp/c31-codex-rc-watch .
plutil -lint local.scott.codex-rc-watch.plist
```

The coordinator installs the reviewed binary at
`/Volumes/NVM/AI_Agent_Runtime/bin/codex-rc-watch`, a copy of the config at
`/Volumes/NVM/AI_Agent_Runtime/codex-rc-watch/config.json`, and the plist at
`/Users/tech/Library/LaunchAgents/local.scott.codex-rc-watch.plist`.
The runtime directory must exist and be writable by tech. Existing non-git
files must be backed up with the exact suffix `.before-20261106-c31` before
replacement. The watcher implementation agent did not install or load the job.

The existing `com.scott.codex-remote-control.plist` runs the Homebrew
`remote-control start --json` command at login. It is a distinct bootstrap
mechanism, observed read-only and unchanged by this code. This watcher never
invokes it or any native start/restart command.

Disable the watcher without touching any Codex daemon:

```sh
launchctl bootout gui/$(id -u)/local.scott.codex-rc-watch
```

Restore a replaced config or plist using its `.before-20261106-c31` backup;
if newly created, remove it after bootout. Do not remove the installed checker
while the gate references it unless intentionally accepting fail-closed refusals.

## Primary source basis

Pinned upstream tag: `rust-v0.167.0`, commit
`086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a`. Retrieved 2026-11-07 UTC.

- [Protocol status and enable types](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server-protocol/src/protocol/v2/remote_control.rs):
  `disabled`, `connecting`, `connected`, `errored`; enable's `ephemeral`.
- [Native daemon Unix WebSocket client](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server-daemon/src/client.rs):
  Unix stream, `ws://localhost/`, initialize with experimental capability.
- [Native RC client](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server-daemon/src/remote_control_client.rs):
  initialized notification, status/enable RPC, bounded readiness wait.
- [RC request processor](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server/src/request_processors/remote_control_processor.rs):
  ephemeral enable changes the existing controller; persistent enable also saves
  daemon preference. No lifecycle command is required for this RPC.
- [Managed daemon documentation](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server-daemon/README.md):
  managed startup, saved settings and update lifecycle. Native CLI lifecycle
  helpers are deliberately outside this watcher's call surface.

## Verification evidence

Initial suite: seven of eight top-level tests passed. The rotation fixture used
a 200-byte limit; its two records fit below that limit, so the expected rotated
file was absent:

```text
=== RUN   TestExceptionsDeduplicateAndRotate
    main_test.go:321: rotation failed: open /Volumes/NVM/AI_Agent_Runtime/tmp/rcw-1272796689/exceptions.jsonl.1: no such file or directory
--- FAIL: TestExceptionsDeduplicateAndRotate (0.00s)
FAIL
FAIL paperclip.local/codex-rc-watch 0.125s
```

The fixture limit was corrected to 150 bytes; implementation behavior did not
change for that failure. The subsequent suite passed all eight tests, then a
ninth startup-error visibility/rotation test was added. The final test output is
recorded by the coordinator. Tests cover read-only check success/refusal, same
connection recovery through connecting, healthy silence, absent daemon silence,
a daemon close race, non-disabled/unknown states, ping/fragmentation, deduplication
and rotation, and startup failures. These use local fake WebSocket servers;
they do not establish live recovery proof.

Live **read-only** checks returned connected for both existing homes:

```json
{"status":"connected","socket_path":"/private/tmp/codex-daemon-501/e205018e9fe6b3d498076268d7ed8b19a314224c442c214900d6939df77b13ee"}
{"status":"connected","socket_path":"/private/tmp/codex-daemon-501/b9fed031ed6d2368fc8d4d121c0e49628afad7bb8ddcd927f0320da5368fa4b0"}
```

The first is the owner home (observed server 0.166.0); the second is the lead
zero home (0.167.0). The checker imposes no exact server-version requirement.
The instance home was reported absent by the coordinator and is configured
for observation without starting it.

Live disabled recovery is **unverified**: no live daemon was disabled or
restarted to manufacture a failure, and this implementation agent never sent
a live enable request. Thread-list/phone visibility proof belongs to the
coordinator's NAR verification; this checker does not query or expose threads.

## c34 Codex path lock (best effort)

The lead accepted the same-user bypasses and races: this is not an exec security
boundary. The PATH shim only permits a zero-home interactive attach; the linked
Homebrew cask binary and selected `~/.codex/packages/**/bin/codex` files have
execute bits removed. The approved copy is directly executable and can itself
be bypassed. A 500 ms polling watcher logs newly observed Codex processes and
available ancestor chains, and SIGTERMs identified unapproved app-servers.
It misses fast, renamed and otherwise unidentifiable launches and cannot recover
an ancestor which exited before the snapshot. It does not interrupt turns.

Installed user LaunchAgents: `local.scott.codex-path-lock` (watcher),
`local.scott.codex-path-lock-files` (package modes), and
`local.scott.codex-path-lock-brew` (Homebrew reapply). Logs and inode-checked
journals are under `/Volumes/NVM/Paperclip/workspaces/platform-lead-outside/lanes/c34-codex-path-lock`.
To roll back, stop all three first, then restore recorded modes and the shim:

```sh
launchctl bootout gui/501/local.scott.codex-path-lock
launchctl bootout gui/501/local.scott.codex-path-lock-files
launchctl bootout gui/501/local.scott.codex-path-lock-brew
cd /Volumes/NVM/Paperclip/master/tools/codex-rc-watch
L=/Volumes/NVM/Paperclip/workspaces/platform-lead-outside/lanes/c34-codex-path-lock
go run ./cmd/path-lock-files --restore --journal "$L/brew-modes.jsonl"
go run ./cmd/path-lock-files --restore --journal "$L/package-auto-modes.jsonl"
go run ./cmd/path-lock-files --restore --journal "$L/package-modes.jsonl"
cp -p codex-shim.sh.before-20261106-c34 codex-shim.sh
```

Restore stops on missing or changed inodes: inspect the journal and current
files, do not force a restore onto a different file. Preserve all backups. A
previous c33 LaunchAgent (`local.scott.codex-rc-watch`) is separate; do not
stop it as part of this rollback.

### Maintenance-window real cask test (not yet run)

Only after an explicit maintenance window and with active work protected:
record `brew list --cask --versions codex`, `readlink /opt/homebrew/bin/codex`,
and `stat` of its target, the approved copy version, and A PID/version. Stop
only the brew reapply agent, and restore its original mode using the exact
inode-checked brew journal command above; **stop on an inode mismatch** and
inspect rather than forcing. Then run `brew reinstall --cask codex` (or, when
actually outdated, `brew upgrade --cask codex`), retaining its output and
exit status. Cask completion generation may need the executable during this
operation; the guard's brew detection and relink checks have races.

After brew finishes, record the new link, target mode and version. Bootstrap
`~/Library/LaunchAgents/local.scott.codex-path-lock-brew.plist` in `gui/501`,
wait at least 10 seconds, inspect `brew-errors.log` and `brew-modes.jsonl`,
then verify the direct Homebrew path returns permission denied and the approved
copy reports the new version. Verify A is still running and no unapproved
app-server remains. If brew or reapply fails, boot out the brew agent and
restore the current target's recorded pre-lock mode only after checking its
current device/inode against its journal entry; old journal entries may refer
to replaced cask files, so the bulk restore can stop before reaching the new
entry. Preserve logs and report failure. To abandon the test entirely, use the
full rollback above, resolving replaced inodes manually first.

### Manual A repin after an upgrade

Do **not** automatically restart, update, repin or interrupt A or its threads.
During a separately authorized maintenance window, with all work checkpointed
and an explicit decision that interruption is acceptable, the operator can
review `codex-approved-c34 app-server daemon update --help` and run
`CODEX_HOME=/Volumes/NVM/Paperclip/workspaces/platform-lead-outside/context/codex-home /Volumes/NVM/AI_Agent_Runtime/bin/codex-approved-c34 app-server daemon update --from-cli`
using the reviewed Homebrew-derived approved copy. This may interrupt work;
verify A's version and remote-control status afterwards. No such update or
restart was performed by c34.
