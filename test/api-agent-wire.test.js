'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ENDPOINTS, API_MODEL_CAPABILITIES, WIRES, ERROR_CLASSIFICATION, validateCapabilities, resolveApiModel, modelMatches,
  assertStrictSchema, classifyProviderError } = require('../lib/api-agent-wire');
const { TOOL_DEFINITIONS } = require('../lib/api-agent-tools');
const { claudeMessage, openaiResponse } = require('./helpers/fake-provider-api');

const CURRENT = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6-astra', 'gpt-6.1-sol'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

test('endpoints are fixed HTTPS production constants', () => {
  assert.deepEqual({ ...ENDPOINTS }, { claude: 'https://api.anthropic.com/v1/messages', openai: 'https://api.openai.com/v1/responses' });
  assert.ok(Object.isFrozen(ENDPOINTS));
});

test('capability table is validated, code owned and covers both providers', () => {
  assert.ok(Object.isFrozen(API_MODEL_CAPABILITIES));
  for (const provider of ['claude', 'openai']) assert.ok(Object.values(API_MODEL_CAPABILITIES).some((e) => e.provider === provider));
  assert.throws(() => validateCapabilities({ 'claude-x': { provider: 'claude', maxOutputTokens: 1, efforts: [], effortWire: null } }), /no openai entry/);
  assert.throws(() => validateCapabilities({ a: {} }), TypeError);
  assert.throws(() => validateCapabilities({ 'gpt-x': { provider: 'openai', maxOutputTokens: 0, efforts: [], effortWire: null } }), TypeError);
  assert.throws(() => validateCapabilities({ 'gpt-x': { provider: 'openai', maxOutputTokens: 1, efforts: [], effortWire: null, extra: 1 } }), TypeError);
});

test('capability table keys are exactly the approved current and preserved legacy IDs', () => {
  assert.deepEqual(Object.keys(API_MODEL_CAPABILITIES).sort(), ['claude-haiku-4-5-20251001', 'claude-opus-5-5', 'claude-sonnet-4-5-20250929',
    'claude-sonnet-5-5', 'gpt-5', 'gpt-5-mini', 'gpt-6-astra', 'gpt-6.1-sol']);
  for (const id of CURRENT) {
    const entry = API_MODEL_CAPABILITIES[id];
    assert.equal(entry.maxOutputTokens, 128000, id); assert.deepEqual([...entry.efforts], EFFORTS, id);
    assert.deepEqual([...entry.observedSnapshots], [], id);
    assert.equal(entry.effortWire, entry.provider === 'claude' ? 'output_config.effort' : 'reasoning.effort', id);
  }
  for (const id of ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929']) {
    assert.equal(API_MODEL_CAPABILITIES[id].maxOutputTokens, 64000); assert.equal(API_MODEL_CAPABILITIES[id].effortWire, null);
  }
  // The wire is null only for an entry with no efforts.
  assert.throws(() => validateCapabilities({ 'claude-x': { provider: 'claude', maxOutputTokens: 1, efforts: ['low'], effortWire: null },
    'gpt-x': { provider: 'openai', maxOutputTokens: 1, efforts: [], effortWire: null } }), /effortWire/);
  assert.throws(() => validateCapabilities({ 'claude-x': { provider: 'claude', maxOutputTokens: 1, efforts: ['low'], effortWire: 'reasoning.effort' },
    'gpt-x': { provider: 'openai', maxOutputTokens: 1, efforts: [], effortWire: null } }), /effortWire/);
  assert.throws(() => validateCapabilities({ 'claude-x': { provider: 'claude', maxOutputTokens: 1, efforts: [], effortWire: 'output_config.effort' },
    'gpt-x': { provider: 'openai', maxOutputTokens: 1, efforts: [], effortWire: null } }), /effortWire/);
});

test('aliases are never translated and unsupported effort is refused', () => {
  for (const alias of ['opus', 'sonnet', 'haiku', 'default', 'gpt-5-codex', 'claude-sonnet-4-5', 'claude-opus-5', 'claude-opus-4-1']) {
    assert.throws(() => resolveApiModel('claude', alias), { code: 'api_model_unmapped' });
  }
  for (const alias of ['astra', 'sol', 'default', 'gpt-6', 'gpt-6.1', 'gpt-6-sol']) {
    assert.throws(() => resolveApiModel('openai', alias), { code: 'api_model_unmapped' });
  }
  for (const id of CURRENT) {
    const provider = API_MODEL_CAPABILITIES[id].provider;
    for (const effort of ['ultra', 'minimal', 'none', 'MAX']) assert.throws(() => resolveApiModel(provider, id, effort), { code: 'api_effort_unsupported' }, `${id} ${effort}`);
  }
  assert.throws(() => resolveApiModel('claude', 'gpt-6.1-sol'), { code: 'api_model_unmapped' });
  assert.throws(() => resolveApiModel('openai', 'claude-opus-5-5'), { code: 'api_model_unmapped' });
  assert.throws(() => resolveApiModel('claude', 'gpt-5'), { code: 'api_model_unmapped' });
  assert.throws(() => resolveApiModel('openai', 'claude-haiku-4-5-20251001'), { code: 'api_model_unmapped' });
  assert.throws(() => resolveApiModel('claude', 'claude-haiku-4-5-20251001', 'high'), { code: 'api_effort_unsupported' });
  assert.throws(() => resolveApiModel('openai', 'gpt-5', 'xhigh'), { code: 'api_effort_unsupported' });
  const r = resolveApiModel('openai', 'gpt-5', 'low');
  assert.equal(r.apiModel, 'gpt-5'); assert.equal(r.effort, 'low'); assert.equal(r.maxOutputTokens, 128000);
  assert.ok(modelMatches(r, 'gpt-5')); assert.ok(modelMatches(r, 'gpt-5-2025-08-07'));
  assert.ok(!modelMatches(r, 'gpt-5-mini')); assert.ok(!modelMatches(r, null));
  const current = resolveApiModel('claude', 'claude-opus-5-5', 'max');
  assert.ok(modelMatches(current, 'claude-opus-5-5')); assert.ok(!modelMatches(current, 'claude-sonnet-5-5'));
});

