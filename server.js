'use strict';

// The Node entrypoint: an HTTP (or HTTPS) socket in front of the backend.
//
// This file is a transport. It owns the port, the TLS certificate, the HTTP
// plumbing and the files in public/; it does not know what a nonce is, where
// the pairing secret lives, or how a keystroke is posted. Those two — GET
// /nonce and POST /msg — go to the backend, one long-lived process it starts
// and talks to over the line protocol in app/protocol.js. Everything else it
// answers itself, which is what keeps that protocol down to text.
//
// The backend is normally `osascript -l JavaScript`, so on a Mac the keyboard
// and the mouse are function calls inside that process rather than an osascript
// spawn per keystroke. Off macOS (or with DIY_MAC_REMOTE_BACKEND=node) the
// same application code runs under Node instead and logs what it would type.
//
// There is a second entrypoint, server.pl, which does this same job in Perl
// over plain HTTP — no Node anywhere. See README › "Run it without Node.js".
//
//   node server.js [detect|wifi|tailscale|<url>] [--tls|--no-tls] [--reset-token]

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const protocol = require('./app/protocol');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8765;
// Explicit bind-address override. Unset (the normal case) we bind all
// interfaces; set, we bind exactly that address — the way to narrow which
// interface the server answers on.
const HOST_OVERRIDE = process.env.HOST || null;
const ARGV = process.argv.slice(2);

const SECRET_DIR = path.join(require('os').homedir(), '.diy-mac-remote');

// TLS (optional). We serve HTTPS whenever a certificate + key exist — generate
// them with ./gen-cert.sh — and plain HTTP otherwise. `--no-tls` forces HTTP
// even if the files are present; `--tls` requires them (error out if missing).
// TLS_CERT / TLS_KEY override the default paths. The app already encrypts every
// request, so HTTPS is defence-in-depth: it stops an active man-in-the-middle
// from rewriting the page itself, and makes the page a secure context.
const TLS_DISABLED = ARGV.includes('--no-tls');
const TLS_FORCED = ARGV.includes('--tls');
const TLS_CERT_FILE = process.env.TLS_CERT || path.join(SECRET_DIR, 'cert.pem');
const TLS_KEY_FILE = process.env.TLS_KEY || path.join(SECRET_DIR, 'key.pem');

// The private key gets the same owner-only enforcement as the pairing secret
// (it is just as sensitive), checked on the open fd so there is no
// check-then-swap window. The certificate is public, so it's read normally.
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
      `The key may be exposed — remove ${SECRET_DIR} and restart to regenerate.`
    );
  }
}

// Load the TLS cert + key, or null to run plain HTTP. Returns null when the
// files are absent — unless `--tls` was given, in which case we insist on them.
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

// The names and IPs the certificate vouches for, for the backend to check the
// address it is about to bake into a pairing QR against. null means "no opinion"
// — no TLS, or a certificate we couldn't parse, in which case inventing warnings
// helps nobody and TLS itself still works.
function certHosts(tls) {
  if (!tls) return null;
  try {
    const x509 = new crypto.X509Certificate(tls.cert);
    const dns = [];
    const ip = [];
    for (const entry of String(x509.subjectAltName || '').split(', ')) {
      const sep = entry.indexOf(':');
      if (sep < 0) continue;
      const kind = entry.slice(0, sep).trim().toUpperCase();
      const value = entry.slice(sep + 1).trim();
      if (kind === 'DNS') dns.push(value);
      else if (kind === 'IP ADDRESS' || kind === 'IP') ip.push(value);
    }
    if (!dns.length && !ip.length) return null; // nothing usable — say nothing
    return { dns, ip };
  } catch {
    return null;
  }
}

let TLS;
try {
  TLS = loadTLS();
} catch (err) {
  console.error('\n❌ ' + err.message);
  process.exit(1);
}
const SCHEME = TLS ? 'https' : 'http';

// ---- the backend ------------------------------------------------------------

