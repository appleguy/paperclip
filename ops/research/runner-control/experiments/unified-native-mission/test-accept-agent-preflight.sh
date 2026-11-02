#!/bin/sh
# Focused lifecycle/assignment acceptance gate regression, no service or model access.
set -eu
ROOT=/Volumes/NVM/Paperclip
AREA=$ROOT/ops/research/runner-control/experiments/unified-native-mission
FILTER=$AREA/accept-agent-preflight.jq
ID=23ed1b59-1ba8-4445-8b54-ded4afdf4780
BASE=$(jq -nc --arg id "$ID" '{
  id:$id, adapterType:"opencode_local", status:"idle", lifecycleState:"ready",
  lifecycleHolds:[], runtimeConfig:{heartbeat:{wakeOnAssignment:true}}
}')
count=0
test_case() {
  label=$1; want=$2; patch=$3
  fixture=$(printf '%s\n' "$BASE" | jq -c "$patch")
  if printf '%s\n' "$fixture" | jq -e --arg id "$ID" -f "$FILTER" >/dev/null 2>&1; then
    got=pass
  else
    got=fail
  fi
  if [ "$want" != "$got" ]; then
    printf 'FAIL %s: expected=%s actual=%s\n' "$label" "$want" "$got" >&2
    exit 1
  fi
  count=$((count+1))
  printf 'PASS %s (%s)\n' "$label" "$got"
}
test_case ready_idle pass '.'
test_case ready_running pass '.status = "running"'
test_case pausing_but_idle fail '.lifecycleState = "pausing"'
test_case resuming_but_idle fail '.lifecycleState = "resuming"'
test_case paused_but_idle fail '.lifecycleState = "paused"'
test_case paused_status fail '.status = "paused"'
test_case terminated_status fail '.status = "terminated"'
test_case approval_status fail '.status = "pending_approval"'
test_case held_budget fail '.lifecycleHolds = ["budget"]'
test_case no_lifecycle_state fail 'del(.lifecycleState)'
test_case no_lifecycle_holds fail 'del(.lifecycleHolds)'
test_case incorrect_id fail '.id = "other-agent"'
test_case wrong_adapter fail '.adapterType = "process"'
test_case no_assignment_wake fail '.runtimeConfig.heartbeat.wakeOnAssignment = false'
printf '%s/%s acceptance preflight fixtures passed\n' "$count" "$count"
