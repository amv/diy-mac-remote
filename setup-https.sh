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
#
# Usage:
#   ./setup-https.sh                  # certificate for this Mac's .local name
#   ./setup-https.sh foo.local 10.0.0.9   # ...plus extra names/IPs (-> gen-cert.sh)

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

"$SCRIPT_DIR/gen-cert.sh" "$@"

echo
"$SCRIPT_DIR/ensure-desktop-folder.sh"

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
