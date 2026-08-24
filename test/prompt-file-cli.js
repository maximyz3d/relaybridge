#!/usr/bin/env node
'use strict';

const fs = require('fs');

if (process.argv.includes('--version')) {
  process.stdout.write('prompt-file-cli 1.0.0\n');
  process.exit(0);
}

const fileIndex = process.argv.indexOf('--prompt-file');
if (fileIndex < 0 || !process.argv[fileIndex + 1]) {
  process.stderr.write('missing --prompt-file\n');
  process.exit(2);
}

const prompt = fs.readFileSync(process.argv[fileIndex + 1], 'utf8');
if (process.argv.includes('--write-home-artifact')) {
  fs.writeFileSync(require('path').join(process.env.HOME || process.env.USERPROFILE, 'provider-artifact.txt'), 'provider state', 'utf8');
}
if (process.argv.includes('--spawn-delayed-home-artifact')) {
  const artifact = require('path').join(process.env.HOME || process.env.USERPROFILE, 'late-provider-artifact.txt');
  const child = require('child_process').spawn(process.execPath, [
    '-e',
    "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'late state'), 750)",
    artifact,
  ], { windowsHide: true, stdio: 'ignore' });
  child.unref();
}
const markerIndex = process.argv.indexOf('--invocation-marker');
if (markerIndex >= 0 && process.argv[markerIndex + 1]) {
  fs.appendFileSync(process.argv[markerIndex + 1], `${prompt}\n`, 'utf8');
}
const delayIndex = process.argv.indexOf('--delay');
const delayMs = delayIndex >= 0 ? Math.max(0, Number(process.argv[delayIndex + 1] || 0)) : 0;

if (process.argv.includes('--claude-json-multiturn')) {
  const events = [1, 2, 3].map((turn) => ({
    type: 'assistant',
    message: {
      id: `fixture-turn-${turn}`,
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 25,
      },
      content: [{ type: 'text', text: `turn ${turn}` }],
    },
  }));
  let index = 0;
  const interval = setInterval(() => {
    if (index < events.length) {
      process.stdout.write(JSON.stringify(events[index++]) + '\n');
      return;
    }
    clearInterval(interval);
    process.stdout.write(JSON.stringify({
      type: 'result', is_error: false, subtype: 'success', result: 'MULTITURN_OK',
      num_turns: 3,
      usage: {
        input_tokens: 300, output_tokens: 120,
        cache_read_input_tokens: 1500, cache_creation_input_tokens: 75,
      },
    }));
  }, 30);
  return;
}

