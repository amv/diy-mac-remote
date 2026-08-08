'use strict';

// The JXA implementation of the host interface described in app/sys.js.
//
// Everything the application needs from the outside world, expressed through
// the ObjC bridge: Foundation for files, processes and randomness,
// CoreGraphics for the keyboard and the mouse.
//
// The input half is why this host exists. Posting a CGEvent requires being in a
// process that can call CoreGraphics, and the way this project reaches
// CoreGraphics without a compiler or a native module is `osascript -l
// JavaScript`. Running the *whole* server in there — instead of shelling out to
// it per keystroke, or keeping a second process on a pipe — is what makes the
// mouse and the keyboard ordinary function calls, and what removes Node.js from
// the critical path.

ObjC.import('Foundation');
ObjC.import('CoreGraphics');

var fm = $.NSFileManager.defaultManager;

// ObjC nil is not JS null: an unwrapped nil comes back as undefined, and a
// wrapped one answers isNil(). Funnel both through one place.
function isNil(v) {
  if (v === null || v === undefined) return true;
  try { return v.isNil(); } catch (e) { return false; }
}

function str(v) {
  if (isNil(v)) return null;
  var s = ObjC.unwrap(v);
  return typeof s === 'string' ? s : null;
}

// A number that came across the ObjC bridge is not always a JS number: an
// NSUInteger like NSData's `length` can arrive as something that prints as 32,
// adds as 32, and still fails `=== 32`. Every numeric value read from the bridge
// goes through here before it is compared to anything. (This cost an afternoon:
// "short read from /dev/urandom (32/32)".)
function num(v) {
  return Number(ObjC.unwrap(v));
}

function readText(path) {
  return str($.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, $()));
}

// Refuse to use a credential (or its directory) unless we own it and no other
// user can touch it — the same stance ssh takes on private keys.
//
// The Node host checks this on the open file descriptor (fstat), which leaves
// no window between the check and the read. JavaScriptCore has no fstat to
// reach through the bridge, so here the check is by path. The gap that opens is
// narrower than it looks: the directory is checked first and must be
// owner-only, and nobody who cannot write that directory can swap a file inside
// it between our two calls.
function assertOwnerOnly(path) {
  var attrs = fm.attributesOfItemAtPathError($(path), $());
  if (isNil(attrs)) throw new Error(path + ' cannot be inspected.');
  var owner = str(attrs.objectForKey($.NSFileOwnerAccountName));
  var perms = num(attrs.objectForKey($.NSFilePosixPermissions));
  var me = str($.NSUserName());
  // A check we cannot make is a check that failed. Refusing to use a credential
  // whose ownership or mode is unreadable is the only safe way round: the
  // alternative is skipping the check quietly, which is how a loosened secret
  // gets used as if it were fine.
  if (owner === null || me === null || !isFinite(perms)) {
    throw new Error(path + ': cannot read who owns it and who can read it.');
  }
  if (owner !== me) {
    throw new Error(path + ' is owned by ' + owner + ', not you (' + me + ').');
  }
  if (perms & 0x3f) { // 0o077
    throw new Error(path + ' is accessible to other users (mode ' +
                    (perms & 0x1ff).toString(8) + '). The secret may be exposed.');
  }
}

// ---- processes --------------------------------------------------------------

