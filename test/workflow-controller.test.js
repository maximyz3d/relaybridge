'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkflowPipeline } = require('../lib/workflow-pipeline');
const { createWorkflowController, WorkflowControllerError } = require('../lib/workflow-controller');
const { createIncidentLog } = require('../lib/incident-log');
const { createRequestLedger } = require('../lib/request-ledger');
const { createTaskQueue } = require('../lib/task-queue');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-controller-'));
  const cwd = path.join(root, 'project');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = { value: 1000000 };

  const tasks = new Map();
  let sequence = 0;
  const taskQueue = {
    newTaskId() { return `t_fake_${++sequence}`; },
    submit(input) { return this.submitReserved(this.newTaskId(), input); },
    submitReserved(id, input) {
      if (tasks.has(id)) throw new Error('task id already exists');
      const task = { id, status: 'queued', startedAt: null, execution: { state: 'never_started' }, ...input, body: { ...input } };
      tasks.set(task.id, task);
      return task;
    },
    get(id) { return tasks.get(id) || null; },
    cancel(id) {
      const task = tasks.get(id);
      if (!task) throw new Error('task not found');
      task.status = 'cancelled';
      return task;
    },
  };
  const config = {
    claude: { oneshot_safe: ['claude-safe'], oneshot_dangerous: ['claude-writer'] },
    claude_fable: { oneshot_safe: ['fable-safe'], oneshot_dangerous: [] },
  };
  const pipeline = createWorkflowPipeline({ dataDir, now: () => clock.value });
  const incidents = createIncidentLog({ dataDir: path.join(root, 'incidents') });
  const controller = createWorkflowController({
    pipeline, taskQueue, incidents, loadConfig: () => config, now: () => clock.value,
  });
  t.after(() => controller.shutdown());
  return {
    cwd,
    dataDir,
    clock,
    tasks,
    taskQueue,
    config,
    pipeline,
    controller,
    incidents,
    finish(task, result, status = 'done', extra = {}) {
      Object.assign(tasks.get(task.id), {
        status,
        result,
        error: status === 'done' ? null : result,
        finishedAt: clock.value,
        ...extra,
      });
    },
  };
}

function reachReviewReady(f, input = createInput(f.cwd), verdict = 'REVISE') {
  const created = f.controller.create(input);
  const planning = f.controller.submitResearch(created.runId, { markdown: 'Research evidence.' });
  f.finish(planning.task, 'Plan details.\nPLAN_STATUS: READY');
  f.controller.reconcile(created.runId);
  const implementation = f.controller.startImplementation(created.runId);
  const review = f.controller.completeImplementation(created.runId, {
    leaseToken: implementation.lease.leaseToken,
    markdown: 'Implementation evidence.',
  });
  f.finish(review.task, `Initial review context unique.\nREVIEW_VERDICT: ${verdict}`);
  f.controller.reconcile(created.runId);
  return created;
}

test('Codex-only policy survives external revision restart with exact Astra/ultra and no provider writer', (t) => {
  const f = fixture(t);
  f.config.codex = { oneshot_safe: ['codex-safe'] };
  const created = reachReviewReady(f, { ...createInput(f.cwd), profile: 'codex-astra-ultra', permissionMode: 'full' });
  assert.deepEqual(f.controller.view(created.runId).nextActions, ['claim_pipeline_revision']);
  assert.throws(() => f.controller.startRevision(created.runId), { code: 'INVALID_WRITER_MODE' });
  const count = f.tasks.size;
  const claimed = f.controller.claimRevision(created.runId);
  const token = claimed.lease.leaseToken;
  assert.equal(claimed.workflow.writerLease.mode, 'external');
  assert.equal(f.tasks.size, count);
  const restarted = createWorkflowController({ pipeline: createWorkflowPipeline({ dataDir: f.dataDir, now: () => f.clock.value }),
    taskQueue: f.taskQueue, loadConfig: () => f.config, now: () => f.clock.value });
  t.after(() => restarted.shutdown());
  assert.equal(restarted.reconcile(created.runId).workflow.phase, 'revising');
  assert.deepEqual(restarted.view(created.runId).nextActions, ['complete_pipeline_revision', 'renew_pipeline_writer_lease']);
  assert.throws(() => restarted.cancel(created.runId, { reason: 'No token' }), { code: 'INVALID_LEASE_TOKEN' });
  assert.throws(() => restarted.completeRevision(created.runId, { leaseToken: 'a'.repeat(64), markdown: 'invalid' }), { code: 'LEASE_MISMATCH' });
  assert.throws(() => restarted.startFinalReview(created.runId), { code: 'INVALID_TRANSITION' });
  restarted.renewWriterLease(created.runId, { leaseToken: token, leaseMs: 60000 });
  const completed = restarted.completeRevision(created.runId, { leaseToken: token, markdown: 'Corrections and exact test evidence.' });
  assert.equal(completed.phase, 'revision_ready');
  assert.equal(completed.writerLease, null);
  assert.equal(f.tasks.size, count, 'external completion never dispatches or approves');
  const closing = restarted.startFinalReview(created.runId);
  f.finish(closing.task, 'Independent closing evidence.\nREVIEW_VERDICT: APPROVE');
  assert.equal(restarted.reconcile(created.runId).workflow.phase, 'complete');
  for (const task of f.tasks.values()) {
    assert.equal(task.kind, 'codex'); assert.equal(task.model, 'gpt-6-astra');
    assert.equal(task.effort, 'ultra'); assert.equal(task.maxEffortOverride, true); assert.equal(task.dangerous, false);
    assert.match(task.prompt, /bounded read-only commands/); assert.doesNotMatch(task.prompt, /Claude|Read\/Glob\/Grep/);
  }
  assert.equal(f.pipeline.list()[0].profile, 'codex-astra-ultra');
});

test('Codex-only unavailable provider, retries, and missing verdicts never select Claude', (t) => {
  const f = fixture(t);
  assert.throws(() => f.controller.create({ ...createInput(f.cwd), profile: 'codex-astra-ultra',
    providerPreferences: { planning: ['claude'] } }), { code: 'INVALID_ARGUMENT' });
  const unavailable = f.controller.create({ ...createInput(f.cwd), profile: 'codex-astra-ultra' });
  assert.throws(() => f.controller.submitResearch(unavailable.runId, { markdown: 'evidence' }), { code: 'PROVIDER_UNAVAILABLE' });
  assert.equal(f.tasks.size, 0);
  f.config.codex = { oneshot_safe: ['codex-safe'] };
  const created = f.controller.create({ ...createInput(f.cwd), profile: 'codex-astra-ultra' });
  const planning = f.controller.submitResearch(created.runId, { markdown: 'evidence' });
  f.finish(planning.task, 'overloaded', 'failed', { failureClass: 'overloaded', execution: { state: 'settled' } });
  f.controller.reconcile(created.runId);
  f.clock.value += 20000;
  const retry = f.controller.reconcile(created.runId).workflow.providerTask;
  assert.equal(retry.provider, 'codex'); assert.equal(retry.model, 'gpt-6-astra'); assert.equal(retry.effort, 'ultra');
  f.finish(f.tasks.get(retry.taskId), 'Missing final plan marker.');
  assert.equal(f.controller.reconcile(created.runId).workflow.phase, 'failed');
  assert.ok([...f.tasks.values()].every((task) => task.kind === 'codex'));
});

test('expired external and legacy ambiguous revisions remain held across read and reconcile', (t) => {
  for (const legacy of [false, true]) {
    const f = fixture(t);
    const created = reachReviewReady(f);
    const claimed = f.controller.claimRevision(created.runId, { leaseMs: 60000 });
    if (legacy) {
      const file = path.join(f.dataDir, 'workflows', created.runId, 'state.json');
      const state = JSON.parse(fs.readFileSync(file));
      state.schemaVersion = 1; delete state.profile; delete state.phasePolicy; delete state.writerLease.mode;
      fs.writeFileSync(file, JSON.stringify(state));
    }
    f.clock.value += 60001;
    assert.equal(f.controller.reconcile(created.runId).workflow.phase, 'revising');
    assert.deepEqual(f.controller.view(created.runId).nextActions, []);
    assert.throws(() => f.controller.cancel(created.runId, { leaseToken: claimed.lease.leaseToken }), { code: 'LEASE_EXPIRED' });
    assert.throws(() => f.pipeline.failOrphanedRevision(created.runId, {}), { code: 'WRITER_EXECUTION_UNCERTAIN' });
    assert.ok(f.pipeline.get(created.runId).writerLease);
  }
});

// NOT RUN until root executes: explicit acknowledged cancellation of expired external ownership.
function expiredExternal(t, { phase = 'revising', legacy = false } = {}) {
  const f = fixture(t);
  let created;
  let claimed;
  if (phase === 'revising') {
    created = reachReviewReady(f);
    claimed = f.controller.claimRevision(created.runId, { leaseMs: 60000 });
  } else {
    created = f.controller.create(createInput(f.cwd));
    const planning = f.controller.submitResearch(created.runId, { markdown: 'Research evidence.' });
    f.finish(planning.task, 'Plan details.\nPLAN_STATUS: READY');
    f.controller.reconcile(created.runId);
    claimed = f.controller.startImplementation(created.runId, { leaseMs: 60000 });
  }
  const runId = created.runId;
  const stateFile = path.join(f.dataDir, 'workflows', runId, 'state.json');
  const edit = (change) => {
    const state = JSON.parse(fs.readFileSync(stateFile));
    change(state);
    fs.writeFileSync(stateFile, JSON.stringify(state));
  };
  if (legacy) edit((state) => { state.schemaVersion = 1; delete state.profile; delete state.phasePolicy; delete state.writerLease.mode; });
  f.clock.value += 60001;
  const state = f.pipeline.get(runId);
  const lockFile = path.join(f.dataDir, 'writer-locks', `${state.writerLease.cwdSha256}.json`);
  const ack = {
    acknowledged: true, revision: state.revision, mode: legacy ? 'legacy_absent' : 'external', actor: 'codex',
    cwdSha256: state.writerLease.cwdSha256, leaseTokenSha256: state.writerLease.leaseTokenSha256,
    acquiredAt: state.writerLease.acquiredAt, expiresAt: state.writerLease.expiresAt,
  };
  const snapshot = () => ({ state: fs.readFileSync(stateFile), lock: fs.existsSync(lockFile) ? fs.readFileSync(lockFile) : null });
  return { f, runId, token: claimed.lease.leaseToken, stateFile, lockFile, ack, edit, snapshot };
}

test('expired external ownership is cancelled by exact acknowledgement without the lost token', (t) => {
  for (const phase of ['implementing', 'revising']) {
    for (const legacy of [false, true]) {
      for (const lockPresent of [true, false]) {
        const x = expiredExternal(t, { phase, legacy });
        if (!lockPresent) fs.unlinkSync(x.lockFile);
        const count = x.f.tasks.size;
        const cancelled = x.f.controller.cancel(x.runId, { actor: 'operator', expiredExternalOwnership: x.ack });
        assert.equal(cancelled.phase, 'cancelled');
        assert.equal(cancelled.writerLease, null);
        assert.equal(x.f.tasks.size, count, 'cancellation dispatches nothing');
        assert.equal(fs.existsSync(x.lockFile), false);
        const reopened = createWorkflowPipeline({ dataDir: x.f.dataDir, now: () => x.f.clock.value }).get(x.runId);
        const event = reopened.history.at(-1);
        assert.equal(event.event, 'expired_external_writer_cancelled');
        assert.equal(event.detail.processTermination, 'not_attested');
        assert.equal(event.detail.lockPresent, lockPresent);
        assert.equal(event.detail.leaseTokenSha256, x.ack.leaseTokenSha256);
        assert.equal(reopened.terminal.status, 'cancelled');
        assert.match(reopened.terminal.reason, /process termination not attested/);
        assert.ok(!fs.readFileSync(x.stateFile, 'utf8').includes(x.token), 'the token never reaches durable state');
        assert.throws(() => x.f.controller.cancel(x.runId, { expiredExternalOwnership: x.ack }), { code: 'WORKFLOW_TERMINAL' });
        assert.equal(x.f.tasks.size, count);
      }
    }
  }
});

test('expired external cancellation refuses misuse without any mutation', (t) => {
  const x = expiredExternal(t);
  const otherRun = x.f.controller.create(createInput(x.f.cwd));
  const otherBefore = JSON.stringify(x.f.pipeline.get(otherRun.runId));
  const before = x.snapshot();
  const count = x.f.tasks.size;
  const refuse = (input, code) => {
    assert.throws(() => x.f.controller.cancel(x.runId, input), { code });
    assert.deepEqual(x.snapshot(), before);
    assert.equal(x.f.tasks.size, count);
  };
  for (const bad of [null, [], 'yes', {}, { ...x.ack, acknowledged: false }, { ...x.ack, acknowledged: 'true' },
    { ...x.ack, extra: 1 }, { ...x.ack, mode: 'provider' }, { ...x.ack, cwdSha256: 'A'.repeat(64) },
    { ...x.ack, revision: 0 }, { ...x.ack, expiresAt: -1 }, { ...x.ack, acquiredAt: 1.5 }]) {
    refuse({ expiredExternalOwnership: bad }, 'INVALID_EXPIRED_CANCEL');
  }
  const { expiresAt, ...missing } = x.ack;
  refuse({ expiredExternalOwnership: missing }, 'INVALID_EXPIRED_CANCEL');
  refuse({ expiredExternalOwnership: x.ack, leaseToken: x.token }, 'INVALID_EXPIRED_CANCEL');
  for (const [field, value] of [['revision', x.ack.revision + 1], ['mode', 'legacy_absent'], ['actor', 'claude'],
    ['cwdSha256', 'b'.repeat(64)], ['leaseTokenSha256', 'b'.repeat(64)], ['acquiredAt', x.ack.acquiredAt + 1],
    ['expiresAt', x.ack.expiresAt + 1]]) {
    refuse({ expiredExternalOwnership: { ...x.ack, [field]: value } }, 'LEASE_MISMATCH');
  }
  assert.throws(() => x.f.controller.cancel(otherRun.runId, { expiredExternalOwnership: x.ack }), { code: 'LEASE_NOT_REQUIRED' });
  assert.throws(() => x.f.pipeline.cancelExpiredExternalWriter(x.runId, { acknowledgement: { ...x.ack, revision: x.ack.revision - 1 } }),
    { code: 'LEASE_MISMATCH' });
  assert.deepEqual(x.snapshot(), before);
  assert.equal(JSON.stringify(x.f.pipeline.get(otherRun.runId)), otherBefore, 'unrelated workflows are untouched');
  // Without the acknowledgement the default expired refusal is unchanged.
  assert.throws(() => x.f.controller.cancel(x.runId, { leaseToken: x.token }), { code: 'LEASE_EXPIRED' });
  assert.deepEqual(x.snapshot(), before);
});

