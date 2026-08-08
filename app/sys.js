'use strict';

// The one place the app touches the outside world.
//
// Everything under app/ is loaded by whichever host is running it — the JXA
// host (app/host-jxa.js, the real thing) or the Node host (app/host-node.js,
// for development and the test suite off macOS). The host installs its own
// implementation of the interface below on the global object before it loads
// main.js, and this module hands it out. Nothing else in app/ may reach for a
// platform API directly: that rule is what lets the identical application code
// run under `osascript -l JavaScript`, which has no Node at all.
//
// The interface (see the two hosts for the implementations):
//
//   platform            'darwin' | whatever the host reports
//   host                'jxa' | 'node'
//   dryRun              true when input events are logged instead of posted
//   root                absolute path of this checkout
//   env(name)           -> string | null
//   homedir()           -> string
//   log(msg)            -> a line on stderr (the entrypoint relays it)
//   exists(path)        -> boolean
//   assertOwnerOnly(p)  -> throws unless we own p and nobody else can touch it
//   readOwnedText(f, d) -> trimmed string | null; throws if f or d is not
//                          owner-only (see pairing.js for why)
//   writePrivateText(p, s)  0600
//   mkdirPrivate(p)         0700, with parents
//   randomBase64(n)     -> base64 of n cryptographically random bytes
//   exec(bin, args)     -> trimmed stdout | null (non-zero exit -> null)
//   execDetached(b, a)  -> fire and forget, never throws
//   lanAddresses()      -> array of non-internal IPv4 addresses
//   input.keyScript(s)  -> run one AppleScript program of keystrokes (input.js)
//   input.mouse(cmd)    -> post one mouse command
//   input.sleep(sec)    -> block for a fraction of a second

var g = (typeof globalThis !== 'undefined') ? globalThis : Function('return this')();

if (!g.__DIY_MAC_REMOTE_SYS__) {
  throw new Error('app/sys.js loaded without a host — start the server through ' +
                  'server.js or server.pl, not by requiring app/ directly.');
}

module.exports = g.__DIY_MAC_REMOTE_SYS__;
