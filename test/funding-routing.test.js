'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bindFundingAtSubmit, resolveFundingRoute, validateFundingEnvelope, assertCanonicalFunding, assertFundingSubscriptionAdmission } = require('../lib/funding-routing');
const { createQualificationAuthority } = require('../lib/api-agent-qualification');
const { CREDIT_SECRET_NAMES } = require('../lib/allocated-credit');
const PERIOD = Object.freeze({ start: '2020-01-01T00:00:00.000Z', end: '2099-01-01T00:00:00.000Z' });
const snapshot = (provider = 'claude', patch = {}) => ({ storeState: 'valid', selected: { profileId: 'one', profileRevision: 3 }, profiles: [{
  id: 'one', provider, revision: 3, subscription: { kind: provider === 'claude' ? 'claude' : 'codex', accountId: 'default' },
  organization: { ref: 'org_one' }, project: { ref: 'proj_one' },
  credentialRef: { type: 'reserved_env', name: CREDIT_SECRET_NAMES[provider === 'claude' ? 0 : 1] }, creditPeriod: PERIOD, ...patch }] });
const request = (patch = {}) => ({ envelope: { route: 'included_api_credit', fallback: 'none' }, snapshot: snapshot(), kind: 'claude', entry: {}, ...patch });

test('API funding never becomes eligible through preference, fallback, profile metadata or period', () => {
  for (const provider of ['claude', 'openai']) for (const mode of ['auto', 'off', 'manual']) for (const route of ['subscription', 'included_api_credit']) for (const fallback of ['none', 'subscription']) {
    const input = request({ entry: { transport: provider === 'claude' ? 'subscription:anthropic' : 'subscription:chatgpt' }, snapshot: snapshot(provider), kind: provider === 'claude' ? 'claude' : 'codex', preference: { mode, manualTarget: 'included_api_credit' }, envelope: { route, fallback } });
    const decision = resolveFundingRoute(input);
    assert.equal(decision.apiDispatchAllowed, false); assert.equal(decision.apiTransportImplemented, true);
    assert.equal(decision.qualification, null);
    if (route === 'included_api_credit') assert.equal(decision.blockedReason, mode === 'off' ? 'credit_preference_off' : 'grant_only_funding_unverified');
    assert.equal(decision.actual, route === 'subscription' || fallback === 'subscription' ? 'subscription' : 'none');
    assert.equal(decision.fallbackApplied, route === 'included_api_credit' && fallback === 'subscription');
    assert.equal(decision.expectedAccountId, 'default');
    assert.equal(resolveFundingRoute(input).decisionHash, decision.decisionHash);
    if (provider === 'openai') assert.equal(decision.apiLimitation, 'codex_api_key_excluded');
  }
});

test('binding survives selection changes but rejects edits, cross-provider and conflicting account choices', () => {
  const bound = bindFundingAtSubmit({ route: 'subscription', fallback: 'none' }, snapshot());
  const other = snapshot(); other.selected = null;
  assert.equal(resolveFundingRoute(request({ envelope: bound, snapshot: other })).actual, 'subscription');
  other.profiles[0].revision++;
  assert.throws(() => resolveFundingRoute(request({ envelope: bound, snapshot: other })), { code: 'funding_profile_stale' });
  for (const [patch, code] of [[{ expectedAccountId: 'other' }, 'funding_account_conflict'], [{ kind: 'codex' }, 'funding_profile_provider_mismatch'],
    [{ entry: { oneshot_adapter: 'openai_chat_api' } }, 'funding_subscription_transport_required'],
    [{ snapshot: { ...snapshot(), storeState: 'invalid' } }, 'funding_profile_store_invalid']]) {
    assert.throws(() => resolveFundingRoute(request(patch)), { code });
  }
});

test('unknown quota, low reserve and vendor blocking never release the final subscription reserve', () => {
  const decision = resolveFundingRoute(request({ envelope: { route: 'included_api_credit', fallback: 'subscription' } }));
  for (const remaining of [0, 1, 2]) assert.throws(() => assertFundingSubscriptionAdmission(decision, { freshness: 'fresh', percentRemaining: remaining }), { code: 'quota_reserve' });
  for (const freshness of ['unknown', 'stale']) assert.throws(() => assertFundingSubscriptionAdmission(decision, { freshness, percentRemaining: 90 }), { code: 'quota_unknown' });
  assert.throws(() => assertFundingSubscriptionAdmission(decision, { freshness: 'fresh', percentRemaining: 90, vendorBlocked: true }), { code: 'quota_reserve' });
  assert.doesNotThrow(() => assertFundingSubscriptionAdmission(decision, { freshness: 'fresh', percentRemaining: 90 }));
});

test('unsupported routing spellings and client funding assertions fail rather than being ignored', () => {
  for (const value of [null, {}, { route: 'auto', fallback: 'none' }, { route: 'included_api_credit', fallback: 'none', fundingVerified: true },
    { route: 'subscription', fallback: 'none', expectedProfileRevision: 0 }]) assert.throws(() => validateFundingEnvelope(value));
  for (const key of ['fundingRoute', 'funding_route', 'billingMode', 'billing_mode']) assert.throws(() => assertCanonicalFunding({ [key]: 'something' }), { code: 'funding_alias_unsupported' });
  assert.throws(() => assertCanonicalFunding({ funding: {} }, false), { code: 'funding_envelope_unsupported' });
});