test('unexpired ownership cannot be cancelled by acknowledgement', (t) => {
  const x = expiredExternal(t);
  x.f.clock.value = x.ack.expiresAt - 1;
  const before = x.snapshot();
  assert.throws(() => x.f.controller.cancel(x.runId, { expiredExternalOwnership: x.ack }), { code: 'INVALID_EXPIRED_CANCEL' });
  assert.throws(() => x.f.pipeline.cancelExpiredExternalWriter(x.runId, { acknowledgement: x.ack }), { code: 'INVALID_EXPIRED_CANCEL' });
  assert.deepEqual(x.snapshot(), before);
});

test('provider, bound-task and owned records are refused before any queue or owner side effect', (t) => {
  for (const [name, change, code, pipelineCode] of [
    ['provider', (state) => { state.writerLease.mode = 'provider'; }, 'INVALID_EXPIRED_CANCEL', 'INVALID_EXPIRED_CANCEL'],
    ['owned', (state) => { state.writerLease.ownerProtocol = 'owned-writer'; }, 'INVALID_EXPIRED_CANCEL', 'OWNER_RELEASE_REQUIRED'],
    ['bound', (state, id) => { state.providerTask = { taskId: id, provider: 'claude', actor: 'codex' }; }, 'INVALID_EXPIRED_CANCEL', 'INVALID_EXPIRED_CANCEL'],
  ]) {
    const x = expiredExternal(t, { legacy: true });
    const task = x.f.taskQueue.submit({ kind: 'claude', prompt: 'bound' });
    x.edit((state) => change(state, task.id));
    const before = x.snapshot();
    const spy = t.mock.method(x.f.taskQueue, 'cancel');
    assert.throws(() => x.f.controller.cancel(x.runId, { expiredExternalOwnership: x.ack }), { code }, name);
    assert.equal(spy.mock.callCount(), 0, `${name}: no queue cancellation`);
    assert.equal(x.f.tasks.get(task.id).status, 'queued');
    assert.deepEqual(x.snapshot(), before);
    assert.throws(() => x.f.pipeline.cancelExpiredExternalWriter(x.runId, { acknowledgement: x.ack }), { code: pipelineCode }, name);
    assert.deepEqual(x.snapshot(), before);
  }
});

test('corrupt, symlink, directory and successor locks are preserved and refuse cancellation', (t) => {
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rb-lock-target-')), 'target.json');
  t.after(() => fs.rmSync(path.dirname(outside), { recursive: true, force: true }));
  fs.writeFileSync(outside, '{}');
  const cases = [
    ['corrupt', (x) => fs.writeFileSync(x.lockFile, '{not json'), 'LOCK_CORRUPT'],
    ['wrong-shape', (x) => fs.writeFileSync(x.lockFile, JSON.stringify({ schemaVersion: 1 })), 'LOCK_CORRUPT'],
    ['symlink', (x) => { fs.unlinkSync(x.lockFile); fs.symlinkSync(outside, x.lockFile); }, 'LOCK_CORRUPT'],
    ['dangling', (x) => { fs.unlinkSync(x.lockFile); fs.symlinkSync(`${outside}.missing`, x.lockFile); }, 'LOCK_CORRUPT'],
    ['directory', (x) => { fs.unlinkSync(x.lockFile); fs.mkdirSync(x.lockFile); }, 'LOCK_CORRUPT'],
    ['successor-token', (x) => { const lock = JSON.parse(fs.readFileSync(x.lockFile)); lock.leaseToken = 'c'.repeat(64); fs.writeFileSync(x.lockFile, JSON.stringify(lock)); }, 'LEASE_MISMATCH'],
    ['successor-run', (x) => { const lock = JSON.parse(fs.readFileSync(x.lockFile)); lock.runId = 'wf_mzzzzzzz_000000000000'; fs.writeFileSync(x.lockFile, JSON.stringify(lock)); }, 'LEASE_MISMATCH'],
  ];
  for (const [name, mutate, code] of cases) {
    const x = expiredExternal(t);
    mutate(x);
    const stateBefore = fs.readFileSync(x.stateFile);
    const lockBefore = fs.lstatSync(x.lockFile);
    const lockBytes = lockBefore.isFile() ? fs.readFileSync(x.lockFile) : null;
    assert.throws(() => x.f.controller.cancel(x.runId, { expiredExternalOwnership: x.ack }), { code }, name);
    assert.deepEqual(fs.readFileSync(x.stateFile), stateBefore, `${name}: state unchanged`);
    const lockAfter = fs.lstatSync(x.lockFile);
    assert.equal(lockAfter.ino, lockBefore.ino, `${name}: lock preserved`);
    if (lockBytes) assert.deepEqual(fs.readFileSync(x.lockFile), lockBytes);
    assert.equal(x.f.pipeline.get(x.runId).phase, 'revising');
  }
});

test('a successor lock written after state terminalization is never unlinked', (t) => {
  const x = expiredExternal(t);
  const original = fs.renameSync;
  const successor = { ...JSON.parse(fs.readFileSync(x.lockFile)), leaseToken: 'd'.repeat(64) };
  t.mock.method(fs, 'renameSync', (from, to, ...rest) => {
    original(from, to, ...rest);
    if (String(to).endsWith('state.json')) fs.writeFileSync(x.lockFile, JSON.stringify(successor));
  });
  assert.throws(() => x.f.pipeline.cancelExpiredExternalWriter(x.runId, { acknowledgement: x.ack }), { code: 'LEASE_MISMATCH' });
  assert.deepEqual(JSON.parse(fs.readFileSync(x.lockFile)), successor, 'successor lock preserved');
  // State is already durable-cancelled; there is no cross-file transaction.
  assert.equal(x.f.pipeline.get(x.runId).phase, 'cancelled');
});

// NOT RUN until root executes. Deterministic seam: wrap one fs read on one path so
// the first (authoritative) read returns its real outcome, then `replace` runs once,
// and every later read sees the replacement. `replace` must not read through fs.
function afterFirstRead(t, method, matches, replace) {
  const original = fs[method];
  const probe = { calls: 0 };
  const mocked = t.mock.method(fs, method, (file, ...rest) => {
    if (!matches(String(file))) return original(file, ...rest);
    probe.calls += 1;
    if (probe.calls > 1) return original(file, ...rest);
    let outcome;
    try { outcome = { value: original(file, ...rest) }; } catch (error) { outcome = { error }; }
    replace();
    if (outcome.error) throw outcome.error;
    return outcome.value;
  });
  probe.restore = () => mocked.mock.restore();
  return probe;
}

const isStateFile = (x) => (file) => file.endsWith(path.join(x.runId, 'state.json'));
const isLockFile = (x) => (file) => path.basename(file) === path.basename(x.lockFile);

// Returns the probe's read count taken at refusal time, before any post-hoc reads.
function assertPrePersistRefusal(t, x, run, probe, { stateBytes, lockBytes }, label) {
  const spy = t.mock.method(x.f.taskQueue, 'cancel');
  const count = x.f.tasks.size;
  assert.throws(run, { code: 'LEASE_MISMATCH' }, label);
  const reads = probe.calls;
  probe.restore();
  assert.deepEqual(fs.readFileSync(x.stateFile), stateBytes, `${label}: state bytes are exactly the replacement`);
  assert.equal(x.f.pipeline.get(x.runId).phase, 'revising', `${label}: no cancelled overwrite`);
  if (lockBytes === null) assert.equal(fs.existsSync(x.lockFile), false, `${label}: lock stays absent`);
  else assert.deepEqual(fs.readFileSync(x.lockFile), lockBytes, `${label}: lock bytes preserved`);
  assert.equal(x.f.tasks.size, count, `${label}: no queue dispatch`);
  assert.equal(spy.mock.callCount(), 0, `${label}: no queue or owner action`);
  return reads;
}

test('pre-persist state replacement after the authoritative read is refused and preserved', (t) => {
  const variants = [
    ['revision bump', (s) => { s.revision += 1; }],
    ['same-revision full-lease replacement', (s) => { s.writerLease.leaseTokenSha256 = 'e'.repeat(64); }],
    ['same-revision lease expiry replacement', (s) => { s.writerLease.expiresAt += 1000; }],
    ['same-revision unrelated state change', (s) => { s.updatedAt += 1; }],
  ];
  for (const [label, change] of variants) {
    const x = expiredExternal(t);
    const before = x.snapshot();
    const replacement = JSON.parse(before.state);
    change(replacement);
    const replacementBytes = Buffer.from(JSON.stringify(replacement));
    const probe = afterFirstRead(t, 'readFileSync', isStateFile(x), () => fs.writeFileSync(x.stateFile, replacementBytes));
    const reads = assertPrePersistRefusal(t, x, () => x.f.pipeline.cancelExpiredExternalWriter(x.runId, { acknowledgement: x.ack }),
      probe, { stateBytes: replacementBytes, lockBytes: before.lock }, label);
    assert.ok(reads >= 2, `${label}: authoritative state was reread before persistence`);
  }
});

test('pre-persist lock replacement after the first lock read is refused without release', (t) => {
  const variants = [
    ['successor token', (lock) => JSON.stringify({ ...lock, leaseToken: 'c'.repeat(64) })],
    ['successor run', (lock) => JSON.stringify({ ...lock, runId: 'wf_mzzzzzzz_000000000000' })],
    ['vanished', () => null],
  ];
  for (const [label, successor] of variants) {
    const x = expiredExternal(t);
    const before = x.snapshot();
    const replacement = successor(JSON.parse(before.lock));
    const replacementBytes = replacement === null ? null : Buffer.from(replacement);
    // A vanished lock makes the production reread throw ENOENT from lstat before any second
    // file read, so that variant counts matching-path lstat probes (pass-through) instead.
    const lstats = { calls: 0, atReplace: 0, atRefusal: 0 };
    let lstatMock = null;
    if (replacementBytes === null) {
      const lstatOriginal = fs.lstatSync;
      lstatMock = t.mock.method(fs, 'lstatSync', (file, ...rest) => {
        if (isLockFile(x)(String(file))) lstats.calls += 1;
        return lstatOriginal(file, ...rest);
      });
    }
    const probe = afterFirstRead(t, 'readFileSync', isLockFile(x), () => {
      lstats.atReplace = lstats.calls;
      if (replacementBytes === null) fs.unlinkSync(x.lockFile); else fs.writeFileSync(x.lockFile, replacementBytes);
    });
    const run = () => {
      try { return x.f.controller.cancel(x.runId, { expiredExternalOwnership: x.ack }); }
      finally { lstats.atRefusal = lstats.calls; }
    };
    const reads = assertPrePersistRefusal(t, x, run,
      probe, { stateBytes: before.state, lockBytes: replacementBytes }, label);
    if (lstatMock) lstatMock.mock.restore();
    if (replacementBytes === null) {
      assert.ok(reads >= 1, `${label}: the first lock read returned its real bytes before the lock vanished`);
      assert.ok(lstats.atReplace >= 1, `${label}: the first lock probe preceded the removal`);
      assert.ok(lstats.atRefusal > lstats.atReplace, `${label}: lock path was probed again before persistence`);
    } else {
      assert.ok(reads >= 2, `${label}: lock was reread before persistence`);
    }
  }
});

test('an initially missing lock that becomes a successor before persistence is refused', (t) => {
  const variants = [
    ['different owner', (lock) => JSON.stringify({ ...lock, leaseToken: 'c'.repeat(64) })],
    // Identical identity still refuses: the lock's presence changed after the first read.
    ['identical identity reappears', (lock) => JSON.stringify(lock)],
  ];
  for (const [label, successor] of variants) {
    const x = expiredExternal(t);
    const successorBytes = Buffer.from(successor(JSON.parse(fs.readFileSync(x.lockFile))));
    fs.unlinkSync(x.lockFile);
    const stateBytes = fs.readFileSync(x.stateFile);
    // The first lock probe still reports ENOENT; the successor is installed before the next one.
    const probe = afterFirstRead(t, 'lstatSync', isLockFile(x), () => fs.writeFileSync(x.lockFile, successorBytes));
    const reads = assertPrePersistRefusal(t, x, () => x.f.pipeline.cancelExpiredExternalWriter(x.runId, { acknowledgement: x.ack }),
      probe, { stateBytes, lockBytes: successorBytes }, label);
    assert.ok(reads >= 2, `${label}: the missing lock was reread before persistence`);
  }
});

test('an unreadable regular lock file is refused and preserved', (t) => {
  for (const code of ['EACCES', 'EIO']) {
    const x = expiredExternal(t);
    const lockStat = fs.lstatSync(x.lockFile);
    assert.ok(lockStat.isFile() && !lockStat.isSymbolicLink(), 'the lock is a real regular file');
    const before = x.snapshot();
    const count = x.f.tasks.size;
    const spy = t.mock.method(x.f.taskQueue, 'cancel');
    const original = fs.readFileSync;
    let thrown = 0;
    const mocked = t.mock.method(fs, 'readFileSync', (file, ...rest) => {
      if (!isLockFile(x)(String(file))) return original(file, ...rest);
      thrown += 1;
      throw Object.assign(new Error(`injected ${code}`), { code });
    });
    const attempts = [
      () => x.f.controller.cancel(x.runId, { expiredExternalOwnership: x.ack }),
      () => x.f.pipeline.cancelExpiredExternalWriter(x.runId, { acknowledgement: x.ack }),
    ];
    for (const attempt of attempts) {
      const reached = thrown;
      assert.throws(attempt, (error) => error.code === 'LOCK_CORRUPT' && new RegExp(`unreadable.*${code}`).test(error.message), code);
      assert.equal(thrown, reached + 1, `${code}: the regular-file read branch was reached`);
    }
    mocked.mock.restore();
    assert.deepEqual(x.snapshot(), before, `${code}: state and lock bytes unchanged`);
    assert.equal(fs.lstatSync(x.lockFile).ino, lockStat.ino, `${code}: lock inode preserved`);
    assert.equal(x.f.tasks.size, count);
    assert.equal(spy.mock.callCount(), 0);
    assert.equal(x.f.pipeline.get(x.runId).phase, 'revising');
  }
});

