#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { prepareBuildInfo } = require('../lib/build-identity.cjs');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
try {
  const prepared = prepareBuildInfo(root);
  process.stdout.write(`${prepared.identity.buildId}\n`);
} catch (error) {
  process.stderr.write(`[RelayBridge] build identity preparation failed: ${String(error?.message || error).slice(0, 1000)}\n`);
  process.exitCode = 1;
}
