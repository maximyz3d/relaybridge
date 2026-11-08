'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApiAgentDispatcher } = require('../lib/api-agent-dispatch');
const { createCheckpointStore } = require('../lib/api-agent-checkpoint');
const { createReadOnlyTools } = require('../lib/api-agent-tools');
const { resolveFundingRoute } = require('../lib/funding-routing');
const { createCreditLedger } = require('../lib/credit-ledger');
const prepaid = require('../lib/prepaid-authorization');
const promo = require('../lib/promotional-authorization');
const { CREDIT_SECRET_NAMES } = require('../lib/allocated-credit');
const { startFakeProvider, reply } = require('./helpers/fake-provider-api');

const KEY = 'sk-test-ledger-dispatch-0123456789ab';
const MODEL = { claude: { model: 'claude-opus-5-5', effort: 'medium' }, openai: { model: 'gpt-6.1-sol', effort: 'low' } };
const API_MODEL = { claude: 'claude-opus-5-5', openai: 'gpt-6.1-sol' };
const NOW = { openai: Date.parse('2026-11-12T00:00:00.000Z'), claude: Date.parse('2026-11-03T00:00:00.000Z') };
const RATES = { inputCentsPerMTok: 300, outputCentsPerMTok: 1500, cacheWriteCentsPerMTok: 375, cacheReadCentsPerMTok: 30 };
const ok = (provider, spec) => ({ status: 200, json: reply(provider, spec) });
const READ = (p) => ({ name: 'read_file', input: { path: p, offset: null, length: null } });

function permitFor(provider, patch = {}, ledger = {}) {
  const l = { budgetCents: 10000, reserveCents: 1500, pricing: { [API_MODEL[provider]]: RATES }, ...ledger };
  if (provider === 'openai') {
    const id = 'pa_disp_1';
    return { schemaVersion: 2, authorizationId: id, policy: prepaid.PREPAID_POLICY, provider, surface: 'openai_responses_agent', supervised: true, noPurchases: true,
      profileId: 'one', profileRevision: 3, organization: 'org_fixture', project: 'proj_fixture', credentialHmac: prepaid.credentialHmac(id, KEY),
      models: ['gpt-6.1-sol'], issuedAt: '2026-11-10T11:59:00.000Z', expiresAt: '2026-11-17T11:59:00.000Z', revokedAt: null,
      providerControls: { autoReload: 'off', hardLimitCents: 12000, hardLimitScope: 'organization', hardLimitEnforced: true, observedAt: '2026-11-10T10:59:00.000Z' },
      balance: { observedBalanceCents: 20100, observedAt: '2026-11-10T10:59:00.000Z', earliestCreditExpiry: '2026-11-30' }, ledger: l, ...patch };
  }
  const id = 'pp_disp_1';
  return { schemaVersion: 2, authorizationId: id, policy: promo.PROMOTIONAL_POLICY, provider, surface: 'claude_messages_agent', supervised: true, noPurchases: true,
    profileId: 'one', profileRevision: 3, organization: 'org_fixture', workspace: 'proj_fixture', credentialHmac: prepaid.credentialHmac(id, KEY),
    models: ['claude-opus-5-5'], issuedAt: '2026-11-02T11:59:00.000Z', expiresAt: '2026-11-09T11:59:00.000Z', revokedAt: null,
    providerControls: { autoReload: 'off', billingMode: 'pay_as_you_go', operatorSpendLimitCents: 12000, operatorSpendLimitScope: 'organization', operatorSpendLimitActive: true, observedAt: '2026-11-02T11:00:00.000Z' },
    balance: { observedPromotionalCents: 19999, observedPurchasedCents: 370, observedMonthSpendCents: 0, promotionalExpiry: '2026-11-20', observedAt: '2026-11-02T11:00:00.000Z' }, ledger: l, ...patch };
}

