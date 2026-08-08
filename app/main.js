'use strict';

// The server itself: credentials, routing, auth, and the events that come out
// the other end.
//
// It owns no socket. An entrypoint (server.js over HTTP/HTTPS, or server.pl
// over plain HTTP) accepts the connection, parses the request, and asks here
// for an answer: a status and a body. That split is what lets the whole
// application run inside `osascript -l JavaScript`, where the keyboard and the
// mouse are function calls into CoreGraphics rather than processes to spawn —
// and it is why there is a Node-free path at all.
//
// Only two requests ever reach here — GET /nonce and POST /msg, the two that
// need a secret to answer. The entrypoints serve public/ themselves, which is
// what keeps the protocol between us down to text: no file bytes cross it, so
// nothing has to carry a content type or an encoding.
//
// Three entry points, called by the host in this order:
//   init(hello)  — resolve credentials (minting a pairing if there are none)
//   banner()     — print the pairing QR or the "use your Home Screen app" note
//   handle(req)  — answer one request; called for every request, forever

var sys = require('./sys');
var bytes = require('./bytes');
var pairing = require('./pairing');
var envelope = require('./envelope');
var input = require('./input');
var netinfo = require('./netinfo');
var qr = require('./qr');

// Everything init() works out, in one place. Until init() runs there is no
// session and handle() must not be called.
var S = {
  scheme: 'http',
  port: 8765,
  entry: 'node',
  startCmd: './start.sh',
  certHosts: null,   // names the entrypoint's certificate vouches for, or null
  session: null,     // envelope.create(secret)
  tokenHash: null,
  master: null,      // non-null ONLY on the run that minted it
  advertised: null,  // { url, kind, ips } — resolved on a pairing run only
};

// How the address encoded in the pairing QR is built — and that is all it does.
// The server always listens on the entrypoint's port regardless of the mode, and
// on a normal restart it resolves no address at all (the paired Home Screen app
// already holds one), so outside a pairing run the mode has no effect. The
// secret is appended as the #fragment, never taken from here.
//
// The first positional arg selects a mode:
//   ./start.sh detect      -> auto (default): Tailscale MagicDNS name if a
//                             tailnet is up, else the Mac .local mDNS name
//   ./start.sh wifi        -> Mac .local mDNS hostname
//   ./start.sh tailscale   -> Tailscale MagicDNS name (over the tailnet)
//   ./start.sh http://host:port/   -> use this URL verbatim (custom override,
//                             e.g. a domain or port-forward)
function parseInvocation(argv) {
  var url = null;
  var mode = null; // 'detect' | 'wifi' | 'tailscale' | null (null => 'detect')
  for (var i = 0; i < argv.length; i++) {
    var a = String(argv[i]);
    if (a.charAt(0) === '-') continue; // flags (--tls, --reset-token, ...) handled elsewhere
    else if (a === 'wifi' || a === 'tailscale' || a === 'detect') mode = a;
    else if (a.indexOf('://') >= 0) url = a; // bare URL positional => custom override
  }
  return { url: url, mode: mode || 'detect' };
}

