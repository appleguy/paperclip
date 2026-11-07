#!/bin/sh
# Interactive entry only; daemon management and noninteractive work use their
# explicit approved launchers, not this shim. Never fall back to ~/.codex.
set -eu
home=/Volumes/NVM/Paperclip/workspaces/platform-lead-outside/context/codex-home
socket="$home/app-server-control/app-server-control.sock"
if [ "${CODEX_HOME:-}" != "$home" ]; then
  echo 'codex shim: CODEX_HOME must name the approved zero home' >&2
  exit 2
fi
if [ "$#" -ne 0 ]; then
  echo 'codex shim: only bare interactive codex is supported; use the approved NAR launcher for other work' >&2
  exit 2
fi
if [ ! -S "$socket" ]; then
  echo 'codex shim: approved daemon socket is unavailable; refusing to start a daemon' >&2
  exit 1
fi
target=$(/usr/bin/readlink "$socket") || { echo 'codex shim: socket link unavailable' >&2; exit 1; }
case "$target" in /*) ;; *) echo 'codex shim: invalid socket target' >&2; exit 1 ;; esac
[ -S "$target" ] || { echo 'codex shim: socket target unavailable' >&2; exit 1; }
export CODEX_HOME="$home"
exec /opt/homebrew/bin/codex --remote "unix://$target"
