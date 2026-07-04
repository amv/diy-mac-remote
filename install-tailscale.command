#!/bin/sh
#
# install-tailscale.command — double-clickable setup for running diy-mac-remote
# over Tailscale, for macOS Finder.
#
# The Tailscale path needs no certificate and nothing installed on the phone:
# the server's own crypto protects every keystroke, and the tailnet-only source
# filter keeps other networks out (see README > Run the server). So "install"
# here is just: make sure there's a Node.js to run on, and put a
# double-clickable start.command into the `diy-mac-remote` folder on the
# Desktop. The Terminal window stays open afterwards so you can read the steps
# below.
#
# Terminal starts .command files with your home directory as the working
# directory, not the folder the file lives in — so resolve our own location
# first, same trick as start.sh.

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Idempotent and silent when ./node/bin/node already works; otherwise it links
# a pre-installed Node or downloads a verified build.
"${SCRIPT_DIR}/ensure-node.sh"

# The generated start.command runs "start.sh tailscale" — Tailscale mode baked
# in, so a double-click can never accidentally start the server in a less
# strict mode: it accepts requests from the tailnet only, and refuses to start
# at all when no tailnet is up (rather than falling back to an open LAN
# address).
"${SCRIPT_DIR}/ensure-desktop-folder.sh" --start-command-only --start-args tailscale

echo
echo "Done. To use it:"
echo
echo "  1) Install Tailscale (https://tailscale.com) on this Mac and on the"
echo "     iPhone, signed in to the same tailnet."
echo
echo "  2) Double-click start.command in the Desktop diy-mac-remote folder."
echo "     It starts the server in Tailscale mode: it advertises this Mac's"
echo "     Tailscale name, accepts requests from the tailnet only, and refuses"
echo "     to start when the tailnet is down. Scan the QR it prints."
