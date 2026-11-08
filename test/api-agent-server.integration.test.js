'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { startTestBridge, waitFor } = require('./helpers/temporary-bridge');
const { CREDIT_SECRET_NAMES } = require('../lib/allocated-credit');
const ROOT = path.resolve(__dirname, '..');
const SENTINEL = 'sk-api-agent-server-sentinel-must-never-appear';
const profile = (id, provider) => ({ id, provider, label: id,
  subscription: { kind: provider === 'claude' ? 'claude' : 'codex', accountId: 'default' },
  organization: { ref: 'org_' + id, label: 'Fixture org' }, project: { ref: 'project_' + id, label: 'Fixture project' },
  credentialRef: { type: 'reserved_env', name: CREDIT_SECRET_NAMES[provider === 'claude' ? 0 : 1] },
  creditPeriod: { start: '2020-01-01T00:00:00.000Z', end: '2099-01-01T00:00:00.000Z' } });

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name))
    : e.isFile() ? [path.join(dir, e.name)] : []);
}

test('production wiring constructs exactly one adapterless qualification authority', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.equal(source.split('createQualificationAuthority(').length - 1, 1);
  assert.match(source, /createQualificationAuthority\(\{ adapters: Object\.freeze\(\{\}\) \}\)/);
  for (const dir of ['server.js', 'mcp', 'lib']) {
    const files = dir.endsWith('.js') ? [path.join(ROOT, dir)] : walk(path.join(ROOT, dir)).filter(f => /\.(c|m)?js$/.test(f));
    for (const file of files) {
      if (file.endsWith('api-agent-qualification.js')) continue;
      const text = fs.readFileSync(file, 'utf8');
      assert.equal(/createQualificationAuthority\(\{ adapters: (?!Object\.freeze\(\{\}\))/.test(text), false, file);
      assert.equal(/fake-provider-api|deny-egress|api-agent-(patch-)?crash-child/.test(text), false, file);
    }
  }
});

test('the real server never qualifies, reads the key for, or dispatches included API credit', async t => {
  let fakeRequests = 0;
  const fake = http.createServer((_req, res) => { fakeRequests++; res.end('{}'); });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => fake.close(resolve)));
  const fakeUrl = `http://127.0.0.1:${fake.address().port}`;
  const egressDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rb-egress-'));
  t.after(() => fs.rmSync(egressDir, { recursive: true, force: true }));
  const egressLog = path.join(egressDir, 'egress.log');
  let marker;
  const bridge = await startTestBridge(t, root => {
    marker = path.join(root, 'attempts');
    const script = path.join(root, 'fixture.js');
    fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(marker)}, 'attempt\\n'); console.log('fixture answer');`);
    const slot = [process.execPath, script, '{prompt}'];
    const seat = { safe: slot, dangerous: slot, oneshot_safe: slot, oneshot_dangerous: slot, capabilities: ['prompt'],
      oneshot_capabilities: { safe: ['model_invocation'], dangerous: ['model_invocation'] }, cost_class: 'subscription', model: 'fixture' };
    return { claude: { label: 'Offline Claude fixture', ...seat }, codex: { label: 'Offline Codex fixture', ...seat } };
  }, {
    nodeArgs: ['--require', path.join(__dirname, 'helpers', 'deny-egress.js')],
    env: {
      [CREDIT_SECRET_NAMES[0]]: SENTINEL, [CREDIT_SECRET_NAMES[1]]: SENTINEL,
      // Plausible activation switches and endpoint overrides; none may have any effect.
      RELAYBRIDGE_API_AGENT_QUALIFIED: '1', RELAYBRIDGE_API_QUALIFICATION: 'claude,openai', RELAYBRIDGE_INCLUDED_API_CREDIT: 'enabled',
      RELAYBRIDGE_API_AGENT_TEST: '1', ANTHROPIC_BASE_URL: fakeUrl, OPENAI_BASE_URL: fakeUrl,
      DENY_EGRESS_LOG: egressLog,
    },
  });
  const dataDir = path.join(bridge.root, 'data');
  const attempts = () => fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').length : 0;
  for (const [id, provider] of [['api_claude', 'claude'], ['api_openai', 'openai']]) {
    const saved = await bridge.request('/api/funding-profiles', { profile: profile(id, provider),
      expectedRevision: (await bridge.request('/api/funding-profiles')).body.storeRevision });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }

  for (const [kind, profileId] of [['claude', 'api_claude'], ['codex', 'api_openai']]) {
    const funding = { route: 'included_api_credit', fallback: 'none', profileId };
    const preview = await bridge.request('/api/funding-route/preview', { kind, funding });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.decision.actual, 'none');
    assert.equal(preview.body.decision.blockedReason, 'grant_only_funding_unverified');
    assert.equal(preview.body.decision.qualification, null);
    assert.equal(preview.body.decision.apiTransportImplemented, true);
    assert.equal(preview.body.decision.apiDispatchAllowed, false);

    for (const dangerous of [false, true]) {
      const shot = await bridge.request('/api/oneshot', { kind, prompt: 'Hello', cwd: bridge.root, dangerous, funding });
      assert.equal(shot.status, 409, JSON.stringify(shot.body));
      assert.equal(shot.body.failureClass, 'grant_only_funding_unverified');
      assert.equal(shot.body.model_invocation, false); assert.equal(shot.body.physical_attempt_count, 0);
      assert.equal(shot.body.route.funding.qualification, null);
    }

    // A client cannot assert a qualification, in the envelope or beside it.
    for (const body of [
      { kind, prompt: 'Hello', cwd: bridge.root, funding: { ...funding, qualification: { qualificationId: 'q_forged' } } },
      { kind, prompt: 'Hello', cwd: bridge.root, funding, qualification: { qualificationId: 'q_forged', provider: 'openai' } },
      { kind, prompt: 'Hello', cwd: bridge.root, funding, qualificationId: 'q_forged' },
      { kind, prompt: 'Hello', cwd: bridge.root, funding, apiQualification: true },
    ]) {
      const forged = await bridge.request('/api/oneshot', body);
      // 409 from envelope validation, 400 from the request-level claim check; both before admission.
      assert.ok([400, 409].includes(forged.status), JSON.stringify(forged.body));
      assert.equal(forged.body.errorCode, 'invalid_funding_envelope', JSON.stringify(forged.body));
      assert.equal(forged.body.model_invocation, false);
    }
    const forgedPreview = await bridge.request('/api/funding-route/preview', { kind, funding, qualification: { qualificationId: 'q_forged' } });
    assert.equal(forgedPreview.body.decision, undefined, JSON.stringify(forgedPreview.body));
    assert.equal(forgedPreview.body.errorCode ?? forgedPreview.body.error, 'invalid_funding_envelope', JSON.stringify(forgedPreview.body));
  }

  const status = await bridge.request('/api/allocated-credit');
  assert.equal(status.body.apiTransport, 'implemented_not_activated');
  assert.equal(status.body.automationAvailable, false);

  assert.equal(attempts(), 0);
  assert.equal(fakeRequests, 0);
  assert.equal(fs.existsSync(egressLog) ? fs.readFileSync(egressLog, 'utf8') : '', '', 'no non-loopback egress');
  assert.equal(fs.existsSync(path.join(dataDir, 'api-agent')), false, 'no API agent checkpoint may be created');
  for (const file of walk(dataDir)) assert.equal(fs.readFileSync(file, 'utf8').includes(SENTINEL), false, file);
});

// ---- owner-authorized prepaid (OpenAI only) -----------------------------------
const os = require('node:os');
const { credentialHmac, PREPAID_POLICY } = require('../lib/prepaid-authorization');

test('production wiring constructs one prepaid authority at a fixed path that nothing writes', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.equal(server.split('createPrepaidAuthority(').length - 1, 1);
  assert.match(server, /createPrepaidAuthority\(\{ dataDir: DATA_DIR \}\)/);
  const lib = fs.readFileSync(path.join(ROOT, 'lib', 'prepaid-authorization.js'), 'utf8');
  assert.equal(/process\.env/.test(lib), false);
  assert.equal(/write(File)?Sync|rename|unlink|rmSync|chmod|appendFile|createWriteStream/.test(lib), false);
  for (const dir of ['server.js', 'mcp', 'lib', 'bin']) {
    const files = dir.endsWith('.js') ? [path.join(ROOT, dir)] : walk(path.join(ROOT, dir)).filter(f => /\.(c|m)?js$/.test(f));
    for (const file of files) {
      if (file.endsWith(path.join('lib', 'prepaid-authorization.js'))) continue;
      const text = fs.readFileSync(file, 'utf8');
      assert.equal(text.includes('prepaid-authorization.json'), false, file);
      if (!file.endsWith('server.js')) assert.equal(text.includes('createPrepaidAuthority('), false, file);
    }
  }
});

// TEST FAKE fetch preload, generated into a temp dir so no production path names it.
function writePrepaidPreload(dir, { scriptFile, fetchLog }) {
  const file = path.join(dir, 'test-fake-prepaid-preload.js');
  fs.writeFileSync(file, `'use strict';
// TEST FAKE: generated by test/api-agent-server.integration.test.js. Never loaded by production.
const fs = require('fs'), path = require('path');
require(${JSON.stringify(path.join(ROOT, 'test', 'helpers', 'deny-egress.js'))});
const realFetch = globalThis.fetch;
const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 110 };
const permitFile = path.join(process.env.RELAYBRIDGE_DATA_DIR, 'prepaid-authorization.json');
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input && input.url ? input.url : input));
  if (/^(127\\.|localhost$|\\[::1\\]$)/.test(url.hostname)) return realFetch(input, init);
  const step = completed();
  const script = JSON.parse(fs.readFileSync(${JSON.stringify(scriptFile)}, 'utf8'));
  const spec = script.steps[step - script.offset] || { text: 'TEST FAKE script exhausted' };
  const headers = new Headers(init.headers);
  fs.appendFileSync(${JSON.stringify(fetchLog)}, JSON.stringify({ host: url.hostname, step, organization: headers.get('openai-organization'),
    project: headers.get('openai-project'), bearer: headers.get('authorization') === 'Bearer ' + script.expectedKey,
    model: JSON.parse(init.body).model }) + '\\n');
  if (spec.gate) while (!fs.existsSync(spec.gate)) await new Promise((resolve) => setTimeout(resolve, 25));
  if (spec.mutate === 'delete') fs.rmSync(permitFile);
  if (spec.mutate === 'edit') { const p = JSON.parse(fs.readFileSync(permitFile, 'utf8')); p.models = [...p.models, 'gpt-5-mini']; fs.writeFileSync(permitFile, JSON.stringify(p)); }
  if (spec.status) return new Response(JSON.stringify({ error: spec.error }), { status: spec.status, headers: { 'content-type': 'application/json' } });
  const output = [];
  if (spec.text) output.push({ type: 'message', id: 'msg_' + step, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: spec.text, annotations: [] }] });
  if (spec.read) output.push({ type: 'function_call', id: 'fc_' + step, call_id: 'call_read_' + step, name: 'read_file', status: 'completed',
    arguments: JSON.stringify({ path: spec.read, offset: null, length: null }) });
  return new Response(JSON.stringify({ id: 'resp_' + step, object: 'response', status: 'completed', model: 'gpt-5', output, usage }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};
function completed() { try { return fs.readFileSync(${JSON.stringify(fetchLog)}, 'utf8').split('\\n').filter(Boolean).length; } catch { return 0; } }
`);
  return file;
}

// A permit valid now: inside the current UTC month, at most 24h, 20%+ cushion.
function livePermit(patch = {}, { now = Date.now(), key = SENTINEL } = {}) {
  const d = new Date(now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), nextMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const issued = Math.max(now - 60000, monthStart), expires = Math.min(issued + 23 * 3600e3, nextMonth);
  const observed = new Date(issued - 3600e3).toISOString();
  const id = patch.authorizationId || 'pa_server_1';
  return { schemaVersion: 1, authorizationId: id, policy: PREPAID_POLICY, provider: 'openai', surface: 'openai_responses_agent',
    supervised: true, noPurchases: true, profileId: 'api_openai', profileRevision: patch.profileRevision ?? 1, organization: 'org_api_openai',
    project: 'project_api_openai', credentialHmac: credentialHmac(id, key), models: ['gpt-5'], issuedAt: new Date(issued).toISOString(),
    expiresAt: new Date(expires).toISOString(), revokedAt: null,
    providerControls: { autoReload: 'off', hardLimitCents: 12000, hardLimitScope: 'organization', hardLimitEnforced: true, observedAt: observed },
    balance: { observedBalanceCents: 20100, observedAt: observed, earliestCreditExpiry: new Date(expires + 2 * 86400e3).toISOString().slice(0, 10) }, ...patch };
}

test('the real server runs owner-authorized prepaid read-only for one OpenAI profile and blocks everything else', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-prepaid-fake-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = { scriptFile: path.join(dir, 'script.json'), fetchLog: path.join(dir, 'fetch.jsonl'), egressLog: path.join(dir, 'egress.log') };
  const preload = writePrepaidPreload(dir, files);
  let ws;
  const bridge = await startTestBridge(t, root => {
    ws = path.join(fs.realpathSync(root), 'ws');
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, 'README.md'), 'prepaid fixture readme\n');
    const script = path.join(root, 'fixture.js');
    fs.writeFileSync(script, `console.log('fixture answer');`);
    const entry = (kind, model) => {
      const slot = [process.execPath, script, kind, '--model', model, '--effort', 'medium', '{prompt}'];
      return { label: `Offline ${kind} fixture`, safe: slot, dangerous: slot, oneshot_safe: slot, oneshot_dangerous: slot,
        capabilities: ['prompt'], oneshot_safe_filesystem_policy: 'read_only_enforced',
        oneshot_capabilities: { safe: ['model_invocation', 'workspace_read', 'tool_use'], dangerous: ['model_invocation', 'workspace_read', 'workspace_write', 'tool_use'] },
        cost_class: 'subscription', model };
    };
    return { _models: { discoverOnBoot: false }, claude: entry('claude', 'fixture'), codex: entry('codex', 'gpt-5') };
  }, { nodeArgs: ['--require', preload], env: { RELAYBRIDGE_WARM_DIAG: '0', RELAYBRIDGE_REMOTE_MCP: '0',
    [CREDIT_SECRET_NAMES[0]]: SENTINEL, [CREDIT_SECRET_NAMES[1]]: SENTINEL, DENY_EGRESS_LOG: files.egressLog } });
  const dataDir = path.join(bridge.root, 'data');
  const permitFile = path.join(dataDir, 'prepaid-authorization.json');
  const writePermit = (value, mode = 0o600) => { fs.rmSync(permitFile, { force: true }); fs.writeFileSync(permitFile, JSON.stringify(value), { mode }); fs.chmodSync(permitFile, mode); };
  const fetches = () => fs.existsSync(files.fetchLog) ? fs.readFileSync(files.fetchLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  const script = (steps) => fs.writeFileSync(files.scriptFile, JSON.stringify({ offset: fetches().length, expectedKey: SENTINEL, steps }));
  for (const [id, provider] of [['api_openai', 'openai'], ['api_claude', 'claude']]) {
    const saved = await bridge.request('/api/funding-profiles', { profile: profile(id, provider),
      expectedRevision: (await bridge.request('/api/funding-profiles')).body.storeRevision });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }
  const revision = (await bridge.request('/api/funding-profiles')).body.profiles.find(p => p.id === 'api_openai').revision;
  const permit = (patch = {}, options) => livePermit({ profileRevision: revision, ...patch }, options);
  const funding = { route: 'authorized_prepaid', fallback: 'none', profileId: 'api_openai' };
  const shot = (patch = {}) => bridge.request('/api/oneshot', { kind: 'codex', prompt: 'Read the readme', cwd: ws, funding, ...patch });
  const responses = [];
  const record = (response) => { responses.push(JSON.stringify(response.body)); return response; };

  // Without a permit the route is blocked and the status says so.
  let status = record(await bridge.request('/api/allocated-credit'));
  assert.equal(status.body.apiTransport, 'implemented_not_activated');
  assert.equal(status.body.prepaidAuthorization.state, 'blocked'); assert.equal(status.body.prepaidAuthorization.reason, 'prepaid_authorization_missing');

  // (a) A valid permit admits one read-only one-shot with full receipt evidence.
  writePermit(permit());
  const preview = record(await bridge.request('/api/funding-route/preview', { kind: 'codex', funding }));
  assert.equal(preview.body.decision.actual, 'authorized_prepaid', JSON.stringify(preview.body));
  assert.equal(preview.body.decision.grantOnly, false); assert.equal(preview.body.decision.fundingPolicy, PREPAID_POLICY);
  script([{ read: 'README.md' }, { text: 'prepaid answer' }]);
  const ok = record(await shot());
  assert.equal(ok.body.exitCode, 0, JSON.stringify(ok.body)); assert.equal(ok.body.stdout, 'prepaid answer');
  assert.equal(ok.body.route.funding.actual, 'authorized_prepaid'); assert.equal(ok.body.route.funding.policy, PREPAID_POLICY);
  assert.equal(ok.body.route.funding.authorizationId, 'pa_server_1'); assert.equal(ok.body.route.funding.grantOnly, false);
  assert.ok(ok.body.route.funding.limitations.includes('provider_cap_enforcement_lag'));
  assert.equal(ok.body.route.read_only_enforced, true); assert.equal(ok.body.route.api_agent.reserve_release_evidence, false);
  assert.equal(fetches().length, 2);
  for (const f of fetches()) {
    assert.equal(f.organization, 'org_api_openai'); assert.equal(f.project, 'project_api_openai'); assert.equal(f.bearer, true); assert.equal(f.model, 'gpt-5');
  }
  status = record(await bridge.request('/api/allocated-credit'));
  assert.equal(status.body.apiTransport, 'owner_authorized_prepaid_supervised');
  assert.equal(status.body.prepaidAuthorization.state, 'valid'); assert.equal(status.body.prepaidAuthorization.authorizationId, 'pa_server_1');
  assert.ok(!JSON.stringify(status.body).includes(permit().credentialHmac));

  const refused = async (patch, code) => {
    const before = fetches().length;
    const r = record(await shot(patch));
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.failureClass ?? r.body.errorCode, code, JSON.stringify(r.body));
    assert.equal(r.body.model_invocation, false); assert.equal(fetches().length, before, code);
  };
  // (b) included_api_credit stays grant-only even with a valid permit. (c) Claude is unsupported.
  await refused({ funding: { ...funding, route: 'included_api_credit' } }, 'grant_only_funding_unverified');
  await refused({ kind: 'claude', funding: { ...funding, profileId: 'api_claude' } }, 'prepaid_provider_unsupported');
  // (g) Prepaid is never a writer.
  await refused({ dangerous: true }, 'api_agent_read_only');
  // (d) Every scope, credential, window and file problem blocks with zero requests.
  const now = Date.now();
  const cases = [
    [permit({ organization: 'org_other' }), 'prepaid_scope_mismatch'], [permit({ project: 'project_other' }), 'prepaid_scope_mismatch'],
    [permit({ profileRevision: revision + 1 }), 'prepaid_scope_mismatch'], [permit({ profileId: 'api_claude' }), 'prepaid_scope_mismatch'],
    [permit({}, { key: SENTINEL + '-other' }), 'prepaid_credential_mismatch'],
    [permit({ revokedAt: new Date(now).toISOString() }), 'prepaid_authorization_revoked'],
    [permit({ models: ['gpt-6.1-sol'] }), 'prepaid_model_not_permitted'],
    [{ ...permit(), hardLimitCents: 1 }, 'prepaid_authorization_invalid'],
    [permit({ providerControls: { ...permit().providerControls, hardLimitCents: 16081 } }), 'prepaid_authorization_invalid'],
  ];
  const past = livePermit({ profileRevision: revision }, { now: now - 2 * 86400e3 });
  if (new Date(Date.parse(past.issuedAt)).getUTCMonth() === new Date(Date.parse(past.expiresAt) - 1).getUTCMonth()) cases.push([past, 'prepaid_authorization_expired']);
  for (const [value, code] of cases) { writePermit(value); await refused({}, code); }
  // POSIX modes are not enforced on win32, where the file-mode check is skipped.
  if (process.platform !== 'win32') { writePermit(permit(), 0o644); await refused({}, 'prepaid_authorization_invalid'); }
  fs.rmSync(permitFile); await refused({}, 'prepaid_authorization_missing');
  status = record(await bridge.request('/api/allocated-credit'));
  assert.equal(status.body.apiTransport, 'implemented_not_activated');

  // (e) Exhaustion under the permit is terminal and releases no reserve.
  writePermit(permit());
  script([{ status: 429, error: { code: 'credit_balance_exhausted', message: 'out' } }]);
  const exhausted = record(await shot());
  assert.equal(exhausted.body.failureClass, 'funding_exhausted', JSON.stringify(exhausted.body));
  assert.equal(exhausted.body.route.api_agent.resumable, false); assert.equal(exhausted.body.route.api_agent.reserve_release_evidence, false);

  // (f) Deleting or editing the permit between turns stops the run before the next request.
  for (const mutate of ['delete', 'edit']) {
    writePermit(permit());
    script([{ read: 'README.md', mutate }, { text: 'never' }]);
    const before = fetches().length;
    const stopped = record(await shot());
    assert.notEqual(stopped.body.exitCode, 0, JSON.stringify(stopped.body));
    assert.deepEqual(stopped.body.route.api_agent.turns.map(turn => turn.state), ['received', 'not_sent'], mutate);
    assert.equal(fetches().length, before + 1, mutate);
  }

  // (h) No egress and the key appears nowhere.
  assert.equal(fs.existsSync(files.egressLog) ? fs.readFileSync(files.egressLog, 'utf8') : '', '', 'no non-loopback egress');
  for (const text of responses) assert.equal(text.includes(SENTINEL), false, text.slice(0, 200));
  assert.equal(fs.readFileSync(files.fetchLog, 'utf8').includes(SENTINEL), false);
  for (const file of walk(dataDir)) assert.equal(fs.readFileSync(file, 'utf8').includes(SENTINEL), false, file);
});

// A unified run opts into prepaid per entry, spends it only after every listed
// native seat is positively exhausted, and returns to a recovered native seat at
// the next segment boundary. The Codex seat is observed through a fake
// app-server; the Claude seat through the statusline endpoint.
test('a unified run uses opted-in prepaid only on proven exhaustion and returns to native at the next segment', { timeout: 180000, skip: process.platform === 'win32' && 'unified runs are unsupported on win32' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-prepaid-unified-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = { scriptFile: path.join(dir, 'script.json'), fetchLog: path.join(dir, 'fetch.jsonl'), egressLog: path.join(dir, 'egress.log') };
  const preload = writePrepaidPreload(dir, files);
  let ws;
  const bridge = await startTestBridge(t, root => {
    ws = path.join(fs.realpathSync(root), 'ws');
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, 'README.md'), 'prepaid fixture readme\n');
    const script = path.join(root, 'fixture.js');
    fs.writeFileSync(script, `console.log('fixture answer from ' + process.argv[2]);`);
    // TEST FAKE Codex app-server: the seat is fully used with a future reset.
    const usage = path.join(root, 'codex-usage.js');
    fs.writeFileSync(usage, `let buf='';process.stdin.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){const q=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);
      if(q.id===1)console.log(JSON.stringify({id:1,result:{}}));
      if(q.id===2)console.log(JSON.stringify({id:2,result:{ordinaryUsageAllowed:true,rateLimits:{limitId:'codex',primary:{usedPercent:100,resetsAt:Math.floor(Date.now()/1000)+3600,windowDurationMins:300}}}}));
    }});process.stdin.on('end',()=>process.exit(0));`);
    const entry = (kind, model) => {
      const slot = [process.execPath, script, kind, '--model', model, '--effort', 'medium', '{prompt}'];
      return { label: `Offline ${kind} fixture`, safe: slot, dangerous: slot, oneshot_safe: slot, oneshot_dangerous: slot,
        capabilities: ['prompt'], oneshot_safe_filesystem_policy: 'read_only_enforced',
        oneshot_capabilities: { safe: ['model_invocation', 'workspace_read', 'tool_use'], dangerous: ['model_invocation', 'workspace_read', 'workspace_write', 'tool_use'] },
        cost_class: 'subscription', model };
    };
    return { _models: { discoverOnBoot: false }, claude: entry('claude', 'fixture'),
      codex: { ...entry('codex', 'gpt-5'), npm_package: '@openai/codex', native_usage_command: [process.execPath, usage] } };
  }, { nodeArgs: ['--require', preload], env: { RELAYBRIDGE_WARM_DIAG: '0', RELAYBRIDGE_REMOTE_MCP: '0',
    [CREDIT_SECRET_NAMES[1]]: SENTINEL, DENY_EGRESS_LOG: files.egressLog } });
  const dataDir = path.join(bridge.root, 'data');
  const permitFile = path.join(dataDir, 'prepaid-authorization.json');
  const fetches = () => fs.existsSync(files.fetchLog) ? fs.readFileSync(files.fetchLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  const script = (steps) => fs.writeFileSync(files.scriptFile, JSON.stringify({ offset: fetches().length, expectedKey: SENTINEL, steps }));
  const responses = [];
  const record = (response) => { responses.push(JSON.stringify(response.body)); return response; };
  const saved = await bridge.request('/api/funding-profiles', { profile: profile('api_openai', 'openai'),
    expectedRevision: (await bridge.request('/api/funding-profiles')).body.storeRevision });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const revision = (await bridge.request('/api/funding-profiles')).body.profiles.find(p => p.id === 'api_openai').revision;
  const claudeUsage = async (used) => {
    const reset = Math.floor(Date.now() / 1000) + 18000;
    const r = await bridge.request('/api/usage/native', { kind: 'claude', accountId: 'default', rate_limits: {
      five_hour: { used_percentage: used, resets_at: reset }, seven_day: { used_percentage: used, resets_at: reset + 604800 } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  // The boot probe records the exhausted Codex seat.
  await waitFor(async () => (await bridge.request('/api/usage/native')).body.observations
    .some(o => String(o.quotaSeat).startsWith('codex')), 15000);
  const manifest = (id) => JSON.parse(fs.readFileSync(path.join(dataDir, 'unified-runs', id, 'manifest.json'), 'utf8'));
  const claudeNative = { kind: 'claude', accountId: 'default', transport: 'native', model: 'fixture', effort: 'medium' };
  const codexNative = { kind: 'codex', accountId: 'default', transport: 'native', model: 'gpt-5', effort: 'medium' };
  const api = { kind: 'codex', accountId: 'default', transport: 'api', model: 'gpt-5', effort: 'medium',
    fundingProfileId: 'api_openai', expectedProfileRevision: revision };
  const prepaid = { ...api, fundingRoute: 'authorized_prepaid' };
  const create = (segments, patch = {}) => bridge.request('/api/unified-runs', { objective: 'Read the readme', cwd: ws, segments, ...patch });
  const refused = async (segments, code, patch) => {
    const before = fetches().length;
    const r = record(await create(segments, patch));
    assert.notEqual(r.status, 202, JSON.stringify(r.body));
    if (code) assert.equal(r.body.errorCode, code, JSON.stringify(r.body));
    assert.equal(fetches().length, before, code);
  };
  script([{ text: 'must never run' }]);

  // An unobserved seat is not exhaustion, and a seat at 1% is protected, not exhausted.
  fs.writeFileSync(permitFile, JSON.stringify(livePermit({ profileRevision: revision })), { mode: 0o600 });
  await refused([claudeNative, codexNative, prepaid], 'waiting_for_quota');
  await claudeUsage(99);
  await refused([claudeNative, codexNative, prepaid], 'waiting_for_quota');
  // Without a permit, exhaustion alone spends nothing.
  await claudeUsage(100);
  fs.rmSync(permitFile);
  await refused([claudeNative, codexNative, prepaid], 'prepaid_authorization_missing');
  fs.writeFileSync(permitFile, JSON.stringify(livePermit({ profileRevision: revision })), { mode: 0o600 });
  // An entry without the opt-in stays on the grant path; a valid permit does not change it.
  await refused([claudeNative, codexNative, api]);
  // Prepaid is never a writer, and needs its own provider's native seat listed.
  await refused([codexNative, prepaid], 'api_agent_read_only', { dangerous: true, acknowledgeFilesystemWrites: true });
  await refused([claudeNative, prepaid], 'prepaid_exhaustion_source_required');

  // Every listed seat is exhausted: the prepaid entry runs read-only. The
  // Claude seat recovers mid-turn; the turn finishes on prepaid and the next
  // segment returns to the recovered native seat.
  const gate = path.join(dir, 'gate');
  script([{ read: 'README.md', gate }, { status: 429, error: { code: 'credit_balance_exhausted', message: 'out' } }]);
  const created = record(await create([claudeNative, codexNative, prepaid]));
  assert.equal(created.status, 202, JSON.stringify(created.body));
  await waitFor(() => fetches().length === 1, 60000);
  await claudeUsage(20);
  fs.writeFileSync(gate, '');
  let last;
  const done = await waitFor(async () => { const v = last = record(await bridge.request(`/api/unified-runs/${created.body.id}`)).body;
    return ['complete', 'failed', 'needs_attention', 'cancelled'].includes(v.state) && v; }, 90000)
    .catch((error) => { throw new Error(`${error.message}; last view ${JSON.stringify(last).slice(0, 4000)}`); });
  assert.equal(done.state, 'complete', JSON.stringify(done));
  const m = manifest(created.body.id);
  assert.equal(m.segments.length, 2, JSON.stringify(m.segments));
  const [first, second] = m.segments;
  assert.equal(first.transport, 'api'); assert.equal(first.entryIndex, 2); assert.equal(first.outcome, 'funding_exhausted');
  assert.equal(first.apiBinding ?? null, null);
  assert.equal(first.prepaidBinding.authorizationId, 'pa_server_1'); assert.equal(first.prepaidBinding.profileRevision, revision);
  assert.deepEqual(first.exhaustionEvidence.map(e => [e.accountId, e.percentRemaining]), [['default', 0], ['default', 0]]);
  assert.deepEqual(first.exhaustionEvidence.map(e => e.quotaSeat.split('#')[0]).sort(), ['claude', 'codex']);
  // Entry 0 is the recovered Claude seat.
  assert.equal(second.transport, 'native'); assert.equal(second.entryIndex, 0); assert.equal(second.outcome, 'done');
  assert.equal(m.reserveRelease ?? null, null, 'prepaid never releases the reserve');
  const task = record(await bridge.request(`/api/tasks/${first.taskId}`)).body;
  const route = task.route ?? task.result?.route;
  assert.equal(route.funding.actual, 'authorized_prepaid', JSON.stringify(task)); assert.equal(route.funding.authorizationId, 'pa_server_1');
  assert.equal(route.read_only_enforced, true); assert.equal(route.api_agent.reserve_release_evidence, false);
  assert.equal(fetches().length, 2);
  for (const f of fetches()) {
    assert.equal(f.organization, 'org_api_openai'); assert.equal(f.project, 'project_api_openai'); assert.equal(f.bearer, true); assert.equal(f.model, 'gpt-5');
  }

  assert.equal(fs.existsSync(files.egressLog) ? fs.readFileSync(files.egressLog, 'utf8') : '', '', 'no non-loopback egress');
  for (const text of responses) assert.equal(text.includes(SENTINEL), false, text.slice(0, 200));
  assert.equal(fs.readFileSync(files.fetchLog, 'utf8').includes(SENTINEL), false);
  for (const file of walk(dataDir)) assert.equal(fs.readFileSync(file, 'utf8').includes(SENTINEL), false, file);
});

// ---- owner-authorized promotional (Claude only) -------------------------------
const { PROMOTIONAL_POLICY } = require('../lib/promotional-authorization');

test('production wiring constructs one promotional authority, used only by explicit one-shot routing and status', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.equal(server.split('createPromotionalAuthority(').length - 1, 1);
  assert.match(server, /createPromotionalAuthority\(\{ dataDir: DATA_DIR \}\)/);
  // fundingForRequest, the preview and the unified-run API decision (v2 ledger permits only, enforced in selectSegment) pass it.
  assert.equal(server.split('prepaidAuthority, promotionalAuthority, now: Date.now() })').length - 1, 3);
  assert.equal(server.split('prepaidAuthority, now: Date.now() })').length - 1, 0);
  const lib = fs.readFileSync(path.join(ROOT, 'lib', 'promotional-authorization.js'), 'utf8');
  assert.equal(/process\.env/.test(lib), false);
  assert.equal(/write(File)?Sync|rename|unlink|rmSync|chmod|appendFile|createWriteStream/.test(lib), false);
  for (const name of ['prepaid-authorization.js']) {
    assert.equal(/promotional/i.test(fs.readFileSync(path.join(ROOT, 'lib', name), 'utf8')), false, name);
  }
  for (const dir of ['server.js', 'mcp', 'lib', 'bin']) {
    const files = dir.endsWith('.js') ? [path.join(ROOT, dir)] : walk(path.join(ROOT, dir)).filter(f => /\.(c|m)?js$/.test(f));
    for (const file of files) {
      if (file.endsWith(path.join('lib', 'promotional-authorization.js'))) continue;
      const text = fs.readFileSync(file, 'utf8');
      assert.equal(text.includes('promotional-authorization.json'), false, file);
      if (!file.endsWith('server.js')) assert.equal(text.includes('createPromotionalAuthority('), false, file);
    }
  }
});

// TEST FAKE Anthropic Messages preload, generated into a temp dir so no production path names it.
function writePromotionalPreload(dir, { scriptFile, fetchLog }) {
  const file = path.join(dir, 'test-fake-promotional-preload.js');
  fs.writeFileSync(file, `'use strict';
