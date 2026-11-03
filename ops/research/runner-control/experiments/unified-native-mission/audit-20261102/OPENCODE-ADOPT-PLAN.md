# SCO-476 — Adopt the running OpenCode listeners in the shared-v2 Runner

Status: read-only source research and patch plan. No product source was modified, no
server was contacted, no process was signalled, no listener password was read into this
document.

Goal: make the canonical server native-v12 "shared-v2 Runner" adopt the already-running
OpenCode listeners on `127.0.0.1:19402` (DeepSeek) and `19403` (GLM) instead of always
spawning a private `opencode serve --port 0`, following the Codex daemon
attach/attestation pattern. That switch retires the CLI adapter's file-based
session-recovery machinery.

Two OpenCode paths exist today; the plan merges the server path onto the listener
identity and does not create a third path.

---

## 1. Current flow

### 1.1 Listener facts observed (snapshot only — must be re-attested at run time)

| Listener | URL | PID observed | Process start | `ps -o comm=` | cwd |
|---|---|---|---|---|---|
| DeepSeek | `127.0.0.1:19402` | 697 | Mon Nov 2 09:13:51 2026 | `/opt/homebrew/bin/opencode` | `/Volumes/NVM/Paperclip/workspaces/tensor64` |
| GLM | `127.0.0.1:19403` | 90730 | Mon Nov 2 08:40:47 2026 | `/opt/homebrew/bin/opencode` | `/Volumes/NVM/Paperclip/workspaces/tensor64` |

Both are launchd-managed and start as
`OPENCODE_SERVER_PASSWORD=$(cat …/password) exec /opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 19402|19403`
with `KeepAlive false`; `exec` keeps the launcher PID equal to the listener PID, so
`ps -p PID` is meaningful but only while nothing restarts the agent.

- Descriptors: `/Volumes/NVM/Paperclip/backends/opencode-deepseek-maya-s/server/shared-*.json`
  and `/Volumes/NVM/Paperclip/backends/opencode-glm-medium/server/shared-*.json`, shape
  `{ url, passwordFile }`.
- Launch definitions: `~/Library/LaunchAgents/ing.paperclip.opencode-deepseek-server.plist`,
  `~/Library/LaunchAgents/ing.paperclip.opencode-glm-mac-server.plist`.
- Runtime config per listener declares provider `native-fleet` / `maya-metal`, model
  `wrx80/deepseek-v4.1-flash-maya-s-4090` / `glm-5.3-flash-maya-l`, npm
  `@ai-sdk/openai-compatible`, and one existing MCP server `one-memory`.
- Both listeners share cwd `/Volumes/NVM/Paperclip/workspaces/tensor64`. This is the root
  of risk A below: OpenCode keys MCP config by directory, not by session.

### 1.2 Path A — server native-v12 shared host (the path being changed)

Entry gate — `server/src/services/native-runtime/native-session-executor.ts:9676-9690`

- `:9676` only when `input.execution.schema === "paperclip.native-execution-input.v12"`
  and no explicit backend.
- `:9677` refuses `!useRunnerd`, remote target, **`input.restartRecovery`**, missing cwd,
  or an MCP binding id — `opencode_shared_requires_fresh_local_admission`.
- `:9678-9679` the executable must come from `PAPERCLIP_OPENCODE_V2_CLI` and be absolute
  (`opencode_shared_cli_not_configured`).
- `:9687` refuses `paperclip/` model prefixes; `:9688` calls `startOpenCodeManagedBackend`;
  `:9689` builds the backend port from `openCodeAdmission.admitted.port`.

Admission — `server/src/services/native-runtime/opencode-managed-admission.ts`

- `:56-74` `claimOpenCodeTaskSession` locks the lease row (`:57`), the run (`:59`), the
  issue (`:60`), then reads the task session (`:62`).
- `:63-66` **refuses an existing task session that already holds `opencodeSharedV2`** —
  `opencode_admission_existing_session_requires_recovery`. Today this makes the shared
  path effectively one admission per task; every later run needs the recovery path.
- `:84` provider profile, `:85` claim, `:87` per-run provider proxy, `:88-90` start host
  with `provider` + `mcp`, `:91` binding with `providerSessionId = ses_<randomUUID()>`.
- `:96` persist host, `:98` catalog verify, `:104-105` create session or reconcile the
  uncertain create, `:106` retain the owner handle, `:108` return the native port.
- `:114-121` `reconcilePendingOpenCodeManagedBackend` — same-controller lost-ACK recovery.

Host — `server/src/services/native-runtime/opencode-shared-host.ts`

- `:28-33` contract: isolated, host-owned v2 server; URL and credentials never come from
  a client; the handle is valid only while this process lives.
- `:34-35` absolute paths and canonical workspace `realpath`.
- `:36-37` **`<executable> --version` must print exactly `opencode v2.2.5`**.
- `:38-41` private temp root (`home/config/data/cache/state/work`), `workingDirectory`
  defaults to `<root>/work`.
