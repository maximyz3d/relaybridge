'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { credentialHmac } = require('../lib/prepaid-authorization');
const { PROMOTIONAL_POLICY, PROMOTIONAL_LIMITATIONS, validateAuthorization, createPromotionalAuthority,
  isPromotionalAuthority, isPromotionalResult, summarize } = require('../lib/promotional-authorization');

const KEY = 'sk-ant-test-promotional-sentinel-0123456789';
const FINGERPRINT = 'hmac-sha256:' + 'c'.repeat(64);
const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const PROFILE = Object.freeze({ id: 'claude-one', provider: 'claude', revision: 2, organization: { ref: 'org_claude' }, project: { ref: 'wrk_claude' },
  credentialRef: { type: 'reserved_env', name: 'RELAYBRIDGE_ANTHROPIC_CREDIT_API_KEY' } });

// Mirrors the owner's observed account: cap $120, promotional $199.99,
// purchased $3.70, nothing spent this month, auto-reload off, pay-as-you-go.
function permit(patch = {}) {
  const id = patch.authorizationId || 'pp_fixture_1';
  return { schemaVersion: 1, authorizationId: id, policy: PROMOTIONAL_POLICY, provider: 'claude', surface: 'claude_messages_agent',
    supervised: true, noPurchases: true, profileId: 'claude-one', profileRevision: 2, organization: 'org_claude', workspace: 'wrk_claude',
    credentialHmac: credentialHmac(id, KEY), models: ['claude-sonnet-5-5'], issuedAt: '2026-11-02T11:59:00.000Z',
    expiresAt: '2026-11-03T11:59:00.000Z', revokedAt: null,
    providerControls: { autoReload: 'off', billingMode: 'pay_as_you_go', operatorSpendLimitCents: 12000,
      operatorSpendLimitScope: 'organization', operatorSpendLimitActive: true, observedAt: '2026-11-02T11:00:00.000Z' },
    balance: { observedPromotionalCents: 19999, observedPurchasedCents: 370, observedMonthSpendCents: 0,
      promotionalExpiry: '2026-11-05', observedAt: '2026-11-02T11:00:00.000Z' }, ...patch };
}
const controls = (patch) => ({ ...permit().providerControls, ...patch });
const balance = (patch) => ({ ...permit().balance, ...patch });
// A window ending at `expiresAt`, issued `hours` earlier, observed just before issue.
function windowed(issuedAt, expiresAt, balancePatch = {}) {
  const observedAt = new Date(Date.parse(issuedAt) - 60_000).toISOString();
  return permit({ issuedAt, expiresAt, providerControls: controls({ observedAt }), balance: balance({ observedAt, ...balancePatch }) });
}

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-promotional-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'promotional-authorization.json');
  const write = (value, mode = 0o600) => {
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode });
    fs.chmodSync(file, mode);
  };
  const thunk = () => { thunk.calls++; return thunk.result; };
  thunk.calls = 0; thunk.result = { value: KEY, fingerprint: FINGERPRINT };
  const authority = createPromotionalAuthority({ dataDir });
  const verify = (patch = {}) => authority.verify({ provider: 'claude', profile: PROFILE, credentialSource: thunk, now: NOW, ...patch });
  return { dataDir, file, write, thunk, authority, verify };
}

