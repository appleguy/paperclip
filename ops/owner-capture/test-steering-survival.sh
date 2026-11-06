#!/bin/sh
# SCO-712/722 validation: owner steering survives /clear, compaction, restart, task switch; gate blocks; escalation fires.
# Isolated STATE; no Paperclip writes; SCO-756 goal gate via a fake pc. Usage: test-steering-survival.sh [incident]   (incident = replay of the 10a2b866 Board transcript)
set -eu
G=$(dirname "$0")/owner-guard
scratch=${OWNER_GUARD_TEST_TMPDIR:-/Volumes/NVM/AI_Agent_Runtime/tmp}
export OWNER_GUARD_STATE=$(mktemp -d "$scratch/owner-guard-test.XXXXXX"); fail=0
ck() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
cap() { printf '{"session_id":"%s","cwd":"%s","prompt":"%s"}' "$1" "$2" "$3" | OWNER_GUARD_PID=$4 $G capture; }
res() { printf '{"session_id":"%s","cwd":"%s","source":"%s"}' "$1" "$2" "$3" | OWNER_GUARD_PID=$4 $G resume; }
gate() { printf '{"session_id":"%s","stop_hook_active":%s}' "$1" "${2:-false}" | $G gate; }
nopen() { $G open 0 2>/dev/null | wc -l | tr -d ' '; }
# Stable source identities survive closure and distinguish equal text.
event_capture() { jq -nc --arg sid "$1" --arg id "$2" --arg text "$3" '{session_id:$sid,message_id:$id,cwd:"/test",prompt:$text}' | "$G" capture; }
event_capture replay-session event-one 'same event'
id=$($G list | jq -r 'select(.sid=="replay-session") | .id')
$G close "$id" 'covered by replay test'
event_capture replay-session event-one 'same event'
ck 'closed event replay stays closed' '[ "$(nopen)" = 0 ] && [ "$(jq -s length "$OWNER_GUARD_STATE/open/replay-session.jsonl")" = 2 ]'
event_capture distinct-session event-one 'equal text'
event_capture distinct-session event-two 'equal text'
ck 'distinct event IDs preserve equal text' '[ "$(nopen)" = 2 ]'
for id in $($G list | jq -r .id); do $G close "$id" 'covered by distinct event test'; done
cap fallback-session /test 'hook and transcript' $$
id=$($G list | jq -r 'select(.sid=="fallback-session") | .id')
$G close "$id" 'covered by fallback test'
jq -nc '{sid:"fallback-session",event:"message:transcript-one",text:"hook and transcript",ts:"2020-01-01T00:00:00Z"}' | $G _ledger_add ''
jq -nc '{sid:"fallback-session",event:"message:transcript-one",text:"hook and transcript",ts:"2020-01-01T00:00:00Z"}' | $G _ledger_add ''
ck 'transcript reconciles closed identity-free receipt once' '[ "$(nopen)" = 0 ] && [ "$(jq -s length "$OWNER_GUARD_STATE/open/fallback-session.jsonl")" = 3 ]'
jq -nc '{sid:"fallback-session",event:"message:transcript-two",text:"hook and transcript",ts:"2020-01-01T00:00:00Z"}' | $G _ledger_add ''
ck 'second transcript occurrence with equal text stays distinct' '[ "$(nopen)" = 1 ]'
for id in $($G list | jq -r .id); do $G close "$id" 'covered by reconciliation test'; done
# Codex guardian review prompts are generated, while interactive and other
# subagent sources may contain real steering. Exercise both scan and receipt.
for kind in guardian exec interactive other unusual; do
  case "$kind" in
    guardian) source='{"subagent":{"other":"guardian"}}'; expected=0 ;;
    exec) source='"exec"'; expected=0 ;;
    interactive) source='"cli"'; expected=1 ;;
    other) source='{"subagent":{"other":"worker"}}'; expected=1 ;;
    unusual) source='{"subagent":"unknown"}'; expected=1 ;;
  esac
  T="$OWNER_GUARD_STATE/rollout-$kind.jsonl"
  jq -nc --argjson source "$source" --arg sid "$kind" '{type:"session_meta",payload:{id:$sid,cwd:"/test",source:$source}}' > "$T"
  jq -nc '{timestamp:"2020-01-01T00:00:00Z",type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"owner steering"}]}}' >> "$T"
  ck "codex $kind scan classification" '[ "$($G scan "$T" | wc -l | tr -d " ")" = "$expected" ]'
  before=$(nopen)
  jq -nc --arg sid "$kind" --arg tr "$T" '{session_id:$sid,transcript_path:$tr,prompt:"owner steering",cwd:"/test"}' | $G capture
  after=$(nopen)
  ck "codex $kind receipt classification" '[ "$((after-before))" = "$expected" ]'
  for id in $($G open 0 2>/dev/null | jq -r .id); do $G close "$id" "covered by SCO-1063 test"; done
