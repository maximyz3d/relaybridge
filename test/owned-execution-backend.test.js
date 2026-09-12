'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOwnedExecutionBackend } = require('../lib/owned-execution-backend');
const { qualifyOwnedFixtureHost, qualifyOwnedHost } = require('../lib/owned-host-qualification');
const { createTaskQueue } = require('../lib/task-queue');
const { createWorkflowPipeline } = require('../lib/workflow-pipeline');
const { hash } = require('../lib/execution-owner');
const native = (name, fn) => test(name, { skip: process.platform !== 'linux' || !fs.existsSync('/usr/bin/bwrap'), timeout: 20000 }, fn);
const RUN = 'wf_backend_111111111111';
async function waitFor(fn, timeout = 6000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 15)); } throw new Error('condition timed out'); }
function assertCode(fn, code) { assert.throws(fn, (error) => error.code === code); }
async function fixture(t, { autoFinalize = true, beforeStart = null, abort = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-owned-backend-'));
  const dataDir = path.join(temp, 'data'), cwd = path.join(temp, 'project'), program = path.join(temp, 'fixture.cjs');
  fs.mkdirSync(dataDir, { mode: 0o700 }); fs.mkdirSync(cwd, { mode: 0o700 });
  fs.writeFileSync(program, "const fs=require('fs');process.stdin.resume();process.stdin.once('end',()=>{fs.appendFileSync('executions.txt','one\\n');process.stdout.write('REVISION_STATUS: APPLIED\\nBounded fixture completed.');});", { mode: 0o600 });
  const launch = { file: fs.realpathSync(process.execPath), args: [program], cwd, env: { PATH: '/usr/bin:/bin' } };
  let queue, pipeline, backend, qualification, activeIdentity, dispatched = 0, released = 0, lastError = null;
  const clock = { value: 1000000 }, handles = [], instances = [];
  const identity = { provider: 'fixture_node', accountId: 'fixture_account', executionHash: hash('execution'),
    cwdIdentityHash: hash([cwd, String(fs.statSync(cwd).ino)]), cwdPolicyId: hash('policy') };
  activeIdentity = identity;
  function construct(enabled) {
    backend = createOwnedExecutionBackend({ enabled, dataDir, receiptStoreId: hash('receipt-store'),
      getTaskQueue: () => queue, getPipeline: () => pipeline, readExecutionIdentity: () => structuredClone(activeIdentity), now: () => clock.value });
    queue = createTaskQueue({ dataDir: path.join(dataDir, 'tasks'), maxConcurrent: 2, autoStart: false,
      executionOwners: backend.taskAuthority, requiresExecutionOwner: (task) => backend.requiresOwnedTask(task),
      executeOneShot: async (body, res, context) => {
        res._relayDeferredResponse = true;
        try {
          const binding = { ...identity, requestId: body.requestId, invocationId: body.requestId,
            attemptId: `${body.requestId}:attempt:1`, taskId: context.taskId, reservationId: context.reservationId,
            runId: 'run_' + context.taskId };
          const profile = { version: 1, kind: 'linux_pid1_owner', policyId: identity.cwdPolicyId,
            cwdIdentityHash: identity.cwdIdentityHash, executionHash: identity.executionHash, writeRoots: [] };
          const handle = backend.prepareLaunch(context, { binding, launch, profile }); handles.push(handle);
          backend.onReleased(handle.ownerId, () => { released++; });
          if (beforeStart) await beforeStart({ handle, context, backend, queue, pipeline });
          if (abort) {
            await backend.abortBeforePermit(handle.ownerId);
            res.status(409).json({ stdout: '', failureClass: 'cancelled_before_permit', model_invocation: false }); return;
          }
          const child = await handle.start(); let stdout = '';
          child.stdout.on('data', (bytes) => { stdout += bytes; }); child.stderr.resume();
          await handle.permit(); dispatched++; child.stdin.end(body.prompt);
          await handle.physicalDone; await handle.confirmPhysical();
          res.json({ stdout, exitCode: 0, model_invocation: true, requestId: body.requestId,
            invocationId: body.requestId, attemptId: `${body.requestId}:attempt:1`,
            route: { execution_hash: identity.executionHash, cwd_identity_hash: identity.cwdIdentityHash, cwd_policy_id: identity.cwdPolicyId } });
          if (autoFinalize) backend.requestFinalizeTask(handle.ownerId);
        } catch (error) { lastError = error; res.status(500).json({ stdout: '', failureClass: error.code || 'fixture_failure', model_invocation: false }); }
      }, now: () => clock.value });
    pipeline = createWorkflowPipeline({ dataDir, executionOwners: backend.writerAuthority, now: () => clock.value });
    instances.push({ backend, queue });
  }
  construct(true);
  qualification = await qualifyOwnedFixtureHost({ dataDir, fixtureLaunch: launch });
  await backend.initialize(qualification); queue.resume();
  function plan(id = RUN) {
    pipeline.createWorkflow({ runId: id, cwd, objective: 'Fixture only.', acceptance: 'Fixture passes.', permissionMode: 'full' });
    pipeline.completeResearch(id, { markdown: 'Research.' }); pipeline.startPlanning(id); pipeline.completePlanning(id, { markdown: 'Plan.' });
  }
  function ready() {
    plan(); const implementation = pipeline.startImplementation(RUN);
    pipeline.completeImplementation(RUN, { leaseToken: implementation.lease.leaseToken, markdown: 'Implementation.' });
    pipeline.startReview(RUN); pipeline.completeReview(RUN, { markdown: 'Revise.', revisionRequested: true });
  }
  ready();
  function submit() {
    backend.assertQualifiedRevision({ workflow: pipeline.get(RUN), provider: identity.provider, cwd });
    pipeline.startOwnedRevision(RUN, { actor: 'claude-reviser', leaseMs: 100 });
    const taskId = queue.newTaskId(); pipeline.bindProviderTask(RUN, { actor: 'claude-reviser', taskId, provider: identity.provider, purpose: 'revision' });
    return queue.submitReserved(taskId, { kind: identity.provider, user: 'claude-reviser', source: 'workflow', cwd,
      dangerous: true, requestId: taskId, prompt: 'Perform only the disposable fixture.',
      correlation: { runId: RUN, requestId: taskId, invocationId: taskId, attemptId: `${taskId}:attempt:1` } });
  }
  t.after(async () => { for (const instance of instances) { instance.queue.shutdown(); instance.backend.stopAll(); instance.backend.close(); }
    for (const handle of handles) { try { await Promise.race([handle.completion, new Promise((resolve) => setTimeout(resolve, 500))]); } catch {} }
    fs.rmSync(temp, { recursive: true, force: true }); });
  return { get backend() { return backend; }, get queue() { return queue; }, get pipeline() { return pipeline; }, clock, temp, cwd, program, qualification,
    submit, handles, plan, dispatched: () => dispatched, released: () => released, error: () => lastError,
    identityChange: () => { activeIdentity = { ...identity, accountId: 'different_default', executionHash: hash('new-default') }; },
    async restart(enabled = false) { queue.shutdown(); backend.close(); construct(enabled); await backend.initialize(qualification); queue.resume(); } };
}

test('default disabled backend creates no authority or runtime directory', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-owned-disabled-')); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const backend = createOwnedExecutionBackend({ dataDir: temp, receiptStoreId: hash('store') });
  assert.equal(backend.writerAuthority, null); assert.equal(backend.taskAuthority, null);
  assert.equal(backend.writerRecoveryBackend, null); assert.equal(fs.existsSync(path.join(temp, 'execution-owners')), false);
  assertCode(() => backend.assertQualifiedRevision({}), 'OWNER_BACKEND_UNAVAILABLE');
  assert.equal((await backend.initialize()).held, 0); backend.close();
});

