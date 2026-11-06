# SCO-1105: bounded cleanup review

The legacy broad apply is retired. The operational `go run .` redirects to
this directory; an apply requires a file of individually Board-cleared
transitions. Board has cleared no self-review transitions for bulk apply.
The other branches below remain inspection-only, not authorization to execute.
Refresh live state before reviewing any candidate; the proof report is a
snapshot, not evidence that a descriptor action has cleared.

* **Self-owned:** Re-read the exact descriptor action and its owner, transition,
  dependencies, pending interaction, approval, recovery, execution lock and
  monitor. Preserve owner, manual, provider, resource and future-time holds.
  Only Board may enter an individually cleared transition in a review file.
  The guarded endpoint checks transition and gates atomically, and the caller
  limits moves to one per 12 seconds. A conflict requires a fresh review.
* **Other agent owner:** SCO-1010 appeared as a redelivery proposal in the
  read-only snapshot. First revalidate the issue, owner and transition, and
  inspect existing wake/receipt state. A transition-bound idempotent delivery
  mechanism and its concurrency behavior must be identified and reviewed
  before a live pilot. This caller does not deliver this branch.
* **Board or user owner:** Inspect the descriptor and existing pending
  interactions. If a Board-first interaction is still appropriate, review a
  single candidate and an idempotency key tied to its blocked transition,
  explicitly addressed to Board. Avoid a duplicate or an owner decision. This
  caller does not create this branch.
* **Stale or misrouted decisions:** Board can inspect with
  `go run . --cleanup-decisions --json`; this requires Board's credential.
  Inspect each original decision, its originating rule and current issue state.
  Preserve genuine Board/user-owned decisions. Review one exact cancellation
  and its reason before using the cancellation API. The tool's inspection
  mode cannot cancel. A read followed by cancellation is not an atomic
  issue-state guarantee; do not infer one.

Record decision counts before and after any Board-approved action, along with
the exact issue and resulting state. A dry-run proposal is not a live branch
example. No broad cleanup, owner question, or apply follows from this document.
