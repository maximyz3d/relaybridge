'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHostedTerminal, classifyHttpTerminal } = require('../lib/http-provider-terminal');

function completion(extra = {}, message = {}) {
  return { model: 'fixture', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'answer', ...message } }],
    usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }, ...extra };
}

test('hosted completion validates usage totals and keeps cache/reasoning breakdown nonadditive', () => {
  const parsed = parseHostedTerminal(completion({ usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18,
    prompt_tokens_details: { cached_tokens: 7 }, completion_tokens_details: { reasoning_tokens: 2 } } }));
  assert.deepEqual(parsed.usage, { input_tokens: 12, output_tokens: 6, total_tokens: 18, cache_input_included: true, cache_read_input_tokens: 7, thinking_tokens: 2 });
  assert.deepEqual(classifyHttpTerminal(parsed), { failureClass: null, stopReason: null });
});

test('truncation, refusal, tool requests and administrative/unknown terminals cannot succeed', () => {
  for (const [reason, expected] of [['stop', null], ['length', 'max_tokens'], ['content_filter', 'refusal'],
    ['tool_calls', 'tool_deferred'], ['function_call', 'tool_deferred'], ['load', 'provider_incomplete_response'],
    ['unload', 'provider_incomplete_response'], ['unexpected', 'provider_incomplete_response'], [null, 'provider_incomplete_response']]) {
    assert.equal(classifyHttpTerminal({ reason }).failureClass, expected);
  }
  assert.equal(classifyHttpTerminal({ reason: null, compatibility: 'ollama_done_without_reason_v1' }).failureClass, null);
  assert.equal(classifyHttpTerminal(parseHostedTerminal(completion({}, { refusal: 'cannot answer' }))).failureClass, 'refusal');
  const tools = parseHostedTerminal(completion({}, { tool_calls: [{ function: { name: 'lookup', arguments: 'private arguments' } }] }));
  assert.equal(classifyHttpTerminal(tools).failureClass, 'tool_deferred'); assert.equal(JSON.stringify(tools).includes('private'), false);
});

test('hosted contradictory or malformed known envelopes fail before returning any content or usage', () => {
  const base = completion();
  for (const extra of [
    { error: { message: 'failed' } }, { error: 'failed' }, { error: null }, { model: {} }, { object: 'chat.completion.chunk' },
    { choices: [{ ...base.choices[0], index: 7 }] },
    { choices: [] }, { choices: [...base.choices, ...base.choices] }, { choices: [{ message: { content: 'answer' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: {}, refusal: 'fallback' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: 'answer', refusal: 3 } }] },
    { choices: [{ finish_reason: 'stop', message: { content: 'answer', tool_calls: {} } }] },
    { choices: [{ finish_reason: 'stop', message: { content: 'answer', function_call: { name: 'x' } } }] },
    { output_text: 'different' }, { usage: [] }, { usage: 'bad' }, { usage: {} },
    { usage: { prompt_tokens: '12', completion_tokens: 6, total_tokens: 18 } },
    { usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 19 } },
    { usage: { ...base.usage, completion_tokens_details: { reasoning_tokens: 7 } } },
    { usage: { ...base.usage, prompt_tokens_details: { cached_tokens: -1 } } },
    { usage: { ...base.usage, total_time: '1' } },
  ]) assert.throws(() => parseHostedTerminal(completion(extra)), (error) => ['provider_error', 'provider_protocol_error'].includes(error.failureClass), JSON.stringify(extra));
});
