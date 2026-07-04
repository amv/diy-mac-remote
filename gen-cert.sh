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
# HTTPS"). After that you can re-run this script any time to mint a fresh leaf
# cert, and the phone keeps trusting it because it still chains up to the same
# CA. The CA is only regenerated if it's missing.
#
# By default the certificate covers exactly ONE name: this Mac's .local
# (Bonjour) address. Not localhost, not LAN IPs, not a Tailscale name — the
# .local name is the one stable address your phone uses on the Wi-Fi, and
# keeping everything else out of the certificate keeps it (and the CA's reach,
# below) as narrow as possible. IPs churn anyway; the .local name doesn't.
#
# The CA is NAME-CONSTRAINED: baked into ca-cert.pem is the list of names it
# may ever vouch for (by default, just the .local name). The phone enforces
# that list, so even a stolen ca-key.pem can only impersonate this Mac's
# address to your phone — not gmail.com or the rest of the web.
#
# Usage
# -----
#   ./gen-cert.sh                      # just this Mac's .local name (default)
#   ./gen-cert.sh foo.local 10.0.0.9   # ...plus extra names/IPs you name
#
# Every argument is added to the certificate as an extra Subject Alternative
# Name (arguments that look like an IP address are added as IPs, otherwise as
# DNS names). The certificate is only valid for the names/IPs baked into it, so
# if your phone reaches the Mac by some other address, pass it explicitly.

set -eu

DIR="${DIY_MAC_REMOTE_DIR:-$HOME/.diy-mac-remote}"
CA_KEY="$DIR/ca-key.pem"
CA_CERT="$DIR/ca-cert.pem"
LEAF_KEY="$DIR/key.pem"
LEAF_CERT="$DIR/cert.pem"        # full chain: leaf + CA
CA_DAYS=3650                     # the CA can be long-lived
LEAF_DAYS=397                    # iOS/Safari reject leaf certs valid > 398 days

# Keep the credential directory owner-only, same stance as the shared secret.
mkdir -p "$DIR"
chmod 700 "$DIR"

# Keep it out of Time Machine backups too: a mounted backup hands ca-key.pem and
# key.pem to whoever reads it, no matter the perms. Sticky xattr, no sudo. This
# MUST land before we write any key material below. tmutil can block 10s+ when
# Time Machine is busy, so — like server.js — we do it once and record success
# with a shared stamp file, only writing the stamp after tmutil actually returns
# (a failed run leaves no stamp and retries next time). Best-effort: if tmutil is
# missing the certs still matter more than the exclusion.
STAMP="$DIR/.backup-excluded"
if [ ! -e "$STAMP" ]; then
  if tmutil addexclusion "$DIR" 2>/dev/null; then
    : > "$STAMP" && chmod 600 "$STAMP"
  fi
fi

# --- Collect the names/IPs the certificate should be valid for ----------------
# Auto-detection adds exactly one name: this Mac's .local (Bonjour) address.
# Nothing else goes in unless you name it on the command line — no localhost,
# no LAN IPs, no Tailscale names (see the header for why).

DNS_NAMES=""
IP_ADDRS=""

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

# This Mac's Bonjour/.local name (scutil is macOS; fall back to `hostname`,
# normalised to a .local form so the default stays "the mDNS address").
LOCALNAME=""
if command -v scutil >/dev/null 2>&1; then
  LOCALNAME="$(scutil --get LocalHostName 2>/dev/null || true)"
fi
if [ -z "$LOCALNAME" ]; then
  LOCALNAME="$(hostname 2>/dev/null | sed 's/\.local$//; s/\..*//' || true)"
fi
[ -n "$LOCALNAME" ] && add_dns "${LOCALNAME}.local"

# Anything the caller named explicitly.
for arg in "$@"; do add_auto "$arg"; done

if [ -z "$DNS_NAMES" ] && [ -z "$IP_ADDRS" ]; then
  echo "ERROR: couldn't detect this Mac's .local name, and no names were given." >&2
  echo "Pass the address your phone will use, e.g.:  $0 mymac.local" >&2
  exit 1
fi

# --- Build the openssl config for the extensions ------------------------------
# LibreSSL's `openssl -addext` support varies across macOS versions, so we write
# a config file instead — that works everywhere.

TMP="$(mktemp -d "${TMPDIR:-/tmp}/diy-mac-remote-cert.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# openssl chatters on stderr even when everything is fine (LibreSSL's genrsa
# especially). Keep successful runs clean: capture stderr, replay it only if
# the command actually fails.
quiet() {
  if ! "$@" 2>"$TMP/stderr"; then
    cat "$TMP/stderr" >&2
    return 1
  fi
}

