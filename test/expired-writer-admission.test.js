'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWorkflowPipeline } = require('../lib/workflow-pipeline');
const { startTestBridge } = require('./helpers/temporary-bridge');

test('REST restart preserves an expired writer lock and reports actionable conflict details', { timeout: 30000 }, async (t) => {
  const ownerId = 'wf_httpowner_111111111111';
  const contenderId = 'wf_httpnext_222222222222';
  let pipeline, lease, lockPath, originalLock, originalOwner, originalContender;
  const bridge = await startTestBridge(t, (root) => {
    const cwd = path.join(root, 'project');
    fs.mkdirSync(cwd);
    const dataDir = path.join(root, 'data');
    // Seed a real prior-process workflow without changing the server's clock.
    pipeline = createWorkflowPipeline({ dataDir, now: () => 1000000 });
    for (const runId of [ownerId, contenderId]) {
      pipeline.createWorkflow({ runId, cwd, objective: 'Verify exclusive writer admission.',
        acceptance: 'An expired writer cannot be replaced on elapsed time alone.' });
      pipeline.completeResearch(runId, { markdown: 'A prior writer may still be running.' });
      pipeline.startPlanning(runId);
      pipeline.completePlanning(runId, { markdown: 'Preserve ownership until proven safe.' });
    }
    ({ lease } = pipeline.startImplementation(ownerId, { leaseMs: 1000 }));
    originalOwner = pipeline.get(ownerId);
    originalContender = pipeline.get(contenderId);
    lockPath = path.join(dataDir, 'writer-locks', `${originalOwner.writerLease.cwdSha256}.json`);
    originalLock = fs.readFileSync(lockPath, 'utf8');
    return {};
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    const claim = await bridge.request(`/api/workflows/${contenderId}/implementation/claim`, {});
    assert.equal(claim.status, 409, JSON.stringify(claim.body));
    assert.equal(claim.body.code, 'WRITER_EXECUTION_UNCERTAIN');
    assert.equal(claim.body.details.runId, ownerId);
    assert.equal(claim.body.details.actor, 'codex');
    assert.equal(claim.body.details.expired, true);
    assert.equal(claim.body.details.recovery, 'unavailable_unbound_owner');
    assert.equal(JSON.stringify(claim.body).includes(lease.leaseToken), false);

    const view = await bridge.request(`/api/workflows/${ownerId}?includeArtifacts=false`);
    assert.equal(view.status, 200);
    assert.deepEqual(view.body.workflow, originalOwner);
    assert.deepEqual(view.body.nextActions, []);
    assert.deepEqual(view.body.blockedActions, [{ code: 'LEASE_EXPIRED',
      recovery: 'unavailable_unbound_owner',
      actions: ['complete_pipeline_implementation', 'renew_pipeline_writer_lease'] }]);
  }

  for (const operation of ['lease/renew', 'implementation/complete']) {
    const rejected = await bridge.request(`/api/workflows/${ownerId}/${operation}`, {
      leaseToken: lease.leaseToken, markdown: 'This expired capability must not advance the workflow.',
    });
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
    assert.equal(rejected.body.code, 'LEASE_EXPIRED');
  }
  assert.equal(fs.readFileSync(lockPath, 'utf8'), originalLock);
  assert.deepEqual(pipeline.get(ownerId), originalOwner);
  assert.deepEqual(pipeline.get(contenderId), originalContender);
  const tasksDir = path.join(bridge.root, 'data', 'tasks');
  assert.deepEqual(fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).filter((name) => name.endsWith('.json')) : [], []);
});
