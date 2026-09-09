'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { startTestBridge, waitFor, completeJsonLines } = require('./helpers/temporary-bridge');

function controlledFixture(root) {
  const script = path.join(root, 'controlled.js');
  fs.writeFileSync(script, [
    "const fs=require('fs'); const [role,marker,release]=process.argv.slice(2);",
    "const event=(event)=>fs.appendFileSync(marker,JSON.stringify({role,event,pid:process.pid})+'\\n');",
    "event('started'); process.on('SIGTERM',()=>event('termination_requested'));",
    "const timer=setInterval(()=>{ if(fs.existsSync(release)){clearInterval(timer);event('finished');process.stdout.write('authenticated\\n');}},10);",
  ].join('\n'));
  return script;
}

test('shutdown reserves incomplete request bodies and rejects late probes and submissions', {timeout:15000}, async t => {
  let marker;
  const bridge = await startTestBridge(t, root => {
    marker = path.join(root,'invocations');
    const script = path.join(root,'probe.js');
    fs.writeFileSync(script, "require('fs').appendFileSync(process.argv[2],'invoked\\n');process.stdout.write('fixture')");
    return {fixture:{safe:[process.execPath],probe:[process.execPath,script,marker]}};
  });
  const request = http.request(bridge.base+'/api/tasks', {method:'POST',headers:{...bridge.headers,'Content-Length':'1000'}});
  request.on('error', () => {}); request.write('{');
  t.after(() => request.destroy());
  await new Promise(resolve => request.once('socket', socket => socket.connecting ? socket.once('connect',resolve) : resolve()));
  // The body parser must have received the partial upload before the census.
  await new Promise(resolve => setTimeout(resolve, 50));
  const busy = await bridge.request('/api/admin/shutdown', {});
  assert.equal(busy.status, 409); assert.ok(busy.body.busy.requests >= 1);
  request.destroy();
  let accepted;
  await waitFor(async () => { accepted = await bridge.request('/api/admin/shutdown', {}); return accepted.status === 200; });
  const results = await Promise.all([
    bridge.request('/api/diag'),
    bridge.request('/api/auth/status?refresh=1'),
    bridge.request('/api/tasks', {kind:'fixture',prompt:'never admitted'}),
    bridge.request('/api/oneshot', {kind:'fixture',prompt:'never admitted'}),
    bridge.request('/API/diag'),
    bridge.request('/API/sessions', {kind:'fixture'}),
    bridge.request('/Api/permissions', {fullPermissions:true}),
  ]);
  for (const result of results) {
    assert.equal(result.status,503); assert.equal(result.body.failureClass,'bridge_shutting_down');
    assert.equal(result.body.model_invocation,false); assert.equal(result.body.physical_attempt_count,0);
  }
  assert.equal(fs.existsSync(marker),false);
  assert.equal(fs.readdirSync(path.join(bridge.root,'data/tasks')).filter(name=>name.endsWith('.json')).length,0);
  await waitFor(() => bridge.proc.exitCode !== null);
});

test('a disconnected asynchronous handler remains busy until its work settles', {timeout:15000}, async t => {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'rb-handler-lifetime-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const marker = path.join(root,'started'), release = path.join(root,'release'), preload = path.join(root,'preload.cjs');
  fs.writeFileSync(preload, [
    "const fs=require('fs');",
    `require(${JSON.stringify(path.resolve(__dirname,'../lib/github-tracker.js'))}).listVersions = async () => {`,
    `fs.writeFileSync(${JSON.stringify(marker)},'started');`,
    `await new Promise(resolve=>{const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);resolve();}},10);});`,
    'return [];};',
  ].join('\n'));
  const bridge = await startTestBridge(t, () => ({}), {nodeArgs:['--require',preload]});
  const caller = new AbortController();
  const pending = bridge.request('/api/github/versions?repo=fixture', undefined, {signal:caller.signal});
  const rejected = assert.rejects(pending,{name:'AbortError'});
  await waitFor(() => fs.existsSync(marker)); caller.abort(); await rejected;
  const busy = await bridge.request('/api/admin/shutdown', {});
  assert.equal(busy.status,409); assert.equal(busy.body.busy.handlers,1);
  fs.writeFileSync(release,'finish');
  await waitFor(async () => (await bridge.request('/api/admin/shutdown',{})).status === 200);
  await waitFor(() => bridge.proc.exitCode !== null);
});

