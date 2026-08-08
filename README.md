# diy-mac-remote — your iPhone as a **keyboard** and **trackpad** for your Mac, built and delivered by you.

<div align="center">
  <table>
    <tr>
      <td align="center"><img src="docs/image-trackpad.png" alt="The trackpad tab running on an iPhone" width="300"></td>
      <td align="center"><img src="docs/image-keyboard.png" alt="The keyboard tab running on an iPhone" width="300"></td>
    </tr>
    <tr>
      <td align="center"><b>The trackpad</b></td>
      <td align="center"><b>The keyboard</b></td>
    </tr>
  </table>
</div>

Letting something 🕹️ **control your Mac** means 🔐 **trusting whoever built it** —
and trusting that 🕵️ **_they_ haven't been hacked** either. So this project keeps that
list of trusted parties as short as possible: you build and deliver it
**yourself**, from readable sources.

There are two pieces: 💻 a small server that runs on your Mac (the [`app/`](app/)
folder, plain JavaScript with no dependencies at all), and 📱 a web page you open
on your iPhone (`public/index.html`, one self-contained file). No App Store app,
no compiled installer, ever — you get the source for both and decide how to ship
and run them, guided by the recipes here.

The server runs **inside macOS's own `osascript`**, which is how it types and
clicks without a compiler or a native module. All it needs from the outside is
something to hold the socket, and there are two ways to give it one — pick
either:

