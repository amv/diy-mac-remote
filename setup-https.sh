#!/bin/sh
#
# setup-https.sh — pick how diy-mac-remote is served over HTTPS.
#
# The app already encrypts every keystroke, so plain HTTP is safe against a
# passive eavesdropper. HTTPS adds transport trust on top: it stops an *active*
# man-in-the-middle from rewriting the page itself, and makes the page a browser
# "secure context". There are two ways to get it, with different trade-offs — this
# script just lets you pick one and sets it up. Both use tools you already have.
#
#   1) Self-signed certificate  (works on ANY network — Wi-Fi, hotel, LAN)
#      You create a tiny private CA with openssl and install it on the iPhone
#      once. Full control, offline, no accounts — but that one-time install +
#      trust dance on the phone, and the cert only covers the names you bake in.
#      -> handled by ./gen-cert.sh
#
#   2) Tailscale HTTPS termination  (only over your tailnet)
#      Tailscale gets a REAL, publicly-trusted Let's Encrypt certificate for your
#      machine's MagicDNS name and terminates TLS for you. NOTHING to install or
#      trust on the iPhone, and the cert auto-renews. But it only works while both
#      devices are on the tailnet, and your machine name lands in a public
#      Certificate Transparency log.
#      -> handled below (tailscale serve)
#
# Usage:
#   ./setup-https.sh                 # interactive menu
#   ./setup-https.sh self [names...] # non-interactive: self-signed (args -> gen-cert.sh)
#   ./setup-https.sh tailscale       # non-interactive: Tailscale HTTPS

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-8765}"

choice="${1:-}"
[ "$#" -gt 0 ] && shift   # remaining args (if any) forward to the chosen path

if [ -z "$choice" ]; then
  echo "How would you like to serve diy-mac-remote over HTTPS?"
  echo
  echo "  1) Self-signed certificate — works on any network (Wi-Fi, LAN, hotel)."
  echo "     You install a certificate on your iPhone once. Full offline control."
  echo
  echo "  2) Tailscale HTTPS         — only over your tailnet, but NOTHING to"
  echo "     install on the iPhone (a real, auto-renewing Let's Encrypt cert)."
  echo
  printf "Pick 1 or 2: "
  read -r choice
fi

case "$choice" in
  1|self|self-signed|selfsigned|cert)
    exec "$SCRIPT_DIR/gen-cert.sh" "$@"
    ;;
  2|tailscale|ts)
    : # fall through to the Tailscale path below
    ;;
  *)
    echo "Unrecognised choice: '$choice' (expected 1/self or 2/tailscale)." >&2
    exit 1
    ;;
esac

# ---- Tailscale HTTPS termination --------------------------------------------

# Find the tailscale CLI (PATH, or the standalone macOS app bundle).
TS=""
for b in tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
  if command -v "$b" >/dev/null 2>&1 || [ -x "$b" ]; then TS="$b"; break; fi
done
if [ -z "$TS" ]; then
  echo "❌ Couldn't find the 'tailscale' command." >&2
  echo "   Install Tailscale on this Mac (https://tailscale.com/download) and sign in," >&2
  echo "   or use option 1 (self-signed) instead:  ./setup-https.sh self" >&2
  exit 1
fi

STATUS="$("$TS" status --json 2>/dev/null || true)"
case "$STATUS" in
  *'"BackendState": "Running"'*|*'"BackendState":"Running"'*) : ;;
  *)
    echo "❌ Tailscale isn't running / signed in on this Mac." >&2
    echo "   Start it and sign in, then re-run this script." >&2
    exit 1
    ;;
esac

# Self.DNSName is the MagicDNS FQDN (e.g. mymac.tailnnnn.ts.net). The first
# DNSName in the JSON is Self's; strip the trailing dot.
NAME="$(printf '%s' "$STATUS" \
  | grep -m1 '"DNSName"' | sed 's/.*"DNSName": *"//; s/".*//; s/\.$//')"
if [ -z "$NAME" ]; then
  echo "❌ No MagicDNS name for this machine yet." >&2
  echo "   Enable MagicDNS AND HTTPS Certificates in the Tailscale admin console:" >&2
  echo "     https://login.tailscale.com/admin/dns" >&2
  echo "   then re-run this script." >&2
  exit 1
fi

echo "Setting up Tailscale to terminate HTTPS for http://127.0.0.1:${PORT} ..."
# --bg keeps it configured across reboots; Tailscale provisions + renews the cert.
if ! "$TS" serve --bg --https=443 "http://127.0.0.1:${PORT}"; then
  echo >&2
  echo "❌ 'tailscale serve' failed. The usual causes:" >&2
  echo "   • HTTPS Certificates not enabled for your tailnet — turn it on at" >&2
  echo "     https://login.tailscale.com/admin/dns (this publishes the machine" >&2
  echo "     name to a public Certificate Transparency log)." >&2
  echo "   • Needs elevated rights — try:  sudo $TS serve --bg --https=443 http://127.0.0.1:${PORT}" >&2
  echo "   Or use option 1 (self-signed) instead:  ./setup-https.sh self" >&2
  exit 1
fi

URL="https://${NAME}/"
echo
echo "✅ Tailscale is now terminating HTTPS in front of port ${PORT}."
echo "   Your iPhone opens this — nothing to install, a real trusted certificate:"
echo "     ${URL}"
echo
echo "Now start the server, bound to loopback so the ONLY way in is via Tailscale's"
echo "HTTPS (any device on the tailnet still can't reach the plain-HTTP port):"
echo
echo "     HOST=127.0.0.1 PORT=${PORT} ./start.sh \"${URL}\""
echo
echo "The QR it prints will point at the HTTPS address above. To stop exposing it:"
echo "     ${TS} serve reset"
