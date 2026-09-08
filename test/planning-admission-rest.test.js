'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { startTestBridge, waitFor } = require('./helpers/temporary-bridge');

test('explicit opt-in planning respects hard ceilings and routed fallback cannot restore weak seats', { timeout: 30000 }, async (t) => {
  let marker;
  const bridge = await startTestBridge(t, (root) => {
    const script = path.join(root, 'provider.js'); marker = path.join(root, 'invoked');
    fs.writeFileSync(script, "if(process.argv[2]==='--version'){process.stdout.write('v1')}else{require('fs').writeFileSync(process.argv[3],'invoked');process.stdout.write('done')}");
    const seat = { safe: [process.execPath], probe: [process.execPath, script, '--version'],
      oneshot_safe: [process.execPath, script, '{prompt_file}', marker],
      oneshot_safe_filesystem_policy: 'read_only_enforced',
      oneshot_capabilities: { safe: ['model_invocation', 'workspace_read', 'tool_use'] } };
    return { groq_llama_fast: { ...seat, label: 'opt-in fixture' }, copilot: { ...seat, label: 'standard ceiling fixture' } };
  });
  const allowed = await bridge.request('/api/plan', { kind: 'groq_llama_fast', task: 'Define a bounded term.', cwd: bridge.root });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.equal(allowed.body.primary.ready, true); assert.equal(allowed.body.primary.eligible, true);
  const task = 'Design architecture and migration for this repository.';
  const blocked = await bridge.request('/api/plan', { kind: 'copilot', task, cwd: bridge.root });
  assert.equal(blocked.status, 400, JSON.stringify(blocked.body));
  assert.equal(blocked.body.validation.code, 'ineligible_provider');
  assert.match(blocked.body.validation.reason, /tier ceiling/);
  assert.equal(blocked.body.physical_attempt_count, 0); assert.match(blocked.body.receiptId, /^rcpt_/);
  const route = await bridge.request('/api/route', { task, cwd: bridge.root, preferKinds: ['copilot', 'groq_llama_fast', 'powershell'] });
  assert.deepEqual(route.body.selected, []); assert.equal(route.body.noEligibleRoute, true);
  const [{ Client }, { StdioClientTransport }] = await Promise.all([import('@modelcontextprotocol/client'), import('@modelcontextprotocol/client/stdio')]);
  const root = path.resolve(__dirname, '..');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'mcp/server.mjs')], cwd: root,
    env: { ...process.env, NODE_ENV: 'test', RELAYBRIDGE_TEST_BUILD_ID: 'security-integration-fixture', RELAYBRIDGE_URL: bridge.base,
      RELAYBRIDGE_TOKEN_FILE: path.join(bridge.root, 'token'), RELAYBRIDGE_DATA_DIR: path.join(bridge.root, 'data'), RELAYBRIDGE_CONFIG_FILE: bridge.configPath }, stderr: 'pipe' });
  const client = new Client({ name: 'hard-routing-test', version: '1' });
  t.after(async () => { await client.close(); await transport.close(); });
  await client.connect(transport);
  const result = (await client.callTool({ name: 'route_and_ask', arguments: { task, cwd: bridge.root, preferredProviders: ['copilot'], useCache: false } })).structuredContent;
  assert.equal(result.modelInvocation, false, JSON.stringify(result)); assert.deepEqual(result.attempts, []);
  assert.equal(fs.existsSync(marker), false);
});

test('planning routes share authenticated request budget; rejected calls cannot consume it', { timeout: 30000 }, async (t) => {
  const bridge = await startTestBridge(t, () => ({}));
  for (let n = 0; n < 125; n++) {
    assert.equal((await bridge.request('/api/plan', {}, { headers: { 'Content-Type': 'application/json', 'X-RelayBridge-Token': 'wrong' } })).status, 401);
  }
  for (let n = 0; n < 120; n++) {
    assert.equal((await bridge.request(n % 2 ? '/api/plan' : '/api/route', {})).status, 400);
  }
  for (const route of ['/api/plan', '/api/route']) {
    const value = await bridge.request(route, { task: 'explain a test' });
    assert.equal(value.status, 429); assert.equal(value.body.validation.code, 'operation_rate_limit');
    assert.equal(value.body.physical_attempt_count, 0); assert.equal(value.body.model_invocation, false);
  }
});

test('concurrent alias diagnostics and caller-specific plans share only raw tags reads, cancellation is subscriber-local', { timeout: 30000 }, async (t) => {
  let gets = 0, generationRequests = 0;
  const responses = [];
  const upstream = http.createServer((req, res) => {
    if (req.url !== '/api/tags') { generationRequests++; res.writeHead(500); return res.end(); }
    gets++; responses.push(res);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const seat = (model) => ({ label: model, model, oneshot_adapter: 'ollama_api', safe: ['unused'], oneshot_safe: ['unused'], transport: 'local:ollama',
    oneshot_capabilities: { safe: ['model_invocation', 'prompt_only'] } });
  const bridge = await startTestBridge(t, () => ({ ollama: seat('present'), ollama_coder: seat('absent'), ollama_fast: seat('present') }),
    { env: { RELAYBRIDGE_OLLAMA_URL: `http://127.0.0.1:${upstream.address().port}` } });
  const cancelled = new AbortController();
  const first = bridge.request('/api/plan', { task: 'Explain a small unit test', kind: 'ollama' }, { signal: cancelled.signal });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  const second = bridge.request('/api/plan', { task: 'Describe a different concept', kind: 'ollama_fast' });
  const diagnostics = bridge.request('/api/diag');
  await waitFor(() => gets > 0);
  // Ping is queued behind already-arrived HTTP request handlers, so their
  // subscriptions are established without releasing the upstream response.
  await bridge.request('/api/health');
  cancelled.abort(); await rejected;
  assert.equal(responses[0].destroyed, false);
  responses.forEach((response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ models: [{ name: 'present' }] })); });
  const [plan, diag] = await Promise.all([second, diagnostics]);
  assert.equal(gets, 1);
  assert.equal(generationRequests, 0);
  assert.equal(plan.status, 200); assert.equal(plan.body.primary.kind, 'ollama_fast');
  assert.equal(diag.body.results.ollama.ready, true);
  assert.equal(diag.body.results.ollama_coder.ready, false);
  assert.equal(diag.body.results.ollama.authAuthoritative, false);
  assert.equal(diag.body.results.ollama.transientProbeFailure, false);
});
