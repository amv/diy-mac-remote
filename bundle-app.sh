#!/bin/sh
#
# bundle-app.sh — wrap the server in a `DIY Remote Server.app` bundle, so the
# Accessibility permission it needs belongs to *that app* instead of to your
# Terminal.
#
# Why you might want this
# -----------------------
# The server types and clicks for you through macOS's Accessibility API, which
# is permission-gated. Run it with `./start.sh`, and the process asking for the
# permission is your Terminal — so the switch you flip in System Settings says
# "Terminal", and from then on *anything* you run from a terminal inherits that
# right. A bundled app has its own entry, so the permission covers this server
# and nothing else. (See README > Accessibility permissions for the server.)
#
# What one run does
# -----------------
#   1) ./ensure-node.sh — so the app never has to download Node.js with no
#      terminal to show it happening.
#   2) Builds the bundle in a temp folder:
#
#        DIY Remote Server.app/
#          Contents/
#            Info.plist                     <- the bundle's identity (name, id,
#                                              background-agent flag)
#            MacOS/diy-remote-server        <- a small shell script that runs
#                                              start.sh in THIS repo
#            Resources/AppIcon.icns         <- built from public/icon-512.png
#            PkgInfo
#
#   3) Ad-hoc code-signs it (`codesign -s -`) if codesign is available, so the
#      permission you grant sticks to a stable identity.
#   4) Moves it to the `diy-mac-remote` folder on your Desktop if that folder
#      exists (the one the installers create), else to /Applications.
#
# Usage:
#   ./bundle-app.sh                  # default server mode
#   ./bundle-app.sh tailscale        # bake in a mode: args go to start.sh
#   ./bundle-app.sh --dest ~/Apps    # put the bundle somewhere specific
#
# Re-running is safe: it replaces the bundle it made last time.

set -eu

APP_NAME="DIY Remote Server"
EXEC_NAME="diy-remote-server"          # no spaces: this is the process name you
                                       # will see in Activity Monitor
BUNDLE_ID="local.diy-mac-remote.server"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Arguments ----------------------------------------------------------------
DEST=""
START_ARGS=""     # shell-quoted, for pasting into the launcher
ARGS_SHOWN=""     # the same thing, plain, for printing back to you

# Single-quote a string so it can be pasted into the generated launcher and
# survive re-parsing by the shell, spaces and all.
shquote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dest)
      [ "$#" -ge 2 ] || { echo "--dest needs a directory" >&2; exit 1; }
      shift; DEST="$1" ;;
    -h|--help)
      echo "Usage: ./bundle-app.sh [--dest DIR] [server.js arguments...]"
      exit 0 ;;
    *)
      # Everything else — modes (wifi, tailscale, a URL) and server.js flags
      # (--tls, --no-tls) alike — is baked into the app's start.sh call.
      START_ARGS="$START_ARGS $(shquote "$1")"
      ARGS_SHOWN="$ARGS_SHOWN $1" ;;
  esac
  shift
done

START_SH="$SCRIPT_DIR/start.sh"
ICON_SRC="$SCRIPT_DIR/public/icon-512.png"

if [ ! -x "$START_SH" ]; then
  echo "ERROR: expected start.sh next to this script — run this from the repo." >&2
  exit 1
fi

# --- Where does it go? --------------------------------------------------------
# The installers (setup-https.sh / install-tailscale.sh) create a
# `diy-mac-remote` folder on the Desktop and put the double-clickable entries
# there. If it exists, the app belongs with them; otherwise this is a
# standalone setup, so the app goes where apps go.
DESKTOP="${DIY_MAC_REMOTE_DESKTOP:-$HOME/Desktop}"
DESKTOP_DIR="$DESKTOP/diy-mac-remote"

if [ -n "$DEST" ]; then
  WHERE="the folder you asked for"
  mkdir -p "$DEST"
elif [ -d "$DESKTOP_DIR" ]; then
  DEST="$DESKTOP_DIR"
  WHERE="the diy-mac-remote folder on your Desktop"
elif [ -d /Applications ] && [ -w /Applications ]; then
  DEST="/Applications"
  WHERE="your Applications folder"
else
  # /Applications needs an admin; every account can write its own ~/Applications.
  DEST="$HOME/Applications"
  WHERE="your personal Applications folder"
  mkdir -p "$DEST"
fi

APP="$DEST/$APP_NAME.app"

# --- Node.js, now rather than later -------------------------------------------
# start.sh would do this itself, but a bundled app has no terminal to print a
# download to — so get it over with here, where you can watch it.
"$SCRIPT_DIR/ensure-node.sh"

# --- Build the bundle in a temp folder ----------------------------------------
# Build it complete, then move it into place, so a half-written bundle is never
# left behind in a folder you launch things from.
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/diy-mac-remote-app.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT INT TERM

