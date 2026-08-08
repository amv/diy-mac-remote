'use strict';

// The entrypoint ⇄ backend protocol.
//
// FastCGI's idea at a thousandth of its weight: an entrypoint owns the socket
// and speaks HTTP to the phone; the backend owns the application and speaks
// this. A message is a run of `key: value` lines ended by a blank one —
//
//     t: req
//     id: 7
//     method: POST
//     path: /msg
//     body: {"iv":"5Nx...","ct":"Qk9...","mac":"1f3..."}
//
//     t: res
//     id: 7
//     status: 200
//     body: {"ok":true,"n":1}
//
// — and that is the entire format. No JSON on the wire, no framing headers, no
// chunking, nothing to parse beyond "split at the first colon". It is small
// enough to implement three times over (Node here, Perl in server.pl,
// JavaScriptCore under osascript) without a library on any side, and small
// enough to read straight off a pipe when something is wrong.
//
// The rules:
//
//   * One key per line, `key: value`. The first colon separates them; one space
//     after it is optional and eaten. Keys are fixed ASCII words.
//   * A blank line ends the message.
//   * A repeated key is a list, in order — that is how `arg` carries a whole
//     command line and `cert-dns` a whole certificate.
//   * Values are percent-encoded: any byte outside printable ASCII, and `%`
//     itself, is written `%XX`. So a value can never contain a newline (which
//     would break the framing), and a message is always pure ASCII — which
//     matters because the JXA host reads whatever chunk the pipe hands it, and
//     a multi-byte UTF-8 sequence split across two reads decodes to nothing.
//     Ordinary text survives the encoding unchanged and stays readable.
//   * Everything on the wire is bytes. A string is UTF-8 encoded before it is
//     percent-encoded, and decoded back the same way — so a value is text by
//     the time anyone reads it. That suits the only body there is: the /msg
//     envelope, which is JSON. Bytes that are not valid UTF-8 arrive as the
//     replacement character, and a request body like that was never going to
//     parse as an envelope anyway.
//   * The backend answers messages in the order it received them, so `id` is a
//     sanity check rather than a demultiplexer.
//   * The backend's stdout carries messages and nothing else; its stderr is
//     human output (log lines, the pairing QR), which the entrypoint relays.
//
// The messages themselves:
//
//   → hello   scheme, port, entry, arg*, cert-dns*, cert-ip*
//   ← hello   ok (1|0), dry-run (1|0), error*
//   → banner
//   ← banner  ok
//   → req     id, method, path, body
//   ← res     id, status, body
//
// Static files never appear here: the entrypoints serve public/ themselves. The
// backend answers /nonce and /msg, which are always JSON, so a response needs a
// status and a body and nothing else — no content types to carry, no bytes that
// aren't text.

var bytes = require('./bytes');

var HEX = '0123456789ABCDEF';

// Percent-encode one value. Accepts a string (UTF-8 encoded first) or raw bytes
// — an HTTP request body arrives as bytes and must not be assumed to be text.
function encodeValue(value) {
  var b = (typeof value === 'string') ? bytes.utf8Encode(value) : value;
  var out = '';
  for (var i = 0; i < b.length; i++) {
    var c = b[i];
    // Printable ASCII passes through, except '%' which introduces an escape.
    if (c >= 0x20 && c <= 0x7e && c !== 0x25) out += String.fromCharCode(c);
    else out += '%' + HEX.charAt(c >> 4) + HEX.charAt(c & 15);
  }
  return out;
}

function decodeValue(text) {
  var out = [];
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (ch === '%' && i + 2 < text.length && /^[0-9a-fA-F]{2}$/.test(text.substr(i + 1, 2))) {
      out.push(parseInt(text.substr(i + 1, 2), 16));
      i += 2;
    } else {
      out.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return bytes.utf8Decode(new Uint8Array(out));
}

// Serialize a message. Values may be strings, numbers, byte arrays, or arrays
// of those (a repeated key). Undefined and null values are left out entirely.
function encode(message) {
  var out = '';
  for (var key in message) {
    if (!Object.prototype.hasOwnProperty.call(message, key)) continue;
    var value = message[key];
    if (value === undefined || value === null) continue;
    var list = Array.isArray(value) ? value : [value];
    for (var i = 0; i < list.length; i++) {
      out += key + ': ' + encodeValue(typeof list[i] === 'number' ? String(list[i]) : list[i]) + '\n';
    }
  }
  return out + '\n';
}

// Parse the lines of one message into { key: [value, ...] }. Every key is a
// list, because any key may legitimately repeat; use one() when you want the
// single value a key is supposed to have.
function decode(text) {
  var message = {};
  var lines = text.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line) continue;
    var colon = line.indexOf(':');
    if (colon < 0) continue; // not a key line — ignore rather than fail
    var key = line.slice(0, colon);
    var raw = line.slice(colon + 1);
    if (raw.charAt(0) === ' ') raw = raw.slice(1);
    if (!message[key]) message[key] = [];
    message[key].push(decodeValue(raw));
  }
  return message;
}

// The value of a key that should appear once, or null.
function one(message, key) {
  var values = message[key];
  return (values && values.length) ? values[0] : null;
}

// The values of a key that may appear any number of times.
function all(message, key) {
  return message[key] || [];
}

module.exports = {
  encode: encode,
  decode: decode,
  one: one,
  all: all,
  encodeValue: encodeValue,
  decodeValue: decodeValue,
};
