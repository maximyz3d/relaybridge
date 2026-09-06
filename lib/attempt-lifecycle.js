'use strict';

const crypto = require('node:crypto');

const PHYSICAL_EVIDENCE = new Set(['not_dispatched', 'spawn_failed', 'http_transport_settled', 'process_tree_settled']);
const errorEvidence = (error) => ({
  code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'LIFECYCLE_CALLBACK_ERROR',
  diagnosticHash: crypto.createHash('sha256').update(String(error?.message || error)).digest('hex'),
});

// Owns local physical lifetime, independently of result delivery. Provider
// parsing, native termination proof, and durable result storage belong to the
// caller. A socket close, stop request, or accepted terminal JSON is not proof
// that a child tree/HTTP reader has finished using its resources.
function createAttemptLifecycle({ runId, kind, route, supervisor, registry, releaseAdmission,
  now = Date.now, onSemanticStop = () => {}, tickMs = 5000, drainTimeoutMs = 5000,
  schedule = setInterval, clearSchedule = clearInterval } = {}) {
  if (!runId || !supervisor || !(registry instanceof Map) || typeof releaseAdmission !== 'function') {
    throw new TypeError('attempt lifecycle requires identity, supervisor, registry and admission owner');
  }
  if (registry.has(runId)) throw new Error('attempt run identity already registered');
  if (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs <= 0 || drainTimeoutMs > 60000) throw new TypeError('invalid physical drain timeout');
  let phase = 'admitted', dispatched = false, detached = false, outcome = null;
  let transport = null, stop = null, stopRequested = false, physicalEvidence = null;
  let settlement = null, cleanupStatus = 'pending', finalized = false;
  let quarantine = null;
  let drainDeadlineAt = null, drainStop = null;
  let timer = null;
  const callbackErrors = [];
  let resolvePhysical;
  const physicalDone = new Promise((resolve) => { resolvePhysical = resolve; });
  const entry = { runId, kind, route, startedAt: supervisor.startedAt, supervisor, pid: null };

  function noteCallbackError(error) {
    if (callbackErrors.length < 4) callbackErrors.push(errorEvidence(error));
  }

  function invokeTransportStop() {
    const requested = stop || drainStop;
    if (!requested || !transport || stopRequested || settlement || quarantine) return;
    stopRequested = true;
    try { Promise.resolve(transport.requestStop({ ...requested })).catch(noteCallbackError); }
    catch (error) { noteCallbackError(error); }
  }

  function requestStop({ reason, detail = '', source = 'caller' } = {}) {
    if (outcome || settlement || quarantine || stop) return false;
    if (typeof reason !== 'string' || !/^[a-z_]{1,64}$/.test(reason)) throw new TypeError('invalid lifecycle stop reason');
    stop = { reason, detail: String(detail).slice(0, 2400), source: String(source).slice(0, 64), at: now() };
    phase = 'stopping';
    // Seal the semantic boundary before calling a possibly synchronous abort.
    try { onSemanticStop({ ...stop }); } catch (error) { noteCallbackError(error); }
    invokeTransportStop();
    return true;
  }

  function evaluate() {
    if (settlement || quarantine) return false;
    if (outcome) {
      if (!drainStop && now() >= drainDeadlineAt) {
        drainStop = { reason: 'physical_drain_timeout', detail: 'Terminal result accepted but local transport has not settled.', source: 'transport', at: now() };
        invokeTransportStop();
        return true;
      }
      return false;
    }
    if (stop) return false;
    const verdict = supervisor.evaluate(now());
    return verdict.action === 'kill'
      ? requestStop({ reason: verdict.reason, detail: verdict.detail, source: 'supervisor' }) : false;
  }

  function bindTransport({ type, pid = null, requestStop: stopTransport } = {}) {
    if (transport || settlement || quarantine) throw new Error('transport already bound or settled');
    if (!['cli', 'http'].includes(type) || typeof stopTransport !== 'function'
      || (pid !== null && (!Number.isSafeInteger(pid) || pid <= 0)) || (type === 'http' && pid !== null)) {
      throw new TypeError('invalid physical transport');
    }
    transport = { type, pid, requestStop: stopTransport };
    entry.pid = pid;
    if (type === 'http') supervisor.recordCpuSample(null, now());
    invokeTransportStop();
  }

  function markDispatched() {
    if (settlement || quarantine || outcome || stop || dispatched) return false;
    if (!transport) throw new Error('bind physical transport before dispatch');
    dispatched = true;
    phase = 'running';
    return true;
  }

  function identifyProcess(pid) {
    if (transport?.type !== 'cli' || settlement || quarantine || !Number.isSafeInteger(pid) || pid <= 0
      || (transport.pid !== null && transport.pid !== pid)) throw new TypeError('invalid process identity handoff');
    transport.pid = pid;
    entry.pid = pid;
  }

  function observeOutput(text, accept = () => {}) {
    if (!dispatched || stop || outcome || settlement || quarantine) return false;
    const accepted = supervisor.recordOutput(text, now());
    if (accepted) {
      try { accept(text); } catch (error) {
        noteCallbackError(error); evaluate();
        requestStop({ reason: 'acceptance_failed', source: 'observer' });
        return false;
      }
    }
    evaluate();
    return accepted;
  }

  function observeUsage(usage, usagePhase = 'incremental', accept = () => {}) {
    if (!dispatched || stop || outcome || settlement || quarantine) return false;
    const accepted = supervisor.recordProviderUsage(usage, { phase: usagePhase });
    if (accepted) {
      try { accept(usage); } catch (error) {
        noteCallbackError(error); evaluate();
        requestStop({ reason: 'acceptance_failed', source: 'observer' });
        return false;
      }
    }
    evaluate();
    return accepted;
  }

  function observeCpu(cpuMs) {
    if (!dispatched || stop || outcome || settlement || quarantine || transport?.type !== 'cli') return false;
    supervisor.recordCpuSample(cpuMs, now());
    evaluate();
    return true;
  }

  function clientDetached({ reason = 'client_cancelled', detail = 'Client detached before a terminal result was sealed.' } = {}) {
    detached = true;
    // An already-observed budget verdict wins over later transport cancellation.
    evaluate();
    return requestStop({ reason, detail, source: 'client' });
  }

  function sealOutcome(value) {
    if (outcome || settlement) return false;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('terminal outcome must be an object');
    evaluate();
    outcome = Object.freeze({ ...value });
    drainDeadlineAt = Math.min(now() + drainTimeoutMs, supervisor.startedAt + supervisor.opts.hardCapMs);
    if (!quarantine) phase = 'draining';
    return true;
  }

  function snapshot() {
    return { runId, phase, dispatched, physicalAttemptCount: dispatched ? 1 : 0,
      clientDetached: detached, outcomeSealed: outcome !== null,
      stop: stop ? { ...stop } : null, drainStop: drainStop ? { ...drainStop } : null, drainDeadlineAt,
      stopRequested, physicalEvidence, cleanupStatus, finalized,
      quarantine: quarantine ? { ...quarantine } : null,
      transport: transport ? { type: transport.type, pid: transport.pid,
        remoteTermination: transport.type === 'http' ? 'unverified' : null } : null,
      callbackErrors: callbackErrors.map((error) => ({ ...error })) };
  }

  // Unknown whole-tree death is a diagnostic state, never settlement. The
  // caller persists this bounded record and may return it without awaiting
  // physicalDone. Resource cleanup and admission remain owned until a later
  // independent proof authorizes settlePhysical.
  function quarantinePhysical({ code = 'OWNER_TERMINATION_UNVERIFIED', error } = {}) {
    if (settlement) return settlement;
    if (quarantine) return quarantine;
    if (transport?.type !== 'cli') throw new TypeError('physical quarantine requires a CLI transport');
    if (typeof code !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(code)) throw new TypeError('invalid quarantine code');
    quarantine = Object.freeze({ code, at: now(), ...(error ? { diagnosticHash: errorEvidence(error).diagnosticHash } : {}) });
    phase = 'quarantined'; cleanupStatus = 'quarantined_unverified';
    if (timer !== null) {
      const capturedTimer = timer; timer = null;
      try { clearSchedule(capturedTimer); } catch (error) { noteCallbackError(error); }
    }
    return quarantine;
  }

  function settlePhysical({ evidence, cleanup = async () => ({ ok: true, status: 'not_applicable' }),
    persist = async () => null } = {}) {
    if (settlement) return settlement;
    if (!PHYSICAL_EVIDENCE.has(evidence)
      || (evidence === 'not_dispatched' && dispatched)
      || (evidence === 'spawn_failed' && transport?.type !== 'cli')
      || (quarantine && evidence !== 'process_tree_settled')
      || (['not_dispatched', 'spawn_failed'].includes(evidence) && transport?.pid !== null && transport?.pid !== undefined)
      || (evidence === 'http_transport_settled' && transport?.type !== 'http')
      || (evidence === 'process_tree_settled' && transport?.type !== 'cli')) {
      throw new TypeError('physical settlement requires matching transport evidence');
    }
    physicalEvidence = evidence;
    phase = 'cleanup';
    // Defer callbacks until settlement is published: synchronous reentrant
    // close/error/cancel cannot run a second cleanup or release.
    settlement = Promise.resolve().then(async () => {
      let cleanupResult = null, persistenceResult = null;
      try {
        try {
          cleanupResult = await cleanup();
          cleanupStatus = cleanupResult?.ok === false ? 'failed_preserved' : 'complete';
        } catch (error) {
          cleanupStatus = 'failed_preserved'; cleanupResult = { ok: false, status: 'cleanup_failed_preserved' };
          noteCallbackError(error);
        }
        try { persistenceResult = await persist({ outcome, snapshot: snapshot(), cleanup: cleanupResult }); }
        catch (error) { noteCallbackError(error); }
      } finally {
        try { releaseAdmission(); } catch (error) { noteCallbackError(error); }
        // Identity guard prevents a cleanup callback from deleting a replacement.
        if (registry.get(runId) === entry) registry.delete(runId);
        finalized = true;
        phase = 'settled';
      }
      const result = { snapshot: snapshot(), cleanup: cleanupResult, persistence: persistenceResult };
      resolvePhysical(result);
      return result;
    });
    if (timer !== null) {
      const capturedTimer = timer; timer = null;
      try { clearSchedule(capturedTimer); } catch (error) { noteCallbackError(error); }
    }
    return settlement;
  }

  const api = { bindTransport, markDispatched, identifyProcess, observeOutput, observeUsage, observeCpu,
    requestStop, clientDetached, sealOutcome, quarantinePhysical, settlePhysical, snapshot, physicalDone, evaluate };
  entry.lifecycle = api;
  registry.set(runId, entry);
  if (Number.isFinite(tickMs) && tickMs > 0) {
    try {
      timer = schedule(() => { if (dispatched) evaluate(); }, tickMs);
      timer?.unref?.();
    } catch (error) {
      if (registry.get(runId) === entry) registry.delete(runId);
      try { releaseAdmission(); } catch (releaseError) { noteCallbackError(releaseError); }
      throw error;
    }
  }
  return api;
}

