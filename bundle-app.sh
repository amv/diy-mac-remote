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
# Why there is an "applet" in here
# --------------------------------
# macOS decides who a permission belongs to by walking up from whatever made the
# request to the first process it considers *responsible* — and it refuses that
# role to its own binaries. So a bundle whose executable is a shell script is
# skipped over (/bin/sh is Apple's), and the walk lands on the next thing down:
# Node. The permission then belongs to a general-purpose interpreter, which is
# no permission boundary at all.
#
# The fix is to give the bundle an executable macOS *will* hold responsible: a
# real Mach-O of our own. `osacompile` ships with macOS and produces one — an
# "applet", a copy of Apple's AppleScript stub. Re-signing the bundle makes that
# copy ours rather than Apple's, and the walk stops there, on the app. The
# permission is then the app's, and Node only borrows it while running as the
# app's child. Node started any other way is a stranger to it again.
#
# The applet is the one file here you cannot read, so it is given as little to
# do as possible: one line of AppleScript that runs launcher.sh, which is the
# same readable shell script this bundle always used.
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
#            MacOS/diy-remote-server        <- the applet: the app's identity,
#                                              and all it does is start ↓
#            Resources/Scripts/main.scpt    <- the one line of AppleScript
#            Resources/launcher.sh          <- the real launcher, readable, runs
#                                              start.sh (or start-plain.sh)
#                                              in THIS repo
#            Resources/AppIcon.icns         <- built from public/icon-512.png
#            PkgInfo
#
#      Without `osacompile` (it ships with macOS, so this is unlikely) it falls
#      back to the older shape — launcher.sh *as* the executable — and says so.
#      That still works; the permission just lands on Node again.
#   3) Ad-hoc code-signs it (`codesign -s -`) if codesign is available. This is
#      what makes the applet our code instead of Apple's, so it is load-bearing
#      here, not just a nicety: it is also what keeps the permission you grant
#      attached to a stable identity.
#   4) Moves it to the `diy-mac-remote` folder on your Desktop if that folder
#      exists (the one the installers create), else to /Applications.
#   5) Registers it to start when you log in — see below. Pass --no-at-login to
#      skip that, or to undo it later.
#
# Starting it at login
# --------------------
# A LaunchAgent: one plist written to ~/Library/LaunchAgents. That is a file in
# your own home folder, so it asks macOS for no permission at all — unlike
# adding a Login Item, which goes through System Events and would want an
# Automation permission for a very powerful target just to tick a checkbox.
# It is plain text, and `--no-at-login` deletes it again.
#
# Three things worth knowing about it:
#
#   - It is *login*, not boot. The server types and clicks through the
#     Accessibility API, which only exists inside a logged-in graphical session;
#     a boot-time LaunchDaemon would run as root before login and could not
#     drive anything anyway.
#   - macOS tells you. From Ventura on you get a "Background items added"
#     notice, and the entry shows up in System Settings > General > Login Items
#     under "Allow in the Background", where you can switch it off yourself.
#   - What it runs is the app's own executable, by absolute path. Login Items
#     names a background item after the program launchd was given, taken from
#     that file rather than from any bundle around it: `/bin/sh -c '...'` is
#     listed as "sh", a helper script is listed by its filename, and only the
#     app's signed executable is listed as "$APP_NAME". By path and not by
#     bundle identifier, too — an identifier is answered by whichever copy
#     LaunchServices likes best, and an old build in another folder answers to
#     the same one. Move the app and re-run this script.
#   - launchd starting the app is not LaunchServices starting it, but the
#     difference does not reach what the bundle is for: launchd is never a
#     responsible process, so the applet is responsible for itself and its
#     children just as it is on a double-click, and TCC knows it by the same
#     ad-hoc signature. The Accessibility grant stays the app's.
#
# It does not start anything now, at build time — it arms the next login. To
# start the server today, double-click the app as usual.
#
# Usage:
#   ./bundle-app.sh                  # default server mode
#   ./bundle-app.sh tailscale        # bake in a mode: args go to start.sh
#   ./bundle-app.sh --plain          # the Node-free path (start-plain.sh)
#   ./bundle-app.sh --dest ~/Apps    # put the bundle somewhere specific
#   ./bundle-app.sh --no-at-login    # don't start at login (removes it if set)
#   ./bundle-app.sh --quiet          # say where it went, skip the walkthrough
#
# Re-running is safe: it replaces the bundle it made last time.
#
# The installers (install-self-signed.sh, install-tailscale.sh,
# install-tailscale-self-signed.sh and setup-https.sh) all end by running this
# script with --quiet, so the app exists from the first install and their own
# closing steps stay the one set of instructions on screen.

set -eu

APP_NAME="DIY Remote Server"
EXEC_NAME="diy-remote-server"          # no spaces: this is the process name you
                                       # will see in Activity Monitor
BUNDLE_ID="local.diy-mac-remote.server"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Arguments ----------------------------------------------------------------
DEST=""
QUIET=false       # --quiet: where it went and what it runs, and nothing else
AT_LOGIN=true     # --no-at-login: skip the LaunchAgent (and remove any we made)
PLAIN=false       # --plain: launch through start-plain.sh (no Node.js at all)
START_ARGS=""     # shell-quoted, for pasting into the launcher
ARGS_SHOWN=""     # the same thing, plain, for printing back to you

