#!/bin/sh
# The active seat file owns the credentials. The stable proxy owns routing,
# including for run-env.sh files created before blue/green deployments existed.
set -eu
f=${PAPERCLIP_RC_RUN_ENV:-}
[ -n "$f" ] && [ -r "$f" ] || { echo 'pcrc: set PAPERCLIP_RC_RUN_ENV to the run-env.sh path from the dispatch prompt' >&2; exit 2; }
. "$f"
export PAPERCLIP_API_URL=https://10.0.1.100
exec "$@"
