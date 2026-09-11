'use strict';
const nativeTest = require('node:test'), assert = require('node:assert/strict');
const test = process.platform === 'linux' ? nativeTest : nativeTest.skip;
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOwnerJournal, hash, canonical } = require('../lib/execution-owner');
const PIN = { hostPid: 12345, starttime: '100', nsIno: '99999', namespacePid: 1, bootId: '11111111-1111-1111-1111-111111111111' };
function fixture(t, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-owned-writer-')); fs.chmodSync(directory, 0o700);
  const writer = { workflowId: 'wf_fixture', phase: 'revising', actor: 'claude', mode: 'provider', ownerEpoch: 'lease_' + 'a'.repeat(48),
    leaseTokenSha256: hash('lease secret'), leaseAcquiredAt: 123, cwd: directory, cwdSha256: hash(directory), taskId: 't_writer_one', provider: 'fixture' };
  const binding = { requestId: 'request_one', invocationId: 'invoke_one', attemptId: 'attempt_one', runId: 'run_one', taskId: writer.taskId,
    provider: 'fixture', accountId: 'default', executionHash: hash('execution'), cwdIdentityHash: hash('cwd'), cwdPolicyId: hash('policy'), reservationId: 'qr_' + 'b'.repeat(32), writer };
  const state = { valid: true, outcome: { outcome: 'completed', artifact: { markdown: '# APPLIED\nExact bounded implementation.', sha256: hash('# APPLIED\nExact bounded implementation.') } },
    revision: 7, writerEffects: new Set(), taskEffects: new Set(), audit: null, failWriter: false, failTask: false, started: false, allowed: 0,
    alive: true, stopRequests: 0, flags: { wrapperExited: false, stdoutEof: false, stderrEof: false } };
  const handles = []; let resolvePhysical, resolveReady;
  const options = { directory, receiptStoreId: hash('store'), hostIdentity: hash('host'), qualifyHost: () => true,
    validateCurrentBinding: value => state.valid && value.taskId === binding.taskId,
    validateWriterBinding: (value, context) => state.valid && canonical(value) === canonical(writer)
      && (context.expectedWorkflowRevision == null || context.expectedWorkflowRevision === 7)
      && (!state.audit || context.operation === 'apply' && context.decision?.decisionId === state.audit),
    readWriterOutcome: () => structuredClone(state.outcome),
    resolveTrustedLaunch: value => ({ profile: { version: 1, kind: 'linux_pid1_owner', policyId: value.cwdPolicyId,
      cwdIdentityHash: value.cwdIdentityHash, executionHash: value.executionHash, writeRoots: [] },
      launch: { file: process.execPath, args: [], cwd: directory, env: { PATH: '/usr/bin:/bin' } } }),
    probeNamespace: () => state.alive ? { state: 'alive' } : { state: 'gone', evidence: 'pid_absent' },
    createPhysicalOwner: () => ({ ready: extra.deferredReady ? new Promise(resolve => { resolveReady = resolve; }) : Promise.resolve(),
      physicalDone: new Promise(resolve => { resolvePhysical = resolve; }),
      start: async () => { state.started = true; }, snapshot: () => ({ pin: { ...PIN }, ...state.flags }),
      allowProvider: async () => { state.allowed++; return true; }, requestStop: () => { state.stopRequests++; return true; } }),
    applyWriterRelease: async (_binding, decision) => { state.writerEffects.add(decision.decisionId); state.audit = decision.decisionId;
      if (state.failWriter) throw new Error('crash after workflow projection'); return true; },
    applyTaskRelease: async (_binding, decision) => { state.taskEffects.add(decision.decisionId); if (state.failTask) throw new Error('crash after task projection'); return true; },
    ...extra };
  delete options.deferredReady;
  const open = () => { const journal = createOwnerJournal(options); handles.push(journal); return journal; };
  t.after(() => { for (const handle of handles) try { handle.close(); } catch {} fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, writer, binding, state, options, open,
    ready: () => resolveReady?.(), finish: () => { state.alive = false; state.flags = { wrapperExited: true, stdoutEof: true, stderrEof: true }; resolvePhysical?.({ evidence: 'process_tree_settled' }); } };
}
const intent = (store, id, extra = {}) => ({ recoveryId: 'recovery_writer', expectedRevision: store.inspect(id).revision,
  expectedBindingHash: store.inspect(id).bindingHash, expectedWorkflowRevision: 7, reason: 'Finalize the exact owned writer only', ...extra });
async function gate(f) { const store = f.open(), id = store.prepare(f.binding).ownerId; await store.start(id); await store.permit(id); return { store, id }; }
async function finish(f) { const result = await gate(f); f.finish(); await result.store.confirmPhysical(result.id); return result; }

test('writer tuple and singleton epoch bind before start; durable prepared alone is not live preparation', async t => {
  const f = fixture(t), store = f.open(), prepared = store.prepare(f.binding), id = prepared.ownerId;
  assert.equal(store.isLocallyPrepared(id), true); assert.deepEqual(store.readPreparedWriter(id).ownerIds, [id]);
  assert.equal(store.readPreparedTaskOwner(id).reference.reservationId, f.binding.reservationId);
  assert.throws(() => store.prepare({ ...f.binding, runId: 'run_other', attemptId: 'attempt_other' }), { code: 'OWNER_WRITER_EPOCH_BOUND' });
  assert.throws(() => store.assertWorkspaceAvailable(f.directory), { code: 'OWNER_WORKSPACE_HELD' });
  await store.start(id); assert.equal(store.inspect(id).lastType, 'prepared'); assert.equal(store.isLocallyPrepared(id), false);
  assert.throws(() => store.readPreparedWriter(id), { code: 'OWNER_WRITER_NOT_PREPARED' });
  store.close(); const restored = f.open(); assert.equal(restored.isLocallyPrepared(id), false);
  assert.throws(() => restored.physicalDone(id), { code: 'OWNER_CONTROL_UNAVAILABLE' });
  assert.equal(restored.privateSnapshots()[0].writerHeld, true); assert.equal(restored.listTaskReservations()[0].held, true);
});

test('writer prepare/launch rejects changed tuple, source cwd, and stale workflow revision', async t => {
  const f = fixture(t), store = f.open();
  assert.throws(() => store.prepare({ ...f.binding, writer: { ...f.writer, taskId: 't_other' } }), { code: 'OWNER_WRITER_BINDING_INVALID' });
  const id = store.prepare(f.binding).ownerId; f.state.valid = false;
  await assert.rejects(store.start(id), { code: 'OWNER_BINDING_CHANGED' }); assert.equal(f.state.started, false); f.state.valid = true;
  await store.start(id); await store.permit(id); f.finish(); await store.confirmPhysical(id);
  assert.throws(() => store.recoverWriter(id, intent(store, id, { expectedWorkflowRevision: 99 })), { code: 'OWNER_WRITER_BINDING_CHANGED' });
});

test('live writer finalization requires composite proof, sealed artifact and both durable projections', async t => {
  const f = fixture(t), { store, id } = await gate(f);
  assert.throws(() => store.commitWriterFinalization(id, intent(store, id)), { code: 'OWNER_STILL_ACTIVE' });
  f.finish(); await store.confirmPhysical(id);
  const decision = store.commitWriterFinalization(id, intent(store, id));
  assert.equal(decision.operation, 'live_finalization'); assert.equal(decision.outcome, 'completed'); assert.equal(decision.artifact.sha256, f.state.outcome.artifact.sha256);
  assert.throws(() => store.assertMutableLease(f.writer.ownerEpoch), { code: 'OWNER_WRITER_LEASE_FROZEN' });
  assert.equal(store.readCommittedTaskRelease(id, decision.decisionId).scope, 'task_capacity');
  assert.equal(store.heldCount(), 1); await store.applyWriterDecision(id, decision.decisionId); await store.applyWriterDecision(id, decision.decisionId);
  assert.equal(f.state.writerEffects.size, 1); assert.equal(f.state.taskEffects.size, 1); assert.equal(store.heldCount(), 0);
  assert.equal(store.inspect(id).writerHeld, false); assert.equal(store.assertWorkspaceAvailable(f.directory), true); assert.equal(store.listTaskReservations()[0].decisionId, decision.decisionId);
});

test('expired recovery is explicit failed outcome and cannot be relabeled by caller fields', async t => {
  const f = fixture(t), { store, id } = await finish(f), input = intent(store, id);
  for (const field of ['outcome', 'proofKind', 'ownerFenced', 'artifact', 'ownerIds']) assert.throws(() => store.recoverWriter(id, { ...input, [field]: 'completed' }), { code: 'OWNER_SCHEMA_INVALID' });
  assert.throws(() => store.recover(id, { recoveryId: 'task', expectedRevision: input.expectedRevision, expectedBindingHash: input.expectedBindingHash, scope: 'task_capacity', reason: 'bypass writer' }), { code: 'OWNER_WRITER_RELEASE_REQUIRED' });
  const decision = store.recoverWriter(id, input); assert.equal(decision.outcome, 'failed'); assert.equal(decision.operation, 'expired_recovery'); assert.equal(decision.artifact, null);
  await store.applyWriterDecision(id, decision.decisionId); assert.equal(store.heldCount(), 0);
});

test('never-permitted fence releases only writer and prevents a late ready continuation from proceeding', async t => {
  const f = fixture(t, { deferredReady: true }), store = f.open(), id = store.prepare(f.binding).ownerId;
  f.state.outcome = { outcome: 'cancelled', artifact: null }; await store.start(id); const permit = store.permit(id);
  const decision = store.abortWriterBeforePermit(id, intent(store, id)); await store.applyWriterDecision(id, decision.decisionId);
  f.ready(); await assert.rejects(permit, { code: 'OWNER_PERMIT_FORBIDDEN' }); assert.equal(f.state.allowed, 0);
  assert.equal(decision.proofKind, 'never_permitted'); assert.equal(f.state.writerEffects.size, 1); assert.equal(f.state.taskEffects.size, 0);
  assert.equal(store.heldCount(), 1); assert.equal(store.inspect(id).writerHeld, false); assert.equal(store.listTaskReservations()[0].held, true);
  assert.throws(() => store.readCommittedTaskRelease(id, decision.decisionId), { code: 'OWNER_TASK_PROOF_UNAVAILABLE' });
  assert.equal(store.assertWorkspaceAvailable(f.directory), true);
});

test('fenced physical owner may later prove composite settlement and release its separate task hold', async t => {
  const f = fixture(t, { maxJournalFiles: 10 }), store = f.open(), id = store.prepare(f.binding).ownerId;
  await store.start(id); f.state.outcome = { outcome: 'failed', artifact: null };
  const decision = store.abortWriterBeforePermit(id, intent(store, id)); await store.applyWriterDecision(id, decision.decisionId);
  f.finish(); await store.confirmPhysical(id); const state = store.inspect(id);
  const taskDecision = store.recover(id, { recoveryId: 'task_release', expectedRevision: state.revision, expectedBindingHash: state.bindingHash, scope: 'task_capacity', reason: 'later composite physical proof' });
  await store.applyRelease(id, taskDecision.decisionId); assert.equal(store.inspect(id).revision, 8); assert.equal(store.heldCount(), 0); assert.equal(f.state.allowed, 0);
  store.close(); assert.equal(f.open().heldCount(), 0);
});

test('durable permit or ambiguous publication cannot be mistaken for never-permitted authority', async t => {
  const f = fixture(t), { store, id } = await gate(f); f.state.outcome = { outcome: 'failed', artifact: null };
  assert.throws(() => store.abortWriterBeforePermit(id, intent(store, id)), { code: 'OWNER_ALREADY_PERMITTED' }); assert.equal(f.state.writerEffects.size, 0);
  const io = Object.create(fs); let fail = false;
  io.fsyncSync = fd => { if (fail && fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('barrier failed'), { code: 'EIO' }); return fs.fsyncSync(fd); };
  const other = fixture(t, { fsApi: io }), second = other.open(), otherId = second.prepare(other.binding).ownerId; await second.start(otherId); fail = true;
  await assert.rejects(second.permit(otherId), { code: 'OWNER_DURABILITY_UNCONFIRMED' }); other.state.outcome = { outcome: 'failed', artifact: null };
  assert.throws(() => second.abortWriterBeforePermit(otherId, intent(second, otherId)), { code: 'OWNER_DURABILITY_UNCONFIRMED' }); assert.equal(other.state.allowed, 0);
});

test('fence-before-decision failure preserves exact intent across restart without future permit', async t => {
  const io = Object.create(fs); let fail = false;
  io.linkSync = (from, to) => { if (fail && to.endsWith('.0003.json')) throw Object.assign(new Error('decision publish failed'), { code: 'EIO' }); return fs.linkSync(from, to); };
  const f = fixture(t, { fsApi: io }), store = f.open(), id = store.prepare(f.binding).ownerId; f.state.outcome = { outcome: 'failed', artifact: null };
  const input = intent(store, id); fail = true; assert.throws(() => store.abortWriterBeforePermit(id, input), { code: 'OWNER_DURABILITY_UNCONFIRMED' }); assert.equal(store.inspect(id).revision, 2);
  store.close(); fail = false; const restored = f.open();
  assert.throws(() => restored.abortWriterBeforePermit(id, { ...input, reason: 'different' }), { code: 'OWNER_RECOVERY_ID_CONFLICT' });
  const decision = restored.abortWriterBeforePermit(id, input); await restored.applyWriterDecision(id, decision.decisionId);
  assert.equal(restored.heldCount(), 1); assert.equal(restored.inspect(id).writerHeld, false); assert.equal(f.state.allowed, 0);
});

test('writer projection crash rolls forward exact audit, then task projection, before dropping holds', async t => {
  const f = fixture(t), { store, id } = await finish(f), input = intent(store, id), decision = store.commitWriterFinalization(id, input);
  f.state.failWriter = true; await assert.rejects(store.applyWriterDecision(id, decision.decisionId)); assert.equal(store.heldCount(), 1); assert.equal(store.inspect(id).writerHeld, true); assert.equal(store.admissionBlocked(), true);
  store.close(); f.state.failWriter = false; const restored = f.open();
  assert.equal(restored.readCommittedWriterRelease(id, decision.decisionId).decisionId, decision.decisionId); await restored.applyWriterDecision(id, decision.decisionId);
  assert.equal(f.state.writerEffects.size, 1); assert.equal(f.state.taskEffects.size, 1); assert.equal(restored.heldCount(), 0);
});

test('task projection failure keeps both holds despite completed writer effect', async t => {
  const f = fixture(t), { store, id } = await finish(f), decision = store.recoverWriter(id, intent(store, id)); f.state.failTask = true;
  await assert.rejects(store.applyWriterDecision(id, decision.decisionId)); assert.equal(store.inspect(id).writerHeld, true); assert.equal(store.heldCount(), 1);
  f.state.failTask = false; await store.applyWriterDecision(id, decision.decisionId); assert.equal(f.state.writerEffects.size, 1); assert.equal(f.state.taskEffects.size, 1); assert.equal(store.heldCount(), 0);
});

test('restore exposes bounded inert holds without invoking pipeline callbacks or reconstructing live handles', async t => {
  const f = fixture(t), { store, id } = await finish(f); store.close();
  f.options.validateCurrentBinding = () => { throw new Error('pipeline not attached during restore'); };
  f.options.validateWriterBinding = () => { throw new Error('pipeline not attached during restore'); };
  f.options.createPhysicalOwner = () => { throw new Error('must not recreate'); };
  const restored = f.open(), rows = restored.privateSnapshots(); assert.equal(rows.length, 1); assert.equal(rows[0].proof.kind, 'physical_owner_settled_v1'); assert.equal(rows[0].held, true); assert.equal(rows[0].locallyPrepared, false);
  assert.throws(() => restored.physicalSnapshot(id), { code: 'OWNER_CONTROL_UNAVAILABLE' }); assert.equal(restored.assertHeld(), true);
});


test('retained private stop survives qualification drift without granting release or restore control', async t => {
  let qualified = true;
  const f = fixture(t, { qualifyHost: () => qualified }), { store, id } = await gate(f);
  const before = store.inspect(id); qualified = false;
  assert.equal(store.stop(id), true); assert.equal(f.state.stopRequests, 1);
  assert.throws(() => store.inspect(id), { code: 'OWNER_HOST_UNQUALIFIED' });
  await assert.rejects(store.confirmPhysical(id), { code: 'OWNER_HOST_UNQUALIFIED' });
  assert.throws(() => store.stop('owner_' + 'f'.repeat(32)), { code: 'OWNER_CONTROL_UNAVAILABLE' });
  assert.throws(() => store.stop({ toString: () => id }), { code: 'OWNER_CONTROL_UNAVAILABLE' });
  qualified = true; assert.deepEqual(store.inspect(id), before); assert.equal(store.heldCount(), 1);
  store.close(); assert.throws(() => store.stop(id), { code: 'OWNER_CONTROLLER_CLOSED' });
  const restored = f.open(); const requests = f.state.stopRequests;
  assert.throws(() => restored.stop(id), { code: 'OWNER_CONTROL_UNAVAILABLE' });
  assert.equal(f.state.stopRequests, requests); assert.equal(restored.heldCount(), 1);
});

test('retained private stop survives replaced journal name while all mutations remain fenced', async t => {
  const f = fixture(t), { store, id } = await gate(f), moved = f.directory + '-moved';
  fs.renameSync(f.directory, moved); fs.mkdirSync(f.directory, { mode: 0o700 });
  try {
    assert.equal(store.stop(id), true); assert.equal(f.state.stopRequests, 1);
    assert.throws(() => store.inspect(id), { code: 'OWNER_LOCK_IDENTITY_CHANGED' });
    assert.equal(store.heldCount(), 1);
  } finally { fs.rmdirSync(f.directory); fs.renameSync(moved, f.directory); }
  assert.equal(store.inspect(id).proof, undefined); assert.equal(store.inspect(id).permitted, true);
});
