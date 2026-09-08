'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveProviderControls } = require('../lib/execution-contract');

const gemini = { oneshot_safe: ['agy', '--model', 'gemini-pro-high', '--effort', 'high', '--print', '{prompt}'],
  model_tiers: { standard: { model: 'gemini-flash-medium', args: ['--model', 'gemini-flash-medium'],
    suppress_args: [{ flag: '--effort', value_count: 1 }] }, heavy: { model: 'gemini-pro-high', args: ['--model', 'gemini-pro-high'],
    suppress_args: [{ flag: '--effort', value_count: 1 }] } } };
const catalog = (...ids) => ({ providers: { gemini: { probed: true, models: ids.map((id) => ({ id })) } } });
const resolveGemini = (args = {}) => resolveProviderControls({ kind: 'gemini', entry: gemini, slot: gemini.oneshot_safe,
  taskTier: 'standard', registry: catalog('gemini-flash-medium', 'gemini-flash-high', 'gemini-pro-high'), ...args });

test('inferred and explicit effort variants preserve exact Gemini model from plan through replay', () => {
  const plan = resolveGemini({ phase: 'plan', effort: 'high' });
  assert.equal(plan.execution.model, 'gemini-flash-high');
  assert.equal(plan.execution.resolvedModelTier, 'standard');
  assert.equal(plan.execution.appliedEffort, 'high');
  assert.equal(plan.slot.includes('--effort'), false);
  const replay = resolveGemini({ execution: plan.execution, model: plan.execution.model });
  assert.deepEqual(replay.execution, plan.execution);
  assert.deepEqual(replay.slot, plan.slot);
});

test('explicit exact model is never swapped to satisfy contradictory effort', () => {
  assert.throws(() => resolveGemini({ model: 'gemini-flash-medium', effort: 'high' }), { code: 'unsupported_effort' });
  assert.throws(() => resolveGemini({ model: 'invented-model' }), { code: 'model_unavailable' });
  assert.throws(() => resolveGemini({ model: 'gemini-flash-medium', registry: catalog('gemini-pro-high') }), { code: 'model_unavailable' });
  const positiveConfigured = resolveGemini({ registry: { providers: { gemini: { probed: false, error: 'failed', models: [] } } } });
  assert.equal(positiveConfigured.execution.model, 'gemini-flash-medium');
});

test('tuple rejects configuration, authority and caller-control drift without accepting client argv', () => {
  const plan = resolveGemini({ phase: 'plan', effort: 'high' });
  assert.throws(() => resolveGemini({ execution: plan.execution, effort: 'low' }), { code: 'execution_control_conflict' });
  assert.throws(() => resolveGemini({ execution: { ...plan.execution, args: ['--dangerously-skip-permissions'] } }), { code: 'invalid_execution_contract' });
  assert.throws(() => resolveGemini({ execution: plan.execution, slot: [...gemini.oneshot_safe, '--new-control'] }), { code: 'execution_config_changed' });
  assert.throws(() => resolveGemini({ execution: plan.execution, dangerous: true }), { code: 'invalid_execution_contract' });
  const refreshed = resolveGemini({ execution: plan.execution,
    entry: { ...gemini, label: 'new label' }, registry: { ...catalog('gemini-flash-medium', 'gemini-flash-high', 'gemini-pro-high'), generatedAt: 'new timestamp' } });
  assert.deepEqual(refreshed.execution, plan.execution);
});

test('high never promotes itself to max; xhigh cannot fall through to low', () => {
  assert.throws(() => resolveGemini({ effort: 'high', registry: catalog('gemini-flash-medium', 'gemini-flash-max') }), { code: 'unsupported_effort' });
  assert.throws(() => resolveGemini({ effort: 'xhigh', maxEffortOverride: true, registry: catalog('gemini-flash-medium', 'gemini-flash-low') }), { code: 'unsupported_effort' });
  assert.throws(() => resolveGemini({ effort: 'xhigh' }), { code: 'extreme_effort_requires_override' });
});