done
for harness in claude codex; do
  sleep 300 & A=$!; sleep 300 & B=$!; sleep 300 & OTHER=$!  # agent processes: A (first run), B (after restart), OTHER (a live peer seat)
  S1=aaaaaaaa-1111-2222-3333-$harness; S2=bbbbbbbb-1111-2222-3333-$harness; S3=cccccccc-1111-2222-3333-$harness; CWD=/tmp/seat-$harness
  # owner steering arrives mid-turn (UserPromptSubmit at receipt); automated peer/system/wake text must be ignored
  cap $S1 $CWD "make cadence 57 minutes adaptive ($harness)" $A
  cap $S1 $CWD 'From: peer\nTo: me\nhello' $A
  cap $S1 $CWD '<system-reminder>x</system-reminder>' $A
  cap $S1 $CWD '<cross-session-message from=uds:/tmp/x.sock from-name=Board>\nplease continue SCO-1\n</cross-session-message>' $A
  cap $S1 $CWD 'OWNER STEERING OPEN in this session (1).' $A
  cap $S1 $CWD 'From: paperclip-done-gate | DONE GATE refused your receipt (1/3, SCO-762): x Fix this.' $A
  cap $S1 $CWD 'Paperclip may post a short platform-generated fast-response receipt in your voice before you reply.' $A
  cap $S1 $CWD 'The following is the Codex agent history added since your last approval assessment. Continue.' $A
  cap $S1 $CWD "make cadence 57 minutes adaptive ($harness)" $A
  ck "$harness unknown provenance retained; identity-free equal text deduplicated" '[ "$(nopen)" = 8 ]'
  ck "$harness gate blocks turn end in the capturing session" 'gate $S1 | jq -e ".decision==\"block\"" >/dev/null'
  ck "$harness gate lets a repeated stop through (no loop)" '! gate $S1 true | grep -q block'
  # compaction: same session id, same process
  ck "$harness compaction: record in fresh context" 'res $S1 $CWD compact $A | grep -q "cadence 57 minutes"'
  # /clear: new session id, same process -> adopts; the gate now covers the new session
  ck "$harness /clear: record in fresh context" 'res $S2 $CWD clear $A | grep -q "cadence 57 minutes"'
  ck "$harness /clear: gate blocks the new session" 'gate $S2 | grep -q block'
  # a live peer seat sharing the cwd must not inherit it
  ck "$harness live peer seat in same cwd not polluted" '[ -z "$(res $S3 $CWD startup $OTHER)" ]'
  ck "$harness other cwd not polluted" '[ -z "$(res $S3 /tmp/other-seat startup $B)" ]'
  # restart: process A dies, new process B in the same seat adopts
  kill $A; wait $A 2>/dev/null || true
  ck "$harness restart: record in fresh context" 'res $S3 $CWD startup $B | grep -q "cadence 57 minutes"'
  ck "$harness restart: gate blocks the restarted session" 'gate $S3 | grep -q block'
  # task switch inside one live session: nothing drops context; the gate still holds the turn until closed
  cap $S3 $CWD "switch to the SC64 issue now ($harness)" $B
  ck "$harness task switch: gate retains all records" '[ "$(gate $S3 | jq -r .reason | grep -c "^- \[")" = 9 ]'
  for id in $($G open 0 2>/dev/null | jq -r .id); do $G close "$id" "covered by SCO-722 test"; done
  ck "$harness closed: gate clean" '[ -z "$(gate $S3)" ]'
  ck "$harness closed: no longer resumed" '[ -z "$(res $S2 $CWD clear $B)" ]'
  ck "$harness closed: detector clean" '$G open 0 >/dev/null 2>&1'
  kill $B $OTHER; wait 2>/dev/null || true
