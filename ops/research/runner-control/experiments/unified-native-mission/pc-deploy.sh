#!/bin/sh
# pc-deploy. Canonical source for /Volumes/NVM/Paperclip/bin/pc-deploy.
# Single-flight, process-verified deploy, 30-minute pacing, bounded admission
# drain, exact-session safety barrier, health-verified rollback. No manual steps.
set -eu
repo=/Volumes/NVM/Paperclip
tmp=/Volumes/NVM/AI_Agent_Runtime/tmp
flock=/opt/homebrew/bin/flock
helper=$repo/master/ops/research/runner-control/experiments/unified-native-mission/deploy-drain.mjs
deploy_branch=sco-337-native-runner-20261101
source_branch=fix/git-installer-bundled-workspaces-20261030
if [ "${PC_DEPLOY_IN_LOCK:-}" != 1 ]; then
  [ -x "$flock" ] || { echo 'pc-deploy: atomic flock unavailable' >&2; exit 1; }
  mkdir -p "$tmp"
  # Each caller waits for its own exclusive turn. An earlier failure cannot
  # acknowledge and lose a queued request. Kernel releases on SIGKILL/PID reuse.
  exec "$flock" -x -w 2700 -E 76 "$tmp/pc-deploy.flock" \
    /usr/bin/env PC_DEPLOY_IN_LOCK=1 /bin/sh "$0" "$@"
fi

health() { curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:3100/api/health | grep -q '"status":"ok"'; }
current() { readlink "$repo/cli/current" | sed 's#.*/##'; }
cli() { node "$repo/cli/current/node_modules/paperclipai/dist/index.js" "$@"; }
poll_health() {
  i=0
  while [ "$i" -lt 40 ]; do
    sleep 6
    if health; then return 0; fi
    i=$((i + 1))
  done
  return 1
}
held=0
restarted=0
installed=0
original=
original_sha=
manifest="$tmp/pc-deploy-drain-$$.json"

restore_old_payload() {
  [ -n "$original" ] || return 1
  if [ "$(current)" != "$original" ]; then
    cli update --rollback || return 1
  fi
  [ "$(current)" = "$original" ] || {
    echo "pc-deploy: rollback payload mismatch" >&2; return 1;
  }
}
rollback_restart() {
  echo 'pc-deploy: restoring previous build and checking restart health' >&2
  restore_old_payload || return 1
  launchctl kickstart -k "gui/$(id -u)/ing.paperclip.paperclipai.main" || return 1
  poll_health || { echo 'pc-deploy: rollback health FAILED' >&2; return 1; }
  if [ -n "$original_sha" ]; then
    node "$helper" finish "$manifest" "$original_sha" || return 1
  fi
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
# Wait safely for the lead's 30-minute deploy spacing, even for a concurrent
# caller that only acquires the lock after the first caller restarts.
node "$helper" pace || exit 1
# Recheck the source after the pacing wait; another agent may have committed.
[ "$(git -C "$repo/master" symbolic-ref --quiet --short HEAD)" = "$source_branch" ] || {
  echo 'pc-deploy: source branch changed during pacing' >&2; exit 1;
}
sha=$(git -C "$repo/master" rev-parse --verify HEAD) || exit 1
short=$(printf '%s' "$sha" | cut -c1-12)
if node "$helper" verified "$sha"; then
  echo "pc-deploy: $short serving process verified after pacing; no restart needed"
  exit 0
else
  rc=$?
  [ "$rc" -eq 10 ] || exit "$rc"
fi
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
if node "$helper" wait "$manifest" 600; then
  :
else
  rc=$?
  [ "$rc" -eq 10 ] || exit "$rc"
  node "$helper" pause "$manifest" || {
    echo 'pc-deploy: cannot prove safe OpenCode ownership; refusing restart' >&2
    exit 1
  }
fi
# Last-second fence: task admission, all company runs, provider sessions.
node "$helper" verify "$manifest" || exit 1
if ! launchctl kickstart -k "gui/$(id -u)/ing.paperclip.paperclipai.main"; then
  echo 'pc-deploy: kickstart failed; rolling back' >&2
  rollback_restart || echo 'pc-deploy: rollback FAILED, operator investigation required' >&2
  exit 1
fi
restarted=1
if ! poll_health || ! node "$helper" finish "$manifest" "$sha"; then
  echo 'pc-deploy: new payload not verified, initiating rollback' >&2
  rollback_restart || echo 'pc-deploy: rollback FAILED, operator investigation required' >&2
  exit 1
fi
held=0
installed=0
echo "pc-deploy: $short verified live, health stable, admission restored"
