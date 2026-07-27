'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const { run } = require('./executor');
const chacha20 = require('./chacha20');
const mouse = require('./mouse');
const qrcode = require('./qr');

const PORT = Number(process.env.PORT) || 8765;
// Explicit bind-address override. Unset (the normal case) we bind all
// interfaces; set, we bind exactly that address — the way to narrow which
// interface the server answers on.
const HOST_OVERRIDE = process.env.HOST || null;

// How the address encoded in the pairing QR is built — and that is all it does.
// The server always listens on PORT regardless of the mode, and on a normal
// restart it resolves no address at all (the paired Home Screen app already
// holds one), so outside a pairing run the mode has no effect. The secret is
// appended as the #fragment, never taken from here.
//
// The first positional arg selects a mode:
//   node server.js detect      -> auto (default): Tailscale MagicDNS name if a
//                                tailnet is up, else the Mac .local mDNS name
//   node server.js wifi        -> Mac .local mDNS hostname
//   node server.js tailscale   -> Tailscale MagicDNS name (over the tailnet)
//   node server.js http://host:port/   -> use this URL verbatim (custom override,
//                                e.g. a domain or port-forward)
function parseInvocation() {
  let url = null;
  let mode = null; // 'detect' | 'wifi' | 'tailscale' | null (null => 'detect')
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('-')) continue; // flags (--tls, --reset-token, ...) parsed elsewhere
    else if (a === 'wifi' || a === 'tailscale' || a === 'detect') mode = a;
    else if (a.includes('://')) url = a; // bare URL positional => custom override
  }
  return { url, mode: mode || 'detect' };
}
const { url: OVERRIDE_URL, mode: MODE } = parseInvocation();
// `--reset-token` mints a fresh pairing key and prints a new QR (every previously
// paired device must then re-pair). Use it to pair a new device, or to recover
// when a phone loses its bookmarked pairing.
const RESET_TOKEN = process.argv.slice(2).includes('--reset-token');

const PUBLIC_DIR = path.join(__dirname, 'public');
const SECRET_DIR = path.join(os.homedir(), '.diy-mac-remote');
const SECRET_FILE = path.join(SECRET_DIR, 'secret');
const TOKEN_FILE = path.join(SECRET_DIR, 'token.hash');
// Sentinel: dropped once the Time Machine exclusion has been applied to
// SECRET_DIR, so we never run the (potentially slow) tmutil again. Shared with
// gen-cert.sh, which honours the same stamp.
const TM_EXCLUDED_STAMP = path.join(SECRET_DIR, '.backup-excluded');

// TLS (optional). We serve HTTPS whenever a certificate + key exist — generate
// them with ./gen-cert.sh — and plain HTTP otherwise. `--no-tls` forces HTTP
// even if the files are present; `--tls` requires them (error out if missing).
// TLS_CERT / TLS_KEY override the default paths. The app already encrypts every
// request, so HTTPS is defence-in-depth: it stops an active man-in-the-middle
// from rewriting the page itself, and makes the page a secure context.
const TLS_DISABLED = process.argv.slice(2).includes('--no-tls');
const TLS_FORCED = process.argv.slice(2).includes('--tls');
const TLS_CERT_FILE = process.env.TLS_CERT || path.join(SECRET_DIR, 'cert.pem');
const TLS_KEY_FILE = process.env.TLS_KEY || path.join(SECRET_DIR, 'key.pem');

// Refuse to use the secret (or its directory) unless we own it and no other user
// can touch it — the same stance ssh takes on private keys. Beyond keeping the
// secret from leaking to other local users, this guards a niche injection: a
// rogue process that can *create* a file but can't overwrite ours or change its
// permissions still can't hand us a secret it knows, because a file/dir it
// created is owned by a different uid (or left group/other-accessible), and we
// reject that. `stat` should come from the open fd (fstat) so we validate exactly
// what we read, leaving no check-then-swap (TOCTOU) window.
function assertOwnerOnly(label, stat) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null && stat.uid !== uid) {
    throw new Error(
      `${label} is owned by uid ${stat.uid}, not you (uid ${uid}). Refusing to use ` +
      `it — inspect and remove ${SECRET_DIR}, then restart to regenerate.`
    );
  }
  if (stat.mode & 0o077) {
    throw new Error(
      `${label} is accessible to other users (mode ${(stat.mode & 0o777).toString(8)}). ` +
      `The secret may be exposed — remove ${SECRET_DIR} and restart to regenerate.`
    );
  }
}