const claudeRequest = (patch = {}) => request({ entry: { transport: 'subscription:anthropic' }, ...patch });
const openaiRequest = (patch = {}) => request({ entry: { transport: 'subscription:chatgpt' }, snapshot: snapshot('openai'), kind: 'codex', ...patch });
const spyThunk = () => { const thunk = () => { thunk.calls++; return { value: 'sk-test-credential-value', fingerprint: 'hmac-sha256:' + 'a'.repeat(64) }; }; thunk.calls = 0; return thunk; };
// Credential-source factory spy: records the provider each source was built for.
const spyFor = (thunk = spyThunk()) => { const factory = (provider) => { factory.providers.push(provider); return thunk; }; factory.providers = []; factory.thunk = thunk; return factory; };

test('the production authority qualifies nothing and never reads the credential', () => {
  const authority = createQualificationAuthority({ adapters: Object.freeze({}) });
  for (const [make, provider] of [[claudeRequest, 'claude'], [openaiRequest, 'openai']]) {
    const factory = spyFor();
    const decision = resolveFundingRoute(make({ qualificationAuthority: authority, credentialSourceFor: factory }));
    assert.equal(decision.actual, 'none'); assert.equal(decision.apiDispatchAllowed, false);
    assert.equal(decision.blockedReason, 'grant_only_funding_unverified'); assert.equal(decision.qualification, null);
    // The source is built for the profile's provider (openai for kind codex) and never read.
    assert.deepEqual(factory.providers, [provider]); assert.equal(factory.thunk.calls, 0);
    assert.equal(decision.identity.provider, provider);
  }
});

test('qualification must come from a branded authority and a branded result', () => {
  const lookalike = { verify: () => ({ qualified: true, provider: 'claude', qualificationId: 'q1', credentialFingerprint: 'x' }) };
  assert.throws(() => resolveFundingRoute(claudeRequest({ qualificationAuthority: lookalike, credentialSourceFor: spyFor() })), { code: 'api_qualification_invalid' });
  const frozen = Object.freeze({ ...createQualificationAuthority({ adapters: {} }) });
  assert.throws(() => resolveFundingRoute(claudeRequest({ qualificationAuthority: frozen })), { code: 'api_qualification_invalid' });
  // Adapters throwing or returning junk never qualify.
  for (const adapter of [() => { throw new Error('boom'); }, () => ({ qualified: 'yes', qualificationId: 'q' }), () => ({ qualified: true, qualificationId: 'bad id!' })]) {
    const authority = createQualificationAuthority({ adapters: { claude: adapter } });
    const decision = resolveFundingRoute(claudeRequest({ qualificationAuthority: authority, credentialSourceFor: spyFor() }));
    assert.equal(decision.apiDispatchAllowed, false); assert.equal(decision.blockedReason, 'grant_only_funding_unverified');
  }
  assert.throws(() => createQualificationAuthority({ adapters: { codex: () => ({}) } }), TypeError);
  assert.throws(() => createQualificationAuthority(), TypeError);
});

test('a qualified test authority routes to included API credit and binds the qualification into the hash', () => {
  const authority = createQualificationAuthority({ adapters: { claude: () => ({ qualified: true, qualificationId: 'q_test_1' }) } });
  const thunk = spyThunk();
  const decision = resolveFundingRoute(claudeRequest({ qualificationAuthority: authority, credentialSourceFor: spyFor(thunk) }));
  assert.equal(thunk.calls, 1);
  assert.equal(decision.actual, 'included_api_credit'); assert.equal(decision.apiDispatchAllowed, true);
  assert.equal(decision.blockedReason, null); assert.equal(decision.fallbackApplied, false);
  assert.equal(decision.version, 2); assert.equal(decision.transport.surface, 'claude_messages_agent');
  assert.deepEqual(decision.qualification, { qualificationId: 'q_test_1', credentialFingerprint: 'hmac-sha256:' + 'a'.repeat(64) });
  assert.ok(!JSON.stringify(decision).includes('sk-test-credential-value'));
  const other = createQualificationAuthority({ adapters: { claude: () => ({ qualified: true, qualificationId: 'q_test_2' }) } });
  assert.notEqual(resolveFundingRoute(claudeRequest({ qualificationAuthority: other, credentialSourceFor: spyFor() })).decisionHash, decision.decisionHash);
  // A requested fallback is not applied when API credit is admitted.
  const withFallback = resolveFundingRoute(claudeRequest({ qualificationAuthority: authority, credentialSourceFor: spyFor(),
    envelope: { route: 'included_api_credit', fallback: 'subscription' } }));
  assert.equal(withFallback.actual, 'included_api_credit'); assert.equal(withFallback.fallbackApplied, false);
});