// Run a command and return its trimmed stdout, or null if it fails in any way.
// /usr/bin/env is the launch path so that PATH lookup works: NSTask insists on
// an absolute executable, and every caller here names a command, not a path.
function runTask(bin, args, wait) {
  var task = $.NSTask.alloc.init;
  task.launchPath = '/usr/bin/env';
  task.arguments = [String(bin)].concat(args || []);
  task.standardInput = $.NSFileHandle.fileHandleWithNullDevice;
  task.standardError = $.NSFileHandle.fileHandleWithNullDevice;
  var pipe = wait ? $.NSPipe.pipe : null;
  task.standardOutput = wait ? pipe : $.NSFileHandle.fileHandleWithNullDevice;
  try {
    task.launch;
  } catch (e) {
    return null;
  }
  if (!wait) return null;
  // Read before waiting: a command that fills the pipe buffer would otherwise
  // block forever waiting for us while we wait for it.
  var data = pipe.fileHandleForReading.readDataToEndOfFile;
  task.waitUntilExit;
  if (num(task.terminationStatus) !== 0) return null;
  var out = str($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
  return out === null ? null : (out.trim() || null);
}

// ---- input ------------------------------------------------------------------
//
// Mouse events, ported straight from the JXA helper this used to keep on a
// pipe. Event-type constants are numeric (the kCG* enums aren't reliably
// bridged as symbols): mouseMoved=5, L down/up=1/2, R down/up=3/4,
// L/R dragged=6/7. kCGHIDEventTap is 0.
var MOUSE_MOVED = 5, L_DOWN = 1, L_UP = 2, R_DOWN = 3, R_UP = 4, L_DRAG = 6, R_DRAG = 7;
var HID_TAP = 0;

var leftDown = false, rightDown = false;

// macOS doesn't infer double-clicks from timing on synthesized events: the
// kCGMouseEventClickState field (CGEventField 1) must be 2 on the second
// down/up pair or the OS treats them as two single clicks. Track recent clicks
// (same button, within the double-click window and a few px) and stamp the
// running count on each event.
var lastClick = { t: 0, x: 0, y: 0, btn: -1, count: 0 };
var downCount = { 0: 1, 1: 1 };

function location() { return $.CGEventGetLocation($.CGEventCreate($())); }
function post(ev) { $.CGEventPost(HID_TAP, ev); }

function clickCount(btn, p) {
  var now = Date.now();
  if (btn === lastClick.btn && now - lastClick.t < 500 &&
      Math.abs(p.x - lastClick.x) < 10 && Math.abs(p.y - lastClick.y) < 10) {
    lastClick.count++;
  } else {
    lastClick.count = 1;
  }
  lastClick.t = now; lastClick.x = p.x; lastClick.y = p.y; lastClick.btn = btn;
  return lastClick.count;
}

function mouse(c) {
  if (c.k === 'mv') {
    var l = location();
    var mp = $.CGPointMake(l.x + c.dx, l.y + c.dy);
    // While a button is held, send the matching drag event instead of a plain
    // move — press-hold plus move is how a drag-and-drop is made.
    var type = leftDown ? L_DRAG : (rightDown ? R_DRAG : MOUSE_MOVED);
    post($.CGEventCreateMouseEvent($(), type, mp, rightDown ? 1 : 0));
    return;
  }
  if (c.k === 'sc') {
    post($.CGEventCreateScrollWheelEvent($(), 0, 1, c.dy));
    return;
  }

  var right = c.btn === 'r';
  var button = right ? 1 : 0;
  var here = location();
  var point = $.CGPointMake(here.x, here.y);

  if (c.k === 'cl') {
    var n = clickCount(button, point);
    var down = $.CGEventCreateMouseEvent($(), right ? R_DOWN : L_DOWN, point, button);
    $.CGEventSetIntegerValueField(down, 1, n);
    post(down);
    var up = $.CGEventCreateMouseEvent($(), right ? R_UP : L_UP, point, button);
    $.CGEventSetIntegerValueField(up, 1, n);
    post(up);
    return;
  }
  if (c.k === 'dn') {
    if (right) rightDown = true; else leftDown = true;
    downCount[button] = clickCount(button, point);
    var evd = $.CGEventCreateMouseEvent($(), right ? R_DOWN : L_DOWN, point, button);
    $.CGEventSetIntegerValueField(evd, 1, downCount[button]);
    post(evd);
    return;
  }
  if (c.k === 'up') {
    if (right) rightDown = false; else leftDown = false;
    var evu = $.CGEventCreateMouseEvent($(), right ? R_UP : L_UP, point, button);
    $.CGEventSetIntegerValueField(evu, 1, downCount[button]);
    post(evu);
  }
}

// ---- typing -----------------------------------------------------------------
//
// Keystrokes are an AppleScript program (built in app/input.js), compiled and
// run here with NSAppleScript — in this process, no launch, no spawn. That is
// the one change from the implementation this replaces, which shelled out to
// `osascript` per keypress and paid ~100ms for it.
//
// Why not CoreGraphics, when the mouse uses it: posting literal text needs
// CGEventKeyboardSetUnicodeString, which takes a `const UniChar *`, and the JXA
// bridge will not pass one. An NSMutableData buffer is refused outright ("Ref
// has incompatible type"), and a JS array is accepted and then quietly ignored —
// which produces a keyboard where every key types "a", because the event goes
// out carrying virtual key 0 and no string at all. Key codes would work; text
// is what cannot. And text is the point of a keyboard.
//
// The cost is the permission: `keystroke` goes through System Events, so macOS
// asks for Automation as well as Accessibility. The mouse still uses
// CoreGraphics directly and needs only Accessibility.
function runScript(source) {
  var script = $.NSAppleScript.alloc.initWithSource($(source));
  if (isNil(script)) throw new Error('could not compile the keystroke script');
  // NULL for the error dictionary: a nil result already says it failed, and
  // reading an out-param dictionary through the bridge is the kind of thing
  // that fails silently. The likely cause is worth stating outright.
  var result = script.executeAndReturnError($());
  if (isNil(result)) {
    throw new Error('AppleScript refused to run the keystrokes. If macOS has ' +
                    'asked to control "System Events" and the answer was no, ' +
                    'turn it back on in System Settings > Privacy & Security > ' +
                    'Automation. Script was: ' + source.split('\n').join(' / '));
  }
}

// ---- logging ----------------------------------------------------------------

// Under osascript, console.log writes to stderr — which is exactly where this
// belongs: stdout carries the messages, and the entrypoint relays stderr to the
// terminal.
function log(msg) { console.log(String(msg)); }

// ---- the interface ----------------------------------------------------------

var sys = {
  platform: 'darwin',
  host: 'jxa',
  dryRun: false,
  root: null,

  env: function (name) {
    var v = str($.NSProcessInfo.processInfo.environment.objectForKey(name));
    return v ? v : null;
  },

  // $HOME first, NSHomeDirectory() second: Node's os.homedir() prefers the
  // environment on POSIX and the two hosts must agree on where the pairing
  // lives — not least so a test run can point both at a throwaway directory.
  homedir: function () {
    return sys.env('HOME') || str($.NSHomeDirectory());
  },

  log: log,

  exists: function (path) {
    return fm.fileExistsAtPath($(path));
  },

  assertOwnerOnly: assertOwnerOnly,

  readOwnedText: function (file, dir) {
    if (!fm.fileExistsAtPath($(file))) return null;
    assertOwnerOnly(dir);
    assertOwnerOnly(file);
    var text = readText(file);
    return text === null ? null : (text.trim() || null);
  },

  writePrivateText: function (path, text) {
    var data = $(String(text)).dataUsingEncoding($.NSUTF8StringEncoding);
    // Create with the mode already set, so the contents are never briefly
    // readable by anyone else, and re-assert it in case the file already existed.
    fm.createFileAtPathContentsAttributes($(path), data, { NSFilePosixPermissions: 0x180 }); // 0o600
    fm.setAttributesOfItemAtPathError({ NSFilePosixPermissions: 0x180 }, $(path), $());
  },

  mkdirPrivate: function (path) {
    fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
      $(path), true, { NSFilePosixPermissions: 0x1c0 }, $()); // 0o700
  },

  randomBase64: function (n) {
    var fh = $.NSFileHandle.fileHandleForReadingAtPath('/dev/urandom');
    if (isNil(fh)) throw new Error('cannot open /dev/urandom for key material');
    var data = fh.readDataOfLength(n);
    fh.closeFile;
    var got = isNil(data) ? 0 : num(data.length);
    if (got !== n) {
      throw new Error('short read from /dev/urandom (' + got + '/' + n + ')');
    }
    return str(data.base64EncodedStringWithOptions(0));
  },

  exec: function (bin, args) { return runTask(bin, args, true); },

  execDetached: function (bin, args) {
    try { runTask(bin, args, false); } catch (e) { /* best effort */ }
  },

  // Every non-loopback IPv4 address on this Mac. NSHost answers this directly;
  // if it ever doesn't, ifconfig is the fallback (this runs only on a pairing
  // run that found no hostname, so the cost is irrelevant).
  lanAddresses: function () {
    var out = [];
    try {
      var addrs = ObjC.deepUnwrap($.NSHost.currentHost.addresses) || [];
      for (var i = 0; i < addrs.length; i++) {
        var a = String(addrs[i]);
        if (/^\d+\.\d+\.\d+\.\d+$/.test(a) && a.indexOf('127.') !== 0 && a !== '0.0.0.0' &&
            out.indexOf(a) < 0) {
          out.push(a);
        }
      }
    } catch (e) { /* fall through */ }
    if (out.length) return out;
    var text = runTask('ifconfig', ['-a'], true) || '';
    var m = text.match(/inet (\d+\.\d+\.\d+\.\d+)/g) || [];
    for (var j = 0; j < m.length; j++) {
      var ip = m[j].slice(5);
      if (ip.indexOf('127.') !== 0 && out.indexOf(ip) < 0) out.push(ip);
    }
    return out;
  },

  input: {
    keyScript: runScript,
    mouse: mouse,
    sleep: function (seconds) {
      if (seconds > 0) $.NSThread.sleepForTimeInterval(seconds);
    },
  },
};

module.exports = sys;
