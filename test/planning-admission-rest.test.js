'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startTestBridge, waitFor } = require('./helpers/temporary-bridge');

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
  const seat = (model) => ({ label: model, model, oneshot_adapter: 'ollama_api', safe: ['unused'], oneshot_safe: ['unused'], transport: 'local:ollama' });
  const bridge = await startTestBridge(t, () => ({ ollama: seat('present'), ollama_coder: seat('absent'), ollama_fast: seat('present') }),
    { env: { RELAYBRIDGE_OLLAMA_URL: `http://127.0.0.1:${upstream.address().port}` } });
  const cancelled = new AbortController();
  const first = bridge.request('/api/plan', { task: 'Explain a small unit test', kind: 'ollama' }, { signal: cancelled.signal });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  const second = bridge.request('/api/plan', { task: 'Describe a different function', kind: 'ollama_fast' });
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
