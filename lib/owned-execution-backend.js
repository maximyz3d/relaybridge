'use strict';
// Private composition of the owner journal, existing queue and workflow store.
// No raw PID, caller proof, shell command or provider replay entry point.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { createOwnerJournal, canonical, hash } = require('./execution-owner');
const { isOwnedHostQualification } = require('./owned-host-qualification');
const { parseRevisionStatus } = require('./workflow-prompts');
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const HASH = /^[a-f0-9]{64}$/;
const PROTOCOL = 'linux_pid1_writer_v1';
const BASE_KEYS = ['requestId', 'invocationId', 'attemptId', 'runId', 'taskId', 'provider',
  'accountId', 'executionHash', 'cwdIdentityHash', 'cwdPolicyId', 'reservationId'];
const IDENTITY_KEYS = ['provider', 'accountId', 'executionHash', 'cwdIdentityHash', 'cwdPolicyId'];
const fault = (code) => Object.assign(new Error(code), { code });
function closed(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw fault('OWNER_ARGUMENT_INVALID');
}
const clone = (value) => structuredClone(value);

function assertNoOrphanedOwnedTasks(dataDir) {
  const directory = path.join(dataDir, 'tasks');
  if (!fs.existsSync(directory)) return;
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fault('OWNER_RECOVERY_SCAN_UNAVAILABLE');
  const entries = fs.opendirSync(directory); let count = 0, bytes = 0;
  try {
    for (;;) {
      const entry = entries.readSync(); if (!entry) return;
      if (++count > 20000) throw fault('OWNER_RECOVERY_SCAN_UNAVAILABLE');
      if (!/^t_[A-Za-z0-9_]+\.json$/.test(entry.name)) continue;
      const file = path.join(directory, entry.name), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.size > 1048576 || (bytes += info.size) > 67108864) throw fault('OWNER_RECOVERY_SCAN_UNAVAILABLE');
        const buffer = Buffer.alloc(info.size + 1); let length = 0, read;
        while (length < buffer.length && (read = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += read;
        if (length !== info.size) throw fault('OWNER_RECOVERY_SCAN_UNAVAILABLE');
        let task;
        try { task = JSON.parse(buffer.subarray(0, length).toString('utf8')); }
        catch { throw fault('OWNER_RECOVERY_SCAN_UNAVAILABLE'); }
        if (task?.executionReservation || task?.execution?.owner || /^owned_/.test(task?.execution?.state || ''))
          throw fault('OWNER_JOURNAL_MISSING');
      } finally { fs.closeSync(fd); }
    }
  } finally { entries.closeSync(); }
}