- `:42` fresh 32-byte password; `:44-47` in-process MCP bridge with per-call admission;
  `:48-49` `OPENCODE_CONFIG_CONTENT` injects the provider **and** the MCP server, with
  `PAPERCLIP_MCP_TOKEN` / `PAPERCLIP_PROVIDER_TOKEN` in the env.
- `:50-56` `spawn(executable, ["serve","--hostname","127.0.0.1","--port","0"])` with a
  scrubbed env; the child PID becomes the host identity.
- `:70-84` `shutdown()` closes scoped listeners, then **SIGTERMs its own child**
  (`:80`), proving the live `ChildProcess` handle is the only thing ever signalled
  (`:76-77`).
- `:88-101` parses the `http://127.0.0.1:<port>` banner out of stdout with a 10 s cap and
  a 16 KiB buffer cap; `:101` discards the banner because it can contain the password.
- `:102` **`generation = randomUUID()`** — per-spawn, not derived from process identity.
- `:103` `createOpenCodeBoundFetch({pid, port, isAlive})` — per-request peer-tuple
  attestation, `allowEmptySessionCreate`.
- `:106-113` `verifyHost()` — `GET /api/info` must answer 2xx and report `pid` + version
  `2.2.5`, else `opencode_host_authentication_failed` / `opencode_host_identity_mismatch`.
- `:114-125` `verifySession()` — `ses_` pattern, host, `GET /api/session/:id`, id match,
  workspace match, `assertSessionModel` (`:21-26` provider/id/variant), host again.
- `:127-135` `dispatchForRun` — binding generation must equal the host generation (`:128`),
  then a session-scoped bound fetch with `allowPromptForSession`.
- `:140-145` `verifyCatalog` — delegates to `verifyOpenCodeNativeCatalog` with the
  per-run proxy base URL and token.
- `:146-156` `prepareManagedSession` — requires workspace + mcp, derives `startedAt` from
  `readProcessStartedAt` (`:151`, `server/src/services/hot-restart.ts:177-199`, which uses
  `ps -o lstart=` on darwin) and `ps -o comm=` (`:152`), then persists the host record.
- `:157-168` `createManagedSession` — exact-body `POST /api/session`, then
  `completeOpenCodeSessionCreation`, then installs the in-process MCP admission.
- `:190-200` `persistForRun` — re-attests birth and reuses the persisted host record.
- `:201-225` `createEmptyObservation` — observation-only, single-shot (`:202-203`), creates
  an empty session and follows the log to `log.synced`.
- `:226-237` `observe` — durable observer with generation/session/version attestation.
- `:247-310` `recoverOpenCodeSharedHost` — restart path: re-attests pid, `startedAt`
  twice (`:254-255`, `:265-266`), `comm` and `lsof -d cwd` (`:256-260`), `/api/info`
  (`:261-264`); restores the password and optional proxy from the encrypted secret
  (`opencode-shared-recovery.ts:92-108`); exposes `observe` and
  `verifySessionAndCatalog(proxy)`; **it cannot signal the process** (`:246`).
- `:284-308` `replaceMcp` — validates the bridge URL shape (`:286`), requires the
  restoration guard (`:287`), attests (`:288`), reserves a digest (`:292`), then
  `PUT /api/experimental/mcp/paperclip?directory=…` (`:295`) and proves it by reading
  `GET /api/mcp` and requiring exactly one `paperclip` entry with
  `status.status === "connected"` (`:297-305`).

Supporting modules

- `server/src/services/native-runtime/opencode-shared-recovery.ts`
  - `:11` `SharedHostRecord` = `{pid, startedAt, executable, port, namespace, workingDirectory?, generation, secretId, secretVersion}`.
  - `:22` immutable binding keys; `:29` `validateHost` field checks; `:33-49` `withLockedSession`
    (lease + run + issue + task-session locks, controller identity at `:35-36`).
  - `:58-70` `persistOpenCodeHost` — password and optional proxy go into the encrypted
    secret provider (`:64-65`), identity goes into `sessionParamsJson.opencodeSharedV2.host`.
  - `:92-108` `readOpenCodeHostRestoration` — refuses after any mutation or semantic call
    (`:97-101`) and **requires `proxy`** (`:105`, `opencode_proxy_restoration_unavailable`).
  - `:111-133` MCP reserve/deliver with digest receipts and a 25 s lease margin.
- `server/src/services/native-runtime/opencode-native-catalog.ts:3-26`
  - `:16` `GET /api/provider`, `:17` `GET /api/provider/:id`, `:21` `GET /api/model`, all
    with `?directory=`.
  - `:18` requires `entry.package === "@opencode/ai/providers/openai-compatible"`.
  - `:20` requires `settings.baseURL === providerBaseURL` **and**
    `settings.apiKey === providerToken` (the per-run proxy token).
  - `:21-25` model id/provider match and exactly one matching variant.
- `server/src/services/native-runtime/opencode-bound-fetch.ts:18` — the only non-session
  request shape allowed is the exact MCP `PUT` body/directory pair.
- `server/src/services/native-runtime/opencode-restart-claim.ts:18-35` — restart claim
  qualification, i.e. where a saved host is re-adopted after controller restart.
