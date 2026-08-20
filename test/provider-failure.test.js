'use strict';

// A seat that dies on its own internal deadline has told you nothing about the
// task. Counting that as an answer — or resubmitting it to the same seat — is
// the failure this classifier exists to prevent.

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyRunFailure, seatToleratesLongRuns } = require('../lib/provider-failure');

test('the real Gemini case: internal timeout is not counted as an answer', () => {
  const v = classifyRunFailure({
    stderr: 'Error: timeout waiting for response',
    exitCode: 1,
    elapsedMs: 183900,
  });
  assert.equal(v.kind, 'provider_internal_timeout');
  assert.equal(v.failUp, true, 'must route to a different seat');
  assert.equal(v.retryable, false, 'the same seat will hit the same deadline');
  assert.match(v.detail, /18[34]s/);
});

test('a supervisor stop is never blamed on the provider', () => {
  const v = classifyRunFailure({ stopReason: 'idle_stall', exitCode: 1, stderr: 'timeout waiting for response' });
  assert.equal(v.kind, 'supervisor_idle_stall');
  assert.equal(v.failUp, false, 'the bridge stopped it; do not burn another seat');
  assert.equal(v.retryable, false);
});

test('transport-level drops are recognized as internal timeouts', () => {
  for (const msg of ['socket hang up', 'ETIMEDOUT', 'context deadline exceeded',
    '504 Gateway Timeout', 'upstream request timeout', 'ECONNRESET']) {
    const v = classifyRunFailure({ stderr: msg, exitCode: 1 });
    assert.equal(v.kind, 'provider_internal_timeout', `${msg} should classify as internal timeout`);
  }
});

test('rate limits and quota fail up but are not retried on the same seat', () => {
  for (const msg of ['429 Too Many Requests', 'rate limit exceeded', 'RESOURCE_EXHAUSTED', 'quota exceeded']) {
    const v = classifyRunFailure({ stderr: msg, exitCode: 1 });
    assert.equal(v.kind, 'rate_limited', msg);
    assert.equal(v.failUp, true);
    assert.equal(v.retryable, false, 'retrying a rate limit on the same seat just fails again');
  }
});

test('overload is the one class worth retrying', () => {
  const v = classifyRunFailure({ stderr: 'Error 529: overloaded', exitCode: 1 });
  assert.equal(v.kind, 'overloaded');
  assert.equal(v.retryable, true);
});

test('auth and missing-binary failures are distinguished from task failures', () => {
  assert.equal(classifyRunFailure({ stderr: '401 Unauthorized', exitCode: 1 }).kind, 'auth_failed');
  assert.equal(classifyRunFailure({ stderr: 'Please run `gemini auth login`', exitCode: 1 }).kind, 'auth_failed');
  assert.equal(classifyRunFailure({ stderr: "spawn gemini ENOENT", exitCode: 1 }).kind, 'not_installed');
});

test('a successful run is not pattern-matched into a failure', () => {
  // The word "timeout" appearing in a successful ANSWER must not trip this.
  const v = classifyRunFailure({
    stdout: 'You should set a request timed out handler and a deadline exceeded fallback.',
    exitCode: 0,
  });
  assert.equal(v.kind, 'ok');
  assert.equal(v.failUp, false);
});

test('an unrecognized non-zero exit still fails up rather than passing silently', () => {
  const v = classifyRunFailure({ stderr: 'segmentation fault', exitCode: 139 });
  assert.equal(v.kind, 'provider_error');
  assert.equal(v.failUp, true);
  assert.match(v.detail, /139/);
});

test('seats with short internal deadlines are flagged for long work', () => {
  assert.equal(seatToleratesLongRuns({ internalTimeoutMs: 180000 }), false, '3 min is too short');
  assert.equal(seatToleratesLongRuns({ internalTimeoutMs: 3600000 }), true);
  assert.equal(seatToleratesLongRuns({}), true, 'unknown must not be treated as short');
});
