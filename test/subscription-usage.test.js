'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createSubscriptionUsage } = require('../lib/subscription-usage');
const { parseCodexRateLimits, parseClaudeStatuslineUsage, parseClaudeStreamRateLimit } = require('../lib/native-usage');
const T = 1700000000000;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-native-store-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let at = T; const store = createSubscriptionUsage({ dataDir: dir, now: () => at });
  const codex = (remaining, extra = {}, seat = 'codex') => parseCodexRateLimits({ ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex' },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 100 - remaining, windowDurationMins: 10080, resetsAt: T / 1000 + 86400 } } }, ...extra }, { quotaSeat: seat, observedAt: at });
  return { store, dir, codex, advance: (ms) => { at += ms; }, at: () => at };
}
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
