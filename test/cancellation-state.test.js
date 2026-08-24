'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  disconnectFailureClass,
  resolveCancellationTerminalState,
} = require('../lib/cancellation-state');

test('disconnect cause distinguishes direct clients from an expired MCP transport deadline', () => {
  assert.equal(disconnectFailureClass({ client: 'browser', deadlineAt: 900, now: 1000 }), 'client_cancelled');
  assert.equal(disconnectFailureClass({ client: 'mcp', deadlineAt: 2000, now: 1000 }), 'client_cancelled');
  assert.equal(disconnectFailureClass({ client: 'mcp', deadlineAt: 1100, now: 1000 }), 'mcp_deadline_cancelled');
});

test('a sticky supervisor verdict wins an idempotent cancellation race', () => {
  const outputCap = resolveCancellationTerminalState({
    stopReason: 'output_cap', timedOut: true, disconnectClass: 'client_cancelled',
  });
  assert.deepEqual(outputCap, {
    failureClass: 'timeout',
    stopReason: 'output_cap',
    supervisorStopReason: 'output_cap',
    cancelled: false,
    timedOut: true,
  });
  assert.deepEqual(
    resolveCancellationTerminalState({
      stopReason: 'output_cap', timedOut: true, disconnectClass: 'mcp_deadline_cancelled',
    }),
    outputCap,
    'changing the losing disconnect cause cannot rewrite a sticky supervisor terminal state',
  );
  assert.deepEqual(resolveCancellationTerminalState({
    stopReason: 'token_budget', timedOut: false, disconnectClass: 'client_cancelled',
  }), {
    failureClass: 'token_budget',
    stopReason: 'token_budget',
    supervisorStopReason: 'token_budget',
    cancelled: false,
    timedOut: false,
  });
});

test('client cancellation state is typed and stable when no supervisor verdict exists', () => {
  for (const failureClass of ['client_cancelled', 'mcp_deadline_cancelled']) {
    const expected = {
      failureClass,
      stopReason: failureClass,
      supervisorStopReason: null,
      cancelled: true,
      timedOut: false,
    };
    assert.deepEqual(resolveCancellationTerminalState({ disconnectClass: failureClass }), expected);
    assert.deepEqual(resolveCancellationTerminalState({ disconnectClass: failureClass }), expected);
  }
});
