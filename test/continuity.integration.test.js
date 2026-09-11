'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { startTestBridge, waitFor, completeJsonLines } = require('./helpers/temporary-bridge');
const ROOT = path.resolve(__dirname, '..');
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
  }, { env: { RELAYBRIDGE_WARM_DIAG: '0', RELAYBRIDGE_REMOTE_MCP: '0' } });
  return { ...bridge, events };
}
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
  await observe(97);
  const changed = await waitFor(async () => { const v = (await bridge.request('/api/continuity/'+id)).body; return v.owner.kind === 'codex' && v.tasks.length === 2 && v; }, 18000);
  await waitFor(() => completeJsonLines(bridge.events).some((e) => e.kind === 'codex' && e.type === 'started'));
  const events = completeJsonLines(bridge.events), stopped = events.find((e) => e.kind === 'claude' && e.type === 'finished');
  const successor = events.find((e) => e.kind === 'codex' && e.type === 'started');
  assert.ok(stopped && successor.at >= stopped.at);
  assert.equal(events.filter((e) => e.kind === 'codex' && e.type === 'started').length, 1);
  assert.equal(events.find((e) => e.type === 'stopping').handoffExists, true);
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
    env: { ...process.env, NODE_ENV: 'test', RELAYBRIDGE_TEST_BUILD_ID: 'security-integration-fixture', RELAYBRIDGE_COLLECTION_MS: '150',
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
});
