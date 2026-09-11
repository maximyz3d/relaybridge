'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { startTestBridge, waitFor, completeJsonLines } = require('./helpers/temporary-bridge');

async function fixture(t, { supervisor = { idleMs: 1000, hardCapMs: 3000 } } = {}) {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end('{"models":[{"name":"fixture"}]}'); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ body: JSON.parse(raw), res });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const bridge = await startTestBridge(t, () => ({ _supervisor: supervisor, ollama_fast: {
    label: 'HTTP lifecycle fixture', model: 'fixture', models_static: ['fixture'], oneshot_adapter: 'ollama_api',
    safe: [process.execPath], oneshot_safe: [process.execPath], oneshot_safe_filesystem_policy: 'read_only_enforced',
    oneshot_capabilities: { safe: ['model_invocation', 'prompt_only'] },
  } }), { env: { RELAYBRIDGE_MAX_ACTIVE_PER_PROVIDER: '1', RELAYBRIDGE_OLLAMA_URL: `http://127.0.0.1:${upstream.address().port}` } });
  const receipts = () => completeJsonLines(path.join(bridge.root, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'));
  return { bridge, requests, receipts };
}

test('normal shutdown refuses an admitted HTTP model call until its transport settles', {timeout:15000}, async t => {
  const {bridge,requests} = await fixture(t);
  const pending = bridge.request('/api/oneshot', {kind:'ollama_fast',prompt:'bounded shutdown fixture',dangerous:false});
  await waitFor(() => requests.length === 1);
  const busy = await bridge.request('/api/admin/shutdown', {});
  assert.equal(busy.status, 409); assert.equal(busy.body.code, 'BRIDGE_BUSY');
  assert.equal(busy.body.busy.oneShots, 1);
  requests[0].res.end('{"response":"Completed normally.","done":true}');
  const result = (await pending).body;
  assert.equal(result.stdout, 'Completed normally.'); assert.equal(result.dropped_out, false);
  await waitFor(async () => (await bridge.request('/api/runs/active')).body.count === 0);
  assert.equal((await bridge.request('/api/admin/shutdown', {})).status, 200);
  await waitFor(() => bridge.proc.exitCode !== null);
});

test('HTTP >10KB prompt is active before first byte and streams under the same durable run identity', { timeout: 15000 }, async (t) => {
  const { bridge, requests, receipts } = await fixture(t);
  const pending = bridge.request('/api/oneshot', { kind: 'ollama_fast', prompt: 'x'.repeat(12001), requestId: 'http-lifecycle-stream', dangerous: false });
  await waitFor(() => requests.length === 1);
  assert.equal(requests[0].body.stream, true); assert.equal(requests[0].body.prompt.length, 12001);
  const active = (await bridge.request('/api/runs/active')).body.runs[0];
  assert.equal(active.pid, null); assert.equal(active.cpuMs, null); assert.equal(active.cpuUnavailable, true);
  assert.equal(active.route.request_id, 'http-lifecycle-stream'); assert.equal(active.transportLifecycle.dispatched, true);
  const duplicate = await bridge.request('/api/oneshot', { kind: 'ollama_fast', prompt: 'another bounded call', dangerous: false });
  assert.equal(duplicate.status, 429); assert.equal(duplicate.body.failureClass, 'admission_limit');
  assert.equal(duplicate.body.physical_attempt_count, 0); assert.equal(requests.length, 1);
  const response = requests[0].res; response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  const delta = Buffer.from('{"response":"First π.","done":false}\n');
  response.write(delta.subarray(0, 22)); response.write(delta.subarray(22));
  await waitFor(async () => (await bridge.request('/api/runs/active')).body.runs[0]?.bytes > 0);
  response.end('{"response":" Completed.","done":true,"model":"fixture","prompt_eval_count":12,"eval_count":6}');
  const result = (await pending).body;
  assert.equal(result.stdout, 'First π. Completed.'); assert.equal(result.dropped_out, false);
  assert.equal(result.runId, active.runId); assert.equal(result.route.run_id, active.runId);
  assert.equal(result.physical_attempt_count, 1); assert.equal(result.usage.total_tokens, 18);
  assert.equal(result.transport_lifecycle.physicalEvidence, 'http_transport_settled');
  assert.equal(result.transport_lifecycle.cleanupStatus, 'complete');
  const receipt = receipts().find((row) => row.receiptId === result.receiptId);
  assert.equal(receipt.runId, active.runId); assert.equal(receipt.requestId, active.route.request_id);
  assert.equal(receipt.physicalAttemptCount, 1); assert.equal(receipt.transportLifecycle.transport.remoteTermination, 'unverified');
  await waitFor(async () => (await bridge.request('/api/runs/active')).body.count === 0);
});

test('HTTP disconnect persists one terminal receipt after local cleanup, hard cap settles silent transport', { timeout: 15000 }, async (t) => {
  const { bridge, requests, receipts } = await fixture(t);
  const controller = new AbortController();
  const pending = bridge.request('/api/oneshot', { kind: 'ollama_fast', prompt: 'bounded disconnect', requestId: 'http-lifecycle-cancel', dangerous: false }, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await waitFor(() => requests.length === 1);
  requests[0].res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  requests[0].res.write('{"response":"Partial progress.","done":false}\n');
  await waitFor(async () => (await bridge.request('/api/runs/active')).body.runs[0]?.bytes > 0);
  controller.abort(); await rejected;
  await waitFor(() => receipts().some((row) => row.requestId === 'http-lifecycle-cancel'));
  const cancelled = receipts().filter((row) => row.requestId === 'http-lifecycle-cancel');
  assert.equal(cancelled.length, 1); assert.equal(cancelled[0].status, 'cancelled');
  assert.equal(cancelled[0].modelInvocation, true); assert.equal(cancelled[0].physicalAttemptCount, 1);
  assert.equal(cancelled[0].transportLifecycle.physicalEvidence, 'http_transport_settled');
  assert.equal(cancelled[0].transportLifecycle.cleanupStatus, 'complete');
  await waitFor(async () => (await bridge.request('/api/runs/active')).body.count === 0);
  const silent = bridge.request('/api/oneshot', { kind: 'ollama_fast', prompt: 'silent bounded request', requestId: 'http-lifecycle-silent', dangerous: false });
  await waitFor(() => requests.length === 2);
  const timed = (await silent).body;
  assert.equal(timed.failureClass, 'timeout'); assert.equal(timed.stop_reason, 'hard_cap');
  assert.equal(timed.timed_out, true); assert.equal(timed.model_invocation, null);
  assert.equal(timed.route.effective_timeout_ms, 3000);
  await waitFor(async () => (await bridge.request('/api/runs/active')).body.count === 0);
});

test('MCP HTTP result and both receipt layers preserve physical lifecycle identity', { timeout: 15000 }, async (t) => {
  const { bridge, requests, receipts } = await fixture(t);
  const [{ Client }, { StdioClientTransport }] = await Promise.all([import('@modelcontextprotocol/client'), import('@modelcontextprotocol/client/stdio')]);
  const root = path.resolve(__dirname, '..');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'mcp/server.mjs')], cwd: root,
    env: { ...process.env, NODE_ENV: 'test', RELAYBRIDGE_TEST_BUILD_ID: 'security-integration-fixture', RELAYBRIDGE_URL: bridge.base,
      RELAYBRIDGE_TOKEN_FILE: path.join(bridge.root, 'token'), RELAYBRIDGE_DATA_DIR: path.join(bridge.root, 'data'), RELAYBRIDGE_CONFIG_FILE: bridge.configPath }, stderr: 'pipe' });
  const client = new Client({ name: 'http-lifecycle-test', version: '1' });
  t.after(async () => { await client.close(); await transport.close(); }); await client.connect(transport);
  const pending = client.callTool({ name: 'ask_provider', arguments: { kind: 'ollama_fast', prompt: 'bounded MCP transport', cwd: bridge.root, useCache: false } });
  await waitFor(() => requests.length === 1);
  requests[0].res.end('{"done":true,"response":"Completed bounded response.","model":"fixture","prompt_eval_count":12,"prompt_eval_cached_count":7,"eval_count":6}');
  const result = (await pending).structuredContent;
  assert.equal(result.stdout, 'Completed bounded response.', JSON.stringify(result));
  assert.equal(result.usage.total_tokens, 18); assert.equal(result.usage.cache_read_input_tokens, 7);
  assert.equal(result.providerTerminalCompatibility, 'ollama_done_without_reason_v1');
  assert.equal(result.providerRunId, result.route.run_id); assert.equal(result.transportLifecycle.runId, result.providerRunId);
  for (const receiptId of [result.receiptId, result.transportReceiptId]) {
    const row = receipts().find((receipt) => receipt.receiptId === receiptId);
    assert.equal(row.transportLifecycle.runId, result.providerRunId);
    assert.equal(row.transportLifecycle.physicalEvidence, 'http_transport_settled');
    assert.equal(row.physicalAttemptCount, 1);
    assert.equal(row.actualTotalTokens, 18); assert.equal(row.cacheInputIncluded, true);
  }
});