test('a providerRetry record is refused before any queue, owner or pipeline action', (t) => {
  const retry = { phase: 'revising', purpose: 'revision', failedProvider: 'claude', failureClass: 'transient',
    previousAttempt: 1, nextAttempt: 2, maxAttempts: 3, scheduledAt: 1, retryAt: 2, failedTaskId: 't_fake_1' };
  const x = expiredExternal(t, { legacy: true });
  const spy = t.mock.method(x.f.taskQueue, 'cancel');
  const count = x.f.tasks.size;
  const before = x.snapshot();
  const cleanWorkflow = x.f.pipeline.get(x.runId);
  // Schema unchanged: a retry beside a writer phase is already STATE_CORRUPT.
  x.edit((state) => { state.providerRetry = retry; });
  const corrupt = x.snapshot();
  assert.throws(() => x.f.controller.cancel(x.runId, { expiredExternalOwnership: x.ack }), { code: 'STATE_CORRUPT' });
  assert.throws(() => x.f.pipeline.cancelExpiredExternalWriter(x.runId, { acknowledgement: x.ack }), { code: 'STATE_CORRUPT' });
  assert.deepEqual(x.snapshot(), corrupt);
  assert.deepEqual(corrupt.lock, before.lock);
  assert.equal(x.f.tasks.size, count);
  assert.equal(spy.mock.callCount(), 0);

  // The pipeline is frozen, so exercise the controller guard through a wrapper that
  // hands it a valid clone carrying providerRetry. This proves guard ordering only;
  // it is not a reachable valid state.
  const guarded = fixtureControllerWith(t, x, {
    get: () => ({ ...cleanWorkflow, providerRetry: retry }),
  });
  assert.throws(() => guarded.controller.cancel(x.runId, { expiredExternalOwnership: x.ack }), { code: 'INVALID_EXPIRED_CANCEL' });
  assert.equal(guarded.delegated(), 0, 'no pipeline cancellation was attempted');
  assert.deepEqual(x.snapshot(), corrupt);
  assert.equal(x.f.tasks.size, count);
  assert.equal(spy.mock.callCount(), 0);
});

function fixtureControllerWith(t, x, overrides) {
  let delegated = 0;
  const pipeline = {
    ...x.f.pipeline,
    ...overrides,
    cancelExpiredExternalWriter: (...args) => { delegated += 1; return x.f.pipeline.cancelExpiredExternalWriter(...args); },
  };
  const controller = createWorkflowController({
    pipeline, taskQueue: x.f.taskQueue, incidents: x.f.incidents, loadConfig: () => x.f.config, now: () => x.f.clock.value,
  });
  t.after(() => controller.shutdown());
  return { controller, delegated: () => delegated };
}

test('a persisted provider mode cannot override the Codex-only external ownership policy', (t) => {
  const f = fixture(t); f.config.codex = { oneshot_safe: ['codex-safe'] };
  const created = reachReviewReady(f, { ...createInput(f.cwd), profile: 'codex-astra-ultra', permissionMode: 'full' });
  f.controller.claimRevision(created.runId);
  const stateFile = path.join(f.dataDir, 'workflows', created.runId, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile));
  const lockDirectory = path.join(f.dataDir, 'writer-locks');
  const locks = fs.readdirSync(lockDirectory).map((name) => [name, fs.readFileSync(path.join(lockDirectory, name))]);
  state.writerLease.mode = 'provider'; fs.writeFileSync(stateFile, JSON.stringify(state));
  for (const action of [() => f.controller.reconcile(created.runId), () => f.controller.cancel(created.runId),
    () => f.pipeline.failOrphanedRevision(created.runId, {}), () => f.pipeline.cancelOrphanedRevision(created.runId, {})]) {
    assert.throws(action, { code: 'STATE_CORRUPT' });
    for (const [name, bytes] of locks) assert.deepEqual(fs.readFileSync(path.join(lockDirectory, name)), bytes);
  }
});

test('status reads are inert and explicit reconciliation advances persisted handoffs', (t) => {
  const f = fixture(t);
  const created = f.controller.create(createInput(f.cwd));
  f.pipeline.completeResearch(created.runId, { markdown: 'durable research' });

  const viewed = f.controller.view(created.runId);
  assert.equal(viewed.workflow.phase, 'research_ready');
  assert.deepEqual(viewed.nextActions, ['reconcile_pipeline']);
  assert.equal(f.tasks.size, 0, 'a status read must not dispatch provider work');

  const reconciled = f.controller.reconcile(created.runId);
  assert.equal(reconciled.workflow.phase, 'planning');
  assert.ok(reconciled.workflow.providerTask);
  assert.equal(f.tasks.size, 1, 'only explicit reconciliation may dispatch the handoff');
});

test('failed planning writes a correlated budget incident before failing without approval', (t) => {
  const f = fixture(t);
  const created = f.controller.create(createInput(f.cwd));
  const planning = f.controller.submitResearch(created.runId, { markdown: 'Research evidence.' });
  f.finish(planning.task, '50060 exceeded maxTotalTokens 50000', 'failed', {
    failureClass: 'budget_exceeded', flags: { budget_exceeded: true }, receiptId: 'rcpt_budget',
  });
  const result = f.controller.reconcile(created.runId);
  assert.equal(result.workflow.phase, 'failed');
  const [incident] = f.incidents.list();
  assert.equal(incident.classification, 'budget_exceeded');
  assert.equal(incident.correlation.taskId, planning.task.id);
  assert.equal(incident.correlation.receiptId, 'rcpt_budget');
  assert.equal(incident.phase, 'planning');
  assert.equal(incident.summary.includes('50060'), false);
  f.controller.reconcile(created.runId);
  assert.equal(f.incidents.stats().total, 1);
});

function createInput(cwd, taskTier = 'complex', permissionMode = 'full') {
  return {
    cwd,
    objective: 'Implement the bounded change.',
    constraints: ['Preserve compatibility.'],
    nonGoals: ['No unrelated refactor.'],
    fileScope: ['lib/target.js', 'test/target.test.js'],
    baseRevision: 'abc123',
    acceptance: ['Focused tests pass.'],
    taskTier,
    permissionMode,
  };
}

test('expired implementation status is inert and explains why renewal/completion are unavailable', (t) => {
  const f = fixture(t);
  const created = f.controller.create(createInput(f.cwd));
  f.pipeline.completeResearch(created.runId, { markdown: 'Research.' });
  f.pipeline.startPlanning(created.runId);
  f.pipeline.completePlanning(created.runId, { markdown: 'Accepted bounded plan.' });
  const started = f.controller.startImplementation(created.runId, { leaseMs: 100 });
  const before = JSON.stringify(f.pipeline.get(created.runId));
  const live = f.controller.view(created.runId, { includeArtifacts: false });
  assert.deepEqual(live.nextActions, ['complete_pipeline_implementation', 'renew_pipeline_writer_lease']);
  assert.equal(live.blockedActions, undefined);
  f.clock.value = started.lease.expiresAt;
  for (let read = 0; read < 3; read += 1) {
    const view = f.controller.view(created.runId, { includeArtifacts: false });
    assert.equal(view.workflow.phase, 'implementing');
    assert.deepEqual(view.nextActions, []);
    assert.deepEqual(view.blockedActions, [{ code: 'LEASE_EXPIRED', recovery: 'unavailable_unbound_owner',
      actions: ['complete_pipeline_implementation', 'renew_pipeline_writer_lease'] }]);
    assert.equal(JSON.stringify(f.pipeline.get(created.runId)), before);
    assert.equal(f.tasks.size, 0, 'status never dispatches a replacement provider');
  }
  assert.throws(() => f.controller.renewWriterLease(created.runId, { leaseToken: started.lease.leaseToken }),
    (error) => error.code === 'LEASE_EXPIRED');
  assert.throws(() => f.controller.completeImplementation(created.runId, {
    leaseToken: started.lease.leaseToken, markdown: 'Must not advance expired work.' }),
  (error) => error.code === 'LEASE_EXPIRED');
  assert.equal(JSON.stringify(f.pipeline.get(created.runId)), before);
});

test('missing implementation lease identity never advertises completion or renewal', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.controller.nextActions({ phase: 'implementing', writerLease: null }), []);
  assert.deepEqual(f.controller.nextActions({ phase: 'implementing', writerLease: { expiresAt: 'later' } }), []);
});

test('controller drives the complete Codex-Claude handoff without overlapping writers', (t) => {
  const f = fixture(t);
  const created = f.controller.create(createInput(f.cwd));
  assert.equal(created.phase, 'scoping');

  const planning = f.controller.submitResearch(created.runId, {
    markdown: '# Research\nLocated the implementation boundary.',
  });
  assert.equal(planning.workflow.phase, 'planning');
  assert.equal(planning.task.kind, 'claude');
  assert.equal(planning.task.modelTier, 'heavy');
  assert.equal(planning.task.effort, 'high');
  assert.equal(planning.task.dangerous, false);
  assert.match(planning.task.prompt, /## File scope\n\n- lib\/target\.js/);
  assert.doesNotMatch(planning.task.prompt, /- - lib\/target\.js/);

  f.finish(planning.task, '# Plan\n1. Change the target.\n2. Test it.\n\nPLAN_STATUS: READY');
  assert.equal(f.controller.reconcile(created.runId).workflow.phase, 'plan_ready');

  const implementation = f.controller.startImplementation(created.runId);
  assert.equal(implementation.workflow.phase, 'implementing');
  assert.equal(implementation.lease.actor, 'codex');

  const review = f.controller.completeImplementation(created.runId, {
    leaseToken: implementation.lease.leaseToken,
    markdown: '# Implementation\nChanged both scoped files and ran focused tests.',
  });
  assert.equal(review.workflow.phase, 'reviewing');
  assert.equal(review.task.kind, 'claude');
  assert.equal(review.task.modelTier, 'standard');
  assert.equal(review.task.effort, 'high');
  assert.equal(review.task.dangerous, false);
  assert.equal(review.workflow.writerLease, null);

  f.finish(review.task, '# Review\nAdd one boundary assertion.\n\nREVIEW_VERDICT: REVISE');
  const reviewed = f.controller.reconcile(created.runId);
  assert.equal(reviewed.workflow.phase, 'review_ready');
  assert.deepEqual(reviewed.nextActions, ['start_pipeline_revision']);

  const revision = f.controller.startRevision(created.runId);
  assert.equal(revision.workflow.phase, 'revising');
  assert.equal(revision.task.kind, 'claude');
  assert.equal(revision.task.modelTier, 'heavy');
  assert.equal(revision.task.effort, 'high');
  assert.equal(revision.task.dangerous, true);
  assert.equal(revision.workflow.writerLease.actor, 'claude-reviser');

  f.finish(revision.task, '# Revision\nAdded the assertion; tests pass.\n\nREVISION_STATUS: APPLIED');
  const revised = f.controller.reconcile(created.runId);
  assert.equal(revised.workflow.phase, 'revision_ready');
  assert.equal(revised.workflow.writerLease, null);

  const finalReview = f.controller.startFinalReview(created.runId);
  assert.equal(finalReview.workflow.phase, 'final_reviewing');
  assert.match(finalReview.task.title, /final-review/);
  f.finish(finalReview.task, '# Final review\nNo material findings.\n\nREVIEW_VERDICT: APPROVE');
  const completed = f.controller.reconcile(created.runId);
  assert.equal(completed.workflow.phase, 'complete');
  assert.deepEqual(completed.nextActions, []);
});

test('a local token-budget stop never retries even with independent accepted 429 evidence', (t) => {
  const f = fixture(t);
  const created = reachReviewReady(f, createInput(f.cwd), 'APPROVE');
  const first = f.controller.startFinalReview(created.runId);
  f.finish(first.task, 'local cache-read budget crossed; provider also returned 429', 'failed', {
    failureClass: 'token_budget', flags: { rate_limited: true, timed_out: true },
    retryAt: f.clock.value + 300000,
  });
  const failed = f.controller.reconcile(created.runId);
  assert.equal(failed.workflow.phase, 'failed');
  assert.equal(failed.workflow.providerRetry, null);
  assert.equal(failed.workflow.providerTask, null);
  assert.equal(failed.workflow.providerTaskHistory.filter((item) => item.purpose === 'final-review').length, 1);
  assert.equal(failed.nextActions.includes('retry_failed_pipeline_provider'), false);
});

test('typed transient review failures retry after backoff and stop at the bounded attempt limit', (t) => {
  const f = fixture(t);
  const created = reachReviewReady(f, createInput(f.cwd), 'APPROVE');
  const first = f.controller.startFinalReview(created.runId);
  f.finish(first.task, 'provider 429', 'failed', {
    failureClass: 'rate_limit',
    flags: { rate_limited: true, timed_out: false },
    retryAt: f.clock.value + 300000,
  });

  const scheduledSecond = f.controller.reconcile(created.runId);
  assert.equal(scheduledSecond.workflow.phase, 'final_reviewing');
  assert.equal(scheduledSecond.workflow.providerTask, null);
  assert.equal(scheduledSecond.workflow.providerRetry.nextAttempt, 2);
  assert.equal(scheduledSecond.workflow.providerRetry.retryAt, 1300000,
    'the workflow must inherit the cooldown store deadline instead of guessing 60 seconds');
  assert.deepEqual(scheduledSecond.nextActions, ['reconcile_pipeline']);
  assert.equal(f.controller.reconcile(created.runId).workflow.providerTask, null,
    'polling before retryAt must not spend another provider attempt');

  f.clock.value = scheduledSecond.workflow.providerRetry.retryAt;
  const secondState = f.controller.reconcile(created.runId).workflow;
  const second = f.tasks.get(secondState.providerTask.taskId);
  assert.equal(secondState.providerTask.attempt, 2);
  f.finish(second, 'provider 429 again', 'failed', {
    failureClass: 'rate_limit',
    flags: { rate_limited: true, timed_out: false },
  });
  const scheduledThird = f.controller.reconcile(created.runId).workflow;
  assert.equal(scheduledThird.providerRetry.nextAttempt, 3);

  f.clock.value = scheduledThird.providerRetry.retryAt;
  const thirdState = f.controller.reconcile(created.runId).workflow;
  const third = f.tasks.get(thirdState.providerTask.taskId);
  assert.equal(thirdState.providerTask.attempt, 3);
  f.finish(third, 'provider 429 exhausted', 'failed', {
    failureClass: 'rate_limit',
    flags: { rate_limited: true, timed_out: false },
  });
  const failed = f.controller.reconcile(created.runId).workflow;
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.providerTaskHistory.filter((item) => item.purpose === 'final-review').length, 3);
  assert.deepEqual(
    failed.providerTaskHistory.filter((item) => item.purpose === 'final-review').map((item) => item.outcome),
    ['retry_scheduled', 'retry_scheduled', 'failed'],
  );
  assert.deepEqual(f.controller.nextActions(failed), [], 'an exhausted failure must not advertise retry');
});

