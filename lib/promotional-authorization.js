'use strict';

// Owner-authorized supervised permit for spending Claude promotional credit
// through the read-only Claude Messages agent. The only source is a private
// operator file at a fixed path inside the bridge data directory, written out
// of band by the owner. No HTTP, MCP, CLI, environment variable or setting can
// write it, point at another file or renew it.
//
// This is not grant-only funding. Anthropic spends promotional credit before
// purchased credit and counts promotional usage toward the organization's
// monthly spend limit, but that order is not billing isolation: the operator
// spend limit's enforcement can lag and overshoot onto purchased balance, and
// spend from other clients or dashboard changes are not seen here. The permit
// records the controls the owner observed; it does not enforce or monitor
// them, and there is no local spend accounting.
//
// The permit is re-read and fully verified on every call, so deleting,
// editing, revoking or outliving it blocks the next turn. It never qualifies
// a reserve release.
//
// Branding is a test seam, not a security boundary against arbitrary code
// already running in this process: it only ensures that plain or deserialized
// objects are never mistaken for a permit result.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { API_MODEL_CAPABILITIES } = require('./api-agent-wire');
const { CREDIT_SECRET_NAMES } = require('./allocated-credit');
const { credentialHmac } = require('./prepaid-authorization');

const PROMOTIONAL_POLICY = 'owner_authorized_promotional';
const FILE_NAME = 'promotional-authorization.json';
const MAX_BYTES = 16384;
const DAY_MS = 24 * 3600 * 1000;
const MAX_WINDOW_MS = DAY_MS;
const MAX_WINDOW_MS_V2 = 7 * DAY_MS;
const MAX_OBSERVATION_AGE_MS = 12 * 3600 * 1000;
const LIMITATIONS = Object.freeze(['provider_cap_enforcement_lag', 'no_local_spend_accounting', 'external_spend_unseen',
  'dashboard_changes_unmonitored', 'purchased_balance_at_risk_on_overshoot', 'not_grant_only', 'supervised_short_lived']);
// Schema v2 keeps every v1 rule and adds a local spend ledger (lib/credit-ledger.js).
const LIMITATIONS_V2 = Object.freeze(['provider_cap_enforcement_lag', 'external_spend_unseen', 'dashboard_changes_unmonitored',
  'purchased_balance_at_risk_on_overshoot', 'not_grant_only', 'local_ledger_owner_declared_pricing', 'supervised_bounded_window']);
const KEYS = Object.freeze(['schemaVersion', 'authorizationId', 'policy', 'provider', 'surface', 'supervised', 'noPurchases',
  'profileId', 'profileRevision', 'organization', 'workspace', 'credentialHmac', 'models', 'issuedAt', 'expiresAt', 'revokedAt',
  'providerControls', 'balance']);
const RATE_KEYS = Object.freeze(['inputCentsPerMTok', 'outputCentsPerMTok', 'cacheWriteCentsPerMTok', 'cacheReadCentsPerMTok']);
const CONTROL_KEYS = Object.freeze(['autoReload', 'billingMode', 'operatorSpendLimitCents', 'operatorSpendLimitScope',
  'operatorSpendLimitActive', 'observedAt']);
const BALANCE_KEYS = Object.freeze(['observedPromotionalCents', 'observedPurchasedCents', 'observedMonthSpendCents',
  'promotionalExpiry', 'observedAt']);
const AUTHORITIES = new WeakSet();
const RESULTS = new WeakSet();

const invalid = () => Object.assign(new Error('promotional_authorization_invalid'), { code: 'promotional_authorization_invalid' });
function closed(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || keys.some(k => !Object.hasOwn(value, k))) throw invalid();
}
function ref(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value) || /^sk-/i.test(value)) throw invalid();
  return value;
}
function iso(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw invalid();
  return Date.parse(value);
}
function cents(value, { positive }) {
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) throw invalid();
  return value;
}
function firstOfNextUtcMonth(ms) { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); }

// Basis for a v2 ledger: promotional balance or the remaining operator spend
// limit, whichever is smaller, so our own metered spend can never reach the
// purchased balance.
function validateLedger(ledger, models, basis) {
  closed(ledger, ['budgetCents', 'reserveCents', 'pricing']);
  const budget = cents(ledger.budgetCents, { positive: true }), reserve = cents(ledger.reserveCents, { positive: true });
  if (reserve < Math.max(100, Math.ceil(basis * 0.05)) || budget + reserve > basis) throw invalid();
  const pricing = ledger.pricing;
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) throw invalid();
  if (Object.keys(pricing).length !== models.length || models.some(m => !Object.hasOwn(pricing, m))) throw invalid();
  for (const m of models) {
    closed(pricing[m], RATE_KEYS);
    for (const k of RATE_KEYS) cents(pricing[m][k], { positive: true });
  }
}

