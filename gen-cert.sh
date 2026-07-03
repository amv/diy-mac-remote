#!/bin/sh
#
# gen-cert.sh — make a self-signed TLS certificate for diy-mac-remote using only
# tools that already ship with macOS (openssl / LibreSSL).
#
# Why you might want this
# -----------------------
# The app already encrypts and authenticates every keystroke (ChaCha20 +
# HMAC), so plain HTTP is safe against a passive eavesdropper. What plain HTTP
# does NOT stop is an *active* man-in-the-middle on an untrusted router, who
# could rewrite the web page itself before your phone ever loads it. Serving the
# page over HTTPS with a certificate your phone trusts closes that gap — the
# phone refuses any page that isn't signed by your certificate. As a bonus,
# HTTPS makes the page a "secure context", so the browser's native `crypto.subtle`
# becomes available (faster hashing than the bundled pure-JS fallback).
#
# What this makes
# ---------------
# A small private Certificate Authority (CA) that lives only on your Mac, plus a
# leaf certificate for this server signed by that CA:
#
#   ~/.diy-mac-remote/ca-cert.pem   <- install THIS on your iPhone (public, safe to copy)
#   ~/.diy-mac-remote/ca-key.pem    <- the CA private key (owner-only, never leaves the Mac)
#   ~/.diy-mac-remote/cert.pem      <- server cert chain (leaf + CA), served by the server
#   ~/.diy-mac-remote/key.pem       <- server private key (owner-only)
#
# You install ca-cert.pem on the iPhone ONCE (see README > "Serve it over
# HTTPS"). After that you can re-run this script any time — e.g. your LAN IP
# changed — to mint a fresh leaf cert, and the phone keeps trusting it because
# it still chains up to the same CA. The CA is only regenerated if it's missing.
#
# Usage
# -----
#   ./gen-cert.sh                 # auto-detect this Mac's names/IPs
#   ./gen-cert.sh foo.local 10.0.0.9   # ...plus any extra names/IPs you name
#
# Every argument is added to the certificate as an extra Subject Alternative
# Name (arguments that look like an IP address are added as IPs, otherwise as
# DNS names). The certificate is only valid for the names/IPs baked into it, so
# add whatever address your phone will actually use to reach the Mac.

set -eu

DIR="${DIY_MAC_REMOTE_DIR:-$HOME/.diy-mac-remote}"
CA_KEY="$DIR/ca-key.pem"
CA_CERT="$DIR/ca-cert.pem"
LEAF_KEY="$DIR/key.pem"
LEAF_CERT="$DIR/cert.pem"        # full chain: leaf + CA
CA_DAYS=3650                     # the CA can be long-lived
LEAF_DAYS=397                    # iOS/Safari reject leaf certs valid > 398 days