test('an older terminal 429 can be explicitly recovered but an untyped semantic failure cannot', (t) => {
  const f = fixture(t);
  const created = reachReviewReady(f, createInput(f.cwd), 'APPROVE');
  const finalReview = f.controller.startFinalReview(created.runId);
  f.finish(finalReview.task, 'provider 429', 'failed', {
    failureClass: 'rate_limit', flags: { rate_limited: true },
  });
  f.pipeline.fail(created.runId, { actor: 'relaybridge', reason: 'legacy terminal behavior' });
  assert.deepEqual(f.controller.nextActions(f.pipeline.get(created.runId)), ['retry_failed_pipeline_provider']);
  f.clock.value += 60000;
  const recovered = f.controller.retryFailedProvider(created.runId, { actor: 'codex' });
  assert.equal(recovered.workflow.phase, 'final_reviewing');
  assert.equal(recovered.workflow.providerTask.attempt, 2);
  const replacement = f.tasks.get(recovered.workflow.providerTask.taskId);
  f.finish(replacement, 'REVIEW_VERDICT: APPROVE');
  assert.equal(f.controller.reconcile(created.runId).workflow.phase, 'complete');

  const other = reachReviewReady(f, { ...createInput(f.cwd), objective: 'Second workflow.' }, 'APPROVE');
  const invalid = f.controller.startFinalReview(other.runId);
  f.finish(invalid.task, 'missing marker', 'failed', { failureClass: 'provider_error' });
  f.pipeline.fail(other.runId, { actor: 'relaybridge', reason: 'semantic provider failure' });
  assert.deepEqual(f.controller.nextActions(f.pipeline.get(other.runId)), []);
  assert.throws(() => f.controller.retryFailedProvider(other.runId), (error) => {
    assert.ok(error instanceof WorkflowControllerError);
    assert.equal(error.code, 'PROVIDER_RETRY_NOT_ALLOWED');
    return true;
  });
});

test('bridge-interrupted tasks require explicit recovery instead of automatic replay', (t) => {
  const f = fixture(t);
  const created = f.controller.create(createInput(f.cwd));
  const planning = f.controller.submitResearch(created.runId, { markdown: 'research' });
  f.finish(planning.task, 'bridge restarted', 'interrupted', { execution: { state: 'uncertain' } });

  const stopped = f.controller.reconcile(created.runId);
  assert.equal(stopped.workflow.phase, 'failed');
  assert.equal(stopped.workflow.providerTask, null);
  assert.deepEqual(stopped.nextActions, []);
  assert.equal(f.tasks.size, 1, 'status polling must not overlap a potentially surviving process');

  assert.throws(() => f.controller.retryFailedProvider(created.runId, { actor: 'operator' }),
    (error) => error.code === 'EXECUTION_TERMINATION_REQUIRED');
  f.tasks.get(planning.task.id).execution = { state: 'fenced', proof: { evidenceId: 'fence_1' } };
  const recovered = f.controller.retryFailedProvider(created.runId, { actor: 'operator' });
  assert.equal(recovered.workflow.phase, 'planning');
  assert.equal(recovered.workflow.providerTask.attempt, 2);
  assert.equal(f.tasks.size, 2, 'only the explicit recovery action may dispatch a replacement');
});

test('critical planning uses Fable while safe workflows cannot grant Claude a writer lease', (t) => {
  const f = fixture(t);
  const critical = f.controller.create(createInput(f.cwd, 'critical', 'safe'));
  const planning = f.controller.submitResearch(critical.runId, { markdown: 'Critical research.' });
  assert.equal(planning.task.kind, 'claude_fable');
  assert.equal(planning.task.modelTier, 'heavy');
  assert.equal(planning.task.effort, 'high');

  f.finish(planning.task, 'PLAN_STATUS: READY');
  f.controller.reconcile(critical.runId);
  const implementation = f.controller.startImplementation(critical.runId);
  const review = f.controller.completeImplementation(critical.runId, {
    leaseToken: implementation.lease.leaseToken,
    markdown: 'Implementation evidence.',
  });
  f.finish(review.task, 'REVIEW_VERDICT: REVISE');
  f.controller.reconcile(critical.runId);
  assert.throws(() => f.controller.startRevision(critical.runId), (error) => {
    assert.ok(error instanceof WorkflowControllerError);
    assert.equal(error.code, 'FULL_PERMISSION_REQUIRED');
    return true;
  });
});

test('a rejected final review is carried into revision and queued revision cancellation releases its lock', (t) => {
  const f = fixture(t);
  const input = {
    ...createInput(f.cwd),
    providerPreferences: { revision: ['claude_fable'], finalReview: ['claude'] },
  };
  const created = reachReviewReady(f, input, 'APPROVE');
  const finalReview = f.controller.startFinalReview(created.runId);
  f.finish(finalReview.task, 'Final-only stale-cache race finding.\nREVIEW_VERDICT: REVISE');
  const rejected = f.controller.reconcile(created.runId);
  assert.equal(rejected.workflow.phase, 'review_ready');
  assert.equal(rejected.workflow.revisionRequested, true);

  const revision = f.controller.startRevision(created.runId);
  assert.equal(revision.task.kind, 'claude', 'Fable must never receive a writer lease');
  assert.match(revision.task.prompt, /## Initial review context[\s\S]*Initial review context unique/);
  assert.match(revision.task.prompt,
    /## Latest final-review findings requiring revision[\s\S]*Final-only stale-cache race finding/);

  const cancelled = f.controller.cancel(created.runId, { reason: 'Stop before the queued writer begins.' });
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(cancelled.writerLease, null);
  assert.equal(f.tasks.get(revision.task.id).status, 'cancelled');

  const replacement = reachReviewReady(f, createInput(f.cwd), 'APPROVE');
  const replacementFinal = f.controller.startFinalReview(replacement.runId);
  assert.equal(replacementFinal.workflow.phase, 'final_reviewing', 'the cancelled writer left no stale cwd lock');
});

test('invalid provider markers and task identity fail closed without authorizing a writer', (t) => {
  const planningFixture = fixture(t);
  const planningRun = planningFixture.controller.create(createInput(planningFixture.cwd));
  const planning = planningFixture.controller.submitResearch(planningRun.runId, { markdown: 'research' });
  planningFixture.finish(planning.task, 'Cannot plan this safely.\nPLAN_STATUS: BLOCKED');
  assert.equal(planningFixture.controller.reconcile(planningRun.runId).workflow.phase, 'failed');

  const identityFixture = fixture(t);
  const identityRun = identityFixture.controller.create(createInput(identityFixture.cwd));
  const identityTask = identityFixture.controller.submitResearch(identityRun.runId, { markdown: 'research' }).task;
  identityFixture.tasks.get(identityTask.id).kind = 'codex';
  assert.equal(identityFixture.controller.reconcile(identityRun.runId).workflow.phase, 'failed');

  const revisionFixture = fixture(t);
  const revisionRun = reachReviewReady(revisionFixture);
  const revision = revisionFixture.controller.startRevision(revisionRun.runId);
  revisionFixture.finish(revision.task, 'No trustworthy completion marker.');
  const failed = revisionFixture.controller.reconcile(revisionRun.runId).workflow;
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.writerLease, null);
  assert.equal(failed.providerTaskHistory.at(-1).outcome, 'failed');

  const runningFixture = fixture(t);
  const runningRun = reachReviewReady(runningFixture);
  const runningRevision = runningFixture.controller.startRevision(runningRun.runId);
  Object.assign(runningFixture.tasks.get(runningRevision.task.id), { status: 'running', kind: 'unexpected_writer' });
  assert.throws(() => runningFixture.controller.reconcile(runningRun.runId), (error) => {
    assert.ok(error instanceof WorkflowControllerError);
    assert.equal(error.code, 'WRITER_TASK_RUNNING');
    return true;
  });
  assert.equal(runningFixture.pipeline.get(runningRun.runId).phase, 'revising');
  assert.ok(runningFixture.pipeline.get(runningRun.runId).writerLease,
    'a mismatched running process must remain fenced by its lease');
  Object.assign(runningFixture.tasks.get(runningRevision.task.id), {
    status: 'failed', kind: 'claude', error: 'fixture cleanup',
  });
  runningFixture.controller.reconcile(runningRun.runId);
  assert.equal(runningFixture.pipeline.get(runningRun.runId).phase, 'failed');
});

test('reserved task IDs are bound before queue persistence and restart recovers an unbound revision', (t) => {
  const f = fixture(t);
  const created = f.controller.create(createInput(f.cwd));
  const originalSubmit = f.taskQueue.submitReserved.bind(f.taskQueue);
  f.taskQueue.submitReserved = (id, input) => {
    const state = f.pipeline.get(created.runId);
    assert.equal(state.providerTask.taskId, id, 'task correlation must be durable before queue admission');
    return originalSubmit(id, input);
  };
  const planning = f.controller.submitResearch(created.runId, { markdown: 'research' });
  assert.equal(planning.workflow.providerTask.taskId, planning.task.id);

  f.finish(planning.task, 'plan\nPLAN_STATUS: READY');
  f.controller.reconcile(created.runId);
  const implementation = f.controller.startImplementation(created.runId);
  const review = f.controller.completeImplementation(created.runId, {
    leaseToken: implementation.lease.leaseToken, markdown: 'implementation',
  });
  f.finish(review.task, 'review\nREVIEW_VERDICT: REVISE');
  f.controller.reconcile(created.runId);

  // Simulate a hard stop after lease acquisition but before an ID was bound.
  f.pipeline.startRevision(created.runId, { actor: 'claude-reviser', mode: 'provider' });
  const restartedPipeline = createWorkflowPipeline({ dataDir: f.dataDir });
  const restartedController = createWorkflowController({
    pipeline: restartedPipeline,
    taskQueue: f.taskQueue,
    loadConfig: () => f.config,
  });
  const recovered = restartedController.reconcile(created.runId).workflow;
  assert.equal(recovered.phase, 'failed');
  assert.equal(recovered.writerLease, null);
});

test('sync resumes crash-interrupted research and implementation handoffs', (t) => {
  const f = fixture(t);
  const created = f.controller.create(createInput(f.cwd));

  // Simulate a crash after the artifact transition but before controller
  // dispatch. Explicit reconciliation must perform the missing read-only handoff.
  f.pipeline.completeResearch(created.runId, { markdown: 'durable research' });
  assert.equal(f.pipeline.get(created.runId).phase, 'research_ready');
  const planning = f.controller.reconcile(created.runId).workflow;
  assert.equal(planning.phase, 'planning');
  assert.ok(planning.providerTask);
  const planningTask = f.tasks.get(planning.providerTask.taskId);
  assert.ok(planningTask);

  f.finish(planningTask, 'plan\nPLAN_STATUS: READY');
  f.controller.reconcile(created.runId);
  const implementation = f.pipeline.startImplementation(created.runId);
  f.pipeline.completeImplementation(created.runId, {
    leaseToken: implementation.lease.leaseToken,
    markdown: 'durable implementation evidence',
  });
  assert.equal(f.pipeline.get(created.runId).phase, 'implementation_ready');
  const reviewing = f.controller.reconcile(created.runId).workflow;
  assert.equal(reviewing.phase, 'reviewing');
  assert.ok(f.tasks.has(reviewing.providerTask.taskId));

  const second = f.controller.create({ ...createInput(f.cwd), objective: 'Recover an unbound planning phase.' });
  f.pipeline.completeResearch(second.runId, { markdown: 'research' });
  f.pipeline.startPlanning(second.runId);
  assert.equal(f.pipeline.get(second.runId).providerTask, null);
  assert.ok(f.controller.reconcile(second.runId).workflow.providerTask,
    'a read-only provider phase without a binding is safe to redispatch');
});

for (const state of ['interrupted', 'cancelled', 'missing', 'malformed']) {
  test(`a ${state} bound writer retains its lease until execution is fenced`, (t) => {
    const f = fixture(t);
    const created = reachReviewReady(f);
    const revision = f.controller.startRevision(created.runId);
    if (state === 'missing') f.tasks.delete(revision.task.id);
    else Object.assign(f.tasks.get(revision.task.id), { status: state === 'malformed' ? 'failed' : state,
      execution: state === 'malformed' ? {} : { state: 'uncertain' } });
    const before = f.pipeline.get(created.runId);
    assert.throws(() => f.controller.reconcile(created.runId), (e) => e.code === 'WRITER_EXECUTION_UNCERTAIN');
    assert.throws(() => f.controller.cancel(created.runId), (e) => e.code === 'WRITER_EXECUTION_UNCERTAIN');
    assert.equal(f.pipeline.get(created.runId).phase, 'revising');
    assert.equal(f.pipeline.get(created.runId).writerLease.leaseToken, before.writerLease.leaseToken);
    assert.equal(f.pipeline.get(created.runId).providerTask.taskId, revision.task.id);
    if (state !== 'missing') {
      f.tasks.get(revision.task.id).execution = { state: 'fenced', proof: { evidenceId: 'process-fence' } };
      assert.equal(f.controller.cancel(created.runId).phase, 'cancelled');
      assert.equal(f.pipeline.get(created.runId).writerLease, null);
    }
  });
}

test('a partial terminal task cannot approve a review even when its text contains APPROVE', (t) => {
  const f = fixture(t);
  const created = reachReviewReady(f, createInput(f.cwd), 'APPROVE');
  const final = f.controller.startFinalReview(created.runId);
  f.finish(final.task, 'REVIEW_VERDICT: APPROVE', 'done', { flags: { partial_result: true }, receiptId: 'rcpt_partial' });
  assert.equal(f.controller.reconcile(created.runId).workflow.phase, 'failed');
  assert.equal(f.incidents.list()[0].classification, 'partial_output');
});

test('workflow request links persist but planning success and status reads do not assert feature milestones', (t) => {
  const f = fixture(t);
  const ledgerDir = path.join(f.dataDir, 'requirements');
  const ledger = createRequestLedger({ dataDir: ledgerDir });
  const controller = createWorkflowController({ pipeline: f.pipeline, taskQueue: f.taskQueue,
    loadConfig: () => f.config, requestLedger: ledger });
  t.after(() => controller.shutdown());
  const created = controller.create(createInput(f.cwd));
  controller.createRequest({ requestId: 'req_queue', actor: 'operator', requirements: [{ requirementId: 'R13', summary: 'Counts' }] });
  controller.linkRequest(created.runId, { requestId: 'req_queue', actor: 'operator' });
  const planning = controller.submitResearch(created.runId, { markdown: 'research' });
  f.finish(planning.task, 'PLAN_STATUS: READY');
  controller.reconcile(created.runId);
  const file = path.join(ledgerDir, 'request-ledger.json');
  const before = fs.readFileSync(file, 'utf8');
  assert.deepEqual(controller.view(created.runId).requestLinks, [{ requestId: 'req_queue', requirementIds: ['R13'] }]);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(controller.getRequest('req_queue').events.length, 0);
  const revision = 'a'.repeat(40);
  controller.recordRequirementEvidence('req_queue', { eventId: 'evt_plan', requirementId: 'R13', actor: 'planner',
    revision, milestone: 'planned', outcome: 'confirmed', evidence: [{ kind: 'artifact', ref: 'plan-artifact' }],
    correlation: { runId: created.runId, taskId: planning.task.id } });
  const coverage = createRequestLedger({ dataDir: ledgerDir }).get('req_queue', { revision }).coverage[0];
  assert.equal(coverage.milestones.planned.outcome, 'confirmed');
  for (const key of ['implemented', 'tested', 'approved', 'merged', 'deployed']) assert.equal(coverage.milestones[key].outcome, 'unknown');
  assert.throws(() => f.controller.createRequest({}), (e) => e.code === 'REQUEST_LEDGER_UNAVAILABLE');
});

test('frequent uncertain-writer reconciliation cannot postpone its lease heartbeat', (t) => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const created = reachReviewReady(f);
  const revision = f.controller.startRevision(created.runId, { leaseMs: 60000 });
  Object.assign(f.tasks.get(revision.task.id), { status: 'cancelled', execution: { state: 'uncertain' } });
  const originalExpiry = f.pipeline.get(created.runId).writerLease.expiresAt;
  for (let i = 0; i < 25; i++) {
    f.clock.value += 1000;
    assert.throws(() => f.controller.reconcile(created.runId), (e) => e.code === 'WRITER_EXECUTION_UNCERTAIN');
    t.mock.timers.tick(1000);
  }
  assert.ok(f.pipeline.get(created.runId).writerLease.expiresAt > originalExpiry,
    'the existing heartbeat must run despite reconciliation on every second');
});


