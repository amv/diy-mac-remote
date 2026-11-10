'use strict';
// The phone's one-time swap of the pairing master for credentials of its own.
//
// The master lives on in the QR, in the saved Home Screen link and in Safari's
// history, so the first launch of the Home Screen app replaces what the server
// holds — a new secret and a new token hash — and the master stops meaning
// anything. These drive the real server over HTTP the way the page does.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { test, assert } = require('./harness');
const {
  deriveCreds, buildOpsEnvelope, getFreePort, startServer, stopServer,
  httpReq, pairMaster, mkTempHome, sha256hex,
} = require('./helpers');

// What the page sends: a random secret and token, and the hash of the token.
function newCreds() {
  const secret = crypto.randomBytes(32).toString('hex');
  const token = crypto.randomBytes(32).toString('hex');
  return { secret, token, hash: sha256hex('diy-mac-remote-token:' + token) };
}

// One request, the way the page makes it: a fresh nonce, counter 1.
async function post(port, creds, ops) {
  const nonce = JSON.parse((await httpReq(port, 'GET', '/nonce')).body).nonce;
  return httpReq(port, 'POST', '/msg', buildOpsEnvelope(creds.secret, creds.token, nonce, 1, ops));
}
const rekeyOp = (c) => ({ t: 'r', s: c.secret, h: c.hash });
const key = { t: 'k', b: { text: 'x' } };

async function paired() {
  const home = mkTempHome();
  const port = await getFreePort();
  const s = await startServer({ home, port });
  const old = deriveCreds(pairMaster(s.out()));
  return { home, port, s, old, dir: path.join(home, '.diy-mac-remote') };
}
async function cleanup(t) {
  await stopServer(t.s.child);
  fs.rmSync(t.home, { recursive: true, force: true });
}

test('a fresh pairing can re-key once, and the master stops working', async () => {
  const t = await paired();
  try {
    assert.ok(fs.existsSync(path.join(t.dir, 'rekey.pending')), 'minting leaves the re-key marker');
    const next = newCreds();
    const r = await post(t.port, t.old, [rekeyOp(next)]);
    assert.strictEqual(r.status, 200, r.body);

    assert.strictEqual((await post(t.port, t.old, [key])).status, 401, 'the master must be dead');
    assert.strictEqual((await post(t.port, next, [key])).status, 200, 'the new credentials must work');

    assert.ok(!fs.existsSync(path.join(t.dir, 'rekey.pending')), 'the marker is used up');
    assert.strictEqual(fs.readFileSync(path.join(t.dir, 'secret'), 'utf8').trim(), next.secret);
    assert.strictEqual(fs.readFileSync(path.join(t.dir, 'token.hash'), 'utf8').trim(), next.hash);
    for (const f of ['secret', 'token.hash']) {
      assert.strictEqual(fs.statSync(path.join(t.dir, f)).mode & 0o077, 0, `${f} must stay owner-only`);
    }
    assert.deepStrictEqual(fs.readdirSync(t.dir).filter((f) => f.endsWith('.new')), [],
      'no staging files left behind');
  } finally { await cleanup(t); }
});

test('a second re-key is refused, even with the new credentials', async () => {
  const t = await paired();
  try {
    const next = newCreds();
    assert.strictEqual((await post(t.port, t.old, [rekeyOp(next)])).status, 200);
    const again = newCreds();
    const r = await post(t.port, next, [rekeyOp(again)]);
    assert.strictEqual(r.status, 409, r.body);
    assert.strictEqual((await post(t.port, next, [key])).status, 200, 'refusal changes nothing');
  } finally { await cleanup(t); }
});

test('the re-keyed pairing survives a restart; the master does not come back', async () => {
  const t = await paired();
  let s2;
  try {
    const next = newCreds();
    assert.strictEqual((await post(t.port, t.old, [rekeyOp(next)])).status, 200);
    await stopServer(t.s.child);
    s2 = await startServer({ home: t.home, port: t.port });
    assert.strictEqual((await post(t.port, next, [key])).status, 200);
    assert.strictEqual((await post(t.port, t.old, [key])).status, 401);
  } finally {
    if (s2) await stopServer(s2.child);
    fs.rmSync(t.home, { recursive: true, force: true });
  }
});

test('an install without the marker refuses to re-key and keeps its pairing', async () => {
  const t = await paired();
  try {
    fs.rmSync(path.join(t.dir, 'rekey.pending'));
    const r = await post(t.port, t.old, [rekeyOp(newCreds())]);
    assert.strictEqual(r.status, 409, r.body);
    assert.strictEqual((await post(t.port, t.old, [key])).status, 200);
  } finally { await cleanup(t); }
});