test('providers qualify independently', () => {
  const authority = createQualificationAuthority({ adapters: { claude: () => ({ qualified: true, qualificationId: 'q_claude' }) } });
  const thunk = spyThunk();
  const openai = resolveFundingRoute(openaiRequest({ qualificationAuthority: authority, credentialSourceFor: spyFor(thunk) }));
  assert.equal(openai.apiDispatchAllowed, false); assert.equal(openai.blockedReason, 'grant_only_funding_unverified');
  assert.equal(thunk.calls, 0);
  const both = createQualificationAuthority({ adapters: { openai: () => ({ qualified: true, qualificationId: 'q_openai' }) } });
  const ok = resolveFundingRoute(openaiRequest({ qualificationAuthority: both, credentialSourceFor: spyFor() }));
  assert.equal(ok.actual, 'included_api_credit'); assert.equal(ok.transport.surface, 'openai_responses_agent');
  assert.equal(resolveFundingRoute(claudeRequest({ qualificationAuthority: both, credentialSourceFor: spyFor() })).apiDispatchAllowed, false);
});

test('unbound credentials, expired periods and an off preference block before any qualification check', () => {
  const authority = createQualificationAuthority({ adapters: { claude: () => ({ qualified: true, qualificationId: 'q' }) } });
  const cases = [
    [{ snapshot: snapshot('claude', { credentialRef: null }) }, 'api_credential_unbound'],
    [{ snapshot: snapshot('claude', { creditPeriod: null }) }, 'api_credential_unbound'],
    [{ snapshot: snapshot('claude', { creditPeriod: { start: '2020-01-01T00:00:00.000Z', end: '2021-01-01T00:00:00.000Z' } }) }, 'grant_expired'],
    [{ snapshot: snapshot('claude', { creditPeriod: { start: '2098-01-01T00:00:00.000Z', end: '2099-01-01T00:00:00.000Z' } }) }, 'grant_expired'],
    [{ now: Date.parse(PERIOD.end) }, 'grant_expired'],
    [{ now: Number.NaN }, 'grant_expired'],
    [{ preference: { mode: 'off' } }, 'credit_preference_off'],
  ];
  for (const [patch, reason] of cases) {
    const thunk = spyThunk(), factory = spyFor(thunk);
    const decision = resolveFundingRoute(claudeRequest({ qualificationAuthority: authority, credentialSourceFor: factory, ...patch }));
    assert.equal(decision.blockedReason, reason, JSON.stringify(patch)); assert.equal(decision.actual, 'none');
    assert.equal(decision.apiDispatchAllowed, false); assert.equal(thunk.calls, 0); assert.deepEqual(factory.providers, []);
  }
  assert.equal(resolveFundingRoute(claudeRequest({ qualificationAuthority: authority, credentialSourceFor: spyFor(), now: Date.parse(PERIOD.start) })).apiDispatchAllowed, true);
});

// Owner-authorized prepaid (OpenAI only). The permit lives in a temp data dir.
const { createPrepaidAuthority, credentialHmac, PREPAID_POLICY } = require('../lib/prepaid-authorization');
const { isApiDecision, apiReleaseBinding, selectSegment } = require('../lib/funding-routing');
const PREPAID_NOW = Date.parse('2026-11-10T12:00:00.000Z');
const prepaidPermit = (patch = {}) => ({ schemaVersion: 1, authorizationId: 'pa_routing', policy: PREPAID_POLICY, provider: 'openai',
  surface: 'openai_responses_agent', supervised: true, noPurchases: true, profileId: 'one', profileRevision: 3, organization: 'org_one',
  project: 'proj_one', credentialHmac: credentialHmac('pa_routing', 'sk-test-credential-value'), models: ['gpt-6.1-sol'],
  issuedAt: '2026-11-10T11:59:00.000Z', expiresAt: '2026-11-11T10:59:00.000Z', revokedAt: null,
  providerControls: { autoReload: 'off', hardLimitCents: 12000, hardLimitScope: 'organization', hardLimitEnforced: true, observedAt: '2026-11-10T10:59:00.000Z' },
  balance: { observedBalanceCents: 20100, observedAt: '2026-11-10T10:59:00.000Z', earliestCreditExpiry: '2026-11-13' }, ...patch });
function prepaidFixture(t) {
  const dataDir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'rb-routing-prepaid-'));
  t.after(() => require('node:fs').rmSync(dataDir, { recursive: true, force: true }));
  const file = require('node:path').join(dataDir, 'prepaid-authorization.json');
  const write = (value) => { require('node:fs').writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); require('node:fs').chmodSync(file, 0o600); };
  write(prepaidPermit());
  return { authority: createPrepaidAuthority({ dataDir }), write, file };
}
const prepaidRequest = (authority, patch = {}) => openaiRequest({ envelope: { route: 'authorized_prepaid', fallback: 'none' },
  prepaidAuthority: authority, credentialSourceFor: spyFor(), now: PREPAID_NOW, ...patch });