test('explicit HTTP timeout is not widened to the default twenty-minute idle window', { timeout: 15000 }, async (t) => {
  const { bridge } = await fixture(t, { supervisor: {} });
  const started = Date.now();
  const result = (await bridge.request('/api/oneshot', { kind: 'ollama_fast', prompt: 'bounded explicit deadline', timeoutMs: 1000, dangerous: false })).body;
  assert.equal(result.stop_reason, 'hard_cap'); assert.equal(result.route.effective_timeout_ms, 1000);
  assert.ok(Date.now() - started < 5000, 'caller deadline must remain an absolute ceiling');
});

test('validated HTTP terminal seals before EOF and survives disconnect with full accepted usage', { timeout: 15000 }, async (t) => {
  const { bridge, requests, receipts } = await fixture(t);
  const controller = new AbortController();
  const pending = bridge.request('/api/oneshot', { kind: 'ollama_fast', prompt: 'terminal before disconnect', requestId: 'sealed-terminal', dangerous: false }, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await waitFor(() => requests.length === 1);
  requests[0].res.write('{"done":true,"done_reason":"stop","response":"Completed answer.","prompt_eval_count":12,"eval_count":6}\n');
  await waitFor(async () => (await bridge.request('/api/runs/active')).body.runs[0]?.transportLifecycle.outcomeSealed === true);
  controller.abort(); await rejected;
  const active = (await bridge.request('/api/runs/active')).body.runs[0];
  assert.equal(active.transportLifecycle.stop, null); assert.equal(active.transportLifecycle.phase, 'draining');
  const blocked = await bridge.request('/api/oneshot', { kind: 'ollama_fast', prompt: 'drain admission', dangerous: false });
  assert.equal(blocked.status, 429);
  // Leave EOF open: only the physical-drain ceiling may abort this transport.
  await waitFor(() => receipts().some((row) => row.requestId === 'sealed-terminal'), 6000);
  const rows = receipts().filter((row) => row.requestId === 'sealed-terminal');
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'completed');
  assert.equal(rows[0].actualInputTokens, 12); assert.equal(rows[0].actualOutputTokens, 6); assert.equal(rows[0].actualTotalTokens, 18);
  assert.equal(rows[0].transportLifecycle.stop, null); assert.equal(rows[0].transportLifecycle.drainStop.reason, 'physical_drain_timeout');
  assert.equal(rows[0].transportDiagnosticCode, 'http_drain_aborted');
});