// Resolve credentials and get ready to serve. `hello` comes from the entrypoint:
//   { root, scheme, port, entry, argv, certHosts }
// Returns { ok:true, dryRun } or { ok:false, error } — a refusal the entrypoint
// prints before exiting non-zero.
function init(hello) {
  S.scheme = hello.scheme || 'http';
  S.port = hello.port;
  S.entry = hello.entry || 'node';
  S.startCmd = S.entry === 'perl' ? './start-plain.sh' : './start.sh';
  S.certHosts = hello.certHosts || null;

  var argv = hello.argv || [];
  var invocation = parseInvocation(argv);
  // `--reset-token` mints a fresh pairing key and prints a new QR (every
  // previously paired device must then re-pair). Use it to pair a new device, or
  // to recover when a phone loses its bookmarked pairing.
  var resetToken = argv.indexOf('--reset-token') >= 0;

  var secret;
  try {
    // Reuse what's stored (normal restart — no master, so no QR to reprint),
    // else mint fresh (first run, `--reset-token`, or a half-written state).
    var stored = resetToken ? { secret: null, tokenHash: null } : pairing.loadStored();
    if (stored.secret && stored.tokenHash) {
      secret = stored.secret;
      S.tokenHash = stored.tokenHash;
    } else {
      // Resolve the address BEFORE minting: resolveBase can refuse (tailscale
      // mode with no tailnet) and minting is not free to undo — it overwrites
      // the stored pairing and discards the only copy of the master. Mint first
      // and a refusal would leave an install nothing can ever pair against.
      S.advertised = netinfo.resolveBase({
        mode: invocation.mode,
        overrideUrl: invocation.url,
        scheme: S.scheme,
        port: S.port,
        certHosts: S.certHosts,
      });
      var minted = pairing.mint();
      S.master = minted.master;
      secret = minted.secret;
      S.tokenHash = minted.tokenHash;
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }

  // Robustness for installs created before the stamp existed (or a dir set up by
  // gen-cert.sh alone): make sure the backup exclusion is in place. mint() already
  // did this synchronously on a fresh install, so on the common path the stamp is
  // present and this is a no-op.
  pairing.ensureBackupExclusion();

  // Prove the host can produce randomness before we claim to be running. On a
  // fresh pairing minting already did; on a restart nothing does until the first
  // /nonce — so without this a broken host means a 500 per keystroke, forever,
  // instead of one refusal at startup with a reason attached.
  try {
    var probe = bytes.b64Decode(sys.randomBase64(32));
    if (!probe || probe.length !== 32) throw new Error('got ' + (probe ? probe.length : 0) + ' bytes');
  } catch (err) {
    return { ok: false, error: 'This host cannot produce random bytes (' + err.message +
      '), so no session could ever be authenticated. Nothing was changed.' };
  }

  S.session = envelope.create(secret);
  return { ok: true, dryRun: !!sys.dryRun };
}

// --- the startup banner ------------------------------------------------------
// The QR hands the phone the MASTER in the #fragment (never sent to the
// server); the page derives the secret + token from it. It can only be shown
// right after minting it (first run, or after an app-secrets reset) — on a
// normal restart it's gone by design (disk holds only the derived secret and
// the token's hash). So a restart has nothing to hand out and prints no
// address either: the paired app carries the one it was paired with, and
// nobody wants to retype a hostname. An unpaired phone needs a reset, not a
// link.
function banner() {
  var say = sys.log;

  if (!S.master) {
    say('');
    say('On the iPhone, open the Home Screen app you saved for this server —');
    say('it kept its pairing, and the address that goes with it.');
    say('');
    say('No Home Screen app, or the pairing was lost? Reset the app secrets and');
    say('start again — a fresh pairing QR prints then (every device re-pairs):');
    say('  reset-app-secrets.command in the Desktop diy-mac-remote folder,');
    say('  or: ' + S.startCmd + ' --reset-token');
    return;
  }

  // A fresh pairing was minted — this is the one time it can be shown. Every
  // warning below is about the pairing being made right now: the address in the
  // QR is what the phone stores and reuses for good, so this is the moment to
  // get it right.

  var base = S.advertised.url;
  var kind = S.advertised.kind;
  var ips = S.advertised.ips;

  if (kind === 'none') {
    // Minted, but no address to build the QR from. The key is already gone
    // (never written to disk), so after fixing the network a reset is the way
    // to get a fresh QR.
    say('');
    say('⚠️  A new pairing was minted, but no address for this Mac could be');
    say('   detected, so the pairing QR cannot be shown. Connect the Mac to the');
    say('   network your phone uses (or pass a URL: ' + S.startCmd + ' http://<ip>:' + S.port + '/),');
    say('   then reset the app secrets and start again for a fresh QR:');
    say('   reset-app-secrets.command (or: ' + S.startCmd + ' --reset-token)');
    return;
  }

  // Raw auto-detected IP: it might be the wrong interface — help the user pick.
  if (kind === 'ip') {
    say('');
    if (ips.length > 1) {
      say('⚠️  No hostname found — several LAN IPs detected; the QR uses ' + ips[0] + '.');
      say('   If it doesn\'t work, pass the right one as the first parameter:');
      say('     ' + S.startCmd + ' http://<ip>:' + S.port + '/');
    } else {
      say('⚠️  No hostname found — this IP was auto-detected. If the QR doesn\'t');
      say('   work, pass the right one: ' + S.startCmd + ' http://<ip>:' + S.port + '/');
    }
  }

  // Over plain HTTP a LAN address trusts the local network — an active attacker
  // on a compromised router can rewrite the page itself (see README › Security).
  // With HTTPS + an installed CA that gap is closed, so no warning then.
  if ((kind === 'local' || kind === 'ip') && S.scheme !== 'https') {
    say('');
    say('⚠️  Pairing to a LAN address over plain HTTP — only safe on a network');
    say('   whose router you trust. On an untrusted network, use Tailscale.');
  }

  // With HTTPS on, an address the certificate doesn't vouch for is a dead end —
  // the phone will refuse the page. Say so up front, with the fix.
  var advertHost = hostOf(base);
  if (advertHost && !netinfo.certCovers(advertHost, S.certHosts)) {
    say('');
    say('⚠️  The certificate does not cover ' + advertHost + ' — the phone will refuse');
    say('   this address. Re-run the setup naming it (./setup-https.sh ' + advertHost + '),');
    say('   or pair against the covered .local name instead: ./start.sh wifi');
  }

  if (S.scheme === 'https') {
    say('');
    say('First time on this phone: install & trust the CA once — the file and');
    say('the steps are in the diy-mac-remote folder on the Desktop.');
  }

  var where =
    kind === 'tailscale' ? 'same Tailscale tailnet' :
    kind === 'local' ? 'same Wi-Fi' :
    kind === 'custom' ? 'wherever this URL reaches the Mac' : 'same LAN';
  var authUrl = withFragment(base, S.master);
  say('');
  say('Scan to pair — in Safari on the iPhone (' + where + '):');
  // Render a QR, or fall back to just the link if the payload overflows the
  // fixed v5 QR capacity (can happen with a long Tailscale/custom host).
  try {
    qr.generate(authUrl, { small: true }, function (out) { say(out); });
  } catch (err) {
    say('   (link is too long to draw as a QR here — open the URL below directly)');
  }
  say(authUrl + '\n');
  say('After pairing: add the page to your Home Screen (Share → Add to Home');
  say('Screen) so the credentials are stored, then restart this server —');
  say('the pairing key above should not stay on screen.\n');
}

// Append a fragment (replacing any existing one). The pairing fragment carries
// the master pairing key; it is never sent to the server.
function withFragment(base, frag) {
  var hash = base.indexOf('#');
  return (hash >= 0 ? base.slice(0, hash) : base) + '#' + frag;
}

// The host out of a URL, without a URL parser (JavaScriptCore has none).
function hostOf(url) {
  var m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/.exec(String(url));
  if (!m) return null;
  var authority = m[1].replace(/^[^@]*@/, '');       // strip any userinfo
  if (authority.charAt(0) === '[') {                  // [::1]:8765
    var end = authority.indexOf(']');
    return end > 0 ? authority.slice(1, end) : null;
  }
  return authority.split(':')[0] || null;
}

// Every answer from here is JSON; the entrypoint knows that and adds the
// content type. Nothing else needs saying.
function json(status, obj) {
  return { status: status, text: JSON.stringify(obj) };
}

// Execute one decrypted op.
//   { t:'k', b:<actions> }            keypress
//   { t:'m', k:'mv', dx, dy }         relative mouse move (drag while a btn is held)
//   { t:'m', k:'cl', btn:'l'|'r' }    mouse click (down+up)
//   { t:'m', k:'dn', btn:'l'|'r' }    mouse button down (hold)
//   { t:'m', k:'up', btn:'l'|'r' }    mouse button up (release)
//   { t:'m', k:'sc', dy }             scroll wheel
function runOp(op) {
  if (!op || typeof op !== 'object') throw new Error('bad op');
  if (op.t === 'k') {
    var actions = normalizeActions(op.b);
    if (!actions) throw new Error('expected action object or array');
    return input.runKeys(actions);
  }
  if (op.t === 'm') return input.runMouse(op);
  throw new Error('unknown op type');
}

// Normalize a key payload into an actions array.
function normalizeActions(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.actions)) return body.actions;
  if (body && typeof body === 'object') return [body];
  return null;
}

