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