# LibreSSL's `openssl req` refuses any -config file lacking a distinguished_name
# entry, even when the subject comes from -subj — so both config files carry a
# stub [req] section pointing at an empty DN section.
ALT="$TMP/alt.cnf"
{
  echo "[req]"
  echo "distinguished_name = req_dn"
  echo "[req_dn]"
  echo
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

# Map each explicitly-passed IP to the subnet the CA will be permitted to vouch
# for: loopback stays exact, a CGNAT (100.64/10, what Tailscale assigns from) IP
# permits that whole range, and a LAN IP permits its /24 (DHCP churn then never
# needs a new CA). Name-constraint IPs use base/mask form. With no IPs passed
# (the default) this emits nothing and the CA is constrained to DNS names only.
constraint_subnets() {
  subs=""
  for a in $IP_ADDRS; do
    case "$a" in
      127.*) s="127.0.0.1/255.255.255.255" ;;
      100.64.*|100.6[5-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*)
             s="100.64.0.0/255.192.0.0" ;;
      *)     s="${a%.*}.0/255.255.255.0" ;;
    esac
    case " $subs " in *" $s "*) ;; *) subs="$subs $s" ;; esac
  done
  printf '%s\n' $subs
}

CACNF="$TMP/ca.cnf"
{
  echo "[req]"
  echo "distinguished_name = req_dn"
  echo "[req_dn]"
  echo
  echo "[v3_ca]"
  echo "basicConstraints = critical, CA:TRUE"
  echo "keyUsage = critical, keyCertSign, cRLSign"
  echo "subjectKeyIdentifier = hash"
  # The blast-radius limiter (see header): the phone rejects anything this CA
  # signs for a name/IP outside these subtrees. Critical, so a validator that
  # can't enforce it refuses the CA rather than ignoring the limit.
  echo "nameConstraints = critical, @name_constraints"
  echo
  echo "[name_constraints]"
  i=1; for n in $DNS_NAMES; do echo "permitted;DNS.$i = $n"; i=$((i+1)); done
  i=1; for s in $(constraint_subnets); do echo "permitted;IP.$i = $s"; i=$((i+1)); done
} > "$CACNF"

# --- Create the CA (only if it doesn't already exist) -------------------------
if [ -f "$CA_KEY" ] && [ -f "$CA_CERT" ]; then
  echo "Reusing existing CA at $CA_CERT"
else
  echo "Creating a new local CA..."
  quiet openssl genrsa -out "$CA_KEY" 2048
  chmod 600 "$CA_KEY"
  quiet openssl req -x509 -new -nodes -key "$CA_KEY" -sha256 -days "$CA_DAYS" \
    -subj "/CN=diy-mac-remote local CA" \
    -extensions v3_ca -config "$CACNF" -out "$CA_CERT"
  chmod 644 "$CA_CERT"
fi

# --- Create the leaf key + cert, signed by the CA -----------------------------
# Everything is built in $TMP and only installed after it validates, so a
# failed re-run never clobbers a working key + cert.
echo "Creating the server certificate..."
quiet openssl genrsa -out "$TMP/leaf.key" 2048

# Pick a Common Name for looks (modern clients validate SANs, not the CN).
PRIMARY="$(printf '%s\n' $DNS_NAMES $IP_ADDRS | head -n1)"

CSR="$TMP/leaf.csr"
quiet openssl req -new -key "$TMP/leaf.key" -subj "/CN=$PRIMARY" -config "$ALT" -out "$CSR"
quiet openssl x509 -req -in "$CSR" -CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial \
  -days "$LEAF_DAYS" -sha256 -extfile "$ALT" -extensions v3_leaf \
  -out "$TMP/leaf.pem"

# Validate the new leaf against the CA the same way the phone will — openssl
# enforces the CA's name constraints here too. This catches the one re-run
# that can't work: an existing CA whose constraints don't cover a newly
# detected name/IP (new network, renamed Mac). Signing alone wouldn't complain;
# the phone would just refuse the cert later.
if ! VERIFY_OUT="$(openssl verify -CAfile "$CA_CERT" "$TMP/leaf.pem" 2>&1)"; then
  echo >&2
  echo "ERROR: the freshly minted certificate does not validate against your" >&2
  echo "existing CA — most likely its name constraints don't cover a name/IP" >&2
  echo "detected on this run. openssl said:" >&2
  echo "    $VERIFY_OUT" >&2
  echo >&2
  echo "Mint a fresh CA covering today's names (then install the new profile" >&2
  echo "on the iPhone once — README > Serve it over HTTPS):" >&2
  echo "    rm '$CA_KEY' '$CA_CERT' && $0 $*" >&2
  echo >&2
  echo "Your existing certificate and key were left untouched." >&2
  exit 1
fi

# Serve the leaf plus the CA (a full chain) so any client validates even if it
# only trusts the leaf directly.
cp "$TMP/leaf.key" "$LEAF_KEY"
chmod 600 "$LEAF_KEY"
cat "$TMP/leaf.pem" "$CA_CERT" > "$LEAF_CERT"
chmod 644 "$LEAF_CERT"

echo
echo "Done. The certificate is valid for:"
for n in $DNS_NAMES; do echo "    DNS  $n"; done
for a in $IP_ADDRS;  do echo "    IP   $a"; done
echo
echo "The CA itself is name-constrained: your phone will only ever accept it for"
echo "these names/subnets, never for other websites:"
for n in $DNS_NAMES; do echo "    DNS  $n (and subdomains)"; done
for s in $(constraint_subnets); do echo "    IP   $s"; done
echo
echo "Files written to $DIR:"
echo "    ca-cert.pem   -> install this on your iPhone (see README > Serve it over HTTPS)"
echo "    cert.pem      -> server certificate chain (served automatically)"
echo "    key.pem       -> server private key (owner-only)"