test('authorized_prepaid is a separate route; the grant-only decision is byte-identical with a valid permit present', (t) => {
  const { authority } = prepaidFixture(t);
  for (const make of [claudeRequest, openaiRequest]) {
    const without = resolveFundingRoute(make({ credentialSourceFor: spyFor(), now: PREPAID_NOW }));
    const factory = spyFor();
    const withPermit = resolveFundingRoute(make({ credentialSourceFor: factory, prepaidAuthority: authority, now: PREPAID_NOW }));
    assert.equal(withPermit.decisionHash, without.decisionHash); assert.deepEqual(withPermit, without);
    assert.equal(withPermit.blockedReason, 'grant_only_funding_unverified'); assert.equal(withPermit.actual, 'none');
    assert.equal(Object.hasOwn(withPermit, 'fundingPolicy'), false); assert.equal(Object.hasOwn(withPermit, 'grantOnly'), false);
    assert.equal(factory.thunk.calls, 0); assert.equal(isApiDecision(withPermit), false);
  }
  const allowed = resolveFundingRoute(prepaidRequest(authority));
  assert.equal(allowed.actual, 'authorized_prepaid'); assert.equal(allowed.apiDispatchAllowed, true); assert.equal(allowed.blockedReason, null);
  assert.equal(allowed.fundingPolicy, PREPAID_POLICY); assert.equal(allowed.grantOnly, false);
  assert.equal(allowed.transport.surface, 'openai_responses_agent'); assert.equal(allowed.qualification.qualificationId, 'prepaid:pa_routing');
  assert.deepEqual(allowed.prepaid.models, ['gpt-6.1-sol']); assert.equal(allowed.prepaid.providerControls.hardLimitCents, 12000);
  assert.ok(allowed.prepaid.limitations.includes('provider_cap_enforcement_lag'));
  assert.ok(!JSON.stringify(allowed).includes('sk-test-credential-value')); assert.ok(!JSON.stringify(allowed).includes(prepaidPermit().credentialHmac));
  assert.equal(isApiDecision(allowed), true);
  assert.equal(resolveFundingRoute(prepaidRequest(authority)).decisionHash, allowed.decisionHash);
  // Lookalike decisions are not API decisions.
  for (const forged of [{ ...allowed, grantOnly: true }, { ...allowed, fundingPolicy: 'grant_only' }, { ...allowed, prepaid: { ...allowed.prepaid, models: 'gpt-5' } },
    { ...allowed, actual: 'included_api_credit' }, { ...allowed, apiDispatchAllowed: false }]) assert.equal(isApiDecision(forged), false);
  // Prepaid never releases the subscription reserve and is never a unified-run
  // segment without an explicit per-entry opt-in.
  assert.equal(apiReleaseBinding(allowed), null);
  const picked = selectSegment({ entries: [{ transport: 'native' }, { transport: 'api' }], headrooms: [{ freshness: 'fresh', percentRemaining: 1 }],
    apiDecisions: [undefined, allowed] });
  assert.equal(picked.phase, 'stopped'); assert.equal(picked.index, null);
});

test('authorized_prepaid blocks every non-permitted case and falls back only when the submit asked', (t) => {
  const fx = prepaidFixture(t);
  const blocked = (patch, reason) => {
    const decision = resolveFundingRoute(prepaidRequest(fx.authority, patch));
    assert.equal(decision.blockedReason, reason, JSON.stringify(patch)); assert.equal(decision.apiDispatchAllowed, false);
    assert.equal(Object.hasOwn(decision, 'prepaid'), false); assert.equal(isApiDecision(decision), false);
    return decision;
  };
  const claude = claudeRequest({ envelope: { route: 'authorized_prepaid', fallback: 'none' }, prepaidAuthority: fx.authority, now: PREPAID_NOW });
  const factory = spyFor();
  assert.equal(resolveFundingRoute({ ...claude, credentialSourceFor: factory }).blockedReason, 'prepaid_provider_unsupported');
  assert.equal(factory.thunk.calls, 0);
  blocked({ preference: { mode: 'off' } }, 'credit_preference_off');
  blocked({ prepaidAuthority: null }, 'prepaid_authorization_missing');
  blocked({ snapshot: snapshot('openai', { credentialRef: null }) }, 'api_credential_unbound');
  blocked({ now: Date.parse('2026-11-11T11:00:00.000Z') }, 'prepaid_authorization_expired');
  blocked({ snapshot: snapshot('openai', { organization: { ref: 'org_two' } }) }, 'prepaid_scope_mismatch');
  // A qualified grant authority never substitutes for the permit.
  const grantAuthority = createQualificationAuthority({ adapters: { openai: () => ({ qualified: true, qualificationId: 'q_grant' }) } });
  blocked({ prepaidAuthority: null, qualificationAuthority: grantAuthority }, 'prepaid_authorization_missing');
  for (const forged of [{ verify: () => ({ allowed: true }) }, Object.freeze({ ...fx.authority })]) {
    assert.throws(() => resolveFundingRoute(prepaidRequest(forged)), { code: 'api_qualification_invalid' });
  }
  const fallback = blocked({ envelope: { route: 'authorized_prepaid', fallback: 'subscription' }, prepaidAuthority: null }, 'prepaid_authorization_missing');
  assert.equal(fallback.actual, 'subscription'); assert.equal(fallback.fallbackApplied, true);
  const admitted = resolveFundingRoute(prepaidRequest(fx.authority, { envelope: { route: 'authorized_prepaid', fallback: 'subscription' } }));
  assert.equal(admitted.actual, 'authorized_prepaid'); assert.equal(admitted.fallbackApplied, false);
  // Any permit edit changes the decision hash, which stops the next turn.
  const before = resolveFundingRoute(prepaidRequest(fx.authority)).decisionHash;
  fx.write(prepaidPermit({ models: ['gpt-6.1-sol', 'gpt-5'] }));
  assert.notEqual(resolveFundingRoute(prepaidRequest(fx.authority)).decisionHash, before);
  fx.write(prepaidPermit({ revokedAt: '2026-11-10T11:59:30.000Z' }));
  blocked({}, 'prepaid_authorization_revoked');
  require('node:fs').rmSync(fx.file);
  blocked({}, 'prepaid_authorization_missing');
});

