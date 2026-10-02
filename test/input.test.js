'use strict';
// What a key action turns into.
//
// Keystrokes are an AppleScript program, built here and compiled in-process by
// the JXA host (app/sys-jxa.js) rather than handed to a fresh `osascript` per
// keypress. Building it is pure, so the exact program that will run on the Mac
// can be checked on any machine — which is the only part of the keyboard that
// can be.
const path = require('path');
const fs = require('fs');
const { test, assert } = require('./harness');
const { createLoader } = require('../app/loader');
const pathutil = require('../app/pathutil');

const APP_DIR = path.join(__dirname, '..', 'app');

// input.js requires ./sys, so give it one; nothing here runs a script.
// `direct` becomes DIY_MAC_REMOTE_DIRECT_CHARS, the list of characters this
// keyboard layout can reach directly. `events`, if given, records what would
// have been sent to the host.
function loadInput(direct, events) {
  const loader = createLoader({
    readText: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
    exists: (p) => fs.existsSync(p),
    path: pathutil,
  });
  const previous = globalThis.__DIY_MAC_REMOTE_SYS__;
  globalThis.__DIY_MAC_REMOTE_SYS__ = {
    dryRun: true, log() {},
    input: {
      keyScript: (source) => events && events.push({ script: source }),
      mediaCommand: (command) => events && events.push({ media: command }),
      keyEvent: (code, down) => events && events.push({ key: [code, down] }),
    },
    env: (name) => (name === 'DIY_MAC_REMOTE_DIRECT_CHARS' ? (direct || null) : null),
  };
  try {
    return loader.requireFrom(APP_DIR)('./input');
  } finally {
    globalThis.__DIY_MAC_REMOTE_SYS__ = previous;
  }
}

const input = loadInput();
const { KEY_CODES } = require('../app/keys');

const TELL = 'tell application "System Events" to ';

test('a batch is one script, one statement per line', () => {
  assert.strictEqual(input.buildScript([{ text: 'hi' }, { key: 'return' }]),
    TELL + 'keystroke "hi"\n' +
    TELL + 'key code 36');
});

test('ASCII goes straight through keystroke', () => {
  for (const text of ['hello', 'a whole swipe-typed word', '{}[]@#$%^&*()_+']) {
    assert.deepStrictEqual(input.actionToStatements({ text }), [TELL + `keystroke "${text}"`]);
  }
});

// The bug this exists to prevent: System Events cannot map a character its
// layout can't reach, and types key code 0 — "a" — instead of failing. There is
// no way to ask macOS which those are, so anything outside ASCII takes the
// clipboard route, which can carry any character at all.
test('a character the layout may not reach goes via the clipboard', () => {
  for (const text of ['õ', '😀', 'ä', 'こんにちは']) {
    const statements = input.actionToStatements({ text });
    assert.ok(statements.length > 1, `${text} should not have been typed directly`);
    assert.ok(statements.some((line) => line === 'set the clipboard to ' + JSON.stringify(text)),
      statements.join('\n'));
    assert.ok(statements.some((line) => line.includes('keystroke "v" using {command down}')));
    // The clipboard is put back — and left alone if it held something that
    // isn't text, rather than replaced with an empty string.
    assert.ok(statements.some((line) => line === 'if diyClipHeld then set the clipboard to diyClipSaved'));
  }
});

test('characters the layout does reach can be named, and keep the fast path', () => {
  const nordic = loadInput('äöåÄÖÅ');
  assert.deepStrictEqual(nordic.actionToStatements({ text: 'hyvää' }),
    [TELL + 'keystroke "hyvää"'], 'named characters should type directly');
  // ...and only the named ones.
  assert.ok(nordic.actionToStatements({ text: 'õ' }).length > 1, 'õ was not named');
});

