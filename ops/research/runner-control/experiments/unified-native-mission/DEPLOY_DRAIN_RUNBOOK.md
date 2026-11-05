# SCO-435: verified deploy-side drain

Canonical source: `pc-deploy.sh` (installed at `/Volumes/NVM/Paperclip/bin/pc-deploy`) plus `deploy-drain.mjs`. The L2 OpenCode runner implementation is separate and untouched.

## Lifecycle and proof

1. Acquire OS-level exclusive `flock` without waiting. A contender refuses immediately and reports each current holder PID and command; it never signals or kills another deploy. OS releases a dead holder's lock, avoiding PID reuse and stale-directory TOCTOU.
2. Validate known source branch, origin, exact immutable 40-character HEAD, and cached healthy *process* receipt (PID + SHA + current payload). If already verified, return without restarting. A symlink alone is insufficient.
3. Respect 30-minute spacing by checking Paperclip instance-admin `GET /api/instance/task-drain?upgradeReadiness=1` server PID and uptime before any restart. Push exact SHA and install with `--ref <sha>` (not a mutable branch).
4. Start audited `POST /api/instance/task-drain` with a bounded 20-minute TTL to fence new admission. Wait up to 600 seconds for running work to settle.
5. If still active, read *all companies*' running runs and local OpenCode recovery config. Match each run with the L2 durable `agentId+taskId+runId+cwd+url+sessionId` binding. Check provider `GET /api/session/active`. On both Mac `19403` and WRX proxy `19402`, a `busy`/`running` provider session without a Paperclip run **or any journal record** can be interrupted automatically only after `GET /api/session/<id>` confirms `time.updated` is at least three minutes old. Recheck run inventory, latest session update and journals immediately before exact-session POST. Persist 0600 intent before POST and each ACK; poll until idle. **Refuse fresh or ambiguous sessions, missing run bindings, non-OpenCode runs, unknown inventory and pending wakes.** No model restart or provider-wide kill is permitted.
6. Verify the admission fence remains held, no new/unowned active sessions or wakes, and run inventory is stable. Only then `launchctl kickstart`. Poll HTTP health and the authenticated server PID for up to **240 seconds**, tolerating `status=starting` until new-PID healthy readiness and matching CLI payload are both observed. Require eight seconds of stable PID/health before writing the process receipt; restart resets the process-local drain and queues resume automatically.
7. On an error **before kickstart**, leave the old process alive, restore prior managed installer symlink **and manifest** under the existing installer lock using `deploy-restore-install.mjs`, then release the original drain. Never use `pc update --rollback` here: its CLI implementation also restarts the service. On failure after the first restart, restore managed installer state, deliberately kickstart again, health-check and record the restored process when resolvable. Always return nonzero for a failed requested deploy. No credentials appear in command output.

**Not guaranteed:** Engine prefix-cache warmth; this depends on the model engine and is not established by a successful restart. Old pre-L2 sessions younger than three minutes, currently changing, linked to any recovery journal, or ambiguous with live Paperclip runs remain protected and block restart rather than being guessed or killed. L2 is responsible for safe same-session successor continuation and no-replay after restart.

## Tests and live evidence

Run:
```sh
sh -n ops/research/runner-control/experiments/unified-native-mission/pc-deploy.sh
node --test ops/research/runner-control/experiments/unified-native-mission/deploy-drain.test.mjs
```

Smoke with running work (2026-11-02 11:50 PST): genuine instance-admin POST drain acknowledged, `wait 0` correctly returned code 10 (active work), DELETE released admission without kickstarting; 0600 evidence at `/Volumes/NVM/AI_Agent_Runtime/tmp/pc-deploy-smoke-20261102.json`. The 30-minute spacing gate blocked an earlier premature restart. Live restart and session-continuation proof must be recorded separately; **mock passing tests do not prove a successful active-run deploy.**

The deployment file itself lives outside the git checkout and must be installed from the committed `pc-deploy.sh`. Check `cmp` and executable permissions. A successful deploy writes `pc-deploy-verified.json` and `pc-deploy-drain-<PID>.json` in the private runtime scratch. Neither contains access tokens or passwords. Do not upload raw terminal logs.