function normalizeTransportLifecycle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.runId !== 'string' || !/^run_[A-Za-z0-9_-]{1,100}$/.test(value.runId)
    || !['admitted', 'running', 'stopping', 'draining', 'quarantined', 'cleanup', 'settled'].includes(value.phase)) return null;
  const count = (n) => Number.isSafeInteger(n) && n >= 0 ? n : null;
  const stop = (entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    && typeof entry.reason === 'string' && /^[a-z_]{1,64}$/.test(entry.reason)
    ? { reason: entry.reason, source: typeof entry.source === 'string' ? entry.source.slice(0, 64) : null,
      at: count(entry.at), detail: typeof entry.detail === 'string' ? entry.detail.slice(0, 2400) : '' } : null;
  return { runId: value.runId, phase: value.phase, dispatched: value.dispatched === true,
    physicalAttemptCount: count(value.physicalAttemptCount), clientDetached: value.clientDetached === true,
    outcomeSealed: value.outcomeSealed === true, stop: stop(value.stop), drainStop: stop(value.drainStop),
    drainDeadlineAt: count(value.drainDeadlineAt), stopRequested: value.stopRequested === true,
    physicalEvidence: PHYSICAL_EVIDENCE.has(value.physicalEvidence) ? value.physicalEvidence : null,
    cleanupStatus: ['pending', 'complete', 'failed_preserved', 'quarantined_unverified'].includes(value.cleanupStatus) ? value.cleanupStatus : null,
    quarantine: value.quarantine && typeof value.quarantine.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(value.quarantine.code)
      ? { code: value.quarantine.code, at: count(value.quarantine.at),
        ...(typeof value.quarantine.diagnosticHash === 'string' && /^[a-f0-9]{64}$/.test(value.quarantine.diagnosticHash)
          ? { diagnosticHash: value.quarantine.diagnosticHash } : {}) } : null,
    finalized: value.finalized === true,
    transport: ['cli', 'http'].includes(value.transport?.type) ? { type: value.transport.type,
      pid: value.transport.type === 'cli' ? count(value.transport.pid) : null,
      remoteTermination: value.transport.type === 'http' ? 'unverified' : null } : null,
    callbackErrors: Array.isArray(value.callbackErrors) ? value.callbackErrors.slice(0, 4).filter((error) =>
      typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
      && typeof error.diagnosticHash === 'string' && /^[a-f0-9]{64}$/.test(error.diagnosticHash))
      .map(({ code, diagnosticHash }) => ({ code, diagnosticHash })) : [] };
}

module.exports = { createAttemptLifecycle, normalizeTransportLifecycle };
