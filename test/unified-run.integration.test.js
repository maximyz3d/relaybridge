'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { startTestBridge, fixtureEnv, waitFor, completeJsonLines } = require('./helpers/temporary-bridge');
const { isolatedEnv } = require('./helpers/isolated-env');
const { CREDIT_SECRET_NAMES } = require('../lib/allocated-credit');
const ROOT = path.resolve(__dirname, '..');
// Unified runs are created only where the directory barrier is enforced.
const linuxOnly = { skip: process.platform !== 'linux' && 'unified run durability is Linux-only' };

// Offline provider fixture. Every invocation is recorded; a prompt containing
// EDIT appends to the workspace file, and HOLD keeps the writer alive until a
// release file appears (bounded, so an orphan cannot outlive the test).
function fixtureConfig(root) {
  const events = path.join(root, 'events.jsonl');
  const script = path.join(root, 'fixture.js');
  fs.writeFileSync(script, `const fs=require('fs'),path=require('path');const prompt=process.argv[process.argv.length-1]||'';
    const kind=process.argv[2];fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({kind,cwd:process.cwd(),pid:process.pid,hold:prompt.includes('HOLD')})+'\\n');
    if(prompt.includes('EDIT'))fs.appendFileSync(path.join(process.cwd(),'a.txt'),'edited by '+kind+'\\n');
    if(prompt.includes('HOLD')){const release=path.join(${JSON.stringify(root)},'release'),until=Date.now()+8000;
      const timer=setInterval(()=>{if(fs.existsSync(release)||Date.now()>until){clearInterval(timer);console.log('held answer');}},50);}
    else console.log('fixture answer from '+kind);`);
  const entry = (kind) => {
    const slot = [process.execPath, script, kind, '--model', 'fixture', '--effort', 'medium', '{prompt}'];
    return { label: `Offline ${kind} fixture`, safe: slot, dangerous: slot, oneshot_safe: slot, oneshot_dangerous: slot,
      capabilities: ['prompt'], oneshot_safe_filesystem_policy: 'read_only_enforced',
      oneshot_capabilities: { safe: ['model_invocation', 'workspace_read', 'tool_use'],
        dangerous: ['model_invocation', 'workspace_read', 'workspace_write', 'tool_use'] },
      cost_class: 'subscription', model: 'fixture' };
  };
  return { _models: { discoverOnBoot: false }, claude: entry('claude'), codex: entry('codex'), claude_fable: entry('claude_fable') };
}

async function bridgeFixture(t, options = {}) {
  let ws;
  const bridge = await startTestBridge(t, (root) => {
    ws = path.join(root, 'ws'); fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: ws, env: isolatedEnv() });
    fs.writeFileSync(path.join(ws, 'a.txt'), 'start\n');
    const config = fixtureConfig(root);
    if (options.registry) {
      fs.mkdirSync(path.join(root, 'data'), { recursive: true });
      fs.writeFileSync(path.join(root, 'data', 'accounts.json'), JSON.stringify({ providers: options.registry }));
      for (const [kind, row] of Object.entries(options.registry)) for (const account of row.accounts) {
        if (account.id === 'default') continue;
        const dir = path.join(root, 'data', 'accounts', kind, account.id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '.credentials.json'), '{"fake":true}');
      }
      config.claude.credential_env = 'FIXTURE_ACCOUNT_DIR';
      config.claude.credential_markers = ['.credentials.json'];
    }
    return config;
  }, { env: { RELAYBRIDGE_WARM_DIAG: '0', RELAYBRIDGE_REMOTE_MCP: '0', ...(options.env || {}) } });
  const events = () => completeJsonLines(path.join(bridge.root, 'events.jsonl'));
  const usage = async (kind, used, accountId = 'default') => {
    const reset = Math.floor(Date.now() / 1000) + 18000;
    const result = await bridge.request('/api/usage/native', { kind, accountId, rate_limits: {
      five_hour: { used_percentage: used, resets_at: reset }, seven_day: { used_percentage: used, resets_at: reset + 604800 } } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  };
  const runsDir = path.join(bridge.root, 'data', 'unified-runs');
  const runDirs = () => (fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((name) => name.startsWith('ur_')) : []);
  const settle = (id, request = bridge.request) => waitFor(async () => {
    const view = await request(`/api/unified-runs/${id}`);
    return !['running'].includes(view.body.state) && view;
  }, 20000);
  return { ...bridge, ws, events, usage, runDirs, settle };
}

// Stops the bridge and starts a new server process on the same store and
// isolated environment; returns an authenticated request helper for it.
async function restartBridge(t, bridge, signal) {
  bridge.proc.kill(signal);
  await new Promise((resolve) => bridge.proc.exitCode !== null || bridge.proc.signalCode !== null ? resolve() : bridge.proc.once('exit', resolve));
  const port = await new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  const nativeHome = path.join(bridge.root, 'native-home');
  const env = fixtureEnv(bridge.root, port, bridge.configPath, nativeHome, { RELAYBRIDGE_WARM_DIAG: '0', RELAYBRIDGE_REMOTE_MCP: '0' });
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill(); await new Promise((resolve) => proc.once('exit', resolve));
    }
  });
  await waitFor(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } }, 15000);
  const token = (await (await fetch(`${base}/api/capability`)).json()).token;
  const request = async (route, body) => {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-RelayBridge-Token': token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { proc, base, request };
}

