'use strict';
// The Node-free entrypoint (server.pl), driven exactly like the Node one.
//
// Both entrypoints are transports in front of the same backend, so the thing
// worth testing is that they are interchangeable: the same pairing, the same
// envelope, the same answers, the same bytes back out. Anything that only works
// on one of them is a bug in that one.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const net = require('net');
const { test, assert } = require('./harness');
const {
  deriveCreds, buildEnvelope, getFreePort,
  startServer, stopServer, httpReq, pairMaster, mkTempHome, PROJECT_ROOT,
  assertStaticParity,
} = require('./helpers');

const HAVE_PERL = (() => {
  try {
    return cp.spawnSync('perl', ['-e', 'print 1'], { encoding: 'utf8' }).stdout === '1';
  } catch {
    return false;
  }
})();

function skipWithoutPerl() {
  if (!HAVE_PERL) console.log('       (no perl on this host — skipped)');
  return !HAVE_PERL;
}

test('server.pl compiles cleanly under -w (core modules only)', () => {
  if (skipWithoutPerl()) return;
  const r = cp.spawnSync('perl', ['-c', 'server.pl'],
    { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /syntax OK/);
  // Anything outside core would show up as a failed `use`, but say so plainly:
  // this entrypoint exists so that nothing has to be installed.
  assert.ok(!/Can't locate/.test(r.stderr), 'a non-core module crept in: ' + r.stderr);
});

test('perl entrypoint: pairs, serves /nonce, and accepts a signed /msg', async () => {
  if (skipWithoutPerl()) return;
  const home = mkTempHome();
  const port = await getFreePort();
  const s = await startServer({ home, port, perl: true });
  try {
    const master = pairMaster(s.out());
    assert.ok(master, 'no pairing QR from the perl entrypoint:\n' + s.out());
    const creds = deriveCreds(master);
    // The pairing landed in the same place, in the same format, with the same perms.
    const dir = path.join(home, '.diy-mac-remote');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'secret'), 'utf8').trim(), creds.secret);
    assert.strictEqual(fs.statSync(path.join(dir, 'secret')).mode & 0o777, 0o600);

    const n = JSON.parse((await httpReq(port, 'GET', '/nonce')).body).nonce;
    const ok = await httpReq(port, 'POST', '/msg',
      buildEnvelope(creds.secret, creds.token, n, 1, true));
    assert.strictEqual(ok.status, 200, ok.body);

    const bad = await httpReq(port, 'POST', '/msg',
      buildEnvelope(creds.secret, 'de'.repeat(32), n, 2, true));
    assert.strictEqual(bad.status, 401, bad.body);

    const notAllowed = await httpReq(port, 'PUT', '/', '{}');
    assert.strictEqual(notAllowed.status, 405);
  } finally {
    await stopServer(s.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('perl entrypoint: serves public/ exactly as the node one does', async () => {
  if (skipWithoutPerl()) return;
  const home = mkTempHome();
  const port = await getFreePort();
  const s = await startServer({ home, port, perl: true });
  try {
    // The same assertions test/pairing.test.js makes against server.js. Static
    // files are served by each entrypoint separately — this is what keeps the
    // two implementations answering alike.
    await assertStaticParity(port, assert);
  } finally {
    await stopServer(s.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('perl entrypoint: two requests down one keep-alive connection', async () => {
  if (skipWithoutPerl()) return;
  const home = mkTempHome();
  const port = await getFreePort();
  const s = await startServer({ home, port, perl: true });
  try {
    // Two requests down a single connection: the phone's page load is a burst
    // of them, so a broken keep-alive would show up as a page that half-loads.
    const raw = await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
        sock.write('GET /icon-512.png HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      });
      const chunks = [];
      sock.on('data', (c) => chunks.push(c));
      sock.on('end', () => resolve(Buffer.concat(chunks)));
      sock.on('error', reject);
      sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('timeout')); });
    });

    const text = raw.toString('latin1');
    const statuses = text.match(/HTTP\/1\.1 (\d+)/g);
    assert.deepStrictEqual(statuses, ['HTTP/1.1 200', 'HTTP/1.1 200'],
      'both requests should be answered on one connection');

    // The PNG is the second body; find it by its own header and compare bytes.
    const png = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'icon-512.png'));
    const at = raw.indexOf(png);
    assert.ok(at > 0, 'the PNG came back changed or truncated');
    assert.match(text, /Content-Type: image\/png/);
    assert.match(text, /Content-Type: text\/html/);
  } finally {
    await stopServer(s.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('perl entrypoint: an oversized body is refused, not buffered', async () => {
  if (skipWithoutPerl()) return;
  const home = mkTempHome();
  const port = await getFreePort();
  const s = await startServer({ home, port, perl: true });
  try {
    const r = await httpReq(port, 'POST', '/msg', 'x'.repeat(70 * 1024));
    assert.strictEqual(r.status, 413, r.body);
    // ...and the server is still there afterwards.
    assert.strictEqual((await httpReq(port, 'GET', '/nonce')).status, 200);
  } finally {
    await stopServer(s.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
