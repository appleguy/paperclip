# SCO-337: External OpenCode activity in Paperclip sidebar

Date: 2026-10-31 Pacific. **Isolated source only, not deployed.**

## User-visible result

A new **External activity** section appears underneath the normal managed
Agents section when this instance has a configured Ztop observer. The row is
labeled `GLM Maya-L · Ztop` and always says `Observed, not managed`.
It presents `Observed live`, `Session handoff`, `Idle`, `Stale
observation`, or `Not verified` according to the native observer.
Handoff count and the existing three-handoff guard ceiling are visible.

The row does not represent a Paperclip task checkout, native Runner,
heartbeat run or managed-agent status. No native OpenCode control, model
requests, tool replay, GPU lease or token/cost attribution is performed.

## Architecture and authority

- The previous seven-test observer is retained (same `observe.mjs`) under
  `server/src/services/scripts/external-presence/`. Its tests are copied
  unchanged. It reads only the *fixed* Ztop SQLite store, guard state,
  committed handoff events and exact OpenCode listener-to-database binding.
  It never receives Paperclip credentials or native OpenCode password.
- New `server/src/services/external-opencode-activity.ts` runs that
  packaged script via Node `execFile` with fixed argv, sanitized environment,
  five-second termination, 24 KiB stdout cap and exact output validation.
  It fails closed to an empty list.
- **Disabled by default.** A host operator must set
  `PAPERCLIP_EXTERNAL_ZTOP_COMPANY_ID` to the authorized SCO company UUID
  on a *separately qualified candidate release*. For every other company,
  the service returns [] **before launching any subprocess or reading files**.
- `GET /companies/:companyId/external-activity` is registered with the
  ordinary agents router. It calls the existing `assertCompanyAccess`
  guard before reading, rejects all query parameters, sets private no-store
  and returns only a validated advisory projection. No browser-controlled
  path, session, host or inference endpoint is accepted.
- UI `ui/src/components/ExternalActivitySection.tsx` uses the ordinary
  authorized API client and React Query. It is rendered by
  `SidebarAgents.tsx` *after*, not inside, the managed Agents section.
  When the API returns [], the external section disappears entirely.
  Its read demand stops on unmount; browser refetching at 30 seconds applies
  only while a configured observer result is present, never as a server
  background scanner.
- Source/backend facts are advisory, separate from run accounting.
  No false `heartbeatRuns`, task status mutation, issue wake, native TUI
  mutation or model operation occurs.

## Compaction and handoff correctness

The source `session_v2.parent_id` and `fork_session_id` are empty for
Ztop's current chain. The guard's separately committed
`successor_dispatched` events and the native successor metadata
`guardParent` are both required to follow a new tab. The active pointer
must equal the durable guard state, and the native listener must still open
the expected store. If any invariant fails, the observer refuses to claim
the wrong tab. It never picks the latest session arbitrarily.

The current Ztop guard has exhausted its three-rotation allowance; the
sidebar only reports that limitation. It does not silently remove it.

## Evidence and tests (no inference)

- Seven original Node lineage tests, copied unchanged: PASS.
- Seven new Vitest service tests: source company scoping, disabled default,
  false-run rejection, wrong session, parsing failure and idle semantics: PASS.
- Four new UI tests: hidden when unavailable, exact advisory presentation,
  idle not mislabeled live, status labels: PASS.
- 26 existing SidebarAgents tests: PASS, 30 total UI tests.
- Live source-to-service invocation (not through a deployed HTTP route):
  bound current session `ses_e6b819e5bffeNhTG19TKi4gE3m`,
  three verified handoffs, guard ceiling reached, status `idle`, no
  Paperclip run, backend identity verified.
- Server `tsc --noEmit` passed through the isolated worktree dependency
  symlinks. Full UI typecheck has unresolved baseline/worktree dependencies
  (missing adapter-utils, protocol schemas, generated Storybook catalog).
  The specific changed component and API did not appear in the errors;
  full release build is NOT qualified by these tests.
- Source branch `codex/sco-337-external-presence`, base
  `3bdffd13d7fcbe800949b782e663b7587c304960`, stored in
  `/Volumes/NVM/Paperclip/workspaces/sco-337-external-presence`.
  This is NOT the deployed commit `965184d2968f40b1183803529b88f288264c832f`.

## Deployment and rollback

No production change is authorized by this patch. The live Paperclip service
and OpenCode/Maya sessions stay untouched. Before any deployment, reconcile
the candidate with the version deployed, build complete release assets,
verify company ACL via an isolated real HTTP server, make a clean
UI/TypeScript build, and obtain owner release approval. The existing
SCO-298 native Runner cleanup quarantine is unaffected.

Rollback is simply omitting this isolated feature commit or leaving the
environment opt-in unset in a future build. No schema changes, persisted
false runs or runtime data migrations are introduced. Retain this worktree
and its clean branch as review evidence until adopted or intentionally
retired; no worker, timer or daemon was installed.

## Exact source anchors

`server/src/services/external-opencode-activity.ts`
`server/src/services/external-opencode-activity.test.ts`
`server/src/services/scripts/external-presence/observe.mjs`
`server/scripts/external-presence/test_observe.mjs`
`server/src/routes/agents.ts`
`ui/src/api/externalActivity.ts`
`ui/src/components/ExternalActivitySection.tsx`
`ui/src/components/ExternalActivitySection.test.tsx`
`ui/src/components/SidebarAgents.tsx`

Research origin: `/Volumes/NVM/Paperclip/ops/research/runner-control/experiments/external-presence-v1/`.

## Next engineering gate

Run the candidate behind a *separate isolated Paperclip instance* with
synthetic company A/B principals, and prove:
1. Authorized company sees exact read-only activity; foreign company gets
   access denied and cannot invoke observer.
2. No owner-managed heartbeat run or agent status changes due to reads.
3. An actual OpenCode handoff changes the row's session ID but not its
   stable external identity; stale or forged events fail closed.
4. Real UI build and packaging include observer JS under
   `dist/services/scripts/external-presence`.
5. The three-handoff ceiling and no-inference constraint remain intact.
