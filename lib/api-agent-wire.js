'use strict';

// Pure wire adapters for the read-only API agent. No I/O, no clocks, no
// credentials in request bodies. Production endpoints are fixed constants; no
// caller may supply a URL.

const crypto = require('node:crypto');

const ENDPOINTS = Object.freeze({
  claude: 'https://api.anthropic.com/v1/messages',
  openai: 'https://api.openai.com/v1/responses',
});
const SURFACES = Object.freeze({ claude: 'claude_messages_agent', openai: 'openai_responses_agent' });
const ANTHROPIC_VERSION = '2023-06-01';
const PROVIDERS = Object.freeze(['claude', 'openai']);
const fail = (code, detail) => { throw Object.assign(new Error(detail || code), { code }); };

// Code-owned capability table keyed by the concrete provider API model ID.
// CLI aliases ("opus", "sonnet", "default") are never translated. An entry
// is added only with a documentation source for its per-request output
// maximum. `maxOutputTokens` limits one request, as the Messages API requires;
// it is not a run budget. `efforts` lists the effort values this transport
// can express on `effortWire` (Claude `output_config.effort`, OpenAI
// `reasoning.effort`); an entry with no efforts sends no effort control.
// `observedSnapshots` lists response.model values the provider documents as
// the pinned snapshot of the requested alias.
const CURRENT_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const API_MODEL_CAPABILITIES = validateCapabilities({
  // Source: https://platform.claude.com/docs/en/models/opus-5-5/overview
  // (128K max output; effort via output_config.effort, see
  // https://platform.claude.com/docs/en/build-with-claude/effort).
  'claude-opus-5-5': { provider: 'claude', maxOutputTokens: 128000, efforts: CURRENT_EFFORTS, effortWire: 'output_config.effort' },
  // Source: https://platform.claude.com/docs/en/models/sonnet-5-5/overview
  // (128K max output; effort via output_config.effort).
  'claude-sonnet-5-5': { provider: 'claude', maxOutputTokens: 128000, efforts: CURRENT_EFFORTS, effortWire: 'output_config.effort' },
  // Source: https://developers.openai.com/api/docs/models/gpt-6-astra
  // (128,000 max output tokens; reasoning.effort low|medium|high|xhigh|max).
  'gpt-6-astra': { provider: 'openai', maxOutputTokens: 128000, efforts: CURRENT_EFFORTS, effortWire: 'reasoning.effort' },
  // Source: https://developers.openai.com/api/docs/models/gpt-6.1-sol
  // (128,000 max output tokens; reasoning.effort low|medium|high|xhigh|max).
  'gpt-6.1-sol': { provider: 'openai', maxOutputTokens: 128000, efforts: CURRENT_EFFORTS, effortWire: 'reasoning.effort' },
  // Legacy entries kept unchanged from the previous table (output maxima
  // re-checked 2026-10-31; deprecation does not imply any substitution).
  // Source: https://platform.claude.com/docs/en/models/haiku-4-5/overview
  // (Claude Haiku 4.5, API ID claude-haiku-4-5-20251001, max output 64K).
  'claude-haiku-4-5-20251001': { provider: 'claude', maxOutputTokens: 64000, efforts: [], effortWire: null },
  // Source: https://platform.claude.com/docs/en/models/sonnet-4-5/overview
  // (Claude Sonnet 4.5, API ID claude-sonnet-4-5-20250929, max output 64K;
  // deprecated 2026-09-30, retires 2026-11-30).
  'claude-sonnet-4-5-20250929': { provider: 'claude', maxOutputTokens: 64000, efforts: [], effortWire: null },
  // Source: https://developers.openai.com/api/docs/models/gpt-5 (128,000 max output
  // tokens; reasoning.effort minimal|low|medium|high; snapshot gpt-5-2025-08-07).
  'gpt-5': { provider: 'openai', maxOutputTokens: 128000, efforts: ['minimal', 'low', 'medium', 'high'],
    effortWire: 'reasoning.effort', observedSnapshots: ['gpt-5-2025-08-07'] },
  // Source: https://developers.openai.com/api/docs/models/gpt-5-mini (128,000 max
  // output tokens; reasoning.effort minimal|low|medium|high; snapshot gpt-5-mini-2025-08-07).
  'gpt-5-mini': { provider: 'openai', maxOutputTokens: 128000, efforts: ['minimal', 'low', 'medium', 'high'],
    effortWire: 'reasoning.effort', observedSnapshots: ['gpt-5-mini-2025-08-07'] },
});