- `server/src/services/native-runtime/codex-shared-daemon.ts:8-34` — the pattern being
  mirrored: validate paths and home ownership (`:11-13`), `realpath` the executable
  (`:14`), read daemon metadata (`:16-19`), pin versions (`:20`), require the managed
  executable inside the app home (`:21-22`), `realpath` the socket (`:23`), then
  **`inspect()` twice and require byte-identical JSON** (`:24-33`).

### 1.3 Path B — CLI adapter against the listeners (to be retired)

- `packages/adapters/opencode-local/src/server/execute.ts:58` imports
  `prepareSharedOpenCodeSession` / `OpenCodeSharedSessionWait`.
- `:520-547` the opt-in preflight: `sessionId` may resume (`:516-520`), then
  `sharedConfigPath` (`:522`), task id and absolute path requirements (`:527-529`),
  `prepareSharedOpenCodeSession` (`:530-535`), and any non-`Wait` error is logged as
  "preflight unavailable; no inference sent" and converted to exit 75 (`:536-546`).
- `:620-627` the recovery prompt — on a resumed, recovered session the model is told to
  inspect existing history and not repeat completed tool calls.
- Further call sites: `:660`, `:745`, `:851-859`.
- `packages/adapters/opencode-local/src/server/shared-session-recovery.ts`
  - `:41` `prepareSharedOpenCodeSession`; `:58` prefixes `/api`; `:74` `GET /session/active`.
  - `:82-86` durable binding file
    `<stateDir>/paperclip-opencode-session-recovery/<agentId>-<taskId>.json`.
  - `:87-99` loads the old binding and fails closed on a mismatch or a parse error.
  - `:101-107` requested-session conflict and **`running(states).some(sid => sid !== selected)`
    — refuses when any foreign session is active**.
  - `:110-118` resume by id or create with `{ location: { directory: cwd } }`.
- Docs/config: `packages/adapters/opencode-local/src/index.ts:104` documents
  `sharedServerRecoveryConfigPath`.

### 1.4 Net difference that the plan must close

| Concern | Path A (spawn) | Path B (listener) |
|---|---|---|
| Process identity | own `ChildProcess` handle | launchd process, must be attested |
| Credentials | random 32-byte password, in env | `passwordFile` from a descriptor |
| Provider | per-run proxy + token in `OPENCODE_CONFIG_CONTENT` | listener config, own key |
| Provider package | `@opencode/ai/providers/openai-compatible` | `@ai-sdk/openai-compatible` |
| MCP | injected at spawn via config | `PUT /api/experimental/mcp/paperclip?directory=` |
| Generation | `randomUUID()` per spawn | must be derived from attested identity |
| Restart | re-attach + observation only | adapter-side file binding + replay |
| Shutdown | SIGTERM own child | detach only |

---

## 2. Proposed change — numbered patch plan

Design rule: adoption is a **second entry point into the same host contract**, not a fork
of it. `startOpenCodeSharedHost` stays for isolated/spawn use; a new `attachOpenCodeSharedHost`
returns the same frozen handle shape so admission, observation, checkpoint and recovery
code stay unchanged. Every new failure mode gets a distinct error code so tests can tell
"listener missing" from "listener is not the one we attested".

### Step 1 — listener descriptor module (new file)

`server/src/services/native-runtime/opencode-listener-descriptor.ts` (new).

- `readOpenCodeListenerDescriptor(path)`: path must be absolute; parse strict JSON;
  accept only `{ url, passwordFile }` plus an optional pinned `providerPackage`.
- Validate `url`: `http:`, hostname `127.0.0.1`, explicit port 1024-65535, pathname `/`,
  no search/hash/userinfo. Model it on `opencode-shared-host.ts:286` and
  `opencode-shared-recovery.ts:19`, both of which already do exactly this shape check.
- Validate `passwordFile`: absolute, `lstat` (not `stat`) so a symlink is rejected, regular
  file, `uid === process.getuid?.()`, `(mode & 0o022) === 0`, size 1-4096, trimmed non-empty.
  Mirror `codex-shared-daemon.ts:12-13`.
- Never log or return the file contents; return only `{ url, port, passwordFile }` and a
  `descriptorDigest = nativeSha256({url, passwordFile, providerPackage})`.

### Step 2 — listener attestation and derived generation (same new file)

`inspectOpenCodeListener({ descriptorPath, expectedExecutable, workspaceCwd })`:

1. Read the descriptor (step 1).
2. Resolve the listener PID for the port **without trusting the descriptor**: `lsof -nP
   -iTCP:<port> -sTCP:LISTEN -t` (server already uses `/usr/sbin/lsof` at
   `opencode-shared-host.ts:258`), require exactly one PID.
3. `readProcessStartedAt(pid)` (`hot-restart.ts:177-199`, `ps -o lstart=` on darwin) and
   `ps -p pid -o comm=`; require `comm` absolute and
   `realpath(comm) === realpath(expectedExecutable)`.
4. `lsof -a -p pid -d cwd -Fn` must contain
   `n<realpath(workspaceCwd)>` — same check as `opencode-shared-host.ts:258-260`.
