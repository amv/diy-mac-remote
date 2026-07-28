#!/bin/sh
#
# ensure-desktop-folder.sh — make sure the `diy-mac-remote` folder on the
# Desktop is present and up to date. Safe to re-run any time; it just fixes
# whatever is stale. The folder is the user-facing handover point:
#
#   ~/Desktop/diy-mac-remote/
#     diy-mac-remote-ca.pem              <- the CA to AirDrop to the iPhone
#                                           (public — never a private key)
#     HOWTO-AIRDROP-CERT-TO-PHONE.html   <- step-by-step install instructions,
#                                           listing the names the current
#                                           certificate is actually valid for
#     start.command                      <- double-click to start the server
#     stop.command                       <- double-click to stop it again
#     reset-app-secrets.command          <- double-click to forget the pairing
#     reset-certificate.command          <- double-click to mint a fresh CA +
#                                           certificate
#
# The .command files are thin entries that point at start.sh / stop.sh /
# reset.sh next to THIS script, wherever the repo lives.
#
# Run it from the repo (setup-https.sh does this for you). It needs the
# certificate files that gen-cert.sh writes to ~/.diy-mac-remote/.
#
# With --start-command-only it writes only start.command, stop.command and
# reset-app-secrets.command — for setups that don't use the self-signed
# certificate (e.g. Tailscale), where there is no CA to hand over, nothing to
# install on the phone, and so no certificate to reset.
#
# With --start-args <args>, the generated start.command passes those arguments
# to start.sh — e.g. --start-args tailscale bakes in Tailscale mode, so that
# double-click can never accidentally start the server in a less strict mode.

set -eu

START_ONLY=false
START_ARGS=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --start-command-only) START_ONLY=true ;;
    --start-args)
      [ "$#" -ge 2 ] || { echo "--start-args needs a value" >&2; exit 1; }
      shift; START_ARGS="$1" ;;
    *) echo "Unknown option: $1 (supported: --start-command-only, --start-args <args>)" >&2
       exit 1 ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

DIR="${DIY_MAC_REMOTE_DIR:-$HOME/.diy-mac-remote}"
CA_CERT="$DIR/ca-cert.pem"
LEAF_CERT="$DIR/cert.pem"

# The Desktop can be overridden for testing on machines without one.
DESKTOP="${DIY_MAC_REMOTE_DESKTOP:-$HOME/Desktop}"
DESKTOP_DIR="$DESKTOP/diy-mac-remote"

START_SH="$SCRIPT_DIR/start.sh"
STOP_SH="$SCRIPT_DIR/stop.sh"
RESET_SH="$SCRIPT_DIR/reset.sh"

if ! $START_ONLY && { [ ! -f "$CA_CERT" ] || [ ! -f "$LEAF_CERT" ]; }; then
  echo "ERROR: no certificate found in $DIR." >&2
  echo "Run ./setup-https.sh first — it generates the certificate and then" >&2
  echo "calls this script." >&2
  exit 1
fi
if [ ! -x "$START_SH" ] || [ ! -x "$STOP_SH" ] || [ ! -x "$RESET_SH" ]; then
  echo "ERROR: expected start.sh, stop.sh and reset.sh next to this script —" >&2
  echo "run this from the repo." >&2
  exit 1
fi
if [ ! -d "$DESKTOP" ]; then
  echo "ERROR: no Desktop folder at $DESKTOP." >&2
  exit 1
fi

# --- Read the names out of the CURRENT certificate ----------------------------
# The HOWTO lists what the cert is actually valid for, so parse the Subject
# Alternative Names from cert.pem itself rather than re-detecting — that way the
# instructions can never drift from the certificate they describe.
DNS_NAMES=""
IP_ADDRS=""
if ! $START_ONLY; then
  SAN_LINE="$(openssl x509 -in "$LEAF_CERT" -noout -text 2>/dev/null \
    | grep -A1 'Subject Alternative Name' | tail -n1 | tr ',' '\n' | sed 's/^ *//')"
  DNS_NAMES="$(printf '%s\n' "$SAN_LINE" | sed -n 's/^DNS://p')"
  IP_ADDRS="$(printf '%s\n' "$SAN_LINE" | sed -n 's/^IP Address://p')"
fi