# Write a self-contained HTML how-to (arg 1 = path). Called at the very end, so
# $PRIMARY and the name lists are already set. Kept dependency-free: plain HTML
# with a little inline CSS, readable in any browser, works offline.
write_howto() {
  cat > "$1" <<HTML
<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Install the diy-mac-remote certificate on your iPhone</title>
<style>
  body { font: 16px/1.6 -apple-system, system-ui, sans-serif; max-width: 40rem;
         margin: 2rem auto; padding: 0 1rem; color: #1d1d1f; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  ol { padding-left: 1.2rem; } li { margin: .5rem 0; }
  code { background: #f2f2f4; padding: .1rem .35rem; border-radius: .25rem; }
  .note { background: #fff8e1; border-left: 4px solid #f0c000; padding: .75rem 1rem;
          border-radius: .25rem; margin: 1.5rem 0; }
  .step2 { background: #eef6ff; border-left: 4px solid #3b82f6; padding: .75rem 1rem;
           border-radius: .25rem; }
</style>

<h1>Install the diy-mac-remote certificate on your iPhone</h1>

<p>This lets your iPhone trust your Mac's HTTPS server, so the remote-control
page loads with a padlock and no warnings. You only do this <strong>once</strong>.
The file to install is <code>diy-mac-remote-ca.pem</code>, sitting right next to
this page.</p>

<div class="note"><strong>Only install a certificate you generated yourself,
on your own Mac, moments ago.</strong> Never install one someone sent you — a
trusted certificate is powerful. This one's private key never left your Mac.</div>

<h2>1. Send the certificate to the iPhone</h2>
<ol>
  <li>In this folder, right-click <code>diy-mac-remote-ca.pem</code> &rarr;
      <strong>Share</strong> &rarr; <strong>AirDrop</strong>, and pick your iPhone.</li>
  <li>On the iPhone, accept the AirDrop. It will say <strong>"Profile
      Downloaded"</strong>.</li>
</ol>
<p><em>No AirDrop?</em> Email the file to yourself and open it in the Mail app.
If iOS opens it as text instead of offering to install, rename the copy to
<code>diy-mac-remote-ca.crt</code> and try again.</p>

<h2>2. Install the profile</h2>
<ol>
  <li>Open <strong>Settings</strong>. Near the top you'll see <strong>Profile
      Downloaded</strong> &mdash; tap it. (Or go to <strong>Settings &rarr; General
      &rarr; VPN &amp; Device Management</strong>.)</li>
  <li>Tap <strong>diy-mac-remote local CA</strong> &rarr; <strong>Install</strong>,
      enter your passcode, then <strong>Install</strong> again to confirm.</li>
</ol>

<h2>3. Turn on trust <span style="font-weight:normal">(the step everyone misses)</span></h2>
<div class="step2">
Installing is not enough &mdash; you must also switch trust on:
<ol>
  <li>Go to <strong>Settings &rarr; General &rarr; About &rarr; Certificate Trust
      Settings</strong>.</li>
  <li>Under <strong>Enable Full Trust for Root Certificates</strong>, turn
      <strong>ON</strong> the switch for <strong>diy-mac-remote local CA</strong>.</li>
</ol>
</div>

<h2>4. Open the app</h2>
<p>In <strong>Safari</strong> on the iPhone, open the <code>https://</code> link
your Mac's Terminal prints (or scan its QR code). You should get a padlock and no
warning. This certificate is valid for:</p>
<ul>
$(for n in $DNS_NAMES; do echo "  <li><code>$n</code></li>"; done)
$(for a in $IP_ADDRS;  do echo "  <li><code>$a</code></li>"; done)
</ul>

<h2>Later</h2>
<p>To remove trust: <strong>Settings &rarr; General &rarr; VPN &amp; Device
Management</strong>, tap the profile, <strong>Remove Profile</strong>. If your
Mac's IP later changes, just re-run <code>gen-cert.sh</code> on the Mac &mdash;
you do <em>not</em> need to reinstall anything on the phone.</p>
</html>
HTML
}

# Keep the credential directory owner-only, same stance as the shared secret.
mkdir -p "$DIR"
chmod 700 "$DIR"

# --- Collect the names/IPs the certificate should be valid for ----------------
# We start with localhost, then add this Mac's .local name, any real LAN IPv4
# addresses, and the Tailscale name/IP if Tailscale is up. Anything you pass on
# the command line is appended too.

DNS_NAMES="localhost"
IP_ADDRS="127.0.0.1"

add_dns() { for n in $DNS_NAMES; do [ "$n" = "$1" ] && return 0; done; DNS_NAMES="$DNS_NAMES $1"; }
add_ip()  { for n in $IP_ADDRS;  do [ "$n" = "$1" ] && return 0; done; IP_ADDRS="$IP_ADDRS $1"; }

# Add a value as an IP if it looks like a dotted-quad IPv4, else as a DNS name.
add_auto() {
  case "$1" in
    *[!0-9.]*) add_dns "$1" ;;                       # has a non-digit/dot -> name
    *.*.*.*)   add_ip "$1" ;;                         # looks like an IPv4
    *)         add_dns "$1" ;;
  esac
}

# This Mac's Bonjour/.local name (scutil is macOS; fall back to `hostname`).
if command -v scutil >/dev/null 2>&1; then
  LOCALNAME="$(scutil --get LocalHostName 2>/dev/null || true)"
  [ -n "$LOCALNAME" ] && add_dns "${LOCALNAME}.local"
fi
HN="$(hostname 2>/dev/null || true)"
if [ -n "$HN" ]; then
  add_dns "$HN"
  case "$HN" in *.local) : ;; *) add_dns "${HN}.local" ;; esac
fi

# Real (non-loopback) LAN IPv4 addresses.
if command -v ifconfig >/dev/null 2>&1; then
  for ip in $(ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -v '^127\.'); do
    add_ip "$ip"
  done
fi

# Tailscale name + IP, if a tailnet is up.
if command -v tailscale >/dev/null 2>&1; then
  TS_NAME="$(tailscale status --json 2>/dev/null \
    | grep -m1 '"DNSName"' | sed 's/.*"DNSName": *"//; s/".*//; s/\.$//' || true)"
  [ -n "$TS_NAME" ] && add_dns "$TS_NAME"
  for ip in $(tailscale ip -4 2>/dev/null || true); do add_ip "$ip"; done
fi

# Anything the caller named explicitly.
for arg in "$@"; do add_auto "$arg"; done

# --- Build the openssl config for the extensions ------------------------------
# LibreSSL's `openssl -addext` support varies across macOS versions, so we write
# a config file instead — that works everywhere.