const { nativeExhausted } = require('../lib/funding-routing');
const seatView = (patch = {}) => ({ quotaSeat: 'codex:default', freshness: 'fresh', percentRemaining: 0, protected: true, vendorBlocked: true, ...patch });

test('positive exhaustion needs a fresh finite 0% observation for one exact seat', () => {
  assert.equal(nativeExhausted(seatView()), true);
  assert.equal(nativeExhausted(seatView({ percentRemaining: -1 })), true);
  assert.equal(nativeExhausted(seatView(), 'codex:default'), true);
  // vendorBlocked is neither required nor sufficient.
  assert.equal(nativeExhausted(seatView({ vendorBlocked: false, protected: false })), true);
  for (const [label, view] of [
    ['stale', seatView({ freshness: 'stale' })], ['unknown', seatView({ freshness: 'unknown', percentRemaining: null })],
    ['missing', null], ['vendor blocked at 40%', seatView({ percentRemaining: 40, vendorBlocked: true, protected: false })],
    ['rate limit reached at 40%', seatView({ percentRemaining: 40, vendorBlocked: true, reachedType: 'rate_limit_reached', protected: false })],
    ['protected band at 2%', seatView({ percentRemaining: 2, protected: true, vendorBlocked: false })],
    ['protected band at 0.5%', seatView({ percentRemaining: 0.5 })], ['NaN', seatView({ percentRemaining: NaN })],
    ['string percent', seatView({ percentRemaining: '0' })], ['no seat', seatView({ quotaSeat: '' })],
    ['auth failure', seatView({ freshness: 'auth_failed', percentRemaining: null })],
  ]) assert.equal(nativeExhausted(view), false, label);
  assert.equal(nativeExhausted(seatView(), 'codex:other'), false);
});

test('a unified run selects opted-in prepaid only after every listed native seat is positively exhausted', (t) => {
  const { authority } = prepaidFixture(t);
  const prepaid = resolveFundingRoute(prepaidRequest(authority));
  const grantBlocked = resolveFundingRoute(openaiRequest({ credentialSourceFor: spyFor(), now: PREPAID_NOW }));
  const nativeA = { kind: 'codex', accountId: 'default', transport: 'native' };
  const nativeB = { kind: 'codex', accountId: 'work', transport: 'native' };
  const optIn = { kind: 'codex', accountId: 'default', transport: 'api', fundingRoute: 'authorized_prepaid' };
  const grantEntry = { kind: 'codex', accountId: 'default', transport: 'api' };
  const exhaustedA = seatView(), exhaustedB = seatView({ quotaSeat: 'codex:work' });
  const pick = (patch) => selectSegment({ entries: [nativeA, optIn], writer: false, headrooms: [exhaustedA], apiDecisions: [undefined, prepaid], ...patch });
  const chosen = pick();
  assert.deepEqual({ index: chosen.index, phase: chosen.phase, stop: chosen.stop }, { index: 1, phase: 'api', stop: null });
  // Not proven exhausted: wait, never spend.
  for (const view of [seatView({ freshness: 'stale' }), seatView({ percentRemaining: 40, protected: false }),
    seatView({ percentRemaining: 1.5 }), undefined]) {
    const waited = pick({ headrooms: [view] });
    assert.equal(waited.phase, 'stopped'); assert.equal(waited.stop, 'waiting_for_quota');
  }
  // Fresh native allowance always wins.
  assert.equal(pick({ headrooms: [seatView({ percentRemaining: 50, protected: false, vendorBlocked: false })] }).phase, 'subscription');
  // Every listed native seat must be exhausted.
  const multi = (headrooms) => selectSegment({ entries: [nativeA, nativeB, optIn], writer: false, headrooms, apiDecisions: [undefined, undefined, prepaid] });
  assert.equal(multi([exhaustedA, seatView({ quotaSeat: 'codex:work', freshness: 'stale' })]).stop, 'waiting_for_quota');
  assert.equal(multi([exhaustedA, exhaustedB]).phase, 'api');
  // Without the opt-in, no native listed, a writer, a used entry or a blocked permit: never prepaid.
  assert.equal(selectSegment({ entries: [nativeA, { ...optIn, fundingRoute: undefined }], headrooms: [exhaustedA], apiDecisions: [undefined, prepaid] }).phase, 'stopped');
  assert.equal(selectSegment({ entries: [optIn], headrooms: [], apiDecisions: [prepaid] }).stop, 'waiting_for_quota');
  assert.equal(pick({ writer: true }).stop, 'api_write_unavailable');
  assert.equal(pick({ exhaustedApi: [1] }).stop, 'waiting_for_quota');
  const missing = resolveFundingRoute(prepaidRequest(null));
  assert.equal(pick({ apiDecisions: [undefined, missing] }).stop, 'prepaid_authorization_missing');
  assert.equal(pick({ apiDecisions: [undefined, undefined] }).stop, 'prepaid_authorization_missing');
  // A grant decision on an opted-in entry is not prepaid, and a prepaid decision on a grant entry is not grant.
  const grantQualified = { ...prepaid, actual: 'included_api_credit' };
  assert.equal(pick({ apiDecisions: [undefined, grantQualified] }).phase, 'stopped');
  assert.equal(selectSegment({ entries: [nativeA, grantEntry], headrooms: [exhaustedA], apiDecisions: [undefined, prepaid] }).phase, 'stopped');
  // Grant first, then prepaid; the grant's blocked reason is reported when prepaid is not reached.
  const both = selectSegment({ entries: [nativeA, grantEntry, optIn], headrooms: [exhaustedA], apiDecisions: [undefined, grantBlocked, prepaid] });
  assert.equal(both.index, 2); assert.equal(both.phase, 'api');
  assert.equal(selectSegment({ entries: [nativeA, grantEntry, optIn], headrooms: [seatView({ freshness: 'stale' })],
    apiDecisions: [undefined, grantBlocked, prepaid] }).stop, 'grant_only_funding_unverified');
  // Prepaid never releases the reserve; the grant decision and hash are unchanged.
  assert.equal(apiReleaseBinding(prepaid), null);
  assert.equal(resolveFundingRoute(openaiRequest({ credentialSourceFor: spyFor(), prepaidAuthority: authority, now: PREPAID_NOW })).decisionHash, grantBlocked.decisionHash);
});

