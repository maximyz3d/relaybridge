'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./subscription-usage');

const PREFERENCE_MODES = Object.freeze(['auto', 'off', 'manual']);
const MANUAL_TARGETS = Object.freeze(['subscription', 'included_api_credit']);
const DEFAULT_PREFERENCE = Object.freeze({ mode: 'auto', manualTarget: null, source: 'default', updatedAt: null });

function preferenceError(code, message) { return Object.assign(new Error(message), { code }); }

function validateCreditPreference(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['mode', 'manualTarget'].includes(key))
    || !Object.hasOwn(input, 'mode') || !PREFERENCE_MODES.includes(input.mode)
    || (input.mode === 'manual' ? !MANUAL_TARGETS.includes(input.manualTarget)
      : input.manualTarget != null)) {
    // Never echo supplied field names or values: a mistaken input may be a key.
    throw preferenceError('invalid_credit_preference', 'Use auto or off without a target, or manual with subscription or included_api_credit.');
  }
  return { mode: input.mode, manualTarget: input.mode === 'manual' ? input.manualTarget : null };
}

function createCreditPreferences({ dataDir } = {}) {
  const file = path.join(dataDir, 'preference.json');
  let current = { ...DEFAULT_PREFERENCE };
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('invalid store');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!saved || Array.isArray(saved) || saved.schemaVersion !== 1
      || Object.keys(saved).some((key) => !['schemaVersion', 'mode', 'manualTarget', 'updatedAt'].includes(key))
      || typeof saved.updatedAt !== 'string' || new Date(saved.updatedAt).toISOString() !== saved.updatedAt) throw new Error('invalid store');
    current = { ...validateCreditPreference({ mode: saved.mode, manualTarget: saved.manualTarget }), source: 'stored', updatedAt: saved.updatedAt };
  } catch (error) {
    if (error.code !== 'ENOENT') current = { mode: 'off', manualTarget: null, source: 'invalid_store', updatedAt: null, storeError: 'invalid_preference_store' };
  }
  return {
    get: () => ({ ...current }),
    set(input) {
      const next = { ...validateCreditPreference(input), source: 'stored', updatedAt: new Date().toISOString() };
      try { atomicWrite(file, { schemaVersion: 1, mode: next.mode, manualTarget: next.manualTarget, updatedAt: next.updatedAt }); }
      catch { throw preferenceError('credit_preference_write_failed', 'Could not persist credit preference; the previous preference remains in use.'); }
      current = next;
      return { ...current };
    },
  };
}

function effectiveCreditRoute(preference) {
  const invalid = preference.source === 'invalid_store';
  const apiSelected = preference.mode === 'manual' && preference.manualTarget === 'included_api_credit';
  return {
    route: apiSelected ? 'blocked' : 'subscription_only', automationAvailable: false, dispatchAllowed: false,
    blockedReason: invalid ? 'invalid_preference_store' : preference.mode === 'auto' || apiSelected ? 'grant_only_funding_unverified' : null,
    detail: invalid ? 'Invalid preference store; credit fallback is off until an explicit setting repairs it.'
      : preference.mode === 'auto' ? 'Auto selected; automatic switching unavailable. Ordinary subscription admission is unchanged.'
        : apiSelected ? 'Selected included API route is blocked. No work is dispatched or attributed to API credits; ordinary subscription admission is unchanged.'
          : preference.mode === 'off' ? 'Credit fallback is off; ordinary subscription admission is unchanged.'
            : 'Manual subscription selected; ordinary subscription admission is unchanged.',
  };
}

