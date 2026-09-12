'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const linuxTest = (name, fn) => test(name, { skip: process.platform !== 'linux' }, fn);
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createWorkflowPipeline } = require('../lib/workflow-pipeline');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const runId = 'wf_owned_111111111111', ownerId = 'owner_11111111111111111111111111111111', decisionId = 'decision_1111111111111111';
function fixture(t, { authorityEnabled = true, fsApi } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-writer-owner-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const cwd = path.join(temp, 'project'); fs.mkdirSync(cwd, { mode: 0o700 });
  const dataDir = path.join(temp, 'data'); const clock = { value: 1000000 };
  let prepared = null, release = null, held = true, workspaceHold = false;
  const authority = {
    assertHeld() { if (!held) throw Object.assign(new Error('OWNER_CONTROLLER_LOST'), { code: 'OWNER_CONTROLLER_LOST' }); },
    assertWorkspaceAvailable() { if (workspaceHold) throw Object.assign(new Error('OWNER_WORKSPACE_HELD'), { code: 'OWNER_WORKSPACE_HELD' }); },
    assertMutableLease() { if (release) throw Object.assign(new Error('OWNER_RELEASE_APPLICATION_PENDING'), { code: 'OWNER_RELEASE_APPLICATION_PENDING' }); },
    readPreparedWriter() { return structuredClone(prepared); },
    readCommittedWriterRelease() { return structuredClone(release); },
  };
  const options = { dataDir, now: () => clock.value,
    ...(authorityEnabled ? { executionOwners: authority, executionOwnerFs: fsApi } : {}) };
  let pipeline = createWorkflowPipeline(options);
  function plan(id = runId) {
    pipeline.createWorkflow({ runId: id, cwd, objective: 'Fixture work.', acceptance: 'Fixture passes.' });
    pipeline.completeResearch(id, { markdown: 'Research.' }); pipeline.startPlanning(id);
    pipeline.completePlanning(id, { markdown: 'Plan.' });
  }
  plan(); const implementation = pipeline.startImplementation(runId);
  pipeline.completeImplementation(runId, { leaseToken: implementation.lease.leaseToken, markdown: 'Implementation.' });
  pipeline.startReview(runId); pipeline.completeReview(runId, { markdown: 'Revise.', revisionRequested: true });
  const paths = { state: path.join(dataDir, 'workflows', runId, 'state.json'), lock: path.join(dataDir, 'writer-locks', `${hash(cwd)}.json`) };
  function enroll() {
    const claimed = pipeline.startOwnedRevision(runId, { actor: 'claude-reviser', leaseMs: 100 });
    pipeline.bindProviderTask(runId, { actor: 'claude-reviser', taskId: 't_writer', provider: 'claude', purpose: 'revision' });
    prepared = { state: 'prepared', ownerId, bindingHash: 'a'.repeat(64), ownerIds: [ownerId], writer: pipeline.getOwnedWriterBinding(runId) };
    pipeline.bindOwnedWriterExecution(runId, { ownerId });
    return claimed;
  }
  function decide() {
    clock.value += 101;
    release = { scope: 'writer_lease', ownerId, ownerIds: [ownerId], decisionId, recoveryId: 'recovery_1',
      bindingHash: prepared.bindingHash, writer: prepared.writer, expectedWorkflowRevision: pipeline.get(runId).revision,
      reason: 'Explicit recovery after independently confirmed original namespace death.' };
    workspaceHold = true;
    return release;
  }
  return { get pipeline() { return pipeline; }, clock, paths, cwd, dataDir, authority, plan, enroll, decide,
    prepared: () => prepared, release: () => release, dropAuthority: () => { held = false; },
    restart: () => { pipeline = createWorkflowPipeline(options); return pipeline; },
    settleAuthority: () => { workspaceHold = false; } };
}
function code(fn, expected) { assert.throws(fn, (error) => error.code === expected); }
function apply(f, extra = {}) { return f.pipeline.applyOwnedWriterRecovery(runId, { ownerId, decisionId, ...extra }); }