TMP="$(mktemp -d "${TMPDIR:-/tmp}/diy-mac-remote-cert.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

ALT="$TMP/alt.cnf"
{
  echo "[v3_leaf]"
  echo "basicConstraints = CA:FALSE"
  echo "keyUsage = critical, digitalSignature, keyEncipherment"
  echo "extendedKeyUsage = serverAuth"
  echo "subjectAltName = @alt_names"
  echo
  echo "[alt_names]"
  i=1; for n in $DNS_NAMES; do echo "DNS.$i = $n"; i=$((i+1)); done
  i=1; for a in $IP_ADDRS;  do echo "IP.$i = $a";  i=$((i+1)); done
} > "$ALT"

CACNF="$TMP/ca.cnf"
{
  echo "[v3_ca]"
  echo "basicConstraints = critical, CA:TRUE"
  echo "keyUsage = critical, keyCertSign, cRLSign"
  echo "subjectKeyIdentifier = hash"
} > "$CACNF"

# --- Create the CA (only if it doesn't already exist) -------------------------
if [ -f "$CA_KEY" ] && [ -f "$CA_CERT" ]; then
  echo "Reusing existing CA at $CA_CERT"
else
  echo "Creating a new local CA..."
  openssl genrsa -out "$CA_KEY" 2048
  chmod 600 "$CA_KEY"
  openssl req -x509 -new -nodes -key "$CA_KEY" -sha256 -days "$CA_DAYS" \
    -subj "/CN=diy-mac-remote local CA" \
    -extensions v3_ca -config "$CACNF" -out "$CA_CERT"
  chmod 644 "$CA_CERT"
fi

# --- Create the leaf key + cert, signed by the CA -----------------------------
echo "Creating the server certificate..."
openssl genrsa -out "$LEAF_KEY" 2048
chmod 600 "$LEAF_KEY"

# Pick a Common Name for looks (modern clients validate SANs, not the CN).
PRIMARY="$(printf '%s\n' $DNS_NAMES | grep -v '^localhost$' | head -n1 || true)"
[ -n "$PRIMARY" ] || PRIMARY="localhost"

CSR="$TMP/leaf.csr"
openssl req -new -key "$LEAF_KEY" -subj "/CN=$PRIMARY" -out "$CSR"
openssl x509 -req -in "$CSR" -CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial \
  -days "$LEAF_DAYS" -sha256 -extfile "$ALT" -extensions v3_leaf \
  -out "$TMP/leaf.pem"

# Serve the leaf plus the CA (a full chain) so any client validates even if it
# only trusts the leaf directly.
cat "$TMP/leaf.pem" "$CA_CERT" > "$LEAF_CERT"
chmod 644 "$LEAF_CERT"

echo
echo "Done. The certificate is valid for:"
for n in $DNS_NAMES; do echo "    DNS  $n"; done
for a in $IP_ADDRS;  do echo "    IP   $a"; done
echo
echo "Files written to $DIR:"
echo "    ca-cert.pem   -> install this on your iPhone (see README > Serve it over HTTPS)"
echo "    cert.pem      -> server certificate chain (served automatically)"
echo "    key.pem       -> server private key (owner-only)"

# Drop a copy of the CA (and only the CA — never a private key) on the Desktop so
# it's a two-tap AirDrop to the iPhone: right-click > Share > AirDrop. We reveal
# it in Finder too. Only the CA is safe to copy around; the private keys stay in
# the owner-only directory above.
DESKTOP="$HOME/Desktop"
if [ -d "$DESKTOP" ]; then
  # Give it its own folder so it doesn't get lost among everything else on the
  # Desktop — opening the folder in Finder shows just this file, ready to AirDrop.
  DESKTOP_DIR="$DESKTOP/diy-mac-remote"
  DESKTOP_CERT="$DESKTOP_DIR/diy-mac-remote-ca.pem"
  mkdir -p "$DESKTOP_DIR"
  cp "$CA_CERT" "$DESKTOP_CERT"
  chmod 644 "$DESKTOP_CERT"

  # Drop a self-contained how-to next to the cert so the steps are right there.
  HOWTO="$DESKTOP_DIR/HOWTO-AIRDROP-CERT-TO-PHONE.html"
  write_howto "$HOWTO"

  echo
  echo "Copied the CA to a folder on your Desktop, with step-by-step instructions:"
  echo "    $DESKTOP_CERT"
  echo "    $HOWTO"
  # Open the folder in Finder on macOS so AirDrop is right-click away.
  command -v open >/dev/null 2>&1 && open "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

echo
echo "Now start the server as usual — it serves HTTPS automatically once these"
echo "files exist:  ./start.sh"