test('a malformed or mixed re-key changes nothing and keeps the marker', async () => {
  const t = await paired();
  try {
    const good = newCreds();
    const cases = [
      [{ t: 'r', s: 'short', h: good.hash }],
      [{ t: 'r', s: good.secret }],
      [{ t: 'r', s: good.secret.toUpperCase(), h: good.hash }],
      [key, rekeyOp(good)],
      [rekeyOp(good), key],
    ];
    for (const ops of cases) {
      const r = await post(t.port, t.old, ops);
      assert.strictEqual(r.status, 400, JSON.stringify(ops) + ' -> ' + r.status + ' ' + r.body);
    }
    assert.ok(fs.existsSync(path.join(t.dir, 'rekey.pending')));
    assert.strictEqual((await post(t.port, t.old, [key])).status, 200, 'the old pairing is untouched');
  } finally { await cleanup(t); }
});

test('re-keying needs a valid pairing: the wrong token is refused', async () => {
  const t = await paired();
  try {
    const r = await post(t.port, { secret: t.old.secret, token: 'f'.repeat(64) }, [rekeyOp(newCreds())]);
    assert.strictEqual(r.status, 401, r.body);
    assert.ok(fs.existsSync(path.join(t.dir, 'rekey.pending')));
  } finally { await cleanup(t); }
});

test('ping authenticates and does nothing', async () => {
  const t = await paired();
  try {
    assert.strictEqual((await post(t.port, t.old, [{ t: 'ping' }])).status, 200);
    assert.strictEqual((await post(t.port, { ...t.old, token: 'bad' }, [{ t: 'ping' }])).status, 401);
  } finally { await cleanup(t); }
});

// ---- a crash in the middle of a re-key ----

test('a re-key cut off after both files were staged is finished on the next start', async () => {
  const t = await paired();
  let s2;
  try {
    const next = newCreds();
    await stopServer(t.s.child);
    // The state rekey() leaves if it dies before moving anything: both staged.
    fs.writeFileSync(path.join(t.dir, 'token.hash.new'), next.hash + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(t.dir, 'secret.new'), next.secret + '\n', { mode: 0o600 });
    s2 = await startServer({ home: t.home, port: t.port });
    assert.strictEqual((await post(t.port, next, [key])).status, 200, 'rolled forward');
    assert.strictEqual((await post(t.port, t.old, [key])).status, 401);
    assert.ok(!fs.existsSync(path.join(t.dir, 'rekey.pending')), 'marker used up');
    assert.deepStrictEqual(fs.readdirSync(t.dir).filter((f) => f.endsWith('.new')), []);
  } finally {
    if (s2) await stopServer(s2.child);
    fs.rmSync(t.home, { recursive: true, force: true });
  }
});

test('a re-key cut off after the token hash was already moved is finished too', async () => {
  const t = await paired();
  let s2;
  try {
    const next = newCreds();
    await stopServer(t.s.child);
    // token.hash already replaced, marker still there, secret.new waiting.
    fs.writeFileSync(path.join(t.dir, 'token.hash'), next.hash + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(t.dir, 'secret.new'), next.secret + '\n', { mode: 0o600 });
    s2 = await startServer({ home: t.home, port: t.port });
    assert.strictEqual((await post(t.port, next, [key])).status, 200);
    assert.ok(!fs.existsSync(path.join(t.dir, 'rekey.pending')));
  } finally {
    if (s2) await stopServer(s2.child);
    fs.rmSync(t.home, { recursive: true, force: true });
  }
});

test('a half-staged re-key is thrown away and the old pairing keeps working', async () => {
  const t = await paired();
  let s2;
  try {
    await stopServer(t.s.child);
    fs.writeFileSync(path.join(t.dir, 'token.hash.new'), newCreds().hash + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(t.dir, 'secret.new'), 'torn', { mode: 0o600 }); // cut off mid-write
    s2 = await startServer({ home: t.home, port: t.port });
    assert.strictEqual((await post(t.port, t.old, [key])).status, 200);
    assert.ok(fs.existsSync(path.join(t.dir, 'rekey.pending')), 'the offer still stands');
    assert.deepStrictEqual(fs.readdirSync(t.dir).filter((f) => f.endsWith('.new')), []);
  } finally {
    if (s2) await stopServer(s2.child);
    fs.rmSync(t.home, { recursive: true, force: true });
  }
});

test('--reset-token starts a new pairing that can re-key again', async () => {
  const t = await paired();
  let s2;
  try {
    assert.strictEqual((await post(t.port, t.old, [rekeyOp(newCreds())])).status, 200);
    await stopServer(t.s.child);
    s2 = await startServer({ home: t.home, port: t.port, args: ['--reset-token'] });
    const fresh = deriveCreds(pairMaster(s2.out()));
    assert.ok(fs.existsSync(path.join(t.dir, 'rekey.pending')));
    assert.strictEqual((await post(t.port, fresh, [rekeyOp(newCreds())])).status, 200);
  } finally {
    if (s2) await stopServer(s2.child);
    fs.rmSync(t.home, { recursive: true, force: true });
  }
});
