<!-- GENERATED FILE — DO NOT EDIT. Run pnpm generate:capability-inventory. -->

# Capability Capability Contract

This generated contract is a self-contained derivative of the Paperclip skill, its seven references, the Paperclip Evals corpus, and the legacy MCP tool surface. It does not import or contact the Paperclip control plane.

The skill/reference inventory and eval cases are the only normative behavior sources. Paperclip does not use the legacy MCP calls as a production capability surface; all MCP names below are traceability aliases folded into normative eval rows. Their disposition, grants, assertions, and evidence contract are inherited from the target row rather than classified independently.

## Baseline Counts

- Skill/reference headings: 131
- Eval cases: 106 across 16 groups
- Total normative rows: 237
- Legacy MCP aliases folded into normative rows: 42

| Eval group | Cases |
| --- | ---: |
| hb | 5 |
| co | 6 |
| st | 8 |
| cm | 6 |
| se | 4 |
| su | 4 |
| bl | 5 |
| dp | 3 |
| ix | 9 |
| ap | 6 |
| ar | 4 |
| er | 9 |
| rf | 22 |
| mh | 4 |
| rs | 3 |
| wk | 8 |

## Regeneration

- `pnpm --dir packages/paperclip-runner generate:capability-inventory` imports the canonical baselines and rewrites every generated file.
- `pnpm --dir packages/paperclip-runner check:capability-inventory` validates counts, uniqueness, normative dispositions, one-to-one MCP folds, required fields, and generated-file drift without requiring the external eval repository.

## Skill / Reference Rows

