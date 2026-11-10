'use strict';

// ---- pairing: one "master" key in the QR, two credentials derived from it ----
//
// The QR/link fragment carries a single high-entropy MASTER. From it we derive,
// with two domain-separated one-way hashes:
//   - the SECRET, which keys the ChaCha20/HMAC crypto, and
//   - the TOKEN, a second-layer proof.
// We keep them apart on disk: the SECRET must live there in the clear (the server
// needs it to run the crypto), but of the TOKEN we store ONLY its hash. The MASTER
// itself is NEVER written to disk — persisting it would let a disk reader
// reconstruct the token and defeat the whole layer. So a disk reader (or someone
// with a stolen backup) gets SECRET + hash(TOKEN) but not the TOKEN, and without
// the token the server rejects every command. Deriving both from one master keeps
// the fragment short enough for the fixed-size QR; it does NOT weaken the split,
// because SECRET = H1(master) reveals nothing about TOKEN = H2(master) (different
// prefixes → independent oracles), and master stays high-entropy (128 bits) so it
// can't be brute-forced against the on-disk secret. (Boundary is unchanged: this
// does NOT stop an attacker who also captures live traffic, or reads memory. See
// docs/security.md.)

var sys = require('./sys');
var sha256 = require('./sha256');
var bytes = require('./bytes');
var p = require('./pathutil');

var DIR = p.join(sys.homedir(), '.diy-mac-remote');
var SECRET_FILE = p.join(DIR, 'secret');
var TOKEN_FILE = p.join(DIR, 'token.hash');
// Sentinel: dropped once the Time Machine exclusion has been applied to DIR, so
// we never run the (potentially slow) tmutil again. Shared with gen-cert.sh,
// which honours the same stamp.
// While this file exists the paired phone may re-key once (see rekey() below). It
// is created when a pairing is minted and removed by the re-key that uses it.
var REKEY_MARKER = p.join(DIR, 'rekey.pending');
// A re-key is staged in these, then moved into place (see rekey()).
var SECRET_NEW = SECRET_FILE + '.new';
var TOKEN_NEW = TOKEN_FILE + '.new';
var TM_EXCLUDED_STAMP = p.join(DIR, '.backup-excluded');

function deriveSecret(master) { return sha256.hashHex('diy-mac-remote-secret:' + master); }
function deriveToken(master) { return sha256.hashHex('diy-mac-remote-authtoken:' + master); }
function hashToken(token) { return sha256.hash('diy-mac-remote-token:' + token); }

// Read one of our credential files. sys.readOwnedText refuses anything we don't
// own outright — the same stance ssh takes on private keys. Beyond keeping the
// secret from leaking to other local users, this guards a niche injection: a
// rogue process that can *create* a file but can't overwrite ours or change its
// permissions still can't hand us a secret it knows, because a file/dir it
// created is owned by a different user (or left group/other-accessible), and we
// reject that. The containing directory is checked too: a foreign-owned or
// group-writable directory would let another user swap the file underneath us.
function readCredential(file) {
  try {
    return sys.readOwnedText(file, DIR);
  } catch (err) {
    throw new Error(err.message + ' Refusing to use it — inspect and remove ' +
                    DIR + ', then restart to regenerate.');
  }
}

function isHex64(s) { return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s); }

// Finish — or throw away — a re-key that a crash cut short.
//
// rekey() writes the new token hash, then the new secret, and only then starts
// moving them over the live files. So if secret.new is there and valid, BOTH new
// files were complete and the right move is forward: finish the moves and use up
// the marker. Anything less is a re-key that never got as far as changing
// anything, and its partial files are simply deleted — the old pairing is intact.
function recoverRekey() {
  var haveSecret = sys.exists(SECRET_NEW);
  var haveToken = sys.exists(TOKEN_NEW);
  if (!haveSecret && !haveToken) return;
  var secret = haveSecret ? readCredential(SECRET_NEW) : null;
  var token = haveToken ? readCredential(TOKEN_NEW) : null;
  if (isHex64(secret) && (!haveToken || isHex64(token))) {
    if (haveToken) sys.renameReplace(TOKEN_NEW, TOKEN_FILE);
    sys.removeFile(REKEY_MARKER);
    sys.renameReplace(SECRET_NEW, SECRET_FILE);
    sys.log('Finished a pairing re-key that was interrupted.');
  } else {
    sys.removeFile(TOKEN_NEW);
    sys.removeFile(SECRET_NEW);
  }
}

function loadStored() {
  recoverRekey();
  var secret = readCredential(SECRET_FILE);
  var hex = readCredential(TOKEN_FILE);
  return { secret: secret, tokenHash: hex ? bytes.fromHex(hex) : null };
}

