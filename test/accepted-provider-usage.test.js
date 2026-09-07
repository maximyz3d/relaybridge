'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = source.indexOf('function acceptedProviderUsage(');
const end = source.indexOf('function acceptedTerminalQuotaEvidence(', start);
assert.ok(start >= 0 && end > start);
const acceptedProviderUsage = vm.runInNewContext(source.slice(start, end) + '\nacceptedProviderUsage');

test('close and disconnect accounting share accepted usage without inventing terminal provenance', () => {
  const newer = { input_tokens: 600, output_tokens: 600, total_tokens: 1200, turns: 2 };
  const usage = acceptedProviderUsage({ usage: null }, newer);
  assert.equal(usage.total_tokens, 1200);
  assert.equal(usage.token_source, 'provider_reported');
  assert.equal(usage.model_usage.length, 0);
  assert.equal(acceptedProviderUsage({ usage: null }, null), null);
  const terminal = { total_tokens: 1400, model_usage: [{ model: 'fixture' }] };
  assert.equal(acceptedProviderUsage({ usage: terminal }, newer), terminal);
  assert.match(source, /usage: acceptedProviderUsage\(parsedOutput, progress\.providerUsage\)/);
  assert.match(source, /const authoritativeUsage = acceptedProviderUsage\(parsedOutput, supervisedUsage\)/);
});
