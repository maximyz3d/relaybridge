'use strict';

const raw = require('./config/timeout-policy.json');

function positiveInteger(name) {
  const value = Number(raw[name]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`config/timeout-policy.json ${name} must be a positive integer`);
  }
  return value;
}

// oneShotDefaultMs, oneShotMaxMs and broadcastQueueWaitMs are no longer
// ceilings: null means "no caller deadline / no enforced maximum". A number
// there is still accepted for a check-in hint, never as a hard stop.
function nullableNonNegativeInteger(name) {
  const value = raw[name];
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`config/timeout-policy.json ${name} must be null or a positive integer`);
  }
  return parsed;
}

const minimumMs = positiveInteger('minimumMs');
const oneShotDefaultMs = nullableNonNegativeInteger('oneShotDefaultMs');
const oneShotMaxMs = nullableNonNegativeInteger('oneShotMaxMs');
const transportGraceMs = positiveInteger('transportGraceMs');
const mcpHostGraceMs = positiveInteger('mcpHostGraceMs');
const broadcastQueueWaitMs = nullableNonNegativeInteger('broadcastQueueWaitMs');

if (oneShotDefaultMs !== null && minimumMs > oneShotDefaultMs) {
  throw new Error('config/timeout-policy.json must satisfy minimumMs <= oneShotDefaultMs');
}
if (oneShotDefaultMs !== null && oneShotMaxMs !== null && oneShotDefaultMs > oneShotMaxMs) {
  throw new Error('config/timeout-policy.json must satisfy oneShotDefaultMs <= oneShotMaxMs');
}

// timeoutMs (and its derived hint here) is a check-in hint only; it is never
// enforced as a ceiling. Returns null when there is no hint to give — callers
// must treat null as uncapped, never coerce it to Infinity.
function normalizeOneShotTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return oneShotDefaultMs;
  return Math.max(minimumMs, Math.trunc(parsed));
}

function transportTimeoutMs(value) {
  const normalized = normalizeOneShotTimeoutMs(value);
  return normalized === null ? null : normalized + transportGraceMs;
}

module.exports = Object.freeze({
  minimumMs,
  oneShotDefaultMs,
  oneShotMaxMs,
  transportGraceMs,
  mcpHostGraceMs,
  broadcastQueueWaitMs,
  normalizeOneShotTimeoutMs,
  transportTimeoutMs,
});