// Owner-authorized promotional (Claude only). The permit lives in a temp data dir.
const { createPromotionalAuthority, PROMOTIONAL_POLICY } = require('../lib/promotional-authorization');
const { assertReserveSegmentAdmission } = require('../lib/funding-routing');
const PROMO_NOW = Date.parse('2026-11-02T12:00:00.000Z');
const promoPermit = (patch = {}) => ({ schemaVersion: 1, authorizationId: 'pp_routing', policy: PROMOTIONAL_POLICY, provider: 'claude',
  surface: 'claude_messages_agent', supervised: true, noPurchases: true, profileId: 'one', profileRevision: 3, organization: 'org_one',
  workspace: 'proj_one', credentialHmac: credentialHmac('pp_routing', 'sk-test-credential-value'), models: ['claude-sonnet-5-5'],
  issuedAt: '2026-11-02T11:59:00.000Z', expiresAt: '2026-11-03T11:59:00.000Z', revokedAt: null,
  providerControls: { autoReload: 'off', billingMode: 'pay_as_you_go', operatorSpendLimitCents: 12000, operatorSpendLimitScope: 'organization',
    operatorSpendLimitActive: true, observedAt: '2026-11-02T11:00:00.000Z' },
  balance: { observedPromotionalCents: 19999, observedPurchasedCents: 370, observedMonthSpendCents: 0, promotionalExpiry: '2026-11-05',
    observedAt: '2026-11-02T11:00:00.000Z' }, ...patch });
function promoFixture(t) {
  const fs = require('node:fs'), path = require('node:path');
  const dataDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rb-routing-promo-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'promotional-authorization.json');
  const write = (value) => { fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); fs.chmodSync(file, 0o600); };
  write(promoPermit());
  return { authority: createPromotionalAuthority({ dataDir }), write, file, dataDir };
}
const promoRequest = (authority, patch = {}) => claudeRequest({ envelope: { route: 'authorized_promotional', fallback: 'none' },
  promotionalAuthority: authority, credentialSourceFor: spyFor(), now: PROMO_NOW, ...patch });

