'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const prepaid = require('../lib/prepaid-authorization');
const promo = require('../lib/promotional-authorization');
const { resolveFundingRoute, isApiDecision } = require('../lib/funding-routing');
const { createQualificationAuthority } = require('../lib/api-agent-qualification');

const OKEY = 'sk-test-openai-v2-sentinel-0123456789', CKEY = 'sk-ant-test-claude-v2-sentinel-0123456789';
const FP = 'hmac-sha256:' + 'd'.repeat(64);
const RATES = (o = {}) => ({ inputCentsPerMTok: 300, outputCentsPerMTok: 1500, cacheWriteCentsPerMTok: 375, cacheReadCentsPerMTok: 30, ...o });
function openaiPermit(patch = {}, ledger = {}) {
  const id = patch.authorizationId || 'pa_v2_1';
  return { schemaVersion: 2, authorizationId: id, policy: prepaid.PREPAID_POLICY, provider: 'openai', surface: 'openai_responses_agent',
    supervised: true, noPurchases: true, profileId: 'one', profileRevision: 3, organization: 'org_one', project: 'proj_one',
    credentialHmac: prepaid.credentialHmac(id, OKEY), models: ['gpt-6.1-sol'], issuedAt: '2026-11-10T11:59:00.000Z',
    expiresAt: '2026-11-17T11:59:00.000Z', revokedAt: null,
    providerControls: { autoReload: 'off', hardLimitCents: 12000, hardLimitScope: 'organization', hardLimitEnforced: true, observedAt: '2026-11-10T10:59:00.000Z' },
    balance: { observedBalanceCents: 20100, observedAt: '2026-11-10T10:59:00.000Z', earliestCreditExpiry: '2026-11-30' },
    ledger: { budgetCents: 10000, reserveCents: 1500, pricing: { 'gpt-6.1-sol': RATES() }, ...ledger }, ...patch };
}
function claudePermit(patch = {}, ledger = {}) {
  const id = patch.authorizationId || 'pp_v2_1';
  return { schemaVersion: 2, authorizationId: id, policy: promo.PROMOTIONAL_POLICY, provider: 'claude', surface: 'claude_messages_agent',
    supervised: true, noPurchases: true, profileId: 'one', profileRevision: 3, organization: 'org_one', workspace: 'proj_one',
    credentialHmac: prepaid.credentialHmac(id, CKEY), models: ['claude-sonnet-5-5'], issuedAt: '2026-11-02T11:59:00.000Z',
    expiresAt: '2026-11-09T11:59:00.000Z', revokedAt: null,
    providerControls: { autoReload: 'off', billingMode: 'pay_as_you_go', operatorSpendLimitCents: 12000,
      operatorSpendLimitScope: 'organization', operatorSpendLimitActive: true, observedAt: '2026-11-02T11:00:00.000Z' },
    balance: { observedPromotionalCents: 19999, observedPurchasedCents: 370, observedMonthSpendCents: 0, promotionalExpiry: '2026-11-20', observedAt: '2026-11-02T11:00:00.000Z' },
    ledger: { budgetCents: 10000, reserveCents: 1500, pricing: { 'claude-sonnet-5-5': RATES() }, ...ledger }, ...patch };
}
const bad = (v, fn, code) => assert.throws(() => fn(v), { code });

test('OpenAI v2 permit validates; v1 still validates without a ledger; v2 needs a ledger', () => {
  const p = openaiPermit();
  assert.equal(prepaid.validateAuthorization(p), p);
  const { ledger, ...rest } = p;
  bad({ ...rest }, prepaid.validateAuthorization, 'prepaid_authorization_invalid');
  bad({ ...p, schemaVersion: 1 }, prepaid.validateAuthorization, 'prepaid_authorization_invalid'); // v1 is closed: no ledger key
  bad({ ...p, schemaVersion: 3 }, prepaid.validateAuthorization, 'prepaid_authorization_invalid');
  bad({ ...p, ledger: { ...p.ledger, extra: 1 } }, prepaid.validateAuthorization, 'prepaid_authorization_invalid');
});