// Which interpreter runs the application. macOS gets JXA, where the input
// events are posted from inside the process; everything else gets Node, which
// logs them instead. DIY_MAC_REMOTE_BACKEND forces either one.
function backendCommand() {
  const forced = process.env.DIY_MAC_REMOTE_BACKEND;
  const useJxa = forced ? forced === 'jxa' : process.platform === 'darwin';
  if (useJxa) {
    return {
      bin: 'osascript',
      args: ['-l', 'JavaScript', path.join(ROOT, 'app', 'host-jxa.js')],
      kind: 'jxa',
    };
  }
  return { bin: process.execPath, args: [path.join(ROOT, 'app', 'host-node.js')], kind: 'node' };
}

// One long-lived child, one message at a time, answers in the order asked. The
// queue below is therefore a plain FIFO: whatever comes back belongs to the
// oldest outstanding request.
function startBackend() {
  const cmd = backendCommand();
  const child = spawn(cmd.bin, cmd.args, {
    // osascript finds the app directory through the environment: it is given a
    // script path, not a module, and has no __dirname of its own.
    env: { ...process.env, DIY_MAC_REMOTE_ROOT: ROOT },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = [];
  let buf = '';
  let dead = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    // A blank line ends a message, so "\n\n" is the boundary between them.
    let end;
    while ((end = buf.indexOf('\n\n')) >= 0) {
      const text = buf.slice(0, end + 1);
      buf = buf.slice(end + 2);
      const next = pending.shift();
      if (next) next.resolve(protocol.decode(text));
    }
  });

  // The backend's stderr is where its human output goes — log lines, warnings,
  // and the pairing QR itself. Pass it straight through.
  child.stderr.on('data', (d) => process.stdout.write(d));

  const die = (why) => {
    if (dead) return;
    dead = true;
    for (const p of pending.splice(0)) p.reject(new Error(why));
    console.error('\n❌ ' + why);
    process.exit(1);
  };
  // Writing to a backend that has just died raises EPIPE on the pipe, and an
  // unhandled 'error' event would take this process down with a stack trace
  // instead of the explanation below.
  child.stdin.on('error', () => {});
  child.stdout.on('error', () => {});
  child.stderr.on('error', () => {});

  child.on('exit', (code, signal) => die(
    `The ${cmd.kind} backend exited (code=${code}, signal=${signal}). ` +
    (cmd.kind === 'jxa'
      ? 'If this happened at startup, check that osascript can run: `osascript -l JavaScript -e "1+1"`.'
      : '')));
  child.on('error', (e) => die(`Could not start the ${cmd.kind} backend (${cmd.bin}): ${e.message}`));

  function send(message) {
    return new Promise((resolve, reject) => {
      if (dead) return reject(new Error('backend is gone'));
      pending.push({ resolve, reject });
      child.stdin.write(protocol.encode(message));
    });
  }

  return { send, kind: cmd.kind, child };
}

// ---- HTTP ------------------------------------------------------------------

const backend = startBackend();
let requestId = 0;

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        // Stop reading, but leave the socket alive long enough to say why —
        // destroying it here would leave the client with a bare connection
        // reset. Ending the response on an unfinished request closes it.
        over = true;
        req.pause();
        const err = new Error('Request body too large');
        err.status = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---- static files ----------------------------------------------------------
//
// public/ is served from here rather than from the backend, so no file bytes
// ever cross the line protocol — which is why that protocol can be plain text.
//
// A static request is answered by listing the directory and looking the
// requested path up in that listing. Nothing a client sends is ever joined onto
// a directory name or turned into a path: the path we open is one this server
// built from what it found on disk, and a request that doesn't match one of
// those exactly is a 404. There is no traversal to defend against, no
// normalization to get subtly wrong, and no encoding trick to try.
//
// Listing per request rather than once at startup costs a readdir of four
// files, and only on a page load — the phone loads the page once and then talks
// to /msg for the rest of the session. In exchange, a file dropped into
// public/ is served immediately, with nothing to restart.

const PUBLIC_DIR = path.join(ROOT, 'public');

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

// Walk public/ and record what is in it: "URL path -> the file it means".
// Symlinks are skipped — one could point anywhere at all, and "only what is in
// this directory" is the whole point.
function listPublic() {
  const table = new Map();
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // no public/ at all, or no permission — every path 404s
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      const url = prefix + '/' + entry.name;
      if (entry.isDirectory()) walk(file, url);
      else if (entry.isFile()) {
        table.set(url, {
          file,
          type: MIME[path.extname(entry.name).toLowerCase()] || 'application/octet-stream',
        });
      }
    }
  };
  walk(PUBLIC_DIR, '');
  if (table.has('/index.html')) table.set('/', table.get('/index.html'));
  return table;
}

