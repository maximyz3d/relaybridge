'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { startTestBridge, waitFor, completeJsonLines } = require('./helpers/temporary-bridge');
const ROOT = path.resolve(__dirname, '..');
const inheritedBridgeKeys = Object.keys(process.env).filter((key) => /^(RELAYBRIDGE_|PS_BRIDGE_)/.test(key));
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !inheritedBridgeKeys.includes(key)));
const unsetBridgeEnv = Object.fromEntries(inheritedBridgeKeys.map((key) => [key, undefined]));
async function fixture(t) {
  let events;
  const bridge = await startTestBridge(t, (root) => {
    events = path.join(root, 'events.jsonl');
    const script = path.join(root, 'provider.cjs');
    fs.writeFileSync(script, `const fs=require('node:fs'),path=require('node:path');
      const [kind,root]=process.argv.slice(2);let input='';
      const event=(type,extra={})=>fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify({kind,type,at:Date.now(),...extra})+'\\n');
      if(process.argv.includes('app-server')){
        let buf='';process.stdin.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){const q=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);
          event('rpc',{method:q.method});if(q.id===1)console.log(JSON.stringify({id:1,result:{}}));
          if(q.id===2)console.log(JSON.stringify({id:2,result:{ordinaryUsageAllowed:true,rateLimits:{limitId:'codex',primary:{usedPercent:20,resetsAt:Math.floor(Date.now()/1000)+3600,windowDurationMins:300}}}}));
        }});process.stdin.on('end',()=>process.exit(0));
      }else{process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
        event('started');
        if(kind==='codex'){console.log(JSON.stringify({checkpoint:{decisions:'Inherited the durable project checkpoint',pending:'Implementation requires the existing writer policy'},delegations:[],complete:false}));event('finished');}
        else if(input.includes('RB_SLOW')){setTimeout(()=>{console.log('Completed delayed answer.');event('finished');},1000);}
        else {let count=0;const timer=setInterval(()=>console.log('Public checkpoint '+(++count)),100);
          process.on('SIGTERM',()=>{clearInterval(timer);const d=path.join(root,'data','continuity','runs');event('stopping',{handoffExists:fs.existsSync(d)&&fs.readdirSync(d).some(n=>n.endsWith('.md'))});setTimeout(()=>{event('finished');process.exit(0);},100);});}
      });}`);
    return { _models: { discoverOnBoot: false }, ...Object.fromEntries(['claude', 'codex'].map((kind) => [kind, {
      label: kind, safe: [process.execPath], probe: [process.execPath, '--version'], version_probe: [process.execPath, '--version'],
      model: 'fixture-model', model_tiers: { standard: { model: 'fixture-model', args: ['--model','fixture-model'] } },
      oneshot_safe: [process.execPath, script, kind, root, '--model', 'fixture-model'], oneshot_output_parser: 'text',
      oneshot_safe_filesystem_policy: 'read_only_enforced',
      oneshot_capabilities: { safe: ['model_invocation', 'workspace_read', 'tool_use'] },
      ...(kind === 'codex' ? { npm_package: '@openai/codex', native_usage_command: [process.execPath, script, kind, root] } : {}),
    }])) };
  }, { env: { ...unsetBridgeEnv, RELAYBRIDGE_WARM_DIAG: '0', RELAYBRIDGE_REMOTE_MCP: '0' } });
  return { ...bridge, events };
}
// Explicitly declared native protocol with a disposable metadata profile and
// an inert Node transport. No installed Claude binary/account is used here.
async function nativeClaudeFixture(t, { mutate = () => {}, registry = null, changeConfig = () => {}, env = {}, interleaveConfig = null,
  probeMode = null } = {}) {
  let profile, events, initial;
  const nodeArgs = [];
  const bridge = await startTestBridge(t, root => {
    if (interleaveConfig) {
      const preload = path.join(root, 'interleave-config.cjs');
      fs.writeFileSync(preload, `const fs=require('node:fs'),path=require('node:path');
        const read=fs.readFileSync,configPath=path.join(${JSON.stringify(root)},'config.json');
        const arm=path.join(${JSON.stringify(root)},'arm-config-change'),done=path.join(${JSON.stringify(root)},'config-change-done');
        fs.readFileSync=function(file,...args){const bytes=read.call(this,file,...args);
          if(file===configPath&&fs.existsSync(arm)&&!fs.existsSync(done)&&new Error().stack.includes('executeOneShot')){
            const config=JSON.parse(bytes);(${interleaveConfig.toString()})(config);
            fs.writeFileSync(configPath,JSON.stringify(config));fs.writeFileSync(done,'changed');
          }return bytes;};`);
      nodeArgs.push('--require', preload);
    }
    profile = path.join(root, 'native-home', '.claude.json'); events = path.join(root, 'native-events.jsonl');
    const probeCwd = path.join(root, 'data', 'claude-usage-probe'); fs.mkdirSync(probeCwd, { recursive: true });
    const accountUuid = '11111111-2222-3333-4444-555555555555', at = Date.now(), reset = Math.floor(at / 1000) * 1000 + 86400000;
    initial = { oauthAccount: { accountUuid }, cachedUsageUtilization: { accountUuid, fetchedAtMs: at, utilization:
      Object.fromEntries(['five_hour', 'seven_day'].map(name => [name, { utilization: 20, resets_at: new Date(reset - 437).toISOString() }])) } };
    initial.projects = { [probeCwd]: { hasTrustDialogAccepted: true } };
    mutate(initial); fs.writeFileSync(profile, JSON.stringify(initial));
    if (registry) { fs.mkdirSync(path.join(root, 'data'), { recursive: true }); fs.writeFileSync(path.join(root, 'data', 'accounts.json'), JSON.stringify({ providers: registry })); }
    const script = path.join(root, 'native-fixture.cjs');
    fs.writeFileSync(script, `const fs=require('node:fs');let input='';const event=type=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({type,at:Date.now()})+'\\n');
      const usage=()=>console.log(JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'allowed',unifiedWindows:{five_hour:{utilization:.2,resetsAt:${reset / 1000}},seven_day:{utilization:.2,resetsAt:${reset / 1000}}}}}));
      process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{event('started');
        if(input.includes('HOLD')){if(!input.includes('TICK'))usage();const timer=setInterval(()=>{if(!input.includes('TICK'))usage();},100);
          process.on('SIGTERM',()=>{clearInterval(timer);event('stopped');process.exit(0);});}
        else {usage();console.log(JSON.stringify({type:'result',subtype:'success',result:'Synthetic native protocol completed.'}));event('finished');}});`);
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
    const cfg = { _models: { discoverOnBoot: false }, claude: entry, claude_fable: { ...entry } }; changeConfig(cfg, root); return cfg;
  }, { nodeArgs, env: { ...unsetBridgeEnv, RELAYBRIDGE_WARM_DIAG: '0', RELAYBRIDGE_REMOTE_MCP: '0', ...env } });
  return { ...bridge, profile, events, initial, usageFile: path.join(bridge.root, 'data', 'usage', 'native-usage.json'),
    ask: (prompt = 'Complete synthetic protocol.', kind = 'claude') => bridge.request('/api/oneshot',
      { kind, cwd: bridge.root, prompt, dangerous: false, modelTier: 'standard', effort: 'medium', useCache: false }) };
}

