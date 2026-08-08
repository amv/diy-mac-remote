// The JXA backend host — the real one, and the reason this project needs no
// Node.js at all.
//
//   osascript -l JavaScript app/host-jxa.js
//
// Started by an entrypoint (server.js or server.pl), never by hand: it speaks
// the line protocol in app/protocol.js over stdin/stdout and nothing else.
//
// What this file does, in order:
//   1. Bootstraps two modules by hand — there is no require() yet, so it reads
//      app/pathutil.js and app/loader.js and evaluates them with new Function.
//   2. Builds the real module loader out of them (app/loader.js), backed by
//      Foundation file reads, and installs the platform implementation
//      (app/sys-jxa.js) where app/sys.js will find it.
//   3. Loads the application and pumps messages: read one, answer it, repeat.
//
// Being *inside* this process is the point. The keyboard and the mouse are
// CoreGraphics calls here (app/sys-jxa.js), so a keystroke costs a function
// call rather than an `osascript` launch — which is what the old design paid,
// per keystroke, and why it needed a long-lived helper process of its own.
//
// Written in ES5 style on purpose: JavaScriptCore gets this as a plain script
// and every module goes through new Function, so there is no tooling anywhere
// in the path to fall back on.

ObjC.import('Foundation');

var GLOBAL = (typeof globalThis !== 'undefined') ? globalThis : Function('return this')();

function jxaReadText(path) {
  var s = $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, $());
  if (!s || s.isNil()) return null;
  return ObjC.unwrap(s);
}

function jxaExists(path) {
  return $.NSFileManager.defaultManager.fileExistsAtPath(path);
}

// ---- where we are -----------------------------------------------------------
//
// osascript is given a script path, not a module: there is no __dirname to
// start from. The entrypoint passes the checkout's location in the
// environment; if that ever goes missing, fall back to this script's own path
// in the process arguments. (The two-line dirname is here because even
// app/pathutil.js can't be read until we know where app/ is.)
function jxaDirname(p) {
  var i = p.lastIndexOf('/');
  if (i < 0) return '.';
  if (i === 0) return '/';
  return p.slice(0, i);
}

function jxaFindRoot() {
  var fromEnv = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('DIY_MAC_REMOTE_ROOT'));
  if (typeof fromEnv === 'string' && fromEnv) return fromEnv;
  var args = ObjC.deepUnwrap($.NSProcessInfo.processInfo.arguments) || [];
  for (var i = 0; i < args.length; i++) {
    var arg = String(args[i]);
    if (arg.indexOf('host-jxa.js') < 0) continue;
    if (arg.charAt(0) !== '/') {
      arg = ObjC.unwrap($.NSFileManager.defaultManager.currentDirectoryPath) + '/' + arg;
    }
    return jxaDirname(jxaDirname(arg)); // .../app/host-jxa.js -> ...
  }
  throw new Error('cannot locate the diy-mac-remote checkout: DIY_MAC_REMOTE_ROOT is unset');
}

var ROOT = jxaFindRoot();
var APP_DIR = ROOT + '/app';

// ---- bootstrap --------------------------------------------------------------

// Evaluate a module that must exist before require() does. Only pathutil and
// loader qualify, and neither of them requires anything itself.
function jxaBootstrap(file) {
  var src = jxaReadText(file);
  if (src === null) throw new Error('cannot read ' + file);
  var module = { exports: {} };
  new Function('exports', 'module', '__filename', src)(module.exports, module, file);
  return module.exports;
}

var pathutil = jxaBootstrap(APP_DIR + '/pathutil.js');
var loaderModule = jxaBootstrap(APP_DIR + '/loader.js');

var loader = loaderModule.createLoader({
  readText: jxaReadText,
  exists: jxaExists,
  path: pathutil,
});
// Hand the loader the two modules it didn't load, so requiring them later
// returns these objects instead of a second copy.
loader.define(APP_DIR + '/pathutil.js', pathutil);
loader.define(APP_DIR + '/loader.js', loaderModule);

var require = loader.requireFrom(APP_DIR);

// ---- boot -------------------------------------------------------------------

var sys = require('./sys-jxa');
sys.root = ROOT;
// Must be in place before main.js — or anything it pulls in — reaches for it.
GLOBAL.__DIY_MAC_REMOTE_SYS__ = sys;

var protocol = require('./protocol');
var main = require('./main');

// ---- messages ---------------------------------------------------------------

var stdin = $.NSFileHandle.fileHandleWithStandardInput;
var stdout = $.NSFileHandle.fileHandleWithStandardOutput;

function send(message) {
  stdout.writeData($(protocol.encode(message)).dataUsingEncoding($.NSUTF8StringEncoding));
}

function onMessage(msg) {
  var type = protocol.one(msg, 't');

  if (type === 'hello') {
    var dns = protocol.all(msg, 'cert-dns');
    var ip = protocol.all(msg, 'cert-ip');
    var result = main.init({
      scheme: protocol.one(msg, 'scheme'),
      port: Number(protocol.one(msg, 'port')),
      entry: protocol.one(msg, 'entry'),
      argv: protocol.all(msg, 'arg'),
      certHosts: (dns.length || ip.length) ? { dns: dns, ip: ip } : null,
    });
    send({ t: 'hello', ok: result.ok ? 1 : 0, 'dry-run': result.dryRun ? 1 : 0, error: result.error });
    return;
  }

  if (type === 'banner') {
    main.banner();
    send({ t: 'banner', ok: 1 });
    return;
  }

  if (type === 'req') {
    var id = protocol.one(msg, 'id');
    var res;
    try {
      res = main.handle({
        method: protocol.one(msg, 'method'),
        path: protocol.one(msg, 'path'),
        body: protocol.one(msg, 'body') || '',
      });
    } catch (err) {
      // One bad request must never take the backend down: from the phone, a
      // dead backend and a dead server look exactly the same.
      sys.log('request failed: ' + (err && err.message ? err.message : err));
      res = { status: 500, text: JSON.stringify({ error: 'internal error' }) };
    }
    send({ t: 'res', id: id, status: res.status, body: res.text });
    return;
  }

  sys.log('unknown message type: ' + type);
}

// Blocking read loop. availableData returns whatever has arrived, so messages
// turn up split and glued in every combination; keep the tail and carry on. A
// blank line ends a message, so "\n\n" is the boundary between them. Zero bytes
// means the entrypoint closed the pipe (or died) — time to go.
var buf = '';
var BOUNDARY = String.fromCharCode(10, 10);
while (true) {
  var data = stdin.availableData;
  // Number(): an NSUInteger off the bridge can fail `=== 0` while being zero,
  // and getting this one wrong means spinning forever instead of exiting when
  // the entrypoint goes away. See num() in app/sys-jxa.js.
  if (!data || Number(ObjC.unwrap(data.length)) === 0) break;
  var chunk = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  if (!chunk || chunk.isNil()) continue; // not our encoding — messages are ASCII
  buf += ObjC.unwrap(chunk);
  var end;
  while ((end = buf.indexOf(BOUNDARY)) >= 0) {
    var text = buf.slice(0, end + 1);
    buf = buf.slice(end + 2);
    onMessage(protocol.decode(text));
  }
}

// osascript prints the script's result on stdout when it finishes — and stdout
// is the message channel. End on a statement whose value is undefined, which
// prints nothing at all.
undefined;
