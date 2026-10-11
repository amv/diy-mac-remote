# Setup options

The [quick start](../README.md#set-it-up) takes one path through the setup:
Node.js, your own certificate, and the app. This page has the others, and the
details of that one.

The server runs **inside macOS's own `osascript`**, which is how it types and
clicks without a compiler or a native module. All it needs from the outside is
something to hold the socket, and there are two ways to give it one — pick
either:

| Entrypoint                    | Needs                       | Speaks             |
| ----------------------------- | --------------------------- | ------------------ |
| [`server.js`](../server.js) — `./start.sh`       | Node.js ([obtained safely](#get-a-secure-nodejs)) | HTTP **and** HTTPS |
| [`server.pl`](../server.pl) — `./start-plain.sh` | nothing (Perl ships with macOS)                   | HTTP only          |

Same server, same pairing, same page — see
[Run it without Node.js](#run-it-without-nodejs).

## Get a secure Node.js

Node.js runs `server.js`, the entrypoint that can serve **HTTPS** — the only
thing you need to install, and you don't install it by hand.
(Don't want it at all? [Run it without Node.js](#run-it-without-nodejs) — plain
HTTP, nothing to fetch.) [`ensure-node.sh`](../ensure-node.sh) does it, and is safe
to run as often as you like:

```sh
./ensure-node.sh              # no-op if ./node/bin/node already works;
                              # else links your Node, or downloads + verifies one
./ensure-node.sh --download   # insist on the pinned, checksum-verified build
./node/bin/node --version     # v26.3.1 if downloaded; your own version if linked
```

If you already have Node.js (v18 or newer), it just symlinks it to
`./node/bin/node` so everything downstream uses one fixed path. Otherwise — or
with `--download`, if you'd rather not trust the copy on your machine — it
fetches an official build and checks it against a SHA-256 checksum **pinned in
this repository**, refusing to unpack anything on a mismatch. That's stronger
than trusting the checksum Node.js publishes alongside the download: if an
attacker controlled nodejs.org they could serve a malicious tarball _and_ a
matching checksum. By pinning the hash in this repo, fooling you requires
compromising **both** nodejs.org **and** this repository — the same "split your
trust" idea the rest of `diy-mac-remote` is built on.

> The download detects your Mac's CPU with `uname -m` and fetches the matching
> build — Apple Silicon (arm64) or Intel (x64). Once `./node` exists, use
> `./node/bin/node server.js` in place of `node server.js` below.

## Run it without Node.js

There is a second way in, and it needs nothing you don't already have:

```sh
./start-plain.sh              # perl holds the socket, osascript runs the server
./start-plain.sh tailscale    # same arguments as ./start.sh
```

**Perl ships with macOS. So does `osascript`.** Between them there is nothing
left to install, nothing to download, nothing to verify — and no `./node`
directory at all. [`server.pl`](../server.pl) is core-Perl-only: no CPAN, no
modules to fetch, about 500 readable lines including its own JSON parser.

**It is the same server.** Both entrypoints start the identical backend and hand
it identical requests, so the pairing, the QR, the crypto, the keyboard, the
trackpad and the media controls are the same code either way — the tests in [`test/`](../test/) drive both
and assert they answer alike. You can switch between them freely: a phone paired
through one works through the other, as long as the address and scheme in its
pairing still match (see [HTTPS is not a mode](#https-is-not-a-mode)).

### What you give up: HTTPS

This path speaks **plain HTTP and only plain HTTP**. There is no certificate,
no `--tls`, nothing to install on the phone. That is a deliberate limit rather
than an omission — TLS in Perl needs a module macOS does not ship, and pulling
one in would undo the entire reason this path exists.

Your commands are still encrypted and authenticated by the app's own crypto
(ChaCha20 + HMAC, see [Security](security.md)); what plain HTTP leaves open is an
**active** attacker on the network who can rewrite the page itself as it loads.
So use this path in one of the two situations where that gap is already closed:

- **Over Tailscale** — the recommended one. The tailnet encrypts and
  authenticates every packet between the phone and the Mac, so there is no
  local network left to be in the middle of. Pair with
  `./start-plain.sh tailscale`, and read
  [Use it over Tailscale](#use-it-over-tailscale-vpn) — including
  [what you give up without the certificate](#what-you-give-up-without-the-certificate),
  which applies here exactly as it does there.
- **On a network with no route to the internet** — an isolated lab, a workshop
  Wi-Fi with nothing else on it, a Mac and a phone on a router that goes
  nowhere. The threat the certificate answers is someone else on the wire; if
  there is provably nobody, there is nothing to answer.

On any ordinary home or office Wi-Fi, prefer `./start.sh` with a certificate:
[Serve it over HTTPS](#serve-it-over-https).

### Everything else works the same

- **Pairing** — first run prints the same QR: `./start-plain.sh`, scan, add to
  the Home Screen. [Pair the phone](pairing.md) applies unchanged.
- **Stopping** — `./stop.sh` finds either entrypoint (and the backend exits by
  itself the moment its entrypoint is gone).
- **Modes** — `detect`, `wifi`, `tailscale`, a custom URL, `--reset-token`: all
  identical, see [Server modes](#server-modes). The TLS flags (`--tls`,
  `--no-tls`) are the only arguments that don't apply.
- **The app bundle** — `./bundle-app.sh --plain` builds
  `DIY Remote Server.app` around `start-plain.sh` instead of `start.sh`,
  including [starting it at login](app-bundle.md#starting-it-at-login). Everything in
  [Bundle the server as its own app](app-bundle.md#bundle-the-server-as-its-own-app) holds,
  minus the Node.js download it otherwise does first.
- **The installers** (`install-self-signed.sh`, `install-tailscale.sh`, …) are
  the Node path: they set up certificates and the Desktop folder, and they run
  `ensure-node.sh`. The Node-free path is driven from the Terminal, plus
  `./bundle-app.sh --plain` if you want the app and the login start.

### How it manages that

`osascript -l JavaScript` — JavaScript for Automation, JXA — is a full
JavaScript engine that can call macOS frameworks. That is how the mouse has
always worked here. This project now runs the **whole server** in there, so the
part that needs Node.js shrinks to "accept a TCP connection, parse HTTP, read a
file", which Perl does out of the box. The entrypoint serves `public/` itself
and asks the backend about the two requests that need a secret:

```
iPhone ⇄ HTTP ⇄ server.pl (or server.js) ─ public/ ─▶ straight off disk
                                         └ /nonce, /msg ─▶ osascript -l JavaScript
                                                           └── app/  pairing, crypto,
                                                                     CGEvent keyboard
                                                                     and mouse
```

What passes between them is `key: value` lines, blank line ends the message —
no JSON, no framing, nothing to parse. That is small enough that `server.pl`
needs no modules beyond what Perl ships with, and readable enough to follow by
eye when something is wrong.

See [How it works](how-it-works.md) for the whole picture.

## Securing the connection between server and iPhone

Once the server is running, whatever your phone loads that page from can type on
your Mac. The commands themselves are already encrypted and authenticated (ChaCha20 +
HMAC) before they leave the phone, so someone merely _listening_ on the network
learns nothing. The gap is someone who can **rewrite the page** on its way to
your phone — a compromised router, a hostile Wi-Fi. Swap in their own JavaScript
and the encryption is theirs too, along with your keyboard.

So close it, one of two ways:

|                            | [HTTPS certificate](#serve-it-over-https)             | [VPN / Tailscale](#use-it-over-tailscale-vpn)                       |
| -------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| **How it protects you**    | your phone refuses any page not signed by your own CA | the link itself is encrypted end to end, so nobody is in the middle |
| **Effort**                 | run a script, AirDrop a profile, trust it once        | install an app on both devices, sign in                             |
| **New parties to trust**   | none — you make the certificate yourself              | Tailscale                                                           |
| **Works off your own LAN** | no                                                    | yes                                                                 |
| **The one command**        | `./install-self-signed.sh`                            | `./install-tailscale.sh`                                            |

Both are real answers, and they stack — that's `./install-tailscale-self-signed.sh`,
which sets up both at once and is the strongest of the three (the VPN's reach
_plus_ the certificate's second layer). Taken alone, the certificate is the purer
fit for this project's "trust nobody" idea; the VPN is far less fiddly and
reaches further. Before taking the VPN on its own, read
[what you give up without the certificate](#what-you-give-up-without-the-certificate)
— it's short, and it's the honest version.

Each installer is described in the section it belongs to, and they all do the
same four things — certificate (where applicable), Node.js, a Desktop folder
with a `start.command` that has the right mode baked in, and
**`DIY Remote Server.app`** in that same folder ([why an
app](app-bundle.md#bundle-the-server-as-its-own-app): the Accessibility permission ends up
belonging to it instead of to your Terminal). **You run these yourself, in
Terminal**, from the folder you unpacked: there is nothing to double-click yet,
and this is the part you want to be able to watch.

| Installer                            | Sets up                                      | Described in                                         |
| ------------------------------------ | -------------------------------------------- | ---------------------------------------------------- |
| `./install-self-signed.sh`           | certificate                                  | [Serve it over HTTPS](#1-run-the-setup-on-the-mac)   |
| `./install-tailscale.sh`             | Tailscale mode                               | [Use it over Tailscale](#use-it-over-tailscale-vpn)  |
| `./install-tailscale-self-signed.sh` | both — certificate covering the tailnet name | [Both at once](#both-at-once-tailscale--certificate) |

**Doing neither also works**, and the control traffic stays encrypted, but the
page-rewrite gap above stays wide open. Almost nobody can actually verify their
router isn't compromised, so treat plain HTTP as "trying it out on my own Wi-Fi
for five minutes", not as how you run it. See [Security](security.md) for the full
threat model.

## Serve it over HTTPS

**One of the two ways to secure the connection**, the other being
[Tailscale](#use-it-over-tailscale-vpn). This one is more work — a script to run
and a profile to AirDrop and trust — but it adds nobody to your list of trusted
parties: you generate the certificate on your own Mac with tools already on
macOS, and hand it to your own phone.

By default `diy-mac-remote` runs over plain HTTP, and that is deliberately safe
against a _passive_ eavesdropper: every keystroke is already encrypted and
authenticated (ChaCha20 + HMAC) before it leaves the phone. What plain HTTP does
**not** protect against is an _active_ man-in-the-middle on a router you don't
control — someone positioned to rewrite the web page itself before your phone
ever loads it (see [Security](security.md)). Serving the page over HTTPS closes
that last gap: the phone refuses any page that isn't served under a certificate
it trusts. As a bonus, an HTTPS page is a browser **"secure context"**, so the
native `crypto.subtle` becomes available and the page uses it for faster hashing
instead of the bundled pure-JS fallback.

(Not the only way to close it: putting both devices on a
[tailnet](#use-it-over-tailscale-vpn) closes it too, and that one needs no
certificate — and no Node.js either, see
[Run it without Node.js](#run-it-without-nodejs).)

HTTPS here means a **self-signed certificate**, using only tools already on
macOS (`openssl`). No download, no accounts, fully offline — nothing to trust
but yourself. You set up a tiny private Certificate Authority (CA) that lives
only on your Mac, install it on your iPhone **once**, and from then on your
phone trusts the server.

The CA is **name-constrained**: baked into the certificate you install is the
list of names it may ever vouch for — by default exactly one, this Mac's
`.local` name — and iOS enforces that list. Installing a homemade CA normally
means trusting it for the _whole web_; this one can never speak for
`gmail.com`, only for your Mac. (See "What you're trusting" below.)

### 1. Run the setup (on the Mac)

In Terminal, run [`install-self-signed.sh`](../install-self-signed.sh) — it also
sets up Node.js in the background (see
[Get a secure Node.js](#get-a-secure-nodejs)) — or do
the certificate part on its own:

```sh
./install-self-signed.sh               # the whole setup, Node.js included
./setup-https.sh                       # certificate + Desktop folder + the app
./setup-https.sh mymac.local 10.0.0.9  # ...plus any extra name/IP the phone will use
./setup-https.sh --tailscale           # ...plus this Mac's MagicDNS name, looked up
```

Pass `--tailscale` if you might ever reach the Mac over your tailnet: it finds
this Mac's MagicDNS name and adds it, so you don't have to type
`mymac.tail9f2c.ts.net` correctly from memory. **Decide this now if you can** —
adding a name later usually means a new CA and re-installing the profile on the
phone (see [Notes and caveats](#notes-and-caveats)). The installers forward
their arguments here, so `./install-self-signed.sh --tailscale` works too; if
you want the Tailscale path proper, with its mode baked into the Desktop
`start.command`, use
[`./install-tailscale-self-signed.sh`](#both-at-once-tailscale--certificate)
instead.

(The installers are plain shell scripts on purpose: macOS refuses to run a
_downloaded_ `.command` file from Finder. The `start.command` this run
generates on your Desktop is created locally on your Mac, so double-clicking
that is fine.)

By default the certificate covers **only the Mac's `.local` address** — no
localhost, no LAN IPs, no Tailscale names — because that's the one stable
address your phone uses on the Wi-Fi, and a narrow certificate keeps the CA's
reach narrow too. A certificate is only valid for the names baked into it, so
if your phone will reach the Mac by some _other_ address, pass it as an
argument (this is [`gen-cert.sh`](../gen-cert.sh) doing the work; arguments are
forwarded to it).

This writes four files into `~/.diy-mac-remote/` (owner-only, the same place
the pairing secret lives):

- `ca-cert.pem` — your CA. **This is the file you put on the iPhone.** It's public; it's safe to copy around.
- `ca-key.pem` — the CA's private key. Stays on the Mac, owner-only. Whoever holds this can mint certs your phone will trust, so don't copy it off the machine.
- `cert.pem` / `key.pem` — the server's certificate and private key, served automatically.

It then refreshes a `diy-mac-remote` folder on your Desktop (via
[`ensure-desktop-folder.sh`](../ensure-desktop-folder.sh)) and opens it in Finder.
The folder holds everything the human side of the setup needs:

- `diy-mac-remote-ca.pem` — the CA, ready to AirDrop to the phone (only ever
  the public certificate — never a private key);
- `HOWTO-AIRDROP-CERT-TO-PHONE.html` — step-by-step install instructions,
  listing the exact names the current certificate is valid for;
- `start.command` — double-click to start the server (it points at `start.sh`
  wherever this repo lives);
- `stop.command` — double-click to stop it again, however you started it. A thin
  entry into [`stop.sh`](../stop.sh), which finds the server by the pid file
  `start.sh` leaves in `~/.diy-mac-remote/`, or failing that by what's listening
  on the port — and checks it really is this repo's server before signalling it;
- `reset-app-secrets.command` / `reset-certificate.command` — double-click to
  reset the pairing or to mint a fresh CA + certificate. Both are thin entries
  into [`reset.sh`](../reset.sh): they ask for confirmation first, and the reset
  takes effect when the server is next started;
- `DIY Remote Server.app` — the same server, wrapped in an app of its own so
  the Accessibility permission belongs to it rather than to your Terminal. The
  setup builds it here for you ([`bundle-app.sh`](../bundle-app.sh)); it is how
  you start the server once the phone is paired — and it is registered to
  [start at every login](app-bundle.md#starting-it-at-login) from then on, which
  `./bundle-app.sh --no-at-login` undoes. See
  [Bundle the server as its own app](app-bundle.md#bundle-the-server-as-its-own-app).

### 2. Install and trust the CA on the iPhone (once)

You need to get the CA onto the phone and then flip **two** switches —
installing a certificate and _trusting_ it are separate steps on iOS. The
`HOWTO-AIRDROP-CERT-TO-PHONE.html` in the Desktop folder walks you through
exactly this:

1. **Get the file onto the phone.** In the Desktop folder, right-click
   `diy-mac-remote-ca.pem` → **Share → AirDrop** → your iPhone. (If AirDrop
   doesn't offer to install it, email the file to yourself and open it in the
   Mail app instead. Some iOS versions are fussy about the extension — if so,
   rename the copy to `diy-mac-remote-ca.crt` and send that.)
2. iOS says **"Profile Downloaded"**. Open **Settings** → it shows **Profile
   Downloaded** near the top (or go to **Settings → General → VPN & Device
   Management**).
3. Tap the **diy-mac-remote local CA** profile → **Install** (enter your
   passcode) → **Install** again to confirm.
4. **Now trust it** — this is the step people miss. Go to **Settings → General →
   About → Certificate Trust Settings**. Under **Enable Full Trust for Root
   Certificates**, turn **ON** the switch for **diy-mac-remote local CA**.

### 3. Start the server

**Start it in Terminal this first time**, where you can watch it. Nothing new to
type — the server serves HTTPS automatically as soon as the certificate files
exist, and the printed QR/link switches to `https://`:

```sh
./start.sh
```

**If it prints a QR code — and on a first setup it will — that's the pairing,
so deal with it now.** Scan it in **Safari** (no warning, a padlock), then
**Add to Home Screen**, both steps, as described in
[Pair the phone](pairing.md). The key in that QR is shown this once
and never written to disk; if it isn't inside a Home Screen app before the
server restarts, the only way back in is resetting the pairing.

That's the whole reason this first run belongs in a terminal rather than a
double-click: a QR you can't see is a pairing you have to reset. Every start
after this one prints no QR, so `start.command` in the Desktop `diy-mac-remote`
folder — or the [app bundle](app-bundle.md#bundle-the-server-as-its-own-app), which refuses
to start unpaired for exactly this reason — is the way to do it from then on.

To temporarily go back to plain HTTP, start with `--no-tls`. To _require_ HTTPS
(fail loudly if the cert is missing rather than silently falling back), use
`--tls`.

### Notes and caveats

- **Re-running is always safe**, and never costs you a reinstall _as long as the
  names don't change_. `./setup-https.sh` (or `./install-self-signed.sh`) mints
  a fresh server certificate and refreshes the Desktop folder while reusing the
  CA, so the phone keeps trusting the result.
- **Adding a name the CA has never heard of needs a new CA.** This is the one
  re-run that can't be free: the CA is name-constrained to the names it was born
  with, so it cannot vouch for a new one — a renamed Mac, or (much more often)
  the Tailscale name you didn't ask for the first time. The script mints the
  certificate, validates it against your CA exactly as the phone will, and when
  that fails it refuses, leaves your existing files untouched, and prints the
  two commands that mint a fresh CA. The cost is installing and trusting the new
  profile on the phone once. **Cheapest fix: name everything up front** —
  `./setup-https.sh --tailscale` if a tailnet is even a maybe.
- **The certificate names only the `.local` address by default**, so reach the
  Mac by that name. IP churn doesn't matter (there are no IPs in the
  certificate), and the `.local` name is stable. For any other address — a raw
  IP, a MagicDNS name — pass it explicitly; the server warns at startup if it's
  about to advertise an address the certificate doesn't cover.
- **HTTPS + Tailscale mode:** with the default `.local`-only certificate, the
  `detect` mode advertises the `.local` name even when a tailnet is up (a QR the
  phone would refuse helps nobody). Explicit `./start.sh tailscale` isn't
  overridden — it pairs against the MagicDNS name and warns that the certificate
  doesn't cover it, which the phone will act on by refusing the page. So put the
  name in the certificate first: `./setup-https.sh --tailscale`.
- **Untrusting it later:** delete the profile on the phone under **Settings →
  General → VPN & Device Management**, or turn its switch back off under
  **Certificate Trust Settings**.
- **What you're trusting:** the CA private key never leaves your Mac and is
  owner-only. Anyone who both steals `ca-key.pem` _and_ can position themselves as
  a man-in-the-middle on your network could forge a page your phone accepts — so
  treat `ca-key.pem` like the pairing secret. For the home-LAN threat model this
  is exactly the transport trust that plain HTTP was missing. Thanks to the name
  constraints, that is also the _worst_ case: a stolen CA key can impersonate
  this Mac's addresses to your phone, never the rest of the web — so trusting
  this CA does not put your general browsing in one file's hands.
- This does not replace any of the app-layer crypto; it's defence-in-depth on top
  of it.

## Use it over Tailscale (VPN)

The other way to secure the connection, and the less fiddly one: no certificate
to generate, nothing to AirDrop, no profile to trust on the phone. Both devices
join a small private network of their own, and everything between them is
encrypted end to end by WireGuard. It also works when the two devices _aren't_ on
the same local network — your phone on cellular, you away from home, a guest
Wi-Fi that keeps devices from seeing each other — which the certificate path
can't do on its own. [Tailscale](https://tailscale.com) is the easiest one to
set up: free for personal use, no port forwarding, no router configuration.

The encryption itself is plain [WireGuard](https://www.wireguard.com) — Tailscale
doesn't replace it, it wraps it. You can run WireGuard directly instead, and it's
the option with nobody else in the loop: you generate the keypairs yourself, put
each device's public key in the other's config by hand, and no third party ever
learns which key belongs to which machine. The cost is that everything Tailscale
does for you becomes yours to do — a reachable endpoint (port forwarding on your
router, or a small VPS to relay through), NAT traversal, key rotation, and a
fresh config edit on both devices every time you add one. If you already run
WireGuard, skip Tailscale entirely — start the server with your Mac's tunnel
address so it both binds and advertises only that interface:

```sh
HOST=10.0.0.1 ./start.sh http://10.0.0.1:8765/     # your WireGuard address
```

The steps below are for everyone else.

1. Install Tailscale on **both** your Mac and your iPhone, and sign in to the
   same account on each.
2. On the Mac, **in Terminal**, run
   [`install-tailscale.sh`](../install-tailscale.sh) — it makes sure there's a
   Node.js to run on and puts a double-clickable `start.command`, plus
   `DIY Remote Server.app`, into a `diy-mac-remote` folder on your Desktop.
   Both have `tailscale` mode baked in, so a double-click can never accidentally
   start the server in a less strict mode. (Or just run `./start.sh tailscale`.)
   To take the certificate as well — recommended, and cheapest decided now —
   run [`install-tailscale-self-signed.sh`](#both-at-once-tailscale--certificate)
   instead of this one. To take **no Node.js** instead, run
   `./start-plain.sh tailscale` and skip the installer: the tailnet is doing the
   transport security here anyway, which is what makes that pairing sound
   ([Run it without Node.js](#run-it-without-nodejs)).
3. Scan the QR code with your iPhone, in **Safari**, and then **Add it to your
   Home Screen** — see [Pair the phone](pairing.md). The QR is printed
   only on that first run, and the Home Screen app is what remembers the
   pairing; without it you'd have to reset the pairing to get a new one.

### What you give up without the certificate

Read this before choosing. Tailscale does cover the attack the certificate
exists to stop: with WireGuard between the two devices, nobody on your Wi-Fi,
your router, or your ISP can read or rewrite the page on its way to your phone.
What changes is **who** you're relying on for that, and what's left if they fail.

- **Tailscale becomes a trusted party.** The traffic is end-to-end encrypted,
  but Tailscale's coordination server is what tells your two devices which
  public keys belong to each other. Someone who controls that server — or who
  gets into your Tailscale account — can enrol a device or swap a key, and your
  phone will talk to it believing it's your Mac. From there they serve their own
  page and own every keystroke. Tailscale's
  [tailnet lock](https://tailscale.com/kb/1226/tailnet-lock) closes this by
  pinning key changes to keys you hold; without it, the certificate path is the
  one with nobody to compromise.
- **There is no second layer.** With the certificate installed, an attacker who
  pulled off the above still hits a wall: the phone rejects any page not signed
  by your CA. Without it, the VPN is the only thing standing between an attacker
  and a keylogger running on your Mac. This is the real cost — not that Tailscale
  is weak, but that it's alone.
- **Anything that puts you back on plain LAN exposes you completely.** What the
  phone uses is the address baked into its Home Screen app at pairing time, so
  this is decided when you pair, once: pair with `./start.sh tailscale` (which
  `install-tailscale.sh` bakes in for you) and the app holds your MagicDNS name
  for good. Pair with plain `./start.sh` and `detect` may well hand it a LAN
  address instead — which it will then keep using, VPN or no VPN.
- **No browser secure context**, so `crypto.subtle` stays unavailable and the
  page falls back to its bundled pure-JS SHA-256 and ChaCha20. They're
  test-vector-verified and fine, just slower.

### Both at once (Tailscale + certificate)

Every cost above is answered by adding the certificate back, and there's one
command for it — in Terminal, like the other two installers:

```sh
./install-tailscale-self-signed.sh        # needs Tailscale running on this Mac
```

It is the strongest setup this project offers: WireGuard carries the traffic
_and_ your phone refuses any page not signed by your own CA, so neither one is
alone. Doing it by hand is fiddly for a single reason — the certificate has to
name the MagicDNS name, and that has to be decided before the CA goes on the
phone — so the script settles that for you:

1. [`gen-cert.sh --tailscale`](../gen-cert.sh) — a CA and certificate covering both
   this Mac's `.local` name and its MagicDNS name, looked up for you.
2. [`ensure-node.sh`](../ensure-node.sh) — make sure there's a Node.js to run on.
3. [`ensure-desktop-folder.sh`](../ensure-desktop-folder.sh) — the Desktop folder,
   with `tailscale` mode baked into `start.command`.
4. [`bundle-app.sh tailscale`](../bundle-app.sh) — `DIY Remote Server.app` in that
   folder too, same mode, so the Accessibility permission lands on the app.

It needs a live tailnet, because step 1 can't name an address that doesn't exist
yet. Without one it stops before touching anything and says so. Extra arguments
are forwarded to `gen-cert.sh`, so you can name further addresses.

**Run it before installing the CA on the phone if you can.** Adding the MagicDNS
name to a CA that already exists means minting a new CA and installing the
profile on the phone again — see [Notes and caveats](#notes-and-caveats). Going
this way from the start costs one profile install, same as either path alone.

From there the phone needs Tailscale, the CA installed and trusted
([step 2](#2-install-and-trust-the-ca-on-the-iphone-once)), and then
[pairing](pairing.md) — once each.

### No source filtering

**The server does not filter by source address.** It listens on all interfaces
in every mode, and a request is judged only by whether it carries the pairing
credentials — not by the network it arrived on. Tailscale mode is about which
address goes into the pairing QR, not about who may connect. If you want the
server to answer on one interface only, bind it there: `HOST=<addr> ./start.sh`.

What that costs is worth being clear about: anyone who can reach the port gets
as far as the page and the unauthenticated `/nonce` endpoint. They cannot type
on your Mac — every command is authenticated and encrypted — but they can knock.
The reason it's left this way is that a source filter is a second, weaker copy
of a decision the crypto already makes correctly, and it brought real costs:
`detect` could silently drop it because of a certificate detail, and a server
started before Tailscale came up refused to run at all.

## Starting it without the app

**Without the bundle**, start it from the Desktop folder or the terminal
instead. [`start.sh`](../start.sh) is the whole of the Mac side: it makes sure
there's a Node.js to run on (`ensure-node.sh`, a no-op when there already is)
and starts the server.

```sh
./start.sh                # ensures ./node, then runs the server
./start.sh tailscale      # any arguments are forwarded to server.js
./start-plain.sh          # the same server with no Node.js at all (plain HTTP)
```

Either way, start it the way you secured it: plain `./start.sh` on the
[certificate path](#serve-it-over-https) — it serves HTTPS by itself as soon as
the certificate files exist — and `./start.sh tailscale` on the
[VPN path](#use-it-over-tailscale-vpn). If you ran either installer, the
`start.command` in your Desktop `diy-mac-remote` folder already has the right
mode baked in, so a double-click can't start it in a weaker one — and
`./bundle-app.sh tailscale` bakes the same mode into the app.

### Server modes

The mode decides which address goes into the pairing QR — and that is all it
does. The server always listens on `PORT` (8765 by default) on every interface,
whatever the mode:

```sh
node server.js               # detect (default): try tailscale first, then wifi
node server.js wifi          # try only the Mac .local mDNS address
node server.js tailscale     # try only the Tailscale MagicDNS name
PORT=8700 node server.js http://192.168.0.2:8700 # custom URL verbatim
node server.js --reset-token # rotate the auth token + print a fresh pairing QR
```

The [Node-free entrypoint](#run-it-without-nodejs) takes exactly the same
arguments — `perl server.pl tailscale`, `./start-plain.sh --reset-token`, and so
on. Only the TLS flags below are Node-only.

**On a restart the mode does nothing at all**, because no address is resolved or
printed — the paired app has one. So it only matters on a pairing run, and there
it matters permanently: the address in the QR is the one the phone keeps.
`tailscale` is the strict one — asked to pair over the tailnet with no tailnet
up, it refuses rather than quietly pairing your phone to a LAN address it would
then keep using. `detect` will take that LAN address without asking, which is
fine behind the certificate and not on its own (see
[Securing the connection](#securing-the-connection-between-server-and-iphone)).

### HTTPS is not a mode

It's automatic and orthogonal: the server serves HTTPS whenever a certificate
and key exist (`cert.pem` / `key.pem` in `~/.diy-mac-remote/`, which
[`setup-https.sh`](../setup-https.sh) writes there) and plain HTTP when they don't.
Request handling is identical either way — TLS only wraps the transport and
flips the advertised URL to `https://`. The flags just override the automatic
choice:

```sh
node server.js --tls         # require HTTPS: fail loudly if cert/key are missing
node server.js --no-tls      # force plain HTTP even when they exist
TLS_CERT=… TLS_KEY=… node server.js   # take the pair from somewhere else
```

**This is the one thing the two entrypoints don't share.** TLS lives in the
entrypoint, and [`server.pl`](../server.pl) has none: it serves plain HTTP whether
or not a certificate exists on disk, and ignores these flags. If you have set
HTTPS up, `./start.sh` is the one to start it with.

**Where it does outrank the mode is `detect`.** With HTTPS on, if the
certificate covers your `.local` name but not your MagicDNS name — the default
[`gen-cert.sh`](../gen-cert.sh) produces — `detect` advertises the `.local` name
even when a tailnet is up, because a QR the phone would refuse helps nobody.
Explicit `./start.sh tailscale` is _not_ overridden: it pairs against the
MagicDNS name and warns that the certificate doesn't cover it. Either way the
fix is the same — `./setup-https.sh --tailscale`, which looks the name up and
adds it.

**And the scheme is part of the pairing.** The QR carries a whole URL, so
`http://` or `https://` is baked into the Home Screen app along with the
address. Turning HTTPS on — or off — after pairing breaks an already-paired
phone: it keeps asking for a scheme the server no longer speaks, and the way
back is a fresh pairing. Set the transport up the way you want it _before_ you
pair, not after.