5. One authenticating `GET /api/info` with the descriptor password: 2xx,
   `pid === attested pid`, `version === "2.2.5"`. This is the only proof that the
   password is correct; file-content equality is not proof.
6. Repeat steps 2-5 and require byte-identical JSON — the `codex-shared-daemon.ts:32-33`
   double-inspect discipline.
7. `generation = nativeSha256({port, pid, startedAt, executable: realExecutable})`
   rendered as the existing 36-char form so `opencode-shared-checkpoint.ts` and
   `opencode-shared-recovery.ts:29` keep accepting it. A restarted listener necessarily
   produces a new `startedAt`/pid, so every stale binding fails closed with
   `opencode_host_binding_mismatch` instead of writing into a stranger's session.
8. Error codes: `opencode_listener_descriptor_invalid`,
   `opencode_listener_descriptor_insecure`, `opencode_listener_unavailable`
   (no/broken port), `opencode_listener_identity_mismatch`,
   `opencode_listener_identity_changed`, `opencode_listener_executable_mismatch`,
   `opencode_listener_authentication_failed`, `opencode_listener_version_unsupported`.

**Version pin:** every durable record requires `version === "2.2.5"`
(`opencode-shared-recovery.ts:34`, `opencode-shared-checkpoint.ts:33`,
`opencode-shared-host.ts:111`). A listener reporting any other version must be rejected
by step 2.8 — adopting it would require a schema bump and is explicitly out of scope.

### Step 3 — adoption mode in `opencode-shared-host.ts`

Add `attachOpenCodeSharedHost` alongside the existing entry point
(`opencode-shared-host.ts:30`), sharing the returned handle shape and internals.

- Replace `:36-37` `<executable> --version` with the step-2 `/api/info` version assertion
  (never execute the listener binary just to read its version).
- Replace `:39-42` mkdtemp + random password with: `pid`, `port`, `generation`, `password`
  from step 2; `namespace` = the descriptor's backend directory (absolute, satisfies
  `opencode-shared-recovery.ts:29`); `workingDirectory` = attested `realpath(workspaceCwd)`.
- Delete the banner parse (`:88-101`) for the attach branch — the URL comes from the
  descriptor, and there is no stdout to parse.
- `:104` authorization stays `Basic opencode:<password>`; `origin` from the descriptor URL.
- `:70-84` `shutdown()` becomes detach for the attach branch: close scoped listeners,
  close the bridge, run `onShutdown`, and **never signal the PID**. Keep the comment at
  `:76-77`; extend it to say an adopted listener is never signalled by this process.
- `:106-113` `verifyHost()` keeps the `/api/info` pid+version check and adds a repeated
  `readProcessStartedAt` comparison after the response (the `:254-266` pattern) so a
  restart racing the call cannot be blessed.
- `:140-145` `verifyCatalog` selects the step-5 catalog check.
- `:146-156` and `:190-200` persist the host record with the new `source`/digest fields
  (step 8), unchanged otherwise.
- `:201-225` `createEmptyObservation` and `:226-237` `observe` need no change beyond the
  derived generation; `allowEmptySessionCreate` stays valid because `createOpenCodeBoundFetch`
  is already pid+port generic.

### Step 4 — split "attach" from "ownership"

`opencode-managed-admission.ts:79-111` currently conflates "we spawned it" with "we may
write to it". Split explicitly:

- `:88-90` choose `attachOpenCodeSharedHost` when the execution declares a listener
  descriptor; `startOpenCodeSharedHost` otherwise. No silent fallback: if the descriptor is
  set and the listener cannot be attested, fail with the step-2 code. A fallback would give
  two different host identities for the same task across runs.
- `:87` the per-run provider proxy must **not** be started in attach mode (the listener owns
  its provider config); skip `startOpenCodeProviderProxy` and its `onShutdown`.
- `:91` `providerSessionId` must come from the task-session resolution in step 7, not
  `ses_${randomUUID()}`.
- `:92-93` the ownership guard becomes `{ host, binding, durable, cause, adopted }` so
  `retainOpenCodeManagedHost` and shutdown know they hold a lease on a foreign process.
- `:98` catalog verify switches package expectation (step 5).
- `:104-105` unchanged: create-or-reconcile of the exact `ses_` id.

### Step 5 — catalog verification without the per-run proxy token

`opencode-native-catalog.ts:18-20` cannot be reused verbatim: it requires the spawn
package `@opencode/ai/providers/openai-compatible` and
`settings.apiKey === providerToken`, neither of which is true for a listener
(`@ai-sdk/openai-compatible`, own key in the listener config).

Add an exported `verifyOpenCodeListenerCatalog` in the same file (additive; do not weaken
the existing function):

- Same reads and size/JSON guards (`:7-15`), same `/api/provider` warm-up (`:16`).
- `:18` assert `entry.package === descriptor.providerPackage`
  (default `"@ai-sdk/openai-compatible"`); a spawn-package value on an adopted listener is
  an error, not a pass.
- `:20` assert `settings.baseURL` (and, if present, `settings.models`) only when the
  descriptor pins them; **never compare `apiKey`** — the run holds no listener key and
  comparing it would require reading the listener config's secrets.
