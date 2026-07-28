#!/bin/sh
#
# setup-https.sh — set up HTTPS for diy-mac-remote with a self-signed certificate.
#
# The app already encrypts every keystroke, so plain HTTP is safe against a
# passive eavesdropper. HTTPS adds transport trust on top: it stops an *active*
# man-in-the-middle from rewriting the page itself, and makes the page a browser
# "secure context". Everything uses tools you already have (openssl ships with
# macOS) — no accounts, fully offline.
#
# What one run does:
#   1) ./gen-cert.sh                — a tiny private CA plus a server certificate
#      for this Mac's .local name (any extra names/IPs you pass are forwarded).
#      You install the CA on the iPhone once; re-runs keep chaining to it.
#   2) ./ensure-desktop-folder.sh   — refresh the `diy-mac-remote` folder on the
#      Desktop: the CA ready to AirDrop, an HTML how-to, and a double-clickable
#      start.command.
#   3) ./bundle-app.sh              — build `DIY Remote Server.app` into that
#      same folder, so the Accessibility permission the server needs belongs to
#      that app rather than to your Terminal. It is how you start the server
#      day to day, so it is built here rather than left as homework.
#      (A caller that builds the app itself skips this step with
#      DIY_MAC_REMOTE_SKIP_BUNDLE=1 — install-self-signed.sh does, and says why.)
#
# Usage:
#   ./setup-https.sh                  # certificate for this Mac's .local name
#   ./setup-https.sh foo.local 10.0.0.9   # ...plus extra names/IPs (-> gen-cert.sh)
#   ./setup-https.sh --tailscale      # ...plus this Mac's MagicDNS name, looked up
#                                     #    for you (what HTTPS over a tailnet needs)

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

"$SCRIPT_DIR/gen-cert.sh" "$@"

echo
"$SCRIPT_DIR/ensure-desktop-folder.sh"

# --- The app -------------------------------------------------------------------
# After the Desktop folder, never before: bundle-app.sh puts the app wherever
# that folder is, and only knows to if it already exists.
#
# DIY_MAC_REMOTE_SKIP_BUNDLE is for a caller that will build it itself —
# install-self-signed.sh does, because it has an ensure-node.sh running in the
# background while we work here, and bundle-app.sh runs one too. Two of those at
# once would fight over ./node.
#
# A failure here is not fatal: the certificate and the Desktop folder above are
# what this script is for, and start.command works without the app.
if [ "${DIY_MAC_REMOTE_SKIP_BUNDLE:-}" != "1" ]; then
  echo
  if ! "$SCRIPT_DIR/bundle-app.sh" --quiet; then
    echo >&2
    echo "⚠️  Could not build DIY Remote Server.app — everything above is set up" >&2
    echo "   and works. Run ./bundle-app.sh on its own to see why; until then," >&2
    echo "   start the server with start.command in the Desktop folder." >&2
  fi
fi

# Open the folder in Finder on macOS so AirDrop is a right-click away.
command -v open >/dev/null 2>&1 && open "$HOME/Desktop/diy-mac-remote" >/dev/null 2>&1 || true

echo
echo "HTTPS is set up. Two steps remain, once each:"
echo
echo "  1) Install the certificate on your iPhone. A Finder window just opened"
echo "     with the file (diy-mac-remote-ca.pem) and the exact steps"
echo "     (HOWTO-AIRDROP-CERT-TO-PHONE.html) — AirDrop, install, enable trust."
echo
echo "  2) Start the server: double-click start.command in that folder (or run"
echo "     ./start.sh here). It serves HTTPS automatically now that the"
echo "     certificate exists, and prints a QR code to pair your iPhone."
echo
echo "After that, DIY Remote Server.app — in the same folder — is how you start"
echo "it day to day: it runs in the background, and the Accessibility permission"
echo "belongs to it instead of to your Terminal. Pairing is the one step it"
echo "cannot do, because the one-time key must not land in its log file."