done
# OpenCode 2.2.x per-backend db (session_v2/session_message): TUI steering reaches the ledger via sync; wakes/probes do not (SCO-722 msg_1a8172 gap)
OC=$OWNER_GUARD_STATE/oc.db; now=$(($(date +%s)*1000))
sqlite3 $OC "create table session_v2(id text primary key, directory text, time_updated integer); create table session_message(id text primary key, session_id text, type text, seq integer, time_created integer, data text);
  insert into session_v2 values('ses_test', '/tmp/seat-oc', $now);
  insert into session_message values('m1','ses_test','user',1,$now,'{\"text\":\"Paperclip may post a short platform-generated receipt. Paperclip task context:\"}'),
   ('m2','ses_test','user',2,$now,'{\"text\":\"Respond with hello.\"}'), ('m3','ses_test','assistant',3,$now,'{\"text\":\"x\"}'),
   ('m4','ses_test','user',4,$now,'{\"text\":\"also clear out the ktrace files (oc test)\"}'),
   ('m5','ses_test','user',5,$now,'{\"text\":\"<shell command=\\\"du -sh x\\\">4.0K x</shell>\"}');"
ocsync() { $G scan "opencode:ses_test@$OC" | jq -c ".+{proc:\"$$@x\"}" | $G _ledger_add ""; }; ocsync
ck "opencode v2: TUI steering captured from a per-backend db" '$G open 0 2>/dev/null | grep -q "ktrace files (oc test)"'
ck "opencode v2: unknown provenance retained" '[ "$(nopen)" = 4 ]'
ocsync
ck "opencode v2: re-sync does not duplicate" '[ "$(nopen)" = 4 ]'
for id in $($G open 0 2>/dev/null | jq -r .id); do $G close "$id" "covered by SCO-722 test"; done
# SCO-1080: NAR's session marker + deterministic message ID identify injected
# instructions/bootstrap regardless of persona text. Owners retain TUI access.
sqlite3 "$OC" <<'SQL'
alter table session_v2 add column metadata text;
insert into session_v2 values('ses_managed','/test/managed',1,'{"paperclip":{"agentId":"worker","issueId":"task"}}');
insert into session_v2 values('ses_unmanaged','/test/native',1,null);
insert into session_message values
 ('msg_aaaaaaaaaaaaaaaaaaaaaaaaaa','ses_managed','user',1,1,'{"text":"instructions with any persona wording"}'),
 ('msg_bbbbbbbbbbbbbbbbbbbbbbbbbb','ses_managed','user',2,1,'{"text":"Read /Volumes/NVM/Paperclip/AGENTS.md at task start and continue"}'),
 ('msg_ownerTuiMessage','ses_managed','user',3,1,'{"text":"keep genuine owner typing"}'),
 ('msg_ownerQuotedInstructions','ses_managed','user',4,1,'{"text":"instructions with any persona wording"}'),
 ('msg_cccccccccccccccccccccccccc','ses_unmanaged','user',1,1,'{"text":"native owner without Paperclip metadata"}');