# Single-quote a string so it can be pasted into the generated launcher and
# survive re-parsing by the shell, spaces and all.
shquote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# The three characters a plist's XML cannot carry literally. Everything we put
# in one is written here, but the app's path is not: it comes from --dest, or
# from your home folder's name, and either can hold an ampersand.
xmlesc() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dest)
      [ "$#" -ge 2 ] || { echo "--dest needs a directory" >&2; exit 1; }
      shift; DEST="$1" ;;
    --quiet)
      # For the installers: they print their own steps, and two walkthroughs in
      # one run of one script is one too many.
      QUIET=true ;;
    --at-login)
      # The default already. Here so that "how do I turn it back on" has an
      # answer that is not "read the script".
      AT_LOGIN=true ;;
    --no-at-login)
      AT_LOGIN=false ;;
    --plain)
      # Build an app for the Node-free path: the launcher runs start-plain.sh
      # (perl + osascript) instead of start.sh (node). Plain HTTP only — see
      # README > "Run it without Node.js".
      PLAIN=true ;;
    -h|--help)
      echo "Usage: ./bundle-app.sh [--dest DIR] [--no-at-login] [--quiet] [--plain] [server arguments...]"
      exit 0 ;;
    *)
      # Everything else — modes (wifi, tailscale, a URL) and server.js flags
      # (--tls, --no-tls) alike — is baked into the app's start.sh call.
      START_ARGS="$START_ARGS $(shquote "$1")"
      ARGS_SHOWN="$ARGS_SHOWN $1" ;;
  esac
  shift
done

# Which launcher the app will run. Everything below refers to it by name only,
# so the two paths differ in exactly one place.
if $PLAIN; then START_NAME="start-plain.sh"; else START_NAME="start.sh"; fi
START_SH="$SCRIPT_DIR/$START_NAME"
ICON_SRC="$SCRIPT_DIR/public/icon-512.png"

if [ ! -x "$START_SH" ]; then
  echo "ERROR: expected $START_NAME next to this script — run this from the repo." >&2
  exit 1
fi

# --- Will the app be allowed to read this repo? -------------------------------
# macOS gates Desktop, Documents and Downloads per app. This app gets an
# identity of its own — that is the whole point of bundling it — so it starts
# out with none of the permissions your Terminal has collected, and a repo in
# one of those three folders means it is refused at launch until you say
# otherwise. Say so now, while there is a terminal to read it. (The launcher
# says the same thing in a dialog if you hit it anyway.)
PROTECTED_IN=""
case "$SCRIPT_DIR/" in
  "$HOME/Desktop/"*)   PROTECTED_IN="Desktop" ;;
  "$HOME/Documents/"*) PROTECTED_IN="Documents" ;;
  "$HOME/Downloads/"*) PROTECTED_IN="Downloads" ;;
esac

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
# download to — so get it over with here, where you can watch it. The Node-free
# path has nothing to fetch: perl and osascript are already on the Mac.
if ! $PLAIN; then
  "$SCRIPT_DIR/ensure-node.sh"
fi

# --- Build the bundle in a temp folder ----------------------------------------
# Build it complete, then move it into place, so a half-written bundle is never
# left behind in a folder you launch things from.
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/diy-mac-remote-app.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT INT TERM

CONTENTS="$STAGE/$APP_NAME.app/Contents"

# --- The executable: an applet if we can, a shell script if we cannot ---------
# See "Why there is an applet in here" at the top. `osacompile` turns the
# AppleScript below into an .app whose executable is a real Mach-O — the thing
# macOS is willing to hold responsible for what it launches. The AppleScript is
# kept to the smallest possible job: find launcher.sh inside this same bundle
# and run it. Everything you would actually want to read stays in that shell
# script.
BUNDLE_KIND="script"
if command -v osacompile >/dev/null 2>&1; then
  # Quoted heredoc: this is AppleScript, and nothing in it is for the shell to
  # expand. Tabs, because that is how AppleScript indents itself.
  cat > "$STAGE/main.applescript" <<'APPLESCRIPT'
on run
	-- Start launcher.sh, which sits in this same bundle, and then stay alive as
	-- its parent for as long as the server runs. Staying is the point: macOS
	-- pins the Accessibility permission to this app only while this process is
	-- here to be pinned to.
	set appPath to POSIX path of (path to me)
	set launcherPath to appPath & "Contents/Resources/launcher.sh"
	try
		-- A year. Left alone, do shell script gives up after two minutes and
		-- takes the server down with it.
		with timeout of 31536000 seconds
			do shell script quoted form of launcherPath
		end timeout
	end try
	-- No error handler on purpose: launcher.sh reports its own refusals in
	-- dialogs you can act on, and a raw AppleScript error on top of one of
	-- those would be noise.
