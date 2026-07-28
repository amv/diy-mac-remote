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
# start.command run doesn't have to wait. Once that is done it builds
# `DIY Remote Server.app` (bundle-app.sh) into the same Desktop folder — the
# app is how you start the server day to day, and it keeps the Accessibility
# permission off your Terminal. It does not start the server — that's the
# Desktop start.command's job, once the certificate is on your phone.
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

# The app bundle is ours to build, not setup-https.sh's: it would build one at
# the end of its own run, but that runs ensure-node.sh — and the copy started
# above is very possibly still unpacking ./node at that moment. So hold it back
# and do it below, once the background setup has finished.
DIY_MAC_REMOTE_SKIP_BUNDLE=1 "${SCRIPT_DIR}/setup-https.sh" "$@"

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

# --- The app -------------------------------------------------------------------
# Now that ./node is settled and the Desktop folder exists (setup-https.sh made
# it, and bundle-app.sh puts the app there when it does), build the app the
# Accessibility permission will belong to. No mode argument: the self-signed
# path serves HTTPS by itself as soon as the certificate exists, so the Desktop
# start.command has none either, and the two should agree.
#
# Not fatal if it fails — the certificate, Node.js and start.command above are
# a working install on their own.
echo
if ! "${SCRIPT_DIR}/bundle-app.sh" --quiet; then
  echo >&2
  echo "⚠️  Could not build DIY Remote Server.app — the rest of the install is" >&2
  echo "   fine. Run ./bundle-app.sh on its own to see why; until then, start" >&2
  echo "   the server with start.command in the Desktop folder." >&2
fi
