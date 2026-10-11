# How it works

**The server runs inside `osascript -l JavaScript`.** Everything that decides
anything — routing, the pairing, the crypto, which key to press — is in
[`app/`](../app/), and `app/` runs in a single long-lived JXA process. An
_entrypoint_ owns the socket in front of it and nothing else:

```
                                        ┌─────────────────────────────────────┐
 iPhone ──HTTP(S)──▶ server.js  ──┐     │ osascript -l JavaScript             │
                    (node)        │     │   app/host-jxa.js   loader, messages │
                                  ├────▶│   app/main.js       routing, auth   │
 iPhone ──HTTP─────▶ server.pl  ──┘     │   app/pairing.js    secret + token  │
                    (perl)   one JSON   │   app/sys-jxa.js    CoreGraphics    │
                             line per   │                     keyboard, mouse │
                             request    └─────────────────────────────────────┘
```

**Why that shape.** Typing and clicking mean posting CoreGraphics events
(Quartz Event Services: `CGEventCreateKeyboardEvent`,
`CGEventCreateMouseEvent`), and `osascript -l JavaScript` is the only way to
reach those on a stock Mac without a compiler or a native module. Being *inside*
that process makes every keystroke and every mouse move a plain function call.
The old design paid an `osascript` launch (~100 ms) per keypress and kept a
second long-lived helper process on a pipe just for the mouse; both are gone.

**The keyboard takes a different road to the mouse**, and always has: AppleScript
can type but cannot move the cursor. So `app/input.js` builds an AppleScript
program — `keystroke "…"`, `key code N using {command down}`, `delay 0.3` — and
`app/sys-jxa.js` compiles and runs it with **`NSAppleScript`, inside this
process**. That is the one thing that changed: the old design launched
`osascript` per keypress and paid ~100 ms for it; the whole batch is now one
compiled script and no launch at all.

**What `keystroke` cannot type, the clipboard can.** System Events maps each
character back to *one* keypress on your current layout, and when it can't find
one it does not fail — it sends key code 0, which types `a`. On a Finnish
keyboard `é` and `ü` arrive; `õ` (option+`~`, then o) becomes `a`, and an emoji
becomes two of them. So `app/input.js` sends ASCII through `keystroke`, which
every Latin layout can reach, and anything else through the clipboard: set it,
⌘V, put back what was there. That is correct for any character at all, at the
cost of a paste (~150 ms) and a brief borrow of the clipboard — so if your
layout does reach some of those directly, name them and they keep the fast path:

```sh
DIY_MAC_REMOTE_DIRECT_CHARS='äöåÄÖÅ' ./start.sh    # a Nordic keyboard
```

Two caveats worth knowing: only the *text* on the clipboard is saved and
restored, so an image or styled content on it is left alone rather than
clobbered but also not preserved; and ⌘V has to be allowed where you are typing.

The obvious fix would be `CGEventKeyboardSetUnicodeString`, which posts
characters directly and needs no layout at all. It is unreachable from JXA: it
takes a `const UniChar *`, and the bridge refuses every way of producing one.
[`test/unicode-probe.jxa.js`](../test/unicode-probe.jxa.js) tries six of them —
`NSMutableData` buffers, a `Uint16Array`, three `ObjC.bindFunction`
re-declarations — and reports what each one did on your Mac. Run it if you want
to check whether a newer macOS has opened that door; if one ever does, the
clipboard path can go.

The price of `keystroke` is the permission: it goes through System Events, so
macOS asks for **Automation** as well as Accessibility. The mouse posts
CoreGraphics events directly and needs only Accessibility.

**The media controls are a fixed list, not a command line.** The Media tab sends
an op naming one control — `volup`, `play`, `lock`, … — and
[`app/input.js`](../app/input.js) maps that name to what runs; anything not on the
list is refused. What runs depends on the control, because the keys on a Mac
keyboard's top row reach macOS in different ways:

- **Volume** is AppleScript's own `set volume`, run in the same `NSAppleScript`
  as the keystrokes but needing no System Events.