end run
APPLESCRIPT

  if osacompile -o "$STAGE/$APP_NAME.app" "$STAGE/main.applescript" >/dev/null 2>&1 \
     && [ -f "$CONTENTS/MacOS/applet" ]; then
    # Give it the name you will see in Activity Monitor. The applet finds its
    # script through the bundle, not through its own filename.
    mv "$CONTENTS/MacOS/applet" "$CONTENTS/MacOS/$EXEC_NAME"
    rm -f "$CONTENTS/Resources/applet.icns"   # ours goes in as AppIcon.icns
    # description.rtfd is the text of the applet's "startup screen" — the
    # here-is-what-this-does window with a Run button. This app is a background
    # agent that you double-click to start a server; a window asking whether you
    # meant it is not what you asked for.
    rm -rf "$CONTENTS/Resources/description.rtfd"
    BUNDLE_KIND="applet"
  else
    rm -rf "$STAGE/$APP_NAME.app"
  fi
fi

# Say so either way — a quieter permission boundary is not something to find out
# about later. (osacompile ships with macOS, so this should not happen there.)
if [ "$BUNDLE_KIND" != "applet" ]; then
  echo "NOTE: no applet (osacompile is missing or refused), so this bundle gets" >&2
  echo "      the older shape: launcher.sh as the executable. It works, but the" >&2
  echo "      Accessibility permission lands on Node rather than on the app." >&2
fi

mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"

# Where the launcher goes depends on which shape we ended up with: a resource
# the applet runs, or the executable itself.
if [ "$BUNDLE_KIND" = "applet" ]; then
  LAUNCHER_DEST="$CONTENTS/Resources/launcher.sh"
else
  LAUNCHER_DEST="$CONTENTS/MacOS/$EXEC_NAME"
fi

# Info.plist — what LaunchServices (and the Accessibility list) reads to know
# what this app is called and how to identify it.
#
# LSUIElement makes it a background agent: no Dock icon, no menu bar, no
# bouncing icon for an app that has no windows to show. It runs until you stop
# it (see the closing notes this script prints).
#
# LSRequiresNativeExecution / LSArchitecturePriority keep it off Rosetta, and
# they are worth keeping even now that the executable is usually a real binary:
# they also take away Finder's "Open using Rosetta" checkbox in Get Info, which
# is sticky once ticked, and they still matter in the shell-script fallback,
# where there is no compiled binary for macOS to read an architecture out of at
# all. Launched translated, Node and everything the server does is translated
# with it.
#
# In applet mode this is NOT what ends up in the bundle: osacompile writes its
# own Info.plist, its stub reads things from it that are none of our business
# (replacing it wholesale is what produced a "Press Run to run this script"
# window), and so we patch that one instead — see below. This copy is for the
# shell-script fallback, which has no plist of its own.
write_our_plist() {
cat > "$1" <<PLIST
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
	<key>CFBundleSignature</key>
	<string>aplt</string>
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
	<key>LSRequiresNativeExecution</key>
	<true/>
	<key>LSArchitecturePriority</key>
	<array>
		<string>arm64</string>
		<string>x86_64</string>
	</array>
	<key>NSDesktopFolderUsageDescription</key>
	<string>$APP_NAME runs the diy-mac-remote server from the folder you built it from. It needs this only because that folder is on your Desktop — move the folder elsewhere and it never asks.</string>
	<key>NSDocumentsFolderUsageDescription</key>
	<string>$APP_NAME runs the diy-mac-remote server from the folder you built it from. It needs this only because that folder is in Documents — move the folder elsewhere and it never asks.</string>
	<key>NSDownloadsFolderUsageDescription</key>
	<string>$APP_NAME runs the diy-mac-remote server from the folder you built it from. It needs this only because that folder is in Downloads — move the folder elsewhere and it never asks.</string>
	<key>NSHumanReadableCopyright</key>
	<string>diy-mac-remote — MIT licensed, built on your own Mac</string>
</dict>
</plist>
PLIST
}

# --- Give the bundle its identity ---------------------------------------------
# Applet mode: keep the plist osacompile wrote — its stub reads keys from it
# that we have no business guessing at — and set only what is ours on top.
# PlistBuddy ships with macOS and edits a plist in place, one key at a time:
# `Set` an existing key, `Add` it if there is none yet.
PB=/usr/libexec/PlistBuddy

plist_set() {   # key, type, value
  "$PB" -c "Set :$1 $3" "$CONTENTS/Info.plist" >/dev/null 2>&1 ||
  "$PB" -c "Add :$1 $2 $3" "$CONTENTS/Info.plist" >/dev/null 2>&1 || true
}

