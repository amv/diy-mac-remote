#!/bin/sh
#
# install-tailscale-self-signed.sh — the belt-and-braces install: Tailscale for
# the transport, your own certificate on top. Run it from Terminal:
#
#   ./install-tailscale-self-signed.sh
#
# Use this when you want both halves of "Securing the connection" at once:
#
#   * Tailscale (WireGuard) carries the traffic, so it works off your own LAN
#     and nobody on the wire can read or rewrite it; and
#   * your phone still refuses any page not signed by your own CA, so the VPN
#     is not the only thing standing between an attacker and your keyboard.
#
# The two paths are fiddly to combine by hand — the certificate has to name the
# MagicDNS name, which means deciding it before the CA is installed on the phone
# — so this script does the whole thing in one go, provided Tailscale is up:
#
#   1) ./gen-cert.sh --tailscale       — a CA + server certificate covering both
#      this Mac's .local name and its MagicDNS name, detected for you.
#   2) ./ensure-node.sh                — make sure there's a Node.js to run on.
#   3) ./ensure-desktop-folder.sh      — the `diy-mac-remote` folder on the
#      Desktop: the CA ready to AirDrop, the how-to, the reset commands, and a
#      start.command with Tailscale mode baked in.
#   4) ./bundle-app.sh tailscale       — `DIY Remote Server.app` in that same
#      folder, same mode baked in: the way you start the server day to day, and
#      the thing the Accessibility permission belongs to instead of your
#      Terminal.
#
# It needs a live tailnet, because step 1 cannot name an address that doesn't
# exist yet. If Tailscale isn't running it stops before touching anything, and
# tells you. It does not start the server — that's the Desktop start.command's
# job, once the certificate is on your phone.
#
# Any extra arguments are forwarded to gen-cert.sh, so you can name further
# addresses:  ./install-tailscale-self-signed.sh 10.0.0.9
#
# Why isn't this itself a double-clickable .command file? macOS quarantines
# downloaded files and refuses to run a downloaded .command from Finder. Files
# *created on this Mac* are not quarantined — so you run this script from
# Terminal once, and the start.command it generates on the Desktop is safely
# double-clickable from then on.

set -eu

# Resolve our own location, so the script works from any current directory.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# The certificate first, because it is the step that can refuse: no tailnet
# means no MagicDNS name to put in it, and an existing CA that predates that
# name has to be replaced (gen-cert.sh detects both and says so). Doing it up
# front means a refusal costs nothing — no Node downloaded, no Desktop folder
# rewritten, no existing certificate touched.
if ! "$SCRIPT_DIR/gen-cert.sh" --tailscale "$@"; then
  echo >&2
  echo "Nothing else was changed. Fix the above, then re-run:" >&2
  echo "    $0${*:+ $*}" >&2
  exit 1
fi

echo
# Idempotent and silent when ./node/bin/node already works; otherwise it links
# a pre-installed Node or downloads a verified build.
"$SCRIPT_DIR/ensure-node.sh"

echo
# The full folder (there IS a CA to hand over on this path), but with Tailscale
# mode baked into start.command. That matters at exactly one moment: pairing.
# `tailscale` mode refuses to pair when no tailnet is up, where the default
# would quietly pair your phone to a .local address it would then keep using.
"$SCRIPT_DIR/ensure-desktop-folder.sh" --start-args tailscale

# --- The app -------------------------------------------------------------------
# After the Desktop folder, never before: that is where bundle-app.sh puts the
# app, and it only knows to if the folder is already there. `tailscale` for the
# same reason start.command has it — the app must not be the one thing that can
# start the server in a less strict mode.
#
# Not fatal if it fails: the certificate, Node.js and start.command above are a
# working install on their own.
echo
if ! "$SCRIPT_DIR/bundle-app.sh" --quiet tailscale; then
  echo >&2
  echo "⚠️  Could not build DIY Remote Server.app — the rest of the install is" >&2
  echo "   fine. Run ./bundle-app.sh tailscale on its own to see why; until" >&2
  echo "   then, start the server with start.command in the Desktop folder." >&2
fi

# Open the folder in Finder on macOS so AirDrop is a right-click away.
command -v open >/dev/null 2>&1 && open "$HOME/Desktop/diy-mac-remote" >/dev/null 2>&1 || true

echo
echo "Done — Tailscale + your own certificate. Three steps remain, once each:"
echo
echo "  1) Install Tailscale (https://tailscale.com) on your iPhone too, signed"
echo "     in to the same tailnet as this Mac."
echo
echo "  2) Install the certificate on your iPhone. A Finder window just opened"
echo "     with the file (diy-mac-remote-ca.pem) and the exact steps"
echo "     (HOWTO-AIRDROP-CERT-TO-PHONE.html) — AirDrop, install, enable trust."
echo "     Both switches: installing a profile and trusting it are separate."
echo
echo "  3) Pair the phone. Double-click start.command in that folder; it starts"
echo "     the server in Tailscale mode over HTTPS and prints a QR code. Scan it"
echo "     in Safari, then add the page to your Home Screen — that saved app is"
echo "     the pairing, and the QR is shown this one time only."
echo
echo "From then on, start it by double-clicking DIY Remote Server.app in that"
echo "same folder: no Terminal window, and the Accessibility permission belongs"
echo "to the app rather than to your Terminal. Pairing is the one step it will"
echo "not do — the one-time key must not end up in its log file."