// TEST FAKE: generated by test/api-agent-server.integration.test.js. Never loaded by production.
const fs = require('fs'), path = require('path');
require(${JSON.stringify(path.join(ROOT, 'test', 'helpers', 'deny-egress.js'))});
const realFetch = globalThis.fetch;
const permitFile = path.join(process.env.RELAYBRIDGE_DATA_DIR, 'promotional-authorization.json');
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input && input.url ? input.url : input));
  if (/^(127\\.|localhost$|\\[::1\\]$)/.test(url.hostname)) return realFetch(input, init);
  const step = completed();
  const script = JSON.parse(fs.readFileSync(${JSON.stringify(scriptFile)}, 'utf8'));
  const spec = script.steps[step - script.offset] || { text: 'TEST FAKE script exhausted' };
  const headers = new Headers(init.headers);
  const model = JSON.parse(init.body).model;
  fs.appendFileSync(${JSON.stringify(fetchLog)}, JSON.stringify({ host: url.hostname, path: url.pathname, step, apiKey: headers.get('x-api-key') === script.expectedKey,
    version: headers.get('anthropic-version'), bearer: headers.has('authorization'), openaiOrganization: headers.has('openai-organization'),
    openaiProject: headers.has('openai-project'), model }) + '\\n');
  if (spec.mutate === 'delete') fs.rmSync(permitFile);
  if (spec.mutate === 'edit') { const p = JSON.parse(fs.readFileSync(permitFile, 'utf8')); p.balance.observedMonthSpendCents += 1; fs.writeFileSync(permitFile, JSON.stringify(p)); }
  if (spec.status) return new Response(JSON.stringify({ type: 'error', error: spec.error }), { status: spec.status, headers: { 'content-type': 'application/json' } });
  const content = [];
  if (spec.text) content.push({ type: 'text', text: spec.text });
  if (spec.read) content.push({ type: 'tool_use', id: 'toolu_read_' + step, name: 'read_file', input: { path: spec.read, offset: null, length: null } });
  return new Response(JSON.stringify({ id: 'msg_' + step, type: 'message', role: 'assistant', model, content,
    stop_reason: spec.read ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};
function completed() { try { return fs.readFileSync(${JSON.stringify(fetchLog)}, 'utf8').split('\\n').filter(Boolean).length; } catch { return 0; } }
`);
  return file;
}

// A promotional permit valid now: at most 24h, inside the current UTC month,
// ending 2+ days before the promotional expiry, cap at most 80% of promo.
function livePromoPermit(patch = {}, { now = Date.now(), key = SENTINEL } = {}) {
  const d = new Date(now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), nextMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const issued = Math.max(now - 60000, monthStart), expires = Math.min(issued + 23 * 3600e3, nextMonth);
  const observed = new Date(issued - 3600e3).toISOString();
  const id = patch.authorizationId || 'pp_server_1';
  return { schemaVersion: 1, authorizationId: id, policy: PROMOTIONAL_POLICY, provider: 'claude', surface: 'claude_messages_agent',
    supervised: true, noPurchases: true, profileId: 'api_claude', profileRevision: patch.profileRevision ?? 1, organization: 'org_api_claude',
    workspace: 'project_api_claude', credentialHmac: credentialHmac(id, key), models: ['claude-sonnet-5-5'], issuedAt: new Date(issued).toISOString(),
    expiresAt: new Date(expires).toISOString(), revokedAt: null,
    providerControls: { autoReload: 'off', billingMode: 'pay_as_you_go', operatorSpendLimitCents: 12000, operatorSpendLimitScope: 'organization',
      operatorSpendLimitActive: true, observedAt: observed },
    balance: { observedPromotionalCents: 19999, observedPurchasedCents: 370, observedMonthSpendCents: 0,
      promotionalExpiry: new Date(expires + 2 * 86400e3).toISOString().slice(0, 10), observedAt: observed }, ...patch };
}

test('the real server runs owner-authorized promotional credit read-only for one Claude profile and blocks everything else', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-promo-fake-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = { scriptFile: path.join(dir, 'script.json'), fetchLog: path.join(dir, 'fetch.jsonl'), egressLog: path.join(dir, 'egress.log') };
  const preload = writePromotionalPreload(dir, files);
  let ws;
  const bridge = await startTestBridge(t, root => {
    ws = path.join(fs.realpathSync(root), 'ws');
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, 'README.md'), 'promotional fixture readme\n');
    const script = path.join(root, 'fixture.js');
    fs.writeFileSync(script, `console.log('fixture answer');`);
    const entry = (kind, model) => {
      const slot = [process.execPath, script, kind, '--model', model, '--effort', 'medium', '{prompt}'];
      return { label: `Offline ${kind} fixture`, safe: slot, dangerous: slot, oneshot_safe: slot, oneshot_dangerous: slot,
        capabilities: ['prompt'], oneshot_safe_filesystem_policy: 'read_only_enforced',
        oneshot_capabilities: { safe: ['model_invocation', 'workspace_read', 'tool_use'], dangerous: ['model_invocation', 'workspace_read', 'workspace_write', 'tool_use'] },
        cost_class: 'subscription', model };
    };
    return { _models: { discoverOnBoot: false }, claude: entry('claude', 'claude-sonnet-5-5'), codex: entry('codex', 'gpt-5') };
  }, { nodeArgs: ['--require', preload], env: { RELAYBRIDGE_WARM_DIAG: '0', RELAYBRIDGE_REMOTE_MCP: '0',
    [CREDIT_SECRET_NAMES[0]]: SENTINEL, [CREDIT_SECRET_NAMES[1]]: SENTINEL, DENY_EGRESS_LOG: files.egressLog } });
  const dataDir = path.join(bridge.root, 'data');
  const permitFile = path.join(dataDir, 'promotional-authorization.json');
  const writePermit = (value, mode = 0o600) => { fs.rmSync(permitFile, { force: true }); fs.writeFileSync(permitFile, JSON.stringify(value), { mode }); fs.chmodSync(permitFile, mode); };
  const fetches = () => fs.existsSync(files.fetchLog) ? fs.readFileSync(files.fetchLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  const script = (steps) => fs.writeFileSync(files.scriptFile, JSON.stringify({ offset: fetches().length, expectedKey: SENTINEL, steps }));
  for (const [id, provider] of [['api_claude', 'claude'], ['api_openai', 'openai']]) {
    const saved = await bridge.request('/api/funding-profiles', { profile: profile(id, provider),
      expectedRevision: (await bridge.request('/api/funding-profiles')).body.storeRevision });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }
  const revision = (await bridge.request('/api/funding-profiles')).body.profiles.find(p => p.id === 'api_claude').revision;
  const permit = (patch = {}, options) => livePromoPermit({ profileRevision: revision, ...patch }, options);
  const funding = { route: 'authorized_promotional', fallback: 'none', profileId: 'api_claude' };
  const shot = (patch = {}) => bridge.request('/api/oneshot', { kind: 'claude', prompt: 'Read the readme', cwd: ws, funding, ...patch });
  const responses = [];
  const record = (response) => { responses.push(JSON.stringify(response.body)); return response; };

  // Without a permit the route is blocked and the status says so; nothing else changes.
  let status = record(await bridge.request('/api/allocated-credit'));
  assert.equal(status.body.apiTransport, 'implemented_not_activated');
  assert.equal(status.body.promotionalTransport, 'implemented_not_activated');
  assert.equal(status.body.promotionalAuthorization.state, 'blocked');
  assert.equal(status.body.promotionalAuthorization.reason, 'promotional_authorization_missing');
  assert.equal(status.body.providers.claude.blockedReason, 'grant_only_funding_unverified');
  const missing = record(await shot());
  assert.equal(missing.status, 409); assert.equal(missing.body.failureClass ?? missing.body.errorCode, 'promotional_authorization_missing');

  // A valid permit admits one read-only one-shot with full receipt evidence.
  writePermit(permit());
  const preview = record(await bridge.request('/api/funding-route/preview', { kind: 'claude', funding }));
  assert.equal(preview.body.decision.actual, 'authorized_promotional', JSON.stringify(preview.body));
  assert.equal(preview.body.decision.grantOnly, false); assert.equal(preview.body.decision.fundingPolicy, PROMOTIONAL_POLICY);
  assert.equal(preview.body.decision.fundingSource, 'promotional_credit_first'); assert.equal(preview.body.decision.promotional.reserveRelease, 'never');
  script([{ read: 'README.md' }, { text: 'promotional answer' }]);
  const ok = record(await shot());
  assert.equal(ok.body.exitCode, 0, JSON.stringify(ok.body)); assert.equal(ok.body.stdout, 'promotional answer');
  const receiptFunding = ok.body.route.funding;
  assert.equal(receiptFunding.actual, 'authorized_promotional'); assert.equal(receiptFunding.policy, PROMOTIONAL_POLICY);
  assert.equal(receiptFunding.authorizationId, 'pp_server_1'); assert.equal(receiptFunding.grantOnly, false);
  assert.equal(receiptFunding.reserveRelease, 'never'); assert.equal(receiptFunding.fundingSource, 'promotional_credit_first');
  for (const limitation of ['provider_cap_enforcement_lag', 'external_spend_unseen', 'dashboard_changes_unmonitored', 'purchased_balance_at_risk_on_overshoot']) {
    assert.ok(receiptFunding.limitations.includes(limitation), limitation);
  }
  assert.equal(ok.body.route.read_only_enforced, true); assert.equal(ok.body.route.api_agent.reserve_release_evidence, false);
  assert.equal(fetches().length, 2);
  for (const f of fetches()) {
    assert.equal(f.host, 'api.anthropic.com'); assert.equal(f.path, '/v1/messages'); assert.equal(f.apiKey, true);
    assert.equal(f.version, '2023-06-01'); assert.equal(f.bearer, false); assert.equal(f.openaiOrganization, false); assert.equal(f.openaiProject, false);
    assert.equal(f.model, 'claude-sonnet-5-5');
  }
  status = record(await bridge.request('/api/allocated-credit'));
  assert.equal(status.body.promotionalTransport, 'owner_authorized_promotional_supervised');
  assert.equal(status.body.promotionalAuthorization.state, 'valid'); assert.equal(status.body.promotionalAuthorization.grantOnly, false);
  assert.match(status.body.promotionalDetail, /not grant-only/); assert.match(status.body.promotionalDetail, /purchased balance is not authorized/);
  // The prepaid route, its status and the grant-only provider view are untouched.
  assert.equal(status.body.apiTransport, 'implemented_not_activated');
  assert.equal(status.body.prepaidAuthorization.reason, 'prepaid_authorization_missing');
  assert.equal(status.body.providers.claude.dispatchAllowed, false);
  assert.ok(!JSON.stringify(status.body).includes(permit().credentialHmac));

  const refused = async (patch, code, httpStatus = 409) => {
    const before = fetches().length;
    const r = record(await shot(patch));
    assert.equal(r.status, httpStatus, JSON.stringify(r.body));
    assert.equal(r.body.failureClass ?? r.body.errorCode, code, JSON.stringify(r.body));
    assert.equal(r.body.model_invocation, false); assert.equal(fetches().length, before, code);
  };
  // Grant-only stays unqualified and prepaid stays OpenAI-only, even with a valid promotional permit.
  await refused({ funding: { ...funding, route: 'included_api_credit' } }, 'grant_only_funding_unverified');
  await refused({ funding: { ...funding, route: 'authorized_prepaid' } }, 'prepaid_provider_unsupported');
  await refused({ kind: 'codex', funding: { ...funding, profileId: 'api_openai' } }, 'promotional_provider_unsupported');
  // Promotional credit is never a writer.
  await refused({ dangerous: true }, 'api_agent_read_only');
  // Every scope, credential, window, cap and file problem blocks with zero requests.
  const cases = [
    [permit({ organization: 'org_other' }), 'promotional_scope_mismatch'], [permit({ workspace: 'project_other' }), 'promotional_scope_mismatch'],
    [permit({ workspace: null }), 'promotional_scope_mismatch'],
    [permit({ profileRevision: revision + 1 }), 'promotional_scope_mismatch'], [permit({ profileId: 'api_openai' }), 'promotional_scope_mismatch'],
    [permit({}, { key: SENTINEL + '-other' }), 'promotional_credential_mismatch'],
    [permit({ revokedAt: new Date().toISOString() }), 'promotional_authorization_revoked'],
    [permit({ models: ['claude-opus-5-5'] }), 'promotional_model_not_permitted'],
    [permit({ balance: { ...permit().balance, observedPromotionalCents: 14999, observedPurchasedCents: 1000000 } }), 'promotional_authorization_invalid'],
    [permit({ providerControls: { ...permit().providerControls, autoReload: 'on' } }), 'promotional_authorization_invalid'],
    [{ ...permit(), policy: 'owner_authorized_prepaid' }, 'promotional_authorization_invalid'],
  ];
  for (const [value, code] of cases) { writePermit(value); await refused({}, code); }
  if (process.platform !== 'win32') { writePermit(permit(), 0o644); await refused({}, 'promotional_authorization_invalid'); }
  // A promotional permit placed at the prepaid path qualifies nothing.
  fs.rmSync(permitFile);
  const prepaidFile = path.join(dataDir, 'prepaid-authorization.json');
  fs.writeFileSync(prepaidFile, JSON.stringify(permit()), { mode: 0o600 });
  await refused({}, 'promotional_authorization_missing');
  await refused({ funding: { ...funding, route: 'authorized_prepaid' } }, 'prepaid_provider_unsupported');
  fs.rmSync(prepaidFile);
  status = record(await bridge.request('/api/allocated-credit'));
  assert.equal(status.body.promotionalTransport, 'implemented_not_activated');

  // A unified run can neither opt an entry into promotional funding nor carry one into a task.
  writePermit(permit());
  const unified = record(await bridge.request('/api/unified-runs', { objective: 'Read the readme', cwd: ws,
    segments: [{ kind: 'claude', accountId: 'default', transport: 'native' }, { kind: 'claude', accountId: 'default', transport: 'api', fundingRoute: 'authorized_promotional' }] }));
  // win32 refuses every unified run before validating segments (409 unified_run_platform_unsupported).
  assert.equal(unified.status, process.platform === 'win32' ? 409 : 400, JSON.stringify(unified.body));
  const before = fetches().length;
  const carried = record(await shot({ unifiedRun: { id: 'ur_forged', segment: 0 } }));
  assert.ok([400, 409].includes(carried.status), JSON.stringify(carried.body));
  assert.equal(carried.body.model_invocation, false); assert.equal(fetches().length, before);

  // Spend-limit and low-credit errors are terminal and release no reserve.
  for (const [httpStatus, error, failureClass] of [
    [429, { type: 'rate_limit_error', message: 'limit', details: { error_code: 'enforced_spend_limit_reached' } }, 'spend_limit'],
    [400, { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' }, 'account_credit_low'],
  ]) {
    script([{ status: httpStatus, error }]);
    const stopped = record(await shot());
    assert.equal(stopped.body.failureClass, failureClass, JSON.stringify(stopped.body));
    assert.equal(stopped.body.route.api_agent.resumable, false); assert.equal(stopped.body.route.api_agent.reserve_release_evidence, false);
  }

  // Deleting or editing the permit between turns stops the run before the next request.
  for (const mutate of ['delete', 'edit']) {
    writePermit(permit());
    script([{ read: 'README.md', mutate }, { text: 'never' }]);
    const start = fetches().length;
    const stopped = record(await shot());
    assert.notEqual(stopped.body.exitCode, 0, JSON.stringify(stopped.body));
    assert.deepEqual(stopped.body.route.api_agent.turns.map(turn => turn.state), ['received', 'not_sent'], mutate);
    assert.equal(fetches().length, start + 1, mutate);
  }

  // No egress and the key appears nowhere.
  assert.equal(fs.existsSync(files.egressLog) ? fs.readFileSync(files.egressLog, 'utf8') : '', '', 'no non-loopback egress');
  for (const text of responses) assert.equal(text.includes(SENTINEL), false, text.slice(0, 200));
  assert.equal(fs.readFileSync(files.fetchLog, 'utf8').includes(SENTINEL), false);
  for (const file of walk(dataDir)) assert.equal(fs.readFileSync(file, 'utf8').includes(SENTINEL), false, file);
});