function sendJSON(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
  });
  res.end(body);
}

function serveStatic(res, urlPath) {
  const entry = listPublic().get(urlPath);
  if (!entry) return sendJSON(res, 404, { error: 'Not found' });
  fs.readFile(entry.file, (err, content) => {
    if (err) return sendJSON(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': entry.type,
      'Cache-Control': 'no-store',
      'Content-Length': content.length,
    });
    res.end(content);
  });
}

// ---- routing ---------------------------------------------------------------
//
// Two paths need a secret to answer and go to the backend. Everything else is a
// file, or a mistake.
function needsBackend(method, pathname) {
  return (method === 'GET' && pathname === '/nonce') ||
         (method === 'POST' && pathname === '/msg');
}

async function handler(req, res) {
  const pathname = String(req.url || '/').split('?')[0];
  const method = (req.method || 'GET').toUpperCase();

  // A body must come with its length. The page always sends one (fetch sets
  // Content-Length for a string body), and server.pl accepts nothing else — so
  // refuse it here too rather than let the two entrypoints differ on what they
  // will read from a stranger.
  if (req.headers['transfer-encoding'] !== undefined) {
    req.resume();
    return sendJSON(res, 411,
      { error: 'Send a body with Content-Length; Transfer-Encoding is not accepted' });
  }

  if (!needsBackend(method, pathname)) {
    // Drain whatever came with it, so a body on a GET doesn't wedge keep-alive.
    req.resume();
    if (method === 'GET' || method === 'HEAD') return serveStatic(res, pathname);
    return sendJSON(res, 405, { error: 'Method not allowed' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJSON(res, err.status || 400, { error: err.message });
  }

  let answer;
  try {
    answer = await backend.send({
      t: 'req',
      id: ++requestId,
      method,
      path: req.url,
      // The body is bytes, not text: whatever the client sent goes across as
      // itself, and the backend decides whether it is JSON.
      body,
    });
  } catch (err) {
    return sendJSON(res, 502, { error: 'backend unavailable' });
  }

  const payload = Buffer.from(protocol.one(answer, 'body') || '', 'utf8');
  res.writeHead(Number(protocol.one(answer, 'status')) || 500, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': payload.length,
  });
  res.end(payload);
}

const server = TLS
  ? https.createServer({ cert: TLS.cert, key: TLS.key }, handler)
  : http.createServer(handler);

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

// The port is bound BEFORE the backend is asked to resolve its credentials: a
// pairing run mints a master, prints it once and forgets it, so discovering the
// port is taken afterwards would leave an install nothing can ever pair against.
server.listen(PORT, bindHost, async () => {
  const certs = certHosts(TLS) || { dns: [], ip: [] };
  const hello = await backend.send({
    t: 'hello',
    scheme: SCHEME,
    port: PORT,
    entry: 'node',
    arg: ARGV,
    'cert-dns': certs.dns,
    'cert-ip': certs.ip,
  });

  if (protocol.one(hello, 'ok') !== '1') {
    console.error('\n❌ ' + (protocol.one(hello, 'error') || 'the backend refused to start'));
    process.exit(1);
  }

  console.log('diy-mac-remote server running.');
  if (TLS) {
    console.log(`🔒 Serving HTTPS (cert: ${TLS_CERT_FILE}).`);
  } else {
    console.log('   Serving plain HTTP. To serve HTTPS, run ./install-self-signed.sh');
    console.log('   (or ./setup-https.sh). See README > "Serve it over HTTPS".');
  }
  console.log(`   Backend: ${backend.kind === 'jxa' ? 'osascript -l JavaScript' : 'node'}.`);
  if (protocol.one(hello, 'dry-run') === '1') {
    console.log('NOTE: input is being logged, not executed (dry-run) — this is not a Mac,');
    console.log('      or DIY_MAC_REMOTE_BACKEND=node was set.');
  }

  await backend.send({ t: 'banner' });
});
