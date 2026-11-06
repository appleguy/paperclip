# Paperclip MCP Server

Model Context Protocol server for Paperclip.

This package is a thin MCP wrapper over the existing Paperclip REST API. It does
not talk to the database directly and it does not reimplement business logic.

## Authentication

The server reads its configuration from environment variables:

- `PAPERCLIP_API_URL` - Paperclip base URL, for example `http://localhost:3100`
- `PAPERCLIP_API_KEY` - bearer token used for `/api` requests
- `PAPERCLIP_COMPANY_ID` - optional default company for company-scoped tools
- `PAPERCLIP_AGENT_ID` - optional default agent for checkout helpers
- `PAPERCLIP_RUN_ID` - optional run id forwarded on mutating requests

Inside an active heartbeat, Paperclip also injects `PAPERCLIP_RUNTIME_TOOLS_*` variables. They enable the run-scoped `connections_search` and `connection_request` tools and expire with the run.

Persistent Claude RC seats set `PAPERCLIP_RC_RUN_ENV` to their private slot's
`run-env.sh`. Missing Paperclip environment values are read from that file for
each tool call; the file is removed when the run ends. Explicit environment
values take precedence. The seat's local MCP server requires the package to be
built before the seat starts.

## Usage

```sh
npx -y @paperclipai/mcp-server
```

Or locally in this repo:

```sh
pnpm --filter @paperclipai/mcp-server build
node packages/mcp-server/dist/stdio.js
```

## Tool Surface

Run-scoped connection tools:

- `connections_search`
- `connection_request`

Read tools:

- `paperclipMe`
- `paperclipInboxLite`
- `paperclipListAgents`
- `paperclipGetAgent`
- `paperclipListIssues`
- `paperclipGetIssue`
- `paperclipGetHeartbeatContext`
- `paperclipListComments`
- `paperclipGetComment`
- `paperclipListIssueApprovals`
- `paperclipListDocuments`
- `paperclipGetDocument`
- `paperclipListDocumentRevisions`
- `paperclipListProjects`
- `paperclipGetProject`
- `paperclipGetIssueWorkspaceRuntime`
- `paperclipWaitForIssueWorkspaceService`
- `paperclipListGoals`
- `paperclipGetGoal`
- `paperclipListApprovals`
- `paperclipGetApproval`
- `paperclipGetApprovalIssues`
- `paperclipListApprovalComments`

Write tools:

- `paperclipCreateIssue`
- `paperclipUpdateIssue`
- `paperclipCheckoutIssue`
- `paperclipReleaseIssue`
- `paperclipAddComment`
- `paperclipSuggestTasks`
- `paperclipAskUserQuestions`
- `paperclipRequestConfirmation`
- `paperclipUpsertIssueDocument`
- `paperclipRestoreIssueDocumentRevision`
- `paperclipControlIssueWorkspaceServices`
- `paperclipCreateApproval`
- `paperclipLinkIssueApproval`
- `paperclipUnlinkIssueApproval`
- `paperclipApprovalDecision`
- `paperclipAddApprovalComment`

Escape hatch:

- `paperclipApiRequest`

`paperclipApiRequest` is limited to paths under `/api` and JSON bodies. It is
meant for endpoints that do not yet have a dedicated MCP tool.