// Ensure DIR is excluded from Time Machine — exactly once, ever. Everything in
// it is key material (secret, token.hash, key.pem, ca-key.pem) and owner-only
// perms mean nothing on a mounted backup: whoever restores it reads it all. The
// sticky (xattr) form of `tmutil addexclusion` needs no sudo and persists on the
// directory, so it only needs setting once — but tmutil itself can block 10s+ when
// Time Machine is busy, so we must not run it on every start. We record success
// with a stamp file, written ONLY after tmutil returns, and skip the whole thing
// whenever the stamp exists. A failed/interrupted run leaves no stamp and simply
// retries next time. Best-effort and macOS-only; a failure must never stop the
// server. (Trade-off: excluded means not restored — after a disk restore the
// server mints a fresh pairing.)
//
//   sync:true  — block until tmutil returns, then stamp. Used inside mint(), right
//                after the dir is created and BEFORE the secret/token hash are
//                written, so cleartext key material never lands in a not-yet-
//                excluded directory.
//   sync:false — fire-and-forget. Used at startup for installs predating the
//                stamp: re-affirm once without stalling a normal restart. Nobody
//                is waiting for the result, so nothing gets stamped either and
//                the (harmless, detached) re-affirm happens on each start until
//                a mint stamps it.
function ensureBackupExclusion(opts) {
  var sync = !!(opts && opts.sync);
  if (sys.platform !== 'darwin') return;
  if (sys.exists(TM_EXCLUDED_STAMP)) return; // already done once — never repeat
  try {
    if (sync) {
      if (sys.exec('tmutil', ['addexclusion', DIR]) !== null) {
        sys.writePrivateText(TM_EXCLUDED_STAMP, ''); // only after tmutil succeeded
      }
    } else {
      sys.execDetached('tmutil', ['addexclusion', DIR]);
    }
  } catch (e) { /* best effort, never fatal */ }
}

// Mint a fresh pairing: generate a master, derive + store the secret and the
// token HASH (owner-only), and DISCARD the master — returning it only so we can
// print the pairing QR this one time. The master never touches disk.
function mint() {
  if (sys.exists(DIR)) {
    // The directory is about to receive fresh key material, so it has to be
    // ours and ours alone — the same check readCredential makes, which a
    // --reset-token run would otherwise skip by never reading anything.
    try {
      sys.assertOwnerOnly(DIR);
    } catch (err) {
      throw new Error(err.message + ' Refusing to write a new pairing into it — ' +
                      'inspect and remove ' + DIR + ', then start again.');
    }
  } else {
    sys.mkdirPrivate(DIR);
  }
  // Exclude the (empty) dir from backups BEFORE the secret/token hash land in it,
  // so a Time Machine snapshot can never capture them in cleartext. Synchronous
  // on purpose — the writes below must not race ahead of the exclusion.
  ensureBackupExclusion({ sync: true });
  // 128-bit, URL-safe, 22 chars: short enough for the fixed-size QR, far beyond
  // brute force.
  var master = bytes.b64ToUrl(sys.randomBase64(16));
  // Whatever an earlier re-key left half-done belongs to the pairing being
  // replaced. The marker goes in first: with it but no secret, the worst case is
  // a pairing that is minted again.
  sys.removeFile(SECRET_NEW);
  sys.removeFile(TOKEN_NEW);
  sys.writePrivateText(REKEY_MARKER, '');
  var secret = deriveSecret(master);
  var tokenHash = hashToken(deriveToken(master));
  sys.writePrivateText(SECRET_FILE, secret + '\n');
  sys.writePrivateText(TOKEN_FILE, bytes.toHex(tokenHash) + '\n');
  return { master: master, secret: secret, tokenHash: tokenHash };
}

// Constant-time check of a client-supplied token against the stored hash.
function tokenOk(candidate, tokenHash) {
  if (typeof candidate !== 'string' || !candidate) return false;
  return bytes.equal(hashToken(candidate), tokenHash);
}

// Replace the credentials, once, at the phone's request.
//
// The master in the QR (and so in the link the Home Screen app was saved from,
// and in Safari's history) is only ever meant to get the phone started. The first
// time the Home Screen app opens it makes a secret and a token of its own and
// sends them here — the secret, and the HASH of the token, the two things this
// server keeps — and from then on the master derives credentials that no longer
// match anything. The marker is what makes that a one-time offer: it is created
// with the pairing and consumed by the re-key, so a phone that already re-keyed
// can't be used to re-key again, and a stolen copy of the master that beats the
// phone to it leaves the phone refused, loudly, instead of silently locked out.
//
// Errors carry rekeyStatus, the HTTP status to answer with.
function rekeyError(status, message) {
  var err = new Error(message);
  err.rekeyStatus = status;
  return err;
}

function rekey(secretHex, tokenHashHex) {
  if (!isHex64(secretHex) || !isHex64(tokenHashHex)) {
    throw rekeyError(400, 'rekey needs a 64-hex secret and token hash');
  }
  if (!sys.exists(REKEY_MARKER)) throw rekeyError(409, 'this pairing has already been re-keyed');
  sys.assertOwnerOnly(DIR);
  // Stage both, token first and secret last (recoverRekey relies on that order),
  // then move them over the live files, using up the marker before the last move.
  sys.writePrivateText(TOKEN_NEW, tokenHashHex + '\n');
  sys.writePrivateText(SECRET_NEW, secretHex + '\n');
  sys.renameReplace(TOKEN_NEW, TOKEN_FILE);
  sys.removeFile(REKEY_MARKER);
  sys.renameReplace(SECRET_NEW, SECRET_FILE);
  return { secret: secretHex, tokenHash: bytes.fromHex(tokenHashHex) };
}

module.exports = {
  rekey: rekey,
  DIR: DIR,
  SECRET_FILE: SECRET_FILE,
  TOKEN_FILE: TOKEN_FILE,
  deriveSecret: deriveSecret,
  deriveToken: deriveToken,
  hashToken: hashToken,
  loadStored: loadStored,
  mint: mint,
  tokenOk: tokenOk,
  ensureBackupExclusion: ensureBackupExclusion,
};
