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
  startServer, stopServer, runServer, httpReq, pairMaster, mkTempHome,
  fakeTailscaleBin, httpFrom, lanIPv4, assertStaticParity, PROJECT_ROOT,
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
    // What to do next is said where it is needed: leave this terminal before
    // the first touch, so the Accessibility grant lands on the app instead.
    assert.match(s.out(), /Close this window/, 'banner should say to close the window');
    assert.match(s.out(), /or build it: \.\/bundle-app\.sh\)/, 'banner should name the app');
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

test('the node entrypoint serves public/ itself, and nothing above it', async () => {
  const s = await startServer({ home: HOME, port: state.port });
  try {
    await assertStaticParity(state.port, assert);
  } finally {
    await stopServer(s.child);
  }
});

test('an oversized body is refused, and the server survives it', async () => {
  const s = await startServer({ home: HOME, port: state.port });
  try {
    // 64 KB is the cap; the point is that it is refused with an answer rather
    // than by swallowing it or by dropping the connection on the floor. (The
    // perl entrypoint is held to the same behaviour in perl.test.js.)
    const r = await httpReq(state.port, 'POST', '/msg', 'x'.repeat(70 * 1024));
    assert.strictEqual(r.status, 413, r.body);
    assert.strictEqual((await httpReq(state.port, 'GET', '/nonce')).status, 200);
  } finally {
    await stopServer(s.child);
  }
});

// ---- every mode but tailscale listens everywhere; tailscale listens on the tailnet ----
// Outside Tailscale mode access is decided by the pairing crypto, never by the
// address a request came from, so every source is served alike. Tailscale mode
// binds the tailnet address only: the fake tailscale below reports 127.0.0.1 as
// that address, so another address on this host stands in for "the LAN".

