'use strict';
const crypto = require('node:crypto');
const { normalizePerplexityState } = require('./perplexity-diagnostics');
const ANSWER_MARKER = 'RELAYBRIDGE_ANSWER_OK';
const ANSWER_PROMPT = `Reply with exactly ${ANSWER_MARKER} and no other text.`;

function answerHealth(payload, { provider, model, accountId, quotaSeat, now = Date.now() }) {
  const text = String(payload.stdout || '').trim();
  const invoked = payload.model_invocation;
  const failed = payload.failureClass || payload.cancelled || payload.dropped_out || payload.partial_result || payload.exitCode !== 0;
  const ready = invoked === true && !failed && text === ANSWER_MARKER;
  const providerState = provider === 'perplexity' ? normalizePerplexityState(payload.provider_state) : null;
  const diagnosticCode = invoked === false ? payload.failureClass || 'probe_not_run'
    : ready ? null : providerState && providerState.diagnosticCode !== 'ready' ? providerState.diagnosticCode
      : payload.failureClass || (text ? 'probe_answer_mismatch' : 'empty_answer_unknown_cause');
  return { status: invoked === false ? 'not_run' : ready ? 'ready' : 'incomplete', diagnosticCode,
    checkedAt: now, expiresAt: now + 300000, freshness: 'current', provider, model, accountId, quotaSeat,
    receiptId: payload.receiptId || null, requestId: payload.requestId || null, invocationId: payload.invocationId || null,
    bindingStrength: 'profile_process', authenticationVerified: false, quotaVerified: false,
    providerState, alternativeRecommended: !ready && invoked !== false,
    bridgeRetries: 0, outputChars: text.length, outputHash: crypto.createHash('sha256').update(text).digest('hex') };
}
module.exports = { ANSWER_PROMPT, answerHealth };