test('OpenAI v2: window up to 7 days only, budget+reserve bounded by min(balance, hard limit), reserve floor, auto-reload off', () => {
  const v = prepaid.validateAuthorization;
  assert.doesNotThrow(() => v(openaiPermit({ expiresAt: '2026-11-17T11:59:00.000Z' })));
  bad(openaiPermit({ expiresAt: '2026-11-17T11:59:00.001Z' }), v, 'prepaid_authorization_invalid');
  assert.doesNotThrow(() => v(openaiPermit({}, { budgetCents: 10500, reserveCents: 1500 }))); // == 12000 basis
  bad(openaiPermit({}, { budgetCents: 10501, reserveCents: 1500 }), v, 'prepaid_authorization_invalid'); // purchased exposure
  bad(openaiPermit({}, { reserveCents: 599, budgetCents: 1000 }), v, 'prepaid_authorization_invalid'); // 5% of 12000
  assert.doesNotThrow(() => v(openaiPermit({}, { reserveCents: 600, budgetCents: 1000 })));
  bad(openaiPermit({ providerControls: { ...openaiPermit().providerControls, autoReload: 'on' } }), v, 'prepaid_authorization_invalid');
  bad(openaiPermit({ providerControls: { ...openaiPermit().providerControls, autoReload: undefined } }), v, 'prepaid_authorization_invalid');
  // credit expiry still caps the window
  bad(openaiPermit({ balance: { ...openaiPermit().balance, earliestCreditExpiry: '2026-11-15' } }), v, 'prepaid_authorization_invalid');
  // monthly reset still caps the window
  bad(openaiPermit({ issuedAt: '2026-11-29T11:59:00.000Z', expiresAt: '2026-12-02T11:59:00.000Z', providerControls: { ...openaiPermit().providerControls, observedAt: '2026-11-29T10:00:00.000Z' },
    balance: { ...openaiPermit().balance, observedAt: '2026-11-29T10:00:00.000Z', earliestCreditExpiry: '2026-12-31' } }), v, 'prepaid_authorization_invalid');
  // a stale observation is still refused
  bad(openaiPermit({ balance: { ...openaiPermit().balance, observedAt: '2026-11-09T11:00:00.000Z' } }), v, 'prepaid_authorization_invalid');
});

test('v2 pricing keys equal models exactly, rates are positive integers, only OpenAI cacheWrite may be 0', () => {
  const v = prepaid.validateAuthorization, c = promo.validateAuthorization;
  bad(openaiPermit({}, { pricing: {} }), v, 'prepaid_authorization_invalid');
  bad(openaiPermit({}, { pricing: { 'gpt-6.1-sol': RATES(), 'gpt-6-astra': RATES() } }), v, 'prepaid_authorization_invalid');
  bad(openaiPermit({}, { pricing: { 'gpt-6-astra': RATES() } }), v, 'prepaid_authorization_invalid');
  bad(openaiPermit({}, { pricing: { 'gpt-6.1-sol': RATES({ inputCentsPerMTok: 0 }) } }), v, 'prepaid_authorization_invalid');
  bad(openaiPermit({}, { pricing: { 'gpt-6.1-sol': RATES({ cacheReadCentsPerMTok: 0 }) } }), v, 'prepaid_authorization_invalid');
  bad(openaiPermit({}, { pricing: { 'gpt-6.1-sol': RATES({ outputCentsPerMTok: 1.5 }) } }), v, 'prepaid_authorization_invalid');
  bad(openaiPermit({}, { pricing: { 'gpt-6.1-sol': { ...RATES(), extra: 1 } } }), v, 'prepaid_authorization_invalid');
  assert.doesNotThrow(() => v(openaiPermit({}, { pricing: { 'gpt-6.1-sol': RATES({ cacheWriteCentsPerMTok: 0 }) } })));
  bad(claudePermit({}, { pricing: { 'claude-sonnet-5-5': RATES({ cacheWriteCentsPerMTok: 0 }) } }), c, 'promotional_authorization_invalid');
  bad(claudePermit({}, { pricing: { 'claude-sonnet-5-5': RATES({ inputCentsPerMTok: -1 }) } }), c, 'promotional_authorization_invalid');
  bad(claudePermit({ models: ['claude-sonnet-5-5', 'claude-opus-5-5'] }), c, 'promotional_authorization_invalid'); // pricing missing opus
});

test('Claude v2: basis excludes purchased credit and is capped by the remaining operator spend limit', () => {
  const v = promo.validateAuthorization;
  assert.equal(v(claudePermit()).schemaVersion, 2);
  bad(claudePermit({}, { budgetCents: 10501 }), v, 'promotional_authorization_invalid'); // limit 12000 < promo 19999
  assert.doesNotThrow(() => v(claudePermit({}, { budgetCents: 10500 })));
  // month spend shrinks the headroom: basis = 12000 - 3000 = 9000
  const spent = (ledger) => claudePermit({ balance: { ...claudePermit().balance, observedMonthSpendCents: 3000 } }, ledger);
  bad(spent({ budgetCents: 7501 }), v, 'promotional_authorization_invalid');
  assert.doesNotThrow(() => v(spent({ budgetCents: 7500 })));
  // purchased credit never enlarges the basis
  bad(claudePermit({ balance: { ...claudePermit().balance, observedPurchasedCents: 100000 } }, { budgetCents: 10501 }), v, 'promotional_authorization_invalid');
  bad(claudePermit({}, { reserveCents: 99, budgetCents: 100 }), v, 'promotional_authorization_invalid');
  bad(claudePermit({ providerControls: { ...claudePermit().providerControls, autoReload: 'on' } }), v, 'promotional_authorization_invalid');
  bad(claudePermit({ expiresAt: '2026-11-09T11:59:00.001Z' }), v, 'promotional_authorization_invalid');
  // still must end 24h before the promotional credit expires
  bad(claudePermit({ balance: { ...claudePermit().balance, promotionalExpiry: '2026-11-09' } }), v, 'promotional_authorization_invalid');
});

