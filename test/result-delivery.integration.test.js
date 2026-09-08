'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startTestBridge, waitFor, completeJsonLines } = require('./helpers/temporary-bridge');

test('REST queued delivery returns before execution, retrieves exact sanitized bytes and acknowledges without replay', async t => {
  let capture, release;
  const bridge = await startTestBridge(t, root => {
    capture = path.join(root, 'calls.jsonl'); release = path.join(root, 'release');
    const script = path.join(root, 'provider.cjs');
    fs.writeFileSync(script, `const fs = require('node:fs'); let prompt=''; process.stdin.on('data', b => prompt += b);
      process.stdin.on('end', () => { fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({prompt})+'\\n');
        const timer=setInterval(()=>{ if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);console.log('Fixture answer 🙂\\napi_key=private-fixture-key');}},20); });`);
    return { _models: { discoverOnBoot: false }, codex: {
      label: 'Fixture', oneshot_safe: [process.execPath, script, '-'],
      oneshot_capabilities: { safe: ['model_invocation', 'workspace_read', 'tool_use'] },
    } };
  }, { env: { RELAYBRIDGE_WARM_DIAG: '0', RELAYBRIDGE_REMOTE_MCP: '0' } });
  const body = { deliveryMode: 'queued', taskId: 't_a', kind: 'codex', prompt: 'Return the fixture response.', cwd: bridge.root };
  const submitted = await bridge.request('/api/tasks', body);
  assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
  assert.equal(submitted.body.resultState, 'pending');
  assert.equal(submitted.body.taskId, 't_a');
  assert.equal(Object.hasOwn(submitted.body, 'body'), false);
  await waitFor(() => completeJsonLines(capture).length === 1);
  const again = await bridge.request('/api/tasks', body);
  assert.equal(again.status, 202); assert.equal(again.body.resultState, 'pending');
  assert.equal((await bridge.request('/api/tasks', { ...body, prompt: 'different' })).status, 409);
  fs.writeFileSync(release, 'ready');
  const collected = await waitFor(async () => {
    const value = await bridge.request('/api/tasks/t_a/result');
    return value.body.resultState === 'pending' ? false : value;
  });
  assert.equal(collected.status, 200);
  assert.equal(collected.body.resultPersisted, true, JSON.stringify(collected.body));
  assert.equal(collected.body.result, 'Fixture answer 🙂\napi_key=[REDACTED]');
  assert.equal(collected.body.metadata.sha256, crypto.createHash('sha256').update(collected.body.result).digest('hex'));
  assert.equal(collected.body.metadata.requestId, 'queued:t_a');
  const filename = path.join(bridge.root, 'data', 'tasks', 't_a.json');
  const before = fs.readFileSync(filename), mtime = fs.statSync(filename).mtimeMs;
  assert.equal((await bridge.request('/api/tasks/t_a/result')).body.acknowledged, false);
  assert.deepEqual(fs.readFileSync(filename), before); assert.equal(fs.statSync(filename).mtimeMs, mtime);
  const identity = { receiptStoreId: collected.body.receiptStoreId, sha256: collected.body.metadata.sha256 };
  assert.equal((await bridge.request('/api/tasks/t_a/result/ack', { ...identity, sha256: 'f'.repeat(64) })).status, 409);
  assert.equal((await bridge.request('/api/tasks/t_a/result/ack', identity)).body.acknowledged, true);
  const ackBytes = fs.readFileSync(filename);
  assert.equal((await bridge.request('/api/tasks/t_a/result/ack', identity)).body.acknowledged, true);
  assert.deepEqual(fs.readFileSync(filename), ackBytes);
  assert.equal(completeJsonLines(capture).length, 1);
  assert.equal((await bridge.request('/api/tasks', { ...body, taskId: 't_large', prompt: 'x'.repeat(100001) })).status, 400);
  assert.equal((await bridge.request('/api/tasks', { ...body, taskId: 't_bad', requestId: 'short' })).status, 400);
  assert.equal(completeJsonLines(capture).length, 1);
});
