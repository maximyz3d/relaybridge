'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { parseCodexRateLimits, parseClaudeStreamRateLimit, parseClaudeStatuslineUsage, readCodexRateLimits } = require('../lib/native-usage');
const T = 1700000000000, reset = T / 1000 + 86400;
const { parseClaudeNativeCache, readClaudeNativeUsage } = require('../lib/native-usage');
const accountUuid = '11111111-2222-3333-4444-555555555555';
function cachePayload(at = T) {
  return { oauthAccount: { accountUuid }, cachedUsageUtilization: { accountUuid, fetchedAtMs: at, utilization: {
    five_hour: { utilization: 4, resets_at: '2023-11-15T03:13:19.563710+00:00' },
    seven_day: { utilization: 89, resets_at: '2023-11-21T22:13:19.563733+00:00' } } } };
}
test('native Claude cache preserves original fetch, raw fractional reset and percentage units', () => {
  const value = parseClaudeNativeCache(cachePayload(), { quotaSeat: 'claude', now: T + 180000 });
  assert.equal(value.observedAt, T); assert.equal(value.nativeFetchedAt, T);
  assert.equal(value.buckets[0].windows[0].percentRemaining, 96);
  assert.equal(value.buckets[0].windows[1].percentRemaining, 11);
  assert.equal(value.buckets[0].windows[0].nativeResetIso, cachePayload().cachedUsageUtilization.utilization.five_hour.resets_at);
  const precise = cachePayload(); precise.cachedUsageUtilization.utilization.five_hour.resets_at = '2023-11-15T03:13:20.000001Z';
  const window = parseClaudeNativeCache(precise, { quotaSeat: 'claude', now: T }).buckets[0].windows[0];
  assert.equal(window.resetBoundaryMs, Date.parse('2023-11-15T03:13:21Z'));
  assert.equal(window.nativeResetNs, String(BigInt(window.nativeResetMs) * 1000000n + 1000n));
  assert.equal(value.ordinaryUsageAllowed, null); assert.doesNotMatch(JSON.stringify(value), new RegExp(accountUuid));
  for (const now of [T - 1, T + 180001]) assert.equal(parseClaudeNativeCache(cachePayload(), { quotaSeat: 'claude', now }), null);
  for (const mutate of [p => p.cachedUsageUtilization.accountUuid = 'different', p => p.cachedUsageUtilization.fetchedAtMs = String(T),
    p => delete p.cachedUsageUtilization.utilization.seven_day,
    p => p.cachedUsageUtilization.utilization.seven_day.utilization = '89',
    p => p.cachedUsageUtilization.utilization.seven_day.utilization = 101,
    p => p.cachedUsageUtilization.utilization.seven_day.resets_at = '2023-02-30T00:00:00Z',
    p => p.cachedUsageUtilization.utilization.seven_day.resets_at = '2040-01-01T00:00:00Z']) {
    const p = cachePayload(); mutate(p); assert.equal(parseClaudeNativeCache(p, { quotaSeat: 'claude', now: T }), null);
  }
});
test('native Claude accepts only a zero-use inactive five-hour window without a reset', () => {
  const payload = cachePayload();
  payload.cachedUsageUtilization.utilization.five_hour = { utilization: 0, resets_at: null };
  const value = parseClaudeNativeCache(payload, { quotaSeat: 'claude', now: T });
  assert.deepEqual(value.buckets[0].windows[0], { id: 'five_hour', percentRemaining: 100,
    resetsAt: null, nativeUsedPercent: 0, nativeNoActiveWindow: true, windowDurationMs: 18000000 });
  for (const mutate of [w => w.utilization = 1, w => delete w.resets_at,
    w => w.resets_at = 'invalid', w => w.utilization = null]) {
    const bad = cachePayload(); bad.cachedUsageUtilization.utilization.five_hour = { utilization: 0, resets_at: null };
    mutate(bad.cachedUsageUtilization.utilization.five_hour);
    assert.equal(parseClaudeNativeCache(bad, { quotaSeat: 'claude', now: T }), null);
  }
});
test('native default profile reader separates identity from stale or mismatched cache and rejects path races', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-native-profile-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, '.claude.json'), payload = cachePayload();
  fs.writeFileSync(file, JSON.stringify(payload));
  const options = { env: { HOME: home }, defaultHome: home, quotaSeat: 'claude', now: T };
  const good = readClaudeNativeUsage(options); assert.ok(good.identity && good.observation);
  const stale = readClaudeNativeUsage({ ...options, now: T + 180001 });
  assert.deepEqual(stale.identity, good.identity); assert.equal(stale.observation, null);
  payload.cachedUsageUtilization.accountUuid = 'different'; fs.writeFileSync(file, JSON.stringify(payload));
  assert.deepEqual(readClaudeNativeUsage(options).identity, good.identity); assert.equal(readClaudeNativeUsage(options).observation, null);
  assert.equal(readClaudeNativeUsage({ ...options, env: { HOME: home, CLAUDE_CONFIG_DIR: home } }).identity, null);
  assert.equal(readClaudeNativeUsage({ ...options, env: { HOME: home + '-other' } }).identity, null);
  fs.writeFileSync(file, '{'); assert.equal(readClaudeNativeUsage(options).identity, null);
  fs.writeFileSync(file, ' '.repeat(1024 * 1024 + 1)); assert.equal(readClaudeNativeUsage(options).identity, null);
  fs.writeFileSync(file, JSON.stringify(cachePayload()));
  const io = Object.create(fs); let changed = false;
  io.readSync = (...args) => { const n = fs.readSync(...args); if (!changed) { changed = true; fs.renameSync(file, file + '.old'); fs.writeFileSync(file, JSON.stringify(cachePayload())); } return n; };
  assert.equal(readClaudeNativeUsage({ ...options, fsImpl: io }).identity, null);
  fs.unlinkSync(file); fs.symlinkSync(file + '.old', file); assert.equal(readClaudeNativeUsage(options).identity, null);
});
test('default profile identity refuses effective alternate authentication and backend selectors', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-native-selectors-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(cachePayload()));
  for (const key of require('../cli-config.json').claude_fable.strip_env) {
    assert.equal(readClaudeNativeUsage({ env: { HOME: home, [key]: 'synthetic-selector' }, defaultHome: home,
      quotaSeat: 'claude', now: T }).identity, null, key);
  }
});
test('regular-profile replacement by a FIFO cannot block the reader', { skip: process.platform === 'win32' }, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-native-fifo-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(cachePayload()));
  const script = `const fs=require('node:fs'),cp=require('node:child_process');
    const home=process.argv[1], file=home+'/.claude.json', io=Object.create(fs); let replaced=false;
    io.lstatSync=(...args)=>{const value=fs.lstatSync(...args);if(!replaced){replaced=true;fs.unlinkSync(file);cp.execFileSync('mkfifo',[file]);}return value;};
    const result=require(${JSON.stringify(require.resolve('../lib/native-usage'))}).readClaudeNativeUsage({env:{HOME:home},defaultHome:home,quotaSeat:'claude',fsImpl:io});
    if(result.identity!==null)process.exit(2);`;
  const result = require('node:child_process').spawnSync(process.execPath, ['-e', script, home], { timeout: 3000, encoding: 'utf8' });
  assert.equal(result.error, undefined, 'bounded child must return without a FIFO writer');
  assert.equal(result.status, 0, result.stderr);
});
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
