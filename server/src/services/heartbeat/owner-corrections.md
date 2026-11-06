# Scoped owner corrections

Use the existing authenticated `POST /api/agents/:agentId/wakeup` endpoint:

```json
{
  "reason": "owner_correction",
  "payload": {
    "issueId": "<task id>",
    "ownerCorrection": {
      "commentId": "<current authenticated user's source comment id>",
      "supersedes": ["<earlier registered source comment id>"]
    }
  }
}
```

`supersedes` is optional. The source comment is the correction text, so there is
no second mutable copy to supply. The user must already have permission to wake
the selected agent. Agent/system wakes cannot introduce corrections. The
source must be a current, trusted comment authored by that user in the selected
company and task. This scope deliberately covers one agent and one task; it
does not turn a file change or an ordinary comment into a fleet-wide command.

Registration uses `agent_wakeup_requests` with reason `owner_correction`, a
server-owned `ownerCorrectionV1` payload and status `consumed`. It records a
completed registration, not a provider run. A short agent-row lock serializes
registration and delivery claims across controllers; no lock spans provider I/O.
The source-comment identity, content fingerprint and explicit supersession set
are immutable. Retry with the exact same request. To change it, create another
source comment and explicitly supersede the old correction. Distinct corrections
remain independently current.

Every currently running task/agent match is steered through
`steerNativeSession`, using a stable source-bound correlation identity. Other
tasks, agents and stopped runs are excluded. The durable registration retains
each target's `dispatching`, `acknowledged`, `failed` or `uncertain` receipt,
including the acknowledged turn or a failure code and next action. The issue's
activity feed records the registration/receipt summary. A successful wake
returns the first matching run. With no running target, the ordinary wake API
returns its skipped response; the correction is registered for future task
runs, and that response does **not** assert provider delivery.

An unacknowledged delivery returns HTTP 409 with
`owner_correction_delivery_incomplete`, the registration receipt id and target
outcomes. Unsupported/rejected/unattached providers can be explicitly retried.
Timeouts, controller crashes during dispatch, and unknown effects are reconciled
against existing durable `steering_acknowledgement` events. They are never
blindly resent. A late native acknowledgement may settle the receipt; the same
request also reconciles it after restart. Pending/uncertain corrections cannot
be superseded until their acknowledgement is reconciled, preventing an older
message from arriving after its replacement. No provider is restarted, no
replacement run is admitted, and no polling worker is installed.

Task preparation reloads current scoped corrections into all task-markdown
variants on each new or resumed run, including reused provider sessions. A run
whose prepared context includes the correction is not steered again. A changed,
deleted or quarantined source renders an explicit withdrawal notice instead of
presenting its old body as current. Source edits require a new correction
identity. Superseded bodies are omitted and replacement messages name exactly
which earlier corrections are no longer current. Existing permissions,
approvals, task intent and unrelated work remain authoritative.

The transport acknowledgement proves receipt at the provider boundary. It does
not prove that the model followed the correction or completed its requested
behavior. Future task-context inclusion is likewise recorded separately from
in-flight acknowledgement.

Implementation reuses the native steering and persisted-event contract in
`../native-runtime/native-session-executor.ts` and `../run-identity.ts`, rather
than adding another transport or guidance-distribution service. Existing
instruction-file loading remains the normal startup guidance mechanism.
