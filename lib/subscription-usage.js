'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validQuotaSeat } = require('./quota-seat');
const DEFAULTS = Object.freeze(require('../config/continuity-policy.json'));
const TTL_MS = 180000;
function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    fs.fsyncSync(fd); fs.closeSync(fd); fd = null; fs.renameSync(temp, file);
    if (process.platform !== 'win32') { const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
  } finally { if (fd != null) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
}
function readJson(file, fallback) {
  try { if (fs.statSync(file).size > 4 * 1024 * 1024) throw new Error('continuity store exceeds bound'); return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function validateSettings(input, previous = DEFAULTS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('continuity settings must be an object');
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULTS, key) || key === 'schemaVersion' && input[key] !== 1) throw new Error('unknown continuity setting');
    if (key === 'reservePercent') {
      if (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 2 || input[key] > 5) throw new Error('reservePercent must be between 2 and 5');
    } else if (key !== 'schemaVersion' && typeof input[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  }
  return { ...previous, ...input, schemaVersion: 1 };
}
function createSubscriptionUsage({ dataDir, now = Date.now, ttlMs = TTL_MS } = {}) {
  const settingsFile = path.join(dataDir, 'continuity-settings.json');
  const observationsFile = path.join(dataDir, 'native-usage.json');
  let settings = validateSettings(readJson(settingsFile, {}));
  let seats = readJson(observationsFile, {});
  if (!seats || typeof seats !== 'object' || Array.isArray(seats)) throw new Error('invalid native usage store');
  function observe(observation) {
    if (!observation || !validQuotaSeat(observation.quotaSeat) || !Array.isArray(observation.buckets)
      || !Number.isSafeInteger(observation.observedAt) || observation.observedAt > now() + 5000
      || !/^[a-f0-9]{64}$/.test(observation.evidenceHash || '')) return false;
    const key = observation.quotaSeat;
    let old = seats[key];
    if (old && observation.observedAt < old.observedAt) return false;
    if (!old && Object.keys(seats).length >= 128) return false;
    if (old?.accountFingerprint && !observation.accountFingerprint) return false;
    if ((old?.accountFingerprint || observation.accountFingerprint) && old?.accountFingerprint !== observation.accountFingerprint) old = null;
    const next = structuredClone(old || { buckets: {}, history: [] });
    next.receivedAt = now();
    // Status-line UI refreshes may repeat a cached account observation forever.
    if (observation.source === 'claude_statusline_v1' && old?.history?.some((h) => h.hash === observation.evidenceHash)) {
      seats[key] = { ...old, receivedAt: now() }; return false;
    }
    if (observation.source === 'claude_statusline_v1' && old) {
      // A cached statusline cannot restore capacity within the same window or
      // supersede a newer stream observation simply by arriving later.
      for (const bucket of observation.buckets) for (const w of bucket.windows) {
        const prior = old.buckets[bucket.id]?.windows?.[w.id];
        if (prior && w.resetsAt === prior.resetsAt && w.percentRemaining > prior.percentRemaining) return false;
        if (prior && w.resetsAt < prior.resetsAt) return false;
      }
    }
    for (const bucket of observation.buckets) {
      if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(bucket.id) || ['__proto__', 'constructor', 'prototype'].includes(bucket.id)) continue;
      const prior = next.buckets[bucket.id] || { windows: {} };
      const windows = observation.fullSnapshot ? {} : { ...prior.windows };
      for (const window of bucket.windows) {
        const value = { ...window, observedAt: observation.observedAt, source: observation.source };
        const previous = prior.windows[window.id];
        if (observation.source === 'claude_statusline_v1' && previous && previous.resetsAt === window.resetsAt
          && previous.percentRemaining === window.percentRemaining) continue;
        const elapsed = previous ? observation.observedAt - previous.observedAt : 0;
        value.percentPerHour = previous && previous.resetsAt === window.resetsAt && elapsed >= 1000
          && window.percentRemaining < previous.percentRemaining
          ? (previous.percentRemaining - window.percentRemaining) * 3600000 / elapsed
          : previous && previous.resetsAt === window.resetsAt && window.percentRemaining === previous.percentRemaining
            ? previous.percentPerHour || null : null;
        windows[window.id] = value;
      }
      next.buckets[bucket.id] = { ...bucket, windows,
        spendControlReached: bucket.spendControlReached ?? prior.spendControlReached ?? null,
        reachedType: bucket.reachedType || (observation.ordinaryUsageAllowed === true && bucket.spendControlReached !== true
          ? null : prior.reachedType || null) };
    }
    next.ordinaryUsageAllowed = observation.ordinaryUsageAllowed ?? old?.ordinaryUsageAllowed ?? null;
    Object.assign(next, { quotaSeat: key, provider: observation.provider, observedAt: observation.observedAt,
      accountFingerprint: observation.accountFingerprint || old?.accountFingerprint || null,
      defaultBucket: observation.defaultBucket, source: observation.source, evidenceHash: observation.evidenceHash });
    next.history = [...(old?.history || []), { at: observation.observedAt, hash: observation.evidenceHash }].slice(-16);
    const replacement = { ...seats, [key]: next };
    atomicWrite(observationsFile, replacement); seats = replacement;
    return true;
  }
  function headroom(quotaSeat, { model = null, bucket: requestedBucket = null } = {}) {
    const seat = seats[quotaSeat];
    const unknown = (reason, extra = {}) => ({ quotaSeat, percentRemaining: null, freshness: seat ? 'stale' : 'unknown',
      source: seat?.source || null, reason, protected: false, ...extra });
    if (!seat) return unknown('no_native_observation');
    const modelBucket = model && Object.values(seat.buckets).find((b) => b.model === model);
    const bucketId = requestedBucket || modelBucket?.id || seat.defaultBucket;
    const bucket = seat.buckets[bucketId];
    const blocked = seat.ordinaryUsageAllowed === false || bucket?.spendControlReached === true || !!bucket?.reachedType;
    if (!bucket) return unknown('quota_bucket_applicability_unknown', { protected: blocked });
    const windows = Object.values(bucket.windows);
    const fresh = windows.filter((w) => now() - w.observedAt <= ttlMs && (w.resetsAt === null || now() < w.resetsAt));
    const low = windows.some((w) => w.percentRemaining <= settings.reservePercent);
    if (!fresh.length || fresh.length !== windows.length) return unknown('native_observation_stale', {
      bucket: bucketId, windows, protected: blocked || low, evidenceHash: seat.evidenceHash,
      observedAt: seat.observedAt, ordinaryUsageAllowed: seat.ordinaryUsageAllowed });
    const binding = fresh.reduce((a, b) => a.percentRemaining <= b.percentRemaining ? a : b);
    const percentRemaining = binding.percentRemaining;
    const percentPerHour = Math.max(0, ...fresh.map((w) => w.percentPerHour || 0)) || null;
    // Start ahead of the reserve when recent measured depletion predicts crossing
    // it during the next probe + checkpoint window. Local token counts play no part.
    const triggerPercent = Math.min(20, settings.reservePercent + (percentPerHour || 0) * 150 / 3600);
    return { quotaSeat, bucket: bucketId, model: bucket.model, percentRemaining, percentPerHour,
      hoursToReserve: percentPerHour ? Math.max(0, percentRemaining - settings.reservePercent) / percentPerHour : null,
      bindingWindow: binding.id, windows, freshness: 'fresh', source: seat.source,
      observedAt: Math.min(...fresh.map((w) => w.observedAt)), evidenceHash: seat.evidenceHash,
      ordinaryUsageAllowed: seat.ordinaryUsageAllowed, triggerPercent,
      protected: blocked || percentRemaining <= triggerPercent, floorReached: blocked || percentRemaining <= 2,
      reason: blocked ? 'vendor_usage_denied' : percentRemaining <= triggerPercent ? 'quota_reserve' : 'headroom_available' };
  }
  return { observe, headroom, fingerprint: (seat) => seats[seat]?.accountFingerprint || null, list: () => Object.keys(seats).map((key) => headroom(key)),
    getSettings: () => ({ ...settings }),
    setSettings(input) { const value = validateSettings(input, settings); atomicWrite(settingsFile, value); settings = value; return { ...value }; },
    verdict(quotaSeat, options) { const value = headroom(quotaSeat, options); return { ...value, admit: !settings.usageProtection || !value.protected }; } };
}
module.exports = { createSubscriptionUsage, validateSettings, atomicWrite, readJson, DEFAULTS, TTL_MS };
