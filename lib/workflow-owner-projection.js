'use strict';

// INTERNAL Linux projection of committed execution-owner decisions. The
// authority is deployment code holding the owner journal's real flock; it is
// never populated from REST bodies, task payloads, caller proofs or scans.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { openLinuxDurableDirectory } = require('./linux-durable-file');

const PROTOCOL = 'linux_pid1_writer_v1';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
function fail(code) { throw Object.assign(new Error(code), { code }); }
function closed(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== [...fields].sort().join('|')) fail('OWNER_ARGUMENT_INVALID');
}

function createWorkflowOwnerProjection({ authority, requireState, statePath,
  lockIdentity, canonicalizeCwd, addHistory, archiveProviderTask, installArtifact, artifactPath,
  verifyArtifacts, revisionArtifactCap = 24000, now, fsApi = fs }) {
  if (process.platform !== 'linux') fail('OWNER_PLATFORM_UNQUALIFIED');
  for (const name of ['assertHeld', 'assertWorkspaceAvailable', 'assertMutableLease',
    'readPreparedWriter', 'readCommittedWriterRelease']) {
    if (typeof authority?.[name] !== 'function') fail('OWNER_AUTHORITY_UNAVAILABLE');
  }

  // The authority must qualify these workflow/lock directories as part of its
  // same-host, same-store anchor before supplying this internal capability.
  function withDirectory(directory, operation) {
    let fd = null;
    try {
      fd = fsApi.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const stat = fsApi.fstatSync(fd);
      if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) fail('OWNER_STORE_UNTRUSTED');
      const result = operation(fd, `/proc/self/fd/${fd}`);
      fsApi.fsyncSync(fd);
      const closing = fd; fd = null; fsApi.closeSync(closing);
      return result;
    } finally {
      if (fd !== null) { const closing = fd; fd = null; fsApi.closeSync(closing); }
    }
  }
  function readAt(anchor, name, asText = false) {
    let fd = null;
    try {
      fd = fsApi.openSync(`${anchor}/${name}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fsApi.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()
        || (stat.mode & 0o7777) !== 0o600 || stat.size < 1 || stat.size > 256 * 1024) fail('OWNER_STORE_UNTRUSTED');
      const bytes = Buffer.alloc(stat.size);
      let offset = 0, calls = 0;
      while (offset < bytes.length) {
        if (++calls > 1024) fail('OWNER_STORE_CHANGED');
        const count = fsApi.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) fail('OWNER_STORE_CHANGED');
        offset += count;
      }
      const after = fsApi.fstatSync(fd);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail('OWNER_STORE_CHANGED');
      const named = fsApi.lstatSync(`${anchor}/${name}`);
      if (named.dev !== stat.dev || named.ino !== stat.ino || named.size !== stat.size) fail('OWNER_STORE_CHANGED');
      fsApi.fsyncSync(fd);
      const result = asText ? bytes.toString('utf8') : JSON.parse(bytes.toString('utf8'));
      const closing = fd; fd = null; fsApi.closeSync(closing);
      return result;
    } finally {
      if (fd !== null) { const closing = fd; fd = null; fsApi.closeSync(closing); }
    }
  }
  function confirmState(runId) {
    const file = statePath(runId);
    return withDirectory(path.dirname(file), (_, anchor) => readAt(anchor, path.basename(file)));
  }
  function persist(state) {
    authority.assertHeld();
    state.revision = Number(state.revision || 0) + 1;
    state.updatedAt = now();
    const file = statePath(state.runId);
    const directory = openLinuxDurableDirectory({ directory: path.dirname(file), fsApi });
    try { directory.replaceAtomic(path.basename(file), `${JSON.stringify(state, null, 2)}\n`); }
    finally { directory.close(); }
    return clone(state);
  }
  function exactLease(state) {
    const lease = state.writerLease;
    if (state.phase !== 'revising' || lease?.mode !== 'provider'
      || lease.ownerProtocol !== PROTOCOL || !ID.test(lease.ownerEpoch || '')
      || !state.providerTask || state.providerTask.phase !== state.phase
      || state.providerTask.actor !== lease.actor) fail('OWNER_UNAVAILABLE_UNBOUND_LEASE');
    if (canonicalizeCwd(state.cwd) !== state.cwd) fail('OWNER_CWD_CHANGED');
    return { workflowId: state.runId, phase: state.phase, actor: lease.actor,
      mode: lease.mode, ownerEpoch: lease.ownerEpoch, leaseTokenSha256: lease.leaseTokenSha256,
      leaseAcquiredAt: lease.acquiredAt, cwd: state.cwd, cwdSha256: lease.cwdSha256,
      taskId: state.providerTask.taskId, provider: state.providerTask.provider };
  }
  function matchesLock(lock, binding) {
    return lock.schemaVersion === 1 && lock.runId === binding.workflowId && lock.actor === binding.actor
      && lock.cwd === binding.cwd && lock.cwdSha256 === binding.cwdSha256
      && lock.acquiredAt === binding.leaseAcquiredAt && typeof lock.leaseToken === 'string'
      && sha(lock.leaseToken) === binding.leaseTokenSha256;
  }
  function confirmLock(binding, { remove = false, allowMissing = false } = {}) {
    authority.assertHeld();
    const file = lockIdentity(binding.cwd).filePath;
    return withDirectory(path.dirname(file), (_, anchor) => {
      const name = path.basename(file);
      let lock;
      try { lock = readAt(anchor, name); }
      catch (error) { if (error.code === 'ENOENT' && allowMissing) return false; throw error; }
      if (!matchesLock(lock, binding)) fail('OWNER_LEASE_CHANGED');
      if (remove) fsApi.unlinkSync(`${anchor}/${name}`);
      return lock;
    });
  }
  function bind(runId, input) {
    closed(input, ['ownerId']);
    if (!ID.test(input.ownerId)) fail('OWNER_ARGUMENT_INVALID');
    authority.assertHeld();
    const state = requireState(runId), binding = exactLease(state);
    authority.assertMutableLease(binding.ownerEpoch);
    const prepared = authority.readPreparedWriter(input.ownerId);
    // The authority permits exactly this one namespace for this entire lease
    // epoch, and rejects any second root before proceed. Descendants remain
    // inside that namespace. This is NOT a caller-supplied ownership claim.
    if (prepared?.state !== 'prepared' || prepared.ownerId !== input.ownerId
      || !DIGEST.test(prepared.bindingHash || '') || !isDeepStrictEqual(prepared.writer, binding)
      || !isDeepStrictEqual(prepared.ownerIds, [input.ownerId])) fail('OWNER_BINDING_CHANGED');
    const expected = { ownerId: input.ownerId, bindingHash: prepared.bindingHash, ownerEpoch: binding.ownerEpoch };
    if (state.writerLease.executionOwner) {
      if (!isDeepStrictEqual(state.writerLease.executionOwner, expected)) fail('OWNER_BINDING_CHANGED');
      const confirmed = confirmState(runId);
      if (!isDeepStrictEqual(confirmed.writerLease, state.writerLease)) fail('OWNER_STORE_CHANGED');
      confirmLock(binding);
      return clone(confirmed);
    }
    const lock = confirmLock(binding);
    if (lock.expiresAt <= now()) fail('OWNER_LEASE_EXPIRED');
    state.writerLease.executionOwner = expected;
    addHistory(state, { event: 'writer_execution_owner_bound', actor: 'relaybridge',
      detail: { ownerId: expected.ownerId, bindingHash: expected.bindingHash } });
    return persist(state);
  }
  function apply(runId, input, { recoveryOnly = true } = {}) {
    closed(input, ['ownerId', 'decisionId']);
    if (!ID.test(input.ownerId) || !ID.test(input.decisionId)) fail('OWNER_ARGUMENT_INVALID');
    authority.assertHeld();
    const release = authority.readCommittedWriterRelease(input.ownerId, input.decisionId);
    // readCommittedWriterRelease verifies the journal's whole sealed owner
    // set, confirmed namespace-death proof, immutable explicit intent/CAS and
    // host/store identity. task_capacity decisions are never convertible.
    if (release?.scope !== 'writer_lease' || release.ownerId !== input.ownerId
      || release.decisionId !== input.decisionId || !ID.test(release.recoveryId || '')
      || !DIGEST.test(release.bindingHash || '') || !isDeepStrictEqual(release.ownerIds, [input.ownerId])
      || release.writer?.workflowId !== runId || !Number.isSafeInteger(release.expectedWorkflowRevision)
      || typeof release.reason !== 'string' || !release.reason.trim() || release.reason.length > 500) fail('OWNER_DECISION_UNTRUSTED');
    const operation = release.operation || 'expired_recovery';
    const outcome = release.outcome || 'failed';
    if (recoveryOnly ? operation !== 'expired_recovery'
      : !['live_finalization', 'never_permitted_abort'].includes(operation)) fail('OWNER_DECISION_UNTRUSTED');
    if (!['completed', 'failed', 'cancelled'].includes(outcome)
      || operation === 'expired_recovery' && outcome !== 'failed'
      || operation === 'never_permitted_abort' && (release.proofKind !== 'never_permitted' || outcome === 'completed')
      || operation === 'live_finalization' && release.proofKind !== 'process_tree_settled') fail('OWNER_DECISION_UNTRUSTED');
    const complete = outcome === 'completed';
    if (complete && (operation !== 'live_finalization' || typeof release.artifact?.markdown !== 'string'
      || !release.artifact.markdown.trim() || release.artifact.markdown.length > revisionArtifactCap
      || !DIGEST.test(release.artifact.sha256 || '') || sha(release.artifact.markdown) !== release.artifact.sha256
      || typeof installArtifact !== 'function' || typeof artifactPath !== 'function'
      || typeof verifyArtifacts !== 'function')) fail('OWNER_ARTIFACT_UNTRUSTED');
    const targetPhase = complete ? 'revision_ready' : outcome;
    const audit = { protocol: PROTOCOL, operation, outcome,
      ...(complete ? { artifactSha256: release.artifact.sha256 } : {}),
      decisionId: release.decisionId, recoveryId: release.recoveryId,
      ownerId: release.ownerId, bindingHash: release.bindingHash, writer: clone(release.writer),
      previousRevision: release.expectedWorkflowRevision };
    let state = requireState(runId);
    if (state.ownerRecovery) {
      if (!isDeepStrictEqual(state.ownerRecovery, audit) || state.phase !== targetPhase
        || state.writerLease !== null || state.providerTask !== null
        || state.revision !== release.expectedWorkflowRevision + 1) fail('OWNER_RECOVERY_CONFLICT');
      const confirmed = confirmState(runId);
      if (!isDeepStrictEqual(confirmed.ownerRecovery, audit)) fail('OWNER_STORE_CHANGED');
      if (complete) {
        const file = artifactPath(runId, 'revision');
        const text = withDirectory(path.dirname(file), (_, anchor) => readAt(anchor, path.basename(file), true));
        if (sha(text) !== release.artifact.sha256 || confirmed.artifacts?.revision?.sha256 !== release.artifact.sha256) fail('OWNER_ARTIFACT_CHANGED');
      }
      // A prior decision may have committed state and crashed before unlink or
      // after unlink but before directory fsync. Reconfirm, never guess.
      confirmLock(release.writer, { remove: true, allowMissing: true });
      return clone(confirmed);
    }
    const binding = exactLease(state);
    if (!isDeepStrictEqual(binding, release.writer) || state.revision !== release.expectedWorkflowRevision
      || !isDeepStrictEqual(state.writerLease.executionOwner, { ownerId: release.ownerId,
        bindingHash: release.bindingHash, ownerEpoch: binding.ownerEpoch })) fail('OWNER_BINDING_CHANGED');
    const lock = confirmLock(binding);
    if (operation === 'expired_recovery' && (lock.expiresAt > now() || state.writerLease.expiresAt > now())) fail('OWNER_LEASE_NOT_EXPIRED');
    // The private live decision owns semantic truth; REST never supplies an
    // artifact or claims successful finalization. Reconfirm the revision file
    // and directory before publishing the phase transition or unlinking.
    if (complete) {
      verifyArtifacts(state, release.artifact.sha256);
      const artifact = installArtifact(state, 'revision', release.artifact.markdown);
      const file = artifactPath(runId, 'revision');
      const text = withDirectory(path.dirname(file), (_, anchor) => readAt(anchor, path.basename(file), true));
      if (sha(text) !== release.artifact.sha256 || artifact.sha256 !== release.artifact.sha256) fail('OWNER_ARTIFACT_CHANGED');
      state.revisionCycle = Number(state.revisionCycle || 0) + 1;
      state.revisionRequested = false;
    }
    state.ownerRecovery = audit;
    archiveProviderTask(state, outcome, binding.actor);
    state.writerLease = null;
    if (!complete) state.terminal = { status: outcome, at: now(), actor: 'relaybridge', reason: release.reason };
    const from = state.phase; state.phase = targetPhase;
    addHistory(state, { event: operation === 'expired_recovery' ? 'owned_writer_recovered' : 'owned_writer_finalized',
      from, to: targetPhase, actor: 'relaybridge',
      detail: { ownerId: release.ownerId, decisionId: release.decisionId, recoveryId: release.recoveryId,
        operation, outcome, ...(complete ? { artifactSha256: release.artifact.sha256 } : {}) } });
    state = persist(state);
    confirmLock(binding, { remove: true });
    return state;
  }
  return Object.freeze({ bind, apply, exactLease, finalize: (runId, input) => apply(runId, input, { recoveryOnly: false }) });
}
module.exports = { createWorkflowOwnerProjection, PROTOCOL };