test('fixed models do not acquire invented reasoning strength from requested task tier', () => {
  const entry = { model: 'fixed-model', oneshot_adapter: 'ollama_api' };
  const selected = resolveProviderControls({ kind: 'local', entry, slot: ['unused'], taskTier: 'critical' });
  assert.equal(selected.execution.model, 'fixed-model');
  assert.equal(selected.execution.targetEffort, 'high');
  assert.equal(selected.execution.appliedEffort, null);
  assert.ok(selected.execution.effortFallbackReason);
  assert.throws(() => resolveProviderControls({ kind: 'local', entry, slot: ['unused'], effort: 'high' }), { code: 'unsupported_effort' });
  const replay = resolveProviderControls({ kind: 'local', entry, slot: ['unused'], execution: selected.execution });
  assert.deepEqual(replay.execution, selected.execution);
});

test('recognized competing selector aliases are replaced and argument suffixes survive', () => {
  const entry = { model_tiers: { standard: { model: 'chosen', args: ['--model', 'chosen', '--option', 'keep'] } } };
  const resolved = resolveProviderControls({ kind: 'fixture', entry, slot: ['cli', '-m', 'old', '--model=older', '--prompt', '{prompt}'] });
  assert.deepEqual(resolved.slot, ['cli', '--model', 'chosen', '--option', 'keep', '--prompt', '{prompt}']);
});

test('model identifier alone cannot invent a selector for an unsupported CLI', () => {
  const entry = { oneshot_safe: ['cli', '-'] };
  assert.throws(() => resolveProviderControls({ kind: 'gemini', entry, slot: entry.oneshot_safe,
    model: 'available-model', registry: catalog('available-model') }), { code: 'unsupported_model_control' });
});

test('explicit model weight is its configured tier, not a contradictory preference', () => {
  const resolved = resolveGemini({ model: 'gemini-pro-high', modelTier: 'standard' });
  assert.equal(resolved.execution.resolvedModelTier, 'heavy');
  assert.equal(resolved.execution.appliedEffort, 'high');
  assert.ok(resolved.execution.effortFallbackReason);
});

const spec = (model, extra = {}) => ({ model, args: ['--model', model], ...extra });
const providerCatalog = (...ids) => ({ providers: { fixture: { probed: true, models: ids.map((id) => ({ id })) } } });

test('Python module launcher remains intact independently of provider model selectors', () => {
  const entry = { model_flags: ['--model'], model_tiers: { standard: spec('chosen') } };
  for (const bin of ['python', '/usr/bin/python3', 'C:\\Python\\python.exe', 'py']) {
    for (const selector of [[], ['--model', 'old'], ['-m', 'old']]) {
      const slot = [bin, '-m', 'provider_cli', ...selector, '--prompt', '{prompt}'];
      const result = resolveProviderControls({ kind: 'fixture', entry, slot });
      assert.deepEqual(result.slot, [bin, '-m', 'provider_cli', '--model', 'chosen', '--prompt', '{prompt}']);
    }
  }
});

test('effort templates reject duplicate, malformed, delimiter-bearing and contradictory controls', () => {
  for (const args of [['--effort', 'high', '--effort', 'max'], ['--effort=high', '--reasoning-effort=max'],
    ['-c', 'model_reasoning_effort=high', '--config=reasoning_effort=max'],
    ['--effort', 'high', '--'], ['--effort', 'low'], ['--effort', 'invalid']]) {
    assert.throws(() => resolveProviderControls({ kind: 'fixture', slot: ['tool'],
      entry: { effort_flags: { high: args } }, effort: 'high' }), { code: 'unsupported_effort' });
  }
  for (const control of [['--effort'], ['--effort', 'invalid'], ['--effort=invalid'],
    ['-c', 'model_reasoning_effort=bogus'], ['--config=reasoning_effort=bogus'],
    ['--effort', 'high', '--effort', 'invalid']]) {
    for (const effort of [undefined, 'high']) assert.throws(() => resolveProviderControls({
      kind: 'fixture', slot: ['tool', ...control], entry: { model_tiers: { standard: spec('chosen') } }, effort,
    }), { code: 'unsupported_effort' });
  }
});

