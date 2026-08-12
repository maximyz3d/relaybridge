#!/usr/bin/env node
'use strict';

const fs = require('fs');

if (process.argv.includes('--version')) {
  process.stdout.write('prompt-file-cli 1.0.0\n');
  process.exit(0);
}

const fileIndex = process.argv.indexOf('--prompt-file');
if (fileIndex < 0 || !process.argv[fileIndex + 1]) {
  process.stderr.write('missing --prompt-file\n');
  process.exit(2);
}

const prompt = fs.readFileSync(process.argv[fileIndex + 1], 'utf8');
const delayIndex = process.argv.indexOf('--delay');
const delayMs = delayIndex >= 0 ? Math.max(0, Number(process.argv[delayIndex + 1] || 0)) : 0;

setTimeout(() => {
  const exitIndex = process.argv.indexOf('--exit');
  if (exitIndex >= 0) {
    process.stderr.write('requested failure after reading ' + prompt.length + ' characters\n');
    process.exit(Number(process.argv[exitIndex + 1] || 1));
  }
  if (process.argv.includes('--empty')) return;
  const envIndex = process.argv.indexOf('--print-env');
  if (envIndex >= 0) {
    process.stdout.write(String(process.env[process.argv[envIndex + 1]] || ''));
    return;
  }
  const outputIndex = process.argv.indexOf('--output');
  process.stdout.write(outputIndex >= 0 ? String(process.argv[outputIndex + 1] || '') : prompt);
}, delayMs);
