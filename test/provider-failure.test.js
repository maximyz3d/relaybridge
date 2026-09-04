'use strict';

// A seat that dies on its own internal deadline has told you nothing about the
// task. Counting that as an answer — or resubmitting it to the same seat — is
// the failure this classifier exists to prevent.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyRunFailure, classifyProviderHttpFailure, detectCopilotMonthlyQuota,
  detectCursorActionRequired, detectPerplexityNoAnswerSentinel,
  isHeadlessCommandPermissionDenial, isHostedApiKeyMissingError,
  isNarrationOnlyResponse, seatToleratesLongRuns, HOSTED_API_KEY_MISSING_CODE,
} = require('../lib/provider-failure');

const CURSOR_NAMED_MODELS = 'ActionRequiredError: Named models unavailable Free plans can only use Auto. Switch to Auto or upgrade plans to continue.';
const CURSOR_USAGE_LIMIT = "ActionRequiredError: You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more.";

test('Cursor exact named-model rejection is a plan restriction only when a model flag was sent', () => {
  const attributed = classifyRunFailure({
    provider: 'cursor', exitCode: 1, stderr: CURSOR_NAMED_MODELS, modelFlagSent: true,
  });
  assert.equal(attributed.kind, 'plan_restriction');
  assert.equal(attributed.retryable, false);
  assert.equal(attributed.actionRequired.kind, 'named_models_unavailable');
  assert.equal(attributed.actionRequired.modelFlagSent, true);
  assert.match(attributed.detail, /remove the model flag/i);

  const unattributed = classifyRunFailure({
    provider: 'cursor', exitCode: 1, stderr: CURSOR_NAMED_MODELS, modelFlagSent: false,
  });
  assert.equal(unattributed.kind, 'provider_error');
  assert.equal(unattributed.actionRequired.modelFlagSent, false);
  assert.doesNotMatch(unattributed.detail, /remove the model flag/i);
  assert.match(unattributed.detail, /sent no model flag/i);
});

test('Cursor exact usage-limit ActionRequiredError is exhausted budget evidence', () => {
  const run = { provider: 'cursor', exitCode: 1, stdout: '', stderr: CURSOR_USAGE_LIMIT };
  assert.deepEqual(detectCursorActionRequired(run), {
    provider: 'cursor', kind: 'usage_quota_exhausted', scope: 'seat',
    source: 'cursor_cli_stderr', diagnostic: "You've hit your usage limit", modelFlagSent: false,
  });
  const classified = classifyRunFailure(run);
  assert.equal(classified.kind, 'budget');
  assert.equal(classified.retryable, false);
  assert.equal(classified.failUp, true);
});

test('Cursor ActionRequired detection rejects other providers, successful quotes, and prose lookalikes', () => {
  const fixtures = [
    { provider: 'claude', exitCode: 1, stderr: CURSOR_USAGE_LIMIT },
    { provider: 'cursor', exitCode: 0, stdout: CURSOR_USAGE_LIMIT },
    { provider: 'cursor', exitCode: 1, stderr: `The docs say: ${CURSOR_USAGE_LIMIT}` },
    { provider: 'cursor', exitCode: 1, stderr: CURSOR_USAGE_LIMIT.replace('Get Cursor Pro', 'Try Cursor Pro') },
    { provider: 'cursor', exitCode: 1, stderr: `Quoted diagnostic: ${CURSOR_NAMED_MODELS}` },
  ];
  for (const fixture of fixtures) {
    assert.equal(detectCursorActionRequired(fixture), null, JSON.stringify(fixture));
  }
});

test('Perplexity exact first-line no-answer sentinel is a non-retryable partial drop', () => {
  const partialDiagnostic = 'https://example.com/one\nSupporting fragment without a complete answer.';
  const run = {
    provider: 'perplexity', exitCode: 0,
    stdout: `No answer received\n${partialDiagnostic}`,
  };
  assert.deepEqual(detectPerplexityNoAnswerSentinel(run), {
    sentinel: 'No answer received',
    source: 'perplexity_cli_stdout_first_line',
    partialDiagnostic,
  });
  const classified = classifyRunFailure(run);
  assert.equal(classified.kind, 'incomplete_response');
  assert.equal(classified.partialResult, true);
  assert.equal(classified.partialDiagnostic, partialDiagnostic);
  assert.equal(classified.retryable, false, 'the same Perplexity seat must not be retried automatically');
  assert.equal(classified.failUp, true);
});

test('Perplexity sentinel detector rejects quoted content, later mentions, and exact-line lookalikes', () => {
  const ordinaryAnswers = [
    '> No answer received\nThis is a quoted user document.',
    'The quoted document begins with “No answer received”.',
    'Normal answer\nNo answer received\nThis phrase appears later.',
    'No answer received.',
    ' No answer received',
    'No answer received extra text',
  ];
  for (const stdout of ordinaryAnswers) {
    const run = { provider: 'perplexity', exitCode: 0, stdout };
    assert.equal(detectPerplexityNoAnswerSentinel(run), null, stdout);
    assert.equal(classifyRunFailure(run).kind, 'ok', stdout);
  }
  assert.equal(detectPerplexityNoAnswerSentinel({
    provider: 'grok', exitCode: 0, stdout: 'No answer received\nhttps://example.com',
  }), null, 'the sentinel is provider-specific');
  assert.equal(detectPerplexityNoAnswerSentinel({
    provider: 'perplexity', exitCode: 1, stdout: 'No answer received',
  }), null, 'non-zero exits keep their existing terminal classification');
});

