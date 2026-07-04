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
# `exec` replaces this shell with node, so the server becomes the main process
# (signals like Ctrl-C go straight to it, no extra shell in the middle).
# "$@" forwards along any arguments you gave start.sh.
exec "$NODE_BIN" "${SCRIPT_DIR}/server.js" "$@"