linuxTest('new exact owner binding, expired recovery and idempotent restart release', (t) => {
  const f = fixture(t); f.enroll(); f.decide();
  const done = apply(f); assert.equal(done.phase, 'failed'); assert.equal(done.writerLease, null);
  assert.equal(done.providerTask, null); assert.equal(done.providerTaskHistory.at(-1).taskId, 't_writer');
  assert.equal(done.ownerRecovery.decisionId, decisionId); assert.equal(fs.existsSync(f.paths.lock), false);
  f.restart(); assert.deepEqual(apply(f), done);
  assert.equal(f.pipeline.get(runId).history.filter((row) => row.event === 'owned_writer_recovered').length, 1);
});

linuxTest('ordinary/manual and legacy provider leases cannot enroll or recover retroactively', (t) => {
  const f = fixture(t); f.pipeline.startRevision(runId, { mode: 'provider', actor: 'claude-reviser' });
  f.pipeline.bindProviderTask(runId, { actor: 'claude-reviser', taskId: 't_writer', provider: 'claude', purpose: 'revision' });
  code(() => f.pipeline.getOwnedWriterBinding(runId), 'OWNER_UNAVAILABLE_UNBOUND_LEASE');
  code(() => f.pipeline.bindOwnedWriterExecution(runId, { ownerId }), 'OWNER_UNAVAILABLE_UNBOUND_LEASE');
  assert.equal(fs.existsSync(f.paths.lock), true);
});

test('ordinary path has no enrollment without the private authority', (t) => {
  const f = fixture(t, { authorityEnabled: false });
  code(() => f.pipeline.startOwnedRevision(runId), 'OWNER_AUTHORITY_UNAVAILABLE');
  const lease = f.pipeline.startRevision(runId, { mode: 'external' });
  f.pipeline.completeRevision(runId, { leaseToken: lease.lease.leaseToken, markdown: 'Applied.' });
  assert.equal(f.pipeline.get(runId).phase, 'revision_ready');
});

linuxTest('no caller proof, task-only authority, live lease or changed CAS can authorize release', (t) => {
  const f = fixture(t); f.enroll();
  code(() => apply(f, { ownerFenced: true }), 'OWNER_ARGUMENT_INVALID');
  code(() => apply(f), 'OWNER_DECISION_UNTRUSTED');
  f.decide(); const decision = f.release(); decision.scope = 'task_capacity';
  code(() => apply(f), 'OWNER_DECISION_UNTRUSTED'); decision.scope = 'writer_lease';
  f.clock.value -= 101; code(() => apply(f), 'OWNER_LEASE_NOT_EXPIRED'); f.clock.value += 101;
  decision.expectedWorkflowRevision--; code(() => apply(f), 'OWNER_BINDING_CHANGED');
  assert.equal(fs.existsSync(f.paths.lock), true); assert.equal(f.pipeline.get(runId).phase, 'revising');
});

linuxTest('a second owner, changed exact task or changed lease tuple is rejected', (t) => {
  const f = fixture(t); f.enroll();
  const prepared = f.prepared(); prepared.ownerIds.push('owner_other');
  code(() => f.pipeline.bindOwnedWriterExecution(runId, { ownerId }), 'OWNER_BINDING_CHANGED'); prepared.ownerIds.pop();
  f.decide(); f.release().writer = { ...f.release().writer, taskId: 't_other' };
  code(() => apply(f), 'OWNER_BINDING_CHANGED'); assert.equal(fs.existsSync(f.paths.lock), true);
});

linuxTest('replacement lock is never unlinked by an old owner decision', (t) => {
  const f = fixture(t); f.enroll(); f.decide();
  const replacement = JSON.parse(fs.readFileSync(f.paths.lock)); replacement.leaseToken = 'b'.repeat(64);
  fs.writeFileSync(f.paths.lock, JSON.stringify(replacement));
  code(() => apply(f), 'OWNER_LEASE_CHANGED'); assert.deepEqual(JSON.parse(fs.readFileSync(f.paths.lock)), replacement);
});

