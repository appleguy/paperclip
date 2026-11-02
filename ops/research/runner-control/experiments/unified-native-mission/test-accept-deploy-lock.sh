#!/bin/sh
# Regression for cross-process shared restart exclusion, without any launchctl or model work.
set -eu
DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT HUP INT TERM
LOCK=$DIR/pc-deploy.flock
exec 9>"$LOCK"
flock -x -n 9
if flock -x -n "$LOCK" /usr/bin/true; then
  echo "FAIL: a second deploy/accept process acquired the held lock" >&2
  exit 1
fi
echo "PASS: overlapping deploy/accept restart refused"
flock -u 9
exec 9>&-
if ! flock -x -n "$LOCK" /usr/bin/true; then
  echo "FAIL: restart lock not reusable after health check" >&2
  exit 1
fi
echo "PASS: restart lock available after verification release"
SCRIPT=/Volumes/NVM/Paperclip/master/ops/research/runner-control/experiments/unified-native-mission/accept-unattended.sh
grep -Fq 'flock -x -n 9' "$SCRIPT"
grep -Fq 'flock -u 9' "$SCRIPT"
echo "PASS: acceptance harness acquires and releases the deploy lock"