# Write a self-contained HTML how-to (arg 1 = path). Kept dependency-free:
# plain HTML with a little inline CSS, readable in any browser, works offline.
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
<p>If the phone does not show up in the AirDrop area, check on the iPhone that:</p>
<ul>
  <li><strong>Settings &rarr; General &rarr; AirDrop</strong> is set to
      <strong>Everyone for 10 Minutes</strong> (the usual fix &mdash;
      "Contacts Only" often fails to match).</li>
  <li>Wi-Fi and Bluetooth are both on. (AirDrop connects the devices directly
      &mdash; they don't need to be on the same Wi-Fi network.)</li>
  <li>Personal Hotspot is off &mdash; it blocks AirDrop.</li>
  <li>The phone is unlocked, awake, and near the Mac.</li>
</ul>
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

<h2>4. Start the server and open the app</h2>
<ol>
  <li>Back on the Mac, double-click <code>start.command</code> in this folder
      (it runs the server from where you installed diy-mac-remote).</li>
  <li>In <strong>Safari</strong> on the iPhone, scan the QR code the Terminal
      shows (or type the <code>https://</code> link it prints). You should get a
      padlock and no warning.</li>
</ol>
<p>This certificate is valid for:</p>
<ul>
$(for n in $DNS_NAMES; do echo "  <li><code>$n</code></li>"; done)
$(for a in $IP_ADDRS;  do echo "  <li><code>$a</code></li>"; done)
</ul>

<p>The certificate authority you're installing is <strong>name-constrained</strong>:
your iPhone will only ever accept it for the addresses above (and, for any IP,
its local subnet) &mdash; never for other websites. Even in the worst case, a
stolen key could not be used to impersonate the wider web to your phone.</p>

<h2>Later</h2>
<p>To remove trust: <strong>Settings &rarr; General &rarr; VPN &amp; Device
Management</strong>, tap the profile, <strong>Remove Profile</strong>. If you
re-run the setup later (a renamed Mac, an extra address), the fresh certificate
still chains up to the CA the phone already trusts &mdash; you do <em>not</em>
need to reinstall anything.</p>
</html>
HTML
}

# --- Fix up the folder ---------------------------------------------------------
mkdir -p "$DESKTOP_DIR"

if ! $START_ONLY; then
  cp "$CA_CERT" "$DESKTOP_DIR/diy-mac-remote-ca.pem"
  chmod 644 "$DESKTOP_DIR/diy-mac-remote-ca.pem"

  write_howto "$DESKTOP_DIR/HOWTO-AIRDROP-CERT-TO-PHONE.html"
fi

# The .command files: Finder runs an executable .command file in a new
# Terminal window. Terminal starts it in $HOME, so bake in the absolute paths
# of the start.sh / reset.sh that live next to this script. They are thin
# entries only — all logic stays in the .sh scripts.
cat > "$DESKTOP_DIR/start.command" <<CMD
#!/bin/sh
# Generated by ensure-desktop-folder.sh — double-click to start diy-mac-remote.
exec "$START_SH"${START_ARGS:+ $START_ARGS}
CMD
chmod 755 "$DESKTOP_DIR/start.command"

cat > "$DESKTOP_DIR/stop.command" <<CMD
#!/bin/sh
# Generated by ensure-desktop-folder.sh — double-click to stop diy-mac-remote,
# however it was started (the app bundle, start.command, or a Terminal window
# that is no longer around).
exec "$STOP_SH"
CMD
chmod 755 "$DESKTOP_DIR/stop.command"

cat > "$DESKTOP_DIR/reset-app-secrets.command" <<CMD
#!/bin/sh
# Generated by ensure-desktop-folder.sh — double-click to forget the pairing
# (asks for confirmation first).
exec "$RESET_SH" app-secrets
CMD
chmod 755 "$DESKTOP_DIR/reset-app-secrets.command"

if ! $START_ONLY; then
  cat > "$DESKTOP_DIR/reset-certificate.command" <<CMD
#!/bin/sh
# Generated by ensure-desktop-folder.sh — double-click to mint a fresh CA +
# server certificate (asks for confirmation first).
exec "$RESET_SH" certificate
CMD
  chmod 755 "$DESKTOP_DIR/reset-certificate.command"
fi

echo "Desktop folder is up to date: $DESKTOP_DIR"
if ! $START_ONLY; then
  echo "    diy-mac-remote-ca.pem            -> AirDrop this to the iPhone"
  echo "    HOWTO-AIRDROP-CERT-TO-PHONE.html -> the steps, in a browser page"
fi
echo "    start.command                    -> double-click to start the server${START_ARGS:+ (mode: $START_ARGS)}"
echo "    stop.command                     -> double-click to stop it again"
echo "    reset-app-secrets.command        -> forget the pairing (devices re-pair)"
if ! $START_ONLY; then
  echo "    reset-certificate.command        -> mint a fresh CA + certificate"
fi
