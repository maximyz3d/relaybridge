'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { parseCodexRateLimits, parseClaudeStreamRateLimit, parseClaudeStatuslineUsage, readCodexRateLimits } = require('../lib/native-usage');
const T = 1700000000000, reset = T / 1000 + 86400;
test('native Codex arbitrary windows preserve meter, denial, spend control and included-cache independence', () => {
  const parsed = parseCodexRateLimits({ ordinaryUsageAllowed: false, rateLimits: { limitId: 'codex' }, rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 44, windowDurationMins: 10080, resetsAt: reset }, spendControlReached: true,
      individualLimit: { remainingPercent: 1, resetsAt: reset } },
    unrelated: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: reset } },
  } }, { quotaSeat: 'codex', observedAt: T });
  assert.equal(parsed.defaultBucket, 'codex'); assert.equal(parsed.ordinaryUsageAllowed, false);
  assert.equal(parsed.buckets[0].windows[0].percentRemaining, 56);
  assert.equal(parsed.buckets[0].windows[0].windowDurationMs, 7 * 86400000);
  assert.equal(parsed.buckets[0].windows[1].resetsAt, reset * 1000);
  assert.equal(parsed.buckets[1].windows[0].percentRemaining, 100);
  assert.equal(parseCodexRateLimits({ tokens: 500, context_window: { used_percentage: 95 } }, { quotaSeat: 'codex', observedAt: T }), null);
});
test('Claude stream fractions, statusline percentages and explicit denials stay distinct', () => {
  const context = { quotaSeat: 'claude', observedAt: T };
  const stream = parseClaudeStreamRateLimit({ type: 'rate_limit_event', rate_limit_info: {
    status: 'allowed', unifiedWindows: { five_hour: { utilization: .8, resetsAt: reset } } } }, context);
  const status = parseClaudeStatuslineUsage({ rate_limits: { five_hour: { used_percentage: 80, resets_at: reset } } }, context);
  assert.equal(stream.buckets[0].windows[0].percentRemaining, 20);
  assert.equal(status.buckets[0].windows[0].percentRemaining, 20);
  const rejected = parseClaudeStreamRateLimit({ type: 'rate_limit_event', rate_limit_info: {
    status: 'rejected', rateLimitType: 'seven_day', utilization: 1.2, resetsAt: reset } }, context);
  // An out-of-range utilization is rejected evidence, not a fabricated 0% remaining: the
  // explicit denial (status: 'rejected') is what protects the seat, independent of the bad window.
  assert.equal(rejected.ordinaryUsageAllowed, false);
  assert.equal(rejected.buckets[0].windows[0].invalid, true);
  assert.equal(rejected.buckets[0].windows[0].percentRemaining, undefined);
  assert.equal(parseClaudeStatuslineUsage({ context_window: { used_percentage: 99 } }, context), null);
});
test('out-of-range usedPercent/utilization are rejected as invalid evidence, not clamped', () => {
  const context = { quotaSeat: 'codex', observedAt: T };
  const overRange = parseCodexRateLimits({ ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex' },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 5000, windowDurationMins: 10080, resetsAt: reset },
      secondary: { usedPercent: 10, windowDurationMins: 300, resetsAt: reset } } } }, context);
  assert.equal(overRange.buckets[0].windows[0].id, 'primary');
  assert.equal(overRange.buckets[0].windows[0].invalid, true);
  assert.equal(overRange.buckets[0].windows[0].percentRemaining, undefined);
  // The good sibling window must not be dropped by the invalid one, nor make the bucket look
  // fully fresh on its own: subscription-usage.js poisons the whole bucket instead.
  assert.equal(overRange.buckets[0].windows[1].id, 'secondary');
  assert.equal(overRange.buckets[0].windows[1].percentRemaining, 90);
  const negative = parseCodexRateLimits({ ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex' },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: -5, windowDurationMins: 10080, resetsAt: reset } } } }, context);
  assert.equal(negative.buckets[0].windows[0].invalid, true);
  const badUtilization = parseClaudeStreamRateLimit({ type: 'rate_limit_event', rate_limit_info: {
    status: 'allowed', unifiedWindows: { five_hour: { utilization: -0.2, resetsAt: reset } } } },
    { quotaSeat: 'claude', observedAt: T });
  assert.equal(badUtilization.buckets[0].windows[0].invalid, true);
});
test('a malformed Codex individualLimit is marked invalid, not silently dropped', () => {
  const context = { quotaSeat: 'codex', observedAt: T };
  const base = (individualLimit) => parseCodexRateLimits({ ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex' },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: reset }, individualLimit } } }, context);
  const overRange = base({ remainingPercent: 150 });
  const individualOverRange = overRange.buckets[0].windows.find((w) => w.id === 'individual');
  assert.equal(individualOverRange.invalid, true);
  assert.equal(individualOverRange.percentRemaining, undefined);
  const badReset = base({ remainingPercent: 40, resetsAt: -5 });
  assert.equal(badReset.buckets[0].windows.find((w) => w.id === 'individual').invalid, true);
  // A missing/null reset is legitimate for a spend limit and must not be treated as invalid.
  const noReset = base({ remainingPercent: 40 });
  const noResetWindow = noReset.buckets[0].windows.find((w) => w.id === 'individual');
  assert.equal(noResetWindow.invalid, undefined);
  assert.equal(noResetWindow.percentRemaining, 40);
  assert.equal(noResetWindow.resetsAt, null);
  const nullReset = base({ remainingPercent: 40, resetsAt: null });
  assert.equal(nullReset.buckets[0].windows.find((w) => w.id === 'individual').invalid, undefined);
  // A valid sibling window must still be present alongside the invalid individual marker.
  assert.equal(overRange.buckets[0].windows.find((w) => w.id === 'primary').percentRemaining, 90);
  // A malformed non-object individualLimit is invalid evidence, not absence: it must not be
  // silently skipped just because it fails the "is an object" shape check.
  for (const malformed of ['bad', 0, false, ['nope']]) {
    const parsed = base(malformed);
    const window = parsed.buckets[0].windows.find((w) => w.id === 'individual');
    assert.ok(window, `expected an individual window marker for ${JSON.stringify(malformed)}`);
    assert.equal(window.invalid, true);
    assert.equal(window.percentRemaining, undefined);
  }
  // A legitimate missing/null individualLimit must remain absent, not fabricated as invalid.
  assert.equal(base(undefined).buckets[0].windows.find((w) => w.id === 'individual'), undefined);
  assert.equal(base(null).buckets[0].windows.find((w) => w.id === 'individual'), undefined);
});
test('native quota RPC performs initialization and account read only, then closes its process', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-quota-rpc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'rpc.cjs'), log = path.join(dir, 'calls');
  fs.writeFileSync(script, `const fs=require('node:fs'),readline=require('node:readline');
    readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},r.method+'\\n');
    if(r.id===1)process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');
    if(r.id===2)process.stdout.write(JSON.stringify({id:2,result:{ordinaryUsageAllowed:true,rateLimits:{primary:{usedPercent:44,resetsAt:${reset},windowDurationMins:10080}}}})+'\\n');});`);
  const result = await readCodexRateLimits({ command: process.execPath, args: [script], timeoutMs: 2000 });
  assert.equal(result.ordinaryUsageAllowed, true);
  assert.equal(fs.readFileSync(log, 'utf8'), 'initialize\ninitialized\naccount/rateLimits/read\n');
});
test('malformed null RPC frames fail without uncaught exceptions', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-quota-bad-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'bad.cjs'); fs.writeFileSync(script, "process.stdout.write('null\\n');setInterval(()=>{},1000)");
  await assert.rejects(readCodexRateLimits({ command: process.execPath, args: [script], timeoutMs: 200 }), /unavailable/);
});