| Capability | Primary disposition | Source anchor |
| --- | --- | --- |
| skill:skills/paperclip/SKILL.md:paperclip:8 | optional_agent_tool | skills/paperclip/SKILL.md:8 |
| skill:skills/paperclip/SKILL.md:work:10 | optional_agent_tool | skills/paperclip/SKILL.md:10 |
| skill:skills/paperclip/SKILL.md:runtime-and-authentication:28 | control_plane_owned | skills/paperclip/SKILL.md:28 |
| skill:skills/paperclip/SKILL.md:task-api:45 | optional_agent_tool | skills/paperclip/SKILL.md:45 |
| skill:skills/paperclip/SKILL.md:permissions-and-human-input:88 | optional_agent_tool | skills/paperclip/SKILL.md:88 |
| skill:skills/paperclip/SKILL.md:chat-and-explicit-work-modes:130 | optional_agent_tool | skills/paperclip/SKILL.md:130 |
| skill:skills/paperclip/SKILL.md:optional-operations:145 | optional_agent_tool | skills/paperclip/SKILL.md:145 |
| skill:skills/paperclip/references/api-reference.md:paperclip-api-reference:1 | optional_agent_tool | skills/paperclip/references/api-reference.md:1 |
| skill:skills/paperclip/references/api-reference.md:response-schemas:9 | optional_agent_tool | skills/paperclip/references/api-reference.md:9 |
| skill:skills/paperclip/references/api-reference.md:agent-record-get-api-agents-me-or-get-api-agents-agentid:11 | optional_agent_tool | skills/paperclip/references/api-reference.md:11 |
| skill:skills/paperclip/references/api-reference.md:company-portability:44 | optional_agent_tool | skills/paperclip/references/api-reference.md:44 |
| skill:skills/paperclip/references/api-reference.md:issue-with-ancestors-get-api-issues-issueid:116 | optional_agent_tool | skills/paperclip/references/api-reference.md:116 |
| skill:skills/paperclip/references/api-reference.md:issue-update-response-patch-api-issues-issueid:202 | optional_agent_tool | skills/paperclip/references/api-reference.md:202 |
| skill:skills/paperclip/references/api-reference.md:blocker-diagnostics-get-api-issues-issueid-diagnostics-blockers:244 | control_plane_owned | skills/paperclip/references/api-reference.md:244 |
| skill:skills/paperclip/references/api-reference.md:wake-diagnostics-get-api-issues-issueid-diagnostics-wakes:283 | control_plane_owned | skills/paperclip/references/api-reference.md:283 |
| skill:skills/paperclip/references/api-reference.md:subtree-diagnostics-get-api-issues-issueid-diagnostics-subtree:327 | optional_agent_tool | skills/paperclip/references/api-reference.md:327 |
| skill:skills/paperclip/references/api-reference.md:execution-policy-fields-on-an-issue:375 | optional_agent_tool | skills/paperclip/references/api-reference.md:375 |
| skill:skills/paperclip/references/api-reference.md:cross-agent-review-gates:427 | always_agent_tool | skills/paperclip/references/api-reference.md:427 |
| skill:skills/paperclip/references/api-reference.md:worked-example-ic-heartbeat:460 | optional_agent_tool | skills/paperclip/references/api-reference.md:460 |
| skill:skills/paperclip/references/api-reference.md:1-identity-skip-if-already-in-context:465 | control_plane_owned | skills/paperclip/references/api-reference.md:465 |
| skill:skills/paperclip/references/api-reference.md:2-check-inbox:469 | control_plane_owned | skills/paperclip/references/api-reference.md:469 |
| skill:skills/paperclip/references/api-reference.md:3-already-have-issue-101-inprogress-highest-priority-continue-it:476 | optional_agent_tool | skills/paperclip/references/api-reference.md:476 |
| skill:skills/paperclip/references/api-reference.md:4-do-the-actual-work-write-code-run-tests:483 | optional_agent_tool | skills/paperclip/references/api-reference.md:483 |
| skill:skills/paperclip/references/api-reference.md:5-work-is-done-update-status-and-comment-in-one-call:485 | always_agent_tool | skills/paperclip/references/api-reference.md:485 |
| skill:skills/paperclip/references/api-reference.md:6-still-have-time-checkout-the-next-task:489 | control_plane_owned | skills/paperclip/references/api-reference.md:489 |
| skill:skills/paperclip/references/api-reference.md:7-made-partial-progress-not-done-yet-comment-and-exit:496 | always_agent_tool | skills/paperclip/references/api-reference.md:496 |
| skill:skills/paperclip/references/api-reference.md:worked-example-report-a-board-user-s-mine-inbox:501 | control_plane_owned | skills/paperclip/references/api-reference.md:501 |
| skill:skills/paperclip/references/api-reference.md:board-user-created-the-requesting-issue:506 | optional_agent_tool | skills/paperclip/references/api-reference.md:506 |
| skill:skills/paperclip/references/api-reference.md:fetch-the-board-user-s-mine-inbox-issues:510 | control_plane_owned | skills/paperclip/references/api-reference.md:510 |
| skill:skills/paperclip/references/api-reference.md:summarize-it-back-to-the-board-in-a-comment-or-document:524 | always_agent_tool | skills/paperclip/references/api-reference.md:524 |
| skill:skills/paperclip/references/api-reference.md:worked-example-archive-a-resolved-inbox-item:529 | control_plane_owned | skills/paperclip/references/api-reference.md:529 |
| skill:skills/paperclip/references/api-reference.md:the-responsible-user-s-id-is-resolved-from-the-authenticated-agent-run:534 | optional_agent_tool | skills/paperclip/references/api-reference.md:534 |
| skill:skills/paperclip/references/api-reference.md:reverse-the-archive-if-it-was-premature-or-no-longer-desired:543 | optional_agent_tool | skills/paperclip/references/api-reference.md:543 |
| skill:skills/paperclip/references/api-reference.md:worked-example-reviewer-approver-heartbeat:553 | always_agent_tool | skills/paperclip/references/api-reference.md:553 |
| skill:skills/paperclip/references/api-reference.md:delegation:592 | optional_agent_tool | skills/paperclip/references/api-reference.md:592 |
| skill:skills/paperclip/references/api-reference.md:comments-and-mentions:601 | always_agent_tool | skills/paperclip/references/api-reference.md:601 |
| skill:skills/paperclip/references/api-reference.md:update:608 | optional_agent_tool | skills/paperclip/references/api-reference.md:608 |
| skill:skills/paperclip/references/api-reference.md:cross-team-work-and-delegation:630 | optional_agent_tool | skills/paperclip/references/api-reference.md:630 |
| skill:skills/paperclip/references/api-reference.md:receiving-cross-team-work:634 | optional_agent_tool | skills/paperclip/references/api-reference.md:634 |
| skill:skills/paperclip/references/api-reference.md:questions-and-dependencies:644 | always_agent_tool | skills/paperclip/references/api-reference.md:644 |
| skill:skills/paperclip/references/api-reference.md:company-context:656 | optional_agent_tool | skills/paperclip/references/api-reference.md:656 |
| skill:skills/paperclip/references/api-reference.md:company-branding-ceo-board:668 | optional_agent_tool | skills/paperclip/references/api-reference.md:668 |
| skill:skills/paperclip/references/api-reference.md:openclaw-invite-prompt-ceo:688 | optional_agent_tool | skills/paperclip/references/api-reference.md:688 |
| skill:skills/paperclip/references/api-reference.md:setting-agent-instructions-path:707 | optional_agent_tool | skills/paperclip/references/api-reference.md:707 |
| skill:skills/paperclip/references/api-reference.md:project-setup-create-workspace:740 | optional_agent_tool | skills/paperclip/references/api-reference.md:740 |
| skill:skills/paperclip/references/api-reference.md:option-a-one-call-create-with-workspace:764 | optional_agent_tool | skills/paperclip/references/api-reference.md:764 |
| skill:skills/paperclip/references/api-reference.md:option-b-two-calls-project-first-then-workspace:783 | optional_agent_tool | skills/paperclip/references/api-reference.md:783 |
| skill:skills/paperclip/references/api-reference.md:governance-and-approvals:812 | optional_agent_tool | skills/paperclip/references/api-reference.md:812 |
| skill:skills/paperclip/references/api-reference.md:requesting-a-hire-management-only:816 | optional_agent_tool | skills/paperclip/references/api-reference.md:816 |
| skill:skills/paperclip/references/api-reference.md:ceo-strategy-approval:881 | optional_agent_tool | skills/paperclip/references/api-reference.md:881 |
| skill:skills/paperclip/references/api-reference.md:questions-and-waiting-for-human-input:890 | always_agent_tool | skills/paperclip/references/api-reference.md:890 |
| skill:skills/paperclip/references/api-reference.md:issue-thread-confirmations:994 | always_agent_tool | skills/paperclip/references/api-reference.md:994 |
| skill:skills/paperclip/references/api-reference.md:conversational-confirmation-answers:1052 | always_agent_tool | skills/paperclip/references/api-reference.md:1052 |
| skill:skills/paperclip/references/api-reference.md:checkbox-confirmations:1058 | always_agent_tool | skills/paperclip/references/api-reference.md:1058 |
| skill:skills/paperclip/references/api-reference.md:item-verdict-requests:1173 | optional_agent_tool | skills/paperclip/references/api-reference.md:1173 |
| skill:skills/paperclip/references/api-reference.md:checking-approval-status:1283 | optional_agent_tool | skills/paperclip/references/api-reference.md:1283 |
| skill:skills/paperclip/references/api-reference.md:approval-follow-up-requesting-agent:1289 | always_agent_tool | skills/paperclip/references/api-reference.md:1289 |
| skill:skills/paperclip/references/api-reference.md:issue-lifecycle:1307 | always_agent_tool | skills/paperclip/references/api-reference.md:1307 |
| skill:skills/paperclip/references/api-reference.md:error-handling:1337 | control_plane_owned | skills/paperclip/references/api-reference.md:1337 |
| skill:skills/paperclip/references/api-reference.md:full-api-reference:1351 | optional_agent_tool | skills/paperclip/references/api-reference.md:1351 |
| skill:skills/paperclip/references/api-reference.md:agents:1353 | optional_agent_tool | skills/paperclip/references/api-reference.md:1353 |
| skill:skills/paperclip/references/api-reference.md:issues-tasks:1374 | optional_agent_tool | skills/paperclip/references/api-reference.md:1374 |
| skill:skills/paperclip/references/api-reference.md:companies-projects-goals:1415 | optional_agent_tool | skills/paperclip/references/api-reference.md:1415 |
| skill:skills/paperclip/references/api-reference.md:routines:1439 | optional_agent_tool | skills/paperclip/references/api-reference.md:1439 |
| skill:skills/paperclip/references/api-reference.md:approvals-costs-activity-dashboard:1455 | optional_agent_tool | skills/paperclip/references/api-reference.md:1455 |
| skill:skills/paperclip/references/api-reference.md:secrets:1477 | optional_agent_tool | skills/paperclip/references/api-reference.md:1477 |
| skill:skills/paperclip/references/api-reference.md:agent-secret-proposals:1490 | optional_agent_tool | skills/paperclip/references/api-reference.md:1490 |
| skill:skills/paperclip/references/api-reference.md:agent-secret-access:1590 | optional_agent_tool | skills/paperclip/references/api-reference.md:1590 |
| skill:skills/paperclip/references/api-reference.md:common-mistakes:1630 | optional_agent_tool | skills/paperclip/references/api-reference.md:1630 |
| skill:skills/paperclip/references/artifacts.md:generated-artifacts-and-work-products:1 | always_agent_tool | skills/paperclip/references/artifacts.md:1 |
| skill:skills/paperclip/references/artifacts.md:workspace-only-file-references:15 | optional_agent_tool | skills/paperclip/references/artifacts.md:15 |
| skill:skills/paperclip/references/cases.md:cases:1 | optional_agent_tool | skills/paperclip/references/cases.md:1 |
| skill:skills/paperclip/references/cases.md:core-model:43 | optional_agent_tool | skills/paperclip/references/cases.md:43 |
| skill:skills/paperclip/references/cases.md:upsert-semantics:62 | optional_agent_tool | skills/paperclip/references/cases.md:62 |
| skill:skills/paperclip/references/cases.md:start-and-hand-off-work:100 | optional_agent_tool | skills/paperclip/references/cases.md:100 |
| skill:skills/paperclip/references/cases.md:example-factory-instructions:249 | optional_agent_tool | skills/paperclip/references/cases.md:249 |
| skill:skills/paperclip/references/cases.md:read-and-search:272 | optional_agent_tool | skills/paperclip/references/cases.md:272 |
| skill:skills/paperclip/references/cases.md:task-documents-and-legacy-case-documents:355 | always_agent_tool | skills/paperclip/references/cases.md:355 |
| skill:skills/paperclip/references/cases.md:fields:389 | optional_agent_tool | skills/paperclip/references/cases.md:389 |
| skill:skills/paperclip/references/cases.md:issue-links:422 | optional_agent_tool | skills/paperclip/references/cases.md:422 |
| skill:skills/paperclip/references/cases.md:child-cases:447 | optional_agent_tool | skills/paperclip/references/cases.md:447 |
| skill:skills/paperclip/references/cases.md:attachments:466 | optional_agent_tool | skills/paperclip/references/cases.md:466 |
| skill:skills/paperclip/references/cases.md:lifecycle:479 | optional_agent_tool | skills/paperclip/references/cases.md:479 |
| skill:skills/paperclip/references/cases.md:worked-blog-post-example:493 | optional_agent_tool | skills/paperclip/references/cases.md:493 |
| skill:skills/paperclip/references/company-skills.md:company-skills-workflow:1 | optional_agent_tool | skills/paperclip/references/company-skills.md:1 |
| skill:skills/paperclip/references/company-skills.md:what-exists:5 | optional_agent_tool | skills/paperclip/references/company-skills.md:5 |
| skill:skills/paperclip/references/company-skills.md:permission-model:22 | optional_agent_tool | skills/paperclip/references/company-skills.md:22 |
| skill:skills/paperclip/references/company-skills.md:core-endpoints:29 | optional_agent_tool | skills/paperclip/references/company-skills.md:29 |
| skill:skills/paperclip/references/company-skills.md:install-a-skill-into-the-company:65 | optional_agent_tool | skills/paperclip/references/company-skills.md:65 |
| skill:skills/paperclip/references/company-skills.md:app-shipped-catalog:75 | optional_agent_tool | skills/paperclip/references/company-skills.md:75 |
| skill:skills/paperclip/references/company-skills.md:external-source-import:101 | optional_agent_tool | skills/paperclip/references/company-skills.md:101 |
| skill:skills/paperclip/references/company-skills.md:source-types-in-order-of-preference:105 | optional_agent_tool | skills/paperclip/references/company-skills.md:105 |
| skill:skills/paperclip/references/company-skills.md:example-skills-sh-import-preferred:116 | optional_agent_tool | skills/paperclip/references/company-skills.md:116 |
| skill:skills/paperclip/references/company-skills.md:example-github-import:138 | optional_agent_tool | skills/paperclip/references/company-skills.md:138 |
| skill:skills/paperclip/references/company-skills.md:inspect-what-was-installed:164 | optional_agent_tool | skills/paperclip/references/company-skills.md:164 |
| skill:skills/paperclip/references/company-skills.md:assign-skills-to-an-existing-agent:181 | optional_agent_tool | skills/paperclip/references/company-skills.md:181 |
| skill:skills/paperclip/references/company-skills.md:include-skills-during-hire-or-create:216 | optional_agent_tool | skills/paperclip/references/company-skills.md:216 |
| skill:skills/paperclip/references/company-skills.md:notes:256 | optional_agent_tool | skills/paperclip/references/company-skills.md:256 |
| skill:skills/paperclip/references/issue-documents.md:issue-documents-through-the-api:1 | always_agent_tool | skills/paperclip/references/issue-documents.md:1 |
| skill:skills/paperclip/references/issue-documents.md:create-a-document:8 | always_agent_tool | skills/paperclip/references/issue-documents.md:8 |
| skill:skills/paperclip/references/issue-documents.md:update-or-resolve-an-unclear-write:49 | optional_agent_tool | skills/paperclip/references/issue-documents.md:49 |
| skill:skills/paperclip/references/issue-workspaces.md:issue-workspace-runtime-controls:1 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:1 |
| skill:skills/paperclip/references/issue-workspaces.md:discover-the-workspace:5 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:5 |
| skill:skills/paperclip/references/issue-workspaces.md:choose-files-and-repositories:23 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:23 |
| skill:skills/paperclip/references/issue-workspaces.md:control-services:37 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:37 |
| skill:skills/paperclip/references/issue-workspaces.md:start-all-configured-services-waits-for-configured-readiness-checks:42 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:42 |
| skill:skills/paperclip/references/issue-workspaces.md:restart-all-configured-services:50 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:50 |
| skill:skills/paperclip/references/issue-workspaces.md:stop-all-running-services:58 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:58 |
| skill:skills/paperclip/references/issue-workspaces.md:read-the-url:77 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:77 |
| skill:skills/paperclip/references/issue-workspaces.md:mcp-tools:86 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:86 |
| skill:skills/paperclip/references/routines.md:paperclip-routines:1 | optional_agent_tool | skills/paperclip/references/routines.md:1 |
| skill:skills/paperclip/references/routines.md:lifecycle:16 | optional_agent_tool | skills/paperclip/references/routines.md:16 |
| skill:skills/paperclip/references/routines.md:creating-a-routine:27 | optional_agent_tool | skills/paperclip/references/routines.md:27 |
| skill:skills/paperclip/references/routines.md:concurrency-policies:64 | optional_agent_tool | skills/paperclip/references/routines.md:64 |
| skill:skills/paperclip/references/routines.md:catch-up-policies:76 | optional_agent_tool | skills/paperclip/references/routines.md:76 |
| skill:skills/paperclip/references/routines.md:activity-gated-scheduled-runs:87 | optional_agent_tool | skills/paperclip/references/routines.md:87 |
| skill:skills/paperclip/references/routines.md:example-skip-quiet-nights:107 | optional_agent_tool | skills/paperclip/references/routines.md:107 |
| skill:skills/paperclip/references/routines.md:adding-triggers:126 | optional_agent_tool | skills/paperclip/references/routines.md:126 |
| skill:skills/paperclip/references/routines.md:schedule-cron:136 | optional_agent_tool | skills/paperclip/references/routines.md:136 |
| skill:skills/paperclip/references/routines.md:webhook:150 | optional_agent_tool | skills/paperclip/references/routines.md:150 |
| skill:skills/paperclip/references/routines.md:api-manual-only:167 | optional_agent_tool | skills/paperclip/references/routines.md:167 |
| skill:skills/paperclip/references/routines.md:updating-and-deleting-triggers:179 | optional_agent_tool | skills/paperclip/references/routines.md:179 |
| skill:skills/paperclip/references/routines.md:manual-run:196 | optional_agent_tool | skills/paperclip/references/routines.md:196 |
| skill:skills/paperclip/references/routines.md:updating-a-routine:212 | optional_agent_tool | skills/paperclip/references/routines.md:212 |
| skill:skills/paperclip/references/routines.md:reading-routines-and-runs:223 | optional_agent_tool | skills/paperclip/references/routines.md:223 |
| skill:skills/paperclip/references/workflows.md:paperclip-workflow-playbooks:1 | optional_agent_tool | skills/paperclip/references/workflows.md:1 |
| skill:skills/paperclip/references/workflows.md:project-setup-ceo-manager:7 | optional_agent_tool | skills/paperclip/references/workflows.md:7 |
| skill:skills/paperclip/references/workflows.md:openclaw-invite-ceo:22 | optional_agent_tool | skills/paperclip/references/workflows.md:22 |
| skill:skills/paperclip/references/workflows.md:setting-agent-instructions-path:50 | optional_agent_tool | skills/paperclip/references/workflows.md:50 |
| skill:skills/paperclip/references/workflows.md:company-import-export:79 | optional_agent_tool | skills/paperclip/references/workflows.md:79 |
| skill:skills/paperclip/references/workflows.md:self-test-playbook-app-level:106 | optional_agent_tool | skills/paperclip/references/workflows.md:106 |