- **Play/pause, next and previous** go to MediaRemote, the private framework
  the media keys end up calling, bound with `ObjC.bindFunction`. It routes the
  command to whichever app owns Now Playing.
- **Brightness** is key codes 144/145 through System Events, and **Do Not
  Disturb** and **dictation** are key codes 178 and 176 — what the moon and
  microphone keys report — posted as separate down and up CoreGraphics events,
  so holding the dictation button is push-to-talk exactly as holding the key is.
- **Lock**, **Display off** and **Mission Control** are one line of AppleScript
  each: ⌃⌘Q, `pmset displaysleepnow`, `open -a "Mission Control"`.

The obvious single route would have been the event the keyboard itself sends for
those keys — an `NSSystemDefined` event built with `NSEvent` and posted through
its `CGEvent` property. Under JXA that goes out and does nothing, with no error
anywhere, which is why none of the controls above depend on it.

**The module loader.** `osascript` runs one script and has no `require()`, so
[`app/loader.js`](../app/loader.js) provides one: read the file, evaluate it with
`new Function('exports', 'require', 'module', …)`, cache it by path. It is
~40 lines, and it's what lets the same `app/` modules load unchanged under Node
— which is how the test suite drives all of this on a machine that has no
`osascript` (see [Tests](#tests)).

**No crypto library, twice over.** JavaScriptCore under `osascript` has no
`node:crypto` and no `crypto.subtle`, exactly as the plain-HTTP page in Safari
has none. So SHA-256, HMAC, ChaCha20, base64 and UTF-8 are all hand-written in
`app/` — the same algorithms the page inlines, pinned against each other and
against Node's native implementations by `test/parity.test.js`.

**The line protocol.** A message is `key: value` lines ended by a blank one, on
the backend's stdin/stdout, one request at a time:

```
t: req                                   t: res
id: 7                                    id: 7
method: POST                             status: 200
path: /msg                               body: {"ok":true,"n":1}
body: {"iv":"5Nx...","ct":"Qk9..."}
```

That is the whole format. Values are percent-encoded, so a value can never
contain a newline and a message is always plain ASCII — which matters because
the JXA host reads whatever chunk the pipe hands it, and half a UTF-8 sequence
decodes to nothing. A repeated key is a list (that is how a command line
travels). There is no parser on any side: writing a message is a `sprintf`,
reading one is a split at the first colon.

**It stays that small because file bytes never cross it.** `public/` is served
by the entrypoints, so the only bodies the backend ever handles are the JSON of
`/nonce` and `/msg`. Duplicating the static serving is the price; a protocol
both a shell script and a Perl one-liner can speak is what it buys.
[`test/perl.test.js`](../test/perl.test.js) holds the two implementations to the
same answers, byte for byte, and
[`app/protocol.js`](../app/protocol.js) documents the format in full.

**Neither entrypoint parses more than it must.** A request body has to arrive
with `Content-Length` — the page always sends one, since `fetch` sets it for a
string body — and a chunked one is refused with `411 Length Required` rather
than decoded. A chunk decoder would be parsing code answering to anyone who can
reach the port, in exchange for a shape the client never sends.

**And the files are served from a listing, not from a path.** A request for a
static file makes the entrypoint list `public/`, build the map of
"URL path → the file it means", and look the request up in it. The path that
gets opened is one the server built from what it found on disk; the client's
path is only ever a key. So there is no traversal to defend against, no
normalization to get subtly wrong, and no `%2e%2e` trick to try — anything that
isn't one of those files, in exactly that spelling, is a 404. Listing per
request costs a `readdir` of four files on a page load, and means a file dropped
into `public/` is served immediately.

## HTTP API

- `GET /` — the web app. (public)
- `GET /nonce` — issue a fresh nonce `{ nonce, ttlMs }`. (public)
- `POST /msg` — the single **authenticated + encrypted** action endpoint. Body is
  an envelope `{ iv, ct, mac }` (see below).

There is one action endpoint; the operation (keypress, mouse, or media control) lives in the
_encrypted_ payload, so the URL never reveals what you sent.

### The `/msg` envelope

```
iv  = base64(random 12-byte ChaCha20 nonce)
ct  = base64(ChaCha20(encKey, iv, counter=1, pad(plaintext)))
mac = hex(HMAC_SHA256(macKey, "POST\n/msg\n" + iv + "\n" + ct))   // encrypt-then-MAC

plaintext = JSON: { "n": <authNonce>, "c": <counter>, "o": [ <op>, ... ], "p": <token> }
op        = { "t":"k", "b": <action obj/array> }   // a keypress
          | { "t":"m", "k":"mv", "dx":<n>, "dy":<n> }   // mouse move (relative)
          | { "t":"m", "k":"cl", "btn":"l"|"r" }        // mouse click (down+up)
          | { "t":"m", "k":"dn", "btn":"l"|"r" }        // mouse button down (hold)
          | { "t":"m", "k":"up", "btn":"l"|"r" }        // mouse button up (release)
          | { "t":"m", "k":"sc", "dy":<n> }             // scroll wheel
          | { "t":"s", "k":<name> }                     // media/system control:
            // volup voldown mute brightup brightdown play next previous
            // dnd dictation lock displayoff missioncontrol
            // (a fixed list — see app/input.js)

pad(x)  = x + spaces, to a multiple of 256 bytes (JSON.parse ignores the spaces)
encKey  = SHA256("diy-mac-remote-enc:" + secret)
macKey  = SHA256("diy-mac-remote-mac:" + secret)
```

`o` is an **array** of ops: the client coalesces keystrokes pressed within a short
window into one message (see padding/batching in [Security](security.md)). The server verifies the MAC
over the ciphertext, decrypts, checks the nonce and counter, then runs the ops in
order.

## Files

- `start.sh` — one-command launcher: runs `ensure-node.sh`, then starts the
  server with `./node/bin/node` (forwarding any arguments to `server.js`), and
  leaves its pid in `~/.diy-mac-remote/server.pid` for `stop.sh` to find.
- `ensure-node.sh` — idempotently makes sure `./node/bin/node` works: a no-op
  if it already does, else it symlinks a pre-installed Node (v18+), else it
  fetches an official build and verifies it against a SHA-256 checksum pinned
  in this repo before unpacking it into `./node` (`--download` forces this).
- `setup-https.sh` — one-command HTTPS setup: generates the certificate
  (`gen-cert.sh`), refreshes the Desktop folder (`ensure-desktop-folder.sh`) and
  builds the app there (`bundle-app.sh`); see
  [Serve it over HTTPS](setup-options.md#serve-it-over-https).
- `install-self-signed.sh` — one-command install for the self-signed HTTPS
  path: runs `setup-https.sh` with `ensure-node.sh` in the background, then
  builds the app once that has finished. Arguments are forwarded to
  `gen-cert.sh`.
- `install-tailscale.sh` — installer for the Tailscale path: runs
  `ensure-node.sh`, drops just a `start.command` (with `tailscale` mode baked
  in) into the Desktop folder and builds the app next to it — no certificate,
  nothing to install on the phone.
- `install-tailscale-self-signed.sh` — installer for both at once, and the
  strongest of the three: a certificate covering this Mac's MagicDNS name as
  well as its `.local` name, plus `tailscale` mode baked into `start.command`
  and into the app. Needs a live tailnet, and refuses without touching anything
  if there isn't one; see
  [Both at once](setup-options.md#both-at-once-tailscale--certificate).
- `bundle-app.sh` — wraps the server in a `DIY Remote Server.app` bundle
  (`--plain` wraps `start-plain.sh` instead, for the Node-free path)
  (Info.plist, a readable shell-script launcher pointing back at this repo, an
  icon, an ad-hoc `codesign` signature) and puts it in the Desktop
  `diy-mac-remote` folder if it exists, else in Applications — so the
  Accessibility permission belongs to that app instead of to your Terminal.
  It also writes the LaunchAgent that
  [starts the app at login](app-bundle.md#starting-it-at-login), unless you pass
  `--no-at-login`.
  Every installer starts by asking it whether the app could run from where the
  repo is (`--check-location`), and stops before changing anything if not; and
  every installer ends by running it (`--quiet`), so it is normally only run by
  hand to rebuild. When a rebuild differs from the build it replaces, it stops
  that one if it is running and resets the app's permissions, so macOS asks for
  them again; see
  [Bundle the server as its own app](app-bundle.md#bundle-the-server-as-its-own-app).
- `gen-cert.sh` — the certificate workhorse: makes a self-signed TLS certificate
  with `openssl` (already on macOS) for this Mac's `.local` name (plus any
  names/IPs you pass, and its MagicDNS name with `--tailscale`).
- `ensure-desktop-folder.sh` — makes sure the `diy-mac-remote` folder on the
  Desktop is up to date: the CA ready to AirDrop, an HTML how-to matching the
  current certificate, and double-clickable `start.command` / `stop.command` /
  `reset-app-secrets.command` / `reset-certificate.command` entries pointing
  at this repo.
- `stop.sh` — stops a running server, whether it was started by the app bundle,
  by `start.command`, or in a Terminal window you no longer have. Finds it by
  the pid file `start.sh` writes, else by what holds the port; confirms the
  process really is this repo's server, then asks it to stop (TERM) before
  insisting (KILL).
- `reset.sh` — the reset logic behind those entries: `./reset.sh app-secrets`
  forgets the pairing (fresh QR on next start, all devices re-pair);
  `./reset.sh certificate` mints a fresh CA + certificate (install the new CA
  on the phone once). Both confirm before resetting; a running server picks
  the reset up on its next start.
- `start-plain.sh` — the same, without Node.js: checks that `perl` and
  `osascript` are there (they ship with macOS), writes the same pid file, and
  starts `server.pl`. Plain HTTP only; see
  [Run it without Node.js](setup-options.md#run-it-without-nodejs).
- `server.js` — the Node **entrypoint**: the socket, TLS, HTTP plumbing and the
  files in `public/`. Knows nothing about nonces, secrets or keystrokes — those
  two requests go to the backend.
- `server.pl` — the Node-free entrypoint: the same job in core Perl, plain HTTP
  only. No modules to install, and no parser in it: the protocol is
  `key: value` lines.
- `app/` — **the server itself**, run by `osascript -l JavaScript` (or by Node
  for development and tests):
  - `app/host-jxa.js` — the JXA host: bootstraps the loader, installs the
    platform layer, and answers messages. Started by an entrypoint, never by
    hand.
  - `app/host-node.js` — the same host under Node, for development and the test
    suite. It logs input events instead of posting them.
  - `app/loader.js` — the `require()` that `osascript` doesn't have:
    `new Function` over a file read, cached by path.
  - `app/protocol.js` — the entrypoint ⇄ backend line protocol, documented in
    full.
  - `app/main.js` — routing, the request lifecycle, the pairing banner.
  - `app/pairing.js` — the secret and the token: derive, mint, store, verify.
  - `app/envelope.js` — nonces, counters, and opening the `/msg` envelope.
  - `app/input.js` — key, mouse and media-control ops to events (and what to
    refuse).
  - `app/keys.js` — the key-code and modifier maps.
  - `app/netinfo.js` — `.local` / MagicDNS / LAN-IP detection and the address
    that goes into the QR.
  - `app/sys.js` — the platform interface; `app/sys-jxa.js` and
    `app/sys-node.js` are its two implementations (files, randomness,
    subprocesses, and the CoreGraphics keyboard, mouse and media keys).
  - `app/sha256.js`, `app/chacha20.js`, `app/bytes.js` — the crypto and the
    byte plumbing, hand-written because neither JavaScriptCore nor a plain-HTTP
    page has any (an identical copy is inlined in the page so both ends
    interoperate).
  - `app/qr.js` — self-contained QR-code generator used to print the
    scan-to-connect QR on startup. Fixed to Version 5 / EC level L / byte mode
    (106 bytes max).
  - `app/pathutil.js` — the handful of `node:path` functions the above need.
- `public/index.html` — the mobile web app: the Mouse, Media and Keyboard tabs
  (self-contained; inlines SHA-256, ChaCha20, HMAC, and the UI).
- `public/manifest.webmanifest`, `public/icon-*.png` — Home-Screen app metadata.
- `docs/` — these pages, and the screenshots at the top of the README.
- `test/` — the test suite (see below). Zero dependencies, no framework, plus
  `test/jxa-smoke.sh` for the parts that only a Mac can check.

## Tests

Run them with plain Node — there's nothing to install:

```sh
npm test          # or: node test/run.js
```

Like the rest of the project, the suite has **no dependencies and no framework** —
just a ~20-line runner (`test/harness.js`) over `node:assert`, so it's as
auditable as the code it checks. It covers the security-critical parts:

- **`chacha20.test.js`** — checks the pure-JS cipher against Node's _native_
  ChaCha20 (authoritative, can't be miscopied), the RFC 8439 keystream vector, and
  the encrypt/decrypt round-trip.
- **`parity.test.js`** — runs the page's _inlined_ SHA-256, ChaCha20, and
  credential derivation in a sandbox and asserts they agree byte-for-byte with
  the backend's own copies **and** with Node's native ones. Three
  implementations, one answer, or the phone and the Mac stop understanding each
  other.
- **`pairing.test.js`** — drives the real server over HTTP the way the phone does:
  master-derivation, the token second layer (valid → 200, wrong/missing → 401),
  the **"the master is never written to disk"** invariant, owner-only file perms,
  restart behaviour, and `--reset-token` rotation.
- **`perl.test.js`** — the same pairing round-trip through
  [`server.pl`](../server.pl), plus keep-alive, a byte-for-byte PNG, and an
  oversized body refused. The two entrypoints are meant to be
  interchangeable; this is what says so.
- **`loader.test.js`** — the stand-in for the Mac. It loads every `app/` module
  the way `osascript` does — through the real
  [`app/loader.js`](../app/loader.js), `new Function` and all — under a stub host
  that shares nothing with Node's, then mints a pairing and drives a signed
  `/msg` through it. If something under `app/` stops being loadable that way, or
  starts assuming Node, it fails here rather than on your Mac.
- **`input.test.js`** — the AppleScript a key action turns into, down to the
  exact program text: modifiers, key codes, capped delays, which characters take
  the clipboard route, and the invariant that makes injection impossible rather
  than unlikely — whatever the phone sends lands inside a quoted literal on
  exactly one line, and every other line is one this project wrote. Also what
  each media control turns into, and that a name not on the list runs nothing.
- **`protocol.test.js`** — the line protocol: that a value survives the trip
  whatever it holds, and that nothing a client can send — a newline, a stray
  percent sign, bytes that aren't text — can break the framing.
- **`install-location.test.js`** — the installers' first question,
  `bundle-app.sh --check-location`: a repo in Desktop, Documents or Downloads
  is stopped with the move spelled out, the home folder (or an explicit
  override) is let by, and the suggested move never lands on a folder that
  already exists.

What the suite _cannot_ check on a machine that isn't a Mac is the last inch —
`osascript` actually loading `app/`, and the CoreGraphics calls in
`app/sys-jxa.js` actually posting the events. That part needs a Mac and a look
at the screen, so it has a script of its own:

```sh
./test/jxa-smoke.sh          # talk to the JXA backend directly, over its own
                             # protocol: does it load, pair, and answer?
./test/jxa-smoke.sh --type   # type and move the mouse for real — 5 seconds to
                             # click into a scratch document first
./test/jxa-smoke.sh --unicode  # which ways of posting literal text this Mac's
                             # JXA bridge accepts (see How it works)
```

The first uses a throwaway `HOME`, so it mints its own pairing and leaves yours
alone, and it **checks** what comes back rather than leaving it to the eye: the
backend loaded, a pairing was minted, `/nonce` answered 200 with a real 256-bit
nonce. The second is the acceptance test for the keyboard: it types ASCII,
non-ASCII, a named key and a ⌘ shortcut, then traces a square with the pointer,
and tells you what you should have seen. **Run both on a Mac before starting the
server for real** — they fail with a reason attached, where the same problem
seen from the phone is just a red box saying the nonce expired.
