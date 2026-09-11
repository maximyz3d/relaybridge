'use strict';
// Optional REST surface over a PRIVATE owned-execution backend. Register only
// after normal capability authentication. No provider start/kill/proof inputs.
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const HASH = /^[a-f0-9]{64}$/;
function fault(code) { return Object.assign(new Error(code), { code }); }
function intent(input) {
  const fields = ['ownerId', 'recoveryId', 'expectedOwnerRevision', 'expectedBindingHash',
    'expectedWorkflowRevision', 'expectedOwnerSetHash', 'reason'];
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join('|') !== fields.sort().join('|')
    || !ID.test(input.ownerId || '') || !ID.test(input.recoveryId || '')
    || !HASH.test(input.expectedBindingHash || '') || !HASH.test(input.expectedOwnerSetHash || '')
    || !Number.isSafeInteger(input.expectedOwnerRevision) || input.expectedOwnerRevision < 1
    || !Number.isSafeInteger(input.expectedWorkflowRevision) || input.expectedWorkflowRevision < 1
    || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500) throw fault('OWNER_ARGUMENT_INVALID');
  return structuredClone(input);
}
function registerOwnedWorkflowRoutes({ app, pipeline, backend = null, assertActionIdentity }) {
  if (typeof assertActionIdentity !== 'function') throw fault('OWNER_ACTION_IDENTITY_UNAVAILABLE');
  function workflow(id) {
    const value = pipeline.get(id);
    if (!value) throw fault('WORKFLOW_NOT_FOUND');
    return value;
  }
  function availability(value) {
    if (!value.ownerRecovery && (!value.writerLease?.ownerProtocol || !value.writerLease?.executionOwner)) return 'unavailable_unbound_owner';
    if (!backend || typeof backend.assertReady !== 'function') return 'unavailable_unqualified_backend';
    try { backend.assertReady(); } catch { return 'unavailable_unqualified_backend'; }
    return null;
  }
  function sendError(res, error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'OWNER_OPERATION_FAILED';
    const status = code === 'OWNER_ARGUMENT_INVALID' ? 400 : code === 'WORKFLOW_NOT_FOUND' ? 404
      : code === 'OWNER_BACKEND_UNAVAILABLE' ? 503 : code === 'OWNER_OPERATION_FAILED' ? 500 : 409;
    return res.status(status).json({ ok: false, code }); // Never expose proof/control/error payloads.
  }
  app.get('/api/workflows/:runId/owner-recovery', (req, res) => {
    try {
      const value = workflow(req.params.runId), unavailable = availability(value);
      if (unavailable) return res.json({ workflowId: value.runId, recoverable: false, reason: unavailable, readOnly: true });
      const state = backend.inspectWriter(value.runId); // Inert, bounded, no proof probe or reconciliation.
      const allowed = ['awaiting_physical_proof', 'ready_for_recovery', 'application_pending', 'released'];
      if (!allowed.includes(state?.state)) throw fault('OWNER_BACKEND_UNAVAILABLE');
      return res.json({ workflowId: value.runId, recoverable: state.state === 'ready_for_recovery',
        reason: state.state, ownerId: value.writerLease?.executionOwner?.ownerId || value.ownerRecovery?.ownerId,
        bindingHash: value.writerLease?.executionOwner?.bindingHash || value.ownerRecovery?.bindingHash,
        ownerRevision: Number.isSafeInteger(state.ownerRevision) ? state.ownerRevision : null,
        workflowRevision: value.revision, ownerSetHash: HASH.test(state.ownerSetHash || '') ? state.ownerSetHash : null,
        readOnly: true });
    } catch (error) { return sendError(res, error); }
  });
  app.post('/api/workflows/:runId/owner-recovery', async (req, res) => {
    try {
      assertActionIdentity(req); // Exact current build/store for ALL callers, not only MCP.
      const input = intent(req.body), value = workflow(req.params.runId);
      // A replay with a previously applied audit still reaches the same private
      // decision; availability() deliberately handles only active leases.
      const unavailable = value.ownerRecovery ? null : availability(value);
      if (unavailable === 'unavailable_unbound_owner') throw fault('OWNER_UNAVAILABLE_UNBOUND_LEASE');
      if (unavailable || !backend) throw fault('OWNER_BACKEND_UNAVAILABLE');
      backend.assertReady();
      const result = await backend.recoverWriter(value.runId, input);
      if (result?.released !== true || !ID.test(result.decisionId || '') || result.ownerId !== input.ownerId
        || result.recoveryId !== input.recoveryId) throw fault('OWNER_OPERATION_FAILED');
      return res.json({ ok: true, workflowId: value.runId, ownerId: input.ownerId,
        decisionId: result.decisionId, recoveryId: input.recoveryId, released: true, providerDispatched: false });
    } catch (error) { return sendError(res, error); }
  });
}
module.exports = { registerOwnedWorkflowRoutes };
