'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { startTestBridge, completeJsonLines } = require('./helpers/temporary-bridge');
const { readClaudeNativeUsage } = require('../lib/native-usage');
const { createSubscriptionUsage } = require('../lib/subscription-usage');
const inheritedBridgeKeys = Object.keys(process.env).filter((key) => /^(RELAYBRIDGE_|PS_BRIDGE_)/.test(key));
const unsetBridgeEnv = Object.fromEntries(inheritedBridgeKeys.map((key) => [key, undefined]));

// Trimmed variant of test/continuity.integration.test.js's nativeClaudeFixture.
//
// subscriptionUsage's seat store is loaded into the server process's memory once, at
// `createSubscriptionUsage()` construction time (server.js boot); nothing in the running
// server ever re-reads native-usage.json off disk afterward. So a prior, already-stale
// observation has to exist BEFORE the bridge boots, not be patched in after. This fixture
// seeds it the same way the real server would (readClaudeNativeUsage + bindIdentity +
// observeNativeCache against a momentarily-fresh profile, so accountFingerprint/profileHash
// genuinely match), ages that seeded record past the freshness TTL, then rewrites the live
// profile itself stale-at-boot so the server's own non-generating boot refresh never
// overwrites the seed (matches continuity.integration.test.js's confirmed behavior that a
// stale-at-boot profile never produces a store observation on its own).
async function staleNativeFixture(t, { initialUtilization = 20, initialResetOffsetMs = 86400000,
  probeMode = null, patchStoreSeat = null, primeStore = true } = {}) {
  let profile, events, usageFile;
  const bridge = await startTestBridge(t, root => {
    profile = path.join(root, 'native-home', '.claude.json'); events = path.join(root, 'native-events.jsonl');
    usageFile = path.join(root, 'data', 'usage', 'native-usage.json');
    const probeCwd = path.join(root, 'data', 'claude-usage-probe'); fs.mkdirSync(probeCwd, { recursive: true });
    const accountUuid = '11111111-2222-3333-4444-555555555555', at = Date.now(), reset = at + initialResetOffsetMs;
    const initial = { oauthAccount: { accountUuid }, cachedUsageUtilization: { accountUuid, fetchedAtMs: at, utilization:
      Object.fromEntries(['five_hour', 'seven_day'].map(name => [name, { utilization: initialUtilization, resets_at: new Date(reset).toISOString() }])) } };
    initial.projects = { [probeCwd]: { hasTrustDialogAccepted: true } };
    fs.writeFileSync(profile, JSON.stringify(initial));
    if (primeStore) {
      const nativeHome = path.join(root, 'native-home');
      const { identity, observation } = readClaudeNativeUsage({ env: { HOME: nativeHome, USERPROFILE: nativeHome },
        defaultHome: nativeHome, quotaSeat: 'claude' });
      const store = createSubscriptionUsage({ dataDir: path.join(root, 'data', 'usage') });
      store.bindIdentity('claude', identity.accountFingerprint);
      store.observeNativeCache(observation);
      if (patchStoreSeat) {
        const raw = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
        raw.claude.observedAt -= 180001; raw.claude.seatObservedAt -= 180001;
        for (const w of Object.values(raw.claude.buckets.account.windows)) w.observedAt -= 180001;
        patchStoreSeat(raw.claude);
        fs.writeFileSync(usageFile, JSON.stringify(raw));
      } else {
        const raw = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
        raw.claude.observedAt -= 180001; raw.claude.seatObservedAt -= 180001;
        for (const w of Object.values(raw.claude.buckets.account.windows)) w.observedAt -= 180001;
        fs.writeFileSync(usageFile, JSON.stringify(raw));
      }
    }
    // Age the live profile past the TTL from the very start so the server's own boot-time
    // refresh never observes anything fresh on top of the seeded (or absent) store entry.
    const stale = JSON.parse(fs.readFileSync(profile, 'utf8'));
    stale.cachedUsageUtilization.fetchedAtMs -= 180001;
    fs.writeFileSync(profile, JSON.stringify(stale));
    const script = path.join(root, 'native-fixture.cjs');
    fs.writeFileSync(script, `const fs=require('node:fs');let input='';const event=type=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({type,at:Date.now()})+'\\n');
      const usage=()=>console.log(JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'allowed',unifiedWindows:{five_hour:{utilization:.2,resetsAt:${reset / 1000}},seven_day:{utilization:.2,resetsAt:${reset / 1000}}}}}));
      process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{event('started');
        usage();console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Synthetic native protocol completed.'}));event('finished');});`);
    const probeScript = path.join(root, 'native-usage-probe.cjs');
    if (probeMode) fs.writeFileSync(probeScript, `const fs=require('node:fs');let input='';
      const event=type=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({type,at:Date.now()})+'\\n');
      console.log('Claude Code v1.0\\n? for shortcuts\\n❯ ');
      process.stdin.on('data',chunk=>{input+=chunk;if(!input.includes('/usage'))return;input='';event('usage_probe');
        if(${JSON.stringify(probeMode)}==='recover'){const value=JSON.parse(fs.readFileSync(${JSON.stringify(profile)},'utf8'));
          value.cachedUsageUtilization.fetchedAtMs=Date.now();fs.writeFileSync(${JSON.stringify(profile)},JSON.stringify(value));}
        if(input.includes('/exit'))process.exit(0);});setInterval(()=>{},1000);`);
    const entry = { label: 'Synthetic native Claude', npm_package: '@anthropic-ai/claude-code', credential_env: 'CLAUDE_CONFIG_DIR', quota_seat: 'claude',
      safe: [process.execPath], probe: [process.execPath, '--version'], version_probe: [process.execPath, '--version'],
      model: 'fixture-model', model_tiers: { standard: { model: 'fixture-model', args: ['--model', 'fixture-model'] } },
      oneshot_safe: [process.execPath, script, '--model', 'fixture-model'], oneshot_output_parser: 'claude_json',
      oneshot_safe_filesystem_policy: 'read_only_enforced', oneshot_capabilities: { safe: ['model_invocation', 'workspace_read', 'tool_use'] } };
    if (probeMode) entry.native_usage_probe = { enabled: true, command: [process.execPath, probeScript], timeout_ms: 2500 };
    return { _models: { discoverOnBoot: false }, claude: entry };
  }, { env: { ...unsetBridgeEnv, RELAYBRIDGE_WARM_DIAG: '0', RELAYBRIDGE_REMOTE_MCP: '0', PTY_MODE: 'auto' } });
  return { ...bridge, profile, events, usageFile,
    ask: (extra = {}) => bridge.request('/api/oneshot',
      { kind: 'claude', cwd: bridge.root, prompt: 'Complete synthetic protocol.', dangerous: false, modelTier: 'standard', effort: 'medium', useCache: false, ...extra }) };
}

