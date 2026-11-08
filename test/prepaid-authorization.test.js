'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PREPAID_POLICY, PREPAID_LIMITATIONS, credentialHmac, validateAuthorization, createPrepaidAuthority,
  isPrepaidAuthority, isPrepaidResult, summarize } = require('../lib/prepaid-authorization');

const KEY = 'sk-test-prepaid-sentinel-0123456789';
const FINGERPRINT = 'hmac-sha256:' + 'b'.repeat(64);
const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const PROFILE = Object.freeze({ id: 'one', provider: 'openai', revision: 3, organization: { ref: 'org_one' }, project: { ref: 'proj_one' },
  credentialRef: { type: 'reserved_env', name: 'RELAYBRIDGE_OPENAI_CREDIT_API_KEY' } });

function permit(patch = {}) {
  const id = patch.authorizationId || 'pa_fixture_1';
  return { schemaVersion: 1, authorizationId: id, policy: PREPAID_POLICY, provider: 'openai', surface: 'openai_responses_agent',
    supervised: true, noPurchases: true, profileId: 'one', profileRevision: 3, organization: 'org_one', project: 'proj_one',
    credentialHmac: credentialHmac(id, KEY), models: ['gpt-6.1-sol'], issuedAt: '2026-11-10T11:59:00.000Z',
    expiresAt: '2026-11-11T10:59:00.000Z', revokedAt: null,
    providerControls: { autoReload: 'off', hardLimitCents: 12000, hardLimitScope: 'organization', hardLimitEnforced: true, observedAt: '2026-11-10T10:59:00.000Z' },
    balance: { observedBalanceCents: 20100, observedAt: '2026-11-10T10:59:00.000Z', earliestCreditExpiry: '2026-11-13' }, ...patch };
}
const controls = (patch) => ({ ...permit().providerControls, ...patch });
const balance = (patch) => ({ ...permit().balance, ...patch });

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-prepaid-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'prepaid-authorization.json');
  const write = (value, mode = 0o600) => {
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode });
    fs.chmodSync(file, mode);
  };
  const thunk = () => { thunk.calls++; return thunk.result; };
  thunk.calls = 0; thunk.result = { value: KEY, fingerprint: FINGERPRINT };
  const authority = createPrepaidAuthority({ dataDir });
  const verify = (patch = {}) => authority.verify({ provider: 'openai', profile: PROFILE, credentialSource: thunk, now: NOW, ...patch });
  return { dataDir, file, write, thunk, authority, verify };
}

test('a valid permit verifies to a branded, secret-free result with a stable hash', (t) => {
  const env = setup(t);
  env.write(permit());
  const result = env.verify();
  assert.equal(result.allowed, true, JSON.stringify(result)); assert.equal(result.reason, null);
  assert.ok(isPrepaidResult(result)); assert.ok(Object.isFrozen(result));
  assert.equal(result.authorizationId, 'pa_fixture_1'); assert.equal(result.credentialFingerprint, FINGERPRINT);
  assert.deepEqual([...result.models], ['gpt-6.1-sol']); assert.deepEqual([...result.limitations], [...PREPAID_LIMITATIONS]);
  assert.match(result.authorizationHash, /^[a-f0-9]{64}$/);
  assert.equal(env.verify().authorizationHash, result.authorizationHash);
  assert.equal(env.thunk.calls, 2);
  assert.ok(!JSON.stringify(result).includes(KEY)); assert.ok(!JSON.stringify(result).includes(permit().credentialHmac));
  const summary = summarize(result);
  assert.equal(summary.state, 'valid'); assert.equal(summary.policy, PREPAID_POLICY);
  const text = JSON.stringify(summary);
  for (const secret of [KEY, permit().credentialHmac, FINGERPRINT]) assert.ok(!text.includes(secret));
  assert.equal(summarize({ ...result }).state, 'blocked');
  // The authority never rewrites or repairs the file.
  assert.equal(fs.readFileSync(env.file, 'utf8'), JSON.stringify(permit(), null, 2));
  assert.equal(fs.statSync(env.file).mode & 0o777, 0o600);
});