test('stale native Claude admission refreshes through a non-generating PTY probe', async t => {
  const bridge = await nativeClaudeFixture(t, {
    probeMode: 'recover', env: { PTY_MODE: 'auto' },
    mutate: profile => { profile.cachedUsageUtilization.fetchedAtMs -= 180001; },
  });
  const replies = await Promise.all([bridge.ask('First synthetic protocol.', 'claude'),
    bridge.ask('Second synthetic protocol.', 'claude_fable')]);
  for (const reply of replies) {
    assert.equal(reply.status, 200, JSON.stringify(reply.body)); assert.equal(reply.body.model_invocation, true);
  }
  const events = completeJsonLines(bridge.events);
  assert.equal(events.filter(event => event.type === 'usage_probe').length, 1);
  assert.equal(events.filter(event => event.type === 'started').length, 2);
});

test('failed native Claude PTY refresh stays fail-closed and fresh capacity skips the probe', async t => {
  await t.test('failed refresh', async sub => {
    const bridge = await nativeClaudeFixture(sub, {
      probeMode: 'fail', env: { PTY_MODE: 'auto' },
      mutate: profile => { profile.cachedUsageUtilization.fetchedAtMs -= 180001; },
    });
    const replies = [await bridge.ask(), await bridge.ask('Retry during probe cooldown.')];
    for (const reply of replies) {
      assert.equal(reply.body.failureClass, 'quota_unknown', JSON.stringify(reply.body));
      assert.equal(reply.body.model_invocation, false);
    }
    const events = completeJsonLines(bridge.events);
    assert.equal(events.filter(event => event.type === 'usage_probe').length, 1);
    assert.equal(events.filter(event => event.type === 'started').length, 0);
  });
  await t.test('fresh cache', async sub => {
    const bridge = await nativeClaudeFixture(sub, { probeMode: 'recover', env: { PTY_MODE: 'auto' } });
    const reply = await bridge.ask(); assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(completeJsonLines(bridge.events).filter(event => event.type === 'usage_probe').length, 0);
  });
  await t.test('fresh protected reserve', async sub => {
    const bridge = await nativeClaudeFixture(sub, {
      probeMode: 'recover', env: { PTY_MODE: 'auto' },
      mutate: profile => {
        for (const window of Object.values(profile.cachedUsageUtilization.utilization)) window.utilization = 98;
      },
    });
    const reply = await bridge.ask();
    assert.equal(reply.body.failureClass, 'quota_reserve', JSON.stringify(reply.body));
    assert.equal(reply.body.model_invocation, false);
    assert.equal(completeJsonLines(bridge.events).filter(event => event.type === 'usage_probe').length, 0);
  });
});

