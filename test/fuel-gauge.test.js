'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFuelGauge, DISCLAIMER, SCOPE } = require('../lib/fuel-gauge');

const NOW = Date.parse('2026-09-07T12:00:00.000Z');

function gauge(overrides = {}) {
  return buildFuelGauge({
    now: NOW,
    windowMs: 3600000,
    queueStats: { queued: 4, active: 2, maxConcurrent: 3 },
    activeByProvider: new Map([['claude', 1], ['codex', 1], ['gemini', 0]]),
    concurrency: { maxActiveOneShots: 4, maxActivePerProvider: 1 },
    gauges: {},
    providerUsageCapabilities: {},
    ...overrides,
  });
}

test('the gauge reports queue depth, live runs, and configured concurrency', () => {
  const view = gauge();
  assert.equal(view.generatedAt, '2026-09-07T12:00:00.000Z');
  assert.equal(view.scope, SCOPE);
  assert.equal(view.windowMs, 3600000);
  assert.deepEqual(view.queue, {
    depth: 4, active: 2, maxConcurrent: 3, saturated: false, source: 'task_queue',
  });
  // A provider with zero live runs is not listed as "at limit" by accident.
  assert.deepEqual(view.localRuns.byProvider, { claude: 1, codex: 1 });
  assert.equal(view.localRuns.total, 2);
  assert.equal(view.localRuns.maxActiveOneShots, 4);
  assert.equal(view.localRuns.maxActivePerProvider, 1);
  assert.equal(view.localRuns.atFleetLimit, false);
  assert.deepEqual(view.localRuns.providersAtLimit.sort(), ['claude', 'codex']);
  assert.equal(view.localRuns.source, 'admission_control');
});

test('saturation is flagged separately from depth', () => {
  const busy = gauge({ queueStats: { queued: 9, active: 3, maxConcurrent: 3 } });
  assert.equal(busy.queue.saturated, true);
  const full = gauge({ activeByProvider: { claude: 2, codex: 2 }, concurrency: { maxActiveOneShots: 4, maxActivePerProvider: 2 } });
  assert.equal(full.localRuns.atFleetLimit, true);
});

test('the gauge never claims account-wide real-time quota', () => {
  const view = gauge();
  assert.equal(view.claims.accountWideRealTimeQuota, false);
  assert.equal(view.unknown.accountWideQuota, 'unknown');
  assert.equal(view.unknown.usageOutsideThisBridge, 'unknown');
  assert.equal(view.unknown.concurrentSessionsElsewhere, 'unknown');
  assert.equal(view.disclaimer, DISCLAIMER);
  assert.match(view.disclaimer, /does not have account-wide real-time quota/);
  // Nothing anywhere in the payload offers a remaining-percentage for the
  // account itself.
  assert.equal(JSON.stringify(view).includes('percentRemaining'), false);
});

test('token usage is reported only where the provider reports it authoritatively', () => {
  const view = gauge({
    gauges: {
      codex: {
        aliases: ['codex'],
        basis: 'metered',
        costClass: 'metered',
        used: { inputTokens: 1200, outputTokens: 800, totalTokens: 2000, runs: 3, failed: 1 },
      },
      claude: {
        aliases: ['claude'],
        basis: 'subscription',
        used: { inputTokens: 0, outputTokens: 0, totalTokens: 0, runs: 5 },
      },
    },
    providerUsageCapabilities: {
      codex: { tokens: 'authoritative', turns: 'authoritative' },
      claude: { tokens: 'unavailable', turns: 'unavailable' },
    },
  });

  assert.equal(view.providerUsage.codex.source, 'provider_reported');
  assert.deepEqual(view.providerUsage.codex.tokens, { input: 1200, output: 800, total: 2000 });
  assert.equal(view.providerUsage.codex.runs, 3);
  assert.equal(view.providerUsage.codex.failed, 1);
  assert.equal(view.providerUsage.codex.basis, 'metered');

  // The seat with 5 runs and no authoritative meter reports null, not zero and
  // not an estimate derived from output size.
  assert.equal(view.providerUsage.claude.source, 'unavailable');
  assert.equal(view.providerUsage.claude.tokens, null);
  assert.match(view.providerUsage.claude.note, /character estimates are deliberately not substituted/);
  assert.deepEqual(view.unknown.providersWithoutAuthoritativeUsage, ['claude']);
  assert.equal(view.usageUnavailable.length, 1);
  assert.equal(view.usageUnavailable[0].tokens, 'unavailable');
  assert.equal(view.usageUnavailable[0].budgetEnforcement, 'unenforceable');
});

