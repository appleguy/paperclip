# N9 identity and authority

This is the database slice of the [single-writer design](https://mac.local/SCO/issues/SCO-932#document-spec).
It is not enabled in a provider path and establishes no provider fencing guarantee.
Gateway/journal integration belongs to [SCO-1016](https://mac.local/SCO/issues/SCO-1016);
adoption belongs to [SCO-1017](https://mac.local/SCO/issues/SCO-1017). Platform deploys the combined result.

## Ownership and contract

`packages/db/src/native-session-authority.ts` owns physical identity, company/run
validation, transactional grant CAS, and its durable transition audit. Existing
`agent_task_sessions` remains the agent/task projection; existing PRP command
journals remain the effect journal. This adds no dispatcher, background scan,
timer, provider handle, public endpoint, or automatic session migration.

The service supplying `AuthorityActor` must derive it from authenticated current
execution authority, not request JSON. Each call validates the company/agent/run
binding against `agents` and `heartbeat_runs`. This binding is not itself the
actor's permission to control a particular conversation; the owning service
retains that authorization check. Do not expose the store directly as an API.

`provision` creates or reads one durable provisional identity per company,
canonical provider family, durable host UUID, and caller-persisted provisional ID.
Retries must reuse that provisional ID, including before provider creation.
Adapter/driver aliases normalize to one family; bare `acpx` is rejected because
it does not identify a provider. Hostname, cwd, task, agent, run, PID, seat, pane,
and runner-wrapper session IDs do not identify a physical provider conversation.
Host UUIDs come from the verified durable host registry, never a fresh UUID per
controller. Duplicate registry entries for the same physical host must be resolved
before adoption; the database cannot infer physical host equivalence.

`bindProvider` atomically records the actual provider conversation ID and rejects
another provisional row bound to that same company/provider/host conversation.
It never merges grant records. `findProvider` lets subsequent runs resolve the
canonical authority row without creating a new provisional one. Known resume
identities must be resolved/bound before any provider mutation. New conversation
creation needs a provisional grant; its returned physical ID must be bound before
subsequent effects. A conflicting bind leaves the loser unbound and must send
the adoption path to observe/reconcile, never to another create or prompt.
Opaque extension providers require an explicit `plugin:` namespace and a reviewed
identity mapper; extension naming alone cannot prove physical uniqueness.

`reserve` performs a conditional UPDATE on expected generation, immutable host
epoch, and `free`/`active` state. Generation is PostgreSQL bigint and crosses the
TypeScript boundary as a decimal string. Exactly one racing client reserves the
next generation in `installing`; no client receives an active grant at reservation.
Active takeover reserves the next installing transition, not permission to send.
Unknown/installing/revoking cannot be acquired by timeout or lease expiry.

`acknowledge` accepts the exact generation/controller/run/gateway incarnation only
while installing. The gateway must first serialize a durable fence barrier and
establish exclusive transport ownership. `release` likewise requires the holder's
exact grant and a settled gateway receipt. These are trusted gateway calls;
an arbitrary controller-supplied evidence string is not a fence or settlement proof.
Gateway evidence validation and the command journal are the next slice.

`markUnknown` preserves ambiguous work. `read` after restart does not clear it.
`reconcileSettled` lets the exclusive gateway audit a current authenticated actor
while settling an exact previous grant after its old run disappears. It requires
the old generation/incarnation/controller/epoch and a verified settlement receipt;
the owning gateway must prove transport exclusion and disposition of prior work.
It cannot settle a successor generation. It does not send/replay a command.
The next reservation increments the high-water mark. Host epoch never changes
because of restart, timeout, process absence, or a caller-provided new epoch;
verified host replacement remains an explicit gateway/adoption operation.

Authority rows and unresolved audit history are durable state, not run-cleanup
garbage. There is no deletion/compaction operation in this slice. Any future
retention must preserve identity uniqueness, high-water marks and unresolved work.
The migration only adds tables, constraints and indexes; it neither rewrites nor
imports historical task sessions. Unproven historical mappings remain on their
existing path or observe-only during future adoption.

## Mutation and alias inventory

Audit boundary: master source at the parent of this change; stable `src` source
at `b52c16815` plus the live claude-rc changes was also inspected. These trees
differ: claude-rc/native-interactive implementations exist in stable `src`, not
this master tree. Deployment must reconcile that branch delta. No entry below
claims the path already consumes this store or has an enforced N9 gateway.

Paths below are repo-relative. `R` = `packages/paperclip-runner/`;
`C` = `R/runner/crates/runner-core/src/`; `D` = `R/src/drivers/`.

| Mutation family | Entry / actual effect owner | Identity and aliases to unify |
| --- | --- | --- |
| Open/create, replacement, recover/resume, attach | `R/src/contracts/native-session-backend.ts`; `R/src/native-session-runtime.ts`; `R/src/backends/harness-driver-backend.ts`; `C/native_provider_backend.rs` | Persisted native session UUID, driver session, run binding and normalized session ID are wrappers. Resolve the actual provider identity below. Attach/recover can mutate provider run binding and must not be assumed read-only. |
| Prompt, continuation, steer/follow-up, interrupt/stop/cancel, request decision/handoff, goal edit/pause/resume/clear, close/cleanup | `NativeSession` methods `startTurn`, `steer`, `interrupt`, `cancel`, `resolveRuntimeRequest`, `handoffRuntimeRequest`, `goal`, `close`; runtime restart-continuation and retained-cleanup callers | A run/task checkout and publication revocation do not fence any of these. Even cleanup/close must use the grant if it can affect the conversation. |
| PRP dispatch and maintenance | `R/src/control-plane/durable-prp-control-plane.ts`; `C/local_runner.rs`, `C/native_provider_backend.rs` | `run.prepare`, `run.attach`, `session.open`, `turn.start`, `turn.steer`, `turn.interrupt`, `turn.stop`, `request.resolve`, `interaction.receipt`, `semantic_tool.result`, `external_provider.operation`, `session.goal.set`, `session.goal.clear`, `session.close`, `session.budget.increase`, `session.destroy`, `run.cancel`, `runner.drain`, `runner.suspend`, `runner.shutdown`. Maintenance commands that close/mutate sessions must use the same barrier; command IDs/connection leases are not conversation IDs. |
| Codex app-server | `D/codex/codex-app-server-driver-impl.ts`, `codex-harness-session.ts`, `codex-session-server-requests.ts`, `app-server-transport.ts`; `C/codex_provider.rs`, `C/codex_shared_socket.rs`; stable `src` also has `D/codex/managed-native-goal-bridge.ts` | Canonical family `codex`; thread ID from provider, not a transport/client/run/turn ID. Includes `thread/start`, `thread/resume`, `turn/start`, `turn/steer`, `turn/interrupt`, goal mutations and server-request responses; all serialized stdin/shared-socket writes belong to the effect owner. |
| ACPX/ACP providers, including Codex, Claude, Cursor, Gemini, Grok, Kimi, Pi, Copilot, Antigravity | `D/acpx/codex-acpx-driver.ts`, `runtime-host.ts`, `session-goals.ts`, `turn-controls.ts`, permission/question adapters; `packages/adapter-utils/src/acpx-engine/execute.ts`; `C/acpx_provider_backend.rs`, `acpx_provider_session.rs`, `acpx_sidecar_transport.rs` | Use actual configured provider family, not `acpx_runtime`. Map ACPX record/runtimeSessionName, acpSessionId, agentSessionId, backendSessionId, providerSessionId, native thread ID through verified provider evidence. `D/acpx/recovery-identity.ts` already distinguishes recovery bindings. New/load/prompt/cancel, mode/model changes, goals, permission/question/extension responses and close are mutations. Bare wrapper IDs remain provisional until the physical mapping is proved. |
| OpenCode shared/server | `D/opencode/opencode-server-driver.ts`; `server/src/services/native-runtime/opencode-shared-authority.ts`; OpenCode adapter shared-session recovery | Family `opencode`; actual server session ID plus stable server host. Session create/fork/init, prompt_async, abort, question reply/reject and permission reply are writes. Agent name, cwd, port, adapter runtime key and run aliases must not create new physical namespaces. |
| Claude native interactive / RC channel / legacy tmux | Stable `src`: `D/claude/native-interactive-session.ts`, `native-pty-factory.ts`; `server/src/adapters/claude-rc/{execute,channel}.ts`; bridge control subprocess and pane input owner | Family `claude`; actual Claude session UUID plus durable physical host. `runId`/op ID, named RC, seat, tmux socket/session/pane and state directory are aliases. Channel inbox/push and tmux literal writes, Enter, startup confirmation/slash commands and prompt fallback all mutate. Fence at the bridge/PTY/pane owner; an adapter precheck alone leaves both bypasses open. |
| Claude Managed Agents / AWS AgentCore / Cursor cloud | `C/claude_managed_provider.rs`, `aws_agentcore_provider.rs`, `cursor_cloud_proxy.rs`, `managed_provider.rs`; Cursor adapter `sdkAgent.send`/reattach | Families `claude_managed`, `aws_agentcore`, `cursor`. Managed Claude API sessions are a distinct physical namespace from local Claude CLI. Remote session/task identity must be mapped to a stable registered remote host namespace, not the transient local proxy host. Create/attach/send, approval decisions, budget/goal changes and termination remain mutations. |
| Dot / Grok Bot / Muse external | `D/dot/dot-harness-driver.ts`, `runnerd-dot-driver.ts`; `D/external/runnerd-external-driver.ts`; `D/muse/runnerd-muse-driver.ts`; `C/dot_provider_backend.rs`, `external_provider_backend.rs` | Families `openai_dot`, `grok_bot`, `muse`. External provider normalizedSessionId/display ID can have no providerSessionId. Preserve provisional identity until external operation evidence binds the actual conversation. Open/start/send, runtime decision, cancel and close go through the external operation gateway. |
| Native host/external control ingress | `server/src/services/native-runtime/{native-session-executor,native-session-resume,native-session-handoff,runtime-request-resolution-authority,retained-native-session-cleanup,claude-native-authority,codex-shared-goal-authority,external-native-authority,antigravity-headless-authority}.ts`; `C/host_control.rs`, `antigravity_provider.rs` | Reuse the same canonical row for owner steering delivered through Paperclip, native goal actions, permission decisions, retained cleanup and remote warm attachment. A new host epoch/run must not fabricate a new conversation identity. |
| Legacy local adapters | `packages/adapters/{claude-local,codex-local,cursor-local,gemini-local,grok-local,kimi-local,pi-local,opencode-local}/src/server/execute.ts` and shared ACPX engine | Canonical family aliases are normalized in the store. Child stdin, ACP request writes, CLI resume and process cancellation remain bypasses until routed/retired. Direct local adapter names do not prove a separate physical session. |
| Hermes / OpenClaw and arbitrary adapter/plugin dispatch | Hermes local/gateway and OpenClaw adapter execute modules; `server/src/adapters/{http,process}/execute.ts`; stable `src` `server/src/adapters/agy/execute.ts`; adapter plugin execution | Hermes create-run/stop and OpenClaw prompt/cancel must bind remote conversation identity. HTTP/process/plugin commands are opaque and may launch a direct writer; no N9 guarantee is possible for them without a provider-bound effect mapper or exclusion from the N9-controlled session. Owner's independent provider UI and arbitrary same-UID processes remain outside the design's security boundary. |

Read-only candidates are descriptor/capability/history/goal-get/result/usage/event
observation and snapshots only when the implementation proves no provider mutation.
Snapshot/get methods that reconcile, start helpers, alter bindings or acknowledge
provider requests still belong behind the effect gateway. Initialization/configuration
and fork/new are mutations even before a provider conversation ID is returned.

This is a source call-site inventory, not a live-provider qualification. All paths
above must be adopted or explicitly excluded before allowing a second controller.
No provider was contacted, interrupted, replaced or migrated for this slice.

## Qualification

`native-session-authority.test.ts` uses two distinct postgres.js clients against
one database. PostgreSQL verifies distinct backend PIDs. PGlite uses its official
socket multiplexer with two TCP connections and reopens the persistent engine for
restart; two separate PGlite databases are never treated as a race. The shared
suite exercises concurrent provision/grant acquisition and provider alias binding,
ACK retry, stale ACK/release, active takeover, wrong company/run/host/provider,
unknown/installing recovery, stale settlement, transaction rollback on audit
failure, and generations above 2^53. PostgreSQL uses the full application schema
and migration chain. PGlite uses the exact generated new migration with only its
three FK parent tables stubbed; it does not qualify the full application schema.

Pinned test dependencies: PGlite 0.5.15, pglite-socket 0.2.18. These are dev-only;
the production database client remains PostgreSQL. PGlite's multiplexer is not
PostgreSQL multi-backend concurrency and is qualified only for these operations
and this version pair. See the [upstream socket contract](https://pglite.dev/docs/pglite-socket).

Run from the checkout root:

```sh
TMPDIR=/Volumes/NVM/AI_Agent_Runtime/tmp pnpm --filter @paperclipai/db exec vitest run src/native-session-authority.test.ts
pnpm --filter @paperclipai/db typecheck
pnpm --filter @paperclipai/db build
```

Test scratch is isolated below the authorized NVM scratch directory; persistent
PGlite test data is retained for bounded quarantine/diagnosis. No production data
or provider state is used. Dependency installs that skip scripts must explicitly
run the embedded-postgres package's reviewed symlink hydration script on macOS;
otherwise missing ICU aliases make PostgreSQL unavailable, which is not a passed
or qualified PostgreSQL result. The earlier fixture failures (bad socket URL and
fault constraint applied to historical test rows) were corrected before acceptance.
