#!/bin/sh
# pc-deploy. Canonical source for /Volumes/NVM/Paperclip/bin/pc-deploy.
# Single-flight, process-verified deploy, admission fence, upstream hot restart
# (running runs are re-entered by the new server, never drained or paused),
# health-verified rollback. No manual steps.
set -eu
# Leave the launching agent's session and pipes before doing any deploy work.
# The waiting parent reports the child's status; if it is reaped, the detached
# child continues with its output in a private log.
if [ "${PC_DEPLOY_DETACHED:-}" != 1 ]; then
  exec /usr/bin/perl -MPOSIX -e '
    my $pid = fork(); defined($pid) or die "pc-deploy: fork: $!\n";
    if ($pid) {
      my $log = "/Volumes/NVM/AI_Agent_Runtime/tmp/pc-deploy-detached-$pid.log";
      print STDERR "pc-deploy: detached log $log\n";
      waitpid($pid, 0); my $status = $?;
      if (open(my $out, "<", $log)) { while (my $line = <$out>) { print $line; } }
      exit($status & 127 ? 128 + ($status & 127) : $status >> 8);
    }
    POSIX::setsid() >= 0 or die "pc-deploy: setsid: $!\n";
    my $log = "/Volumes/NVM/AI_Agent_Runtime/tmp/pc-deploy-detached-$$.log";
    umask 0077;
    open(STDIN, "<", "/dev/null") or die "pc-deploy: stdin: $!\n";
    open(STDOUT, ">", $log) or die "pc-deploy: log: $!\n";
    open(STDERR, ">&STDOUT") or die "pc-deploy: stderr: $!\n";
    $ENV{PC_DEPLOY_DETACHED} = 1;
    exec "/bin/sh", @ARGV or die "pc-deploy: exec: $!\n";
  ' "$0" "$@"
fi
# Self-copy: sh reads a script incrementally, so rewriting this file while a
# deploy runs corrupts it mid-run (SCO-649 incident). Run from a private copy;
# edit this file only by write-to-temp + mv.
if [ -z "${PC_DEPLOY_COPY:-}" ]; then
  _t=/Volumes/NVM/AI_Agent_Runtime/tmp
  mkdir -p "$_t"
  find "$_t" -maxdepth 1 -name 'pc-deploy-run.*' -mtime +1 -exec rm -f {} + 2>/dev/null || :
  _c=$(mktemp "$_t/pc-deploy-run.XXXXXX")
  cat "$0" > "$_c"
  PC_DEPLOY_COPY=$_c
  export PC_DEPLOY_COPY
  exec /bin/sh "$_c" "$@"
fi
repo=/Volumes/NVM/Paperclip
# Canonical env (SCO-762): launchd lacks PAPERCLIP_HOME, so the installer walks the
# ~/.paperclip symlink and prepare-bundled-package.mjs silently skips its main guard.
[ -n "${PAPERCLIP_HOME:-}" ] || . "$repo/env.sh"
handoff=/Volumes/NVM/AI_Coding_Projects/zagent/bin/autodeploy
blue_green=0
if [ -f "$repo/ops/zero-downtime/enabled" ]; then
  blue_green=1
fi
tmp=/Volumes/NVM/AI_Agent_Runtime/tmp
flock=/opt/homebrew/bin/flock
helper=$repo/master/ops/research/runner-control/experiments/unified-native-mission/deploy-drain.mjs
hot_helper=$repo/master/ops/research/runner-control/experiments/unified-native-mission/hot-deploy.mjs
restore_helper=$repo/master/ops/research/runner-control/experiments/unified-native-mission/deploy-restore-install.mjs
deploy_branch=sco-337-native-runner-20261101
source_branch=fix/git-installer-bundled-workspaces-20261030
usage() { echo 'usage: pc-deploy [--dry-run] [--help]  (deploys master HEAD; no other arguments)'; }
dry_run=0
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --dry-run) dry_run=1 ;;
    *) echo "pc-deploy: unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done