test('pre-existing subscription, grant and prepaid decision hashes are pinned and unaffected by a promotional permit', (t) => {
  const { authority: prepaidAuthority } = prepaidFixture(t);
  const { authority: promotionalAuthority } = promoFixture(t);
  const src = () => () => ({ value: 'sk-test-credential-value', fingerprint: 'hmac-sha256:' + 'a'.repeat(64) });
  const grant = createQualificationAuthority({ adapters: { claude: () => ({ qualified: true, qualificationId: 'q_test_1' }) } });
  const base = { entry: { transport: 'subscription:anthropic' }, now: PREPAID_NOW };
  for (const promo of [{}, { promotionalAuthority }]) {
    assert.equal(resolveFundingRoute(request({ ...base, ...promo, envelope: { route: 'subscription', fallback: 'none' } })).decisionHash,
      '4e278ea2e520d1c7197f1441e3c7b151f2d2c776f58b155a51216ca4979b27cd');
    assert.equal(resolveFundingRoute(request({ ...base, ...promo, qualificationAuthority: grant, credentialSourceFor: src })).decisionHash,
      'a3f2cbb53594df721ea6a5b73b9b606c8276fc83f6e1572a9dd48fd1e2c0cc72');
    assert.equal(resolveFundingRoute(openaiRequest({ ...promo, credentialSourceFor: src, now: PREPAID_NOW })).decisionHash,
      'd0b2bd6c3aa1d939fa2e1f8de2b0ff1c860ebdf2be0a69fd678057f5e27b1af2');
    assert.equal(resolveFundingRoute(openaiRequest({ ...promo, envelope: { route: 'authorized_prepaid', fallback: 'none' }, prepaidAuthority,
      credentialSourceFor: src, now: PREPAID_NOW })).decisionHash, 'd79c09c105d4d2a0e55501258f2948f142c0dbf40c63a01de05f6011f25fff02');
  }
  // A valid promotional permit never makes the grant route or the prepaid route admit Claude.
  const factory = spyFor();
  const grantClaude = resolveFundingRoute(claudeRequest({ credentialSourceFor: factory, promotionalAuthority, now: PROMO_NOW }));
  assert.equal(grantClaude.actual, 'none'); assert.equal(grantClaude.blockedReason, 'grant_only_funding_unverified');
  assert.equal(Object.hasOwn(grantClaude, 'fundingPolicy'), false); assert.equal(factory.thunk.calls, 0);
  const prepaidClaude = resolveFundingRoute(claudeRequest({ envelope: { route: 'authorized_prepaid', fallback: 'none' }, prepaidAuthority,
    promotionalAuthority, credentialSourceFor: spyFor(), now: PROMO_NOW }));
  assert.equal(prepaidClaude.blockedReason, 'prepaid_provider_unsupported'); assert.equal(isApiDecision(prepaidClaude), false);
});

test('authorized_promotional is a separate Claude route that is never grant-only and never releases the reserve', (t) => {
  const { authority } = promoFixture(t);
  const allowed = resolveFundingRoute(promoRequest(authority));
  assert.equal(allowed.actual, 'authorized_promotional'); assert.equal(allowed.apiDispatchAllowed, true); assert.equal(allowed.blockedReason, null);
  assert.equal(allowed.fundingPolicy, PROMOTIONAL_POLICY); assert.equal(allowed.grantOnly, false);
  assert.equal(allowed.fundingSource, 'promotional_credit_first'); assert.equal(Object.hasOwn(allowed, 'prepaid'), false);
  assert.equal(allowed.transport.surface, 'claude_messages_agent'); assert.equal(allowed.qualification.qualificationId, 'promotional:pp_routing');
  assert.deepEqual(allowed.promotional.models, ['claude-sonnet-5-5']); assert.equal(allowed.promotional.reserveRelease, 'never');
  assert.equal(allowed.promotional.providerControls.operatorSpendLimitCents, 12000);
  assert.equal(allowed.promotional.balance.observedPurchasedCents, 370);
  assert.ok(allowed.promotional.limitations.includes('not_grant_only'));
  assert.ok(allowed.promotional.limitations.includes('purchased_balance_at_risk_on_overshoot'));
  assert.ok(!JSON.stringify(allowed).includes('sk-test-credential-value')); assert.ok(!JSON.stringify(allowed).includes(promoPermit().credentialHmac));
  assert.equal(isApiDecision(allowed), true);
  assert.equal(resolveFundingRoute(promoRequest(authority)).decisionHash, allowed.decisionHash);
  for (const forged of [{ ...allowed, grantOnly: true }, { ...allowed, fundingPolicy: PREPAID_POLICY }, { ...allowed, fundingPolicy: undefined },
    { ...allowed, promotional: { ...allowed.promotional, reserveRelease: 'allowed' } }, { ...allowed, promotional: { ...allowed.promotional, models: 'x' } },
    { ...allowed, promotional: undefined }, { ...allowed, actual: 'authorized_prepaid' }, { ...allowed, apiDispatchAllowed: false }]) {
    assert.equal(isApiDecision(forged), false);
  }
  // Never a reserve release, and never selected as a unified-run segment,
  // even with a prepaid opt-in entry and every native seat exhausted.
  assert.equal(apiReleaseBinding(allowed), null);
  const release = { reserveReleaseEvidence: true, errorClass: 'funding_exhausted', index: 1, qualificationId: allowed.qualification.qualificationId,
    binding: { provider: 'claude', organization: 'org_one', project: 'proj_one', creditPeriod: PERIOD, profileRevision: 3,
      qualificationId: allowed.qualification.qualificationId, credentialFingerprint: allowed.qualification.credentialFingerprint } };
  assert.throws(() => assertReserveSegmentAdmission({ release, decision: allowed, headroom: { freshness: 'fresh', percentRemaining: 50 } }),
    { code: 'reserve_release_unavailable' });
  const native = { kind: 'claude', accountId: 'default', transport: 'native' };
  const exhausted = { quotaSeat: 'claude:default', freshness: 'fresh', percentRemaining: 0, protected: true, vendorBlocked: true };
  for (const entry of [{ kind: 'claude', accountId: 'default', transport: 'api' },
    { kind: 'claude', accountId: 'default', transport: 'api', fundingRoute: 'authorized_prepaid' }]) {
    const picked = selectSegment({ entries: [native, entry], writer: false, headrooms: [exhausted], apiDecisions: [undefined, allowed] });
    assert.equal(picked.phase, 'stopped'); assert.equal(picked.index, null);
    const viaRelease = selectSegment({ entries: [native, entry], writer: false, headrooms: [{ freshness: 'fresh', percentRemaining: 1 }],
      apiDecisions: [undefined, allowed], reserveRelease: release });
    assert.equal(viaRelease.phase, 'stopped');
  }
});

