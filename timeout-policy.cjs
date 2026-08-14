'use strict';

const raw = require('./config/timeout-policy.json');

function positiveInteger(name) {
  const value = Number(raw[name]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`config/timeout-policy.json ${name} must be a positive integer`);
  }
  return value;
}

const minimumMs = positiveInteger('minimumMs');
const oneShotDefaultMs = positiveInteger('oneShotDefaultMs');
const oneShotMaxMs = positiveInteger('oneShotMaxMs');
const transportGraceMs = positiveInteger('transportGraceMs');
const mcpHostGraceMs = positiveInteger('mcpHostGraceMs');
const broadcastQueueWaitMs = positiveInteger('broadcastQueueWaitMs');

if (minimumMs > oneShotDefaultMs || oneShotDefaultMs > oneShotMaxMs) {
  throw new Error('config/timeout-policy.json must satisfy minimumMs <= oneShotDefaultMs <= oneShotMaxMs');
}

function normalizeOneShotTimeoutMs(value) {
  const parsed = Number(value);
  const selected = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : oneShotDefaultMs;
  return Math.max(minimumMs, Math.min(selected, oneShotMaxMs));
}

function transportTimeoutMs(value) {
  return normalizeOneShotTimeoutMs(value) + transportGraceMs;
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
