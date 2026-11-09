'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createQualificationAuthority, isQualificationAuthority, isBrandedQualification } = require('../lib/api-agent-qualification');
const { createPrepaidAuthority, isPrepaidAuthority, isPrepaidResult, credentialHmac, PREPAID_POLICY } = require('../lib/prepaid-authorization');

const PROFILE = { id: 'one', provider: 'openai', revision: 3, organization: { ref: 'org_one' }, project: { ref: 'proj_one' },
  credentialRef: { type: 'reserved_env', name: 'RELAYBRIDGE_OPENAI_CREDIT_API_KEY' } };
const KEY = 'sk-test-qualification-sentinel';

test('the adapterless production authority never qualifies and never reads the credential', () => {
  const authority = createQualificationAuthority({ adapters: Object.freeze({}) });
  assert.ok(isQualificationAuthority(authority));
  let calls = 0;
  for (const provider of ['claude', 'openai']) {
    const result = authority.verify({ provider, profile: { ...PROFILE, provider }, credentialSource: () => { calls++; return { value: KEY, fingerprint: 'f' }; }, now: Date.now() });
    assert.ok(isBrandedQualification(result)); assert.equal(result.qualified, false);
  }
  assert.equal(calls, 0);
});

test('grant qualifications and prepaid permit results are not interchangeable', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-qualification-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const now = Date.parse('2026-11-10T12:00:00.000Z');
  const file = path.join(dataDir, 'prepaid-authorization.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, authorizationId: 'pa_q', policy: PREPAID_POLICY, provider: 'openai',
    surface: 'openai_responses_agent', supervised: true, noPurchases: true, profileId: 'one', profileRevision: 3, organization: 'org_one',
    project: 'proj_one', credentialHmac: credentialHmac('pa_q', KEY), models: ['gpt-5'], issuedAt: '2026-11-10T11:59:00.000Z',
    expiresAt: '2026-11-11T10:59:00.000Z', revokedAt: null,
    providerControls: { autoReload: 'off', hardLimitCents: 12000, hardLimitScope: 'project', hardLimitEnforced: true, observedAt: '2026-11-10T11:00:00.000Z' },
    balance: { observedBalanceCents: 20100, observedAt: '2026-11-10T11:00:00.000Z', earliestCreditExpiry: '2026-11-12' } }), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  const prepaid = createPrepaidAuthority({ dataDir });
  const grant = createQualificationAuthority({ adapters: { openai: () => ({ qualified: true, qualificationId: 'q_test' }) } });
  const source = () => ({ value: KEY, fingerprint: 'hmac-sha256:' + 'c'.repeat(64) });
  const permit = prepaid.verify({ provider: 'openai', profile: PROFILE, credentialSource: source, now });
  const qualification = grant.verify({ provider: 'openai', profile: PROFILE, credentialSource: source, now });
  assert.equal(permit.allowed, true); assert.equal(qualification.qualified, true);
  assert.equal(isBrandedQualification(permit), false); assert.equal(isPrepaidResult(qualification), false);
  assert.equal(isQualificationAuthority(prepaid), false); assert.equal(isPrepaidAuthority(grant), false);
  assert.equal(Object.hasOwn(permit, 'qualified'), false); assert.equal(Object.hasOwn(qualification, 'allowed'), false);
});
