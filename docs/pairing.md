# Pair the phone (once)

The first time you start the server it mints a **pairing key** and prints it as
a QR code. Scanning that QR and then saving the page to your Home Screen is the
whole of pairing — and it happens once, not every time you use the remote.

**Only one phone can be paired at a time.** The pairing is a single secret that
the Mac holds, and the phone's Home Screen app takes it over on its first launch
([below](#2-add-it-to-your-home-screen-full-screen)). A second phone that scans
the same QR or opens the same link isn't a second pairing: it holds a key that the
first phone's launch retires, and then it only ever sees _this pairing is no
longer valid_. To switch phones,
[pair again](#pairing-again-a-new-phone-or-a-lost-pairing) — which ends the old
phone's pairing.

This is steps 4 and 5 of the [quick start](../README.md#4-pair-the-phone-once),
with the reasons.

## 1. Scan the QR, in Safari

The QR (and the printed link) point at the server's address with the pairing key
appended as the `#fragment` (`#<key>`). That fragment never leaves the phone: the
page derives _two_ credentials from it — the secret that keys the crypto, and a
token the server only ever stores hashed (see [Security](security.md)).

It has to be **Safari** — Chrome and Firefox on iOS can't add a page to the Home
Screen, and that next step isn't optional.

## 2. Add it to your Home Screen (full-screen)

`diy-mac-remote` ships an app icon and a web manifest, so the page becomes a real
Home Screen icon that launches full-screen with no Safari chrome — your own
hand-installed "app", no store required. It is also **where the pairing lives**:

1. With the scanned page open in **Safari**, tap the **Share** button → **Add to
   Home Screen** → **Add**.
2. Launch it from the new **Mac Remote** icon, **with the server running**. It
   opens full-screen, already paired.

**The first launch re-keys the pairing.** The key in the QR also ends up in the
saved link and in Safari's history, so the Home Screen app, the first time it
opens, makes a secret and a token of its own and has the server swap them in. From
then on the key in the link derives credentials that match nothing — a copy of it
in your history, an iCloud-synced tab or a backup is just a dead string. It
happens once per pairing (the server allows it only while `rekey.pending` exists
in `~/.diy-mac-remote/`), and it is quiet: if the server isn't reachable at that
moment the app simply tries again on its next launch. A pairing from before this
existed has no such file and keeps working as it always did (that is a legacy
case, not a way to pair more phones: only one phone at a time is supported).

This is also why the **Safari tab stops working** once the Home Screen app has
opened: the key it was opened with has been retired. That is expected. The tab
says so in a red bar and tells you to use the Home Screen app instead.

In a Safari tab the page also reminds you that pairing isn't finished until it's
on the Home Screen. And if the server stops recognising the _Home Screen app's_
own credentials (the pairing was reset, or another phone re-keyed it first), the
app says so in a red bar — *this pairing is no longer valid* — instead of a bare
error: delete the app, reset the app secrets, and pair again.

**Don't skip this step.** The pairing key is shown exactly once, because
it is never written to disk on the Mac — that's the point of it. After the
server restarts it is simply gone: the Mac kept only the derived secret and the
token's hash, so it has nothing left to print, and won't print a QR again. If
the key isn't safely inside a Home Screen app by then, the only way back in is
to reset the pairing and start over.

## 3. Close the terminal, and restart it the way you'll keep starting it

Pairing is done, and two things are worth doing right now — both of them about
not leaving a door open that you no longer need.

**Close that Terminal window.** The QR — and the link printed beside it — is the
pairing key, and pairing did not use it up: the phone derived its two
credentials from that key, and so can anything else that reads it afterwards.
The same secret, the same token, and the server cannot tell the two apart.
The Mac deliberately kept no copy ([Security](security.md)), which means the
scrollback in that window is now the only copy in existence. Closing the window
is what ends it. `Cmd-K` clears the buffer first if you want to be thorough —
and it's worth knowing that Terminal's _reopen windows when logging back in_ can
otherwise bring that scrollback back after a restart.

**Then start the server the way you actually intend to start it** — the
[app bundle](app-bundle.md#bundle-the-server-as-its-own-app), or `start.command` in the
Desktop `diy-mac-remote` folder — _before_ you let the phone type anything. The
first keystroke is when macOS asks for
[Accessibility](app-bundle.md#accessibility-permissions-for-the-server), and the permission
goes to whatever is running the server at that moment. Grant it with the server
running from a terminal and it goes to **Terminal**, which means every program
you ever run from a terminal inherits the right to control your Mac. Grant it to
the app bundle and it covers this server and nothing else. It is the same single
click either way; only the size of what you handed over differs.

## Pairing again (a new phone, or a lost pairing)

Resetting the pairing is what mints a fresh key and prints a new QR. That's the
way to **switch to a different phone**, or to recover a phone whose Home Screen
app was deleted. There is only ever one paired phone, so this replaces the pairing
rather than adding to it:

```sh
node server.js --reset-token   # rotate the pairing, print a fresh QR
perl server.pl --reset-token   # ...or the same, on the Node-free path
```

— or double-click `reset-app-secrets.command` in the Desktop `diy-mac-remote`
folder and restart the server; same effect. Either way the rotation is total:
the previously paired phone loses its pairing, and the phone you want must scan
the new QR (delete the stale Home Screen app first, or you'll end up with two
icons). Don't hand the new QR to two phones — the first Home Screen app to open
wins and the other is locked out.

A fresh QR is a fresh live key, so it earns the same treatment as the first one:
once the phone is on its Home Screen, close the window that printed it
([step 3](#3-close-the-terminal-and-restart-it-the-way-youll-keep-starting-it)).
