'use strict';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (message, code = 'http_invalid_frame') => Object.assign(new Error(message), { code, failureClass: 'provider_protocol_error' });

function tokenCount(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(`Provider ${field} is malformed.`, 'http_invalid_usage');
  return value;
}

function toolCount(value) {
  if (value === undefined || value === null) return 0;
  if (!Array.isArray(value) || value.length > 128 || value.some((tool) => !object(tool)
    || !object(tool.function) || typeof tool.function.name !== 'string' || !tool.function.name
    || tool.function.name.length > 160 || !(typeof tool.function.arguments === 'string' || object(tool.function.arguments)))) {
    throw invalid('Provider tool-call envelope is malformed.');
  }
  return value.length;
}

// This adapter requests one nonstreaming chat completion. Validate every known
// alternative before accepting any answer or usage; never retain raw tool args,
// refusal prose, reasoning, or unknown fields in terminal metadata.
function parseHostedTerminal(document) {
  if (!object(document)) throw invalid('Provider completion must be an object.');
  if (document.object !== undefined && document.object !== 'chat.completion') throw invalid('Provider completion object type is invalid.');
  if (Object.hasOwn(document, 'error')) {
    if (!object(document.error) || typeof document.error.message !== 'string' || !document.error.message
      || (document.error.type !== undefined && typeof document.error.type !== 'string')) throw invalid('Provider error envelope is malformed.');
    throw Object.assign(new Error('Provider returned an error envelope.'), { code: 'http_provider_error', failureClass: 'provider_error' });
  }
  if (document.model !== undefined && (typeof document.model !== 'string' || !document.model || document.model.length > 160)) {
    throw invalid('Provider model identity is malformed.');
  }
  if (!Array.isArray(document.choices) || document.choices.length !== 1 || !object(document.choices[0])) {
    throw invalid('Provider completion needs exactly one choice.');
  }
  const choice = document.choices[0], message = choice.message;
  if ((choice.index !== undefined && choice.index !== 0) || !object(message) || (message.role !== undefined && message.role !== 'assistant')
    || (message.content !== undefined && message.content !== null && typeof message.content !== 'string')
    || (message.refusal !== undefined && message.refusal !== null && typeof message.refusal !== 'string')
    || typeof choice.finish_reason !== 'string' || !choice.finish_reason || choice.finish_reason.length > 64) {
    throw invalid('Provider completion message or terminal reason is malformed.');
  }
  if (Object.hasOwn(document, 'output_text') && (typeof document.output_text !== 'string' || document.output_text !== message.content)) {
    throw invalid('Provider output envelopes disagree.');
  }
  let tools = toolCount(message.tool_calls);
  if (message.function_call !== undefined && message.function_call !== null) {
    tools += toolCount([{ function: message.function_call }]);
  }
  let usage = null;
  if (document.usage !== undefined && document.usage !== null) {
    if (!object(document.usage)) throw invalid('Provider usage must be an object.', 'http_invalid_usage');
    const source = document.usage;
    const input = tokenCount(source.prompt_tokens, 'prompt_tokens');
    const output = tokenCount(source.completion_tokens, 'completion_tokens');
    const total = tokenCount(source.total_tokens, 'total_tokens');
    if (!Number.isSafeInteger(input + output) || total !== input + output) throw invalid('Provider token totals disagree.', 'http_invalid_usage');
    usage = { input_tokens: input, output_tokens: output, total_tokens: total, cache_input_included: true };
    for (const [field, leaf, target, ceiling] of [
      ['prompt_tokens_details', 'cached_tokens', 'cache_read_input_tokens', input],
      ['completion_tokens_details', 'reasoning_tokens', 'thinking_tokens', output],
    ]) {
      const detail = source[field];
      if (detail === undefined || detail === null) continue;
      if (!object(detail)) throw invalid('Provider usage details are malformed.', 'http_invalid_usage');
      if (detail[leaf] !== undefined) {
        const count = tokenCount(detail[leaf], leaf);
        if (count > ceiling) throw invalid('Provider token detail exceeds its total.', 'http_invalid_usage');
        usage[target] = count;
      }
    }
    for (const field of ['queue_time', 'prompt_time', 'completion_time', 'total_time']) {
      if (source[field] !== undefined && (typeof source[field] !== 'number' || !Number.isFinite(source[field]) || source[field] < 0)) {
        throw invalid('Provider usage duration is malformed.', 'http_invalid_usage');
      }
    }
  }
  const refused = Boolean(message.refusal?.trim());
  if (typeof message.content !== 'string' && !tools && !refused && !['tool_calls', 'function_call', 'content_filter'].includes(choice.finish_reason)) {
    throw invalid('Provider completion has no textual answer.');
  }
  return { model: document.model || null, reason: choice.finish_reason, output: message.content || '',
    usage, toolCount: tools, refused, compatibility: null };
}

function classifyHttpTerminal({ reason, toolCount: tools = 0, refused = false, compatibility = null }) {
  if (refused || reason === 'content_filter') return { failureClass: 'refusal', stopReason: 'refusal' };
  if (reason === 'length') return { failureClass: 'max_tokens', stopReason: 'max_tokens' };
  if (tools || reason === 'tool_calls' || reason === 'function_call') return { failureClass: 'tool_deferred', stopReason: 'tool_deferred' };
  if (reason === 'stop' || (reason === null && compatibility === 'ollama_done_without_reason_v1')) return { failureClass: null, stopReason: null };
  return { failureClass: 'provider_incomplete_response', stopReason: 'provider_terminal_incomplete' };
}

module.exports = { parseHostedTerminal, classifyHttpTerminal, toolCount };