linuxTest('all existing writer completion/failure/cancel release paths reject an owned lease', (t) => {
  const f = fixture(t); const claim = f.enroll();
  for (const action of [
    () => f.pipeline.completeRevision(runId, { actor: 'claude-reviser', leaseToken: claim.lease.leaseToken, markdown: 'Applied.' }),
    () => f.pipeline.completeBoundRevision(runId, { actor: 'claude-reviser', taskId: 't_writer', markdown: 'Applied.' }),
    () => f.pipeline.failBoundWriterTask(runId, { actor: 'claude-reviser', taskId: 't_writer', reason: 'failure' }),
    () => f.pipeline.cancelBoundWriterTask(runId, { actor: 'claude-reviser', taskId: 't_writer' }),
    () => f.pipeline.failOrphanedRevision(runId, { actor: 'claude-reviser' }),
    () => f.pipeline.cancel(runId, { actor: 'claude-reviser', leaseToken: claim.lease.leaseToken }),
  ]) code(action, 'OWNER_RELEASE_REQUIRED');
  assert.equal(f.pipeline.get(runId).phase, 'revising'); assert.equal(fs.existsSync(f.paths.lock), true);
});

linuxTest('controller loss and pending release prevent recovery/renewal/successor admission', (t) => {
  const f = fixture(t); const claim = f.enroll(); f.decide();
  code(() => f.pipeline.renewWriterLease(runId, { actor: 'claude-reviser', leaseToken: claim.lease.leaseToken }), 'OWNER_RELEASE_APPLICATION_PENDING');
  f.plan('wf_other_222222222222'); code(() => f.pipeline.startImplementation('wf_other_222222222222'), 'OWNER_WORKSPACE_HELD');
  f.dropAuthority(); code(() => apply(f), 'OWNER_CONTROLLER_LOST');
});

linuxTest('state publication directory-sync failure retains lock; retry reconfirms before unlink', (t) => {
  let failSync = false, paths;
  const fsApi = Object.create(fs);
  fsApi.fsyncSync = (fd) => {
    if (failSync && fs.fstatSync(fd).isDirectory()
      && fs.readlinkSync(`/proc/self/fd/${fd}`) === path.dirname(paths.state)
      && JSON.parse(fs.readFileSync(paths.state)).phase === 'failed') throw Object.assign(new Error('injected sync'), { code: 'EIO' });
    return fs.fsyncSync(fd);
  };
  const f = fixture(t, { fsApi }); paths = f.paths; f.enroll(); f.decide(); failSync = true;
  assert.throws(() => apply(f)); assert.equal(fs.existsSync(paths.lock), true);
  f.restart(); assert.throws(() => apply(f)); assert.equal(fs.existsSync(paths.lock), true);
  failSync = false; assert.equal(apply(f).phase, 'failed'); assert.equal(fs.existsSync(paths.lock), false);
});

linuxTest('crash after state commit but before unlink rolls forward exactly once', (t) => {
  let failUnlink = false, lock;
  const fsApi = Object.create(fs);
  fsApi.unlinkSync = (file) => { if (failUnlink && path.basename(file) === path.basename(lock)) throw Object.assign(new Error('injected unlink'), { code: 'EIO' }); return fs.unlinkSync(file); };
  const f = fixture(t, { fsApi }); lock = f.paths.lock; f.enroll(); f.decide(); failUnlink = true;
  assert.throws(() => apply(f)); assert.equal(fs.existsSync(lock), true); assert.equal(f.pipeline.get(runId).phase, 'failed');
  f.restart(); failUnlink = false; const done = apply(f); assert.equal(fs.existsSync(lock), false);
  assert.equal(done.history.filter((row) => row.event === 'owned_writer_recovered').length, 1);
});

linuxTest('unlink effect followed by error remains journal-held until absent lock barrier reconfirmed', (t) => {
  let failAfterUnlink = false, lock;
  const fsApi = Object.create(fs);
  fsApi.unlinkSync = (file) => { fs.unlinkSync(file); if (failAfterUnlink && path.basename(file) === path.basename(lock)) throw Object.assign(new Error('injected post-unlink'), { code: 'EIO' }); };
  const f = fixture(t, { fsApi }); lock = f.paths.lock; f.enroll(); f.decide(); failAfterUnlink = true;
  assert.throws(() => apply(f)); assert.equal(fs.existsSync(lock), false);
  f.plan('wf_other_333333333333'); code(() => f.pipeline.startImplementation('wf_other_333333333333'), 'OWNER_WORKSPACE_HELD');
  f.restart(); failAfterUnlink = false; assert.equal(apply(f).phase, 'failed');
});

