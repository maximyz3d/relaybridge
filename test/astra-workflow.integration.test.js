'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestBridge, waitFor, completeJsonLines } = require('./helpers/temporary-bridge');

test('REST workflow carries Astra/ultra through the real queue and argv without a provider writer', async (t) => {
  let capture;
  const bridge = await startTestBridge(t, (root) => {
    capture = path.join(root, 'calls.jsonl');
    const script = path.join(root, 'advisor.cjs');
    fs.writeFileSync(script, `const fs = require('node:fs'); let input = ''; process.stdin.on('data', c => input += c);
      process.stdin.on('end', () => {
        fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), input }) + '\\n');
        console.log(input.startsWith('# RelayBridge planning handoff') ? 'Fixture plan.\\nPLAN_STATUS: READY'
          : input.startsWith('# RelayBridge final review handoff') ? 'Fixture closing review.\\nREVIEW_VERDICT: APPROVE'
          : 'Fixture review correction.\\nREVIEW_VERDICT: REVISE');
      });`);
    const codex = structuredClone(require('../cli-config.json').codex);
    codex.oneshot_safe = [process.execPath, script, '-'];
    codex.oneshot_dangerous = [];
    codex.oneshot_output_parser = 'text';
    delete codex.probe; delete codex.version_probe;
    return { _models: { discoverOnBoot: false }, codex };
  }, { env: { RELAYBRIDGE_WARM_DIAG: '0', RELAYBRIDGE_REMOTE_MCP: '0' } });
  const created = await bridge.request('/api/workflows', { cwd: bridge.root, objective: 'Verify the bounded provider contract.',
    acceptance: 'Exact Astra ultra, external revision, fresh closing review.', profile: 'codex-astra-ultra',
    permissionMode: 'full', acknowledgeFilesystemWrites: true });
  assert.equal(created.status, 201);
  const prefix = '/api/workflows/' + created.body.workflow.runId;
  async function settle(dispatched) {
    assert.equal(dispatched.status, 202, JSON.stringify(dispatched.body));
    const task = dispatched.body.task;
    assert.equal(task.body.model, 'gpt-6-astra'); assert.equal(task.body.effort, 'ultra');
    await waitFor(async () => {
      const current = await bridge.request('/api/tasks/' + task.id);
      const record = current.body.task || current.body;
      if (record.status === 'failed') throw new Error(JSON.stringify(record));
      return record.status === 'done';
    });
    return (await bridge.request(prefix + '/reconcile', {})).body.workflow;
  }
  assert.equal((await settle(await bridge.request(prefix + '/research', { markdown: 'Fixture research.' }))).phase, 'plan_ready');
  const implementation = await bridge.request(prefix + '/implementation/claim', {});
  assert.equal(implementation.status, 200);
  assert.equal((await settle(await bridge.request(prefix + '/implementation/complete', {
    leaseToken: implementation.body.lease.leaseToken, markdown: 'Fixture implementation evidence.' }))).phase, 'review_ready');
  assert.equal((await bridge.request(prefix + '/revision/start', {})).status, 400);
  const claimed = await bridge.request(prefix + '/revision/claim', {});
  assert.equal(claimed.status, 200);
  assert.equal((await bridge.request(prefix + '/reconcile', {})).body.workflow.phase, 'revising');
  assert.equal(completeJsonLines(capture).length, 2);
  const completed = await bridge.request(prefix + '/revision/complete', {
    leaseToken: claimed.body.lease.leaseToken, markdown: 'Fixture corrective evidence.' });
  assert.equal(completed.body.workflow.phase, 'revision_ready');
  assert.equal(completeJsonLines(capture).length, 2);
  assert.equal((await settle(await bridge.request(prefix + '/final-review/start', {}))).phase, 'complete');
  const calls = completeJsonLines(capture);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'gpt-6-astra');
    assert.ok(call.argv.includes('model_reasoning_effort=ultra'));
    assert.doesNotMatch(call.input, /Claude|Read\/Glob\/Grep/);
  }
});
