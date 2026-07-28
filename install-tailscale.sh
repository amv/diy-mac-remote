#!/bin/sh
#
# install-tailscale.sh — set up diy-mac-remote for Tailscale. Run it from
# Terminal:
#
#   ./install-tailscale.sh
#
# The Tailscale path needs no certificate and nothing installed on the phone:
# WireGuard protects the transport and the server's own crypto protects every
# keystroke. So "install" here is just: make sure there's a Node.js to run on,
# put a double-clickable start.command (Tailscale mode baked in) into the
# `diy-mac-remote` folder on the Desktop, and build `DIY Remote Server.app`
# (bundle-app.sh) next to it — the same mode baked in, the Accessibility
# permission belonging to that app instead of to your Terminal, and the app
# registered to start at login (./bundle-app.sh --no-at-login undoes that).
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
# in, so the pairing QR always carries this Mac's Tailscale name and never a LAN
# address that happened to be detected instead. It only matters while pairing;
# afterwards the phone's Home Screen app holds the address.
"${SCRIPT_DIR}/ensure-desktop-folder.sh" --start-command-only --start-args tailscale

# --- The app -------------------------------------------------------------------
# After the Desktop folder, never before: that is where bundle-app.sh puts the
# app, and it only knows to if the folder is already there. `tailscale` for the
# same reason start.command has it — the app must not be the one thing that can
# start the server in a less strict mode.
#
# Not fatal if it fails: Node.js and start.command above are a working install.
echo
if ! "${SCRIPT_DIR}/bundle-app.sh" --quiet tailscale; then
  echo >&2
  echo "⚠️  Could not build DIY Remote Server.app — the rest of the install is" >&2
  echo "   fine. Run ./bundle-app.sh tailscale on its own to see why; until" >&2
  echo "   then, start the server with start.command in the Desktop folder." >&2
fi

echo
echo "Done. To use it:"
echo
echo "  1) Install Tailscale (https://tailscale.com) on this Mac and on the"
echo "     iPhone, signed in to the same tailnet."
echo
echo "  2) Double-click start.command in the Desktop diy-mac-remote folder."
echo "     It starts the server in Tailscale mode, so the pairing QR carries"
echo "     this Mac's Tailscale name. Scan the QR it prints in Safari, then"
echo "     add the page to your Home Screen — that is the pairing, and it is"
echo "     the only time the QR is shown."
echo
echo "From then on, start it by double-clicking DIY Remote Server.app in that"
echo "same folder: no Terminal window, and the Accessibility permission belongs"
echo "to the app rather than to your Terminal. Pairing is the one step it will"
echo "not do — the one-time key must not end up in its log file."
echo
echo "And once you have paired, that app starts by itself every time you log in."
echo "./bundle-app.sh --no-at-login tailscale turns that off again."
