'use strict';

// The fuel gauge: what this bridge can honestly say about capacity.
//
// The temptation with a status view like this is to present a single "you have
// N% left" number. RelayBridge cannot know that. It observes the runs it
// dispatched and the signals providers volunteered; it has no account-wide
// meter, and a second machine, a browser tab, or a teammate can burn the same
// seat without this process ever hearing about it.
//
// So every field is labelled with where it came from, and the things that are
// genuinely unknown are reported as unknown rather than omitted — an omitted
// field reads as zero, and "zero usage outside this bridge" is a claim we are
// not entitled to make.

const SCOPE = 'this_bridge_only';

const DISCLAIMER = 'Counts and usage cover work dispatched by this bridge only. '
  + 'RelayBridge does not have account-wide real-time quota for any provider; '
  + 'usage from other machines, browser sessions, or teammates is not visible here.';

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function mapFromCounts(value) {
  if (!value) return {};
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  const out = {};
  for (const [key, amount] of entries) {
    const total = count(amount);
    if (total > 0) out[String(key)] = total;
  }
  return out;
}

// Token usage is only reported for providers that authoritatively report it.
// A provider whose capability is 'unavailable' gets `null` and an explicit
// reason: estimating tokens from output characters would make the number look
// authoritative while being wrong in the expensive direction.
function providerUsageView(gauges = {}, capabilities = {}) {
  const reported = {};
  const unavailable = [];
  for (const [seat, gauge] of Object.entries(gauges)) {
    const providers = Array.isArray(gauge?.aliases) && gauge.aliases.length ? gauge.aliases : [seat];
    const capability = providers
      .map((provider) => capabilities[provider])
      .find((entry) => entry && entry.tokens === 'authoritative');
    if (!capability) {
      unavailable.push({
        seat,
        providers,
        tokens: providers.map((provider) => capabilities[provider]?.tokens).find(Boolean) || 'unknown',
        budgetEnforcement: 'unenforceable',
        reason: 'no provider on this seat reports authoritative token usage',
      });
      reported[seat] = {
        source: 'unavailable',
        tokens: null,
        note: 'No authoritative token usage; character estimates are deliberately not substituted.',
      };
      continue;
    }
    reported[seat] = {
      source: 'provider_reported',
      turns: capability.turns,
      basis: gauge.basis || null,
      costClass: gauge.costClass || null,
      tokens: {
        input: count(gauge.used?.inputTokens),
        output: count(gauge.used?.outputTokens),
        total: count(gauge.used?.totalTokens),
      },
      runs: count(gauge.used?.runs),
      failed: count(gauge.used?.failed),
      note: 'Measured from runs this bridge dispatched inside the requested window.',
    };
  }
  return { reported, unavailable };
}

// Vendor signals are recognized evidence only: a parsed 429 quota message, an
// operator-entered reading, or an active cooldown. Nothing is inferred.
function vendorSignalsView(gauges = {}, cooldowns = []) {
  const signals = [];
  for (const [seat, gauge] of Object.entries(gauges)) {
    if (gauge?.vendorQuota) {
      signals.push({
        seat,
        kind: 'vendor_quota_exhausted',
        source: 'vendor_observed',
        model: gauge.vendorQuota.model || null,
        unit: gauge.vendorQuota.unit || null,
        actual: gauge.vendorQuota.actual ?? null,
        limit: gauge.vendorQuota.limit ?? null,
        expiresAt: gauge.vendorQuota.reset?.expiresAt || null,
        note: gauge.vendorQuota.reset?.note || null,
      });
    }
    if (gauge?.operatorQuota) {
      signals.push({
        seat,
        kind: 'operator_reported_quota',
        source: 'operator_observed',
        provenance: gauge.operatorQuota.provenance || null,
        percentRemaining: gauge.operatorQuota.percentRemaining ?? null,
        observedAt: gauge.operatorQuota.observedAt || null,
        expiresAt: gauge.operatorQuota.expiresAt || null,
        note: 'A point-in-time human reading, not a live meter.',
      });
    }
  }
  for (const cooling of Array.isArray(cooldowns) ? cooldowns : []) {
    signals.push({
      seat: cooling.seat || null,
      kind: 'rate_limited',
      source: 'vendor_observed',
      reason: cooling.reason || null,
      remainingSec: count(cooling.remainingSec),
      note: 'Provider refused work; the seat is unusable until the cooldown expires regardless of remaining fuel.',
    });
  }
  return signals;
}

