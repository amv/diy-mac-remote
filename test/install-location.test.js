'use strict';
// The installers' first question, asked before they change anything: could the
// app run from where the repo is? macOS keeps an app out of Desktop, Documents
// and Downloads until it is let in, one app at a time — and a downloaded ZIP
// lands in Downloads. So `bundle-app.sh --check-location` must stop those
// three, spell out the move, and let everything else (and an override) by.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { test, assert } = require('./harness');
const { mkTempHome, PROJECT_ROOT } = require('./helpers');

// A copy of just what the check reads — bundle-app.sh, and the start.sh it
// expects next to it — at <home>/<rel>, where an unpacked download would sit.
function repoAt(home, rel) {
  const dir = path.join(home, rel);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['bundle-app.sh', 'start.sh']) {
    fs.copyFileSync(path.join(PROJECT_ROOT, f), path.join(dir, f));
    fs.chmodSync(path.join(dir, f), 0o755);
  }
  return dir;
}

function checkLocation(dir, home, env = {}) {
  return cp.spawnSync('sh', [path.join(dir, 'bundle-app.sh'), '--check-location'],
    { encoding: 'utf8', env: { ...process.env, HOME: home, ...env } });
}

test('--check-location stops a repo in Desktop, Documents or Downloads', () => {
  const home = mkTempHome();
  try {
    for (const where of ['Desktop', 'Documents', 'Downloads']) {
      const dir = repoAt(home, path.join(where, 'diy-mac-remote-main'));
      const r = checkLocation(dir, home);
      assert.strictEqual(r.status, 1, `${where}: ${r.stderr}`);
      assert.match(r.stderr, new RegExp(`in your ${where} folder`));
      // The way out, ready to paste.
      const mv = `mv '${dir}' '${path.join(home, 'diy-mac-remote')}'`;
      assert.ok(r.stderr.includes(mv), `${where}: no "${mv}" in:\n${r.stderr}`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('--check-location lets the home folder by, and an explicit override', () => {
  const home = mkTempHome();
  try {
    const fine = checkLocation(repoAt(home, 'diy-mac-remote'), home);
    assert.strictEqual(fine.status, 0, fine.stderr);
    assert.strictEqual(fine.stdout + fine.stderr, '', 'a fine location should print nothing');

    const kept = checkLocation(repoAt(home, 'Documents/diy-mac-remote'), home,
      { DIY_MAC_REMOTE_ALLOW_PROTECTED_FOLDER: '1' });
    assert.strictEqual(kept.status, 0, kept.stderr);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('--check-location never suggests moving onto a folder that exists', () => {
  const home = mkTempHome();
  try {
    // An older copy already in the obvious place: `mv` onto it would put this
    // one *inside* it, so the suggestion falls back to the folder's own name.
    fs.mkdirSync(path.join(home, 'diy-mac-remote'));
    const dir = repoAt(home, 'Downloads/diy-mac-remote-main');
    const r = checkLocation(dir, home);
    assert.strictEqual(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes(`'${path.join(home, 'diy-mac-remote-main')}'`), r.stderr);
    assert.ok(!r.stderr.includes(`'${path.join(home, 'diy-mac-remote')}'`), r.stderr);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