- Keep `:21-25` model and variant checks untouched, so a missing effort still fails as
  `opencode_native_variant_unavailable` before any prompt is sent.
- `recoverOpenCodeSharedHost.verifySessionAndCatalog` (`opencode-shared-host.ts:274-283`)
  takes `proxy` unconditionally today; give it a listener branch that reads the descriptor
  and uses this check.

### Step 6 — MCP wiring through the existing directory-keyed route

Adoption cannot use `OPENCODE_CONFIG_CONTENT` (`opencode-shared-host.ts:48-49`) because the
listener is already running.

- Extract the body of `replaceMcp` (`:284-308`) into
  `installPaperclipMcp({ host, binding, bridge })`: validate bridge shape (`:286`),
  require the restoration guard (`:287`), attest (`:288`), reserve digest (`:292`),
  deliver with `allowExactMcpReplace` (`:293-295`), require 204 and exactly one
  `paperclip` entry with `connected` (`:297-305`). Both `replaceMcp` and adoption call it.
- Before the `PUT`, add a pre-check on `GET /api/mcp?directory=…`: if a `paperclip` entry
  already reports `connected` that is **not** this run's bridge, refuse with
  `opencode_listener_foreign_mcp_binding`. A live foreign bridge means another run owns
  the directory; replacing it would silently steal that run's tool authority.
- Add `withdrawPaperclipMcp` for run end. The 2.2.5 API surface for removal is
  **unverified** — no `DELETE` for `/api/experimental/mcp/…` appears anywhere in this
  repository (only `PUT` at `:295` and in `opencode-native-create-canary.test.ts:54`).
  Therefore: implement withdrawal only if a route is confirmed against the pinned build;
  otherwise leave the entry in place and document the residual window (risk A.3). Do not
  invent a route.
- `opencode-bound-fetch.ts:18` needs no change for install; a withdrawal would need a new
  allowlist entry of the same exact-shape discipline.

### Step 7 — session identity: resume or create, never fork silently

- `opencode-managed-admission.ts:63-66` currently refuses any task session that already
  holds `opencodeSharedV2` (`opencode_admission_existing_session_requires_recovery`).
  Replace that refusal for listener mode with:
  - if `sessionParamsJson.opencodeSharedV2` holds `{providerSessionId,
    listenerGeneration, listenerDescriptorDigest}` **and** the freshly attested generation
    and digest match **and** `GET /api/session/:id` returns that id with the same
    workspace and model, resume that session;
  - otherwise create a new `ses_` id only when no `nativeRunFinalizations` lease for the
    previous run is live (the `:57`/`:71` lease predicate already answers this), and
    record `listenerGeneration`/digest with the new id;
  - never reuse an id from a different generation — fail
    `opencode_listener_binding_stale`.
- Keep spawn-mode behaviour unchanged (fresh `ses_` per admission) so the two modes stay
  distinguishable in the durable record.

### Step 8 — durable host record

`opencode-shared-recovery.ts`:

- `:11` extend `SharedHostRecord` with `source: "spawned" | "adopted"` and, for adopted,
  `listenerDescriptorDigest: string`; keep `proxy` spawn-only.
- `:29` `validateHost` accepts the new fields and requires `listenerDescriptorDigest` when
  `source === "adopted"`, and `source` present on every record.
- `:64-65` `persistOpenCodeHost` writes `{password}` (no `proxy`) for adopted hosts;
  `parseHostSecret` (`:14-21`) already tolerates a password-only secret.
- `:105` `readOpenCodeHostRestoration` requires `proxy` only when
  `host.source === "spawned"`; adopted hosts require the descriptor digest to match the
  live descriptor. `opencode_proxy_restoration_unavailable` stays for spawn mode.
- Add `source` and `listenerDescriptorDigest` to the immutable key lists at
  `opencode-shared-recovery.ts:22` and
  `server/src/services/heartbeat/opencode-shared-checkpoint.ts:13` so no checkpoint writer
  can rewrite identity.
- `server/src/services/heartbeat/run-state.ts:1665-1675` and
  `opencode-shared-checkpoint.ts:28-41` need **no** change: they compare the whole native
  state digest and a fixed key list; the new fields are covered by the digest.

### Step 9 — executor gate

`native-session-executor.ts:9676-9690`:

- `:9677` split the guard: keep the runnerd / remote-target / missing-cwd / MCP-binding
  refusals for both modes; move the `restartRecovery` refusal to per-mode. A restart with
  a listener descriptor maps to the observation-only path
  (`recoverOpenCodeSharedHost`, `opencode-shared-host.ts:247-310`) and still cannot prompt
  until a fresh claim exists. Anything else keeps
  `opencode_shared_requires_fresh_local_admission`.
- `:9678-9679` in listener mode, `PAPERCLIP_OPENCODE_V2_CLI` must `realpath`-equal the
  attested `comm`; mismatch is `opencode_listener_executable_mismatch` (already produced by
  step 2.3 — assert it here too so the gate fails before admission).
- `:9689` unchanged: the port comes from `openCodeAdmission.admitted.port`, which for
  adoption is the listener port.

### Step 10 — retire Path B (separate follow-up commit)

