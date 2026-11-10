'use strict';
// Nonce bookkeeping: GET /nonce is unauthenticated, so what anyone can mint must
// never be able to push out a session a paired phone is using.
const path = require('path');
const fs = require('fs');
const { test, assert } = require('./harness');
const { createLoader } = require('../app/loader');
const pathutil = require('../app/pathutil');

const APP_DIR = path.join(__dirname, '..', 'app');

function loadEnvelope() {
  const loader = createLoader({
    readText: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
    exists: (p) => fs.existsSync(p),
    path: pathutil,
  });
  const previous = globalThis.__DIY_MAC_REMOTE_SYS__;
  globalThis.__DIY_MAC_REMOTE_SYS__ = {
    randomBase64: (n) => require('crypto').randomBytes(n).toString('base64'),
  };
  try { return loader.requireFrom(APP_DIR)('./envelope'); }
  finally { globalThis.__DIY_MAC_REMOTE_SYS__ = previous; }
}

test('anonymous nonce floods cannot evict a nonce that has been used', () => {
  const env = loadEnvelope();
  const session = env.create('secret');
  const live = session.createNonce();
  assert.ok(session.checkNonceCounter(live, 1).ok);
  for (let i = 0; i < env.MAX_NONCES * 3; i++) session.createNonce();
  assert.ok(session.checkNonceCounter(live, 2).ok, 'the live session was evicted');
});

test('when every nonce has been used, the oldest goes', () => {
  const env = loadEnvelope();
  const session = env.create('secret');
  const first = session.createNonce();
  session.checkNonceCounter(first, 1);
  for (let i = 0; i < env.MAX_NONCES; i++) {
    const n = session.createNonce();
    session.checkNonceCounter(n, 1);
  }
  assert.ok(!session.checkNonceCounter(first, 2).ok);
});
