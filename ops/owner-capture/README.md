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

Receipt capture and Claude, Codex and both OpenCode schema scans share the same
Paperclip envelope classifier (SCO-977). A wake/resume envelope must start the
message, carry its generated opening sentence, and contain reason/issue fields;
a task-context envelope must start the message and contain its issue field.
Owner prose mentioning markers, or preceding a quoted payload with an instruction,
is retained. Existing transport exclusions (Codex exec, Claude metadata and
OpenCode synthetic/compaction rows) still apply. Text structure is a fallback,
not authentication: an exact envelope without origin metadata is ambiguous.
Run `node --test ops/owner-capture/quoted-markers.test.mjs` for receipt/scan parity,
mixed owner-plus-payload cases and automated-envelope exclusions.

The older shared text-based wake and automated-message exclusions above remain
in this source. They can suppress an owner-authored exact envelope without
trusted origin metadata and therefore do not yet meet the no-shape-only
classification requirement. They require reconciliation before installation.

Deployment belongs to the outside Platform Lead: recheck the actual source/live
diff against the then-current live script and preserve any newer live protections
before hot installation. Archive the live baseline; do not replace ledger files,
restart sessions, or change hook trust.