test('incomplete instruction or verdict authority fails durably before automatic retry', (t) => {
  for (const patch of [{ route: { prompt_truncated: true } }, { resultIntegrity: { truncated: true } },
    { resultIntegrity: { inputTruncated: true } }]) {
    const f = fixture(t);
    const created = f.controller.create(createInput(f.cwd));
    const planning = f.controller.submitResearch(created.runId, { markdown: 'Research evidence.' });
    f.finish(planning.task, 'PLAN_STATUS: READY', 'failed', { flags: { rate_limited: true }, ...patch });
    const state = f.controller.reconcile(created.runId);
    const stored = f.pipeline.get(created.runId);
    assert.equal(stored.phase, 'failed'); assert.equal(stored.providerRetry, null);
    assert.match(stored.terminal.reason, /artifact_truncated/);
    assert.equal(f.tasks.size, 1);
  }
});

// Managed-writer tests use the real durable pipeline and a fake queue, never a provider.
function reachPlanReady(f, extra = {}) {
  const run = f.controller.create({ ...createInput(f.cwd), ...extra });
  const planning = f.controller.submitResearch(run.runId, { markdown: 'Research evidence.' });
  f.finish(planning.task, 'Accepted plan.\nPLAN_STATUS: READY');
  return f.controller.reconcile(run.runId).workflow;
}

function writerFiles(f, runId) {
  return [fs.readFileSync(path.join(f.dataDir, 'workflows', runId, 'state.json'), 'utf8'),
    fs.readdirSync(path.join(f.dataDir, 'writer-locks')).map((name) =>
      [name, fs.readFileSync(path.join(f.dataDir, 'writer-locks', name), 'utf8')])];
}

test('managed initial writer binds before queue admission, completes once, and requests fresh review', (t) => {
  const f = fixture(t), run = reachPlanReady(f);
  assert.deepEqual(f.controller.view(run.runId).nextActions, ['claim_pipeline_implementation', 'start_pipeline_implementation']);
  const submit = f.taskQueue.submitReserved.bind(f.taskQueue);
  f.taskQueue.submitReserved = (id, input) => {
    const state = f.pipeline.get(run.runId);
    assert.equal(state.phase, 'implementing');
    assert.equal(state.providerTask.taskId, id);
    assert.equal(state.writerLease.mode, 'provider');
    assert.ok(!state.history.some((row) => row.event === 'implementation_completed'));
    return submit(id, input);
  };
  const started = f.controller.startManagedImplementation(run.runId);
  f.taskQueue.submitReserved = submit;
  assert.equal(f.tasks.size, 2);
  assert.equal(started.task.kind, 'claude');
  assert.equal(started.task.user, 'claude-implementer');
  assert.equal(started.task.dangerous, true);
  assert.deepEqual(started.task.correlation, { runId: run.runId, requestId: started.task.id,
    invocationId: started.task.id, attemptId: `${started.task.id}:attempt:1` });
  assert.ok(!JSON.stringify(started).includes('"leaseToken":'));
  assert.deepEqual(f.controller.view(run.runId).nextActions, ['reconcile_pipeline']);
  assert.throws(() => f.controller.completeImplementation(run.runId, { markdown: 'forged' }), { code: 'INVALID_WRITER_MODE' });
  assert.throws(() => f.controller.renewWriterLease(run.runId, {}), { code: 'INVALID_WRITER_MODE' });
  f.finish(started.task, 'Changed the scoped files; fixture checks passed.\nIMPLEMENTATION_STATUS: COMPLETE',
    'done', { execution: { state: 'settled' } });
  const reviewed = f.controller.reconcile(run.runId).workflow;
  assert.equal(reviewed.phase, 'reviewing');
  assert.equal(reviewed.writerLease, null);
  assert.equal(reviewed.providerTaskHistory.at(-1).purpose, 'implementation');
  assert.equal(reviewed.providerTaskHistory.at(-1).outcome, 'completed');
  assert.match(f.tasks.get(reviewed.providerTask.taskId).prompt, /Implementation evidence from the managed Claude writer/);
  assert.equal(f.tasks.get(reviewed.providerTask.taskId).modelTier, 'standard');
  assert.equal(f.tasks.get(reviewed.providerTask.taskId).effort, 'high');
  assert.match(f.pipeline.readArtifact(run.runId, 'implementation').content, /IMPLEMENTATION_STATUS: COMPLETE/);
  f.controller.reconcile(run.runId);
  assert.equal(f.tasks.size, 3, 'repeat reconciliation does not dispatch a second review');
});

test('managed admission refusals leave durable state, cwd locks and queue unchanged', (t) => {
  const cases = [
    ['safe', { permissionMode: 'safe' }, {}, 'FULL_PERMISSION_REQUIRED'],
    ['profile', { profile: 'codex-astra-ultra' }, {}, 'INVALID_WRITER_MODE'],
    ['preference', { providerPreferences: { implementation: ['claude_fable'] } }, {}, 'PROVIDER_RESTRICTION'],
    ['actor', {}, { actor: 'codex' }, 'PROVIDER_RESTRICTION'],
    ['owned', {}, { ownedLease: false }, 'INVALID_ARGUMENT'],
    ['scope', {}, { allowedWritePaths: ['lib/target.js'] }, 'INVALID_ARGUMENT'],
    ['model', {}, { model: 'opus' }, 'INVALID_ARGUMENT'],
    ['null lease', {}, { leaseMs: null }, 'INVALID_ARGUMENT'],
    ['small lease', {}, { leaseMs: 59999 }, 'INVALID_ARGUMENT'],
    ['large lease', {}, { leaseMs: 86400001 }, 'INVALID_ARGUMENT'],
    ['missing slot', {}, {}, 'PROVIDER_UNAVAILABLE'],
    ['conflict', {}, {}, 'WRITER_CONFLICT'],
  ];
  for (const [name, extra, input, code] of cases) {
    const f = fixture(t);
    f.config.codex = { oneshot_safe: ['codex-safe'] };
    const run = reachPlanReady(f, extra);
    if (name === 'missing slot') f.config.claude.oneshot_dangerous = [];
    if (name === 'conflict') {
      const other = reachPlanReady(f);
      f.controller.startImplementation(other.runId);
    }
    const before = writerFiles(f, run.runId), count = f.tasks.size;
    assert.throws(() => f.controller.startManagedImplementation(run.runId, input), { code }, name);
    assert.deepEqual(writerFiles(f, run.runId), before, name);
    assert.equal(f.tasks.size, count, name);
    if (name === 'safe' || name === 'profile') {
      assert.deepEqual(f.controller.view(run.runId).nextActions, ['claim_pipeline_implementation']);
    }
  }
});

test('wrong-phase managed admission never reconciles or dispatches a pending handoff', (t) => {
  for (const phase of ['research_ready', 'implementation_ready']) {
    const f = fixture(t);
    let run;
    if (phase === 'research_ready') {
      run = f.controller.create(createInput(f.cwd));
      f.pipeline.completeResearch(run.runId, { markdown: 'Research.' });
    } else {
      run = reachPlanReady(f);
      const count = f.tasks.size;
      const claimed = f.controller.startImplementation(run.runId);
      assert.equal(f.tasks.size, count, 'external claim dispatches nothing');
      f.pipeline.completeImplementation(run.runId, { leaseToken: claimed.lease.leaseToken, markdown: 'Real external evidence.' });
    }
    const before = writerFiles(f, run.runId), count = f.tasks.size;
    assert.throws(() => f.controller.startManagedImplementation(run.runId), { code: 'INVALID_TRANSITION' });
    assert.deepEqual(writerFiles(f, run.runId), before);
    assert.equal(f.tasks.size, count);
  }
});

test('unbound provider crash releases only its own reservation', (t) => {
  for (const mode of ['orphan reconcile', 'orphan cancel']) {
    const f = fixture(t), run = reachPlanReady(f);
    f.pipeline.startImplementation(run.runId, { actor: 'claude-implementer', mode: 'provider' });
    const restarted = createWorkflowController({ pipeline: createWorkflowPipeline({ dataDir: f.dataDir }),
      taskQueue: f.taskQueue, loadConfig: () => f.config });
    t.after(() => restarted.shutdown());
    if (mode === 'orphan cancel') restarted.cancel(run.runId);
    else { restarted.reconcile(run.runId); restarted.reconcile(run.runId); }
    assert.equal(f.pipeline.get(run.runId).phase, mode === 'orphan cancel' ? 'cancelled' : 'failed');
    assert.equal(f.pipeline.get(run.runId).writerLease, null);
    assert.deepEqual(fs.readdirSync(path.join(f.dataDir, 'writer-locks')), []);
    assert.equal(f.tasks.size, 1);
  }
});

for (const phase of ['implementation', 'revision']) {
  test(`${phase} submission directory-fsync failure cancels the published task before releasing the writer`,
    { skip: process.platform === 'win32' ? 'directory fsync is a POSIX queue durability barrier' : false }, (t) => {
    const f = fixture(t), run = phase === 'implementation' ? reachPlanReady(f) : reachReviewReady(f);
    const dir = path.join(f.dataDir, 'durable-tasks');
    const queue = createTaskQueue({ dataDir: dir, autoStart: false, now: () => f.clock.value,
      executeOneShot() { assert.fail('no provider should be invoked'); } });
    t.after(() => queue.shutdown());
    const controller = createWorkflowController({ pipeline: f.pipeline, taskQueue: queue,
      loadConfig: () => f.config, now: () => f.clock.value });
    t.after(() => controller.shutdown());
    const originalSync = fs.fsyncSync;
    const originalOpen = fs.openSync;
    let queueDirectoryFd = null;
    let published = null;
    t.mock.method(fs, 'openSync', (file, ...args) => {
      const fd = originalOpen(file, ...args);
      if (file === dir) queueDirectoryFd = fd;
      return fd;
    });
    t.mock.method(fs, 'fsyncSync', (fd) => {
      // Inject exactly the post-rename directory barrier failure, not a
      // fabricated submission result or a workflow-store failure.
      if (!published && fd === queueDirectoryFd && fs.fstatSync(fd).isDirectory()) {
        const name = fs.readdirSync(dir).find((entry) => /^t_.*\.json$/.test(entry));
        published = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        throw Object.assign(new Error('fixture queue directory fsync EIO'), { code: 'EIO' });
      }
      return originalSync(fd);
    });
    const start = () => phase === 'implementation' ? controller.startManagedImplementation(run.runId) : controller.startRevision(run.runId);
    assert.throws(start, /fixture queue directory fsync EIO/);
    assert.equal(published.status, 'queued');
    assert.equal(published.execution.state, 'never_started');
    const cancelled = queue.get(published.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.startedAt, null);
    assert.equal(cancelled.execution.state, 'never_started');
    assert.equal(f.pipeline.get(run.runId).phase, 'failed');
    assert.equal(f.pipeline.get(run.runId).writerLease, null);
    assert.deepEqual(fs.readdirSync(path.join(f.dataDir, 'writer-locks')), []);
    queue.shutdown();
    const restarted = createTaskQueue({ dataDir: dir, autoStart: false });
    t.after(() => restarted.shutdown());
    assert.equal(restarted.get(published.id).status, 'cancelled');
    assert.equal(restarted.stats().queued, 0, 'published work cannot re-enter the queue on restart');
  });
}