function sha256(data) { return crypto.createHash('sha256').update(data).digest(); }
function sha256hex(str) { return sha256(str).toString('hex'); }

// ---- pairing: one "master" key in the QR, two credentials derived from it ----
//
// The QR/link fragment carries a single high-entropy MASTER. From it we derive,
// with two domain-separated one-way hashes:
//   - the SECRET, which keys the ChaCha20/HMAC crypto, and
//   - the TOKEN, a second-layer proof.
// We keep them apart on disk: the SECRET must live there in the clear (the server
// needs it to run the crypto), but of the TOKEN we store ONLY its hash. The MASTER
// itself is NEVER written to disk — persisting it would let a disk reader
// reconstruct the token and defeat the whole layer. So a disk reader (or someone
// with a stolen backup) gets SECRET + hash(TOKEN) but not the TOKEN, and without
// the token the server rejects every command. Deriving both from one master keeps
// the fragment short enough for the fixed-size QR; it does NOT weaken the split,
// because SECRET = H1(master) reveals nothing about TOKEN = H2(master) (different
// prefixes → independent oracles), and master stays high-entropy (128 bits) so it
// can't be brute-forced against the on-disk secret. (Boundary is unchanged: this
// does NOT stop an attacker who also captures live traffic, or reads memory. See
// README › Security.)
function deriveSecret(master) { return sha256hex('diy-mac-remote-secret:' + master); }
function deriveToken(master) { return sha256hex('diy-mac-remote-authtoken:' + master); }
function hashToken(token) { return sha256('diy-mac-remote-token:' + token); }

// Read an owner-only file's trimmed contents, or null if it's missing/empty.
// Ownership + mode are enforced on the open fd (and the dir) exactly like ssh —
// we refuse a credential we don't fully control rather than trust what's on disk.
function readOwnedFile(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return null;
  }
  try {
    // Validate the containing dir too: a foreign-owned or group/other-writable
    // dir would let another user swap the file underneath us.
    assertOwnerOnly(SECRET_DIR, fs.statSync(SECRET_DIR));
    assertOwnerOnly(file, fs.fstatSync(fd));
    return fs.readFileSync(fd, 'utf8').trim() || null;
  } finally {
    fs.closeSync(fd);
  }
}

function loadStored() {
  const secret = readOwnedFile(SECRET_FILE);
  const hex = readOwnedFile(TOKEN_FILE);
  return { secret, tokenHash: hex ? Buffer.from(hex, 'hex') : null };
}

