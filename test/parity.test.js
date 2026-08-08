'use strict';
// One algorithm, three implementations. The page (public/index.html) inlines its
// own SHA-256 and ChaCha20 because a plain-HTTP page gets no crypto.subtle; the
// backend (app/) carries its own because JavaScriptCore under osascript has no
// node:crypto; and Node has the real thing. If any of them drifts, the phone and
// the Mac silently stop interoperating. These tests run the page's inlined
// modules in a sandbox and hold all three against each other.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');
const { test, assert } = require('./harness');
const chacha20 = require('../app/chacha20');
const { sha256hex, deriveCreds } = require('./helpers');

// Extract and run the page's <script> IIFEs (SHA256 is #1, ChaCha20 is #2) in a
// shared sandbox, then read the globals they publish.
function loadPageCrypto() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const root = {};
  const ctx = { self: root, globalThis: root };
  vm.createContext(ctx);
  vm.runInContext(scripts[0], ctx); // SHA-256 module
  vm.runInContext(scripts[1], ctx); // ChaCha20 module
  if (!root.SHA256 || !root.ChaCha20) throw new Error('page crypto not found in expected script order');
  return root;
}

const page = loadPageCrypto();
function pageSha256hex(s) {
  return page.SHA256.toHex(page.SHA256.bytes(page.SHA256.toBytes(s)));
}

test('page SHA-256 matches Node crypto (ASCII, base64url chars, Unicode)', () => {
  for (const s of ['', 'abc', 'diy-mac-remote-secret:AZ90-_xY', 'こんにちは', 'x'.repeat(200)]) {
    assert.strictEqual(pageSha256hex(s), sha256hex(s), `sha256 mismatch for ${JSON.stringify(s).slice(0, 24)}`);
  }
});

test('page ChaCha20 matches server chacha20.js', () => {
  for (let i = 0; i < 10; i++) {
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const data = crypto.randomBytes(1 + i * 25);
    const fromPage = Buffer.from(page.ChaCha20.xor(key, nonce, 1, data)).toString('hex');
    const fromServer = Buffer.from(chacha20.xor(key, nonce, 1, data)).toString('hex');
    assert.strictEqual(fromPage, fromServer, `chacha20 mismatch at case ${i}`);
  }
});

// The backend can't use node:crypto either — under `osascript -l JavaScript`
// there is no such thing — so app/sha256.js is a third copy of the same
// algorithm. Three implementations, one answer, or the phone and the Mac stop
// understanding each other.
test('the backend SHA-256 and HMAC match Node crypto and the page', () => {
  const appSha = require('../app/sha256');
  for (const s of ['', 'abc', 'diy-mac-remote-secret:AZ90-_xY', 'こんにちは', 'x'.repeat(200)]) {
    assert.strictEqual(appSha.hashHex(s), sha256hex(s), `app sha256 mismatch for ${JSON.stringify(s).slice(0, 24)}`);
    assert.strictEqual(appSha.hashHex(s), pageSha256hex(s), 'app and page sha256 disagree');
  }
  for (let i = 0; i < 8; i++) {
    const key = crypto.randomBytes(1 + i * 9);
    const msg = crypto.randomBytes(i * 40);
    assert.strictEqual(
      Buffer.from(appSha.hmac(key, msg)).toString('hex'),
      crypto.createHmac('sha256', key).update(msg).digest('hex'),
      `app hmac mismatch at case ${i}`);
  }
});

test('the backend base64 and UTF-8 match Node', () => {
  const bytes = require('../app/bytes');
  for (let i = 0; i < 40; i++) {
    const raw = crypto.randomBytes(i);
    assert.deepStrictEqual(Buffer.from(bytes.b64Decode(raw.toString('base64'))), raw,
      `b64 decode mismatch at ${i}`);
  }
  // Not base64 must be null, not a shorter string of bytes: length checks
  // downstream (a 12-byte iv) are only as good as this.
  for (const bad of ['a', '****', 'AB=C', 'AA-_']) {
    assert.strictEqual(bytes.b64Decode(bad), null, `should have rejected ${bad}`);
  }
  for (const s of ['', 'abc', 'こんにちは', '🙂🙂', 'a\u0000b']) {
    assert.deepStrictEqual(Buffer.from(bytes.utf8Encode(s)), Buffer.from(s, 'utf8'), 'utf8 encode');
    assert.strictEqual(bytes.utf8Decode(Buffer.from(s, 'utf8')), s, 'utf8 decode');
  }
});

test('page credential derivation matches the server derivation', () => {
  for (const master of ['abc', 'AZ90-_xy', crypto.randomBytes(16).toString('base64url')]) {
    const pageSecret = pageSha256hex('diy-mac-remote-secret:' + master);
    const pageToken = pageSha256hex('diy-mac-remote-authtoken:' + master);
    const server = deriveCreds(master);
    assert.strictEqual(pageSecret, server.secret, 'secret derivation drifted');
    assert.strictEqual(pageToken, server.token, 'token derivation drifted');
  }
});
