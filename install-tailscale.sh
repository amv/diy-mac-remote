#!/bin/sh
#
# install-tailscale.sh — set up diy-mac-remote for Tailscale. Run it from
# Terminal:
#
#   ./install-tailscale.sh
#
# The Tailscale path needs no certificate and nothing installed on the phone:
# the server's own crypto protects every keystroke, and the tailnet-only source
# filter keeps other networks out (see README > Run the server). So "install"
# here is just: make sure there's a Node.js to run on, and put a
# double-clickable start.command (Tailscale mode baked in) into the
# `diy-mac-remote` folder on the Desktop.
#
# Why isn't this itself a double-clickable .command file? macOS quarantines
# downloaded files and refuses to run a downloaded .command from Finder. Files
# *created on this Mac* are not quarantined — so you run this script from
# Terminal once, and the start.command it generates on the Desktop is safely
# double-clickable from then on.

set -eu

# Resolve our own location, so the script works from any current directory.
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