test('a valid promotional permit verifies to a branded, secret-free result that is never grant-only', (t) => {
  const env = setup(t);
  env.write(permit());
  const result = env.verify();
  assert.equal(result.allowed, true, JSON.stringify(result)); assert.equal(result.reason, null);
  assert.ok(isPromotionalResult(result)); assert.ok(Object.isFrozen(result));
  assert.equal(result.provider, 'claude'); assert.equal(result.authorizationId, 'pp_fixture_1');
  assert.equal(result.credentialFingerprint, FINGERPRINT); assert.equal(result.reserveRelease, 'never');
  assert.deepEqual([...result.models], ['claude-sonnet-5-5']); assert.deepEqual([...result.limitations], [...PROMOTIONAL_LIMITATIONS]);
  for (const limitation of ['provider_cap_enforcement_lag', 'external_spend_unseen', 'dashboard_changes_unmonitored',
    'purchased_balance_at_risk_on_overshoot', 'not_grant_only']) assert.ok(PROMOTIONAL_LIMITATIONS.includes(limitation), limitation);
  assert.match(result.authorizationHash, /^[a-f0-9]{64}$/);
  assert.equal(env.verify().authorizationHash, result.authorizationHash);
  assert.equal(env.verify({ now: NOW + 3600_000 }).authorizationHash, result.authorizationHash);
  assert.equal(env.thunk.calls, 3);
  for (const secret of [KEY, permit().credentialHmac]) assert.ok(!JSON.stringify(result).includes(secret));
  const summary = summarize(result);
  assert.equal(summary.state, 'valid'); assert.equal(summary.policy, PROMOTIONAL_POLICY);
  assert.equal(summary.grantOnly, false); assert.equal(summary.reserveRelease, 'never'); assert.equal(summary.supervised, true);
  const text = JSON.stringify(summary);
  for (const secret of [KEY, permit().credentialHmac, FINGERPRINT]) assert.ok(!text.includes(secret));
  assert.equal(summarize({ ...result }).state, 'blocked');
  // A profile without a workspace matches a permit whose workspace is null.
  env.write(permit({ workspace: null }));
  assert.equal(env.verify({ profile: { ...PROFILE, project: undefined } }).allowed, true);
  assert.equal(env.verify().reason, 'promotional_scope_mismatch');
  // The authority never rewrites or repairs the file.
  assert.equal(fs.readFileSync(env.file, 'utf8'), JSON.stringify(permit({ workspace: null }), null, 2));
  assert.equal(fs.statSync(env.file).mode & 0o777, 0o600);
});

test('every schema rule failure is promotional_authorization_invalid and never reads the credential', (t) => {
  const env = setup(t);
  const { credentialHmac: _omit, ...missingKey } = permit();
  const cases = {
    extraKey: { ...permit(), note: 'x' }, missingKey, schemaVersion: permit({ schemaVersion: 2 }),
    prepaidId: permit({ authorizationId: 'pa_fixture_1' }), prepaidPolicy: permit({ policy: 'owner_authorized_prepaid' }),
    grantPolicy: permit({ policy: 'grant_only' }), openaiProvider: permit({ provider: 'openai' }),
    openaiSurface: permit({ surface: 'openai_responses_agent' }), supervised: permit({ supervised: false }), noPurchases: permit({ noPurchases: false }),
    revision: permit({ profileRevision: 0 }), hmacFormat: permit({ credentialHmac: 'sha256:abc' }), secretLikeRef: permit({ profileId: 'sk-ant-live' }),
    badWorkspace: permit({ workspace: '' }), noModels: permit({ models: [] }), openaiModel: permit({ models: ['gpt-6.1-sol'] }),
    unknownModel: permit({ models: ['claude-unknown'] }), duplicateModels: permit({ models: ['claude-opus-5-5', 'claude-opus-5-5'] }),
    nonCanonicalTime: permit({ issuedAt: '2026-11-02T11:59:00Z' }),
    over24h: permit({ expiresAt: '2026-11-03T11:59:00.001Z' }), emptyWindow: permit({ expiresAt: '2026-11-02T11:59:00.000Z' }),
    // Must end at least 24h before the promotional credit expires (2026-11-05T00:00Z).
    insidePromoExpiryDay: windowed('2026-11-03T12:00:00.000Z', '2026-11-04T00:00:00.001Z'),
    afterPromoExpiry: windowed('2026-11-04T12:00:00.000Z', '2026-11-05T06:00:00.000Z'),
    pastMonthReset: windowed('2026-11-30T12:00:00.000Z', '2026-12-01T06:00:00.000Z', { promotionalExpiry: '2026-12-31' }),
    impossibleDate: permit({ balance: balance({ promotionalExpiry: '2026-02-30' }) }),
    looseDate: permit({ balance: balance({ promotionalExpiry: '2026-11-5' }) }),
    controlsAfterIssue: permit({ providerControls: controls({ observedAt: '2026-11-02T12:30:00.000Z' }) }),
    staleControls: permit({ providerControls: controls({ observedAt: '2026-11-01T23:58:59.000Z' }) }),
    staleBalance: permit({ balance: balance({ observedAt: '2026-11-01T23:58:59.000Z' }) }),
    autoReloadOn: permit({ providerControls: controls({ autoReload: 'on' }) }),
    invoiced: permit({ providerControls: controls({ billingMode: 'invoice' }) }),
    workspaceScope: permit({ providerControls: controls({ operatorSpendLimitScope: 'workspace' }) }),
    limitInactive: permit({ providerControls: controls({ operatorSpendLimitActive: false }) }),
    zeroCap: permit({ providerControls: controls({ operatorSpendLimitCents: 0 }) }),
    fractionalCap: permit({ providerControls: controls({ operatorSpendLimitCents: 100.5 }) }),
    zeroPromotional: permit({ balance: balance({ observedPromotionalCents: 0 }) }),
    negativePurchased: permit({ balance: balance({ observedPurchasedCents: -1 }) }),
    negativeSpend: permit({ balance: balance({ observedMonthSpendCents: -1 }) }),
    // Remaining cap must be positive and at most 80% of the promotional balance.
    capExhausted: permit({ balance: balance({ observedMonthSpendCents: 12000 }) }),
    capOver80: permit({ balance: balance({ observedPromotionalCents: 14999 }) }),
    // Purchased balance never qualifies: a large purchased balance does not rescue a thin promotional one.
    purchasedDoesNotCount: permit({ balance: balance({ observedPromotionalCents: 14999, observedPurchasedCents: 1_000_000 }) }),
    controlsExtra: permit({ providerControls: { ...controls({}), spent: 0 } }),
    balanceExtra: permit({ balance: { ...balance({}), reserved: 1 } }),
    revokedNotIso: permit({ revokedAt: 'yesterday' }),
  };
  for (const [name, value] of Object.entries(cases)) {
    assert.throws(() => validateAuthorization(value), { code: 'promotional_authorization_invalid' }, name);
    env.write(value);
    const result = env.verify();
    assert.equal(result.allowed, false, name); assert.equal(result.reason, 'promotional_authorization_invalid', name);
  }
  for (const text of ['not json', '[]', 'null']) { env.write(text); assert.equal(env.verify().reason, 'promotional_authorization_invalid', text); }
  assert.equal(env.thunk.calls, 0);
  // Boundaries that are accepted: exactly 80%, spend already counted, the
  // last allowed end before promotional expiry and before the month reset.
  for (const value of [permit({ balance: balance({ observedPromotionalCents: 15000 }) }),
    permit({ balance: balance({ observedPromotionalCents: 14999, observedMonthSpendCents: 1 }) }),
    windowed('2026-11-03T12:00:00.000Z', '2026-11-04T00:00:00.000Z'),
    windowed('2026-11-30T12:00:00.000Z', '2026-12-01T00:00:00.000Z', { promotionalExpiry: '2026-12-31' }),
    permit({ models: ['claude-opus-5-5', 'claude-sonnet-5-5'], workspace: null })]) {
    assert.doesNotThrow(() => validateAuthorization(value), JSON.stringify(value));
  }
});

