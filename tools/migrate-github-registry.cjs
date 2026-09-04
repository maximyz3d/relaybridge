#!/usr/bin/env node
'use strict';

// Small installer/startup-compatible entrypoint around the same migration code
// used by the live tracker. Paths are argv elements, never shell fragments.
const path = require('path');
const tracker = require('../lib/github-tracker');

function fail(message) {
  process.stderr.write(`[RelayBridge] ${message}\n`);
  process.exitCode = 1;
}

const args = process.argv.slice(2);
const options = {};
let validate = false;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--validate') {
    validate = true;
    continue;
  }
  if (arg === '--root' || arg === '--legacy-file' || arg === '--runtime-file') {
    if (!args[i + 1]) {
      fail(`${arg} requires a path`);
      return;
    }
    const value = args[++i];
    if (arg === '--root') options.root = path.resolve(value);
    if (arg === '--legacy-file') options.legacyFile = value;
    if (arg === '--runtime-file') options.runtimeFile = value;
    continue;
  }
  fail(`unknown argument: ${arg}`);
  return;
}

try {
  const result = tracker.migrateLegacyRegistry(options);
  if (validate) tracker.loadRegistry(undefined, options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (err) {
  fail(err.message);
}