// Load the TLS cert + key, or null to run plain HTTP. The private key is read
// with the same owner-only enforcement as the secret (it's just as sensitive);
// the certificate is public, so it's read normally. Returns null when the files
// are absent — unless `--tls` was given, in which case we insist on them.
function loadTLS() {
  if (TLS_DISABLED) return null;
  let key;
  try {
    const fd = fs.openSync(TLS_KEY_FILE, 'r');
    try {
      assertOwnerOnly(TLS_KEY_FILE, fs.fstatSync(fd));
      key = fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // perms wrong, etc. — surface it
    if (TLS_FORCED) {
      throw new Error(
        `--tls was requested but no TLS key at ${TLS_KEY_FILE}. Generate one with ` +
        `./setup-https.sh (or set TLS_CERT/TLS_KEY), then restart.`
      );
    }
    return null; // no key, no --tls -> fall back to plain HTTP
  }
  let cert;
  try {
    cert = fs.readFileSync(TLS_CERT_FILE);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    throw new Error(
      `Found a TLS key at ${TLS_KEY_FILE} but no certificate at ${TLS_CERT_FILE}. ` +
      `Run ./setup-https.sh to (re)generate both, then restart.`
    );
  }
  return { key, cert };
}

// Ensure SECRET_DIR is excluded from Time Machine — exactly once, ever. Everything
// in it is key material (secret, token.hash, key.pem, ca-key.pem) and owner-only
// perms mean nothing on a mounted backup: whoever restores it reads it all. The
// sticky (xattr) form of `tmutil addexclusion` needs no sudo and persists on the
// directory, so it only needs setting once — but tmutil itself can block 10s+ when
// Time Machine is busy, so we must not run it on every start. We record success
// with a stamp file, written ONLY after tmutil returns, and skip the whole thing
// whenever the stamp exists. A failed/interrupted run leaves no stamp and simply
// retries next time. Best-effort and macOS-only; a failure must never stop the
// server. (Trade-off: excluded means not restored — after a disk restore the
// server mints a fresh pairing.)
//
//   sync:true  — block until tmutil returns, then stamp. Used inside mint(), right
//                after the dir is created and BEFORE the secret/token hash are
//                written, so cleartext key material never lands in a not-yet-
//                excluded directory. Bounded by a timeout so a wedged tmutil can't
//                hang startup (on timeout it throws → no stamp → retried next run).
//   sync:false — fire-and-forget, stamping in the callback on success. Used at
//                startup for installs predating the stamp: re-affirm once without
//                stalling a normal restart.
function ensureBackupExclusion({ sync = false } = {}) {
  if (process.platform !== 'darwin') return;
  if (fs.existsSync(TM_EXCLUDED_STAMP)) return; // already done once — never repeat
  const stamp = () => { try { fs.writeFileSync(TM_EXCLUDED_STAMP, '', { mode: 0o600 }); } catch {} };
  try {
    if (sync) {
      execFileSync('tmutil', ['addexclusion', SECRET_DIR], { stdio: 'ignore', timeout: 30000 });
      stamp(); // only after tmutil actually succeeded
    } else {
      execFile('tmutil', ['addexclusion', SECRET_DIR], { timeout: 30000 }, (err) => { if (!err) stamp(); });
    }
  } catch {}
}

// Mint a fresh pairing: generate a master, derive + store the secret and the
// token HASH (owner-only), and DISCARD the master — returning it only so we can
// print the pairing QR this one time. The master never touches disk.
function mint() {
  try {
    assertOwnerOnly(SECRET_DIR, fs.statSync(SECRET_DIR));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    fs.mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 });
  }
  // Exclude the (empty) dir from backups BEFORE the secret/token hash land in it,
  // so a Time Machine snapshot can never capture them in cleartext. Synchronous
  // on purpose — the writes below must not race ahead of the exclusion.
  ensureBackupExclusion({ sync: true });
  const master = crypto.randomBytes(16).toString('base64url'); // 128-bit, URL-safe, 22 chars
  const secret = deriveSecret(master);
  const tokenHash = hashToken(deriveToken(master));
  fs.writeFileSync(SECRET_FILE, secret + '\n', { mode: 0o600 });
  fs.writeFileSync(TOKEN_FILE, tokenHash.toString('hex') + '\n', { mode: 0o600 });
  return { master, secret, tokenHash };
}

// Present HTTPS if a cert+key are available (see loadTLS), else plain HTTP. The
// request handling is identical either way; TLS only wraps the transport and
// flips the advertised scheme to https. Resolved before resolveBase() so the
// advertised URL (and QR) carries the right scheme.
let TLS;
try {
  TLS = loadTLS();
} catch (err) {
  console.error('\n❌ ' + err.message);
  process.exit(1);
}
const SCHEME = TLS ? 'https' : 'http';

// Resolve credentials: reuse what's stored (normal restart — no master, so no QR
// to reprint), else mint fresh (first run, `--reset-token`, or a half-written
// state). MASTER is non-null only when we just minted, i.e. when we can pair.
//
// A pairing run resolves its address BEFORE minting, because resolveBase() can
// refuse (tailscale mode with no tailnet) and minting is not free to undo: it
// overwrites the stored pairing and discards the only copy of the master. Mint
// first and a refusal would leave an install nothing can ever pair against.
let SECRET, TOKEN_HASH, MASTER = null;
let advertised = null;
{
  const stored = RESET_TOKEN ? { secret: null, tokenHash: null } : loadStored();
  if (stored.secret && stored.tokenHash) {
    SECRET = stored.secret;
    TOKEN_HASH = stored.tokenHash;
  } else {
    advertised = resolveBase();
    ({ master: MASTER, secret: SECRET, tokenHash: TOKEN_HASH } = mint());
  }
}

