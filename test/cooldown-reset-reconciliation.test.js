'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { startTestBridge, completeJsonLines, waitFor } = require('./helpers/temporary-bridge');
const { createCooldownStore, BACKOFF } = require('../lib/provider-cooldown');
const { createSubscriptionUsage } = require('../lib/subscription-usage');
const { readClaudeNativeUsage, parseClaudeStreamRateLimit } = require('../lib/native-usage');
const { receiptStoreIdentity } = require('../lib/receipt-store-identity.cjs');
const recovery = require('../lib/cooldown-reset-reconciliation');
const seat = 'subscription:anthropic:default', uuid = '11111111-2222-3333-4444-555555555555';
const url = '/api/cooldowns/reset-reconciliations';
const unsetEnv = Object.fromEntries(Object.keys(process.env).filter(k => /^(RELAYBRIDGE_|PS_BRIDGE_)/.test(k)).map(k => [k, undefined]));
function sourceReceipt(current, storeId) {
  return { receiptId: current.sourceReceiptId, receiptStoreId: storeId, timestamp: new Date(current.lastOffenceAt + 1).toISOString(),
    event: 'bridge_provider_call', provider: 'claude', modelInvocation: true, status: 'dropped', failureClass: 'rate_limit',
    providerTerminalReason: 'api_error', providerApiErrorStatus: 429,
    quotaEvidence: { scope: 'account', status: 429 }, route: { quota_seat: seat, account: null },
    cooldown: { seat, sourceReceiptId: current.sourceReceiptId, until: current.until, offences: current.offences,
      source: 'backoff', reason: 'rate_limited', scope: 'account' } };
}
async function fixture(t, mode = 'success') {
  let expected, events, profile, current, journal, cooldownFile, failJournalWrite;
  const nodeArgs = [];
  const bridge = await startTestBridge(t, root => {
    const data = path.join(root, 'data'), nativeHome = path.join(root, 'native-home');
    failJournalWrite = path.join(root, 'fail-attempt-journal-write');
    const preload = path.join(root, 'attempt-journal-failure.cjs');
    // Fixture-only fault at the actual descriptor write, after durable reservation.
    // Marker stays absent in every other scenario; no permission/OS assumption.
    fs.writeFileSync(preload, `const fs=require('node:fs');
      const marker=${JSON.stringify(failJournalWrite)};
      fs.writeFileSync=new Proxy(fs.writeFileSync,{apply(target,receiver,args){
        if(typeof args[0]==='number'&&typeof args[1]==='string'&&fs.existsSync(marker)){
          let receipt;try{receipt=JSON.parse(args[1]);}catch{}
          if(receipt?.event==='cooldown_reset_attempt'&&receipt.seat===${JSON.stringify(seat)}){
            const error=new Error('fixture attempt journal write failure');error.code='EIO';throw error;
          }
        }
        return Reflect.apply(target,receiver,args);
      }});`);
    nodeArgs.push('--require', preload);
    const at = Date.now(), failureAt = at - 600000, oldAt = failureAt - 1000;
    const oldReset = at - 300000, weekReset = at + 604000000;
    profile = path.join(nativeHome, '.claude.json'); events = path.join(root, 'probe-events.jsonl');
    const probeCwd = path.join(data, 'claude-usage-probe'); fs.mkdirSync(probeCwd, { recursive: true });
    const initial = { oauthAccount: { accountUuid: uuid }, projects: { [probeCwd]: { hasTrustDialogAccepted: true } },
      cachedUsageUtilization: { accountUuid: uuid, fetchedAtMs: oldAt, utilization: {
        five_hour: { utilization: 100, resets_at: new Date(oldReset).toISOString() },
        seven_day: { utilization: 30, resets_at: new Date(weekReset).toISOString() } } } };
    fs.writeFileSync(profile, JSON.stringify(initial));
    // Reader's wall clock is real; prime using a momentarily fresh, future-reset cache,
    // then age its retained native authority to the historical failure/reset boundary.
    initial.cachedUsageUtilization.fetchedAtMs = at;
    initial.cachedUsageUtilization.utilization.five_hour.resets_at = new Date(at + 18000000).toISOString();
    fs.writeFileSync(profile, JSON.stringify(initial));
    const freshSample = readClaudeNativeUsage({ env: { HOME: nativeHome, USERPROFILE: nativeHome }, defaultHome: nativeHome, quotaSeat: seat });
    const usageDir = path.join(data, 'usage'), usage = createSubscriptionUsage({ dataDir: usageDir });
    usage.bindIdentity(seat, freshSample.identity.accountFingerprint); usage.observeNativeCache(freshSample.observation);
    usage.setSettings({ usageProtection: true, reservePercent: 5 });
    const file = path.join(usageDir, 'native-usage.json'), raw = JSON.parse(fs.readFileSync(file));
    const row = raw[seat]; row.observedAt = oldAt; row.seatObservedAt = oldAt;
    row.ordinaryUsageAllowed = false; row.denialObservedAt = oldAt;
    row.nativeFetchWatermarks = { [row.accountFingerprint]: oldAt };
    for (const w of Object.values(row.buckets.account.windows)) w.observedAt = oldAt;
    const w = row.buckets.account.windows.five_hour;
    Object.assign(w, { resetsAt: oldReset, nativeResetMs: oldReset, nativeResetIso: new Date(oldReset).toISOString(),
      nativeResetNs: String(BigInt(oldReset) * 1000000n), resetBoundaryMs: Math.ceil(oldReset / 1000) * 1000,
      nativeResetAnchor: { version: 1, ns: String(BigInt(oldReset) * 1000000n), precision: 'nanosecond', origin: 'observed' } });
    fs.writeFileSync(file, JSON.stringify(raw));
    initial.cachedUsageUtilization.fetchedAtMs = oldAt;
    initial.cachedUsageUtilization.utilization.five_hour.resets_at = new Date(oldReset).toISOString();
    fs.writeFileSync(profile, JSON.stringify(initial));
    cooldownFile = path.join(data, 'cooldowns.json');
    const cooldown = createCooldownStore({ file: cooldownFile, now: () => failureAt });
    for (let i = 0; i < 4; i++) { const observed = cooldown.noteFailure(seat, 'rate_limited'); cooldown.attachReceipt(observed, 'rcpt_genuine'); }
    current = cooldown.status(seat);
    expected = { kind: 'claude', accountId: 'default', quotaSeat: seat, ...recovery.expectedObservation(current), acknowledgeNativeReset: true };
    const storeId = receiptStoreIdentity(data).id;
    fs.mkdirSync(path.join(data, 'receipts'), { recursive: true });
    journal = path.join(data, 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl');
    fs.writeFileSync(journal, JSON.stringify(sourceReceipt(current, storeId)) + '\n');
    const script = path.join(root, 'native-fixture.cjs');
    fs.writeFileSync(script, `const fs=require('node:fs');const mode=${JSON.stringify(mode)};const profile=${JSON.stringify(profile)};
      const log=type=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({type,at:Date.now()})+'\\n');
      if(process.argv.includes('--version')){console.log('Claude Code v1.0');process.exit(0);}
      if(!process.argv.includes('-p')){console.log('Claude Code v1.0\\n? for shortcuts\\n❯ ');let input='';
        process.stdin.on('data',chunk=>{input+=chunk;if(!input.includes('/usage'))return;input='';log('usage');
          if(mode==='stale')return;
          const value=JSON.parse(fs.readFileSync(profile));value.cachedUsageUtilization.fetchedAtMs=Date.now();
          value.cachedUsageUtilization.utilization.five_hour={utilization:0,resets_at:new Date(Date.now()+18000000-(mode==='samewindow'?900000:0)).toISOString()};
          if(mode==='weekly')value.cachedUsageUtilization.utilization.seven_day.utilization=99;
          if(mode==='identity'){value.oauthAccount.accountUuid='99999999-8888-7777-6666-555555555555';value.cachedUsageUtilization.accountUuid=value.oauthAccount.accountUuid;}
          fs.writeFileSync(profile,JSON.stringify(value));});setInterval(()=>{},1000);
      }else{log('answer');
        if(mode==='hang'){setInterval(()=>{},1000);return;}
        if(mode==='postidentity'){const p=JSON.parse(fs.readFileSync(profile));p.oauthAccount.accountUuid='99999999-8888-7777-6666-555555555555';p.cachedUsageUtilization.accountUuid=p.oauthAccount.accountUuid;fs.writeFileSync(profile,JSON.stringify(p));}

        if(mode==='race'){const {createCooldownStore}=require(${JSON.stringify(require.resolve('../lib/provider-cooldown'))});createCooldownStore({file:${JSON.stringify(cooldownFile)}}).noteFailure(${JSON.stringify(seat)},'overloaded');}
        const p=JSON.parse(fs.readFileSync(profile)); if(mode==='answerlow')p.cachedUsageUtilization.utilization.seven_day.utilization=100; const windows=Object.fromEntries(Object.entries(p.cachedUsageUtilization.utilization).map(([k,w])=>[k,{utilization:w.utilization/100,resetsAt:Math.ceil(Date.parse(w.resets_at)/1000)}]));
        console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-sonnet-5-5'}));
        if(mode!=='missing')console.log(JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:mode==='rejected'?'rejected':'allowed_warning',unifiedWindows:windows}}));
        console.log(JSON.stringify({type:'result',subtype:mode==='error'?'error_during_execution':'success',is_error:mode==='error',result:'READY',num_turns:1,permission_denials:mode==='denied'?[{tool_name:'Bash'}]:[],usage:{input_tokens:1,output_tokens:1}}));
      }`);
    return { _models: { discoverOnBoot: false }, claude: { label: 'Native fixture', npm_package: '@anthropic-ai/claude-code',
      credential_env: 'CLAUDE_CONFIG_DIR', quota_seat: seat, transport: 'subscription:anthropic',
      safe: [process.execPath, script, '--safe-mode', '--restricted', '--strict-mcp-config', '--mcp-config', '{\"mcpServers\":{}}', '--tools', 'Read,Glob,Grep', '--permission-mode', 'plan', '--autocompact', '150k', '--model', 'sonnet', '--effort', 'medium'], probe: [process.execPath, script, '--version'], version_probe: [process.execPath, script, '--version'],
      oneshot_safe: [process.execPath, script, '-p'], oneshot_safe_filesystem_policy: 'read_only_enforced',
      oneshot_output_parser: 'claude_json', model: 'fixture-model',
      native_usage_probe: { enabled: true, command: [process.execPath, script], timeout_ms: 1000 } } };
  }, { nodeArgs, env: { ...unsetEnv, RELAYBRIDGE_WARM_DIAG: '0', RELAYBRIDGE_REMOTE_MCP: '0', PTY_MODE: 'auto' } });
  const health = (await bridge.request('/api/health')).body;
  const headers = { ...bridge.headers, 'x-relaybridge-expected-build-id': health.buildId,
    'x-relaybridge-expected-receipt-store-id': health.receiptStoreId };
  return { ...bridge, expected, events, current, journal, cooldownFile, failJournalWrite, headers,
    reconcile: (body = expected, options = {}) => bridge.request(url, body, { headers, ...options }) };
}
test('closed reset request and source proof reject weaker/fabricated authority', () => {
  const at = Date.now(), current = { sourceReceiptId: 'rcpt_genuine', sourceObservationId: 'a'.repeat(24),
    lastOffenceAt: at, until: at + BACKOFF[3], offences: 4, source: 'backoff', reason: 'rate_limited', scope: 'account' };
  const body = { kind: 'claude', accountId: 'default', quotaSeat: seat, ...recovery.expectedObservation(current), acknowledgeNativeReset: true };
  assert.equal(recovery.validResetRequest(body), true);
  for (const patch of [{ force: true }, { accountId: 'other' }, { kind: 'codex' }, { acknowledgeNativeReset: false }, { until: null }]) assert.equal(recovery.validResetRequest({ ...body, ...patch }), false);
  const r = sourceReceipt(current, 'store');
  const check = (row = current, rows = [r]) => recovery.authorizeResetSource({ rows, current: row, seat, receiptStoreId: 'store', now: at });
  assert.equal(check().ok, true);
  for (const source of ['retry-after', 'retry-after-capped', 'overload-default']) assert.equal(check({ ...current, source }).ok, false);
  for (const patch of [{ scope: 'model' }, { until: current.until + 1 }]) assert.equal(check({ ...current, ...patch }).ok, false);
  assert.equal(check(current, []).ok, false); assert.equal(check(current, [r,r]).ok, false);
  assert.equal(check(current, [{ ...r, providerApiErrorStatus: null }]).ok, false);
});
test('actual reset endpoint checks authority then coalesces probes, clears both holds and replays without quota', async t => {
  const f = await fixture(t);
  assert.equal((await f.reconcile(f.expected, { headers: { 'Content-Type': 'application/json' } })).status, 401);
  assert.equal((await f.request(url, f.expected)).status, 409);
  assert.equal((await f.reconcile({ ...f.expected, force: true })).status, 400);
  assert.equal((await f.reconcile({ ...f.expected, until: f.expected.until + 1 })).status, 409);
  const results = await Promise.all([f.reconcile(), f.reconcile()]);
  for (const result of results) assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(results[0].body.after.offences, 4);
  assert.equal((await f.reconcile()).body.replayed, true);
  assert.deepEqual(completeJsonLines(f.events).map(e => e.type), ['usage','answer']);
  const row = JSON.parse(fs.readFileSync(f.cooldownFile))[seat];
  assert.equal(row.until, 0); assert.equal(row.lastOffenceAt, f.expected.lastOffenceAt);
  assert.equal(createCooldownStore({ file: f.cooldownFile })._state()[seat].reconciliation.receiptId, results[0].body.reconciliation.receiptId);
  const usage = JSON.parse(fs.readFileSync(path.join(f.root, 'data', 'usage', 'native-usage.json')))[seat];
  assert.equal(usage.ordinaryUsageAllowed, true);
  const response = await f.request('/api/oneshot', { kind: 'claude', prompt: 'fixed fixture', cwd: f.root, dangerous: false });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.exitCode, 0, JSON.stringify(response.body));
});
for (const mode of ['stale', 'samewindow', 'weekly', 'identity', 'missing', 'rejected', 'error', 'denied', 'race', 'postidentity', 'answerlow']) {
  test(`actual endpoint refuses ${mode}, retains denial/backoff and durable retry throttle`, async t => {
    const f = await fixture(t, mode), response = await f.reconcile();
    assert.equal(response.status, 409, JSON.stringify(response.body));
    const row = JSON.parse(fs.readFileSync(f.cooldownFile))[seat];
    assert.ok(row.until > Date.now());
    const usage = JSON.parse(fs.readFileSync(path.join(f.root, 'data', 'usage', 'native-usage.json')))[seat];
    assert.equal(usage.ordinaryUsageAllowed, false);
    const count = completeJsonLines(f.events).length;
    assert.equal((await f.reconcile()).status, 409);
    assert.equal(completeJsonLines(f.events).length, count);
    assert.equal(createCooldownStore({ file: f.cooldownFile }).beginResetAttempt(seat, recovery.expectedObservation(row), recovery.requestDigest(f.expected)).code, 'reset_attempt_throttled');
  });
}