async function setup(t, provider, script, { permit = permitFor(provider), withLedger = true } = {}) {
  const respond = typeof script === 'function' ? script : (req) => script[Math.min(req.index, script.length) - 1];
  const fake = await startFakeProvider(t, { provider, respond });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-ledger-disp-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'ws'); fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, 'README.md'), 'hello\n');
  const dataDir = path.join(base, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, provider === 'openai' ? 'prepaid-authorization.json' : 'promotional-authorization.json');
  if (permit) fs.writeFileSync(file, JSON.stringify(permit), { mode: 0o600 });
  const store = createCheckpointStore({ dataDir });
  const ledger = createCreditLedger({ dataDir });
  const registry = new Map();
  const snapshot = { storeState: 'valid', selected: { profileId: 'one', profileRevision: 3 }, profiles: [{ id: 'one', provider, revision: 3,
    subscription: { kind: provider === 'claude' ? 'claude' : 'codex', accountId: 'default' }, organization: { ref: 'org_fixture' }, project: { ref: 'proj_fixture' },
    credentialRef: { type: 'reserved_env', name: CREDIT_SECRET_NAMES[provider === 'claude' ? 0 : 1] },
    creditPeriod: { start: '2020-01-01T00:00:00.000Z', end: '2099-01-01T00:00:00.000Z' } }] };
  const env = { provider, fake, store, ledger, dataDir, file, delivered: [], releases: 0 };
  env.decide = (patch = {}) => resolveFundingRoute({ envelope: { route: provider === 'openai' ? 'authorized_prepaid' : 'authorized_promotional', fallback: 'none' }, snapshot,
    kind: provider === 'claude' ? 'claude' : 'codex', entry: { transport: provider === 'claude' ? 'subscription:anthropic' : 'subscription:chatgpt' },
    credentialSourceFor: () => () => ({ value: KEY, fingerprint: store.fingerprint(KEY) }), now: NOW[provider],
    ...(provider === 'openai' ? { prepaidAuthority: prepaid.createPrepaidAuthority({ dataDir }) } : { promotionalAuthority: promo.createPromotionalAuthority({ dataDir }) }), ...patch });
  env.dispatcher = createApiAgentDispatcher({ fetchImpl: fake.fetchImpl, store, registry, ...(withLedger ? { creditLedger: ledger } : {}),
    readCredential: () => KEY, createTools: () => createReadOnlyTools({ cwd }) });
  env.common = (patch = {}) => ({ admission: { resolveDecision: env.decide, cwd, cwdIdentityHash: 'cwd-identity-1' }, ...MODEL[provider],
    kind: provider === 'claude' ? 'claude' : 'codex', deliver: async (r) => { env.delivered.push(r); }, releaseAdmission: () => { env.releases++; }, ...patch });
  env.summary = () => ledger.summary({ authorizationId: provider === 'openai' ? 'pa_disp_1' : 'pp_disp_1' });
  return env;
}

for (const provider of ['claude', 'openai']) {
  test(`${provider}: permit-only run settles each turn in the ledger and the receipt carries the ledger, no secrets`, async (t) => {
    const env = await setup(t, provider, [ok(provider, { tools: [READ('README.md')] }), ok(provider, { text: 'done' })]);
    const receipt = await env.dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'read it', route: { mode: 'oneshot' } });
    assert.equal(receipt.exitCode, 0, JSON.stringify(receipt.route.api_agent));
    assert.equal(env.fake.requests.length, 2);
    const f = receipt.route.funding, runId = receipt.route.run_id;
    assert.equal(f.ledger.budgetCents, 10000); assert.equal(f.ledger.reserveCents, 1500);
    assert.equal(f.ledger.heldCents, 0); assert.equal(f.ledger.exhausted, false);
    assert.equal(f.ledger.turns.length, 2);
    for (const [i, turn] of f.ledger.turns.entries()) {
      assert.equal(turn.requestKey, `${runId}:${i + 1}`); assert.equal(turn.disposition, 'settled');
      assert.ok(turn.reservedCents > 0 && turn.chargedCents >= 1 && turn.chargedCents <= turn.reservedCents); assert.ok(turn.usage);
    }
    assert.equal(f.ledger.spentCents, f.ledger.turns.reduce((n, x) => n + x.chargedCents, 0));
    assert.equal(f.ledger.remainingCents, 10000 - f.ledger.spentCents);
    assert.equal(f.authorizationId, provider === 'openai' ? 'pa_disp_1' : 'pp_disp_1');
    const text = JSON.stringify(receipt);
    for (const secret of [KEY, permitFor(provider).credentialHmac]) assert.ok(!text.includes(secret));
    // durable receipts: provider/org/scope/authorizationId/evidence/charge/disposition
    const lines = fs.readFileSync(path.join(env.dataDir, 'credit-ledger', 'receipts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    for (const line of lines) {
      for (const k of ['provider', 'organization', 'authorizationId', 'chargedCents', 'disposition']) assert.ok(k in line, k);
      assert.ok('scope' in line && 'evidence' in line);
      assert.ok(!JSON.stringify(line).includes(KEY));
    }
  });

  test(`${provider}: a local budget below the estimate sends nothing`, async (t) => {
    const env = await setup(t, provider, [ok(provider, { text: 'never' })], { permit: permitFor(provider, {}, { budgetCents: 100 }) });
    const receipt = await env.dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'x' });
    assert.equal(env.fake.requests.length, 0);
    assert.equal(receipt.failureClass, 'funding_exhausted'); assert.equal(receipt.model_invocation, false);
    assert.equal(receipt.route.api_agent.turns.filter((x) => x.state !== 'not_sent').length, 0);
    assert.ok(env.summary() === null || env.summary().spentCents === 0);
  });
}

