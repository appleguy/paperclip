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
