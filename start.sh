#!/bin/sh
#
# start.sh — one command to get Node.js (if needed) and start the server
#
# What this does
# --------------
# 1. Run ensure-node.sh, which makes sure ./node/bin/node works: a no-op if it
#    already does, else it links a pre-installed Node or downloads a verified
#    build (see the long explanation in that script).
# 2. Start the server using *that* Node, so the code always runs on the build
#    ensure-node.sh vouched for.
#
# Any arguments you pass to start.sh are forwarded straight to server.js, e.g.
#   ./start.sh tailscale
#   ./start.sh http://myhost:8765/

set -eu   # -e: stop on the first error.  -u: error on unset variables.

# Work relative to this script's own location, so it doesn't matter what
# directory you happen to run it from. `dirname "$0"` is the folder the script
# lives in; `cd` there and grab the absolute path with `pwd`.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

NODE_BIN="${SCRIPT_DIR}/node/bin/node"

# --- Make sure we have Node ---------------------------------------------------

# ensure-node.sh is idempotent and silent when ./node/bin/node already works;
# otherwise it links a pre-installed Node or downloads a verified build.
"${SCRIPT_DIR}/ensure-node.sh"

# --- Start the server ---------------------------------------------------------

echo "Starting server..."

# Leave a note of which process this is, for stop.sh (and the double-clickable
# stop.command next to it) to find later. `exec` below swaps this shell for node
# without changing the process id, so $$ is already the server's pid.
#
# Only if the directory is already there: it is the server's own, created with
# permissions it checks on startup, and this is not the place to second-guess
# those. Before the first run there is nothing to stop anyway, and stop.sh can
# find a running server by its port regardless.
DIR="${DIY_MAC_REMOTE_DIR:-$HOME/.diy-mac-remote}"
[ -d "$DIR" ] && echo "$$" > "$DIR/server.pid"

# `exec` replaces this shell with node, so the server becomes the main process
# (signals like Ctrl-C go straight to it, no extra shell in the middle).
# "$@" forwards along any arguments you gave start.sh.
exec "$NODE_BIN" "${SCRIPT_DIR}/server.js" "$@"
