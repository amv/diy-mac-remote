'use strict';
// Shared test utilities (not a *.test.js, so the runner won't treat it as a suite).
const crypto = require('crypto');
const cp = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const chacha20 = require('../app/chacha20');

const PROJECT_ROOT = path.join(__dirname, '..');

function sha256hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// Derive both credentials from a pairing master — must match server.js and the
// page's inlined derivation exactly (same prefixes).
function deriveCreds(master) {
  return {
    secret: sha256hex('diy-mac-remote-secret:' + master),
    token: sha256hex('diy-mac-remote-authtoken:' + master),
  };
}

// Build a browser-equivalent /msg envelope for one keypress op. Pass
// includeToken=false to omit `p` entirely (to test the missing-token path).
function buildEnvelope(secret, token, nonce, counter, includeToken) {
  const encKey = crypto.createHash('sha256').update('diy-mac-remote-enc:' + secret).digest();
  const macKey = crypto.createHash('sha256').update('diy-mac-remote-mac:' + secret).digest();
  const msg = { n: nonce, c: counter, o: [{ t: 'k', b: { text: 'x' } }] };
  if (includeToken) msg.p = token;
  const plain = Buffer.from(JSON.stringify(msg), 'utf8');
  const target = Math.ceil((plain.length + 1) / 256) * 256; // pad to 256B multiple
  const padded = Buffer.alloc(target, 0x20);
  plain.copy(padded);
  const iv = crypto.randomBytes(12);
  const ct = Buffer.from(chacha20.xor(encKey, iv, 1, padded));
  const ivB = iv.toString('base64'), ctB = ct.toString('base64');
  const mac = crypto.createHmac('sha256', macKey).update('POST\n/msg\n' + ivB + '\n' + ctB).digest('hex');
  return JSON.stringify({ iv: ivB, ct: ctB, mac });
}

// Ask the OS for a free TCP port (tiny bind-then-close; good enough for tests).
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

const spawned = [];
process.on('exit', () => { for (const c of spawned) { try { c.kill('SIGKILL'); } catch (e) {} } });

// Start server.js pointed at 127.0.0.1:port with a throwaway HOME, so the test's
// credentials live in a temp dir. Resolves once it's listening. `out()` returns
// everything printed so far (banner + QR).
// The two entrypoints take the same arguments and answer the same HTTP, which
// is the point of them — so the tests spawn them through one function.
// `perl: true` runs the Node-free path (perl server.pl) instead of server.js.
function entrypointCommand(perl, positional, args) {
  return perl
    ? { bin: 'perl', argv: ['server.pl', ...positional, ...args] }
    : { bin: process.execPath, argv: ['server.js', ...positional, ...args] };
}

function startServer({ home, port, args = [], url, env = {}, perl = false }) {
  return new Promise((resolve, reject) => {
    // Default: pass a custom URL so resolveBase() short-circuits to 'custom' (no
    // host detection). Pass url:null to omit it and let a mode arg (wifi/tailscale/
    // detect) drive resolution — needed to exercise the mode-specific pairing paths.
    const positional = url === null ? [] : [url || `http://127.0.0.1:${port}/`];
    const cmd = entrypointCommand(perl, positional, args);
    const child = cp.spawn(cmd.bin, cmd.argv,
      { cwd: PROJECT_ROOT, env: { ...process.env, HOME: home, PORT: String(port), ...env } });
    spawned.push(child);
    let out = '';
    let settle = null;
    const timer = setTimeout(() => reject(new Error('server start timeout\n' + out)), 5000);
    const onData = (c) => {
      out += c;
      // "server running" is printed once the socket is bound AND the backend has
      // resolved its credentials; the banner (and any QR) follows it over the
      // backend's stderr. Wait for the output to go quiet so out() has all of it.
      if (/server running/.test(out)) {
        clearTimeout(timer);
        clearTimeout(settle);
        settle = setTimeout(() => resolve({ child, out: () => out }), 200);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', reject);
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    const i = spawned.indexOf(child);
    if (i >= 0) spawned.splice(i, 1);
    child.on('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

// A request shaped like the page's: a string body with its length up front,
// which is what fetch() sends and the only thing either entrypoint accepts.
// (Leaving Content-Length off makes Node chunk the body — see the 411 case in
// assertStaticParity.)
function httpReq(port, method, p, body) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const headers = body
      ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      : {};
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// Fetch a path and keep the body as bytes — for the static files, where the
// point is that what arrives is what is on disk.
function httpBytes(port, method, p) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks),
      }));
    });
    r.on('error', reject);
    r.end();
  });
}

