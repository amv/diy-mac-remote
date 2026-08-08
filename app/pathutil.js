'use strict';

// Just enough of node:path to get by, because the JXA host has no node:path.
// POSIX only — the only OS this ever runs on is macOS.

// Collapse '.', '..' and duplicate separators. Leading '..' segments on a
// relative path are kept (there is nothing above to resolve them against);
// on an absolute path they are dropped, exactly as the filesystem would.
function normalize(p) {
  var absolute = p.charAt(0) === '/';
  var parts = p.split('/');
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var seg = parts[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(seg);
  }
  var joined = out.join('/');
  if (absolute) return '/' + joined;
  return joined === '' ? '.' : joined;
}

function join() {
  var parts = [];
  for (var i = 0; i < arguments.length; i++) {
    var a = String(arguments[i]);
    if (a !== '') parts.push(a);
  }
  if (parts.length === 0) return '.';
  return normalize(parts.join('/'));
}

function dirname(p) {
  var i = p.lastIndexOf('/');
  if (i < 0) return '.';
  if (i === 0) return '/';
  return p.slice(0, i);
}

function basename(p) {
  var i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

// '.png' for 'icon.png', '' when there is no extension. A leading dot is a
// hidden file, not an extension.
function extname(p) {
  var base = basename(p);
  var i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}

module.exports = { normalize: normalize, join: join, dirname: dirname, basename: basename, extname: extname };