if [ "$BUNDLE_KIND" = "applet" ] && [ -x "$PB" ]; then
  plist_set CFBundleName        string "$APP_NAME"
  plist_set CFBundleDisplayName string "$APP_NAME"
  plist_set CFBundleIdentifier  string "$BUNDLE_ID"
  plist_set CFBundleExecutable  string "$EXEC_NAME"   # we renamed the applet
  plist_set CFBundleIconFile    string AppIcon
  plist_set LSUIElement              bool true
  plist_set LSRequiresNativeExecution bool true
  plist_set NSHumanReadableCopyright string "diy-mac-remote — MIT licensed, built on your own Mac"
  plist_set NSDesktopFolderUsageDescription   string "$APP_NAME runs the diy-mac-remote server from the folder you built it from. It needs this only because that folder is on your Desktop — move the folder elsewhere and it never asks."
  plist_set NSDocumentsFolderUsageDescription string "$APP_NAME runs the diy-mac-remote server from the folder you built it from. It needs this only because that folder is in Documents — move the folder elsewhere and it never asks."
  plist_set NSDownloadsFolderUsageDescription string "$APP_NAME runs the diy-mac-remote server from the folder you built it from. It needs this only because that folder is in Downloads — move the folder elsewhere and it never asks."

  # osacompile's plist also carries CFBundleIconName, which points into an asset
  # catalog rather than at a file — and macOS reads it *before* CFBundleIconFile.
  # Leave it and you get Apple's scroll no matter what we put in Resources.
  # Removing it is what lets CFBundleIconFile above be the answer.
  "$PB" -c "Delete :CFBundleIconName" "$CONTENTS/Info.plist" >/dev/null 2>&1 || true

  # An array has to be rebuilt rather than set.
  "$PB" -c "Delete :LSArchitecturePriority" "$CONTENTS/Info.plist" >/dev/null 2>&1 || true
  "$PB" -c "Add :LSArchitecturePriority array" "$CONTENTS/Info.plist" >/dev/null 2>&1 || true
  "$PB" -c "Add :LSArchitecturePriority: string arm64" "$CONTENTS/Info.plist" >/dev/null 2>&1 || true
  "$PB" -c "Add :LSArchitecturePriority: string x86_64" "$CONTENTS/Info.plist" >/dev/null 2>&1 || true
else
  # The fallback shape, or an applet on a Mac with no PlistBuddy: our own plist,
  # written whole.
  write_our_plist "$CONTENTS/Info.plist"
fi

printf 'APPL????' > "$CONTENTS/PkgInfo"

# The launcher. It is deliberately a readable shell script — the whole point of
# this project is that you can see what you are trusting, and a bundle should
# not change that. It runs start.sh *in this repo*; the app is a wrapper, not a
# copy, so updating the repo updates the app.
cat > "$LAUNCHER_DEST" <<LAUNCHER
#!/bin/sh
#
# DIY Remote Server — generated by bundle-app.sh. Edit the repo, not this file:
# re-running ./bundle-app.sh overwrites it.
#
# Everything this app does happens in the repo below, and everything the app
# itself does is here: the applet that started this script exists only to be an
# identity macOS will hold responsible, so that the Accessibility permission
# belongs to this bundle rather than to your Terminal or to Node.

set -eu

