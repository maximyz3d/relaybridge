'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestBridge, waitFor, completeJsonLines } = require('./helpers/temporary-bridge');
const { buildAskBody } = require('../bin/relaybridge');
const ROOT = path.resolve(__dirname, '..');

test('output guidance survives REST, queued execution and MCP cache as frozen prompt text', { timeout:45000 }, async t => {
  const { compileOutputProfile } = require('../lib/output-profiles');
  const crypto = require('node:crypto');
  let marker;
  const bridge = await startTestBridge(t, root => {
    marker = path.join(root, 'profile-invocations.jsonl');
    const script = path.join(root, 'profile-provider.js');
    fs.writeFileSync(script, [
      "const fs=require('fs'),a=process.argv.slice(2);",
      "if(a[0]==='--version'){process.stdout.write('fixture v1');process.exit(0);}",
      "const prompt=fs.readFileSync(a[a.indexOf('--prompt-file')+1],'utf8');",
      "fs.appendFileSync(a[a.indexOf('--marker')+1],JSON.stringify({prompt})+'\\n');",
      "process.stdout.write('A bounded cache preserves the selected identity and rejects stale inputs before lookup. Verification completed.');",
    ].join('\n'));
    const entry = { label:'Profile fixture', transport:'subscription:fixture',
      oneshot_capabilities:{ safe:['model_invocation'] }, safe:[process.execPath],
      probe:[process.execPath,script,'--version'], model:'fixture-model',
      oneshot_safe:[process.execPath,script,'--model','fixture-model','--marker',marker,'--prompt-file','{prompt_file}'],
      oneshot_safe_filesystem_policy:'read_only_enforced',
      model_tiers:{ standard:{ model:'fixture-model', args:['--model','fixture-model'] } } };
    return { claude:entry, codex:entry };
  });
  const catalog = (await bridge.request('/api/output-profiles')).body;
  const profile = catalog.profiles.find(item => item.id === 'decision-analysis');
  const selection = { id:profile.id, version:profile.version, digest:profile.digest };
  const prompt = 'Explain how to choose the size of a bounded cache.';
  const expected = compileOutputProfile(prompt, selection).prompt;
  const library = await bridge.request('/api/workflow-library');
  assert.equal(library.body.entries.length, 6);
  assert.ok(library.body.entries.every(entry => entry.connectionEvidence === null));
  const planned = await bridge.request('/api/plan', { kind:'claude', task:prompt, cwd:bridge.root, outputProfile:selection });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  assert.equal(planned.body.preparedPrompt, expected);
  assert.equal(planned.body.outputProfile.digest, profile.digest);
  const invoked = await bridge.request('/api/oneshot', { kind:'claude', prompt, cwd:bridge.root, outputProfile:selection, dangerous:false });
  assert.equal(invoked.body.exitCode, 0, JSON.stringify(invoked.body));
  assert.equal(completeJsonLines(marker).at(-1).prompt, expected);
  assert.equal(invoked.body.route.prompt_evidence.effectiveHash, crypto.createHash('sha256').update(expected).digest('hex'));
  assert.equal(invoked.body.route.output_profile.digest, profile.digest);
  const queued = await bridge.request('/api/tasks', { kind:'claude', prompt, cwd:bridge.root, outputProfile:selection, notBefore:Date.now()+100 });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  assert.equal(queued.body.body.prompt, expected);
  assert.equal(queued.body.body.taskTier, planned.body.primary.execution.resolvedTaskTier);
  assert.equal('outputProfile' in queued.body.body, false, 'queue stores ordinary frozen text, not a new profile lifecycle field');
  const done = await waitFor(async () => {
    const task = (await bridge.request('/api/tasks/' + queued.body.id)).body;
    return ['done','failed'].includes(task.status) ? task : null;
  });
  assert.equal(done.status, 'done', JSON.stringify(done));
  assert.equal(completeJsonLines(marker).at(-1).prompt, expected);
  assert.equal((expected.match(/\[RelayBridge output guidance:/g) || []).length, 1);
  let before = completeJsonLines(marker).length;
  for (const [route, body] of [
    ['/api/tasks', { outputProfile:{ ...selection, digest:'0'.repeat(64) } }],
    ['/api/oneshot', { outputProfile:{ ...selection, version:999 } }],
    ['/api/tasks', { outputProfile:selection, prompt:'x'.repeat(100001 - (compileOutputProfile('x', selection).prompt.length - 1)) }],
    ['/api/tasks', { outputProfile:selection, requiresWorkspaceAccess:true, prompt:'Read the current repository and diagnose its implementation.' }],
  ]) {
    const rejected = await bridge.request(route, { kind:'claude', prompt, cwd:bridge.root, dangerous:false, ...body });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(rejected.body.model_invocation, false);
  }
  assert.equal(completeJsonLines(marker).length, before);
  const admission = (await bridge.request('/api/workspace/validate', { kind:'claude', prompt, cwd:bridge.root, outputProfile:selection })).body;
  const originalConfig = JSON.parse(fs.readFileSync(bridge.configPath, 'utf8'));
  fs.writeFileSync(bridge.configPath, JSON.stringify({ ...originalConfig, claude:{ ...originalConfig.claude, oneshot_safe_prompt_prefix:'A changed policy prefix.' } }));
  const drifted = await bridge.request('/api/oneshot', { kind:'claude', prompt:admission.preparedPrompt, cwd:bridge.root,
    dangerous:false, execution:admission.execution, expectedPromptHash:admission.promptEvidence.effectiveHash });
  assert.equal(drifted.body.errorCode, 'prompt_identity_changed', JSON.stringify(drifted.body));
  assert.equal(drifted.body.model_invocation, false);
  assert.equal(completeJsonLines(marker).length, before);
  fs.writeFileSync(bridge.configPath, JSON.stringify(originalConfig));

  // Adversarial transport responses test correlation independently of the compiler.
  const http = require('node:http'); let tamper = null;
  const proxy = http.createServer(async (req,res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const upstream = await fetch(bridge.base + req.url, { method:req.method, headers:bridge.headers,
      ...(req.method === 'GET' ? {} : { body:raw }) });
    const body = await upstream.json();
    if (tamper === 'admission' && req.url === '/api/workspace/validate' && body.promptEvidence) body.promptEvidence.effectiveHash = '0'.repeat(64);
    if (tamper === 'actual') {
      if (req.url === '/api/oneshot' && body.route) delete body.route.prompt_evidence;
      if (req.url.startsWith('/api/tasks/') && body.route) delete body.route.prompt_evidence;
    }
    res.writeHead(upstream.status, { 'Content-Type':'application/json' }); res.end(JSON.stringify(body));
  });
  await new Promise(resolve => proxy.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => proxy.close(resolve)));

  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/client'), import('@modelcontextprotocol/client/stdio'),
  ]);
  const transport = new StdioClientTransport({ command:process.execPath, args:[path.join(ROOT,'mcp/server.mjs')], cwd:ROOT,
    env:{ ...process.env, NODE_ENV:'test', RELAYBRIDGE_TEST_BUILD_ID:'security-integration-fixture', RELAYBRIDGE_URL:`http://127.0.0.1:${proxy.address().port}`,
      RELAYBRIDGE_TOKEN_FILE:path.join(bridge.root,'token'), RELAYBRIDGE_DATA_DIR:path.join(bridge.root,'data'),
      RELAYBRIDGE_CONFIG_FILE:bridge.configPath }, stderr:'pipe' });
  const client = new Client({ name:'profile-handoff-test', version:'1.0.0' });
  t.after(async () => { await client.close(); await transport.close(); }); await client.connect(transport);
  const call = async (name,args) => (await client.callTool({ name, arguments:args })).structuredContent;
  assert.equal((await call('list_workflow_library', {})).entries.length, 6);
  assert.equal((await call('list_output_profiles', {})).profiles.length, 6);
  const mcpPlan = await call('plan_task', { task:prompt, kind:'claude', cwd:bridge.root, outputProfile:selection });
  assert.equal(mcpPlan.preparedPrompt, expected);
  const request = { kind:'claude', prompt, cwd:bridge.root, outputProfile:selection, useCache:true, cacheTtlMs:60000 };
  const first = await call('ask_provider', request);
  assert.equal(first.exitCode, 0, JSON.stringify(first));
  assert.equal(completeJsonLines(marker).at(-1).prompt, expected);
  before = completeJsonLines(marker).length;
  tamper = 'admission';
  const badAdmission = await call('ask_provider', request);
  assert.equal(badAdmission.modelInvocation, false, JSON.stringify(badAdmission));
  assert.equal(badAdmission.cacheHit, false);
  assert.equal(completeJsonLines(marker).length, before);
  tamper = 'actual';
  const missingHash = await call('ask_provider', { ...request, prompt:prompt+' Consider freshness.' });
  assert.equal(missingHash.failureClass, 'prompt_identity_changed', JSON.stringify(missingHash));
  assert.equal(missingHash.modelInvocation, true);
  tamper = null;
  assert.equal((await call('ask_provider', { ...request, prompt:prompt+' Consider freshness.' })).cacheHit, false);
  assert.equal(completeJsonLines(marker).length, before+2);
  const submitted = await call('submit_task', { kind:'claude', prompt, cwd:bridge.root, outputProfile:selection });
  assert.equal(submitted.body.prompt, expected, JSON.stringify(submitted));
  await waitFor(async () => (await bridge.request('/api/tasks/'+submitted.id)).body.status === 'done');
  const routed = await call('route_and_ask', { task:prompt, cwd:bridge.root, preferredProviders:['claude'], outputProfile:selection, useCache:false });
  assert.equal(routed.ok, true, JSON.stringify(routed));
  assert.equal(completeJsonLines(marker).at(-1).prompt, expected);
  const committeeTask = 'Review this proposed cache design and identify a bug: two bounded caches share eviction state.';
  const committee = await call('run_committee', { task:committeeTask, providers:['claude','codex'], maxProviders:2,
    cwd:bridge.root, outputProfile:selection, useCache:false, mode:'advisory' });
  assert.equal(committee.members.length, 2, JSON.stringify(committee));
  assert.ok(committee.members.every(member => member.exitCode === 0), JSON.stringify(committee));
  const memberPrompts = completeJsonLines(marker).slice(-2).map(row => row.prompt);
  assert.ok(memberPrompts.every(text => text.includes(expected.slice(prompt.length))));
  const rawMemberMax = Math.max(...memberPrompts.map(text => text.indexOf('\n\n[RelayBridge output guidance:')));
  fs.writeFileSync(bridge.configPath, JSON.stringify({ ...originalConfig, codex:{ ...originalConfig.codex,
    prompt_input_max_chars:Math.max(rawMemberMax, compileOutputProfile(committeeTask,selection).prompt.length)+20 } }));
  before = completeJsonLines(marker).length;
  const rejectedCommittee = await call('run_committee', { task:committeeTask, providers:['claude','codex'], maxProviders:2,
    cwd:bridge.root, outputProfile:selection, useCache:false, mode:'advisory' });
  assert.equal(rejectedCommittee.modelInvocation, false, JSON.stringify(rejectedCommittee));
  assert.equal(completeJsonLines(marker).length, before, 'later expanded member rejection spends no earlier member');
  const badRoute = await call('route_and_ask', { task:prompt, cwd:bridge.root, outputProfile:{ ...selection, version:999 } });
  assert.equal(badRoute.modelInvocation, false, JSON.stringify(badRoute));
  assert.equal(completeJsonLines(marker).length, before);
  fs.writeFileSync(bridge.configPath, JSON.stringify(originalConfig));
  before = completeJsonLines(marker).length;
  assert.equal((await call('ask_provider', request)).cacheHit, true);
  assert.equal(completeJsonLines(marker).length, before);
  const rejected = await call('ask_provider', { ...request, outputProfile:{ ...selection, digest:'0'.repeat(64) } });
  assert.equal(rejected.physicalAttemptCount, 0, JSON.stringify(rejected));
  assert.equal(completeJsonLines(marker).length, before);
  const changed = await call('ask_provider', { ...request, outputProfile:{ id:'implementation-plan', version:1 } });
  assert.equal(changed.exitCode, 0, JSON.stringify(changed)); assert.notEqual(changed.cacheHit, true);
  assert.equal(completeJsonLines(marker).length, before + 1);
  const broadcast = await call('broadcast', { providers:['claude'], prompt, cwd:bridge.root, outputProfile:selection });
  assert.equal(broadcast.results[0].ok, true, JSON.stringify(broadcast));
  assert.equal(completeJsonLines(marker).at(-1).prompt, expected);
});