function validateCapabilities(table) {
  if (!table || typeof table !== 'object' || Array.isArray(table)) throw new TypeError('model capability table must be an object');
  const out = {};
  for (const [id, entry] of Object.entries(table)) {
    if (!/^[a-z0-9][a-z0-9._-]{1,99}$/.test(id)) throw new TypeError(`invalid API model id ${id}`);
    if (!entry || typeof entry !== 'object') throw new TypeError(`invalid capability for ${id}`);
    const keys = Object.keys(entry);
    if (keys.some((k) => !['provider', 'maxOutputTokens', 'efforts', 'effortWire', 'observedSnapshots'].includes(k))) throw new TypeError(`unknown capability field for ${id}`);
    if (!PROVIDERS.includes(entry.provider)) throw new TypeError(`invalid provider for ${id}`);
    if (!Number.isSafeInteger(entry.maxOutputTokens) || entry.maxOutputTokens < 1) throw new TypeError(`invalid maxOutputTokens for ${id}`);
    if (!Array.isArray(entry.efforts) || entry.efforts.some((e) => typeof e !== 'string' || !/^[a-z]{1,16}$/.test(e))) throw new TypeError(`invalid efforts for ${id}`);
    const wire = entry.provider === 'openai' ? 'reasoning.effort' : 'output_config.effort';
    if (entry.efforts.length ? entry.effortWire !== wire : entry.effortWire !== null) throw new TypeError(`invalid effortWire for ${id}`);
    const snapshots = entry.observedSnapshots ?? [];
    if (!Array.isArray(snapshots) || snapshots.some((s) => typeof s !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,99}$/.test(s))) throw new TypeError(`invalid observedSnapshots for ${id}`);
    out[id] = Object.freeze({ provider: entry.provider, maxOutputTokens: entry.maxOutputTokens,
      efforts: Object.freeze([...entry.efforts]), effortWire: entry.effortWire, observedSnapshots: Object.freeze([...snapshots]) });
  }
  for (const provider of PROVIDERS) {
    if (!Object.values(out).some((e) => e.provider === provider)) throw new TypeError(`model capability table has no ${provider} entry`);
  }
  return Object.freeze(out);
}

// Exact lookup; never substitutes or translates an alias.
function resolveApiModel(provider, model, effort = null, table = API_MODEL_CAPABILITIES) {
  if (!PROVIDERS.includes(provider)) fail('api_model_unmapped', 'unknown API provider');
  if (typeof model !== 'string' || !Object.hasOwn(table, model) || table[model].provider !== provider) {
    fail('api_model_unmapped', 'The requested model is not a concrete API model ID with a code-owned capability entry.');
  }
  const capability = table[model];
  if (effort !== null && effort !== undefined && !capability.efforts.includes(effort)) {
    fail('api_effort_unsupported', 'The requested effort is not supported by this API model on this transport.');
  }
  return Object.freeze({ provider, apiModel: model, effort: effort ?? null, maxOutputTokens: capability.maxOutputTokens,
    effortWire: capability.effortWire, observedSnapshots: capability.observedSnapshots });
}

function modelMatches(resolved, observed) {
  return typeof observed === 'string' && (observed === resolved.apiModel || resolved.observedSnapshots.includes(observed));
}