// This is a readiness contract, not a billing adapter. A key, screenshot,
// estimated budget or operator assertion cannot enforce grant-only spending.
// No production funding adapter has been qualified. Keep dispatch blocked.
const CREDIT_SECRET_NAMES = Object.freeze([
  'RELAYBRIDGE_ANTHROPIC_CREDIT_API_KEY',
  'RELAYBRIDGE_OPENAI_CREDIT_API_KEY',
]);
const POLICY = Object.freeze({
  thresholdPercent: 2,
  order: Object.freeze(['subscription', 'included_api_credit', 'subscription_reserve', 'stop']),
  reserveRelease: 'only_after_provider_verified_included_credit_exhaustion',
  allowPurchasedCredits: false,
  allowAutoReload: false,
  allowInvoicedUsage: false,
});
const PROVIDERS = Object.freeze({
  claude: Object.freeze({
    apiKeyVariable: CREDIT_SECRET_NAMES[0],
    keysUrl: 'https://platform.claude.com/settings/keys',
    eligibleSurface: 'independently_run_api_key_claude_print_or_agent_sdk',
    limitation: 'Cowork and interactive Claude Code extra usage are separate from API credits.',
  }),
  openai: Object.freeze({
    apiKeyVariable: CREDIT_SECRET_NAMES[1],
    keysUrl: 'https://platform.openai.com/api-keys',
    eligibleSurface: 'separate_openai_api_agent_required',
    limitation: 'Codex API-key usage is excluded from the linked ChatGPT API-credit benefit.',
  }),
});

function creditSetup(provider) {
  if (!Object.hasOwn(PROVIDERS, provider)) throw new Error('credit setup requires claude or openai');
  const info = PROVIDERS[provider];
  return { provider, ...info, activationAvailable: false, steps: [
    `Open ${info.keysUrl} and sign in yourself; select the organization linked to the subscription.`,
    'Create a restricted API key in that organization only when needed. Save it in a private local secret store; never paste it into chat, prompts, logs or the repository.',
    `The reserved variable ${info.apiKeyVariable} is isolated from provider children and does not activate API usage.`,
    'Verify included credit balance and expiry, purchased balance, auto-reload and invoicing. This build has no provider-enforced grant-only funding adapter and cannot enable automatic API dispatch.',
    info.limitation,
  ] };
}

function allocatedCreditStatus(env = process.env, preference = DEFAULT_PREFERENCE) {
  return { mode: 'readiness_only', automationAvailable: false, policy: POLICY,
    preference: { ...preference }, effective: effectiveCreditRoute(preference),
    subscriptionAdmission: 'unchanged',
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([provider, info]) => [provider, {
      ...info, apiKeyPresent: typeof env[info.apiKeyVariable] === 'string' && !!env[info.apiKeyVariable].trim(),
      fundingVerification: 'unavailable', dispatchAllowed: false,
      blockedReason: 'grant_only_funding_unverified',
    }])),
    detail: 'The 2% switching order is recorded, not active. Keys or local configuration cannot enable it. No API transport, automatic purchase or billing mutation is implemented.',
  };
}

// Reject both the reserved route names and explicit funding claims. Do not let
// generic CLI/HTTP configuration silently turn an unqualified credit route on.
function assertNoAllocatedCreditDispatch(kind, entry = {}, request = {}) {
  const claimsCredit = (value) => value?.funding_route === 'allocated_api_credit'
    || value?.billing_mode === 'allocated_credit_only';
  const keyBindings = [entry?.api_key_env, entry?.credential_env,
    ...(Array.isArray(entry?.api_key_env_aliases) ? entry.api_key_env_aliases : [])];
  const usesReservedKey = keyBindings.some((name) => typeof name === 'string'
    && CREDIT_SECRET_NAMES.includes(name.toUpperCase()));
  if (['claude_credit', 'openai_responses_credit'].includes(kind) || claimsCredit(entry) || claimsCredit(request) || usesReservedKey) {
    const error = new Error('Allocated-credit dispatch is blocked: provider-enforced grant-only funding is unavailable. See docs/ALLOCATED-CREDIT.md.');
    error.code = 'allocated_credit_unavailable';
    throw error;
  }
}

module.exports = { CREDIT_SECRET_NAMES, POLICY, PREFERENCE_MODES, MANUAL_TARGETS, validateCreditPreference,
  createCreditPreferences, allocatedCreditStatus, creditSetup, assertNoAllocatedCreditDispatch };
