'use strict';
// The line protocol between an entrypoint and the backend.
//
// It is deliberately tiny — `key: value` lines ended by a blank one — and it is
// implemented three times: here in JS (used by the Node entrypoint and both
// hosts), again in Perl in server.pl, and read by JavaScriptCore under
// osascript. What has to hold is that a value survives the trip unchanged, and
// that nothing a client can send can break the framing.
const crypto = require('crypto');
const { test, assert } = require('./harness');
const protocol = require('../app/protocol');

test('a message round-trips, keys and all', () => {
  const wire = protocol.encode({ t: 'req', id: 7, method: 'POST', path: '/msg', body: '{"a":1}' });
  assert.strictEqual(wire,
    't: req\nid: 7\nmethod: POST\npath: /msg\nbody: {"a":1}\n\n',
    'the wire format should stay this readable');
  const msg = protocol.decode(wire);
  assert.strictEqual(protocol.one(msg, 't'), 'req');
  assert.strictEqual(protocol.one(msg, 'id'), '7');
  assert.strictEqual(protocol.one(msg, 'body'), '{"a":1}');
  assert.strictEqual(protocol.one(msg, 'nope'), null);
});

test('a repeated key is a list, in order', () => {
  const wire = protocol.encode({ t: 'hello', arg: ['tailscale', '--reset-token'], 'cert-dns': [] });
  assert.strictEqual(wire, 't: hello\narg: tailscale\narg: --reset-token\n\n');
  assert.deepStrictEqual(protocol.all(protocol.decode(wire), 'arg'), ['tailscale', '--reset-token']);
  assert.deepStrictEqual(protocol.all(protocol.decode(wire), 'cert-dns'), []);
});

test('nothing a value contains can break the framing', () => {
  // A newline in a value would end the message early; a percent sign would
  // start an escape that isn't one. Both have to come back as themselves.
  const nasty = 'line\nbreak\r\n\nblank: line\n\n% percent %41 %zz \0 tab\there';
  const msg = protocol.decode(protocol.encode({ t: 'res', body: nasty }));
  assert.strictEqual(protocol.one(msg, 'body'), nasty);
  const wire = protocol.encode({ t: 'res', body: nasty });
  assert.strictEqual(wire.split('\n').length - 1, 3,
    'two keys and the blank line: exactly three newlines, however nasty the value');
});

test('values survive as bytes, whatever they hold', () => {
  for (const s of ['', 'abc', 'ä ö ü', '🙂 — ✓', 'x'.repeat(1000)]) {
    const msg = protocol.decode(protocol.encode({ t: 'res', body: s }));
    assert.strictEqual(protocol.one(msg, 'body'), s, `mangled: ${JSON.stringify(s)}`);
  }
  // An HTTP request body goes in as bytes and comes out as the text those
  // bytes spell — which is what /msg wants, since its envelope is JSON.
  const text = JSON.stringify({ iv: 'AAAA', ct: 'BBBB', mac: 'cc' });
  assert.strictEqual(
    protocol.one(protocol.decode(protocol.encode({ body: Buffer.from(text, 'utf8') })), 'body'),
    text, 'a JSON body must arrive byte-identical');

  // Bytes that are not valid UTF-8 are not text and cannot come back as text —
  // what matters is that they cannot break the framing or the message either.
  // (A body like that was never going to parse as an envelope anyway.)
  const junk = crypto.randomBytes(256);
  const wire = protocol.encode({ t: 'req', id: 1, body: junk });
  assert.ok(/^[\x20-\x7e\n]*$/.test(wire), 'random bytes escaped onto the wire');
  assert.strictEqual(wire.split('\n').length - 1, 4, 'random bytes stayed on one line');
  const decoded = protocol.decode(wire);
  assert.strictEqual(protocol.one(decoded, 'id'), '1', 'the rest of the message survived');
});

test('the encoding is pure ASCII, so a split read cannot corrupt it', () => {
  // The JXA host decodes whatever chunk the pipe hands it; a multi-byte UTF-8
  // sequence cut in half would decode to nothing at all.
  const wire = protocol.encode({ t: 'res', body: '🙂 ä ✓', error: 'no tailnet — refusing' });
  assert.ok(/^[\x20-\x7e\n]*$/.test(wire), 'non-ASCII escaped onto the wire: ' + wire);
});

test('a malformed line is ignored, not fatal', () => {
  const msg = protocol.decode('t: res\nthis line has no colon\n: empty key\nstatus: 200\n');
  assert.strictEqual(protocol.one(msg, 't'), 'res');
  assert.strictEqual(protocol.one(msg, 'status'), '200');
});
