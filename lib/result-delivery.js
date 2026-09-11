'use strict';

// Pure projections for the existing task store. No execution, replay or new
// result database; acknowledgement is delivery evidence, never approval.
const crypto = require('node:crypto');
const { redactCheckpointSecrets, MAX_REDACTION_SOURCE_BYTES } = require('./partial-checkpoint');
const MAX_RESULT_BYTES = 200000;
const HASH = /^[a-f0-9]{64}$/;
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'interrupted']);
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => value[key] !== undefined).map((key) => [key, stable(value[key])]));
  return value;
}
function intentHash(input) { return sha256(JSON.stringify(stable(input))); }
function reference(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)
    && redactCheckpointSecrets(value, 1024) === value ? value : null;
}
function deliveryRecord(input, receiptStoreId) {
  if (!HASH.test(String(receiptStoreId || ''))) fail('DELIVERY_UNAVAILABLE', 'result delivery has no qualified store identity');
  return { version: 1, mode: 'queued', intentHash: intentHash(input), receiptStoreId,
    acknowledgedAt: null, acknowledgedResultHash: null };
}
function sanitizeResult(payload = {}, failed = false, task = {}) {
  if (!payload || typeof payload !== 'object') payload = {};
  const source = typeof payload.stdout === 'string' ? payload.stdout : typeof payload.text === 'string' ? payload.text : '';
  const originalBytes = Buffer.byteLength(source);
  let text = '', unavailableReason = null;
  if (originalBytes > MAX_REDACTION_SOURCE_BYTES) unavailableReason = 'redaction_input_limit';
  else {
    text = redactCheckpointSecrets(source, MAX_REDACTION_SOURCE_BYTES);
    if (Buffer.byteLength(text) > MAX_RESULT_BYTES) { text = ''; unavailableReason = 'result_size_limit'; }
  }
  if (!text.trim() && !unavailableReason) unavailableReason = 'no_semantic_result';
  const partial = Boolean(failed || payload.stdout_truncated === true || payload.stdoutTruncated === true
    || payload.prompt_truncated === true || payload.route?.prompt_truncated === true || payload.route?.prompt_evidence?.truncated === true
    || payload.audit_usability?.usable === false || payload.partial_result === true || payload.dropped_out === true || payload.ok === false
    || !!payload.failureClass || !!payload.error || (payload.exitCode != null && payload.exitCode !== 0)
    || ['auth_failed', 'budget_exceeded', 'timed_out', 'rate_limited', 'permission_denied'].some((key) => payload[key] === true));
  const requestId = reference(payload.requestId || payload.route?.request_id);
  const invocationId = reference(payload.invocationId || payload.route?.invocation_id);
  const attemptId = reference(payload.attemptId || payload.route?.attempt_id);
  const expectedRequest = task.body?.requestId;
  const expectedInvocation = task.correlation?.invocationId || expectedRequest;
  const expectedAttempt = task.correlation?.attemptId || `${expectedInvocation}:attempt:1`;
  if (!expectedRequest || requestId !== expectedRequest || invocationId !== expectedInvocation
    || !attemptId || (expectedAttempt && attemptId !== expectedAttempt)
    || !attemptId.startsWith(`${invocationId}:attempt:`) || !/^[1-9][0-9]{0,5}$/.test(attemptId.slice(`${invocationId}:attempt:`.length))) {
    text = ''; unavailableReason = 'result_correlation_unverified';
  }
  return { text, metadata: { version: 1, sanitizerVersion: 'semantic-result-v1',
    state: unavailableReason ? 'unavailable' : 'persisted', unavailableReason,
    sha256: unavailableReason ? null : sha256(text), bytes: Buffer.byteLength(text), originalBytes,
    complete: !partial && !unavailableReason && !!text.trim(),
    partial, truncated: false,
    modelInvocation: typeof payload.model_invocation === 'boolean' ? payload.model_invocation : null,
    providerCompleted: !partial && !payload.supervisor_stop_reason
      && ['end_turn', 'stop', 'completed'].includes(payload.provider_terminal_reason) ? true : null,
    requestId, invocationId, attemptId,
    providerRunId: reference(payload.runId || payload.run_id || payload.route?.run_id),
    providerReceiptId: reference(payload.receiptId),
  } };
}
function resultProjection(task, receiptStoreId, expectedId = task?.id) {
  if (!task) fail('TASK_NOT_FOUND', 'task not found');
  if (typeof task.id !== 'string' || !/^t_[A-Za-z0-9_]{1,120}$/.test(task.id) || task.id !== expectedId
    || !['queued', 'running', ...TERMINAL].includes(task.status)) fail('DELIVERY_UNAVAILABLE', 'stored task identity or status is invalid');
  if (task.delivery?.version !== 1 || task.delivery.mode !== 'queued'
    || !HASH.test(String(receiptStoreId || '')) || !HASH.test(String(task.delivery.intentHash || ''))
    || task.delivery.receiptStoreId !== receiptStoreId) fail('DELIVERY_UNAVAILABLE', 'task has no result delivery contract for this store');
  const terminal = TERMINAL.has(task.status);
  const stored = task.resultEnvelope;
  const ackAt = task.delivery.acknowledgedAt;
  const ackHash = task.delivery.acknowledgedResultHash;
  if (!(ackAt === null && ackHash === null) && !(Number.isSafeInteger(ackAt) && ackAt >= 0 && HASH.test(String(ackHash)))) {
    fail('DELIVERY_UNAVAILABLE', 'stored delivery acknowledgement is invalid');
  }
  const validMetadata = stored?.sanitizerVersion === 'semantic-result-v1'
    && Number.isSafeInteger(stored.bytes) && stored.bytes >= 1 && stored.bytes <= MAX_RESULT_BYTES
    && Number.isSafeInteger(stored.originalBytes) && stored.originalBytes >= 0 && stored.originalBytes <= MAX_REDACTION_SOURCE_BYTES
    && typeof stored.complete === 'boolean' && typeof stored.partial === 'boolean' && stored.truncated === false
    && !(stored.complete && stored.partial) && !(stored.providerCompleted && stored.partial)
    && (stored.modelInvocation === null || typeof stored.modelInvocation === 'boolean')
    && (stored.providerCompleted === null || stored.providerCompleted === true)
    && stored.unavailableReason === null;
  const correlation = stored && sanitizeResult({ stdout: task.result, requestId: stored.requestId,
    invocationId: stored.invocationId, attemptId: stored.attemptId }, false, task);
  const available = terminal && !['cancelled', 'interrupted'].includes(task.status)
    && validMetadata && stored?.version === 1 && stored.state === 'persisted' && typeof task.result === 'string'
    && correlation.metadata.unavailableReason === null && correlation.text === task.result
    && HASH.test(String(stored.sha256)) && sha256(task.result) === stored.sha256 && Buffer.byteLength(task.result) === stored.bytes;
  const integrityLost = task.resultIntegrity?.truncated === true || task.resultIntegrity?.inputTruncated === true;
  const metadata = available ? {
    sanitizerVersion: stored.sanitizerVersion, sha256: stored.sha256, bytes: stored.bytes,
    originalBytes: stored.originalBytes, complete: !integrityLost && task.status === 'done' && stored.complete === true,
    partial: integrityLost || task.status === 'failed' || stored.partial === true,
    modelInvocation: stored.modelInvocation, providerCompleted: integrityLost ? null : stored.providerCompleted,
    requestId: reference(stored.requestId), invocationId: reference(stored.invocationId), attemptId: reference(stored.attemptId),
    providerRunId: reference(stored.providerRunId), providerReceiptId: reference(stored.providerReceiptId),
  } : null;
  return { taskId: task.id, status: task.status, deliveryMode: 'queued', receiptStoreId,
    resultState: available ? 'persisted' : terminal ? 'unavailable' : 'pending', resultPersisted: available,
    result: available ? task.result : null, metadata,
    unavailableReason: terminal && !available ? ['redaction_input_limit', 'result_size_limit', 'no_semantic_result', 'result_correlation_unverified'].includes(stored?.unavailableReason)
      ? stored.unavailableReason : 'no_recoverable_result' : null,
    acknowledged: available && task.delivery.acknowledgedResultHash === stored.sha256,
    acknowledgedAt: available && task.delivery.acknowledgedResultHash === stored.sha256 ? task.delivery.acknowledgedAt : null,
    resultEndpoint: `/api/tasks/${encodeURIComponent(task.id)}/result`,
  };
}
function acknowledgeResult(task, input, receiptStoreId, at) {
  const projected = resultProjection(task, receiptStoreId);
  if (input?.receiptStoreId !== receiptStoreId || !HASH.test(String(input?.sha256 || ''))
    || !projected.resultPersisted || input.sha256 !== projected.metadata.sha256) {
    fail('RESULT_IDENTITY_MISMATCH', 'acknowledgement requires this exact store and persisted result hash');
  }
  if (!Number.isSafeInteger(at) || at < 0) fail('INVALID_DELIVERY', 'invalid acknowledgement time');
  if (projected.acknowledged) return task;
  return { ...task, delivery: { ...task.delivery, acknowledgedAt: at, acknowledgedResultHash: input.sha256 } };
}

module.exports = { MAX_RESULT_BYTES, intentHash, deliveryRecord, sanitizeResult, resultProjection, acknowledgeResult };
