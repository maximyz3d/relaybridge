'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { createCreditPreferences, validateCreditPreference, allocatedCreditStatus } = require('../lib/allocated-credit');
const { startTestBridge, waitFor } = require('./helpers/temporary-bridge');
const ROOT = path.resolve(__dirname, '..');
const selections = [{ mode: 'auto' }, { mode: 'off' },
  { mode: 'manual', manualTarget: 'subscription' }, { mode: 'manual', manualTarget: 'included_api_credit' }];
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-credit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('default Auto and each explicit preference persist without enabling API dispatch', (t) => {
  const dataDir = path.join(temporary(t), 'credit');
  const store = createCreditPreferences({ dataDir });
  assert.equal(store.get().mode, 'auto'); assert.equal(store.get().source, 'default');
  for (const selection of selections) {
    const saved = store.set(selection);
    assert.deepEqual(createCreditPreferences({ dataDir }).get(), saved);
    const status = allocatedCreditStatus({}, saved);
    assert.equal(status.effective.route, selection.manualTarget === 'included_api_credit' ? 'blocked' : 'subscription_only');
    assert.equal(status.automationAvailable, false); assert.equal(status.effective.dispatchAllowed, false);
    assert.ok(Object.values(status.providers).every((p) => !p.dispatchAllowed));
    saved.mode = 'off'; assert.deepEqual(store.get().mode, selection.mode);
  }
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dataDir, 'preference.json')).mode & 0o777, 0o600);
  }
});

test('invalid inputs and failed writes preserve the last preference and never echo supplied secrets', (t) => {
  const root = temporary(t), dataDir = path.join(root, 'credit');
  const store = createCreditPreferences({ dataDir }); store.set({ mode: 'off' });
  const before = store.get();
  for (const bad of [null, [], {}, 'auto', { mode: 'secret-value' }, { mode: 'manual' },
    { mode: 'manual', manualTarget: 'secret-value' }, { mode: 'off', manualTarget: 'subscription' },
    { mode: 'auto', apiKey: 'secret-value' }, { mode: 'auto', updatedAt: 'secret-value' },
    { mode: 'auto', fundingVerified: true }, { mode: 'auto', schemaVersion: 1 }]) {
    assert.throws(() => store.set(bad), (e) => e.code === 'invalid_credit_preference' && !e.message.includes('secret-value'));
    assert.deepEqual(store.get(), before);
  }
  assert.deepEqual(validateCreditPreference({ mode: 'auto', manualTarget: null }), { mode: 'auto', manualTarget: null });
  fs.renameSync(dataDir, path.join(root, 'backup')); fs.writeFileSync(dataDir, 'obstruct write');
  assert.throws(() => store.set({ mode: 'auto' }), { code: 'credit_preference_write_failed' });
  assert.deepEqual(store.get(), before);
});

test('invalid saved state falls back to Off without rewriting it, and explicit selection repairs it', (t) => {
  const dataDir = temporary(t), file = path.join(dataDir, 'preference.json');
  for (const raw of ['{', 'x'.repeat(4097), 'null', '[]', JSON.stringify({ schemaVersion: 1, mode: 'auto', updatedAt: 'bad' }),
    JSON.stringify({ schemaVersion: 1, mode: 'auto', updatedAt: new Date().toISOString(), fundingVerified: true })]) {
    fs.writeFileSync(file, raw);
    const store = createCreditPreferences({ dataDir });
    assert.equal(store.get().mode, 'off'); assert.equal(store.get().source, 'invalid_store');
    assert.equal(allocatedCreditStatus({}, store.get()).effective.blockedReason, 'invalid_preference_store');
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
    store.set({ mode: 'auto' }); assert.equal(createCreditPreferences({ dataDir }).get().mode, 'auto');
  }
  fs.unlinkSync(file); fs.mkdirSync(file);
  assert.equal(createCreditPreferences({ dataDir }).get().source, 'invalid_store');
});

test('symlinked preferences are rejected without reading or overwriting their target', { skip: process.platform === 'win32' }, (t) => {
  const dataDir = temporary(t), file = path.join(dataDir, 'preference.json'), target = path.join(dataDir, 'private');
  fs.writeFileSync(target, 'private-fixture'); fs.symlinkSync(target, file);
  const store = createCreditPreferences({ dataDir }); assert.equal(store.get().source, 'invalid_store');
  store.set({ mode: 'off' }); assert.equal(fs.readFileSync(target, 'utf8'), 'private-fixture');
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
});

