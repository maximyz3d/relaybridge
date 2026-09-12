'use strict';

const crypto = require('crypto');
const { validQuotaSeat } = require('./quota-seat');

const MAX_QUOTA_VALUE = 1_000_000_000_000;
const MAX_OVER_LIMIT_MULTIPLIER = 10;
const MAX_WINDOW_HOURS = 168;

function boundedInteger(raw) {
  const normalized = String(raw || '').replace(/,/g, '');
  if (!/^\d+$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_QUOTA_VALUE ? value : null;
}

function isoTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * Parse only xAI Grok's recognized subscription 429 diagnostic. Requiring the
 * provider, HTTP status, vendor error code, reset phrase, model and labelled
 * actual/limit tuple prevents arbitrary stderr numbers from becoming quota.
 */
function parseGrokQuota429({ provider, rateLimited, failureClass, text, model, observedAt = new Date() } = {}) {
  if (String(provider || '').toLowerCase() !== 'grok') return null;
  if (rateLimited !== true && failureClass !== 'rate_limit') return null;
  const diagnostic = String(text || '');
  if (!/(?:status[= ]429|429 Too Many Requests)/i.test(diagnostic)) return null;
  if (!/subscription:free-usage-exhausted/i.test(diagnostic)) return null;

  const pattern = /used all the included free usage for model\s+(grok-[a-z0-9._-]+)[\s\S]{0,400}?Usage resets over a rolling\s+(\d{1,3})(?:-|\s+)hour window\s*[—–-]\s*tokens\s*\(actual\/limit\)\s*:\s*([0-9][0-9,]*)\s*\/\s*([0-9][0-9,]*)/gi;
  const matches = [];
  let match;
  while ((match = pattern.exec(diagnostic)) !== null) {
    const windowHours = Number(match[2]);
    const actual = boundedInteger(match[3]);
    const limit = boundedInteger(match[4]);
    if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > MAX_WINDOW_HOURS) continue;
    if (actual === null || limit === null || limit < 1 || actual > limit * MAX_OVER_LIMIT_MULTIPLIER) continue;
    matches.push({ model: match[1].toLowerCase(), windowHours, actual, limit });
  }
  if (!matches.length) return null;

  const requestedModel = String(model || '').toLowerCase();
  const scoped = requestedModel ? matches.filter((item) => item.model === requestedModel) : matches;
  if (requestedModel && !scoped.length) return null;
  const selected = [...scoped].sort((left, right) => right.actual - left.actual)[0];
  const observedAtIso = isoTime(observedAt);
  if (!observedAtIso) return null;
  const windowMs = selected.windowHours * 60 * 60 * 1000;
  const expiresAt = new Date(new Date(observedAtIso).getTime() + windowMs).toISOString();
  const evidence = `${selected.model}|${selected.actual}|${selected.limit}|${windowMs}`;

  return {
    provider: 'grok',
    model: selected.model,
    scope: 'model',
    unit: 'tokens',
    actual: selected.actual,
    limit: selected.limit,
    remaining: Math.max(0, selected.limit - selected.actual),
    percentRemaining: Math.max(0, Math.round(((selected.limit - selected.actual) / selected.limit) * 100)),
    overLimit: selected.actual > selected.limit,
    source: 'grok_429_subscription_free_usage_exhausted',
    observedAt: observedAtIso,
    window: {
      kind: 'rolling',
      durationMs: windowMs,
      label: `rolling ${selected.windowHours}-hour window`,
    },
    reset: {
      kind: 'conservative_expiry',
      expiresAt,
      note: 'rolling-window membership is unknown; observation expires one full window after it was seen',
    },
    evidenceHash: crypto.createHash('sha256').update(evidence).digest('hex'),
  };
}

const QUALITATIVE_SOURCE = 'antigravity_individual_quota';
const QUALITATIVE_SOURCES = Object.freeze({ gemini: QUALITATIVE_SOURCE,
  copilot: 'copilot_monthly_quota', cursor: 'cursor_agent_usage_limit' });
const QUALITATIVE_TTL_MS = 5 * 60 * 1000;
const QUALITATIVE_KEYS = new Set(['kind','provider','model','scope','unit','actual','limit','remaining','percentRemaining','overLimit',
  'source','diagnosticSource','observedAt','reset','evidenceHash','seat','quotaSeat','recordedAt']);
