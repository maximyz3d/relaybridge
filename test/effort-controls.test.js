'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseReasoningEffortAssignment, applyProviderEffort } = require('../lib/effort-controls');
const { validateProviderBudget } = require('../lib/provider-budget');
const { normalizeGenericValidation } = require('../lib/validation-contract');

test('effort assignment uses bounded key/value parsing and retains declared controls', () => {
  for (const value of ['model_reasoning_effort=high', ' MODEL_REASONING_EFFORT = "HIGH" ', "model_reasoning_effort = 'high'"]) {
    assert.deepEqual(parseReasoningEffortAssignment(value), { key: 'model_reasoning_effort', effort: 'high' });
  }
  for (const value of [null, {}, 'x=high', 'reasoning_effort=high=x', 'reasoning_effort="high', 'reasoning_effort=' + ' '.repeat(100000) + 'x\nX']) {
    assert.equal(parseReasoningEffortAssignment(value), null);
  }
  const resolved = applyProviderEffort({ slot: ['cli', '-c', 'model_reasoning_effort=medium', '-'], requestedEffort: 'xhigh' });
  assert.deepEqual(resolved.slot, ['cli', '-c', 'model_reasoning_effort=xhigh', '-']);
  assert.equal(resolved.appliedEffort, 'xhigh');
});

test('null budget envelope is omission; individual null ceilings remain explicit unlimited', () => {
  assert.equal(validateProviderBudget(null), undefined);
  assert.equal(validateProviderBudget(undefined), undefined);
  assert.deepEqual(validateProviderBudget({ maxTurns: null }), { maxTurns: null });
  for (const budget of [false, [], 1, { maxTurns: 0 }, { maxTurns: '1' }, { unexpected: null }]) {
    assert.throws(() => validateProviderBudget(budget));
  }
});

test('generic validation preserves bounded typed metadata, never arbitrary exception properties', () => {
  const value = normalizeGenericValidation({ code: 'prompt_too_large', field: 'prompt', reason: 'Too long',
    retryable: false, inputChars: 24001, maxChars: 24000, inputHash: 'a'.repeat(64), inputTruncated: false,
    transport: 'argument', prompt: 'secret', path: '/private', stack: 'secret stack' });
  assert.deepEqual(Object.keys(value).sort(), ['code', 'field', 'reason', 'retryable', 'inputChars', 'maxChars', 'inputHash', 'inputTruncated', 'transport'].sort());
  assert.equal(normalizeGenericValidation({ code: '../bad', field: 'prompt', reason: 'bad' }), null);
});
