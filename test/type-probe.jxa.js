// A JXA script that types and moves the mouse, and nothing else.
//
//   ./test/jxa-smoke.sh --type          (which is how you should run it)
//
// This exercises the one part of the project that no test on another machine
// can reach: app/sys-jxa.js actually running the keystroke script and posting
// real CoreGraphics mouse events. Everything upstream of it — the loader, the
// routing, the pairing, the crypto, the exact AppleScript that gets built — is
// covered by `npm test` on any machine. What is left is whether it comes out.
//
// It needs the same permissions the server does, granted to whatever is running
// it (your Terminal, if you run it there): Accessibility for the mouse, and
// Automation > System Events for the keyboard.
//
// The bootstrap below is deliberately the same shape as app/host-jxa.js: read
// two modules by hand, build the loader out of them, install the platform layer
// on the global where app/sys.js looks for it.

ObjC.import('Foundation');

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
if (!ROOT) throw new Error('DIY_MAC_REMOTE_ROOT is unset — run test/jxa-smoke.sh instead');
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

console.log('Click into a text field (TextEdit, a browser address bar, anything');
console.log('you do not mind typing into). Starting in 5 seconds...');
for (var i = 5; i > 0; i--) {
  console.log('  ' + i);
  sys.input.sleep(1);
}

// Plain text. The whole batch is one compiled script.
console.log('typing: diy-mac-remote 123');
input.runKeys([{ text: 'diy-mac-remote 123' }]);

// Non-ASCII, which is why the keyboard goes through `keystroke` at all.
console.log('typing: äöü — 🙂');
input.runKeys([{ text: ' äöü — 🙂' }]);

// A named key, which goes out as `key code` rather than as characters.
console.log('pressing: return');
input.runKeys([{ key: 'return' }]);

// A shortcut, and a delay, in one script.
console.log('pressing: command+a, then delete (undo it if this was not scratch)');
input.runKeys([{ text: 'a', modifiers: ['command'] }, { delay: 300 }, { key: 'delete' }]);

// And the mouse: a small square, then back roughly where it started.
console.log('moving the mouse in a square');
var steps = [[60, 0], [0, 60], [-60, 0], [0, -60]];
for (var s = 0; s < steps.length; s++) {
  for (var n = 0; n < 20; n++) {
    input.runMouse({ k: 'mv', dx: steps[s][0] / 20, dy: steps[s][1] / 20 });
    sys.input.sleep(0.01);
  }
}

console.log('');
console.log('Done. What should have happened:');
console.log('  * "diy-mac-remote 123 äöü — 🙂" typed, then Return');
console.log('  * everything selected (⌘A) and deleted');
console.log('  * the pointer traced a square and came back');
console.log('If the mouse moved but nothing was typed, macOS is refusing the');
console.log('keystrokes: System Settings > Privacy & Security > Automation, and');
console.log('allow whatever ran this to control System Events.');
undefined;
