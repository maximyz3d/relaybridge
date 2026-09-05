'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestBridge, waitFor, completeJsonLines } = require('./helpers/temporary-bridge');
const { buildAskBody } = require('../bin/relaybridge');
const ROOT = path.resolve(__dirname, '..');

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
