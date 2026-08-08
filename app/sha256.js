'use strict';

// Pure-JS SHA-256 (FIPS 180-4) and HMAC-SHA256 (RFC 2104).
//
// Why a hand-written hash: the app runs inside `osascript -l JavaScript`, which
// gives us JavaScriptCore and nothing else — no node:crypto, no
// crypto.subtle. CommonCrypto is technically reachable through the ObjC bridge,
// but only by handing C functions raw byte pointers, which is exactly the kind
// of code that is hard to read and easy to get wrong.
//
// So this is the same algorithm the page already inlines (public/index.html),
// for the same reason it inlines it. test/parity.test.js runs both copies plus
// Node's native implementation over the same inputs and asserts they agree, so
// the duplication cannot silently drift.
//
// Everything here is synchronous and speaks Uint8Array.

var bytes = require('./bytes');

var K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

// SHA-256 of a Uint8Array -> Uint8Array(32).
function digest(msg) {
  var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  var h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  var l = msg.length;
  var bitLen = l * 8;
  var withOne = l + 1;
  var pad = (56 - (withOne % 64) + 64) % 64;
  var total = withOne + pad + 8;
  var buf = new Uint8Array(total);
  buf.set(msg, 0);
  buf[l] = 0x80;
  // 64-bit big-endian bit length (split to stay within 32-bit ops)
  var hi = Math.floor(bitLen / 0x100000000);
  var lo = bitLen >>> 0;
  buf[total - 8] = (hi >>> 24) & 0xff; buf[total - 7] = (hi >>> 16) & 0xff;
  buf[total - 6] = (hi >>> 8) & 0xff;  buf[total - 5] = hi & 0xff;
  buf[total - 4] = (lo >>> 24) & 0xff; buf[total - 3] = (lo >>> 16) & 0xff;
  buf[total - 2] = (lo >>> 8) & 0xff;  buf[total - 1] = lo & 0xff;

  var w = new Int32Array(64);
  var i;
  for (var off = 0; off < total; off += 64) {
    for (i = 0; i < 16; i++) {
      w[i] = (buf[off + i * 4] << 24) | (buf[off + i * 4 + 1] << 16) |
             (buf[off + i * 4 + 2] << 8) | (buf[off + i * 4 + 3]);
    }
    for (i = 16; i < 64; i++) {
      var x15 = w[i - 15], x2 = w[i - 2];
      var s0 = rotr(x15, 7) ^ rotr(x15, 18) ^ (x15 >>> 3);
      var s1 = rotr(x2, 17) ^ rotr(x2, 19) ^ (x2 >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (i = 0; i < 64; i++) {
      var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      var ch = (e & f) ^ (~e & g);
      var t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  var out = new Uint8Array(32);
  var hs = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (i = 0; i < 8; i++) {
    out[i * 4] = (hs[i] >>> 24) & 0xff; out[i * 4 + 1] = (hs[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (hs[i] >>> 8) & 0xff; out[i * 4 + 3] = hs[i] & 0xff;
  }
  return out;
}

// Accept a string (UTF-8 encoded) or bytes, as every caller here does.
function toBytes(input) {
  return (typeof input === 'string') ? bytes.utf8Encode(input) : input;
}

function hash(input) { return digest(toBytes(input)); }
function hashHex(input) { return bytes.toHex(digest(toBytes(input))); }

// HMAC-SHA256 -> Uint8Array(32). Block size is 64 bytes; keys longer than that
// are hashed first, shorter ones zero-padded (RFC 2104).
function hmac(key, message) {
  var k = toBytes(key);
  if (k.length > 64) k = digest(k);
  var pad = new Uint8Array(64);
  pad.set(k, 0);
  var ipad = new Uint8Array(64);
  var opad = new Uint8Array(64);
  for (var i = 0; i < 64; i++) {
    ipad[i] = pad[i] ^ 0x36;
    opad[i] = pad[i] ^ 0x5c;
  }
  var msg = toBytes(message);
  var inner = new Uint8Array(64 + msg.length);
  inner.set(ipad, 0);
  inner.set(msg, 64);
  var innerHash = digest(inner);
  var outer = new Uint8Array(64 + 32);
  outer.set(opad, 0);
  outer.set(innerHash, 64);
  return digest(outer);
}

module.exports = {
  digest: digest,       // bytes -> bytes
  hash: hash,           // string|bytes -> bytes
  hashHex: hashHex,     // string|bytes -> hex string
  hmac: hmac,           // (key, message) -> bytes
};
