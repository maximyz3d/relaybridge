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
  probeMode = null, patchStoreSeat = null, primeStore = true, trustProbeDir = true } = {}) {
  let profile, events, usageFile;
  const bridge = await startTestBridge(t, root => {
    profile = path.join(root, 'native-home', '.claude.json'); events = path.join(root, 'native-events.jsonl');
    usageFile = path.join(root, 'data', 'usage', 'native-usage.json');
    const probeCwd = path.join(root, 'data', 'claude-usage-probe'); fs.mkdirSync(probeCwd, { recursive: true });
    const accountUuid = '11111111-2222-3333-4444-555555555555', at = Date.now(), reset = at + initialResetOffsetMs;
    const initial = { oauthAccount: { accountUuid }, cachedUsageUtilization: { accountUuid, fetchedAtMs: at, utilization:
      Object.fromEntries(['five_hour', 'seven_day'].map(name => [name, { utilization: initialUtilization, resets_at: new Date(reset).toISOString() }])) } };
    // B1 fixture knob: when false, the probe's own project-trust read (a distinct
    // readClaudeNativeUsage call bound to CLAUDE_USAGE_PROBE_DIR) never establishes trust, so
    // probeClaudeNativeAdmission's pre-refresh identity comparison fails with
    // reason 'identity_mismatch_pre' -- the same reason code an actual account/profile
    // mismatch at that comparison would produce.
    if (trustProbeDir) initial.projects = { [probeCwd]: { hasTrustDialogAccepted: true } };
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
        if(${JSON.stringify(probeMode)}==='drift'){
          // B1 fixture: the logged-in account changes DURING the probe round-trip (refreshed,
          // not merely stale), so the post-refresh identity comparison inside
          // probeClaudeNativeAdmission sees a different account than the one captured at
          // admission time and fails closed with reason identity_mismatch_post.
          const value=JSON.parse(fs.readFileSync(${JSON.stringify(profile)},'utf8'));
          const driftedUuid='99999999-8888-7777-6666-555555555555';
          value.oauthAccount.accountUuid=driftedUuid; value.cachedUsageUtilization.accountUuid=driftedUuid;
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

// S5: an at/below-reserve prior observation whose binding window has genuinely rolled over
// (the store's own anchored reset boundary, not just a raw resetsAt field, has passed) must
// stale-admit through the native-launch fallback (server.js's stale-admit branch) with
// stale_reason:'window_reset'. headroom()'s `low`/`protectedState` computation is unchanged
// from main (a window's raw resetsAt no longer factors into it at all) -- the reserve stays
// protected at account-selection time until the probe runs; only the stale-admit fallback,
// via subscriptionUsage.anchoredRolloverOccurred(), may release admission, and only when the
// anchor itself (not merely resetsAt) has genuinely moved into the past. This fixture ages
// the whole native reset identity (nativeResetMs/nativeResetNs/nativeResetIso/
// resetBoundaryMs/nativeResetAnchor.ns) together with resetsAt, simulating a real rollover
// rather than a forged/moved resetsAt alone.
test('a binding window whose anchored rollover has occurred stale-admits through the fallback', async t => {
  const bridge = await staleNativeFixture(t, {
    initialUtilization: 99, probeMode: 'fail',
    patchStoreSeat: seat => {
      const pastMs = Date.now() - 5000;
      const pastNs = BigInt(pastMs) * 1000000n;
      const boundary = Number((pastNs + 999999999n) / 1000000000n) * 1000;
      for (const w of Object.values(seat.buckets.account.windows)) {
        w.resetsAt = pastMs;
        w.nativeResetMs = pastMs;
        w.nativeResetNs = String(pastNs);
        w.nativeResetIso = new Date(pastMs).toISOString();
        w.resetBoundaryMs = boundary;
        w.nativeResetAnchor = { version: 1, ns: String(pastNs), precision: 'nanosecond', origin: 'observed' };
      }
    },
  });
  const reply = await bridge.ask();
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.model_invocation, true);
  assert.equal(reply.body.route.native_usage_freshness, 'stale_admitted', JSON.stringify(reply.body));
  assert.equal(reply.body.route.stale_reason, 'window_reset', JSON.stringify(reply.body));
});

// Contrast: a forged/moved resetsAt alone, with the underlying native reset identity
// (nativeResetMs/anchor) left untouched, must NOT be trusted as a rollover -- the seat stays
// protected and the request is rejected as quota_reserve, same as before any window "reset".
test('a raw resetsAt moved into the past without an anchor change is not trusted as a rollover', async t => {
  const bridge = await staleNativeFixture(t, {
    initialUtilization: 99, probeMode: 'fail',
    patchStoreSeat: seat => { for (const w of Object.values(seat.buckets.account.windows)) w.resetsAt = Date.now() - 5000; },
  });
  const reply = await bridge.ask();
  assert.equal(reply.status, 409, JSON.stringify(reply.body));
  assert.equal(reply.body.failureClass, 'quota_reserve', JSON.stringify(reply.body));
  assert.equal(reply.body.model_invocation, false);
});

// Contrast case required by the lane spec: at/below reserve, but the binding window has
// NOT reset (initialResetOffsetMs stays in the future, the fixture default). This must still
// be filtered out at account-selection time as 'quota_reserve', with no probe ever run.
test('a prior observation at or below reserve whose window has not reset still rejects as quota_reserve', async t => {
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

// B1: the stale-admit fallback previously judged only headroom/windowReset from the prior
// observation, with no identity check at all -- so a wrong-account probe result, or an
// account that changed while the probe was mid-flight, could still stale-admit and launch
// under the wrong login. Both tests below force an identity mismatch and assert the request
// is refused with no provider ever started.

test('an identity mismatch during the probe rejects and never stale-admits', async t => {
  // trustProbeDir:false means probeClaudeNativeAdmission's own pre-refresh identity read
  // (bound to CLAUDE_USAGE_PROBE_DIR) never establishes project trust, so the probe fails
  // closed with reason identity_mismatch_pre before it ever runs the refresh command.
  const bridge = await staleNativeFixture(t, { probeMode: 'fail', trustProbeDir: false });
  const reply = await bridge.ask();
  assert.equal(reply.status, 409, JSON.stringify(reply.body));
  assert.equal(reply.body.failureClass, 'quota_unknown', JSON.stringify(reply.body));
  assert.equal(reply.body.probe_reason, 'identity_mismatch_pre', JSON.stringify(reply.body));
  assert.equal(reply.body.model_invocation, false);
  assert.equal(completeJsonLines(bridge.events).filter(e => e.type === 'started').length, 0);
});

test('an account that drifts during the probe round-trip rejects with no spawn', async t => {
  // probeMode:'drift' swaps the logged-in account mid-probe (a genuine refresh happens, not
  // merely staleness). refreshClaudeUsageViaPty's own sameIdentity gate then never reports
  // refreshed:true for the new account, so the probe times out unrefreshed; and the
  // post-probe sameClaudeLaunchIdentity() re-check this lane added to the stale-admit
  // fallback sees the now-drifted profile and refuses to fall back, so the request rejects
  // before the pre-spawn identity re-checks (server.js ~5119/5161) are ever reached, and no
  // provider process is started under the wrong account.
  const bridge = await staleNativeFixture(t, { probeMode: 'drift' });
  const reply = await bridge.ask();
  assert.equal(reply.status, 409, JSON.stringify(reply.body));
  assert.equal(reply.body.failureClass, 'quota_unknown', JSON.stringify(reply.body));
  assert.ok(reply.body.probe_reason, JSON.stringify(reply.body));
  assert.equal(reply.body.model_invocation, false);
  assert.equal(completeJsonLines(bridge.events).filter(e => e.type === 'started').length, 0);
});