test('fixed selector tuples reproduce unknown effort under successful, missing and failed censuses', () => {
  for (const registry of [providerCatalog('fixed-model'), undefined, { providers: { fixture: { probed: false, error: 'offline' } } }]) {
    for (const taskTier of [undefined, 'standard']) {
      const input = { kind: 'fixture', entry: {}, slot: ['tool', '--model', 'fixed-model'], registry, taskTier };
      const plan = resolveProviderControls({ ...input, phase: 'plan' });
      assert.equal(plan.execution.appliedEffort, null);
      const replay = resolveProviderControls({ ...input, execution: plan.execution });
      assert.deepEqual(replay.execution, plan.execution);
      assert.deepEqual(replay.slot, plan.slot);
    }
  }
});

test('model suppression cannot consume a delimiter and templates cannot introduce one', () => {
  const entry = { model_tiers: { standard: spec('chosen', { suppress_args: [{ flag: '--effort', value_count: 1 }] }) } };
  for (const slot of [['tool', '--effort', '--', '--model', 'literal'], ['tool', '--effort']]) {
    assert.throws(() => resolveProviderControls({ kind: 'fixture', entry, slot }), { code: 'unsupported_model_control' });
  }
  assert.throws(() => resolveProviderControls({ kind: 'fixture', slot: ['tool', '--prompt-file', '{prompt_file}'],
    entry: { model_tiers: { standard: { model: 'chosen', args: ['--model', 'chosen', '--'] } } } }), { code: 'unsupported_model_control' });
});

test('linked account tails cannot override model or effort after contract admission', () => {
  const slot = ['tool', '--model', 'chosen'];
  for (const linked_account_args of [['--model', 'other'], ['--effort', 'max'],
    ['--config=reasoning_effort=max'], ['--'], ['--engine', 'other']]) {
    assert.throws(() => resolveProviderControls({ kind: 'fixture', slot,
      entry: { linked_account_args, model_flags: ['--engine'] } }), { code: 'invalid_account_controls' });
  }
  const plan = resolveProviderControls({ kind: 'fixture', slot, entry: { linked_account_args: ['--no-auto-login'] }, phase: 'plan' });
  assert.throws(() => resolveProviderControls({ kind: 'fixture', slot, entry: {}, execution: plan.execution }), { code: 'execution_config_changed' });
});

test('HTTP adapters cannot claim CLI-only effort controls were sent', () => {
  for (const oneshot_adapter of ['ollama_api', 'openai_chat_api']) {
    const input = { kind: 'fixture', slot: ['unused'], entry: { oneshot_adapter, model: 'fixed-model', effort_flags: { high: ['--effort', 'high'] } } };
    assert.throws(() => resolveProviderControls({ ...input, effort: 'high' }), { code: 'unsupported_effort' });
    const plan = resolveProviderControls({ ...input, taskTier: 'critical', phase: 'plan' });
    assert.equal(plan.execution.appliedEffort, null);
    assert.equal(plan.execution.effortMethod, 'not_supported');
    assert.ok(plan.execution.effortFallbackReason);
    assert.deepEqual(resolveProviderControls({ ...input, execution: plan.execution }).execution, plan.execution);
  }
});

test('configured effort variant absent from positive census is rejected after final selection', () => {
  const entry = { model_tiers: { standard: spec('family-medium'), heavy: spec('family-high') } };
  assert.throws(() => resolveProviderControls({ kind: 'fixture', entry, slot: ['tool'],
    registry: providerCatalog('family-medium'), taskTier: 'standard', effort: 'high' }), { code: 'model_unavailable' });
});

