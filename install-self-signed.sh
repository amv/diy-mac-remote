#!/bin/sh
#
# install-self-signed.sh — one-command HTTPS install. Run it from Terminal:
#
#   ./install-self-signed.sh              # certificate for this Mac's .local name
#   ./install-self-signed.sh --tailscale  # ...plus this Mac's MagicDNS name
#
# It runs setup-https.sh, which generates the certificate and refreshes the
# `diy-mac-remote` folder on the Desktop; read the remaining steps it prints.
# Any arguments are forwarded through to gen-cert.sh, so extra names/IPs (and
# --tailscale) can be named here too.
# While the certificate is being generated it also sets up Node.js in the
# background (ensure-node.sh: a no-op if ./node already works, else it links a
# pre-installed Node or downloads a verified build), so the first
# start.command run doesn't have to wait. It does not start the server —
# that's the Desktop start.command's job, once the certificate is on your
# phone.
#
# Why isn't this itself a double-clickable .command file? macOS quarantines
# downloaded files and refuses to run a downloaded .command from Finder. Files
# *created on this Mac* are not quarantined — so you run this script from
# Terminal once, and the start.command it generates on the Desktop is safely
# double-clickable from then on.

set -eu

# Resolve our own location, so the script works from any current directory.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Kick off the Node.js setup in the background, output to a log so it doesn't
# interleave with the certificate setup below; the result is reported once the
# setup is done. ensure-node.sh is idempotent and silent when ./node already
# works, so this is safe (and instant) on re-runs.
NODE_LOG="$(mktemp "${TMPDIR:-/tmp}/diy-mac-remote-ensure-node.XXXXXX")"
"${SCRIPT_DIR}/ensure-node.sh" >"$NODE_LOG" 2>&1 &
NODE_PID=$!

"${SCRIPT_DIR}/setup-https.sh" "$@"

if kill -0 "$NODE_PID" 2>/dev/null; then
  echo
  echo "Waiting for the background Node.js setup to finish..."
fi
if wait "$NODE_PID"; then
  if [ -s "$NODE_LOG" ]; then
    echo
    echo "Node.js is ready in ./node."
  fi
  rm -f "$NODE_LOG"
else
  echo >&2
  echo "⚠️  Setting up Node.js failed:" >&2
  tail -n 5 "$NODE_LOG" >&2
  echo "   (full log: $NODE_LOG)" >&2
  echo "   The HTTPS setup above still succeeded — start.command will retry" >&2
  echo "   the Node.js setup when you run it." >&2
  exit 1
fi
