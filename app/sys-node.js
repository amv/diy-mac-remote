'use strict';

// The Node implementation of the host interface described in app/sys.js.
//
// This is the development and test host. It is what runs the application on
// anything that isn't a Mac (and on a Mac when DIY_MAC_REMOTE_BACKEND=node
// forces it), so the suite in test/ can drive the real routing, pairing and
// crypto on a Linux box with no osascript in sight.
//
// It never posts a real event: input is logged, exactly as the old non-macOS
// dry-run did. Actually typing on a Mac is the JXA host's job (app/sys-jxa.js),
// because that is the one that can call CoreGraphics.

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

// Refuse to use a credential (or its directory) unless we own it and no other
// user can touch it. `stat` comes from the open fd (fstat) so we validate
// exactly what we read, leaving no check-then-swap (TOCTOU) window.
function assertOwnerOnly(label, stat) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null && stat.uid !== uid) {
    throw new Error(`${label} is owned by uid ${stat.uid}, not you (uid ${uid}).`);
  }
  if (stat.mode & 0o077) {
    throw new Error(`${label} is accessible to other users ` +
                    `(mode ${(stat.mode & 0o777).toString(8)}). The secret may be exposed.`);
  }
}

const sys = {
  platform: process.platform,
  host: 'node',
  // The Node host logs input instead of posting it, on every platform.
  dryRun: true,
  root: null,

  env(name) {
    const v = process.env[name];
    return v === undefined || v === '' ? null : v;
  },

  homedir() { return os.homedir(); },

  // stderr, always: stdout is the message channel to the entrypoint.
  log(msg) { process.stderr.write(String(msg) + '\n'); },

  exists(path) { return fs.existsSync(path); },

  assertOwnerOnly(path) { assertOwnerOnly(path, fs.statSync(path)); },

  readOwnedText(file, dir) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      return null;
    }
    try {
      // Validate the containing dir too: a foreign-owned or group/other-writable
      // dir would let another user swap the file underneath us.
      assertOwnerOnly(dir, fs.statSync(dir));
      assertOwnerOnly(file, fs.fstatSync(fd));
      return fs.readFileSync(fd, 'utf8').trim() || null;
    } finally {
      fs.closeSync(fd);
    }
  },

  writePrivateText(path, text) {
    fs.writeFileSync(path, text, { mode: 0o600 });
  },

  mkdirPrivate(path) {
    fs.mkdirSync(path, { recursive: true, mode: 0o700 });
  },

  randomBase64(n) { return crypto.randomBytes(n).toString('base64'); },

  exec(bin, args) {
    try {
      const out = execFileSync(bin, args, {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000,
      });
      return out.trim() || null;
    } catch {
      return null;
    }
  },

  execDetached(bin, args) {
    try {
      const child = spawn(bin, args, { stdio: 'ignore', detached: true });
      child.unref();
      child.on('error', () => {});
    } catch { /* best effort */ }
  },

  lanAddresses() {
    const out = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal && out.indexOf(iface.address) < 0) {
          out.push(iface.address);
        }
      }
    }
    return out;
  },

  input: {
    keyScript(source) {
      sys.log('[dry-run] would run AppleScript:\n' + source);
    },
    mouse(cmd) {
      sys.log('[dry-run] mouse ' + JSON.stringify(cmd));
    },
    sleep(seconds) {
      // A synchronous sleep, because the whole application is synchronous: the
      // host handles one message at a time and a promise has nobody to await it.
      const ms = Math.max(0, Math.round(seconds * 1000));
      if (!ms) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    },
  },
};

module.exports = sys;