test('the promotional permit file must be a private regular file owned by this user', { skip: process.platform === 'win32' }, (t) => {
  const env = setup(t);
  assert.equal(env.verify().reason, 'promotional_authorization_missing');
  for (const mode of [0o644, 0o640, 0o400, 0o700]) { env.write(permit(), mode); assert.equal(env.verify().reason, 'promotional_authorization_invalid', mode.toString(8)); }
  env.write(permit());
  assert.equal(env.verify().allowed, true);
  const elsewhere = path.join(env.dataDir, 'elsewhere.json');
  fs.renameSync(env.file, elsewhere);
  fs.symlinkSync(elsewhere, env.file);
  assert.equal(env.verify().reason, 'promotional_authorization_invalid', 'symlink');
  fs.rmSync(env.file);
  fs.linkSync(elsewhere, env.file);
  assert.equal(env.verify().reason, 'promotional_authorization_invalid', 'hard link');
  fs.rmSync(env.file); fs.rmSync(elsewhere);
  env.write(JSON.stringify(permit()) + ' '.repeat(16385));
  assert.equal(env.verify().reason, 'promotional_authorization_invalid', 'oversized');
  fs.rmSync(env.file); fs.mkdirSync(env.file);
  assert.equal(env.verify().reason, 'promotional_authorization_invalid', 'directory');
  // The prepaid permit file is never read for this route.
  fs.rmSync(env.file, { recursive: true });
  fs.writeFileSync(path.join(env.dataDir, 'prepaid-authorization.json'), JSON.stringify(permit()), { mode: 0o600 });
  assert.equal(env.verify().reason, 'promotional_authorization_missing');
  assert.equal(env.thunk.calls, 1);
});