for (const perl of [false, true]) {
  const who = perl ? 'server.pl' : 'server.js';

  test(`${who}: a non-loopback (LAN) source is served outside tailscale mode`, async () => {
    const lan = lanIPv4();
    if (!lan) { console.log('       (no LAN IPv4 on this host — skipped)'); return; }
    const home = mkTempHome();
    const port = await getFreePort();
    const s = await startServer({ home, port, perl });
    try {
      const r = await httpFrom({ host: lan, port, localAddress: lan, path: '/nonce' });
      assert.strictEqual(r.status, 200, 'public /nonce should answer any source: ' + r.body);
    } finally {
      await stopServer(s.child);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test(`${who}: tailscale mode listens on the tailnet address only`, async () => {
    const home = mkTempHome();
    const bin = fakeTailscaleBin(home);
    const port = await getFreePort();
    const s = await startServer({ home, port, perl, url: null, args: ['tailscale'],
      env: { PATH: `${bin}:${process.env.PATH}` } });
    try {
      assert.match(s.out(), /tailnet address only \(127\.0\.0\.1\)/, s.out());
      const ok = await httpFrom({ host: '127.0.0.1', port, path: '/nonce' });
      assert.strictEqual(ok.status, 200, 'the tailnet address should answer');
      // Anything else on this host must not: another loopback address, and the
      // LAN address if there is one.
      for (const other of ['127.0.0.2', lanIPv4()].filter(Boolean)) {
        await assert.rejects(httpFrom({ host: other, port, path: '/nonce' }),
          (e) => e.code === 'ECONNREFUSED', `${other} should refuse connections`);
      }
    } finally {
      await stopServer(s.child);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test(`${who}: tailscale mode with HOST set binds HOST instead`, async () => {
    const home = mkTempHome();
    const bin = fakeTailscaleBin(home);
    const port = await getFreePort();
    const s = await startServer({ home, port, perl, url: null, args: ['tailscale'],
      env: { PATH: `${bin}:${process.env.PATH}`, HOST: '127.0.0.2' } });
    try {
      assert.strictEqual((await httpFrom({ host: '127.0.0.2', port, path: '/nonce' })).status, 200);
      await assert.rejects(httpFrom({ host: '127.0.0.1', port, path: '/nonce' }),
        (e) => e.code === 'ECONNREFUSED');
    } finally {
      await stopServer(s.child);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test(`${who}: tailscale mode waits for the tailnet, then listens on it only`, async () => {
    const home = mkTempHome();
    const bin = fakeTailscaleBin(home, { running: false });
    const port = await getFreePort();
    const env = { PATH: `${bin}:${process.env.PATH}` };
    const cmd = perl ? { bin: 'perl', argv: ['server.pl', 'tailscale'] }
                     : { bin: process.execPath, argv: ['server.js', 'tailscale'] };
    let out = '';
    const child = require('child_process').spawn(cmd.bin, cmd.argv,
      { cwd: PROJECT_ROOT, env: { ...process.env, HOME: home, PORT: String(port), ...env } });
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    try {
      // Tailnet down: it keeps waiting (does not exit), says so, and listens nowhere.
      await new Promise((r) => setTimeout(r, 2500));
      assert.strictEqual(child.exitCode, null, 'must keep waiting, but exited:\n' + out);
      assert.match(out, /waiting for the Tailscale network/, out);
      for (const host of ['127.0.0.1', lanIPv4()].filter(Boolean)) {
        await assert.rejects(httpFrom({ host, port, path: '/nonce' }),
          (e) => e.code === 'ECONNREFUSED', `${host} must not be listening yet`);
      }
      assert.ok(!fs.existsSync(path.join(home, '.diy-mac-remote', 'secret')),
        'must not mint a pairing while it has no address');
      // Tailnet comes up: within a couple of retries it starts listening there.
      fakeTailscaleBin(home, { running: true });
      let up = false;
      for (let i = 0; i < 20 && !up; i++) {
        await new Promise((r) => setTimeout(r, 500));
        up = await httpFrom({ host: '127.0.0.1', port, path: '/nonce' })
          .then((r) => r.status === 200, () => false);
      }
      assert.ok(up, 'should start listening once the tailnet is up:\n' + out);
      assert.match(out, /tailnet address only \(127\.0\.0\.1\)/, out);
    } finally {
      await stopServer(child);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

// ---- a restart prints no address ----
// The paired Home Screen app already holds it, and retyping a hostname is
// exactly what pairing exists to avoid.

test('a restart prints no address and no QR', async () => {
  const home = mkTempHome();
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}/`;
  const first = await startServer({ home, port, url });
  assert.ok(pairMaster(first.out()), 'the pairing run should print a QR link');
  await stopServer(first.child);

  const s = await startServer({ home, port, url });
  try {
    const out = s.out();
    assert.ok(!out.includes(url), 'restart must not print the address: ' + out);
    assert.strictEqual(pairMaster(out), null, 'restart must not print a pairing link');
    assert.match(out, /Home Screen app/, 'restart should point at the paired app');
  } finally {
    await stopServer(s.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('cleanup: remove the temp home', () => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

test('server.js keeps an idle connection open well past the Node default of 5s', async () => {
  const home = mkTempHome();
  const port = await getFreePort();
  const s = await startServer({ home, port });
  const net = require('net');
  const sock = net.connect(port, '127.0.0.1');
  let closed = false;
  sock.on('close', () => { closed = true; });
  sock.on('error', () => {});
  try {
    const answered = new Promise((r) => sock.once('data', r));
    sock.write('GET /nonce HTTP/1.1\r\nHost: x\r\n\r\n');
    await answered;
    await new Promise((r) => setTimeout(r, 7000));
    assert.ok(!closed, 'the idle keep-alive connection was closed after 7s');
    sock.write('GET /nonce HTTP/1.1\r\nHost: x\r\n\r\n');
    await new Promise((r) => sock.once('data', r)); // still usable
  } finally {
    sock.destroy();
    await stopServer(s.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