const nativeSegment = (patch = {}) => ({ kind: 'claude', accountId: 'default', transport: 'native', model: 'fixture', effort: 'low', ...patch });
const writer = (bridge, patch = {}) => ({ objective: 'EDIT a.txt', cwd: bridge.ws, dangerous: true, acknowledgeFilesystemWrites: true,
  advisoryFileScope: ['a.txt'], segments: [nativeSegment()], ...patch });

test('default native writer run edits the workspace with no funding envelope, registry or profile store', linuxOnly, async (t) => {
  const bridge = await bridgeFixture(t);
  await bridge.usage('claude', 10);
  const data = path.join(bridge.root, 'data');
  const stores = ['accounts.json', 'accounts.initialized', 'funding-profiles', 'funding-profiles.initialized'];
  for (const name of stores) assert.equal(fs.existsSync(path.join(data, name)), false, `${name} exists before the run`);

  assert.equal((await fetch(`${bridge.base}/api/unified-runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(writer(bridge)) })).status, 401);

  const created = await bridge.request('/api/unified-runs', writer(bridge));
  assert.equal(created.status, 202, JSON.stringify(created.body));
  assert.equal(created.body.writeBoundary, 'advisory_unenforced');
  const done = await bridge.settle(created.body.id);
  assert.equal(done.body.state, 'complete', JSON.stringify(done.body));
  assert.equal(done.body.writeBoundary, 'advisory_unenforced');
  const [segment] = done.body.segments;
  assert.equal(segment.accountId, 'default'); assert.equal(segment.quotaSeat, 'claude');
  assert.equal(segment.model, 'fixture'); assert.equal(segment.effort, 'low'); assert.equal(segment.transport, 'native');
  assert.equal(done.body.writer_diff_summary.changedFileCount, 1);
  assert.deepEqual(done.body.writer_diff_summary.files.map((file) => file.path), ['a.txt']);
  assert.match(fs.readFileSync(path.join(bridge.ws, 'a.txt'), 'utf8'), /edited by claude/);
  assert.equal(bridge.events().length, 1);

  // The admitted queue body binds the exact account and seat and carries no funding property.
  const task = (await bridge.request(`/api/tasks/${segment.taskId}`)).body;
  const body = task.body || task.input || task;
  assert.equal(Object.hasOwn(body, 'funding'), false, JSON.stringify(body));
  assert.equal(body.expectedAccountId, 'default'); assert.equal(body.expectedQuotaSeat, 'claude');
  assert.equal(body.requireFreshUsage, true); assert.equal(body.dangerous, true);
  for (const name of stores) assert.equal(fs.existsSync(path.join(data, name)), false, `${name} was created by a default run`);

  // Terminal resume: no submit and no model call.
  const resumed = await bridge.request(`/api/unified-runs/${created.body.id}/resume`, {});
  assert.equal(resumed.status, 200); assert.equal(resumed.body.state, 'complete'); assert.equal(resumed.body.segments.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(bridge.events().length, 1);
  assert.equal(JSON.stringify(done.body).match(/"(signature|thinking|redacted_thinking|encrypted_content|reasoning_item_ids?)"/), null);

  // CLI and MCP read the same record.
  const cliEnv = isolatedEnv({ RELAYBRIDGE_URL: bridge.base, RELAYBRIDGE_TOKEN: bridge.headers['X-RelayBridge-Token'],
    NODE_ENV: 'test', RELAYBRIDGE_TEST_BUILD_ID: 'security-integration-fixture', RELAYBRIDGE_DATA_DIR: data,
    RELAYBRIDGE_CONFIG_FILE: bridge.configPath, RELAYBRIDGE_TOKEN_FILE: path.join(bridge.root, 'token') });
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin/relaybridge.js'), ...args], { encoding: 'utf8', env: cliEnv, cwd: bridge.root });
  const cliStatus = cli('unified', 'status', created.body.id);
  assert.equal(cliStatus.status, 0, cliStatus.stderr);
  assert.equal(JSON.parse(cliStatus.stdout).state, 'complete');

  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const client = new Client({ name: 'unified-fixture', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp/server.mjs')], env: cliEnv, stderr: 'pipe' }));
  try {
    const call = (name, args) => client.callTool({ name, arguments: args });
    const status = await call('unified_run_status', { runId: created.body.id });
    assert.equal(status.structuredContent.state, 'complete', JSON.stringify(status));
    assert.deepEqual(status.structuredContent.segments, (await bridge.request(`/api/unified-runs/${created.body.id}`)).body.segments);

    // Same validation result over HTTP, CLI and MCP, with no call and no run record.
    const requestFile = path.join(bridge.root, 'request.json');
    for (const [patch, code, status] of [
      [{ allowedWritePaths: ['a.txt'] }, null, null],
      [{ acknowledgeFilesystemWrites: undefined }, 'filesystem_acknowledgement_required', 400],
      [{ segments: [nativeSegment({ accountId: undefined })] }, 'account_binding_required', 400],
      [{ segments: [nativeSegment({ accountId: null })] }, 'account_binding_required', 400],
      [{ unifiedRun: { id: 'ur_0', segment: 1 } }, 'invalid_funding_envelope', 400],
      [{ reserveRelease: { reserveReleaseEvidence: true } }, 'invalid_funding_envelope', 400],
      [{ funding: { route: 'subscription', fallback: 'none' } }, 'funding_envelope_unsupported', 400],
      [{ constraints: undefined, segments: [{ ...nativeSegment(), thinking: 'x' }] }, null, 400],
    ]) {
      const input = JSON.parse(JSON.stringify(writer(bridge, patch)));
      const http = await bridge.request('/api/unified-runs', input);
      if (status) assert.equal(http.status, status, JSON.stringify(http.body));
      else assert.ok([400, 409].includes(http.status), JSON.stringify(http.body));
      if (code) assert.equal(http.body.errorCode, code);
      if (patch.allowedWritePaths) assert.ok(['filesystem_contract_unsupported', 'invalid_write_contract'].includes(http.body.errorCode), JSON.stringify(http.body));
      assert.equal(http.body.model_invocation, false);
      fs.writeFileSync(requestFile, JSON.stringify(input));
      const viaCli = cli('unified', 'run', '--file', requestFile);
      assert.notEqual(viaCli.status, 0); assert.match(viaCli.stderr, new RegExp(http.body.errorCode));
      const viaMcp = await call('unified_run_create', input);
      assert.ok(viaMcp.isError, JSON.stringify(viaMcp));
      assert.match(JSON.stringify(viaMcp), new RegExp(http.body.errorCode));
    }
    assert.equal(bridge.runDirs().length, 1);
    assert.equal(bridge.events().length, 1);
  } finally { await client.close(); }

  // Internal fields are refused on every public submit surface.
  for (const route of ['/api/oneshot', '/api/tasks']) {
    for (const field of ['unifiedRun', 'reserveRelease']) {
      const refused = await bridge.request(route, { kind: 'claude', prompt: 'hello', cwd: bridge.ws, [field]: { id: 'x' } });
      assert.equal(refused.status, 400, `${route} ${field} ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.model_invocation, false);
    }
  }
  assert.equal(bridge.events().length, 1);
});

