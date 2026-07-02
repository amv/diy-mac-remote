'use strict';
// A tiny zero-dependency test harness — no framework, no npm, just node:assert
// and a sequential runner, so the tests are as auditable as the rest of the repo.
// Tests register with test(name, fn); fn may be async. run() executes them in
// order (some spawn a server and bind a port, so they must not overlap).
const assert = require('assert');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function run() {
  let pass = 0, fail = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log('  ok   ' + t.name);
      pass++;
    } catch (err) {
      const msg = (err && err.stack) || String(err);
      console.log('  FAIL ' + t.name + '\n       ' + msg.split('\n').join('\n       '));
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  return fail;
}

module.exports = { test, run, assert };
