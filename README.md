# diy-mac-remote — your iPhone as a **keyboard** and **trackpad** for your Mac, built and delivered by you.

When you open your machine up to be controlled remotely, you **really** want
to know that the tools doing the controlling **can be trusted**.

The simplest way to raise that trust is to shrink the list of parties you have
to rely on, because even if those parties are honest, you are also trusting
that **they themselves are not hacked!**

That is the aim of this project: to keep the list of trusted parties list as
short as possible by helping you do most of it **yourself**, in a way that is
**transparent**, **verifiable**, and **easy**.

There is **no App Store app** to install. There is **no compiled installer**
for the part running on your mac. There never will be. Instead you get the
source for both halves and *you* decide how to deliver them onto your own mac
and phone by following our guides.

`diy-mac-remote` is a kit, not a product. Nothing is signed by us, hosted by
us, or phoning home to us, because there is no "us" in the loop once you've
downloaded the repo. You are in charge of everything that runs both on your
phone and mac.

And as a small bonus, there is also no cost, and no ads.

```
┌────────────┐        you wire this up yourself:       ┌────────────┐
│  your Mac  │  ◀─ Mac software (server.js) --------   │ your iPhone│
│ (the host) │  ----- Web app (public/index.html) ─▶   │ (the app)  │
└────────────┘                                         └────────────┘
```

As an extra measure, if you have access to an LLM agent, you should download
this code, and then ask the agent to verify none of the code and examples in
this repo contain clever ways to try to hack you.

It is not only you being rightfully untrusting of me who wrote this message,
but untrusting of all of the infrastructure that was needed to send these bits
to your computer - because a lot could have gone wrong along the way, and you
might be reading a guide that was purposefully altered to get you to do things
that expose your computer to be controlled by hackers.

## The DIY deal

Two halves, and **you** are responsible for getting each one where it needs to go:

- **The backend** is `server.js` — plain JavaScript. We help you get a safe version of Node.js to run it on, and there are no other dependencies.
- **The app** is `public/index.html` — a single self-contained web page. You load it onto your phone yourself.

For each half there are several ways to do the delivery, with different
trade-offs in trust, convenience, and reach. We'll provide a menu of those
options and a guide for each. **Right now one path is written up below** — the
fast, local one, but one that requires a lot of trust from your network! More guides are coming; the philosophy is that you pick the
delivery that fits *your* threat model and *your* network, and we just hand you
the recipes.

## Requirements