test('default account disabled, tombstoned or unlisted is refused before any submit', linuxOnly, async (t) => {
  const bridge = await bridgeFixture(t);
  await bridge.usage('claude', 10);
  const registry = path.join(bridge.root, 'data', 'accounts.json');
  for (const [name, providers, accountId] of [
    ['disabled default', { claude: { accounts: [{ id: 'default', enabled: false }] } }, 'default'],
    ['tombstone', { claude: { accounts: [] } }, 'default'],
    ['unlisted account', null, 'other'],
  ]) {
    if (providers) fs.writeFileSync(registry, JSON.stringify({ providers }));
    else fs.rmSync(registry, { force: true });
    const refused = await bridge.request('/api/unified-runs', writer(bridge, { segments: [nativeSegment({ accountId })] }));
    assert.equal(refused.status >= 400, true, name);
    assert.equal(refused.body.errorCode, 'account_binding_required', `${name}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.model_invocation, false);
  }
  assert.equal(bridge.runDirs().length, 0);
  assert.equal(bridge.events().length, 0);
  assert.equal(fs.existsSync(path.join(bridge.root, 'data', 'tasks')) ? fs.readdirSync(path.join(bridge.root, 'data', 'tasks'))
    .filter((name) => name.startsWith('t_ur_')).length : 0, 0);
});

test('a protected listed account hands off to the next listed account; stale capacity waits; unlisted is never used', linuxOnly, async (t) => {
  const bridge = await bridgeFixture(t, { registry: { claude: { accounts: [{ id: 'default' }, { id: 'work' }, { id: 'spare' }] } } });
  await bridge.usage('claude', 99, 'default');
  await bridge.usage('claude', 5, 'spare');
  const plain = { objective: 'Summarize the project', cwd: bridge.ws,
    segments: [nativeSegment(), nativeSegment({ accountId: 'work', model: 'fixture', effort: 'high' })] };
  const stale = await bridge.request('/api/unified-runs', plain);
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.errorCode, 'waiting_for_quota');
  assert.equal(bridge.runDirs().length, 0);
  assert.equal(bridge.events().length, 0);

  await bridge.usage('claude', 10, 'work');
  const created = await bridge.request('/api/unified-runs', plain);
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const done = await bridge.settle(created.body.id);
  assert.equal(done.body.state, 'complete', JSON.stringify(done.body));
  const [segment] = done.body.segments;
  assert.equal(segment.kind, 'claude'); assert.equal(segment.accountId, 'work');
  assert.notEqual(segment.quotaSeat, 'claude');
  assert.equal(segment.model, 'fixture'); assert.equal(segment.effort, 'high');
  assert.match(segment.handoffDigest, /^[a-f0-9]{64}$/);
  assert.equal(bridge.events().length, 1);
  const task = (await bridge.request(`/api/tasks/${segment.taskId}`)).body;
  assert.equal(task.body.expectedAccountId, 'work'); assert.equal(task.body.expectedQuotaSeat, segment.quotaSeat);
});

test('API segments are fail-closed without verified grant-only funding', linuxOnly, async (t) => {
  let requests = 0;
  const endpoint = http.createServer((_req, res) => { requests++; res.end('{}'); });
  await new Promise((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => endpoint.close(resolve)));
  const sentinel = 'sk-fixture-secret-must-never-appear';
  const bridge = await bridgeFixture(t, { env: { RELAYBRIDGE_ANTHROPIC_CREDIT_API_KEY: sentinel,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${endpoint.address().port}` } });
  await bridge.usage('claude', 99);
  const profile = { id: 'grant', provider: 'claude', label: 'grant', subscription: { kind: 'claude', accountId: 'default' },
    organization: { ref: 'org_grant', label: 'Fixture org' }, project: { ref: 'project_grant', label: 'Fixture project' },
    credentialRef: { type: 'reserved_env', name: CREDIT_SECRET_NAMES[0] },
    creditPeriod: { start: '2020-01-01T00:00:00.000Z', end: '2099-01-01T00:00:00.000Z' } };
  const saved = await bridge.request('/api/funding-profiles', { profile, expectedRevision: 0 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const revision = saved.body.profiles?.find?.((p) => p.id === 'grant')?.revision ?? 1;
  const api = { kind: 'claude', accountId: 'default', transport: 'api', model: 'claude-opus-5-5', effort: 'high',
    fundingProfileId: 'grant', expectedProfileRevision: revision };
  const blocked = await bridge.request('/api/unified-runs', { objective: 'Review only', cwd: bridge.ws, segments: [nativeSegment(), api] });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.errorCode, 'grant_only_funding_unverified');
  const writerApi = await bridge.request('/api/unified-runs', writer(bridge, { segments: [nativeSegment(), api] }));
  assert.equal(writerApi.body.errorCode, 'api_write_unavailable', JSON.stringify(writerApi.body));
  const unmapped = await bridge.request('/api/unified-runs', { objective: 'Review only', cwd: bridge.ws,
    segments: [{ ...api, model: 'opus' }] });
  assert.equal(unmapped.status, 400, JSON.stringify(unmapped.body));
  assert.equal(unmapped.body.errorCode, 'api_model_unmapped');
  assert.equal(JSON.stringify([blocked.body, writerApi.body, unmapped.body]).includes(sentinel), false);
  assert.equal(requests, 0); assert.equal(bridge.events().length, 0); assert.equal(bridge.runDirs().length, 0);
});