test('actual endpoint refuses exact source, model hold, corrupt journal and append failure before any quota use', async t => {
  const f = await fixture(t), before = fs.readFileSync(f.cooldownFile, 'utf8'), journalBefore = fs.readFileSync(f.journal, 'utf8');
  const callExpectNoProbe = async status => {
    const result = await f.reconcile(); assert.equal(result.status, status, JSON.stringify(result.body));
    assert.equal(completeJsonLines(f.events).length, 0);
  };
  const row = JSON.parse(before);
  for (const patch of [{ source: 'retry-after' }, { scope: 'model' }]) {
    fs.writeFileSync(f.cooldownFile, JSON.stringify({ [seat]: { ...row[seat], ...patch } })); await callExpectNoProbe(409);
  }
  fs.writeFileSync(f.cooldownFile, before);
  fs.writeFileSync(f.journal, journalBefore + journalBefore); await callExpectNoProbe(409);
  fs.writeFileSync(f.journal, journalBefore + '{'); await callExpectNoProbe(503);
  fs.writeFileSync(f.journal, journalBefore);
  const c = createCooldownStore({ file: f.cooldownFile }); c.noteFailure('claude', 'rate_limited', { scope: 'model' });
  await callExpectNoProbe(409); fs.writeFileSync(f.cooldownFile, before);
  // Read is permitted but the required attempt journal append fails. Reservation
  // is durable, so retrying after a disk repair cannot silently spend again.
  fs.writeFileSync(f.failJournalWrite, 'armed');
  await callExpectNoProbe(503);
  fs.unlinkSync(f.failJournalWrite);
  assert.equal(fs.readFileSync(f.journal, 'utf8'), journalBefore);
  const retained = JSON.parse(fs.readFileSync(f.cooldownFile))[seat];
  assert.equal(retained.sourceReceiptId, f.expected.sourceReceiptId);
  assert.equal(retained.until, f.expected.until);
  assert.equal(retained.resetAttempt.event, 'cooldown_reset_attempt');
  assert.equal((await f.reconcile()).body.code, 'reset_attempt_throttled');
});
test('cancelled generating probe never releases either hold', async t => {
  const f = await fixture(t, 'hang'), controller = new AbortController();
  const pending = f.reconcile(f.expected, { signal: controller.signal }).catch(error => error);
  await waitFor(() => completeJsonLines(f.events).some(e => e.type === 'answer'));
  controller.abort(); await pending;
  await waitFor(() => completeJsonLines(f.journal).some(e => e.event === 'cooldown_reset_probe_result'));
  assert.ok(JSON.parse(fs.readFileSync(f.cooldownFile))[seat].until > Date.now());
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'data', 'usage', 'native-usage.json')))[seat].ordinaryUsageAllowed, false);
});
test('maintenance safety timeout never releases either hold', async t => {
  const f = await fixture(t, 'hang'), response = await f.reconcile();
  assert.equal(response.status, 409); assert.equal(response.body.code, 'reset_probe_failed');
  assert.ok(JSON.parse(fs.readFileSync(f.cooldownFile))[seat].until > Date.now());
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'data', 'usage', 'native-usage.json')))[seat].ordinaryUsageAllowed, false);
});


test('fixed probe normalizes installed Claude safe slot and refuses wrappers/unknown flags', () => {
  const slot = ['claude', '--safe-mode', '--restricted', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'Read,Glob,Grep', '--permission-mode', 'plan', '--autocompact', '150k', '--model', 'sonnet', '--effort', 'medium'];
  assert.deepEqual(recovery.fixedResetCommand(slot), { binary: 'claude', prefix: ['--safe-mode', '--restricted'] });
  for (const bad of [['sh', '-c', 'claude'], ['claude', '--dangerously-skip-permissions'], ['claude', '--model'], ['claude', '--settings', 'untrusted.json']]) assert.equal(recovery.fixedResetCommand(bad), null);
});
