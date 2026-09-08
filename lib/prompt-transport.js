'use strict';

const crypto = require('node:crypto');
const { validationError: promptError } = require('./validation-contract');

const TRANSPORTS = new Set(['argument', 'file', 'stdin', 'hosted_openai_compatible', 'local_http']);
const DEFAULT_LIMITS = Object.freeze({ argument: 6000, file: null, stdin: null,
  hosted_openai_compatible: 12000, local_http: 24000 });
const MAX_POLICY_CHARS = 4096;

// Limits are UTF-16 code units, matching the established CLI allowance and
// Windows argument-size accounting. File/stdin are not subject to argv caps;
// the request surface still applies its separate finite envelope size.
function promptTransportLimits(entry = {}, slot = []) {
  let transport;
  if (entry.oneshot_adapter === 'openai_chat_api') transport = 'hosted_openai_compatible';
  else if (entry.oneshot_adapter === 'ollama_api') transport = 'local_http';
  else {
    const inline = slot.some((arg) => typeof arg === 'string' && arg.includes('{prompt}'));
    const file = slot.some((arg) => typeof arg === 'string' && arg.includes('{prompt_file}'));
    if (inline && file) throw promptError('invalid_prompt_transport', 'provider', 'provider cannot mix argument and file prompt placeholders');
    transport = file ? 'file' : inline ? 'argument' : 'stdin';
  }
  let maxChars = DEFAULT_LIMITS[transport];
  let effectiveMaxChars = null;
  if (maxChars !== null && entry.prompt_max_chars !== undefined && entry.prompt_max_chars !== null) {
    maxChars = entry.prompt_max_chars;
    if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 1024 * 1024) {
      throw promptError('invalid_prompt_limit', 'provider', 'provider prompt limit must be a positive safe integer of at most 1048576 characters');
    }
  }
  // Wrappers can read stdin yet hand the same text to a downstream argv-only
  // executable. This is a declared semantic limit, distinct from the bridge's
  // immediate argv cap; it applies before starting the wrapper itself.
  if (entry.prompt_input_max_chars !== undefined && entry.prompt_input_max_chars !== null) {
    const semanticMax = entry.prompt_input_max_chars;
    if (!Number.isSafeInteger(semanticMax) || semanticMax < 1 || semanticMax > 1024 * 1024) {
      throw promptError('invalid_prompt_limit', 'provider', 'provider semantic input limit must be a positive safe integer of at most 1048576 characters');
    }
    maxChars = maxChars === null ? semanticMax : Math.min(maxChars, semanticMax);
    effectiveMaxChars = semanticMax;
  }
  return { transport, maxChars, effectiveMaxChars, units: 'utf16_code_units', policyMaxChars: MAX_POLICY_CHARS, truncationAllowed: false };
}

function promptHash(value) { return crypto.createHash('sha256').update(value, 'utf8').digest('hex'); }

// Nothing in this module clips semantic input. It returns the exact transport
// text or throws a zero-invocation preflight diagnostic containing only
// hashes/counts. The safety prefix has its own bounded allowance and cannot
// consume the tail of the user's existing prompt allowance.
function preparePrompt(prompt, { transport, maxChars, effectiveMaxChars = null, policyPrefix = '' } = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw promptError('invalid_prompt', 'prompt', 'prompt must be a non-empty string');
  }
  if (!TRANSPORTS.has(transport)) throw promptError('invalid_prompt_transport', 'provider', 'unknown provider prompt transport');
  if (maxChars !== null && (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 1024 * 1024)) {
    throw promptError('invalid_prompt_limit', 'provider', 'invalid provider prompt limit');
  }
  if (typeof policyPrefix !== 'string' || policyPrefix.length > MAX_POLICY_CHARS) {
    throw promptError('invalid_prompt_policy', 'provider', 'provider safety prefix must be a string of at most 4096 characters');
  }
  const originalHash = promptHash(prompt);
  if (maxChars !== null && prompt.length > maxChars) {
    throw promptError('prompt_too_large', 'prompt', 'prompt exceeds this provider transport limit; shorten it or choose a full-input transport', {
      inputChars: prompt.length, inputHash: originalHash, maxChars, transport,
      units: 'utf16_code_units', inputTruncated: false,
    });
  }
  const text = policyPrefix ? `${policyPrefix}\n\nUser request:\n${prompt}` : prompt;
  if (effectiveMaxChars !== null) {
    if (!Number.isSafeInteger(effectiveMaxChars) || effectiveMaxChars < 1 || effectiveMaxChars > 1024 * 1024) {
      throw promptError('invalid_prompt_limit', 'provider', 'invalid downstream semantic prompt limit');
    }
    if (text.length > effectiveMaxChars) {
      throw promptError('prompt_too_large', 'prompt', 'complete prompt and policy exceed the downstream provider input limit', {
        inputChars: prompt.length, inputHash: originalHash, effectiveChars: text.length,
        maxChars: effectiveMaxChars, transport, units: 'utf16_code_units', inputTruncated: false,
      });
    }
  }
  return {
    text,
    evidence: { originalChars: prompt.length, effectiveChars: text.length,
      originalHash, effectiveHash: promptHash(text), transport, maxChars, effectiveMaxChars,
      units: 'utf16_code_units', policyChars: policyPrefix.length, truncated: false },
  };
}

function renderPromptSlot(slot, { prompt, prompt_file, cwd }) {
  const replacements = { prompt, prompt_file, cwd };
  // Replacement callbacks return literal bytes. Chained replacements rescan
  // user text; replacement strings also interpret $&, $$, $` and $'.
  return slot.map((arg) => typeof arg === 'string'
    ? arg.replace(/\{(prompt_file|prompt|cwd)\}/g, (_, name) => replacements[name]) : arg);
}

module.exports = { DEFAULT_LIMITS, MAX_POLICY_CHARS, promptTransportLimits, preparePrompt, renderPromptSlot };