test('accepted post-response checkpoint work blocks normal shutdown until it settles', {timeout:15000}, async t => {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'rb-background-lifetime-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const marker = path.join(root,'started'), release = path.join(root,'release'), preload = path.join(root,'preload.cjs');
  fs.writeFileSync(preload, [
    "const fs=require('fs');",
    `require(${JSON.stringify(path.resolve(__dirname,'../lib/github-tracker.js'))}).trackRun = async () => {`,
    `fs.writeFileSync(${JSON.stringify(marker)},'started');`,
    `await new Promise(resolve=>{const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);resolve();}},10);});`,
    'return {tracked:false};};',
  ].join('\n'));
  const bridge = await startTestBridge(t, () => ({fixture:{safe:[process.execPath],
    oneshot_safe:[process.execPath,'-e',"process.stdout.write('Completed fixture answer.')"]}}), {nodeArgs:['--require',preload]});
  const result = await bridge.request('/api/oneshot',{kind:'fixture',prompt:'Answer the fixture.',dangerous:false});
  assert.equal(result.body.stdout,'Completed fixture answer.');
  await waitFor(() => fs.existsSync(marker));
  const busy = await bridge.request('/api/admin/shutdown',{});
  assert.equal(busy.status,409); assert.equal(busy.body.busy.background,1);
  fs.writeFileSync(release,'finish');
  await waitFor(async () => (await bridge.request('/api/admin/shutdown',{})).status === 200);
  await waitFor(() => bridge.proc.exitCode !== null);
});

test('disconnected remote MCP tool retains its callback reservation after HTTP closes', {timeout:15000}, async t => {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'rb-mcp-lifetime-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const marker = path.join(root,'started'), release = path.join(root,'release'), preload = path.join(root,'preload.cjs');
  fs.writeFileSync(preload, [
    "const fs=require('fs');",
    `const req=require('module').createRequire(${JSON.stringify(path.resolve(__dirname,'../package.json'))});`,
    "const remote=req('./lib/remote-mcp'), original=remote.mountRemoteMcp;",
    "remote.mountRemoteMcp=(app,opts)=>original(app,{...opts,buildServer:()=>{",
    "const server=new (req('@modelcontextprotocol/server').McpServer)({name:'fixture',version:'1'});",
    "server.registerTool('fixture_wait',{inputSchema:req('zod').z.object({})},async()=>{",
    `fs.writeFileSync(${JSON.stringify(marker)},'started');`,
    `await new Promise(resolve=>{const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);resolve();}},10);});`,
    "return {content:[{type:'text',text:'completed'}]};});return server;}});",
  ].join('\n'));
  const bridge = await startTestBridge(t, () => ({}), {nodeArgs:['--require',preload],env:{RELAYBRIDGE_REMOTE_MCP:'1'}});
  assert.equal((await bridge.request('/api/remote-mcp/status')).body.enabled,true);
  const headers = {...bridge.headers,Accept:'application/json, text/event-stream'};
  const init = await fetch(bridge.base+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fixture',version:'1'}}})});
  assert.equal(init.status,200); await init.text();
  if(init.headers.get('mcp-session-id')) headers['mcp-session-id']=init.headers.get('mcp-session-id');
  const caller = new AbortController();
  const pending = fetch(bridge.base+'/mcp',{method:'POST',headers,signal:caller.signal,
    body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'fixture_wait',arguments:{}}})}).then(response=>response.text());
  const rejected = assert.rejects(pending,{name:'AbortError'});
  await waitFor(()=>fs.existsSync(marker)); caller.abort(); await rejected;
  const busy = await bridge.request('/api/admin/shutdown',{});
  assert.equal(busy.status,409); assert.ok(busy.body.busy.handlers >= 1);
  fs.writeFileSync(release,'finish');
  await waitFor(async () => (await bridge.request('/api/admin/shutdown',{})).status === 200);
  await waitFor(() => bridge.proc.exitCode !== null);
});