test('a prior same-identity observation above reserve admits through a failed probe as stale', async t => {
  const bridge = await staleNativeFixture(t, { probeMode: 'fail' });
  const reply = await bridge.ask();
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.model_invocation, true);
  assert.equal(reply.body.route.native_usage_freshness, 'stale_admitted', JSON.stringify(reply.body));
  assert.equal(completeJsonLines(bridge.events).filter(e => e.type === 'usage_probe').length, 1);
});

// NOTE on the two cases below (windowReset-near-reserve admits as stale, and
// at/below-reserve stays fail-closed with a probe reason): both are
// UNREACHABLE through this fixture (or any request through /api/oneshot) as
// originally specified, and are documented rather than faked per the lane
// contract. resolveDispatchAccount (server.js:6823) filters candidate
// accounts by `subscriptionUsage.verdict(seat, ...).admit` BEFORE the
// native-launch-identity stale-admit fallback (server.js:4740-4786) is ever
// reached; the oneshot dispatch call site (server.js:4677) does not pass
// `ignoreNativeReserve: true` (unlike the two other call sites at
// server.js:6426 and 6460, which do use that seam for native-launch
// pre-checks). So any seat whose last-known usage is at/below reserve -
// which is exactly what both of these cases need to seed - gets rejected
// earlier, at account-selection time, with failureClass 'quota_reserve' and
// no `probe_reason` (server.js:4696), regardless of whether a binding window
// has since reset or what the probe would have returned. Reaching the
// fallback's own reserve-aware branches would require threading
// `ignoreNativeReserve: true` into the server.js:4677 dispatch call
// conditionally for native-launch identities - a broader change than this
// lane's minimal-edit scope (server.js untouched outside 4918-4920,
// 5111, 5153 for this task). Both cases are asserted against the system's
// actual, correct behavior instead.
test('a binding window reset since the prior observation still protects reserve at account-selection time (documented unreachable case)', async t => {
  const bridge = await staleNativeFixture(t, {
    initialUtilization: 99, probeMode: 'fail',
    patchStoreSeat: seat => { for (const w of Object.values(seat.buckets.account.windows)) w.resetsAt = Date.now() - 5000; },
  });
  const reply = await bridge.ask();
  assert.equal(reply.status, 409, JSON.stringify(reply.body));
  assert.equal(reply.body.failureClass, 'quota_reserve', JSON.stringify(reply.body));
  assert.equal(reply.body.model_invocation, false);
});

