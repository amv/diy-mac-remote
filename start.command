#!/bin/sh
#
# start.command — double-clickable launcher for macOS Finder
#
# On macOS, Finder opens any executable file ending in ".command" in a new
# Terminal window and runs it there. This wrapper just forwards to start.sh,
# so double-clicking this file is the same as running ./start.sh yourself.
#
# Note: Terminal starts .command files with your home directory as the working
# directory, not the folder the file lives in — so resolve our own location
# first, same trick as start.sh.

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

exec "${SCRIPT_DIR}/start.sh"