test('default native Claude cache refresh is non-generating, independent of Codex and deduplicates eligible aliases', async t => {
  const bridge = await nativeClaudeFixture(t);
  await waitFor(() => fs.existsSync(bridge.usageFile));
  const before = JSON.parse(fs.readFileSync(bridge.usageFile)).claude;
  assert.equal(before.source, 'claude_native_cache_v1'); assert.equal(before.observedAt, bridge.initial.cachedUsageUtilization.fetchedAtMs);
  assert.equal(before.history.length, 1); assert.equal(completeJsonLines(bridge.events).length, 0);
  assert.equal((await bridge.request('/api/usage/native/refresh', {})).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(bridge.usageFile)).claude.history.length, 1);
  const reply = await bridge.ask(); assert.equal(reply.status, 200, JSON.stringify(reply.body)); assert.equal(reply.body.model_invocation, true);
  const after = JSON.parse(fs.readFileSync(bridge.usageFile)).claude;
  assert.equal(after.source, 'claude_stream_v1'); assert.equal(after.accountFingerprint, before.accountFingerprint);
  assert.equal(after.buckets.account.windows.five_hour.accountFingerprint, before.accountFingerprint);
  assert.equal(after.buckets.account.windows.five_hour.nativeResetNs, before.buckets.account.windows.five_hour.nativeResetNs);
  const rejected = await bridge.request('/api/usage/native', { kind: 'claude', rate_limits: { five_hour: { used_percentage: 0, resets_at: Math.floor(Date.now() / 1000) + 86400 } } });
  assert.equal(rejected.body.observed, false, 'unbound statusline cannot relabel the selected login');
});
test('zero-use native Claude cache with no five-hour reset admits the selected profile', async t => {
  const bridge = await nativeClaudeFixture(t, { mutate(profile) {
    profile.cachedUsageUtilization.utilization.five_hour = { utilization: 0, resets_at: null };
    profile.cachedUsageUtilization.utilization.seven_day.utilization = 0;
  } });
  await waitFor(() => fs.existsSync(bridge.usageFile));
  const before = JSON.parse(fs.readFileSync(bridge.usageFile)).claude;
  assert.equal(before.buckets.account.windows.five_hour.nativeNoActiveWindow, true);
  assert.equal(completeJsonLines(bridge.events).length, 0);
  const reply = await bridge.ask();
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.model_invocation, true);
});

