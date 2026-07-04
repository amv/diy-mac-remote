#!/bin/sh
#
# reset.sh — reset diy-mac-remote credentials. Two kinds:
#
#   ./reset.sh app-secrets    forget the pairing (the app secret + auth-token
#                             hash). The next server start mints a fresh
#                             pairing key and prints a new QR; EVERY paired
#                             device must re-pair.
#   ./reset.sh certificate    throw away the local CA + server certificate and
#                             mint fresh ones (via setup-https.sh, which also
#                             refreshes the Desktop folder). The iPhone must
#                             then install + trust the new CA once. Any extra
#                             arguments are forwarded as extra certificate
#                             names/IPs, like setup-https.sh takes.
#
# Both ask for confirmation before touching anything, and both only take
# effect when the server is next started — a running server keeps its loaded
# credentials until then.
#
# The reset-*.command files that ensure-desktop-folder.sh puts in the Desktop
# diy-mac-remote folder are thin double-clickable entries into this script.

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIR="${DIY_MAC_REMOTE_DIR:-$HOME/.diy-mac-remote}"

WHAT="${1:-}"
[ "$#" -gt 0 ] && shift   # remaining args (certificate only) -> setup-https.sh

confirm() {
  printf '%s [y/N] ' "$1"
  read -r answer || answer=""
  case "$answer" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}

restart_note() {
  echo
  echo "If the server is running, the reset takes effect only after a restart:"
  echo "shut it down (Ctrl-C in its Terminal window, or close that window) and"
  echo "start it again (start.command, or ./start.sh)."
}

case "$WHAT" in
  app-secrets)
    if [ ! -f "$DIR/secret" ] && [ ! -f "$DIR/token.hash" ]; then
      echo "No pairing found in $DIR — nothing to reset."
      echo "The server mints one the next time it starts."
      exit 0
    fi
    echo "This forgets the current pairing: the app secret and the auth-token"
    echo "hash in $DIR."
    echo "EVERY paired device loses access, and re-pairs by scanning the fresh"
    echo "QR the server prints on its next start."
    echo
    if ! confirm "Reset the app secrets?"; then
      echo "Not resetting — nothing was changed."
      exit 1
    fi
    rm -f "$DIR/secret" "$DIR/token.hash"
    echo
    echo "App secrets reset. The next server start mints a new pairing key and"
    echo "prints the QR to re-pair your devices."
    restart_note
    ;;

  certificate)
    if [ ! -f "$DIR/ca-key.pem" ] && [ ! -f "$DIR/ca-cert.pem" ]; then
      echo "No certificate authority found in $DIR — nothing to reset." >&2
      echo "To set up HTTPS in the first place, run:  ./install-self-signed.sh" >&2
      exit 1
    fi
    echo "This throws away the local certificate authority and the server"
    echo "certificate in $DIR, then mints fresh ones."
    echo "Your iPhone will NOT trust the server again until you install and"
    echo "trust the new CA on it once — the Desktop folder is refreshed with"
    echo "the new file and the instructions."
    echo
    if ! confirm "Reset the certificate?"; then
      echo "Not resetting — nothing was changed."
      exit 1
    fi
    rm -f "$DIR/ca-key.pem" "$DIR/ca-cert.pem" "$DIR/ca-cert.srl" \
          "$DIR/cert.pem" "$DIR/key.pem"
    echo
    "$SCRIPT_DIR/setup-https.sh" "$@"
    restart_note
    ;;

  *)
    echo "Usage: $0 app-secrets | certificate [extra cert names/IPs...]" >&2
    exit 1
    ;;
esac