function createOwnedExecutionBackend({ enabled = false, dataDir, receiptStoreId, qualification = null,
  getTaskQueue, getPipeline, readExecutionIdentity, now = Date.now } = {}) {
  if (typeof enabled !== 'boolean' || typeof dataDir !== 'string' || !path.isAbsolute(dataDir)
    ) throw fault('OWNER_BACKEND_ARGUMENT_INVALID');
  const directory = path.join(dataDir, 'execution-owners');
  let restoreRequired = false;
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fault('OWNER_STORE_UNTRUSTED');
    const handle = fs.opendirSync(directory);
    try { for (;;) { const row = handle.readSync(); if (!row) break; if (row.name !== 'controller.lock') { restoreRequired = true; break; } } }
    finally { handle.closeSync(); }
  }
  // A removed journal never turns a previously owned task into ordinary work.
  // Only new owner markers count; legacy uncertain tasks remain unchanged.
  if (!restoreRequired) assertNoOrphanedOwnedTasks(dataDir);
  const active = enabled && process.platform === 'linux' || restoreRequired;
  if (active && !HASH.test(receiptStoreId || '')) throw fault('OWNER_BACKEND_ARGUMENT_INVALID');
  if (qualification && (!isOwnedHostQualification(qualification) || qualification.directory !== directory)) throw fault('OWNER_HOST_UNQUALIFIED');
  if (active && (typeof getTaskQueue !== 'function' || typeof getPipeline !== 'function'
    || typeof readExecutionIdentity !== 'function')) throw fault('OWNER_BACKEND_ARGUMENT_INVALID');
  let owners = null, closedBackend = false, restored = !active;
  const launches = new Map(), sealed = new Map(), releaseListeners = new Map(), proofErrors = new Map(), finalizers = new Map(), finalizerStatus = new Map();
  function queue() { const value = getTaskQueue?.(); if (!value) throw fault('OWNER_STORES_UNAVAILABLE'); return value; }
  function pipeline() { const value = getPipeline?.(); if (!value) throw fault('OWNER_STORES_UNAVAILABLE'); return value; }
  function assertAuthority() {
    if (closedBackend || !owners) throw fault('OWNER_BACKEND_UNAVAILABLE');
    qualification.assertStorage(); owners.assertHeld();
  }
  function assertReady() { assertAuthority(); if (!restored) throw fault('OWNER_RESTORE_PENDING'); }
  function snapshots() { assertAuthority(); return owners.privateSnapshots(); }
  function ownerRecord(id) { assertAuthority(); return owners.inspect(id); }
  function workflowForTask(task) {
    const id = task?.correlation?.runId;
    if (typeof id !== 'string') return null;
    const value = pipeline().get(id);
    if (!value || value.providerTask?.taskId !== task.id || value.providerTask.provider !== task.kind
      || value.providerTask.actor !== task.user || value.cwd !== task.body?.cwd) return null;
    return value;
  }
  function requiresOwnedTask(task) {
    if (!active) return false;
    const workflow = workflowForTask(task);
    return workflow?.writerLease?.ownerProtocol === PROTOCOL && workflow.writerLease.mode === 'provider';
  }
  function exactTask(binding) {
    const task = queue().get(binding.taskId);
    if (!task || task.id !== binding.taskId || task.kind !== binding.provider
      || task.body?.requestId !== binding.requestId || binding.invocationId !== binding.requestId
      || binding.attemptId !== `${binding.requestId}:attempt:1`
      || task.executionReservation?.reservationId !== binding.reservationId
      || !binding.writer || task.body.cwd !== binding.writer.cwd) throw fault('OWNER_TASK_BINDING_CHANGED');
    const recorded = owners?.privateSnapshots().find((row) => row.binding.taskId === binding.taskId && row.binding.runId === binding.runId);
    if (recorded) {
      if (!isDeepStrictEqual(recorded.binding, binding)) throw fault('OWNER_EXECUTION_IDENTITY_CHANGED');
      // The original resolved account/model is immutable journal authority;
      // never re-select today's linked/default account during recovery.
      const route = task.route || {};
      for (const [key, routeKey] of [['executionHash', 'execution_hash'], ['cwdIdentityHash', 'cwd_identity_hash'], ['cwdPolicyId', 'cwd_policy_id']]) {
        if (route[routeKey] != null && route[routeKey] !== binding[key]) throw fault('OWNER_EXECUTION_IDENTITY_CHANGED');
      }
    } else if (!isDeepStrictEqual(Object.fromEntries(IDENTITY_KEYS.map((key) => [key, binding[key]])), readExecutionIdentity(clone(task)))) throw fault('OWNER_EXECUTION_IDENTITY_CHANGED');
    return task;
  }
  function validateWriterBinding(writer, { ownerId, operation, decision, expectedWorkflowRevision } = {}) {
    try {
      if (!['prepare', 'launch', 'expired_recovery', 'live_finalization', 'never_permitted_abort', 'apply'].includes(operation)) return false;
      const workflow = pipeline().get(writer.workflowId);
      if (!workflow) return false;
      const audit = workflow.ownerRecovery;
      if (operation === 'apply' && decision && audit && audit.ownerId === ownerId
        && audit.bindingHash === decision.bindingHash && isDeepStrictEqual(audit.writer, writer)
        && audit.decisionId === decision.decisionId) return true;
      if (!isDeepStrictEqual(pipeline().getOwnedWriterBinding(writer.workflowId), writer)) return false;
      if (['prepare', 'launch'].includes(operation) && (workflow.writerLease.expiresAt <= now()
        || queue().get(writer.taskId)?.status !== 'running')) return false;
      if (!['prepare', 'launch'].includes(operation) && workflow.revision !== expectedWorkflowRevision) return false;
      if (operation === 'expired_recovery' && workflow.writerLease.expiresAt > now()) return false;
      const reference = workflow.writerLease.executionOwner;
      // Preparation precedes the pipeline's bind call; no provider may be
      // permitted until both pipeline and queue references are present.
      return operation === 'prepare' && !reference || reference?.ownerId === ownerId;
    } catch { return false; }
  }
  function validateCurrentBinding(binding) {
    try {
      const task = exactTask(binding), workflow = pipeline().get(binding.writer.workflowId);
      if (!workflow) return false;
      const record = owners?.privateSnapshots().find((row) => row.binding.taskId === binding.taskId && row.binding.runId === binding.runId);
      if (workflow.ownerRecovery && record && workflow.ownerRecovery.ownerId === record.ownerId
        && workflow.ownerRecovery.bindingHash === record.bindingHash && isDeepStrictEqual(workflow.ownerRecovery.writer, binding.writer)) return true;
      if (!isDeepStrictEqual(pipeline().getOwnedWriterBinding(binding.writer.workflowId), binding.writer)) return false;
      const local = launches.get(binding.runId);
      if (!record) return !!local && !local.ownerId && isDeepStrictEqual(local.binding, binding);
      const reference = workflow.writerLease.executionOwner;
      return reference?.ownerId === record.ownerId && reference.bindingHash === record.bindingHash
        && task.execution?.owner?.ownerId === record.ownerId && task.execution.owner.bindingHash === record.bindingHash;
    } catch { return false; }
  }
  function resolveTrustedLaunch(binding) {
    const local = launches.get(binding.runId);
    if (!local || !isDeepStrictEqual(local.binding, binding)) throw fault('OWNER_LAUNCH_UNAVAILABLE');
    qualification.assertLaunch({ binding, launch: local.launch, profile: local.profile });
    return { launch: clone(local.launch), profile: clone(local.profile) };
  }
  function readWriterOutcome({ ownerId, binding }) {
    const value = sealed.get(ownerId);
    if (!value || value.bindingHash !== hash(binding)) throw fault('OWNER_OUTCOME_UNAVAILABLE');
    if (value.taskHash && hash(semanticTask(exactTask(binding))) !== value.taskHash) throw fault('OWNER_OUTCOME_CHANGED');
    return clone(value.outcome);
  }
  function applyWriterRelease(binding, decision) {
    const value = owners.readCommittedWriterRelease(decision.ownerId, decision.decisionId);
    if (value.operation === 'expired_recovery') pipeline().applyOwnedWriterRecovery(binding.writer.workflowId, {
      ownerId: decision.ownerId, decisionId: decision.decisionId });
    else pipeline().applyOwnedWriterFinalization(binding.writer.workflowId, { ownerId: decision.ownerId, decisionId: decision.decisionId });
    return true;
  }
  function notifyReleased() {
    for (const row of snapshots()) {
      if (row.held) continue;
      const listeners = releaseListeners.get(row.ownerId);
      if (!listeners) continue;
      for (const listener of [...listeners]) { listener(); listeners.delete(listener); }
      if (!listeners.size) releaseListeners.delete(row.ownerId);
    }
  }
  function refresh() { assertAuthority(); queue().refreshOwnedReservations(); notifyReleased(); }
  function initializeJournal(capability) {
    if (!active) return;
    if (owners) { if (capability !== qualification) throw fault('OWNER_AUTHORITY_CHANGED'); return; }
    if (!isOwnedHostQualification(capability) || capability.directory !== directory) throw fault('OWNER_HOST_UNQUALIFIED');
    qualification = capability;
    owners = createOwnerJournal({ directory, receiptStoreId, hostIdentity: qualification.hostIdentity,
      qualifyHost: () => qualification.assertStorage(), resolveTrustedLaunch,
      createPhysicalOwner: (options) => qualification.createPhysicalOwner(options),
      validateCurrentBinding, validateWriterBinding, readWriterOutcome,
      applyTaskRelease: (binding, decision) => queue().applyOwnedTaskRelease(binding, decision), applyWriterRelease,
    });
  }
  if (active && qualification) initializeJournal(qualification);
  const writerAuthority = !active ? null : Object.freeze(Object.fromEntries(['assertHeld', 'assertWorkspaceAvailable',
    'assertMutableLease', 'readPreparedWriter', 'readCommittedWriterRelease'].map((name) => [name, (...args) => {
      assertAuthority(); return owners[name](...args);
    }])));
  const taskAuthority = !active ? null : Object.freeze(Object.fromEntries(['listTaskReservations', 'readPreparedTaskOwner',
    'readCommittedTaskRelease'].map((name) => [name, (...args) => {
      // Queue construction is paused: persisted owned markers remain uncertain
      // until startup qualification restores authoritative rows before resume.
      if (!owners && !closedBackend && name === 'listTaskReservations') return [];
      assertAuthority(); return owners[name](...args); }])));

  async function restoreAndRollForward() {
    if (!active) return { restored: true, held: 0 };
    assertAuthority(); queue(); pipeline();
    queue().refreshOwnedReservations();
    for (const record of snapshots()) {
      if (record.writerDecision && !record.writerApplied) await owners.applyWriterDecision(record.ownerId, record.writerDecision.decisionId);
      if (record.decision && !record.taskApplied) await owners.applyRelease(record.ownerId, record.decision.decisionId);
    }
    refresh(); restored = true;
    return { restored: true, held: owners.listTaskReservations().filter((row) => row.held).length };
  }
  function assertQualifiedRevision({ workflow, provider, cwd }) {
    assertReady();
    if (!enabled) throw fault('OWNER_EXECUTION_DISABLED');
    if (!workflow || workflow.phase !== 'review_ready' || workflow.permissionMode !== 'full'
      || workflow.phasePolicy?.revision.mode === 'external') throw fault('OWNER_WORKFLOW_INELIGIBLE');
    qualification.assertRevision({ provider, cwd });
  }
  function assertWorkspaceLaunchAllowed({ cwd, privateContext = null, dangerous = true }) {
    if (dangerous !== true) return;
    const canonicalCwd = fs.realpathSync(cwd);
    if (active) assertReady();
    if (active && privateContext && queue().isExecutionContext(privateContext) && privateContext.requiresOwner) {
      const task = queue().get(privateContext.taskId), workflow = workflowForTask(task);
      if (workflow?.writerLease?.ownerProtocol === PROTOCOL && workflow.cwd === canonicalCwd
        && task.executionReservation?.reservationId === privateContext.reservationId) return;
      throw fault('OWNER_TASK_BINDING_CHANGED');
    }
    if (getPipeline?.()?.ownedWorkspaceHeld(canonicalCwd)) throw fault('OWNER_WORKSPACE_HELD');
    if (active) owners.assertWorkspaceAvailable(canonicalCwd);
  }
  function prepareLaunch(context, input) {
    assertReady(); if (!enabled) throw fault('OWNER_EXECUTION_DISABLED');
    closed(input, ['binding', 'launch', 'profile']); closed(input.binding, BASE_KEYS);
    if (!queue().isExecutionContext(context) || !context.requiresOwner || input.binding.taskId !== context.taskId
      || input.binding.reservationId !== context.reservationId) throw fault('OWNER_TASK_CONTEXT_INVALID');
    const task = queue().get(context.taskId), workflow = workflowForTask(task);
    if (!workflow || workflow.writerLease?.ownerProtocol !== PROTOCOL) throw fault('OWNER_UNAVAILABLE_UNBOUND_LEASE');
    const binding = { ...clone(input.binding), writer: pipeline().getOwnedWriterBinding(workflow.runId) };
    qualification.assertRevision({ provider: binding.provider, cwd: workflow.cwd });
    exactTask(binding);
    if (launches.has(binding.runId)) throw fault('OWNER_EXISTS');
    const local = { binding, launch: clone(input.launch), profile: clone(input.profile), ownerId: null };
    qualification.assertLaunch({ binding, launch: local.launch, profile: local.profile });
    launches.set(binding.runId, local);
    const record = owners.prepare(binding); local.ownerId = record.ownerId;
    pipeline().bindOwnedWriterExecution(workflow.runId, { ownerId: record.ownerId });
    queue().attachOwnedExecution(context, { ownerId: record.ownerId, bindingHash: record.bindingHash, reservationId: context.reservationId });
    // Confirm proof as soon as a live physical owner actually settles. This
    // persists evidence only; it never synthesizes a decision or replays work.
    const physicalDone = owners.physicalDone(record.ownerId);
    Promise.resolve(physicalDone).then(() => owners.confirmPhysical(record.ownerId))
      .catch((error) => { proofErrors.set(record.ownerId, /^[A-Z0-9_]{1,64}$/.test(error.code || '') ? error.code : 'OWNER_PROOF_UNAVAILABLE'); });
    return Object.freeze({ ownerId: record.ownerId, bindingHash: record.bindingHash, binding: clone(binding),
      start: () => { if (!queue().isExecutionContext(context)) throw fault('OWNER_TASK_CONTEXT_EXPIRED'); return owners.start(record.ownerId); },
      permit: () => { if (!queue().isExecutionContext(context)) { owners.stop(record.ownerId); throw fault('OWNER_TASK_CONTEXT_EXPIRED'); } return owners.permit(record.ownerId); },
      stop: () => owners.stop(record.ownerId), physicalDone,
      completion: owners.completion(record.ownerId), snapshot: () => owners.physicalSnapshot(record.ownerId),
      confirmPhysical: () => owners.confirmPhysical(record.ownerId),
    });
  }
  function semanticTask(task) {
    return { id: task.id, status: task.status, result: task.result, resultIntegrity: task.resultIntegrity,
      flags: task.flags, failureClass: task.failureClass, receiptId: task.receiptId, correlation: task.correlation };
  }
  function sealedTaskOutcome(record) {
    const task = exactTask(record.binding);
    if (!['done', 'failed', 'cancelled', 'interrupted'].includes(task.status)) throw fault('OWNER_RESULT_PENDING');
    if (task.status === 'cancelled') return { outcome: 'cancelled', artifact: null };
    const markdown = String(task.result || '').trim();
    const incomplete = task.resultIntegrity?.truncated || task.resultIntegrity?.inputTruncated
      || task.route?.prompt_evidence?.truncated || task.route?.prompt_truncated || task.resultEnvelope?.truncated;
    if (task.status !== 'done' || incomplete || task.failureClass || Object.values(task.flags || {}).some((value) => value === true)
      || !markdown || parseRevisionStatus(markdown) !== 'APPLIED') return { outcome: 'failed', artifact: null };
    return { outcome: 'completed', artifact: { markdown, sha256: hash(markdown) } };
  }
  function decisionIntent(record, recoveryId, reason) {
    const workflow = pipeline().get(record.binding.writer.workflowId);
    return { recoveryId, expectedRevision: record.revision, expectedBindingHash: record.bindingHash,
      expectedWorkflowRevision: workflow.revision, reason };
  }
  async function finalizeTask(ownerId) {
    assertReady();
    let record = ownerRecord(ownerId);
    if (!record.writerDecision) await owners.confirmPhysical(ownerId);
    record = ownerRecord(ownerId);
    if (!record.writerDecision) {
      const task = exactTask(record.binding), outcome = sealedTaskOutcome(record);
      sealed.set(ownerId, { bindingHash: record.bindingHash, taskHash: hash(semanticTask(task)), outcome });
      const intent = decisionIntent(record, `finalize_${record.binding.runId}`, 'Owned provider finished; apply its verified result and physical settlement.');
      owners.commitWriterFinalization(ownerId, intent);
      record = ownerRecord(ownerId);
    }
    if (record.writerDecision.operation !== 'live_finalization') throw fault('OWNER_DECISION_CONFLICT');
    await owners.applyWriterDecision(ownerId, record.writerDecision.decisionId);
    refresh();
    return { ownerId, decisionId: record.writerDecision.decisionId, workflow: pipeline().get(record.binding.writer.workflowId),
      taskHeld: owners.listTaskReservations().find((row) => row.ownerId === ownerId)?.held !== false };
  }
  async function abortBeforePermit(ownerId, reason = 'Owned launch was cancelled before provider permit.') {
    assertReady(); if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw fault('OWNER_ARGUMENT_INVALID');
    let record = ownerRecord(ownerId);
    sealed.set(ownerId, { bindingHash: record.bindingHash, outcome: { outcome: 'failed', artifact: null } });
    if (!record.writerDecision) {
      owners.abortWriterBeforePermit(ownerId, decisionIntent(record, `abort_${record.binding.runId}`, reason));
      record = ownerRecord(ownerId);
    }
    if (record.writerDecision.operation !== 'never_permitted_abort') throw fault('OWNER_DECISION_CONFLICT');
    await owners.applyWriterDecision(ownerId, record.writerDecision.decisionId);
    refresh();
    return { ownerId, decisionId: record.writerDecision.decisionId, writerReleased: true, taskHeld: true };
  }
  function inspectWriter(workflowId) {
    assertReady(); const workflow = pipeline().get(workflowId);
    const reference = workflow?.writerLease?.executionOwner || workflow?.ownerRecovery;
    if (!reference?.ownerId) throw fault('OWNER_UNAVAILABLE_UNBOUND_LEASE');
    const record = ownerRecord(reference.ownerId);
    return { state: record.writerApplied ? 'released' : record.writerDecision ? 'application_pending'
      : record.proof ? 'ready_for_recovery' : 'awaiting_physical_proof',
      ownerRevision: record.revision, ownerSetHash: hash([record.ownerId]) };
  }
  async function recoverWriter(workflowId, input) {
    assertReady(); closed(input, ['ownerId', 'recoveryId', 'expectedOwnerRevision', 'expectedBindingHash',
      'expectedWorkflowRevision', 'expectedOwnerSetHash', 'reason']);
    if (!ID.test(input.ownerId || '') || input.expectedOwnerSetHash !== hash([input.ownerId])) throw fault('OWNER_BINDING_CHANGED');
    const record = ownerRecord(input.ownerId), workflow = pipeline().get(workflowId);
    if (record.binding.writer?.workflowId !== workflowId || !workflow
      || (workflow.writerLease?.executionOwner?.ownerId || workflow.ownerRecovery?.ownerId) !== input.ownerId) throw fault('OWNER_BINDING_CHANGED');
    if (!workflow.ownerRecovery && workflow.writerLease.expiresAt > now()) throw fault('OWNER_LEASE_NOT_EXPIRED');
    const decision = owners.recoverWriter(input.ownerId, { recoveryId: input.recoveryId, expectedRevision: input.expectedOwnerRevision,
      expectedBindingHash: input.expectedBindingHash, expectedWorkflowRevision: input.expectedWorkflowRevision, reason: input.reason });
    await owners.applyWriterDecision(input.ownerId, decision.decisionId); refresh();
    return { released: true, ownerId: input.ownerId, recoveryId: input.recoveryId, decisionId: decision.decisionId };
  }
  function onReleased(ownerId, callback) {
    assertAuthority(); if (typeof callback !== 'function') throw fault('OWNER_ARGUMENT_INVALID');
    if (!releaseListeners.has(ownerId)) releaseListeners.set(ownerId, new Set());
    releaseListeners.get(ownerId).add(callback); notifyReleased();
    return () => releaseListeners.get(ownerId)?.delete(callback);
  }
  function requestFinalizeTask(ownerId) {
    assertReady(); const record = ownerRecord(ownerId);
    if (record.writerApplied) return { state: 'settled', ownerId };
    if (finalizers.has(ownerId)) return { state: 'pending', ownerId };
    if (!['done', 'failed', 'cancelled', 'interrupted'].includes(exactTask(record.binding).status)) return { state: 'result_pending', ownerId };
    const pending = Promise.resolve().then(() => finalizeTask(ownerId));
    finalizers.set(ownerId, pending); finalizerStatus.set(ownerId, { state: 'pending', ownerId });
    pending.then(() => finalizerStatus.set(ownerId, { state: 'settled', ownerId }),
      (error) => finalizerStatus.set(ownerId, { state: 'blocked', ownerId,
        code: /^[A-Z0-9_]{1,64}$/.test(error.code || '') ? error.code : 'OWNER_FINALIZATION_FAILED' }))
      .finally(() => finalizers.delete(ownerId));
    return { state: 'pending', ownerId };
  }
  function reservationSnapshot() {
    if (!active) return [];
    assertAuthority();
    return snapshots().map((record) => ({ ownerId: record.ownerId, taskId: record.binding.taskId,
      reservationId: record.binding.reservationId, provider: record.binding.provider,
      accountId: record.binding.accountId, cwd: record.sourceCwd, held: record.held, writerHeld: record.writerHeld }));
  }
  function stopAll() {
    if (!owners || closedBackend) return { requested: 0, unavailable: 0 };
    const result = { requested: 0, unavailable: 0 };
    // Cancellation uses only controller-retained private IDs; changed storage
    // cannot revoke stop control, nor may it grant proof or release authority.
    for (const local of launches.values()) if (local.ownerId) {
      try { owners.stop(local.ownerId); result.requested++; } catch { result.unavailable++; }
    }
    return result;
  }
  return Object.freeze({ writerAuthority, taskAuthority, requiresOwnedTask, restoreAndRollForward,
    initialize: async (capability) => { initializeJournal(capability); return restoreAndRollForward(); },
    requestFinalizeTask, reservationSnapshot, stopAll, stop: (ownerId) => {
      if (!owners || closedBackend) throw fault('OWNER_BACKEND_UNAVAILABLE');
      return owners.stop(ownerId);
    },
    isExecutionContext: (context) => { try { return queue().isExecutionContext(context); } catch { return false; } },
    assertQualifiedRevision, assertWorkspaceLaunchAllowed, prepareLaunch, finalizeTask, abortBeforePermit,
    inspectWriter, recoverWriter, assertReady, refresh, onReleased,
    writerRecoveryBackend: active ? Object.freeze({ assertReady, inspectWriter, recoverWriter }) : null,
    finalizationStatus: (ownerId) => clone(finalizerStatus.get(ownerId) || { state: 'idle', ownerId }),
    status: () => ({ enabled, active, restored, scope: qualification?.scope || 'unqualified',
      launchProfile: qualification?.profileId || null, restoreRequired }),
    close() { if (closedBackend) return; closedBackend = true; owners?.close(); },
  });
}
module.exports = { createOwnedExecutionBackend };
