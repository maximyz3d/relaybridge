'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createSubscriptionUsage } = require('../lib/subscription-usage');
const { parseCodexRateLimits, parseClaudeStatuslineUsage, parseClaudeStreamRateLimit } = require('../lib/native-usage');
const T = 1700000000000;
const { parseClaudeNativeCache } = require('../lib/native-usage');
const uuid = '11111111-2222-3333-4444-555555555555';
function native(f, remaining = 11, resetMs = T + 86400000 - 437, accountUuid = uuid) {
  return parseClaudeNativeCache({ oauthAccount: { accountUuid }, cachedUsageUtilization: { accountUuid, fetchedAtMs: f.at(), utilization:
    Object.fromEntries(['five_hour', 'seven_day'].map(name => [name, { utilization: 100 - remaining, resets_at: new Date(resetMs).toISOString() }])) } },
  { quotaSeat: 'claude', now: f.at() });
}
test('Claude first identity binding retains legacy denials and needs complete fresh bound windows', t => {
  const f = fixture(t), reset = T / 1000 + 86400;
  const old = parseClaudeStreamRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected',
    unifiedWindows: { five_hour: { utilization: .97, resetsAt: reset }, seven_day: { utilization: .97, resetsAt: reset } } } },
  { quotaSeat: 'claude', observedAt: f.at() });
  f.store.observe(old); const cached = native(f, 3), fp = cached.accountFingerprint;
  const prior = JSON.parse(fs.readFileSync(path.join(f.dir, 'native-usage.json'))).claude;
  assert.equal(f.store.bindIdentity('claude', fp), true);
  const bound = JSON.parse(fs.readFileSync(path.join(f.dir, 'native-usage.json'))).claude;
  assert.deepEqual(bound.buckets, prior.buckets); assert.deepEqual(bound.history, prior.history); assert.equal(bound.observedAt, prior.observedAt);
  assert.equal(f.store.headroom('claude', { accountFingerprint: fp }).reason, 'native_account_capacity_unbound');
  assert.equal(f.store.headroom('claude').protected, true);
  f.advance(1000); assert.equal(f.store.observe(native(f, 3)), true);
  const usage = f.store.headroom('claude', { accountFingerprint: fp }); assert.equal(usage.freshness, 'fresh'); assert.equal(usage.protected, true);
  assert.equal(usage.ordinaryUsageAllowed, false);
  const oldSnapshot = JSON.parse(fs.readFileSync(path.join(f.dir, 'native-usage.json'))).claude;
  const other = native(f, 90, T + 86400000 - 437, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(f.store.bindIdentity('claude', other.accountFingerprint), true);
  assert.equal(f.store.headroom('claude', { accountFingerprint: other.accountFingerprint }).percentRemaining, null);
  const isolated = JSON.parse(fs.readFileSync(path.join(f.dir, 'native-usage.json'))).claude;
  assert.deepEqual(isolated.previousIdentity.buckets, oldSnapshot.buckets);
  assert.equal(f.store.observe(native(f, 3)), false, 'previous account must not overwrite current selection');
});
test('cache watermark persists and replay cannot renew freshness or discard newer stream evidence', t => {
  const f = fixture(t); const value = native(f); f.store.bindIdentity('claude', value.accountFingerprint); assert.equal(f.store.observe(value), true);
  f.advance(1000); const reopened = createSubscriptionUsage({ dataDir: f.dir, now: f.at });
  const before = fs.readFileSync(path.join(f.dir, 'native-usage.json'), 'utf8');
  assert.equal(reopened.observe(value), false); assert.equal(fs.readFileSync(path.join(f.dir, 'native-usage.json'), 'utf8'), before);
  const current = native(f); assert.equal(reopened.observe(current), true);
  const stream = parseClaudeStreamRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed',
    unifiedWindows: { five_hour: { utilization: .89, resetsAt: (T + 86400000) / 1000 }, seven_day: { utilization: .89, resetsAt: (T + 86400000) / 1000 } } } },
  { quotaSeat: 'claude', observedAt: f.at() + 1000, accountFingerprint: value.accountFingerprint });
  f.advance(1000); assert.equal(reopened.observe(stream), true); assert.equal(reopened.observe(current), false);
  f.advance(180001); assert.equal(reopened.observe(current), false); assert.equal(reopened.headroom('claude').freshness, 'stale');
});
test('returning to an identity restores reserve and denial protection across restart without reusing capacity', t => {
  const f = fixture(t), a = native(f, 4), fp = a.accountFingerprint;
  const state = () => JSON.parse(fs.readFileSync(path.join(f.dir, 'native-usage.json'))).claude;
  f.store.bindIdentity('claude', fp); assert.equal(f.store.observe(a), true); f.advance(6000);
  const denied = parseClaudeStreamRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected',
    unifiedWindows: Object.fromEntries(['five_hour', 'seven_day'].map(id => [id,
      { utilization: .97, resetsAt: (T + 86400000) / 1000 }])) } },
  { quotaSeat: 'claude', observedAt: f.at(), accountFingerprint: fp });
  assert.equal(f.store.observe(denied), true); const prior = state();
  const b = native(f, 90, T + 86400000, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(f.store.bindIdentity('claude', b.accountFingerprint), true);
  const restarted = createSubscriptionUsage({ dataDir: f.dir, now: f.at });
  assert.equal(restarted.bindIdentity('claude', fp), true);
  assert.deepEqual(state().buckets, prior.buckets); assert.equal(state().ordinaryUsageAllowed, false);
  assert.equal(restarted.headroom('claude', { accountFingerprint: fp }).freshness, 'stale');
  assert.equal(restarted.headroom('claude').protected, true);
  f.advance(1000); assert.equal(restarted.observe(native(f, 90)), false, 'new timestamp cannot replenish the same account window');
  assert.equal(restarted.observe(native(f, 3)), true);
  assert.equal(restarted.headroom('claude').protected, true); assert.equal(restarted.headroom('claude').ordinaryUsageAllowed, false);
  assert.equal(state().buckets.account.windows.five_hour.rateAnchorObservedAt, prior.buckets.account.windows.five_hour.rateAnchorObservedAt);
});
test('identity-bound denials survive rejected capacity without renewing windows or accepting older permission', t => {
  for (const shifted of [false, true]) {
    const f = fixture(t), a = native(f, 80), fp = a.accountFingerprint;
    const state = () => JSON.parse(fs.readFileSync(path.join(f.dir, 'native-usage.json'))).claude;
    f.store.bindIdentity('claude', fp); f.store.observe(a); const prior = state(); f.advance(1000);
    const event = (status, remaining, offset = 0, observedAt = f.at(), accountFingerprint = fp) =>
      parseClaudeStreamRateLimit({ type: 'rate_limit_event', rate_limit_info: { status,
        unifiedWindows: Object.fromEntries(['five_hour', 'seven_day'].map(id => [id,
          { utilization: (100 - remaining) / 100, resetsAt: (T + 86400000) / 1000 + offset }])) } },
      { quotaSeat: 'claude', observedAt, accountFingerprint });
    assert.equal(f.store.observe(event('rejected', shifted ? 80 : 90, shifted ? 1 : 0)), false);
    assert.deepEqual(state().buckets, prior.buckets); assert.equal(state().observedAt, prior.observedAt);
    assert.equal(state().source, prior.source); assert.equal(state().evidenceHash, prior.evidenceHash);
    assert.equal(f.store.headroom('claude').ordinaryUsageAllowed, false); assert.equal(f.store.verdict('claude').admit, false);
    assert.equal(f.store.observe(event('allowed', 80, 0, f.at() - 1)), false);
    const reopened = createSubscriptionUsage({ dataDir: f.dir, now: f.at });
    assert.equal(reopened.verdict('claude').admit, false);
    assert.equal(reopened.observe(event('allowed', 80)), true);
    assert.equal(reopened.verdict('claude').admit, false, 'same-time permission cannot clear denial');
    f.advance(1000); assert.equal(reopened.observe(event('allowed', 80)), true);
    assert.equal(reopened.verdict('claude').admit, true);
  }
});
test('fractional reset equivalence retains rate anchor in both orders and rejects drift and recovery', t => {
  for (const nativeFirst of [true, false]) {
    const f = fixture(t), fp = native(f).accountFingerprint, reset = (T + 86400000) / 1000;
    const stream = remaining => parseClaudeStreamRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed',
      unifiedWindows: Object.fromEntries(['five_hour', 'seven_day'].map(name => [name, { utilization: (100 - remaining) / 100, resetsAt: reset }])) } },
    { quotaSeat: 'claude', observedAt: f.at(), accountFingerprint: fp });
    f.store.bindIdentity('claude', fp); assert.equal(f.store.observe(nativeFirst ? native(f, 12) : stream(12)), true);
    f.advance(6000); assert.equal(f.store.observe(nativeFirst ? stream(11) : native(f, 11)), true);
    assert.equal(Math.round(f.store.headroom('claude').percentPerHour), 600);
    const anchor = f.store.headroom('claude').windows[0].rateAnchorObservedAt;
    f.advance(150000); assert.equal(f.store.observe(native(f, 11)), true);
    const usage = f.store.headroom('claude'); assert.equal(usage.windows[0].rateAnchorObservedAt, anchor); assert.ok(usage.percentPerHour < 30); assert.equal(usage.protected, false);
    f.advance(1000); assert.equal(f.store.observe(native(f, 12)), false, 'same window cannot restore capacity');
    assert.equal(f.store.observe(native(f, 11, T + 86400000 - 436)), true, 'jitter within the fixed key is one window');
    assert.equal(f.store.headroom('claude').windows[0].resetsAt, T + 86400000 - 437, 'jitter must not extend expiry');
    f.advance(1000);
    assert.equal(f.store.observe(native(f, 11, T + 86400000 + 1000)), false, 'future reset drift is not rollover');
    f.advance(86400000); assert.equal(f.store.observe(native(f, 90, f.at() + 86400000)), true);
    assert.equal(f.store.headroom('claude').percentPerHour, null);
  }
});
function fixture(t, initialAt = T) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-native-store-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let at = initialAt; const store = createSubscriptionUsage({ dataDir: dir, now: () => at });
  const codex = (remaining, extra = {}, seat = 'codex') => parseCodexRateLimits({ ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex' },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 100 - remaining, windowDurationMins: 10080, resetsAt: T / 1000 + 86400 } } }, ...extra }, { quotaSeat: seat, observedAt: at });
  return { store, dir, codex, advance: (ms) => { at += ms; }, at: () => at };
}
test('invalid stream retains native protection and last valid depletion anchor', t => {
  const f = fixture(t), fp = native(f, 12).accountFingerprint; f.store.bindIdentity('claude', fp); f.store.observe(native(f, 12));
  f.advance(6000); f.store.observe(native(f, 11));
  const before = f.store.headroom('claude').windows[0]; f.advance(1000);
  const malformed = parseClaudeStreamRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed',
    unifiedWindows: { five_hour: { utilization: 'invalid', resetsAt: (T + 86400000) / 1000 } } } },
  { quotaSeat: 'claude', observedAt: f.at(), accountFingerprint: fp });
  assert.equal(f.store.observe(malformed), true); assert.notEqual(f.store.headroom('claude').freshness, 'fresh');
  const invalid = f.store.headroom('claude').windows[0];
  assert.equal(invalid.nativeResetNs, before.nativeResetNs); assert.equal(invalid.rateAnchorObservedAt, before.rateAnchorObservedAt);
  f.advance(1000); assert.equal(f.store.observe(native(f, 90)), false);
  f.advance(150000); assert.equal(f.store.observe(native(f, 11)), true);
  assert.equal(f.store.headroom('claude').windows[0].rateAnchorObservedAt, before.rateAnchorObservedAt);
  assert.ok(f.store.headroom('claude').percentPerHour < 30);
});
test('selected identity and seat high-water mark cannot be replaced by stream claims or older new-account fetches', t => {
  const f = fixture(t), first = native(f); assert.equal(f.store.observe(first), false, 'independent profile binding is required');
  f.store.bindIdentity('claude', first.accountFingerprint); assert.equal(f.store.observe(first), true);
  const second = native(f, 90, T + 86400000, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(f.store.observe(second), false); f.store.bindIdentity('claude', second.accountFingerprint);
  assert.equal(f.store.observe(second), false, 'account isolation retains the prior seat observation barrier');
  f.advance(1000); assert.equal(f.store.observe(native(f, 90, T + 86400000, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')), true);
});
test('submillisecond reset precision rejects early stream boundaries but accepts fixed-key native jitter', t => {
  const f = fixture(t), reset = T + 86400000;
  const exact = suffix => parseClaudeNativeCache({ oauthAccount: { accountUuid: uuid }, cachedUsageUtilization: {
    accountUuid: uuid, fetchedAtMs: f.at(), utilization: Object.fromEntries(['five_hour', 'seven_day'].map(id =>
      [id, { utilization: 89, resets_at: new Date(reset).toISOString().replace('.000Z', suffix) }])) } }, { quotaSeat: 'claude', now: f.at() });
  const value = exact('.000001Z'); f.store.bindIdentity('claude', value.accountFingerprint); assert.equal(f.store.observe(value), true); f.advance(1000);
  const stream = seconds => parseClaudeStreamRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {
    five_hour: { utilization: .89, resetsAt: seconds }, seven_day: { utilization: .89, resetsAt: seconds } } } },
  { quotaSeat: 'claude', accountFingerprint: value.accountFingerprint, observedAt: f.at() });
  assert.equal(f.store.observe(stream(reset / 1000)), false);
  assert.equal(f.store.observe(stream(reset / 1000 + 1)), true); f.advance(1000);
  assert.equal(f.store.observe(exact('.000002Z')), true); f.advance(1000);
  assert.equal(f.store.observe(exact('.000001Z')), true);
  assert.equal(f.store.headroom('claude').windows[0].resetsAt, reset, 'expiry uses the conservative original raw millisecond');
});

function preciseNative(f, resets, remaining = [11, 11], { at = f.at(), accountUuid = uuid } = {}) {
  return parseClaudeNativeCache({ oauthAccount: { accountUuid }, cachedUsageUtilization: {
    accountUuid, fetchedAtMs: at, utilization: Object.fromEntries(['five_hour', 'seven_day'].map((id, i) =>
      [id, { utilization: 100 - remaining[i], resets_at: resets[i] }])) } }, { quotaSeat: 'claude', now: at });
}
function preciseIso(ns) {
  return new Date(Number(ns / 1000000n)).toISOString().replace(/\.\d{3}Z$/, `.${String(ns % 1000000000n).padStart(9, '0')}Z`);
}
function storeBytes(f) { return fs.readFileSync(path.join(f.dir, 'native-usage.json'), 'utf8'); }
function storedSeat(f) { return JSON.parse(storeBytes(f)).claude; }

test('captured native reset jitter refreshes exact fetch time without capacity uplift or expiry extension', t => {
  const f = fixture(t, 1789316910862);
  const firstResets = ['2026-09-13T17:59:59.584712+00:00', '2026-09-13T23:59:59.584741+00:00'];
  const refreshedResets = ['2026-09-13T17:59:59.925436+00:00', '2026-09-13T23:59:59.925462+00:00'];
  const first = preciseNative(f, firstResets, [91, 10]);
  assert.ok(first); f.store.bindIdentity('claude', first.accountFingerprint);
  assert.equal(f.store.observe(first), true);
  f.advance(1789317230534 - f.at());
  assert.equal(f.store.headroom('claude').freshness, 'stale');
  const refreshed = preciseNative(f, refreshedResets, [91, 10]);
  assert.equal(f.store.observe(refreshed), true);
  const after = storedSeat(f), windows = Object.values(after.buckets.account.windows);
  assert.equal(after.observedAt, 1789317230534);
  assert.equal(after.nativeFetchWatermarks[first.accountFingerprint], 1789317230534);
  assert.equal(f.store.headroom('claude', { accountFingerprint: first.accountFingerprint }).freshness, 'fresh');
  assert.deepEqual(windows.map(w => w.percentRemaining), [91, 10]);
  assert.deepEqual(windows.map(w => w.resetsAt), firstResets.map(Date.parse));
  assert.deepEqual(windows.map(w => w.resetBoundaryMs), [1789322400000, 1789344000000]);
  f.advance(6000); assert.equal(f.store.observe(preciseNative(f, refreshedResets, [90, 9])), true);
  const decreased = f.store.headroom('claude').windows;
  assert.deepEqual(decreased.map(w => w.rateAnchorObservedAt), [1789317230534, 1789317230534]);
  assert.deepEqual(decreased.map(w => w.percentPerHour), [600, 600]);
  f.advance(1000); const beforeUplift = storeBytes(f);
  assert.equal(f.store.observe(preciseNative(f, firstResets, [90, 10])), false, 'one replenished sibling rejects the entire fetch');
  assert.equal(storeBytes(f), beforeUplift);
});

test('fixed native keys survive jitter chains restart and whole-second stream roundtrips with earliest expiry', t => {
  const f = fixture(t), boundary = T + 86400000, baseNs = BigInt(boundary - 1000) * 1000000n;
  const observation = fraction => preciseNative(f, [preciseIso(baseNs + fraction), preciseIso(baseNs + fraction)]);
  const initial = observation(584712000n); f.store.bindIdentity('claude', initial.accountFingerprint);
  assert.equal(f.store.observe(initial), true);
  let earliest = boundary - 416;
  for (const fraction of [925436000n, 100000001n, 999999999n, 1n, 800000000n]) {
    f.advance(1000);
    f.store = createSubscriptionUsage({ dataDir: f.dir, now: f.at });
    assert.equal(f.store.observe(observation(fraction)), true);
    earliest = Math.min(earliest, Number((baseNs + fraction) / 1000000n));
    const stream = parseClaudeStreamRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed',
      unifiedWindows: Object.fromEntries(['five_hour', 'seven_day'].map(id => [id, { utilization: .89, resetsAt: boundary / 1000 }])) } },
      { quotaSeat: 'claude', observedAt: f.at() + 1000, accountFingerprint: initial.accountFingerprint });
    f.advance(1000); assert.equal(f.store.observe(stream), true);
    for (const w of f.store.headroom('claude').windows) {
      assert.equal(w.resetBoundaryMs, boundary);
      assert.equal(w.resetsAt, earliest);
      assert.equal(Number(BigInt(w.nativeResetNs) / 1000000n), w.nativeResetMs);
      assert.equal(Date.parse(w.nativeResetIso), w.nativeResetMs);
      assert.ok(w.resetsAt <= w.nativeResetMs, 'effective expiry never follows raw provenance');
    }
  }
  f.advance(1000); const before = storeBytes(f);
  const nextKey = preciseIso(BigInt(boundary) * 1000000n + 1n);
  assert.equal(f.store.observe(preciseNative(f, [nextKey, nextKey])), false, 'a one-nanosecond crossing cannot extend the fixed key');
  assert.equal(storeBytes(f), before);
});