test('a seat with no capability entry at all is unavailable, not assumed available', () => {
  const view = gauge({
    gauges: { mystery: { used: { totalTokens: 999 } } },
    providerUsageCapabilities: {},
  });
  assert.equal(view.providerUsage.mystery.source, 'unavailable');
  assert.equal(view.usageUnavailable[0].tokens, 'unknown');
});

test('vendor quota, operator readings, and cooldowns surface as distinct signals', () => {
  const view = gauge({
    gauges: {
      codex: {
        vendorQuota: {
          model: 'gpt-5', unit: 'tokens', actual: 100, limit: 100,
          reset: { expiresAt: '2026-09-07T13:00:00.000Z', note: 'resets hourly' },
        },
      },
      claude: {
        operatorQuota: {
          provenance: 'operator_entered', percentRemaining: 40,
          observedAt: '2026-09-07T11:00:00.000Z', expiresAt: '2026-09-07T17:00:00.000Z',
        },
      },
    },
    cooldowns: [{ seat: 'codex', reason: 'rate_limited', remainingSec: 120 }],
  });

  const kinds = view.vendorSignals.map((signal) => signal.kind).sort();
  assert.deepEqual(kinds, ['operator_reported_quota', 'rate_limited', 'vendor_quota_exhausted']);

  const vendor = view.vendorSignals.find((s) => s.kind === 'vendor_quota_exhausted');
  assert.equal(vendor.source, 'vendor_observed');
  assert.equal(vendor.expiresAt, '2026-09-07T13:00:00.000Z');

  const operator = view.vendorSignals.find((s) => s.kind === 'operator_reported_quota');
  assert.equal(operator.source, 'operator_observed');
  assert.match(operator.note, /not a live meter/);

  const cooldown = view.vendorSignals.find((s) => s.kind === 'rate_limited');
  assert.equal(cooldown.seat, 'codex');
  assert.equal(cooldown.remainingSec, 120);
});

test('nothing is inferred when the providers volunteered nothing', () => {
  assert.deepEqual(gauge().vendorSignals, []);
  assert.deepEqual(gauge().providerUsage, {});
});

test('delegation and incident backlogs are folded in when present', () => {
  const view = gauge({
    delegations: { queued: 2, running: 1, awaitingEscalation: 1, settled: 7 },
    incidents: { open: 3, occurrencesOpen: 9 },
  });
  assert.deepEqual(view.delegations, { queued: 2, running: 1, awaitingEscalation: 1, settled: 7 });
  assert.deepEqual(view.incidents, { open: 3, occurrencesOpen: 9 });
  assert.equal(gauge().delegations, null);
  assert.equal(gauge().incidents, null);
});

test('missing or nonsense inputs degrade to zero rather than throwing', () => {
  const view = buildFuelGauge({ now: NOW });
  assert.deepEqual(view.queue, { depth: 0, active: 0, maxConcurrent: null, saturated: false, source: 'task_queue' });
  assert.equal(view.localRuns.total, 0);
  assert.equal(view.windowMs, null);
  assert.equal(view.claims.accountWideRealTimeQuota, false);

  const junk = gauge({ queueStats: { queued: -5, active: 'lots', maxConcurrent: null } });
  assert.equal(junk.queue.depth, 0);
  assert.equal(junk.queue.active, 0);
});