setTimeout(() => {
  if (process.argv.includes('--cursor-action-required')) {
    if (prompt.includes('CURSOR_NAMED_MODELS')) {
      process.stderr.write('ActionRequiredError: Named models unavailable Free plans can only use Auto. Switch to Auto or upgrade plans to continue.\n');
    } else if (prompt.includes('CURSOR_USAGE_LIMIT')) {
      process.stderr.write("ActionRequiredError: You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more.\n");
    } else {
      process.stderr.write('ActionRequiredError: operator action is required for an unrelated reason\n');
    }
    process.exit(1);
  }
  const stderrIndex = process.argv.indexOf('--stderr');
  if (stderrIndex >= 0) process.stderr.write(String(process.argv[stderrIndex + 1] || '') + '\n');
  const exitIndex = process.argv.indexOf('--exit');
  if (exitIndex >= 0) {
    process.stderr.write('requested failure after reading ' + prompt.length + ' characters\n');
    process.exit(Number(process.argv[exitIndex + 1] || 1));
  }
  if (process.argv.includes('--empty')) return;
  const envIndex = process.argv.indexOf('--print-env');
  if (envIndex >= 0) {
    process.stdout.write(String(process.env[process.argv[envIndex + 1]] || ''));
    return;
  }
  const outputIndex = process.argv.indexOf('--output');
  if (process.argv.includes('--perplexity-fixture')) {
    if (prompt.includes('PERPLEXITY_QUOTED_DOCUMENT')) {
      process.stdout.write('> No answer received\nThis is a quoted user document inside a normal answer.');
    } else {
      process.stdout.write('No answer received\nhttps://docs.example.test/one\npartial extracted text');
    }
    return;
  }
  if (process.argv.includes('--claude-json')) {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fixture' }) + '\n');
    process.stdout.write(JSON.stringify({
      type: 'result',
      is_error: false,
      subtype: 'success',
      result: 'STRUCTURED_OK',
      total_cost_usd: 0.32762,
      usage: {
        input_tokens: 2,
        output_tokens: 887,
        cache_read_input_tokens: 20937,
        cache_creation_input_tokens: 13086,
        output_tokens_details: { thinking_tokens: 873 },
      },
      modelUsage: {
        'claude-haiku-4-5-20251001': {
          inputTokens: 528,
          outputTokens: 13,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.000593,
          canonicalModel: 'claude-haiku-4-5',
          provider: 'firstParty',
        },
        'claude-fable-5': {
          inputTokens: 2,
          outputTokens: 887,
          cacheReadInputTokens: 20937,
          cacheCreationInputTokens: 13086,
          costUSD: 0.327027,
          canonicalModel: 'claude-fable-5',
          provider: 'firstParty',
        },
      },
    }));
    return;
  }
  if (process.argv.includes('--claude-json-malformed-model-usage')) {
    process.stdout.write(JSON.stringify({
      type: 'result',
      is_error: false,
      subtype: 'success',
      result: 'TOP_LEVEL_USAGE_OK',
      total_cost_usd: false,
      usage: {
        input_tokens: 7,
        output_tokens: 3,
        cache_read_input_tokens: 11,
        cache_creation_input_tokens: 2,
      },
      modelUsage: {
        metadata_only: {
          canonicalModel: 'not-a-token-row',
          inputTokens: -1,
          outputTokens: 5,
          cacheReadInputTokens: 12,
          cacheCreationInputTokens: 1,
          costUSD: -5,
        },
      },
    }));
    return;
  }
  if (process.argv.includes('--claude-json-malformed-top-usage')) {
    process.stdout.write(JSON.stringify({
      type: 'result',
      is_error: false,
      subtype: 'success',
      result: 'MALFORMED_TOP_USAGE_ANSWER',
      usage: { input_tokens: -1, output_tokens: 5 },
    }));
    return;
  }
  if (process.argv.includes('--claude-json-partial-cost')) {
    process.stdout.write(JSON.stringify({
      type: 'result',
      is_error: false,
      subtype: 'success',
      result: 'PARTIAL_COST_ANSWER',
      usage: { input_tokens: 3, output_tokens: 2, output_tokens_details: { thinking_tokens: 3 } },
      modelUsage: {
        a: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.1, canonicalModel: {}, provider: false },
        b: { inputTokens: 2, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: false },
      },
    }));
    return;
  }
  if (process.argv.includes('--claude-json-error-result')) {
    process.stdout.write(JSON.stringify({
      type: 'result',
      is_error: true,
      subtype: 'error_during_execution',
      errors: ['rate limit reached before completion'],
      usage: { input_tokens: 9, output_tokens: 1 },
    }));
    return;
  }
  if (process.argv.includes('--claude-json-success-error-disagreement')) {
    process.stdout.write(JSON.stringify({
      type: 'system', subtype: 'api_retry', uuid: 'schema-disagreement-retry',
      attempt: 1, max_retries: 3, retry_delay_ms: 125,
      error_status: 429, error: 'rate_limit',
    }) + '\n');
    process.stdout.write(JSON.stringify({
      type: 'result', is_error: true, subtype: 'success', result: 'MUST_NOT_ESCAPE',
      errors: ["You've hit your weekly limit after a provider retry."],
      api_error_status: 429, terminal_reason: 'rapid_refill_breaker',
      stop_reason: 'end_turn', num_turns: 2, duration_ms: 765, duration_api_ms: 654,
      usage: {
        input_tokens: 21, output_tokens: 4,
        cache_read_input_tokens: 5, cache_creation_input_tokens: 6,
        output_tokens_details: { thinking_tokens: 1 },
      },
    }));
    return;
  }
  if (process.argv.includes('--claude-json-error-success-flag-disagreement')) {
    process.stdout.write(JSON.stringify({
      type: 'result', is_error: false, subtype: 'error_during_execution', result: 'MUST_NOT_ESCAPE',
      errors: ['Server is temporarily limiting requests despite a false is_error flag.'],
      api_error_status: 429, terminal_reason: 'rapid_refill_breaker',
      stop_reason: 'end_turn', num_turns: 1, duration_ms: 432, duration_api_ms: 321,
      usage: {
        input_tokens: 31, output_tokens: 2,
        cache_read_input_tokens: 7, cache_creation_input_tokens: 3,
        output_tokens_details: { thinking_tokens: 1 },
      },
    }));
    return;
  }
  if (process.argv.includes('--claude-json-invalid-result')) {
    process.stdout.write(JSON.stringify({
      type: 'assistant', is_error: false, subtype: 'success', result: 'FAKE',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    return;
  }
  if (process.argv.includes('--claude-json-retries')) {
    const retry = (uuid, attempt, status, error, delay) => ({
      type: 'system', subtype: 'api_retry', uuid, attempt, max_retries: 5,
      retry_delay_ms: delay, error_status: status, error,
    });
    process.stdout.write(JSON.stringify(retry('retry-a', 1, 429, 'rate_limit', 100)) + '\n');
    process.stdout.write(JSON.stringify(retry('retry-a', 1, 429, 'rate_limit', 100)) + '\n');
    process.stdout.write(JSON.stringify(retry('', 2, 500, 'server_error', 50)) + '\n');
    process.stdout.write(JSON.stringify(retry('retry-invalid-status', 2, '429', 'rate_limit', 50)) + '\n');
    process.stdout.write(JSON.stringify(retry('retry-b', 2, 529, 'overloaded', 200)) + '\n');
    process.stdout.write(JSON.stringify({
      type: 'result', is_error: false, subtype: 'success', result: 'RETRY_OK',
      stop_reason: 'end_turn', terminal_reason: 'completed',
      permission_denials: [{ tool_name: 'WebFetch', tool_use_id: 'tool-denied-1', tool_input: { url: 'not-persisted' } }],
      num_turns: 3, duration_ms: 987, duration_api_ms: 654,
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    return;
  }
  if (process.argv.includes('--claude-json-budget-error')) {
    process.stdout.write(JSON.stringify({
      type: 'result', is_error: true, subtype: 'error_max_budget_usd',
      errors: ['maximum budget exceeded after provider admission; usage limit also reported'],
      api_error_status: 402, terminal_reason: 'blocking_limit', permission_denials: [],
      stop_reason: 'end_turn', num_turns: 2, duration_ms: 555, duration_api_ms: 444,
      usage: { input_tokens: 12, output_tokens: 1 },
    }));
    return;
  }
  if (process.argv.includes('--claude-json-rate-error')) {
    process.stdout.write(JSON.stringify({
      type: 'result', is_error: true, subtype: 'error_during_execution',
      errors: ["You've hit your weekly limit. Server is temporarily limiting requests."],
      api_error_status: 429, terminal_reason: 'rapid_refill_breaker', permission_denials: [],
      num_turns: 1, duration_ms: 333, duration_api_ms: 222,
      usage: { input_tokens: 8, output_tokens: 1 },
    }));
    return;
  }
  if (process.argv.includes('--claude-json-max-tokens')) {
    process.stdout.write(JSON.stringify({
      type: 'result', is_error: false, subtype: 'success', result: 'TRUNCATED_ANSWER',
      stop_reason: 'max_tokens', terminal_reason: 'blocking_limit', permission_denials: [],
      num_turns: 1, duration_ms: 111, duration_api_ms: 99,
      usage: { input_tokens: 6, output_tokens: 4 },
    }));
    return;
  }
  if (process.argv.includes('--claude-json-auth-error')) {
    process.stdout.write(JSON.stringify({
      type: 'result', is_error: true, subtype: 'error_during_execution',
      errors: ['Not logged in · Please run /login'],
      api_error_status: 401, terminal_reason: 'model_error', permission_denials: [],
      num_turns: 0, duration_ms: 12, duration_api_ms: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    }));
    return;
  }
  if (process.argv.includes('--claude-json-api-timeout')) {
    process.stdout.write(JSON.stringify({
      type: 'result', is_error: true, subtype: 'error_during_execution',
      errors: ['upstream request ended without a response'], api_error_status: 504,
      terminal_reason: 'model_error', permission_denials: [],
      num_turns: 1, duration_ms: 300, duration_api_ms: 299,
      usage: { input_tokens: 4, output_tokens: 0 },
    }));
    return;
  }
  if (process.argv.includes('--claude-json-tool-deferred')) {
    process.stdout.write(JSON.stringify({
      type: 'result', is_error: false, subtype: 'success', result: 'TOOL_DEFERRED',
      stop_reason: 'tool_deferred', terminal_reason: 'tool_deferred', permission_denials: [],
      num_turns: 1, duration_ms: 200, duration_api_ms: 150,
      usage: { input_tokens: 5, output_tokens: 2 },
    }));
    return;
  }
  if (process.argv.includes('--claude-json-terminal-from-prompt')) {
    const terminalReason = String(prompt || '').trim();
    process.stdout.write(JSON.stringify({
      type: 'result', is_error: true, subtype: 'error_during_execution',
      errors: [`terminal reason ${terminalReason}`],
      api_error_status: terminalReason === 'api_error' ? 429 : null,
      terminal_reason: terminalReason, permission_denials: [],
      num_turns: 1, duration_ms: 25, duration_api_ms: 20,
      usage: { input_tokens: 3, output_tokens: 1 },
    }));
    return;
  }
  if (process.argv.includes('--claude-json-retry-hang')) {
    process.stdout.write(JSON.stringify({
      type: 'system', subtype: 'api_retry', uuid: 'retry-before-cancel',
      attempt: 1, max_retries: 5, retry_delay_ms: 250,
      error_status: 529, error: 'overloaded',
    }) + '\n');
    setInterval(() => {}, 1000);
    return;
  }
  process.stdout.write(outputIndex >= 0 ? String(process.argv[outputIndex + 1] || '') : prompt);
}, delayMs);
