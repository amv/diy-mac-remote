#!/bin/sh
#
# install-tailscale.sh — set up diy-mac-remote for Tailscale. Run it from
# Terminal:
#
#   ./install-tailscale.sh
#
# The Tailscale path needs no certificate and nothing installed on the phone:
# WireGuard protects the transport and the server's own crypto protects every
# keystroke. So "install" here is just: put a double-clickable start.command
# (Tailscale mode baked in) into the `diy-mac-remote` folder on the Desktop,
# and build `DIY Remote Server.app` (bundle-app.sh) next to it — the same mode
# baked in, the Accessibility permission belonging to that app instead of to
# your Terminal, and the app registered to start at login
# (./bundle-app.sh --no-at-login --plain tailscale undoes that).
#
# No Node.js: both run start-plain.sh — perl holds the socket, osascript runs
# the server, and both ship with macOS, so nothing is downloaded. What that
# path gives up is HTTPS, and over a tailnet there is nothing for HTTPS to add
# that WireGuard hasn't already done (docs/setup-options.md > "Run it without
# Node.js"). It also means a certificate left over from an earlier self-signed
# install can't switch the server to HTTPS behind your back: this server has
# none to switch to. install-tailscale-self-signed.sh is the path that serves
# the certificate, and the one that uses Node.js.
#
# Why isn't this itself a double-clickable .command file? macOS quarantines
# downloaded files and refuses to run a downloaded .command from Finder. Files
# *created on this Mac* are not quarantined — so you run this script from
# Terminal once, and the start.command it generates on the Desktop is safely
# double-clickable from then on.

set -eu

# Resolve our own location, so the script works from any current directory.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Before anything else: could the app this builds run from where the repo is?
# Not from Desktop, Documents or Downloads — and a downloaded ZIP lands in
# Downloads. Stopping now costs nothing; finding out at the end would mean
# redoing all of the below once the folder has moved, because every piece of it
# points back at this path.
if ! "${SCRIPT_DIR}/bundle-app.sh" --check-location; then
  echo >&2
  echo "Nothing was changed. Move the folder, then re-run from there:" >&2
  echo "    ./$(basename "$0")${*:+ $*}" >&2
  exit 1
fi

# The two things start-plain.sh runs on. Both are part of macOS, so this only
# trips on something unusual — but start-plain.sh would only say so on the
# first double-click, and the app in a dialog after that.
for tool in perl osascript; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "❌ No $tool found. It ships with macOS, and the Node-free server this" >&2
    echo "   installs runs on it. Nothing was changed. Use the Node.js path" >&2
    echo "   instead:  ./bundle-app.sh tailscale  (it fetches Node.js first)." >&2
    exit 1
  fi
done

# The generated start.command runs "start-plain.sh tailscale" — Tailscale mode
# baked in, so the pairing QR always carries this Mac's Tailscale name and
# never a LAN address that happened to be detected instead. It only matters
# while pairing; afterwards the phone's Home Screen app holds the address.
"${SCRIPT_DIR}/ensure-desktop-folder.sh" --start-command-only --plain --start-args tailscale

# --- The app -------------------------------------------------------------------
# After the Desktop folder, never before: that is where bundle-app.sh puts the
# app, and it only knows to if the folder is already there. `--plain tailscale`
# for the same reasons start.command has them — the app must not be the one
# thing that can start the server in a less strict mode, or on a different
# entrypoint from the one the phone was paired with.
#
# Not fatal if it fails: start.command above is a working install.
echo
if ! "${SCRIPT_DIR}/bundle-app.sh" --quiet --plain tailscale; then
  echo >&2
  echo "⚠️  Could not build DIY Remote Server.app — the rest of the install is" >&2
  echo "   fine. Run ./bundle-app.sh --plain tailscale on its own to see why;" >&2
  echo "   until then, start the server with start.command in the Desktop folder." >&2
fi

# A certificate from an earlier HTTPS install is unused from now on, which
# changes nothing for a phone paired over Tailscale before — unless that pairing
# was made while the certificate was being served, in which case the phone's
# Home Screen app holds an https:// address this server cannot answer.
DIR="${DIY_MAC_REMOTE_DIR:-$HOME/.diy-mac-remote}"
if [ -f "$DIR/key.pem" ]; then
  echo
  echo "Note: there is a certificate in $DIR from an earlier HTTPS install."
  echo "This install doesn't use it — the Node-free server has no HTTPS at all."
  echo "A phone already paired to an https:// address has to pair again:"
  echo "reset-app-secrets.command in the Desktop folder, then start.command."
  echo "To serve the certificate over Tailscale instead, run"
  echo "./install-tailscale-self-signed.sh."
fi

echo
echo "Done. To use it:"
echo
echo "  1) Install Tailscale (https://tailscale.com) on this Mac and on the"
echo "     iPhone, signed in to the same tailnet."
echo
echo "  2) Double-click start.command in the Desktop diy-mac-remote folder."
echo "     It starts the server in Tailscale mode — plain HTTP, no Node.js —"
echo "     so the pairing QR carries this Mac's Tailscale name. Scan the QR it"
echo "     prints in Safari, then add the page to your Home Screen — that is"
echo "     the pairing, and it is the only time the QR is shown."
echo
echo "From then on, start it by double-clicking DIY Remote Server.app in that"
echo "same folder: no Terminal window, and the Accessibility permission belongs"
echo "to the app rather than to your Terminal. Pairing is the one step it will"
echo "not do — the one-time key must not end up in its log file."
echo
echo "And once you have paired, that app starts by itself every time you log in."
echo "./bundle-app.sh --no-at-login --plain tailscale turns that off again."
