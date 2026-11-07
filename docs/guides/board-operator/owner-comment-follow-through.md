---
title: Owner comment follow-through
summary: How Paperclip routes and records owner feedback on tasks, documents, and artifact reviews
---

Paperclip recognizes direct comments and edits by an active company member whose membership role is `owner`. The source record remains authoritative. Text quoted inside a comment, document, or artifact is context to review, not permission to bypass approvals, spending limits, or other human-only controls.

## What the server routes automatically

The shared delivery coordinator watches committed issue activity and reconstructs pending intake from a per-company cursor after startup. Its append-only mapping records the source activity, author, source trust, delivery state, linked task, and eventual disposition in `activity_log`; source text is re-read from the source record before a wake is created.

The current supported surfaces are:

- Issue comments by an owner. Paperclip uses the normal assignee wake first. Reconciliation checks the durable wake and, after a short grace period, creates an idempotent fallback wake if the normal wake is missing.
- Comments and replies in issue document annotation threads, including Markdown artifact-review documents.
- Owner-reopened issue document annotation threads.
- Owner edits to issue documents, including Markdown artifact-review documents.
- Owner updates to native issue work-product records.

For annotations and artifact updates, the server wakes the current assignee when the source task remains active and assigned. If there is no active assignee, or the task is terminal, the ledger records the exact blocker for agent or owner judgment. The reconciler does not create tasks automatically.

`PAPERCLIP_OWNER_COMMENT_INTAKE_BACKFILL_FROM` can set the initial cursor boundary. Its default is `2026-10-29T02:30:00.000Z`. Intake is bounded from that timestamp; it does not replay older history. Existing agent replies in the supported source thread are recognized during backfill to avoid reopening already handled work.

## Agent judgment and receipts

The assignee decides whether feedback belongs in existing work, an inline correction, a bounded linked task, an informational answer, or an exact blocker. Creating separate work is still an agent decision and remains subject to normal task, spend, safety, and approval checks.

When work starts, the agent posts a source-linked receipt and records `stage: "started"`. It records `stage: "completed"` when finished, or `stage: "blocked"` with the exact blocker. The disposition endpoint rejects a receipt unless the responding actor authored it in the same annotation thread, or its issue comment links back to the source comment, document, or work product. A newly created task must be linked in the disposition, and its identifier must appear in the receipt.

Typical source references are `#comment-<id>` for issue comments, a reply in the annotation thread for annotations, `#document-<key>` for document edits, and the work-product ID for work-product edits. For separate work, include the linked issue identifier in the receipt.

## Surfaces not covered by this worker

The current reconciler does not ingest routine or case document annotations, approval discussion/comments, comments that exist only in external chat or provider systems, non-Markdown artifacts without a native Paperclip work-product activity, or edits made directly in an external artifact provider without a corresponding Paperclip activity. These surfaces need their own supported event source before they can be described as covered.

## Delivery and verification limits

The queue registration and transactional activity signal configure delivery. They do not by themselves prove that a particular agent started work. The durable mapping distinguishes pending intake, a queued wake, an actual start, completion, an existing receipt, and a blocker. A wake can be coalesced by Paperclip; an agent receipt is the evidence of follow-through.

The embedded-Postgres integration test for owner-comment intake exercises each supported source kind, a native issue-comment wake, a duplicate source event, process restart recovery, linked receipt validation, and idempotent start/completion updates. This verifies the server path in that test environment. It does not establish universal coverage for deployments or unsupported surfaces.

Run the integration test from the repository root with:

```sh
pnpm exec vitest run server/src/__tests__/owner-comment-intake.test.ts
```
