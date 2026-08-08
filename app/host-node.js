'use strict';

// The Node backend host — the development twin of app/host-jxa.js.
//
// Same job as the JXA host: install a platform implementation, load the
// application, and pump messages between stdin and stdout. The differences are
// that Node brings its own module loader (so there is no mini-require here) and
// its own event loop (so the read loop is a stream handler rather than a while
// loop), and that input events are logged instead of posted.
//
// This host is what the test suite runs against, and what you get on any
// machine that isn't a Mac. On a Mac, DIY_MAC_REMOTE_BACKEND=node picks it
// deliberately — useful to see the routing and pairing work with nothing
// touching the screen.
//
//   node app/host-node.js        (started by server.js; not by hand)

const sys = require('./sys-node');

// Must be in place before main.js — or anything it pulls in — reaches for it.
const g = (typeof globalThis !== 'undefined') ? globalThis : global;
g.__DIY_MAC_REMOTE_SYS__ = sys;

const protocol = require('./protocol');
const main = require('./main');

function send(message) {
  process.stdout.write(protocol.encode(message));
}

function onMessage(msg) {
  const type = protocol.one(msg, 't');

  if (type === 'hello') {
    const dns = protocol.all(msg, 'cert-dns');
    const ip = protocol.all(msg, 'cert-ip');
    const result = main.init({
      scheme: protocol.one(msg, 'scheme'),
      port: Number(protocol.one(msg, 'port')),
      entry: protocol.one(msg, 'entry'),
      argv: protocol.all(msg, 'arg'),
      certHosts: (dns.length || ip.length) ? { dns, ip } : null,
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
    const id = protocol.one(msg, 'id');
    let res;
    try {
      res = main.handle({
        method: protocol.one(msg, 'method'),
        path: protocol.one(msg, 'path'),
        body: protocol.one(msg, 'body') || '',
      });
    } catch (err) {
      // A request must never take the backend down: the phone would see the
      // whole server disappear over one bad message.
      sys.log('request failed: ' + (err && err.stack ? err.stack : err));
      res = { status: 500, text: JSON.stringify({ error: 'internal error' }) };
    }
    send({ t: 'res', id: id, status: res.status, body: res.text });
    return;
  }

  sys.log('unknown message type: ' + type);
}

// A blank line ends a message, so "\n\n" is the boundary between them.
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let end;
  while ((end = buf.indexOf('\n\n')) >= 0) {
    const text = buf.slice(0, end + 1);
    buf = buf.slice(end + 2);
    onMessage(protocol.decode(text));
  }
});

// The entrypoint closing stdin (or dying) is how the backend is told to stop.
process.stdin.on('end', () => process.exit(0));
