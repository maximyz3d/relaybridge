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

// The bug these cover: a caller asked for the strongest level a model offers and
// got a weaker one, or an outright refusal, with nothing on the wire saying so.
const CODEX_SLOT = ['codex', 'exec', '--sandbox', 'read-only', '-'];
const codexEntry = (overrides = {}) => ({
  effort_flags: Object.fromEntries(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    .map((level) => [level, ['--config', `model_reasoning_effort=${level}`]])),
  // ultra is gated per model: the level exists, but not on every model.
  effort_model_allowlist: { ultra: ['gpt-6-astra', 'gpt-6-sol'] },
  ...overrides,
});
const sentEffort = (result) => (result.slot || [])
  .find((arg) => String(arg).startsWith('model_reasoning_effort=')) || null;

test('a declared ultra level reaches the CLI as ultra', () => {
  const result = applyProviderEffort({ slot: CODEX_SLOT, entry: codexEntry(),
    modelChoice: { model: 'gpt-6-astra' }, requestedEffort: 'ultra',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] });
  assert.equal(result.error, undefined);
  assert.equal(result.appliedEffort, 'ultra');
  assert.equal(sentEffort(result), 'model_reasoning_effort=ultra');
  assert.equal(result.effortFallbackReason, undefined, 'nothing was substituted');
});

test('max is sent as max, not quietly rewritten to xhigh', () => {
  const result = applyProviderEffort({ slot: CODEX_SLOT, entry: codexEntry(),
    modelChoice: { model: 'gpt-6-astra' }, requestedEffort: 'max',
    supportedEfforts: ['high', 'xhigh', 'max', 'ultra'] });
  assert.equal(result.appliedEffort, 'max');
  assert.equal(sentEffort(result), 'model_reasoning_effort=max');
});

test('a config row weaker than the catalog allows is reported, not silent', () => {
  // This is the shape that shipped: max mapped to xhigh, and every max request
  // was answered one rung short with no record of it.
  const entry = codexEntry({ effort_flags: { ...codexEntry().effort_flags,
    max: ['--config', 'model_reasoning_effort=xhigh'] } });
  const result = applyProviderEffort({ slot: CODEX_SLOT, entry,
    modelChoice: { model: 'gpt-6-astra' }, requestedEffort: 'max',
    supportedEfforts: ['high', 'xhigh', 'max', 'ultra'] });
  assert.equal(result.appliedEffort, 'xhigh');
  assert.match(result.effortFallbackReason, /catalog lists max/);
});

test('a level the model does not offer steps down instead of failing', () => {
  const result = applyProviderEffort({ slot: CODEX_SLOT, entry: codexEntry(),
    modelChoice: { model: 'gpt-6-luna' }, requestedEffort: 'ultra',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
  assert.equal(result.error, undefined);
  assert.equal(result.appliedEffort, 'max', 'the strongest level luna does accept');
  assert.match(result.effortFallbackReason, /gpt-6-luna does not accept effort=ultra/);
});

test('a provider whose ceiling is max never receives ultra as a flag', () => {
  // Claude Code accepts --effort low..max. Handing it ultra fails the call.
  const result = applyProviderEffort({ slot: ['claude', '-p', '--effort', 'max'],
    entry: {}, modelChoice: { model: 'opus' }, requestedEffort: 'ultra',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
  assert.equal(result.error, undefined);
  assert.equal(result.appliedEffort, 'max');
  assert.ok(!result.slot.includes('ultra'), 'ultra must not reach a CLI that rejects it');
  assert.match(result.effortFallbackReason, /does not accept effort=ultra/);
});

test('with no catalog evidence, effort resolution is unchanged', () => {
  const declared = applyProviderEffort({ slot: CODEX_SLOT, entry: codexEntry(),
    modelChoice: { model: 'gpt-6-astra' }, requestedEffort: 'ultra' });
  assert.equal(declared.appliedEffort, 'ultra', 'an explicit effort_flags row still stands alone');

  const undeclared = applyProviderEffort({ slot: CODEX_SLOT,
    entry: codexEntry({ effort_flags: { high: ['--config', 'model_reasoning_effort=high'] } }),
    modelChoice: { model: 'gpt-6-astra' }, requestedEffort: 'ultra' });
  // The exact wording differs by provider gate; what matters is that an
  // undeclared level is refused rather than quietly turned into something else.
  assert.ok(undeclared.error, 'an undeclared level must not resolve');
  assert.match(undeclared.error, /ultra/);
});