SQL
ck "opencode NAR scan: instructions and bootstrap excluded, both owner messages kept" '[ "$($G scan "opencode:ses_managed@$OC" | jq -sr "map(.line)==[3,4]")" = true ]'
ck "opencode NAR scan: incremental cursor preserves owner messages" '[ "$($G scan "opencode:ses_managed@$OC" 3 | jq -sr "map(.line)==[4]")" = true ]'
ck "opencode scan: NAR-shaped ID without managed metadata remains eligible" '[ "$($G scan "opencode:ses_unmanaged@$OC" | jq -s length)" = 1 ]'
for item in instructions bootstrap owner repeated_owner unmanaged; do
  case "$item" in
    instructions) sid=ses_managed; mid=msg_aaaaaaaaaaaaaaaaaaaaaaaaaa; text='instructions with any persona wording'; expected=0 ;;
    bootstrap) sid=ses_managed; mid=msg_bbbbbbbbbbbbbbbbbbbbbbbbbb; text='Read /Volumes/NVM/Paperclip/AGENTS.md at task start and continue'; expected=0 ;;
    owner) sid=ses_managed; mid=msg_ownerTuiMessage; text='keep genuine owner typing'; expected=1 ;;
    repeated_owner) sid=ses_managed; mid=msg_ownerQuotedInstructions; text='instructions with any persona wording'; expected=1 ;;
    unmanaged) sid=ses_unmanaged; mid=msg_cccccccccccccccccccccccccc; text='native owner without Paperclip metadata'; expected=1 ;;
  esac
  before=$(nopen)
  jq -nc --arg sid "$sid" --arg mid "$mid" --arg text "$text" '{session_id:$sid,message_id:$mid,cwd:"/test",prompt:$text}' |
    OPENCODE_DB="$OC" OWNER_GUARD_SRC=opencode $G capture
  after=$(nopen)
  ck "opencode $item receipt classification" '[ "$((after-before))" = "$expected" ]'
done
before=$(nopen)
jq -nc '{session_id:"ses_managed",cwd:"/test",prompt:"instructions with any persona wording"}' |
  OPENCODE_DB="$OC" OWNER_GUARD_SRC=opencode $G capture
ck "opencode legacy receipt without message ID matches persisted NAR injection" '[ "$(nopen)" = "$before" ]'
for id in $($G list | jq -r .id); do $G close "$id" "covered by SCO-1080 test"; done
# Claude harness-injected turns (task-notification envelopes, restart continuation summaries,
# interrupt markers) are not owner typing when they lead the prompt; a quoted occurrence
# mid-text stays owner.
for p in '<task-notification>' 'This session is being continued from a previous conversation' '[Request interrupted by user'; do
  before=$(nopen)
  cap claude-harness /test "$p" $$
  ck "claude harness: leading marker not captured" '[ "$(nopen)" = "$before" ]'
  cap claude-harness /test "fix the cadence after $p ended" $$
  ck "claude harness: mid-text marker stays owner" '[ "$(nopen)" = "$((before+1))" ]'
  for id in $($G list | jq -r .id); do $G close "$id" "covered by harness skip test"; done
