#!/bin/sh
# Reuse the existing instance environment before entering the pinned CLI.
set -eu
. /Volumes/NVM/Paperclip/env.sh
exec "$@"
