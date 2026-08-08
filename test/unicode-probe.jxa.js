// Which spelling of CGEventKeyboardSetUnicodeString does the JXA bridge accept?
//
//   ./test/jxa-smoke.sh --unicode       (which is how you should run it)
//
// Why this exists
// ---------------
// Keystrokes currently go through AppleScript's `keystroke`, which maps each
// character back to ONE keypress on the Mac's current keyboard layout. That is
// fine for anything the layout has a key for — on a Finnish keyboard ä and ö
// are single keys and arrive perfectly — and hopeless for anything it can only
// produce as a dead key followed by a letter: é (´+e), ü (¨+u), õ (~+o). Those
// have no single keypress to map to, so they come out wrong or not at all.
//
// CGEventKeyboardSetUnicodeString has no such limit: it posts the characters
// themselves, whatever the layout, emoji included. The catch is its signature —
// `const UniChar *`, a pointer to 16-bit units — and the JXA bridge is fussy
// about which JS value it will accept there. One spelling is refused outright
// ("Ref has incompatible type"); another is accepted and then silently ignored,
// which produced a keyboard where every key typed "a".
//
// So this script tries every spelling worth trying and lets the SCREEN decide.
// "It didn't throw" has already been wrong once; what lands in a text field
// cannot be.
//
// How to read it
// --------------
// Click into an empty scratch document, run it, and look at what was typed.
// Each attempt writes its own number and an equals sign using AppleScript
// (which is known to work for ASCII), then tries to add the sample text with
// the spelling being tested. So a line reading
//
//     3=éüõ😀
//
// means attempt 3 works and is the one to use. A line reading `3=` or `3=aaaa`
// means that spelling is a dud. The console says separately which ones threw.

ObjC.import('Foundation');
ObjC.import('CoreGraphics');

var GLOBAL = (typeof globalThis !== 'undefined') ? globalThis : Function('return this')();

function readText(path) {
  var s = $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, $());
  return (!s || s.isNil()) ? null : ObjC.unwrap(s);
}

function bootstrap(file) {
  var src = readText(file);
  if (src === null) throw new Error('cannot read ' + file);
  var module = { exports: {} };
  new Function('exports', 'module', '__filename', src)(module.exports, module, file);
  return module.exports;
}

var ROOT = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('DIY_MAC_REMOTE_ROOT'));
if (!ROOT) throw new Error('DIY_MAC_REMOTE_ROOT is unset — run test/jxa-smoke.sh --unicode instead');
var APP = ROOT + '/app';

var pathutil = bootstrap(APP + '/pathutil.js');
var loaderModule = bootstrap(APP + '/loader.js');
var loader = loaderModule.createLoader({
  readText: readText,
  exists: function (p) { return $.NSFileManager.defaultManager.fileExistsAtPath(p); },
  path: pathutil,
});
loader.define(APP + '/pathutil.js', pathutil);
loader.define(APP + '/loader.js', loaderModule);

var require = loader.requireFrom(APP);
var sys = require('./sys-jxa');
GLOBAL.__DIY_MAC_REMOTE_SYS__ = sys;
var input = require('./input');

// Characters chosen to fail on a Finnish layout under `keystroke`: each needs a
// dead key, and the emoji needs no key at all. If these arrive, the spelling
// that carried them is layout-independent and the keyboard problem is over.
var SAMPLE = 'éüõ😀';

function label(text) {
  input.runKeys([{ text: text }]);  // AppleScript, for the parts known to work
}

// Post one key-down/key-up pair carrying SAMPLE, with the string attached by
// `setter`. Virtual key 0 is used because the characters, not the key, are what
// the receiving app should read.
function typeWith(setter) {
  var down = $.CGEventCreateKeyboardEvent($(), 0, true);
  setter(down, SAMPLE);
  $.CGEventPost(0, down);
  var up = $.CGEventCreateKeyboardEvent($(), 0, false);
  setter(up, SAMPLE);
  $.CGEventPost(0, up);
}

// ---- the spellings ----------------------------------------------------------

// The buffer NSString itself fills in. This is the one that reports
// "Ref has incompatible type": mutableBytes is a void pointer and the parameter
// wants unsigned short *.
function viaMutableData(ev, text) {
  var ns = $(text);
  var n = Number(ObjC.unwrap(ns.length));
  var data = $.NSMutableData.dataWithLength(n * 2);
  ns.getCharactersRange(data.mutableBytes, $.NSMakeRange(0, n));
  $.CGEventKeyboardSetUnicodeString(ev, n, data.mutableBytes);
}

// A plain JS array of code units. This is the one that lies: no exception, no
// text. Kept in the list so its line on screen (empty, or "aaaa") stays the
// reference for what a silent failure looks like.
function viaArray(ev, text) {
  var units = [];
  for (var i = 0; i < text.length; i++) units.push(text.charCodeAt(i));
  $.CGEventKeyboardSetUnicodeString(ev, units.length, units);
}