test('ambiguous submission outcomes retain the initial writer binding and fence', (t) => {
  for (const outcome of ['missing', 'identity mismatch', 'running', 'no execution proof', 'cancel throws', 'cancel not durable']) {
    const f = fixture(t), run = reachPlanReady(f);
    const submit = f.taskQueue.submitReserved.bind(f.taskQueue);
    let cancellations = 0;
    const cancel = f.taskQueue.cancel.bind(f.taskQueue);
    f.taskQueue.cancel = (id) => {
      cancellations++;
      if (outcome === 'cancel throws') throw new Error('fixture cancellation persistence failure');
      if (outcome === 'cancel not durable') return { ...f.taskQueue.get(id), status: 'cancelled' };
      return cancel(id);
    };
    f.taskQueue.submitReserved = (id, input) => {
      if (outcome !== 'missing') {
        const task = submit(id, input);
        task.execution = { state: 'never_started' };
        if (outcome === 'identity mismatch') task.body.cwd = path.join(f.cwd, 'other');
        if (outcome === 'running') Object.assign(task, { status: 'running', startedAt: f.clock.value, execution: { state: 'in_flight' } });
        if (outcome === 'no execution proof') delete task.execution;
      }
      throw new Error('fixture ambiguous submission failure');
    };
    assert.throws(() => f.controller.startManagedImplementation(run.runId), /fixture ambiguous submission failure/);
    const current = f.pipeline.get(run.runId);
    assert.equal(current.phase, 'implementing');
    assert.equal(current.providerTask.purpose, 'implementation');
    assert.equal(current.writerLease.mode, 'provider');
    assert.equal(fs.readdirSync(path.join(f.dataDir, 'writer-locks')).length, 1);
    assert.equal(cancellations, outcome.startsWith('cancel ') ? 1 : 0);
    const held = writerFiles(f, run.runId);
    if (['missing', 'identity mismatch'].includes(outcome)) {
      assert.throws(() => f.controller.reconcile(run.runId), { code: 'WRITER_EXECUTION_UNCERTAIN' });
    } else {
      assert.equal(f.controller.reconcile(run.runId).workflow.phase, 'implementing');
    }
    assert.throws(() => f.controller.cancel(run.runId), outcome === 'cancel throws'
      ? /fixture cancellation persistence failure/
      : { code: outcome === 'running' ? 'WRITER_TASK_RUNNING' : 'WRITER_EXECUTION_UNCERTAIN' });
    assert.deepEqual(writerFiles(f, run.runId), held, 'later reconcile/cancel cannot convert ambiguous admission into release');
  }
});

test('revision submission with a missing outcome cannot fall through to token-based release', (t) => {
  const f = fixture(t), run = reachReviewReady(f);
  f.taskQueue.submitReserved = () => { throw new Error('fixture ambiguous revision submission'); };
  assert.throws(() => f.controller.startRevision(run.runId), /fixture ambiguous revision submission/);
  const current = f.pipeline.get(run.runId);
  assert.equal(current.phase, 'revising');
  assert.equal(current.providerTask.purpose, 'revision');
  assert.equal(current.writerLease.mode, 'provider');
  assert.equal(fs.readdirSync(path.join(f.dataDir, 'writer-locks')).length, 1);
});

test('managed queued cancellation rechecks durable settlement before releasing the fence', (t) => {
  const f = fixture(t), run = reachPlanReady(f);
  const started = f.controller.startManagedImplementation(run.runId);
  const before = writerFiles(f, run.runId);
  const cancel = f.taskQueue.cancel.bind(f.taskQueue);
  f.taskQueue.cancel = (id) => ({ ...f.taskQueue.get(id), status: 'cancelled' });
  assert.throws(() => f.controller.cancel(run.runId), { code: 'WRITER_EXECUTION_UNCERTAIN' });
  assert.deepEqual(writerFiles(f, run.runId), before);
  f.taskQueue.cancel = () => { throw new Error('fixture cancellation write failed'); };
  assert.throws(() => f.controller.cancel(run.runId), /fixture cancellation write failed/);
  assert.deepEqual(writerFiles(f, run.runId), before);
  f.taskQueue.cancel = cancel;
  f.tasks.get(started.task.id).kind = 'wrong';
  assert.throws(() => f.controller.reconcile(run.runId), { code: 'WRITER_EXECUTION_UNCERTAIN' });
  assert.equal(f.tasks.get(started.task.id).status, 'queued', 'mismatched identity is not cancelled');
  assert.deepEqual(writerFiles(f, run.runId), before);
  f.tasks.get(started.task.id).kind = 'claude';
  assert.equal(f.controller.cancel(run.runId).phase, 'cancelled');
});

for (const mode of ['missing', 'interrupted', 'cancelled', 'malformed', 'running mismatch', 'running']) {
  test(`restarted initial writer with ${mode} task keeps its reservation until authoritative settlement`, (t) => {
    const f = fixture(t), run = reachPlanReady(f);
    const started = f.controller.startManagedImplementation(run.runId, mode === 'running' ? { leaseMs: 60000 } : {});
    f.controller.shutdown();
    if (mode === 'missing') f.tasks.delete(started.task.id);
    else Object.assign(f.tasks.get(started.task.id), mode.startsWith('running')
      ? { status: 'running', ...(mode === 'running mismatch' ? { kind: 'wrong' } : {}) }
      : { status: mode === 'malformed' ? 'failed' : mode, execution: mode === 'malformed' ? {} : { state: 'uncertain' } });
    if (mode === 'running') {
      assert.equal(started.workflow.writerLease.expiresAt - f.clock.value, 60000);
      // A bridge outage can outlast its heartbeat lease while the writer lives.
      f.clock.value = started.workflow.writerLease.expiresAt + 1;
    }
    const restored = createWorkflowController({ pipeline: createWorkflowPipeline({ dataDir: f.dataDir, now: () => f.clock.value }),
      taskQueue: f.taskQueue, loadConfig: () => f.config, now: () => f.clock.value });
    t.after(() => restored.shutdown());
    const before = writerFiles(f, run.runId), count = f.tasks.size;
    restored.view(run.runId);
    if (mode === 'running') {
      assert.ok(f.pipeline.get(run.runId).writerLease.expiresAt < f.clock.value);
      assert.equal(restored.reconcile(run.runId).workflow.phase, 'implementing');
      assert.equal(f.tasks.get(started.task.id).status, 'running');
    } else assert.throws(() => restored.reconcile(run.runId), { code: mode === 'running mismatch' ? 'WRITER_TASK_RUNNING' : 'WRITER_EXECUTION_UNCERTAIN' });
    assert.throws(() => restored.cancel(run.runId), { code: mode.startsWith('running') ? 'WRITER_TASK_RUNNING' : 'WRITER_EXECUTION_UNCERTAIN' });
    assert.deepEqual(writerFiles(f, run.runId), before, 'restart, expiry and refused cancellation retain the exact fence');
    assert.equal(f.tasks.size, count, 'no replacement writer or review is dispatched');
    if (mode !== 'missing') {
      Object.assign(f.tasks.get(started.task.id), { kind: 'claude', status: 'failed', execution: { state: 'fenced' } });
      assert.equal(restored.cancel(run.runId).phase, 'cancelled');
    }
  });
}

for (const status of ['done', 'failed']) {
  for (const evidence of ['omitted', 'null']) {
    test(`initial ${status} task with ${evidence} execution evidence retains its fence across restart and cancel`, (t) => {
      const f = fixture(t), run = reachPlanReady(f), contender = reachPlanReady(f);
      const started = f.controller.startManagedImplementation(run.runId);
      f.finish(started.task, 'Scoped implementation.\nIMPLEMENTATION_STATUS: COMPLETE', status, { execution: null });
      if (evidence === 'omitted') delete started.task.execution;
      f.controller.shutdown();
      const restored = createWorkflowController({ pipeline: createWorkflowPipeline({ dataDir: f.dataDir, now: () => f.clock.value }),
        taskQueue: f.taskQueue, loadConfig: () => f.config, now: () => f.clock.value });
      t.after(() => restored.shutdown());
      const before = writerFiles(f, run.runId), count = f.tasks.size;
      assert.throws(() => restored.reconcile(run.runId), { code: 'WRITER_EXECUTION_UNCERTAIN' });
      assert.throws(() => restored.cancel(run.runId), { code: 'WRITER_EXECUTION_UNCERTAIN' });
      assert.throws(() => restored.startImplementation(contender.runId), { code: 'WRITER_CONFLICT' });
      assert.deepEqual(writerFiles(f, run.runId), before, 'the exact lease and binding remain held');
      assert.equal(f.tasks.size, count, 'no review or replacement writer is dispatched');
      started.task.execution = { state: status === 'done' ? 'settled' : 'fenced' };
      const settled = restored.reconcile(run.runId).workflow;
      assert.equal(settled.phase, status === 'done' ? 'reviewing' : 'failed');
      assert.equal(settled.writerLease, null, 'affirmative matching terminal evidence permits settlement');
    });
  }
}

for (const [field, status, mutate] of [
  ['id', 'done', task => { task.id += '_other'; }],
  ['actor', 'failed', task => { task.user = 'other-writer'; }],
  ['provider', 'done', task => { task.kind = 'wrong-provider'; }],
  ['cwd', 'failed', task => { task.body.cwd += '-other'; }],
  ['request', 'done', task => { task.correlation.requestId += '_other'; }],
  ['invocation', 'failed', task => { task.correlation.invocationId += '_other'; }],
]) {
  test(`initial terminal ${field} mismatch cannot settle or cancel the original bound writer`, (t) => {
    const f = fixture(t), run = reachPlanReady(f), contender = reachPlanReady(f);
    const started = f.controller.startManagedImplementation(run.runId);
    f.finish(started.task, 'Scoped implementation.\nIMPLEMENTATION_STATUS: COMPLETE', status,
      { execution: { state: 'settled' } });
    const original = structuredClone(started.task);
    mutate(started.task);
    f.controller.shutdown();
    const restored = createWorkflowController({ pipeline: createWorkflowPipeline({ dataDir: f.dataDir, now: () => f.clock.value }),
      taskQueue: f.taskQueue, loadConfig: () => f.config, now: () => f.clock.value });
    t.after(() => restored.shutdown());
    const before = writerFiles(f, run.runId), count = f.tasks.size;
    assert.throws(() => restored.reconcile(run.runId), { code: 'WRITER_EXECUTION_UNCERTAIN' });
    assert.throws(() => restored.cancel(run.runId), { code: 'WRITER_EXECUTION_UNCERTAIN' });
    assert.throws(() => restored.startImplementation(contender.runId), { code: 'WRITER_CONFLICT' });
    assert.deepEqual(writerFiles(f, run.runId), before);
    assert.equal(f.tasks.size, count, 'a mismatched terminal record cannot dispatch review or retry');
    Object.assign(started.task, original, { status: 'failed', execution: { state: 'fenced' } });
    assert.equal(restored.cancel(run.runId).phase, 'cancelled', 'the exact fenced task permits operator cancellation');
  });
}

for (const evidence of ['uncertain', 'missing execution', 'terminal identity mismatch']) {
  test(`initial writer heartbeat survives ${evidence} reconciliation and stops after phase change`, (t) => {
    const f = fixture(t);
    t.mock.timers.enable({ apis: ['setInterval'] });
    const run = reachPlanReady(f), started = f.controller.startManagedImplementation(run.runId, { leaseMs: 60000 });
    Object.assign(f.tasks.get(started.task.id), { status: 'cancelled', execution: { state: 'uncertain' } });
    if (evidence === 'missing execution') {
      started.task.status = 'done';
      delete started.task.execution;
    } else if (evidence === 'terminal identity mismatch') {
      Object.assign(started.task, { status: 'done', execution: { state: 'settled' } });
      started.task.correlation.invocationId = 'other-task';
    }
    const expiry = started.workflow.writerLease.expiresAt;
    for (let i = 0; i < 25; i++) {
      f.clock.value += 1000;
      assert.throws(() => f.controller.reconcile(run.runId), { code: 'WRITER_EXECUTION_UNCERTAIN' });
      t.mock.timers.tick(1000);
    }
    assert.ok(f.pipeline.get(run.runId).writerLease.expiresAt > expiry);
    started.task.correlation.invocationId = started.task.id;
    f.finish(started.task, 'Scoped implementation.\nIMPLEMENTATION_STATUS: COMPLETE', 'done', { execution: { state: 'settled' } });
    f.controller.reconcile(run.runId);
    const before = writerFiles(f, run.runId);
    f.clock.value += 60000; t.mock.timers.tick(60000);
    assert.deepEqual(writerFiles(f, run.runId), before);
  });
}

test('initial writer terminal refusals never dispatch review or retry a writer', (t) => {
  const cases = [
    ['', {}], ['No marker.', {}], ['IMPLEMENTATION_STATUS: BLOCKED', {}],
    ['text IMPLEMENTATION_STATUS: COMPLETE', {}],
    ['IMPLEMENTATION_STATUS: COMPLETE', { resultIntegrity: { truncated: true } }],
    ['IMPLEMENTATION_STATUS: COMPLETE', { flags: { timed_out: true } }],
  ];
  for (const [result, extra] of cases) {
    const f = fixture(t), run = reachPlanReady(f), started = f.controller.startManagedImplementation(run.runId);
    f.finish(started.task, result, 'done', { execution: { state: 'settled' }, ...extra });
    const view = f.controller.reconcile(run.runId);
    assert.equal(view.workflow.phase, 'failed');
    assert.equal(view.workflow.writerLease, null);
    assert.deepEqual(view.nextActions, []);
    assert.equal(f.tasks.size, 2);
  }
});