# --- Never run translated -----------------------------------------------------
# Info.plist asks macOS to launch this app natively; this is the belt to that
# pair of braces, and it also rescues a copy someone ticked "Open using Rosetta"
# on in Finder's Get Info. The sysctl.proc_translated flag is 1 only when this
# very process is being translated -- it does not exist on Intel Macs or off
# macOS, so a failed read means "not translated" -- and arch -arm64 starts us
# again on the real CPU. The environment variable keeps a re-exec that did not
# take from turning into a loop.
if [ "\${DIY_MAC_REMOTE_NATIVE:-}" != "1" ] \\
   && [ "\$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ] \\
   && [ -x /usr/bin/arch ]; then
  export DIY_MAC_REMOTE_NATIVE=1
  exec /usr/bin/arch -arm64 "\$0" "\$@"
fi

REPO=$(shquote "$SCRIPT_DIR")

DIR="\${DIY_MAC_REMOTE_DIR:-\$HOME/.diy-mac-remote}"
LOG="\$DIR/server.log"

# This script sits either in Contents/Resources (with the applet) or in
# Contents/MacOS (without it) — two levels up is the bundle either way.
APP_BUNDLE="\$(cd "\$(dirname "\$0")/../.." && pwd)"
MENU_JS="\$APP_BUNDLE/Contents/Resources/menubar.js"

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

# A path is the one thing in these messages that we did not write, so quote it
# for AppleScript on the way in: a " or a \\ in a folder name would otherwise end
# the string early and take the rest of the sentence with it.
REPO_SHOWN=\$(printf '%s' "\$REPO" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g')

# Two different faults land here, and from inside this script they look alike:
# the folder really is gone, or it is there and macOS will not let this app so
# much as look at it. The check below tells those apart when it can -- but at
# login there may be nobody to answer a permission prompt, and a refusal can
# arrive as "there is nothing here" instead. So say the path, and name both.
if [ ! -x "\$REPO/$START_NAME" ]; then
  say "This app cannot see the folder it runs from:\n\n    \$REPO_SHOWN\n\nEither that folder has moved, in which case re-run ./bundle-app.sh from wherever it lives now -- or it is still there and macOS is refusing this app access to it, which is what happens when it sits inside Desktop, Documents or Downloads. Moving it to your home folder settles both."
  exit 1
fi

# Can this app actually read the repo, though? macOS keeps apps out of Desktop,
# Documents and Downloads until you allow it, and that is a per-app decision --
# your Terminal being allowed says nothing about this app, which is the whole
# point of giving it an identity of its own. The test above passes even when the
# folder is off limits: looking at a file is allowed, opening it is not, so the
# refusal would otherwise arrive as a bare "Operation not permitted" line in the
# log. Reading one byte is the smallest way to find out for real -- and it is
# also what makes macOS show its own permission prompt, if it means to show one.
if ! head -c 1 "\$REPO/$START_NAME" >/dev/null 2>&1; then
  say "macOS will not let this app read the folder it runs from:\n\n    \$REPO_SHOWN\n\nThat folder is inside Desktop, Documents or Downloads -- folders apps need permission for.\n\nTwo ways to fix it, either is fine:\n\n1) Move the diy-mac-remote folder somewhere else (straight into your home folder is fine) and re-run ./bundle-app.sh there.\n\n2) Add this app to System Settings > Privacy & Security > Full Disk Access.\n\nThe first one asks macOS for nothing, so it is the one to prefer."
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
#
# Except at login, where nobody asked for this app to start and nobody is
# waiting on it: there, an unpaired server is a line in the log, not a dialog at
# every login until you get round to pairing. The LaunchAgent sets
# DIY_MAC_REMOTE_AT_LOGIN to tell us apart; if it does not reach us, the dialog
# below appears instead, which is what this app has always done.
if [ ! -f "\$DIR/secret" ] || [ ! -f "\$DIR/token.hash" ]; then
  if [ "\${DIY_MAC_REMOTE_AT_LOGIN:-}" = "1" ]; then
    if [ -d "\$DIR" ]; then
      (umask 077; echo "=== \$(date) — not paired yet, so nothing was started." >>"\$LOG")
    fi
    exit 0
  fi
  ANSWER=\$(/usr/bin/osascript \\
    -e 'try' -e 'tell me to activate' -e 'end try' \\
    -e "display dialog \"Not paired yet, so this app will not start.\n\nRun ./$START_NAME in Terminal once and scan the QR code with your iPhone, then launch this app again.\n\nWhy from Terminal: pairing prints a one-time key, and this app would write it to its log file — the one place that key must never end up.\" with title \"$APP_NAME\" buttons {\"Open Terminal\", \"OK\"} default button \"Open Terminal\" with icon caution giving up after 300" \\
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

"\$REPO/$START_NAME"$START_ARGS &
SERVER_PID=\$!
echo "\$SERVER_PID" > "\$DIR/server.pid"

# Ctrl-C has nowhere to come from here, but a "Quit" from Activity Monitor
# arrives as a TERM — pass it on so the server goes down with the app.
trap 'kill \$SERVER_PID 2>/dev/null || true' TERM INT

# --- Something to look at, and a way to stop -----------------------------------
# An app with no Dock icon and no window gives you nothing to tell you it worked,
# and nothing to click when you are done. menubar.js -- next to this script, and
# just as readable -- puts a small keyboard in the menu bar with a "Stop server"
# item behind it. It runs as its own process, so the server never waits on it,
# and it is taken down with the server further below.
#
# The menu bar item is the least certain thing in this app: it is Cocoa, reached
# through the AppleScript bridge, and if any of that fails it fails quietly. So
# give it two seconds to prove it survived, and if it did not, put up a plain
# dialog instead. Either way you end up with a way to stop the server that is
# not "go and find a Terminal".
MENU_PID=""
if [ -f "\$MENU_JS" ]; then
  DIY_SERVER_PID="\$SERVER_PID" DIY_APP_NAME="$APP_NAME" \\
    /usr/bin/osascript -l JavaScript "\$MENU_JS" >/dev/null 2>&1 &
  MENU_PID=\$!
  sleep 2
  kill -0 "\$MENU_PID" 2>/dev/null || MENU_PID=""
fi

if [ -z "\$MENU_PID" ]; then
  (
    ANSWER=\$(/usr/bin/osascript \\
      -e 'try' -e 'tell me to activate' -e 'end try' \\
      -e "display dialog \"The diy-mac-remote server is running.\n\nOpen the Mac Remote app on your iPhone and it is ready to use.\n\nStop Server shuts it down. Keep Running just closes this box -- the server stays up, and stop.command in the Desktop diy-mac-remote folder stops it whenever you like.\" with title \"$APP_NAME\" buttons {\"Stop Server\", \"Keep Running\"} default button \"Keep Running\" with icon note" \\
      2>/dev/null) || ANSWER=""
    case "\$ANSWER" in
      *"Stop Server"*) kill "\$SERVER_PID" 2>/dev/null || true ;;
    esac
  ) &
  MENU_PID=\$!
fi

wait "\$SERVER_PID" || STATUS=\$?
STATUS=\${STATUS:-0}
rm -f "\$DIR/server.pid"

# If the server went down some other way -- stop.command, a crash -- the menu bar
# item (or the dialog) is now advertising something that is not there. Take it
# down with the server. The second line is for the dialog case: killing the
# subshell on its own leaves its osascript child still holding the box.
if [ -n "\$MENU_PID" ]; then
  kill "\$MENU_PID" 2>/dev/null || true
  pkill -P "\$MENU_PID" 2>/dev/null || true
fi

# 143/130/137 are TERM/INT/KILL: you stopped it, and stop.sh escalates to KILL
# when the server does not go quietly — none of that is a failure. Anything else
# means it fell over — most often the port is already in use because the server
# is running in a Terminal window somewhere.
case "\$STATUS" in
  0|143|130|137) ;;
  *) say "The server stopped unexpectedly (exit \$STATUS). The last lines of ~/.diy-mac-remote/server.log say why — the usual cause is another copy already running." ;;
