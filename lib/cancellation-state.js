'use strict';

function disconnectFailureClass({ client = null, deadlineAt = null, now = Date.now() } = {}) {
  const deadline = Number(deadlineAt);
  return client === 'mcp' && Number.isFinite(deadline) && now >= deadline - 250
    ? 'mcp_deadline_cancelled' : 'client_cancelled';
}

function resolveCancellationTerminalState({
  stopReason = null,
  timedOut = false,
  disconnectClass = 'client_cancelled',
} = {}) {
  if (stopReason) {
    const cancelled = ['operator_cancelled', 'client_cancelled', 'mcp_deadline_cancelled'].includes(stopReason);
    const nonTimeStops = new Set(['token_budget', 'quota_reserve', 'quota_unknown', 'assessor_stuck',
      'account_identity_changed', 'coordinator_yielded', 'child_fanout', 'scope_expansion', 'native_transport_limit']);
    return {
      failureClass: cancelled ? stopReason : stopReason === 'provider_permission_denied' ? 'policy'
        : nonTimeStops.has(stopReason) ? stopReason : 'timeout',
      stopReason,
      supervisorStopReason: stopReason,
      cancelled,
      timedOut: cancelled || nonTimeStops.has(stopReason) || stopReason === 'provider_permission_denied' ? false : !!timedOut,
    };
  }
  const failureClass = disconnectClass === 'mcp_deadline_cancelled'
    ? 'mcp_deadline_cancelled' : 'client_cancelled';
  return {
    failureClass,
    stopReason: failureClass,
    supervisorStopReason: null,
    cancelled: true,
    timedOut: false,
  };
}

module.exports = { disconnectFailureClass, resolveCancellationTerminalState };