// Robustness for installs created before the stamp existed (or a dir set up by
// gen-cert.sh alone): make sure the backup exclusion is in place. mint() already
// did this synchronously on a fresh install, so on the common path the stamp is
// present and this is a no-op; otherwise it re-affirms once, fire-and-forget, so
// a busy tmutil can never stall a normal restart.
ensureBackupExclusion();

// Derive separate subkeys for encryption and authentication (never share a key
// between the cipher and the MAC). Both are 32 bytes.
const ENC_KEY = sha256('diy-mac-remote-enc:' + SECRET);
const MAC_KEY = sha256('diy-mac-remote-mac:' + SECRET);

// Constant-time check of a client-supplied token against the stored hash.
function tokenOk(p) {
  if (typeof p !== 'string' || !p) return false;
  const got = hashToken(p);
  return got.length === TOKEN_HASH.length && crypto.timingSafeEqual(got, TOKEN_HASH);
}

// ---- challenge-response auth (nonce + monotonic counter + HMAC-SHA256) ----
//
// Flow: client GETs /nonce, then signs every action request with
//   HMAC-SHA256(secret, METHOD\nPATH\nNONCE\nCOUNTER\nBODY)
// sent in the request envelope. The secret never travels on the wire; only the
// MAC does. The counter must strictly increase per nonce (replay protection),
// and nonces are random + in-memory only, so a server restart invalidates all
// old sessions. Nonces expire by TTL and are capped to bound memory.
const NONCE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_NONCES = 200;
const nonces = new Map(); // nonce -> { lastCounter, created }

function pruneNonces() {
  const now = Date.now();
  for (const [k, v] of nonces) {
    if (now - v.created > NONCE_TTL_MS) nonces.delete(k);
  }
  // Cap: drop oldest (Map preserves insertion order).
  while (nonces.size >= MAX_NONCES) {
    nonces.delete(nonces.keys().next().value);
  }
}

function createNonce() {
  pruneNonces();
  const nonce = crypto.randomBytes(32).toString('hex'); // 256-bit, unique in practice
  nonces.set(nonce, { lastCounter: 0, created: Date.now() });
  return nonce;
}

// Constant-time compare a received hex MAC against the expected MAC bytes.
function macOk(hexMac, expectedBuf) {
  let got;
  try {
    got = Buffer.from(hexMac, 'hex');
  } catch (e) {
    return false;
  }
  return got.length === expectedBuf.length && crypto.timingSafeEqual(got, expectedBuf);
}

// Check a (nonce, counter) pair for validity + replay. Advances lastCounter on
// success. Returns { ok } / { ok:false, error }.
function checkNonceCounter(nonce, counter) {
  const entry = nonces.get(nonce);
  if (!entry) return { ok: false, error: 'unknown or expired nonce' };
  if (Date.now() - entry.created > NONCE_TTL_MS) {
    nonces.delete(nonce);
    return { ok: false, error: 'expired nonce' };
  }
  if (!Number.isInteger(counter) || counter <= entry.lastCounter) {
    return { ok: false, error: 'bad or replayed counter' };
  }
  entry.lastCounter = counter;
  return { ok: true };
}