test('exact plan intent survives CLI, REST, MCP cache, queue and broadcast; drift spends zero', { timeout: 45000 }, async (t) => {
  let marker, census;
  const bridge = await startTestBridge(t, (root) => {
    marker = path.join(root, 'invocations.jsonl'); census = path.join(root, 'catalog.txt');
    fs.writeFileSync(census, 'gemini-flash-medium\ngemini-flash-high\ngemini-pro-high\n');
    const script = path.join(root, 'provider.js');
    fs.writeFileSync(script, [
      "const fs=require('fs');const args=process.argv.slice(2);",
      "if(args[0]==='--version'){process.stdout.write('fixture v1');process.exit(0);}",
      "if(args[0]==='--catalog'){process.stdout.write(fs.readFileSync(args[1]));process.exit(0);}",
      "const at=args.indexOf('--marker');fs.appendFileSync(args[at+1],JSON.stringify(args)+'\\n');",
      "process.stdout.write('A complete explanation with deterministic verification steps.');",
    ].join('\n'));
    const seat = () => ({ label: 'Gemini fixture', transport: 'subscription:fixture',
      oneshot_capabilities: { safe: ['model_invocation'] },
      safe: [process.execPath], probe: [process.execPath, script, '--version'],
      models_probe: [process.execPath, script, '--catalog', census],
      oneshot_safe: [process.execPath, script, '--model', 'gemini-pro-high', '--effort', 'high', '--marker', marker, '--prompt-file', '{prompt_file}'],
      oneshot_safe_filesystem_policy: 'read_only_enforced',
      model_tiers: {
        standard: { model: 'gemini-flash-medium', args: ['--model', 'gemini-flash-medium'], suppress_args: [{ flag: '--effort', value_count: 1 }] },
        heavy: { model: 'gemini-pro-high', args: ['--model', 'gemini-pro-high'], suppress_args: [{ flag: '--effort', value_count: 1 }] },
      } });
    return { gemini: seat(), claude: seat() };
  });
  await bridge.request('/api/models?refresh=1');
  const task = 'Explain how a bounded cache works and list its invariants.';
  const planned = await bridge.request('/api/plan', { task, kind: 'gemini', modelTier: 'standard', effort: 'high', providerBudget: null });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  const plan = planned.body, execution = plan.primary.execution;
  assert.equal(execution.model, 'gemini-flash-high');
  assert.equal(execution.appliedEffort, 'high');
  const cliBody = buildAskBody(plan, task, bridge.root, 'cli:exact-model-handoff', null, 'high');
  const invoked = await bridge.request('/api/oneshot', cliBody);
  assert.equal(invoked.status, 200, JSON.stringify(invoked.body));
  assert.deepEqual(invoked.body.route.execution, execution);
  assert.equal(invoked.body.route.resolved_outgoing_model, 'gemini-flash-high');
  assert.equal(invoked.body.route.observed_model, null, 'outgoing control is not a provider-observed revision');
  const checkArgv = (model = 'gemini-flash-high') => {
    const args = completeJsonLines(marker).at(-1);
    assert.equal(args[args.indexOf('--model') + 1], model);
    assert.equal(args.filter((arg) => arg === '--model').length, 1);
    assert.equal(args.includes('--effort'), false);
  };
  checkArgv();
  const queued = await bridge.request('/api/tasks', { kind: 'gemini', prompt: task, cwd: bridge.root, execution });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  const done = await waitFor(async () => {
    const row = (await bridge.request('/api/tasks/' + queued.body.id)).body;
    return ['done', 'failed'].includes(row.status) ? row : null;
  });
  assert.equal(done.status, 'done', JSON.stringify(done)); checkArgv();
  const broadcast = await bridge.request('/api/broadcast', { providers: ['gemini'], prompt: task, cwd: bridge.root, execution });
  assert.equal(broadcast.body.results?.[0]?.ok, true, JSON.stringify(broadcast.body)); checkArgv();
  let before = completeJsonLines(marker).length;
  for (const [route, body, code] of [
    ['/api/oneshot', { kind: 'gemini', execution, effort: 'low' }, 'execution_control_conflict'],
    ['/api/tasks', { kind: 'gemini', execution, model: 'invented-model' }, 'execution_control_conflict'],
    ['/api/broadcast', { providers: ['gemini', 'claude'], execution }, 'invalid_execution_contract'],
    ['/api/oneshot', { kind: 'gemini', model: 'invented-model' }, 'model_unavailable'],
    ['/api/oneshot', { kind: 'gemini', effort: false }, 'invalid_control'],
    ['/api/tasks', { kind: 'gemini', modelTier: 7 }, 'invalid_control'],
    ['/api/plan', { kind: 'gemini', task, effort: {} }, 'invalid_control'],
  ]) {
    const rejected = await bridge.request(route, { prompt: task, cwd: bridge.root, dangerous: false, ...body });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(rejected.body.validation.code, code);
    assert.equal(rejected.body.physical_attempt_count, 0);
    assert.equal(rejected.body.model_invocation, false);
  }
  assert.equal(completeJsonLines(marker).length, before);

  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/client'), import('@modelcontextprotocol/client/stdio'),
  ]);
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp/server.mjs')], cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', RELAYBRIDGE_TEST_BUILD_ID: 'security-integration-fixture',
      RELAYBRIDGE_URL: bridge.base, RELAYBRIDGE_TOKEN_FILE: path.join(bridge.root, 'token'),
      RELAYBRIDGE_DATA_DIR: path.join(bridge.root, 'data'), RELAYBRIDGE_CONFIG_FILE: bridge.configPath }, stderr: 'pipe' });
  const client = new Client({ name: 'execution-handoff-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await transport.close(); });
  await client.connect(transport);
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  const mcpPlan = await call('plan_task', { task, kind: 'gemini', modelTier: 'standard', effort: 'high', providerBudget: null });
  assert.deepEqual(mcpPlan.primary.execution, execution);
  const request = { kind: 'gemini', prompt: task, cwd: bridge.root, execution, useCache: true, cacheTtlMs: 60000, providerBudget: null };
  const first = await call('ask_provider', request);
  assert.equal(first.exitCode, 0, JSON.stringify(first));
  assert.deepEqual(first.route.execution, execution); checkArgv();
  const cached = await call('ask_provider', { ...request, model: execution.model, taskTier: execution.resolvedTaskTier, modelTier: execution.resolvedModelTier });
  assert.equal(cached.cacheHit, true, JSON.stringify(cached));
  before = completeJsonLines(marker).length;
  const rejected = await call('ask_provider', { ...request, effort: 'low' });
  assert.equal(rejected.validation.code, 'execution_control_conflict');
  assert.equal(rejected.physicalAttemptCount, 0);
  const receipt = await call('get_receipt', { receiptId: rejected.receiptId });
  assert.equal(receipt.receipt.validation.code, 'execution_control_conflict');
  const mcpQueued = await call('submit_task', { kind: 'gemini', prompt: task, cwd: bridge.root, execution });
  assert.ok(mcpQueued.id, JSON.stringify(mcpQueued));
  const mcpDone = await waitFor(async () => {
    const row = await call('get_task', { id: mcpQueued.id });
    return ['done', 'failed'].includes(row.status) ? row : null;
  });
  assert.equal(mcpDone.status, 'done', JSON.stringify(mcpDone)); checkArgv();
  const mcpBroadcast = await call('broadcast', { providers: ['gemini'], prompt: task, cwd: bridge.root, execution });
  assert.equal(mcpBroadcast.results[0].ok, true); checkArgv();
  assert.equal(completeJsonLines(marker).length, before + 2);

  const routed = await call('route_and_ask', { task, cwd: bridge.root, preferredProviders: ['gemini'],
    maxEscalations: 0, effort: 'high', useCache: false });
  assert.equal(routed.winner?.exitCode, 0, JSON.stringify(routed));
  assert.equal(routed.winner.route.execution.model, 'gemini-flash-high');
  assert.equal(routed.winner.route.execution.appliedEffort, 'high'); checkArgv();
  const committee = await call('run_committee', { task: 'Design the architecture of a concurrent cache and explain its failure handling.',
    cwd: bridge.root, providers: ['gemini', 'claude'], maxProviders: 2, mode: 'advisory', effort: 'high', useCache: false });
  assert.equal(committee.members?.length, 2, JSON.stringify(committee));
  assert.ok(committee.members.every((member) => member.exitCode === 0 && member.route.execution.appliedEffort === 'high'), JSON.stringify(committee));

  // A successful live census changes without editing the config or the MCP
  // cache key. Admission must still reject before serving the cached answer.
  fs.writeFileSync(census, 'gemini-flash-medium\ngemini-pro-high\n');
  await bridge.request('/api/models?refresh=1');
  before = completeJsonLines(marker).length;
  const removed = await call('ask_provider', request);
  assert.equal(removed.validation.code, 'model_unavailable', JSON.stringify(removed));
  assert.equal(removed.physicalAttemptCount, 0); assert.equal(removed.cacheHit, false);
  assert.equal(completeJsonLines(marker).length, before);
  const medium = await bridge.request('/api/oneshot', { kind: 'gemini', prompt: task, cwd: bridge.root, dangerous: false,
    model: 'gemini-flash-medium', effort: 'medium' });
  assert.equal(medium.status, 200, JSON.stringify(medium.body)); checkArgv('gemini-flash-medium');
});
