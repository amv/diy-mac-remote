'use strict';
// The page's side of the re-key (public/index.html, `Rekey`), run as it is in the
// page against a real server. The interesting cases are the ones a phone really
// hits: the answer is lost after the server swapped the credentials, the request
// never arrives, an old server refuses.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');
const { test, assert } = require('./harness');
const {
  deriveCreds, buildOpsEnvelope, getFreePort, startServer, stopServer,
  httpReq, pairMaster, mkTempHome, sha256hex,
} = require('./helpers');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test('every script in the page still parses', () => {
  scripts.forEach((src, i) => { new vm.Script(src, { filename: `index.html script #${i}` }); });
});

const Rekey = (() => {
  const src = scripts.find((s) => /var Rekey = /.test(s));
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.Rekey = Rekey;', ctx);
  return ctx.Rekey;
})();

function memoryStore() {
  const m = new Map();
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)), remove: (k) => m.delete(k), m };
}

// A phone talking to a real server. `net` decides what the network does to a call:
// 'ok', 'drop-request' (never arrives), 'drop-answer' (arrives, answer lost).
async function setup() {
  const home = mkTempHome();
  const port = await getFreePort();
  const s = await startServer({ home, port });
  const master = deriveCreds(pairMaster(s.out()));
  const store = memoryStore();
  const phone = { creds: { ...master }, net: 'ok', calls: [] };
  store.set('diy-mac-remote_secret', master.secret);
  store.set('diy-mac-remote_token', master.token);

  const rekey = Rekey.create({
    store,
    random: (n) => crypto.randomBytes(n),
    toHex: (b) => Buffer.from(b).toString('hex'),
    sha256hex,
    current: () => phone.creds,
    adopt: (c) => {
      store.set('diy-mac-remote_secret', c.secret);
      store.set('diy-mac-remote_token', c.token);
      phone.creds = { secret: c.secret, token: c.token };
    },
    call: async (creds, ops) => {
      phone.calls.push(ops[0].t);
      if (phone.net === 'drop-request') throw new Error('offline');
      const nonce = JSON.parse((await httpReq(port, 'GET', '/nonce')).body).nonce;
      const r = await httpReq(port, 'POST', '/msg', buildOpsEnvelope(creds.secret, creds.token, nonce, 1, ops));
      if (phone.net === 'drop-answer') throw new Error('connection lost');
      return { status: r.status };
    },
  });
  const works = async (creds) => {
    const nonce = JSON.parse((await httpReq(port, 'GET', '/nonce')).body).nonce;
    return (await httpReq(port, 'POST', '/msg',
      buildOpsEnvelope(creds.secret, creds.token, nonce, 1, [{ t: 'ping' }]))).status === 200;
  };
  const done = async () => { await stopServer(s.child); fs.rmSync(home, { recursive: true, force: true }); };
  return { rekey, store, phone, master, works, done, dir: path.join(home, '.diy-mac-remote') };
}

test('nothing is pending: run does nothing and makes no calls', async () => {
  const t = await setup();
  try {
    assert.strictEqual(await t.rekey.run(), 'none');
    assert.deepStrictEqual(t.phone.calls, []);
  } finally { await t.done(); }
});

test('first launch: swaps the master for credentials of its own', async () => {
  const t = await setup();
  try {
    t.rekey.markPending();
    assert.strictEqual(await t.rekey.run(), 'done');
    assert.ok(!t.rekey.isPending());
    assert.notStrictEqual(t.phone.creds.secret, t.master.secret);
    assert.strictEqual(t.store.get('diy-mac-remote_secret'), t.phone.creds.secret, 'stored for next launch');
    assert.strictEqual(t.store.get('diy-mac-remote_next'), null, 'the attempt record is dropped');
    assert.ok(await t.works(t.phone.creds), 'the new credentials work');
    assert.ok(!(await t.works(t.master)), 'the master is dead');
    assert.strictEqual(await t.rekey.run(), 'none', 'and it never runs again');
  } finally { await t.done(); }
});

test('the answer is lost after the server swapped: the next launch adopts the new credentials', async () => {
  const t = await setup();
  try {
    t.rekey.markPending();
    t.phone.net = 'drop-answer';
    assert.strictEqual(await t.rekey.run(), 'later');
    assert.ok(t.rekey.isPending(), 'still pending');
    assert.ok(t.store.get('diy-mac-remote_next'), 'the credentials it tried are written down');
    assert.strictEqual(t.phone.creds.secret, t.master.secret, 'not adopted without proof');

    t.phone.net = 'ok';
    assert.strictEqual(await t.rekey.run(), 'done');
    assert.ok(await t.works(t.phone.creds));
    assert.ok(!(await t.works(t.master)));
    assert.ok(!t.rekey.isPending());
  } finally { await t.done(); }
});

test('the request never arrives: the next launch tries again with fresh credentials', async () => {
  const t = await setup();
  try {
    t.rekey.markPending();
    t.phone.net = 'drop-request';
    assert.strictEqual(await t.rekey.run(), 'later');
    const abandoned = t.store.get('diy-mac-remote_next');

    t.phone.net = 'ok';
    assert.strictEqual(await t.rekey.run(), 'done');
    assert.notStrictEqual(t.store.get('diy-mac-remote_secret'), JSON.parse(abandoned).secret);
    assert.ok(await t.works(t.phone.creds));
    assert.ok(!(await t.works(t.master)));
  } finally { await t.done(); }
});

test('an install that cannot re-key is left as it was, and not asked again', async () => {
  const t = await setup();
  try {
    fs.rmSync(path.join(t.dir, 'rekey.pending')); // a pairing from before re-keying existed
    t.rekey.markPending();
    assert.strictEqual(await t.rekey.run(), 'refused');
    assert.ok(!t.rekey.isPending());
    assert.strictEqual(t.store.get('diy-mac-remote_next'), null);
    assert.ok(await t.works(t.master), 'the master still works');
    const before = t.phone.calls.length;
    assert.strictEqual(await t.rekey.run(), 'none');
    assert.strictEqual(t.phone.calls.length, before, 'no further calls');
  } finally { await t.done(); }
});

test('a phone whose credentials the server does not know reports them stale', async () => {
  const t = await setup();
  try {
    t.phone.creds = { secret: 'a'.repeat(64), token: 'b'.repeat(64) };
    t.rekey.markPending();
    assert.strictEqual(await t.rekey.run(), 'stale');
    assert.ok(!t.rekey.isPending(), 'and it stops trying');
    assert.ok(await t.works(t.master), 'the server is untouched');
  } finally { await t.done(); }
});

test('no secure randomness: it waits instead of making weak credentials', async () => {
  const store = memoryStore();
  const rekey = Rekey.create({
    store, random: () => { throw new Error('no secure random'); }, toHex: () => '', sha256hex: () => '',
    current: () => ({}), adopt: () => {}, call: async () => { throw new Error('must not be called'); },
  });
  rekey.markPending();
  assert.strictEqual(await rekey.run(), 'later');
  assert.ok(rekey.isPending());
});
