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
  function bindIdentity(quotaSeat, fingerprint) {
    if (!validQuotaSeat(quotaSeat) || !/^[a-f0-9]{64}$/.test(fingerprint || '')) return false;
    const old = seats[quotaSeat];
    if (old?.selectedFingerprint === fingerprint) return true;
    if (!old && Object.keys(seats).length >= 128) return false;
    const changed = (old?.selectedFingerprint || old?.accountFingerprint)
      && (old.selectedFingerprint || old.accountFingerprint) !== fingerprint;
    // Keep each identity's protection when switching away and back. Never evict
    // it to make room: an unknown identity beyond the bound stays unavailable.
    const identityStates = structuredClone(old?.identityStates || {});
    const snapshot = (value) => {
      const copy = structuredClone(value);
      for (const key of ['identityStates', 'previousIdentity', 'nativeFetchWatermarks',
        'seatObservedAt', 'selectedFingerprint', 'identityNeedsFreshEvidence']) delete copy[key];
      return copy;
    };
    if (changed) {
      const previous = old.selectedFingerprint || old.accountFingerprint;
      identityStates[previous] = snapshot(old);
      if (!Object.hasOwn(identityStates, fingerprint) && Object.keys(identityStates).length >= 32) return false;
    }
    // First binding retains unattributed evidence. A returning identity retains
    // its windows/anchors/denials but must obtain evidence newer than the seat.
    const next = changed ? { ...(identityStates[fingerprint] || { quotaSeat, provider: 'claude', buckets: {}, history: [] }),
      identityStates, nativeFetchWatermarks: old.nativeFetchWatermarks || {},
      seatObservedAt: old.seatObservedAt ?? old.observedAt, identityNeedsFreshEvidence: true,
      previousIdentity: snapshot(old) } : structuredClone(old || { quotaSeat, buckets: {}, history: [] });
    next.selectedFingerprint = fingerprint;
    const replacement = { ...seats, [quotaSeat]: next };
    atomicWrite(observationsFile, replacement); seats = replacement; return true;
  }
  const nativeResetRadiusNs = 1000000000n;
  function hasNativeResetAuthority(window) {
    return window.source === 'claude_native_cache_v1'
      || ['nativeResetMs', 'nativeResetNs', 'nativeResetIso', 'nativeUsedPercent',
        'nativeResetAnchor', 'resetBoundaryMs'].some(field => Object.hasOwn(window, field));
  }
  function nativeResetIdentity(window, persisted = false) {
    const ms = window.nativeResetMs;
    if (!Number.isSafeInteger(ms) || ms < 0) return null;
    const text = window.nativeResetNs ?? String(BigInt(ms) * 1000000n);
    if (typeof text !== 'string' || !/^[0-9]{1,20}$/.test(text)) return null;
    const ns = BigInt(text);
    if (ns / 1000000n !== BigInt(ms)) return null;
    const boundary = Number((ns + 999999999n) / 1000000000n) * 1000;
    if (!Number.isSafeInteger(boundary)
      || !persisted && window.resetBoundaryMs != null && window.resetBoundaryMs !== boundary) return null;
    if (window.nativeResetIso != null) {
      const iso = window.nativeResetIso;
      if (typeof iso !== 'string' || Date.parse(iso) !== ms) return null;
      const fraction = /\.(\d{1,9})(?:Z|[+-]\d{2}:\d{2})$/.exec(iso)?.[1] || '';
      if (window.nativeResetNs != null
        && BigInt(ms) * 1000000n + BigInt(fraction.padEnd(9, '0').slice(3)) !== ns) return null;
    }
    return { ns, boundary };
  }
  function nativeResetAnchor(window) {
    const raw = nativeResetIdentity(window, true);
    if (!raw) return null;
    const saved = window.nativeResetAnchor;
    const anchor = saved === undefined ? { version: 1, ns: String(raw.ns),
      precision: window.nativeResetNs == null ? 'millisecond' : 'nanosecond', origin: 'retained' } : saved;
    if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)
      || Object.keys(anchor).length !== 4 || anchor.version !== 1 || typeof anchor.ns !== 'string'
      || !/^[0-9]{1,20}$/.test(anchor.ns)
      || !['millisecond', 'nanosecond'].includes(anchor.precision)
      || !['observed', 'retained'].includes(anchor.origin)) return null;
    const ns = BigInt(anchor.ns);
    const boundary = Number((ns + 999999999n) / 1000000000n) * 1000;
    if (!Number.isSafeInteger(boundary)
      || anchor.precision === 'millisecond' && ns % 1000000n !== 0n
      || raw.ns < ns - nativeResetRadiusNs || raw.ns > ns + nativeResetRadiusNs
      || window.resetBoundaryMs != null && window.resetBoundaryMs !== boundary
      || !Number.isSafeInteger(window.resetsAt) || window.resetsAt > window.nativeResetMs
      || window.resetsAt > Number(ns / 1000000n)) return null;
    return { value: anchor, ns, boundary };
  }
  function sameNativeWindow(previous, window) {
    const before = hasNativeResetAuthority(previous) ? nativeResetAnchor(previous) : null;
    const after = window.nativeResetMs != null ? nativeResetIdentity(window) : null;
    if (hasNativeResetAuthority(previous) && !before || window.nativeResetMs != null && !after) return false;
    if (!before && !after) return previous.resetsAt === window.resetsAt;
    // This explicit local radius covers measured native jitter, including
    // whole-second crossings. Compare to the immutable anchor, never the last
    // sample, so repeated refreshes cannot accumulate a sliding tolerance.
    if (before && after) return after.ns >= before.ns - nativeResetRadiusNs
      && after.ns <= before.ns + nativeResetRadiusNs;
    // Keep the existing conservative stream representation/migration rule.
    return before ? window.resetsAt === before.boundary : previous.resetsAt === after.boundary;
  }
  function observe(observation) {
    if (!observation || !validQuotaSeat(observation.quotaSeat) || !Array.isArray(observation.buckets)
      || !Number.isSafeInteger(observation.observedAt) || observation.observedAt > now() + 5000
      || !/^[a-f0-9]{64}$/.test(observation.evidenceHash || '')) return false;
    if (observation.buckets.some(b => !b || !Array.isArray(b.windows)
      || b.windows.some(w => !w || typeof w !== 'object'))) return false;
    const key = observation.quotaSeat;
    let old = seats[key];
    const native = observation.source === 'claude_native_cache_v1';
    const boundClaude = observation.provider === 'claude' && !!observation.accountFingerprint;
    if (boundClaude && old?.selectedFingerprint !== observation.accountFingerprint) return false;
    if (boundClaude && old?.accountFingerprint && old.accountFingerprint !== observation.accountFingerprint) return false;
    if (native && (!/^[a-f0-9]{64}$/.test(observation.accountFingerprint || '')
      || observation.nativeFetchedAt !== observation.observedAt || observation.observedAt > now()
      || now() - observation.observedAt > ttlMs
      || observation.observedAt <= (old?.observedAt ?? -1)
      || observation.observedAt <= (old?.seatObservedAt ?? -1)
      || observation.observedAt <= (old?.nativeFetchWatermarks?.[observation.accountFingerprint] ?? -1)
      || observation.buckets.length !== 1 || observation.buckets[0].id !== 'account'
      || observation.buckets[0].windows.length !== 2
      || !['five_hour', 'seven_day'].every((id) => observation.buckets[0].windows.some((w) => w.id === id && !w.invalid
        && typeof w.percentRemaining === 'number' && Number.isFinite(w.percentRemaining)
        && w.percentRemaining >= 0 && w.percentRemaining <= 100 && Number.isSafeInteger(w.nativeResetMs)
        && w.nativeResetMs === w.resetsAt && w.resetsAt > observation.observedAt
        && nativeResetIdentity(w))))) return false;
    if (old && observation.observedAt < Math.max(old.observedAt ?? -1, old.seatObservedAt ?? -1)) return false;
    if (!old && Object.keys(seats).length >= 128) return false;
    if (old?.accountFingerprint && !observation.accountFingerprint) return false;
    if ((old?.accountFingerprint || observation.accountFingerprint) && old?.accountFingerprint !== observation.accountFingerprint) {
      // Claude first adoption must retain prior unattributed windows and denials.
      // Identity changes use bindIdentity's independent selected-profile boundary.
      if (!(boundClaude && !old?.accountFingerprint)) old = null;
    }
    const next = structuredClone(old || { buckets: {}, history: [] });
    next.receivedAt = now();
    // A captured native stream may explicitly deny usage even when its capacity
    // fields cannot be reconciled. Latch that denial without refreshing capacity.
    const rejectCapacity = () => {
      if (boundClaude && observation.source === 'claude_stream_v1' && observation.ordinaryUsageAllowed === false) {
        const denied = { ...old, ordinaryUsageAllowed: false,
          denialObservedAt: Math.max(old?.denialObservedAt ?? -1, observation.observedAt),
          denialEvidenceHash: observation.evidenceHash,
          seatObservedAt: Math.max(old?.seatObservedAt ?? old?.observedAt ?? -1, observation.observedAt) };
        const replacement = { ...seats, [key]: denied };
        atomicWrite(observationsFile, replacement); seats = replacement;
      }
      return false;
    };
    if (observation.buckets.some(b => b.windows.some(w => Object.hasOwn(w, 'nativeResetAnchor')))) return rejectCapacity();
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
    for (const bucket of observation.buckets) for (const w of bucket.windows) {
      const prior = old?.buckets[bucket.id]?.windows?.[w.id];
      if (prior && hasNativeResetAuthority(prior) && !nativeResetAnchor(prior)) return rejectCapacity();
      if (!prior || w.invalid || !(native || hasNativeResetAuthority(prior))) continue;
      const same = sameNativeWindow(prior, w);
      if (same && (w.percentRemaining > prior.percentRemaining || observation.observedAt >= prior.resetsAt)) return rejectCapacity();
      const priorIdentity = hasNativeResetAuthority(prior) ? nativeResetAnchor(prior) : null;
      const boundary = priorIdentity?.boundary ?? prior.resetBoundaryMs ?? prior.resetsAt;
      if (!same && (observation.observedAt < boundary || w.resetsAt <= boundary)) return rejectCapacity();
      // An unequal rounded stream value close to the anchored native band is
      // ambiguous even after the original boundary. It cannot prove rollover
      // and replenish capacity. Equal-boundary streams retain the rule above.
      if (!same && priorIdentity && w.nativeResetMs == null) {
        if (!Number.isSafeInteger(w.resetsAt)) return rejectCapacity();
        const rounded = BigInt(w.resetsAt) * 1000000n;
        if (rounded + 500000000n >= priorIdentity.ns - nativeResetRadiusNs
          && rounded - 500000000n <= priorIdentity.ns + nativeResetRadiusNs) return rejectCapacity();
      }
    }
    for (const bucket of observation.buckets) {
      if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(bucket.id) || ['__proto__', 'constructor', 'prototype'].includes(bucket.id)) continue;
      const prior = next.buckets[bucket.id] || { windows: {} };
      const windows = observation.fullSnapshot ? {} : { ...prior.windows };
      for (const window of bucket.windows) {
        const value = { ...window, observedAt: observation.observedAt, source: observation.source };
        const previous = prior.windows[window.id];
        const identity = window.nativeResetMs != null ? nativeResetIdentity(window) : null;
        if (identity) {
          value.resetBoundaryMs = identity.boundary;
          value.nativeResetAnchor = { version: 1, ns: String(identity.ns),
            precision: window.nativeResetNs == null ? 'millisecond' : 'nanosecond', origin: 'observed' };
        }
        const sameReset = previous && (native || hasNativeResetAuthority(previous))
          ? sameNativeWindow(previous, window) : previous?.resetsAt === window.resetsAt;
        if (sameReset && (native || previous && hasNativeResetAuthority(previous))) {
          const before = previous.nativeResetMs != null ? nativeResetIdentity(previous, true) : null;
          const after = window.nativeResetMs != null ? nativeResetIdentity(window) : null;
          const earliest = before && (!after || before.ns <= after.ns) ? previous : window;
          const anchor = before ? nativeResetAnchor(previous) : null;
          Object.assign(value, { nativeResetMs: earliest.nativeResetMs,
            nativeResetNs: earliest.nativeResetNs,
            nativeUsedPercent: window.nativeUsedPercent ?? previous.nativeUsedPercent,
            nativeResetIso: earliest.nativeResetIso,
            nativeResetAnchor: anchor?.value ?? value.nativeResetAnchor,
            resetBoundaryMs: anchor?.boundary ?? after.boundary,
            resetsAt: Math.min(window.resetsAt, previous.resetsAt) });
        }
        if (boundClaude) value.accountFingerprint = observation.accountFingerprint;
        if (observation.source === 'claude_statusline_v1' && previous && previous.resetsAt === window.resetsAt
          && previous.percentRemaining === window.percentRemaining) continue;
        const elapsed = previous ? observation.observedAt - previous.observedAt : 0;
        // A rate has one bounded anchor: the last valid decrease.  Recomputing
        // from that anchor on unchanged observations makes a past burst decay
        // instead of treating its instantaneous rate as timeless.
        value.percentPerHour = null;
        value.rateAnchorPercentRemaining = null;
        value.rateAnchorObservedAt = null;
        if (!window.invalid && previous && (!previous.invalid || hasNativeResetAuthority(previous)) && sameReset) {
          if (elapsed >= 1000 && window.percentRemaining < previous.percentRemaining) {
            value.percentPerHour = (previous.percentRemaining - window.percentRemaining) * 3600000 / elapsed;
            value.rateAnchorPercentRemaining = previous.percentRemaining;
            value.rateAnchorObservedAt = previous.observedAt;
          } else if (window.percentRemaining === previous.percentRemaining
            && Number.isFinite(previous.rateAnchorPercentRemaining)
            && Number.isSafeInteger(previous.rateAnchorObservedAt)
            && previous.rateAnchorObservedAt <= previous.observedAt
            && previous.rateAnchorPercentRemaining > window.percentRemaining) {
            const anchorElapsed = observation.observedAt - previous.rateAnchorObservedAt;
            if (anchorElapsed >= 1000) {
              value.percentPerHour = (previous.rateAnchorPercentRemaining - window.percentRemaining) * 3600000 / anchorElapsed;
              value.rateAnchorPercentRemaining = previous.rateAnchorPercentRemaining;
              value.rateAnchorObservedAt = previous.rateAnchorObservedAt;
            }
          }
        }
        // Invalid evidence must not erase the last valid percentRemaining/resetsAt for
        // this window: retain them (even across a persisted reading that predates this
        // retention logic) so protection keeps being evaluated against the *current*
        // reserve setting instead of a boolean snapshot taken under a stale reserve, and
        // so a later cached reading can still be checked for same-reset monotonicity.
        if (window.invalid) {
          value.percentRemaining = previous?.percentRemaining ?? null;
          value.resetsAt = previous?.resetsAt ?? null;
          if (previous && hasNativeResetAuthority(previous)) for (const field of ['nativeResetMs', 'nativeResetNs', 'nativeResetIso',
            'nativeUsedPercent', 'nativeResetAnchor', 'resetBoundaryMs', 'observedAt', 'percentPerHour', 'rateAnchorPercentRemaining', 'rateAnchorObservedAt']) {
            value[field] = previous[field];
          }
        }
        windows[window.id] = value;
      }
      next.buckets[bucket.id] = { ...bucket, windows,
        spendControlReached: bucket.spendControlReached ?? prior.spendControlReached ?? null,
        reachedType: bucket.reachedType || (observation.ordinaryUsageAllowed === true && bucket.spendControlReached !== true
          ? null : prior.reachedType || null) };
    }
    next.ordinaryUsageAllowed = observation.ordinaryUsageAllowed === true && observation.observedAt <= (old?.denialObservedAt ?? -1)
      ? old.ordinaryUsageAllowed : observation.ordinaryUsageAllowed ?? old?.ordinaryUsageAllowed ?? null;
    if (observation.ordinaryUsageAllowed === false) {
      next.denialObservedAt = observation.observedAt; next.denialEvidenceHash = observation.evidenceHash;
    }
    if (native) next.identityNeedsFreshEvidence = false;
    Object.assign(next, { quotaSeat: key, provider: observation.provider, observedAt: observation.observedAt,
      seatObservedAt: Math.max(old?.seatObservedAt ?? old?.observedAt ?? -1, observation.observedAt),
      accountFingerprint: observation.accountFingerprint || old?.accountFingerprint || null,
      defaultBucket: observation.defaultBucket, source: observation.source, evidenceHash: observation.evidenceHash });
    next.history = [...(old?.history || []), { at: observation.observedAt, hash: observation.evidenceHash }].slice(-16);
    if (native) next.nativeFetchWatermarks = { ...(old?.nativeFetchWatermarks || {}), [observation.accountFingerprint]: observation.observedAt };
    const replacement = { ...seats, [key]: next };
    atomicWrite(observationsFile, replacement); seats = replacement;
    return true;
  }
  function headroom(quotaSeat, { model = null, bucket: requestedBucket = null, accountFingerprint = null } = {}) {
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
    // A low reading must keep protecting the seat even once evidence for that window
    // turns invalid or stale: invalid/stale windows retain the last valid
    // percentRemaining for that window id (see observe()) and are evaluated against
    // the *current* reserve setting, not a boolean captured under a past setting.
    const low = windows.some((w) => typeof w.percentRemaining === 'number' && w.percentRemaining <= settings.reservePercent);
    const protectedState = blocked || low;
    if (seat.identityNeedsFreshEvidence) return unknown('native_account_capacity_unbound', { protected: protectedState });
    if (accountFingerprint && (seat.accountFingerprint !== accountFingerprint
      || seat.selectedFingerprint && seat.selectedFingerprint !== accountFingerprint
      || !['five_hour', 'seven_day'].every((id) => bucket.windows[id]?.accountFingerprint === accountFingerprint))) {
      return unknown('native_account_capacity_unbound', { protected: protectedState });
    }
    // A single invalid window in this bucket's most recent evidence poisons the whole bucket:
    // a good sibling window must not be used alone to declare the bucket fresh.
    if (windows.some((w) => w.invalid || hasNativeResetAuthority(w) && !nativeResetAnchor(w))) return unknown('native_evidence_invalid', {
      bucket: bucketId, windows, protected: protectedState, evidenceHash: seat.evidenceHash,
      observedAt: seat.observedAt, ordinaryUsageAllowed: seat.ordinaryUsageAllowed });
    const fresh = windows.filter((w) => now() - w.observedAt <= ttlMs && (w.resetsAt === null || now() < w.resetsAt));
    if (!fresh.length || fresh.length !== windows.length) return unknown('native_observation_stale', {
      bucket: bucketId, windows, protected: protectedState, evidenceHash: seat.evidenceHash,
      observedAt: seat.observedAt, ordinaryUsageAllowed: seat.ordinaryUsageAllowed });
    const rateFor = (window) => Number.isFinite(window.percentPerHour) && window.percentPerHour > 0
      ? window.percentPerHour : 0;
    const triggerFor = (window) => Math.min(20, settings.reservePercent + rateFor(window) * 150 / 3600);
    const binding = fresh.reduce((a, b) => a.percentRemaining <= b.percentRemaining ? a : b);
    const percentRemaining = binding.percentRemaining;
    const percentPerHour = rateFor(binding) || null;
    // Start ahead of the reserve when recent measured depletion predicts crossing
    // it during the next probe + checkpoint window. Local token counts play no part.
    const triggerPercent = triggerFor(binding);
    const triggering = fresh.filter((window) => window.percentRemaining <= triggerFor(window))
      .sort((a, b) => (a.percentRemaining - triggerFor(a)) - (b.percentRemaining - triggerFor(b)))[0];
    const protectedByTrigger = !!triggering;
    // Keep the lowest remaining window's metrics together, and separately explain
    // protection when another window's own depletion forecast is the constraint.
    const protectionWindow = triggering ? { id: triggering.id, percentRemaining: triggering.percentRemaining,
      percentPerHour: rateFor(triggering) || null, triggerPercent: triggerFor(triggering) } : null;
    return { quotaSeat, bucket: bucketId, model: bucket.model, percentRemaining, percentPerHour,
      hoursToReserve: percentPerHour ? Math.max(0, percentRemaining - settings.reservePercent) / percentPerHour : null,
      bindingWindow: binding.id, windows, freshness: 'fresh', source: seat.source,
      observedAt: Math.min(...fresh.map((w) => w.observedAt)), evidenceHash: seat.evidenceHash,
      ordinaryUsageAllowed: seat.ordinaryUsageAllowed, triggerPercent, protectionWindow,
      protected: blocked || protectedByTrigger, floorReached: blocked || percentRemaining <= 2,
      reason: blocked ? 'vendor_usage_denied' : protectedByTrigger ? 'quota_reserve' : 'headroom_available' };
  }
  return { observe, bindIdentity, headroom, fingerprint: (seat) => seats[seat]?.accountFingerprint || null, list: () => Object.keys(seats).map((key) => headroom(key)),
    getSettings: () => ({ ...settings }),
    setSettings(input) { const value = validateSettings(input, settings); atomicWrite(settingsFile, value); settings = value; return { ...value }; },
    verdict(quotaSeat, options) { const value = headroom(quotaSeat, options); return { ...value, admit: !settings.usageProtection || !value.protected }; } };
}
module.exports = { createSubscriptionUsage, validateSettings, atomicWrite, readJson, DEFAULTS, TTL_MS };
