'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { receiptStoreIdentity } = require('../lib/receipt-store-identity.cjs');

let bridgeRequest, server, handler, data, receiptStoreId;
const buildId = 'mcp-transport-fixture';
const token = 'a'.repeat(64);
const savedEnvironment = new Map();

test.before(async () => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-mcp-transport-'));
  receiptStoreId = receiptStoreIdentity(data).id;
  server = http.createServer((req, res) => {
    if (req.url === '/api/health') return res.end(JSON.stringify({
      capabilityAuth: true, buildIdentityReady: true, buildId, receiptStoreId,
    }));
    handler(req, res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  for (const [key, value] of Object.entries({ NODE_ENV: 'test',
    RELAYBRIDGE_TEST_BUILD_ID: buildId, RELAYBRIDGE_DATA_DIR: data,
    RELAYBRIDGE_TOKEN: token, RELAYBRIDGE_URL: `http://127.0.0.1:${server.address().port}` })) {
    savedEnvironment.set(key, process.env[key]); process.env[key] = value;
  }
  ({ bridgeRequest } = await import('../mcp/bridge-client.mjs'));
});

test.after(async () => {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(data, { recursive: true, force: true });
});

test('buffered one-shots keep their deadline independently of fetch header limits', async t => {
  let fetchCalls = 0, observed;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls++;
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('accelerated headers deadline'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) });
  });
  handler = async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    observed = { headers: req.headers, body: JSON.parse(raw) };
    setTimeout(() => res.end(JSON.stringify({ stdout: 'complete 😀 output' })), 80);
  };
  const before = Date.now();
  const result = await bridgeRequest('/api/oneshot', { method: 'POST',
    timeoutMs: 900000, body: { prompt: 'literal 😀 prompt', requestId: 'transport-regression' } });
  assert.equal(result.stdout, 'complete 😀 output');
  assert.equal(result.actionPreflight.ok, true);
  assert.equal(fetchCalls, 0, 'the buffered call must not inherit fetch header/body ceilings');
  assert.equal(observed.headers['x-relaybridge-token'], token);
  assert.equal(observed.headers['x-relaybridge-expected-build-id'], buildId);
  assert.equal(observed.headers['x-relaybridge-expected-receipt-store-id'], receiptStoreId);
  assert.ok(Number(observed.headers['x-relaybridge-client-deadline-at']) >= before + 900000);
  assert.equal(observed.body.prompt, 'literal 😀 prompt');
});

test('pre-aborted calls never dispatch and preserve the caller reason', async () => {
  let calls = 0; handler = (_req, res) => { calls++; res.end('{}'); };
  const reason = new Error('caller stopped');
  await assert.rejects(bridgeRequest('/api/test', { signal: AbortSignal.abort(reason) }), error => error.cause === reason);
  assert.equal(calls, 0);
});

for (const phase of ['headers', 'body']) {
  test(`caller cancellation closes the socket during ${phase}`, async () => {
    const controller = new AbortController();
    let resolveStarted, resolveClosed;
    const started = new Promise(resolve => { resolveStarted = resolve; });
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    handler = (_req, res) => {
      res.once('close', resolveClosed);
      if (phase === 'body') { res.writeHead(200); res.write('{"partial":'); }
      resolveStarted();
    };
    const pending = bridgeRequest('/api/test', { signal: controller.signal });
    const reason = new Error('bounded cancellation');
    const rejected = assert.rejects(pending, error => error.cause === reason);
    await started; controller.abort(reason);
    await rejected; await closed;
  });
}

for (const phase of ['headers', 'body']) test(`the request deadline covers stalled ${phase}`, async () => {
  let resolveClosed; const closed = new Promise(resolve => { resolveClosed = resolve; });
  handler = (_req, res) => {
    res.once('close', resolveClosed);
    if (phase === 'body') { res.writeHead(200); res.write('{'); }
  };
  await assert.rejects(bridgeRequest('/api/test', { timeoutMs: 1000 }), error => error.cause?.name === 'TimeoutError');
  await closed;
});

test('redirects cannot forward a capability token and HTTP failures retain their detail', async () => {
  let calls = 0;
  handler = (_req, res) => { calls++; res.writeHead(302, { Location: '/api/redirect-target' }); res.end(); };
  await assert.rejects(bridgeRequest('/api/test'), /redirect refused/);
  assert.equal(calls, 1);
  handler = (_req, res) => { res.writeHead(409); res.end('{"code":"BRIDGE_BUSY"}'); };
  await assert.rejects(bridgeRequest('/api/test'), error => error.status === 409 && error.detail.code === 'BRIDGE_BUSY');
});

test('truncated and oversized responses fail without a partial success', async () => {
  let calls = 0;
  handler = (_req, res) => { calls++; res.writeHead(200, { 'Content-Length': 100 }); res.write('{'); res.socket.end(); };
  await assert.rejects(bridgeRequest('/api/oneshot', { method: 'POST', body: { requestId: 'do-not-replay' } }), /RelayBridge request failed/);
  assert.equal(calls, 1, 'a failed POST must never be automatically repeated');
  handler = (_req, res) => { res.writeHead(200, { 'Content-Length': 128 * 1024 * 1024 + 1 }); res.flushHeaders(); };
  await assert.rejects(bridgeRequest('/api/test'), /transport size limit/);
});