test('a prior observation at or below reserve is filtered at account-selection time, not the native fallback (documented unreachable case)', async t => {
  const bridge = await staleNativeFixture(t, { initialUtilization: 99, probeMode: 'fail' });
  const reply = await bridge.ask();
  assert.equal(reply.status, 409, JSON.stringify(reply.body));
  assert.equal(reply.body.failureClass, 'quota_reserve', JSON.stringify(reply.body));
  assert.equal(reply.body.model_invocation, false);
  assert.equal(reply.body.probe_reason, undefined, JSON.stringify(reply.body));
});

test('no prior observation stays fail-closed with a probe reason', async t => {
  // The live profile starts stale (never primed), so the server's own boot refresh
  // never records an observation for this identity (see
  // test/continuity.integration.test.js's "stale, future, mismatched and incomplete
  // native caches never authorize a fake model start", which asserts observedAt stays
  // undefined for a stale-at-boot profile).
  const bridge = await staleNativeFixture(t, { primeStore: false, probeMode: 'fail' });
  const reply = await bridge.ask();
  assert.equal(reply.status, 409, JSON.stringify(reply.body));
  assert.equal(reply.body.failureClass, 'quota_unknown', JSON.stringify(reply.body));
  assert.equal(reply.body.model_invocation, false);
  assert.ok(reply.body.probe_reason, JSON.stringify(reply.body));
  assert.equal(fs.existsSync(bridge.usageFile) ? JSON.parse(fs.readFileSync(bridge.usageFile, 'utf8')).claude.observedAt : undefined, undefined);
});

test('requireFreshUsage stays fail-closed even when the stale-admit fallback would otherwise admit', async t => {
  // Same headroom-above-reserve prior observation as the first case, but the store
  // entry is also pushed past its own TTL. headroom()'s admit only depends on
  // protected/reserve status (not freshness), so the native stale-admit fallback still
  // uses it; the LATER, separate requireFreshUsage gate (reserveAdmission.freshness)
  // does check freshness and must still reject.
  const bridge = await staleNativeFixture(t, {
    probeMode: 'fail',
    patchStoreSeat: seat => {
      seat.observedAt -= 200000; seat.seatObservedAt -= 200000;
      for (const w of Object.values(seat.buckets.account.windows)) w.observedAt -= 200000;
    },
  });
  const admitted = await bridge.ask();
  assert.equal(admitted.status, 200, JSON.stringify(admitted.body));
  assert.equal(admitted.body.route.native_usage_freshness, 'stale_admitted', JSON.stringify(admitted.body));
  const refused = await bridge.ask({ requireFreshUsage: true });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.failureClass, 'quota_unknown', JSON.stringify(refused.body));
  assert.equal(refused.body.model_invocation, false);
});