CONTENTS="$STAGE/$APP_NAME.app/Contents"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"

# Info.plist — what LaunchServices (and the Accessibility list) reads to know
# what this app is called and how to identify it.
#
# LSUIElement makes it a background agent: no Dock icon, no menu bar, no
# bouncing icon for an app that has no windows to show. It runs until you stop
# it (see the closing notes this script prints).
cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>$APP_NAME</string>
	<key>CFBundleDisplayName</key>
	<string>$APP_NAME</string>
	<key>CFBundleIdentifier</key>
	<string>$BUNDLE_ID</string>
	<key>CFBundleExecutable</key>
	<string>$EXEC_NAME</string>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>LSMinimumSystemVersion</key>
	<string>10.13</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSHumanReadableCopyright</key>
	<string>diy-mac-remote — MIT licensed, built on your own Mac</string>
</dict>
</plist>
PLIST

printf 'APPL????' > "$CONTENTS/PkgInfo"

# The launcher. It is deliberately a readable shell script — the whole point of
# this project is that you can see what you are trusting, and a bundle should
# not change that. It runs start.sh *in this repo*; the app is a wrapper, not a
# copy, so updating the repo updates the app.
cat > "$CONTENTS/MacOS/$EXEC_NAME" <<LAUNCHER
#!/bin/sh
#
# DIY Remote Server — generated by bundle-app.sh. Edit the repo, not this file:
# re-running ./bundle-app.sh overwrites it.
#
# Everything this app does happens in the repo below. Launching the app rather
# than typing ./start.sh is what makes macOS attribute the Accessibility
# permission to this bundle instead of to your Terminal.

set -eu

REPO=$(shquote "$SCRIPT_DIR")

DIR="\${DIY_MAC_REMOTE_DIR:-\$HOME/.diy-mac-remote}"
LOG="\$DIR/server.log"

# A bundled app has no terminal to print to, so anything you must actually read
# goes into a dialog box.
#
# Three details make that dialog actually get seen:
#   - "tell me to activate" puts it in front of whatever you were doing. This is
#     a background agent with no Dock icon to bounce, so a dialog left behind
#     another window is a dialog you never see.
#   - it is wrapped in "try", so a refused activation can never swallow the
#     message itself — the dialog is what matters.
#   - "giving up after" dismisses it if nobody is at the Mac, instead of leaving
#     the app alive forever waiting on a click.
#
# The dialog belongs to osascript itself — no "tell application" to anything
# else — so it needs no Automation permission and asks you for nothing. (Every
# message below is a fixed string written here, so there are no quotes to escape.)
say() {
  /usr/bin/osascript \\
    -e 'try' -e 'tell me to activate' -e 'end try' \\
    -e "display dialog \"\$1\" with title \"$APP_NAME\" buttons {\"OK\"} default button 1 with icon caution giving up after 300" \\
    >/dev/null 2>&1 || true
}

if [ ! -x "\$REPO/start.sh" ]; then
  say "The diy-mac-remote folder this app points at is gone. Re-run bundle-app.sh from wherever the repo lives now."
  exit 1
fi

# Refuse to run an unpaired server. First run (and every reset) prints a
# one-time pairing QR, and this app would send it to the log file — while the
# whole point of the pairing key is that it is never written to disk. So pair
# from Terminal, where the QR is shown and then forgotten.
#
# This is the one refusal you can do something about right away, so its dialog
# offers to open a Terminal in the repo for you. "open -a Terminal" is plain
# LaunchServices — it asks for no permission and controls nothing.
if [ ! -f "\$DIR/secret" ] || [ ! -f "\$DIR/token.hash" ]; then
  ANSWER=\$(/usr/bin/osascript \\
    -e 'try' -e 'tell me to activate' -e 'end try' \\
    -e "display dialog \"Not paired yet, so this app will not start.\n\nRun ./start.sh in Terminal once and scan the QR code with your iPhone, then launch this app again.\n\nWhy from Terminal: pairing prints a one-time key, and this app would write it to its log file — the one place that key must never end up.\" with title \"$APP_NAME\" buttons {\"Open Terminal\", \"OK\"} default button \"Open Terminal\" with icon caution giving up after 300" \\
    2>/dev/null) || ANSWER=""
  case "\$ANSWER" in
    *"Open Terminal"*) /usr/bin/open -a Terminal "\$REPO" >/dev/null 2>&1 || true ;;
  esac
  exit 1
fi

# Owner-only, and inside the directory the server already keeps out of Time
# Machine. A restart cannot reprint the pairing key, so this log holds no
# secrets — the check above is what keeps it that way.
umask 077
exec >>"\$LOG" 2>&1
echo "=== \$(date) — started by $APP_NAME ==="

"\$REPO/start.sh"$START_ARGS &
SERVER_PID=\$!
echo "\$SERVER_PID" > "\$DIR/server.pid"