/**
 * Assembles the fuel gauge from state the bridge already owns.
 *
 * Pure: every input is passed in, so the view can be tested without a running
 * server, a queue, or a provider.
 *
 * @param {object} input
 * @param {object} input.queueStats        taskQueue.stats(): {active, queued, maxConcurrent}
 * @param {object|Map} input.activeByProvider  live one-shot counts keyed by provider kind
 * @param {object} input.concurrency       configured admission limits
 * @param {object} [input.gauges]          usageLedger.gaugeAll() output
 * @param {object} [input.providerUsageCapabilities]
 * @param {Array}  [input.cooldowns]       active provider cooldowns
 * @param {object} [input.delegations]     delegation coordinator stats
 * @param {object} [input.incidents]       incident log stats
 */
function buildFuelGauge(input = {}) {
  const now = Number(input.now) || Date.now();
  const queueStats = input.queueStats || {};
  const activeByProvider = mapFromCounts(input.activeByProvider);
  const concurrency = input.concurrency || {};
  const gauges = input.gauges || {};
  const capabilities = input.providerUsageCapabilities || {};

  const localActiveTotal = Object.values(activeByProvider).reduce((sum, value) => sum + value, 0);
  const maxActiveOneShots = count(concurrency.maxActiveOneShots) || null;
  const maxActivePerProvider = count(concurrency.maxActivePerProvider) || null;
  const maxConcurrentTasks = count(queueStats.maxConcurrent) || count(concurrency.maxConcurrentTasks) || null;

  const usage = providerUsageView(gauges, capabilities);
  const signals = vendorSignalsView(gauges, input.cooldowns);

  return {
    generatedAt: new Date(now).toISOString(),
    scope: SCOPE,
    windowMs: Number(input.windowMs) || null,
    queue: {
      depth: count(queueStats.queued),
      active: count(queueStats.active),
      maxConcurrent: maxConcurrentTasks,
      // Depth alone hides the difference between "busy" and "wedged"; the
      // saturation flag is what an operator actually reacts to.
      saturated: maxConcurrentTasks !== null && count(queueStats.active) >= maxConcurrentTasks,
      source: 'task_queue',
    },
    localRuns: {
      byProvider: activeByProvider,
      total: localActiveTotal,
      maxActiveOneShots,
      maxActivePerProvider,
      atFleetLimit: maxActiveOneShots !== null && localActiveTotal >= maxActiveOneShots,
      providersAtLimit: maxActivePerProvider === null ? [] : Object.entries(activeByProvider)
        .filter(([, value]) => value >= maxActivePerProvider).map(([kind]) => kind),
      source: 'admission_control',
    },
    providerUsage: usage.reported,
    usageUnavailable: usage.unavailable,
    vendorSignals: signals,
    delegations: input.delegations ? {
      queued: count(input.delegations.queued),
      running: count(input.delegations.running),
      awaitingEscalation: count(input.delegations.awaitingEscalation),
      settled: count(input.delegations.settled),
    } : null,
    incidents: input.incidents ? {
      open: count(input.incidents.open),
      occurrencesOpen: count(input.incidents.occurrencesOpen),
    } : null,
    // Explicit unknowns. These are values an operator might otherwise assume
    // are covered by the numbers above.
    unknown: {
      accountWideQuota: 'unknown',
      usageOutsideThisBridge: 'unknown',
      concurrentSessionsElsewhere: 'unknown',
      providersWithoutAuthoritativeUsage: usage.unavailable.map((entry) => entry.seat),
      reason: DISCLAIMER,
    },
    claims: {
      accountWideRealTimeQuota: false,
      note: 'This view never asserts account-wide real-time quota.',
    },
    disclaimer: DISCLAIMER,
  };
}

module.exports = { buildFuelGauge, DISCLAIMER, SCOPE };
