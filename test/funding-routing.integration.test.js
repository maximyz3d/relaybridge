'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const http = require('node:http');
const { startTestBridge, waitFor } = require('./helpers/temporary-bridge');
const { CREDIT_SECRET_NAMES } = require('../lib/allocated-credit');
const { isolatedEnv } = require('./helpers/isolated-env');
const ROOT = path.resolve(__dirname, '..');
const profile = (id = 'one', provider = 'claude') => ({ id, provider, label: id,
  subscription: { kind: provider === 'claude' ? 'claude' : 'codex', accountId: 'default' },
  organization: { ref: 'org_' + id, label: 'Fixture org' }, project: { ref: 'project_' + id, label: 'Fixture project' },
  credentialRef: { type: 'reserved_env', name: CREDIT_SECRET_NAMES[provider === 'claude' ? 0 : 1] },
  creditPeriod: { start: '2020-01-01T00:00:00.000Z', end: '2099-01-01T00:00:00.000Z' } });
const envelope = (patch = {}) => ({ route: 'included_api_credit', fallback: 'none', ...patch });
function assertRejectedFunding(body, authorized) {
  assert.equal(body.model_invocation, false);
  assert.equal(body.physical_attempt_count, 0);
  assert.equal(body.route.funding.actual, 'none');
  assert.equal(body.route.funding.fallbackApplied, false);
  assert.equal(body.route.funding.fallbackAuthorized, authorized);
  assert.equal(body.route.funding.admissionBlockedReason, body.failureClass);
}

test('OpenAI eligible API choice is distinct from Codex auth; generic HTTP transport cannot masquerade as subscription', async t => {
  let requests = 0;
  const endpoint = http.createServer((_req, res) => { requests++; res.end('{}'); });
  await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => endpoint.close(resolve)));
  const bridge = await startTestBridge(t, () => ({ codex: { model: 'fixture', oneshot_adapter: 'openai_chat_api',
    api_base_url: `http://127.0.0.1:${endpoint.address().port}/v1/chat/completions`, api_key_env: 'RELAYBRIDGE_OPENAI_CREDIT_API_KEY' } }));
  assert.equal((await bridge.request('/api/funding-profiles', { profile: profile('api', 'openai'), expectedRevision: 0 })).status, 200);
  for (const fallback of ['none', 'subscription']) {
    const rejected = await bridge.request('/api/oneshot', { kind: 'codex', prompt: 'Hello', cwd: bridge.root,
      funding: envelope({ profileId: 'api', fallback }) });
    assert.equal(rejected.status, 409); assert.equal(rejected.body.model_invocation, false);
    assert.equal(rejected.body.failureClass, 'funding_subscription_transport_required');
    assert.equal(rejected.body.physical_attempt_count, 0); assert.equal(requests, 0);
  }
  fs.writeFileSync(bridge.configPath, JSON.stringify({ codex: { oneshot_safe: [process.execPath, '-e', 'throw Error("must not run")', '{prompt}'] } }));
  const blocked = await bridge.request('/api/oneshot', { kind: 'codex', prompt: 'Hello', cwd: bridge.root, funding: envelope({ profileId: 'api' }) });
  assert.equal(blocked.body.failureClass, 'grant_only_funding_unverified'); assert.equal(blocked.body.route.funding.apiLimitation, 'codex_api_key_excluded');
  assert.equal(blocked.body.route.funding.eligibleApiSurface, 'openai_responses_agent'); assert.equal(requests, 0);
  const unknown = await bridge.request('/api/oneshot', { kind: 'codex', prompt: 'Hello', cwd: bridge.root,
    funding: envelope({ profileId: 'api', fallback: 'subscription' }) });
  assert.equal(unknown.body.failureClass, 'quota_unknown', JSON.stringify(unknown.body));
  assertRejectedFunding(unknown.body, true); assert.equal(requests, 0);
});

