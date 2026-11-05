# Blue/green deploy operations

Postgres already runs independently as `ing.paperclip.postgres` on 55432.
The external connection in `instances/main/config.json` is unchanged. Upstream
supports this through `DATABASE_URL` or `database.mode=postgres`; see
`doc/DATABASE.md`. Keep migrations compatible with both overlapping versions
(`doc/MIGRATION-COMPATIBILITY.md`).

Both live Caddy listeners now know blue (3100) and green (3101), select the first
healthy upstream, and actively check `/api/health` for `status=ok`. The transcripts
`forward_auth` uses the same pool. Caddy's admin API stays off. The initial pool
configuration was applied with SIGUSR1, which reloads the original `--config`
file without restarting Caddy. Subsequent handoffs need no Caddy reload.

Primary references:
- https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- https://caddyserver.com/docs/caddyfile/directives/forward_auth
- https://caddyserver.com/docs/command-line

## Controller

`zagent/go/cmd/autodeploy` implements `serve-color`, `endpoint` and `handoff`.
The plists run as tech and read immutable colour payloads from
`/Volumes/NVM/Paperclip/ops/zero-downtime/{blue,green}.json`. Both connect to the
same existing instance and external Postgres; the scheduler advisory lock is on.
The active colour is recorded in `active.json` only after readiness.

`pc-deploy` resolves the active endpoint inside its existing flock. Its verified
build and docs-only fast paths run before installation or replacement. A new
runtime head still deploys immediately. With the ops `enabled` marker present,
it starts the idle colour, waits for its listener and lock-wait state, writes the
upstream hot-restart intent, and asks the old controller to detach with SIGUSR2.
The old controller retains HTTP while the successor takes leadership and adopts
runs, then exits after Caddy has observed successor readiness. Normal shutdown
reuses the same preparation, so a second signal cannot detach twice.

The first transition from a pre-lock server uses `legacy-leader.mjs` to hold the
same upstream advisory lock until that server exits. It is temporary bootstrap
glue, not a second scheduler. A failed replacement restores the pinned original
colour and install pointer; no database or payload is deleted.

`pcrc.sh` reads each active seat's existing credential file but routes calls to
the stable HTTPS API. This also fixes seat files written before blue/green,
without rewriting credentials during another worker's update.

## Current rollout state

The Caddy pools and stable `pcrc` wrapper are live. The handoff controller and
server changes are built and tested, but the `enabled` marker is absent and no
green service has been bootstrapped. Server-owned ACP stdio still returns
`acp_drain_required` in `prepareHotRestartShutdown`; SCO-929 owns its restart
survival. The controller must not be described as proven until the live Codex
and Claude RC handoff has passed with no failed calls or interrupted runs.

## Rollback

After an enabled handoff, set `cli/current` back using the existing
`deploy-restore-install.mjs` helper and run `autodeploy handoff` with the original
full SHA and the current payload's short SHA; the same health checks apply.
For bootstrap recovery, restore the archived blue plist and install pointer,
boot out green, and bootstrap blue. Caddy already falls back to blue.
Backups are in `/Volumes/NVM/Paperclip/ops/zero-downtime/archive/sco877-bootstrap`.
Postgres stays independent throughout rollback.