test('openai: a provider funding error exhausts the ledger, so a later run sends nothing', async (t) => {
  const env = await setup(t, 'openai', (req) => ({ status: 429, json: { error: { type: 'insufficient_quota', code: 'credit_balance_exhausted', message: 'out' } } }));
  const first = await env.dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'x' });
  assert.equal(first.failureClass, 'funding_exhausted'); assert.equal(env.fake.requests.length, 1);
  const s = env.summary(); assert.equal(s.exhausted, true); assert.equal(s.spentCents, 0); assert.equal(s.turns[0].disposition, 'provider_error');
  const second = await env.dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'y' });
  assert.equal(second.failureClass, 'funding_exhausted'); assert.equal(env.fake.requests.length, 1);
});

test('claude: a spend-limit provider error exhausts the ledger', async (t) => {
  const env = await setup(t, 'claude', () => ({ status: 429, json: { type: 'error', error: { type: 'rate_limit_error', message: 'x', details: { error_code: 'enforced_spend_limit_reached' } } } }));
  const first = await env.dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'x' });
  assert.equal(first.failureClass, 'spend_limit'); assert.equal(env.summary().exhausted, true);
  await env.dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'y' });
  assert.equal(env.fake.requests.length, 1);
});

test('a rate_limited turn is not charged, and the resumed retry takes a fresh reservation', async (t) => {
  const env = await setup(t, 'openai', (req) => req.index === 1
    ? { status: 429, json: { error: { type: 'requests', code: 'rate_limit_exceeded', message: 'slow' } } } : ok('openai', { text: 'fine' }));
  const first = await env.dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'x' });
  assert.equal(first.failureClass, 'rate_limited'); assert.equal(env.summary().exhausted, false); assert.equal(env.summary().spentCents, 0);
  const runId = first.route.api_agent.checkpoint_run_id;
  const resumed = await env.dispatcher.resumeApiAgentRun({ ...env.common(), runId });
  assert.equal(resumed.exitCode, 0);
  const keys = env.summary().turns.map((x) => x.requestKey + ':' + x.disposition);
  assert.deepEqual(keys, [`run_${runId}:1:provider_error`, `run_${runId}:2:settled`]);
});

test('an uncertain outcome charges its reservation and is never re-sent', async (t) => {
  const env = await setup(t, 'claude', () => ({ destroy: true }));
  const receipt = await env.dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'x' });
  assert.equal(receipt.failureClass, 'outcome_uncertain');
  const s = env.summary(); assert.equal(s.turns[0].disposition, 'outcome_uncertain');
  assert.equal(s.spentCents, s.turns[0].reservedCents); assert.ok(s.spentCents > 0); assert.equal(s.heldCents, 0);
  const runId = receipt.route.api_agent.checkpoint_run_id;
  const again = await env.dispatcher.resumeApiAgentRun({ ...env.common(), runId });
  assert.equal(again.failureClass, 'outcome_uncertain'); assert.equal(env.fake.requests.length, 1); assert.equal(env.summary().spentCents, s.spentCents);
});