// Responses strict mode requires every property in `required` and
// additionalProperties:false at every object level.
function assertStrictSchema(schema, where = 'schema') {
  if (!schema || typeof schema !== 'object') throw new TypeError(`${where} must be an object schema`);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('object')) {
    const props = Object.keys(schema.properties || {});
    if (schema.additionalProperties !== false) throw new TypeError(`${where} must set additionalProperties:false`);
    const required = schema.required || [];
    if (props.length !== required.length || props.some((p) => !required.includes(p))) throw new TypeError(`${where} must list every property as required`);
    for (const p of props) assertStrictSchema(schema.properties[p], `${where}.${p}`);
  }
  if (types.includes('array') && schema.items) assertStrictSchema(schema.items, `${where}[]`);
  return true;
}

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

const nonneg = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

// ---------------------------------------------------------------------------
// Claude Messages
// ---------------------------------------------------------------------------

const messages = Object.freeze({
  provider: 'claude',
  initialState({ prompt, system = null }) {
    if (typeof prompt !== 'string' || !prompt) throw new TypeError('prompt is required');
    return { system: system || null, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] };
  },
  headers(credential) {
    return { 'content-type': 'application/json', 'x-api-key': credential, 'anthropic-version': ANTHROPIC_VERSION };
  },
  buildRequest(state, model, toolDefs) {
    // Effort is the only reasoning control sent. No thinking, sampling
    // (temperature/top_p/top_k), forced tool_choice or assistant prefill:
    // current models keep adaptive thinking on and reject those overrides.
    return { model: model.apiModel, max_tokens: model.maxOutputTokens,
      ...(model.effort ? { output_config: { effort: model.effort } } : {}),
      ...(state.system ? { system: state.system } : {}), messages: state.messages,
      tools: toolDefs.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) };
  },
  parseResponse(json) {
    if (!json || typeof json !== 'object' || json.type !== 'message' || !Array.isArray(json.content)) {
      return { stop: 'provider_protocol_error', assistant: null, toolCalls: [], text: '', usage: null, observedModel: null, providerStopReason: null };
    }
    const text = json.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
    const toolUses = json.content.filter((b) => b?.type === 'tool_use');
    const u = json.usage || {};
    const usage = { input_tokens: nonneg(u.input_tokens), output_tokens: nonneg(u.output_tokens),
      cache_read_input_tokens: nonneg(u.cache_read_input_tokens), cache_creation_input_tokens: nonneg(u.cache_creation_input_tokens) };
    const reason = json.stop_reason;
    let stop;
    if (reason === 'end_turn' || reason === 'stop_sequence') stop = toolUses.length ? 'provider_protocol_error' : 'completed';
    else if (reason === 'tool_use') {
      stop = toolUses.length && toolUses.every((b) => typeof b.id === 'string' && b.id && typeof b.name === 'string'
        && b.input && typeof b.input === 'object' && !Array.isArray(b.input)) ? 'tool_calls' : 'provider_protocol_error';
    } else if (reason === 'max_tokens') stop = 'output_limit_reached';
    else if (reason === 'model_context_window_exceeded') stop = 'context_window_exceeded';
    else if (reason === 'refusal') stop = 'refusal';
    else if (reason === 'pause_turn') stop = 'pause_turn';
    else stop = 'provider_protocol_error';
    return { stop, providerStopReason: typeof reason === 'string' ? reason : null,
      // Assistant content (including thinking blocks and their signatures) is
      // replayed verbatim.
      assistant: { role: 'assistant', content: json.content },
      toolCalls: stop === 'tool_calls' ? toolUses.map((b) => ({ id: b.id, name: b.name, input: b.input })) : [],
      text, usage, observedModel: typeof json.model === 'string' ? json.model : null };
  },
  appendAssistant(state, assistant) {
    return { ...state, messages: [...state.messages, assistant] };
  },
  appendToolResults(state, results) {
    return { ...state, messages: [...state.messages, { role: 'user', content: results.map((r) => ({
      type: 'tool_result', tool_use_id: r.id, content: r.output, ...(r.isError ? { is_error: true } : {}) })) }] };
  },
});

