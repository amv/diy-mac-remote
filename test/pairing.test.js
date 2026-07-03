'use strict';
// End-to-end tests of the two-layer pairing, driving the real server over HTTP
// exactly as the browser would (same envelope format). Covers: master-derivation,
// the token second layer, the "master is never persisted" invariant, owner-only
// perms, restart behaviour, and `--reset-token`.
const fs = require('fs');
const path = require('path');
const { test, assert } = require('./harness');
const {
  deriveCreds, buildEnvelope, getFreePort,
  startServer, stopServer, httpReq, pairMaster, mkTempHome,
  fakeTailscaleBin, httpFrom, lanIPv4,
} = require('./helpers');

// One HOME shared across the restart/reset sequence (tests run in order).
const HOME = mkTempHome();
const DIR = path.join(HOME, '.diy-mac-remote');
const state = {}; // carries { port, master, secret, token } between tests

async function nonce(port) {
  const r = await httpReq(port, 'GET', '/nonce');
  return JSON.parse(r.body).nonce;
}

test('first run mints a master and derives + stores the credentials', async () => {
  state.port = await getFreePort();
  const s = await startServer({ home: HOME, port: state.port });
  try {
    state.master = pairMaster(s.out());
    assert.ok(state.master, 'no pairing master printed');
    assert.ok(!/[^A-Za-z0-9_-]/.test(state.master), 'master is not URL-safe base64url');
    Object.assign(state, deriveCreds(state.master));

    assert.ok(fs.existsSync(path.join(DIR, 'secret')), 'secret file missing');
    assert.ok(fs.existsSync(path.join(DIR, 'token.hash')), 'token.hash missing');
    assert.strictEqual(fs.readFileSync(path.join(DIR, 'secret'), 'utf8').trim(), state.secret,
      'stored secret != derived secret');

    // The master must not be written anywhere under the dir.
    for (const f of fs.readdirSync(DIR)) {
      assert.ok(fs.readFileSync(path.join(DIR, f), 'utf8').indexOf(state.master) < 0,
        `master leaked into ${f}`);
    }
    // Owner-only perms on both files.
    for (const f of ['secret', 'token.hash']) {
      assert.strictEqual(fs.statSync(path.join(DIR, f)).mode & 0o777, 0o600, `${f} not 0600`);
    }
  } finally {
    await stopServer(s.child);
  }
});

test('valid secret + valid token is accepted (200)', async () => {
  const s = await startServer({ home: HOME, port: state.port });
  try {
    const n = await nonce(state.port);
    const r = await httpReq(state.port, 'POST', '/msg',
      buildEnvelope(state.secret, state.token, n, 1, true));
    assert.strictEqual(r.status, 200, r.body);
  } finally {
    await stopServer(s.child);
  }
});

test('valid secret + wrong token is rejected (401)', async () => {
  const s = await startServer({ home: HOME, port: state.port });
  try {
    const n = await nonce(state.port);
    const r = await httpReq(state.port, 'POST', '/msg',
      buildEnvelope(state.secret, 'deadbeef'.repeat(8), n, 1, true));
    assert.strictEqual(r.status, 401);
    assert.match(r.body, /token/);
  } finally {
    await stopServer(s.child);
  }
});

test('valid secret + missing token is rejected (401)', async () => {
  const s = await startServer({ home: HOME, port: state.port });
  try {
    const n = await nonce(state.port);
    const r = await httpReq(state.port, 'POST', '/msg',
      buildEnvelope(state.secret, null, n, 1, false));
    assert.strictEqual(r.status, 401);
    assert.match(r.body, /token/);
  } finally {
    await stopServer(s.child);
  }
});

test('a normal restart does not reprint the master but still authenticates', async () => {
  const s = await startServer({ home: HOME, port: state.port });
  try {
    assert.strictEqual(pairMaster(s.out()), null, 'restart leaked the master');
    assert.match(s.out(), /reset-token/, 'restart banner should explain re-pairing');
    const n = await nonce(state.port);
    const r = await httpReq(state.port, 'POST', '/msg',
      buildEnvelope(state.secret, state.token, n, 1, true));
    assert.strictEqual(r.status, 200, r.body);
  } finally {
    await stopServer(s.child);
  }
});

test('--reset-token rotates the pairing; old creds fail, new creds pass', async () => {
  const s = await startServer({ home: HOME, port: state.port, args: ['--reset-token'] });
  try {
    const master2 = pairMaster(s.out());
    assert.ok(master2 && master2 !== state.master, 'reset did not mint a fresh master');
    const next = deriveCreds(master2);
    assert.notStrictEqual(next.secret, state.secret, 'secret should rotate with the master');

    let n = await nonce(state.port);
    let r = await httpReq(state.port, 'POST', '/msg',
      buildEnvelope(state.secret, state.token, n, 1, true));
    assert.strictEqual(r.status, 401, 'old creds should be rejected after reset');

    n = await nonce(state.port);
    r = await httpReq(state.port, 'POST', '/msg',
      buildEnvelope(next.secret, next.token, n, 1, true));
    assert.strictEqual(r.status, 200, r.body);
  } finally {
    await stopServer(s.child);
  }
});

// ---- tailnet-only source filter (Tailscale mode) ----
// These stand alone (own temp home + port) and stub `tailscale` on PATH so the
// filter engages regardless of whether this machine really runs Tailscale.

test('tailnet mode refuses a non-tailnet (LAN) source, allows loopback', async () => {
  const home = mkTempHome();
  const bin = fakeTailscaleBin(home, '100.101.102.103'); // in 100.64.0.0/10
  const port = await getFreePort();
  const s = await startServer({ home, port, url: null, args: ['tailscale'],
    env: { PATH: `${bin}:${process.env.PATH}` } });
  try {
    assert.match(s.out(), /tailnet only/, 'banner should announce the tailnet-only filter');

    // Loopback is treated as local and passes the gate (public /nonce -> 200).
    const loop = await httpFrom({ host: '127.0.0.1', port, path: '/nonce' });
    assert.strictEqual(loop.status, 200, 'loopback should pass the gate: ' + loop.body);

    // A LAN source is refused at the gate, before any routing/auth.
    const lan = lanIPv4();
    if (lan) {
      const r = await httpFrom({ host: lan, port, localAddress: lan, path: '/nonce' });
      assert.strictEqual(r.status, 403, `LAN source should be refused, got ${r.status}`);
      assert.match(r.body, /tailnet/, 'refusal should mention tailnet');
    } else {
      console.log('       (no LAN IPv4 on this host — skipped the deny-path assertion)');
    }
  } finally {
    await stopServer(s.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('filter is OFF outside tailnet mode: a LAN source is served normally', async () => {
  const lan = lanIPv4();
  if (!lan) { console.log('       (no LAN IPv4 on this host — skipped)'); return; }
  const home = mkTempHome();
  const port = await getFreePort();
  // wifi mode never consults Tailscale, so the filter stays off deterministically
  // even if the host running the tests happens to have a tailnet up.
  const s = await startServer({ home, port, url: null, args: ['wifi'] });
  try {
    const r = await httpFrom({ host: lan, port, localAddress: lan, path: '/nonce' });
    assert.notStrictEqual(r.status, 403, 'LAN source must not be filtered outside tailnet mode');
    assert.strictEqual(r.status, 200, 'public /nonce should answer a LAN client: ' + r.body);
  } finally {
    await stopServer(s.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('cleanup: remove the temp home', () => {
  fs.rmSync(HOME, { recursive: true, force: true });
});