esac
exit "\$STATUS"
LAUNCHER
chmod 755 "$LAUNCHER_DEST"

# The menu bar item. A quoted heredoc, because every other line of this is
# JavaScript talking to Cocoa through `$.` and none of it is for the shell.
#
# Why JavaScript and not more shell: a menu bar item is a Cocoa object, and JXA
# (`osascript -l JavaScript`) can build Cocoa objects at run time. Nothing here
# is compiled and nothing is installed — it is the same osascript the trackpad
# already uses, so an app that needs no developer tools still needs none.
cat > "$CONTENTS/Resources/menubar.js" <<'MENUJS'
// menubar.js — the small keyboard in the menu bar while the server is running,
// and the "Stop server" behind it. Generated by bundle-app.sh; edit the repo.
//
// launcher.sh runs this as:  osascript -l JavaScript menubar.js
// with the server's process id in DIY_SERVER_PID. This process owns nothing but
// the menu: the server is already running before it starts, and carries on
// perfectly well if it dies.

ObjC.import('Cocoa');
ObjC.import('stdlib');   // for $.system, which is how we send the kill

var env = $.NSProcessInfo.processInfo.environment;
function fromEnv(name, fallback) {
  var value = env.objectForKey(name);
  return value.isNil() ? fallback : ObjC.unwrap(value);
}

var serverPid = fromEnv('DIY_SERVER_PID', '');
var appName   = fromEnv('DIY_APP_NAME', 'diy-mac-remote');

// A menu item sends its action to an object, and there is no object here to
// send it to — so make a class at run time and use one of those. This is the
// ObjC bridge doing what it is for, not a compiler in disguise.
ObjC.registerSubclass({
  name: 'DIYRemoteMenuTarget',
  methods: {
    'stopServer:': {
      types: ['void', ['id']],
      implementation: function () {
        // Plain TERM, the same signal Ctrl-C sends and the same one
        // stop.command starts with. launcher.sh notices the server exit and
        // tidies up after both of us.
        if (serverPid !== '') $.system('/bin/kill ' + serverPid);
        $.NSApp.terminate(null);
      }
    }
  }
});

var app = $.NSApplication.sharedApplication;
// 1 = NSApplicationActivationPolicyAccessory: menu bar only, no Dock icon, no
// menu bar *menus* of its own. Written as the number because the named constant
// is not reliably bridged.
app.setActivationPolicy(1);

var target = $.DIYRemoteMenuTarget.alloc.init;

// -1 = NSVariableStatusItemLength: as wide as its content needs.
var statusItem = $.NSStatusBar.systemStatusBar.statusItemWithLength(-1);
statusItem.button.title = '⌨';
statusItem.button.toolTip = appName + ' is running';

var menu = $.NSMenu.alloc.init;
// Without this, macOS decides for itself which items are usable and greys out
// the ones whose action it cannot resolve — including ours.
menu.autoenablesItems = false;

var heading = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(
  appName + ' is running', '', '');
heading.enabled = false;
menu.addItem(heading);
menu.addItem($.NSMenuItem.separatorItem);

var stopItem = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(
  'Stop server', 'stopServer:', '');
stopItem.target = target;
stopItem.enabled = true;
menu.addItem(stopItem);

statusItem.menu = menu;

// Blocks here for as long as the item is on screen. launcher.sh kills this
// process when the server stops, which is what takes the item away again.
app.run;
MENUJS

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

# An applet bundle arrives with its icon named applet.icns, and its plist
# pointing at that name. We point the plist at ours instead — but that edit is
# best-effort, and if it did not take, an app whose only icon file we deleted
# falls back to the blank generic one. Putting the same icon under both names
# costs a few KB and removes the failure mode entirely.
if $HAS_ICON && [ "$BUNDLE_KIND" = "applet" ]; then
  cp "$CONTENTS/Resources/AppIcon.icns" "$CONTENTS/Resources/applet.icns" 2>/dev/null || true
fi

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
# LaunchServices to notice if we say so. Best effort, and the `[ -x ]` is meant:
# lsregister is not on PATH — this absolute path is the only way to reach it —
# and nothing here depends on it having worked.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$APP" >/dev/null 2>&1 || true
# The icon cache is keyed on the bundle's modification date as well, and this
# bundle keeps the same path every time. Bump it so a changed icon is noticed.
touch "$APP" 2>/dev/null || true

# --- Start it at login --------------------------------------------------------
# See "Starting it at login" at the top for why this is a LaunchAgent and not a
# Login Item. Everything below is one plist in your own home folder; deleting it
# is the whole of the undo, and --no-at-login does exactly that.
AGENT_LABEL="$BUNDLE_ID"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
AGENT_PLIST="$LAUNCH_AGENTS/$AGENT_LABEL.plist"

