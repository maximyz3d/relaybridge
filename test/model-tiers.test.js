'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { resolveModelArgs, applyModelArgs, modelConfigStaleness, modelTierForTaskTier } = require('../lib/model-tiers');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cli-config.json'), 'utf8'));

test('task tiers map to sensible model weight classes', () => {
  assert.equal(modelTierForTaskTier('utility'), 'light');
  assert.equal(modelTierForTaskTier('standard'), 'standard');
  assert.equal(modelTierForTaskTier('complex'), 'heavy');
  assert.equal(modelTierForTaskTier('critical'), 'heavy');
  assert.equal(modelTierForTaskTier('nonsense'), 'standard', 'unknown tiers must not fail the call');
});

test('a cheap lookup and a hard task get different models from the same CLI', () => {
  const cheap = resolveModelArgs({ entry: config.claude, taskTier: 'utility' });
  const hard = resolveModelArgs({ entry: config.claude, taskTier: 'complex' });
  assert.equal(cheap.model, 'haiku');
  assert.equal(hard.model, 'opus');
  assert.notDeepEqual(cheap.args, hard.args);
});

test('Claude pins use stable aliases rather than versioned identifiers', () => {
  // Versioned ids rot on release; aliases keep working.
  for (const tier of ['light', 'standard', 'heavy']) {
    const model = config.claude.model_tiers[tier].model;
    assert.match(model, /^(haiku|sonnet|opus)$/, `claude ${tier} should be an alias, got ${model}`);
  }
});

test('providers with account-dependent lineups send no model flag', () => {
  // A missing flag runs on whatever the account has; a wrong one fails the call.
  for (const kind of ['copilot', 'grok']) {
    const resolved = resolveModelArgs({ entry: config[kind], taskTier: 'complex' });
    assert.deepEqual(resolved.args, [], `${kind} should defer to the account default`);
    assert.equal(resolved.source, 'account_default');
  }
});

test('a provider missing the requested tier falls back instead of failing', () => {
  const entry = { model_tiers: { standard: { args: ['--model', 'mid'], model: 'mid' } } };
  const heavy = resolveModelArgs({ entry, taskTier: 'complex' });
  assert.equal(heavy.model, 'mid');
  assert.equal(heavy.source, 'fallback');
});

test('model args are injected after a subcommand and before the prompt', () => {
  const slot = applyModelArgs(['agent', '-p', '--mode', 'ask', '{prompt}'], ['--model', 'x'], {});
  assert.deepEqual(slot, ['agent', '--model', 'x', '-p', '--mode', 'ask', '{prompt}']);
  assert.equal(slot[slot.length - 1], '{prompt}', 'the prompt placeholder must stay last');
});

test('a routed tier replaces a model already pinned in the slot', () => {
  const slot = applyModelArgs(['--model', 'already', '{prompt}'], ['--model', 'other'], {});
  assert.deepEqual(slot, ['--model', 'other', '{prompt}'], 'the routed tier replaces a pinned default instead of being silently dropped');
});

test('no model args leaves the slot untouched', () => {
  const slot = applyModelArgs(['-p', '{prompt}'], [], {});
  assert.deepEqual(slot, ['-p', '{prompt}']);
});

test('stale model pins are reported rather than trusted silently', () => {
  const fresh = modelConfigStaleness({ modelsCheckedAt: '2026-08-01', staleAfterDays: 45 }, Date.parse('2026-08-14'));
  assert.equal(fresh.stale, false);
  const old = modelConfigStaleness({ modelsCheckedAt: '2026-01-01', staleAfterDays: 45 }, Date.parse('2026-08-14'));
  assert.equal(old.stale, true);
  assert.match(old.message, /re-check/);
  const unknown = modelConfigStaleness({}, Date.now());
  assert.equal(unknown.stale, true, 'an unverified config is stale by definition');
});

test('shipped config carries a verification date and per-CLI check commands', () => {
  assert.ok(config._models.modelsCheckedAt, 'model pins need a checked date');
  assert.ok(config._models.verifyCommands.codex, 'codex ids rot fastest and need a check command');
});