test('verified native adapter refreshes stale counters while preserving unadmitted reset authority', async t => {
  const { createSubscriptionUsage } = require('../lib/subscription-usage');
  const { parseClaudeNativeCache } = require('../lib/native-usage');
  let priorProfile, priorState;
  const bridge = await nativeClaudeFixture(t, {
    mutate(profile) {
      priorProfile = structuredClone(profile); priorProfile.cachedUsageUtilization.fetchedAtMs -= 180001;
      for (const w of Object.values(profile.cachedUsageUtilization.utilization)) {
        w.resets_at = new Date(Date.parse(w.resets_at) + 3000).toISOString();
      }
    },
    changeConfig(cfg, root) {
      const dataDir = path.join(root, 'data', 'usage'), at = priorProfile.cachedUsageUtilization.fetchedAtMs;
      const store = createSubscriptionUsage({ dataDir, now: () => at });
      const observation = parseClaudeNativeCache(priorProfile, { quotaSeat: 'claude', now: at });
      assert.ok(observation); store.bindIdentity('claude', observation.accountFingerprint); assert.equal(store.observe(observation), true);
      priorState = JSON.parse(fs.readFileSync(path.join(dataDir, 'native-usage.json'))).claude;
    },
  });
  await waitFor(() => JSON.parse(fs.readFileSync(bridge.usageFile)).claude.observedAt > priorState.observedAt);
  const after = JSON.parse(fs.readFileSync(bridge.usageFile)).claude;
  assert.equal(after.observedAt, bridge.initial.cachedUsageUtilization.fetchedAtMs);
  assert.equal(completeJsonLines(bridge.events).length, 0, 'refresh must not invoke the synthetic provider');
  for (const id of ['five_hour', 'seven_day']) {
    const w = after.buckets.account.windows[id], old = priorState.buckets.account.windows[id];
    for (const field of ['resetsAt', 'nativeResetMs', 'nativeResetNs', 'nativeResetIso', 'nativeResetAnchor', 'resetBoundaryMs']) {
      assert.deepEqual(w[field], old[field], `${id}.${field}`);
    }
    assert.equal(w.nativeCounterRefresh.resetIdentityAccepted, false);
    assert.equal(w.nativeCounterRefresh.retainedFromEvidenceHash, priorState.evidenceHash);
  }
  const reply = await bridge.ask(); assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.model_invocation, true, 'fresh bound counter evidence authorizes only the isolated synthetic provider');
});

