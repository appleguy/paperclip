# Owner event identity

`owner-guard` is the source for the deployed hook at
`/Volumes/NVM/Paperclip/ops/owner-capture/owner-guard`. The deployment's existing
README documents the ledger lifecycle, gate, adoption and escalation commands.

Capture deduplicates an occurrence by native `message_id`, `event_id`, `turn_id`,
`prompt_id` or `uuid`, scoped to the full session. Transcript scans carry native
message identity (Claude UUID / OpenCode message ID) or an append-only row
position for Codex rows lacking IDs. Repeated text is never a deduplication key.
Existing records, close events and watches are retained without rewriting.

For pre-append Claude/Codex hooks lacking a native ID, the transcript path and
line frontier identify hook redelivery. A later scan binds the first matching
row to that receipt by appending an identity alias; closure remains effective.
A post-append hook can use the final user row directly. Different turns must
advance the transcript or supply distinct native IDs. A call with neither a
readable transcript nor an event ID is preserved as an independent occurrence:
there is no evidence with which to distinguish a retry from a new owner turn.

`note SRC [REASON...]` generates a fresh Steering submission identity and prints
its record ID. A retry-capable caller can set `OWNER_GUARD_EVENT_ID` to a stable
submission ID; it must generate a new ID for each independent submission. The
OpenCode shim forwards `m.id`, matching both supported DB scan schemas.

Run `node --test ops/owner-capture/event-identity.test.mjs`. All inputs and state
are synthetic and retained under NVM scratch. Text fixtures are archived rather
than deleted, per `file-hygiene`; no production ledger is mutated by tests.

Deployment: preserve a pre-change copy under the deployment's `archive/`, then
copy the committed `owner-guard` and `opencode/owner-guard.js` to their matching
deployment paths. No service restart or live session interruption is required.
Rollback restores those two archived files; ledger history remains intact.
