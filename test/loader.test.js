'use strict';
// The application, loaded the way the Mac loads it.
//
// On a Mac the server runs inside `osascript -l JavaScript`: every module under
// app/ is read as text and evaluated with new Function by app/loader.js, and
// every platform call goes through a host implementation that is not Node's.
// None of that can be exercised on a Linux box — but all of it except the ObjC
// calls themselves can, by driving the *real* loader with node:fs readers and a
// stub host of our own.
//
// So this suite is the stand-in for the JXA host: if a module under app/ stops
// being loadable this way, or starts assuming something only Node provides, it
// fails here rather than on the Mac.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { test, assert } = require('./harness');
const { createLoader } = require('../app/loader');
const pathutil = require('../app/pathutil');
const { deriveCreds, buildEnvelope, pairMaster } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const APP_DIR = path.join(ROOT, 'app');

// A host that is deliberately not Node's: credential files live in a Map, input
// events are recorded instead of posted, and nothing here uses a Node API the
// JXA host couldn't match with Foundation.
function makeStubHost() {
  const files = new Map();
  const logs = [];
  const events = [];
  const sys = {
    platform: 'darwin', // exercise the macOS-only branches
    host: 'stub',
    dryRun: false,
    root: ROOT,
    env: (name) => (name === 'HOME' ? '/home/stub' : null),   // no DIRECT_CHARS
    homedir: () => '/home/stub',
    log: (msg) => { logs.push(String(msg)); },
    exists: (p) => files.has(p),
    assertOwnerOnly: () => {},
    readOwnedText: (file) => (files.has(file) ? files.get(file).trim() || null : null),
    writePrivateText: (p, text) => { files.set(p, text); },
    mkdirPrivate: (p) => { files.set(p, ''); },
    randomBase64: (n) => crypto.randomBytes(n).toString('base64'),
    exec: () => null,          // no scutil, no tailscale, no tmutil
    execDetached: () => {},
    lanAddresses: () => [],
    input: {
      keyScript: (source) => events.push({ script: source }),
      mouse: (cmd) => events.push({ mouse: cmd }),
      sleep: (seconds) => events.push({ sleep: seconds }),
    },
  };
  return { sys, files, logs, events };
}

// Load app/main.js exactly as app/host-jxa.js does: the real loader, reading
// source text and evaluating it with new Function.
function loadApp(sys) {
  const loader = createLoader({
    readText: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
    exists: (p) => fs.existsSync(p),
    path: pathutil,
  });
  const previous = globalThis.__DIY_MAC_REMOTE_SYS__;
  globalThis.__DIY_MAC_REMOTE_SYS__ = sys;
  try {
    return loader.requireFrom(APP_DIR)('./main');
  } finally {
    globalThis.__DIY_MAC_REMOTE_SYS__ = previous;
  }
}

test('every app module loads through the JXA loader (new Function, no Node require)', () => {
  const { sys } = makeStubHost();
  const main = loadApp(sys);
  assert.strictEqual(typeof main.init, 'function');
  assert.strictEqual(typeof main.handle, 'function');
  assert.strictEqual(typeof main.banner, 'function');
});

test('the loader caches by path and refuses non-relative specifiers', () => {
  const loader = createLoader({
    readText: (p) => (p === '/x/a.js' ? 'module.exports = { n: Math.random() };' : null),
    exists: (p) => p === '/x/a.js',
    path: pathutil,
  });
  const req = loader.requireFrom('/x');
  assert.strictEqual(req('./a'), req('./a'), 'a second require returned a second copy');
  assert.throws(() => req('fs'), /only relative paths/);
  assert.throws(() => req('./nope'), /not found/);
});

// The whole point of the split: the same application code, driven by a host
// that shares nothing with Node's, still pairs and still authenticates.
test('under a foreign host: mint, serve /nonce, and accept a signed /msg', () => {
  const { sys, logs, events } = makeStubHost();
  const main = loadApp(sys);

  const init = main.init({
    scheme: 'http', port: 8765, entry: 'perl',
    argv: ['http://stub.local:8765/'], certHosts: null,
  });
  assert.strictEqual(init.ok, true, JSON.stringify(init));

  main.banner();
  const master = pairMaster(logs.join('\n'));
  assert.ok(master, 'no pairing master in the banner:\n' + logs.join('\n'));
  const creds = deriveCreds(master);

  const nonceRes = main.handle({ method: 'GET', path: '/nonce', body: '' });
  assert.strictEqual(nonceRes.status, 200);
  const nonce = JSON.parse(nonceRes.text).nonce;
  assert.ok(/^[0-9a-f]{64}$/.test(nonce), 'nonce should be 32 random bytes in hex');

  const ok = main.handle({
    method: 'POST', path: '/msg', body: buildEnvelope(creds.secret, creds.token, nonce, 1, true),
  });
  assert.strictEqual(ok.status, 200, ok.text);
  assert.deepStrictEqual(events,
    [{ script: 'tell application "System Events" to keystroke "x"' }],
    'the keystroke should have reached the host: ' + JSON.stringify(events));

  // Replay of the same counter, and a wrong token, are still refused here.
  const replay = main.handle({
    method: 'POST', path: '/msg', body: buildEnvelope(creds.secret, creds.token, nonce, 1, true),
  });
  assert.strictEqual(replay.status, 401, replay.text);
  const badToken = main.handle({
    method: 'POST', path: '/msg', body: buildEnvelope(creds.secret, 'ff'.repeat(32), nonce, 2, true),
  });
  assert.strictEqual(badToken.status, 401, badToken.text);
});

// The failure this guards against cost a real debugging session on a Mac: a
// host whose randomness call was broken started fine, then answered every
// single keystroke with a 500. Startup is where that has to be found.
test('a host that cannot produce randomness is refused at startup', () => {
  const { sys, logs } = makeStubHost();
  sys.randomBase64 = (n) => 'AAAA';   // four bytes, whatever was asked for
  const main = loadApp(sys);
  const init = main.init({ scheme: 'http', port: 8765, entry: 'node',
                           argv: ['http://stub.local:8765/'], certHosts: null });
  assert.strictEqual(init.ok, false, 'should have refused to start');
  assert.match(init.error, /random/i, init.error);
  assert.ok(!logs.join('').includes('#'), 'nothing should have been paired');
});

test('the backend answers only the two routes that need a secret', () => {
  const { sys } = makeStubHost();
  const main = loadApp(sys);
  main.init({ scheme: 'http', port: 8765, entry: 'node',
              argv: ['http://stub.local:8765/'], certHosts: null });

  // Everything else — the page, the icons, an unknown path — belongs to the
  // entrypoints, which is what keeps file bytes off the protocol entirely.
  assert.strictEqual(main.handle({ method: 'GET', path: '/', body: '' }).status, 404);
  assert.strictEqual(main.handle({ method: 'GET', path: '/icon-512.png', body: '' }).status, 404);
  assert.strictEqual(main.handle({ method: 'PUT', path: '/msg', body: '' }).status, 404);
  // A query string doesn't hide the route.
  assert.strictEqual(main.handle({ method: 'GET', path: '/nonce?x=1', body: '' }).status, 200);
});