// Decrypt + authenticate an encrypted envelope { iv, ct, mac } for the given
// method/path. Encrypt-then-MAC: verify the MAC over the ciphertext BEFORE
// decrypting. Returns { ok, plaintext } or { ok:false, status, error }.
function openEnvelope(method, pathname, rawBody) {
  let env;
  try {
    env = JSON.parse(rawBody);
  } catch (e) {
    return { ok: false, status: 400, error: 'invalid JSON envelope' };
  }
  if (!env || typeof env.iv !== 'string' || typeof env.ct !== 'string' || typeof env.mac !== 'string') {
    return { ok: false, status: 400, error: 'missing iv/ct/mac' };
  }

  const macInput = `${method}\n${pathname}\n${env.iv}\n${env.ct}`;
  const expected = crypto.createHmac('sha256', MAC_KEY).update(macInput).digest();
  if (!macOk(env.mac, expected)) return { ok: false, status: 401, error: 'bad mac' };

  let iv, ct;
  try {
    iv = Buffer.from(env.iv, 'base64');
    ct = Buffer.from(env.ct, 'base64');
  } catch (e) {
    return { ok: false, status: 400, error: 'bad base64' };
  }
  if (iv.length !== 12) return { ok: false, status: 400, error: 'bad iv length' };

  const pt = Buffer.from(chacha20.xor(ENC_KEY, iv, 1, ct));
  return { ok: true, plaintext: pt.toString('utf8') };
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, urlPath) {
  // Resolve within PUBLIC_DIR only; guard against path traversal.
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJSON(res, 403, { error: 'Forbidden' });
    return;
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      sendJSON(res, 404, { error: 'Not found' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(content);
  });
}

// Normalize a /key payload into an actions array.
function normalizeActions(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.actions)) return body.actions;
  if (body && typeof body === 'object') return [body];
  return null;
}

function clampInt(x) {
  const n = Math.round(Number(x));
  if (!Number.isFinite(n)) return 0;
  return Math.max(-10000, Math.min(10000, n));
}

// Execute one decrypted op.
//   { t:'k', b:<actions> }            keypress
//   { t:'m', k:'mv', dx, dy }         relative mouse move (drag while a btn is held)
//   { t:'m', k:'cl', btn:'l'|'r' }    mouse click (down+up)
//   { t:'m', k:'dn', btn:'l'|'r' }    mouse button down (hold)
//   { t:'m', k:'up', btn:'l'|'r' }    mouse button up (release)
//   { t:'m', k:'sc', dy }             scroll wheel
async function runOp(op) {
  if (!op || typeof op !== 'object') throw new Error('bad op');
  if (op.t === 'k') {
    const actions = normalizeActions(op.b);
    if (!actions) throw new Error('expected action object or array');
    return run(actions);
  }
  if (op.t === 'm') {
    if (op.k === 'mv') return mouse.send({ k: 'mv', dx: clampInt(op.dx), dy: clampInt(op.dy) });
    if (op.k === 'cl') return mouse.send({ k: 'cl', btn: op.btn === 'r' ? 'r' : 'l' });
    if (op.k === 'dn') return mouse.send({ k: 'dn', btn: op.btn === 'r' ? 'r' : 'l' });
    if (op.k === 'up') return mouse.send({ k: 'up', btn: op.btn === 'r' ? 'r' : 'l' });
    if (op.k === 'sc') return mouse.send({ k: 'sc', dy: clampInt(op.dy) });
    throw new Error('bad mouse op');
  }
  throw new Error('unknown op type');
}

// Execute a batch of ops in order (the client coalesces keystrokes per flush).
async function dispatchOps(res, ops) {
  const list = Array.isArray(ops) ? ops : [ops];
  if (list.length === 0) return sendJSON(res, 400, { error: 'empty batch' });
  try {
    let last;
    for (const op of list) last = await runOp(op);
    const extra = last && last.dryRun ? { dryRun: true, script: last.script } : {};
    return sendJSON(res, 200, { ok: true, n: list.length, ...extra });
  } catch (err) {
    console.error('Dispatch error:', err.message);
    return sendJSON(res, 500, { error: err.message });
  }
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  // Public endpoints (no auth): the page/assets and nonce issue.
  if (req.method === 'GET' && pathname === '/nonce') {
    return sendJSON(res, 200, { nonce: createNonce(), ttlMs: NONCE_TTL_MS });
  }

  // Single authenticated + encrypted endpoint. The body is an encrypt-then-MAC
  // envelope; the decrypted plaintext carries the auth nonce, counter, and the
  // operation — so nothing about the keystroke is visible on the wire.
  if (req.method === 'POST' && pathname === '/msg') {
    let rawBody;
    try {
      rawBody = await readBody(req);
    } catch (err) {
      return sendJSON(res, 400, { error: err.message });
    }

    const opened = openEnvelope('POST', pathname, rawBody);
    if (!opened.ok) return sendJSON(res, opened.status, { error: opened.error });

    let msg;
    try {
      msg = JSON.parse(opened.plaintext);
    } catch (e) {
      return sendJSON(res, 400, { error: 'bad plaintext' });
    }

    const check = checkNonceCounter(msg.n, msg.c);
    if (!check.ok) return sendJSON(res, 401, { error: check.error });

    // Second-layer auth: the decrypted payload must carry the token (msg.p) whose
    // hash matches the one on disk. Read access to the disk alone can't produce it.
    if (!tokenOk(msg.p)) return sendJSON(res, 401, { error: 'bad or missing token' });

    return dispatchOps(res, msg.o);
  }

  if (req.method === 'GET') {
    return serveStatic(req, res, pathname);
  }

  sendJSON(res, 405, { error: 'Method not allowed' });
}