## Legacy MCP Alias Index

This is a compatibility/traceability index, not a tool catalog. “Inherited disposition” is shown only to make the normative target easy to audit.

| Legacy MCP name | Folded into normative row | Inherited disposition | Source anchor |
| --- | --- | --- | --- |
| paperclipMe | eval:hb-inbox-lite-01 | control_plane_owned | packages/mcp-server/src/tools.ts:291 |
| paperclipInboxLite | eval:hb-inbox-lite-01 | control_plane_owned | packages/mcp-server/src/tools.ts:297 |
| paperclipListAgents | eval:rf-api-mgr-heartbeat-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:303 |
| paperclipListSkills | eval:rf-cskill-audit-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:309 |
| paperclipGetAgent | eval:rf-api-mgr-heartbeat-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:315 |
| paperclipListIssues | eval:se-q-filters-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:324 |
| paperclipGetIssue | eval:se-get-issue-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:339 |
| paperclipGetHeartbeatContext | eval:hb-context-01 | control_plane_owned | packages/mcp-server/src/tools.ts:345 |
| paperclipListComments | eval:se-get-issue-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:354 |
| paperclipGetComment | eval:hb-wake-comment-01 | control_plane_owned | packages/mcp-server/src/tools.ts:367 |
| paperclipListIssueApprovals | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:374 |
| paperclipListDocuments | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:380 |
| paperclipGetDocument | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:386 |
| paperclipListDocumentRevisions | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:393 |
| paperclipListProjects | eval:rf-wf-project-setup-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:403 |
| paperclipGetProject | eval:rf-wf-project-setup-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:409 |
| paperclipGetIssueWorkspaceRuntime | eval:rf-iws-start-url-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:418 |
| paperclipControlIssueWorkspaceServices | eval:rf-iws-start-url-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:424 |
| paperclipWaitForIssueWorkspaceService | eval:rf-iws-target-restart-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:441 |
| paperclipListGoals | eval:su-parent-goal-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:467 |
| paperclipGetGoal | eval:su-parent-goal-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:473 |
| paperclipListApprovals | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:479 |
| paperclipCreateApproval | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:488 |
| paperclipGetApproval | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:497 |
| paperclipGetApprovalIssues | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:503 |
| paperclipListApprovalComments | eval:ap-approval-deny-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:509 |
| paperclipCreateIssue | eval:su-parent-goal-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:515 |
| paperclipUpdateIssue | eval:st-done-comment-01 | always_agent_tool | packages/mcp-server/src/tools.ts:522 |
| paperclipCheckoutIssue | eval:co-body-contract-01 | control_plane_owned | packages/mcp-server/src/tools.ts:529 |
| paperclipReleaseIssue | eval:er-release-01 | control_plane_owned | packages/mcp-server/src/tools.ts:541 |
| paperclipAddComment | eval:cm-multiline-01 | always_agent_tool | packages/mcp-server/src/tools.ts:547 |
| paperclipSuggestTasks | eval:ix-suggest-tasks-01 | always_agent_tool | packages/mcp-server/src/tools.ts:554 |
| paperclipAskUserQuestions | eval:ix-questions-01 | always_agent_tool | packages/mcp-server/src/tools.ts:566 |
| paperclipRequestConfirmation | eval:ix-confirmation-plan-01 | always_agent_tool | packages/mcp-server/src/tools.ts:578 |
| paperclipRequestCheckboxConfirmation | eval:ix-checkbox-01 | always_agent_tool | packages/mcp-server/src/tools.ts:590 |
| paperclipUpsertIssueDocument | eval:dp-plan-doc-01 | always_agent_tool | packages/mcp-server/src/tools.ts:602 |
| paperclipRestoreIssueDocumentRevision | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:613 |
| paperclipLinkIssueApproval | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:628 |
| paperclipUnlinkIssueApproval | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:637 |
| paperclipApprovalDecision | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:647 |
| paperclipAddApprovalComment | eval:ap-approval-deny-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:669 |
| paperclipApiRequest | eval:rf-api-404-report-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:678 |
