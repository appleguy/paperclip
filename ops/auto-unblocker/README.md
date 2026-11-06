# Auto-unblocker

This repository copy is not automatically promoted to the existing tool under
`/Volumes/NVM/Paperclip/ops/auto-unblocker`. Apply is reserved for Board using
its own credential. Never pass that credential to a worker.

Set `PAPERCLIP_API_URL`, `PAPERCLIP_COMPANY_ID` and an authorized
`PAPERCLIP_API_KEY`. Inspect the current blocked set without changing it:

```
go run . --older-than=1ns --json
```

Rows named `self_review` are proposals, not findings that the action has
cleared. Board must inspect each issue and its descriptor action, including
owner holds, resource waits and future handoffs. Dependency readiness is not
evidence that the descriptor action is complete. Use the reported `issue`,
`blockedTransitionAt`, `descriptorAction`, and `ownerAgentPrefix` to create a
JSON array containing only individually cleared proposals. For example:

```json
[{"issue":"SCO-1","blockedTransitionAt":"2026-01-01T00:00:00Z","descriptorAction":"Example cleared action","ownerAgentPrefix":"12345678"}]
```

Board can re-inspect only those entries with `--review-file=PATH --json`,
then apply with `--review-file=PATH --apply --json --older-than=1ns` and the
Board key, Board agent ID, agent ID and run ID in the environment. Apply is
limited to reviewed self-owned transitions and serially spaced by 12 seconds.
It rejects missing or changed transitions, descriptor actions and owners, and
rechecks live dependencies, interactions, approvals, recovery actions and
monitor timing. It checks the issue again after those reads. The apply request
uses `PATCH /api/issues/:id/guarded-unblock` with only `status: "todo"` and
`expectedBlockedTransition`: the observed `statusVersion`, `updatedAt`,
`blockedTransitionAt`, and complete `blockedByIssueIds` from diagnostics.
The server checks the blocked issue and dependency readiness under transaction
locks; a stale snapshot must be reviewed again. A missing endpoint or any
error is a failed apply, never a reason to fall back to the ordinary PATCH.
This guard does not make the preceding interaction, approval and recovery reads
atomic; Board must still review those gates. It does not establish clearance.

`--cleanup-decisions` is inspection-only and requires the Board credential;
it cannot be combined with apply. Peer redelivery and Board routing appear in
dry-run reports but are not executed by this targeted apply. Decision cleanup
and other live branches require a separate reviewed procedure.