test('Grok future-tense process narration is incomplete, preserved, and never retried on the same seat', () => {
  const stdout = 'I will inspect the repository and trace the relevant pipeline.\nNext I will review the tests and report any defects.';
  assert.equal(isNarrationOnlyResponse({ prompt: 'Audit this repository and return concrete findings.', stdout }), true);
  assert.equal(isNarrationOnlyResponse({
    prompt: 'Audit this repository and return concrete findings.',
    stdout: "I’ll inspect the repository first.\nNext I’m going to review the tests.",
  }), true, 'common straight and curly apostrophe contractions are covered');
  const v = classifyRunFailure({ prompt: 'Audit this repository and return concrete findings.', stdout, exitCode: 0 });
  assert.equal(v.kind, 'incomplete_response');
  assert.equal(v.failUp, true);
  assert.equal(v.retryable, false);
});

test('legitimate concise results are not narration-only', () => {
  for (const stdout of [
    'Use a 10 kΩ pull-up. It limits current while preserving the required logic threshold.',
    'I will use a 10 kΩ pull-up.',
    'I inspected the repository. I found two stale routes and confirmed the focused tests pass.',
  ]) {
    assert.equal(isNarrationOnlyResponse({ prompt: 'Return the answer.', stdout }), false, stdout);
  }
});

test('a requested plan remains a valid answer even when every line is future-tense', () => {
  const stdout = 'First I will inspect the existing tests.\nNext I will implement the narrow fix.\nFinally I will run the full suite.';
  for (const prompt of [
    'Please provide a detailed implementation plan.',
    'How would you approach this migration?',
  ]) assert.equal(isNarrationOnlyResponse({ prompt, stdout }), false, prompt);
  assert.equal(isNarrationOnlyResponse({ prompt: 'Plan and implement this migration.', stdout }), true,
    'an execution request must not be exempt merely because it starts with plan');
});

test('code, tables, and structured data outputs are never narration-only', () => {
  for (const stdout of [
    '```js\nconst result = 42;\n```',
    '{"status":"complete","findings":[]}',
    '[{"status":"complete"}]',
    '| check | result |\n| --- | --- |\n| tests | pass |',
  ]) assert.equal(isNarrationOnlyResponse({ prompt: 'Return results.', stdout }), false, stdout);
});

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

test('Antigravity headless command auto-denial is concrete policy evidence and is never retried', () => {
  for (const exitCode of [0, 1]) {
    const run = {
      provider: 'gemini', stdout: '', exitCode,
      stderr: 'jetski: no output produced — a tool required the command permission that headless mode cannot prompt for, so it was auto-denied.',
    };
    assert.equal(isHeadlessCommandPermissionDenial(run), true);
    const classified = classifyRunFailure(run);
    assert.equal(classified.kind, 'headless_command_permission_auto_denied');
    assert.equal(classified.retryable, false);
    assert.equal(classified.failUp, true);
    assert.match(classified.detail, /command-free read-only review policy/);
  }
});

test('quoted permission diagnostics in successful answers are not policy failures', () => {
  const run = {
    provider: 'gemini', exitCode: 0,
    stdout: 'The diagnostic is: jetski: no output produced — a tool required the command permission that headless mode cannot prompt for, so it was auto-denied.',
    stderr: '',
  };
  assert.equal(isHeadlessCommandPermissionDenial(run), false);
  assert.equal(classifyRunFailure(run).kind, 'ok');
});

test('rate limits and quota fail up but are not retried on the same seat', () => {
  for (const msg of ['429 Too Many Requests', 'rate limit exceeded', 'RESOURCE_EXHAUSTED', 'quota exceeded']) {
    const v = classifyRunFailure({ stderr: msg, exitCode: 1 });
    assert.equal(v.kind, 'rate_limited', msg);
    assert.equal(v.failUp, true);
    assert.equal(v.retryable, false, 'retrying a rate limit on the same seat just fails again');
  }
});

test('the exact failed Copilot monthly-quota diagnostic cools the seat without same-seat retry', () => {
  const stderr = 'You have exceeded your monthly quota (Request ID: 393F:279076:21CF7B:277870:6A7E5965)\n\nChanges    +0 -0\nAI Credits 0 (3s)\nResume     copilot --resume=fixture';
  const run = {
    provider: 'copilot', stdout: '', stderr, exitCode: 1,
    observedAt: '2026-08-24T05:05:27.679Z',
  };
  const evidence = detectCopilotMonthlyQuota(run);
  assert.deepEqual({
    provider: evidence.provider, scope: evidence.scope, kind: evidence.kind,
    source: evidence.source, diagnostic: evidence.diagnostic,
    observedAt: evidence.observedAt, stderrChars: evidence.stderrChars,
  }, {
    provider: 'copilot', scope: 'seat', kind: 'monthly_quota_exhausted',
    source: 'copilot_cli_stderr', diagnostic: 'You have exceeded your monthly quota',
    observedAt: '2026-08-24T05:05:27.679Z', stderrChars: stderr.length,
  });
  assert.match(evidence.stderrHash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(evidence), /393F|resume=fixture/i, 'bounded evidence excludes request and resume ids');

  const classified = classifyRunFailure(run);
  assert.equal(classified.kind, 'rate_limited');
  assert.equal(classified.failUp, true);
  assert.equal(classified.retryable, false);
});