test('earliest same-key expiry blocks replenishment until actual fixed-boundary rollover', t => {
  const f = fixture(t), boundary = T + 60000;
  const resets = ms => [new Date(ms).toISOString(), new Date(ms).toISOString()];
  const first = preciseNative(f, resets(boundary - 416), [4, 4]);
  f.store.bindIdentity('claude', first.accountFingerprint); assert.equal(f.store.observe(first), true);
  f.advance(1000); assert.equal(f.store.observe(preciseNative(f, resets(boundary - 75), [4, 4])), true);
  f.advance(boundary - 416 - f.at());
  const expired = storeBytes(f);
  assert.equal(f.store.observe(preciseNative(f, resets(boundary - 75), [4, 4])), false, 'equal capacity cannot renew an expired earliest reset');
  assert.equal(storeBytes(f), expired);
  assert.equal(f.store.headroom('claude').freshness, 'stale');
  assert.equal(f.store.headroom('claude').protected, true);
  const stream = parseClaudeStreamRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed',
    unifiedWindows: Object.fromEntries(['five_hour', 'seven_day'].map(id => [id, { utilization: .96, resetsAt: boundary / 1000 }])) } },
    { quotaSeat: 'claude', observedAt: f.at(), accountFingerprint: first.accountFingerprint });
  assert.equal(f.store.observe(stream), false, 'a whole-second stream cannot bypass the earliest native expiry');
  assert.equal(storeBytes(f), expired);
  f.advance(boundary - 1 - f.at());
  assert.equal(f.store.observe(preciseNative(f, resets(boundary + 18000000), [90, 90])), false);
  assert.equal(storeBytes(f), expired, 'the full fixed boundary must pass before a new key is eligible');
  f.advance(1); assert.equal(f.store.observe(preciseNative(f, resets(boundary + 18000000), [90, 90])), true);
  assert.equal(f.store.headroom('claude').freshness, 'fresh');
  assert.equal(f.store.headroom('claude').percentRemaining, 90);
  assert.ok(f.store.headroom('claude').windows.every(w => w.percentPerHour === null));
});

