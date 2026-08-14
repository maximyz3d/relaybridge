'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseModelList, classifyModel, reconcileProvider, buildRegistry, pinIsRetired } = require('../lib/model-registry');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cli-config.json'), 'utf8'));

test('parses the output shapes real CLIs actually emit', () => {
  assert.deepEqual(
    parseModelList('NAME              ID       SIZE\nqwen2.5-coder:7b  abc      4.7 GB', {}),
    ['qwen2.5-coder:7b'], 'table header must not be treated as a model');
  assert.deepEqual(
    parseModelList('Available models:\n  * gpt-5.6-sol\n  * gpt-5.6-luna', {}),
    ['gpt-5.6-sol', 'gpt-5.6-luna'], 'bullets must be stripped before the id');
  assert.deepEqual(
    parseModelList('Select a model:\n> gemini-3.6-flash\n  gemini-3.5-flash-lite', {}),
    ['gemini-3.6-flash', 'gemini-3.5-flash-lite']);
});

test('unparseable, empty, and error output degrade to nothing rather than garbage', () => {
  assert.deepEqual(parseModelList('', {}), []);
  assert.deepEqual(parseModelList('Error: not authenticated. Please run login.', {}), []);
  assert.deepEqual(parseModelList('   \n---\n', {}), []);
});

test('duplicates are collapsed and ids are normalized', () => {
  const models = parseModelList('gpt-5.6-sol\ngpt-5.6-sol,\n  gpt-5.6-sol', {});
  assert.deepEqual(models, ['gpt-5.6-sol']);
});

test('a provider-supplied parse pattern takes precedence', () => {
  const models = parseModelList('model=alpha-1 (ready)\nmodel=beta-2 (ready)', { models_parse: 'model=([a-z0-9-]+)' });
  assert.deepEqual(models, ['alpha-1', 'beta-2']);
});

test('a broken parse pattern falls back instead of throwing', () => {
  assert.doesNotThrow(() => parseModelList('gpt-5.6-sol', { models_parse: '([unclosed' }));
});

test('capability matching prefers the most specific family', () => {
  assert.equal(classifyModel('gemini-3.5-flash-lite').tier, 'light', 'flash-lite must not be swallowed by flash');
  assert.equal(classifyModel('gemini-3.6-flash').tier, 'standard');
  assert.equal(classifyModel('gpt-5.6-sol').tier, 'heavy');
  assert.equal(classifyModel('opus').tier, 'heavy');
});

test('a future version inherits its family profile without a config edit', () => {
  const future = classifyModel('gpt-5.9-luna');
  assert.equal(future.tier, 'light');
  assert.match(future.bestAt, /subagent/);
});

test('an unknown model is flagged rather than silently trusted', () => {
  const unknown = classifyModel('totally-new-thing-42');
  assert.equal(unknown.matched, null);
  assert.match(unknown.bestAt, /uncategorized/);
});

test('a retired pin is detected when the provider lists its models', () => {
  const result = reconcileProvider({
    kind: 'codex',
    entry: { model_tiers: { standard: { model: 'gpt-5.4' } } },
    discovered: ['gpt-5.6-sol', 'gpt-5.6-terra'],
  });
  assert.equal(result.configured.standard.status, 'missing');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /retired/);
});

test('pins are left alone when the provider could not be probed', () => {
  const result = reconcileProvider({
    kind: 'codex',
    entry: { model_tiers: { standard: { model: 'gpt-5.6-terra' } } },
    discovered: null,
    error: 'no list command',
  });
  assert.equal(result.configured.standard.status, 'unverified');
  assert.deepEqual(result.warnings, [], 'an unprobed provider must not be second-guessed');
});

test('only a positive probe can veto a pin', () => {
  const probed = buildRegistry({ probeResults: { codex: { models: ['gpt-5.6-sol'] } }, config: { codex: { label: 'Codex' } } });
  assert.equal(pinIsRetired(probed, 'codex', 'gpt-5.4'), true);
  assert.equal(pinIsRetired(probed, 'codex', 'gpt-5.6-sol'), false);

  const unprobed = buildRegistry({ probeResults: {}, config: { codex: { label: 'Codex' } } });
  assert.equal(pinIsRetired(unprobed, 'codex', 'gpt-5.4'), false, 'no evidence means no veto');
  assert.equal(pinIsRetired(unprobed, 'nonexistent', 'x'), false);
});

test('registry builds from the shipped config without throwing', () => {
  const registry = buildRegistry({ probeResults: { cursor: { models: ['gpt-5.6-sol', 'auto'] } }, config });
  assert.ok(registry.providerCount > 0);
  assert.ok(registry.generatedAt);
  assert.equal(registry.providers.cursor.probed, true);
  assert.ok(registry.providers.cursor.models.every((m) => m.bestAt), 'every model needs a capability note');
});

test('claude declares stable aliases so it is known without a list command', () => {
  assert.deepEqual(config.claude.models_static, ['opus', 'sonnet', 'haiku']);
  assert.ok(config._models.discoverOnBoot, 'discovery should run at boot by default');
});
