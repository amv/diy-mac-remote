'use strict';

// ---- challenge-response auth (nonce + monotonic counter + HMAC-SHA256) ----
//
// Flow: client GETs /nonce, then signs every action request with
//   HMAC-SHA256(secret, METHOD\nPATH\nNONCE\nCOUNTER\nBODY)
// sent in the request envelope. The secret never travels on the wire; only the
// MAC does. The counter must strictly increase per nonce (replay protection),
// and nonces are random + in-memory only, so a server restart invalidates all
// old sessions. Nonces expire by TTL and are capped to bound memory.

var sys = require('./sys');
var sha256 = require('./sha256');
var chacha20 = require('./chacha20');
var bytes = require('./bytes');

var NONCE_TTL_MS = 60 * 60 * 1000; // 1 hour
var MAX_NONCES = 200;

// Build the crypto half of a session from the paired secret. Two subkeys are
// derived, because a key must never be shared between the cipher and the MAC.
function create(secret) {
  var encKey = sha256.hash('diy-mac-remote-enc:' + secret);
  var macKey = sha256.hash('diy-mac-remote-mac:' + secret);

  // nonce -> { lastCounter, created }. A plain object used as an ordered map:
  // JS keeps string keys in insertion order, which is what the cap below drops by.
  var nonces = Object.create(null);
  var nonceOrder = [];

  function drop(nonce) {
    delete nonces[nonce];
    var i = nonceOrder.indexOf(nonce);
    if (i >= 0) nonceOrder.splice(i, 1);
  }

  function prune() {
    var now = Date.now();
    for (var i = nonceOrder.length - 1; i >= 0; i--) {
      var key = nonceOrder[i];
      if (now - nonces[key].created > NONCE_TTL_MS) drop(key);
    }
    while (nonceOrder.length >= MAX_NONCES) drop(nonceOrder[0]); // oldest first
  }

  function createNonce() {
    prune();
    // 256-bit, unique in practice.
    var nonce = bytes.toHex(bytes.b64Decode(sys.randomBase64(32)));
    nonces[nonce] = { lastCounter: 0, created: Date.now() };
    nonceOrder.push(nonce);
    return nonce;
  }

  // Check a (nonce, counter) pair for validity + replay. Advances lastCounter on
  // success. Returns { ok } / { ok:false, error }.
  function checkNonceCounter(nonce, counter) {
    var entry = typeof nonce === 'string' ? nonces[nonce] : null;
    if (!entry) return { ok: false, error: 'unknown or expired nonce' };
    if (Date.now() - entry.created > NONCE_TTL_MS) {
      drop(nonce);
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
  function open(method, pathname, rawBody) {
    var env;
    try {
      env = JSON.parse(rawBody);
    } catch (e) {
      return { ok: false, status: 400, error: 'invalid JSON envelope' };
    }
    if (!env || typeof env.iv !== 'string' || typeof env.ct !== 'string' || typeof env.mac !== 'string') {
      return { ok: false, status: 400, error: 'missing iv/ct/mac' };
    }

    var macInput = method + '\n' + pathname + '\n' + env.iv + '\n' + env.ct;
    var expected = sha256.hmac(macKey, macInput);
    var got = bytes.fromHex(env.mac);
    if (!bytes.equal(got, expected)) return { ok: false, status: 401, error: 'bad mac' };

    var iv = bytes.b64Decode(env.iv);
    var ct = bytes.b64Decode(env.ct);
    if (!iv || !ct) return { ok: false, status: 400, error: 'bad base64' };
    if (iv.length !== 12) return { ok: false, status: 400, error: 'bad iv length' };

    return { ok: true, plaintext: bytes.utf8Decode(chacha20.xor(encKey, iv, 1, ct)) };
  }

  return {
    createNonce: createNonce,
    checkNonceCounter: checkNonceCounter,
    open: open,
    ttlMs: NONCE_TTL_MS,
  };
}

module.exports = { create: create, NONCE_TTL_MS: NONCE_TTL_MS, MAX_NONCES: MAX_NONCES };