test('every current model and effort produces exactly its effort field and no forbidden Claude controls', () => {
  const FORBIDDEN = ['thinking', 'temperature', 'top_p', 'top_k', 'tool_choice'];
  for (const id of CURRENT) {
    const provider = API_MODEL_CAPABILITIES[id].provider;
    for (const effort of [...EFFORTS, null]) {
      const model = resolveApiModel(provider, id, effort);
      const state = WIRES[provider].initialState({ prompt: 'hi', system: 'sys' });
      const body = WIRES[provider].buildRequest(state, model, TOOL_DEFINITIONS);
      assert.equal(body.model, id);
      if (provider === 'claude') {
        assert.equal(body.max_tokens, 128000);
        if (effort) assert.deepEqual(body.output_config, { effort }); else assert.equal('output_config' in body, false);
        assert.equal('reasoning' in body, false);
        for (const field of FORBIDDEN) assert.equal(field in body, false, `${id} ${effort} ${field}`);
        assert.equal(body.messages.at(-1).role, 'user', 'no assistant prefill');
        assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', ...(effort ? ['output_config'] : []), 'system', 'tools'].sort());
      } else {
        assert.equal(body.max_output_tokens, 128000);
        if (effort) assert.deepEqual(body.reasoning, { effort }); else assert.equal('reasoning' in body, false);
        assert.equal('output_config' in body, false);
        for (const field of ['temperature', 'top_p', 'tool_choice']) assert.equal(field in body, false, `${id} ${effort} ${field}`);
      }
    }
  }
  // Signed thinking blocks from a prior turn are replayed unchanged.
  const signed = { type: 'thinking', thinking: 'opaque', signature: 'sig-opaque-9' };
  const state = { system: null, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [signed, { type: 'tool_use', id: 't1', name: 'list_dir', input: { path: null } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }] };
  const body = WIRES.claude.buildRequest(state, resolveApiModel('claude', 'claude-sonnet-5-5', 'xhigh'), TOOL_DEFINITIONS);
  assert.deepEqual(body.messages[1].content[0], signed); assert.equal('thinking' in body, false);
});

test('tool schemas are strict and Responses requests carry strict tools, store:false and reasoning replay', () => {
  for (const d of TOOL_DEFINITIONS) assert.ok(assertStrictSchema(d.inputSchema, d.name));
  assert.throws(() => assertStrictSchema({ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } }, required: [] }), /required/);
  assert.throws(() => assertStrictSchema({ type: 'object', properties: {}, required: [] }), /additionalProperties/);
  const model = resolveApiModel('openai', 'gpt-5-mini', 'medium');
  const body = WIRES.openai.buildRequest(WIRES.openai.initialState({ prompt: 'hi', system: 'sys' }), model, TOOL_DEFINITIONS);
  assert.equal(body.store, false); assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.deepEqual(body.reasoning, { effort: 'medium' }); assert.equal(body.max_output_tokens, 128000);
  assert.ok(body.tools.every((t) => t.strict === true && t.type === 'function'));
  assert.equal(body.instructions, 'sys');
  const claude = WIRES.claude.buildRequest(WIRES.claude.initialState({ prompt: 'hi' }), resolveApiModel('claude', 'claude-haiku-4-5-20251001'), TOOL_DEFINITIONS);
  assert.equal(claude.max_tokens, 64000); assert.equal(claude.system, undefined);
  assert.ok(!('thinking' in claude));
});

test('headers bind credential and declared org/project without an organization check', () => {
  const h = WIRES.claude.headers('sk-ant-test-value');
  assert.deepEqual(Object.keys(h).sort(), ['anthropic-version', 'content-type', 'x-api-key']);
  const o = WIRES.openai.headers('sk-test-value', { organization: 'org_1', project: 'proj_1' });
  assert.equal(o.authorization, 'Bearer sk-test-value'); assert.equal(o['openai-organization'], 'org_1'); assert.equal(o['openai-project'], 'proj_1');
});

