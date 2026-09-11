'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestBridge, waitFor, completeJsonLines } = require('./helpers/temporary-bridge');

test('buffered parallel workers expose fanout; exact cancellation leaves the other worker running', { timeout: 30000 }, async t => {
  const bridge = await startTestBridge(t, root => {
    const helper = path.join(root, 'worker.cjs');
    fs.writeFileSync(helper, `const fs=require('node:fs'),{spawn}=require('node:child_process');const label=process.argv[2];
      const children=Array.from({length:label==='A'?2:1},()=>spawn(process.execPath,['-e','setInterval(()=>{},1000)','secret-census-fixture'],{stdio:'ignore'}));
      const finish=()=>{for(const child of children)try{child.kill();}catch{};setTimeout(()=>process.exit(0),50);};
      process.on('SIGTERM',finish);process.on('SIGINT',finish);
      setInterval(()=>{if(fs.existsSync('release-'+label)){console.log('Fixture completed '+label);finish();}},25);`);
    return { _models: { discoverOnBoot: false }, fixture: { oneshot_safe: [process.execPath, helper, '{prompt}'],
      oneshot_capabilities: { safe: ['model_invocation'] } } };
  }, { env: { RELAYBRIDGE_WARM_DIAG: '0', RELAYBRIDGE_REMOTE_MCP: '0' } });
  const first = bridge.request('/api/oneshot', { kind: 'fixture', prompt: 'A', cwd: bridge.root, dangerous: false,
    requestId: 'fixture-a', childProcessPolicy: { maxChildren: 1, action: 'warn' } });
  const second = bridge.request('/api/oneshot', { kind: 'fixture', prompt: 'B', cwd: bridge.root, dangerous: false, requestId: 'fixture-b' });
  const active = await waitFor(async () => {
    const value = await bridge.request('/api/runs/active');
    return value.body.runs?.find(run => run.route.request_id === 'fixture-a' && run.processCensus?.descendantCount >= 2) && value.body;
  }, 15000);
  const a = active.runs.find(run => run.route.request_id === 'fixture-a');
  assert.ok(a.processWarnings.includes('child_fanout')); assert.doesNotMatch(JSON.stringify(a.processCensus), /secret-census-fixture/);
  const tuple = { requestId: a.route.request_id, invocationId: a.route.invocation_id, attemptId: a.route.attempt_id };
  assert.equal((await bridge.request('/api/runs/' + a.runId + '/cancel', { ...tuple, attemptId: 'wrong' })).status, 409);
  const cancellation = await bridge.request('/api/runs/' + a.runId + '/cancel', tuple);
  assert.equal(cancellation.status, 202); assert.equal(cancellation.body.terminationVerified, false);
  const aResult = await first;
  assert.equal(aResult.body.failureClass, 'operator_cancelled', JSON.stringify(aResult.body));
  assert.equal(aResult.body.cancelled, true); assert.equal(aResult.body.timed_out, false);
  assert.ok((await bridge.request('/api/runs/active')).body.runs.some(run => run.route.request_id === 'fixture-b'));
  fs.writeFileSync(path.join(bridge.root, 'release-B'), 'fixture-only');
  assert.equal((await second).body.exitCode, 0);
  const receiptsDir = path.join(bridge.root, 'data/receipts');
  const receipts = fs.readdirSync(receiptsDir).flatMap(file => completeJsonLines(path.join(receiptsDir, file)));
  assert.equal(receipts.filter(row => row.event === 'active_run_cancel_requested').length, 1);
  assert.equal(receipts.find(row => row.requestId === 'fixture-a' && row.event === 'bridge_provider_call').failureClass, 'operator_cancelled');
});
