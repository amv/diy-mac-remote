#!/bin/sh
#
# start-plain.sh — one command to start the server with no Node.js at all
#
# The Node-free path: Perl (which macOS ships) owns the socket, and the server
# itself runs inside `osascript -l JavaScript` (which macOS also ships). Nothing
# is downloaded, nothing is installed, and there is no ./node directory in
# sight — compare start.sh, which begins by making sure it has a verified
# Node.js to run on.
#
# What you give up is HTTPS: this path speaks plain HTTP and only plain HTTP.
# That is fine in exactly two situations, and they are the two this is for:
#
#   * over Tailscale — the tailnet already encrypts and authenticates every
#     packet between the phone and the Mac, so a certificate would be belt and
#     braces (./start-plain.sh tailscale), or
#   * on a network with no route to the internet at all.
#
# On any other network, prefer start.sh with a certificate — see README >
# "Serve it over HTTPS". The app's own encryption (ChaCha20 + HMAC) is in place
# either way; what plain HTTP costs you is protection against an active attacker
# on the local network rewriting the page itself.
#
# Any arguments you pass are forwarded straight to server.pl, e.g.
#   ./start-plain.sh tailscale
#   ./start-plain.sh --reset-token
#   ./start-plain.sh http://myhost:8765/

set -eu   # -e: stop on the first error.  -u: error on unset variables.

# Work relative to this script's own location, so it doesn't matter what
# directory you happen to run it from.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Check what we're standing on ---------------------------------------------

# Both of these are part of macOS. If one is missing you are either not on a Mac
# or on something unusual, and a clear message now beats a confusing one later.
if ! command -v perl >/dev/null 2>&1; then
  echo "❌ No perl found. It ships with macOS — if it is gone from this Mac," >&2
  echo "   use ./start.sh instead (that path uses Node.js)." >&2
  exit 1
fi

if ! command -v osascript >/dev/null 2>&1; then
  echo "❌ No osascript found. This is macOS's own scripting tool and the server" >&2
  echo "   runs inside it; without it there is nothing to run." >&2
  exit 1
fi

# --- Start the server ---------------------------------------------------------

echo "Starting server (no Node.js — perl + osascript)..."

# Leave a note of which process this is, for stop.sh (and the double-clickable
# stop.command next to it) to find later. `exec` below swaps this shell for perl
# without changing the process id, so $$ is already the server's pid.
#
# Only if the directory is already there: it is the server's own, created with
# permissions it checks on startup, and this is not the place to second-guess
# those. Before the first run there is nothing to stop anyway, and stop.sh can
# find a running server by its port regardless.
DIR="${DIY_MAC_REMOTE_DIR:-$HOME/.diy-mac-remote}"
[ -d "$DIR" ] && echo "$$" > "$DIR/server.pid"

# `exec` replaces this shell with perl, so the server becomes the main process
# (signals like Ctrl-C go straight to it, no extra shell in the middle).
# "$@" forwards along any arguments you gave start-plain.sh.
exec perl "${SCRIPT_DIR}/server.pl" "$@"