Only after adoption has produced real v12 runs on both listeners, and only as its own
commit so rollback is one revert. Inventory in section 5.

---

## 3. Risks

### A. Duplicate writer

A.1 — **Two v12 runs on one listener.** The lease row (`opencode-managed-admission.ts:57`)
is per run, not per listener, so two runs for different tasks can both adopt `19402`. They
get distinct `ses_` ids, so session writes do not collide, but everything
directory-scoped does.

A.2 — **MCP entry theft.** `PUT /api/experimental/mcp/paperclip?directory=…` is keyed by
directory, and both listeners share `/Volumes/NVM/Paperclip/workspaces/tensor64`. The second
run's `PUT` replaces the first run's `paperclip` entry and its `Bearer` secret, so the first
run's semantic tool calls start failing authority checks mid-run (they would reach the
second run's bridge with a token for a different binding). Mitigations, all required:
per-listener in-process mutex keyed by descriptor digest; the `GET /api/mcp` `connected`
pre-check from step 6 (`opencode_listener_foreign_mcp_binding`); and the "no foreign active
session" preflight from `shared-session-recovery.ts:105-106` re-implemented server-side in
adoption (`GET /api/session/active`, refuse when any non-idle session is not bound to this
run). That last check is the only thing that currently prevents two writers in Path B — it
must survive the retirement, not disappear with the file.

A.3 — **Stale entry after run end.** If withdrawal (step 6) is unavailable, the listener
keeps a `paperclip` entry pointing at a dead bridge. The next adopted run replaces it before
use, but a Path B run on the same directory in that window would see a stale entry. During
rollout, keep the two paths on disjoint agents/directories, or cut Path B config off before
enabling adoption for the same agent.

A.4 — **Mixed Path B and adoption on one listener.** The adapter's file binding
(`<stateDir>/paperclip-opencode-session-recovery/<agentId>-<taskId>.json`) and the server's
`opencodeSharedV2` record are independent sources of truth for the same listener. They can
disagree about which session is current, and neither sees the other's writer. Adoption must
be gated per agent, in config, and the retirement commit must land before any agent's
descriptor is moved over — never both enabled.

### B. Stale listener

B.1 — **Dead listener.** launchd runs with `KeepAlive false`, so a crashed listener stays
down. Adoption must fail closed (`opencode_listener_unavailable`) and must not spawn a
private host as a fallback: a silent fallback splits identity across runs while the durable
record still says "adopted".

B.2 — **Restarted listener.** A restart changes the PID, so `readProcessStartedAt` changes
and the derived generation changes. Every old binding then fails
`opencode_host_binding_mismatch` at `opencode-shared-host.ts:128` / `:232` instead of
addressing a session that may not exist in the new process. This is the correct failure;
the risk is a run that hangs instead of failing, which the `AbortSignal.timeout` on every
call (`:108`, `:117`, `:163`, `:295`) already bounds.

B.3 — **Port squatter.** If another process binds 19402, only the full attestation chain
rejects it: single `LISTEN` pid, `comm` realpath, cwd, `/api/info` pid, `startedAt` before
and after, and the double-inspect equality. Dropping any one of them makes adoption of a
stranger possible, so they must all live in one function with no optional flags.

B.4 — **Password file drift.** The launchd job reads the password at start; rotating the
file without restarting the listener would make adoption "succeed" at reading the file and
fail at `/api/info`. Because step 2.5 authenticates for real, this fails closed with
`opencode_listener_authentication_failed` and no secret is persisted.

B.5 — **Persisted-record trust.** `recoverOpenCodeSharedHost` already re-attests process
identity (`:253-267`); adoption must keep the same rule for the descriptor itself (digest
equality), otherwise an edited descriptor could redirect recovery to a different port.

### C. Restart replay

C.1 — **Double prompt after controller restart.** The listener keeps the session alive and
may keep advancing it while the controller is down. The v12 path has `resume` on
`dispatchForRun` (`opencode-shared-host.ts:127`) and Path B handles this with the recovery
prompt at `execute.ts:620-627`; after retirement that prompt disappears, so the equivalent
guidance must exist in the v12 dispatch path before Path B is removed. Otherwise a
controller restart can replay a completed assignment as a fresh one and duplicate tool
actions.

C.2 — **Cursor reset.** Replay safety depends on the durable cursor committed by
`commitLog` (`opencode-shared-host.ts:216-220`) and persisted by
`opencode-shared-checkpoint.ts:28-41`. On re-attach, the cursor must be loaded, not
restarted at null — a null cursor over a live listener replays the whole log. Step 3 must
assert that the recovery branch calls `loadCursor` (`:215` currently returns null by
design for the observation-only path) and that adoption's normal path does not.

C.3 — **Create replay.** `createEmptyObservation` is single-shot (`:202-203`) and
`createManagedSession` reconciles a lost ACK (`:104-105`). Adoption must not weaken either:
a re-attach must never issue `POST /api/session` again for an id whose creation outcome is
unknown, because the listener may already hold it.