- macOS
- iPhone
- Node.js — don't have it, or don't trust the one already on your machine? Run
  [`get-node.sh`](get-node.sh) to fetch an official build and verify it against a
  checksum pinned in this repo (see [Get a verified Node.js](#get-a-verified-nodejs)).
- This repository.
- **Accessibility permission:** the first time it sends a key, macOS will ask to allow your Terminal *System Settings → Privacy & Security → Accessibility*. Grant it.

> ⚠️ **DO NOT USE** if you do not trust your LAN network routers! The easiest
> way to increase trust is to install [Tailscale](https://tailscale.com) on
> your Mac and iPhone.
> See [Security](#security) or [How it works](#how-it-works) for more info.

## Delivery guide: run it locally (the default DIY path)

The simplest delivery method: run the server from source and load the app over
your LAN. No build step, no signing, no store.

The fastest path is [`start.sh`](start.sh), which gets a verified Node.js (only
if you don't already have one unpacked) and starts the server for you:

```sh
./start.sh                # fetches ./node if needed, then runs the server
./start.sh tailscale      # any arguments are forwarded to server.js
```

Then scan the QR code, grant Accessibility rights, and you're controlling your
Mac. The rest of this section explains each step if you'd rather run them by hand:

1. Open your Terminal.
2. Clone this repo with git on your machine.
3. Get Node.js — use your own, or run [`get-node.sh`](get-node.sh) (see below).
4. Run the server with Node.js (see below).
5. Scan the QR code with your iPhone.
6. Grant Accessibility rights for Terminal.
7. Use the web app to control your Mac.
8. (optional) Add it to your Home Screen as a full-screen app.

### Get a verified Node.js

If you don't already have Node.js — or you'd rather not trust the copy that's on
your machine — run the bundled script to fetch an official build and check it
against a SHA-256 checksum **pinned in this repository**:

```sh
./get-node.sh                 # downloads, verifies, unpacks into ./node
./node/bin/node --version     # should print v26.3.1
```

The script refuses to unpack anything unless the download's checksum matches the
one committed here. This is on purpose, and it's stronger than trusting the
checksum Node.js publishes alongside the download: if an attacker controlled
nodejs.org they could serve a malicious tarball *and* a matching checksum. By
pinning the hash in this repo, fooling you requires compromising **both**
nodejs.org **and** this repository — the same "split your trust" idea the rest of
`diy-mac-remote` is built on.

> The script detects your Mac's CPU with `uname -m` and fetches the matching
> build — Apple Silicon (arm64) or Intel (x64). Once it's unpacked, use
> `./node/bin/node server.js` in place of `node server.js` below.

### Run the server

```sh
node server.js               # detect (default): try tailscale first, then wifi
node server.js wifi          # try only the Mac .local mDNS address
node server.js tailscale     # try only the Tailscale MagicDNS name
PORT=8700 node server.js http://192.168.0.2:8700 # custom URL verbatim
node server.js --reset-token # rotate the auth token + print a fresh pairing QR
```

It prints the address to open on your phone plus a QR code to make it easier.

**Tailscale mode restricts access to the tailnet.** Whenever the server
advertises a Tailscale address — either `tailscale` mode, or the default `detect`
mode when a tailnet is up — it accepts requests **only** from tailnet source
addresses (`100.64.0.0/10` or Tailscale's IPv6 range). The port still listens on
all interfaces, but a request from anywhere else — e.g. a co-present untrusted
Wi-Fi — is refused with a `403` *before* it reaches any routing, crypto, or input
handling, so an on-path attacker on that LAN can't drive your Mac or get the page
to rewrite. (Filtering the source rather than binding one interface avoids a
startup race with Tailscale and survives your tailnet IP changing. The
`wifi`/`.local` and raw-IP modes don't filter, as before. Set `HOST=<addr>` to
bind a single interface and opt out of the filter.)

The QR (and printed link) point at that URL with a single **pairing key** appended
as the `#fragment` (`#<key>`). The phone derives *two* credentials from it — the
secret that keys the crypto and a token the server only ever stores hashed (see
[Security](#security)). The key is minted on first run. On a normal restart the
server can no longer show it (it kept only the derived secret and the token's hash
— that's the point), so already-paired devices just reopen the app; to pair a
**new** device, or to recover if a phone loses its pairing, run
`node server.js --reset-token` to mint a fresh key and QR. That rotates the
pairing, so every previously paired device must re-pair.

### Deliver the app to your Home Screen (full-screen)

`diy-mac-remote` ships an app icon and web manifest, so you can add the page to
your Home Screen and launch it full-screen with no Safari chrome — your own
hand-installed "app", no store required:

1. Open the printed `http://<mac-ip>:8765` in **Safari** on the iPhone (must be
   Safari — Chrome/Firefox on iOS can't add to the Home Screen).
2. Tap the **Share** button → **Add to Home Screen** → **Add**.
3. Launch it from the new "Mac Remote" icon. It opens full-screen.

Notes:
- Keep the Mac and phone on the same Wi-Fi or Tailscale VPN, and keep `server.js`
  running in the Terminal.

> **More delivery options coming.** This local path is one recipe. The roadmap is
> a menu of others — Tailscale-only access, port-forwarding, and so on — each with
> its own guide, so you can choose the delivery that matches the trust you have in
> your network.

## Serve it over HTTPS

By default `diy-mac-remote` runs over plain HTTP, and that is deliberately safe
against a *passive* eavesdropper: every keystroke is already encrypted and
authenticated (ChaCha20 + HMAC) before it leaves the phone. What plain HTTP does
**not** protect against is an *active* man-in-the-middle on a router you don't
control — someone positioned to rewrite the web page itself before your phone
ever loads it (see [Security](#security)). Serving the page over HTTPS closes
that last gap: the phone refuses any page that isn't served under a certificate
it trusts. As a bonus, an HTTPS page is a browser **"secure context"**, so the
native `crypto.subtle` becomes available and the page uses it for faster hashing
instead of the bundled pure-JS fallback.

There are **two ways** to get HTTPS, and one command to pick between them:

```sh
./setup-https.sh          # interactive: choose option A or B
./setup-https.sh self     # go straight to the self-signed path
./setup-https.sh tailscale
```

| | **A. Self-signed certificate** | **B. Tailscale HTTPS** |
|---|---|---|
| Works on | **any** network (Wi-Fi, LAN, hotel) | only over your **tailnet** |
| iPhone setup | install + trust a cert **once** | **nothing** |
| Certificate | your own private CA (`openssl`) | real, auto-renewing Let's Encrypt |
| Depends on | nothing but your Mac | a Tailscale account + MagicDNS |
| Privacy note | fully offline | machine name goes in a public [CT log](https://certificate.transparency.dev/) |

Pick **A** if you want it to work everywhere and stay fully offline; pick **B**
if you already use Tailscale and want zero fuss on the phone.

## Option A — self-signed certificate

This uses only tools already on macOS (`openssl`). No download, nothing to trust
but yourself. You set up a tiny private Certificate Authority (CA) that lives
only on your Mac, install it on your iPhone **once**, and from then on your phone
trusts the server.

### 1. Generate the certificate (on the Mac)

```sh
./gen-cert.sh                       # auto-detect this Mac's .local name, LAN IPs, Tailscale name
./gen-cert.sh mymac.local 10.0.0.9  # ...plus any extra name/IP the phone will use
```

A certificate is only valid for the names and IPs baked into it, so if you'll
reach the Mac by an address the script didn't auto-detect, pass it as an
argument. This writes four files into `~/.diy-mac-remote/` (owner-only, the same
place the pairing secret lives):

- `ca-cert.pem` — your CA. **This is the file you put on the iPhone.** It's public; it's safe to copy around.
- `ca-key.pem` — the CA's private key. Stays on the Mac, owner-only. Whoever holds this can mint certs your phone will trust, so don't copy it off the machine.
- `cert.pem` / `key.pem` — the server's certificate and private key, served automatically.

### 2. Start the server

Nothing new to type — the server serves HTTPS automatically as soon as those
files exist, and the printed QR/link switches to `https://`:

```sh
./start.sh
```

To temporarily go back to plain HTTP, start with `--no-tls`. To *require* HTTPS
(fail loudly if the cert is missing rather than silently falling back), use
`--tls`.

### 3. Install and trust the CA on the iPhone (once)

You need to get `~/.diy-mac-remote/ca-cert.pem` onto the phone and then flip
**two** switches — installing a certificate and *trusting* it are separate steps
on iOS.

1. **Get the file onto the phone.** `gen-cert.sh` already dropped a copy in a
   `diy-mac-remote` folder on your Desktop (alongside a
   `HOWTO-AIRDROP-CERT-TO-PHONE.html` with these same steps) and opened it in
   Finder — right-click `diy-mac-remote-ca.pem` → **Share → AirDrop** → your
   iPhone. (If AirDrop doesn't offer to install it,
   email the file to yourself and open it in the Mail app instead. Some iOS
   versions are fussy about the extension — if so, rename the copy to
   `diy-mac-remote-ca.crt` and send that.)
2. iOS says **"Profile Downloaded"**. Open **Settings** → it shows **Profile
   Downloaded** near the top (or go to **Settings → General → VPN & Device
   Management**).
3. Tap the **diy-mac-remote local CA** profile → **Install** (enter your
   passcode) → **Install** again to confirm.
4. **Now trust it** — this is the step people miss. Go to **Settings → General →
   About → Certificate Trust Settings**. Under **Enable Full Trust for Root
   Certificates**, turn **ON** the switch for **diy-mac-remote local CA**.

That's it. Open `https://<your-mac>.local:8765/` (or scan the new QR) in
**Safari** — no warning, a padlock, and you can Add to Home Screen as before.

### Notes and caveats

- **Changing address?** If the Mac's LAN IP changes, just re-run `./gen-cert.sh`
  (add the new IP if needed) and restart the server. The phone keeps working with
  **no reinstall** — the new certificate still chains up to the same CA it already
  trusts. Reaching the Mac by its stable `.local` name avoids this entirely.
- **Untrusting it later:** delete the profile on the phone under **Settings →
  General → VPN & Device Management**, or turn its switch back off under
  **Certificate Trust Settings**.
- **What you're trusting:** the CA private key never leaves your Mac and is
  owner-only. Anyone who both steals `ca-key.pem` *and* can position themselves as
  a man-in-the-middle on your network could forge a page your phone accepts — so
  treat `ca-key.pem` like the pairing secret. For the home-LAN threat model this
  is exactly the transport trust that plain HTTP was missing.
- This does not replace any of the app-layer crypto; it's defence-in-depth on top
  of it.

## Option B — Tailscale HTTPS

If you already run [Tailscale](https://tailscale.com) on both devices, it can do
the HTTPS for you: Tailscale obtains a **real, publicly-trusted Let's Encrypt
certificate** for your Mac's MagicDNS name and terminates TLS in front of the
server. The upshot is there is **nothing to install or trust on the iPhone** —
the certificate is already trusted by every device — and it **auto-renews**. The
trade-off is that it only works while both devices are on the tailnet.

### 1. One-time Tailscale setup

In the Tailscale admin console, enable **MagicDNS** and **HTTPS Certificates**
on the [DNS page](https://login.tailscale.com/admin/dns). (Enabling HTTPS means
your machine names appear in a public Certificate Transparency log — that's how
Let's Encrypt works.) Make sure Tailscale is running and signed in on the Mac.

### 2. Turn it on

```sh
./setup-https.sh tailscale
```

This runs `tailscale serve --bg --https=443 http://127.0.0.1:8765`, which tells
Tailscale to accept HTTPS on your MagicDNS name and reverse-proxy it to the local
server. It then prints the exact command to start the server — bound to
**loopback only**, so the plain-HTTP port isn't reachable even from other tailnet
devices; the *only* way in is through Tailscale's HTTPS:

```sh
HOST=127.0.0.1 PORT=8765 ./start.sh "https://<your-mac>.<tailnet>.ts.net/"
```

The QR/link it prints points at that HTTPS address. Open it in **Safari** on the
phone (same tailnet) — padlock, no warning, no install. Add to Home Screen as
usual.

### Notes and caveats

- **Turning it off:** `tailscale serve reset` stops the HTTPS proxy.
- **Certificate:** provisioned and renewed by Tailscale automatically; you never
  run `tailscale cert` or touch a key file yourself.
- **Reach:** works only over the tailnet. Off the tailnet, use option A (or a
  plain LAN address on a network you trust).
- Like option A, this is transport trust layered on top of the app's own crypto,
  not a replacement for it.

## The keyboard

The Keyboard tab pairs your phone's **own native keyboard** with a bar of the
special keys a phone keyboard lacks.

- **Type with the native keyboard.** Tap the capture field and your phone's
  keyboard pops up below; whatever you type — letters, numbers, symbols, **å ä ö**,
  emoji, swipe-typed words, predictive suggestions — is sent straight to the Mac.
  This means your own layout, languages, and autocomplete, instead of a fixed
  on-screen grid. (Soft keyboards don't emit reliable key events, so the app reads
  the field's edit events instead and forwards each one as a keystroke.)
- **A special-keys bar sits above it**: ⎋ esc, ⇥ tab, the modifiers (⌘ ⌥ ⌃ ⇧),
  and a navigation row (⌫ backspace, ⌦ forward-delete, ← ↑ ↓ →, ⏎ return). These
  stay visible above the native keyboard and don't dismiss it when tapped.
- **Modifier** keys (⌘ ⌥ ⌃ ⇧) **latch**: tap one and it stays held (highlighted
  gold) until you tap it again. While held they combine with what you type next on
  the native keyboard, so you can build combos and selections:
  - tap **⌘**, then press **S** → Cmd-S (⌘ stays held — tap it again to release).
  - hold **⇧** then tap **→** repeatedly to extend a selection.
  - hold **⌘** and **⇧** together, then press **T** → Cmd-Shift-T.
- Backspace, return, and the native "delete word" gesture are all forwarded; the
  native keyboard's own shift/caps handles letter case.

## The trackpad

The app opens on the **Mouse** tab. It's a remote trackpad:

- **Drag** anywhere on the trackpad area to move the cursor (relative movement,
  like a laptop trackpad); **tap** it for a left click.
- A **scroll** strip down the side scrolls the wheel.
- **Left click** / **Right click** buttons below the pad. They are
  **press-and-hold**: the button stays down while you hold it, so you can hold a
  button and drag on the trackpad with another finger to drag-and-drop, then
  release to drop.
- A **sensitivity** slider at the top scales pointer speed (0.5–6×, default 2.5).

Moves and scrolls are coalesced client-side and sent on the same ~50 ms grid as
keystrokes, so a drag becomes a few summed deltas rather than a flood of
messages.

## How it works

Everything runs through macOS's `osascript`, in two different language modes.

**Keypresses** use AppleScript (the default mode):

```sh
osascript -e 'tell application "System Events" to key code 36'   # Enter
```

The server turns each keypress op into an AppleScript `keystroke` / `key code`
program (all of the op's actions in one `tell application` block) and runs
`osascript` once per op.

**Mouse** events use JXA — JavaScript for Automation — via `osascript -l
JavaScript`, because AppleScript has no clean way to move the cursor while JXA
can call CoreGraphics (Quartz Event Services: `CGEventCreateMouseEvent` etc.).
Spawning a JXA process per movement would be far too slow (~100 ms startup), so
the server keeps **one long-lived `osascript` helper** and streams
newline-delimited JSON commands to its stdin — fast enough to feel like a real
trackpad. (See `mouse.js`.)

## HTTP API

- `GET /` — the keyboard web app. (public)
- `GET /nonce` — issue a fresh nonce `{ nonce, ttlMs }`. (public)
- `POST /msg` — the single **authenticated + encrypted** action endpoint. Body is
  an envelope `{ iv, ct, mac }` (see below).

There is one action endpoint; the operation (keypress vs. mouse) lives in the
*encrypted* payload, so the URL never reveals what you sent.

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

pad(x)  = x + spaces, to a multiple of 256 bytes (JSON.parse ignores the spaces)
encKey  = SHA256("diy-mac-remote-enc:" + secret)
macKey  = SHA256("diy-mac-remote-mac:" + secret)
```

`o` is an **array** of ops: the client coalesces keystrokes pressed within a short
window into one message (see padding/batching below). The server verifies the MAC
over the ciphertext, decrypts, checks the nonce and counter, then runs the ops in
order.

## Security

`diy-mac-remote` gives you **authentication, replay protection, and
confidentiality** — everything except transport-level trust for your mobile app
interface.

So a simple eavesdropper in LAN can **NOT** read keystrokes or replay controls,
but if you have a compromised router in your LAN, and an Active Middle Man
attacker in your network when your phone loads the UI from the server, the
attacker can start operating your keyboard and mouse. You do not want that.

1. **Shared secret.** Stored in `~/.diy-mac-remote/secret` (auto-created, 32 hex
   chars, owner-only perms), kept in memory while running. Ownership and mode are
   **re-checked on every load** (ssh-style): the server refuses to use the secret
   if the file or its directory is owned by another user or is readable by group/
   other, rather than trusting whatever is on disk — so a stray process can't slip
   in a secret it knows, and a loosened-perms secret is rejected instead of used.
   The secret is **derived** from the pairing key the phone gets
   **out-of-band via the QR code** the server prints on startup, which encodes
   `http://host.local:PORT/#<key>` — a single high-entropy value. The `#fragment`
   is **never sent to the server**, so the pairing key stays off the wire; the page
   reads it from `location.hash`, derives the secret (and the token, item 5), and
   stores those in `localStorage`. (You can also paste the key — the app prompts if
   it has none.) Two subkeys are then derived from the secret (one for the cipher,
   one for the MAC).
2. **Confidentiality.** Every action is encrypted with **ChaCha20** before
   sending. A fresh random nonce per message means identical keystrokes never
   produce identical ciphertext, so an eavesdropper can't correlate or count
   repeats. The auth nonce + counter are *inside* the ciphertext too.
   - **Length hiding:** plaintext is padded with spaces to a multiple of 256
     bytes before encryption, so a single letter, a modifier combo, and a mouse
     move all look the same size on the wire (a stream cipher otherwise leaks length).
   - **Timing hiding (light):** sends are quantized to a ~50 ms grid and
     keystrokes in the same window are batched into one message, blurring precise
     inter-keystroke timing. (Full timing privacy would need constant-rate cover
     traffic; this is a deliberate light touch.)
3. **Authentication.** **Encrypt-then-MAC** with HMAC-SHA256 over the ciphertext;
   the server verifies the MAC *before* decrypting. The secret itself is never
   transmitted.
4. **Replay protection.** The server tracks the highest counter seen per nonce
   and rejects anything not strictly greater. Nonces are random 256-bit values,
   in-memory only (a restart invalidates old sessions), expire after 1 hour, and
   are capped to bound memory.
5. **Second-layer auth token (disk-read hardening).** The shared secret has to
   sit on disk in the clear — the server needs it to run the crypto — so anyone
   who can **read** the disk (or restores a backup of your home dir) gets the
   secret and could forge the crypto layer. A second-layer **token** guards against
   exactly that. First run mints one random **pairing key** (the `#<key>` in the
   QR) and derives from it, with two domain-separated one-way hashes, both the
   `secret` and the `token`. On disk it stores the `secret` and **only the SHA-256
   hash** of the token (`~/.diy-mac-remote/token.hash`, owner-only, perms enforced
   on load); the **pairing key itself is never written to disk** — persisting it
   would let a reader re-derive the token and defeat the layer. The phone keeps the
   pairing key, re-derives the token, and includes it (`"p"`) inside every encrypted
   message; the server hashes what it receives and compares — in constant time —
   against the stored hash. So a disk reader gets `secret` + `hash(token)`, **not**
   the token (and can't get it from the secret: `secret = H₁(key)` reveals nothing
   about `token = H₂(key)`, and the 128-bit key can't be brute-forced), so the
   server rejects every command. Deriving both from one key is purely so the QR
   stays small; it doesn't weaken the split. Because the server keeps only the
   secret + token hash, it can't reprint the pairing key on a later start: paired
   devices just reopen the app, and to pair a new device (or recover a lost pairing)
   you run `node server.js --reset-token`, which mints a fresh key + QR (all devices
   re-pair; note the secret rotates with it).
   - **What this covers:** offline theft of the disk or a backup — someone who
     ends up with your files but was never on your network still can't drive the
     Mac.
   - **What it does *not* cover:** an attacker who **also captured your live
     traffic** (the secret decrypts the token straight off the wire), or who can
     **read process memory** (both live there while running), or who can **write**
     the hash file (they'd just overwrite it — but such an attacker could overwrite
     the secret too). This is a hardening of the read-only-disk case, not a new
     trust boundary against an on-network attacker. For that, still use TLS/VPN.

**Backups.** Owner-only file permissions mean nothing on a mounted backup:
whoever restores a copy of your home directory reads `secret`, `token.hash`,
and (if you use option A) `key.pem` + `ca-key.pem` — enough to impersonate the
server to your phone. So the server and `gen-cert.sh` both mark
`~/.diy-mac-remote/` as **excluded from Time Machine** (`tmutil addexclusion`,
the sticky no-sudo form) whenever they touch it. Caveats, honestly stated:

- **Time Machine only.** Third-party backup tools (Backblaze, Arq, rsync
  scripts, disk clones) generally ignore the exclusion attribute — check your
  own tool, or exclude the directory there too.
- **Tailscale keeps its own keys** (its node key, and the Let's Encrypt private
  key if you use option B) in its own app data, which *is* backed up. Those are
  Tailscale's to manage — but unlike your CA key, a stolen node key can be
  revoked from the admin console.
- **Excluded means not restored.** After restoring a Mac from backup the server
  simply mints a fresh pairing on first run (scan the new QR to re-pair), and
  option A users re-run `./gen-cert.sh` and install the new CA once. That's the
  point: a restore is exactly the moment you want fresh keys, not old ones with
  an unknown number of copies.

**Crypto in the browser:** `crypto.subtle` (Web Crypto) is only available in a
secure context (HTTPS/localhost), which plain-HTTP LAN pages are not. So the page
ships small, test-vector-verified **pure-JS SHA-256 and ChaCha20** (inlined in
`index.html`), using native Web Crypto for hashing when it *is* available.

**Remaining caveat:** by default this is application-layer crypto over plain
HTTP, not TLS. It protects the *contents* of requests, but without a trusted
server certificate it can't stop an active man-in-the-middle who can rewrite the
page itself. For a trusted home LAN that's fine; to close the gap, serve it over
HTTPS — a self-signed cert you install on your phone, or Tailscale's HTTPS with
nothing to install — see [Serve it over HTTPS](#serve-it-over-https).

## Files

- `start.sh` — one-command launcher: runs `get-node.sh` if `./node` is missing,
  then starts the server with that Node (forwarding any arguments to `server.js`).
- `get-node.sh` — fetches an official Node.js build and verifies it against a
  SHA-256 checksum pinned in this repo before unpacking it into `./node`.
- `setup-https.sh` — pick how to serve over HTTPS: option A (self-signed) or
  option B (Tailscale HTTPS); see [Serve it over HTTPS](#serve-it-over-https).
- `gen-cert.sh` — option A's workhorse: makes a self-signed TLS certificate with
  `openssl` (already on macOS) and drops the CA + a how-to on your Desktop.
- `server.js` — HTTP/HTTPS server, routing, auth/crypto, static files.
- `executor.js` — turns key actions into AppleScript and runs `osascript`.
- `mouse.js` — long-lived JXA (`osascript -l JavaScript`) helper that posts
  CoreGraphics mouse-move / click / scroll events.
- `keys.js` — key-code and modifier maps.
- `chacha20.js` — pure-JS ChaCha20 (server side; an identical copy is inlined in
  the page so both ends interoperate).
- `public/index.html` — the mobile web keyboard (self-contained; inlines SHA-256,
  ChaCha20, HMAC, and the UI).
- `public/manifest.webmanifest`, `public/icon-*.png` — Home-Screen app metadata.
- `qr.js` — self-contained QR-code generator used to print the scan-to-connect
  QR on startup. Fixed to Version 5 / EC level L / byte mode (106 bytes max).
- `test/` — the test suite (see below). Zero dependencies, no framework.

## Tests

Run them with plain Node — there's nothing to install:

```sh
npm test          # or: node test/run.js
```

Like the rest of the project, the suite has **no dependencies and no framework** —
just a ~20-line runner (`test/harness.js`) over `node:assert`, so it's as
auditable as the code it checks. It covers the security-critical parts:

- **`chacha20.test.js`** — checks the pure-JS cipher against Node's *native*
  ChaCha20 (authoritative, can't be miscopied), the RFC 8439 keystream vector, and
  the encrypt/decrypt round-trip.
- **`parity.test.js`** — runs the page's *inlined* SHA-256, ChaCha20, and
  credential derivation in a sandbox and asserts they agree byte-for-byte with the
  server, so the two copies can't silently drift apart.
- **`pairing.test.js`** — drives the real server over HTTP the way the phone does:
  master-derivation, the token second layer (valid → 200, wrong/missing → 401),
  the **"the master is never written to disk"** invariant, owner-only file perms,
  restart behaviour, and `--reset-token` rotation.

## License

`diy-mac-remote` is released under the [MIT License](LICENSE).

This project has no third-party runtime dependencies.