# Ctrl-C has nowhere to come from here, but a "Quit" from Activity Monitor
# arrives as a TERM — pass it on so the server goes down with the app.
trap 'kill \$SERVER_PID 2>/dev/null || true' TERM INT

wait "\$SERVER_PID" || STATUS=\$?
STATUS=\${STATUS:-0}
rm -f "\$DIR/server.pid"

# 143/130 are TERM/INT: you stopped it, that is not a failure. Anything else
# means it fell over — most often the port is already in use because the server
# is running in a Terminal window somewhere.
case "\$STATUS" in
  0|143|130) ;;
  *) say "The server stopped unexpectedly (exit \$STATUS). The last lines of ~/.diy-mac-remote/server.log say why — the usual cause is another copy already running." ;;
esac
exit "\$STATUS"
LAUNCHER
chmod 755 "$CONTENTS/MacOS/$EXEC_NAME"

# --- Icon (best effort) -------------------------------------------------------
# sips and iconutil ship with macOS; on anything else this quietly does nothing
# and the app gets the generic icon.
if [ -f "$ICON_SRC" ] && command -v sips >/dev/null 2>&1 \
   && command -v iconutil >/dev/null 2>&1; then
  ICONSET="$STAGE/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z $size $size "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}.png" \
      >/dev/null 2>&1 || true
    double=$((size * 2))
    sips -z $double $double "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}@2x.png" \
      >/dev/null 2>&1 || true
  done
  iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/AppIcon.icns" 2>/dev/null || true
fi
[ -f "$CONTENTS/Resources/AppIcon.icns" ] && HAS_ICON=true || HAS_ICON=false

# --- Sign it (best effort) ----------------------------------------------------
# An ad-hoc signature (`-s -`) involves no certificate, no account, no Apple:
# it just hashes the bundle's own contents. macOS uses it to recognise the app
# as the same app next time, so the Accessibility permission you grant is not
# forgotten. Unsigned works too — macOS then identifies the app by path, and
# moving it can cost you the permission.
SIGNED="not signed (codesign unavailable)"
if command -v codesign >/dev/null 2>&1; then
  if codesign --force --sign - --identifier "$BUNDLE_ID" \
       "$STAGE/$APP_NAME.app" >/dev/null 2>&1; then
    SIGNED="ad-hoc signed"
  else
    SIGNED="not signed (codesign refused — harmless, see below)"
  fi
fi

# --- Move it into place -------------------------------------------------------
# Only ever replace a bundle this script made: check for our own launcher
# before removing anything.
if [ -e "$APP" ]; then
  if [ -f "$APP/Contents/MacOS/$EXEC_NAME" ]; then
    rm -rf "$APP"
  else
    echo "ERROR: $APP exists and was not made by this script — refusing to" >&2
    echo "replace it. Move it aside, or pass --dest to build elsewhere." >&2
    exit 1
  fi
fi
mv "$STAGE/$APP_NAME.app" "$APP"

# macOS caches app metadata; a fresh bundle at a familiar path is easier for
# LaunchServices to notice if we say so. Harmless if the tool is missing.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$APP" >/dev/null 2>&1 || true

# --- Tell the human what just happened ----------------------------------------
echo
echo "Built $APP_NAME.app and put it in $WHERE:"
echo
echo "    $APP"
echo
echo "  Contents/MacOS/$EXEC_NAME -> runs start.sh in $SCRIPT_DIR${ARGS_SHOWN:+ (mode:$ARGS_SHOWN)}"
echo "  Contents/Info.plist       -> identifies it to macOS as $BUNDLE_ID"
if $HAS_ICON; then echo "  Contents/Resources        -> the app icon"; fi
echo "  the bundle is $SIGNED"
echo
echo "It is a wrapper, not a copy: it runs the code in this repo, so pulling"
echo "updates here updates the app. Re-run ./bundle-app.sh after moving the repo."
echo
echo "To use it:"
echo
echo "  1) Pair first, from Terminal: ./start.sh, then scan the QR with the"
echo "     iPhone. The app refuses to start unpaired, because the one-time"
echo "     pairing key must not land in a log file."
echo
echo "  2) Double-click the app. It runs in the background — no Dock icon, no"
echo "     window — and logs to ~/.diy-mac-remote/server.log."
echo
echo "  3) The first time it types for you, macOS asks for Accessibility."
echo "     Grant it, and check System Settings > Privacy & Security >"
echo "     Accessibility: the switch should say '$APP_NAME'. If your Terminal"
echo "     is switched on there from earlier runs, turn it off — that entry"
echo "     lets anything you run from a terminal drive your Mac."
echo
echo "  4) To stop it: kill \$(cat ~/.diy-mac-remote/server.pid), or quit"
echo "     '$EXEC_NAME' in Activity Monitor."
