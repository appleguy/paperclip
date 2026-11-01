# Native Claude session observation

`GET /api/companies/:companyId/native-sessions/claude` discovers host-local
Claude sessions for an explicitly authenticated Board instance administrator
with company access. Agents and implicit local actors cannot use it. Request
parameters cannot select a filesystem path, process, account or session.

The service joins two `claude agents --json` inventories, OS process birth
checks, and the official Agent SDK `getSessionInfo` metadata. Only exact
session IDs, sanitized kind/status, and capability labels leave the service.
It does not expose process IDs, workspaces, transcript contents or credentials.
Concurrent authorized requests share one scan with a 15-second deadline;
an outstanding dependency retains its slot until settlement.

The `/native-sessions/claude` company page is a manually refreshed snapshot.
Its `observed_external` label does not imply Paperclip task ownership, model
activity, Remote Control pairing, streaming or mutation authority. Owner
intervention through the native Claude interface remains unrestricted.

The installed CLI qualification used Claude 2.1.309 and Agent SDK 0.3.286.
Two running interactive sessions matched their native metadata and process
identity without inference or provider writes. SDK transcript pagination
parses the transcript before applying its output limit and supplies no durable
cursor, so this endpoint does not advertise message replay.

Server-owned PATH and optional `CLAUDE_CONFIG_DIR` select the local namespace;
the SDK namespace must match. A different host/account requires explicit
future controller configuration. A separate headless query does not control
an already running Remote Control conversation.