test('funding selections, blocked API, explicit fallback, queues, CLI and MCP retain their binding', async t => {
  let marker;
  const sentinel = 'sk-fixture-secret-must-never-appear';
  const bridge = await startTestBridge(t, root => {
    marker = path.join(root, 'attempts');
    const script = path.join(root, 'fixture.js');
    fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(marker)}, 'attempt\\n');
      console.log('fixture answer');`);
    const slot = [process.execPath, script, '{prompt}'];
    return { claude: { label: 'Offline Claude fixture', safe: slot, dangerous: slot, oneshot_safe: slot, oneshot_dangerous: slot,
      capabilities: ['prompt'], oneshot_capabilities: { safe: ['model_invocation'], dangerous: ['model_invocation'] }, cost_class: 'subscription', model: 'fixture' },
      codex: { label: 'Offline Codex fixture', safe: slot, oneshot_safe: slot, capabilities: ['prompt'], cost_class: 'subscription', model: 'fixture' } };
  }, { env: { RELAYBRIDGE_ANTHROPIC_CREDIT_API_KEY: sentinel, RELAYBRIDGE_OPENAI_CREDIT_API_KEY: sentinel } });
  const count = () => fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').length : 0;
  const put = (route, body, opts = {}) => bridge.request(route, body, { method: 'PUT', ...opts });
  const set = async p => bridge.request('/api/funding-profiles', { profile: p, expectedRevision: (await bridge.request('/api/funding-profiles')).body.storeRevision });
  const select = async id => put('/api/settings/funding-selection', { profileId: id, expectedRevision: (await bridge.request('/api/funding-profiles')).body.storeRevision });
  const base = { kind: 'claude', prompt: 'Say hello', cwd: bridge.root, dangerous: false };
  const shot = f => bridge.request('/api/oneshot', { ...base, funding: f });
  const usage = async used => {
    const reset = Math.floor(Date.now() / 1000) + 18000;
    const result = await bridge.request('/api/usage/native', { kind: 'claude', accountId: 'default', rate_limits: {
      five_hour: { used_percentage: used, resets_at: reset }, seven_day: { used_percentage: used, resets_at: reset + 604800 } } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  };
  assert.equal((await fetch(bridge.base + '/api/funding-profiles', { method: 'POST', body: '{}' })).status, 401);
  const staleMcp = await bridge.request('/api/funding-profiles', { profile: profile(), expectedRevision: 0 }, { headers: { ...bridge.headers, 'X-RelayBridge-Client': 'mcp' } });
  assert.equal(staleMcp.status, 409); assert.equal(staleMcp.body.failureClass, 'bridge_identity_mismatch');
  const created = await set(profile()); assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal((await select('one')).status, 200);
  const preferencesBefore = (await bridge.request('/api/allocated-credit')).body.preference;
  const selected = (await bridge.request('/api/funding-profiles')).body;
  assert.equal(selected.selected.profileId, 'one');
  const revision = selected.profiles[0].revision;

  const blocked = await shot(envelope());
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.failureClass, 'grant_only_funding_unverified');
  assert.equal(blocked.body.model_invocation, false); assert.equal(blocked.body.physical_attempt_count, 0);
  assert.equal(blocked.body.route.funding.actual, 'none'); assert.equal(blocked.body.receiptPersisted, true);
  assertRejectedFunding(blocked.body, false);
  assert.equal(count(), 0);
  const unknown = await shot(envelope({ fallback: 'subscription' }));
  assert.equal(unknown.body.failureClass, 'quota_unknown', JSON.stringify(unknown.body)); assert.equal(count(), 0);
  assertRejectedFunding(unknown.body, true);
  await usage(10);
  const ran = await shot(envelope({ fallback: 'subscription' }));
  assert.equal(ran.status, 200, JSON.stringify(ran.body)); assert.equal(ran.body.exitCode, 0, JSON.stringify(ran.body));
  assert.equal(count(), 1);
  assert.equal(ran.body.route.funding.actual, 'subscription'); assert.equal(ran.body.route.funding.requested.route, 'included_api_credit');
  assert.equal(ran.body.route.funding.identity.organization, 'org_one'); assert.equal(ran.body.route.funding.fallbackApplied, true);
  assert.equal(ran.body.route.funding.expectedAccountId, 'default');

  // Bound durable work is not redirected by a selection change. The original
  // profile remains valid; a later edit invalidates accepted queued work.
  const queued = await bridge.request('/api/tasks', { ...base, deliveryMode: 'queued', taskId: 't_funding_selection',
    notBefore: Date.now() + 4000, funding: envelope({ route: 'subscription', profileId: 'one', expectedProfileRevision: revision }) });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  assert.equal((await set(profile('two'))).status, 200); await select('two');
  const finished = await waitFor(async () => { const r = await bridge.request('/api/tasks/t_funding_selection'); const task = r.body.task || r.body; return ['done', 'failed'].includes(task.status) && task; });
  assert.equal(finished.status, 'done', JSON.stringify(finished));
  assert.equal(finished.route.funding.requested.profileId, 'one'); assert.equal(count(), 2);
  const stale = await bridge.request('/api/tasks', { ...base, deliveryMode: 'queued', taskId: 't_funding_stale',
    notBefore: Date.now() + 4000, funding: envelope({ route: 'subscription', profileId: 'one', expectedProfileRevision: revision }) });
  assert.equal(stale.status, 202, JSON.stringify(stale.body));
  const changedIntent = await bridge.request('/api/tasks', { ...base, deliveryMode: 'queued', taskId: 't_funding_stale',
    funding: envelope({ route: 'subscription', profileId: 'two' }) });
  assert.equal(changedIntent.status, 409); assert.equal(changedIntent.body.code, 'TASK_INTENT_CONFLICT');
  const edited = profile(); edited.project.ref = 'project_changed'; await set(edited);
  const staleResult = await waitFor(async () => { const r = await bridge.request('/api/tasks/t_funding_stale'); const task = r.body.task || r.body; return ['done', 'failed'].includes(task.status) && task; });
  assert.equal(staleResult.failureClass, 'funding_profile_stale'); assert.equal(count(), 2);

  for (const route of ['/api/sessions', '/api/plan', '/api/workflows', '/api/continuity']) {
    const r = await bridge.request(route, { ...base, funding: envelope() });
    assert.equal(r.body.errorCode, 'funding_envelope_unsupported', JSON.stringify(r.body));
  }
  // Delegated tasks cannot carry a funding or account selector; refuse, never drop.
  for (const key of ['funding', 'expectedAccountId', 'funding_route', 'billingMode']) {
    const value = key === 'funding' ? envelope() : key === 'expectedAccountId' ? 'default' : 'included_api_credit';
    const r = await bridge.request('/api/delegate', { tasks: [{ prompt: 'Say hello' }, { prompt: 'Say hello', [key]: value }] });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.errorCode, key.startsWith('funding_') || key === 'billingMode' ? 'funding_alias_unsupported' : 'funding_envelope_unsupported');
  }
  const refusedPreview = await bridge.request('/api/funding-route/preview', { kind: 'claude', funding: { route: 'auto', fallback: 'none' } });
  assert.equal(refusedPreview.status, 400); assert.equal(refusedPreview.body.errorCode, 'auto_switching_unavailable');
  assert.equal(refusedPreview.body.receiptPersisted, false); assert.equal(refusedPreview.body.receiptId, undefined);
  const mixed = await bridge.request('/api/workflows', { ...base, funding: envelope(), funding_route: 'allocated_api_credit' });
  assert.equal(mixed.status, 400); assert.equal(count(), 2);
  for (const key of ['fundingRoute', 'billingMode']) {
    const r = await bridge.request('/api/tasks', { ...base, [key]: 'included_api_credit' });
    assert.equal(r.body.errorCode, 'funding_alias_unsupported');
  }
  assert.equal(count(), 2);

  const cliEnv = isolatedEnv({ RELAYBRIDGE_URL: bridge.base, RELAYBRIDGE_TOKEN: bridge.headers['X-RelayBridge-Token'],
    NODE_ENV: 'test', RELAYBRIDGE_TEST_BUILD_ID: 'security-integration-fixture', RELAYBRIDGE_DATA_DIR: path.join(bridge.root, 'data'),
    RELAYBRIDGE_CONFIG_FILE: bridge.configPath, RELAYBRIDGE_TOKEN_FILE: path.join(bridge.root, 'token') });
  const cli = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'bin/relaybridge.js'), ...args], { encoding: 'utf8', env: cliEnv, cwd: bridge.root });
  assert.equal(JSON.parse(cli('profiles', 'list', '--json')).selected.profileId, 'two');
  const preview = JSON.parse(cli('profiles', 'preview', '--kind', 'claude', '--route', 'included_api_credit'));
  assert.equal(preview.decision.actual, 'none'); assert.equal(count(), 2);
  const cliResult = JSON.parse(cli('ask', 'Say hello', '--kind', 'claude', '--funding-route', 'subscription', '--funding-profile', 'two', '--json'));
  assert.equal(cliResult.route.funding.actual, 'subscription'); assert.equal(count(), 3);
  const badCli = spawnSync(process.execPath, [path.join(ROOT, 'bin/relaybridge.js'), 'ask', 'Hello', '--fundingRoute', 'included_api_credit'], { env: cliEnv, encoding: 'utf8' });
  assert.notEqual(badCli.status, 0); assert.match(badCli.stderr, /Unsupported funding/);

  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const client = new Client({ name: 'funding-fixture', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp/server.mjs')], env: cliEnv, stderr: 'pipe' }));
  try {
    const call = async (name, args) => client.callTool({ name, arguments: args });
    const listed = await call('list_funding_profiles', {}); assert.equal(listed.structuredContent.selected.profileId, 'two');
    const context = await call('get_context_bundle', { includeDiagnostics: false, includeSessionOutput: false,
      includeCollabMessages: false, recentRuns: 0, recentReceipts: 0 });
    const summary = context.structuredContent.allocatedCredit.fundingProfiles;
    assert.deepEqual(summary, (await bridge.request('/api/allocated-credit')).body.fundingProfiles);
    assert.equal(summary.selected.profileId, 'two');
    for (const item of summary.profiles) {
      assert.deepEqual(Object.keys(item).sort(), ['id', 'provider', 'revision', 'dispatchAllowed'].sort());
      assert.equal(item.dispatchAllowed, false);
    }
    assert.equal(JSON.stringify(summary).includes(sentinel), false);
    assert.equal(JSON.stringify(summary).includes(bridge.root), false);
    assert.equal(count(), 3);
    for (const name of ['route_and_ask', 'broadcast', 'run_committee']) {
      const result = await call(name, { task: 'Say hello', prompt: 'Say hello', funding: envelope() });
      assert.ok(result.isError, JSON.stringify(result));
      assert.match(JSON.stringify(result), /funding_envelope_unsupported/);
    }
    const delegated = await call('delegate_tasks', { tasks: [{ prompt: 'Say hello', baseSha: 'a'.repeat(40), ownedFiles: ['x.txt'],
      doneWhen: ['done'], funding: envelope() }] });
    assert.ok(delegated.isError, JSON.stringify(delegated)); assert.match(JSON.stringify(delegated), /funding_envelope_unsupported/);
    const unsupported = await call('submit_task', { ...base, fundingRoute: 'included_api_credit' });
    assert.ok(unsupported.isError); assert.match(JSON.stringify(unsupported), /funding_alias_unsupported/);
    const accountConflict = await call('ask_provider', { ...base, expectedAccountId: 'other', funding: envelope() });
    assert.equal(accountConflict.structuredContent.errorCode, 'funding_account_conflict'); assert.equal(count(), 3);
    const api = await call('ask_provider', { ...base, funding: envelope() });
    assert.match(JSON.stringify(api), /grant_only_funding_unverified/); assert.equal(count(), 3);
    const fallback = await call('ask_provider', { ...base, funding: envelope({ fallback: 'subscription' }), collectionMs: 10000 });
    assert.equal(fallback.structuredContent.route.funding.actual, 'subscription', JSON.stringify(fallback));
    assert.equal(count(), 4);
    const repeat = await call('ask_provider', { ...base, funding: envelope({ fallback: 'subscription' }) });
    assert.equal(repeat.structuredContent.route.funding.requested.profileId, 'two'); assert.equal(count(), 5); // Never cache funded work.
  } finally { await client.close(); }
  await usage(98);
  const reserve = await shot(envelope({ fallback: 'subscription' }));
  assert.equal(reserve.body.failureClass, 'quota_reserve', JSON.stringify(reserve.body)); assert.equal(count(), 5);
  assertRejectedFunding(reserve.body, true);
  // Disabling ordinary usage protection does not relax the funded fallback's reserve gate.
  assert.equal((await put('/api/settings/continuity', { usageProtection: false })).status, 200);
  await usage(97);
  const unprotected = await shot(envelope({ fallback: 'subscription' }));
  assert.equal(unprotected.body.failureClass, 'quota_reserve', JSON.stringify(unprotected.body)); assert.equal(count(), 5);
  assertRejectedFunding(unprotected.body, true);
  assert.equal((await put('/api/settings/continuity', { usageProtection: true })).status, 200);
  assert.deepEqual((await bridge.request('/api/allocated-credit')).body.preference, preferencesBefore);
  for (const value of [blocked.body, ran.body, finished, staleResult]) assert.equal(JSON.stringify(value).includes(sentinel), false);
});

test('a generic 429 cooldown is not bypassed by an authorized subscription fallback', async t => {
  let marker;
  const bridge = await startTestBridge(t, root => {
    marker = path.join(root, 'attempts');
    const script = path.join(root, 'fixture.js');
    fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(marker)}, 'attempt\\n');
      console.error('HTTP 429 rate limit exceeded'); process.exit(29);`);
    const slot = [process.execPath, script, '{prompt}'];
    return { claude: { label: 'Offline Claude fixture', safe: slot, oneshot_safe: slot, capabilities: ['prompt'], cost_class: 'subscription', model: 'fixture' } };
  });
  const count = () => fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').length : 0;
  assert.equal((await bridge.request('/api/funding-profiles', { profile: profile(), expectedRevision: 0 })).status, 200);
  const reset = Math.floor(Date.now() / 1000) + 18000;
  assert.equal((await bridge.request('/api/usage/native', { kind: 'claude', accountId: 'default', rate_limits: {
    five_hour: { used_percentage: 10, resets_at: reset }, seven_day: { used_percentage: 10, resets_at: reset + 604800 } } })).status, 200);
  const base = { kind: 'claude', prompt: 'Say hello', cwd: bridge.root, dangerous: false };
  const limited = await bridge.request('/api/oneshot', base);
  assert.equal(limited.body.rate_limited, true, JSON.stringify(limited.body)); assert.equal(count(), 1);
  const cooling = await bridge.request('/api/oneshot', { ...base, funding: envelope({ profileId: 'one', fallback: 'subscription' }) });
  assert.equal(cooling.status, 409); assert.equal(cooling.body.failureClass, 'provider_cooldown', JSON.stringify(cooling.body));
  assert.equal(cooling.body.model_invocation, false); assert.equal(count(), 1);
  assertRejectedFunding(cooling.body, true);
});
