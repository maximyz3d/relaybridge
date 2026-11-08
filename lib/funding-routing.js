'use strict';

const crypto = require('node:crypto');
const { isQualificationAuthority, isBrandedQualification } = require('./api-agent-qualification');
const { PREPAID_POLICY, isPrepaidAuthority, isPrepaidResult } = require('./prepaid-authorization');
const { PROMOTIONAL_POLICY, isPromotionalAuthority, isPromotionalResult } = require('./promotional-authorization');
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const FUNDING_ERROR_CODES = new Set(['invalid_funding_envelope', 'auto_switching_unavailable', 'funding_profile_store_invalid', 'funding_profile_missing', 'funding_profile_stale', 'funding_profile_provider_mismatch', 'funding_account_conflict', 'funding_subscription_transport_required', 'funding_alias_unsupported', 'funding_envelope_unsupported', 'funding_owned_binding_unsupported', 'funding_decision_changed', 'grant_only_funding_unverified', 'credit_preference_off',
  'grant_expired', 'api_credential_unbound', 'api_qualification_invalid', 'funding_exhausted', 'funding_ambiguous', 'account_credit_low',
  'spend_limit', 'api_model_unmapped', 'api_effort_unsupported', 'api_model_mismatch', 'checkpoint_binding_stale', 'api_agent_read_only',
  'api_dispatch_unavailable', 'owner_live_or_unknown', 'outcome_uncertain', 'output_limit_reached', 'linked_attempt_invalid',
  'linked_attempt_parent_not_terminal', 'linked_attempt_unauthorized', 'api_write_unavailable', 'waiting_for_quota',
  'account_binding_required', 'writer_execution_uncertain', 'workspace_reconciliation_unavailable', 'workspace_writer_busy',
  'reserve_release_unavailable', 'prepaid_authorization_missing', 'prepaid_authorization_invalid', 'prepaid_authorization_expired',
  'prepaid_authorization_revoked', 'prepaid_provider_unsupported', 'prepaid_scope_mismatch', 'prepaid_credential_mismatch',
  'prepaid_model_not_permitted', 'prepaid_subscription_available', 'prepaid_exhaustion_source_required',
  'promotional_authorization_missing', 'promotional_authorization_invalid', 'promotional_authorization_expired',
  'promotional_authorization_revoked', 'promotional_provider_unsupported', 'promotional_scope_mismatch',
  'promotional_credential_mismatch', 'promotional_model_not_permitted', 'promotional_unified_unsupported']);
