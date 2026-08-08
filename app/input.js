'use strict';

// Turning a decoded request into keystrokes and mouse events.
//
// The two halves go out by different routes, for the same reason they always
// have: AppleScript can type but cannot move the cursor, and CoreGraphics can
// do both but can only be handed literal text through a C pointer the JXA
// bridge will not pass. So:
//
//   keyboard — an AppleScript program, compiled and run *inside* this process
//              with NSAppleScript. Same statements the old executor.js built
//              and handed to `osascript`; what changed is that there is no
//              longer a process launch per keypress — and that a character the
//              keyboard layout cannot reach now goes via the clipboard instead
//              of silently typing "a" (see keystrokeCanType below).
//   mouse    — CoreGraphics events, posted directly (app/sys-jxa.js).
//
// Building the script is what this module does, and it does it purely: no
// events are posted here, nothing platform-specific is touched, so the exact
// program that will run can be checked without a Mac (test/input.test.js).
//
// Key actions (unchanged from the HTTP API this project has always had):
//   { text: "hello" }                        type literal text
//   { text: "s", modifiers: ["command"] }    ⌘S
//   { key: "return" }                        named special key (keys.js)
//   { code: 36 }                             raw macOS key code
//   { key: "left", modifiers: ["command"] }  special key with modifiers
//   { delay: 500 }                           wait, milliseconds

var sys = require('./sys');
var keys = require('./keys');

// Escape a string for safe embedding inside an AppleScript double-quoted literal.
//
// Quotes and backslashes escape the usual way. Line breaks cannot: AppleScript
// has no \n escape, so a newline in the text would have to appear in the source
// as a newline — and a statement that spans lines is a statement whose lines
// can be read as statements. The text arrives from the phone, so that is not a
// gap to reason about; it is one to close. Each line becomes its own literal,
// joined with AppleScript's `linefeed`, which keeps a text action to exactly one
// line of source however many lines of text it carries.
function asString(str) {
  var parts = String(str).split(/\r\n|\r|\n/).map(function (part) {
    return '"' + part.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  });
  // Parenthesised when concatenated, so the whole expression is unambiguously
  // the command's argument and not the start of something else.
  return parts.length === 1 ? parts[0] : '(' + parts.join(' & linefeed & ') + ')';
}

function resolveModifiers(modifiers) {
  if (modifiers === undefined || modifiers === null) return '';
  if (!Array.isArray(modifiers)) throw new Error('modifiers must be an array');
  if (modifiers.length === 0) return '';
  var parts = [];
  for (var i = 0; i < modifiers.length; i++) {
    var name = String(modifiers[i]).toLowerCase();
    if (!keys.MODIFIERS[name]) throw new Error('Unknown modifier: ' + modifiers[i]);
    parts.push(keys.MODIFIERS[name]);
  }
  return ' using {' + parts.join(', ') + '}';
}

// Which characters `keystroke` can actually produce.
//
// System Events maps a character back to ONE keypress on the Mac's current
// layout. Anything the layout cannot reach that way does not fail loudly: it
// comes out as key code 0, which types "a". On a Finnish keyboard é and ü
// arrive, õ (option+~ then o) becomes "a", and an emoji becomes two of them.
//
// There is no way to ask macOS what the layout can reach — the APIs that know
// (UCKeyTranslate, TIS…) take C pointers the JXA bridge will not pass, which is
// also why CGEventKeyboardSetUnicodeString, the call that would make this whole
// problem disappear, is unavailable here. See test/unicode-probe.jxa.js for the
// six ways that were tried and the six that failed.
//
// So the rule is: ASCII goes through `keystroke`, because every Latin layout can
// reach it; anything else goes through the clipboard, which can carry any
// character at all. That is correct everywhere and slower where it applies.
// If your layout does reach some of those characters directly — äöå on a Nordic
// keyboard, éè on a French one — name them and they keep the fast path:
//
//     DIY_MAC_REMOTE_DIRECT_CHARS='äöåÄÖÅ' ./start.sh
//
// Get that list wrong in the generous direction and those characters type "a"
// again, which is exactly the bug this rule exists to avoid — so it is opt-in.
function directChars() {
  return sys.env('DIY_MAC_REMOTE_DIRECT_CHARS') || '';
}

function keystrokeCanType(text) {
  var extra = directChars();
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) continue;          // ASCII: any Latin layout has it
    if (c === 9 || c === 10 || c === 13) continue; // tab and line breaks
    if (extra.indexOf(text.charAt(i)) >= 0) continue;
    return false;
  }
  return true;
}

var TELL = 'tell application "System Events" to ';

