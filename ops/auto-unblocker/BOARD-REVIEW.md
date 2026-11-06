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

## Reviewed live result and remaining evidence

Board's SCO-1154 inspection checked 88 blocked issues: 10 self-review, 61
Board-routing, 7 live dependencies, 6 active recoveries, 2 existing decisions
and 2 exceptions. None of the self-review actions was cleared, and there was no
peer-redelivery candidate. Board cancelled the one stale auto-unblocker decision
for SCO-682, which was already in progress with its 24-hour monitor; its
receipt confirms cancellation and reason. Open auto-unblocker decisions went
from 42 to 41. This did not unblock the issue. Seven other stale and seven
agent-owned proposals remain individually reviewable, not pre-authorized.

This is one live cancellation example, not acceptance of the remaining branches.
The prior server 422 test passed. Before/after self-owned counts attributable
to a cleanup and live self-transition, peer-redelivery and Board-routing
examples remain outstanding. No broad cleanup or owner question follows.

## Minimal pilot boundary

SCO-1010 is a real Board-owned blocked transition, but it explicitly waits for
SCO-1029, which was still blocked on inspection. It is not cleared for a card
or a wake; preserve its dependency and recovery instructions. SCO-1021 is also
Board-owned and is waiting for an existing seat to start naturally; do not
create a card to manufacture a pilot. Select a fresh actual candidate only when
Board verifies a new actionable request and no existing path handles it.

For a single Board-routing pilot, the server must first accept the expected
blocked transition, owner and descriptor as a precondition to creating the
interaction. Under the same issue-row lock used for insertion, compare the
expected transition and descriptor, reject changed or non-blocked state, and
check existing applicable interactions and other relevant gates. Create at most
one Board-addressed interaction with a stable key scoped to issue and blocked
transition; reuse the exact same request on retry and inspect its returned
status. The current interaction service locks the issue and enforces unique
issue/idempotency keys, but checks only terminal status, not the expected blocked
transition; a client re-read followed by POST can therefore create a stale
card. No guarded interaction-create contract is established by this report.

For a peer pilot, first establish a real other-agent owner and inspect its
existing wake receipt and the intended transition. The original notification
uses `issue-unblock:<issue-id>:<transition>` and records a notified timestamp,
so repeating that same key is not evidence of a fresh delivery. A safe retry
needs a reviewed server-side transition/owner check and durable single-retry
claim with a distinct stable key, a uniqueness or equivalent lock boundary,
and a receipt distinguishing queued, coalesced and delivered. The present
`issue-unblock:` key has no matching unique index in the wake-request schema;
do not assume a key alone prevents concurrent duplicates or overstate delivery.
Runner-core changes remain with the outside Platform Lead. Neither pilot is
implemented or authorized merely by this proposal.