test('late malformed frames cannot rewrite a sealed terminal or its accepted usage', { timeout: 15000 }, async (t) => {
  const { bridge, requests, receipts } = await fixture(t);
  const pending = bridge.request('/api/oneshot', { kind: 'ollama_fast', prompt: 'terminal then malformed', dangerous: false });
  await waitFor(() => requests.length === 1);
  requests[0].res.end('{"done":true,"done_reason":"stop","response":"Completed answer.","prompt_eval_count":12,"prompt_eval_cached_count":7,"eval_count":6}\n{malformed}\n');
  const result = (await pending).body;
  assert.equal(result.stdout, 'Completed answer.'); assert.equal(result.usage.input_tokens, 12);
  assert.equal(result.transport_diagnostic_code, 'http_conflicting_terminal');
  const row = receipts().find((entry) => entry.receiptId === result.receiptId);
  assert.equal(row.actualTotalTokens, 18); assert.equal(row.transportDiagnosticCode, result.transport_diagnostic_code);
  assert.equal(row.actualCacheReadInputTokens, 7); assert.equal(row.cacheInputIncluded, true);
});

test('Ollama truncation/tool/admin terminals retain evidence without successful output', { timeout: 15000 }, async (t) => {
  const { bridge, requests } = await fixture(t);
  for (const [reason, failure] of [['length', 'max_tokens'], ['load', 'provider_incomplete_response'], ['unknown', 'provider_incomplete_response']]) {
    const index = requests.length;
    const pending = bridge.request('/api/oneshot', { kind: 'ollama_fast', prompt: `terminal ${reason}`, dangerous: false });
    await waitFor(() => requests.length === index + 1);
    requests[index].res.end(JSON.stringify({ done: true, done_reason: reason, response: 'Unfinished answer.', prompt_eval_count: 12, eval_count: 6 }));
    const result = (await pending).body;
    assert.equal(result.failureClass, failure); assert.equal(result.stdout, ''); assert.equal(result.partial_result, true);
    assert.equal(result.provider_stop_reason, reason); assert.equal(result.usage.total_tokens, 18); assert.equal(result.dropped_out, true);
  }
});

test('oversized HTTP error body preserves known status and physical invocation evidence', { timeout: 15000 }, async (t) => {
  const { bridge, requests } = await fixture(t);
  const pending = bridge.request('/api/oneshot', { kind: 'ollama_fast', prompt: 'bounded provider quota failure', dangerous: false });
  await waitFor(() => requests.length === 1);
  requests[0].res.writeHead(429); requests[0].res.end('x'.repeat(65537));
  const result = (await pending).body;
  assert.equal(result.exitCode, 429); assert.equal(result.provider_api_error_status, 429); assert.equal(result.rate_limited, true);
  assert.equal(result.transport_diagnostic_code, 'http_wire_limit'); assert.equal(result.model_invocation, false);
  assert.equal(result.physical_attempt_count, 1); assert.equal(result.failureClass, 'rate_limit');
});