function env(t, provider, permit) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-v2-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, provider === 'openai' ? 'prepaid-authorization.json' : 'promotional-authorization.json');
  fs.writeFileSync(file, JSON.stringify(permit), { mode: 0o600 });
  const snapshot = { storeState: 'valid', selected: { profileId: 'one', profileRevision: 3 }, profiles: [{ id: 'one', provider, revision: 3,
    subscription: { kind: provider === 'openai' ? 'codex' : 'claude', accountId: 'default' }, organization: { ref: 'org_one' }, project: { ref: 'proj_one' },
    credentialRef: { type: 'reserved_env', name: provider === 'openai' ? 'RELAYBRIDGE_OPENAI_CREDIT_API_KEY' : 'RELAYBRIDGE_ANTHROPIC_CREDIT_API_KEY' },
    creditPeriod: { start: '2020-01-01T00:00:00.000Z', end: '2099-01-01T00:00:00.000Z' } }] };
  const key = provider === 'openai' ? OKEY : CKEY;
  const route = (extra = {}, now = Date.parse(provider === 'openai' ? '2026-11-12T00:00:00.000Z' : '2026-11-03T00:00:00.000Z')) => resolveFundingRoute({
    envelope: { route: provider === 'openai' ? 'authorized_prepaid' : 'authorized_promotional', fallback: 'none' }, snapshot,
    kind: provider === 'openai' ? 'codex' : 'claude', entry: { transport: provider === 'openai' ? 'subscription:chatgpt' : 'subscription:anthropic' },
    credentialSourceFor: () => () => ({ value: key, fingerprint: FP }), now,
    ...(provider === 'openai' ? { prepaidAuthority: prepaid.createPrepaidAuthority({ dataDir }) } : { promotionalAuthority: promo.createPromotionalAuthority({ dataDir }) }), ...extra });
  return { dataDir, file, route };
}

test('v2 permits thread the ledger into the decision; v1 decisions carry no ledger key', (t) => {
  for (const [provider, make, v1] of [['openai', openaiPermit, (p) => { const { ledger, ...r } = p; return { ...r, schemaVersion: 1, expiresAt: '2026-11-11T10:59:00.000Z' }; }],
    ['claude', claudePermit, (p) => { const { ledger, ...r } = p; return { ...r, schemaVersion: 1, expiresAt: '2026-11-03T11:59:00.000Z' }; }]]) {
    const field = provider === 'openai' ? 'prepaid' : 'promotional';
    const e2 = env(t, provider, make());
    const d2 = e2.route();
    assert.equal(d2.apiDispatchAllowed, true, JSON.stringify(d2)); assert.ok(isApiDecision(d2));
    assert.equal(d2[field].ledger.budgetCents, 10000); assert.equal(d2[field].ledger.pricing[provider === 'openai' ? 'gpt-6.1-sol' : 'claude-sonnet-5-5'].outputCentsPerMTok, 1500);
    assert.ok(!d2[field].limitations.includes('no_local_spend_accounting')); assert.ok(!d2[field].limitations.includes('supervised_short_lived'));
    assert.ok(d2[field].limitations.includes('local_ledger_owner_declared_pricing')); assert.ok(d2[field].limitations.includes('supervised_bounded_window'));
    if (provider === 'claude') { assert.ok(d2.promotional.limitations.includes('not_grant_only')); assert.equal(d2.promotional.reserveRelease, 'never'); }
    const e1 = env(t, provider, v1(make()));
    const d1 = e1.route(provider === 'openai' ? {} : {}, Date.parse(provider === 'openai' ? '2026-11-10T12:00:00.000Z' : '2026-11-02T12:00:00.000Z'));
    assert.equal(d1.apiDispatchAllowed, true, JSON.stringify(d1));
    assert.ok(!Object.hasOwn(d1[field], 'ledger')); assert.ok(d1[field].limitations.includes('no_local_spend_accounting'));
  }
});

test('summaries expose the v2 ledger with no secrets; included_api_credit stays blocked with a v2 permit present', (t) => {
  const e = env(t, 'openai', openaiPermit());
  const authority = prepaid.createPrepaidAuthority({ dataDir: e.dataDir });
  const result = authority.verify({ provider: 'openai', profile: { id: 'one', provider: 'openai', revision: 3, organization: { ref: 'org_one' }, project: { ref: 'proj_one' },
    credentialRef: { name: 'x' } }, credentialSource: () => ({ value: OKEY, fingerprint: FP }), now: Date.parse('2026-11-12T00:00:00.000Z') });
  assert.ok(result.allowed, JSON.stringify(result));
  const s = prepaid.summarize(result);
  assert.equal(s.ledger.reserveCents, 1500); assert.equal(s.ledger.budgetCents, 10000);
  for (const secret of [OKEY, openaiPermit().credentialHmac, FP]) assert.ok(!JSON.stringify(s).includes(secret));
  // grant route: production authority has no adapters, so v2 permits never qualify it
  const grant = e.route({ envelope: { route: 'included_api_credit', fallback: 'none' }, qualificationAuthority: createQualificationAuthority({ adapters: {} }) });
  assert.equal(grant.apiDispatchAllowed, false); assert.equal(grant.blockedReason, 'grant_only_funding_unverified');
  assert.ok(!Object.hasOwn(grant, 'prepaid'));
});