test('jitter preserves identity-bound denial and rate anchors across refresh restart and replay', t => {
  const f = fixture(t), boundary = T + 86400000;
  const resets = delta => [new Date(boundary - delta).toISOString(), new Date(boundary - delta).toISOString()];
  const first = preciseNative(f, resets(416), [12, 12]);
  f.store.bindIdentity('claude', first.accountFingerprint); f.store.observe(first);
  f.advance(6000); assert.equal(f.store.observe(preciseNative(f, resets(75))), true);
  const anchor = f.store.headroom('claude').windows[0].rateAnchorObservedAt;
  assert.equal(anchor, T); assert.equal(f.store.headroom('claude').percentPerHour, 600);
  f.advance(1000);
  const denial = parseClaudeStreamRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected',
    unifiedWindows: Object.fromEntries(['five_hour', 'seven_day'].map(id => [id, { utilization: .89, resetsAt: boundary / 1000 }])) } },
    { quotaSeat: 'claude', observedAt: f.at(), accountFingerprint: first.accountFingerprint });
  assert.equal(f.store.observe(denial), true);
  f.advance(150000); const fresh = preciseNative(f, resets(250)); assert.equal(f.store.observe(fresh), true);
  f.store = createSubscriptionUsage({ dataDir: f.dir, now: f.at });
  const current = f.store.headroom('claude');
  assert.equal(current.ordinaryUsageAllowed, false); assert.equal(current.protected, true);
  assert.equal(current.windows[0].rateAnchorObservedAt, anchor);
  assert.ok(current.percentPerHour > 0 && current.percentPerHour < 30);
  const before = storeBytes(f);
  f.advance(1000); assert.equal(f.store.observe(fresh), false);
  assert.equal(storeBytes(f), before, 'restart must not renew a persisted fetch watermark');
  f.advance(180001);
  assert.ok(f.at() - 180001 > storedSeat(f).nativeFetchWatermarks[first.accountFingerprint],
    'the expired fetch must exceed the watermark so TTL rejection is independently exercised');
  for (const options of [{ at: f.at() - 180001 }, { at: f.at() + 1 },
    { accountUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }]) {
    assert.equal(f.store.observe(preciseNative(f, resets(100), [11, 11], options)), false);
    assert.equal(storeBytes(f), before);
  }
});