test('provider, scope, revocation, window and credential are checked in order, around the credential read', (t) => {
  const env = setup(t);
  env.write(permit());
  const expect = (patch, reason, calls) => {
    const before = env.thunk.calls;
    const result = env.verify(patch);
    assert.equal(result.allowed, false); assert.equal(result.reason, reason, JSON.stringify(patch));
    assert.equal(env.thunk.calls - before, calls, reason);
    assert.ok(isPromotionalResult(result));
    return result;
  };
  expect({ provider: 'openai' }, 'promotional_provider_unsupported', 0);
  expect({ profile: { ...PROFILE, provider: 'openai' } }, 'promotional_provider_unsupported', 0);
  for (const profile of [{ ...PROFILE, id: 'two' }, { ...PROFILE, revision: 3 }, { ...PROFILE, organization: { ref: 'org_other' } },
    { ...PROFILE, project: { ref: 'wrk_other' } }, { ...PROFILE, project: undefined }]) {
    assert.equal(expect({ profile }, 'promotional_scope_mismatch', 0).authorizationId, 'pp_fixture_1');
  }
  expect({ now: Date.parse('2026-11-02T11:58:59.999Z') }, 'promotional_authorization_expired', 0);
  expect({ now: Date.parse('2026-11-03T11:59:00.000Z') }, 'promotional_authorization_expired', 0);
  expect({ now: NaN }, 'promotional_authorization_expired', 0);
  expect({ profile: { ...PROFILE, credentialRef: null } }, 'api_credential_unbound', 0);
  expect({ profile: { ...PROFILE, credentialRef: { type: 'reserved_env', name: 'RELAYBRIDGE_OPENAI_CREDIT_API_KEY' } } }, 'api_credential_unbound', 0);
  expect({ credentialSource: null }, 'api_credential_unbound', 0);
  env.thunk.result = null; expect({}, 'api_credential_unbound', 1);
  env.thunk.result = { value: KEY + '-other', fingerprint: FINGERPRINT }; expect({}, 'promotional_credential_mismatch', 1);
  env.thunk.result = { value: KEY, fingerprint: FINGERPRINT };
  // An id change without a new HMAC is a mismatch: the HMAC is keyed by the id.
  env.write(permit({ authorizationId: 'pp_fixture_2', credentialHmac: credentialHmac('pp_fixture_1', KEY) }));
  expect({}, 'promotional_credential_mismatch', 1);
  env.write(permit({ revokedAt: '2026-11-02T11:59:30.000Z' }));
  expect({}, 'promotional_authorization_revoked', 0);
  expect({ profile: { ...PROFILE, revision: 9 } }, 'promotional_scope_mismatch', 0);
  // Any edit changes the hash, so a decision bound to the old permit goes stale.
  env.write(permit());
  const before = env.verify().authorizationHash;
  env.write(permit({ models: ['claude-sonnet-5-5', 'claude-opus-5-5'] }));
  assert.notEqual(env.verify().authorizationHash, before);
});

test('promotional status reads the profile the permit names; brands cannot be copied', (t) => {
  const env = setup(t);
  assert.equal(summarize(env.authority.status({ profiles: [PROFILE], now: NOW })).reason, 'promotional_authorization_missing');
  env.write(permit());
  const factory = (provider) => { factory.providers.push(provider); return env.thunk; }; factory.providers = [];
  assert.equal(summarize(env.authority.status({ profiles: [{ ...PROFILE, id: 'other' }], credentialSourceFor: factory, now: NOW })).reason, 'promotional_scope_mismatch');
  assert.deepEqual(factory.providers, []);
  const status = summarize(env.authority.status({ profiles: [{ ...PROFILE, id: 'zero' }, PROFILE], credentialSourceFor: factory, now: NOW }));
  assert.equal(status.state, 'valid'); assert.deepEqual(factory.providers, ['claude']);
  assert.equal(summarize(env.authority.status({ profiles: [PROFILE], now: NOW })).reason, 'api_credential_unbound');
  assert.ok(isPromotionalAuthority(env.authority)); assert.ok(Object.isFrozen(env.authority));
  assert.equal(isPromotionalAuthority({ ...env.authority }), false);
  assert.equal(isPromotionalResult({ allowed: true }), false);
  assert.equal(summarize({ allowed: true, authorizationId: 'pp_x' }).state, 'blocked');
  assert.throws(() => createPromotionalAuthority({}), TypeError);
});

test('the promotional authority module has no write path and no environment input', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'promotional-authorization.js'), 'utf8');
  for (const forbidden of ['writeFile', 'appendFile', 'rename', 'unlink', 'rmSync', 'mkdir', 'chmod', 'O_CREAT', 'O_WRONLY', 'O_RDWR', 'process.env']) {
    assert.ok(!source.includes(forbidden), forbidden);
  }
});
