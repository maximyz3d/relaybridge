'use strict';

// Owner-authorized prepaid permit for one OpenAI account. The only source is
// a private operator file at a fixed path inside the bridge data directory,
// written out of band by the owner. No HTTP, MCP, CLI, environment variable
// or setting can write it, point at another file or renew it.
//
// The permit is re-read and fully verified on every call, so deleting,
// editing, revoking or outliving it blocks the next turn. It records the
// provider-side controls the owner observed; it does not enforce or monitor
// them. There is no local spend accounting: the provider hard cap is the
// spending backstop, its enforcement can lag and overshoot, and spend from
// other clients or dashboard changes are not seen here.
//
// Branding is a test seam, not a security boundary against arbitrary code
// already running in this process: it only ensures that plain or deserialized
// objects are never mistaken for a permit result.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { API_MODEL_CAPABILITIES } = require('./api-agent-wire');

const PREPAID_POLICY = 'owner_authorized_prepaid';
const FILE_NAME = 'prepaid-authorization.json';
const MAX_BYTES = 16384;
const MAX_WINDOW_MS = 24 * 3600 * 1000;
const MAX_OBSERVATION_AGE_MS = 12 * 3600 * 1000;
const LIMITATIONS = Object.freeze(['provider_cap_enforcement_lag', 'no_local_spend_accounting', 'external_spend_unseen',
  'dashboard_changes_unmonitored', 'supervised_short_lived']);
const KEYS = Object.freeze(['schemaVersion', 'authorizationId', 'policy', 'provider', 'surface', 'supervised', 'noPurchases',
  'profileId', 'profileRevision', 'organization', 'project', 'credentialHmac', 'models', 'issuedAt', 'expiresAt', 'revokedAt',
  'providerControls', 'balance']);
const AUTHORITIES = new WeakSet();
const RESULTS = new WeakSet();

const invalid = () => Object.assign(new Error('prepaid_authorization_invalid'), { code: 'prepaid_authorization_invalid' });
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
function cents(value) { if (!Number.isSafeInteger(value) || value <= 0) throw invalid(); return value; }
function firstOfNextUtcMonth(ms) { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); }

function credentialHmac(authorizationId, credential) {
  if (typeof authorizationId !== 'string' || typeof credential !== 'string' || !credential) throw new TypeError('authorizationId and credential are required');
  return 'hmac-sha256:' + crypto.createHmac('sha256', authorizationId).update(credential).digest('hex');
}

// Closed schema, version 1. Every rule failure is prepaid_authorization_invalid.
function validateAuthorization(value) {
  closed(value, KEYS);
  if (value.schemaVersion !== 1 || typeof value.authorizationId !== 'string' || !/^pa_[A-Za-z0-9_-]{1,96}$/.test(value.authorizationId)
    || value.policy !== PREPAID_POLICY || value.provider !== 'openai' || value.surface !== 'openai_responses_agent'
    || value.supervised !== true || value.noPurchases !== true
    || !Number.isSafeInteger(value.profileRevision) || value.profileRevision < 1
    || typeof value.credentialHmac !== 'string' || !/^hmac-sha256:[a-f0-9]{64}$/.test(value.credentialHmac)) throw invalid();
  ref(value.profileId); ref(value.organization); ref(value.project);
  if (!Array.isArray(value.models) || !value.models.length || value.models.length > 16 || new Set(value.models).size !== value.models.length
    || value.models.some(m => typeof m !== 'string' || !Object.hasOwn(API_MODEL_CAPABILITIES, m) || API_MODEL_CAPABILITIES[m].provider !== 'openai')) throw invalid();
  const issued = iso(value.issuedAt), expires = iso(value.expiresAt);
  if (value.revokedAt !== null) iso(value.revokedAt);
  const controls = value.providerControls;
  closed(controls, ['autoReload', 'hardLimitCents', 'hardLimitScope', 'hardLimitEnforced', 'observedAt']);
  if (controls.autoReload !== 'off' || controls.hardLimitEnforced !== true || !['organization', 'project'].includes(controls.hardLimitScope)) throw invalid();
  const balance = value.balance;
  closed(balance, ['observedBalanceCents', 'observedAt', 'earliestCreditExpiry']);
  const hardLimit = cents(controls.hardLimitCents), observedBalance = cents(balance.observedBalanceCents);
  if (typeof balance.earliestCreditExpiry !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(balance.earliestCreditExpiry)) throw invalid();
  const creditExpiry = Date.parse(`${balance.earliestCreditExpiry}T00:00:00.000Z`);
  if (!Number.isFinite(creditExpiry) || new Date(creditExpiry).toISOString().slice(0, 10) !== balance.earliestCreditExpiry) throw invalid();
  // Short-lived: at most 24h, ending before the earliest credit expiry and the
  // provider's monthly cap reset, both of which require a fresh owner check.
  if (!(expires > issued) || expires - issued > MAX_WINDOW_MS || expires > creditExpiry || expires > firstOfNextUtcMonth(issued)) throw invalid();
  for (const observed of [iso(controls.observedAt), iso(balance.observedAt)]) {
    if (observed > issued || issued - observed > MAX_OBSERVATION_AGE_MS) throw invalid();
  }
  // The provider cap must sit comfortably below the observed balance (at
  // least a 20% nominal cushion). This is not a reserve guarantee.
  if (hardLimit * 5 > observedBalance * 4) throw invalid();
  return value;
}

const brand = (value) => { const result = Object.freeze(value); RESULTS.add(result); return result; };
const blocked = (reason, extra = {}) => brand({ allowed: false, reason, provider: 'openai', authorizationId: null, ...extra });