const server = TLS
  ? https.createServer({ cert: TLS.cert, key: TLS.key }, handler)
  : http.createServer(handler);

// Docker's default bridge networks live in 172.16.0.0/12 (docker0 is usually
// 172.17.0.1, compose networks 172.18+). These are almost never the address the
// phone should reach, so we sort them to the back rather than dropping them.
function isDockerIp(ip) {
  const m = /^172\.(\d+)\./.exec(ip);
  return m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

function lanAddresses() {
  const out = new Set();
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.add(iface.address);
    }
  }
  // Prioritise real LAN addresses over Docker bridge IPs (kept, just last).
  return [...out].sort((a, b) => isDockerIp(a) - isDockerIp(b));
}

function sh(bin, args) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

// The Bonjour/mDNS hostname (e.g. "mac-air.local"). This is the LocalHostName
// (`scutil --get LocalHostName`) — the name mDNS actually answers to. We do NOT
// fall back to os.hostname(): that's the kernel HostName, set dynamically from
// DHCP/reverse-DNS or the ComputerName, so it can be wrong (e.g. "MacbookAir")
// or not even a valid .local label (e.g. "Mac Air"). If scutil has no answer
// (non-macOS, or the early-boot window before LocalHostName is set), return null
// and let the caller fall back to a LAN IP instead.
function localHostname() {
  if (process.platform !== 'darwin') return null;
  const name = sh('scutil', ['--get', 'LocalHostName']);
  return name ? name + '.local' : null;
}

// This node's MagicDNS name on the tailnet, read straight from the Tailscale
// daemon — the authoritative source, decoupled from the OS hostname. Returns
// Self.DNSName (which always resolves via MagicDNS regardless of the device's
// search domains), else the short HostName, else null when Tailscale isn't
// installed/running or no tailnet is up.
function tailscaleSelf() {
  const bins = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  for (const bin of bins) {
    const out = sh(bin, ['status', '--json']);
    if (!out) continue;
    try {
      const status = JSON.parse(out);
      // When Tailscale is switched off the daemon still reports Self, so skip it
      // unless the tailnet is actually up.
      if (status.BackendState === 'Stopped') continue;
      const self = status.Self || {};
      const name = self.DNSName ? self.DNSName.replace(/\.$/, '') : (self.HostName || null);
      if (!name) continue; // strip trailing dot from the FQDN above
      return name;
    } catch {}
  }
  return null;
}

// Does the served certificate vouch for this host? Always true over plain HTTP
// (there is no certificate to disagree with). Used to pick the advertised name
// and to warn instead of printing a QR the phone would refuse. TLS.cert is the
// full chain; X509Certificate parses its first PEM block — the leaf.
function certCovers(host) {
  if (!TLS) return true;
  try {
    const x509 = new crypto.X509Certificate(TLS.cert);
    return /^\d+\.\d+\.\d+\.\d+$/.test(host)
      ? Boolean(x509.checkIP(host))
      : Boolean(x509.checkHost(host));
  } catch {
    return true; // unparseable cert -> don't invent warnings; TLS itself still works
  }
}

