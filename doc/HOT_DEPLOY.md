# Hot deploy (SCO-818)

`bin/pc-deploy` picks hot or full restart from the files changed since the build the server is serving.

| Class | Files | Deploy |
|---|---|---|
| hot | `server/src/adapters/claude-rc/{execute,done-gate,channel,rc-name}.ts` and their tests | install payload, switch the server's hot modules; no drain, no restart |
| none | `doc/ docs/ ops/ tests/ evals/`, `*.md` | nothing to deploy |
| full | everything else (wake/routing in `services/`, `liveness.ts`, db, shared, UI) | SCO-817 drain, checkpoint, restart |
| plugin | plugin UI bundles and workers | already restart-free via the plugin system; not handled by pc-deploy |
| adapter | externally installed adapters | upstream `POST /api/adapters/:type/reload` |

Mechanism: `server/src/hot/hot-modules.ts`. `hot-deploy.mjs activate` writes `$PAPERCLIP_HOME/hot/active.json`
(base build, hot commit, new payload dist dir). The server watcher preloads the modules and writes
`hot/loaded.json`; calls started later import the new payload's copy (`?hot=<sha>` cache bust), running calls finish on
the code they started with. A marker for another build is ignored, so a restart returns to the built-in code. No ack in
60 s removes the marker and pc-deploy falls back to the full path.

Adding a hot module: it must be a leaf with no shared singleton state, be loaded through `hotImport`, and be listed in
`server/src/hot/hot-paths.txt`. Modules imported statically elsewhere (e.g. `claude-rc/liveness.ts`) stay full.

## Hot reload vs reattach (owner direction)

Runner detach/reattach across server restarts (SCO-817) is the preferred route wherever hot reload of a module is not
practical. Hot reload is reserved for leaf modules that are cheap to swap safely.

| Module | Route | Why |
|---|---|---|
| claude-rc `execute`, `done-gate`, `channel`, `rc-name` | hot | leaf, no shared singleton state, edited most often; in-flight calls finish on old code |
| plugin UI bundles and workers | plugin system (restart-free) | upstream already supports it |
| externally installed adapters | `POST /api/adapters/:type/reload` | upstream path |
| claude-rc `liveness`, wake/routing in `services/`, heartbeat | reattach (full restart) | statically imported, hold timers and in-memory run state; swapping risks split-brain |
| db/migrations, `shared`, auth, routes, UI server bundle | reattach (full restart) | process-wide state or schema; no safe partial swap |
| opencode-local / codex_local / NAR adapters | reattach (full restart) | long-lived runner state already survives restarts via detach/reattach |
