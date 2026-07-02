'use strict';
// Entry point: load every *.test.js in this directory (each registers its cases
// with the shared harness), then run them. Exit non-zero if any fail.
//   node test/run.js      (or: npm test)
const fs = require('fs');
const path = require('path');
const { run } = require('./harness');

for (const f of fs.readdirSync(__dirname).sort()) {
  if (f.endsWith('.test.js')) require(path.join(__dirname, f));
}

run().then((failures) => process.exit(failures ? 1 : 0));