test('one-nanosecond and adjacent two-nanosecond boundary crossings remain distinct native windows', t => {
  const point = BigInt(T + 86400000) * 1000000n;
  for (const [firstNs, otherNs] of [[point, point + 1n], [point + 1n, point],
    [point - 1n, point + 1n]]) {
    const f = fixture(t), firstIso = preciseIso(firstNs), otherIso = preciseIso(otherNs);
    const first = preciseNative(f, [firstIso, firstIso]);
    f.store.bindIdentity('claude', first.accountFingerprint); assert.equal(f.store.observe(first), true);
    f.advance(1000); const before = storeBytes(f);
    assert.equal(f.store.observe(preciseNative(f, [otherIso, otherIso])), false);
    assert.equal(storeBytes(f), before);
  }
});

test('native millisecond fallback preserves the fixed key and earliest expiry with consistent provenance', t => {
  const f = fixture(t), boundary = T + 86400000;
  const withoutPrecision = reset => {
    const value = native(f, 11, reset);
    for (const w of value.buckets[0].windows) delete w.nativeResetNs;
    return value;
  };
  const first = withoutPrecision(boundary - 437);
  f.store.bindIdentity('claude', first.accountFingerprint); assert.equal(f.store.observe(first), true);
  f.advance(1000); assert.equal(f.store.observe(withoutPrecision(boundary - 436)), true);
  f.store = createSubscriptionUsage({ dataDir: f.dir, now: f.at });
  for (const w of f.store.headroom('claude').windows) {
    assert.equal(w.resetBoundaryMs, boundary); assert.equal(w.resetsAt, boundary - 437);
    assert.ok([boundary - 437, boundary - 436].includes(w.nativeResetMs));
    assert.equal(Date.parse(w.nativeResetIso), w.nativeResetMs);
    if (w.nativeResetNs != null) assert.equal(BigInt(w.nativeResetNs), BigInt(w.nativeResetMs) * 1000000n);
  }
  f.advance(1000); const before = storeBytes(f);
  assert.equal(f.store.observe(withoutPrecision(boundary + 1)), false);
  assert.equal(storeBytes(f), before);
});