test('every schema rule failure is prepaid_authorization_invalid and never reads the credential', (t) => {
  const env = setup(t);
  const { credentialHmac: _omit, ...missingKey } = permit();
  const cases = {
    extraKey: { ...permit(), note: 'x' }, missingKey, schemaVersion: permit({ schemaVersion: 2 }),
    badId: permit({ authorizationId: 'auth_1' }), policy: permit({ policy: 'grant_only' }), provider: permit({ provider: 'claude' }),
    surface: permit({ surface: 'claude_messages_agent' }), supervised: permit({ supervised: false }), noPurchases: permit({ noPurchases: false }),
    revision: permit({ profileRevision: 0 }), hmacFormat: permit({ credentialHmac: 'sha256:abc' }), secretLikeRef: permit({ profileId: 'sk-live' }),
    noModels: permit({ models: [] }), claudeModel: permit({ models: ['claude-opus-5-5'] }), unknownModel: permit({ models: ['gpt-unknown'] }),
    duplicateModels: permit({ models: ['gpt-5', 'gpt-5'] }), nonCanonicalTime: permit({ issuedAt: '2026-11-10T11:59:00Z' }),
    over24h: permit({ expiresAt: '2026-11-11T12:00:00.000Z' }), emptyWindow: permit({ expiresAt: '2026-11-10T11:59:00.000Z' }),
    pastCreditExpiry: permit({ balance: balance({ earliestCreditExpiry: '2026-11-11' }) }),
    impossibleDate: permit({ balance: balance({ earliestCreditExpiry: '2026-02-30' }) }),
    pastMonthReset: permit({ issuedAt: '2026-11-30T12:00:00.000Z', expiresAt: '2026-12-01T06:00:00.000Z',
      providerControls: controls({ observedAt: '2026-11-30T11:00:00.000Z' }),
      balance: balance({ observedAt: '2026-11-30T11:00:00.000Z', earliestCreditExpiry: '2026-12-31' }) }),
    observedAfterIssue: permit({ providerControls: controls({ observedAt: '2026-11-10T12:30:00.000Z' }) }),
    staleBalance: permit({ balance: balance({ observedAt: '2026-11-09T23:58:59.000Z' }) }),
    cushionUnder20: permit({ providerControls: controls({ hardLimitCents: 16081 }) }),
    capNotEnforced: permit({ providerControls: controls({ hardLimitEnforced: false }) }),
    autoReloadOn: permit({ providerControls: controls({ autoReload: 'on' }) }),
    badScope: permit({ providerControls: controls({ hardLimitScope: 'account' }) }),
    controlsExtra: permit({ providerControls: { ...controls({}), spent: 0 } }),
    balanceExtra: permit({ balance: { ...balance({}), reserved: 1 } }),
    zeroBalance: permit({ balance: balance({ observedBalanceCents: 0 }) }),
    revokedNotIso: permit({ revokedAt: 'yesterday' }),
  };
  for (const [name, value] of Object.entries(cases)) {
    assert.throws(() => validateAuthorization(value), { code: 'prepaid_authorization_invalid' }, name);
    env.write(value);
    const result = env.verify();
    assert.equal(result.allowed, false, name); assert.equal(result.reason, 'prepaid_authorization_invalid', name);
  }
  for (const text of ['not json', '[]', 'null']) { env.write(text); assert.equal(env.verify().reason, 'prepaid_authorization_invalid', text); }
  assert.equal(env.thunk.calls, 0);
  // The 20% boundary itself is accepted; it is a nominal cushion, not a reserve.
  assert.doesNotThrow(() => validateAuthorization(permit({ providerControls: controls({ hardLimitCents: 16080 }) })));
  assert.doesNotThrow(() => validateAuthorization(permit({ models: ['gpt-5', 'gpt-5-mini'], project: 'proj_one',
    providerControls: controls({ hardLimitScope: 'project' }) })));
});

test('the permit file must be a private regular file owned by this user', { skip: process.platform === 'win32' }, (t) => {
  const env = setup(t);
  assert.equal(env.verify().reason, 'prepaid_authorization_missing');
  for (const mode of [0o644, 0o640, 0o400, 0o700]) { env.write(permit(), mode); assert.equal(env.verify().reason, 'prepaid_authorization_invalid', mode.toString(8)); }
  env.write(permit());
  assert.equal(env.verify().allowed, true);
  const elsewhere = path.join(env.dataDir, 'elsewhere.json');
  fs.renameSync(env.file, elsewhere);
  fs.symlinkSync(elsewhere, env.file);
  assert.equal(env.verify().reason, 'prepaid_authorization_invalid', 'symlink');
  fs.rmSync(env.file);
  fs.linkSync(elsewhere, env.file);
  assert.equal(env.verify().reason, 'prepaid_authorization_invalid', 'hard link');
  fs.rmSync(env.file); fs.rmSync(elsewhere);
  env.write(JSON.stringify(permit()) + ' '.repeat(16385));
  assert.equal(env.verify().reason, 'prepaid_authorization_invalid', 'oversized');
  fs.rmSync(env.file); fs.mkdirSync(env.file);
  assert.equal(env.verify().reason, 'prepaid_authorization_invalid', 'directory');
  assert.equal(env.thunk.calls, 1);
  // A foreign owner cannot be created without privileges; the uid check is in readPermit().
});