test('Copilot quota lookalikes and quoted success prose fail closed', () => {
  const cases = [
    { provider: 'claude', stderr: 'You have exceeded your monthly quota', exitCode: 1 },
    { provider: 'copilot', stderr: 'The docs say: You have exceeded your monthly quota', exitCode: 1 },
    { provider: 'copilot', stderr: 'You may have exceeded your monthly quota', exitCode: 1 },
    { provider: 'copilot', stderr: 'You have exceeded your monthly token quota', exitCode: 1 },
    { provider: 'copilot', stderr: 'You have exceeded your monthly quota (Request ID: ../../secret)', exitCode: 1 },
    { provider: 'copilot', stdout: 'You have exceeded your monthly quota is the error to handle.', stderr: '', exitCode: 0 },
  ];
  for (const fixture of cases) {
    assert.equal(detectCopilotMonthlyQuota(fixture), null, JSON.stringify(fixture));
    assert.notEqual(classifyRunFailure(fixture).kind, 'rate_limited', JSON.stringify(fixture));
  }
});

test('quota text wins over a generic 403 auth signature', () => {
  const v = classifyRunFailure({ stderr: 'HTTP 403: quota exceeded for this subscription', exitCode: 1 });
  assert.equal(v.kind, 'rate_limited');
  assert.equal(v.failUp, true);
});

test('HTTP 403 requires typed response detail before changing account authority', () => {
  assert.equal(classifyProviderHttpFailure(401, ''), 'auth');
  assert.equal(classifyProviderHttpFailure(403, 'HTTP 403: quota exceeded for this subscription'), 'rate_limit');
  assert.equal(classifyProviderHttpFailure(403, 'Credit budget exhausted'), 'budget');
  assert.equal(classifyProviderHttpFailure(403, 'Not logged in. Please run /login'), 'auth');
  assert.equal(classifyProviderHttpFailure(403, 'Forbidden: permission denied for this organization'), 'permission');
  assert.equal(classifyProviderHttpFailure(403, ''), 'provider_error');
  assert.notEqual(classifyRunFailure({ stderr: '403', exitCode: 1 }).kind, 'auth_failed',
    'a bare forbidden status is not proof that credentials are invalid');
});

test('hosted transport errors never infer authentication from numeric lookalikes', () => {
  assert.equal(isHostedApiKeyMissingError(new Error('connect ECONNREFUSED 127.0.0.1:4010')), false);
  assert.equal(isHostedApiKeyMissingError(new Error('proxy route /403/status was unreachable')), false);
  const missingKey = new Error('hosted provider key is not set');
  missingKey.code = HOSTED_API_KEY_MISSING_CODE;
  assert.equal(isHostedApiKeyMissingError(missingKey), true);
});

test('overload is the one class worth retrying', () => {
  const v = classifyRunFailure({ stderr: 'Error 529: overloaded', exitCode: 1 });
  assert.equal(v.kind, 'overloaded');
  assert.equal(v.retryable, true);
});

test('auth and missing-binary failures are distinguished from task failures', () => {
  assert.equal(classifyRunFailure({ stderr: '401 Unauthorized', exitCode: 1 }).kind, 'auth_failed');
  assert.equal(classifyRunFailure({ stderr: 'Please run `gemini auth login`', exitCode: 1 }).kind, 'auth_failed');
  assert.notEqual(classifyRunFailure({
    stderr: 'MCP server docs: authentication required; MCP OAuth token expired; Sign in to enable search',
    exitCode: 1,
  }).kind, 'auth_failed', 'auxiliary-service auth warnings are not provider-account evidence');
  assert.equal(classifyRunFailure({ stderr: "spawn gemini ENOENT", exitCode: 1 }).kind, 'not_installed');
});

test('Copilot signed-out terminal lines are provider-specific auth evidence', () => {
  for (const stderr of [
    'Error: No authentication information found.\nRun copilot login to authenticate.',
    'Not authenticated. Please authenticate first.',
    'Error: chat requires authentication. Please sign in first with: copilot login',
  ]) {
    assert.equal(classifyRunFailure({ provider: 'copilot', stderr, exitCode: 1 }).kind, 'auth_failed');
    assert.notEqual(classifyRunFailure({ provider: 'claude', stderr, exitCode: 1 }).kind, 'auth_failed');
  }
  assert.notEqual(classifyRunFailure({
    provider: 'copilot',
    stderr: 'MCP server docs: authentication required; Please sign in first with: copilot login',
    exitCode: 1,
  }).kind, 'auth_failed');
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