test('a shortcut takes the keystroke path — a chord is not a character', () => {
  assert.deepStrictEqual(input.actionToStatements({ text: 'c', modifiers: ['command'] }),
    [TELL + 'keystroke "c" using {command down}']);

  // ...and a chord on a character the layout cannot reach is refused, not
  // guessed at. That character becomes key code 0, so ⌘ plus it is ⌘A — Select
  // All — and the next keystroke would replace the document. An error on the
  // phone is the better outcome by a wide margin.
  assert.throws(() => input.actionToStatements({ text: 'õ', modifiers: ['command'] }),
    /no single key for it/);
  // Naming it as reachable allows it again.
  const nordic = loadInput('äöå');
  assert.deepStrictEqual(nordic.actionToStatements({ text: 'ä', modifiers: ['command'] }),
    [TELL + 'keystroke "ä" using {command down}']);
});

test('nothing in the text can become a statement of its own', () => {
  assert.deepStrictEqual(input.actionToStatements({ text: 'a"b' }), [TELL + 'keystroke "a\\"b"']);
  assert.deepStrictEqual(input.actionToStatements({ text: 'a\\b' }), [TELL + 'keystroke "a\\\\b"']);

  // AppleScript has no \n escape, so text carrying a line break becomes one
  // literal per line joined with `linefeed` — and stays a single line of source.
  assert.deepStrictEqual(input.actionToStatements({ text: 'a\nb' }),
    [TELL + 'keystroke ("a" & linefeed & "b")']);
  assert.deepStrictEqual(input.actionToStatements({ text: 'a\r\nb', modifiers: ['shift'] }),
    [TELL + 'keystroke ("a" & linefeed & "b") using {shift down}']);

  // The invariant that makes injection impossible rather than unlikely: the
  // text lands inside a quoted literal on exactly one line, whatever it holds —
  // one statement on the keystroke path, one on the clipboard path. Every other
  // line of the script is a fixed one this file wrote.
  for (const text of [
    '" \nend tell\ndo shell script "id',
    'plain',
    '\n\n\n',
    'a\rb\nc',
    '\\" & (do shell script "id") & "',
    'õ" \nset the clipboard to "gotcha',   // the same trick against the paste path
  ]) {
    const lines = input.buildScript([{ text }]).split('\n');
    // Every line that could be carrying the text: the keystroke statement, or
    // the clipboard assignment. (The paste itself is a fixed ⌘V and carries
    // nothing, so it doesn't count.)
    const PASTE = TELL + 'keystroke "v" using {command down}';
    const carrying = lines.filter((line) =>
      line !== PASTE &&
      (line.startsWith(TELL + 'keystroke ') || line.startsWith('set the clipboard to ')));
    assert.strictEqual(carrying.length, 1,
      `the text should occupy exactly one line: ${JSON.stringify(lines)}`);
    for (const line of lines) {
      assert.ok(!/^\s*do shell script/.test(line), 'injected a statement: ' + line);
    }
  }
});

test('named keys and raw codes become key codes', () => {
  assert.deepStrictEqual(input.actionToStatements({ key: 'return' }), [TELL + 'key code ' + KEY_CODES.return]);
  assert.deepStrictEqual(input.actionToStatements({ code: 36 }), [TELL + 'key code 36']);
  assert.throws(() => input.actionToStatements({ key: 'nope' }), /Unknown key/);
  assert.throws(() => input.actionToStatements({ code: -1 }), /Invalid key code/);
});

test('modifiers ride along, aliases and all', () => {
  assert.deepStrictEqual(input.actionToStatements({ text: 'c', modifiers: ['command'] }),
    [TELL + 'keystroke "c" using {command down}']);
  assert.deepStrictEqual(input.actionToStatements({ key: 'left', modifiers: ['cmd', 'shift'] }),
    [TELL + 'key code ' + KEY_CODES.left + ' using {command down, shift down}']);
  assert.deepStrictEqual(input.actionToStatements({ text: 'x', modifiers: ['alt'] }),
    [TELL + 'keystroke "x" using {option down}']);
  assert.throws(() => input.actionToStatements({ text: 'x', modifiers: ['hyper'] }), /Unknown modifier/);
  assert.throws(() => input.actionToStatements({ text: 'x', modifiers: 'command' }), /must be an array/);
});