test('stale, future, mismatched and incomplete native caches never authorize a fake model start', async t => {
  for (const [name, mutate] of Object.entries({ stale: p => p.cachedUsageUtilization.fetchedAtMs -= 180001,
    future: p => p.cachedUsageUtilization.fetchedAtMs += 60000, mismatch: p => p.cachedUsageUtilization.accountUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    incomplete: p => delete p.cachedUsageUtilization.utilization.seven_day })) await t.test(name, async sub => {
    const bridge = await nativeClaudeFixture(sub, { mutate }); const reply = await bridge.ask();
    assert.equal(reply.body.failureClass, 'quota_unknown', JSON.stringify(reply.body)); assert.equal(reply.body.model_invocation, false);
    assert.equal(completeJsonLines(bridge.events).length, 0);
    const stored = JSON.parse(fs.readFileSync(bridge.usageFile)).claude;
    assert.ok(stored.selectedFingerprint); assert.equal(stored.observedAt, undefined);
  });
});
test('inherited and explicit authentication overrides cannot authorize default-profile native launches', async t => {
  for (const explicit of [false, true]) for (const key of require('../cli-config.json').claude_fable.strip_env) {
    await t.test(`${explicit ? 'explicit' : 'inherited'} ${key}`, async sub => {
      const bridge = await nativeClaudeFixture(sub, { env: explicit ? {} : { [key]: 'synthetic-selector' },
        changeConfig: cfg => { cfg.claude.strip_env = []; cfg.claude_fable.enabled = false;
          if (explicit) cfg.claude.oneshot_env = { [key]: 'synthetic-selector' }; } });
      const reply = await bridge.ask(); assert.equal(reply.body.model_invocation, false, JSON.stringify(reply.body));
      assert.equal(completeJsonLines(bridge.events).length, 0);
    });
  }
});

test('dispatch config snapshot cannot lose native identity requirements before capture', async t => {
  for (const [name, interleaveConfig] of [
    ['removed native markers', cfg => { delete cfg.claude.npm_package; delete cfg.claude.credential_env; }],
    ['changed launch environment', cfg => { cfg.claude.oneshot_env = { SYNTHETIC_LAUNCH_CHANGE: 'changed' }; }],
    ['changed quota seat', cfg => { cfg.claude.quota_seat = 'replacement-seat'; }],
  ]) await t.test(name, async sub => {
    const bridge = await nativeClaudeFixture(sub, { interleaveConfig,
      mutate: p => { delete p.cachedUsageUtilization.utilization.seven_day; },
      changeConfig: cfg => { cfg.claude_fable.enabled = false; } });
    fs.writeFileSync(path.join(bridge.root, 'arm-config-change'), 'armed');
    const reply = await bridge.ask();
    assert.ok(fs.existsSync(path.join(bridge.root, 'config-change-done')), 'initial dispatch read returned the old native entry before the on-disk change');
    assert.equal(reply.body.failureClass, 'account_identity_unavailable', JSON.stringify(reply.body));
    assert.equal(reply.body.model_invocation, false);
    assert.equal(completeJsonLines(bridge.events).length, 0);
  });
});

test('native profile relocation and disabled or tombstoned aliases cannot silently use default capacity', async t => {
  for (const [name, options, kind] of [
    ['relocated', { changeConfig: (cfg, root) => { cfg.claude.oneshot_env = { CLAUDE_CONFIG_DIR: root }; cfg.claude_fable.enabled = false; } }, 'claude'],
    ['home', { changeConfig: (cfg, root) => { cfg.claude.oneshot_env = { HOME: root }; cfg.claude_fable.enabled = false; } }, 'claude'],
    ['disabled', { registry: { claude: { accounts: [{ id: 'default', enabled: false }] } } }, 'claude'],
    ['tombstone', { registry: { claude_fable: { accounts: [] } } }, 'claude_fable'],
  ]) await t.test(name, async sub => {
    const bridge = await nativeClaudeFixture(sub, options); const reply = await bridge.ask('Complete synthetic protocol.', kind);
    assert.equal(reply.body.model_invocation, false, JSON.stringify(reply.body)); assert.ok(reply.status >= 400);
    assert.equal(completeJsonLines(bridge.events).length, 0);
    if (fs.existsSync(bridge.usageFile)) assert.equal(JSON.parse(fs.readFileSync(bridge.usageFile)).claude.history.length, 1,
      'only the remaining eligible alias can contribute one account observation');
  });
});

