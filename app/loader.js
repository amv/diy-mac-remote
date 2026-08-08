'use strict';

// A require() for JavaScriptCore.
//
// `osascript -l JavaScript` runs one script. There is no module system, no
// __dirname, no way to split a program across files — and this program is a
// server. So the JXA host builds one: read the file, hand it to
// new Function('exports', 'require', 'module', ...), cache the result by
// absolute path. That is the whole of CommonJS that matters here, and it is
// enough for every module under app/ to be loadable unchanged by both
// JavaScriptCore and Node.
//
// All filesystem access is injected, which keeps this file free of ObjC — the
// JXA host passes Foundation-backed readers, and test/loader.test.js passes
// node:fs ones to exercise exactly this code on a machine with no osascript.

// io: { readText(path) -> string|null, exists(path) -> boolean, path: pathutil }
function createLoader(io) {
  var cache = {};

  // Resolve a specifier against the directory of the module doing the
  // requiring. Only relative paths are supported — app/ has no dependencies and
  // never will, which is what makes a loader this small enough.
  function resolve(fromDir, spec) {
    if (spec.charAt(0) !== '.') {
      throw new Error('require("' + spec + '"): only relative paths are supported here');
    }
    var base = io.path.join(fromDir, spec);
    var candidates = [base, base + '.js', io.path.join(base, 'index.js')];
    for (var i = 0; i < candidates.length; i++) {
      if (io.exists(candidates[i])) return candidates[i];
    }
    throw new Error('require("' + spec + '") from ' + fromDir + ': not found');
  }

  function load(file) {
    if (cache[file]) return cache[file].exports;

    var src = io.readText(file);
    if (src === null) throw new Error('cannot read module ' + file);

    var module = { exports: {} };
    // Cache before evaluating, so a cycle sees a partial exports object rather
    // than looping forever. (app/ has no cycles; this is cheap insurance.)
    cache[file] = module;

    var dir = io.path.dirname(file);
    var fn;
    try {
      fn = new Function('exports', 'require', 'module', '__filename', '__dirname', src);
    } catch (err) {
      delete cache[file];
      throw new Error('syntax error in ' + file + ': ' + err.message);
    }
    try {
      fn(module.exports, requireFrom(dir), module, file, dir);
    } catch (err) {
      delete cache[file];
      throw err;
    }
    return module.exports;
  }

  function requireFrom(dir) {
    return function (spec) { return load(resolve(dir, spec)); };
  }

  // Seed the cache with a module the host had to evaluate before this loader
  // existed, so requiring it later returns the same object rather than a copy.
  function define(file, exports) {
    cache[file] = { exports: exports };
  }

  return { requireFrom: requireFrom, load: load, define: define, cache: cache };
}

module.exports = { createLoader: createLoader };