test('writer holds exclude overlapping writers, corrupt locks hold, and a killed bridge leaves the writer uncertain', { ...linuxOnly, timeout: 60000 }, async (t) => {
  const bridge = await bridgeFixture(t);
  const pids = [];
  t.after(() => { for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch {} });
  await bridge.usage('claude', 10);

  // Plain + plain still runs alongside each other.
  const plain = await bridge.request('/api/unified-runs', { objective: 'Read only', cwd: bridge.ws, segments: [nativeSegment()] });
  assert.equal(plain.status, 202, JSON.stringify(plain.body));
  const plainShot = await bridge.request('/api/oneshot', { kind: 'claude', prompt: 'Read only', cwd: bridge.ws, dangerous: false, effort: 'low' });
  assert.equal(plainShot.status, 200, JSON.stringify(plainShot.body));
  assert.equal((await bridge.settle(plain.body.id)).body.state, 'complete');

  // A corrupt workflow writer lock holds every workspace.
  const locks = path.join(bridge.root, 'data', 'writer-locks'); fs.mkdirSync(locks, { recursive: true });
  fs.writeFileSync(path.join(locks, 'corrupt.json'), '{');
  const locked = await bridge.request('/api/unified-runs', writer(bridge));
  assert.equal(locked.status, 409, JSON.stringify(locked.body)); assert.equal(locked.body.errorCode, 'workspace_writer_busy');
  assert.equal(locked.body.holder.holder, 'workflow_writer_lock');
  fs.rmSync(path.join(locks, 'corrupt.json'));

  const before = bridge.events().length;
  const held = await bridge.request('/api/unified-runs', writer(bridge, { objective: 'EDIT HOLD a.txt' }));
  assert.equal(held.status, 202, JSON.stringify(held.body));
  await waitFor(() => bridge.events().some((event) => event.hold));
  pids.push(...bridge.events().map((event) => event.pid));
  for (const [name, request] of [
    ['child one-shot', () => bridge.request('/api/oneshot', { kind: 'claude', prompt: 'EDIT', cwd: path.join(bridge.ws, 'sub'), dangerous: true, acknowledgeFilesystemWrites: true, effort: 'low' })],
    ['parent unified run', () => bridge.request('/api/unified-runs', writer(bridge, { cwd: bridge.root, segments: [nativeSegment()] }))],
    ['child unified run', () => bridge.request('/api/unified-runs', writer(bridge, { cwd: path.join(bridge.ws, 'sub'), segments: [nativeSegment()] }))],
  ]) {
    const refused = await request();
    assert.equal(refused.status, 409, `${name}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.errorCode || refused.body.failureClass, 'workspace_writer_busy', `${name}: ${JSON.stringify(refused.body)}`);
  }
  assert.equal(bridge.events().length, before + 1);

  // Kill the bridge while the writer is live, then restart it on the same store.
  const { request } = await restartBridge(t, bridge, 'SIGKILL');
  const uncertain = await waitFor(async () => {
    const view = await request(`/api/unified-runs/${held.body.id}`);
    return view.body.state === 'needs_attention' && view;
  }, 15000);
  assert.equal(uncertain.body.stopReason, 'writer_execution_uncertain', JSON.stringify(uncertain.body));
  assert.equal(uncertain.body.segments[0].state, 'uncertain');
  assert.equal(uncertain.body.workspaceReconciliation.available, true, JSON.stringify(uncertain.body));
  const digest = uncertain.body.workspaceReconciliation.workspaceEffectsDigest;
  assert.match(digest, /^[a-f0-9]{64}$/);

  // The run still holds its workspace while uncertain.
  const busy = await request('/api/unified-runs', writer({ ws: bridge.ws }));
  assert.equal(busy.body.errorCode, 'workspace_writer_busy', JSON.stringify(busy.body));

  const resumed = await request(`/api/unified-runs/${held.body.id}/resume`, {});
  assert.equal(resumed.body.errorCode, 'writer_execution_uncertain');
  for (const body of [{ confirmDuplicateBillingRisk: true }, { confirmDuplicateBillingRisk: true, workspaceEffectsDigest: 'f'.repeat(64) },
    { confirmDuplicateBillingRisk: true, workspaceEffectsDigest: digest }]) {
    const linked = await request(`/api/unified-runs/${held.body.id}/link`, body);
    assert.equal(linked.status, 409, JSON.stringify(linked.body));
    assert.equal(linked.body.errorCode, 'writer_execution_uncertain', JSON.stringify(linked.body));
  }
  const after = await request(`/api/unified-runs/${held.body.id}`);
  assert.equal(after.body.segments.length, 1);
  assert.equal(bridge.events().length, before + 1);
});

test('cancel over HTTP, CLI and MCP closes never-started queued segments, refuses running work and never starts pending work', { ...linuxOnly, timeout: 90000 }, async (t) => {
  const bridge = await bridgeFixture(t, { env: { RELAYBRIDGE_MAX_TASKS: '1' } });
  const pids = [];
  t.after(() => { for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch {} });
  await bridge.usage('claude', 10);
  const data = path.join(bridge.root, 'data');
  const cliEnv = isolatedEnv({ RELAYBRIDGE_URL: bridge.base, RELAYBRIDGE_TOKEN: bridge.headers['X-RelayBridge-Token'],
    NODE_ENV: 'test', RELAYBRIDGE_TEST_BUILD_ID: 'security-integration-fixture', RELAYBRIDGE_DATA_DIR: data,
    RELAYBRIDGE_CONFIG_FILE: bridge.configPath, RELAYBRIDGE_TOKEN_FILE: path.join(bridge.root, 'token') });
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin/relaybridge.js'), ...args], { encoding: 'utf8', env: cliEnv, cwd: bridge.root });
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const client = new Client({ name: 'unified-cancel-fixture', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp/server.mjs')], env: cliEnv, stderr: 'pipe' }));
  t.after(() => client.close());
  const view = async (id) => (await bridge.request(`/api/unified-runs/${id}`)).body;
  const create = async (objective) => {
    const created = await bridge.request('/api/unified-runs', { objective, cwd: bridge.ws, segments: [nativeSegment()] });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    return created.body.id;
  };

  // The only queue slot is held by a running segment.
  const running = await create('HOLD read only');
  await waitFor(() => bridge.events().some((event) => event.hold));
  pids.push(...bridge.events().map((event) => event.pid));
  const live = await view(running);
  assert.equal(live.recovery.cancel, 'refused', JSON.stringify(live));
  assert.equal(live.recovery.automaticRetry, false);
  const refused = await bridge.request(`/api/unified-runs/${running}/cancel`, {});
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.errorCode, 'unified_run_segment_running', JSON.stringify(refused.body));
  const refusedCli = cli('unified', 'cancel', running);
  assert.notEqual(refusedCli.status, 0); assert.match(refusedCli.stderr, /unified_run_segment_running/);
  const refusedMcp = await client.callTool({ name: 'unified_run_cancel', arguments: { runId: running } });
  assert.ok(refusedMcp.isError, JSON.stringify(refusedMcp));
  assert.match(JSON.stringify(refusedMcp), /unified_run_segment_running/);

  // Segments queued behind it have a durable never-started record of their exact intent.
  const queued = [await create('Queued via HTTP'), await create('Queued via CLI'), await create('Queued via MCP')];
  for (const id of queued) {
    const waiting = await waitFor(async () => { const v = await view(id); return v.segments?.[0]?.taskId && v; });
    assert.equal(waiting.recovery.cancel, 'available', JSON.stringify(waiting));
    assert.equal((await bridge.request(`/api/tasks/${waiting.segments[0].taskId}`)).body.status, 'queued');
  }
  const viaHttp = await bridge.request(`/api/unified-runs/${queued[0]}/cancel`, {});
  assert.equal(viaHttp.status, 200, JSON.stringify(viaHttp.body));
  const viaCli = cli('unified', 'cancel', queued[1]);
  assert.equal(viaCli.status, 0, viaCli.stderr);
  assert.equal(JSON.parse(viaCli.stdout).state, 'cancelled');
  const viaMcp = await client.callTool({ name: 'unified_run_cancel', arguments: { runId: queued[2] } });
  assert.ok(!viaMcp.isError, JSON.stringify(viaMcp));
  assert.equal(viaMcp.structuredContent.state, 'cancelled');
  for (const id of queued) {
    const cancelled = await view(id);
    assert.equal(cancelled.state, 'cancelled', JSON.stringify(cancelled));
    assert.equal(cancelled.segments[0].state, 'cancelled');
    assert.equal(cancelled.recovery.cancel, 'not_applicable');
    assert.equal((await bridge.request(`/api/tasks/${cancelled.segments[0].taskId}`)).body.status, 'cancelled');
  }
  // Public fields are refused, and repeating a cancel is a no-op.
  assert.equal((await bridge.request(`/api/unified-runs/${queued[0]}/cancel`, { reserveRelease: {} })).status, 400);
  assert.equal((await bridge.request(`/api/unified-runs/${queued[0]}/cancel`, {})).body.state, 'cancelled');

  // Releasing the slot completes the running segment; nothing cancelled starts,
  // including after a later tick and an explicit resume.
  fs.writeFileSync(path.join(bridge.root, 'release'), '');
  assert.equal((await bridge.settle(running)).body.state, 'complete');
  for (const id of queued) assert.equal((await bridge.request(`/api/unified-runs/${id}/resume`, {})).body.state, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 6000));
  assert.equal(bridge.events().length, 1, JSON.stringify(bridge.events()));
  for (const id of queued) assert.equal((await view(id)).segments.length, 1);

  // A bridge restarted on the same store starts nothing for the cancelled
  // runs, across more than two continuity ticks and an explicit resume.
  const restarted = await restartBridge(t, bridge, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 11000));
  for (const id of queued) {
    const after = (await restarted.request(`/api/unified-runs/${id}`)).body;
    assert.equal(after.state, 'cancelled', JSON.stringify(after));
    assert.equal(after.segments.length, 1); assert.equal(after.segments[0].state, 'cancelled');
    assert.equal((await restarted.request(`/api/unified-runs/${id}/resume`, {})).body.state, 'cancelled');
    assert.equal((await restarted.request(`/api/tasks/${after.segments[0].taskId}`)).body.status, 'cancelled');
  }
  await new Promise((resolve) => setTimeout(resolve, 6000));
  assert.equal(bridge.events().length, 1, JSON.stringify(bridge.events()));
  for (const id of queued) assert.equal((await restarted.request(`/api/unified-runs/${id}`)).body.segments.length, 1);
});

test('where the directory barrier is not enforced, unified runs are refused before any directory, task or call', { skip: process.platform === 'linux' && 'covers hosts without the Linux directory barrier', timeout: 60000 }, async (t) => {
  const bridge = await bridgeFixture(t);
  await bridge.usage('claude', 10);
  for (const body of [writer(bridge), { objective: 'Read only', cwd: bridge.ws, segments: [nativeSegment()] }]) {
    const refused = await bridge.request('/api/unified-runs', body);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.errorCode, 'unified_run_platform_unsupported', JSON.stringify(refused.body));
  }
  assert.deepEqual(bridge.runDirs(), []);
  assert.equal(bridge.events().length, 0);
});
