'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { startTestBridge, waitFor, completeJsonLines } = require('./helpers/temporary-bridge');
const { prepareGroundedPrompt } = require('../lib/workspace-grounding');
const ROOT = path.resolve(__dirname, '..');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('grounding is a zero-spend gate across plans, REST, CLI, queue, broadcast and MCP cache', { timeout: 30000 }, async (t) => {
  const httpCalls = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ models: [{ name: 'fixture' }] })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    httpCalls.push(JSON.parse(raw));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ response: 'Completed analysis of the supplied fixture.', model: 'fixture', done: true, prompt_eval_count: 12, eval_count: 8 }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  let cliMarker;
  const bridge = await startTestBridge(t, (root) => {
    const script = path.join(root, 'provider.js'); cliMarker = path.join(root, 'calls.jsonl');
    fs.writeFileSync(script, "const fs=require('fs');if(process.argv[2]==='--version'){process.stdout.write('v1');process.exit(0)};const prompt=fs.readFileSync(process.argv[2],'utf8');fs.appendFileSync(process.argv[3],JSON.stringify({prompt})+'\\n');process.stdout.write('Completed fixture analysis.');");
    const cli = { label: 'CLI fixture', safe: [process.execPath], probe: [process.execPath, script, '--version'],
      oneshot_safe: [process.execPath, script, '{prompt_file}', cliMarker], oneshot_safe_filesystem_policy: 'read_only_enforced' };
    const local = { label: 'Prompt-only fixture', safe: [process.execPath], oneshot_safe: [process.execPath],
      model: 'fixture', models_static: ['fixture'], oneshot_adapter: 'ollama_api', oneshot_safe_filesystem_policy: 'read_only_enforced',
      workspaceAccess: true, oneshot_capabilities: { safe: ['model_invocation', 'workspace_read', 'tool_use'] } };
    return { ollama_coder: local, unknown_cli: cli,
      claude: { ...cli, oneshot_capabilities: { safe: ['model_invocation', 'workspace_read', 'tool_use'] } } };
  }, { env: { RELAYBRIDGE_OLLAMA_URL: `http://127.0.0.1:${upstream.address().port}` } });
  const prompt = 'Return concrete findings.';
  const required = { kind: 'ollama_coder', prompt, cwd: bridge.root, dangerous: false, requiresWorkspaceAccess: true };
  for (const body of [required, { ...required, prompt: 'Review src/a.js.', requiresWorkspaceAccess: false },
    { ...required, groundingOverride: true }, { ...required, kind: 'unknown_cli' }]) {
    const response = await bridge.request('/api/oneshot', body);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.failureClass, 'workspace_grounding'); assert.equal(response.body.model_invocation, false);
    assert.equal(response.body.physical_attempt_count, 0); assert.match(response.body.receiptId, /^rcpt_/);
  }
  assert.equal((await bridge.request('/api/tasks', required)).body.failureClass, 'workspace_grounding');
  assert.equal((await bridge.request('/api/broadcast', { ...required, providers: ['claude', 'ollama_coder'] })).body.failureClass, 'workspace_grounding');
  const plan = await bridge.request('/api/plan', { ...required, task: prompt });
  assert.equal(plan.body.failureClass, 'workspace_grounding');
  const route = await bridge.request('/api/route', { task: 'Review src/a.js.', cwd: bridge.root, preferKinds: ['ollama_coder'] });
  assert.equal(route.status, 200, JSON.stringify(route.body));
  assert.equal(route.body.selected.some((row) => row.kind === 'ollama_coder'), false);
  assert.equal(route.body.fleetState.groundingSkipped.some((row) => row.kind === 'ollama_coder'), true);
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'bin/relaybridge.js'), 'ask', '--kind', 'ollama_coder',
    '--requires-workspace-access', prompt], { cwd: bridge.root, env: { ...process.env, RELAYBRIDGE_URL: bridge.base,
      RELAYBRIDGE_TOKEN_FILE: path.join(bridge.root, 'token') }, encoding: 'utf8' });
  assert.notEqual(cli.status, 0); assert.match(cli.stderr, /cannot read the workspace/);
  assert.equal(httpCalls.length, 0); assert.equal(completeJsonLines(cliMarker).length, 0);

  const identity = (await bridge.request('/api/workspace/validate', { cwd: bridge.root })).body.cwdIdentityHash;
  const content = 'src/a.js\r\nexport const π = "雪";\r\n';
  const inlineEvidence = { content, sha256: sha(content), cwdIdentityHash: identity };
  for (const patch of [{ sha256: 'a'.repeat(64) }, { cwdIdentityHash: 'b'.repeat(64) }]) {
    const rejected = await bridge.request('/api/oneshot', { ...required, inlineEvidence: { ...inlineEvidence, ...patch } });
    assert.equal(rejected.body.model_invocation, false); assert.equal(rejected.body.errorCode, 'invalid_grounding');
  }
  const admitted = await bridge.request('/api/oneshot', { ...required, inlineEvidence });
  assert.equal(admitted.status, 200, JSON.stringify(admitted.body));
  assert.equal(admitted.body.grounding.mode, 'inline_evidence');
  assert.equal(admitted.body.grounding.hasAccess, false);
  const expected = prepareGroundedPrompt({ ...required, cwdIdentityHash: identity, seat: 'ollama_coder', inlineEvidence }).prompt;
  assert.equal(httpCalls[0].prompt, expected); assert.equal(httpCalls[0].prompt.split(content).length, 2);
  assert.equal(admitted.body.route.prompt_evidence.effectiveHash, sha(expected));
  const receipt = completeJsonLines(path.join(bridge.root, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'))
    .find((row) => row.receiptId === admitted.body.receiptId);
  assert.deepEqual(receipt.grounding, admitted.body.grounding); assert.equal(JSON.stringify(receipt).includes(content), false);

  const queued = (await bridge.request('/api/tasks', { ...required, inlineEvidence })).body;
  assert.ok(queued.id, JSON.stringify(queued));
  await waitFor(async () => (await bridge.request('/api/tasks/' + queued.id)).body.status === 'done');
  assert.equal(httpCalls.at(-1).prompt, expected);
  const broadcast = (await bridge.request('/api/broadcast', { ...required, providers: ['claude', 'ollama_coder'], inlineEvidence })).body;
  assert.equal(broadcast.results.every((row) => row.ok), true, JSON.stringify(broadcast));
  assert.equal(httpCalls.at(-1).prompt, expected); assert.equal(completeJsonLines(cliMarker).at(-1).prompt, expected);

  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/client'), import('@modelcontextprotocol/client/stdio'),
  ]);
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp/server.mjs')], cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', RELAYBRIDGE_TEST_BUILD_ID: 'security-integration-fixture',
      RELAYBRIDGE_URL: bridge.base, RELAYBRIDGE_TOKEN_FILE: path.join(bridge.root, 'token'),
      RELAYBRIDGE_DATA_DIR: path.join(bridge.root, 'data'), RELAYBRIDGE_CONFIG_FILE: bridge.configPath }, stderr: 'pipe' });
  const client = new Client({ name: 'grounding-test', version: '1' });
  t.after(async () => { await client.close(); await transport.close(); });
  await client.connect(transport);
  const ask = async (args) => (await client.callTool({ name: 'ask_provider', arguments: { kind: 'ollama_coder', prompt,
    cwd: bridge.root, useCache: true, ...args } })).structuredContent;
  assert.equal((await ask({})).modelInvocation, true);
  assert.equal((await ask({})).cacheHit, true);
  const before = httpCalls.length;
  const blocked = await ask({ requiresWorkspaceAccess: true });
  assert.equal(blocked.failureClass, 'workspace_grounding'); assert.equal(blocked.cacheHit, false);
  assert.equal(blocked.modelInvocation, false); assert.equal(httpCalls.length, before);
  const grounded = await ask({ requiresWorkspaceAccess: true, inlineEvidence });
  assert.equal(grounded.modelInvocation, true, JSON.stringify(grounded)); assert.equal(grounded.grounding.mode, 'inline_evidence');
  assert.equal((await ask({ requiresWorkspaceAccess: true, inlineEvidence })).cacheHit, true);
  for (const receiptId of [grounded.receiptId, grounded.transportReceiptId]) {
    const row = (await client.callTool({ name: 'get_receipt', arguments: { receiptId } })).structuredContent.receipt;
    assert.deepEqual(row.grounding, grounded.grounding);
  }
  const badCwd = await ask({ requiresWorkspaceAccess: true, inlineEvidence, cwd: path.dirname(bridge.root) });
  assert.equal(badCwd.modelInvocation, false); assert.equal(badCwd.errorCode, 'cwd_outside_allowed_roots');
  const padding = 'x'.repeat(24000 - expected.length);
  const atLimit = await bridge.request('/api/oneshot', { ...required, prompt: prompt + padding, inlineEvidence });
  assert.equal(atLimit.status, 200, JSON.stringify(atLimit.body)); assert.equal(httpCalls.at(-1).prompt.length, 24000);
  const count = httpCalls.length;
  const oversized = await bridge.request('/api/oneshot', { ...required, prompt: prompt + padding + 'x', inlineEvidence });
  assert.equal(oversized.body.errorCode, 'prompt_too_large'); assert.equal(oversized.body.model_invocation, false);
  assert.equal(httpCalls.length, count);
  const impossiblePlan = await bridge.request('/api/plan', { ...required, task: prompt + padding + 'x', inlineEvidence });
  assert.equal(impossiblePlan.body.errorCode, 'prompt_too_large'); assert.equal(impossiblePlan.body.model_invocation, false);
  const impossibleRoute = (await bridge.request('/api/route', { task: prompt + padding + 'x', cwd: bridge.root,
    requiresWorkspaceAccess: true, inlineEvidence, preferKinds: ['ollama_coder'] })).body;
  assert.equal(impossibleRoute.selected.some((row) => row.kind === 'ollama_coder'), false);
  assert.equal(impossibleRoute.candidates.find((row) => row.kind === 'ollama_coder').ready, false);

  const largeContent = 'e'.repeat(10000);
  const largeEvidence = { content: largeContent, sha256: sha(largeContent), cwdIdentityHash: identity };
  const callsBefore = completeJsonLines(cliMarker).length;
  const oversizedRouted = (await client.callTool({ name: 'route_and_ask', arguments: { task: prompt, cwd: bridge.root,
    requiresWorkspaceAccess: true, inlineEvidence: largeEvidence, preferredProviders: ['claude'], maxEscalations: 0, useCache: false } })).structuredContent;
  assert.equal(oversizedRouted.attempts[0].modelInvocation, false, JSON.stringify(oversizedRouted));
  assert.equal(oversizedRouted.attempts[0].errorCode, 'prompt_too_large');
  const oversizedCommittee = (await client.callTool({ name: 'run_committee', arguments: { task: 'Review src/a.js.', cwd: bridge.root,
    requiresWorkspaceAccess: true, inlineEvidence: largeEvidence, providers: ['claude'], maxProviders: 1, useCache: false } })).structuredContent;
  assert.equal(oversizedCommittee.blocked, true); assert.equal(oversizedCommittee.members.length, 0);
  assert.equal(oversizedCommittee.errorCode, 'prompt_too_large');
  assert.equal(completeJsonLines(cliMarker).length, callsBefore, 'tier/member semantic caps include the complete inline bundle');
  const filesystemCommittee = (await client.callTool({ name: 'run_committee', arguments: { task: 'Review src/a.js.', cwd: bridge.root,
    requiresWorkspaceAccess: true, providers: ['claude'], maxProviders: 1, useCache: false } })).structuredContent;
  assert.equal(filesystemCommittee.members[0].modelInvocation, true, JSON.stringify(filesystemCommittee));
  const memberPrompt = completeJsonLines(cliMarker).at(-1).prompt;
  assert.match(memberPrompt, /permitted read-only inspection tools/); assert.match(memberPrompt, /Do not edit files/);
  assert.doesNotMatch(memberPrompt, /Do not edit files, run tools/);
});