C.4 — **Foreign advance during downtime.** If something else prompts the adopted session
while the controller is down, replay would resume from a cursor that is no longer
contiguous. `GET /api/session/:id` plus the observer's monotonic `previous`/`next`
validation (`validateOpenCodeLogItem`, `:217`) must reject the gap rather than skip it.

---

## 4. Negative tests to add

Unit/integration tests, one failure mode each. All must assert that **no prompt is sent**,
which is the property that matters more than the error string.

1. Descriptor is a symlink, has mode `0644`, or is owned by another uid →
   `opencode_listener_descriptor_insecure`, password never read.
2. Descriptor `url` uses `0.0.0.0`, a non-loopback host, port 0, a path, or a query →
   `opencode_listener_descriptor_invalid`.
3. `lsof` reports two listening PIDs, or none → `opencode_listener_unavailable`.
4. `/api/info` returns a different `pid` than the attested one → `opencode_listener_identity_mismatch`
   (port-squatter case B.3).
5. `ps -o comm=` resolves to a different `realpath` than `PAPERCLIP_OPENCODE_V2_CLI` →
   `opencode_listener_executable_mismatch`.
6. `startedAt` changes between the two inspects → `opencode_listener_identity_changed`.
7. Wrong password file contents → `opencode_listener_authentication_failed`, and the secret
   provider write is never called.
8. `/api/info.version` is not `2.2.5` → `opencode_listener_version_unsupported`.
9. Catalog reports the spawn package `@opencode/ai/providers/openai-compatible` on an
   adopted listener → `opencode_native_provider_unavailable` (proves the listener check is
   not the spawn check).
10. Catalog model absent → `opencode_native_model_unavailable`; effort absent →
    `opencode_native_variant_unavailable`; both before any session POST.
11. `GET /api/session/active` reports a foreign non-idle session → adoption refuses
    (`opencode_listener_foreign_session`) and `POST /api/session/:id/prompt` is never called
    (guards A.1/A.2).
12. `GET /api/mcp` reports `paperclip` `connected` to a bridge this run did not create →
    `opencode_listener_foreign_mcp_binding`, and no `PUT` is issued (guards A.2).
13. Two concurrent admissions for one descriptor → second gets
    `opencode_listener_already_adopted`; the fake fetch records exactly one MCP `PUT`.
14. Listener restarts (fake `startedAt` change) between persist and dispatch →
    `opencode_host_binding_mismatch` and no prompt (guards B.2/C.1).
15. Adopted handle `shutdown()` → `process.kill` is never invoked; the spawn handle still
    SIGTERMs its own child (guards the `:76-80` contract).
16. Task session holding `opencodeSharedV2` with a different `listenerGeneration` →
    `opencode_listener_binding_stale`, and the old `ses_` id is not reused (guards step 7).
17. Adopted host persisted with a password-only secret: `readOpenCodeHostRestoration`
    succeeds; the same record with `source: "spawned"` and no proxy still throws
    `opencode_proxy_restoration_unavailable`.
18. Re-attach with `loadCursor` forced to return a non-null cursor and a log gap →
    `validateOpenCodeLogItem` rejects instead of skipping (guards C.2/C.4).

---

## 5. Retirement inventory — Path B callers

Everything below is reachable only through the opt-in `sharedServerRecoveryConfigPath`
field. Nothing here is part of the v12 shared host, and none of it is needed once adoption
exists.

### 5.1 Every caller of `shared-session-recovery.ts`

| File:line | What it is | Fate |
|---|---|---|
| `packages/adapters/opencode-local/src/server/execute.ts:58` | `import { OpenCodeSharedSessionWait, prepareSharedOpenCodeSession }` | remove import |
| `execute.ts:520-547` | opt-in preflight block: `canResumeSession` (`:516-520`), `sharedSession` (`:521`), `sharedConfigPath` (`:522`), task/absolute-path guards (`:527-529`), `prepareSharedOpenCodeSession` (`:530-535`), the log-and-exit-75 path (`:536-546`) | delete the block; the v12 path owns preflight |
| `execute.ts:658` | `resumeSessionId ?? sharedSession?.sessionId` feeds `--session` | drop the `sharedSession` alternative |
| `execute.ts:746` | `parsed.sessionId ??= … ?? sharedSession?.sessionId ?? null` | drop the `sharedSession` alternative |
| `execute.ts:851` | `runAttempt(sharedSession?.resumed ? sharedSession.sessionId : sessionId)` | reduce to `sessionId` |
| `execute.ts:852` | `await sharedSession?.finish(initial.proc)` | delete |
| `execute.ts:855` | `!sharedSession` guard in the unknown-session retry | delete the guard |
| `execute.ts:536-539` | the exact error log "Shared OpenCode recovery preflight unavailable; no inference sent" | delete |
| `execute.ts:541-546` | exit 75 result shape `{ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } }` | delete, unless another path emits it |
| `shared-session-recovery.ts:41` | `prepareSharedOpenCodeSession` itself | delete file |
| `shared-session-recovery.ts:82-86` | durable binding file `<stateDir>/paperclip-opencode-session-recovery/<agentId>-<taskId>.json` | delete; no reader remains |
| `shared-session-recovery.ts:101-107` | requested-session conflict and foreign-active-session refusal | **behaviour must be ported to adoption** (step 6 / risk A.1), then deleted here |
| `shared-session-recovery.ts:110-118` | resume-or-create | superseded by step 7 |
| `shared-session-recovery.test.ts:1-176` (uses at `:79, :90, :104, :107, :115, :121, :126, :134, :142, :149, :153, :160, :163, :168, :170, :176`) | whole suite | delete with the module; its cases map to negative tests 11, 16 and to step 7 |
| `execute.shared-restart.test.ts:81` | `sharedServerRecoveryConfigPath: cfg` fixture | delete the fixture and the restart assertions it drives, or convert to a v12 adoption restart test |
| `packages/adapters/opencode-local/src/index.ts:104` | documents `sharedServerRecoveryConfigPath` | remove the field from the documented config |
| `ops/research/runner-control/experiments/unified-native-mission/deploy-drain.mjs:290, :305` | research artifact reading the same field and state dir | mark historical or delete; it is not product code |

