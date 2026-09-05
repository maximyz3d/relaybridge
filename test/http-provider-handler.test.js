'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { RunSupervisor } = require('../lib/run-supervisor');
const { createAttemptLifecycle } = require('../lib/attempt-lifecycle');
const { parseHostedTerminal, classifyHttpTerminal } = require('../lib/http-provider-terminal');
const { readProviderBody, readOllamaStream, LIMITS: HTTP_PROVIDER_LIMITS } = require('../lib/http-provider-stream');

const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const handlerSource = source.slice(source.indexOf('async function runHttpProviderOneShot('), source.indexOf('\nconst activeChildren ='));

async function run(response, providerBudget = {}) {
  let result, released = 0, cleaned = 0;
  const activeRuns = new Map();
  const context = vm.createContext({ crypto, AbortController, RunSupervisor, createAttemptLifecycle, readProviderBody,
    readOllamaStream, HTTP_PROVIDER_LIMITS, parseHostedTerminal, classifyHttpTerminal, activeRuns,
    nonnegativeUsageNumber: (value) => Number.isSafeInteger(value) && value >= 0 ? value : null,
    safeTokenSum: (values) => values.reduce((sum, value) => sum + value, 0),
    cleanOutput: (value) => String(value || '').trim(), hostedChatUrl: () => new URL('https://fixture.invalid'),
    hostedApiKey: () => ({ name: 'FAKE_KEY', value: 'not-a-real-key' }),
    fetch: async (_url, options) => { assert.equal(options.redirect, 'manual'); return response; },
    isHostedApiKeyMissingError: () => false,
    rejectedHttpModelInvocation: (status) => [400, 401, 403, 404, 409, 422, 429].includes(status) ? false : null,
    isUpstreamTimeoutStatus: (status) => [408, 504].includes(status),
    classifyProviderHttpFailure: (status) => status === 429 ? 'rate_limit' : status === 401 ? 'auth' : 'provider_error',
    disconnectFailureClass: () => 'client_cancelled', sendOneShotResult: (_res, payload) => { result = payload; },
  });
  const handler = vm.runInContext(handlerSource + '\nrunHttpProviderOneShot;', context);
  const res = new EventEmitter(); res.writableEnded = false;
  await handler({ entry: { oneshot_adapter: 'openai_chat_api', model: 'fixture' }, prompt: 'bounded test', effectivePrompt: 'bounded test',
    res, route: { provider: 'hosted_fixture' }, startedAt: Date.now(), cwd: __dirname,
    supervisorOptions: { idleMs: 1000, hardCapMs: 3000, providerBudget }, accountId: null,
    releaseAdmission: () => { released++; }, cleanupResources: () => { cleaned++; return { ok: true }; } });
  assert.equal(released, 1); assert.equal(cleaned, 1); assert.equal(activeRuns.size, 0);
  return result;
}

function completion(reason = 'stop', message = {}) {
  return { model: 'fixture', choices: [{ finish_reason: reason, message: { content: 'Completed answer.', ...message } }],
    usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 7 } } };
}

test('production hosted handler preserves terminal reasons, nonadditive usage and sticky local budget', async () => {
  for (const [reason, expected] of [['stop', null], ['length', 'max_tokens'], ['content_filter', 'refusal'], ['tool_calls', 'tool_deferred']]) {
    const result = await run(new Response(JSON.stringify(completion(reason))));
    assert.equal(result.failureClass, expected); assert.equal(result.dropped_out, expected !== null);
    assert.equal(result.provider_stop_reason, reason); assert.equal(result.usage.total_tokens, 18);
    assert.equal(result.usage.cache_read_input_tokens, 7); assert.equal(result.usage.cache_input_included, true);
    assert.equal(result.transport_lifecycle.outcomeSealed, true);
  }
  const refused = await run(new Response(JSON.stringify(completion('stop', { refusal: 'Cannot answer.' }))));
  assert.equal(refused.failureClass, 'refusal'); assert.equal(refused.stdout, '');
  const budget = await run(new Response(JSON.stringify(completion('length'))), { maxTotalTokens: 10 });
  assert.equal(budget.failureClass, 'token_budget'); assert.equal(budget.provider_stop_reason, 'length');
  assert.equal(budget.usage.input_tokens, 12); assert.equal(budget.usage.total_tokens, 18); assert.equal(budget.stdout, '');
});

test('production hosted handler rejects HTTP-200 error/invalid usage without accepting content', async () => {
  for (const extra of [{ error: { message: 'failed' } }, { usage: [] }, { model: {} }]) {
    const result = await run(new Response(JSON.stringify({ ...completion(), ...extra })));
    assert.equal(result.dropped_out, true); assert.equal(result.stdout, ''); assert.equal(result.usage, null);
    assert.equal(result.model_invocation, true);
  }
});

test('production hosted handler preserves 429 on oversized and invalid UTF-8 diagnostic bodies', async () => {
  for (const bytes of ['x'.repeat(65537), Buffer.from([255])]) {
    const result = await run(new Response(bytes, { status: 429 }));
    assert.equal(result.failureClass, 'rate_limit'); assert.equal(result.rate_limited, true);
    assert.equal(result.provider_api_error_status, 429); assert.equal(result.model_invocation, false);
    assert.equal(result.physical_attempt_count, 1); assert.ok(result.transport_diagnostic_code);
  }
});