test('captured fractional ISO without nanoseconds retains conservative identity across restart and refresh', t => {
  const f = fixture(t, 1789316910862);
  const firstResets = ['2026-09-13T17:59:59.584712+00:00', '2026-09-13T23:59:59.584741+00:00'];
  const nextResets = ['2026-09-13T17:59:59.925436+00:00', '2026-09-13T23:59:59.925462+00:00'];
  const withoutNs = resets => {
    const observation = preciseNative(f, resets, [91, 10]);
    for (const w of observation.buckets[0].windows) delete w.nativeResetNs;
    return observation;
  };
  const first = withoutNs(firstResets);
  f.store.bindIdentity('claude', first.accountFingerprint); assert.equal(f.store.observe(first), true);
  f.store = createSubscriptionUsage({ dataDir: f.dir, now: f.at });
  f.advance(1789317230534 - f.at());
  assert.equal(f.store.observe(withoutNs(nextResets)), true);
  const windows = f.store.headroom('claude').windows;
  assert.equal(f.store.headroom('claude').freshness, 'fresh');
  for (const [i, w] of windows.entries()) {
    assert.equal(w.nativeResetNs, undefined, 'fallback must not invent nanosecond provenance');
    assert.ok([firstResets[i], nextResets[i]].includes(w.nativeResetIso));
    assert.equal(Date.parse(w.nativeResetIso), w.nativeResetMs);
    assert.equal(w.resetsAt, Date.parse(firstResets[i]));
    assert.equal(w.resetBoundaryMs, [1789322400000, 1789344000000][i]);
  }
  f.advance(1000); const inconsistent = withoutNs(nextResets), before = storeBytes(f);
  inconsistent.buckets[0].windows[0].nativeResetIso = firstResets[0];
  assert.equal(f.store.observe(inconsistent), false, 'missing ns must not disable ISO/ms consistency');
  assert.equal(storeBytes(f), before);
});

test('missing native boundaries are materialized and cannot replenish before the fixed key after restart', t => {
  const boundary = 1789322400000;
  for (const mode of ['current', 'restart', 'legacy-restart']) {
    const f = fixture(t, boundary - 60000);
    const first = preciseNative(f, ['2026-09-13T17:59:59.584712+00:00',
      '2026-09-13T17:59:59.584712+00:00'], [4, 4]);
    for (const w of first.buckets[0].windows) delete w.resetBoundaryMs;
    f.store.bindIdentity('claude', first.accountFingerprint); assert.equal(f.store.observe(first), true);
    assert.deepEqual(f.store.headroom('claude').windows.map(w => w.resetBoundaryMs), [boundary, boundary]);
    if (mode === 'legacy-restart') {
      const persisted = JSON.parse(storeBytes(f));
      for (const w of Object.values(persisted.claude.buckets.account.windows)) delete w.resetBoundaryMs;
      fs.writeFileSync(path.join(f.dir, 'native-usage.json'), JSON.stringify(persisted));
    }
    if (mode !== 'current') f.store = createSubscriptionUsage({ dataDir: f.dir, now: f.at });
    f.advance(boundary - 200 - f.at());
    const before = storeBytes(f), futureReset = new Date(boundary + 18000000).toISOString();
    assert.equal(f.store.observe(preciseNative(f, [futureReset, futureReset], [90, 90])), false,
      `${mode}: fractional expiry must not substitute for the fixed boundary`);
    assert.equal(storeBytes(f), before);
    assert.equal(f.store.headroom('claude').protected, true);
    f.advance(201);
    assert.equal(f.store.observe(preciseNative(f, [futureReset, futureReset], [90, 90])), true);
    assert.equal(f.store.headroom('claude').percentRemaining, 90);
    assert.equal(f.store.headroom('claude').freshness, 'fresh');
    assert.ok(f.store.headroom('claude').windows.every(w => w.resetBoundaryMs === boundary + 18000000 && w.percentPerHour === null));
  }
});

test('corrupted persisted native identity refuses rollover without replacing protection or evidence', t => {
  for (const mutate of [w => { w.nativeResetNs = 'invalid'; },
    w => { w.resetBoundaryMs += 1000; }, w => { w.nativeResetIso = new Date(w.nativeResetMs + 1).toISOString(); }]) {
    const f = fixture(t), first = native(f, 4);
    f.store.bindIdentity('claude', first.accountFingerprint); assert.equal(f.store.observe(first), true);
    const persisted = JSON.parse(storeBytes(f)); mutate(persisted.claude.buckets.account.windows.five_hour);
    fs.writeFileSync(path.join(f.dir, 'native-usage.json'), JSON.stringify(persisted));
    f.store = createSubscriptionUsage({ dataDir: f.dir, now: f.at });
    f.advance(86400001); const before = storeBytes(f);
    assert.equal(f.store.observe(native(f, 90, f.at() + 86400000)), false);
    assert.equal(storeBytes(f), before);
    assert.equal(f.store.headroom('claude').protected, true);
  }
});