test('delays are seconds, and capped so one request cannot wedge the backend', () => {
  assert.deepStrictEqual(input.actionToStatements({ delay: 250 }), ['delay 0.25']);
  assert.deepStrictEqual(input.actionToStatements({ delay: 60000 }), ['delay 5']);
  assert.throws(() => input.actionToStatements({ delay: -1 }), /Invalid delay/);
});

test('a batch is built in full before any of it runs', () => {
  // The second action is the bad one; nothing may be typed for the first.
  assert.throws(() => input.buildScript([{ text: 'a' }, { key: 'nope' }]), /Unknown key/);
  assert.throws(() => input.buildScript([]), /non-empty/);
  assert.throws(() => input.buildScript(['nope']), /must be an object/);
});

// The media controls are a fixed list: the phone names one, and that name is
// all it gets to say.
test('play/pause, next and previous are MediaRemote commands', () => {
  const events = [];
  const sysInput = loadInput(null, events);
  for (const [name, command] of [['play', 2], ['next', 4], ['previous', 5]]) {
    events.length = 0;
    sysInput.runSystem({ t: 's', k: name });
    assert.deepStrictEqual(events, [{ media: command }], name);
  }
});

test('volume steps are clamped and unmute, like the keyboard', () => {
  const events = [];
  const sysInput = loadInput(null, events);
  sysInput.runSystem({ t: 's', k: 'volup' });
  sysInput.runSystem({ t: 's', k: 'voldown' });
  sysInput.runSystem({ t: 's', k: 'mute' });
  const [up, down, mute] = events.map((e) => e.script);
  assert.match(up, /\(get volume settings\)\) \+ \(6\)/);
  assert.match(down, /\(get volume settings\)\) \+ \(-6\)/);
  for (const s of [up, down]) {
    assert.match(s, /if diyVol < 0 then set diyVol to 0/);
    assert.match(s, /if diyVol > 100 then set diyVol to 100/);
    assert.match(s, /set volume without output muted$/);
  }
  assert.strictEqual(mute, 'set volume output muted (not (output muted of (get volume settings)))');
});

test('brightness, lock and display-off are fixed AppleScript, and nothing else is accepted', () => {
  const events = [];
  const sysInput = loadInput(null, events);
  for (const k of ['brightup', 'brightdown', 'lock', 'displayoff', 'missioncontrol']) {
    sysInput.runSystem({ t: 's', k });
  }
  assert.deepStrictEqual(events, [
    { script: TELL + 'key code 144' },
    { script: TELL + 'key code 145' },
    { script: TELL + 'keystroke "q" using {control down, command down}' },
    { script: 'do shell script "pmset displaysleepnow"' },
    { script: 'do shell script "open -a \'Mission Control\'"' },
  ]);
  events.length = 0;
  for (const k of ['nope', 'toString', '__proto__', 'constructor', undefined]) {
    assert.throws(() => sysInput.runSystem({ t: 's', k }), /Unknown system control/, String(k));
  }
  assert.deepStrictEqual(events, []);
});

test('dictation is its key, down and up apart; Do Not Disturb is a tap of its key', () => {
  const events = [];
  const sysInput = loadInput(null, events);
  sysInput.runSystem({ t: 's', k: 'dictationdown' });
  sysInput.runSystem({ t: 's', k: 'dictationup' });
  assert.deepStrictEqual(events, [{ key: [176, true] }, { key: [176, false] }]);
  events.length = 0;
  sysInput.runSystem({ t: 's', k: 'dnd' });
  assert.deepStrictEqual(events, [{ key: [178, true] }, { key: [178, false] }]);
});
