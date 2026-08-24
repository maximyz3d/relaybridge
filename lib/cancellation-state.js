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
    return {
      failureClass: stopReason === 'token_budget' ? 'token_budget' : 'timeout',
      stopReason,
      supervisorStopReason: stopReason,
      cancelled: false,
      timedOut: stopReason === 'token_budget' ? false : !!timedOut,
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
