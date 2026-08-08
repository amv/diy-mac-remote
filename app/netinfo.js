'use strict';

// Working out which address to put in the pairing QR.
//
// This is only ever consulted on a pairing run — the address chosen here is
// baked into the QR and the phone keeps it for good, so this is where
// strictness belongs. On a normal restart nothing in this file runs: the paired
// Home Screen app already holds the address it was paired with.

var sys = require('./sys');

// The Bonjour/mDNS hostname (e.g. "mac-air.local"). This is the LocalHostName
// (`scutil --get LocalHostName`) — the name mDNS actually answers to. We do NOT
// fall back to the kernel hostname: that one is set dynamically from
// DHCP/reverse-DNS or the ComputerName, so it can be wrong (e.g. "MacbookAir")
// or not even a valid .local label (e.g. "Mac Air"). If scutil has no answer
// (non-macOS, or the early-boot window before LocalHostName is set), return null
// and let the caller fall back to a LAN IP instead.
function localHostname() {
  if (sys.platform !== 'darwin') return null;
  var name = sys.exec('scutil', ['--get', 'LocalHostName']);
  return name ? name + '.local' : null;
}

// This node's MagicDNS name on the tailnet, read straight from the Tailscale
// daemon — the authoritative source, decoupled from the OS hostname. Returns
// Self.DNSName (which always resolves via MagicDNS regardless of the device's
// search domains), else the short HostName, else null when Tailscale isn't
// installed/running or no tailnet is up.
function tailscaleSelf() {
  var bins = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  for (var i = 0; i < bins.length; i++) {
    var out = sys.exec(bins[i], ['status', '--json']);
    if (!out) continue;
    try {
      var status = JSON.parse(out);
      // When Tailscale is switched off the daemon still reports Self, so skip it
      // unless the tailnet is actually up.
      if (status.BackendState === 'Stopped') continue;
      var self = status.Self || {};
      // Strip the trailing dot from the FQDN.
      var name = self.DNSName ? self.DNSName.replace(/\.$/, '') : (self.HostName || null);
      if (!name) continue;
      return name;
    } catch (e) { /* not JSON — try the next binary */ }
  }
  return null;
}

// Does the served certificate vouch for this host? Always true over plain HTTP
// (there is no certificate to disagree with), which is also the answer when the
// entrypoint couldn't parse its own certificate — inventing warnings from a
// failed parse helps nobody, and TLS itself still works.
//
// `certHosts` is what the Node entrypoint read out of the certificate's
// subjectAltName: { dns: [...], ip: [...] }, or null for no TLS. The Perl
// entrypoint has no TLS at all and always sends null.
function certCovers(host, certHosts) {
  if (!certHosts) return true;
  var h = String(host).toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return (certHosts.ip || []).indexOf(h) >= 0;
  var dns = certHosts.dns || [];
  for (var i = 0; i < dns.length; i++) {
    var name = String(dns[i]).toLowerCase();
    if (name === h) return true;
    // A wildcard covers exactly one label: *.example.com matches a.example.com
    // but not a.b.example.com, and never example.com itself.
    if (name.indexOf('*.') === 0) {
      var dot = h.indexOf('.');
      if (dot > 0 && h.slice(dot + 1) === name.slice(2)) return true;
    }
  }
  return false;
}

// Docker's default bridge networks live in 172.16.0.0/12 (docker0 is usually
// 172.17.0.1, compose networks 172.18+). These are almost never the address the
// phone should reach, so we sort them to the back rather than dropping them.
function isDockerIp(ip) {
  var m = /^172\.(\d+)\./.exec(ip);
  return m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

function lanAddresses() {
  var out = sys.lanAddresses();
  return out.slice().sort(function (a, b) { return (isDockerIp(a) ? 1 : 0) - (isDockerIp(b) ? 1 : 0); });
}

// Thrown when the requested mode cannot produce an address. Minting is not free
// to undo — it overwrites the stored pairing and discards the only copy of the
// master — so the caller resolves the address BEFORE minting and refuses here.
function RefusalError(message) {
  var err = new Error(message);
  err.refusal = true;
  return err;
}

// Resolve the address to advertise into { url, kind, ips }, where kind is one of
// 'custom' | 'tailscale' | 'local' | 'ip' | 'none' (used to tailor the pairing
// banner and its warnings). `ips` is the list of auto-detected LAN IPv4
// addresses, only set for kind 'ip'. For 'none' there's no address to advertise.
//   tailscale -> MagicDNS name
//   wifi      -> .local mDNS name
//   detect    -> MagicDNS name if a tailnet is up, else the .local name
// Hostname modes fall back to auto-detected LAN IP(s), never to localhost (the
// phone can't reach that).
function resolveBase(opts) {
  if (opts.overrideUrl) return { url: opts.overrideUrl, kind: 'custom' };

  var host = null;
  var kind = null;
  if (opts.mode === 'tailscale') {
    host = tailscaleSelf();
    if (!host) {
      // Asked to pair over the tailnet with no tailnet to pair over. Quietly
      // pairing to a LAN address instead would hand the phone an address it
      // keeps forever and a transport the user didn't choose, so stop.
      throw RefusalError(
        'Tailscale mode: no tailnet detected (is Tailscale running and\n' +
        '   signed in on this Mac?). Refusing to pair against a LAN address\n' +
        '   you did not ask for — the phone would keep it. Start Tailscale and\n' +
        '   try again, or pair on your Wi-Fi with:  ./start.sh wifi');
    }
    kind = 'tailscale';
  } else if (opts.mode === 'wifi') {
    host = localHostname();
    if (host) kind = 'local';
  } else { // detect
    var ts = tailscaleSelf();
    var local = localHostname();
    // Prefer the tailnet when one is up — unless we're serving HTTPS with a
    // certificate that vouches for the .local name but not the MagicDNS name
    // (gen-cert.sh's default): a QR the phone refuses helps nobody, so pick
    // the name the certificate actually covers.
    var preferLocal = ts && local && !certCovers(ts, opts.certHosts) && certCovers(local, opts.certHosts);
    if (ts && !preferLocal) { host = ts; kind = 'tailscale'; }
    else if (local) { host = local; kind = 'local'; }
  }

  if (host) return { url: opts.scheme + '://' + host + ':' + opts.port + '/', kind: kind };

  // No hostname: fall back to auto-detected LAN IPv4 address(es).
  var ips = lanAddresses();
  if (ips.length) return { url: opts.scheme + '://' + ips[0] + ':' + opts.port + '/', kind: 'ip', ips: ips };
  return { url: null, kind: 'none' };
}

module.exports = {
  localHostname: localHostname,
  tailscaleSelf: tailscaleSelf,
  certCovers: certCovers,
  lanAddresses: lanAddresses,
  resolveBase: resolveBase,
};
