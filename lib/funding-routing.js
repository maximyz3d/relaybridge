'use strict';

const crypto = require('node:crypto');
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const FUNDING_ERROR_CODES = new Set(['invalid_funding_envelope', 'auto_switching_unavailable', 'funding_profile_store_invalid', 'funding_profile_missing', 'funding_profile_stale', 'funding_profile_provider_mismatch', 'funding_account_conflict', 'funding_subscription_transport_required', 'funding_alias_unsupported', 'funding_envelope_unsupported', 'funding_owned_binding_unsupported', 'funding_decision_changed', 'grant_only_funding_unverified', 'credit_preference_off']);
const FUNDING_ALIASES = Object.freeze(['funding_route', 'fundingRoute', 'billing_mode', 'billingMode']);
function assertCanonicalFunding(request, supported = true) {
  if (request?.funding_route === 'allocated_api_credit' || request?.billing_mode === 'allocated_credit_only') fail('allocated_credit_unavailable');
  if (FUNDING_ALIASES.some(k => Object.hasOwn(request || {}, k))) fail('funding_alias_unsupported');
  if (!supported && Object.hasOwn(request || {}, 'funding')) fail('funding_envelope_unsupported');
}
function validateFundingEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !['route', 'profileId', 'expectedProfileRevision', 'fallback'].includes(k))) fail('invalid_funding_envelope');
  if (value.route === 'auto') fail('auto_switching_unavailable');
  if (!['subscription', 'included_api_credit'].includes(value.route)
    || !['none', 'subscription'].includes(value.fallback)
    || (value.profileId !== undefined && (typeof value.profileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value.profileId) || /^sk-/i.test(value.profileId)))
    || (value.expectedProfileRevision !== undefined && (!Number.isSafeInteger(value.expectedProfileRevision) || value.expectedProfileRevision < 1))) fail('invalid_funding_envelope');
  return { ...value };
}
function bindFundingAtSubmit(envelope, snapshot) {
  const value = validateFundingEnvelope(envelope);
  if (snapshot.storeState === 'invalid') fail('funding_profile_store_invalid');
  const profileId = value.profileId ?? snapshot.selected?.profileId;
  const profile = snapshot.profiles.find(p => p.id === profileId);
  if (!profile) fail('funding_profile_missing');
  if (value.expectedProfileRevision !== undefined && value.expectedProfileRevision !== profile.revision) fail('funding_profile_stale');
  return { ...value, profileId, expectedProfileRevision: profile.revision };
}
function resolveFundingRoute({ envelope, snapshot, kind, entry, expectedAccountId, preference }) {
  const bound = bindFundingAtSubmit(envelope, snapshot);
  const profile = snapshot.profiles.find(p => p.id === bound.profileId);
  if (profile.subscription.kind !== kind) fail('funding_profile_provider_mismatch');
  if (expectedAccountId !== undefined && expectedAccountId !== profile.subscription.accountId) fail('funding_account_conflict');
  // A generic hosted HTTP provider is never a subscription seat.
  const subscriptionTransport = profile.provider === 'claude' ? 'subscription:anthropic' : 'subscription:chatgpt';
  if (!entry || entry.oneshot_adapter || (entry.transport && !['cli', subscriptionTransport].includes(entry.transport))) fail('funding_subscription_transport_required');
  const api = bound.route === 'included_api_credit';
  const blockedReason = !api ? null : preference?.mode === 'off' ? 'credit_preference_off' : 'grant_only_funding_unverified';
  const fallbackApplied = api && bound.fallback === 'subscription';
  const actual = !api || fallbackApplied ? 'subscription' : 'none';
  const decision = { version: 1, requested: bound, actual, fallbackApplied, blockedReason,
    eligibleApiSurface: profile.provider === 'openai' ? 'openai_responses_agent' : 'claude_messages_agent',
    apiDispatchAllowed: false, apiTransportImplemented: false,
    apiLimitation: profile.provider === 'openai' ? 'codex_api_key_excluded' : null,
    transport: { surface: actual === 'subscription' ? 'subscription_cli' : 'none', kind },
    identity: { provider: profile.provider, organization: profile.organization.ref, project: profile.project?.ref ?? null,
      creditPeriod: profile.creditPeriod, profileRevision: profile.revision },
    expectedAccountId: profile.subscription.accountId };
  return Object.freeze({ ...decision, decisionHash: crypto.createHash('sha256').update(JSON.stringify(decision)).digest('hex') });
}
function assertFundingSubscriptionAdmission(decision, headroom) {
  if (!decision?.fallbackApplied) return;
  if (headroom?.freshness !== 'fresh' || !Number.isFinite(headroom.percentRemaining)) fail('quota_unknown');
  if (headroom.protected || headroom.vendorBlocked || headroom.percentRemaining <= 2) fail('quota_reserve');
}
module.exports = { FUNDING_ERROR_CODES, assertFundingSubscriptionAdmission, FUNDING_ALIASES, assertCanonicalFunding, validateFundingEnvelope, bindFundingAtSubmit, resolveFundingRoute };