function createPrepaidAuthority({ dataDir } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('prepaid authority requires a data directory');
  const file = path.join(path.resolve(dataDir), FILE_NAME);

  // Returns { raw, permit } or a blocked reason. Never repairs or rewrites.
  function readPermit() {
    let fd = null;
    try {
      let stat;
      try { stat = fs.lstatSync(file); } catch (error) { return error.code === 'ENOENT' ? { reason: 'prepaid_authorization_missing' } : { reason: 'prepaid_authorization_invalid' }; }
      const strict = (s) => s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= MAX_BYTES
        && (process.platform === 'win32' || ((s.mode & 0o777) === 0o600 && s.uid === process.getuid()));
      if (!strict(stat)) return { reason: 'prepaid_authorization_invalid' };
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(fd);
      if (!strict(opened) || opened.ino !== stat.ino || opened.dev !== stat.dev) return { reason: 'prepaid_authorization_invalid' };
      const raw = Buffer.alloc(opened.size);
      let read = 0;
      while (read < raw.length) { const n = fs.readSync(fd, raw, read, raw.length - read, read); if (!n) break; read += n; }
      if (read !== raw.length) return { reason: 'prepaid_authorization_invalid' };
      return { raw, permit: validateAuthorization(JSON.parse(raw.toString('utf8'))) };
    } catch { return { reason: 'prepaid_authorization_invalid' }; }
    finally { if (fd !== null) try { fs.closeSync(fd); } catch {} }
  }

  // credentialSource is a lazy thunk returning { value, fingerprint }. It is
  // called only after the file, its scope and its window check out. The
  // result never includes `now`, so its hash is stable inside the window.
  function verify({ provider, profile, credentialSource, now }) {
    if (provider !== 'openai' || profile?.provider !== 'openai') return blocked('prepaid_provider_unsupported');
    const read = readPermit();
    if (!read.permit) return blocked(read.reason);
    const p = read.permit;
    const scope = { authorizationId: p.authorizationId };
    if (profile.id !== p.profileId || profile.revision !== p.profileRevision || profile.organization?.ref !== p.organization
      || (profile.project?.ref ?? null) !== p.project) return blocked('prepaid_scope_mismatch', scope);
    if (p.revokedAt !== null) return blocked('prepaid_authorization_revoked', scope);
    if (!Number.isFinite(now) || now < Date.parse(p.issuedAt) || now >= Date.parse(p.expiresAt)) return blocked('prepaid_authorization_expired', scope);
    if (!profile.credentialRef || typeof credentialSource !== 'function') return blocked('api_credential_unbound', scope);
    let credential = null;
    try { credential = credentialSource(); } catch { credential = null; }
    if (!credential || typeof credential.value !== 'string' || !credential.value || typeof credential.fingerprint !== 'string') {
      return blocked('api_credential_unbound', scope);
    }
    const expected = Buffer.from(p.credentialHmac), actual = Buffer.from(credentialHmac(p.authorizationId, credential.value));
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return blocked('prepaid_credential_mismatch', scope);
    return brand({ allowed: true, reason: null, provider: 'openai', authorizationId: p.authorizationId,
      authorizationHash: crypto.createHash('sha256').update(read.raw).digest('hex'),
      credentialFingerprint: credential.fingerprint, profileId: p.profileId, profileRevision: p.profileRevision,
      issuedAt: p.issuedAt, expiresAt: p.expiresAt, models: Object.freeze([...p.models]),
      providerControls: Object.freeze({ ...p.providerControls }), balance: Object.freeze({ ...p.balance }), limitations: LIMITATIONS });
  }

  // Status view: verifies the permit against the profile it names.
  function status({ profiles = [], credentialSourceFor = null, now }) {
    const read = readPermit();
    if (!read.permit) return blocked(read.reason);
    const profile = profiles.find(p => p.id === read.permit.profileId);
    if (!profile) return blocked('prepaid_scope_mismatch', { authorizationId: read.permit.authorizationId });
    return verify({ provider: profile.provider, profile, now,
      credentialSource: typeof credentialSourceFor === 'function' ? credentialSourceFor(profile.provider) : null });
  }

  const authority = Object.freeze({ policy: PREPAID_POLICY, verify, status });
  AUTHORITIES.add(authority);
  return authority;
}

const isPrepaidAuthority = (value) => AUTHORITIES.has(value);
const isPrepaidResult = (value) => RESULTS.has(value);

// Secret-free view for status output: no HMAC, credential or fingerprint.
function summarize(result) {
  if (!isPrepaidResult(result)) return { state: 'blocked', reason: 'prepaid_authorization_invalid', policy: PREPAID_POLICY };
  if (!result.allowed) return { state: 'blocked', reason: result.reason, policy: PREPAID_POLICY, authorizationId: result.authorizationId };
  return { state: 'valid', reason: null, policy: PREPAID_POLICY, authorizationId: result.authorizationId,
    profileId: result.profileId, profileRevision: result.profileRevision, issuedAt: result.issuedAt, expiresAt: result.expiresAt,
    models: [...result.models], providerControls: { ...result.providerControls }, balance: { ...result.balance },
    supervised: true, noPurchases: true, limitations: [...result.limitations] };
}

module.exports = { PREPAID_POLICY, PREPAID_LIMITATIONS: LIMITATIONS, credentialHmac, validateAuthorization, createPrepaidAuthority,
  isPrepaidAuthority, isPrepaidResult, summarize };