| Entrypoint                    | Needs                       | Speaks             |
| ----------------------------- | --------------------------- | ------------------ |
| [`server.js`](server.js) — `./start.sh`       | Node.js ([obtained safely](#get-a-secure-nodejs)) | HTTP **and** HTTPS |
| [`server.pl`](server.pl) — `./start-plain.sh` | nothing (Perl ships with macOS)                   | HTTP only          |

Same server, same pairing, same page — see
[Run it without Node.js](#run-it-without-nodejs).
Nothing is signed by us, hosted by us, or phoning home to us — once you've downloaded
the repo, there is no "us" in the loop.

And as a nice side effect: 🎁 no cost, no ads.

🔍 Don't take my word for it either. If you have an LLM agent, first download the
repository and ask your LLM to check the files for anything clever.

## Requirements

- 💻 A Mac and 📱 an iPhone, on the same network (but [VPN guides](#use-it-over-tailscale-vpn) also exist).
- The files of this repository on your Mac: [Get the source](#get-the-source).
- **Something to hold the socket** — either **Node.js**, which also brings HTTPS:
  [Get it securely](#get-a-secure-nodejs) — or **nothing at all**, over plain
  HTTP: [Run it without Node.js](#run-it-without-nodejs).
- **A secure connection between server and iPhone**: [Secure it](#securing-the-connection-between-server-and-iphone).
- **Accessibility permissions for the server**: [Grant them](#accessibility-permissions-for-the-server).

The sections below go in that order, and end with
[pairing the phone](#pair-the-phone-once) — once — and
[running it](#run-it-again), every time after that.

## Get the source

However you like — the repo doesn't care how it reached you:

- **Download the ZIP** from GitHub — the green _Code_ button → _Download ZIP_.
- If you know what git is, **`git clone`** from GitHub.
- **Copy it from a friend** who already has it, on a USB stick or over AirDrop.

**Where you put the folder does matter, though — keep it out of Desktop,
Documents and Downloads.** Your home folder (`~/diy-mac-remote`) is the easy
choice. macOS gates those three folders per app, and while your Terminal can
reach them, the [app bundle](#bundle-the-server-as-its-own-app) — which has a
permission identity of its own, deliberately — cannot, and refuses to start with
`Operation not permitted`. Nothing else in this README cares where the folder
lives, so this is the one moment to get it right; moving it later means
re-running `./bundle-app.sh` from the new place.

Then check what you got, because any of those routes could have handed you
altered files. The whole thing is small enough to be checked in minutes:

- **Ask an LLM agent.** If you have one (Claude Code, Codex, Copilot, …), point
  it at the folder and ask it plainly: _"Go through every file in this repo and
  tell me if anything here could harm me or my computer — hidden network calls,
  obfuscated code, shell commands that do more than they claim. Tell me if it
  is absolutely safe for me to run the commands suggested in the readme."_
- **Read it yourself.** [`app/main.js`](app/main.js) (routing, auth, what a
  request is allowed to do) and `public/index.html` (the whole phone side) are
  the two files that matter; `server.js` / `server.pl` are transports in front of
  the first one. All of it is plain, readable source with no build step and no
  dependencies to hide in.
- **Match it against GitHub — if you know git.** The strongest check, and the
  most technical. Clones only, not ZIPs; worth it for a copy from a friend:

  ```sh
  git remote -v                  # does origin point at the real GitHub repo?
  git status --short             # must print nothing: no edits on top of the commit
  git fetch origin
  git branch -r --contains HEAD  # must list origin/main
  ```

  The last line proves your exact code was published upstream, not edited along
  the way. Being _behind_ `origin/main` is fine; edits in `git status`, or a
  commit GitHub has never heard of, are not.

## Get a secure Node.js

Node.js runs `server.js`, the entrypoint that can serve **HTTPS** — the only
thing you need to install, and you don't install it by hand.
(Don't want it at all? [Run it without Node.js](#run-it-without-nodejs) — plain
HTTP, nothing to fetch.) [`ensure-node.sh`](ensure-node.sh) does it, and is safe
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
directory at all. [`server.pl`](server.pl) is core-Perl-only: no CPAN, no
modules to fetch, about 500 readable lines including its own JSON parser.

**It is the same server.** Both entrypoints start the identical backend and hand
it identical requests, so the pairing, the QR, the crypto, the keyboard and the
trackpad are the same code either way — the tests in [`test/`](test/) drive both
and assert they answer alike. You can switch between them freely: a phone paired
through one works through the other, as long as the address and scheme in its
pairing still match (see [HTTPS is not a mode](#https-is-not-a-mode)).

### What you give up: HTTPS

This path speaks **plain HTTP and only plain HTTP**. There is no certificate,
no `--tls`, nothing to install on the phone. That is a deliberate limit rather
than an omission — TLS in Perl needs a module macOS does not ship, and pulling
one in would undo the entire reason this path exists.

Your commands are still encrypted and authenticated by the app's own crypto
(ChaCha20 + HMAC, see [Security](#security)); what plain HTTP leaves open is an
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
  the Home Screen. [Pair the phone](#pair-the-phone-once) applies unchanged.
- **Stopping** — `./stop.sh` finds either entrypoint (and the backend exits by
  itself the moment its entrypoint is gone).
- **Modes** — `detect`, `wifi`, `tailscale`, a custom URL, `--reset-token`: all
  identical, see [Server modes](#server-modes). The TLS flags (`--tls`,
  `--no-tls`) are the only arguments that don't apply.
- **The app bundle** — `./bundle-app.sh --plain` builds
  `DIY Remote Server.app` around `start-plain.sh` instead of `start.sh`,
  including [starting it at login](#starting-it-at-login). Everything in
  [Bundle the server as its own app](#bundle-the-server-as-its-own-app) holds,
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

See [How it works](#how-it-works) for the whole picture.

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
app](#bundle-the-server-as-its-own-app): the Accessibility permission ends up
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
for five minutes", not as how you run it. See [Security](#security) for the full
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
ever loads it (see [Security](#security)). Serving the page over HTTPS closes
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

In Terminal, run [`install-self-signed.sh`](install-self-signed.sh) — it also
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
argument (this is [`gen-cert.sh`](gen-cert.sh) doing the work; arguments are
forwarded to it).

This writes four files into `~/.diy-mac-remote/` (owner-only, the same place
the pairing secret lives):

- `ca-cert.pem` — your CA. **This is the file you put on the iPhone.** It's public; it's safe to copy around.
- `ca-key.pem` — the CA's private key. Stays on the Mac, owner-only. Whoever holds this can mint certs your phone will trust, so don't copy it off the machine.
- `cert.pem` / `key.pem` — the server's certificate and private key, served automatically.

It then refreshes a `diy-mac-remote` folder on your Desktop (via
[`ensure-desktop-folder.sh`](ensure-desktop-folder.sh)) and opens it in Finder.
The folder holds everything the human side of the setup needs:

- `diy-mac-remote-ca.pem` — the CA, ready to AirDrop to the phone (only ever
  the public certificate — never a private key);
- `HOWTO-AIRDROP-CERT-TO-PHONE.html` — step-by-step install instructions,
  listing the exact names the current certificate is valid for;
- `start.command` — double-click to start the server (it points at `start.sh`
  wherever this repo lives);
- `stop.command` — double-click to stop it again, however you started it. A thin
  entry into [`stop.sh`](stop.sh), which finds the server by the pid file
  `start.sh` leaves in `~/.diy-mac-remote/`, or failing that by what's listening
  on the port — and checks it really is this repo's server before signalling it;
- `reset-app-secrets.command` / `reset-certificate.command` — double-click to
  reset the pairing or to mint a fresh CA + certificate. Both are thin entries
  into [`reset.sh`](reset.sh): they ask for confirmation first, and the reset
  takes effect when the server is next started;
- `DIY Remote Server.app` — the same server, wrapped in an app of its own so
  the Accessibility permission belongs to it rather than to your Terminal. The
  setup builds it here for you ([`bundle-app.sh`](bundle-app.sh)); it is how
  you start the server once the phone is paired — and it is registered to
  [start at every login](#starting-it-at-login) from then on, which
  `./bundle-app.sh --no-at-login` undoes. See
  [Bundle the server as its own app](#bundle-the-server-as-its-own-app).

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
[Pair the phone](#pair-the-phone-once). The key in that QR is shown this once
and never written to disk; if it isn't inside a Home Screen app before the
server restarts, the only way back in is resetting the pairing.

That's the whole reason this first run belongs in a terminal rather than a
double-click: a QR you can't see is a pairing you have to reset. Every start
after this one prints no QR, so `start.command` in the Desktop `diy-mac-remote`
folder — or the [app bundle](#bundle-the-server-as-its-own-app), which refuses
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
   [`install-tailscale.sh`](install-tailscale.sh) — it makes sure there's a
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
   Home Screen** — see [Pair the phone](#pair-the-phone-once). The QR is printed
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

1. [`gen-cert.sh --tailscale`](gen-cert.sh) — a CA and certificate covering both
   this Mac's `.local` name and its MagicDNS name, looked up for you.
2. [`ensure-node.sh`](ensure-node.sh) — make sure there's a Node.js to run on.
3. [`ensure-desktop-folder.sh`](ensure-desktop-folder.sh) — the Desktop folder,
   with `tailscale` mode baked into `start.command`.
4. [`bundle-app.sh tailscale`](bundle-app.sh) — `DIY Remote Server.app` in that
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
[pairing](#pair-the-phone-once) — once each.

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

## Accessibility permissions for the server

The server types and clicks by asking macOS to do it, through the
**Accessibility API** — the same door screen readers, window managers and macro
tools go through. macOS keeps that door shut by default, because whatever is
behind it can drive your Mac: press any key, click anywhere, in any app.

**What you do:** start the server and use the app. The first time it tries to
type, macOS shows a dialog asking for Accessibility. Say yes, or grant it by
hand under _System Settings → Privacy & Security → Accessibility_ — switch on
whatever asked (see below for what that is).

Answering that dialog is usually all there is to it. If input stays dead
afterwards, restart the server: the keyboard and the trackpad are driven from
one long-lived `osascript` process (see [How it works](#how-it-works)), and a
process that started before you granted the permission keeps running without it.

> **A second dialog asks to control _System Events_.** That one is the keyboard:
> keystrokes go through AppleScript, which is what lets any character be typed
> on any layout (see [How it works](#how-it-works)). Saying yes makes the
> keyboard work; saying no leaves you with a working trackpad and nothing typed.
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

## Pair the phone (once)

The first time you start the server it mints a **pairing key** and prints it as
a QR code. Scanning that QR and then saving the page to your Home Screen is the
whole of pairing — and it happens once, not every time you use the remote.

### 1. Scan the QR, in Safari

The QR (and the printed link) point at the server's address with the pairing key
appended as the `#fragment` (`#<key>`). That fragment never leaves the phone: the
page derives _two_ credentials from it — the secret that keys the crypto, and a
token the server only ever stores hashed (see [Security](#security)).

It has to be **Safari** — Chrome and Firefox on iOS can't add a page to the Home
Screen, and that next step isn't optional.

### 2. Add it to your Home Screen (full-screen)

`diy-mac-remote` ships an app icon and a web manifest, so the page becomes a real
Home Screen icon that launches full-screen with no Safari chrome — your own
hand-installed "app", no store required. It is also **where the pairing lives**:

1. With the scanned page open in **Safari**, tap the **Share** button → **Add to
   Home Screen** → **Add**.
2. Launch it from the new **Mac Remote** icon. It opens full-screen, already
   paired.

**Don't skip this step.** The pairing key is shown exactly once, because
it is never written to disk on the Mac — that's the point of it. After the
server restarts it is simply gone: the Mac kept only the derived secret and the
token's hash, so it has nothing left to print, and won't print a QR again. If
the key isn't safely inside a Home Screen app by then, the only way back in is
to reset the pairing and start over.

### 3. Close the terminal, and restart it the way you'll keep starting it

Pairing is done, and two things are worth doing right now — both of them about
not leaving a door open that you no longer need.

**Close that Terminal window.** The QR — and the link printed beside it — is the
pairing key, and pairing did not use it up: the phone derived its two
credentials from that key, and so can anything else that reads it afterwards.
The same secret, the same token, and the server cannot tell the two apart.
The Mac deliberately kept no copy ([Security](#security)), which means the
scrollback in that window is now the only copy in existence. Closing the window
is what ends it. `Cmd-K` clears the buffer first if you want to be thorough —
and it's worth knowing that Terminal's _reopen windows when logging back in_ can
otherwise bring that scrollback back after a restart.

**Then start the server the way you actually intend to start it** — the
[app bundle](#bundle-the-server-as-its-own-app), or `start.command` in the
Desktop `diy-mac-remote` folder — _before_ you let the phone type anything. The
first keystroke is when macOS asks for
[Accessibility](#accessibility-permissions-for-the-server), and the permission
goes to whatever is running the server at that moment. Grant it with the server
running from a terminal and it goes to **Terminal**, which means every program
you ever run from a terminal inherits the right to control your Mac. Grant it to
the app bundle and it covers this server and nothing else. It is the same single
click either way; only the size of what you handed over differs.

### Pairing again (a new phone, or a lost pairing)

Resetting the pairing is what mints a fresh key and prints a new QR. That's the
way to pair a **second** device, or to recover a phone whose Home Screen app was
deleted:

```sh
node server.js --reset-token   # rotate the pairing, print a fresh QR
perl server.pl --reset-token   # ...or the same, on the Node-free path
```

— or double-click `reset-app-secrets.command` in the Desktop `diy-mac-remote`
folder and restart the server; same effect. Either way the rotation is total:
**every** previously paired device loses its pairing and must scan the new QR
(delete the stale Home Screen app first, or you'll end up with two icons).

A fresh QR is a fresh live key, so it earns the same treatment as the first one:
once the new device is on its Home Screen, close the window that printed it
([step 3](#3-close-the-terminal-and-restart-it-the-way-youll-keep-starting-it)).

## Run it again

Everything above is setup you do once, pairing included. This is the short part
you actually repeat:

1. **On the Mac:** start the server — double-click **DIY Remote Server.app** in
   the Desktop `diy-mac-remote` folder (or one of the fallbacks below).
2. **On the iPhone:** tap the **Mac Remote** icon on your Home Screen.

Two icons, and that's all of it. **There is no QR to scan any more** — the Home
Screen app carries the pairing and the address with it. A restarted server
couldn't show you a pairing QR even if you wanted one; instead it prints a
reminder to open that app, and how to
[reset the pairing](#pairing-again-a-new-phone-or-a-lost-pairing) if the app is
gone.

**The app bundle is the way to start it day to day.** Every installer builds it
for you — it's sitting in the Desktop `diy-mac-remote` folder next to
`start.command`, and [`./bundle-app.sh`](bundle-app.sh) rebuilds it whenever you
want (see
[Bundle the server as its own app](#bundle-the-server-as-its-own-app)). From the
first install on, the double-click is all there is: it runs in the background
with no Dock icon and no Terminal window, with its mode baked in, and it holds the
Accessibility permission **on its own** instead of handing it to your Terminal
and everything you'll ever run there. Its output goes to
`~/.diy-mac-remote/server.log`. To stop it: double-click **stop.command** in the
same Desktop folder (or `./stop.sh` here). Quitting the app in Activity Monitor
is not the same thing — that stops the applet, and the server it started keeps
running.

**And after the first pairing, not even the double-click.** The app is
registered to [start when you log in](#starting-it-at-login) — a LaunchAgent
`bundle-app.sh` writes to `~/Library/LaunchAgents`, which starts nothing until
the phone is paired, and which `./bundle-app.sh --no-at-login` removes again.

**Without the bundle**, start it from the Desktop folder or the terminal
instead. [`start.sh`](start.sh) is the whole of the Mac side: it makes sure
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

Keep the Mac and the phone on the same Wi-Fi or tailnet, and keep the server
running — the phone loads the page from your Mac every time; nothing lives on
the phone but the icon and its stored pairing.

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
[`setup-https.sh`](setup-https.sh) writes there) and plain HTTP when they don't.
Request handling is identical either way — TLS only wraps the transport and
flips the advertised URL to `https://`. The flags just override the automatic
choice:

```sh
node server.js --tls         # require HTTPS: fail loudly if cert/key are missing
node server.js --no-tls      # force plain HTTP even when they exist
TLS_CERT=… TLS_KEY=… node server.js   # take the pair from somewhere else
```

**This is the one thing the two entrypoints don't share.** TLS lives in the
entrypoint, and [`server.pl`](server.pl) has none: it serves plain HTTP whether
or not a certificate exists on disk, and ignores these flags. If you have set
HTTPS up, `./start.sh` is the one to start it with.

**Where it does outrank the mode is `detect`.** With HTTPS on, if the
certificate covers your `.local` name but not your MagicDNS name — the default
[`gen-cert.sh`](gen-cert.sh) produces — `detect` advertises the `.local` name
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

## Bundle the server as its own app

**A guide for keeping the Accessibility grant narrow.** Instead of letting your
Terminal hold the permission, wrap the server in an app bundle that holds it
alone. Nothing about the code changes — the bundle runs the same `start.sh` (or
`start-plain.sh`, with `--plain`) in the same repo. What changes is the name in the Accessibility list, and what
else that name covers: nothing.

[`bundle-app.sh`](bundle-app.sh) builds it for you — and **the installers run it
for you**, with the right mode baked in, so on a fresh install the app already
exists and this section is background reading. Run it yourself to rebuild the
app after moving the repo, to change the baked-in mode, or to put it somewhere
else:

```sh
./bundle-app.sh                  # default server mode
./bundle-app.sh tailscale        # bake in a mode — arguments go to start.sh
./bundle-app.sh --dest ~/Apps    # put the bundle somewhere specific
./bundle-app.sh --no-at-login    # don't start it at login (and undo it if set)
./bundle-app.sh --plain          # wrap start-plain.sh — the Node-free path
./bundle-app.sh --quiet          # where it went, without the walkthrough
                                 #   (what the installers use)
```

`--plain` is the only one that changes what the app runs: `start-plain.sh`
instead of `start.sh`, so the app needs no Node.js either and skips the
`ensure-node.sh` step this script otherwise does first. Everything else in this
section is the same — including the login start. See
[Run it without Node.js](#run-it-without-nodejs).

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
  repo and the app is updated too. (Move the repo and you re-run
  `./bundle-app.sh`.)
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
  re-running** `./bundle-app.sh --dest <new folder>` — as does moving the
  **repo**, since the app is a wrapper pointing back at it.

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
because macOS lets an app _look at_ a file it may not _open_. `bundle-app.sh`
warns you at build time if it's building from such a folder, and the app puts
the same explanation in a dialog. The fix, in preference order:

```sh
mv ~/Desktop/diy-mac-remote ~/diy-mac-remote   # your home folder isn't gated
cd ~/diy-mac-remote && ./bundle-app.sh         # plus your mode, if any
```

Moving it asks macOS for nothing. If you'd rather leave the repo where it is,
add the app to _System Settings → Privacy & Security → Full Disk Access_
instead — a much wider grant than the one this whole section is about
narrowing, which is why it's the second choice.

Then:

1. **Pair from Terminal first** — `./start.sh`, scan the QR in Safari, **Add to
   Home Screen** ([Pair the phone](#pair-the-phone-once)). The app refuses to
   start an unpaired server on purpose: pairing prints a one-time key, the app
   has no terminal to print to, and putting that key in a log file would break
   the one rule the pairing key has ([never written to disk](#security)). It
   doesn't fail silently — it puts a **dialog** on screen explaining why, with
   an _Open Terminal_ button that opens one in the repo folder for you.
2. **Double-click the app.** It runs in the background and writes its output to
   `~/.diy-mac-remote/server.log` (owner-only, and inside the directory the
   server already keeps out of Time Machine). A normal restart can't reprint
   the pairing key, so that log holds no secrets — the refusal in step 1 is
   what keeps that true.
3. **Grant Accessibility to _DIY Remote Server_** when macOS asks. Then look at
   _System Settings → Privacy & Security → Accessibility_: if **Terminal** is
   switched on there from earlier runs, switch it off. Leaving it on keeps the
   wide grant you just went to the trouble of avoiding.
4. **To stop it:** pick _Stop server_ from the **⌨** in the menu bar. Or
   double-click `stop.command` in the Desktop `diy-mac-remote` folder, or run
   [`./stop.sh`](stop.sh). Quitting `diy-remote-server` in Activity Monitor is
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

**The server runs inside `osascript -l JavaScript`.** Everything that decides
anything — routing, the pairing, the crypto, which key to press — is in
[`app/`](app/), and `app/` runs in a single long-lived JXA process. An
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
[`test/unicode-probe.jxa.js`](test/unicode-probe.jxa.js) tries six of them —
`NSMutableData` buffers, a `Uint16Array`, three `ObjC.bindFunction`
re-declarations — and reports what each one did on your Mac. Run it if you want
to check whether a newer macOS has opened that door; if one ever does, the
clipboard path can go.

The price of `keystroke` is the permission: it goes through System Events, so
macOS asks for **Automation** as well as Accessibility. The mouse posts
CoreGraphics events directly and needs only Accessibility.

**The module loader.** `osascript` runs one script and has no `require()`, so
[`app/loader.js`](app/loader.js) provides one: read the file, evaluate it with
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
[`test/perl.test.js`](test/perl.test.js) holds the two implementations to the
same answers, byte for byte, and
[`app/protocol.js`](app/protocol.js) documents the format in full.

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

- `GET /` — the keyboard web app. (public)
- `GET /nonce` — issue a fresh nonce `{ nonce, ttlMs }`. (public)
- `POST /msg` — the single **authenticated + encrypted** action endpoint. Body is
  an envelope `{ iv, ct, mac }` (see below).

There is one action endpoint; the operation (keypress vs. mouse) lives in the
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
   repeats. The auth nonce + counter are _inside_ the ciphertext too.
   - **Length hiding:** plaintext is padded with spaces to a multiple of 256
     bytes before encryption, so a single letter, a modifier combo, and a mouse
     move all look the same size on the wire (a stream cipher otherwise leaks length).
   - **Timing hiding (light):** sends are quantized to a ~50 ms grid and
     keystrokes in the same window are batched into one message, blurring precise
     inter-keystroke timing. (Full timing privacy would need constant-rate cover
     traffic; this is a deliberate light touch.)
3. **Authentication.** **Encrypt-then-MAC** with HMAC-SHA256 over the ciphertext;
   the server verifies the MAC _before_ decrypting. The secret itself is never
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
   you run `node server.js --reset-token` (or `perl server.pl --reset-token`),
   which mints a fresh key + QR (all devices re-pair; note the secret rotates
   with it).
   - **What this covers:** offline theft of the disk or a backup — someone who
     ends up with your files but was never on your network still can't drive the
     Mac.
   - **What it does _not_ cover:** an attacker who **also captured your live
     traffic** (the secret decrypts the token straight off the wire), or who can
     **read process memory** (both live there while running), or who can **write**
     the hash file (they'd just overwrite it — but such an attacker could overwrite
     the secret too). This is a hardening of the read-only-disk case, not a new
     trust boundary against an on-network attacker. For that, still use TLS/VPN.

**Backups.** Owner-only file permissions mean nothing on a mounted backup:
whoever restores a copy of your home directory reads `secret`, `token.hash`,
and (if you use HTTPS) `key.pem` + `ca-key.pem` — enough to impersonate the
server to your phone. So the server and `gen-cert.sh` both mark
`~/.diy-mac-remote/` as **excluded from Time Machine** (`tmutil addexclusion`,
the sticky no-sudo form) whenever they touch it. Caveats, honestly stated:

- **Time Machine only.** Third-party backup tools (Backblaze, Arq, rsync
  scripts, disk clones) generally ignore the exclusion attribute — check your
  own tool, or exclude the directory there too.
- **Tailscale keeps its own keys** (its node key) in its own app data, which
  _is_ backed up. Those are Tailscale's to manage — but unlike your CA key, a
  stolen node key can be revoked from the admin console.
- **Excluded means not restored.** After restoring a Mac from backup the server
  simply mints a fresh pairing on first run (scan the new QR to re-pair), and
  HTTPS users re-run `./setup-https.sh` and install the new CA once. That's the
  point: a restore is exactly the moment you want fresh keys, not old ones with
  an unknown number of copies.

**Crypto in the browser:** `crypto.subtle` (Web Crypto) is only available in a
secure context (HTTPS/localhost), which plain-HTTP LAN pages are not. So the page
ships small, test-vector-verified **pure-JS SHA-256 and ChaCha20** (inlined in
`index.html`), using native Web Crypto for hashing when it _is_ available.

**And on the server, for the same reason.** The server runs inside
`osascript -l JavaScript`, where there is no `node:crypto` and no
`crypto.subtle` either — so `app/sha256.js`, `app/chacha20.js` and `app/bytes.js`
are the same hand-written primitives. Every one of them is checked against
Node's native implementation and against the page's copy on every test run
([`test/parity.test.js`](test/parity.test.js)), because three implementations
that disagree is the failure mode that matters here.

**Remaining caveat:** by default this is application-layer crypto over plain
HTTP, not TLS. It protects the _contents_ of requests, but without a trusted
server certificate it can't stop an active man-in-the-middle who can rewrite the
page itself. For a trusted home LAN that's fine; to close the gap, either
[serve it over HTTPS](#serve-it-over-https) — a self-signed cert you install on
your phone once — or put both devices on a VPN, which encrypts the link instead
of authenticating the page (see
[Use it over Tailscale](#use-it-over-tailscale-vpn) and
[what that gives up](#what-you-give-up-without-the-certificate)).

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
  [Serve it over HTTPS](#serve-it-over-https).
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
  [Both at once](#both-at-once-tailscale--certificate).
- `bundle-app.sh` — wraps the server in a `DIY Remote Server.app` bundle
  (`--plain` wraps `start-plain.sh` instead, for the Node-free path)
  (Info.plist, a readable shell-script launcher pointing back at this repo, an
  icon, an ad-hoc `codesign` signature) and puts it in the Desktop
  `diy-mac-remote` folder if it exists, else in Applications — so the
  Accessibility permission belongs to that app instead of to your Terminal.
  It also writes the LaunchAgent that
  [starts the app at login](#starting-it-at-login), unless you pass
  `--no-at-login`.
  Every installer ends by running it (`--quiet`), so it is normally only run by
  hand to rebuild; see
  [Bundle the server as its own app](#bundle-the-server-as-its-own-app).
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
  [Run it without Node.js](#run-it-without-nodejs).
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
  - `app/input.js` — actions to key/mouse events (and what to refuse).
  - `app/keys.js` — the key-code and modifier maps.
  - `app/netinfo.js` — `.local` / MagicDNS / LAN-IP detection and the address
    that goes into the QR.
  - `app/sys.js` — the platform interface; `app/sys-jxa.js` and
    `app/sys-node.js` are its two implementations (files, randomness,
    subprocesses, and the CoreGraphics keyboard + mouse).
  - `app/sha256.js`, `app/chacha20.js`, `app/bytes.js` — the crypto and the
    byte plumbing, hand-written because neither JavaScriptCore nor a plain-HTTP
    page has any (an identical copy is inlined in the page so both ends
    interoperate).
  - `app/qr.js` — self-contained QR-code generator used to print the
    scan-to-connect QR on startup. Fixed to Version 5 / EC level L / byte mode
    (106 bytes max).
  - `app/pathutil.js` — the handful of `node:path` functions the above need.
- `public/index.html` — the mobile web keyboard (self-contained; inlines SHA-256,
  ChaCha20, HMAC, and the UI).
- `public/manifest.webmanifest`, `public/icon-*.png` — Home-Screen app metadata.
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
  [`server.pl`](server.pl), plus keep-alive, a byte-for-byte PNG, and an
  oversized body refused. The two entrypoints are meant to be
  interchangeable; this is what says so.
- **`loader.test.js`** — the stand-in for the Mac. It loads every `app/` module
  the way `osascript` does — through the real
  [`app/loader.js`](app/loader.js), `new Function` and all — under a stub host
  that shares nothing with Node's, then mints a pairing and drives a signed
  `/msg` through it. If something under `app/` stops being loadable that way, or
  starts assuming Node, it fails here rather than on your Mac.
- **`input.test.js`** — the AppleScript a key action turns into, down to the
  exact program text: modifiers, key codes, capped delays, which characters take
  the clipboard route, and the invariant that makes injection impossible rather
  than unlikely — whatever the phone sends lands inside a quoted literal on
  exactly one line, and every other line is one this project wrote.
- **`protocol.test.js`** — the line protocol: that a value survives the trip
  whatever it holds, and that nothing a client can send — a newline, a stray
  percent sign, bytes that aren't text — can break the framing.

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

## License

`diy-mac-remote` is released under the [MIT License](LICENSE).

This project has no third-party runtime dependencies.
