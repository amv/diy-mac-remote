'use strict';
// Shared test utilities (not a *.test.js, so the runner won't treat it as a suite).
const crypto = require('crypto');
const cp = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const chacha20 = require('../chacha20');

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
function startServer({ home, port, args = [] }) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath,
      ['server.js', `http://127.0.0.1:${port}/`, ...args],
      { cwd: PROJECT_ROOT, env: { ...process.env, HOME: home, PORT: String(port) } });
    spawned.push(child);
    let out = '';
    const timer = setTimeout(() => reject(new Error('server start timeout\n' + out)), 5000);
    const onData = (c) => {
      out += c;
      if (/server running/.test(out) && /(Minted|Loaded)/.test(out)) {
        clearTimeout(timer);
        setTimeout(() => resolve({ child, out: () => out }), 150); // let listen() bind
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

function httpReq(port, method, p, body) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p,
      headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// Pull the base64url pairing master out of the printed URL fragment.
function pairMaster(out) {
  const m = out.match(/\/#([A-Za-z0-9_-]{20,})\b/);
  return m ? m[1] : null;
}

function mkTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'diymac-test-'));
}

module.exports = {
  PROJECT_ROOT, sha256hex, deriveCreds, buildEnvelope, getFreePort,
  startServer, stopServer, httpReq, pairMaster, mkTempHome,
};