test('scope, revocation, window and credential are checked in order, before and around the credential read', (t) => {
  const env = setup(t);
  env.write(permit());
  const expect = (patch, reason, calls) => {
    const before = env.thunk.calls;
    const result = env.verify(patch);
    assert.equal(result.allowed, false); assert.equal(result.reason, reason, JSON.stringify(patch));
    assert.equal(env.thunk.calls - before, calls, reason);
    assert.ok(isPrepaidResult(result));
    return result;
  };
  expect({ provider: 'claude' }, 'prepaid_provider_unsupported', 0);
  expect({ profile: { ...PROFILE, provider: 'claude' } }, 'prepaid_provider_unsupported', 0);
  for (const profile of [{ ...PROFILE, id: 'two' }, { ...PROFILE, revision: 4 }, { ...PROFILE, organization: { ref: 'org_other' } },
    { ...PROFILE, project: { ref: 'proj_other' } }, { ...PROFILE, project: undefined }]) {
    assert.equal(expect({ profile }, 'prepaid_scope_mismatch', 0).authorizationId, 'pa_fixture_1');
  }
  expect({ now: Date.parse('2026-11-10T11:58:59.999Z') }, 'prepaid_authorization_expired', 0);
  expect({ now: Date.parse('2026-11-11T10:59:00.000Z') }, 'prepaid_authorization_expired', 0);
  expect({ now: NaN }, 'prepaid_authorization_expired', 0);
  expect({ profile: { ...PROFILE, credentialRef: null } }, 'api_credential_unbound', 0);
  expect({ credentialSource: null }, 'api_credential_unbound', 0);
  env.thunk.result = null; expect({}, 'api_credential_unbound', 1);
  env.thunk.result = { value: KEY + '-other', fingerprint: FINGERPRINT }; expect({}, 'prepaid_credential_mismatch', 1);
  env.thunk.result = { value: KEY, fingerprint: FINGERPRINT };
  // An id change without a new HMAC is a mismatch: the HMAC is keyed by the id.
  env.write(permit({ authorizationId: 'pa_fixture_2', credentialHmac: credentialHmac('pa_fixture_1', KEY) }));
  expect({}, 'prepaid_credential_mismatch', 1);
  env.write(permit({ revokedAt: '2026-11-10T11:59:30.000Z' }));
  expect({}, 'prepaid_authorization_revoked', 0);
  expect({ profile: { ...PROFILE, revision: 9 } }, 'prepaid_scope_mismatch', 0);
});

test('status reads the profile the permit names; brands cannot be copied', (t) => {
  const env = setup(t);
  assert.equal(summarize(env.authority.status({ profiles: [PROFILE], now: NOW })).reason, 'prepaid_authorization_missing');
  env.write(permit());
  const factory = (provider) => { factory.providers.push(provider); return env.thunk; }; factory.providers = [];
  assert.equal(summarize(env.authority.status({ profiles: [{ ...PROFILE, id: 'other' }], credentialSourceFor: factory, now: NOW })).reason, 'prepaid_scope_mismatch');
  assert.deepEqual(factory.providers, []);
  const status = summarize(env.authority.status({ profiles: [{ ...PROFILE, id: 'zero' }, PROFILE], credentialSourceFor: factory, now: NOW }));
  assert.equal(status.state, 'valid'); assert.deepEqual(factory.providers, ['openai']);
  assert.equal(summarize(env.authority.status({ profiles: [PROFILE], now: NOW })).reason, 'api_credential_unbound');
  assert.ok(isPrepaidAuthority(env.authority)); assert.ok(Object.isFrozen(env.authority));
  assert.equal(isPrepaidAuthority({ ...env.authority }), false);
  assert.equal(isPrepaidResult({ allowed: true }), false);
  assert.equal(summarize({ allowed: true, authorizationId: 'pa_x' }).state, 'blocked');
  assert.throws(() => createPrepaidAuthority({}), TypeError);
  assert.match(credentialHmac('pa_a', 'value'), /^hmac-sha256:[a-f0-9]{64}$/);
  assert.notEqual(credentialHmac('pa_a', 'value'), credentialHmac('pa_b', 'value'));
});
