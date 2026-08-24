'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { providerUsageCapability, providerUsageCapabilities } = require('../lib/provider-usage-capability');

test('missing provider telemetry stays unknown rather than becoming an estimate', () => {
  assert.equal(providerUsageCapability({}), null);
});

test('Antigravity unavailable telemetry fails closed with no character fallback', () => {
  const capability = providerUsageCapability({ usage_capability: {
    tokens: 'unavailable', turns: 'unavailable', verified_runtime_version: '1.1.19',
    evidence: 'agy help has message formats but no usage fields',
  } }, { runtimeVersion: '1.1.19' });
  assert.deepEqual(capability, {
    authoritative: false,
    tokens: 'unavailable',
    turns: 'unavailable',
    tokenBudgetEnforceable: false,
    turnBudgetEnforceable: false,
    budgetEnforcement: 'unenforceable',
    characterEstimateFallback: false,
    verifiedRuntimeVersion: '1.1.19',
    currentRuntimeVersion: '1.1.19',
    evidenceCurrent: true,
    evidence: 'agy help has message formats but no usage fields',
  });
});

test('runtime drift is disclosed without pretending a new version is enforceable', () => {
  const capabilities = providerUsageCapabilities({
    gemini: { usage_capability: { tokens: 'unavailable', turns: 'unavailable', verified_runtime_version: '1.1.19' } },
    other: {},
  }, { gemini: '1.2.0' });
  assert.equal(capabilities.gemini.evidenceCurrent, false);
  assert.equal(capabilities.gemini.budgetEnforcement, 'unenforceable');
  assert.equal(capabilities.other, undefined);
});
