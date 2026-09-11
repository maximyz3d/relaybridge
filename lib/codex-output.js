'use strict';
const crypto = require('node:crypto');
const { redactCheckpointSecrets } = require('./partial-checkpoint');
function parseCodexOutput(raw, { ignoreTerminalResult = false, exitCode = null } = {}) {
  let text = '', terminal = null, malformed = false, failed = false, usage = null, diagnostic = '';
  const messages = new Map();
  for (const line of String(raw || '').split(/\r?\n/).filter((s) => s.trim())) {
    let event; try { event = JSON.parse(line); } catch { malformed = true; continue; }
    if (!event || typeof event !== 'object' || Array.isArray(event)) { malformed = true; continue; }
    if (event.type === 'turn.started') { terminal = null; text = ''; usage = null; messages.clear(); }
    if (terminal && ['item.started', 'item.updated', 'item.completed', 'error'].includes(event.type)) { terminal = null; malformed = true; }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      const id = event.item.id;
      if (typeof id === 'string' && messages.has(id) && messages.get(id) !== event.item.text) { malformed = true; text = ''; }
      else { if (typeof id === 'string') messages.set(id, event.item.text); text = redactCheckpointSecrets(event.item.text, 200000); }
      terminal = null;
    }
    if (['turn.failed', 'error'].includes(event.type)) {
      failed = true; terminal = null;
      const message = event.type === 'turn.failed' ? event.error?.message : event.message;
      if (typeof message === 'string') diagnostic = redactCheckpointSecrets(message, 2000);
    }
    if (event.type === 'turn.completed') {
      terminal = event;
      const u = event.usage;
      if (u && ['input_tokens', 'output_tokens'].every((key) => Number.isSafeInteger(u[key]) && u[key] >= 0)
        && ['cached_input_tokens', 'reasoning_output_tokens'].every((key) => u[key] == null || Number.isSafeInteger(u[key]) && u[key] >= 0)
        && Number.isSafeInteger(u.input_tokens + u.output_tokens)) {
        usage = { input_tokens: u.input_tokens, output_tokens: u.output_tokens,
          total_tokens: u.input_tokens + u.output_tokens, cache_read_input_tokens: u.cached_input_tokens ?? 0,
          cache_input_included: true, thinking_tokens: u.reasoning_output_tokens ?? null, token_source: 'provider_reported' };
      }
    }
  }
  const complete = !!terminal && !malformed && !failed && exitCode !== null && exitCode === 0 && !ignoreTerminalResult;
  const checkpoint = { text, bytes: Buffer.byteLength(text), originalBytes: Buffer.byteLength(text), truncated: false,
    sha256: crypto.createHash('sha256').update(text).digest('hex'), eventType: 'agent_message', messageIdHash: null };
  return { output: complete ? text : '', usage, isError: !complete,
    failureClass: complete ? null : failed ? 'provider_error' : 'no_verdict',
    terminalReason: complete ? 'completed' : null, providerStopReason: complete ? 'completed' : null,
    parseError: complete ? null : 'Codex did not return a complete accepted terminal result.',
    diagnostic, diagnosticIsProviderError: !!diagnostic, numTurns: null,
    partialCheckpoint: checkpoint, partialDiagnostic: text, partialDiagnosticTruncated: false };
}
module.exports = { parseCodexOutput };