if [ "$dry_run" = 1 ]; then
  if [ "$blue_green" -eq 1 ]; then
    PAPERCLIP_DEPLOY_API_BASE=$("$handoff" endpoint) || exit 1
    export PAPERCLIP_DEPLOY_API_BASE
  fi
  echo "pc-deploy: dry run, would deploy master HEAD $(git -C "$repo/master" rev-parse --short HEAD 2>/dev/null || echo unknown) over current build $(readlink "$repo/cli/current" | sed 's#.*/##'); nothing changed"
  _h=$(git -C "$repo/master" rev-parse --verify HEAD 2>/dev/null || :)
  [ -z "$_h" ] || node "$hot_helper" plan "$_h" 2>&1 || :
  exit 0
fi
if [ "${PC_DEPLOY_IN_LOCK:-}" != 1 ]; then
  [ -x "$flock" ] || { echo 'pc-deploy: atomic flock unavailable' >&2; exit 1; }
  mkdir -p "$tmp"
  # Each caller waits for its own exclusive turn. A full deploy finishes in
  # well under 10 minutes; a holder older than that is stuck and is killed
  # (owner 2026-11-03: deploys never hold on a stuck process). The kernel
  # releases the lock on SIGKILL. Queued waiters may also be killed; every
  # deploy installs master HEAD, so the surviving caller covers their request.
  rc=0
  "$flock" -x -w 600 -E 76 "$tmp/pc-deploy.flock" \
    /usr/bin/env PC_DEPLOY_IN_LOCK=1 /bin/sh "$0" "$@" || rc=$?
  [ "$rc" -eq 76 ] || exit "$rc"
  holders=$(lsof -t "$tmp/pc-deploy.flock" 2>/dev/null | grep -vx "$$" || :)
  echo "pc-deploy: WARNING deploy lock held >10 min; killing stuck holder(s): $holders" >&2
  [ -z "$holders" ] || { kill -TERM $holders 2>/dev/null || :; sleep 10; kill -KILL $holders 2>/dev/null || :; }
  exec "$flock" -x -w 60 -E 76 "$tmp/pc-deploy.flock" \
    /usr/bin/env PC_DEPLOY_IN_LOCK=1 /bin/sh "$0" "$@"
fi

# Re-read the active colour inside the lock: a preceding deploy may have
# switched it while this caller waited. Duplicate callers now probe the live
# process and take the verified/no-payload fast paths without another restart.
if [ "$blue_green" -eq 1 ]; then
  PAPERCLIP_DEPLOY_API_BASE=$("$handoff" endpoint) || exit 1
  export PAPERCLIP_DEPLOY_API_BASE
fi

current() { readlink "$repo/cli/current" | sed 's#.*/##'; }
cli() { node "$repo/cli/current/node_modules/paperclipai/dist/index.js" "$@"; }
held=0
restarted=0
installed=0
original=
original_sha=
manifest="$tmp/pc-deploy-drain-$$.json"

