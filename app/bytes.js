'use strict';

// Byte-level helpers shared by everything that touches the crypto: UTF-8,
// hex, base64, and a constant-time comparison.
//
// All of it is hand-rolled because the app now runs inside
// `osascript -l JavaScript`, and JavaScriptCore there is the bare language:
// no Buffer, no TextEncoder, no atob/btoa, no crypto. Uint8Array it does have,
// so that is the currency every function here deals in.
//
// (The page, public/index.html, has always been in the same position — served
// over plain HTTP it gets no window.crypto.subtle — which is why it carries its
// own copies too. test/parity.test.js pins the two sides together.)

// UTF-8 encode a JS string (UTF-16, surrogate pairs and all) to bytes.
function utf8Encode(str) {
  var s = String(str);
  var out = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    // A high surrogate followed by a low one is one code point, not two.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      var next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0x10000) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f),
               0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

// UTF-8 decode bytes back to a JS string. Malformed sequences become U+FFFD
// rather than throwing: this decodes attacker-supplied plaintext (a decrypted
// envelope), and the JSON.parse that follows is the real gate.
function utf8Decode(bytes) {
  var out = '';
  var i = 0;
  while (i < bytes.length) {
    var b = bytes[i++];
    var cp, need;
    if (b < 0x80) { cp = b; need = 0; }
    else if ((b & 0xe0) === 0xc0) { cp = b & 0x1f; need = 1; }
    else if ((b & 0xf0) === 0xe0) { cp = b & 0x0f; need = 2; }
    else if ((b & 0xf8) === 0xf0) { cp = b & 0x07; need = 3; }
    else { out += '�'; continue; }
    if (i + need > bytes.length) { out += '�'; break; }
    for (var k = 0; k < need; k++) {
      var cb = bytes[i++];
      if ((cb & 0xc0) !== 0x80) { cp = -1; break; }
      cp = (cp << 6) | (cb & 0x3f);
    }
    if (cp < 0) { out += '�'; continue; }
    if (cp > 0xffff) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
  }
  return out;
}

function toHex(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) s += (bytes[i] + 0x100).toString(16).slice(1);
  return s;
}

// Parse hex to bytes, or null if it isn't clean hex of even length. Used on
// values that arrive from the wire (MACs) and from disk (the token hash), so
// "not hex" has to be an answer rather than an exception.
function fromHex(hex) {
  var s = String(hex);
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) return null;
  var out = new Uint8Array(s.length / 2);
  for (var i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

// Decoding only: base64 arrives from two directions — the iv/ct a client sent,
// and the random bytes a host hands us — and never has to be produced here.
var B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var B64_INDEX = (function () {
  var m = {};
  for (var i = 0; i < B64_CHARS.length; i++) m[B64_CHARS.charAt(i)] = i;
  return m;
})();

// Decode base64 to bytes, or null if the input isn't valid base64. Strict on
// purpose — this parses the iv/ct a client sent us, and quietly "decoding"
// garbage into shorter-than-expected bytes is how length checks get bypassed.
// Whitespace is tolerated; anything else (including base64url's -_ ) is not.
function b64Decode(str) {
  var s = String(str).replace(/[\s]/g, '');
  var pad = 0;
  while (s.length && s.charAt(s.length - 1) === '=') { s = s.slice(0, -1); pad++; }
  if (pad > 2 || s.length % 4 === 1) return null;
  var out = new Uint8Array((s.length * 3) >> 2);
  var acc = 0, bits = 0, o = 0;
  for (var i = 0; i < s.length; i++) {
    var v = B64_INDEX[s.charAt(i)];
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

// base64 -> base64url (URL-safe alphabet, no padding). The pairing master
// travels in a URL fragment and inside a QR, so neither + / nor = may appear.
function b64ToUrl(b64) {
  return String(b64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Constant-time equality. Compares every byte of equal-length inputs so the
// time taken says nothing about how far a guess got — the property that makes
// MAC and token checks safe to expose to an attacker who can retry.
function equal(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

module.exports = {
  utf8Encode: utf8Encode,
  utf8Decode: utf8Decode,
  toHex: toHex,
  fromHex: fromHex,
  b64Decode: b64Decode,
  b64ToUrl: b64ToUrl,
  equal: equal,
};
