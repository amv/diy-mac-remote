# Security

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
([`test/parity.test.js`](../test/parity.test.js)), because three implementations
that disagree is the failure mode that matters here.

**Remaining caveat:** by default this is application-layer crypto over plain
HTTP, not TLS. It protects the _contents_ of requests, but without a trusted
server certificate it can't stop an active man-in-the-middle who can rewrite the
page itself. For a trusted home LAN that's fine; to close the gap, either
[serve it over HTTPS](setup-options.md#serve-it-over-https) — a self-signed cert you install on
your phone once — or put both devices on a VPN, which encrypts the link instead
of authenticating the page (see
[Use it over Tailscale](setup-options.md#use-it-over-tailscale-vpn) and
[what that gives up](setup-options.md#what-you-give-up-without-the-certificate)).