done
# agy (antigravity-cli) keeps one append-only global history.jsonl: owner TUI turns reach the
# ledger with their real conversationId; slash-command and conversation-less rows do not;
# line n is the stable idempotent occurrence.
FIX=$OWNER_GUARD_STATE/agy-history.jsonl
cat > "$FIX" <<'EOF'
{"display":"make the deploy gate stricter","timestamp":1760000000000,"workspace":"/tmp/w1","conversationId":"conv-1"}
{"display":"/clear","timestamp":1760000001000,"workspace":"/tmp/w1","conversationId":"conv-1","type":"slash_command"}
{"display":"orphan turn","timestamp":1760000002000,"workspace":"/tmp/w1"}
{"display":"and keep the ledger idempotent","timestamp":1760000003000,"workspace":"/tmp/w2","conversationId":"conv-2"}
{"display":"/compact","timestamp":1760000004000,"workspace":"/tmp/w2","conversationId":"conv-2","type":"slash_command"}
EOF
ck 'agy scan: owner turns kept, slash and orphan rows dropped' '[ "$($G scan "agy:$FIX" | jq -sr "map(.line)==[1,4]")" = true ]'
ck 'agy scan: incremental from line 1 keeps only the new turn' '[ "$($G scan "agy:$FIX" 1 | jq -sr "map(.line)==[4]")" = true ]'
ck 'agy scan: records carry conversation id, workspace and source' '$G scan "agy:$FIX" | jq -se "[.[]|select(.line==4)]|.[0]|.sid==\"conv-2\" and .cwd==\"/tmp/w2\" and .src==\"agy\"" >/dev/null'
$G scan "agy:$FIX" | $G _ledger_add ""
ck 'agy ledger: both owner turns open' '[ "$(nopen)" = 2 ] && $G open 0 2>/dev/null | grep -q "deploy gate stricter" && $G open 0 2>/dev/null | grep -q "keep the ledger idempotent"'
$G scan "agy:$FIX" | $G _ledger_add ""
ck 'agy ledger: re-scan does not duplicate' '[ "$(nopen)" = 2 ]'
# Fleet discovery (tick/sync path): a fixture HOME with a fresh history file reaches the ledger
FXH=$OWNER_GUARD_STATE/agy-home; mkdir -p "$FXH/.gemini/antigravity-cli"
jq -nc '{display:"fixture home agy turn",timestamp:1760000005000,workspace:"/tmp/w3",conversationId:"conv-fx"}' > "$FXH/.gemini/antigravity-cli/history.jsonl"
EMDB=$OWNER_GUARD_STATE/empty.db; : > "$EMDB" # pin ocdbs: the absolute per-backend globs must not reach real opencode dbs
HOME="$FXH" OPENCODE_DB="$EMDB" $G sync 2
ck 'agy sync: fixture HOME history reaches the ledger' '[ "$(nopen)" = 3 ] && $G open 0 2>/dev/null | grep -q "fixture home agy turn"'
for id in $($G list | jq -r .id); do $G close "$id" "covered by agy test"; done
# escalation: records open past N minutes fire the webhook once, with every record in the payload
cap dddddddd-1111-2222-3333-esc /tmp/seat-esc "esc test message" $$
# Private chat fixtures are synthetic; no actual z-voice content is read/logged.
cap private-root /Volumes/NVM/AI_Coding_Projects/zvoice 'synthetic-private-fixture' $$
cap private-child /Volumes/NVM/AI_Coding_Projects/zvoice/chat 'synthetic-private-fixture' $$
REQ=$OWNER_GUARD_STATE/req.txt; export REQ
mkdir -p "$OWNER_GUARD_STATE/bin"
printf '#!/bin/sh\ncat > "$REQ"\ncat "$OWNER_GUARD_STATE/escalate.hdr" >> "$REQ"\n' > "$OWNER_GUARD_STATE/bin/curl"
chmod +x "$OWNER_GUARD_STATE/bin/curl"
OLD_PATH=$PATH; PATH="$OWNER_GUARD_STATE/bin:$PATH"; export PATH
printf 'http://synthetic.invalid/fire\n' > $OWNER_GUARD_STATE/escalate.url; printf 'Authorization: Bearer test\n' > $OWNER_GUARD_STATE/escalate.hdr
ck "escalation fires for records older than N" '$G escalate -1 2>/dev/null; grep -q "esc test message" $REQ && grep -q "Bearer test" $REQ'
ck "z-voice root and child records never enter webhook payload" '! rg -q "synthetic-private-fixture|zvoice" "$REQ" && rg -q "\"count\":\"1\"" "$REQ"'
ck "escalation is not repeated" '$G escalate -1 2>/dev/null'
PATH=$OLD_PATH; export PATH
ck "z-voice records stay local and un-escalated" '[ "$($G list | jq -s "[.[]|select(.sid==\"private-root\" or .sid==\"private-child\")|select(.escalated==null)]|length")" = 2 ]'
for id in $($G list | jq -r 'select(.sid=="private-root" or .sid=="private-child")|.id'); do $G close "$id" "dropped: synthetic privacy regression fixture"; done
ck "escalated record stays open until closed" '[ "$(nopen)" = 1 ]'
# SCO-747 Steering page: a direction typed there is recorded and, with a reason, closed onto its issue at once
ck "steering note opens a listed record" 'id=$(echo "steer open test" | $G note steering-page) && $G list | jq -e --arg i "$id" "select(.id==\$i and .src==\"steering-page\")" >/dev/null'
ck "steering note with reason lands closed" 'id=$(echo "steer closed test" | $G note steering-page SCO-747 posted) && ! $G list | grep -q "$id" && grep -q "\"close\":\"SCO-747 posted\"" $OWNER_GUARD_STATE/open/steering.jsonl'
# SCO-756 goal gate: an active managed goal blocks a stop only while the seat holds workable issues; blocked-only seats
# stop freely; inside a Paperclip run it stays out; the same set blocking twice with no progress lets the stop through once.
GS=$OWNER_GUARD_STATE/rc-seat; mkdir -p $GS; export OWNER_GUARD_SEATS=$GS/seat.json OWNER_GUARD_PC=$OWNER_GUARD_STATE/fake-pc
GSID=eeeeeeee-1111-2222-3333-goal; LIST=$OWNER_GUARD_STATE/list.json
printf '#!/bin/sh\ncat %s\n' "$LIST" > $OWNER_GUARD_PC; chmod +x $OWNER_GUARD_PC
printf '{"agentId":"a1","companyId":"c1","conversationId":"%s","goals":{"i1":"active"}}' $GSID > $GS/seat.json
printf '[{"id":"i1","identifier":"SCO-1","status":"in_progress","title":"goal issue","updatedAt":"t1","activeRun":null,"executionRunId":null},
 {"id":"i2","identifier":"SCO-2","status":"todo","title":"next work","updatedAt":"t1","activeRun":null,"executionRunId":null}]' > $LIST