// Type text through the clipboard: the only way left to put a character on
// screen that the layout cannot reach. Costs a paste — and borrows the
// clipboard, which is why it is the exception and not the rule.
//
// The clipboard is saved and put back. Only its *text* is: if it held an image
// or styled content there is nothing here that can carry that across, so the
// flag below leaves it alone rather than replacing it with an empty string.
// (⌘V also has to be allowed where you are typing — a field that refuses paste
// refuses this.)
function clipboardStatements(text) {
  return [
    'set diyClipSaved to ""',
    'set diyClipHeld to false',
    'try',
    '  set diyClipSaved to (the clipboard as text)',
    '  set diyClipHeld to true',
    'end try',
    'set the clipboard to ' + asString(text),
    TELL + 'keystroke "v" using {command down}',
    'delay 0.15',
    'if diyClipHeld then set the clipboard to diyClipSaved',
  ];
}

// Convert a single action object into AppleScript statements. Each statement is
// a complete top-level line — `tell application "System Events" to …` rather
// than a block — so that a clipboard sequence and a keystroke can sit side by
// side in one program without nesting.
function actionToStatements(action) {
  if (action === null || typeof action !== 'object') {
    throw new Error('Action must be an object');
  }

  if ('delay' in action) {
    var ms = Number(action.delay);
    if (!Number.isFinite(ms) || ms < 0) throw new Error('Invalid delay');
    // A delay paces keystrokes; it is not a way to wedge the single-threaded
    // backend, which handles one request at a time and would keep the phone's
    // next keystroke waiting behind this one. Cap it at 5s.
    return ['delay ' + (Math.min(ms, 5000) / 1000)];
  }

  var mods = resolveModifiers(action.modifiers);

  if ('text' in action) {
    var text = String(action.text);
    if (mods) {
      // A shortcut is a chord, not a character, so the clipboard is no help
      // here — and letting it through would be worse than useless. An
      // unreachable character becomes key code 0, so ⌘ plus one of them is ⌘A:
      // Select All, and whatever is typed next replaces the document. Refuse it
      // and let the phone show the error instead.
      if (!keystrokeCanType(text)) {
        throw new Error('Cannot combine "' + text + '" with modifiers: this Mac\'s keyboard ' +
          'layout has no single key for it, and a shortcut needs one. (If the layout does ' +
          'reach it, add it to DIY_MAC_REMOTE_DIRECT_CHARS.)');
      }
      return [TELL + 'keystroke ' + asString(text) + mods];
    }
    if (keystrokeCanType(text)) return [TELL + 'keystroke ' + asString(text) + mods];
    return clipboardStatements(text);
  }

  if ('code' in action) {
    var code = Number(action.code);
    if (!Number.isInteger(code) || code < 0) throw new Error('Invalid key code');
    return [TELL + 'key code ' + code + mods];
  }

  if ('key' in action) {
    var name = String(action.key).toLowerCase();
    var known = keys.KEY_CODES[name];
    if (known === undefined) throw new Error('Unknown key: ' + action.key);
    return [TELL + 'key code ' + known + mods];
  }

  throw new Error('Action has no recognized field (text/key/code/delay)');
}

// Build a complete AppleScript program from a list of actions. The whole batch
// is one program: the client coalesces keystrokes per flush, and compiling once
// for the batch is the difference between a keyboard that keeps up and one that
// doesn't. Everything that can be rejected is rejected here, before a single
// statement runs — a batch that fails halfway has already typed half of itself.
function buildScript(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('actions must be a non-empty array');
  }
  var lines = [];
  for (var i = 0; i < actions.length; i++) {
    var statements = actionToStatements(actions[i]);
    for (var j = 0; j < statements.length; j++) lines.push(statements[j]);
  }
  return lines.join('\n');
}

function runKeys(actions) {
  var script = buildScript(actions);
  sys.input.keyScript(script);
  return sys.dryRun ? { dryRun: true, script: script } : { ok: true, n: actions.length };
}

function clampInt(x) {
  var n = Math.round(Number(x));
  if (!Number.isFinite(n)) return 0;
  return Math.max(-10000, Math.min(10000, n));
}

// Execute one mouse op.
//   { k:'mv', dx, dy }        relative move (a drag while a button is held)
//   { k:'cl', btn:'l'|'r' }   click (down+up)
//   { k:'dn'|'up', btn }      button hold / release
//   { k:'sc', dy }            scroll wheel
function runMouse(op) {
  var cmd;
  if (op.k === 'mv') cmd = { k: 'mv', dx: clampInt(op.dx), dy: clampInt(op.dy) };
  else if (op.k === 'cl' || op.k === 'dn' || op.k === 'up') cmd = { k: op.k, btn: op.btn === 'r' ? 'r' : 'l' };
  else if (op.k === 'sc') cmd = { k: 'sc', dy: clampInt(op.dy) };
  else throw new Error('bad mouse op');
  sys.input.mouse(cmd);
  return sys.dryRun ? { dryRun: true, cmd: cmd } : { ok: true };
}

module.exports = {
  buildScript: buildScript,
  actionToStatements: actionToStatements,
  runKeys: runKeys,
  runMouse: runMouse,
};