// Resolve the address to advertise into { url, kind, ips }, where kind is one of
// 'custom' | 'tailscale' | 'local' | 'ip' | 'none' (used to tailor the pairing
// banner and its warnings). `ips` is the list of auto-detected LAN IPv4
// addresses, only set for kind 'ip'. For 'none' there's no address to advertise.
//   tailscale -> MagicDNS name
//   wifi      -> .local mDNS name
//   detect    -> MagicDNS name if a tailnet is up, else the .local name
// Hostname modes fall back to auto-detected LAN IP(s), never to localhost (the
// phone can't reach that).
//
// Only ever called on a pairing run, so this is where strictness belongs: the
// address chosen here is baked into the QR and the phone keeps it for good, and
// a pairing pointing somewhere the phone can't reach is worse than no pairing.
function resolveBase() {
  if (OVERRIDE_URL) return { url: OVERRIDE_URL, kind: 'custom' };

  let host = null;
  let kind = null;
  if (MODE === 'tailscale') {
    host = tailscaleSelf();
    if (!host) {
      // Asked to pair over the tailnet with no tailnet to pair over. Quietly
      // pairing to a LAN address instead would hand the phone an address it
      // keeps forever and a transport the user didn't choose, so stop.
      console.error('\n❌ Tailscale mode: no tailnet detected (is Tailscale running and');
      console.error('   signed in on this Mac?). Refusing to pair against a LAN address');
      console.error('   you did not ask for — the phone would keep it. Start Tailscale and');
      console.error('   try again, or pair on your Wi-Fi with:  ./start.sh wifi');
      process.exit(1);
    }
    kind = 'tailscale';
  } else if (MODE === 'wifi') {
    host = localHostname();
    if (host) kind = 'local';
  } else { // detect
    const ts = tailscaleSelf();
    const local = localHostname();
    // Prefer the tailnet when one is up — unless we're serving HTTPS with a
    // certificate that vouches for the .local name but not the MagicDNS name
    // (gen-cert.sh's default): a QR the phone refuses helps nobody, so pick
    // the name the certificate actually covers.
    const preferLocal = ts && local && !certCovers(ts) && certCovers(local);
    if (ts && !preferLocal) { host = ts; kind = 'tailscale'; }
    else if (local) { host = local; kind = 'local'; }
  }

  if (host) return { url: `${SCHEME}://${host}:${PORT}/`, kind };

  // No hostname: fall back to auto-detected LAN IPv4 address(es).
  const ips = lanAddresses();
  if (ips.length) return { url: `${SCHEME}://${ips[0]}:${PORT}/`, kind: 'ip', ips };
  return { url: null, kind: 'none' };
}

// Append a fragment (replacing any existing one). The pairing fragment carries
// the master pairing key; it is never sent to the server.
function withFragment(base, frag) {
  const hash = base.indexOf('#');
  return (hash >= 0 ? base.slice(0, hash) : base) + '#' + frag;
}

// Render a QR, or fall back to just the link if the payload overflows the fixed
// v5 QR capacity (can happen with a long Tailscale/custom host + both creds).
function printQR(url) {
  try {
    qrcode.generate(url, { small: true });
  } catch (err) {
    console.log('   (link is too long to draw as a QR here — open the URL below directly)');
  }
}