test('Claude parse maps stop reasons and replays thinking verbatim', () => {
  const tool = claudeMessage({ thinking: true, text: 'let me look', tools: [{ id: 't1', name: 'list_dir', input: { path: null } }] });
  const p = WIRES.claude.parseResponse(tool);
  assert.equal(p.stop, 'tool_calls'); assert.deepEqual(p.toolCalls, [{ id: 't1', name: 'list_dir', input: { path: null } }]);
  assert.equal(p.assistant.content[0].signature, 'sig-opaque-1');
  const state = WIRES.claude.appendAssistant(WIRES.claude.initialState({ prompt: 'x' }), p.assistant);
  assert.deepEqual(state.messages[1].content, tool.content);
  for (const [reason, stop] of [['end_turn', 'completed'], ['max_tokens', 'output_limit_reached'], ['refusal', 'refusal'],
    ['pause_turn', 'pause_turn'], ['model_context_window_exceeded', 'context_window_exceeded'], ['weird', 'provider_protocol_error']]) {
    const parsed = WIRES.claude.parseResponse(claudeMessage({ text: 'x', stop: reason }));
    assert.equal(parsed.stop, stop, reason);
    assert.deepEqual(parsed.toolCalls, []);
  }
  // A partial tool call under max_tokens is never surfaced for execution.
  assert.deepEqual(WIRES.claude.parseResponse(claudeMessage({ tools: [{ name: 'read_file', input: {} }], stop: 'max_tokens' })).toolCalls, []);
  assert.equal(WIRES.claude.parseResponse({ nope: 1 }).stop, 'provider_protocol_error');
});

test('OpenAI parse maps incomplete, refusal, content filter and malformed calls', () => {
  const p = WIRES.openai.parseResponse(openaiResponse({ reasoning: true, tools: [{ id: 'c1', name: 'search', input: { query: 'a', path: null } }] }));
  assert.equal(p.stop, 'tool_calls'); assert.equal(p.assistant[0].encrypted_content, 'enc-opaque-1');
  assert.equal(p.usage.reasoning_output_tokens, 3); assert.equal(p.usage.cache_read_input_tokens, 5);
  assert.equal(WIRES.openai.parseResponse(openaiResponse({ status: 'incomplete', incomplete: 'max_output_tokens', tools: [{ name: 'search', input: '{"query":' }] })).stop, 'output_limit_reached');
  assert.equal(WIRES.openai.parseResponse(openaiResponse({ status: 'incomplete', incomplete: 'content_filter' })).stop, 'content_filter');
  assert.equal(WIRES.openai.parseResponse(openaiResponse({ refusal: true })).stop, 'refusal');
  assert.equal(WIRES.openai.parseResponse(openaiResponse({ tools: [{ name: 'search', input: '{bad' }] })).stop, 'provider_protocol_error');
  assert.equal(WIRES.openai.parseResponse(openaiResponse({ text: 'done' })).stop, 'completed');
});

test('error classification follows the pinned table', () => {
  const cases = [
    ['openai', 429, { error: { code: 'credit_balance_exhausted' } }, 'funding_exhausted', true],
    ['openai', 429, { error: { code: 'insufficient_quota' } }, 'funding_ambiguous', false],
    ['openai', 400, { error: { code: 'insufficient_quota' } }, 'funding_ambiguous', false],
    ['openai', 429, { error: { code: 'organization_spend_limit_exceeded' } }, 'spend_limit', false],
    ['openai', 429, { error: { code: 'project_spend_limit_exceeded' } }, 'spend_limit', false],
    ['claude', 429, { type: 'error', error: { type: 'rate_limit_error', message: 'x', details: { error_code: 'enforced_spend_limit_reached' } } }, 'spend_limit', false],
    ['claude', 400, { error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }, 'account_credit_low', false],
    ['claude', 400, { error: { type: 'invalid_request_error', message: 'You have reached your specified API usage limits.' } }, 'spend_limit', false],
    ['claude', 429, { error: { type: 'rate_limit_error' } }, 'rate_limited', false],
    ['openai', 429, { error: { code: 'rate_limit_exceeded' } }, 'rate_limited', false],
    ['claude', 529, { error: { type: 'overloaded_error' } }, 'provider_unavailable', false],
    ['claude', 500, { error: { type: 'overloaded_error' } }, 'provider_unavailable', false],
    ['openai', 503, null, 'provider_unavailable', false],
    ['claude', 401, null, 'auth', false],
    ['openai', 403, null, 'permission', false],
    ['claude', 400, { error: { message: 'bad request' } }, 'provider_request_rejected', false],
  ];
  for (const [provider, status, body, cls, release] of cases) {
    const r = classifyProviderError(provider, status, body);
    assert.equal(r.errorClass, cls, `${provider} ${status} ${JSON.stringify(body)}`);
    assert.equal(r.releaseEligible, release);
  }
  assert.equal(classifyProviderError('claude', 429, { error: { code: 'credit_balance_exhausted' } }).errorClass, 'rate_limited');
  assert.equal(classifyProviderError('claude', 429, {}).resumable, true);
  assert.ok(Object.isFrozen(ERROR_CLASSIFICATION));
});