test('inconsistent precise native reset metadata fails closed before initial or existing-window persistence', t => {
  const mutations = [
    w => { w.nativeResetNs = 'not-an-integer'; },
    w => { w.nativeResetNs = '-1'; },
    w => { w.nativeResetNs = Number(w.nativeResetNs); },
    w => { w.nativeResetNs = String(BigInt(w.nativeResetNs) + 1n); },
    w => { w.nativeResetNs = String(BigInt(w.nativeResetNs) + 1000000n); },
    w => { w.resetBoundaryMs += 1000; },
    w => { w.nativeResetMs += 1; w.resetsAt += 1; },
  ];
  for (const adopted of [false, true]) for (const mutate of mutations) {
    const f = fixture(t), first = native(f);
    f.store.bindIdentity('claude', first.accountFingerprint);
    if (adopted) assert.equal(f.store.observe(first), true);
    f.advance(1000); const next = native(f), before = storeBytes(f);
    mutate(next.buckets[0].windows[0]);
    assert.equal(f.store.observe(next), false, 'malformed metadata must return refusal rather than throw or overwrite');
    assert.equal(storeBytes(f), before);
  }
});
test('reserve settings default on, validate floor, persist, and never infer allowance from absence', (t) => {
  const { store, dir } = fixture(t);
  assert.equal(store.getSettings().reservePercent, 5); assert.equal(store.getSettings().usageProtection, true);
  assert.throws(() => store.setSettings({ reservePercent: 1 }), /between/);
  store.setSettings({ reservePercent: 2, autoHandoff: false });
  assert.equal(createSubscriptionUsage({ dataDir: dir }).getSettings().reservePercent, 2);
  assert.equal(store.headroom('unknown').percentRemaining, null);
  assert.equal(store.headroom('unknown').freshness, 'unknown');
});
test('applicable window, aliases, distinct accounts, reserve and measured depletion', (t) => {
  const f = fixture(t); f.store.observe(f.codex(56)); f.store.observe(f.codex(90, {}, 'codex#second'));
  assert.equal(f.store.headroom('codex').percentRemaining, 56);
  f.advance(60000); f.store.observe(f.codex(50));
  assert.equal(f.store.headroom('codex').percentPerHour, 360);
  assert.equal(f.store.headroom('codex#second').percentRemaining, 90);
  f.advance(60000); f.store.observe(f.codex(4.5)); assert.equal(f.store.verdict('codex').admit, false);
  f.store.setSettings({ usageProtection: false }); assert.equal(f.store.verdict('codex').admit, true);
});
test('unchanged fresh readings decay a measured rate and never borrow another window rate', (t) => {
  const f = fixture(t), fiveHourReset = T / 1000 + 18000, weekReset = T / 1000 + 604800;
  const stream = (fiveHour, week) => parseClaudeStreamRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed',
    unifiedWindows: { five_hour: { utilization: (100 - fiveHour) / 100, resetsAt: fiveHourReset },
      seven_day: { utilization: (100 - week) / 100, resetsAt: weekReset } } } }, { quotaSeat: 'claude', observedAt: f.at() });
  f.store.observe(stream(85, 20));
  // Two points 5.592 seconds apart produce the observed 1287.55%/hour burst.
  f.advance(5592); f.store.observe(stream(83, 18));
  assert.equal(Math.round(f.store.headroom('claude').percentPerHour * 100) / 100, 1287.55);
  assert.equal(f.store.verdict('claude').admit, false, 'a recent drop in the weekly bucket is protective');
  // A later stream observation with unchanged percentages is fresh evidence, but
  // the old burst is now only a 2-point depletion over the longer anchor interval.
  f.advance(150000); f.store.observe(stream(83, 18));
  const decayed = f.store.headroom('claude');
  assert.ok(decayed.percentPerHour < 50);
  assert.ok(decayed.triggerPercent < 8);
  assert.equal(decayed.percentRemaining, 18);
  assert.equal(f.store.verdict('claude').admit, true);

  const independent = fixture(t);
  const independentStream = (fiveHour, week) => parseClaudeStreamRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed',
    unifiedWindows: { five_hour: { utilization: (100 - fiveHour) / 100, resetsAt: fiveHourReset },
      seven_day: { utilization: (100 - week) / 100, resetsAt: weekReset } } } }, { quotaSeat: 'claude', observedAt: independent.at() });
  independent.store.observe(independentStream(90, 18));
  independent.advance(60000); independent.store.observe(independentStream(80, 18));
  const weeklyBinding = independent.store.headroom('claude');
  assert.equal(weeklyBinding.bindingWindow, 'seven_day');
  assert.equal(weeklyBinding.percentPerHour, null);
  assert.equal(weeklyBinding.triggerPercent, 5);
  assert.equal(independent.store.verdict('claude').admit, true, 'a fast high-remaining 5h bucket cannot protect the weekly bucket');
});
test('legacy rates without a depletion anchor do not become timeless on fresh unchanged evidence', (t) => {
  const f = fixture(t), reset = T / 1000 + 86400;
  f.store.observe(f.codex(18));
  const storeFile = path.join(f.dir, 'native-usage.json');
  const persisted = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  persisted.codex.buckets.codex.windows.primary.percentPerHour = 1287.55;
  fs.writeFileSync(storeFile, JSON.stringify(persisted, null, 2));
  const reopened = createSubscriptionUsage({ dataDir: f.dir, now: f.at });
  f.advance(1000);
  reopened.observe(parseCodexRateLimits({ ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex' },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 82, windowDurationMins: 10080, resetsAt: reset } } } },
  { quotaSeat: 'codex', observedAt: f.at() }));
  const headroom = reopened.headroom('codex');
  assert.equal(headroom.percentPerHour, null);
  assert.equal(headroom.triggerPercent, 5);
  assert.equal(reopened.verdict('codex').admit, true);
});
test('malformed persisted rates never weaken reserve protection or become numeric metadata', (t) => {
  const f = fixture(t);
  f.store.observe(f.codex(4));
  const storeFile = path.join(f.dir, 'native-usage.json');
  const persisted = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  for (const malformed of [-100, '600', 'NaN', {}, null]) {
    persisted.codex.buckets.codex.windows.primary.percentPerHour = malformed;
    fs.writeFileSync(storeFile, JSON.stringify(persisted));
    const headroom = createSubscriptionUsage({ dataDir: f.dir, now: f.at }).verdict('codex');
    assert.equal(headroom.admit, false);
    assert.equal(headroom.triggerPercent, 5);
    assert.equal(headroom.percentPerHour, null);
    assert.equal(headroom.protectionWindow.percentPerHour, null);
  }
});
test('protection names the triggering window when it differs from the lowest remaining window', (t) => {
  const f = fixture(t);
  const stream = (fiveHour) => parseClaudeStreamRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed',
    unifiedWindows: { five_hour: { utilization: (100 - fiveHour) / 100, resetsAt: T / 1000 + 18000 },
      seven_day: { utilization: .86, resetsAt: T / 1000 + 604800 } } } }, { quotaSeat: 'claude', observedAt: f.at() });
  f.store.observe(stream(25));
  f.advance(60000); f.store.observe(stream(15));
  const headroom = f.store.verdict('claude');
  assert.equal(headroom.admit, false);
  assert.equal(headroom.bindingWindow, 'seven_day');
  assert.equal(headroom.percentRemaining, 14);
  assert.equal(headroom.triggerPercent, 5);
  assert.deepEqual(headroom.protectionWindow, { id: 'five_hour', percentRemaining: 15,
    percentPerHour: 600, triggerPercent: 20 });
});
test('denial and spend-control nulls cannot fabricate recovery', (t) => {
  const f = fixture(t); f.store.observe(f.codex(90, { ordinaryUsageAllowed: false }));
  assert.equal(f.store.verdict('codex').admit, false);
  f.advance(1000); f.store.observe(f.codex(100, { ordinaryUsageAllowed: null })); assert.equal(f.store.verdict('codex').admit, false);
  f.advance(1000); f.store.observe(f.codex(90)); assert.equal(f.store.verdict('codex').admit, true);
});
test('a full healthy Codex refresh retires expired removed windows', (t) => {
  const f = fixture(t); f.store.observe(f.codex(90, { rateLimitsByLimitId: { codex: {
    primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: T / 1000 + 86400 },
    secondary: { usedPercent: 98, windowDurationMins: 300, resetsAt: T / 1000 + 1 } } } }));
  f.advance(2000); f.store.observe(f.codex(90));
  assert.equal(f.store.headroom('codex').freshness, 'fresh'); assert.equal(f.store.verdict('codex').admit, true);
});
test('an invalid window poisons the whole bucket and never fabricates fresh headroom from a good sibling', (t) => {
  const f = fixture(t);
  f.store.observe(parseCodexRateLimits({ ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex' },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 9999, windowDurationMins: 10080, resetsAt: T / 1000 + 86400 },
      secondary: { usedPercent: 10, windowDurationMins: 300, resetsAt: T / 1000 + 86400 } } } }, { quotaSeat: 'codex', observedAt: f.at() }));
  const headroom = f.store.headroom('codex');
  assert.equal(headroom.percentRemaining, null);
  assert.equal(headroom.reason, 'native_evidence_invalid');
  assert.equal(f.store.verdict('codex').admit, true);
});
test('explicit denial protects the seat even when every window is malformed', (t) => {
  const f = fixture(t);
  f.store.observe(parseCodexRateLimits({ ordinaryUsageAllowed: false, rateLimits: { limitId: 'codex' },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: -1, windowDurationMins: 10080, resetsAt: T / 1000 + 86400 } } } }, { quotaSeat: 'codex', observedAt: f.at() }));
  const headroom = f.store.headroom('codex');
  assert.equal(headroom.percentRemaining, null);
  assert.equal(headroom.protected, true);
  assert.equal(f.store.verdict('codex').admit, false);
});
test('a malformed individualLimit scalar poisons the bucket and retains the prior individual reading through a fullSnapshot replacement', (t) => {
  const f = fixture(t), reset = T / 1000 + 86400;
  const withIndividual = (individualLimit) => parseCodexRateLimits({ ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex' },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: reset }, individualLimit } } },
    { quotaSeat: 'codex', observedAt: f.at() });
  f.store.observe(withIndividual({ remainingPercent: 3, resetsAt: reset }));
  assert.equal(f.store.headroom('codex').percentRemaining, 3);
  for (const malformed of ['bad', 0, false, ['nope']]) {
    f.advance(1000);
    f.store.observe(withIndividual(malformed));
    const headroom = f.store.headroom('codex');
    // The good sibling primary window (80% remaining) must not make this bucket look
    // fresh: the malformed individual window poisons it, and the prior 3% is retained.
    assert.equal(headroom.reason, 'native_evidence_invalid');
    assert.equal(headroom.windows.find((w) => w.id === 'individual').percentRemaining, 3);
    assert.equal(f.store.verdict('codex').admit, false);
  }
});
test('a low window stays protected after the same window turns invalid, across all native parsers', (t) => {
  const f = fixture(t), reset = T / 1000 + 86400;
  // Codex RPC: valid 3%-remaining primary window blocks admission, then a malformed
  // reading of the same window one second later must not reopen it.
  f.store.observe(parseCodexRateLimits({ ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex' },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 97, windowDurationMins: 10080, resetsAt: reset } } } },
    { quotaSeat: 'codex', observedAt: f.at() }));
  assert.equal(f.store.headroom('codex').percentRemaining, 3); assert.equal(f.store.verdict('codex').admit, false);
  f.advance(1000);
  f.store.observe(parseCodexRateLimits({ ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex' },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 9999, windowDurationMins: 10080, resetsAt: reset } } } },
    { quotaSeat: 'codex', observedAt: f.at() }));
  const codexHeadroom = f.store.headroom('codex');
  assert.equal(codexHeadroom.reason, 'native_evidence_invalid');
  assert.equal(codexHeadroom.protected, true, 'malformed same-window reading must not clear prior reserve protection');
  assert.equal(f.store.verdict('codex').admit, false);

  // Claude statusline: same pattern.
  f.store.observe(parseClaudeStatuslineUsage({ rate_limits: { five_hour: { used_percentage: 97, resets_at: reset } } },
    { quotaSeat: 'claude-status', observedAt: f.at() }));
  assert.equal(f.store.verdict('claude-status').admit, false);
  f.advance(1000);
  f.store.observe(parseClaudeStatuslineUsage({ rate_limits: { five_hour: { used_percentage: 5000, resets_at: reset } } },
    { quotaSeat: 'claude-status', observedAt: f.at() }));
  const statuslineHeadroom = f.store.headroom('claude-status');
  assert.equal(statuslineHeadroom.reason, 'native_evidence_invalid');
  assert.equal(statuslineHeadroom.protected, true);
  assert.equal(f.store.verdict('claude-status').admit, false);

  // Claude stream: same pattern.
  f.store.observe(parseClaudeStreamRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed',
    unifiedWindows: { five_hour: { utilization: .97, resetsAt: reset } } } }, { quotaSeat: 'claude-stream', observedAt: f.at() }));
  assert.equal(f.store.verdict('claude-stream').admit, false);
  f.advance(1000);
  f.store.observe(parseClaudeStreamRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed',
    unifiedWindows: { five_hour: { utilization: 1.01, resetsAt: reset } } } }, { quotaSeat: 'claude-stream', observedAt: f.at() }));
  const streamHeadroom = f.store.headroom('claude-stream');
  assert.equal(streamHeadroom.reason, 'native_evidence_invalid');
  assert.equal(streamHeadroom.protected, true);
  assert.equal(f.store.verdict('claude-stream').admit, false);

  // Sticky protection survives a store restart (persisted to disk).
  const reopened = createSubscriptionUsage({ dataDir: f.dir, now: f.at });
  assert.equal(reopened.headroom('codex').protected, true, 'restart must not clear sticky low-water protection');

  // A payload with both a valid 3%-remaining window AND an invalid sibling must
  // not allow admission either.
  f.advance(1000);
  const mixed = fixture(t);
  mixed.store.observe(parseCodexRateLimits({ ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex' },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 97, windowDurationMins: 10080, resetsAt: reset },
      secondary: { usedPercent: 9999, windowDurationMins: 300, resetsAt: reset } } } }, { quotaSeat: 'codex', observedAt: mixed.at() }));
  const mixedHeadroom = mixed.store.headroom('codex');
  assert.equal(mixedHeadroom.reason, 'native_evidence_invalid');
  assert.equal(mixedHeadroom.protected, true, 'a low sibling window must keep protecting even in the same payload as an invalid one');
  assert.equal(mixed.store.verdict('codex').admit, false);

  // Affirmative healthy recovery on the same window clears sticky protection.
  f.advance(1000);
  f.store.observe(parseCodexRateLimits({ ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex' },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: reset } } } },
    { quotaSeat: 'codex', observedAt: f.at() }));
  const recovered = f.store.headroom('codex');
  assert.equal(recovered.freshness, 'fresh'); assert.equal(recovered.percentRemaining, 90);
  assert.equal(f.store.verdict('codex').admit, true);
});
test('a stale cache cannot slip in after an invalid observation clears the retained comparison point', (t) => {
  const f = fixture(t), reset = T / 1000 + 86400;
  const stream = (remaining) => parseClaudeStreamRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed',
    unifiedWindows: { five_hour: { utilization: (100 - remaining) / 100, resetsAt: reset } } } }, { quotaSeat: 'claude', observedAt: f.at() });
  const line = (remaining) => parseClaudeStatuslineUsage({ rate_limits: { five_hour: { used_percentage: 100 - remaining, resets_at: reset } } }, { quotaSeat: 'claude', observedAt: f.at() });
  f.store.observe(stream(3));
  assert.equal(f.store.verdict('claude').admit, false);
  f.advance(1000);
  f.store.observe(stream(5000)); // malformed same-window reading, must not clear protection
  assert.equal(f.store.headroom('claude').reason, 'native_evidence_invalid');
  f.advance(1000);
  // An unseen cached 80%-remaining status-line reading arriving after the invalid
  // observation must still be rejected by the same-reset monotonicity guard: the
  // retained percentRemaining from the last valid (3%) reading is the comparison point.
  assert.equal(f.store.observe(line(80)), false);
  assert.equal(f.store.verdict('claude').admit, false, 'a stale cache must not reopen admission through an invalid intermediate reading');
});
test('sticky reserve protection is re-evaluated against the current reserve setting, not a stale snapshot', (t) => {
  const f = fixture(t), reset = T / 1000 + 86400;
  f.store.setSettings({ reservePercent: 2 });
  f.store.observe(parseCodexRateLimits({ ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex' },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 97, windowDurationMins: 10080, resetsAt: reset } } } },
    { quotaSeat: 'codex', observedAt: f.at() }));
  // 3% remaining is above the 2% reserve in effect at observation time: not yet protected.
  assert.equal(f.store.verdict('codex').admit, true);
  f.advance(1000);
  f.store.observe(parseCodexRateLimits({ ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex' },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 9999, windowDurationMins: 10080, resetsAt: reset } } } },
    { quotaSeat: 'codex', observedAt: f.at() }));
  assert.equal(f.store.headroom('codex').reason, 'native_evidence_invalid');
  // Raising the reserve to 5% must re-evaluate the retained 3% reading against the new
  // setting and protect the seat, instead of trusting a boolean captured under the old reserve.
  f.store.setSettings({ reservePercent: 5 });
  assert.equal(f.store.verdict('codex').admit, false, 'raising the reserve must protect a retained reading that now falls under it');
});
test('a persisted valid reading protects the seat once invalid, even without a legacy lowWater field', (t) => {
  const f = fixture(t), reset = T / 1000 + 86400;
  f.store.observe(parseCodexRateLimits({ ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex' },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 97, windowDurationMins: 10080, resetsAt: reset } } } },
    { quotaSeat: 'codex', observedAt: f.at() }));
  assert.equal(f.store.verdict('codex').admit, false);
  // Simulate a store persisted by older code that never wrote a lowWater field.
  const storeFile = path.join(f.dir, 'native-usage.json');
  const persisted = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  delete persisted.codex.buckets.codex.windows.primary.lowWater;
  fs.writeFileSync(storeFile, JSON.stringify(persisted, null, 2));
  const reopened = createSubscriptionUsage({ dataDir: f.dir, now: f.at });
  assert.equal(reopened.verdict('codex').admit, false, 'protection must not depend on a persisted lowWater field');
  f.advance(1000);
  reopened.observe(parseCodexRateLimits({ ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex' },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 9999, windowDurationMins: 10080, resetsAt: reset } } } },
    { quotaSeat: 'codex', observedAt: f.at() }));
  assert.equal(reopened.verdict('codex').admit, false, 'invalid evidence after a lowWater-less persisted reading must still protect');
});
test('cached Claude repeats neither renew freshness nor clear a newer low reserve', (t) => {
  const f = fixture(t), reset = T / 1000 + 86400;
  const line = (remaining) => parseClaudeStatuslineUsage({ rate_limits: { five_hour: { used_percentage: 100 - remaining, resets_at: reset } } }, { quotaSeat: 'claude', observedAt: f.at() });
  f.store.observe(line(80)); f.advance(200000); assert.equal(f.store.observe(line(80)), false);
  assert.equal(f.store.headroom('claude').freshness, 'stale');
  f.store.observe(parseClaudeStreamRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed',
    unifiedWindows: { five_hour: { utilization: .97, resetsAt: reset } } } }, { quotaSeat: 'claude', observedAt: f.at() }));
  f.advance(1000); assert.equal(f.store.observe(line(80)), false);
  assert.equal(f.store.headroom('claude').percentRemaining, 3); assert.equal(f.store.verdict('claude').admit, false);
});
