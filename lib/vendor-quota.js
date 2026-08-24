'use strict';

const crypto = require('crypto');

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

module.exports = { parseGrokQuota429, MAX_QUOTA_VALUE, MAX_OVER_LIMIT_MULTIPLIER, MAX_WINDOW_HOURS };
