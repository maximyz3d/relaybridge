'use strict';

// Loopback fake for the Claude Messages and OpenAI Responses APIs. The
// injected fetch asserts that the runner targets the fixed production
// endpoint with redirect:'error', then forwards the request to a local
// node:http server. Nothing here reaches the network.

const http = require('node:http');
const assert = require('node:assert/strict');
const { ENDPOINTS } = require('../../lib/api-agent-wire');

async function startFakeProvider(t, { provider, respond }) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const record = { headers: req.headers, body: JSON.parse(text), index: requests.length + 1 };
      requests.push(record);
      let action;
      try { action = await respond(record, requests); } catch (error) { action = { status: 500, json: { error: { message: String(error.message) } } }; }
      if (!action || action.destroy) { req.socket.destroy(); return; }
      if (action.hang) return; // never answer; the caller must abort
      res.writeHead(action.status || 200, { 'content-type': 'application/json' });
      res.end(action.raw !== undefined ? action.raw : JSON.stringify(action.json));
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }));
  const fetchImpl = async (url, init) => {
    assert.equal(url, ENDPOINTS[provider]);
    assert.equal(init.redirect, 'error');
    assert.equal(init.method, 'POST');
    return fetch(`http://127.0.0.1:${port}/`, { ...init, redirect: 'error' });
  };
  return { requests, fetchImpl, port };
}

// ---- response builders ---------------------------------------------------

const claudeUsage = (n = 1) => ({ input_tokens: 100 * n, output_tokens: 10 * n, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 });

function claudeMessage({ model = 'claude-opus-5-5', text = null, tools = [], stop = null, thinking = false, usage = claudeUsage() } = {}) {
  const content = [];
  if (thinking) content.push({ type: 'thinking', thinking: 'considering', signature: 'sig-opaque-1' });
  if (text !== null) content.push({ type: 'text', text });
  for (const [i, call] of tools.entries()) content.push({ type: 'tool_use', id: call.id || `toolu_${i}_${Math.random().toString(16).slice(2, 8)}`, name: call.name, input: call.input });
  return { id: 'msg_fake', type: 'message', role: 'assistant', model, content,
    stop_reason: stop || (tools.length ? 'tool_use' : 'end_turn'), stop_sequence: null, usage };
}

const openaiUsage = (n = 1) => ({ input_tokens: 100 * n, input_tokens_details: { cached_tokens: 5 }, output_tokens: 10 * n,
  output_tokens_details: { reasoning_tokens: 3 }, total_tokens: 110 * n });

function openaiResponse({ model = 'gpt-6.1-sol', text = null, tools = [], status = 'completed', incomplete = null,
  reasoning = false, refusal = false, usage = openaiUsage() } = {}) {
  const output = [];
  if (reasoning) output.push({ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-opaque-1' });
  if (text !== null || refusal) output.push({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
    content: refusal ? [{ type: 'refusal', refusal: 'no' }] : [{ type: 'output_text', text, annotations: [] }] });
  for (const [i, call] of tools.entries()) output.push({ type: 'function_call', id: `fc_${i}`, call_id: call.id || `call_${i}_${Math.random().toString(16).slice(2, 8)}`,
    name: call.name, arguments: typeof call.input === 'string' ? call.input : JSON.stringify(call.input), status: 'completed' });
  return { id: 'resp_fake', object: 'response', status, model, output, usage,
    ...(incomplete ? { incomplete_details: { reason: incomplete } } : {}) };
}

// Provider-neutral builder used by tests that cover both wires.
function reply(provider, spec) {
  if (provider === 'claude') {
    return claudeMessage({ ...spec, ...(spec.limit ? { stop: 'max_tokens' } : {}) });
  }
  return openaiResponse({ ...spec, ...(spec.limit ? { status: 'incomplete', incomplete: 'max_output_tokens' } : {}) });
}

module.exports = { startFakeProvider, claudeMessage, openaiResponse, claudeUsage, openaiUsage, reply };