// Closed schema, version 1 or 2 (v2 adds `ledger`). Every rule failure is promotional_authorization_invalid.
function validateAuthorization(value) {
  const v2 = !!value && typeof value === 'object' && value.schemaVersion === 2;
  closed(value, v2 ? [...KEYS, 'ledger'] : KEYS);
  if ((value.schemaVersion !== 1 && !v2) || typeof value.authorizationId !== 'string' || !/^pp_[A-Za-z0-9_-]{1,96}$/.test(value.authorizationId)
    || value.policy !== PROMOTIONAL_POLICY || value.provider !== 'claude' || value.surface !== 'claude_messages_agent'
    || value.supervised !== true || value.noPurchases !== true
    || !Number.isSafeInteger(value.profileRevision) || value.profileRevision < 1
    || typeof value.credentialHmac !== 'string' || !/^hmac-sha256:[a-f0-9]{64}$/.test(value.credentialHmac)) throw invalid();
  ref(value.profileId); ref(value.organization);
  if (value.workspace !== null) ref(value.workspace);
  if (!Array.isArray(value.models) || !value.models.length || value.models.length > 16 || new Set(value.models).size !== value.models.length
    || value.models.some(m => typeof m !== 'string' || !Object.hasOwn(API_MODEL_CAPABILITIES, m) || API_MODEL_CAPABILITIES[m].provider !== 'claude')) throw invalid();
  const issued = iso(value.issuedAt), expires = iso(value.expiresAt);
  if (value.revokedAt !== null) iso(value.revokedAt);
  const controls = value.providerControls;
  closed(controls, CONTROL_KEYS);
  // Pay-as-you-go only: invoiced billing has no prepaid balance to bound it.
  if (controls.autoReload !== 'off' || controls.billingMode !== 'pay_as_you_go' || controls.operatorSpendLimitScope !== 'organization'
    || controls.operatorSpendLimitActive !== true) throw invalid();
  const balance = value.balance;
  closed(balance, BALANCE_KEYS);
  const cap = cents(controls.operatorSpendLimitCents, { positive: true });
  const promotional = cents(balance.observedPromotionalCents, { positive: true });
  cents(balance.observedPurchasedCents, { positive: false });
  const monthSpend = cents(balance.observedMonthSpendCents, { positive: false });
  if (typeof balance.promotionalExpiry !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(balance.promotionalExpiry)) throw invalid();
  const promoExpiry = Date.parse(`${balance.promotionalExpiry}T00:00:00.000Z`);
  if (!Number.isFinite(promoExpiry) || new Date(promoExpiry).toISOString().slice(0, 10) !== balance.promotionalExpiry) throw invalid();
  // Short-lived: at most 24h, ending at least 24h before the promotional
  // credit expires and no later than the monthly spend-limit reset, each of
  // which requires a fresh owner check.
  if (!(expires > issued) || expires - issued > (v2 ? MAX_WINDOW_MS_V2 : MAX_WINDOW_MS) || expires > promoExpiry - DAY_MS
    || expires > firstOfNextUtcMonth(issued)) throw invalid();
  for (const observed of [iso(controls.observedAt), iso(balance.observedAt)]) {
    if (observed > issued || issued - observed > MAX_OBSERVATION_AGE_MS) throw invalid();
  }
  // The spend limit still available this month must be positive and at most
  // 80% of the observed promotional balance. Purchased balance never counts
  // toward this check. This is a nominal cushion, not a reserve guarantee.
  const headroom = cap - monthSpend;
  if (headroom <= 0 || headroom * 5 > promotional * 4) throw invalid();
  if (v2) validateLedger(value.ledger, value.models, Math.min(promotional, headroom));
  return value;
}

const freezeLedger = (l) => Object.freeze({ budgetCents: l.budgetCents, reserveCents: l.reserveCents,
  pricing: Object.freeze(Object.fromEntries(Object.entries(l.pricing).map(([m, r]) => [m, Object.freeze({ ...r })]))) });
const brand = (value) => { const result = Object.freeze(value); RESULTS.add(result); return result; };
const blocked = (reason, extra = {}) => brand({ allowed: false, reason, provider: 'claude', authorizationId: null, ...extra });

