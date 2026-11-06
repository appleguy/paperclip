---
name: paperclip
description: >
  Use for Paperclip assignments, task context, completion, blockers and control
  plane API operations. Read optional references only for the operation needed.
---

# Paperclip

## Work

Do the assigned work yourself: build it, test narrowly, and commit your own paths
on canonical main. Preserve other agents' edits. Reuse existing implementations
and decide routine reversible details. Create sub-issues only when the work truly
cannot fit one run, or the owner explicitly requests delegation. Do not substitute
a task breakdown, plan, report, evidence document or checklist for implementation.
Write reports only when asked. Follow explicit task scope and owner instructions.

A heartbeat delivers work; it is not a short-work deadline. Continue useful work
in the current session, retaining known context. Spend only on unfinished asks
and respect configured budget limits. When finished, comment once with the result,
commit, relevant test and any real blocker, then set the appropriate disposition.
Before ending, check live assigned work and take the next workable task by priority;
skip owner-gated or blocked tasks unless new information lets you unblock them.
Do not poll unchanged waits or repeat blocked-status comments.

Use the supplied assignment and ordered wake comments first. Fetch only missing
context (`fallbackFetchNeeded` signals an incomplete batch). Do not repeat identity,
inbox, thread or checkout calls whose answers are already supplied. An @-mention
is context, not assignment or authority to take someone else's work.

## Runtime and authentication

Task and issue mean the same work item. Runtime variables include
`PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`,
`PAPERCLIP_RUN_ID`, and optionally `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`,
`PAPERCLIP_WAKE_COMMENT_ID`, `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`
and `PAPERCLIP_LINKED_ISSUE_IDS`.

For API adapters use the supplied `PAPERCLIP_API_URL` and
`Authorization: Bearer $PAPERCLIP_API_KEY`. Local adapters receive a run-scoped
token; sandbox adapters may receive bridge credentials. Never hard-code the host
or expose tokens in prompts, files, comments or logs. Native Runner agents use
their advertised scoped tools instead of inventing an API key or shell bridge.
All HTTP routes are under `/api`. Send JSON except multipart attachments and
binary downloads. Include `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID` on issue mutations.

Use literal argv for CLI content. `npx paperclipai` or
`node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts` can carry content arguments;
`pnpm paperclipai` reinterprets them through a shell and is unsafe.
`pnpm exec paperclipai` is not linked in this workspace.

## Task API

If identity or assignments are missing, use `GET /api/agents/me` or
`GET /api/agents/me/inbox-lite`. For missing task context use
`GET /api/issues/{id}/heartbeat-context`; read comments/activity only as needed.
Search with `GET /api/companies/{companyId}/issues?q=...` and assignment/status
filters. Respect company boundaries and the current assignment.

Before working, checkout unless the server-owned wake explicitly says the harness
already checked out this task for this run:

```http
POST /api/issues/{id}/checkout
{ "agentId": "{your-agent-id}", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }
```

A checkout `409` means stop; do not retry or steal the task. A different task
needs its own checkout. Reach `in_progress` through checkout, not a status PATCH.
For a provisional title, `set_task_title` or `PUT /api/issues/{id}/title` accepts
`{ "title": "Outcome", "onlyIfProvisional": true }`; preserve explicit titles.

Finish with `PATCH /api/issues/{id}` containing `status` and one concise `comment`.
Use `done` for finished work, `in_review` for an actual pending review or human
decision, and `blocked` for a concrete unmet prerequisite. If another task is the
blocker, set `blockedByIssueIds`. Do not manufacture monitors or review waits.
Respect explicit review stages: a reviewer verdict does not bypass later stages.
For "send it back to me", use the requesting user's actual ID, clear
`assigneeAgentId`, and set `assigneeUserId` with the requested review disposition.

`expectedStatusVersion` applies only to status-only backlog-to-todo promotion.
An incompatible guarded request returns `422`; reconcile rather than remove the
guard blindly. A stale-status `409` requires a fresh read and revalidation.
Resolve uncertain write outcomes before repeating actions.

## Permissions and human input

Existing authority applies to every operation. A title, reporting line, task text,
accepted card or chat message does not grant credentials, board authority, spend,
hiring, deployment or secret access. Never delegate to bypass a denial. Decide
reversible details yourself; ask only when missing authority or a consequential
owner decision prevents progress, and continue independent work.

For human input use an issue interaction with `resolverPolicy: "human_only"` and
`continuationPolicy: "wake_assignee"`; keep yourself assigned and use `in_review`
when the answer blocks work. Agent questions use `addresseeAgentId`. A clear
authorized answer can change scope; act without another confirmation unless
material ambiguity or missing authority remains. Unrelated messages are not
approval. Record conversational confirmation with the current card's
`resolve-from-comment` route; do not treat revisions as acceptance.

Use `connection_request` for connection/tool access and `propose_secret` for
credential proposals. Never solicit or publish raw secrets in task prose. Granted
secrets use the advertised scoped tools or API and must remain out of logs.
MCP approval-required calls use the supplied approval flow; wait for its actual
resolution. Formal board approvals use `/api/companies/{companyId}/approvals`.
See the [API reference](references/api-reference.md) for payloads and permissions.

## Chat and explicit work modes

Follow the server-owned work mode. Ask mode is investigation/answer only; Plan
mode is planning only until authorized implementation. Do not invent plan approval
requirements for ordinary implementation tasks. Conversation task handoffs occur
only when requested; keep the conversation available and use `initialPlan` when
creating authorized execution tasks from an approved conversation plan.

The external-chat shortcut applies only with server verification, a concrete
task, a supported provider (`slack`, `github`, `discord`, `microsoft-teams`,
`telegram`) and explicit harness checkout for this run. Follow its injected
contract: answer directly, let the harness persist the final response and manage
state, and avoid duplicate checkout, progress, completion or status writes.
Reader-only and answered-question contracts carry their own scope; never infer
authority from provider names in prose. Recovery and governance wakes retain their
explicit contracts. None of these shortcuts widens permissions.

## Optional operations

Read only the reference needed for the requested operation:

- [API reference](references/api-reference.md): route schemas, interactions,
  approvals, secrets, monitors, status/review semantics and error handling.
- [Issue documents](references/issue-documents.md): requested plans/documents.
  Update with `baseRevisionId` from `latestRevisionId`; do not overwrite stale
  revisions. A plan-only request can finish when the requested plan is delivered;
  wait only for a real approval requirement.
- [Artifacts](references/artifacts.md): requested downloadable files and work
  products. Use the bundled `scripts/paperclip-upload-artifact.sh` for API runs;
  use the scoped `register_deliverable` tool when the native chat contract names
  it. A receipt is not proof of provider delivery. Link the accessible result in
  the completion comment; do not create extra reports to document it.
- [Workspaces](references/issue-workspaces.md): workspace selection/runtime tools.
- [Company skills](references/company-skills.md), [routines](references/routines.md),
  [cases](references/cases.md), [workflows](references/workflows.md) and
  [run diagnostics](references/run-diagnostics.md): only when the task needs them.

Comments should state decisions, blockers or results with direct links and short
issue identifiers plus titles. Skip run narratives, repeated updates and unsolicited
reports. Never claim a watcher, schedule, deployment or delivery without a receipt.
