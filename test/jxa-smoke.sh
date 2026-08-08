#!/bin/sh
#
# jxa-smoke.sh — check the backend on a Mac, without a phone and without a socket.
#
# `npm test` covers everything that can be checked anywhere: the routing, the
# pairing, the crypto, the module loader, both entrypoints. What it cannot cover
# off a Mac is the last inch — `osascript -l JavaScript` actually loading app/,
# and app/sys-jxa.js actually posting CoreGraphics events. That is what this is
# for, and it is the first thing to run on a Mac after changing anything under
# app/.
#
#   ./test/jxa-smoke.sh          talk to the backend directly, over its own
#                                protocol: does it load, pair, and answer?
#                                (`key: value` lines, blank line ends a message
#                                 — see app/protocol.js)
#   ./test/jxa-smoke.sh --type   type and move the mouse for real (5s to click
#                                into a scratch document first)
#   ./test/jxa-smoke.sh --unicode
#                                find out which way of posting literal text this
#                                Mac's JXA bridge actually accepts — the answer
#                                decides whether the keyboard can type characters
#                                your layout has no key for
#
# The first mode uses a throwaway HOME, so it mints its own pairing and leaves
# your real one alone.

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export DIY_MAC_REMOTE_ROOT="$ROOT"

if ! command -v osascript >/dev/null 2>&1; then
  echo "This needs osascript, which means it needs a Mac." >&2
  exit 1
fi

if [ "${1:-}" = "--type" ]; then
  exec osascript -l JavaScript "$SCRIPT_DIR/type-probe.jxa.js"
fi

if [ "${1:-}" = "--unicode" ]; then
  exec osascript -l JavaScript "$SCRIPT_DIR/unicode-probe.jxa.js"
fi

HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/diymac-smoke.XXXXXX")"
trap 'rm -rf "$HOME_DIR"' EXIT
export HOME="$HOME_DIR"

echo "Backend: osascript -l JavaScript app/host-jxa.js"
echo "HOME:    $HOME_DIR   (throwaway — your own pairing is untouched)"
echo

# Three messages, exactly as an entrypoint would send them: introduce ourselves,
# ask for the banner, then one request. Answers come back on stdout in the same
# order; anything human (the QR, log lines) arrives on stderr.
{
  printf 't: hello\nscheme: http\nport: 8765\nentry: node\narg: http://smoke.local:8765/\n\n'
  printf 't: banner\n\n'
  printf 't: req\nid: 1\nmethod: GET\npath: /nonce\nbody: \n\n'
} | osascript -l JavaScript "$ROOT/app/host-jxa.js" > "$HOME_DIR/messages.out"

echo
echo "--- what came back ---"
cat "$HOME_DIR/messages.out"
echo

# Check it rather than leave it to the eye. Each of these has failed for real at
# some point, and each fails in a way that looks like something else from the
# phone.
fail() { echo "❌ $1"; echo; echo "The whole exchange is above."; exit 1; }

grep -q '^ok: 1' "$HOME_DIR/messages.out" ||
  fail "the backend refused to start — app/ did not load, or it could not mint a pairing."
grep -q '^status: 200' "$HOME_DIR/messages.out" ||
  fail "/nonce did not answer 200 — see the log lines above for what threw."
grep -q '"nonce":"[0-9a-f]\{64\}"' "$HOME_DIR/messages.out" ||
  fail "/nonce answered without a 256-bit nonce — the host's randomness is not working."
grep -q '#' "$HOME_DIR/messages.out" && true   # (the QR goes to stderr, not here)

echo "✅ The backend loads, pairs, and answers. (public/ never appears here —"
echo "   the entrypoints serve it; to check that side, start the server for real.)"
echo
echo "Then check the events themselves:  ./test/jxa-smoke.sh --type"
