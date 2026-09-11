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
  assert.equal(rejected.ordinaryUsageAllowed, false); assert.equal(rejected.buckets[0].windows[0].percentRemaining, 0);
  assert.equal(parseClaudeStatuslineUsage({ context_window: { used_percentage: 99 } }, context), null);
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