// Bind all interfaces (unless HOST is set). Deliberately not the tailnet
// interface even in Tailscale mode: binding 0.0.0.0 always succeeds, so there's
// no address-not-available race while Tailscale comes up, the server survives
// the tailnet's IP changing, and a server started before the tailnet is up stays
// up and starts working when it arrives. What reaches the input path is decided
// by the pairing crypto, not by the address a request arrived on.
const bindHost = HOST_OVERRIDE || '0.0.0.0';

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use. Stop the other process, or set PORT=<n>.`);
  } else {
    console.error('\n❌ Server failed to start:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, bindHost, () => {
  console.log('diy-mac-remote server running.');
  if (TLS) {
    console.log(`🔒 Serving HTTPS (cert: ${TLS_CERT_FILE}).`);
  } else {
    console.log('   Serving plain HTTP. To serve HTTPS, run ./install-self-signed.sh');
    console.log('   (or ./setup-https.sh). See README > "Serve it over HTTPS".');
  }
  if (process.platform !== 'darwin') {
    console.log('NOTE: not running on macOS — keypresses will be logged, not executed (dry-run).');
  }

  // --- Pairing -----------------------------------------------------------------
  // The QR hands the phone the MASTER in the #fragment (never sent to the
  // server); the page derives the secret + token from it. It can only be shown
  // right after minting it (first run, or after an app-secrets reset) — on a
  // normal restart it's gone by design (disk holds only the derived secret and
  // the token's hash). So a restart has nothing to hand out and prints no
  // address either: the paired app carries the one it was paired with, and
  // nobody wants to retype a hostname. An unpaired phone needs a reset, not a
  // link.

  if (!MASTER) {
    console.log('\nOn the iPhone, open the Home Screen app you saved for this server —');
    console.log('it kept its pairing, and the address that goes with it.');
    console.log('\nNo Home Screen app, or the pairing was lost? Reset the app secrets and');
    console.log('start again — a fresh pairing QR prints then (every device re-pairs):');
    console.log('  reset-app-secrets.command in the Desktop diy-mac-remote folder,');
    console.log('  or: node server.js --reset-token');
    return;
  }

  // A fresh pairing was minted — this is the one time it can be shown. Every
  // warning below is about the pairing being made right now: the address in the
  // QR is what the phone stores and reuses for good, so this is the moment to
  // get it right.

  const { url: base, kind, ips } = advertised;

  if (kind === 'none') {
    // Minted, but no address to build the QR from. The key is already gone
    // (never written to disk), so after fixing the network a reset is the way
    // to get a fresh QR.
    console.log('\n⚠️  A new pairing was minted, but no address for this Mac could be');
    console.log('   detected, so the pairing QR cannot be shown. Connect the Mac to the');
    console.log(`   network your phone uses (or pass a URL: node server.js http://<ip>:${PORT}/),`);
    console.log('   then reset the app secrets and start again for a fresh QR:');
    console.log('   reset-app-secrets.command (or: node server.js --reset-token)');
    return;
  }

  // Raw auto-detected IP: it might be the wrong interface — help the user pick.
  if (kind === 'ip') {
    if (ips.length > 1) {
      console.log(`\n⚠️  No hostname found — several LAN IPs detected; the QR uses ${ips[0]}.`);
      console.log('   If it doesn\'t work, pass the right one as the first parameter:');
      console.log(`     node server.js http://<ip>:${PORT}/`);
    } else {
      console.log('\n⚠️  No hostname found — this IP was auto-detected. If the QR doesn\'t');
      console.log(`   work, pass the right one: node server.js http://<ip>:${PORT}/`);
    }
  }

  // Over plain HTTP a LAN address trusts the local network — an active attacker
  // on a compromised router can rewrite the page itself (see README › Security).
  // With HTTPS + an installed CA that gap is closed, so no warning then.
  if ((kind === 'local' || kind === 'ip') && !TLS) {
    console.log('\n⚠️  Pairing to a LAN address over plain HTTP — only safe on a network');
    console.log('   whose router you trust. On an untrusted network, use Tailscale.');
  }

  // With HTTPS on, an address the certificate doesn't vouch for is a dead end —
  // the phone will refuse the page. Say so up front, with the fix.
  let advertHost = null;
  try { advertHost = new URL(base).hostname; } catch {}
  if (advertHost && !certCovers(advertHost)) {
    console.log(`\n⚠️  The certificate does not cover ${advertHost} — the phone will refuse`);
    console.log(`   this address. Re-run the setup naming it (./setup-https.sh ${advertHost}),`);
    console.log('   or pair against the covered .local name instead: ./start.sh wifi');
  }

  if (TLS) {
    console.log('\nFirst time on this phone: install & trust the CA once — the file and');
    console.log('the steps are in the diy-mac-remote folder on the Desktop.');
  }

  const where =
    kind === 'tailscale' ? 'same Tailscale tailnet' :
    kind === 'local' ? 'same Wi-Fi' :
    kind === 'custom' ? 'wherever this URL reaches the Mac' : 'same LAN';
  const authUrl = withFragment(base, MASTER);
  console.log(`\nScan to pair — in Safari on the iPhone (${where}):`);
  printQR(authUrl);
  console.log(authUrl + '\n');
  console.log('After pairing: add the page to your Home Screen (Share → Add to Home');
  console.log('Screen) so the credentials are stored, then restart this server —');
  console.log('the pairing key above should not stay on screen.\n');
});