// public/ is served by the entrypoints, not by the backend — twice over, once
// in JavaScript and once in Perl. This is the behaviour both are held to, so
// that "the two entrypoints are interchangeable" stays true where it is easiest
// to let it drift.
//
// Both answer a static request by listing public/ and looking the requested
// path up in that listing, so anything that is not one of those files is a 404
// — including every shape of traversal, which is a path that was never in the
// listing rather than a path that got rejected.
async function assertStaticParity(port, assert) {
  const page = await httpBytes(port, 'GET', '/');
  assert.strictEqual(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.strictEqual(page.headers['cache-control'], 'no-store');
  assert.deepStrictEqual(page.body, fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'index.html')),
    'the page came back changed');

  const icon = await httpBytes(port, 'GET', '/icon-512.png');
  assert.strictEqual(icon.status, 200);
  assert.strictEqual(icon.headers['content-type'], 'image/png');
  assert.deepStrictEqual(icon.body, fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'icon-512.png')),
    'the PNG came back changed');

  const manifest = await httpBytes(port, 'GET', '/manifest.webmanifest');
  assert.strictEqual(manifest.status, 200);
  assert.strictEqual(manifest.headers['content-type'], 'application/manifest+json');

  // Only an exact match out of the directory listing is served. Nothing here is
  // a path this server ever builds, so there is nothing to escape from.
  for (const attempt of [
    '/../server.js',            // the obvious one
    '/a/../../server.js',       // ...and the one a normalizer might resolve
    '/./index.html',            // a path that names the right file, the wrong way
    '//index.html',             // ditto
    '/index.html/',             // ditto
    '/INDEX.HTML',              // the filesystem may not care about case; we do
    '/%2e%2e/server.js',        // percent-encoded, in case anything decodes it
    '/nope.txt',                // and a plain miss
  ]) {
    assert.strictEqual((await httpBytes(port, 'GET', attempt)).status, 404,
      `${attempt} should not be served`);
  }
  assert.strictEqual((await httpBytes(port, 'PUT', '/')).status, 405);

  // A body has to arrive with its length. Neither entrypoint decodes chunked
  // requests: the page never sends one, and a chunk decoder on the
  // unauthenticated path is parsing code answering to anyone who can reach the
  // port. (Node's own client chunks whenever it isn't told the length, which is
  // how this stays easy to check.)
  const chunked = await new Promise((resolve, reject) => {
    const r = require('http').request(
      { host: '127.0.0.1', port, method: 'POST', path: '/msg',
        headers: { 'Content-Type': 'application/json' } },  // no Content-Length
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', reject);
    r.write('{"iv":"","ct":"","mac":""}');
    r.end();
  });
  assert.strictEqual(chunked, 411, 'a chunked body should be refused, not decoded');
}

// Pull the base64url pairing master out of the printed URL fragment.
function pairMaster(out) {
  const m = out.match(/\/#([A-Za-z0-9_-]{20,})\b/);
  return m ? m[1] : null;
}

function mkTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'diymac-test-'));
}

// Write a throwaway `tailscale` CLI (into <dir>/bin) so the server's tailnet
// detection can be driven either way in tests without real Tailscale. Prepend
// the returned dir to PATH. `running: false` reports a stopped daemon, which is
// how tailscaleSelf() sees "no tailnet up".
function fakeTailscaleBin(dir, { running = true } = {}) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const json = JSON.stringify(running
    ? { BackendState: 'Running',
        Self: { DNSName: 'testmac.tail9f2c.ts.net.', HostName: 'testmac' } }
    : { BackendState: 'Stopped', Self: {} });
  fs.writeFileSync(path.join(bin, 'tailscale'),
    `#!/bin/sh\n[ "$1" = "status" ] && cat <<'JSON'\n${json}\nJSON\n`, { mode: 0o755 });
  return bin;
}

// Run server.js to completion (rather than waiting for it to listen) and resolve
// { code, out } — for the paths where startup is meant to refuse and exit.
function runServer({ home, port, args = [], url, env = {}, perl = false }) {
  return new Promise((resolve, reject) => {
    const positional = url === null ? [] : [url || `http://127.0.0.1:${port}/`];
    const cmd = entrypointCommand(perl, positional, args);
    const child = cp.spawn(cmd.bin, cmd.argv,
      { cwd: PROJECT_ROOT, env: { ...process.env, HOME: home, PORT: String(port), ...env } });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('did not exit\n' + out)); }, 5000);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

// Like httpReq, but choose the destination host and the client's SOURCE address
// (localAddress) — used to prove a non-loopback source is served like any other.
function httpFrom({ host = '127.0.0.1', port, localAddress, method = 'GET', path: p = '/nonce' }) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const r = http.request({ host, port, method, path: p, localAddress }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    r.end();
  });
}

// The first non-internal IPv4 on this host (a plausibly-"LAN" source address),
// or null if the box only has loopback.
function lanIPv4() {
  const ifs = os.networkInterfaces();
  for (const k of Object.keys(ifs)) for (const i of ifs[k] || [])
    if (i.family === 'IPv4' && !i.internal) return i.address;
  return null;
}

module.exports = {
  PROJECT_ROOT, sha256hex, deriveCreds, buildEnvelope, getFreePort,
  startServer, stopServer, runServer, httpReq, httpBytes, assertStaticParity,
  pairMaster, mkTempHome, fakeTailscaleBin, httpFrom, lanIPv4,
};
