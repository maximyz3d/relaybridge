'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseGrokQuota429, MAX_QUOTA_VALUE,
} = require('../lib/vendor-quota');

const observedAt = '2026-08-24T04:20:31.357Z';
const realDiagnostic = `
2026-08-24T04:20:30Z ERROR responses API error status=429 Too Many Requests
error_message=subscription:free-usage-exhausted: You've used all the included free usage for model grok-4.6 for now.
Usage resets over a rolling 24-hour window — tokens (actual/limit): 552,305/500,000.
Upgrade to a Grok subscription for higher limits: https://grok.com/supergrok model_id=grok-4.6`;

test('recognized Grok 429 becomes bounded model-scoped rolling-window evidence', () => {
  const observation = parseGrokQuota429({
    provider: 'grok', rateLimited: true, text: realDiagnostic,
    model: 'grok-4.6', observedAt,
  });
  assert.deepEqual({
    provider: observation.provider,
    model: observation.model,
    unit: observation.unit,
    actual: observation.actual,
    limit: observation.limit,
    remaining: observation.remaining,
    percentRemaining: observation.percentRemaining,
    overLimit: observation.overLimit,
    source: observation.source,
  }, {
    provider: 'grok', model: 'grok-4.6', unit: 'tokens',
    actual: 552305, limit: 500000, remaining: 0, percentRemaining: 0,
    overLimit: true, source: 'grok_429_subscription_free_usage_exhausted',
  });
  assert.equal(observation.window.kind, 'rolling');
  assert.equal(observation.window.durationMs, 86400000);
  assert.equal(observation.reset.kind, 'conservative_expiry');
  assert.equal(observation.reset.expiresAt, '2026-08-25T04:20:31.357Z');
  assert.match(observation.evidenceHash, /^[0-9a-f]{64}$/);
});

test('model scope selects matching evidence when Grok reports several models', () => {
  const other = realDiagnostic.replaceAll('grok-4.6', 'grok-4.5').replace('552,305', '544,314');
  const observation = parseGrokQuota429({
    provider: 'grok', failureClass: 'rate_limit', text: `${other}\n${realDiagnostic}`,
    model: 'grok-4.6', observedAt,
  });
  assert.equal(observation.model, 'grok-4.6');
  assert.equal(observation.actual, 552305);
  assert.equal(parseGrokQuota429({
    provider: 'grok', rateLimited: true, text: realDiagnostic,
    model: 'grok-4.7', observedAt,
  }), null);
});

test('arbitrary, malformed and hostile numbers are never promoted to quota', () => {
  const cases = [
    { provider: 'claude', rateLimited: true, text: realDiagnostic },
    { provider: 'grok', rateLimited: false, failureClass: 'provider_error', text: realDiagnostic },
    { provider: 'grok', rateLimited: true, text: '429: usage 552305 of 500000' },
    { provider: 'grok', rateLimited: true, text: realDiagnostic.replace('status=429', 'status=500') },
    { provider: 'grok', rateLimited: true, text: realDiagnostic.replace('subscription:free-usage-exhausted', 'some-other-error') },
    { provider: 'grok', rateLimited: true, text: realDiagnostic.replace('24-hour', '999-hour') },
    { provider: 'grok', rateLimited: true, text: realDiagnostic.replace('552,305', String(MAX_QUOTA_VALUE + 1)) },
    { provider: 'grok', rateLimited: true, text: realDiagnostic.replace('552,305', '9,999,999') },
    { provider: 'grok', rateLimited: true, text: realDiagnostic.replace('500,000', '0') },
    { provider: 'grok', rateLimited: true, text: realDiagnostic.replace('552,305', '55e4') },
  ];
  for (const fixture of cases) {
    assert.equal(parseGrokQuota429({ ...fixture, model: 'grok-4.6', observedAt }), null, fixture.text);
  }
});