test('missing journal refuses new owned markers without changing legacy or task bytes', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-owned-orphan-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const directory = path.join(temp, 'tasks'); fs.mkdirSync(directory);
  const file = path.join(directory, 't_existing.json');
  const legacy = JSON.stringify({ id: 't_existing', status: 'interrupted', execution: { state: 'uncertain' } });
  fs.writeFileSync(file, legacy);
  const inactive = createOwnedExecutionBackend({ dataDir: temp, receiptStoreId: null });
  assert.equal(inactive.status().active, false); inactive.close();
  assert.equal(fs.readFileSync(file, 'utf8'), legacy);
  for (const marker of [{ executionReservation: { version: 1, reservationId: 'qr_test' } },
    { execution: { state: 'owned_held', owner: { ownerId: 'owner_test' } } }, { execution: { state: 'owned_settled' } }]) {
    const bytes = JSON.stringify({ id: 't_existing', status: 'done', ...marker }); fs.writeFileSync(file, bytes);
    assertCode(() => createOwnedExecutionBackend({ dataDir: temp, receiptStoreId: null }), 'OWNER_JOURNAL_MISSING');
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.equal(fs.existsSync(path.join(temp, 'execution-owners')), false);
  }
});

native('real qualified Node gate completes one owned writer through queue, journal and workflow', async (t) => {
  const f = await fixture(t); const task = f.submit();
  await waitFor(() => f.pipeline.get(RUN).phase === 'revision_ready');
  assert.equal(f.error(), null); assert.equal(f.dispatched(), 1); assert.equal(f.released(), 1);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'executions.txt'), 'utf8'), 'one\n');
  assert.equal(f.queue.get(task.id).execution.state, 'owned_settled');
  assert.equal(f.backend.reservationSnapshot()[0].held, false);
  assert.equal(f.pipeline.readArtifact(RUN, 'revision').content.includes('APPLIED'), true);
  assert.equal(f.qualification.scope, 'fixture_only');
  if (fs.statfsSync(f.temp, { bigint: true }).type === 0x1021994n) assert.equal(f.qualification.storage.persistent, false);
});