# launchd reads this folder afresh at every login, so writing the file is the
# whole of "install" and deleting it is the whole of "remove". No launchctl
# either way, and that is deliberate rather than lazy: the job named here is the
# app itself, so `launchctl bootout` on a session where the server is running
# would take the server down with it — which is not what anyone means by "stop
# starting this at login". The removal takes effect at the next login, and the
# server you have running now is left alone.

AT_LOGIN_STATE="off"

if $AT_LOGIN; then
  mkdir -p "$LAUNCH_AGENTS"

  # The program is the app's own executable — the applet — by absolute path.
  #
  # Why the executable and not a script that opens the app: System Settings >
  # General > Login Items names a background item after the program launchd was
  # given, and it takes that name from the file itself rather than from any
  # bundle around it. `/bin/sh -c '...'` is listed as "sh"; a shell script inside
  # the bundle is listed by its filename; AssociatedBundleIdentifiers does not
  # override either, because macOS will not take our word for an association
  # between a file it cannot attribute and an ad-hoc signed app of ours. The
  # app's signed main executable is the one thing it will resolve to the app.
  #
  # This is launchd starting the app rather than LaunchServices, which is a real
  # difference — but not one that touches what the app is *for*: launchd is
  # never a responsible process, so the applet is responsible for itself and its
  # children exactly as it is when you double-click it, and TCC identifies it by
  # the ad-hoc signature either way. The Accessibility grant is the app's.
  #
  # And by path rather than by bundle identifier, because an identifier is
  # answered by whichever copy LaunchServices likes best — an old build left in
  # another folder answers to the same one, points at whatever repo it was built
  # against, and fails in a way that takes an evening to work out. A path is
  # exactly one app: the one just built. Move the app and this wants
  # ./bundle-app.sh --dest run again.
  #
  # DIY_MAC_REMOTE_AT_LOGIN tells launcher.sh it was not you who started this,
  # so that an unpaired server is a line in the log rather than a dialog at every
  # login until you pair. launchd sets it here; if it does not survive the
  # applet's `do shell script` the dialog appears instead, which is only the
  # behaviour this app has always had.
  cat > "$AGENT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$AGENT_LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$(xmlesc "$APP/Contents/MacOS/$EXEC_NAME")</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>EnvironmentVariables</key>
	<dict>
		<key>DIY_MAC_REMOTE_AT_LOGIN</key>
		<string>1</string>
	</dict>
	<key>AssociatedBundleIdentifiers</key>
	<array>
		<string>$BUNDLE_ID</string>
	</array>
</dict>
</plist>
PLIST

  # launchd ignores a plist that is group- or world-writable, and says nothing
  # about it. Whatever umask you are running with, this one is 644.
  chmod 644 "$AGENT_PLIST" 2>/dev/null || true

  # plutil ships with macOS. A plist it cannot parse is a plist launchd will not
  # read either, and a half-written one left in that folder is worse than none.
  if command -v plutil >/dev/null 2>&1 && ! plutil -lint "$AGENT_PLIST" >/dev/null 2>&1; then
    rm -f "$AGENT_PLIST"
    echo "NOTE: could not write a valid LaunchAgent, so the app will not start at" >&2
    echo "      login. Everything else about the app is fine — double-click it." >&2
    AT_LOGIN_STATE="failed"
  else
    AT_LOGIN_STATE="on"
  fi
elif [ -f "$AGENT_PLIST" ]; then
  rm -f "$AGENT_PLIST"
  AT_LOGIN_STATE="removed"
fi

# --- Tell the human what just happened ----------------------------------------
# A repo inside Desktop/Documents/Downloads is the one thing that can stop this
# app dead, and it is worth saying however brief we are being — so it is a
# function, printed at the end of both the quiet and the full summary.
protected_folder_heads_up() {
  [ -n "$PROTECTED_IN" ] || return 0
  echo
  echo "HEADS UP: this repo is in your $PROTECTED_IN folder —"
  echo
  echo "    $SCRIPT_DIR"
  echo
  echo "  macOS asks apps for permission to read $PROTECTED_IN, and this app has"
  echo "  an identity of its own, so your Terminal's permission does not carry"
  echo "  over. If it refuses to start ('Operation not permitted' in the log),"
  echo "  the fix is either:"
  echo
  echo "    - move the repo out of $PROTECTED_IN (your home folder is fine) and"
  echo "      re-run ./bundle-app.sh from there — this asks macOS for nothing, or"
  echo "    - add the app to System Settings > Privacy & Security >"
  echo "      Full Disk Access."
}

# The LaunchAgent, for the --quiet summary the installers print. Brief, but never
# absent: something that starts by itself from now on is not a thing to leave
# people to find out. (The full walkthrough says the same at more length, as
# step 5.)
at_login_note() {
  case "$AT_LOGIN_STATE" in
    on)
      echo "  It starts when you log in from now on — a LaunchAgent in"
      echo "  ~/Library/LaunchAgents, which starts it only once the phone is paired,"
      echo "  and does nothing at all until then. To undo: ./bundle-app.sh"
      echo "  --no-at-login, or the switch in System Settings > General > Login Items." ;;
    removed)
      echo "  It no longer starts when you log in: the LaunchAgent is deleted." ;;
    off)
      echo "  It does not start at login (--no-at-login, and there was none to remove)." ;;
  esac
}