test('exact extreme-effort model also requires explicit override when effort field is omitted', () => {
  const entry = { model_tiers: { standard: spec('family-medium') } };
  const args = { kind: 'fixture', entry, slot: ['tool'], registry: providerCatalog('family-medium', 'family-xhigh'), model: 'family-xhigh' };
  assert.throws(() => resolveProviderControls(args), { code: 'extreme_effort_requires_override' });
  assert.equal(resolveProviderControls({ ...args, maxEffortOverride: true }).execution.appliedEffort, 'xhigh');
});

test('fixed metadata cannot silently remove a conflicting actual CLI selector', () => {
  assert.throws(() => resolveProviderControls({ kind: 'fixture', entry: { model: 'desired' },
    slot: ['tool', '--model', 'other'], model: 'desired' }), { code: 'model_unavailable' });
});

test('variant-owned suppression is identical in planning and replay', () => {
  const entry = { model_tiers: { standard: spec('family-medium'), heavy: spec('family-high', {
    suppress_args: [{ flag: '--fast', value_count: 0 }],
  }) } };
  const args = { kind: 'fixture', entry, slot: ['tool', '--fast'], taskTier: 'standard', effort: 'high' };
  const planned = resolveProviderControls({ ...args, phase: 'plan' });
  const replayed = resolveProviderControls({ ...args, execution: planned.execution });
  assert.equal(planned.slot.includes('--fast'), false);
  assert.deepEqual(replayed.slot, planned.slot);
  assert.deepEqual(replayed.execution, planned.execution);
});

test('existing model selectors stay after interpreter scripts and before their prompt arguments', () => {
  const entry = { model_tiers: { standard: spec('chosen') } };
  for (const script of ['/tmp/fixture.js', 'tools/fixture.js', 'fixture.js']) {
    const result = resolveProviderControls({ kind: 'fixture', entry,
      slot: ['node', script, '--model', 'old', '--prompt-file', '{prompt_file}'] });
    assert.deepEqual(result.slot, ['node', script, '--model', 'chosen', '--prompt-file', '{prompt_file}']);
  }
});

test('positional model-like and effort-like text after delimiter remains literal', () => {
  const slot = ['tool', '--', '--model', 'literal', '--effort', 'max'];
  const resolved = resolveProviderControls({ kind: 'fixture', entry: {}, slot });
  assert.deepEqual(resolved.slot, slot);
  assert.equal(resolved.execution.model, null);
  assert.equal(resolved.execution.appliedEffort, null);
});

test('static aliases are explicit declarations, not any alphabetic configured identifier', () => {
  const args = { kind: 'fixture', entry: { model_tiers: { standard: spec('retired') } },
    slot: ['tool'], registry: providerCatalog('live') };
  assert.throws(() => resolveProviderControls(args), { code: 'model_unavailable' });
  const allowed = resolveProviderControls({ ...args, entry: { ...args.entry, models_static: ['retired'] } });
  assert.equal(allowed.execution.model, 'retired');
});

test('fixed model adapter rejects forged account-default tuple', () => {
  const args = { kind: 'fixture', entry: { model: 'local-fixed', oneshot_adapter: 'ollama_api' }, slot: ['ollama', 'run', 'local-fixed'] };
  const plan = resolveProviderControls({ ...args, phase: 'plan' });
  assert.throws(() => resolveProviderControls({ ...args, execution: { ...plan.execution, model: null } }), { code: 'unsupported_model_control' });
});

test('competing implicit effort controls reject; explicit target replaces inline and paired controls', () => {
  assert.throws(() => resolveProviderControls({ kind: 'fixture', entry: {}, slot: ['tool', '--effort', 'low', '--effort', 'max'] }), { code: 'unsupported_effort' });
  const resolved = resolveProviderControls({ kind: 'fixture', entry: {},
    slot: ['tool', '--effort=max', '--reasoning-effort', 'low', '--', '--effort', 'literal'], effort: 'high' });
  assert.deepEqual(resolved.slot, ['tool', '--effort', 'high', '--', '--effort', 'literal']);
  assert.equal(resolved.execution.appliedEffort, 'high');
});
