#!/bin/sh
# SCO-337 L3 unattended acceptance: six genuine assigned issues, mid-run restart, live steer.
# --run performs live changes; --preflight only checks readiness. No Codex, no paid inference.
# Evidence (no credentials) is retained 30 days for the lead to inspect.
set -u
umask 077
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH
ROOT=/Volumes/NVM/Paperclip
CLI=$ROOT/bin/pc
AREA=$ROOT/ops/research/runner-control/experiments/unified-native-mission
MAC_AGENT=23ed1b59-1ba8-4445-8b54-ded4afdf4780
WRX_AGENT=6afb0f4c-9524-4b02-b6b1-68d7fc696b8c
SERVICE=ing.paperclip.paperclipai.main
START_TIMEOUT=${ACCEPT_START_TIMEOUT:-900}
FINISH_TIMEOUT=${ACCEPT_FINISH_TIMEOUT:-2400}
POLL_SEC=${ACCEPT_POLL_SEC:-12}
MODE=${1:-}
case "$MODE" in --run|--preflight) ;; *) echo "usage: $0 --run | --preflight" >&2; exit 2;; esac
for prog in jq curl sort comm wc date launchctl; do
  command -v "$prog" >/dev/null 2>&1 || { echo "Missing $prog" >&2; exit 2; }
done
[ -x "$CLI" ] || { echo "Missing $CLI" >&2; exit 2; }

LOCK=$AREA/.accept-unattended.lock
if ! mkdir "$LOCK" 2>/dev/null; then echo "FAIL: acceptance already running ($LOCK)" >&2; exit 2; fi
trap 'rmdir "$LOCK" 2>/dev/null || :' EXIT HUP INT TERM
stamp=$(date -u '+%Y%m%dT%H%M%SZ')
RUN_TAG="ACCEPT-$stamp-$$"
EVIDENCE=$AREA/acceptance-evidence/$RUN_TAG
mkdir -p "$EVIDENCE" || exit 2
CASES=$EVIDENCE/cases.tsv
: > "$CASES"
printf '%s\n' "$RUN_TAG" > "$EVIDENCE/tag.txt"
utc() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
note() { printf '[%s] %s\n' "$(utc)" "$*" | tee -a "$EVIDENCE/progress.log"; }
abort() {
  note "FAIL: $*"
  printf '| Check | Result | Evidence |\n|---|---|---|\n'
  printf '| Preflight/setup | FAIL: %s | %s |\n' "$*" "$EVIDENCE/progress.log"
  printf 'EVIDENCE_DIR=%s\n' "$EVIDENCE"
  exit 1
}
healthy() {
  curl -fsS --max-time 5 http://127.0.0.1:3100/api/health 2>/dev/null |
    jq -e '.status == "ok"' >/dev/null 2>&1
}
service_pid() {
  launchctl print "gui/$(id -u)/$SERVICE" 2>/dev/null |
    sed -nE 's/^[[:space:]]*pid = ([0-9]+).*/\1/p' | sed -n '1p'
}
agent_preflight() {
  ref=$1
  label=$2
  "$CLI" agent get "$ref" --json 2>>"$EVIDENCE/preflight-errors.log" |
    jq -e --arg id "$ref" \
      '.id == $id and .adapterType == "opencode_local" and
      (.status != "paused" and .status != "terminated") and
      .runtimeConfig.heartbeat.wakeOnAssignment == true' >/dev/null ||
    abort "$label is unavailable or not an assignment-triggered OpenCode agent"
}

