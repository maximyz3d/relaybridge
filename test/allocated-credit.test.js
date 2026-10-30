'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { allocatedCreditStatus, creditSetup, CREDIT_SECRET_NAMES } = require('../lib/allocated-credit');
const { startTestBridge } = require('./helpers/temporary-bridge');

test('a key never enables unverified funding; policy preserves the final 2% after included credits', () => {
  const env = Object.fromEntries(CREDIT_SECRET_NAMES.map((key) => [key, 'private-fixture-secret']));
  const status = allocatedCreditStatus(env);
  assert.equal(status.policy.thresholdPercent, 2);
  assert.deepEqual(status.policy.order, ['subscription', 'included_api_credit', 'subscription_reserve', 'stop']);
  assert.equal(status.policy.reserveRelease, 'only_after_provider_verified_included_credit_exhaustion');
  assert.equal(status.automationAvailable, false);
  for (const info of Object.values(status.providers)) {
    assert.equal(info.apiKeyPresent, true);
    assert.equal(info.dispatchAllowed, false);
  }
  assert.equal(JSON.stringify(status).includes('private-fixture-secret'), false);
  assert.equal(allocatedCreditStatus({}).providers.claude.apiKeyPresent, false);
  assert.match(creditSetup('openai').limitation, /Codex API-key usage is excluded/);
  assert.throws(() => creditSetup('toString'));
});

test('real server rejects credit claims before CLI/HTTP/session dispatch and records zero invocation', async (t) => {
  let marker;
  const bridge = await startTestBridge(t, (root) => {
    marker = path.join(root, 'invoked');
    const file = path.join(root, 'fake.js');
    fs.writeFileSync(file, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'called');`);
    const slot = [process.execPath, file, '{prompt}'];
    const fixture = { label: 'offline fixture', safe: slot, dangerous: slot,
      oneshot_safe: slot, oneshot_dangerous: slot, capabilities: ['prompt'] };
    return { ordinary: fixture, claude_credit: fixture, openai_responses_credit: fixture,
      alias: { ...fixture, billing_mode: 'allocated_credit_only' },
      key_alias: { ...fixture, api_key_env_aliases: ['relaybridge_openai_credit_api_key'] },
      http_alias: { label: 'blocked HTTP', oneshot_adapter: 'openai_chat_api',
        funding_route: 'allocated_api_credit', api_url: 'http://127.0.0.1:1/never' } };
  });
  const status = await bridge.request('/api/allocated-credit');
  assert.equal(status.status, 200);
  assert.equal(status.body.automationAvailable, false);
  const unauthorized = await fetch(bridge.base + '/api/allocated-credit');
  assert.equal(unauthorized.status, 401);
  for (const preference of [{ mode: 'auto' }, { mode: 'off' },
    { mode: 'manual', manualTarget: 'subscription' }, { mode: 'manual', manualTarget: 'included_api_credit' }]) {
    assert.equal((await bridge.request('/api/settings/allocated-credit', preference, { method: 'PUT' })).status, 200);
    for (const kind of ['claude_credit', 'openai_responses_credit', 'alias', 'key_alias', 'http_alias', 'ordinary']) {
      const requestId = 'credit-test:' + preference.mode + ':' + (preference.manualTarget || '') + ':' + kind;
      const result = await bridge.request('/api/oneshot', { requestId, kind, prompt: 'must not run', cwd: bridge.root,
        ...(kind === 'ordinary' ? { funding_route: 'allocated_api_credit' } : {}) });
      assert.equal(result.status, 409, JSON.stringify(result.body));
      assert.equal(result.body.failureClass, 'allocated_credit_unavailable');
      assert.equal(result.body.model_invocation, false);
      assert.equal(result.body.physical_attempt_count, 0);
      assert.equal(result.body.receiptPersisted, true);
      assert.ok(result.body.receiptId);
    }
    for (const kind of ['claude_credit', 'alias', 'ordinary']) {
      const result = await bridge.request('/api/sessions', { kind, cwd: bridge.root,
        ...(kind === 'ordinary' ? { billing_mode: 'allocated_credit_only' } : {}) });
      assert.equal(result.status, 400);
      assert.equal(result.body.errorCode, 'allocated_credit_unavailable');
    }
  }
  assert.equal(fs.existsSync(marker), false);
});

test('ordinary child environments drop dedicated credit secrets including case variants and config overrides', async (t) => {
  const mixedCase = 'relaybridge_openai_credit_api_key';
  const secretEnv = Object.fromEntries([...CREDIT_SECRET_NAMES, mixedCase].map((name) => [name, 'do-not-inherit']));
  const bridge = await startTestBridge(t, (root) => {
    const file = path.join(root, 'env.js');
    fs.writeFileSync(file, `console.log(JSON.stringify(Object.keys(process.env).filter(k => /relaybridge_.*_credit_api_key/i.test(k))));`);
    const slot = [process.execPath, file, '{prompt}'];
    return { ordinary: { label: 'offline env fixture', safe: slot, dangerous: slot,
      oneshot_safe: slot, oneshot_dangerous: slot, oneshot_env: secretEnv, capabilities: ['prompt'] } };
  }, { env: secretEnv });
  const result = await bridge.request('/api/oneshot', { kind: 'ordinary', prompt: 'list names only', cwd: bridge.root });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(JSON.parse(result.body.stdout), []);
  const status = await bridge.request('/api/allocated-credit');
  assert.equal(status.body.providers.claude.apiKeyPresent, true);
  assert.equal(JSON.stringify(status.body).includes('do-not-inherit'), false);
});

test('CLI setup works offline, never accepts credentials, and distinguishes Codex eligibility', () => {
  const cli = path.resolve(__dirname, '../bin/relaybridge.js');
  const output = execFileSync(process.execPath, [cli, 'credit', 'setup', 'openai', '--json'], {
    encoding: 'utf8', env: { ...process.env, RELAYBRIDGE_URL: 'http://127.0.0.1:1' },
  });
  const result = JSON.parse(output);
  assert.equal(result.activationAvailable, false);
  assert.match(result.limitation, /excluded/);
});