### 5.2 The recovery prompt in the adapter

`packages/adapters/opencode-local/src/server/execute.ts:620-627`:

```ts
const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
const basePrompt = joinPromptSections([
  // On a recovered server session, keep the model's prior tool outcomes
  // in context instead of treating the assignment as a fresh execution.
  resumedSession && sharedSession?.resumed &&
    (sharedSession.recovered || isPaperclipRecoveryWakePayload(context.paperclipWake))
    ? "Controller restart recovery: inspect the existing session history. Do not repeat any completed tool actions; continue only unfinished work."
    : "",
```

The condition depends on `sharedSession.resumed` / `.recovered`, so it dies with the module.
**The sentence itself must move**, not disappear: after retirement, controller-restart
recovery on an adopted listener goes through `dispatchForRun` with `resume: true`
(`opencode-shared-host.ts:127`), and that path needs the same "inspect existing history, do
not repeat completed tool actions" instruction. Otherwise risk C.1 becomes a live
regression at exactly the moment the safety net is deleted. Note `resumedSession` (`:616`)
and `isPaperclipRecoveryWakePayload` are independent of `sharedSession` and stay.

### 5.3 Untouched by this plan

- `server/src/services/heartbeat/run-state.ts:1665-1675` — final checkpoint recognition.
- `server/src/services/heartbeat/opencode-shared-checkpoint.ts:28-41` — lease-checked
  cursor writer (only the `immutable` list at `:13` grows).
- `server/src/services/native-runtime/opencode-bound-fetch.ts:18` — MCP `PUT` allowlist.
- `server/src/services/native-runtime/opencode-shared-authority.ts`,
  `opencode-shared-observer.ts`, `opencode-managed-mutation.ts`, `opencode-native-port.ts`,
  `opencode-scoped-listener.ts` — all consume the handle and do not care where the process
  came from.

---

## 6. Sequencing

Four commits, each independently revertible:

1. **Descriptor + attestation** (steps 1-2) with unit tests 1-8, 15. No caller yet; nothing
   changes at runtime. This is the commit that must be reviewed hardest — it is the whole
   security boundary.
2. **Adoption wiring** (steps 3-6, 8) behind an explicit per-agent config flag, with tests
   9-12, 17. `startOpenCodeSharedHost` remains the default, so a bad flag fails closed.
3. **Identity and gate** (steps 7, 9) with tests 13, 14, 16, 18, and the ported
   "no foreign active session" preflight plus the ported restart-recovery sentence
   (section 5.2). Only now may an agent's config point at 19402/19403.
4. **Retirement** (step 10, section 5) as its own revertible commit after one real v12 run
   has completed on each listener and been reconciled after a controller restart.

Gates between commits:

- Commit 3 must not merge until risk A.2's directory collision is either proven harmless
  (one writer per directory enforced) or documented as an accepted limitation with the
  mutex in place.
- Commit 4 must not merge until the "no foreign active session" and restart-recovery
  behaviours are demonstrably present in the v12 path — they are the two things Path B does
  correctly today that the server path does not do yet.
- Do not enable adoption for an agent whose adapter config still carries
  `sharedServerRecoveryConfigPath`; the two writers must not overlap (risk A.4).

### Unverified preconditions to check before step 2 is implemented

1. `/api/info.version` on both listeners is `2.2.5`. Everything durable is pinned to that
   value (`opencode-shared-recovery.ts:34`, `opencode-shared-checkpoint.ts:33`); a different
   build is a blocking finding, not a workaround.
2. Whether 2.2.5 exposes any removal route for `/api/experimental/mcp/<name>`; only `PUT`
   is evidenced in this repository. If it does not exist, step 6 keeps the residual risk
   A.3 and the mutex becomes load-bearing.
3. The exact `namespace` value to persist (backend descriptor directory vs. the listener's
   own state root) — pick whichever makes `recoverOpenCodeSharedHost`'s
   `workingDirectory ?? join(namespace, "work")` (`opencode-shared-host.ts:260`) resolve to
   the attested cwd, since that comparison is what rejects a redirected recovery.

No product source was edited for this report; no listener was contacted and no process was
signalled while producing it.



