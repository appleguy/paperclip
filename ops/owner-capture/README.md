# Owner event identity

`owner-guard` is the source for the deployed hook at
`/Volumes/NVM/Paperclip/ops/owner-capture/owner-guard`. The deployment's existing
README documents the ledger lifecycle, gate, adoption and escalation commands.

Capture deduplicates an occurrence by native `message_id`, `event_id`, `turn_id`,
`prompt_id` or `uuid`, scoped to the full session. Transcript scans carry native
message identity (Claude UUID / OpenCode message ID) or an append-only row
position for Codex rows lacking IDs. Repeated text is never a deduplication key.
Existing records, close events and watches are retained without rewriting.

`owner-guard correct-non-owner FULL-ID REASON` appends an attributed disposition
for an independently verified non-owner receipt, including one already closed.
It ends the watch and remains effective against stale watch or reopen events.
The exact ID and evidence-bearing reason are required; classification is manual.

Without a native occurrence ID, neither matching text nor a transcript frontier
identifies a hook occurrence. Each ambiguous receipt is retained independently,
even if a later transcript scan creates another record. Peer-mail batch, thread
and message IDs do not identify a pre-append Codex turn. Independently verified
peer records can be corrected with the full-ID command above. OpenCode NAR
receipts are excluded only when the managed-session metadata and native message
ID identify the injection; an ID-less receipt remains eligible.

`note SRC [REASON...]` generates a fresh Steering submission identity and prints
its record ID. A retry-capable caller can set `OWNER_GUARD_EVENT_ID` to a stable
submission ID; it must generate a new ID for each independent submission. The
OpenCode shim forwards `m.id`, matching both supported DB scan schemas.

Run `node --test ops/owner-capture/event-identity.test.mjs`. All inputs and state
are synthetic and retained under NVM scratch. Text fixtures are archived rather
than deleted, per `file-hygiene`; no production ledger is mutated by tests.

Capture and scans retain nonempty text even when it resembles a wake, peer mail,
tool result, or health probe. Text shape is not authentication. Trusted Codex
provenance, guardian/exec transport, Claude metadata, and OpenCode synthetic or
identified NAR occurrences remain excluded. Unattributed injections can thus
appear in the ledger and require independent verification and correction; this
is preferable to silently dropping genuine steering. Run
`node --test ops/owner-capture/quoted-markers.test.mjs` for parity and ambiguous
envelope fixtures.

Deployment belongs to the outside Platform Lead: recheck the actual source/live
diff against the then-current live script and preserve any newer live protections
before hot installation. Archive the live baseline; do not replace ledger files,
restart sessions, or change hook trust.
