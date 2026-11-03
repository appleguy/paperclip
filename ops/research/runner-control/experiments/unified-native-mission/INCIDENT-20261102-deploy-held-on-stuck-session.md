# INCIDENT 2026-11-02: deploy held on a stuck process (major transgression)

Severity: major. Owner (2026-11-03): "It is a major transgression that must be
documented to hold a deploy on a process that is stuck, especially when even
killing it would have been acceptable to make progress."

## What happened
- The SCO-337 cloud integration lead (a senior lead with authority to kill
  anything) ran `pc-deploy` for 456e4f20f (NAR adapter flag).
- The deploy waited through the 30-minute pacing gate, then the 600 s drain,
  then stalled. A GLM OpenCode session for SCO-478 kept generating on the
  shared server (:19403) after its run was cancelled by an agent pause.
- deploy-drain treated that session as unsettled work and refused to restart.
  The lead spent time diagnosing instead of killing it. Only then was the exact
  session interrupted and the deploy completed.

## Root causes
1. Policy: the deploy was designed to fail closed. Any run without a journaled
   OpenCode session (Claude, Codex, agy, NAR, pre-journal) or any unowned
   active provider session was a hard refusal, and stuck work was a hold.
2. Pacing (30 min) and a 600 s drain wait were unconditional delays.
3. Bug: an agent pause cancels the Paperclip run but does not interrupt the
   provider session, which leaves a zombie that keeps generating. This is still
   open and is tracked on SCO-337.
4. Operator: the lead had authority to kill the zombie immediately and did not.

## Fix (so it cannot recur)
- `bdb03ceda`: removed the pacing gate and the drain wait. Runs without a
  journaled session are marked `restart-lost` (the server recovery re-runs or
  rejoins them). Unowned active OpenCode sessions never block. Zombie sessions
  (journal owner run not running) are interrupted with no age wait.
- Follow-up commit (this file): every remaining safety step is bounded and
  fails forward:
  - wait 60 s, pause 120 s, verify 60 s, each via a perl alarm. On failure the
    script prints a WARNING, restarts anyway and prints a NOTE that the restart
    was forced.
  - A deploy-lock holder older than 10 min is killed (TERM, then KILL), then
    the deploy proceeds.
  - There is no remaining `exit` on refusal between install and kickstart.
- Contract test (`deploy-drain.test.mjs`, "installed deploy shell contract")
  fails if pacing, a nonzero drain wait, `refusing restart`, an unbounded
  verify/pause, or the 45-minute lock wait comes back.
- Fleet rule: `deploy-never-holds` tag in z-agent
  `ops/skills/GLOBAL_AGENT_GUIDANCE.md`.

## Still guaranteed
Restart never touches the OpenCode servers. Install rollback and the new-PID
plus SHA plus health verification are unchanged. Forced restarts are reported.
