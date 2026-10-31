'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bindFundingAtSubmit, resolveFundingRoute, validateFundingEnvelope, assertCanonicalFunding, assertFundingSubscriptionAdmission } = require('../lib/funding-routing');
const snapshot = (provider = 'claude') => ({ storeState: 'valid', selected: { profileId: 'one', profileRevision: 3 }, profiles: [{
  id: 'one', provider, revision: 3, subscription: { kind: provider === 'claude' ? 'claude' : 'codex', accountId: 'default' },
  organization: { ref: 'org_one' }, project: { ref: 'proj_one' }, creditPeriod: null }] });
const request = (patch = {}) => ({ envelope: { route: 'included_api_credit', fallback: 'none' }, snapshot: snapshot(), kind: 'claude', entry: {}, ...patch });

test('API funding never becomes eligible through preference, fallback, profile metadata or period', () => {
  for (const provider of ['claude', 'openai']) for (const mode of ['auto', 'off', 'manual']) for (const route of ['subscription', 'included_api_credit']) for (const fallback of ['none', 'subscription']) {
    const input = request({ entry: { transport: provider === 'claude' ? 'subscription:anthropic' : 'subscription:chatgpt' }, snapshot: snapshot(provider), kind: provider === 'claude' ? 'claude' : 'codex', preference: { mode, manualTarget: 'included_api_credit' }, envelope: { route, fallback } });
    const decision = resolveFundingRoute(input);
    assert.equal(decision.apiDispatchAllowed, false); assert.equal(decision.apiTransportImplemented, false);
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