test('a v2 permit without a configured ledger sends nothing', async (t) => {
  const env = await setup(t, 'openai', [ok('openai', { text: 'never' })], { withLedger: false });
  await assert.rejects(env.dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'x' }), { code: 'credit_ledger_unavailable' });
  assert.equal(env.fake.requests.length, 0); assert.equal(env.releases, 1);
});

test('missing, expired and revoked permits never dispatch', async (t) => {
  for (const provider of ['openai', 'claude']) {
    const missing = await setup(t, provider, [ok(provider, { text: 'x' })], { permit: null });
    assert.equal(missing.decide().apiDispatchAllowed, false);
    const revoked = await setup(t, provider, [ok(provider, { text: 'x' })], { permit: permitFor(provider, { revokedAt: '2026-11-01T00:00:00.000Z' }) });
    assert.equal(revoked.decide().apiDispatchAllowed, false);
    const expired = await setup(t, provider, [ok(provider, { text: 'x' })]);
    assert.equal(expired.decide({ now: NOW[provider] + 8 * 24 * 3600 * 1000 }).apiDispatchAllowed, false);
    await assert.rejects(expired.dispatcher.runApiAgentOneShot({ ...expired.common({ admission: { resolveDecision: () => expired.decide({ now: NOW[provider] + 8 * 24 * 3600 * 1000 }),
      cwd: '/tmp', cwdIdentityHash: 'x' } }), prompt: 'x' }));
    assert.equal(expired.fake.requests.length, 0);
  }
});

function wrapLedger(real, overrides) {
  return { reserve: (...a) => (overrides.reserve ?? real.reserve)(...a), settle: (...a) => (overrides.settle ?? real.settle)(...a),
    markExhausted: (...a) => (overrides.markExhausted ?? real.markExhausted)(...a), summary: (...a) => real.summary(...a) };
}

test('openai: markExhausted failing after a funding error fails closed in-process and surfaces the ledger error', async (t) => {
  const id = 'pa_disp_failclosed';
  const permit = permitFor('openai', { authorizationId: id, credentialHmac: prepaid.credentialHmac(id, KEY) });
  const env = await setup(t, 'openai', () => ({ status: 429, json: { error: { type: 'insufficient_quota', code: 'credit_balance_exhausted', message: 'out' } } }), { permit });
  let calls = 0;
  const bad = wrapLedger(env.ledger, { markExhausted: () => { calls++; throw Object.assign(new Error('x'), { code: 'credit_ledger_locked' }); } });
  const dispatcher = createApiAgentDispatcher({ fetchImpl: env.fake.fetchImpl, store: env.store, registry: new Map(), creditLedger: bad,
    readCredential: () => KEY, createTools: () => createReadOnlyTools({ cwd: env.common().admission.cwd }) });
  const first = await dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'x' });
  assert.equal(first.failureClass, 'funding_exhausted'); assert.equal(calls, 2);
  assert.equal(first.route.funding.ledgerError, 'credit_ledger_locked');
  assert.equal(env.fake.requests.length, 1);
  const second = await dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'y' });
  assert.equal(second.failureClass, 'funding_exhausted'); assert.equal(env.fake.requests.length, 1);
});

test('claude: a reservation is settled not_sent when markDispatched refuses after a successful reserve', async (t) => {
  const env = await setup(t, 'claude', [ok('claude', { text: 'never' })]);
  const ac = new AbortController();
  const racing = wrapLedger(env.ledger, { reserve: (a) => { const r = env.ledger.reserve(a); ac.abort(); return r; } });
  const dispatcher = createApiAgentDispatcher({ fetchImpl: env.fake.fetchImpl, store: env.store, registry: new Map(), creditLedger: racing,
    readCredential: () => KEY, createTools: () => createReadOnlyTools({ cwd: env.common().admission.cwd }) });
  await dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'x', signal: ac.signal });
  assert.equal(env.fake.requests.length, 0);
  const s = env.summary();
  assert.equal(s.heldCents, 0); assert.equal(s.spentCents, 0);
  assert.ok(s.turns.every((x) => x.disposition === 'not_sent'));
});
