# The Accessibility permission and the app

Why the quick start has you [switch to the app](../README.md#5-switch-to-the-app)
before you first use the remote — and what that app is.

## Accessibility permissions for the server

The server types and clicks by asking macOS to do it, through the
**Accessibility API** — the same door screen readers, window managers and macro
tools go through. macOS keeps that door shut by default, because whatever is
behind it can drive your Mac: press any key, click anywhere, in any app.

**What you do:** start the server and use the app. The first time you use the
trackpad, macOS shows a dialog titled _Accessibility Access (Events)_. It can't
grant anything itself, and its highlighted button is _Deny_: click _Open System
Settings_ instead, and under _Privacy & Security → Accessibility_ switch on
whatever asked (see below for what that is).

Then restart the server. The keyboard, the trackpad and the media controls are
all driven from one long-lived `osascript` process (see [How it works](how-it-works.md)),
and a process that started before you granted the permission keeps running
without it.

> **A second dialog asks to control _System Events_.** That one is the keyboard:
> keystrokes go through AppleScript, which is what lets any character be typed
> on any layout (see [How it works](how-it-works.md)). The Media tab's navigation
> pad, Spotlight, brightness and Lock buttons are keystrokes too. Saying yes makes
> all of those work; saying no leaves you with a working trackpad, the
> volume, media, Do Not Disturb, dictation and display-off buttons, and nothing
> typed.
> It lives in _System Settings → Privacy & Security → **Automation**_, separately
> from Accessibility.

**What it means.** The permission is granted to a _program_, not to this
project — and the program macOS sees is whatever it launched, not the script
you typed. So it matters a great deal _how_ you started the server:

| You start it with…                                                                          | macOS asks for, and you grant it to…                   |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `./start.sh` or `./start-plain.sh` in a terminal, or `start.command` on the Desktop         | **Terminal** (or iTerm, or whichever terminal you use) |
| the bundled app from [Bundle the server as its own app](#bundle-the-server-as-its-own-app)  | **DIY Remote Server**                                  |

**How the second row earns its name.** macOS doesn't hand the permission to
whatever made the request — it walks up to the first process it considers
_responsible_, refusing that role to Apple's own binaries along the way. The
process actually posting the events is `osascript`, which is Apple's, so the
walk goes straight past it, past the shell, and lands on whatever started it:
**Node** (or **Perl**, or your terminal), and the dialog names that. The bundle
avoids this by having an executable of its own that macOS _will_ stop at, so the
permission is the app's:
[Why there's an applet in it](#why-theres-an-applet-in-it).

That is the difference between the two rows, and it's the reason to prefer the
second one:

- **Granted to the app, the interpreter only borrows it.** The right applies
  while Node (or Perl) runs as the app's child, and to nothing else. The same
  binary started from a terminal is attributed to your terminal instead, and
  gets nothing.
- **Granted to the interpreter, it belongs to the binary.** Anything started
  from that file inherits it, `-e '…'` included. That's what the earlier `node`
  dialog was really offering, and it's what the fallback shape still does.

Neither is a wall against yourself: grants are per user account, so other
accounts don't inherit them, but code running as _you_ can edit `app/main.js`,
or simply talk to the running server. What this bounds is the blast radius
between _programs_, which is the whole game here.

What would be narrower still is a purpose-built binary that can do nothing but
this remote's own actions. That needs a compiler and a build step, which is
exactly what this project trades away to stay readable end to end. Node, Perl
and `osascript` are all general-purpose interpreters, and granting Accessibility
to one is always a grant to "whatever it is asked to run" — which is precisely
why it's worth the trouble to make sure the grant is the _app's_, and lapses the
moment the interpreter runs on its own.

That first row is the one to think about. Granting Accessibility to Terminal
grants it to Terminal _itself_, so **every future program you run from a
terminal inherits the right to control your Mac** — a build script, an
installer, a one-liner you pasted from a web page, an LLM agent you let run
commands. None of them will ask you again; the permission is already there,
attached to the terminal they happen to run in. That is a genuinely wide grant,
and it long outlives this project.

For a single-user Mac where you already run whatever you like from a terminal,
that may be a trade you're happy with. If it isn't — and it's a reasonable
thing to be uneasy about — give the permission to a bundle that contains only
this server, so it covers this and nothing else. That's
[Bundle the server as its own app](#bundle-the-server-as-its-own-app). You
can also switch Terminal back off in _System Settings → Privacy & Security →
Accessibility_ at any time; the setting is a switch, not a one-way door.

## Bundle the server as its own app

**A guide for keeping the Accessibility grant narrow.** Instead of letting your
Terminal hold the permission, wrap the server in an app bundle that holds it
alone. Nothing about the code changes — the bundle runs the same `start.sh` (or
`start-plain.sh`, with `--plain`) in the same repo. What changes is the name in the Accessibility list, and what
else that name covers: nothing.

[`bundle-app.sh`](../bundle-app.sh) builds it for you — and **the installers run it
for you**, with the right mode baked in, so on a fresh install the app already
exists and this section is background reading. Run it yourself to change the
baked-in mode, or to put the app somewhere else:

```sh
./bundle-app.sh                  # default server mode
./bundle-app.sh tailscale        # bake in a mode — arguments go to start.sh
./bundle-app.sh --dest ~/Apps    # put the bundle somewhere specific
./bundle-app.sh --no-at-login    # don't start it at login (and undo it if set)
./bundle-app.sh --plain          # wrap start-plain.sh — the Node-free path
./bundle-app.sh --quiet          # where it went, without the walkthrough
                                 #   (what the installers use)
./bundle-app.sh --check-location # could the app run from here? builds nothing
                                 #   (what the installers ask first)
```

After moving the repo, re-run the installer you used rather than this alone: the
`.command` files in the Desktop folder point back at the repo too, and the
installer is what rewrites them.

`--plain` is the only one that changes what the app runs: `start-plain.sh`
instead of `start.sh`, so the app needs no Node.js either and skips the
`ensure-node.sh` step this script otherwise does first. Everything else in this
section is the same — including the login start. See
[Run it without Node.js](setup-options.md#run-it-without-nodejs).

It makes `DIY Remote Server.app` and puts it in the `diy-mac-remote` folder on
your Desktop if the installers made one, and in `/Applications` if they didn't
(falling back to your own `~/Applications` if `/Applications` isn't yours to
write to). It also registers the app to
[start when you log in](#starting-it-at-login) — that's the default, and
`--no-at-login` is how you say no. It prints exactly where it went and what's
inside. Re-running is safe — it replaces the bundle it made last time, and
refuses to touch a `DIY Remote Server.app` it didn't build.

What's in the bundle:

- `Contents/MacOS/diy-remote-server` — the **applet**: a real binary, whose
  only job is to be an identity. See
  [Why there's an applet in it](#why-theres-an-applet-in-it) below; it is the
  one file here you can't read, and it does one thing.
- `Contents/Resources/Scripts/main.scpt` — the one line of AppleScript the
  applet runs: _start `launcher.sh`, and stay alive while it does._
- `Contents/Resources/launcher.sh` — the actual launcher, and readable like
  everything else: it checks you're paired, redirects the log, and runs
  `start.sh` **in this repo**. The app is a wrapper, not a copy: update the
  repo and the app is updated too. (Move the repo and you re-run the installer
  you used — or `./bundle-app.sh`, if you built the app on its own.)
- `Contents/Resources/menubar.js` — puts a **⌨ in your menu bar** while the
  server runs, with _Stop server_ behind it, so a windowless app still has
  something to look at and something to click. It's JavaScript rather than
  shell because a menu bar item is a Cocoa object, and `osascript -l JavaScript`
  can make one at run time — nothing compiled, nothing installed. If it fails to
  start, the launcher falls back to a plain dialog with the same _Stop Server_
  button, so there's always a way to stop the server without a terminal.
- `Contents/Info.plist` — the bundle's identity: its name, its bundle
  identifier (`local.diy-mac-remote.server`), `LSUIElement`, which marks it a
  background agent — no Dock icon, no window, because there's nothing to show —
  and `LSRequiresNativeExecution`, which keeps it off Rosetta (see below).
- `Contents/Resources/AppIcon.icns` — built from the app icon already in the
  repo, so you can recognise it in the Accessibility list.

The script then **ad-hoc code-signs** the bundle (`codesign -s -`, a plain
`codesign` invocation with no certificate, no account, and nobody but your Mac
involved — it just hashes the bundle's contents). macOS uses that signature to
recognise the app as the same app next time, so the permission you grant sticks
instead of being re-asked or silently lost. Here it does a second job too: it
is what makes the applet _your_ binary rather than Apple's, which is the whole
reason the permission lands on this app. Unsigned still runs, but you lose that.

That recognition is exact, though: the signature is a hash of the bundle's
contents, so a rebuild that changes them — a moved repo, another mode, a changed
launcher — is a different app to macOS. Its switches in System Settings stay on,
but they no longer apply, and the remote loads and does nothing. So when a
rebuild replaces a build it differs from, `bundle-app.sh` does two things. If
the old build is running, it stops it first: macOS could no longer match it to
anything on disk, and a double-click on the new app would only bring the old
one forward. And it resets the app's permissions
(`tccutil reset All local.diy-mac-remote.server`), Full Disk Access included if
you gave it that, so macOS asks for them again the first time you use the
remote. A rebuild that comes out identical keeps them.

### Starting it at login

`bundle-app.sh` also registers the app to start when you log in, unless you pass
`--no-at-login`. The installers run `bundle-app.sh`, so on a fresh install this
is already done: pair the phone once, and from then on the server is simply
there.

It's a **LaunchAgent** — one plist written to `~/Library/LaunchAgents`, which is
a file in your own home folder and so asks macOS for no permission whatsoever.
The alternative, adding a Login Item, goes through System Events and would want
an _Automation_ permission over a very powerful target just to tick a checkbox;
this project spends permissions more carefully than that. The plist is plain
text you can read, and it names one program: the app's own executable. Deleting
the plist is the entire undo:

```sh
./bundle-app.sh --no-at-login        # plus your mode, if any
```

or switch **DIY Remote Server** off in _System Settings → General → Login Items_,
under _Allow in the Background_ — where macOS lists it by name, and where it
announces it to you in the first place ("Background items added"). Nothing here
is hidden from you by design.

Six things worth knowing:

- **The program it names is the app's own executable**, and that's not an
  accident of convenience. System Settings names a background item after the
  program launchd was handed, taken from that *file* rather than from any bundle
  around it. Point it at `/bin/sh -c '…'` and Login Items calls the entry
  **sh**; point it at a helper script inside the bundle and it's called
  **at-login.sh** — neither tells you what it is or whether you want it, and
  `AssociatedBundleIdentifiers` doesn't override them, because macOS won't take
  our word for an association between a file it can't attribute and an ad-hoc
  signed app of ours. Only the app's signed executable resolves to
  **DIY Remote Server**.
- **launchd starting the app isn't LaunchServices starting it** — but the
  difference doesn't reach what the bundle is for. launchd is never a
  responsible process, so the applet is responsible for itself and its children
  exactly as it is on a double-click, and TCC recognises it by the same ad-hoc
  signature. The Accessibility grant stays the app's.

- **It's login, not boot.** The server types and clicks through the
  Accessibility API, which only exists inside a logged-in graphical session. A
  boot-time `LaunchDaemon` would run as root before anyone logs in and couldn't
  drive anything anyway — so the server comes up with your session, not with the
  Mac.
- **It won't nag about an unpaired server.** The plist sets
  `DIY_MAC_REMOTE_AT_LOGIN=1`, and `launcher.sh` takes that to mean nobody asked
  for this and nobody's waiting: not paired yet becomes a line in the log rather
  than the app's _not paired yet_ dialog at every login until you get round to
  it. If that variable doesn't survive the applet's `do shell script`, you get
  the dialog — which is only what the app has always done.
- **Stopping it stops it.** There's no `KeepAlive`, so _Stop server_,
  `stop.command` and `./stop.sh` all mean what they say; nothing brings the
  server back until your next login.
- **By absolute path, not by bundle identifier.**
  `open -b local.diy-mac-remote.server` would look tidier and would survive
  moving the app, but an identifier is answered by whichever copy LaunchServices
  likes best — and it's easy to end up with two: build once before the Desktop
  folder exists and the app goes to `/Applications`, build again afterwards and
  it goes to the Desktop folder. The spare answers to the same identifier,
  carries the same name in the Accessibility list, and runs whatever repo path
  it was built with, so you get a login that fails while the app you double-click
  works. A path is exactly one app. The cost is that **moving the app means
  re-running** `./bundle-app.sh --dest <new folder>` — and moving the **repo**
  means re-running the installer you used, since the app (like the Desktop
  folder's `.command` files) is a wrapper pointing back at it.

Building the app doesn't start anything: `bundle-app.sh` arms the next login and
leaves the current session alone. To start the server today, double-click the
app as usual.

### Why there's an applet in it

macOS decides who a permission belongs to by walking up from whatever made the
request to the first process it considers **responsible** — and it refuses that
role to Apple's own binaries. A bundle whose executable is a shell script is
therefore skipped straight over, because `/bin/sh` is Apple's, and the walk
lands on the next thing down: **Node** — which is how you end up with a
permission dialog that says `node`. A grant to a general-purpose interpreter is
not much of a boundary: it covers whatever that interpreter is next asked to
run.

So the bundle needs an executable macOS _will_ hold responsible: a real Mach-O
of our own. `osacompile` ships with macOS and produces one — an "applet", a copy
of Apple's AppleScript stub — and re-signing the bundle makes that copy ours
rather than Apple's. The walk then stops at the app, and:

- the permission is stored against **this bundle**, not against a Node binary
  sitting in a folder;
- Node gets the right only while running **as this app's child**;
- the same Node started from a terminal is a stranger to it again, and gets
  nothing.

That last point is the one worth having. The applet is also the one file in this
project you can't read, so it's given as little to do as possible: a single line
of AppleScript that starts `launcher.sh` and then stays alive as its parent —
it has to stay, because the permission is pinned to a process that's there to be
pinned to. Everything else remains shell you can read.

If `osacompile` is somehow missing, `bundle-app.sh` falls back to the old shape —
`launcher.sh` as the executable — and says so on the way past. That still works;
the permission just lands on Node again.

**Keep the repo out of Desktop, Documents and Downloads.** macOS gates those
three folders per app, and the bundle has an identity of its own — that's the
point of it — so your Terminal's access doesn't carry over. A repo in one of
them gets the app refused at launch, and the refusal is easy to misread: it
arrives as `Operation not permitted` in the log, not as a permission prompt,
because macOS lets an app _look at_ a file it may not _open_. So the
installers check first, and refuse to start from such a folder before they
change anything; `bundle-app.sh` on its own warns you at build time, and the app
puts the same explanation in a dialog. The fix, in preference order:

```sh
mv ~/Downloads/diy-mac-remote ~/diy-mac-remote   # your home folder isn't gated
cd ~/diy-mac-remote && ./install-self-signed.sh  # or the installer you used
```

Moving it asks macOS for nothing. If you'd rather leave the repo where it is,
run the installer with `DIY_MAC_REMOTE_ALLOW_PROTECTED_FOLDER=1` in front of it,
so it doesn't stop, and add the app to _System Settings → Privacy & Security →
Full Disk Access_ instead — a much wider grant than the one this whole section
is about narrowing, which is why it's the second choice.

Then:

1. **Pair from Terminal first** — `./start.sh`, scan the QR in Safari, **Add to
   Home Screen** ([Pair the phone](pairing.md)). The app refuses to
   start an unpaired server on purpose: pairing prints a one-time key, the app
   has no terminal to print to, and putting that key in a log file would break
   the one rule the pairing key has ([never written to disk](security.md)). It
   doesn't fail silently — it puts a **dialog** on screen explaining why, with
   an _Open Terminal_ button that opens one in the repo folder for you.
2. **Double-click the app.** It runs in the background and writes its output to
   `~/.diy-mac-remote/server.log` (owner-only, and inside the directory the
   server already keeps out of Time Machine). A normal restart can't reprint
   the pairing key, so that log holds no secrets — the refusal in step 1 is
   what keeps that true.
3. **Grant Accessibility to _DIY Remote Server_** when macOS asks — _Open
   System Settings_, not _Deny_ — and let it control _System Events_. Then stop
   the server and start the app once more, so the server runs with both. While
   you are in _System Settings → Privacy & Security → Accessibility_: if
   **Terminal** is switched on there from earlier runs, switch it off. Leaving it
   on keeps the wide grant you just went to the trouble of avoiding.
4. **To stop it:** pick _Stop server_ from the **⌨** in the menu bar. Or
   double-click `stop.command` in the Desktop `diy-mac-remote` folder, or run
   [`./stop.sh`](../stop.sh). Quitting `diy-remote-server` in Activity Monitor is
   the one thing that won't do it — that stops the applet, and the server it
   started is its own process and carries on serving.
5. **From then on it starts itself**, at every login, so step 2 is a one-time
   thing — see [Starting it at login](#starting-it-at-login) above, including
   how to turn that off.

**How a windowless app talks to you.** Anything you actually need to read — not
paired yet, the repo has moved, the server fell over on startup — comes up as a
dialog box, because a background agent has no terminal and no window of its
own. The launcher raises it to the front first (`tell me to activate`), since a
dialog left behind another window is a dialog you never see, and gives up after
five minutes rather than keeping the app alive forever waiting for a click. The
dialogs belong to `osascript` itself — the launcher never tells another
application to do anything — so they need no Automation permission and ask you
for nothing. Everything else just goes to the log.

Two honest caveats. This narrows _which program_ holds the permission; it does
not make the server itself less powerful — the bundle can still type anything,
which is the entire point of it. And it isn't a sandbox: the bundle is a shell
script running your Node.js, not an App Store app with entitlements. What it
buys you is that the switch in System Settings means "this server" instead of
"anything I ever run in a terminal".