test('retained advisor and revision records without execution metadata keep their legacy settlement behavior', (t) => {
  const f = fixture(t), run = f.controller.create(createInput(f.cwd));
  const planning = f.controller.submitResearch(run.runId, { markdown: 'Research evidence.' });
  delete planning.task.execution;
  f.finish(planning.task, 'Accepted legacy plan.\nPLAN_STATUS: READY');
  assert.equal(f.controller.reconcile(run.runId).workflow.phase, 'plan_ready');
  const claimed = f.controller.startImplementation(run.runId);
  const review = f.controller.completeImplementation(run.runId, { leaseToken: claimed.lease.leaseToken, markdown: 'External implementation.' });
  delete review.task.execution;
  f.finish(review.task, 'Legacy revision finding.\nREVIEW_VERDICT: REVISE');
  f.controller.reconcile(run.runId);
  const revision = f.controller.startRevision(run.runId);
  delete revision.task.execution;
  f.finish(revision.task, 'Legacy revision evidence.\nREVISION_STATUS: APPLIED');
  assert.equal(f.controller.reconcile(run.runId).workflow.phase, 'revision_ready');
  assert.equal(f.pipeline.get(run.runId).writerLease, null);
});

for (const taskTier of ['complex', 'critical', 'standard', 'utility', 'deterministic']) {
  test(`both managed writer phases request the accepted ${taskTier} tier`, (t) => {
    const expected = ['complex', 'critical'].includes(taskTier) ? ['heavy', 'high'] : ['standard', 'medium'];
    const f = fixture(t), run = reachPlanReady(f, { taskTier });
    const initial = f.controller.startManagedImplementation(run.runId);
    assert.deepEqual([initial.task.modelTier, initial.task.effort], expected);
    f.finish(initial.task, 'Implemented.\nIMPLEMENTATION_STATUS: COMPLETE');
    const review = f.controller.reconcile(run.runId).workflow;
    f.finish(f.tasks.get(review.providerTask.taskId), 'Finding.\nREVIEW_VERDICT: REVISE');
    f.controller.reconcile(run.runId);
    const revision = f.controller.startRevision(run.runId);
    assert.deepEqual([revision.task.modelTier, revision.task.effort], expected);
  });
}

for (const historical of [false, true]) {
  test(`reconcile preserves ${historical ? 'historical' : 'external'} initial owner without queue activity`, (t) => {
    const f = fixture(t), run = reachPlanReady(f);
    f.controller.startImplementation(run.runId);
    if (historical) {
      const file = path.join(f.dataDir, 'workflows', run.runId, 'state.json');
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      state.schemaVersion = 1; delete state.profile; delete state.phasePolicy; delete state.writerLease.mode;
      fs.writeFileSync(file, JSON.stringify(state));
    }
    const before = writerFiles(f, run.runId), count = f.tasks.size;
    f.controller.reconcile(run.runId); f.controller.reconcile(run.runId);
    assert.deepEqual(writerFiles(f, run.runId), before);
    assert.equal(f.tasks.size, count);
    assert.deepEqual(f.controller.view(run.runId).nextActions, ['complete_pipeline_implementation', 'renew_pipeline_writer_lease']);
  });
}

test('initial bound-before-submit crash remains held and a restarted running task renews', (t) => {
  const f = fixture(t), run = reachPlanReady(f), actor = 'claude-implementer', taskId = 't_reserved_only';
  t.mock.timers.enable({ apis: ['setInterval'] });
  f.pipeline.startImplementation(run.runId, { actor, mode: 'provider', leaseMs: 60000 });
  f.pipeline.bindProviderTask(run.runId, { actor, taskId, provider: 'claude', purpose: 'implementation', modelTier: 'standard', effort: 'medium' });
  const restored = createWorkflowController({ pipeline: createWorkflowPipeline({ dataDir: f.dataDir, now: () => f.clock.value }),
    taskQueue: f.taskQueue, loadConfig: () => f.config, now: () => f.clock.value });
  t.after(() => restored.shutdown());
  assert.throws(() => restored.reconcile(run.runId), { code: 'WRITER_EXECUTION_UNCERTAIN' });
  assert.equal(f.tasks.size, 1, 'restart does not invent a replacement writer');
  // The real submitter uses the workflow's canonical identity, including
  // lowercased Windows paths, rather than the caller's original spelling.
  f.taskQueue.submitReserved(taskId, { kind: 'claude', user: actor, cwd: f.pipeline.get(run.runId).cwd, dangerous: true,
    modelTier: 'standard', model: null, effort: 'medium', requestId: taskId,
    correlation: { runId: run.runId, requestId: taskId, invocationId: taskId, attemptId: `${taskId}:attempt:1` } });
  f.tasks.get(taskId).status = 'running';
  const original = f.pipeline.get(run.runId).writerLease.expiresAt;
  restored.reconcile(run.runId);
  f.clock.value += 30000; t.mock.timers.tick(30000);
  assert.ok(f.pipeline.get(run.runId).writerLease.expiresAt > original);
});

function canonicalEvidenceJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalEvidenceJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalEvidenceJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function modelUnavailableEvidence(task) {
  return {
    kind: 'bridge_claude_model_unavailable', version: 1, source: 'claude_json_stream', provider: 'claude_fable',
    selectedModel: 'fable', selectedModelSource: 'bridge_dispatch', vendorModelEcho: null,
    requestId: task.id, invocationId: task.id, attemptId: `${task.id}:attempt:1`,
    retryEvents: [{ line: 2, eventIdHash: 'b'.repeat(64), attempt: 1, errorStatus: 404, error: 'model_not_found' }],
    terminal: { line: 3, hash: 'c'.repeat(64), subtype: 'error_during_execution', apiErrorStatus: 404, terminalReason: 'model_error' },
    streamHash: 'd'.repeat(64), streamLines: 3,
  };
}

// Mirrors the queue's settled shape for a launched Fable CLI that ended with
// Bridge-owned model_unavailable evidence. `mutate` breaks one join at a time.
function settleModelUnavailable(f, task, mutate = () => {}) {
  const receiptId = `rcpt_test_${task.id.replace(/[^a-z0-9]/gi, '')}`;
  f.finish(task, '', 'failed', {
    error: 'provider returned no successful result (model_unavailable)',
    failureClass: 'model_unavailable',
    receiptId,
    execution: { state: 'settled', settledAt: f.clock.value, receiptId },
    stopReason: null,
    partialCheckpoint: '',
    route: {
      provider: 'claude_fable', requested_model: 'fable', resolved_outgoing_model: 'fable', model_flag_sent: true,
      observed_model: null, request_id: task.id, invocation_id: task.id, attempt_id: `${task.id}:attempt:1`,
    },
    flags: {
      cancelled: false, rate_limited: false, budget_exceeded: false, auth_failed: false, timed_out: false,
      dropped_out: true, permission_denied: false, partial_result: false,
    },
    providerMetadata: {
      receiptPersisted: true, model_invocation: true, physical_attempt_count: 1,
      provider_api_error_status: 404, provider_terminal_reason: 'model_error',
      provider_action_required: modelUnavailableEvidence(task),
      provider_permission_denials: { retained: [], count: 0, observed: 0, invalid: 0, truncated: false, byTool: {} },
    },
    retryAt: null,
    retryAfterSec: null,
  });
  mutate(f.tasks.get(task.id));
  return f.tasks.get(task.id);
}

function startFablePlanning(f, input) {
  const created = f.controller.create(input);
  const planning = f.controller.submitResearch(created.runId, { markdown: 'Research evidence.' });
  assert.equal(planning.task.kind, 'claude_fable');
  return { created, planning };
}

function restartedController(t, f) {
  const controller = createWorkflowController({
    pipeline: createWorkflowPipeline({ dataDir: f.dataDir, now: () => f.clock.value }),
    taskQueue: f.taskQueue, loadConfig: () => f.config, now: () => f.clock.value,
  });
  t.after(() => controller.shutdown());
  return controller;
}

const claudeTasks = (f) => [...f.tasks.values()].filter((task) => task.kind === 'claude');

for (const [label, input, modelTier, effort] of [
  ['complex with Fable preferred', (cwd) => ({ ...createInput(cwd, 'complex'), providerPreferences: { planning: ['claude_fable'] } }), 'heavy', 'high'],
  ['critical default', (cwd) => createInput(cwd, 'critical'), 'heavy', 'high'],
  ['standard with Fable preferred', (cwd) => ({ ...createInput(cwd, 'standard'), providerPreferences: { planning: ['claude_fable'] } }), 'standard', 'medium'],
]) {
  test(`${label}: Fable model_unavailable continues once on Claude in the same reconcile`, (t) => {
    const f = fixture(t);
    const { created, planning } = startFablePlanning(f, input(f.cwd));
    const fable = settleModelUnavailable(f, planning.task);
    const fableBefore = structuredClone(fable);
    const evidence = modelUnavailableEvidence(fable);

    const continued = f.controller.reconcile(created.runId);
    assert.equal(continued.workflow.phase, 'planning');
    assert.deepEqual(continued.nextActions, ['reconcile_pipeline']);
    assert.equal(f.tasks.size, 2);
    assert.deepEqual(f.tasks.get(fable.id), fableBefore, 'the failed Fable task and its accounting stay unmodified');
    const replacement = claudeTasks(f)[0];
    assert.equal(replacement.modelTier, modelTier);
    assert.equal(replacement.effort, effort);
    assert.equal(replacement.model, null);
    assert.equal(replacement.maxEffortOverride, false);
    assert.equal(replacement.dangerous, false);
    assert.match(replacement.intent, /planning_replacement_after_model_unavailable/);
    assert.equal(replacement.correlation.attemptId, `${replacement.id}:attempt:1`);
    assert.deepEqual(continued.workflow.providerTask && {
      taskId: continued.workflow.providerTask.taskId, provider: continued.workflow.providerTask.provider,
      attempt: continued.workflow.providerTask.attempt,
    }, { taskId: replacement.id, provider: 'claude', attempt: 1 });
    assert.deepEqual(continued.workflow.planningReplacement, {
      version: 1,
      failed: {
        taskId: fable.id, provider: 'claude_fable', model: 'fable', attemptId: `${fable.id}:attempt:1`,
        receiptId: fable.receiptId,
        evidenceHash: require('node:crypto').createHash('sha256').update(canonicalEvidenceJson(evidence)).digest('hex'),
        failureClass: 'model_unavailable',
      },
      replacementProvider: 'claude',
      excludedProviders: ['claude_fable'],
      scheduledAt: f.clock.value,
      firstReplacementTaskId: replacement.id,
      currentTaskId: replacement.id,
    });
    const archived = continued.workflow.providerTaskHistory.at(-1);
    assert.equal(archived.taskId, fable.id);
    assert.equal(archived.outcome, 'replacement_scheduled');

    f.finish(replacement, 'Plan details.\nPLAN_STATUS: READY');
    const ready = f.controller.reconcile(created.runId).workflow;
    assert.equal(ready.phase, 'plan_ready');
    assert.equal(ready.planningReplacement.failed.taskId, fable.id);
    assert.equal(f.tasks.size, 2, 'no implementation, writer or plan adoption is started');
    assert.equal(f.controller.reconcile(created.runId).workflow.phase, 'plan_ready');
    assert.equal(f.tasks.size, 2);
  });
}

test('every broken model_unavailable join keeps the ordinary Fable failure path', (t) => {
  const f = fixture(t);
  const metadata = (change) => (task) => { change(task.providerMetadata); };
  const evidence = (change) => (task) => { change(task.providerMetadata.provider_action_required); };
  const cases = [
    ['other failure class', (task) => { task.failureClass = 'provider_exit'; }],
    ...['cancelled', 'rate_limited', 'budget_exceeded', 'auth_failed', 'timed_out', 'permission_denied', 'partial_result']
      .map((flag) => [`flag ${flag}`, (task) => { task.flags[flag] = true; }]),
    ['not dropped', (task) => { task.flags.dropped_out = false; }],
    ['missing flag', (task) => { delete task.flags.partial_result; }],
    ['cooldown', metadata((m) => { m.cooldown = { until: 2000000 }; })],
    ['quota evidence', metadata((m) => { m.quota_evidence = { kind: 'weekly' }; })],
    ['vendor quota', metadata((m) => { m.vendor_quota = { remaining: 0 }; })],
    ['metadata retry_after', metadata((m) => { m.retry_after = 30; })],
    ['task retryAt', (task) => { task.retryAt = 2000000; }],
    ['task retryAfterSec', (task) => { task.retryAfterSec = 30; }],
    ['stop reason', (task) => { task.stopReason = 'token_budget'; }],
    ['partial checkpoint', (task) => { task.partialCheckpoint = 'partial'; }],
    ['partial diagnostic', metadata((m) => { m.partial_diagnostic = 'partial'; })],
    ['supervisor stop', metadata((m) => { m.supervisor_stop_reason = 'token_budget'; })],
    ['permission denial', metadata((m) => { m.provider_permission_denials.count = 1; })],
    ['retained denial', metadata((m) => { m.provider_permission_denials.retained = [{ tool: 'Bash' }]; })],
    ['no denial record', metadata((m) => { delete m.provider_permission_denials; })],
    ['incomplete authority', (task) => { task.resultIntegrity = { truncated: true }; }],
    ['uncertain execution', (task) => { task.execution = { state: 'uncertain' }; }],
    ['not invoked', (task) => { task.execution = { state: 'not_invoked' }; task.providerMetadata.model_invocation = false; }],
    ['owned execution', (task) => { task.execution = { state: 'owned_held', owner: { ownerId: 'o' } }; }],
    ['no receipt', (task) => { task.receiptId = null; task.execution.receiptId = null; }],
    ['receipt mismatch', (task) => { task.execution.receiptId = 'rcpt_other'; }],
    ['receipt not persisted', metadata((m) => { m.receiptPersisted = false; })],
    ['model not invoked', metadata((m) => { m.model_invocation = false; })],
    ['second physical attempt', metadata((m) => { m.physical_attempt_count = 2; })],
    ['wrong run', (task) => { task.correlation.runId = 'wf_other_000000000000'; }],
    ['stale attempt', (task) => { task.correlation.attemptId = `${task.id}:attempt:2`; }],
    ['wrong request', (task) => { task.correlation.requestId = 't_other'; }],
    ['body model', (task) => { task.body.model = 'opus'; }],
    ['body effort override', (task) => { task.body.maxEffortOverride = true; }],
    ['body tier', (task) => { task.body.modelTier = 'light'; }],
    ['body cwd', (task) => { task.body.cwd = '/elsewhere'; }],
    ['source', (task) => { task.source = 'api'; }],
    ['route provider', (task) => { task.route.provider = 'claude'; }],
    ['route requested model', (task) => { task.route.requested_model = 'opus'; }],
    ['route resolved model', (task) => { task.route.resolved_outgoing_model = 'opus'; }],
    ['route flag unsent', (task) => { task.route.model_flag_sent = false; }],
    ['vendor echo', (task) => { task.route.observed_model = 'claude-opus'; }],
    ['route attempt', (task) => { task.route.attempt_id = `${task.id}:attempt:2`; }],
    ['no evidence', metadata((m) => { delete m.provider_action_required; })],
    ['evidence kind', evidence((e) => { e.kind = 'vendor_model_unavailable'; })],
    ['evidence version', evidence((e) => { e.version = 2; })],
    ['evidence source', evidence((e) => { e.source = 'stderr'; })],
    ['evidence model', evidence((e) => { e.selectedModel = 'opus'; })],
    ['evidence vendor echo', evidence((e) => { e.vendorModelEcho = 'fable'; })],
    ['evidence invented field', evidence((e) => { e.vendorModelId = 'fable-1'; })],
    ['evidence request', evidence((e) => { e.requestId = 't_other'; })],
    ['evidence attempt', evidence((e) => { e.attemptId = 't_other:attempt:1'; })],
    ['evidence no retries', evidence((e) => { e.retryEvents = []; })],
    ['evidence retry error', evidence((e) => { e.retryEvents[0].error = 'rate_limit'; })],
    ['evidence retry status', evidence((e) => { e.retryEvents[0].errorStatus = 429; })],
    ['evidence first attempt', evidence((e) => { e.retryEvents[0].attempt = 2; })],
    ['evidence non-monotonic', evidence((e) => { e.retryEvents.push({ ...e.retryEvents[0] }); })],
    ['evidence terminal status', evidence((e) => { e.terminal.apiErrorStatus = 401; })],
    ['evidence terminal reason', evidence((e) => { e.terminal.terminalReason = 'rate_limit'; })],
    ['evidence hash', evidence((e) => { e.streamHash = 'not-a-hash'; })],
    ['evidence one line', evidence((e) => { e.streamLines = 1; })],
  ];
  for (const [label, mutate] of cases) {
    const { created, planning } = startFablePlanning(f, {
      ...createInput(f.cwd), objective: `Exclusion ${label}.`, providerPreferences: { planning: ['claude_fable'] },
    });
    settleModelUnavailable(f, planning.task, mutate);
    const before = claudeTasks(f).length;
    const after = f.controller.reconcile(created.runId).workflow;
    assert.equal(after.planningReplacement, null, label);
    assert.equal(claudeTasks(f).length, before, label);
    assert.notEqual(after.providerTask?.provider, 'claude', label);
  }
});

