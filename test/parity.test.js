'use strict';
// The page (public/index.html) ships its OWN inlined SHA-256 and ChaCha20, plus
// its own copy of the credential derivation. If either drifts from the server the
// whole thing silently stops interoperating. These tests run the page's inlined
// modules in a sandbox and assert byte-for-byte agreement with the server side.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');
const { test, assert } = require('./harness');
const chacha20 = require('../chacha20');
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

test('page credential derivation matches the server derivation', () => {
  for (const master of ['abc', 'AZ90-_xy', crypto.randomBytes(16).toString('base64url')]) {
    const pageSecret = pageSha256hex('diy-mac-remote-secret:' + master);
    const pageToken = pageSha256hex('diy-mac-remote-authtoken:' + master);
    const server = deriveCreds(master);
    assert.strictEqual(pageSecret, server.secret, 'secret derivation drifted');
    assert.strictEqual(pageToken, server.token, 'token derivation drifted');
  }
});
