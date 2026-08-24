'use strict';

// Issue #11, two halves:
//   1. Falling back to the account default did not actually reach the account
//      default: a --model pin left in the base slot kept overriding it, so a
//      retired pin failed every call.
//   2. Config preservation kept installed model pins over shipped ones, so an
//      upgrade that corrected a retired pin could never take effect.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { resolveModelArgs, applyModelArgs, modelFlagInSlot, MODEL_FLAGS } = require('../lib/model-tiers');

// ---- half 1: the fallback path --------------------------------------------

test('a retired pin in the base slot is dropped when falling back to the account default', () => {
  const entry = { args: ['chat', '--model', 'claude-3-opus-RETIRED', '--print'] };
  const r = resolveModelArgs({ entry, taskTier: 'standard' });
  assert.equal(r.source, 'account_default');
  assert.equal(r.suppressedPin, 'claude-3-opus-RETIRED');

  const argv = applyModelArgs(entry.args, r.args, entry, r.suppressArgs);
  assert.ok(!argv.includes('claude-3-opus-RETIRED'),
    'saying "the account default applies" while still sending a dead pin is the bug');
  assert.ok(!argv.includes('--model'), 'the flag must go with its value');
  assert.deepEqual(argv, ['chat', '--print'], 'everything else is untouched');
});

test('the same holds when tiers exist but none are usable', () => {
  const entry = { args: ['run', '-m', 'gpt-RETIRED'], model_tiers: { standard: [] } };
  const r = resolveModelArgs({ entry, taskTier: 'standard' });
  assert.equal(r.source, 'account_default');
  assert.match(r.note, /dropped stale pin gpt-RETIRED/);
  assert.deepEqual(applyModelArgs(entry.args, r.args, entry, r.suppressArgs), ['run']);
});

test('a configured tier still overrides the base pin normally', () => {
  const entry = { args: ['chat', '--model', 'base', '--print'], model_tiers: { standard: ['--model', 'sonnet'] } };
  const r = resolveModelArgs({ entry, taskTier: 'standard' });
  assert.equal(r.source, 'configured');
  assert.deepEqual(applyModelArgs(entry.args, r.args, entry, r.suppressArgs),
    ['chat', '--model', 'sonnet', '--print']);
});

test('a slot with no pin is left exactly as it was', () => {
  const entry = { args: ['chat', '--print'] };
  const r = resolveModelArgs({ entry, taskTier: 'standard' });
  assert.equal(r.suppressedPin, null);
  assert.deepEqual(applyModelArgs(entry.args, r.args, entry, r.suppressArgs), ['chat', '--print']);
});

test('every known model flag spelling is recognised', () => {
  for (const flag of MODEL_FLAGS) {
    const found = modelFlagInSlot({ args: ['x', flag, 'some-model'] });
    assert.equal(found.flag, flag, flag);
    assert.equal(found.value, 'some-model');
  }
  assert.equal(modelFlagInSlot({ args: ['x', '--print'] }), null);
  assert.equal(modelFlagInSlot({}), null, 'an entry with no args must not throw');
});

test('a provider-specific model flag is honoured over the generic list', () => {
  const entry = { args: ['gen', '--engine', 'old-engine'], model_flags: ['--engine'] };
  const found = modelFlagInSlot(entry);
  assert.equal(found.value, 'old-engine');
  const r = resolveModelArgs({ entry, taskTier: 'standard' });
  assert.deepEqual(applyModelArgs(entry.args, r.args, entry, r.suppressArgs), ['gen']);
});

// ---- half 2: the installer's merge policy ---------------------------------
// install.ps1 cannot run here, so assert the policy is present and that its
// escape hatches are wired — the behaviour itself is verified on Windows.

test('the installer restores shipped model pins over installed ones', () => {
  const ps = fs.readFileSync(path.join(__dirname, '..', 'install.ps1'), 'utf8');
  assert.match(ps, /function Restore-ShippedModelPins/,
    'preserving a retired pin across upgrades is the defect');
  assert.match(ps, /Restore-ShippedModelPins \$merged \$defaults \$existing/,
    'the policy must actually be invoked during the merge');
  assert.match(ps, /cli-config\.json/, 'and scoped to the config that carries pins');
});

test('an operator can keep their own pins, per entry or globally', () => {
  const ps = fs.readFileSync(path.join(__dirname, '..', 'install.ps1'), 'utf8');
  assert.match(ps, /model_tiers_locked/, 'per-entry opt-out');
  assert.match(ps, /pinsLocked/, 'global opt-out');
});

test('pin replacement is announced, never silent', () => {
  const ps = fs.readFileSync(path.join(__dirname, '..', 'install.ps1'), 'utf8');
  assert.match(ps, /replaced installed model pins with the shipped set/,
    'silently overwriting operator config would be its own bug');
});

test('an Auto-only shipped seat removes stale installed tiers unless the operator locked them', () => {
  const ps = fs.readFileSync(path.join(__dirname, '..', 'install.ps1'), 'utf8');
  assert.match(ps, /removed installed model pins because the shipped seat now requires its account default/);
  assert.match(ps, /Only a lock that existed in the operator's installed config/);
});