test('a sync identity mismatch fails closed with the observed ID and never replaces', (t) => {
  const f = fixture(t);
  for (const [index, [label, mutate]] of [
    ['substituted id', (task) => { task.id = 't_substituted'; }],
    ['wrong kind', (task) => { task.kind = 'claude'; }],
    ['wrong user', (task) => { task.user = 'codex'; }],
  ].entries()) {
    const { created, planning } = startFablePlanning(f, { ...createInput(f.cwd, 'critical'), objective: `Mismatch ${label}.` });
    const stored = settleModelUnavailable(f, planning.task);
    mutate(stored);
    const failed = f.controller.reconcile(created.runId).workflow;
    assert.equal(failed.phase, 'failed', label);
    assert.equal(failed.planningReplacement, null, label);
    assert.match(failed.terminal.reason, new RegExp(`provider task ${stored.id} failed`), label);
    assert.equal(f.tasks.size, index + 1, label);
    assert.deepEqual(f.controller.nextActions(failed), [], label);
  }
});

test('a same-ID identity mismatch with a typed transient failure never retries Fable or its replacement', (t) => {
  const f = fixture(t);
  const limited = () => ({ failureClass: 'rate_limit', flags: { rate_limited: true, timed_out: false }, retryAt: f.clock.value + 1000 });
  for (const [label, mutate] of [
    ['wrong kind', (task) => { task.kind = 'codex'; }],
    ['wrong user', (task) => { task.user = 'codex'; }],
  ]) {
    const fable = startFablePlanning(f, { ...createInput(f.cwd, 'critical'), objective: `Fable transient ${label}.` });
    f.finish(fable.planning.task, 'provider 429', 'failed', limited());
    mutate(f.tasks.get(fable.planning.task.id));
    const fableBefore = f.tasks.size;
    const fableFailed = f.controller.reconcile(fable.created.runId).workflow;
    assert.equal(fableFailed.phase, 'failed', label);
    assert.equal(fableFailed.providerRetry, null, label);
    assert.equal(fableFailed.planningReplacement, null, label);
    assert.deepEqual(f.controller.nextActions(fableFailed), [], label);
    assert.throws(() => f.controller.retryFailedProvider(fable.created.runId, { actor: 'operator' }),
      { code: 'PROVIDER_RETRY_NOT_ALLOWED' }, label);
    assert.equal(f.tasks.size, fableBefore, label);

    const replaced = startFablePlanning(f, { ...createInput(f.cwd, 'critical'), objective: `Replacement transient ${label}.` });
    settleModelUnavailable(f, replaced.planning.task);
    const bound = f.controller.reconcile(replaced.created.runId).workflow;
    const replacement = f.tasks.get(bound.providerTask.taskId);
    assert.equal(replacement.kind, 'claude', label);
    f.finish(replacement, 'provider 429', 'failed', limited());
    mutate(replacement);
    const before = f.tasks.size;
    const failed = f.controller.reconcile(replaced.created.runId).workflow;
    assert.equal(failed.phase, 'failed', label);
    assert.equal(failed.providerRetry, null, label);
    assert.equal(failed.planningReplacement.currentTaskId, replacement.id, label);
    assert.deepEqual(f.controller.nextActions(failed), [], label);
    assert.throws(() => f.controller.retryFailedProvider(replaced.created.runId, { actor: 'operator' }),
      { code: 'PROVIDER_RETRY_NOT_ALLOWED' }, label);
    assert.equal(f.tasks.size, before, label);
  }
});

test('replacement survives repeated reconcile and restart at every boundary with one submit', (t) => {
  const f = fixture(t);
  // After settle, before any reconcile: a fresh controller schedules and dispatches once.
  const settled = startFablePlanning(f, createInput(f.cwd, 'critical'));
  settleModelUnavailable(f, settled.planning.task);
  const second = restartedController(t, f);
  second.reconcile(settled.created.runId);
  second.reconcile(settled.created.runId);
  f.controller.reconcile(settled.created.runId);
  restartedController(t, f).reconcile(settled.created.runId);
  assert.equal(claudeTasks(f).length, 1);

  // After the durable schedule, before the bind: the next reconcile dispatches exactly once.
  const scheduled = startFablePlanning(f, { ...createInput(f.cwd, 'critical'), objective: 'Scheduled boundary.' });
  const fable = settleModelUnavailable(f, scheduled.planning.task);
  f.pipeline.schedulePlanningReplacement(scheduled.created.runId, {
    actor: 'claude-planner', failedTaskId: fable.id, replacementProvider: 'claude',
    failed: { model: 'fable', attemptId: `${fable.id}:attempt:1`, receiptId: fable.receiptId,
      evidenceHash: 'e'.repeat(64), failureClass: 'model_unavailable' },
  });
  const resumed = restartedController(t, f);
  const dispatched = resumed.reconcile(scheduled.created.runId).workflow;
  resumed.reconcile(scheduled.created.runId);
  f.controller.reconcile(scheduled.created.runId);
  assert.equal(claudeTasks(f).length, 2);
  assert.equal(dispatched.providerTask.provider, 'claude');
  assert.equal(dispatched.planningReplacement.firstReplacementTaskId, dispatched.providerTask.taskId);

  // After the bind, before queue submission: the missing task fails closed.
  const bound = startFablePlanning(f, { ...createInput(f.cwd, 'critical'), objective: 'Bound boundary.' });
  const boundFable = settleModelUnavailable(f, bound.planning.task);
  f.pipeline.schedulePlanningReplacement(bound.created.runId, {
    actor: 'claude-planner', failedTaskId: boundFable.id, replacementProvider: 'claude',
    failed: { model: 'fable', attemptId: `${boundFable.id}:attempt:1`, receiptId: boundFable.receiptId,
      evidenceHash: 'e'.repeat(64), failureClass: 'model_unavailable' },
  });
  f.pipeline.bindProviderTask(bound.created.runId, {
    actor: 'claude-planner', taskId: 't_lost_replacement', provider: 'claude', purpose: 'planning',
    modelTier: 'heavy', effort: 'high', attempt: 1,
  });
  const lost = restartedController(t, f).reconcile(bound.created.runId);
  assert.equal(lost.workflow.phase, 'failed');
  assert.match(lost.workflow.terminal.reason, /provider task t_lost_replacement failed/);
  assert.deepEqual(lost.nextActions, []);
  assert.equal(claudeTasks(f).length, 2);
  assert.equal(f.tasks.has('t_lost_replacement'), false);
});

test('a replacement 429 retries on Claude only and explicit recovery stays on Claude', (t) => {
  const f = fixture(t);
  const { created, planning } = startFablePlanning(f, createInput(f.cwd, 'critical'));
  settleModelUnavailable(f, planning.task);
  const first = f.controller.reconcile(created.runId).workflow;
  const firstTask = f.tasks.get(first.providerTask.taskId);
  f.finish(firstTask, 'provider 429', 'failed', {
    failureClass: 'rate_limit', flags: { rate_limited: true, timed_out: false }, retryAt: f.clock.value + 1000,
  });
  const scheduled = f.controller.reconcile(created.runId).workflow;
  assert.equal(scheduled.providerRetry.failedProvider, 'claude');
  assert.equal(scheduled.providerRetry.nextAttempt, 2);
  f.clock.value += 1000;
  const retried = f.controller.reconcile(created.runId).workflow;
  const secondTask = f.tasks.get(retried.providerTask.taskId);
  assert.equal(secondTask.kind, 'claude');
  assert.equal(retried.providerTask.attempt, 2);
  assert.equal(retried.planningReplacement.firstReplacementTaskId, firstTask.id);
  assert.equal(retried.planningReplacement.currentTaskId, secondTask.id);

  f.finish(secondTask, 'bridge restarted', 'interrupted', { execution: { state: 'uncertain' } });
  const failed = f.controller.reconcile(created.runId).workflow;
  assert.equal(failed.phase, 'failed');
  f.tasks.get(secondTask.id).execution = { state: 'fenced', proof: { evidenceId: 'fence_2' } };
  const recovered = f.controller.retryFailedProvider(created.runId, { actor: 'operator' });
  assert.equal(recovered.workflow.phase, 'planning');
  assert.equal(recovered.workflow.providerTask.provider, 'claude');
  assert.equal(recovered.workflow.providerTask.attempt, 3);
  assert.equal(f.tasks.get(recovered.workflow.providerTask.taskId).kind, 'claude');
  assert.equal(recovered.workflow.planningReplacement.currentTaskId, recovered.workflow.providerTask.taskId);
  assert.equal([...f.tasks.values()].filter((task) => task.kind === 'claude_fable').length, 1, 'never returns to Fable');
});

test('a replacement dispatch refusal fails without a third provider', (t) => {
  const f = fixture(t);
  f.config.codex = { oneshot_safe: ['codex-safe'] };
  const { created, planning } = startFablePlanning(f, {
    ...createInput(f.cwd), providerPreferences: { planning: ['claude_fable', 'codex'] },
  });
  const fable = settleModelUnavailable(f, planning.task);
  f.pipeline.schedulePlanningReplacement(created.runId, {
    actor: 'claude-planner', failedTaskId: fable.id, replacementProvider: 'claude',
    failed: { model: 'fable', attemptId: `${fable.id}:attempt:1`, receiptId: fable.receiptId,
      evidenceHash: 'e'.repeat(64), failureClass: 'model_unavailable' },
  });
  delete f.config.claude;
  assert.throws(() => f.controller.reconcile(created.runId), { code: 'PROVIDER_UNAVAILABLE' });
  const failed = f.pipeline.get(created.runId);
  assert.equal(failed.phase, 'failed');
  assert.match(failed.terminal.reason, /planning dispatch failed/);
  assert.equal(f.tasks.size, 1, 'neither Codex nor Fable is selected');
});

test('no replacement for unconfigured Claude, phase policy or review phases', (t) => {
  const f = fixture(t);
  const claude = f.config.claude;
  delete f.config.claude;
  const unconfigured = startFablePlanning(f, createInput(f.cwd, 'critical'));
  settleModelUnavailable(f, unconfigured.planning.task);
  const failed = f.controller.reconcile(unconfigured.created.runId).workflow;
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.planningReplacement, null);
  assert.equal(f.tasks.size, 1);
  f.config.claude = claude;

  f.config.codex = { oneshot_safe: ['codex-safe'] };
  const policy = f.controller.create({ ...createInput(f.cwd), objective: 'Policy run.', profile: 'codex-astra-ultra' });
  const codexPlanning = f.controller.submitResearch(policy.runId, { markdown: 'Research evidence.' });
  assert.equal(codexPlanning.task.kind, 'codex');
  settleModelUnavailable(f, codexPlanning.task);
  const policyFailed = f.controller.reconcile(policy.runId).workflow;
  assert.equal(policyFailed.phase, 'failed');
  assert.equal(policyFailed.planningReplacement, null);
  assert.equal(f.tasks.size, 2);

  const review = f.controller.create({ ...createInput(f.cwd), objective: 'Review run.', providerPreferences: { review: ['claude_fable'] } });
  const plan = f.controller.submitResearch(review.runId, { markdown: 'Research evidence.' });
  f.finish(plan.task, 'Plan details.\nPLAN_STATUS: READY');
  f.controller.reconcile(review.runId);
  const implementation = f.controller.startImplementation(review.runId);
  const reviewing = f.controller.completeImplementation(review.runId, {
    leaseToken: implementation.lease.leaseToken, markdown: 'Implementation evidence.',
  });
  assert.equal(reviewing.task.kind, 'claude_fable');
  const count = f.tasks.size;
  settleModelUnavailable(f, reviewing.task);
  const reviewFailed = f.controller.reconcile(review.runId).workflow;
  assert.equal(reviewFailed.phase, 'failed');
  assert.equal(reviewFailed.planningReplacement, null);
  assert.equal(f.tasks.size, count);
});
