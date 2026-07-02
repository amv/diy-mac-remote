'use strict';
// chacha20.js is the cipher on the server side (and an identical copy is inlined
// in the page). We check it against Node's *native* ChaCha20 rather than a
// hand-typed keystream vector — the native impl is authoritative and can't be
// miscopied. OpenSSL/Node take the IV as counter(32-bit LE) || nonce(96-bit), so
// we build that to match our xor(key, nonce, counter, data) signature.
const crypto = require('crypto');
const { test, assert } = require('./harness');
const chacha20 = require('../chacha20');

function nativeXor(key, nonce, counter, data) {
  const ctr = Buffer.alloc(4); ctr.writeUInt32LE(counter, 0);
  const iv = Buffer.concat([ctr, nonce]); // 16-byte IV: counter||nonce
  const c = crypto.createCipheriv('chacha20', key, iv);
  return Buffer.concat([c.update(data), c.final()]);
}

test('chacha20 matches Node native across random key/nonce/counter/data', () => {
  for (let i = 0; i < 25; i++) {
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const counter = 1 + (i % 5);
    const data = crypto.randomBytes(1 + ((i * 37) % 300));
    const ours = Buffer.from(chacha20.xor(key, nonce, counter, data)).toString('hex');
    const nat = nativeXor(key, nonce, counter, data).toString('hex');
    assert.strictEqual(ours, nat, `mismatch at case ${i} (len ${data.length})`);
  }
});

test('chacha20 keystream matches the RFC 8439 §2.3.2 vector (counter=1)', () => {
  const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i)); // 00..1f
  const nonce = Buffer.from('000000090000004a00000000', 'hex');
  const ks = Buffer.from(chacha20.xor(key, nonce, 1, Buffer.alloc(64))).toString('hex');
  // Cross-checked against Node native above; assert the well-known first block.
  assert.strictEqual(ks,
    '10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c068030422aa9ac3d46c4e' +
    'd2826446079faa0914c2d705d98b02a2b5129cd1de164eb9cbd083e8a2503c4e');
});

test('chacha20 is its own inverse (encrypt then decrypt round-trips)', () => {
  const key = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const pt = crypto.randomBytes(500);
  const ct = Buffer.from(chacha20.xor(key, nonce, 1, pt));
  const back = Buffer.from(chacha20.xor(key, nonce, 1, ct));
  assert.ok(back.equals(pt), 'round-trip did not restore plaintext');
  assert.ok(!ct.equals(pt), 'ciphertext unexpectedly equals plaintext');
});