restore_old_payload() {
  [ -n "$original" ] || return 1
  if [ "$(current)" != "$original" ]; then
    node "$restore_helper" restore "$original" "$short" || return 1
  fi
  [ "$(current)" = "$original" ] || {
    echo "pc-deploy: rollback payload mismatch" >&2; return 1;
  }
}
rollback_restart() {
  echo 'pc-deploy: restoring previous build and checking restart health' >&2
  restore_old_payload || return 1
  sudo -n launchctl kickstart -k system/ing.paperclip.paperclipai.main || return 1
  [ -n "$original_sha" ] || { echo 'pc-deploy: original exact SHA unavailable for rollback verification' >&2; return 1; }
  node "$helper" finish "$manifest" "$original_sha" || {
    echo 'pc-deploy: rollback health/process identity FAILED' >&2; return 1;
  }
  echo "pc-deploy: rollback healthy, restored $original" >&2
  return 0
}
cleanup() {
  result=$?
  trap - EXIT INT TERM HUP
  if [ "$restarted" -eq 0 ]; then
    if [ "$installed" -eq 1 ]; then
      restore_old_payload || echo 'pc-deploy: WARNING previous payload not restored' >&2
    fi
    if [ "$held" -eq 1 ]; then
      node "$helper" release "$manifest" || echo 'pc-deploy: WARNING admission release failed' >&2
    fi
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
if [ -n "${PC_DEPLOY_CHECK_ONLY:-}" ]; then
  echo 'pc-deploy: exclusive deployment lock acquired (check only)'
  exit 0
fi

# Only the deliberately pinned canonical checkout branch may publish.
source_now=$(git -C "$repo/master" symbolic-ref --quiet --short HEAD) || {
  echo 'pc-deploy: detached HEAD refused' >&2; exit 1;
}
[ "$source_now" = "$source_branch" ] || {
  echo "pc-deploy: source branch changed ($source_now), refused" >&2; exit 1;
}
origin=$(git -C "$repo/master" remote get-url origin)
[ "$origin" = "https://github.com/appleguy/paperclip.git" ] || {
  echo 'pc-deploy: unexpected origin; refusing mismatched install repository' >&2; exit 1;
}
# Uncommitted work belongs to other agents; never stage or discard it.
[ ! -e "$repo/master/.git/rebase-merge" ] && [ ! -e "$repo/master/.git/rebase-apply" ] || {
  echo 'pc-deploy: refusing source mid-rebase' >&2; exit 1;
}
T=/Volumes/NVM/AI_Agent_Runtime/tools/corepack
sha=$(git -C "$repo/master" rev-parse --verify HEAD) || exit 1
short=$(printf '%s' "$sha" | cut -c1-12)

# A previous deploy may have died while holding admission, including before
# the already-verified fast path or hot-deploy path is reached.
node "$helper" reclaim || exit 1
if node "$helper" verified "$sha"; then
  echo "pc-deploy: $short serving process verified; no restart needed"
  exit 0
else
  rc=$?
  [ "$rc" -eq 10 ] || exit "$rc"
fi
# SCO-818: hot path. When every file changed since the served build is a hot
# module (server/src/hot/hot-paths.txt) or outside the payload, install the new
# payload and switch the running server's hot modules over: no drain, no restart,
# running runs finish on the code they started with. Anything else, or any hot
# failure, falls through to the SCO-817 drain/restart path below.
hot_rc=0
original=$(current)
original_sha=$(git -C "$repo/master" rev-parse --verify "$original^{commit}" 2>/dev/null || :)
node "$hot_helper" plan "$sha" || hot_rc=$?
case "$hot_rc" in
  11|12) exit 0 ;;
  0)
    git -C "$repo/master" push -q origin "$sha:refs/heads/$deploy_branch" || {
      echo 'pc-deploy: push rejected; no new payload installed' >&2; exit 1;
    }
    hot_orig=$(current)
    (cd "$repo" && PATH="$T/node_modules/.bin:$PATH" \
      COREPACK_HOME="$T/home" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 nice -n 10 \
      node cli/current/node_modules/paperclipai/dist/index.js install --ref "$sha" \
      --repo appleguy/paperclip --yes) || {
        echo 'pc-deploy: hot install failed; restoring previous payload' >&2
        [ "$(current)" = "$hot_orig" ] || node "$restore_helper" restore "$hot_orig" "$short" || :
        exit 1
      }
    installed=1
    if [ "$(current)" = "$short" ] && node "$hot_helper" activate "$sha"; then
      installed=0
      exit 0
    fi
    echo 'pc-deploy: hot activation failed; falling back to full restart' >&2
    ;;
esac
# Owner (11-05): no deploy safeguard. A live codex_local run never defers a deploy;
# runners reattach to the new server (git-flow).
# The exact 40-digit immutable sha is pushed and installed. Never resolve
# an unconstrained moving branch at install time.
git -C "$repo/master" push -q origin "$sha:refs/heads/$deploy_branch" || {
  echo 'pc-deploy: push rejected; no new payload installed' >&2; exit 1;
}
if [ "$blue_green" -eq 0 ]; then
  node "$helper" begin "$manifest" || exit 1
  held=1