ck "goal gate blocks while workable issues are held" 'gate $GSID | jq -e ".decision==\"block\" and (.reason|test(\"SCO-2\"))" >/dev/null'
ck "goal gate lets the bounced stop through" '[ -z "$(gate $GSID true)" ]'
ck "goal gate blocks the same set a second time" 'gate $GSID | grep -q block'
ck "goal gate: no progress after two blocks -> stop allowed, reported once" 'gate $GSID | jq -e ".systemMessage|test(\"no progress\")" >/dev/null && [ -z "$(gate $GSID)" ]'
printf '[{"id":"i1","identifier":"SCO-1","status":"in_progress","title":"goal issue","updatedAt":"t2","activeRun":null,"executionRunId":null}]' > $LIST
ck "goal gate: progress (issue updated) re-arms the block" 'gate $GSID | grep -q block'
printf '[{"id":"i1","identifier":"SCO-1","status":"blocked","title":"goal issue","updatedAt":"t3","activeRun":null,"executionRunId":null,"blockerAttention":{"unresolvedBlockerCount":1}},
 {"id":"i3","identifier":"SCO-3","status":"blocked","title":"waits","updatedAt":"t3","activeRun":null,"executionRunId":null,"unblockDescriptor":{"owner":"board","action":"x"}},
 {"id":"i4","identifier":"SCO-4","status":"blocked","title":"timed","updatedAt":"t3","activeRun":null,"executionRunId":null,"monitorNextCheckAt":"2030-01-01T00:00:00Z"},
 {"id":"i2","identifier":"SCO-2","status":"in_progress","title":"running","updatedAt":"t3","activeRun":{"id":"r"},"executionRunId":"r"}]' > $LIST
