'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { startTestBridge } = require('./helpers/temporary-bridge');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('complete argv prompt reaches provider literally; +1 is a typed zero-attempt rejection', { timeout: 30000 }, async (t) => {
  let marker;
  const bridge = await startTestBridge(t, (root) => {
    const script = path.join(root, 'echo.js'); marker = path.join(root, 'invocations');
    fs.writeFileSync(script, "const fs=require('fs');fs.appendFileSync(process.argv[2],'called\\n');process.stdout.write(process.argv[3]);");
    return { fixture: { label: 'literal argv', prompt_max_chars: 24000,
      oneshot_safe: [process.execPath, script, marker, '{prompt}'] } };
  });
  const tail = " $& $$ $` $' {cwd} {prompt_file} {prompt} 世界 END";
  const prompt = 'HEAD' + 'x'.repeat(24000 - tail.length - 4) + tail;
  const accepted = await bridge.request('/api/oneshot', { kind: 'fixture', prompt, dangerous: false, cwd: bridge.root });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.stdout, prompt);
  assert.equal(accepted.body.route.prompt_evidence.effectiveHash, hash(prompt));
  assert.equal(accepted.body.route.prompt_evidence.originalChars, 24000);
  const before = fs.readFileSync(marker, 'utf8');
  const rejected = await bridge.request('/api/oneshot', { kind: 'fixture', prompt: prompt + '!', dangerous: false, cwd: bridge.root });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.validation.code, 'prompt_too_large');
  assert.equal(rejected.body.validation.inputHash, hash(prompt + '!'));
  assert.equal(rejected.body.model_invocation, false);
  assert.equal(rejected.body.physical_attempt_count, 0);
  assert.equal(rejected.body.token_usage_source, 'not_invoked');
  assert.deepEqual(fs.readFileSync(marker, 'utf8'), before);
  assert.equal(rejected.body.receiptPersisted, true);
});

test('wrapper semantic stdin limit rejects before wrapper startup, despite immediate full-input transport', async (t) => {
  let marker;
  const bridge = await startTestBridge(t, (root) => {
    marker = path.join(root, 'must-not-exist');
    const script = path.join(root, 'wrapper.js');
    fs.writeFileSync(script, "require('fs').writeFileSync(process.argv[2],'started');");
    return { fixture: { oneshot_safe: [process.execPath, script, marker], prompt_input_max_chars: 12000 } };
  });
  const result = await bridge.request('/api/oneshot', { kind: 'fixture', prompt: 'x'.repeat(12001), dangerous: false });
  assert.equal(result.status, 400);
  assert.equal(result.body.validation.transport, 'stdin');
  assert.equal(result.body.validation.maxChars, 12000);
  assert.equal(result.body.physical_attempt_count, 0);
  assert.equal(fs.existsSync(marker), false);
});

test('local HTTP adapter preserves boundary input and accepts omitted/null budgets; +1 makes zero POSTs', { timeout: 30000 }, async (t) => {
  const posts = [];
  const upstream = http.createServer((req, res) => {
    let text = ''; req.on('data', (part) => { text += part; });
    req.on('end', () => {
      if (req.url !== '/api/generate') { res.writeHead(500); return res.end(); }
      posts.push(JSON.parse(text));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'fixture', response: 'complete answer', done: true, prompt_eval_count: 4, eval_count: 3 }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const bridge = await startTestBridge(t, () => ({ fixture: { model: 'fixture', oneshot_adapter: 'ollama_api',
    oneshot_safe: ['unused'], prompt_max_chars: 100, oneshot_safe_prompt_prefix: 'READ ONLY' } }),
  { env: { RELAYBRIDGE_OLLAMA_URL: `http://127.0.0.1:${upstream.address().port}` } });
  const prompt = 'HEAD' + 'x'.repeat(90) + 'TAIL!!';
  for (const budget of [undefined, null, { maxTurns: null }]) {
    const result = await bridge.request('/api/oneshot', { kind: 'fixture', prompt, dangerous: false, providerBudget: budget });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.stdout, 'complete answer');
    const effective = `READ ONLY\n\nUser request:\n${prompt}`;
    assert.equal(posts.at(-1).prompt, effective);
    assert.equal(result.body.route.prompt_evidence.effectiveHash, hash(effective));
  }
  const rejected = await bridge.request('/api/oneshot', { kind: 'fixture', prompt: prompt + '!', dangerous: false });
  assert.equal(rejected.status, 400); assert.equal(rejected.body.physical_attempt_count, 0);
  assert.equal(posts.length, 3);
});