test('native profile change stops an active stream without accepting quota under the new login', async t => {
  for (const [name, mode, change] of [
    ['quota event', 'HOLD', bridge => { const changed = structuredClone(bridge.initial); changed.oauthAccount.accountUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; fs.writeFileSync(bridge.profile, JSON.stringify(changed)); }],
    ['silent tick', 'HOLD TICK', bridge => { const changed = structuredClone(bridge.initial); changed.oauthAccount.accountUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; fs.writeFileSync(bridge.profile, JSON.stringify(changed)); }],
    ['disabled registry', 'HOLD', bridge => { fs.writeFileSync(path.join(bridge.root, 'data', 'accounts.json'), JSON.stringify({ providers: { claude: { accounts: [{ id: 'default', enabled: false }] } } })); }],
    ['native configuration removed', 'HOLD TICK', bridge => { const cfg = JSON.parse(fs.readFileSync(bridge.configPath)); delete cfg.claude.npm_package; delete cfg.claude.credential_env; fs.writeFileSync(bridge.configPath, JSON.stringify(cfg)); }],
  ]) await t.test(name, async sub => {
    const bridge = await nativeClaudeFixture(sub), pending = bridge.ask(mode);
    await waitFor(() => completeJsonLines(bridge.events).some(e => e.type === 'started'));
    const before = JSON.parse(fs.readFileSync(bridge.usageFile)).claude;
    change(bridge);
    const reply = await pending; assert.equal(reply.body.supervisor_stop_reason, 'account_identity_changed', JSON.stringify(reply.body));
    const after = JSON.parse(fs.readFileSync(bridge.usageFile)).claude;
    assert.equal(after.accountFingerprint, before.accountFingerprint);
    assert.equal(completeJsonLines(bridge.events).filter(e => e.type === 'started').length, 1);
    assert.ok(fs.readdirSync(path.join(bridge.root, 'data', 'continuity', 'runs')).some(name => name.endsWith('.md')));
  });
});
test('native quota stops only after a durable checkpoint and launches one physically fenced successor', { timeout: 30000 }, async (t) => {
  const bridge = await fixture(t);
  await waitFor(async () => (await bridge.request('/api/usage/native')).body.observations.some((o) => o.quotaSeat === 'codex' && o.freshness === 'fresh'));
  const reset = Math.floor(Date.now()/1000)+3600;
  const observe = (used) => bridge.request('/api/usage/native', { kind: 'claude', rate_limits: { five_hour: { used_percentage: used, resets_at: reset } } });
  assert.equal((await observe(20)).status, 200);
  const settings = (await bridge.request('/api/settings/continuity')).body.settings;
  assert.equal(settings.usageProtection, true); assert.equal(settings.reservePercent, 5);
  assert.equal((await bridge.request('/api/settings/continuity', { reservePercent: 1 }, { method: 'PUT' })).status, 400);
  const created = await bridge.request('/api/continuity', { mode: 'managed', kind: 'claude', allowedProviders: ['claude', 'codex'],
    cwd: bridge.root, objective: 'Inspect project with a preserved handoff', checkpoint: { decisions: 'Keep public contracts stable', tests: 'Pending' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  await waitFor(() => completeJsonLines(bridge.events).some((e) => e.kind === 'claude' && e.type === 'started'));
  // Capture the durable handoff BEFORE the low-quota signal is injected, so this
  // proves the checkpoint pre-dated the quota drop rather than merely proving the
  // successor later wrote a (any) .md into the same directory.
  const runsDir = path.join(bridge.root, 'data', 'continuity', 'runs');
  const preHandoffFiles = await waitFor(() => {
    const files = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((n) => n.endsWith('.md')) : [];
    return files.length ? files : false;
  });
  assert.ok(preHandoffFiles.length, 'a durable checkpoint handoff must exist before quota drops toward reserve');
  await observe(97);
  const changed = await waitFor(async () => { const v = (await bridge.request('/api/continuity/'+id)).body; return v.owner.kind === 'codex' && v.tasks.length === 2 && v; }, 18000);
  await waitFor(() => completeJsonLines(bridge.events).some((e) => e.kind === 'codex' && e.type === 'started'));
  const events = completeJsonLines(bridge.events);
  assert.equal(events.filter((e) => e.kind === 'codex' && e.type === 'started').length, 1);
  // Windows does not deliver a real SIGTERM to the fixture child, so its own
  // 'stopping'/'finished' self-report never fires there. The physical order that
  // actually matters (predecessor durably settled before the successor started, and
  // a handoff existed first) is proven platform-neutrally from the queue's own
  // durable task settlement timestamps instead of the child's signal handler.
  const predecessorTaskId = changed.tasks.find((t) => t.kind === 'claude').taskId;
  const successorTaskId = changed.tasks.find((t) => t.kind === 'codex').taskId;
  const predecessorTask = (await bridge.request('/api/tasks/'+predecessorTaskId)).body;
  const successorTask = await waitFor(async () => { const v = (await bridge.request('/api/tasks/'+successorTaskId)).body; return v.startedAt != null && v; });
  // finishedAt alone can also represent cancellation intent; require the task's own
  // execution record to have actually settled (not merely reached a terminal status).
  assert.equal(predecessorTask.execution?.state, 'settled', 'predecessor coordinator task must durably settle');
  assert.ok(predecessorTask.execution?.settledAt, 'predecessor coordinator task must record a settlement timestamp');
  assert.ok(successorTask.startedAt >= predecessorTask.execution.settledAt, 'successor must not start before the predecessor physically settles');
  assert.ok(fs.existsSync(runsDir) && fs.readdirSync(runsDir).some((n) => n.endsWith('.md')),
    'a durable checkpoint handoff must exist by the time the predecessor settles');
  if (process.platform !== 'win32') {
    const stopped = events.find((e) => e.kind === 'claude' && e.type === 'finished');
    const successor = events.find((e) => e.kind === 'codex' && e.type === 'started');
    assert.ok(stopped && successor.at >= stopped.at);
    assert.equal(events.find((e) => e.type === 'stopping').handoffExists, true);
  }
  assert.match(fs.readFileSync(changed.handoffPath, 'utf8'), /Keep public contracts stable/);
  assert.equal(changed.epoch, 2);
  assert.deepEqual(events.filter((e) => e.type === 'rpc').map((e) => e.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  const refused = await bridge.request('/api/oneshot', { kind: 'claude', cwd: bridge.root, prompt: 'Must not start below reserve', dangerous: false, modelTier: 'standard', effort: 'medium' });
  assert.equal(refused.body.failureClass, 'quota_reserve', JSON.stringify(refused.body)); assert.equal(refused.body.model_invocation, false);
});
test('default MCP collection returns a recoverable pending handle and leaves the exact worker running', { timeout: 20000 }, async (t) => {
  const bridge = await fixture(t);
  const [{ Client }, { StdioClientTransport }] = await Promise.all([import('@modelcontextprotocol/client'), import('@modelcontextprotocol/client/stdio')]);
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp/server.mjs')], cwd: ROOT,
    env: { ...cleanEnv, NODE_ENV: 'test', RELAYBRIDGE_TEST_BUILD_ID: 'security-integration-fixture', RELAYBRIDGE_COLLECTION_MS: '150',
      RELAYBRIDGE_URL: bridge.base, RELAYBRIDGE_TOKEN_FILE: path.join(bridge.root,'token'), RELAYBRIDGE_DATA_DIR: path.join(bridge.root,'data'), RELAYBRIDGE_CONFIG_FILE: bridge.configPath }, stderr: 'pipe' });
  const client = new Client({ name: 'continuity-collection-test', version: '1' });
  t.after(async () => { await client.close(); await transport.close(); }); await client.connect(transport);
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  const value = await call('ask_provider', { kind: 'claude', cwd: bridge.root, prompt: 'RB_SLOW explain a cache', useCache: false });
  assert.equal(value.pending, true, JSON.stringify(value)); assert.equal(value.terminal, false); assert.ok(value.taskId);
  const task = await waitFor(async () => { const v = (await bridge.request('/api/tasks/'+value.taskId)).body; return v.status === 'done' && v; });
  assert.equal(task.body.timeoutMs, undefined);
  const result = await call('get_task_result', { id: value.taskId });
  assert.equal(result.resultState, 'persisted'); assert.equal(result.metadata.complete, true); assert.equal(result.result, 'Completed delayed answer.');
  assert.equal(completeJsonLines(bridge.events).filter((e) => e.kind === 'claude' && e.type === 'started').length, 1);
  // Exercise the actual MCP acquisition schemas and REST persistence without
  // starting another model: caller-known capabilities survive a lost response.
  await call('set_continuity_settings', { autoHandoff: false });
  await bridge.request('/api/usage/native', { kind: 'claude', rate_limits: { five_hour: {
    used_percentage: 20, resets_at: Math.floor(Date.now()/1000) + 3600 } } });
  const registration = { mode: 'external', kind: 'claude', cwd: bridge.root, objective: 'Continue from the verified result',
    allowedProviders: ['claude'], ownerToken: 'a'.repeat(64), model: 'fixture-model' };
  const source = await call('register_coordinator', registration);
  assert.ok(source.id, JSON.stringify(source));
  const repeated = await call('register_coordinator', registration); assert.equal(repeated.id, source.id); assert.equal(repeated.epoch, 1);
  await call('checkpoint_and_yield', { id: source.id, ownerToken: registration.ownerToken, epoch: 1,
    checkpoint: { completed: 'Exact worker result collected' }, releaseEvidence: 'All owned work physically settled' });
  const acquisition = { id: source.id, kind: 'claude', model: 'fixture-model', accountId: 'default', ownerToken: 'b'.repeat(64), expectedEpoch: 1 };
  const next = await call('resume_from_checkpoint', acquisition), retry = await call('resume_from_checkpoint', acquisition);
  assert.equal(next.epoch, 2, JSON.stringify(next)); assert.equal(retry.epoch, 2); assert.equal(retry.ownerToken, acquisition.ownerToken);
  assert.equal(retry.checkpoint.completed, 'Exact worker result collected');
  const projection = await call('get_coordinator', { id: source.id });
  assert.equal(projection.ownerToken, undefined); assert.equal(projection.lastAcquisition, undefined);
  assert.equal(completeJsonLines(bridge.events).filter((e) => e.kind === 'claude' && e.type === 'started').length, 1);
});

test('live settings revoke assessment immediately and revoked admission never launches a provider', { timeout: 20000 }, async (t) => {
  const bridge = await fixture(t);
  const pending = bridge.request('/api/oneshot', { kind: 'claude', cwd: bridge.root, prompt: 'RB_SLOW inspect this project', dangerous: false });
  const run = await waitFor(async () => (await bridge.request('/api/runs/active')).body.runs[0]);
  assert.equal(run.adaptive, true);
  const settings = await bridge.request('/api/settings/continuity', { assessorEnabled: false }, { method: 'PUT' });
  assert.equal(settings.status, 200);
  const active = (await bridge.request('/api/runs/active')).body.runs.find((r) => r.runId === run.runId);
  assert.equal(active.assessor.enabled, false); assert.equal(active.assessor.state, 'assessor_disabled');
  assert.equal(active.hardCapRemainingMs, null); assert.equal(active.adaptive, true);
  assert.equal((await pending).body.exitCode, 0);
  const refused = await bridge.request('/api/oneshot', { kind: 'claude', cwd: bridge.root, prompt: 'Do not launch',
    source: 'progress-assessor', requestId: 'queued:t_assess_revoked', dangerous: false });
  assert.equal(refused.body.failureClass, 'assessment_revoked', JSON.stringify(refused.body));
  assert.equal(refused.body.model_invocation, false);
  assert.equal(completeJsonLines(bridge.events).filter((e) => e.kind === 'claude' && e.type === 'started').length, 1);
});