function normalizeQualitativeQuotaExhaustion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !QUALITATIVE_KEYS.has(key))
    || value.kind !== 'quota_exhausted' || typeof value.provider !== 'string'
    || !Object.hasOwn(QUALITATIVE_SOURCES, value.provider) || value.scope !== 'account'
    || value.source !== QUALITATIVE_SOURCES[value.provider] || !['stderr','stdout'].includes(value.diagnosticSource)
    || value.seat !== undefined && value.seat !== value.provider
    || value.quotaSeat !== undefined && !validQuotaSeat(value.quotaSeat)
    || value.recordedAt !== undefined && (typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt)) || new Date(value.recordedAt).toISOString() !== value.recordedAt)
    || !['unit','actual','limit','remaining','percentRemaining','overLimit'].every(key => value[key] === null)
    || !(value.model === null || typeof value.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value.model))
    || typeof value.evidenceHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.evidenceHash)
    || !value.reset || typeof value.reset !== 'object' || Array.isArray(value.reset)
    || Object.keys(value.reset).some(key => !['kind','durationMs','expiresAt'].includes(key))
    || !['provider_reset','conservative_expiry'].includes(value.reset.kind)) return null;
  if (typeof value.observedAt !== 'string' || typeof value.reset.expiresAt !== 'string') return null;
  const observed = Date.parse(value.observedAt), expires = Date.parse(value.reset.expiresAt), duration = value.reset.durationMs;
  if (!Number.isFinite(observed) || !Number.isFinite(expires)
    || new Date(observed).toISOString() !== value.observedAt || new Date(expires).toISOString() !== value.reset.expiresAt
    || !Number.isSafeInteger(duration) || duration <= 0 || duration > MAX_WINDOW_HOURS * 3600000 || expires - observed !== duration
    || value.reset.kind === 'conservative_expiry' && duration !== QUALITATIVE_TTL_MS) return null;
  return { kind:'quota_exhausted', provider:value.provider, model:value.model, scope:'account', unit:null,
    actual:null, limit:null, remaining:null, percentRemaining:null, overLimit:null,
    source:QUALITATIVE_SOURCES[value.provider], diagnosticSource:value.diagnosticSource, observedAt:value.observedAt,
    reset:{kind:value.reset.kind,durationMs:duration,expiresAt:value.reset.expiresAt}, evidenceHash:value.evidenceHash };
}
function activeQualitativeQuotaExhaustion(value, nowMs = Date.now()) {
  const normalized = normalizeQualitativeQuotaExhaustion(value);
  return normalized && Date.parse(normalized.observedAt) <= nowMs && Date.parse(normalized.reset.expiresAt) > nowMs ? normalized : null;
}
function parseGeminiQuotaExhaustion({provider,stdout='',stderr='',exitCode,stopReason,supervisorStopReason,model=null,observedAt=new Date()} = {}) {
  if (provider !== 'gemini' || !Number.isInteger(exitCode) || exitCode === 0 || stopReason || supervisorStopReason) return null;
  const clean = value => typeof value === 'string' && value.length <= 2048
    ? value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g,'').replace(/\r\n/g,'\n').trim() : null;
  const out = clean(stdout), err = clean(stderr);
  if (out === null || err === null) return null;
  const pattern = /^(?:Error:\s*)?Individual quota reached(?:[.;]?|(?:[.;,]{1,3}[ \t]*(?:\n[ \t]*)?|[ \t]+|\n[ \t]*)resets in[ \t]+([^\r\n]+))$/i;
  // This exact vendor upgrade sentence is part of the diagnostic, not arbitrary
  // prose surrounding a quota phrase. Preserve the one-channel/exit safeguards.
  const diagnostic = (!out ? err : !err ? out : null)?.replace(
    /^(Individual quota reached[.]) Please upgrade your subscription to increase your limits[.] (?=Resets in )/i, '$1 ');
  const match = diagnostic?.match(pattern);
  if (!match) return null;
  const reset = (match[1] || '').replace(/[.]$/,'').trim();
  const units = /^(?:(\d{1,3})h\s*)?(?:(\d{1,2})m\s*)?(?:(\d{1,2})s)?$/.exec(reset);
  let duration = null;
  if (units && (units[1] || units[2] || units[3]) && Number(units[2] || 0) < 60 && Number(units[3] || 0) < 60) {
    const proposed = (Number(units[1] || 0) * 3600 + Number(units[2] || 0) * 60 + Number(units[3] || 0)) * 1000;
    if (proposed > 0 && proposed <= MAX_WINDOW_HOURS * 3600000) duration = proposed;
  }
  const at = isoTime(observedAt);
  if (!at) return null;
  return normalizeQualitativeQuotaExhaustion({ kind:'quota_exhausted', provider:'gemini', model, scope:'account',
    unit:null, actual:null, limit:null, remaining:null, percentRemaining:null, overLimit:null,
    source:QUALITATIVE_SOURCE, diagnosticSource:out ? 'stdout' : 'stderr', observedAt:at,
    reset:{kind:duration === null ? 'conservative_expiry' : 'provider_reset',durationMs:duration ?? QUALITATIVE_TTL_MS,
      expiresAt:new Date(Date.parse(at) + (duration ?? QUALITATIVE_TTL_MS)).toISOString()},
    evidenceHash:crypto.createHash('sha256').update(out || err).digest('hex') });
}
module.exports = { parseGrokQuota429, MAX_QUOTA_VALUE, MAX_OVER_LIMIT_MULTIPLIER, MAX_WINDOW_HOURS,
  parseGeminiQuotaExhaustion, normalizeQualitativeQuotaExhaustion, activeQualitativeQuotaExhaustion };