// ---------------------------------------------------------------------------
// OpenAI Responses
// ---------------------------------------------------------------------------

const responses = Object.freeze({
  provider: 'openai',
  initialState({ prompt, system = null }) {
    if (typeof prompt !== 'string' || !prompt) throw new TypeError('prompt is required');
    return { instructions: system || null, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }] };
  },
  headers(credential, { organization = null, project = null } = {}) {
    return { 'content-type': 'application/json', authorization: `Bearer ${credential}`,
      ...(organization ? { 'openai-organization': organization } : {}), ...(project ? { 'openai-project': project } : {}) };
  },
  buildRequest(state, model, toolDefs) {
    for (const t of toolDefs) assertStrictSchema(t.inputSchema, t.name);
    return { model: model.apiModel, ...(state.instructions ? { instructions: state.instructions } : {}),
      input: state.input, max_output_tokens: model.maxOutputTokens,
      ...(model.effort ? { reasoning: { effort: model.effort } } : {}),
      tools: toolDefs.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: true })),
      store: false, include: ['reasoning.encrypted_content'] };
  },
  parseResponse(json) {
    if (!json || typeof json !== 'object' || json.object !== 'response' || !Array.isArray(json.output)) {
      return { stop: 'provider_protocol_error', assistant: null, toolCalls: [], text: '', usage: null, observedModel: null, providerStopReason: null };
    }
    const items = json.output;
    const messagesOut = items.filter((i) => i?.type === 'message');
    const parts = messagesOut.flatMap((m) => Array.isArray(m.content) ? m.content : []);
    const text = parts.filter((p) => p?.type === 'output_text' && typeof p.text === 'string').map((p) => p.text).join('');
    const refused = parts.some((p) => p?.type === 'refusal');
    const calls = items.filter((i) => i?.type === 'function_call');
    const u = json.usage || {};
    const usage = { input_tokens: nonneg(u.input_tokens), output_tokens: nonneg(u.output_tokens),
      cache_read_input_tokens: nonneg(u.input_tokens_details?.cached_tokens),
      reasoning_output_tokens: nonneg(u.output_tokens_details?.reasoning_tokens), total_tokens: nonneg(u.total_tokens) };
    let stop, toolCalls = [];
    const reason = json.status === 'incomplete' ? json.incomplete_details?.reason ?? null : json.status;
    if (json.status === 'incomplete') {
      // Never execute a function call from an incomplete response.
      stop = reason === 'max_output_tokens' ? 'output_limit_reached' : reason === 'content_filter' ? 'content_filter' : 'provider_protocol_error';
    } else if (json.status !== 'completed') stop = 'provider_protocol_error';
    else if (refused) stop = 'refusal';
    else if (calls.length) {
      try {
        toolCalls = calls.map((c) => {
          if (typeof c.call_id !== 'string' || !c.call_id || typeof c.name !== 'string' || typeof c.arguments !== 'string') throw new Error('bad call');
          const input = JSON.parse(c.arguments);
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('bad arguments');
          return { id: c.call_id, name: c.name, input };
        });
        stop = 'tool_calls';
      } catch { toolCalls = []; stop = 'provider_protocol_error'; }
    } else stop = 'completed';
    return { stop, providerStopReason: typeof reason === 'string' ? reason : null,
      // Reasoning items (with encrypted_content), messages and function calls
      // are replayed verbatim on the next turn.
      assistant: items, toolCalls, text, usage, observedModel: typeof json.model === 'string' ? json.model : null };
  },
  appendAssistant(state, assistant) {
    return { ...state, input: [...state.input, ...assistant] };
  },
  appendToolResults(state, results) {
    return { ...state, input: [...state.input, ...results.map((r) => ({ type: 'function_call_output', call_id: r.id, output: r.output }))] };
  },
});

const WIRES = Object.freeze({ claude: messages, openai: responses });

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

// Pinned literal provider texts (lowercased substring match, never a regex).
const ANTHROPIC_LOW_CREDIT_TEXT = 'credit balance is too low';
const ANTHROPIC_SPEND_LIMIT_TEXT = 'reached your specified api usage limits';

