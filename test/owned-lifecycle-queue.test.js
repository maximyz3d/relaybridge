'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createAttemptLifecycle, normalizeTransportLifecycle } = require('../lib/attempt-lifecycle');
const { RunSupervisor } = require('../lib/run-supervisor');
const { createTaskQueue } = require('../lib/task-queue');
const { canonical } = require('../lib/owned-task-projection');
const hash = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const turn = () => new Promise(setImmediate);
function lifecycle(extra = {}) {
  const registry = new Map(); let releases = 0;
  const value = createAttemptLifecycle({ runId: 'run_owned', registry, strictSettlement: true, tickMs: 0,
    supervisor: new RunSupervisor({ startedAt: 0, idleMs: 1000, hardCapMs: 5000 }), releaseAdmission: () => { releases++; }, ...extra });
  value.bindTransport({ type: 'cli', pid: 123, requestStop() {} }); value.markDispatched(); value.sealOutcome({ ok: true });
  return { value, registry, releases: () => releases };
}
test('strict lifecycle persists before cleanup/release and preserves exact retry after failure', async () => {
  const f = lifecycle(), order = []; let fail = true, done = false;
  f.value.physicalDone.then(() => { done = true; });
  const persist = async () => { order.push('persist'); if (fail) throw new Error('private fsync error'); return { durability: 'confirmed' }; };
  const cleanup = async () => { order.push('cleanup'); return { ok: true }; };
  await assert.rejects(f.value.settlePhysical({ evidence: 'process_tree_settled', persist, cleanup }), { code: 'LIFECYCLE_PERSISTENCE_UNCONFIRMED' });
  assert.deepEqual(order, ['persist']); assert.equal(f.registry.size, 1); assert.equal(f.releases(), 0); assert.equal(done, false);
  assert.equal(normalizeTransportLifecycle(f.value.snapshot()).phase, 'settlement_blocked');
  assert.equal(f.value.snapshot().cleanupStatus, 'preserved_unconfirmed'); assert.equal(JSON.stringify(f.value.snapshot()).includes('private fsync'), false);
  fail = false; await f.value.settlePhysical({ evidence: 'process_tree_settled', persist, cleanup });
  assert.deepEqual(order, ['persist', 'persist', 'cleanup']); assert.equal(f.registry.size, 0); assert.equal(f.releases(), 1); assert.equal(done, true);
});
test('strict lifecycle missing or unconfirmed persistence never releases from readable output', async () => {
  const f = lifecycle(); assert.throws(() => f.value.settlePhysical({ evidence: 'process_tree_settled' }), /explicit matching durable/);
  await assert.rejects(f.value.settlePhysical({ evidence: 'process_tree_settled', persist: async () => ({ readable: true, durability: 'unconfirmed' }) }), { code: 'LIFECYCLE_PERSISTENCE_UNCONFIRMED' });
  assert.equal(f.registry.size, 1); assert.equal(f.releases(), 0); assert.equal(f.value.snapshot().finalized, false);
});
test('strict release error retains registry until private idempotent retry confirms', async () => {
  let fail = true, effects = 0; const seen = new Set();
  const f = lifecycle({ releaseAdmission: () => { if (!seen.has('run_owned')) { seen.add('run_owned'); effects++; } if (fail) throw new Error('unconfirmed release'); } });
  const args = { evidence: 'process_tree_settled', persist: async () => ({ durability: 'confirmed' }) };
  await assert.rejects(f.value.settlePhysical(args), { code: 'LIFECYCLE_RELEASE_UNCONFIRMED' }); assert.equal(f.registry.size, 1); assert.equal(f.value.snapshot().finalized, false);
  fail = false; await f.value.settlePhysical(args); assert.equal(effects, 1); assert.equal(f.registry.size, 0);
});
function queueFixture(t, { maxConcurrent = 1, autoStart = false, execute } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-owned-queue-'));
  const references = new Map(), committed = new Map(), bindings = new Map(); let calls = 0, queue;
  const authority = {
    listTaskReservations: () => [...references.values()].map(row => ({ ...row })),
    readPreparedTaskOwner: ownerId => ({ locallyPrepared: true, started: false, reference: [...references.values()].find(row => row.ownerId === ownerId) }),
    readCommittedTaskRelease: (_ownerId, decisionId) => committed.get(decisionId) || null,
  };
  const options = { dataDir: directory, maxConcurrent, autoStart, executionOwners: authority,
    requiresExecutionOwner: task => task.body.prompt === 'owned',
    executeOneShot: async (body, res, context) => {
      calls++;
      if (context.requiresOwner) {
        const persisted = JSON.parse(fs.readFileSync(path.join(directory, context.taskId + '.json')));
        assert.equal(persisted.executionReservation.reservationId, context.reservationId, 'reservation is durable before executor');
        const binding = { taskId: context.taskId, reservationId: context.reservationId, runId: 'run_' + context.taskId };
        const reference = { taskId: context.taskId, reservationId: context.reservationId, ownerId: 'owner_' + crypto.randomBytes(16).toString('hex'), bindingHash: hash(binding), cwd: directory, held: true, decisionId: null };
        references.set(context.taskId, reference); bindings.set(context.taskId, binding);
        assert.throws(() => queue.attachOwnedExecution({ ...context }, { ownerId: reference.ownerId, bindingHash: reference.bindingHash, reservationId: context.reservationId }), { code: 'OWNED_TASK_CONTEXT_INVALID' });
        queue.attachOwnedExecution(context, { ownerId: reference.ownerId, bindingHash: reference.bindingHash, reservationId: context.reservationId });
      }
      if (execute) return execute({ body, res, context, queue });
      res.json({ stdout: 'semantic result', exitCode: 0, model_invocation: false, physicalAttemptCount: 0, physicalSettled: true, ownerFenced: true });
    } };
  function open(extra = {}) { queue = createTaskQueue({ ...options, ...extra }); return queue; }
  t.after(() => { queue?.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, references, committed, bindings, options, open, calls: () => calls,
    decision(taskId) {
      const row = references.get(taskId), decisionId = hash({ taskId, decision: 'release' });
      const record = { version: 1, taskId, reservationId: row.reservationId, ownerId: row.ownerId, bindingHash: row.bindingHash, decisionId, scope: 'task_capacity' };
      committed.set(decisionId, record); return { decisionId, bindingHash: row.bindingHash, scope: 'task_capacity' };
    } };
}
const native = process.platform === 'linux' ? test : test.skip;
native('owned task payload cannot release capacity; immutable projection awaits journal applied', async t => {
  const f = queueFixture(t), q = f.open(); const owned = q.submit({ kind: 'fixture', prompt: 'owned', cwd: f.directory });
  const next = q.submit({ kind: 'fixture', prompt: 'ordinary', cwd: f.directory }); q.resume(); await turn(); await turn();
  assert.equal(f.calls(), 1); assert.equal(q.get(owned.id).status, 'done'); assert.equal(q.get(owned.id).execution.state, 'owned_held');
  assert.equal(q.get(next.id).status, 'queued'); assert.equal(q.stats().reserved, 1); assert.equal(q.unsettledInWorkspace(f.directory), true);
  assert.throws(() => q.confirmStopped(owned.id), { code: 'OWNED_TASK_PRIVATE_DECISION_REQUIRED' });
  const original = fs.readFileSync(path.join(f.directory, owned.id + '.json')); const decision = f.decision(owned.id);
  assert.equal(q.applyOwnedTaskRelease(f.bindings.get(owned.id), decision), true); assert.equal(q.applyOwnedTaskRelease(f.bindings.get(owned.id), decision), true);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, owned.id + '.json')), original); assert.equal(q.stats().reserved, 1);
  await turn(); assert.equal(f.calls(), 1, 'projection alone does not pump');
  Object.assign(f.references.get(owned.id), { held: false, decisionId: decision.decisionId }); q.refreshOwnedReservations(); q.resume(); await turn(); await turn();
  assert.equal(f.calls(), 2); assert.equal(q.get(owned.id).execution.state, 'owned_settled'); assert.equal(q.get(next.id).status, 'done');
  assert.deepEqual(fs.readFileSync(path.join(f.directory, owned.id + '.json')), original);
});
native('restart restores held reservations before pump without rewriting owned or legacy task bytes', async t => {
  const f = queueFixture(t), q = f.open(); const owned = q.submit({ kind: 'fixture', prompt: 'owned', cwd: f.directory }); q.resume(); await turn(); await turn();
  const original = fs.readFileSync(path.join(f.directory, owned.id + '.json')); q.shutdown();
  const restarted = f.open({ autoStart: false }); const next = restarted.submit({ kind: 'fixture', prompt: 'ordinary', cwd: f.directory });
  assert.equal(restarted.stats().ownedHeld, 1); assert.equal(restarted.stats().paused, true); restarted.resume(); await turn();
  assert.equal(restarted.get(next.id).status, 'queued'); assert.equal(f.calls(), 1); assert.deepEqual(fs.readFileSync(path.join(f.directory, owned.id + '.json')), original);
});
native('occupied union avoids counting an in-flight owned task twice and holds dependencies', async t => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const f = queueFixture(t, { maxConcurrent: 2, execute: async ({ body, res }) => { if (body.prompt === 'owned') await gate; res.json({ stdout: 'done' }); } });
  const q = f.open(), owned = q.submit({ kind: 'fixture', prompt: 'owned', cwd: f.directory });
  q.submit({ kind: 'fixture', prompt: 'ordinary', cwd: f.directory });
  const dependent = q.submit({ kind: 'fixture', prompt: 'dependent', cwd: f.directory, dependsOn: [owned.id] });
  q.resume(); await turn(); await turn(); assert.equal(f.calls(), 2); assert.equal(q.stats().reserved, 1);
  finish(); await turn(); await turn(); assert.equal(q.get(owned.id).status, 'done'); assert.equal(q.get(dependent.id).status, 'queued'); assert.equal(f.calls(), 2);
});
native('missing private owner despite success payload stays uncertain and cannot use caller proof', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-owned-missing-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const q = createTaskQueue({ dataDir: directory, maxConcurrent: 1,
    executionOwners: { listTaskReservations: () => [], readPreparedTaskOwner: () => null, readCommittedTaskRelease: () => null },
    requiresExecutionOwner: () => true, executeOneShot: async (_body, res) => res.json({ stdout: 'done', model_invocation: false, physicalSettled: true }) });
  t.after(() => q.shutdown()); const first = q.submit({ kind: 'fixture', prompt: 'one' }), second = q.submit({ kind: 'fixture', prompt: 'two' }); await turn(); await turn();
  assert.equal(q.get(first.id).execution.state, 'owned_unverified'); assert.equal(q.stats().uncertain, 1); assert.equal(q.get(second.id).status, 'queued');
});
native('changed binding, forged decision, and missing applied projection fail closed', async t => {
  const f = queueFixture(t), q = f.open(), task = q.submit({ kind: 'fixture', prompt: 'owned', cwd: f.directory }); q.resume(); await turn(); await turn();
  const decision = f.decision(task.id), binding = f.bindings.get(task.id);
  assert.throws(() => q.applyOwnedTaskRelease({ ...binding, reservationId: 'qr_' + 'f'.repeat(32) }, decision), { code: 'OWNED_TASK_BINDING_CHANGED' });
  assert.throws(() => q.applyOwnedTaskRelease(binding, { ...decision, decisionId: 'e'.repeat(64) }), { code: 'OWNED_TASK_DECISION_UNTRUSTED' });
  Object.assign(f.references.get(task.id), { held: false, decisionId: decision.decisionId });
  assert.throws(() => q.refreshOwnedReservations(), { code: 'OWNED_TASK_PROJECTION_UNCONFIRMED' }); assert.equal(q.stats().ownedHeld, 1);
});
native('disabling new owned enrollment cannot drop an existing terminal owned hold on restart', async t => {
  const f = queueFixture(t), q = f.open(), owned = q.submit({ kind: 'fixture', prompt: 'owned', cwd: f.directory }); q.resume(); await turn(); await turn();
  const original = fs.readFileSync(path.join(f.directory, owned.id + '.json')); q.shutdown();
  const restarted = f.open({ executionOwners: null, requiresExecutionOwner: null, autoStart: true });
  const next = restarted.submit({ kind: 'fixture', prompt: 'ordinary' }); await turn();
  assert.equal(restarted.stats().uncertain, 1); assert.equal(restarted.get(next.id).status, 'queued'); assert.deepEqual(fs.readFileSync(path.join(f.directory, owned.id + '.json')), original);
});
native('unconfirmed sidecar fsync keeps hold; exact confirmed retry never rewrites task', async t => {
  const f = queueFixture(t), q = f.open(), task = q.submit({ kind: 'fixture', prompt: 'owned', cwd: f.directory }); q.resume(); await turn(); await turn();
  const decision = f.decision(task.id), binding = f.bindings.get(task.id), original = fs.readFileSync(path.join(f.directory, task.id + '.json'));
  const originalSync = fs.fsyncSync; let armed = true;
  t.mock.method(fs, 'fsyncSync', fd => { if (armed && fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('barrier failure'), { code: 'EIO' }); return originalSync(fd); });
  assert.throws(() => q.applyOwnedTaskRelease(binding, decision)); assert.equal(q.stats().reserved, 1); assert.deepEqual(fs.readFileSync(path.join(f.directory, task.id + '.json')), original);
  armed = false; assert.equal(q.applyOwnedTaskRelease(binding, decision), true); assert.equal(q.stats().reserved, 1); assert.deepEqual(fs.readFileSync(path.join(f.directory, task.id + '.json')), original);
});