test('authorized_promotional blocks every non-permitted case in order and falls back only when the submit asked', (t) => {
  const fx = promoFixture(t);
  const blocked = (patch, reason) => {
    const decision = resolveFundingRoute(promoRequest(fx.authority, patch));
    assert.equal(decision.blockedReason, reason, JSON.stringify(Object.keys(patch))); assert.equal(decision.apiDispatchAllowed, false);
    assert.equal(Object.hasOwn(decision, 'promotional'), false); assert.equal(Object.hasOwn(decision, 'fundingPolicy'), false);
    assert.equal(isApiDecision(decision), false);
    return decision;
  };
  // OpenAI can never use the promotional route, and the credential is not read.
  const factory = spyFor();
  const openai = resolveFundingRoute(openaiRequest({ envelope: { route: 'authorized_promotional', fallback: 'none' }, promotionalAuthority: fx.authority,
    credentialSourceFor: factory, now: PROMO_NOW }));
  assert.equal(openai.blockedReason, 'promotional_provider_unsupported'); assert.equal(factory.thunk.calls, 0);
  blocked({ preference: { mode: 'off' } }, 'credit_preference_off');
  blocked({ preference: { mode: 'off' }, promotionalAuthority: null }, 'credit_preference_off');
  blocked({ snapshot: snapshot('claude', { credentialRef: null }) }, 'api_credential_unbound');
  blocked({ promotionalAuthority: null }, 'promotional_authorization_missing');
  blocked({ now: Date.parse('2026-11-03T11:59:00.000Z') }, 'promotional_authorization_expired');
  blocked({ snapshot: snapshot('claude', { organization: { ref: 'org_two' } }) }, 'promotional_scope_mismatch');
  blocked({ snapshot: snapshot('claude', { project: { ref: 'proj_two' } }) }, 'promotional_scope_mismatch');
  // Neither a qualified grant authority nor a valid prepaid permit substitutes for the promotional permit.
  const grantAuthority = createQualificationAuthority({ adapters: { claude: () => ({ qualified: true, qualificationId: 'q_grant' }) } });
  const prepaidAuthority = prepaidFixture(t).authority;
  blocked({ promotionalAuthority: null, qualificationAuthority: grantAuthority, prepaidAuthority }, 'promotional_authorization_missing');
  for (const forged of [{ verify: () => ({ allowed: true }) }, Object.freeze({ ...fx.authority }), prepaidAuthority]) {
    assert.throws(() => resolveFundingRoute(promoRequest(forged)), { code: 'api_qualification_invalid' });
  }
  const fallback = blocked({ envelope: { route: 'authorized_promotional', fallback: 'subscription' }, promotionalAuthority: null }, 'promotional_authorization_missing');
  assert.equal(fallback.actual, 'subscription'); assert.equal(fallback.fallbackApplied, true);
  const admitted = resolveFundingRoute(promoRequest(fx.authority, { envelope: { route: 'authorized_promotional', fallback: 'subscription' } }));
  assert.equal(admitted.actual, 'authorized_promotional'); assert.equal(admitted.fallbackApplied, false);
  // Any permit edit changes the decision hash, which stops the next turn.
  const before = resolveFundingRoute(promoRequest(fx.authority)).decisionHash;
  fx.write(promoPermit({ models: ['claude-sonnet-5-5', 'claude-opus-5-5'] }));
  assert.notEqual(resolveFundingRoute(promoRequest(fx.authority)).decisionHash, before);
  fx.write(promoPermit({ balance: { ...promoPermit().balance, observedPromotionalCents: 14999 } }));
  blocked({}, 'promotional_authorization_invalid');
  fx.write(promoPermit({ revokedAt: '2026-11-02T11:59:30.000Z' }));
  blocked({}, 'promotional_authorization_revoked');
  require('node:fs').rmSync(fx.file);
  blocked({}, 'promotional_authorization_missing');
  // The submit-time envelope accepts the route name; nothing else changes.
  assert.deepEqual(validateFundingEnvelope({ route: 'authorized_promotional', fallback: 'none' }), { route: 'authorized_promotional', fallback: 'none' });
});