linuxTest('recovery conflict cannot rewrite an already audited decision', (t) => {
  const f = fixture(t); f.enroll(); f.decide(); apply(f);
  f.release().recoveryId = 'recovery_conflict'; code(() => apply(f), 'OWNER_RECOVERY_CONFLICT');
});

linuxTest('unbound external lease remains byte-for-byte held after attempted owner enrollment', (t) => {
  const f = fixture(t); f.pipeline.startRevision(runId, { mode: 'external', actor: 'codex' });
  const before = fs.readFileSync(f.paths.lock); f.clock.value += 86400001;
  code(() => f.pipeline.bindOwnedWriterExecution(runId, { ownerId }), 'OWNER_UNAVAILABLE_UNBOUND_LEASE');
  assert.deepEqual(fs.readFileSync(f.paths.lock), before);
});

linuxTest('prepared owner must still be before physical start and missing initial lock is not recovery', (t) => {
  const f = fixture(t); f.enroll(); f.prepared().state = 'running';
  code(() => f.pipeline.bindOwnedWriterExecution(runId, { ownerId }), 'OWNER_BINDING_CHANGED');
  f.decide(); fs.unlinkSync(f.paths.lock); code(() => apply(f), 'ENOENT');
  assert.equal(f.pipeline.get(runId).phase, 'revising');
});

linuxTest('strict close failure after published recovery retains hold and is not silently retried', (t) => {
  let inject = false, paths, failures = 0;
  const fsApi = Object.create(fs);
  fsApi.closeSync = (fd) => {
    const matches = inject && fs.fstatSync(fd).isDirectory()
      && fs.readlinkSync(`/proc/self/fd/${fd}`) === path.dirname(paths.state)
      && JSON.parse(fs.readFileSync(paths.state)).phase === 'failed';
    fs.closeSync(fd);
    if (matches) { failures++; throw Object.assign(new Error('injected close'), { code: 'EIO' }); }
  };
  const f = fixture(t, { fsApi }); paths = f.paths; f.enroll(); f.decide(); inject = true;
  assert.throws(() => apply(f)); assert.equal(failures, 1); assert.equal(fs.existsSync(paths.lock), true);
  f.restart(); assert.throws(() => apply(f)); assert.equal(failures, 2); assert.equal(fs.existsSync(paths.lock), true);
  inject = false; assert.equal(apply(f).phase, 'failed'); assert.equal(fs.existsSync(paths.lock), false);
});

const nativeFinalizationTest = (name, fn) => test(name, { skip: process.platform !== 'linux' }, fn);

function finalize(f) { return f.pipeline.applyOwnedWriterFinalization(runId, { ownerId, decisionId }); }
function liveDecision(f, outcome = 'completed') {
  const release = f.decide(); f.clock.value -= 101;
  Object.assign(release, { operation: 'live_finalization', proofKind: 'process_tree_settled', outcome });
  if (outcome === 'completed') { const markdown = 'REVISION_STATUS: APPLIED\nChanged the bounded target and verified it.';
    release.artifact = { markdown, sha256: hash(markdown) }; }
  return release;
}

nativeFinalizationTest('normal successful owned completion preserves revision artifact and phase review gate', (t) => {
  const f = fixture(t); f.enroll(); const release = liveDecision(f);
  code(() => apply(f), 'OWNER_DECISION_UNTRUSTED');
  const result = finalize(f); assert.equal(result.phase, 'revision_ready'); assert.equal(result.revisionRequested, false);
  assert.equal(result.artifacts.revision.sha256, release.artifact.sha256); assert.equal(result.revisionCycle, 1);
  assert.equal(f.pipeline.readArtifact(runId, 'revision').content, release.artifact.markdown);
  assert.equal(result.providerTaskHistory.at(-1).outcome, 'completed'); assert.equal(fs.existsSync(f.paths.lock), false);
  f.restart(); assert.deepEqual(finalize(f), result); assert.equal(result.phase === 'complete', false);
});

