#!/bin/sh
#
# stop.sh — stop a running diy-mac-remote server.
#
# Ctrl-C works when you started the server in a Terminal window and that window
# is still in front of you. This is for every other time: started from the app
# bundle, started from start.command in a window you have since lost, or simply
# started so long ago you'd rather not go looking.
#
# How it finds the server
# -----------------------
#   1. ~/.diy-mac-remote/server.pid, which start.sh writes when it starts the
#      server (the app bundle writes the same number).
#   2. Failing that — a stale file, a deleted one — whatever is listening on the
#      port (8765 unless you set PORT).
#
# Either way it checks that the process it found really is this repo's server
# before signalling it, by looking for server.js in the command line. A pid
# file can outlive the process it named, and pids get reused; killing whatever
# inherited the number is not a thing a script should do quietly.
#
# It asks politely first (TERM, the signal Ctrl-C sends), waits, and only
# escalates to KILL if the server ignores it.
#
# The stop.command file in the Desktop diy-mac-remote folder is a thin
# double-clickable entry into this script.
#
# Usage:
#   ./stop.sh              # stop it
#   PORT=8700 ./stop.sh    # ...if the server runs on a non-default port

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIR="${DIY_MAC_REMOTE_DIR:-$HOME/.diy-mac-remote}"
PID_FILE="$DIR/server.pid"
PORT="${PORT:-8765}"

# Where is that process's working directory? lsof can tell us; if it can't, we
# just don't get an answer, and the caller falls back on the stricter test.
proc_cwd() {
  command -v lsof >/dev/null 2>&1 || return 0
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

# Is this pid a running diy-mac-remote server from THIS repo? `ps -o command=`
# prints the whole command line. start.sh starts the server by absolute path,
# which settles it outright. Started by hand as `node server.js` — which the
# README's server modes do — the path is relative and says nothing on its own,
# so we ask where that process is running from instead.
is_our_server() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac        # digits only
  kill -0 "$1" 2>/dev/null || return 1              # still alive?
  cmd="$(ps -o command= -p "$1" 2>/dev/null || true)"
  case "$cmd" in
    *"$SCRIPT_DIR/server.js"*) return 0 ;;
    *server.js*) [ "$(proc_cwd "$1")" = "$SCRIPT_DIR" ] ;;
    *) return 1 ;;
  esac
}

PID=""

# --- 1. The pid file ----------------------------------------------------------
if [ -f "$PID_FILE" ]; then
  FILE_PID="$(tr -d ' \t\n' < "$PID_FILE" 2>/dev/null || true)"
  if is_our_server "$FILE_PID"; then
    PID="$FILE_PID"
  else
    echo "Ignoring $PID_FILE: it names no running server (pid ${FILE_PID:-empty})."
    rm -f "$PID_FILE"
  fi
fi

# --- 2. Whatever holds the port -----------------------------------------------
# lsof ships with macOS. -t prints bare pids, -sTCP:LISTEN skips clients that
# merely have a connection open to the server.
if [ -z "$PID" ] && command -v lsof >/dev/null 2>&1; then
  for candidate in $(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true); do
    if is_our_server "$candidate"; then
      PID="$candidate"
      echo "Found the server on port $PORT (pid $PID)."
      break
    fi
  done
fi

if [ -z "$PID" ]; then
  echo "No diy-mac-remote server is running."
  echo "(Looked for $PID_FILE, then for a listener on port $PORT.)"
  exit 0
fi

# --- Ask, then insist ---------------------------------------------------------
echo "Stopping the diy-mac-remote server (pid $PID)..."
kill "$PID" 2>/dev/null || true

# Give it a few seconds to close its socket and exit on its own.
i=0
while [ "$i" -lt 20 ] && kill -0 "$PID" 2>/dev/null; do
  sleep 0.25
  i=$((i + 1))
done

if kill -0 "$PID" 2>/dev/null; then
  echo "It did not stop on its own — sending KILL."
  kill -9 "$PID" 2>/dev/null || true
  sleep 0.5
fi

rm -f "$PID_FILE"

if kill -0 "$PID" 2>/dev/null; then
  echo "Could not stop pid $PID. Try Activity Monitor." >&2
  exit 1
fi

echo "Stopped."
echo
echo "The pairing is untouched: start it again whenever you like, and the"
echo "iPhone app carries on as before."