# Existing mode-600 server passwords never enter argv, stdout, evidence, or git.
route_cfg() {
  for cfg in "$ROOT"/backends/*/server/shared-"$1".json; do
    [ -f "$cfg" ] && { printf '%s\n' "$cfg"; return 0; }
  done
  return 1
}
oc_active() (
  cfg=$(route_cfg "$1") || exit 1
  url=$(jq -er '.url' "$cfg") || exit 1
  pwf=$(jq -er '.passwordFile' "$cfg") || exit 1
  [ -r "$pwf" ] || exit 1
  auth=$(printf 'opencode:%s' "$(cat "$pwf")" | jq -Rs .)
  printf 'user = %s\n' "$auth" |
    curl -fsS --max-time 8 --config - "$url/api/session/active" 2>/dev/null |
    jq -er '.data | if type=="object" then keys[] else error("bad active map") end' |
    LC_ALL=C sort
)
oc_steer() (
  route=$1
  session=$2
  message=$3
  response=$4
  cfg=$(route_cfg "$route") || exit 1
  url=$(jq -er '.url' "$cfg") || exit 1
  pwf=$(jq -er '.passwordFile' "$cfg") || exit 1
  [ -r "$pwf" ] || exit 1
  auth=$(printf 'opencode:%s' "$(cat "$pwf")" | jq -Rs .)
  payload=$(jq -nc --arg text "$message" '{text:$text,delivery:"steer"}') || exit 1
  printf 'user = %s\n' "$auth" |
    curl -sS --max-time 12 --config - -o "$response" -w '%{http_code}' \
      -H 'Content-Type: application/json' --data "$payload" \
      "$url/api/session/$session/prompt"
)
running_run() {
  "$CLI" issue runs "$1" --json 2>/dev/null |
    jq -r '[.[] | select(.status=="running") | .runId] | .[0] // empty' 2>/dev/null
}
issue_state() {
  "$CLI" issue get "$1" --json 2>/dev/null | jq -r '.status // empty' 2>/dev/null
}
case_file() { printf '%s/case-%s\n' "$EVIDENCE" "$1"; }

note "SCO-337 L3 preflight tag=$RUN_TAG"
healthy || abort "Paperclip API health is not ok"
pid_initial=$(service_pid)
[ -n "$pid_initial" ] || abort "GUI Paperclip launchd service not running"
agent_preflight "$MAC_AGENT" "Mac GLM"
agent_preflight "$WRX_AGENT" "WRX DeepSeek"
mac_ref=$("$CLI" issue get SCO-427 --json 2>>"$EVIDENCE/preflight-errors.log") ||
  abort "cannot read SCO-427"
wrx_ref=$("$CLI" issue get SCO-421 --json 2>>"$EVIDENCE/preflight-errors.log") ||
  abort "cannot read SCO-421"
company=$(printf '%s' "$mac_ref" | jq -er '.companyId') || abort "missing company"
project=$(printf '%s' "$mac_ref" | jq -er '.projectId') || abort "missing project"
goal=$(printf '%s' "$mac_ref" | jq -er '.goalId') || abort "missing goal"
printf '%s\n' "$wrx_ref" |
  jq -e --arg co "$company" --arg pr "$project" --arg go "$goal" \
    '.companyId==$co and .projectId==$pr and .goalId==$go' >/dev/null ||
  abort "agent reference issues have different company/project/goal"
for route in glm-mac deepseek; do
  oc_active "$route" > "$EVIDENCE/baseline-$route.ids" ||
    abort "OpenCode route $route unavailable or unauthorized"
done
note "Preflight PASS; main pid=$pid_initial, agent bindings and two routes verified"
if [ "$MODE" = --preflight ]; then
  printf '| Check | Result | Evidence |\n|---|---|---|\n'
  printf '| Preflight | PASS | %s |\n' "$EVIDENCE/progress.log"
  printf 'EVIDENCE_DIR=%s\n' "$EVIDENCE"
  exit 0
fi

# Only assignment-wake, no manual agent wake. Long first cases hold a real window
# for live steering and service restart; every case is tiny, bounded and read-only.
i=1
while [ "$i" -le 6 ]; do
  if [ $((i % 2)) -eq 1 ]; then
    route=glm-mac
    agent=$MAC_AGENT
  else
    route=deepseek
    agent=$WRX_AGENT
  fi
  case_tag="$RUN_TAG-C$i"
  if [ "$i" -le 2 ]; then
    steps="Run the shell tool twice, one call for 'sleep 30', then one for 'sleep 25'."
  else
    steps="Run the shell tool once for 'sleep 5'."
  fi
  description="SCO-337 unattended reliability acceptance case $i, token $case_tag. Read-only bounded task. $steps Do not modify files or launch agents. Create or update this issue's document key report (title Report, markdown) with at least 350 UTF-8 bytes, the exact token $case_tag, an account of the shell calls and their results, and the word DONE. If a live steering comment asks for an extra marker, include that marker in your report. Only then mark THIS issue done. Do not replace report with a comment; after a service restart, never rerun an already completed tool call."
  raw=$("$CLI" issue create -C "$company" \
    --title "SCO-337 unattended $RUN_TAG case $i ($route)" \
    --description "$description" --status todo --priority low \
    --assignee-agent-id "$agent" --project-id "$project" --goal-id "$goal" \
    --standalone --json 2>"$EVIDENCE/create-$i.stderr") ||
    abort "create failed case $i; prior created issues retained in $CASES"
  id=$(printf '%s' "$raw" | jq -er '.id') || abort "case $i lacks id"
  ident=$(printf '%s' "$raw" | jq -er '.identifier') || abort "case $i lacks identifier"
  printf '%s|%s|%s|%s|%s\n' "$i" "$route" "$agent" "$id" "$ident" >> "$CASES"
  mkdir -p "$(case_file "$i")"
  printf '%s\n' "$raw" | jq '{id,identifier,status,assigneeAgentId,projectId,goalId}' \
    > "$(case_file "$i")/created.json"
  note "Created case $i: $ident route=$route (auto-assignment wake)"
  i=$((i+1))
done

STEER_RESULT=FAIL
RESTART_RESULT=FAIL
STEER_DETAIL="no live steering receipt"
RESTART_DETAIL="no mid-run restart"
STEER_CASE=
RESTART_CASE=
deadline=$(($(date +%s) + START_TIMEOUT))
note "Waiting for one matching in-flight issue/run and exactly one new shared OpenCode session"
while [ "$(date +%s)" -lt "$deadline" ]; do
  while IFS='|' read -r ix route agent id ident; do
    run=$(running_run "$id")
    [ -n "$run" ] || continue
    current="$EVIDENCE/current-$route.ids"
    oc_active "$route" > "$current" || continue
    new_sessions="$EVIDENCE/new-$route.ids"
    comm -13 "$EVIDENCE/baseline-$route.ids" "$current" > "$new_sessions"
    count=$(wc -l < "$new_sessions" | tr -d ' ')
    [ "$count" -eq 1 ] || continue
    session=$(sed -n '1p' "$new_sessions")
    [ -n "$session" ] || continue
    marker="STEER-$RUN_TAG-C$ix"
    message="SCO-337 LIVE steering comment for $ident, run $run: include the exact marker $marker in the final report document. Continue the original task without repeating a completed tool call."
    printf '%s\n' "$message" > "$EVIDENCE/steering-comment.txt"
    if comment=$("$CLI" issue comment "$id" --body "$message" --json \
      2>"$EVIDENCE/steering-comment.stderr"); then
      printf '%s\n' "$comment" |
        jq '{id,issueId,createdAt}' > "$EVIDENCE/steering-comment.json" 2>/dev/null || :
    else
      STEER_DETAIL="Paperclip comment could not be posted"
      note "FAIL: $STEER_DETAIL"
      STEER_CASE=$ix
      break
    fi
    code=$(oc_steer "$route" "$session" "$message" "$EVIDENCE/steer-response.json" \
      2>"$EVIDENCE/steer-error.log") || code=000
    case "$code" in
      2??) STEER_RESULT=PENDING
           STEER_DETAIL="native OpenCode HTTP $code; final report marker not yet verified" ;;
      *) STEER_DETAIL="native OpenCode steer HTTP $code" ;;
    esac
    STEER_CASE=$ix
    printf 'case=%s\nissue=%s\nrun=%s\nroute=%s\nsession=%s\nmarker=%s\nhttp=%s\n' \
      "$ix" "$ident" "$run" "$route" "$session" "$marker" "$code" \
      > "$EVIDENCE/steer-receipt.txt"
    note "Steering comment + native delivery for $ident/$run on session $session: $STEER_DETAIL"

    # Require the exact source issue/run to remain live right before restart.
    if [ "$(running_run "$id")" != "$run" ]; then
      RESTART_DETAIL="steered run had ended before kickstart"
      note "FAIL: $RESTART_DETAIL"
      break
    fi
    pid_before=$(service_pid)
    [ -n "$pid_before" ] || { RESTART_DETAIL="main PID missing before kickstart"; break; }
    RESTART_CASE=$ix
    printf 'before_pid=%s\nbefore_run=%s\nissue=%s\nat=%s\n' \
      "$pid_before" "$run" "$ident" "$(utc)" > "$EVIDENCE/restart-receipt.txt"
    note "Mid-run restart: launchctl kickstart -k gui/$(id -u)/$SERVICE (PID $pid_before)"
    if launchctl kickstart -k "gui/$(id -u)/$SERVICE" \
      > "$EVIDENCE/restart-command.out" 2>"$EVIDENCE/restart-command.err"; then
      recovery_deadline=$(($(date +%s) + 180))
      while [ "$(date +%s)" -lt "$recovery_deadline" ]; do
        healthy && break
        sleep 3
      done
      pid_after=$(service_pid)
      if healthy; then health_state=ok; else health_state=bad; fi
      printf 'after_pid=%s\nhealth=%s\nat=%s\n' \
        "$pid_after" "$health_state" "$(utc)" >> "$EVIDENCE/restart-receipt.txt"
      if [ "$health_state" = ok ] && [ -n "$pid_after" ] && \
         [ "$pid_after" != "$pid_before" ]; then
        RESTART_RESULT=PENDING
        RESTART_DETAIL="main PID $pid_before -> $pid_after, healthy; awaiting case completion"
      else
        RESTART_DETAIL="main did not become healthy under a different PID"
      fi
    else
      RESTART_DETAIL="launchctl kickstart failed"
    fi
    note "Restart check: $RESTART_DETAIL"
    break
  done < "$CASES"
  if [ -n "$STEER_CASE" ] || [ -n "$RESTART_CASE" ]; then break; fi
  sleep "$POLL_SEC"
done

# Never wake/reopen or replay work; observe the autonomous queue for a bounded period.
note "Awaiting six done statuses (maximum $FINISH_TIMEOUT seconds)"
deadline=$(($(date +%s) + FINISH_TIMEOUT))
while [ "$(date +%s)" -lt "$deadline" ]; do
  unfinished=0
  while IFS='|' read -r ix route agent id ident; do
    state=$(issue_state "$id")
    [ "$state" = done ] || unfinished=$((unfinished+1))
  done < "$CASES"
  [ "$unfinished" -eq 0 ] && break
  sleep "$POLL_SEC"
done

failure=0
printf '| Case | Agent | Issue | Closed status | Report bytes | Successful run | Result | Evidence |\n'
printf '|---|---|---|---|---:|---|---|---|\n'
while IFS='|' read -r ix route agent id ident; do
  dir=$(case_file "$ix")
  if "$CLI" issue get "$id" --json > "$dir/issue.json" 2>"$dir/issue.stderr"; then
    state=$(jq -r '.status // "unknown"' "$dir/issue.json")
  else
    state=unknown
  fi
  "$CLI" issue runs "$id" --json 2>"$dir/runs.stderr" |
    jq '[.[] | {runId,status,agentId,adapterType,startedAt,finishedAt,errorCode,retryOfRunId}]' \
      > "$dir/runs.json" || printf '[]\n' > "$dir/runs.json"
  successful=$(jq -r '[.[] | select(.status=="succeeded") | .runId] | .[0] // empty' \
    "$dir/runs.json")
  bytes=0
  doc_ok=no
  if "$CLI" issue document:get "$id" report --json > "$dir/report-document.json" \
    2>"$dir/report-error.log"; then
    jq -r '.body // ""' "$dir/report-document.json" > "$dir/report.md"
    bytes=$(LC_ALL=C wc -c < "$dir/report.md" | tr -d ' ')
    if jq -e '.key=="report" and .format=="markdown"' \
      "$dir/report-document.json" >/dev/null &&
      [ "$bytes" -ge 250 ] &&
      grep -Fq "$RUN_TAG-C$ix" "$dir/report.md"; then doc_ok=yes; fi
  fi
  if [ "$state" = done ] && [ "$doc_ok" = yes ] && [ -n "$successful" ]; then
    verdict=PASS
  else
    verdict=FAIL
    failure=$((failure+1))
  fi
  if [ "$ix" = "$STEER_CASE" ] && [ "$STEER_RESULT" = PENDING ]; then
    if [ "$doc_ok" = yes ] && grep -Fq "STEER-$RUN_TAG-C$ix" "$dir/report.md"; then
      STEER_RESULT=PASS
      STEER_DETAIL="comment marker arrived through live native steer and appears in final report"
    else
      STEER_RESULT=FAIL
      STEER_DETAIL="steering marker absent from report"
    fi
  fi
  if [ "$ix" = "$RESTART_CASE" ] && [ "$RESTART_RESULT" = PENDING ]; then
    if [ "$verdict" = PASS ]; then
      RESTART_RESULT=PASS
      RESTART_DETAIL="$ident completed and reported after a verified PID replacement"
    else
      RESTART_RESULT=FAIL
      RESTART_DETAIL="$ident did not complete with a report after PID replacement"
    fi
  fi
  run_short=$(printf '%.12s' "$successful")
  [ -n "$run_short" ] || run_short=none
  printf '| %s | %s | %s | %s | %s | %s | %s | %s |\n' \
    "$ix" "$route" "$ident" "$state" "$bytes" "$run_short" "$verdict" "$dir"
done < "$CASES"

[ "$STEER_RESULT" = PASS ] || failure=$((failure+1))
[ "$RESTART_RESULT" = PASS ] || failure=$((failure+1))
printf '| Steer | OpenCode | case %s | %s | - | - | %s | %s |\n' \
  "${STEER_CASE:-none}" "$STEER_DETAIL" "$STEER_RESULT" "$EVIDENCE/steer-receipt.txt"
printf '| Restart survival | Paperclip main | case %s | %s | - | - | %s | %s |\n' \
  "${RESTART_CASE:-none}" "$RESTART_DETAIL" "$RESTART_RESULT" "$EVIDENCE/restart-receipt.txt"
note "Acceptance finished, failures=$failure; no Codex, no model swaps, no manual agent wakes"
printf 'EVIDENCE_DIR=%s\n' "$EVIDENCE"
[ "$failure" -eq 0 ]