test('REST, CLI and MCP share persisted modes, preserve quota settings, and enforce auth/identity', async (t) => {
  const bridge = await startTestBridge(t, () => ({}));
  const put = (body, extra = {}) => bridge.request('/api/settings/allocated-credit', body, { method: 'PUT', ...extra });
  const continuity = (await bridge.request('/api/settings/continuity')).body;
  assert.equal((await fetch(bridge.base + '/api/settings/allocated-credit', { method: 'PUT', body: '{}' })).status, 401);
  for (const identity of [{}, { 'X-RelayBridge-Expected-Build-Id': 'stale', 'X-RelayBridge-Expected-Receipt-Store-Id': 'stale' }]) {
    const result = await put({ mode: 'off' }, { headers: { ...bridge.headers, 'X-RelayBridge-Client': 'mcp', ...identity } });
    assert.equal(result.status, 409); assert.equal(result.body.failureClass, 'bridge_identity_mismatch');
  }
  const rejected = await put({ mode: 'auto', secret: 'private-fixture' });
  assert.equal(rejected.status, 400); assert.equal(JSON.stringify(rejected.body).includes('private-fixture'), false);
  for (const selection of selections) {
    const result = await put(selection); assert.equal(result.status, 200);
    assert.equal(result.body.preference.mode, selection.mode); assert.equal(result.body.automationAvailable, false);
  }
  const cliEnv = { ...process.env, RELAYBRIDGE_URL: bridge.base, RELAYBRIDGE_TOKEN: bridge.headers['X-RelayBridge-Token'] };
  const cli = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'bin/relaybridge.js'), ...args], { encoding: 'utf8', env: cliEnv });
  assert.match(cli('credit', 'mode', 'manual', 'included_api_credit'), /effective\s+blocked/);
  assert.deepEqual(JSON.parse(cli('options', '--json')).allocatedCredit, (await bridge.request('/api/allocated-credit')).body);
  assert.equal(JSON.parse(cli('credit', 'mode', 'auto', '--json')).preference.mode, 'auto');

  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const client = new Client({ name: 'credit-fixture', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp/server.mjs')], stderr: 'pipe',
    env: { ...cliEnv, NODE_ENV: 'test', RELAYBRIDGE_TEST_BUILD_ID: 'security-integration-fixture',
      RELAYBRIDGE_DATA_DIR: path.join(bridge.root, 'data'), RELAYBRIDGE_CONFIG_FILE: bridge.configPath,
      RELAYBRIDGE_TOKEN_FILE: path.join(bridge.root, 'token') } });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: 'set_allocated_credit_mode', arguments: { mode: 'off' } });
    assert.ok(!result.isError, JSON.stringify(result)); assert.equal(result.structuredContent.preference.mode, 'off');
    const bad = await client.callTool({ name: 'set_allocated_credit_mode', arguments: { mode: 'auto', fundingVerified: true } });
    assert.equal(bad.isError, true);
    const context = await client.callTool({ name: 'get_context_bundle', arguments: { includeDiagnostics: false, includeSessionOutput: false } });
    assert.equal(context.structuredContent.allocatedCredit.preference.mode, 'off');
    assert.equal(context.structuredContent.allocatedCredit.effective.automationAvailable, false);
  } finally { await client.close(); }
  assert.deepEqual((await bridge.request('/api/settings/continuity')).body, continuity);
  const beforeRestart = (await bridge.request('/api/allocated-credit')).body.preference;
  await bridge.request('/api/admin/shutdown', {});
  await waitFor(() => bridge.proc.exitCode !== null || bridge.proc.signalCode !== null);
  const restarted = await startTestBridge(t, () => ({}), { env: { RELAYBRIDGE_DATA_DIR: path.join(bridge.root, 'data') } });
  assert.deepEqual((await restarted.request('/api/allocated-credit')).body.preference, beforeRestart);
});

test('CLI rejects ambiguous/trailing arguments and secret flags before any network request', () => {
  for (const args of [['credit', 'mode', 'auto', 'extra'], ['credit', 'mode', 'manual'],
    ['credit', 'setup', 'openai', 'private-fixture'], ['credit', '--api-key', 'private-fixture'],
    ['credit', '--json=true'], ['options', 'off'], ['options', '--unexpected'], ['credit', 'mode', 'private-fixture']]) {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/relaybridge.js'), ...args], {
      encoding: 'utf8', env: { ...process.env, RELAYBRIDGE_URL: 'http://127.0.0.1:1' } });
    assert.notEqual(result.status, 0); assert.doesNotMatch(result.stderr, /cannot reach|no bridge token|private-fixture/);
  }
});