fi
tries=0
while [ "$(current)" != "$short" ] && [ "$tries" -lt 2 ]; do
  # The installer could flip cli/current before returning nonzero.
  installed=1
  (cd "$repo" && PATH="$T/node_modules/.bin:$PATH" \
    COREPACK_HOME="$T/home" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 nice -n 10 \
    node cli/current/node_modules/paperclipai/dist/index.js install --ref "$sha" \
    --repo appleguy/paperclip --yes) || {
      echo 'pc-deploy: install failed; verifying prior payload' >&2; exit 1;
    }
  tries=$((tries + 1))
done
[ "$(current)" = "$short" ] || {
  echo 'pc-deploy: installed payload differs from pushed SHA' >&2; exit 1;
}
[ -f "$repo/cli/current/node_modules/@paperclipai/server/dist/vendor/claude-channel-bridge/hook.cjs" ] || {
  echo "pc-deploy: payload lacks dist/vendor/claude-channel-bridge/hook.cjs (every claude_rc Stop hook would fail); no restart" >&2; exit 1;
}
if [ "$blue_green" -eq 1 ]; then
  if "$handoff" handoff "$sha" "$original"; then
    installed=0
    echo "pc-deploy: $short verified live by blue/green handoff"
    exit 0
  fi
  echo 'pc-deploy: handoff failed; restoring the original install pointer' >&2
  restore_old_payload || echo 'pc-deploy: WARNING original install pointer not restored' >&2
  installed=0
  exit 1
fi
# Owner policy 2026-11-03: a deploy NEVER holds on running, stuck or
# unprovable work. SCO-817: upstream hot restart (doc/DEVELOPING.md "Hot-Restart
# Deploys"). The intent makes the old server snapshot running runs and exit
# without a drain; the new server re-enters runs whose adapter supports restart
# reattach under the same run id and reaps the rest as before. No session is
# paused or aborted here.
bounded() { secs=$1; shift; perl -e 'alarm shift; exec @ARGV' "$secs" "$@"; }
forced=0
server_pid=$(jq -r .serverPid "$manifest")
intent_log="$tmp/pc-deploy-hot-restart-$$.json"
if ! (cd "$repo/master/server" && bounded 60 ./node_modules/.bin/tsx ../scripts/request-hot-restart.ts \
    --server-pid "$server_pid") > "$intent_log" 2>&1; then
  forced=1
  echo "pc-deploy: WARNING hot-restart intent not written ($intent_log); the server drains on restart" >&2
fi
if ! sudo -n launchctl kickstart -k system/ing.paperclip.paperclipai.main; then
  echo 'pc-deploy: kickstart failed; rolling back' >&2
  rollback_restart || echo 'pc-deploy: rollback FAILED, operator investigation required' >&2
  exit 1
fi
restarted=1
# The helper polls health *and* new process identity for up to four minutes.
# A transient status=starting directly after kickstart is expected.
if ! node "$helper" finish "$manifest" "$sha"; then
  echo 'pc-deploy: new payload not verified after readiness window, initiating rollback' >&2
  rollback_restart || echo 'pc-deploy: rollback FAILED, operator investigation required' >&2
  exit 1
fi
held=0
installed=0
report="$PAPERCLIP_HOME/instances/${PAPERCLIP_INSTANCE_ID:-default}/hot-restart-report.json"
if [ "$forced" -eq 0 ] && [ -f "$report" ]; then
  jq -r '"pc-deploy: hot restart re-entered \(.adoptedRunIds|length), finalized \(.finalizedWhileDownRunIds|length), reaped-and-retried \(.skippedRunIds|length), lost \(.lostRunIds|length)"' "$report" || :
  [ "$(jq '.lostRunIds|length' "$report" 2>/dev/null || echo 0)" -eq 0 ] || echo "pc-deploy: WARNING lost runs: $(jq -c .lostRunIds "$report")" >&2
fi
echo "pc-deploy: $short verified live, health stable, admission restored"
[ "$forced" -eq 0 ] || echo "pc-deploy: NOTE forced restart; interrupted work is recovered or re-run by the server"