ck "goal gate: all issues blocked with a reason or in a live run -> stop allowed, no re-wake" '[ -z "$(gate $GSID)" ]'
printf '[{"id":"i1","identifier":"SCO-1","status":"blocked","title":"goal issue","updatedAt":"t3b","activeRun":null,"executionRunId":null,"blockerAttention":{"unresolvedBlockerCount":1}},
 {"id":"i5","identifier":"SCO-5","status":"blocked","title":"stale hold","updatedAt":"t3b","activeRun":null,"executionRunId":null,"blockerAttention":{"unresolvedBlockerCount":0},"unblockDescriptor":null,"monitorNextCheckAt":null}]' > $LIST
ck "goal gate: blocked with no blocker, reason or wake counts as workable (SCO-768)" 'gate $GSID | jq -e ".decision==\"block\" and (.reason|test(\"SCO-5\"))" >/dev/null'
printf '[{"id":"i2","identifier":"SCO-2","status":"todo","title":"next","updatedAt":"t4","activeRun":null,"executionRunId":null}]' > $LIST
ck "goal gate: goal issue closed -> no goal layer" '[ -z "$(gate $GSID)" ]'
printf '[{"id":"i1","identifier":"SCO-1","status":"todo","title":"goal issue","updatedAt":"t5","activeRun":null,"executionRunId":null}]' > $LIST
touch $GS/active.json
ck "goal gate: stays out inside a Paperclip run" '[ -z "$(gate $GSID)" ]'
rm $GS/active.json; printf '{"agentId":"a1","companyId":"c1","conversationId":"%s","goals":{"i1":"paused"}}' $GSID > $GS/seat.json
ck "goal gate: paused goal -> no goal layer" '[ -z "$(gate $GSID)" ]'
ck "goal gate: other sessions unaffected" '[ -z "$(gate ffffffff-other)" ]'
printf '#!/bin/sh\nexit 1\n' > $OWNER_GUARD_PC; printf '{"agentId":"a1","companyId":"c1","conversationId":"%s","goals":{"i1":"active"}}' $GSID > $GS/seat.json
ck "goal gate: Paperclip unreachable -> fail open" '[ -z "$(gate $GSID)" ]'
unset OWNER_GUARD_SEATS OWNER_GUARD_PC
if [ "${1:-}" = incident ]; then # 10a2b866 Board session lost 5 items to chat before /clear (later SCO-714..718)
  T=/Users/tech/.claude/projects/-Volumes-NVM-Paperclip-workspaces-board/10a2b866-9769-4781-b51a-ec4903f7c2cf.jsonl
  sleep 300 & P=$!
  $G scan "$T" | jq -c --arg p "$P@$(ps -o lstart= -p $P | tr -s ' ' | sed 's/^ //;s/ $//;s/ /_/g')" '.+{proc:$p}' | $G _ledger_add ""
  n=$(cat $OWNER_GUARD_STATE/open/10a2b866*.jsonl | wc -l | tr -d ' '); echo "incident transcript: $n owner records in ledger"
  for l in 509 562; do $G scan "$T" | jq -e "select(.line==$l)" >/dev/null && echo "PASS line $l captured" || { echo "FAIL line $l"; fail=1; }; done
  out=$(res 94dadb0a-new /Volumes/NVM/Paperclip/workspaces/board clear $P)
  ck "incident post-/clear session sees 57-minute cadence + unpause/DeepSeek items" 'printf %s "$out" | grep -q "57 minutes" && printf %s "$out" | grep -qi "deepseek\|unpause"'
  ck "incident post-/clear session cannot end its turn" 'gate 94dadb0a-new | grep -q block'
  kill $P
fi
OWNER_GUARD_TEST_BIN="$G" sh /Volumes/NVM/Paperclip/ops/owner-capture/test-private-fleet.sh || fail=1
rm -rf "$OWNER_GUARD_STATE"; exit $fail
