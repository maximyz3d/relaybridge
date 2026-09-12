'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { registerOwnedWorkflowRoutes } = require('../lib/owned-workflow-routes');
function setup({ owned = true, backend = null, identity = true } = {}) {
  const handlers = {}; let calls = 0;
  const row = { runId: 'wf_1', revision: 7, writerLease: owned ? { ownerProtocol: 'linux_pid1_writer_v1',
    executionOwner: { ownerId: 'owner_1', bindingHash: 'a'.repeat(64) } } : { mode: 'external' } };
  registerOwnedWorkflowRoutes({ app: { get: (p, f) => { handlers.get = f; }, post: (p, f) => { handlers.post = f; } },
    pipeline: { get: () => row }, backend, assertActionIdentity() { calls++; if (!identity) throw Object.assign(new Error(), { code: 'BRIDGE_IDENTITY_MISMATCH' }); } });
  async function invoke(method, body) { let status = 200, value; await handlers[method]({ params: { runId: row.runId }, body },
    { status(n) { status = n; return this; }, json(v) { value = v; } }); return { status, value }; }
  return { invoke, row, calls: () => calls };
}
const body = { ownerId: 'owner_1', recoveryId: 'recovery_1', expectedOwnerRevision: 6,
  expectedBindingHash: 'a'.repeat(64), expectedWorkflowRevision: 7, expectedOwnerSetHash: 'b'.repeat(64), reason: 'Bound recovery.' };
test('unbound manual lease is unavailable without probing a backend', async () => {
  const f = setup({ owned: false, backend: { assertReady() { assert.fail('must not probe legacy'); } } });
  assert.equal((await f.invoke('get')).value.reason, 'unavailable_unbound_owner');
  assert.equal((await f.invoke('post', body)).value.code, 'OWNER_UNAVAILABLE_UNBOUND_LEASE');
});
test('omitted backend is honestly unavailable and never releases a bound lease', async () => {
  const f = setup(); assert.equal((await f.invoke('get')).value.reason, 'unavailable_unqualified_backend');
  assert.equal((await f.invoke('post', body)).status, 503);
});
test('caller PID, death proof, force and ownerFenced fields fail the closed contract', async () => {
  const f = setup();
  for (const field of ['pid', 'proof', 'force', 'ownerFenced', 'leaseToken', 'command'])
    assert.equal((await f.invoke('post', { ...body, [field]: true })).status, 400);
});
test('identity guard runs for every mutation and precedes private recovery', async () => {
  const f = setup({ identity: false, backend: { assertReady() { assert.fail('identity rejected first'); } } });
  assert.equal((await f.invoke('post', body)).value.code, 'BRIDGE_IDENTITY_MISMATCH'); assert.equal(f.calls(), 1);
});
test('status returns only bounded public selectors, not private proof or control fields', async () => {
  const f = setup({ backend: { assertReady() {}, inspectWriter() { return { state: 'ready_for_recovery', ownerRevision: 6,
    ownerSetHash: 'b'.repeat(64), pin: { hostPid: 123 }, controlNonce: 'PRIVATE', launch: ['SECRET'] }; } } });
  const result = await f.invoke('get'); assert.equal(result.value.recoverable, true);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false); assert.equal(JSON.stringify(result).includes('hostPid'), false);
});
test('qualified private backend applies once by decision and supports audited retry', async () => {
  let effects = 0; const seen = new Set();
  const f = setup({ backend: { assertReady() {}, recoverWriter(id, input) {
    if (!seen.has(input.recoveryId)) { seen.add(input.recoveryId); effects++; }
    return { released: true, ownerId: input.ownerId, recoveryId: input.recoveryId, decisionId: 'decision_1' };
  } } });
  assert.equal((await f.invoke('post', body)).value.released, true);
  f.row.writerLease = null; f.row.ownerRecovery = { decisionId: 'decision_1' };
  assert.equal((await f.invoke('post', body)).value.released, true); assert.equal(effects, 1);
});