nativeFinalizationTest('normal owned failure uses the same physical gate without waiting for lease expiry', (t) => {
  const f = fixture(t); f.enroll(); liveDecision(f, 'failed');
  const result = finalize(f); assert.equal(result.phase, 'failed'); assert.equal(fs.existsSync(f.paths.lock), false);
});

nativeFinalizationTest('never-permitted abort releases only the writer projection and does not claim process death', (t) => {
  const f = fixture(t); f.enroll(); const release = liveDecision(f, 'failed');
  release.operation = 'never_permitted_abort'; release.proofKind = 'never_permitted';
  const result = finalize(f); assert.equal(result.phase, 'failed'); assert.equal(fs.existsSync(f.paths.lock), false);
  f.plan('wf_other_444444444444'); code(() => f.pipeline.startImplementation('wf_other_444444444444'), 'OWNER_WORKSPACE_HELD');
  // Only the journal may decide which remaining physical reservation is held;
  // this projection never invokes a queue or physical-capacity release API.
  assert.equal(result.ownerRecovery.operation, 'never_permitted_abort');
});

nativeFinalizationTest('never-permitted proof cannot approve output and bad artifact hashes leave lease untouched', (t) => {
  const f = fixture(t); f.enroll(); const release = liveDecision(f);
  release.operation = 'never_permitted_abort'; release.proofKind = 'never_permitted';
  code(() => finalize(f), 'OWNER_DECISION_UNTRUSTED'); release.operation = 'live_finalization'; release.proofKind = 'process_tree_settled';
  release.artifact.sha256 = '0'.repeat(64); code(() => finalize(f), 'OWNER_ARTIFACT_UNTRUSTED');
  assert.equal(fs.existsSync(f.paths.lock), true); assert.equal(f.pipeline.get(runId).phase, 'revising');
});

nativeFinalizationTest('successful completion requires intact original instruction artifacts', (t) => {
  const f = fixture(t); f.enroll(); liveDecision(f);
  fs.writeFileSync(path.join(path.dirname(f.paths.state), 'artifacts', 'plan.md'), 'Tampered plan.');
  assert.throws(() => finalize(f)); assert.equal(fs.existsSync(f.paths.lock), true); assert.equal(f.pipeline.get(runId).phase, 'revising');
});

nativeFinalizationTest('replacement revision artifact published before state failure retries without stranding the lease', (t) => {
  let failStateSync = false, stateDirectory;
  const fsApi = Object.create(fs);
  fsApi.fsyncSync = (fd) => {
    const name = fs.readlinkSync(`/proc/self/fd/${fd}`);
    if (failStateSync && !fs.fstatSync(fd).isDirectory() && path.dirname(name) === stateDirectory
      && path.basename(name).startsWith('.rb-')) throw Object.assign(new Error('state file sync'), { code: 'EIO' });
    return fs.fsyncSync(fd);
  };
  const f = fixture(t, { fsApi }); stateDirectory = path.dirname(f.paths.state);
  const old = 'Prior accepted revision.', artifact = path.join(stateDirectory, 'artifacts', 'revision.md');
  fs.writeFileSync(artifact, old, { mode: 0o600 }); const state = JSON.parse(fs.readFileSync(f.paths.state));
  state.artifacts.revision = { kind: 'revision', file: 'artifacts/revision.md', sha256: hash(old),
    originalChars: old.length, storedChars: old.length, truncated: false, updatedAt: f.clock.value };
  fs.writeFileSync(f.paths.state, JSON.stringify(state));
  f.enroll(); const release = liveDecision(f); failStateSync = true;
  assert.throws(() => finalize(f)); assert.equal(f.pipeline.get(runId).phase, 'revising');
  assert.equal(fs.readFileSync(artifact, 'utf8'), release.artifact.markdown); assert.equal(fs.existsSync(f.paths.lock), true);
  failStateSync = false; f.restart(); assert.equal(finalize(f).phase, 'revision_ready'); assert.equal(fs.existsSync(f.paths.lock), false);
});