// A typed array is the right shape in JS terms — 16-bit units, contiguous — so
// it is worth asking whether the bridge will hand its backing store over.
function viaUint16Array(ev, text) {
  var units = new Uint16Array(text.length);
  for (var i = 0; i < text.length; i++) units[i] = text.charCodeAt(i);
  $.CGEventKeyboardSetUnicodeString(ev, units.length, units);
}

// ObjC.bindFunction re-declares a C function with a signature of our choosing,
// which is the documented way past a bridge that won't accept an argument. If
// the third parameter is declared as a plain pointer, the type check that
// refuses mutableBytes has nothing left to object to. Three shapes of that idea:
function bindThen(argType) {
  return function (ev, text) {
    ObjC.bindFunction('CGEventKeyboardSetUnicodeString', ['void', ['void*', 'int', argType]]);
    var ns = $(text);
    var n = Number(ObjC.unwrap(ns.length));
    var data = $.NSMutableData.dataWithLength(n * 2);
    ns.getCharactersRange(data.mutableBytes, $.NSMakeRange(0, n));
    $.CGEventKeyboardSetUnicodeString(ev, n, data.mutableBytes);
  };
}

var ATTEMPTS = [
  ['NSMutableData.mutableBytes', viaMutableData],
  ['JS array of code units', viaArray],
  ['Uint16Array', viaUint16Array],
  ['bindFunction, buffer as void*', bindThen('void*')],
  ['bindFunction, buffer as char*', bindThen('char*')],
  ['bindFunction, buffer as unsigned short*', bindThen('unsigned short*')],
];

// Not a CGEvent spelling at all: put the text on the clipboard and press ⌘V.
// Layout-independent, needs no new permission, and certain to work — which is
// why it is here, as the answer if every attempt above is a dud. What it costs
// is the clipboard: this saves and restores the text on it, but a remote
// keyboard doing that on every keystroke is a real imposition, and anything on
// the clipboard that isn't plain text (an image, styled text) would not
// survive. A fallback, not a plan.
function viaClipboard() {
  var source =
    'set saved to ""\n' +
    'try\n' +
    '  set saved to (the clipboard as text)\n' +
    'end try\n' +
    'set the clipboard to "' + SAMPLE + '"\n' +
    'tell application "System Events" to keystroke "v" using {command down}\n' +
    'delay 0.2\n' +
    'set the clipboard to saved';
  var script = $.NSAppleScript.alloc.initWithSource($(source));
  if (script.executeAndReturnError($()).isNil()) throw new Error('the paste script would not run');
}

// ---- run --------------------------------------------------------------------

console.log('Click into an EMPTY scratch document — TextEdit, a new note, a text');
console.log('field you do not mind filling. This types ' + ATTEMPTS.length + ' lines into it.');
console.log('Starting in 5 seconds...');
for (var i = 5; i > 0; i--) {
  console.log('  ' + i);
  sys.input.sleep(1);
}

for (var a = 0; a < ATTEMPTS.length; a++) {
  var name = ATTEMPTS[a][0];
  var setter = ATTEMPTS[a][1];
  console.log('attempt ' + (a + 1) + ': ' + name);
  label(String(a + 1) + '=');
  try {
    typeWith(setter);
    console.log('   posted without complaint — look at the screen for whether it landed');
  } catch (err) {
    console.log('   threw: ' + (err && err.message ? err.message : err));
  }
  input.runKeys([{ key: 'return' }]);
  sys.input.sleep(0.3);
}

// The fallback, tried last so a working CGEvent spelling above is not confused
// with it.
console.log('attempt ' + (ATTEMPTS.length + 1) + ': clipboard + command-V');
label(String(ATTEMPTS.length + 1) + '=');
try {
  viaClipboard();
  console.log('   pasted (your clipboard was saved and put back)');
} catch (err) {
  console.log('   threw: ' + (err && err.message ? err.message : err));
}
input.runKeys([{ key: 'return' }]);
sys.input.sleep(0.3);

// For comparison, the same sample through what the server uses today. On a
// layout where these need dead keys, this is the line that comes out wrong —
// probably as a row of "a"s, which is System Events falling back to key code 0
// when it cannot map a character. That is the whole reason for this script.
console.log('and, for comparison, AppleScript keystroke (what the server uses now)');
label('now=' + SAMPLE);
input.runKeys([{ key: 'return' }]);

console.log('');
console.log('Now read the document. You are looking for a line that says exactly:');
console.log('');
console.log('    <number>=' + SAMPLE);
console.log('');
console.log('A line that stops at "=" is a spelling the bridge accepted and then');
console.log('ignored. A line of "a"s is key code 0 — the same thing the layout does');
console.log('when it cannot map a character, which is what you are seeing today.');
console.log('');
console.log('Tell me which numbers came out right. A CGEvent one (1-6) makes the');
console.log('keyboard layout-independent and drops the System Events permission with');
console.log('it; the last one is the fallback if none of those work.');
undefined;