const FUNDING_ALIASES = Object.freeze(['funding_route', 'fundingRoute', 'billing_mode', 'billingMode']);
// Qualification comes only from the server's own authority; a client cannot assert it.
const QUALIFICATION_CLAIMS = Object.freeze(['qualification', 'qualificationId', 'apiQualification', 'fundingQualification']);
function assertCanonicalFunding(request, supported = true) {
  if (QUALIFICATION_CLAIMS.some(k => Object.hasOwn(request || {}, k))) fail('invalid_funding_envelope');
  if (request?.funding_route === 'allocated_api_credit' || request?.billing_mode === 'allocated_credit_only') fail('allocated_credit_unavailable');
  if (FUNDING_ALIASES.some(k => Object.hasOwn(request || {}, k))) fail('funding_alias_unsupported');
  if (!supported && Object.hasOwn(request || {}, 'funding')) fail('funding_envelope_unsupported');
}
function validateFundingEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !['route', 'profileId', 'expectedProfileRevision', 'fallback'].includes(k))) fail('invalid_funding_envelope');
  if (value.route === 'auto') fail('auto_switching_unavailable');
  if (!['subscription', 'included_api_credit', 'authorized_prepaid', 'authorized_promotional'].includes(value.route)
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
function insideCreditPeriod(period, now) {
  const start = Date.parse(period?.start), end = Date.parse(period?.end);
  return Number.isFinite(now) && Number.isFinite(start) && Number.isFinite(end) && now >= start && now < end;
}
// API credit is used only when an authority-branded qualification exists for
// this provider and `now` lies inside the profile credit period. The
// credential source is built for the profile's own provider, only once the
// qualification check is reached, and its thunk is never called unless the
// authority has an adapter for that provider.
//
// `authorized_prepaid` is a separate explicit route. It consults only the
// owner's private prepaid permit (prepaidAuthority), never the grant-only
// authority, and its decision says grantOnly:false. The grant route never
// consults the permit, so its decision and hash are unchanged.
//
// `authorized_promotional` is a third, separate route for Claude promotional
// credit. It consults only the owner's private promotional permit
// (promotionalAuthority) and its decision also says grantOnly:false: the
// provider spends promotional credit first, but that order is not billing
// isolation. No other route consults this permit.
function resolveFundingRoute({ envelope, snapshot, kind, entry, expectedAccountId, preference,
  qualificationAuthority = null, credentialSourceFor = null, prepaidAuthority = null, promotionalAuthority = null, now = Date.now() }) {
  const bound = bindFundingAtSubmit(envelope, snapshot);
  const profile = snapshot.profiles.find(p => p.id === bound.profileId);
  if (profile.subscription.kind !== kind) fail('funding_profile_provider_mismatch');
  if (expectedAccountId !== undefined && expectedAccountId !== profile.subscription.accountId) fail('funding_account_conflict');
  // A generic hosted HTTP provider is never a subscription seat.
  const subscriptionTransport = profile.provider === 'claude' ? 'subscription:anthropic' : 'subscription:chatgpt';
  if (!entry || entry.oneshot_adapter || (entry.transport && !['cli', subscriptionTransport].includes(entry.transport))) fail('funding_subscription_transport_required');
  const grant = bound.route === 'included_api_credit', prepaidRoute = bound.route === 'authorized_prepaid';
  const promoRoute = bound.route === 'authorized_promotional';
  const api = grant || prepaidRoute || promoRoute;
  let blockedReason = null, qualification = null, prepaid = null, promotional = null;
  if (promoRoute) {
    if (preference?.mode === 'off') blockedReason = 'credit_preference_off';
    else if (profile.provider !== 'claude') blockedReason = 'promotional_provider_unsupported';
    else if (!profile.credentialRef) blockedReason = 'api_credential_unbound';
    else if (!promotionalAuthority) blockedReason = 'promotional_authorization_missing';
    else {
      if (!isPromotionalAuthority(promotionalAuthority)) fail('api_qualification_invalid');
      const credentialSource = typeof credentialSourceFor === 'function' ? credentialSourceFor(profile.provider) : null;
      const result = promotionalAuthority.verify({ provider: profile.provider, profile, credentialSource, now });
      if (!isPromotionalResult(result) || result.provider !== profile.provider) fail('api_qualification_invalid');
      if (result.allowed) {
        qualification = { qualificationId: `promotional:${result.authorizationId}`, credentialFingerprint: result.credentialFingerprint };
        promotional = { authorizationId: result.authorizationId, authorizationHash: result.authorizationHash, issuedAt: result.issuedAt,
          expiresAt: result.expiresAt, models: [...result.models], providerControls: { ...result.providerControls },
          balance: { ...result.balance }, limitations: [...result.limitations], reserveRelease: 'never',
          ...(result.ledger ? { ledger: JSON.parse(JSON.stringify(result.ledger)) } : {}) };
      } else blockedReason = result.reason;
    }
  } else if (prepaidRoute) {
    if (preference?.mode === 'off') blockedReason = 'credit_preference_off';
    else if (profile.provider !== 'openai') blockedReason = 'prepaid_provider_unsupported';
    else if (!profile.credentialRef) blockedReason = 'api_credential_unbound';
    else if (!prepaidAuthority) blockedReason = 'prepaid_authorization_missing';
    else {
      if (!isPrepaidAuthority(prepaidAuthority)) fail('api_qualification_invalid');
      const credentialSource = typeof credentialSourceFor === 'function' ? credentialSourceFor(profile.provider) : null;
      const result = prepaidAuthority.verify({ provider: profile.provider, profile, credentialSource, now });
      if (!isPrepaidResult(result) || result.provider !== profile.provider) fail('api_qualification_invalid');
      if (result.allowed) {
        qualification = { qualificationId: `prepaid:${result.authorizationId}`, credentialFingerprint: result.credentialFingerprint };
        prepaid = { authorizationId: result.authorizationId, authorizationHash: result.authorizationHash, issuedAt: result.issuedAt,
          expiresAt: result.expiresAt, models: [...result.models], providerControls: { ...result.providerControls },
          balance: { ...result.balance }, limitations: [...result.limitations],
          ...(result.ledger ? { ledger: JSON.parse(JSON.stringify(result.ledger)) } : {}) };
      } else blockedReason = result.reason;
    }
  } else if (grant) {
    if (preference?.mode === 'off') blockedReason = 'credit_preference_off';
    else if (!profile.credentialRef || !profile.creditPeriod) blockedReason = 'api_credential_unbound';
    else if (!insideCreditPeriod(profile.creditPeriod, now)) blockedReason = 'grant_expired';
    else if (!qualificationAuthority) blockedReason = 'grant_only_funding_unverified';
    else {
      if (!isQualificationAuthority(qualificationAuthority)) fail('api_qualification_invalid');
      const credentialSource = typeof credentialSourceFor === 'function' ? credentialSourceFor(profile.provider) : null;
      const result = qualificationAuthority.verify({ provider: profile.provider, profile, credentialSource, now });
      if (!isBrandedQualification(result) || result.provider !== profile.provider) fail('api_qualification_invalid');
      if (result.qualified) qualification = { qualificationId: result.qualificationId, credentialFingerprint: result.credentialFingerprint };
      else blockedReason = 'grant_only_funding_unverified';
    }
  }
  const apiAllowed = api && qualification !== null;
  const fallbackApplied = api && !apiAllowed && bound.fallback === 'subscription';
  const actual = !api || fallbackApplied ? 'subscription' : apiAllowed ? bound.route : 'none';
  const surface = profile.provider === 'openai' ? 'openai_responses_agent' : 'claude_messages_agent';
  const decision = { version: 2, requested: bound, actual, fallbackApplied, blockedReason,
    eligibleApiSurface: surface,
    apiDispatchAllowed: apiAllowed, apiTransportImplemented: true,
    apiLimitation: profile.provider === 'openai' ? 'codex_api_key_excluded' : null,
    transport: { surface: actual === 'subscription' ? 'subscription_cli' : apiAllowed ? surface : 'none', kind },
    identity: { provider: profile.provider, organization: profile.organization.ref, project: profile.project?.ref ?? null,
      creditPeriod: profile.creditPeriod, profileRevision: profile.revision },
    qualification,
    expectedAccountId: profile.subscription.accountId,
    // Prepaid-only fields; absent for every other decision, whose hash is unchanged.
    ...(prepaid ? { fundingPolicy: PREPAID_POLICY, grantOnly: false, prepaid } : {}),
    // Promotional-only fields; likewise absent for every other decision.
    ...(promotional ? { fundingPolicy: PROMOTIONAL_POLICY, grantOnly: false, fundingSource: 'promotional_credit_first', promotional } : {}) };
  return Object.freeze({ ...decision, decisionHash: crypto.createHash('sha256').update(JSON.stringify(decision)).digest('hex') });
}
// An admitted API agent decision: qualified included credit, or an allowed
// owner-authorized prepaid or promotional permit. Reserve release never uses
// this; it stays keyed on included_api_credit only. Segment selection uses it
// only for an explicitly opted-in prepaid entry, never for promotional.
function isApiDecision(decision) {
  if (!decision || decision.apiDispatchAllowed !== true || !decision.qualification || !decision.identity) return false;
  if (decision.actual === 'included_api_credit') return !Object.hasOwn(decision, 'fundingPolicy');
  if (decision.actual === 'authorized_promotional') {
    return decision.fundingPolicy === PROMOTIONAL_POLICY && decision.grantOnly === false && !!decision.promotional
      && decision.promotional.reserveRelease === 'never' && Array.isArray(decision.promotional.models);
  }
  return decision.actual === 'authorized_prepaid' && decision.fundingPolicy === PREPAID_POLICY && decision.grantOnly === false
    && !!decision.prepaid && Array.isArray(decision.prepaid.models);
}
function assertFundingSubscriptionAdmission(decision, headroom) {
  if (!decision?.fallbackApplied) return;
  if (headroom?.freshness !== 'fresh' || !Number.isFinite(headroom.percentRemaining)) fail('quota_unknown');
  if (headroom.protected || headroom.vendorBlocked || headroom.percentRemaining <= 2) fail('quota_reserve');
}
// Server-internal fields. Only the unified-run engine sets them; a public
// request carrying any of them is refused rather than trusted or dropped.
const INTERNAL_CLIENT_FIELDS = Object.freeze(['unifiedRun', 'reserveRelease']);
function assertNoInternalFields(request) {
  if (INTERNAL_CLIENT_FIELDS.some(k => Object.hasOwn(request || {}, k))
    || QUALIFICATION_CLAIMS.some(k => Object.hasOwn(request || {}, k))) fail('invalid_funding_envelope');
}
// The quota reserve is released to a native segment only by evidence that a
// qualified included-credit API segment was exhausted. Rate limits, auth,
// permission and provider errors never carry that evidence.
//
// The release is bound to the exhausted API admission (profile revision,
// credential identity, credit period and qualification). Every use compares
// that binding with a freshly resolved decision; a qualificationId alone is
// not authority. A consumed release admits only the task that consumed it.
// The released reserve may be spent down to, but not past, 0%.
const RELEASE_BINDING_FIELDS = Object.freeze(['provider', 'organization', 'project', 'creditPeriod', 'profileRevision',
  'qualificationId', 'credentialFingerprint']);
function apiReleaseBinding(decision) {
  if (decision?.actual !== 'included_api_credit' || decision.apiDispatchAllowed !== true || !decision.qualification
    || !decision.identity || typeof decision.qualification.qualificationId !== 'string' || !decision.qualification.qualificationId
    || typeof decision.qualification.credentialFingerprint !== 'string') return null;
  const { provider, organization, project, creditPeriod, profileRevision } = decision.identity;
  return { provider, organization, project, creditPeriod, profileRevision,
    qualificationId: decision.qualification.qualificationId, credentialFingerprint: decision.qualification.credentialFingerprint };
}
function assertReserveSegmentAdmission({ release, decision, headroom, taskId = null }) {
  if (release?.reserveReleaseEvidence !== true || release.errorClass !== 'funding_exhausted' || !release.binding) fail('reserve_release_unavailable');
  if (release.consumedBy != null && (taskId === null || release.consumedBy !== taskId)) fail('reserve_release_unavailable');
  const fresh = apiReleaseBinding(decision);
  if (!fresh || release.qualificationId !== fresh.qualificationId
    || RELEASE_BINDING_FIELDS.some(k => JSON.stringify(release.binding[k] ?? null) !== JSON.stringify(fresh[k] ?? null))) fail('reserve_release_unavailable');
  if (headroom?.freshness !== 'fresh' || !Number.isFinite(headroom.percentRemaining)) fail('quota_unknown');
  if (headroom.vendorBlocked || headroom.percentRemaining <= 0) fail('quota_reserve');
}
const nativeFresh = (h) => h?.freshness === 'fresh' && !h.protected && !h.vendorBlocked && Number.isFinite(h.percentRemaining);
// Positive exhaustion: a fresh, finite observation at or below 0% for one exact
// quota seat. vendorBlocked alone is not exhaustion (it also covers transient
// rate limits and overload), and the protected band above 0% is not exhausted.
// Stale, unknown, auth, rate-limit and overload evidence never qualifies.
const nativeExhausted = (h, quotaSeat) => h?.freshness === 'fresh' && Number.isFinite(h.percentRemaining) && h.percentRemaining <= 0
  && typeof h.quotaSeat === 'string' && h.quotaSeat.length > 0 && (quotaSeat === undefined || h.quotaSeat === quotaSeat);
const prepaidEntry = (entry) => entry?.transport === 'api' && entry.fundingRoute === 'authorized_prepaid';
// Pure segment choice over the caller's listed entries only. `headrooms[i]`
// and `apiDecisions[i]` are precomputed by the caller for `entries[i]`.
// Order: subscription (native) -> qualified API -> released reserve ->
// explicitly opted-in prepaid (only when every listed native seat is
// positively exhausted) -> stop.
function selectSegment({ entries, writer, source = null, headrooms = [], apiDecisions = [], reservePercent = 0,
  exhaustedApi = [], reserveRelease = null }) {
  const list = Array.isArray(entries) ? entries : [];
  const stop = (code) => Object.freeze({ index: null, entry: null, phase: 'stopped', stop: code });
  const floor = Math.max(source?.percentRemaining ?? 0, Number(reservePercent) || 0, 2);
  const native = list.map((entry, index) => ({ entry, index, headroom: headrooms[index] }))
    .filter(c => c.entry?.transport === 'native' && c.index !== source?.index
      && (source?.quotaSeat === undefined || c.headroom?.quotaSeat !== source.quotaSeat)
      && nativeFresh(c.headroom) && c.headroom.percentRemaining > floor);
  // The first segment honours listed order; successors take the most headroom.
  const pick = source ? native.sort((a, b) => b.headroom.percentRemaining - a.headroom.percentRemaining || a.index - b.index)[0] : native[0];
  if (pick) return Object.freeze({ index: pick.index, entry: pick.entry, phase: 'subscription', stop: null });
  const api = list.map((entry, index) => ({ entry, index })).filter(c => c.entry?.transport === 'api');
  if (!api.length) return stop('waiting_for_quota');
  // API tools are read-only in N1, so a writer run never selects an API segment.
  if (writer) return stop('api_write_unavailable');
  let blocked = null;
  for (const c of api) {
    if (exhaustedApi.includes(c.index) || prepaidEntry(c.entry)) continue;
    const decision = apiDecisions[c.index];
    if (decision?.actual === 'included_api_credit' && decision.apiDispatchAllowed === true && decision.qualification) {
      return Object.freeze({ index: c.index, entry: c.entry, phase: 'api', stop: null });
    }
    blocked ??= decision?.blockedReason || decision?.code || 'grant_only_funding_unverified';
  }
  if (reserveRelease) {
    for (const c of list.map((entry, index) => ({ entry, index })).filter(c => c.entry?.transport === 'native')) {
      try {
        assertReserveSegmentAdmission({ release: reserveRelease, decision: apiDecisions[reserveRelease.index], headroom: headrooms[c.index] });
        return Object.freeze({ index: c.index, entry: c.entry, phase: 'reserve', stop: null });
      } catch {}
    }
  }
  // Prepaid never spends while any listed native seat might still have
  // allowance; an unproven exhaustion waits rather than spending.
  const natives = list.map((entry, index) => ({ entry, index })).filter(c => c.entry?.transport === 'native');
  if (natives.length && natives.every(c => nativeExhausted(headrooms[c.index]))) {
    for (const c of api) {
      if (exhaustedApi.includes(c.index) || !prepaidEntry(c.entry)) continue;
      const decision = apiDecisions[c.index];
      if (decision?.actual === 'authorized_prepaid' && isApiDecision(decision)) {
        return Object.freeze({ index: c.index, entry: c.entry, phase: 'api', stop: null });
      }
      blocked ??= decision?.blockedReason || decision?.code || 'prepaid_authorization_missing';
    }
  }
  return stop(blocked || 'waiting_for_quota');
}
module.exports = { FUNDING_ERROR_CODES, isApiDecision, assertFundingSubscriptionAdmission, FUNDING_ALIASES, assertCanonicalFunding, validateFundingEnvelope, bindFundingAtSubmit, resolveFundingRoute,
  INTERNAL_CLIENT_FIELDS, assertNoInternalFields, assertReserveSegmentAdmission, apiReleaseBinding, selectSegment, nativeExhausted };