const ERROR_CLASSES = Object.freeze({
  funding_exhausted: Object.freeze({ resumable: false, releaseEligible: true }),
  funding_ambiguous: Object.freeze({ resumable: false, releaseEligible: false }),
  account_credit_low: Object.freeze({ resumable: false, releaseEligible: false }),
  spend_limit: Object.freeze({ resumable: false, releaseEligible: false }),
  rate_limited: Object.freeze({ resumable: true, releaseEligible: false }),
  provider_unavailable: Object.freeze({ resumable: true, releaseEligible: false }),
  auth: Object.freeze({ resumable: false, releaseEligible: false }),
  permission: Object.freeze({ resumable: false, releaseEligible: false }),
  provider_request_rejected: Object.freeze({ resumable: false, releaseEligible: false }),
});

// Table rows, evaluated in order. Exported so tests and docs pin the mapping.
const ERROR_CLASSIFICATION = Object.freeze([
  Object.freeze({ provider: 'openai', status: 429, code: 'credit_balance_exhausted', class: 'funding_exhausted' }),
  Object.freeze({ provider: 'openai', status: null, code: 'insufficient_quota', class: 'funding_ambiguous' }),
  Object.freeze({ provider: 'openai', status: 429, code: 'organization_spend_limit_exceeded', class: 'spend_limit' }),
  Object.freeze({ provider: 'openai', status: 429, code: 'project_spend_limit_exceeded', class: 'spend_limit' }),
  Object.freeze({ provider: 'claude', status: 429, detailsErrorCode: 'enforced_spend_limit_reached', class: 'spend_limit' }),
  Object.freeze({ provider: 'claude', status: 400, text: ANTHROPIC_LOW_CREDIT_TEXT, class: 'account_credit_low' }),
  Object.freeze({ provider: 'claude', status: 400, text: ANTHROPIC_SPEND_LIMIT_TEXT, class: 'spend_limit' }),
  Object.freeze({ provider: null, status: 429, class: 'rate_limited' }),
  Object.freeze({ provider: 'claude', status: null, type: 'overloaded_error', class: 'provider_unavailable' }),
  Object.freeze({ provider: null, status: 529, class: 'provider_unavailable' }),
  Object.freeze({ provider: null, status: '5xx', class: 'provider_unavailable' }),
  Object.freeze({ provider: null, status: 401, class: 'auth' }),
  Object.freeze({ provider: null, status: 403, class: 'permission' }),
]);

function classifyProviderError(provider, status, body) {
  const error = body && typeof body === 'object' ? body.error : null;
  const code = typeof error?.code === 'string' ? error.code : null;
  const type = typeof error?.type === 'string' ? error.type : null;
  const message = typeof error?.message === 'string' ? error.message : '';
  const detailsErrorCode = error?.details?.error_code ?? body?.details?.error_code ?? null;
  const row = ERROR_CLASSIFICATION.find((r) => (r.provider === null || r.provider === provider)
    && (r.status === null || r.status === status || (r.status === '5xx' && status >= 500 && status <= 599))
    && (r.code === undefined || r.code === code)
    && (r.type === undefined || r.type === type)
    && (r.detailsErrorCode === undefined || r.detailsErrorCode === detailsErrorCode)
    && (r.text === undefined || message.toLowerCase().includes(r.text)));
  const errorClass = row ? row.class : 'provider_request_rejected';
  return { errorClass, status, providerCode: code || (typeof detailsErrorCode === 'string' ? detailsErrorCode : null), providerType: type,
    ...ERROR_CLASSES[errorClass] };
}

module.exports = { ENDPOINTS, SURFACES, ANTHROPIC_VERSION, API_MODEL_CAPABILITIES, WIRES, ERROR_CLASSIFICATION, ERROR_CLASSES,
  validateCapabilities, resolveApiModel, modelMatches, assertStrictSchema, classifyProviderError, digest };