native('same-cwd ordinary dangerous launches are fenced; authentic context alone can prepare', async (t) => {
  let reached, proceed; const atGate = new Promise((resolve) => { reached = resolve; }), release = new Promise((resolve) => { proceed = resolve; });
  const f = await fixture(t, { beforeStart: async ({ context, backend }) => {
    assertCode(() => backend.assertWorkspaceLaunchAllowed({ cwd: f.cwd, dangerous: true }), 'OWNER_WORKSPACE_HELD');
    assertCode(() => backend.assertWorkspaceLaunchAllowed({ cwd: f.cwd, dangerous: true, privateContext: { ...context } }), 'OWNER_WORKSPACE_HELD');
    backend.assertWorkspaceLaunchAllowed({ cwd: f.cwd, dangerous: false });
    backend.assertWorkspaceLaunchAllowed({ cwd: f.cwd, dangerous: true, privateContext: context }); reached(); await release;
  } });
  f.submit(); await atGate; assert.equal(f.dispatched(), 0); proceed(); await waitFor(() => f.pipeline.get(RUN).phase === 'revision_ready');
});

native('owned lease before task enrollment fences ordinary writes across disabled restart', async (t) => {
  const f = await fixture(t);
  f.pipeline.startOwnedRevision(RUN, { actor: 'claude-reviser', leaseMs: 100 });
  assert.equal(f.backend.reservationSnapshot().length, 0);
  assert.equal(f.pipeline.ownedWorkspaceHeld(f.cwd), true);
  assertCode(() => f.backend.assertWorkspaceLaunchAllowed({ cwd: f.cwd }), 'OWNER_WORKSPACE_HELD');
  f.clock.value += 101;
  await f.restart(false);
  assert.equal(f.backend.status().active, false);
  assertCode(() => f.backend.assertWorkspaceLaunchAllowed({ cwd: f.cwd }), 'OWNER_WORKSPACE_HELD');
  f.backend.assertWorkspaceLaunchAllowed({ cwd: f.cwd, dangerous: false });
  assert.equal(f.pipeline.get(RUN).writerLease.ownerProtocol, 'linux_pid1_writer_v1');
});

native('restored physical hold and explicit expired recovery retain original account after default changes', async (t) => {
  const f = await fixture(t, { autoFinalize: false }); const task = f.submit();
  await waitFor(() => f.queue.get(task.id).status === 'done'); await waitFor(() => f.backend.inspectWriter(RUN).state === 'ready_for_recovery');
  const before = f.backend.reservationSnapshot()[0]; assert.equal(before.held, true); f.identityChange();
  await f.restart(false); assert.equal(f.backend.reservationSnapshot()[0].accountId, 'fixture_account');
  assert.equal(f.queue.get(task.id).execution.state, 'owned_held');
  const view = f.backend.inspectWriter(RUN), workflow = f.pipeline.get(RUN); f.clock.value += 101;
  const input = { ownerId: before.ownerId, recoveryId: 'operator_recovery', expectedOwnerRevision: view.ownerRevision,
    expectedBindingHash: workflow.writerLease.executionOwner.bindingHash, expectedWorkflowRevision: workflow.revision,
    expectedOwnerSetHash: view.ownerSetHash, reason: 'Explicit exact expired-owner recovery.' };
  const first = await f.backend.recoverWriter(RUN, input), second = await f.backend.recoverWriter(RUN, input);
  assert.deepEqual(first, second); assert.equal(f.pipeline.get(RUN).phase, 'failed');
  assert.equal(f.queue.get(task.id).execution.state, 'owned_settled'); assert.equal(f.dispatched(), 1);
});