function createPromotionalAuthority({ dataDir } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('promotional authority requires a data directory');
  const file = path.join(path.resolve(dataDir), FILE_NAME);

  // Returns { raw, permit } or a blocked reason. Never repairs or rewrites.
  function readPermit() {
    let fd = null;
    try {
      let stat;
      try { stat = fs.lstatSync(file); } catch (error) { return error.code === 'ENOENT' ? { reason: 'promotional_authorization_missing' } : { reason: 'promotional_authorization_invalid' }; }
      const strict = (s) => s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= MAX_BYTES
        && (process.platform === 'win32' || ((s.mode & 0o777) === 0o600 && s.uid === process.getuid()));
      if (!strict(stat)) return { reason: 'promotional_authorization_invalid' };
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(fd);
      if (!strict(opened) || opened.ino !== stat.ino || opened.dev !== stat.dev) return { reason: 'promotional_authorization_invalid' };
      const raw = Buffer.alloc(opened.size);
      let read = 0;
      while (read < raw.length) { const n = fs.readSync(fd, raw, read, raw.length - read, read); if (!n) break; read += n; }
      if (read !== raw.length) return { reason: 'promotional_authorization_invalid' };
      return { raw, permit: validateAuthorization(JSON.parse(raw.toString('utf8'))) };
    } catch { return { reason: 'promotional_authorization_invalid' }; }
    finally { if (fd !== null) try { fs.closeSync(fd); } catch {} }
  }

  // credentialSource is a lazy thunk returning { value, fingerprint }. It is
  // called only after the file, its scope and its window check out. The
  // result never includes `now`, so its hash is stable inside the window.
  function verify({ provider, profile, credentialSource, now }) {
    if (provider !== 'claude' || profile?.provider !== 'claude') return blocked('promotional_provider_unsupported');
    const read = readPermit();
    if (!read.permit) return blocked(read.reason);
    const p = read.permit;
    const scope = { authorizationId: p.authorizationId };
    if (profile.id !== p.profileId || profile.revision !== p.profileRevision || profile.organization?.ref !== p.organization
      || (profile.project?.ref ?? null) !== p.workspace) return blocked('promotional_scope_mismatch', scope);
    if (p.revokedAt !== null) return blocked('promotional_authorization_revoked', scope);
    if (!Number.isFinite(now) || now < Date.parse(p.issuedAt) || now >= Date.parse(p.expiresAt)) return blocked('promotional_authorization_expired', scope);
    if (profile.credentialRef?.name !== CREDIT_SECRET_NAMES[0] || typeof credentialSource !== 'function') return blocked('api_credential_unbound', scope);
    let credential = null;
    try { credential = credentialSource(); } catch { credential = null; }
    if (!credential || typeof credential.value !== 'string' || !credential.value || typeof credential.fingerprint !== 'string') {
      return blocked('api_credential_unbound', scope);
    }
    const expected = Buffer.from(p.credentialHmac), actual = Buffer.from(credentialHmac(p.authorizationId, credential.value));
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return blocked('promotional_credential_mismatch', scope);
    return brand({ allowed: true, reason: null, provider: 'claude', authorizationId: p.authorizationId,
      authorizationHash: crypto.createHash('sha256').update(read.raw).digest('hex'),
      credentialFingerprint: credential.fingerprint, profileId: p.profileId, profileRevision: p.profileRevision,
      issuedAt: p.issuedAt, expiresAt: p.expiresAt, models: Object.freeze([...p.models]),
      providerControls: Object.freeze({ ...p.providerControls }), balance: Object.freeze({ ...p.balance }), limitations: p.schemaVersion === 2 ? LIMITATIONS_V2 : LIMITATIONS,
      ...(p.schemaVersion === 2 ? { ledger: freezeLedger(p.ledger) } : {}), reserveRelease: 'never' });
  }

  // Status view: verifies the permit against the profile it names.
  function status({ profiles = [], credentialSourceFor = null, now }) {
    const read = readPermit();
    if (!read.permit) return blocked(read.reason);
    const profile = profiles.find(p => p.id === read.permit.profileId);
    if (!profile) return blocked('promotional_scope_mismatch', { authorizationId: read.permit.authorizationId });
    return verify({ provider: profile.provider, profile, now,
      credentialSource: typeof credentialSourceFor === 'function' ? credentialSourceFor(profile.provider) : null });
  }

  const authority = Object.freeze({ policy: PROMOTIONAL_POLICY, verify, status });
  AUTHORITIES.add(authority);
  return authority;
}

const isPromotionalAuthority = (value) => AUTHORITIES.has(value);
const isPromotionalResult = (value) => RESULTS.has(value);

// Secret-free view for status output: no HMAC, credential or fingerprint.
function summarize(result) {
  if (!isPromotionalResult(result)) return { state: 'blocked', reason: 'promotional_authorization_invalid', policy: PROMOTIONAL_POLICY };
  if (!result.allowed) return { state: 'blocked', reason: result.reason, policy: PROMOTIONAL_POLICY, authorizationId: result.authorizationId };
  return { state: 'valid', reason: null, policy: PROMOTIONAL_POLICY, authorizationId: result.authorizationId,
    profileId: result.profileId, profileRevision: result.profileRevision, issuedAt: result.issuedAt, expiresAt: result.expiresAt,
    models: [...result.models], providerControls: { ...result.providerControls }, balance: { ...result.balance },
    supervised: true, noPurchases: true, grantOnly: false, reserveRelease: 'never', limitations: [...result.limitations],
    ...(result.ledger ? { ledger: JSON.parse(JSON.stringify(result.ledger)) } : {}) };
}

module.exports = { PROMOTIONAL_POLICY, PROMOTIONAL_LIMITATIONS: LIMITATIONS, PROMOTIONAL_LIMITATIONS_V2: LIMITATIONS_V2, validateAuthorization, createPromotionalAuthority,
  isPromotionalAuthority, isPromotionalResult, summarize };
