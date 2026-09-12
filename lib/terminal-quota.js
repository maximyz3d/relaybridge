'use strict';
const crypto = require('node:crypto');
const { parseGeminiQuotaExhaustion, parseGrokQuota429, normalizeQualitativeQuotaExhaustion } = require('./vendor-quota');
const quotaWords = /individual quota reached|monthly quota|hit your usage limit|subscription:free-usage-exhausted|included free usage/i;

// A terminal transcript is weak evidence. Accept only a complete standalone
// native diagnostic at unsuccessful process exit; never mine arbitrary output
// tails, quoted examples, login/shell output, or supervisor cancellations.
function createTerminalQuotaObserver(provider) {
  let transcript = '', overflow = false, inputMentionsQuota = false;
  return {
    output(chunk) {
      if (overflow) return;
      transcript += String(chunk);
      if (transcript.length > 4096) { transcript = ''; overflow = true; }
    },
    input(text) { if (quotaWords.test(String(text))) inputMentionsQuota = true; },
    finish(exitCode, stopReason = null) {
      if (overflow || inputMentionsQuota || !Number.isInteger(exitCode) || exitCode === 0 || stopReason) return null;
      if (provider === 'gemini') return parseGeminiQuotaExhaustion({ provider, stdout: transcript, exitCode, stopReason });
      const text = transcript.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r\n/g, '\n').trim();
      if (provider === 'grok') {
        // Native error record, not a phrase extracted from surrounding prose.
        if (!/^\d{4}-\d\d-\d\dT[0-9:.]+Z ERROR responses API error status=429 Too Many Requests\nerror_message=subscription:free-usage-exhausted:/.test(text)) return null;
        return parseGrokQuota429({ provider, rateLimited: true, text });
      }
      const source = provider === 'copilot' && /^You have exceeded your monthly quota(?:\s+\(Request ID:\s*[A-F0-9:]{3,160}\))?$/i.test(text)
        ? 'copilot_monthly_quota' : provider === 'cursor'
          && /^ActionRequiredError: You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more\.$/.test(text)
          ? 'cursor_agent_usage_limit' : null;
      if (!source) return null;
      const observedAt = Date.now(), durationMs = 300000;
      return normalizeQualitativeQuotaExhaustion({ kind: 'quota_exhausted', provider, model: null, scope: 'account',
        unit: null, actual: null, limit: null, remaining: null, percentRemaining: null, overLimit: null,
        source, diagnosticSource: 'stdout', observedAt: new Date(observedAt).toISOString(),
        reset: { kind: 'conservative_expiry', durationMs, expiresAt: new Date(observedAt + durationMs).toISOString() },
        evidenceHash: crypto.createHash('sha256').update(source).digest('hex') });
    },
  };
}
module.exports = { createTerminalQuotaObserver };
