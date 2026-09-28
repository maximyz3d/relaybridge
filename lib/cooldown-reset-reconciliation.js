'use strict';

// Exact administrative recovery of a *local* backoff, not a vendor-limit bypass.
// Callers choose the observation; all capacity/response evidence is server-owned.
const crypto = require('node:crypto');
const path = require('node:path');
const { validCorrectionRequest } = require('./cooldown-correction');
const { BACKOFF } = require('./provider-cooldown');
const EXPECTED_KEYS = ['sourceReceiptId', 'sourceObservationId', 'until', 'lastOffenceAt', 'offences'];
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const expectedObservation = body => Object.fromEntries(EXPECTED_KEYS.map(key => [key, body[key]]));
const matchesObservation = (row, expected) => !!row && EXPECTED_KEYS.every(key => row[key] === expected[key]);
function validResetRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const { kind, accountId, acknowledgeNativeReset, ...identity } = body;
  return kind === 'claude' && accountId === 'default' && acknowledgeNativeReset === true
    && validCorrectionRequest(identity);
}
function requestDigest(body) {
  return hash({ kind: body.kind, accountId: body.accountId, quotaSeat: body.quotaSeat,
    ...expectedObservation(body), acknowledgeNativeReset: true });
}
function authorizeResetSource({ rows, receiptStoreId, seat, current, now = Date.now() }) {
  const fail = code => ({ ok: false, code });
  if (!current || current.authority === 'unknown') return fail('authority_unavailable');
  if (current.source !== 'backoff' || current.reason !== 'rate_limited' || current.scope !== 'account'
    || current.until <= now || current.offences < 1
    || current.until - BACKOFF[Math.min(current.offences - 1, BACKOFF.length - 1)] !== current.lastOffenceAt) return fail('not_local_backoff');
  const matches = rows.filter(row => row.receiptId === current.sourceReceiptId);
  if (matches.length !== 1) return fail('receipt_missing_or_ambiguous');
  const r = matches[0], c = r.cooldown, at = Date.parse(r.timestamp);
  if (!receiptStoreId || r.receiptStoreId !== receiptStoreId || r.event !== 'bridge_provider_call'
    || r.modelInvocation !== true || !['claude', 'claude_fable'].includes(r.provider)
    || r.failureClass !== 'rate_limit' || r.providerApiErrorStatus !== 429 || r.status !== 'dropped'
    || r.providerTerminalReason !== 'api_error' || r.quotaEvidence?.scope !== 'account'
    || r.quotaEvidence?.status !== 429 || r.route?.quota_seat !== seat
    || r.route?.account != null && r.route.account !== 'default'
    || !Number.isFinite(at) || at < current.lastOffenceAt || at > current.lastOffenceAt + 60000
    || !c || c.seat !== seat || c.source !== 'backoff' || c.scope !== 'account'
    || c.reason !== current.reason || c.until !== current.until || c.offences !== current.offences
    || c.sourceReceiptId !== current.sourceReceiptId) return fail('source_receipt_not_exact_429');
  return { ok: true, sourceReceiptHash: hash(r) };
}
function validateResetCapacity({ observation, fingerprint, seat, lastOffenceAt, reservePercent, now = Date.now() }) {
  const fail = code => ({ ok: false, code });
  if (!observation || observation.provider !== 'claude' || observation.source !== 'claude_native_cache_v1'
    || observation.accountFingerprint !== fingerprint || observation.quotaSeat !== seat
    || !Number.isSafeInteger(observation.observedAt) || observation.observedAt <= lastOffenceAt
    || observation.observedAt > now || now - observation.observedAt > 180000
    || observation.nativeFetchedAt !== observation.observedAt) return fail('native_capacity_not_fresh');
  const bucket = observation.buckets?.[0];
  if (observation.buckets?.length !== 1 || bucket?.id !== 'account' || bucket.windows?.length !== 2
    || bucket.spendControlReached === true || bucket.reachedType || observation.ordinaryUsageAllowed === false
    || !['five_hour', 'seven_day'].every(id => bucket.windows.some(w => w.id === id && !w.invalid
      && Number.isFinite(w.percentRemaining) && w.percentRemaining > Math.max(reservePercent, 2)
      && w.percentRemaining <= 100 && (w.resetsAt > now
        || id === 'five_hour' && w.nativeNoActiveWindow === true && w.percentRemaining === 100 && w.resetsAt === null)))) {
    return fail('native_capacity_not_available');
  }
  const w = bucket.windows.find(w => w.id === 'five_hour');
  if (!(w.nativeNoActiveWindow === true || w.windowDurationMs === 18000000
    && w.resetsAt - w.windowDurationMs >= lastOffenceAt)) return fail('native_reset_not_proven');
  return { ok: true, proof: { evidenceHash: observation.evidenceHash, observedAt: observation.observedAt,
    accountFingerprint: fingerprint, fiveHour: w, sevenDay: bucket.windows.find(w => w.id === 'seven_day') } };
}
// Rebuild known Claude CLI options instead of inheriting tool permissions or
// rejecting the installed safe slot. No shell/wrapper arguments are executable.
function fixedResetCommand(slot) {
  if (!Array.isArray(slot) || !slot.length || slot.some(v => typeof v !== 'string')) return null;
  const [binary, ...configured] = slot;
  const prefix = [];
  if (/^node(?:\.exe)?$/i.test(path.basename(binary)) && path.isAbsolute(configured[0] || '')
    && /\.(?:c|m)?js$/.test(configured[0])) prefix.push(configured.shift());
  else if (!/^claude(?:\.exe)?$/i.test(path.basename(binary))) return null;
  const flags = new Set(['--safe-mode', '--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']);
  const options = new Set(['--mcp-config', '--tools', '--permission-mode', '--autocompact', '--model', '--effort', '--setting-sources']);
  while (configured.length) {
    const flag = configured.shift();
    if (flags.has(flag)) continue;
    if (!options.has(flag) || !configured.length || configured[0].startsWith('--')) return null;
    configured.shift();
  }
  return { binary, prefix: [...prefix, '--safe-mode', '--restricted'] };
}
function sanitizeRateEvent(event) {
  const info = event?.rate_limit_info;
  const window = value => ({
    utilization: Number.isFinite(value?.utilization) ? value.utilization : null,
    resetsAt: Number.isSafeInteger(value?.resetsAt) ? value.resetsAt : null });
  return { status: ['allowed', 'allowed_warning', 'rejected'].includes(info?.status) ? info.status : 'unknown',
    rateLimitType: ['five_hour', 'seven_day'].includes(info?.rateLimitType) ? info.rateLimitType : null,
    ...window(info), unifiedWindows: Object.fromEntries(['five_hour', 'seven_day']
      .filter(id => info?.unifiedWindows?.[id] != null).map(id => [id, window(info.unifiedWindows[id])])) };
}
module.exports = { EXPECTED_KEYS, expectedObservation, matchesObservation, validResetRequest,
  requestDigest, authorizeResetSource, validateResetCapacity, fixedResetCommand, sanitizeRateEvent, hash };
