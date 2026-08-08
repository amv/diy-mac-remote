'use strict';

// Mouse control for macOS, dependency-free.
//
// AppleScript can't move the cursor, but JavaScript for Automation (JXA) can call
// CoreGraphics (Quartz Event Services) to synthesize mouse-move / click / scroll
// events. Spawning `osascript -l JavaScript` per movement would be far too slow
// (JXA startup is ~100ms+), so we keep ONE long-lived helper process and stream
// newline-delimited JSON commands to its stdin. Requires Accessibility
// permission (same as the keyboard).

const { spawn } = require('child_process');

// JXA daemon: read commands from stdin forever, post CG events for each.
// Command shapes: {k:'mv',dx,dy} relative move | {k:'cl',btn:'l'|'r'} click |
// {k:'dn'|'up',btn} button hold/release | {k:'sc',dy} scroll. Event-type
// constants are numeric (kCG* enums aren't reliably bridged as symbols):
// mouseMoved=5, L down/up=1/2, R down/up=3/4, L/R dragged=6/7. We track which
// button is held so a move becomes a drag (so press-hold + move = drag-and-drop).
const DAEMON = `
ObjC.import('Foundation');
ObjC.import('CoreGraphics');
function loc(){ return $.CGEventGetLocation($.CGEventCreate($())); }
function post(ev){ $.CGEventPost(0, ev); }
var leftDown = false, rightDown = false;
// macOS doesn't infer double-clicks from timing on synthesized events: the
// kCGMouseEventClickState field (CGEventField 1) must be 2 on the second
// down/up pair or the OS treats them as two single clicks. Track recent
// clicks (same button, within the double-click window and a few px) and
// stamp the running count on each event.
var last = { t: 0, x: 0, y: 0, btn: -1, count: 0 };
var downCount = { 0: 1, 1: 1 };
function clickCount(btn, p){
  var now = Date.now();
  if(btn === last.btn && now - last.t < 500 &&
     Math.abs(p.x - last.x) < 10 && Math.abs(p.y - last.y) < 10){
    last.count++;
  } else {
    last.count = 1;
  }
  last.t = now; last.x = p.x; last.y = p.y; last.btn = btn;
  return last.count;
}
function handle(line){
  line = line.trim();
  if(!line) return;
  var c;
  try { c = JSON.parse(line); } catch(e){ return; }
  if(c.k === 'mv'){
    var l = loc(); var mp = $.CGPointMake(l.x + c.dx, l.y + c.dy);
    // While a button is held, send the matching drag event instead of a plain move.
    var type = leftDown ? 6 : (rightDown ? 7 : 5);
    var btn = rightDown ? 1 : 0;
    post($.CGEventCreateMouseEvent($(), type, mp, btn));
  } else if(c.k === 'cl'){
    var l2 = loc(); var p = $.CGPointMake(l2.x, l2.y);
    var right = c.btn === 'r'; var b = right ? 1 : 0;
    var n = clickCount(b, p);
    var dn = $.CGEventCreateMouseEvent($(), right ? 3 : 1, p, b);
    $.CGEventSetIntegerValueField(dn, 1, n);
    post(dn);
    var up = $.CGEventCreateMouseEvent($(), right ? 4 : 2, p, b);
    $.CGEventSetIntegerValueField(up, 1, n);
    post(up);
  } else if(c.k === 'dn'){
    var ld = loc(); var rd = c.btn === 'r'; var bd = rd ? 1 : 0;
    if(rd) rightDown = true; else leftDown = true;
    downCount[bd] = clickCount(bd, ld);
    var evd = $.CGEventCreateMouseEvent($(), rd ? 3 : 1, $.CGPointMake(ld.x, ld.y), bd);
    $.CGEventSetIntegerValueField(evd, 1, downCount[bd]);
    post(evd);
  } else if(c.k === 'up'){
    var lu = loc(); var ru = c.btn === 'r'; var bu = ru ? 1 : 0;
    if(ru) rightDown = false; else leftDown = false;
    var evu = $.CGEventCreateMouseEvent($(), ru ? 4 : 2, $.CGPointMake(lu.x, lu.y), bu);
    $.CGEventSetIntegerValueField(evu, 1, downCount[bu]);
    post(evu);
  } else if(c.k === 'sc'){
    post($.CGEventCreateScrollWheelEvent($(), 0, 1, c.dy));
  }
}
var fh = $.NSFileHandle.fileHandleWithStandardInput;
var NL = String.fromCharCode(10);
var buf = '';
while(true){
  var data = fh.availableData;
  if(!data || data.length === 0) break;       // EOF -> exit when parent closes stdin
  buf += $.NSString.alloc.initWithDataEncoding(data, 4).js;  // NSUTF8StringEncoding = 4
  var parts = buf.split(NL);
  buf = parts.pop();                          // keep any partial trailing line
  // One bad op must not take the daemon down: an exception thrown out of
  // handle() escapes this loop, ends the script, and the mouse stays dead until
  // some later command happens to respawn a helper. Log it and keep reading.
  // (console.log goes to stderr under osascript, so the parent prefixes it.)
  for(var i = 0; i < parts.length; i++){
    try { handle(parts[i]); } catch(e){ console.log('op failed: ' + e.message); }
  }
}
`;

let helper = null;

// These lines are read long after the fact, out of a log the server appends to
// from login until shutdown — so unlike the rest of the server's output, they
// carry the time. "The mouse died some time today" is not a diagnosis.
function log(msg) {
  console.error(`[mouse ${new Date().toISOString()}] ${msg}`);
}

function ensureHelper() {
  if (helper && helper.stdin && helper.stdin.writable) return helper;
  helper = spawn('osascript', ['-l', 'JavaScript', '-e', DAEMON], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  log(`helper started (pid=${helper.pid})`);
  helper.stderr.on('data', (d) => log(d.toString().trim()));
  // A helper that dies takes the mouse with it until the next command respawns
  // one, and a respawn loop looks identical to "nothing happens" from the phone.
  // Say so in the log: code/signal is the difference between a JXA exception and
  // something killing the process.
  helper.on('exit', (code, signal) => {
    log(`helper exited (code=${code}, signal=${signal})`);
    helper = null;
  });
  helper.on('error', (e) => { log('helper error: ' + e.message); helper = null; });
  return helper;
}

// Fire-and-forget a single mouse command. Returns synchronously.
function send(cmd) {
  if (process.platform !== 'darwin') {
    console.log('[dry-run, not macOS] mouse ' + JSON.stringify(cmd));
    return { dryRun: true, cmd };
  }
  try {
    ensureHelper().stdin.write(JSON.stringify(cmd) + '\n');
  } catch (e) {
    helper = null;
    log('write failed: ' + e.message);
  }
  return { ok: true };
}

module.exports = { send };
