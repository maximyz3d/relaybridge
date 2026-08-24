'use strict';

// Usage ledger + fuel gauge.
//
// Answers four questions the bridge could not previously answer:
//   1. How much of each seat's budget is left? (the fuel gauge)
//   2. How fast are we burning it? (burn rate over a rolling window)
//   3. What would this have cost on metered API pricing, even though we are
//      on subscription plans? (shadow cost — the number you want when
//      deciding whether a plan is worth it)
//   4. Which seat should take the next unit of work so every seat drains at
//      roughly the same rate instead of one hitting a wall first?
//
// Design decisions worth knowing:
//
// * Subscription plans do not publish a token quota, so "fuel" for them is
//   measured against a CONFIGURED budget, not a vendor number. Getting that
//   budget wrong changes advice, not correctness — so the gauge always reports
//   `basis` ('configured' | 'metered' | 'unmetered') and never presents an
//   estimate as if it were authoritative.
// * Local seats (ollama) are free and effectively infinite. They are always
//   reported as full, and levelling never tries to "spread load" onto or off
//   them on cost grounds.
// * Every write is append-only JSONL, so a crash cannot corrupt history and
//   the file can be inspected with any text tool.

const fs = require('fs');
const path = require('path');

const DAY_MS = 86400000;

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

// Shadow pricing in USD per MILLION tokens. These are list API rates used to
// answer "what would this have cost if we were paying per token" while on a
// plan. They are estimates: vendors change prices, and a CLI may silently use
// a different model than requested, so treat the output as an order of
// magnitude, not an invoice.
const DEFAULT_PRICING = {
  // family prefix -> { in, out }
  'claude-opus':    { in: 15.00, out: 75.00 },
  'claude-sonnet':  { in: 3.00,  out: 15.00 },
  'claude-haiku':   { in: 0.80,  out: 4.00 },
  'gpt-5':          { in: 1.25,  out: 10.00 },
  'gpt-4o':         { in: 2.50,  out: 10.00 },
  'o3':             { in: 2.00,  out: 8.00 },
  'gemini-2.5-pro': { in: 1.25,  out: 10.00 },
  'gemini-2.5-flash': { in: 0.30, out: 2.50 },
  'grok':           { in: 3.00,  out: 15.00 },
  'perplexity':     { in: 1.00,  out: 1.00 },
  _default:         { in: 1.00,  out: 5.00 },
};

function priceFor(model, pricing = DEFAULT_PRICING) {
  const m = String(model || '').toLowerCase();
  let best = null;
  for (const [prefix, rate] of Object.entries(pricing)) {
    if (prefix === '_default') continue;
    if (m.includes(prefix.toLowerCase()) && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, rate };
    }
  }
  return best ? best.rate : (pricing._default || DEFAULT_PRICING._default);
}