echo
echo "Built $APP_NAME.app and put it in $WHERE:"
echo
echo "    $APP"
echo
# The short version: what it points at, whether the signature took, and the one
# warning that outlives this script. The caller — an installer — says the rest.
if $QUIET; then
  echo "  it runs $START_NAME in $SCRIPT_DIR${ARGS_SHOWN:+ (mode:$ARGS_SHOWN)}, and it is $SIGNED"
  echo "  it is a wrapper, not a copy — pulling updates in this repo updates the"
  echo "  app, and moving the repo means re-running ./bundle-app.sh there."
  echo
  at_login_note
  if [ "$BUNDLE_KIND" = "applet" ] && [ "$SIGNED" != "ad-hoc signed" ]; then
    echo
    echo "  Unsigned matters more than usual here: the applet is then still"
    echo "  Apple's binary rather than yours, and the Accessibility permission"
    echo "  goes back to landing on the entrypoint's interpreter."
  fi
  protected_folder_heads_up
  exit 0
fi

if [ "$BUNDLE_KIND" = "applet" ]; then
  echo "  Contents/MacOS/$EXEC_NAME -> the applet: the identity macOS holds"
  echo "                               responsible, and nothing else"
  echo "  Resources/main.scpt (Scripts/) -> the one line that starts the launcher"
  echo "  Resources/launcher.sh     -> runs $START_NAME in $SCRIPT_DIR${ARGS_SHOWN:+ (mode:$ARGS_SHOWN)}"
else
  echo "  Contents/MacOS/$EXEC_NAME -> runs $START_NAME in $SCRIPT_DIR${ARGS_SHOWN:+ (mode:$ARGS_SHOWN)}"
fi
echo "  Contents/Info.plist       -> identifies it to macOS as $BUNDLE_ID"
if $HAS_ICON; then echo "  Contents/Resources        -> the app icon"; fi
echo "  the bundle is $SIGNED"
if [ "$BUNDLE_KIND" = "applet" ] && [ "$SIGNED" != "ad-hoc signed" ]; then
  echo
  echo "  ^ that matters more than usual here: unsigned, the applet is still"
  echo "    Apple's binary rather than yours, and the Accessibility permission"
  echo "    goes back to landing on the entrypoint's interpreter."
fi
echo
echo "It is a wrapper, not a copy: it runs the code in this repo, so pulling"
echo "updates here updates the app. Re-run ./bundle-app.sh after moving the repo."
echo
echo "To use it:"
echo
echo "  1) Pair first, from Terminal: ./$START_NAME, then scan the QR with the"
echo "     iPhone. The app refuses to start unpaired, because the one-time"
echo "     pairing key must not land in a log file."
echo
echo "  2) Double-click the app. It runs in the background — no Dock icon, no"
echo "     window — and logs to ~/.diy-mac-remote/server.log."
echo
echo "  3) The first time it types for you, macOS asks for Accessibility."
echo "     Grant it and you are done. (If the trackpad alone stays dead, stop"
echo "     and start the server: it drives the mouse through one long-lived"
echo "     helper, which keeps running without the permission it started"
echo "     without.)"
echo
echo "     Then check System Settings > Privacy & Security > Accessibility:"
echo "     the switch should say '$APP_NAME'. If your Terminal is switched on"
echo "     there from earlier runs, turn it off — that entry lets anything you"
echo "     run from a terminal drive your Mac."
echo
echo "  4) To stop it: double-click stop.command in the Desktop diy-mac-remote"
echo "     folder, or run ./stop.sh here."
if [ "$BUNDLE_KIND" = "applet" ]; then
  echo "     Quitting '$EXEC_NAME' in Activity Monitor stops the applet, but"
  echo "     the server it started is a separate process and keeps running —"
  echo "     so use stop.command instead."
fi
echo
case "$AT_LOGIN_STATE" in
  on)
    echo "  5) From now on it also starts when you log in, so step 2 is a"
    echo "     one-time thing. Log in, not switch on: the server needs a"
    echo "     logged-in desktop to type into, so it comes up with your"
    echo "     session rather than with the Mac. Stopping it stops it —"
    echo "     nothing brings it back until the next login."
    echo
    echo "     It is one plist you can read, in ~/Library/LaunchAgents, and it"
    echo "     starts nothing until the phone is paired. Nothing was started"
    echo "     just now; this arms the next login. To undo, either:"
    echo
    echo "       ./bundle-app.sh --no-at-login${ARGS_SHOWN:+$ARGS_SHOWN}"
    echo
    echo "     or turn '$APP_NAME' off in System Settings > General >"
    echo "     Login Items, under 'Allow in the Background'." ;;
  removed)
    echo "  5) It no longer starts when you log in: the LaunchAgent is deleted." ;;
  off)
    echo "  5) It does not start when you log in (--no-at-login, and there was"
    echo "     none to remove). Drop that flag and it will." ;;
esac

protected_folder_heads_up
