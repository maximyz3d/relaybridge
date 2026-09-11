'use strict';

const PREFIX = 'RELAYBRIDGE_PERPLEXITY_STATE=';
const CODES = new Set(['ready', 'upstream_empty_answer', 'authentication_failed', 'rate_limited',
  'unsupported_request', 'provider_protocol_error', 'provider_failure_unknown', 'not_run']);
function providerVersion(text) {
  const value = String(text || '');
  if (value.length > 8192) return null;
  return value.match(/\b(?:pwm|perplexity-web-mcp(?:-cli)?)[,\s]+(?:version\s+)?v?(\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][A-Za-z0-9.-]{1,32})?)\b/i)?.[1] || null;
}
function classifyAnswer({ stdout = '', stderr = '', exitCode } = {}) {
  const text = String(stdout).trim(), diagnostic = String(stderr).trim();
  if (text.length + diagnostic.length > 16384) return 'provider_failure_unknown';
  if (exitCode === 0 && /^No answer received\.?$/i.test(text)) return 'upstream_empty_answer';
  if (/^(?:ResponseParsingError\b|Error\s*\(ResponseParsingError\)|Failed to parse API response)/i.test(text)
    || /^(?:ResponseParsingError\b|Error\s*\(ResponseParsingError\)|Failed to parse API response)/i.test(diagnostic)) return 'provider_protocol_error';
  if (exitCode !== 0) {
    if (/^(?:Error:\s*)?(?:AuthenticationError\b|Not authenticated\b|Authentication failed\b)/i.test(diagnostic)) return 'authentication_failed';
    if (/^(?:Error:\s*)?(?:RateLimitError\b|Rate limit exceeded\b)/i.test(diagnostic)) return 'rate_limited';
    if (/^(?:Error:\s*)?(?:Unknown|Invalid|Unsupported) (?:model|source)\b/i.test(diagnostic)) return 'unsupported_request';
    return 'provider_failure_unknown';
  }
  return text ? 'ready' : 'upstream_empty_answer';
}
function normalizePerplexityState(value) {
  if (!value || value.schema !== 1 || value.backend !== 'pwm_subscription' || !CODES.has(value.diagnosticCode)
    || value.version !== null && (typeof value.version !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][A-Za-z0-9.-]{1,32})?$/.test(value.version))) return null;
  return { schema: 1, backend: 'pwm_subscription', version: value.version, diagnosticCode: value.diagnosticCode,
    source: 'wrapper_diagnostic', authenticationVerified: false, rootCauseVerified: false };
}
function readPerplexityState(stderr) {
  let found = null;
  for (const line of String(stderr || '').split(/\r?\n/)) {
    if (!line.startsWith(PREFIX) || line.length > 1024) continue;
    try { found = normalizePerplexityState(JSON.parse(line.slice(PREFIX.length))); } catch { return null; }
  }
  return found;
}
module.exports = { PREFIX, providerVersion, classifyAnswer, normalizePerplexityState, readPerplexityState };