// Cost in USD for one run. Returns 0 for local seats — they burn electricity,
// not budget, and pretending otherwise would distort levelling.
function costOf({ model, inputTokens = 0, outputTokens = 0, costClass = 'metered' }, pricing = DEFAULT_PRICING) {
  if (costClass === 'local' || costClass === 'none') return 0;
  const rate = priceFor(model, pricing);
  return ((Number(inputTokens) || 0) / 1e6) * rate.in
       + ((Number(outputTokens) || 0) / 1e6) * rate.out;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

function createUsageLedger(opts = {}) {
  const dir = opts.dataDir;
  const pricing = { ...DEFAULT_PRICING, ...(opts.pricing || {}) };
  // Per-seat budgets. `tokensPerDay`/`runsPerDay` are what the fuel gauge
  // measures against for subscription seats that publish no quota.
  const budgets = opts.budgets || {};
  const log = opts.log || (() => {});
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  fs.mkdirSync(dir, { recursive: true });

  const filePath = (d = new Date()) =>
    path.join(dir, `usage-${d.toISOString().slice(0, 10)}.jsonl`);
  const vendorQuotaPath = path.join(dir, 'vendor-quota.jsonl');

  function observeVendorQuota(observation) {
    if (!observation || typeof observation !== 'object') return null;
    const observedMs = Date.parse(observation.observedAt);
    const expiresMs = Date.parse(observation.reset?.expiresAt);
    const actual = Number(observation.actual);
    const limit = Number(observation.limit);
    if (!observation.provider || !observation.model || observation.unit !== 'tokens'
      || !Number.isSafeInteger(actual) || actual < 0
      || !Number.isSafeInteger(limit) || limit < 1
      || !Number.isFinite(observedMs) || !Number.isFinite(expiresMs) || expiresMs <= observedMs) return null;
    const row = {
      ...observation,
      seat: String(observation.provider),
      actual,
      limit,
      recordedAt: new Date(now()).toISOString(),
    };
    try {
      fs.appendFileSync(vendorQuotaPath, JSON.stringify(row) + '\n', 'utf8');
    } catch (err) {
      log(`[RelayBridge] vendor quota observation write failed: ${err.message}`);
      return null;
    }
    return row;
  }

  function activeVendorQuota(seat, model = null) {
    if (!fs.existsSync(vendorQuotaPath)) return null;
    const current = now();
    const wantedModel = model ? String(model).toLowerCase() : null;
    let latest = null;
    for (const line of fs.readFileSync(vendorQuotaPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.seat !== seat || Date.parse(row.reset?.expiresAt) <= current) continue;
        if (wantedModel && String(row.model || '').toLowerCase() !== wantedModel) continue;
        if (!latest || Date.parse(row.observedAt) > Date.parse(latest.observedAt)) latest = row;
      } catch { /* skip malformed observation */ }
    }
    return latest;
  }

  function record(entry) {
    const now = Date.now();
    const row = {
      ts: now,
      seat: String(entry.seat || 'unknown'),
      model: entry.model || null,
      costClass: entry.costClass || 'metered',
      inputTokens: Number(entry.inputTokens) || 0,
      outputTokens: Number(entry.outputTokens) || 0,
      elapsedMs: Number(entry.elapsedMs) || 0,
      ok: entry.ok !== false,
      failureKind: entry.failureKind || null,
      taskId: entry.taskId || null,
      project: entry.project || null,
    };
    row.totalTokens = row.inputTokens + row.outputTokens;
    row.costUsd = costOf({
      model: row.model, inputTokens: row.inputTokens,
      outputTokens: row.outputTokens, costClass: row.costClass,
    }, pricing);
    try {
      fs.appendFileSync(filePath(), JSON.stringify(row) + '\n', 'utf8');
    } catch (err) {
      log(`[RelayBridge] usage ledger write failed: ${err.message}`);
    }
    return row;
  }

  // Read rows over a window. Reads day files rather than one giant file so a
  // long-running bridge does not re-parse months of history for a 1h question.
  function rows({ sinceMs = DAY_MS, seat = null } = {}) {
    const cutoff = Date.now() - sinceMs;
    const out = [];
    const days = Math.ceil(sinceMs / DAY_MS) + 1;
    for (let i = 0; i < days; i++) {
      const fp = filePath(new Date(Date.now() - i * DAY_MS));
      if (!fs.existsSync(fp)) continue;
      for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (r.ts >= cutoff && (!seat || r.seat === seat)) out.push(r);
        } catch { /* skip malformed line */ }
      }
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  function summarize(list) {
    const s = {
      runs: list.length, ok: 0, failed: 0,
      inputTokens: 0, outputTokens: 0, totalTokens: 0,
      costUsd: 0, elapsedMs: 0, models: {},
    };
    for (const r of list) {
      s[r.ok ? 'ok' : 'failed'] += 1;
      s.inputTokens += r.inputTokens;
      s.outputTokens += r.outputTokens;
      s.totalTokens += r.totalTokens;
      s.costUsd += r.costUsd;
      s.elapsedMs += r.elapsedMs;
      if (r.model) {
        const m = s.models[r.model] || (s.models[r.model] = { runs: 0, tokens: 0, costUsd: 0 });
        m.runs += 1; m.tokens += r.totalTokens; m.costUsd += r.costUsd;
      }
    }
    s.costUsd = Number(s.costUsd.toFixed(4));
    return s;
  }

  // Burn rate: tokens/hour and USD/hour over the window, plus how long the
  // remaining budget lasts at that rate. `hoursToEmpty` is null when there is
  // no budget to run out of (local/unmetered) or no burn.
  function burnRate(seat, windowMs = 3600000) {
    const list = rows({ sinceMs: windowMs, seat });
    const s = summarize(list);
    const hours = windowMs / 3600000;
    return {
      windowMs,
      tokensPerHour: Math.round(s.totalTokens / hours),
      usdPerHour: Number((s.costUsd / hours).toFixed(4)),
      runsPerHour: Number((s.runs / hours).toFixed(2)),
    };
  }

  // The fuel gauge for one seat.
  function gauge(seat, seatConfig = {}, windowMs = DAY_MS) {
    const costClass = seatConfig.costClass || 'metered';
    const used = summarize(rows({ sinceMs: windowMs, seat }));
    const burn = burnRate(seat);
    const budget = budgets[seat] || {};

    let basis = 'unmetered';
    let capacity = null;
    let remaining = null;
    let percentRemaining = null;

    if (costClass === 'local' || costClass === 'none') {
      basis = 'unmetered';
      percentRemaining = 100; // free and effectively infinite
    } else if (Number.isFinite(Number(budget.tokensPerDay)) && Number(budget.tokensPerDay) > 0) {
      basis = costClass === 'subscription' ? 'configured' : 'metered';
      capacity = Number(budget.tokensPerDay);
      remaining = Math.max(0, capacity - used.totalTokens);
      percentRemaining = Math.round((remaining / capacity) * 100);
    } else if (Number.isFinite(Number(budget.usdPerDay)) && Number(budget.usdPerDay) > 0) {
      basis = 'metered';
      capacity = Number(budget.usdPerDay);
      remaining = Math.max(0, capacity - used.costUsd);
      percentRemaining = Math.round((remaining / capacity) * 100);
    }

    let hoursToEmpty = null;
    if (remaining !== null && burn.tokensPerHour > 0 && basis !== 'unmetered') {
      hoursToEmpty = budget.tokensPerDay
        ? Number((remaining / burn.tokensPerHour).toFixed(1))
        : Number((remaining / Math.max(burn.usdPerHour, 1e-9)).toFixed(1));
    }

    const configuredEstimate = {
      basis, capacity, remaining, percentRemaining, hoursToEmpty,
    };
    const vendorQuota = activeVendorQuota(seat, seatConfig.model || null);
    if (vendorQuota) {
      basis = 'vendor_observed';
      capacity = vendorQuota.limit;
      remaining = Math.max(0, vendorQuota.limit - vendorQuota.actual);
      percentRemaining = Math.max(0, Math.round((remaining / capacity) * 100));
      hoursToEmpty = null;
    }

    return {
      seat, costClass, basis,
      capacity, remaining, percentRemaining, hoursToEmpty,
      vendorQuota,
      configuredEstimate: vendorQuota && configuredEstimate.basis !== 'unmetered' ? configuredEstimate : null,
      used: {
        runs: used.runs, ok: used.ok, failed: used.failed,
        inputTokens: used.inputTokens, outputTokens: used.outputTokens,
        totalTokens: used.totalTokens, costUsd: used.costUsd,
        activeMinutes: Math.round(used.elapsedMs / 60000),
      },
      burn,
      models: used.models,
      // Honest labelling: a configured budget is a guess we wrote down, not a
      // vendor-published quota. The UI shows this so nobody reads an estimate
      // as fact.
      note: basis === 'vendor_observed'
        ? 'vendor-observed quota from a recognized 429; retained conservatively until its stated rolling window expires'
        : basis === 'configured'
        ? 'measured against a configured budget, not a vendor-published quota'
        : basis === 'unmetered' ? 'local or free seat — no budget to exhaust' : null,
    };
  }

  function gaugeAll(seatConfigs = {}, windowMs = DAY_MS) {
    const out = {};
    for (const [seat, cfg] of Object.entries(seatConfigs)) out[seat] = gauge(seat, cfg, windowMs);
    return out;
  }

  // Totals across every seat, for the "what would this have cost" headline.
  function totals(windowMs = DAY_MS) {
    const all = rows({ sinceMs: windowMs });
    const s = summarize(all);
    const bySeat = {};
    for (const r of all) {
      const b = bySeat[r.seat] || (bySeat[r.seat] = { runs: 0, tokens: 0, costUsd: 0, costClass: r.costClass });
      b.runs += 1; b.tokens += r.totalTokens; b.costUsd = Number((b.costUsd + r.costUsd).toFixed(4));
    }
    return {
      windowMs, ...s,
      bySeat,
      // Split so a plan's value is visible: what you paid nothing extra for
      // versus what genuinely billed.
      shadowCostUsd: Number(all.filter((r) => r.costClass === 'subscription')
        .reduce((n, r) => n + r.costUsd, 0).toFixed(4)),
      meteredCostUsd: Number(all.filter((r) => r.costClass === 'metered')
        .reduce((n, r) => n + r.costUsd, 0).toFixed(4)),
    };
  }

  return {
    record, rows, summarize, burnRate, gauge, gaugeAll, totals,
    observeVendorQuota, activeVendorQuota,
    pricing, budgets, costOf: (e) => costOf(e, pricing),
  };
}

module.exports = { createUsageLedger, costOf, priceFor, DEFAULT_PRICING };
