'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildTaskPlan, resolveEffort, effortForTier, findEffortVariant, costClassFor, EFFORT_ORDER } = require('../lib/task-plan');
const { resolveModelArgs } = require('../lib/model-tiers');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cli-config.json'), 'utf8'));

const route = (tier, kinds) => ({ classification: { tier }, selected: kinds.map((kind) => ({ kind })) });

test('effort scales with tier and never exceeds the ladder', () => {
  assert.equal(effortForTier('utility'), 'low');
  assert.equal(effortForTier('standard'), 'medium');
  assert.equal(effortForTier('complex'), 'high');
  // Critical deliberately stops at high: max costs far more for a marginal gain,
  // so a caller who genuinely wants it must ask.
  assert.equal(effortForTier('critical'), 'high');
  for (const tier of ['utility', 'standard', 'complex', 'critical']) {
    assert.ok(EFFORT_ORDER.includes(effortForTier(tier)));
  }
});

test('an explicit effort overrides the tier default', () => {
  assert.equal(effortForTier('utility', 'max'), 'max');
  assert.equal(effortForTier('complex', 'low'), 'low');
  assert.equal(effortForTier('standard', 'nonsense'), 'medium', 'garbage falls back, never throws');
});

test('effort uses a CLI flag when the provider has one', () => {
  const resolved = resolveEffort({ entry: config.codex, effort: 'high', baseModel: 'gpt-5.6-sol' });
  assert.equal(resolved.method, 'flag');
  assert.ok(resolved.args.join(' ').includes('model_reasoning_effort=high'));
});

test('effort swaps to a model variant when that is how the vendor expresses it', () => {
  // Cursor lists gpt-5.6-sol-low/-high/-max as separate model ids.
  const available = ['gpt-5.6-sol-low', 'gpt-5.6-sol-high', 'gpt-5.6-sol-max', 'auto'];
  assert.equal(findEffortVariant({ baseModel: 'gpt-5.6-sol-medium', effort: 'high', availableModels: available }), 'gpt-5.6-sol-high');
  assert.equal(findEffortVariant({ baseModel: 'gpt-5.6-sol-high', effort: 'low', availableModels: available }), 'gpt-5.6-sol-low');
  const resolved = resolveEffort({ entry: config.cursor, effort: 'max', baseModel: 'gpt-5.6-sol-high', availableModels: available });
  assert.equal(resolved.method, 'model_variant');
  assert.equal(resolved.model, 'gpt-5.6-sol-max');
});

test('a provider with no effort knob reports that honestly', () => {
  const resolved = resolveEffort({ entry: config.claude, effort: 'high', baseModel: 'opus' });
  assert.equal(resolved.method, 'model_choice');
  assert.deepEqual(resolved.args, [], 'inventing a flag Claude does not accept would fail every call');
});

test('cost class distinguishes free, local, subscription and metered', () => {
  assert.equal(costClassFor(config.powershell), 'none');
  assert.equal(costClassFor(config.ollama_coder), 'local');
  assert.equal(costClassFor(config.claude), 'subscription');
});

test('a trivial task does not get a frontier seat at high effort', () => {
  const plan = buildTaskPlan({
    route: route('utility', ['ollama_fast', 'claude']),
    config, resolveModelArgs,
  });
  assert.equal(plan.tier, 'utility');
  assert.equal(plan.effort, 'low');
  assert.equal(plan.primary.kind, 'ollama_fast');
  assert.equal(plan.primary.costClass, 'local', 'utility work must not spend a paid seat');
});

test('a hard task gets the heavy model at high effort', () => {
  const plan = buildTaskPlan({
    route: route('complex', ['claude', 'codex']),
    config, resolveModelArgs,
  });
  assert.equal(plan.effort, 'high');
  assert.equal(plan.primary.model, 'opus');
  assert.equal(plan.primary.modelTier, 'heavy');
});

test('the plan names the company, not just the provider key', () => {
  const plan = buildTaskPlan({ route: route('standard', ['codex']), config, resolveModelArgs });
  assert.ok(plan.primary.company && plan.primary.company.length > 1);
  assert.equal(plan.primary.kind, 'codex');
});

test('effort flags and the model flag both reach the args', () => {
  const plan = buildTaskPlan({ route: route('complex', ['codex']), config, resolveModelArgs });
  const args = plan.primary.args.join(' ');
  assert.ok(args.includes('--model'), 'model must be pinned');
  assert.ok(args.includes('model_reasoning_effort=high'), 'effort must be applied');
});

test('a cheaper capable provider is surfaced instead of being hidden', () => {
  const plan = buildTaskPlan({ route: route('standard', ['claude', 'ollama_coder']), config, resolveModelArgs });
  assert.ok(plan.cheapestCapable);
  assert.equal(plan.cheapestCapable.costClass, 'local');
  assert.ok(plan.guidance.some((g) => /cheaper/i.test(g)), 'the plan should say a cheaper seat exists');
});

test('critical tier demands a human gate', () => {
  const plan = buildTaskPlan({ route: route('critical', ['claude']), config, resolveModelArgs });
  assert.equal(plan.humanGate, true);
  assert.ok(plan.guidance.some((g) => /not auto-execute/i.test(g)));
});

test('deterministic work is routed away from models entirely', () => {
  const plan = buildTaskPlan({ route: route('deterministic', ['powershell']), config, resolveModelArgs });
  assert.equal(plan.primary.costClass, 'none');
  assert.ok(plan.guidance.some((g) => /no model at all/i.test(g)));
});

test('an explicitly requested provider is planned even if unrouted', () => {
  const plan = buildTaskPlan({ route: route('standard', ['ollama_coder']), config, resolveModelArgs, requestedKind: 'claude' });
  assert.equal(plan.primary.kind, 'claude');
});

test('the CLI exposes plan before ask and documents effort', () => {
  const { USAGE } = require('../bin/relaybridge.js');
  assert.match(USAGE, /relaybridge plan/);
  assert.match(USAGE, /minimal\|low\|medium\|high\|max/);
  assert.ok(USAGE.indexOf('plan') < USAGE.indexOf('ask'), 'plan should be presented before ask');
});

test('the CLI never force-exits while sockets are in flight', () => {
  // process.exit() with a closing HTTP handle trips a libuv assertion on
  // Windows and prints a crash after otherwise-correct output.
  const cli = fs.readFileSync(path.join(__dirname, '..', 'bin', 'relaybridge.js'), 'utf8');
  const tail = cli.slice(cli.indexOf('require.main === module'));
  assert.ok(!/main\(\)\.then\(\(code\) => process\.exit\(code\)\)/.test(tail),
    'set process.exitCode and let the loop drain instead');
  assert.match(tail, /process\.exitCode = code/);
  assert.match(tail, /unref/, 'the safety timer must not hold the process open by itself');
});

test('a 404 is explained as a stale bridge rather than a CLI fault', () => {
  const cli = fs.readFileSync(path.join(__dirname, '..', 'bin', 'relaybridge.js'), 'utf8');
  assert.match(cli, /not available on the running bridge/);
  assert.match(cli, /restart RelayBridge after syncing/);
});