native('pre-permit abort never starts a provider and keeps physical capacity separate from writer release', async (t) => {
  const f = await fixture(t, { abort: true }); const task = f.submit();
  await waitFor(() => f.pipeline.get(RUN).phase === 'failed' || f.error());
  assert.equal(f.error(), null); assert.equal(f.dispatched(), 0); assert.equal(fs.existsSync(path.join(f.cwd, 'executions.txt')), false);
  assert.equal(f.backend.reservationSnapshot()[0].writerHeld, false);
  assert.equal(f.backend.reservationSnapshot()[0].held, true); assert.equal(f.released(), 0);
  assert.equal(f.queue.get(task.id).execution.state, 'owned_held');
});

native('exact fixture qualification cannot authorize native providers or a changed helper', async (t) => {
  const f = await fixture(t);
  assertCode(() => f.backend.assertQualifiedRevision({ workflow: f.pipeline.get(RUN), provider: 'claude', cwd: f.cwd }), 'OWNER_PROVIDER_PROFILE_UNQUALIFIED');
  fs.appendFileSync(f.program, '\n// changed after qualification');
  assertCode(() => f.submit(), 'OWNER_HELPER_CHANGED'); assert.equal(f.dispatched(), 0);
});

native('enabled pending initialization refuses forged host assertions and preserves ordinary data', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-owned-unqualified-')); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const backend = createOwnedExecutionBackend({ enabled: true, dataDir: temp, receiptStoreId: hash('store'),
    getTaskQueue: () => null, getPipeline: () => null, readExecutionIdentity: () => null });
  await assert.rejects(backend.initialize({ directory: path.join(temp, 'execution-owners'), assertStorage: () => true }), { code: 'OWNER_HOST_UNQUALIFIED' });
  assertCode(() => backend.assertQualifiedRevision({}), 'OWNER_BACKEND_UNAVAILABLE');
  assert.deepEqual(fs.readdirSync(temp), []); backend.close();
  if (fs.statfsSync(temp, { bigint: true }).type === 0x1021994n)
    await assert.rejects(qualifyOwnedHost({ dataDir: temp }), { code: 'OWNER_FILESYSTEM_UNQUALIFIED' });
});


native('expiry between prepare and start must prevent actual fixture dispatch', async (t) => {
  const f = await fixture(t, {beforeStart: async () => { f.clock.value += 101; }});
  const task = f.submit();
  await waitFor(() => f.queue.get(task.id).status !== 'running' && f.queue.get(task.id).status !== 'queued');
  assert.equal(f.dispatched(), 0, 'expired lease launched and permitted a physical provider');
});

native('stale workflow revision must reject before immutable recovery decision is written', async (t) => {
  const f = await fixture(t, {autoFinalize:false}); const task=f.submit();
  await waitFor(()=>f.queue.get(task.id).status==='done');
  await waitFor(()=>f.backend.inspectWriter(RUN).state==='ready_for_recovery');
  f.clock.value+=101;
  const before=f.backend.inspectWriter(RUN), workflow=f.pipeline.get(RUN), row=f.backend.reservationSnapshot()[0];
  const input={ownerId:row.ownerId,recoveryId:'stale_revision',expectedOwnerRevision:before.ownerRevision,
    expectedBindingHash:workflow.writerLease.executionOwner.bindingHash,expectedWorkflowRevision:workflow.revision-1,
    expectedOwnerSetHash:before.ownerSetHash,reason:'Reject stale revision before writing authority.'};
  await assert.rejects(f.backend.recoverWriter(RUN,input));
  assert.equal(f.backend.inspectWriter(RUN).state,'ready_for_recovery','bad request committed an immutable recovery decision before workflow CAS');
  assert.equal(f.backend.inspectWriter(RUN).ownerRevision,before.ownerRevision);
});
