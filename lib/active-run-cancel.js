'use strict';
const { intentHash } = require('./result-delivery');
function cancelActiveRun({ runId, input, activeRuns, controls, append, now = Date.now }) {
  const fail = (code, status) => { throw Object.assign(new Error(code), { code, status }); };
  if (!/^run_[A-Za-z0-9_-]{1,100}$/.test(runId || '') || !input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 3 || !['requestId', 'invocationId', 'attemptId'].every(key => typeof input[key] === 'string' && input[key].length > 0 && input[key].length <= 200)) fail('invalid_run_cancellation', 400);
  const active = activeRuns.get(runId), control = controls.get(runId);
  if (!active || !control || control.settled || typeof control.stop !== 'function') fail('active_run_not_found', 404);
  if (active.route !== control.route || input.requestId !== control.route.request_id || input.invocationId !== control.route.invocation_id
    || input.attemptId !== control.route.attempt_id) fail('active_run_identity_changed', 409);
  if (!control.operatorCancellation) {
    const binding = { event: 'active_run_cancel_requested', runId, ...input };
    control.operatorCancellation = { ...binding, receiptId: `rcpt_cancel_${intentHash(binding)}`,
      timestamp: new Date(now()).toISOString(), reason: 'operator_cancelled', terminationVerified: false };
  }
  append(control.operatorCancellation);
  const alreadyRequested = control.operatorCancellationAccepted === true;
  const accepted = alreadyRequested || control.stop('operator_cancelled') === true;
  if (accepted) control.operatorCancellationAccepted = true;
  return { runId, ...input, receiptId: control.operatorCancellation.receiptId,
    stopRequested: accepted, alreadyRequested, terminationVerified: false };
}
module.exports = { cancelActiveRun };