// Execute a batch of ops in order (the client coalesces keystrokes per flush).
function dispatchOps(ops) {
  var list = Array.isArray(ops) ? ops : [ops];
  if (list.length === 0) return json(400, { error: 'empty batch' });
  try {
    var last;
    for (var i = 0; i < list.length; i++) last = runOp(list[i]);
    var body = { ok: true, n: list.length };
    if (last && last.dryRun) body.dryRun = true;
    return json(200, body);
  } catch (err) {
    sys.log('Dispatch error: ' + err.message);
    return json(500, { error: err.message });
  }
}

// Answer one request. `req` is { method, path (with any query), body }.
function handle(req) {
  var pathname = String(req.path || '/').split('?')[0];
  var method = String(req.method || 'GET').toUpperCase();

  // Public endpoint (no auth): nonce issue.
  if (method === 'GET' && pathname === '/nonce') {
    return json(200, { nonce: S.session.createNonce(), ttlMs: S.session.ttlMs });
  }

  // Single authenticated + encrypted endpoint. The body is an encrypt-then-MAC
  // envelope; the decrypted plaintext carries the auth nonce, counter, and the
  // operation — so nothing about the keystroke is visible on the wire.
  if (method === 'POST' && pathname === '/msg') {
    var opened = S.session.open('POST', pathname, req.body || '');
    if (!opened.ok) return json(opened.status, { error: opened.error });

    var msg;
    try {
      msg = JSON.parse(opened.plaintext);
    } catch (e) {
      return json(400, { error: 'bad plaintext' });
    }

    var check = S.session.checkNonceCounter(msg.n, msg.c);
    if (!check.ok) return json(401, { error: check.error });

    // Second-layer auth: the decrypted payload must carry the token (msg.p) whose
    // hash matches the one on disk. Read access to the disk alone can't produce it.
    if (!pairing.tokenOk(msg.p, S.tokenHash)) return json(401, { error: 'bad or missing token' });

    return dispatchOps(msg.o);
  }

  // The entrypoints route /nonce and /msg here and answer everything else
  // themselves, so nothing should reach this line. Answer it anyway rather than
  // fall off the end: this is also the door a direct write to the backend's
  // stdin would come through.
  return json(404, { error: 'Not found' });
}

module.exports = { init: init, banner: banner, handle: handle, _parseInvocation: parseInvocation, _hostOf: hostOf };
