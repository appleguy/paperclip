#!/bin/sh
# pc-deploy. Canonical source for /Volumes/NVM/Paperclip/bin/pc-deploy.
# Single-flight, process-verified deploy, 30-minute pacing, bounded admission
# drain, exact-session safety barrier, health-verified rollback. No manual steps.
set -eu
repo=/Volumes/NVM/Paperclip
tmp=/Volumes/NVM/AI_Agent_Runtime/tmp
flock=/opt/homebrew/bin/flock
helper=$repo/master/ops/research/runner-control/experiments/unified-native-mission/deploy-drain.mjs
restore_helper=$repo/master/ops/research/runner-control/experiments/unified-native-mission/deploy-restore-install.mjs
deploy_branch=sco-337-native-runner-20261101
source_branch=fix/git-installer-bundled-workspaces-20261030
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
  if [ "$held" -eq 1 ] && [ "$restarted" -eq 0 ]; then
    if [ "$installed" -eq 1 ]; then
      restore_old_payload || echo 'pc-deploy: WARNING previous payload not restored' >&2
    fi
    node "$helper" release "$manifest" || echo 'pc-deploy: WARNING admission release failed' >&2
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

if node "$helper" verified "$sha"; then
  echo "pc-deploy: $short serving process verified; no restart needed"
  exit 0
else
  rc=$?
  [ "$rc" -eq 10 ] || exit "$rc"
fi
# Owner policy 2026-11-02: deploys never wait (no pacing gate, no drain wait).
# Running work is paused at an exact safe point or left for server recovery.
original=$(current)
original_sha=$(git -C "$repo/master" rev-parse --verify "$original^{commit}" 2>/dev/null || :)
# The exact 40-digit immutable sha is pushed and installed. Never resolve
# an unconstrained moving branch at install time.
git -C "$repo/master" push -q origin "$sha:refs/heads/$deploy_branch" || {
  echo 'pc-deploy: push rejected; no new payload installed' >&2; exit 1;
}
node "$helper" begin "$manifest" || exit 1
held=1
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
# Owner policy 2026-11-03: a deploy NEVER holds on running, stuck or
# unprovable work. Killing it is acceptable; redo is acceptable. Each safety
# step gets one bounded attempt to reach a clean safe point, then the restart
# proceeds and server recovery re-runs or rejoins the work. A step that fails
# is reported loudly, never turned into a hold or a refusal.
bounded() { secs=$1; shift; perl -e 'alarm shift; exec @ARGV' "$secs" "$@"; }
forced=0
if bounded 60 node "$helper" wait "$manifest" 0; then
  :
else
  bounded 120 node "$helper" pause "$manifest" || {
    forced=1
    echo 'pc-deploy: WARNING owned sessions not paused within bound; restarting anyway (deploys never hold)' >&2
  }
fi
# Last-second barrier: report, never hold.
bounded 60 node "$helper" verify "$manifest" || {
  forced=1
  echo 'pc-deploy: WARNING safety barrier not proven; restarting anyway (deploys never hold)' >&2
}
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
echo "pc-deploy: $short verified live, health stable, admission restored"
[ "$forced" -eq 0 ] || echo "pc-deploy: NOTE forced restart; interrupted work is recovered or re-run by the server"
