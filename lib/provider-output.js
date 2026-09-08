'use strict';
const { redactCheckpointSecrets } = require('./partial-checkpoint');
const MAX_JSON_CHARS = 256000;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim() ? value : null;
function document(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_JSON_CHARS) throw new Error('Missing or oversized provider JSON document.');
  const value = JSON.parse(raw);
  if (!object(value)) throw new Error('Provider JSON must contain one object.');
  return value;
}
function diagnostic(value) {
  const cleaned = redactCheckpointSecrets(value, MAX_JSON_CHARS * 4);
  return { text:cleaned.slice(0, 4000), truncated:cleaned.length > 4000 };
}
function baseline() {
  // Native CLI telemetry has not been qualified as provider billing or observed
  // model evidence. In particular Gemini may replace missing counters with zero.
  return { output:'', usage:null, isError:false, resultSubtype:null, failureClass:null,
    diagnostic:'', errorCount:0, errorObserved:0, errorInvalid:0, errorDiagnosticTruncated:false,
    providerStopReason:null, terminalReason:null, apiErrorStatus:null, numTurns:null,
    providerDurationMs:null, providerApiDurationMs:null, resultSchemaDisagreement:false,
    partialDiagnostic:'', partialDiagnosticTruncated:false, parseError:null, diagnosticIsProviderError:false };
}
function failed(base, reason, failureClass = 'provider_error') {
  const safe = diagnostic(reason);
  return { ...base, output:'', isError:true, failureClass, terminalReason:null, diagnostic:safe.text,
    errorCount:1, errorObserved:1, errorDiagnosticTruncated:safe.truncated };
}

// These grammars are distinct from Claude JSON. They never select a last line,
// salvage a partial object or promote stderr into successful answer content.
function parseNativeProviderOutput(parser, rawOutput, { stderr = '', exitCode = null, ignoreTerminalResult = false } = {}) {
  const base = baseline();
  try {
    if (!['grok_json','gemini_cli_json'].includes(parser)) throw new Error('Unknown native provider parser.');
    let value;
    if (parser === 'gemini_cli_json' && !String(rawOutput || '').trim()) {
      value = document(stderr);
      if (!object(value.error)) throw new Error('Gemini stderr is diagnostic-only, never answer output.');
    } else value = document(rawOutput);
    if (parser === 'grok_json') {
      if (value.type === 'error') {
        if (!text(value.message)) throw new Error('Grok error is missing its message.');
        // Actual native 1.0.13 signed-out document. Do not match quoted answer
        // text or auxiliary MCP warnings as account authority.
        const authoritative = !ignoreTerminalResult && Number.isInteger(exitCode) && exitCode !== 0;
        const auth = authoritative && exitCode === 1 && value.message.startsWith('Not signed in. To authenticate without a browser, run:\n')
          && value.message.includes('grok login --device-code');
        return { ...failed(base, value.message, auth ? 'auth' : 'provider_error'), diagnosticIsProviderError:authoritative };
      }
      if ('error' in value || 'type' in value || value.is_error === true) return failed(base, 'Grok returned contradictory error evidence.');
      if (!text(value.text) || !text(value.sessionId) || value.sessionId.length > 200
        || !text(value.requestId) || value.requestId.length > 200 || !text(value.stopReason) || value.stopReason.length > 80) throw new Error('Incomplete Grok result envelope.');
      base.providerStopReason = value.stopReason;
      if (value.stopReason !== 'end_turn') return failed(base, 'Grok stopped without a complete end_turn result.', 'incomplete_response');
      base.terminalReason = 'completed';
      base.output = value.text;
    } else {
      if ('error' in value) {
        if (!object(value.error) || !text(value.error.type) || value.error.type.length > 100 || !text(value.error.message)
          || value.error.code !== undefined && !(Number.isSafeInteger(value.error.code) && value.error.code >= 0
            || typeof value.error.code === 'string' && value.error.code.length <= 120)) throw new Error('Malformed Gemini error envelope.');
        const authoritative = !ignoreTerminalResult && Number.isInteger(exitCode) && exitCode !== 0;
        const auth = authoritative && exitCode === 41 && value.error.code === 41 && ['Error','FatalAuthenticationError'].includes(value.error.type);
        return { ...failed(base, value.error.message, auth ? 'auth'
          : value.error.type === 'INVALID_STREAM' ? 'incomplete_response' : 'provider_error'), diagnosticIsProviderError:authoritative };
      }
      if (!text(value.response)) throw new Error('Gemini returned no answer text.');
      if (value.warnings !== undefined && (!Array.isArray(value.warnings) || value.warnings.length > 64
        || value.warnings.some(warning => typeof warning !== 'string' || warning.length > 4000))) throw new Error('Malformed Gemini warnings.');
      // Gemini JSON has no terminal stop reason. A warning can report an early
      // stop despite exit zero; until warning variants are qualified, retain
      // uncertainty instead of asserting that the requested artifact completed.
      if (value.warnings?.some(warning => warning.trim())) return failed(base, value.warnings.join('\n'), 'incomplete_response');
      base.output = value.response;
      // Deliberately keep terminalReason/resultSubtype null: the CLI can emit
      // error-free JSON after STOP_EXECUTION. Artifact review remains necessary.
    }
    if (ignoreTerminalResult || exitCode !== 0) return failed(base, 'Provider output cannot establish completion after a stop or unsuccessful process exit.', 'incomplete_response');
    return base;
  } catch {
    return { ...failed(base, 'Provider returned missing, malformed or unsupported JSON.', 'incomplete_response'),
      parseError:'Provider JSON framing or required fields could not be verified.' };
  }
}
module.exports = { MAX_JSON_CHARS, parseNativeProviderOutput };