test('concurrent diagnostic callers share one physical probe; one subscriber cancellation does not kill it', { timeout: 30000 }, async (t) => {
  let marker, release;
  const bridge = await startTestBridge(t, (root) => {
    marker = path.join(root, 'events.jsonl'); release = path.join(root, 'release');
    return { fixture: { label: 'fixture', safe: [process.execPath],
      probe: [process.execPath, controlledFixture(root), 'probe', marker, release] } };
  });
  const cancelled = new AbortController();
  const first = bridge.request('/api/diag', undefined, { signal: cancelled.signal });
  const firstRejected = assert.rejects(first, { name: 'AbortError' });
  const second = bridge.request('/api/diag');
  await waitFor(() => completeJsonLines(marker).some((event) => event.event === 'started'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  cancelled.abort(); await firstRejected;
  assert.equal(completeJsonLines(marker).filter((event) => event.event === 'started').length, 1);
  assert.equal(completeJsonLines(marker).some((event) => event.event === 'termination_requested'), false);
  fs.writeFileSync(release, 'finish');
  const response = await second;
  assert.equal(response.status, 200);
  assert.equal(response.body.results.fixture.ready, true);
});

test('last diagnostic cancellation retains draining-key admission until the physical child closes', {
  skip: process.platform === 'win32', timeout: 30000,
}, async (t) => {
  let marker, release;
  const bridge = await startTestBridge(t, (root) => {
    marker = path.join(root, 'events.jsonl'); release = path.join(root, 'release');
    return { fixture: { label: 'fixture', safe: [process.execPath],
      probe: [process.execPath, controlledFixture(root), 'probe', marker, release] } };
  });
  const caller = new AbortController();
  const pending = bridge.request('/api/diag', undefined, { signal: caller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await waitFor(() => completeJsonLines(marker).some((event) => event.event === 'started'));
  caller.abort(); await rejected;
  await waitFor(() => completeJsonLines(marker).some((event) => event.event === 'termination_requested'));
  const draining = await bridge.request('/api/diag');
  assert.equal(draining.body.results.fixture.ready, false);
  assert.equal(draining.body.results.fixture.authFailed, false);
  assert.equal(draining.body.results.fixture.authAuthoritative, false);
  assert.equal(draining.body.results.fixture.transientProbeFailure, true);
  assert.equal(completeJsonLines(marker).filter((event) => event.event === 'started').length, 1);
  fs.writeFileSync(release, 'finish');
  await waitFor(() => completeJsonLines(marker).some((event) => event.event === 'finished'));
  await waitFor(async () => (await bridge.request('/api/diag')).body.results.fixture.ready === true);
  assert.equal(completeJsonLines(marker).filter((event) => event.event === 'started').length, 2);
});

test('installer has exclusive physical admission and recovers after completion', { timeout: 30000 }, async (t) => {
  let marker, release;
  const bridge = await startTestBridge(t, (root) => {
    marker = path.join(root, 'events.jsonl'); release = path.join(root, 'release');
    return { fixture: { label: 'fixture', install_command: [process.execPath, controlledFixture(root), 'install', marker, release] } };
  });
  const first = bridge.request('/api/install', { kind: 'fixture' });
  await waitFor(() => completeJsonLines(marker).some((event) => event.event === 'started'));
  const excess = await bridge.request('/api/install', { kind: 'fixture' });
  assert.equal(excess.status, 429);
  assert.equal(excess.body.validation.code, 'operation_admission_limit');
  assert.equal(excess.body.physical_attempt_count, 0);
  assert.equal(excess.body.model_invocation, false);
  assert.equal(completeJsonLines(marker).filter((event) => event.event === 'started').length, 1);
  fs.writeFileSync(release, 'finish');
  assert.equal((await first).body.success, true);
  assert.equal((await bridge.request('/api/install', { kind: 'fixture' })).body.success, true);
  assert.equal(completeJsonLines(marker).filter((event) => event.event === 'started').length, 2);
});

test('rate limits follow authentication, bound account mutations, and validate advice before expensive work', { timeout: 30000 }, async (t) => {
  const bridge = await startTestBridge(t, () => ({ fixture: { label: 'fixture', credential_env: 'FIXTURE_CONFIG_DIR' } }));
  for (let n = 0; n < 65; n++) {
    const denied = await bridge.request('/api/accounts/fixture', { id: 'invalid/id' }, { headers: { 'Content-Type': 'application/json', 'X-RelayBridge-Token': 'wrong' } });
    assert.equal(denied.status, 401);
  }
  assert.equal((await bridge.request('/api/accounts/fixture', { id: 'team' })).status, 200);
  const registryPath = path.join(bridge.root, 'data', 'accounts.json');
  const before = fs.readFileSync(registryPath);
  for (let n = 0; n < 59; n++) assert.equal((await bridge.request('/api/accounts/fixture', { id: 'invalid/id' })).status, 400);
  const limited = await bridge.request('/api/accounts/fixture', { id: 'must-not-exist' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.validation.code, 'operation_rate_limit');
  assert.deepEqual(fs.readFileSync(registryPath), before);
  assert.equal(fs.existsSync(path.join(bridge.root, 'data', 'accounts', 'fixture', 'must-not-exist')), false);
  for (const candidates of [{}, new Array(65).fill('fixture'), ['constructor']]) {
    const invalid = await bridge.request('/api/usage/advise', { candidates });
    assert.equal(invalid.status, 400); assert.equal(invalid.body.validation.code, 'invalid_candidates');
  }
});

test('incomplete auth output cannot quarantine a cold default or erase prior authoritative signed-out evidence', { timeout: 30000 }, async (t) => {
  let mode, marker;
  const bridge = await startTestBridge(t, (root) => {
    mode = path.join(root, 'complete-failure'); marker = path.join(root, 'probe-events');
    const script = path.join(root, 'auth-probe.js');
    fs.writeFileSync(script, [
      "const fs=require('fs');",
      `fs.appendFileSync(${JSON.stringify(marker)},'started\\n');`,
      "process.stdout.write('not logged in\\n');",
      `if(fs.existsSync(${JSON.stringify(mode)})) process.exitCode=1; else setInterval(()=>{},1000);`,
    ].join('\n'));
    return { fixture: { label: 'fixture', credential_env: 'FIXTURE_AUTH_CONFIG',
      safe: [process.execPath], login_command: [process.execPath, '-e', 'process.exit(0)'],
      probe: [process.execPath, script], probe_timeout_ms: 750, probe_auth_authoritative: true,
      oneshot_safe: [process.execPath, '-e', "process.stdout.write('fixture answer')"] } };
  });
  const cold = await bridge.request('/api/auth/status?refresh=1');
  assert.equal(cold.status, 200); assert.equal(cold.body.signedOutCount, 0);
  assert.ok(fs.readFileSync(marker, 'utf8').includes('started'));
  const diag = await bridge.request('/api/diag');
  assert.equal(diag.body.results.fixture.ready, false);
  assert.equal(diag.body.results.fixture.authAuthoritative, false);
  assert.equal(diag.body.results.fixture.authFailed, false);
  const dispatch = await bridge.request('/api/oneshot', { kind: 'fixture', prompt: 'say hello', dangerous: false });
  assert.equal(dispatch.status, 200, JSON.stringify(dispatch.body));
  assert.equal(dispatch.body.stdout, 'fixture answer');
  fs.writeFileSync(mode, 'complete');
  const definitive = await bridge.request('/api/auth/status?refresh=1');
  assert.equal(definitive.body.signedOutCount, 1);
  const registryPath = path.join(bridge.root, 'data', 'accounts.json');
  const bytes = fs.readFileSync(registryPath);
  fs.unlinkSync(mode);
  const transient = await bridge.request('/api/auth/status?refresh=1');
  assert.equal(transient.body.signedOutCount, 1);
  assert.deepEqual(fs.readFileSync(registryPath), bytes, 'timeout cannot renew or clear auth authority');
});

test('auth refresh and diagnostics agree on expected and rejected exit-zero probe output', {timeout:30000}, async t => {
  let mode;
  const bridge = await startTestBridge(t, root => {
    mode = path.join(root, 'probe-output'); fs.writeFileSync(mode, 'Not logged in');
    const script = path.join(root, 'probe.js');
    fs.writeFileSync(script, "process.stdout.write(require('fs').readFileSync(process.argv[2],'utf8'))");
    return {fixture:{label:'fixture', credential_env:'FIXTURE_AUTH_CONFIG', safe:[process.execPath],
      probe:[process.execPath,script,mode], probe_expect:'Logged in as', probe_reject:['not logged in'],
      probe_auth_authoritative:true, probe_success_detail:'authenticated fixture'}};
  });
  const account = () => JSON.parse(fs.readFileSync(path.join(bridge.root,'data/accounts.json')))
    .providers.fixture.accounts.find(item => item.id === 'default');
  for (const output of ['Not logged in', 'Logged in as fixture\nNot logged in']) {
    fs.writeFileSync(mode, output);
    const auth = (await bridge.request('/api/auth/status?refresh=1')).body;
    assert.equal(auth.signedOutCount, 1);
    assert.ok(account().authFailureMarker, 'exit-zero rejection must preserve authentication quarantine');
    const diag = (await bridge.request('/api/diag')).body.results.fixture;
    assert.equal(diag.ready, false); assert.equal(diag.authFailed, true); assert.equal(diag.authAuthoritative, true);
  }
  fs.writeFileSync(mode, 'Fixture version only');
  await bridge.request('/api/auth/status?refresh=1');
  assert.ok(account().authFailureMarker, 'a missing expected string cannot clear authentication quarantine');
  assert.equal((await bridge.request('/api/diag')).body.results.fixture.ready, false);
  fs.writeFileSync(mode, 'Logged in as fixture');
  assert.equal((await bridge.request('/api/auth/status?refresh=1')).body.signedOutCount, 0);
  assert.equal(account().authFailureMarker, undefined);
  const ready = (await bridge.request('/api/diag')).body.results.fixture;
  assert.equal(ready.ready, true); assert.equal(ready.authFailed, false);
});

test('old in-flight diagnostics cannot publish readiness after an operator auth-retry mutation', { timeout: 30000 }, async (t) => {
  let marker, release;
  const bridge = await startTestBridge(t, (root) => {
    marker = path.join(root, 'events.jsonl'); release = path.join(root, 'release');
    return { fixture: { label: 'fixture', credential_env: 'FIXTURE_AUTH_CONFIG', safe: [process.execPath],
      probe: [process.execPath, controlledFixture(root), 'probe', marker, release], probe_auth_authoritative: true } };
  });
  const old = bridge.request('/api/diag');
  await waitFor(() => completeJsonLines(marker).some((event) => event.event === 'started'));
  assert.equal((await bridge.request('/api/accounts/fixture/default/auth/retry', { retry: true })).status, 200);
  fs.writeFileSync(release, 'finish');
  const stale = await old;
  assert.equal(stale.status, 409); assert.equal(stale.body.errorCode, 'diagnostic_stale');
  const current = await bridge.request('/api/diag');
  assert.equal(current.status, 200); assert.equal(current.body.results.fixture.ready, true);
});

test('installer disconnect does not release its exclusive slot before child cleanup', {
  skip: process.platform === 'win32', timeout: 30000,
}, async (t) => {
  let marker, release;
  const bridge = await startTestBridge(t, (root) => {
    marker = path.join(root, 'events.jsonl'); release = path.join(root, 'release');
    return { fixture: { label: 'fixture', install_command: [process.execPath, controlledFixture(root), 'install', marker, release] } };
  });
  const caller = new AbortController();
  const first = bridge.request('/api/install', { kind: 'fixture' }, { signal: caller.signal });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await waitFor(() => completeJsonLines(marker).some((event) => event.event === 'started'));
  caller.abort(); await rejected;
  await waitFor(() => completeJsonLines(marker).some((event) => event.event === 'termination_requested'));
  const excess = await bridge.request('/api/install', { kind: 'fixture' });
  assert.equal(excess.status, 429); assert.equal(excess.body.validation.code, 'operation_admission_limit');
  assert.equal(completeJsonLines(marker).filter((event) => event.event === 'started').length, 1);
  fs.writeFileSync(release, 'finish');
  await waitFor(() => completeJsonLines(marker).some((event) => event.event === 'finished'));
  await waitFor(async () => (await bridge.request('/api/install', { kind: 'fixture' })).body.success === true);
});

test('four live host commands reject a fifth and keep a disconnected child slot until close', {
  skip: process.platform === 'win32', timeout: 30000,
}, async (t) => {
  let marker, release, script;
  const bridge = await startTestBridge(t, (root) => {
    marker = path.join(root, 'events.jsonl'); release = path.join(root, 'release'); script = controlledFixture(root);
    return {};
  });
  const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
  const command = 'exec ' + [process.execPath, script, 'exec', marker, release].map(quote).join(' ');
  const caller = new AbortController();
  const first = bridge.request('/api/exec', { command, shell: 'sh' }, { signal: caller.signal });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  const others = Array.from({ length: 3 }, () => bridge.request('/api/exec', { command, shell: 'sh' }));
  await waitFor(() => completeJsonLines(marker).filter((event) => event.event === 'started').length === 4);
  const excess = await bridge.request('/api/exec', { command, shell: 'sh' });
  assert.equal(excess.status, 429); assert.equal(excess.body.physical_attempt_count, 0);
  caller.abort(); await rejected;
  await waitFor(() => completeJsonLines(marker).some((event) => event.event === 'termination_requested'));
  assert.equal((await bridge.request('/api/exec', { command, shell: 'sh' })).status, 429);
  fs.writeFileSync(release, 'finish');
  for (const result of await Promise.all(others)) assert.equal(result.body.exitCode, 0);
  await waitFor(async () => (await bridge.request('/api/exec', { command, shell: 'sh' })).body.exitCode === 0);
});
