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
const { QUOTA_SEAT_RE } = require('./quota-seat');

const DAY_MS = 86400000;
const MAX_OPERATOR_QUOTA_TTL_MS = 31 * DAY_MS;
const OPERATOR_QUOTA_PROVENANCE = Object.freeze([
  'human_account_owner',
  'vendor_ui_manual_read',
  'provider_support',
]);

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
  const quotaSeats = opts.quotaSeats || {};
  const log = opts.log || (() => {});
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  fs.mkdirSync(dir, { recursive: true });

  const filePath = (d = new Date()) =>
    path.join(dir, `usage-${d.toISOString().slice(0, 10)}.jsonl`);
  const vendorQuotaPath = path.join(dir, 'vendor-quota.jsonl');
  const operatorQuotaPath = path.join(dir, 'operator-quota.jsonl');

  const quotaSeatFor = (seat) => quotaSeats[String(seat)] || String(seat);
  const aliasesFor = (quotaSeat) => Object.keys(quotaSeats)
    .filter((seat) => quotaSeatFor(seat) === quotaSeat).sort();

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
      quotaSeat: typeof observation.quotaSeat === 'string' && QUOTA_SEAT_RE.test(observation.quotaSeat)
        ? observation.quotaSeat : quotaSeatFor(observation.provider),
      scope: observation.scope === 'account' ? 'account' : 'model',
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

  function activeVendorQuota(seat, model = null, quotaSeatOverride = null) {
    const current = now();
    const wantedModel = model ? String(model).toLowerCase() : null;
    const wantedQuotaSeat = quotaSeatOverride || quotaSeatFor(seat);
    let latest = null;
    for (const row of parsedRows(vendorQuotaPath)) {
      try {
        const rowQuotaSeat = row.quotaSeat || quotaSeatFor(row.seat);
        if (rowQuotaSeat !== wantedQuotaSeat || Date.parse(row.reset?.expiresAt) <= current) continue;
        const scope = row.scope === 'account' ? 'account' : 'model';
        if (scope === 'model') {
          if (wantedModel && String(row.model || '').toLowerCase() !== wantedModel) continue;
          if (!wantedModel && row.seat !== seat) continue;
        }
        if (!latest || Date.parse(row.observedAt) > Date.parse(latest.observedAt)) latest = row;
      } catch { /* skip malformed observation */ }
    }
    return latest;
  }

  function appendOperatorQuota(row) {
    try {
      fs.appendFileSync(operatorQuotaPath, JSON.stringify(row) + '\n', 'utf8');
      return row;
    } catch (err) {
      log(`[RelayBridge] operator quota observation write failed: ${err.message}`);
      return null;
    }
  }

  function observeOperatorQuota(observation) {
    if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return null;
    const quotaSeat = typeof observation.quotaSeat === 'string' ? observation.quotaSeat.trim() : '';
    const percentRemaining = observation.percentRemaining;
    const provenance = String(observation.provenance || '');
    const current = now();
    const observedAt = observation.observedAt || new Date(current).toISOString();
    const observedMs = Date.parse(observedAt);
    const expiresMs = Date.parse(observation.expiresAt);
    if (!QUOTA_SEAT_RE.test(quotaSeat)
      || !Number.isInteger(percentRemaining) || percentRemaining < 0 || percentRemaining > 100
      || observation.source !== 'operator_reported'
      || !OPERATOR_QUOTA_PROVENANCE.includes(provenance)
      || !Number.isFinite(observedMs) || observedMs > current + 300000
      || !Number.isFinite(expiresMs) || expiresMs <= current || expiresMs <= observedMs
      || expiresMs - current > MAX_OPERATOR_QUOTA_TTL_MS) return null;
    return appendOperatorQuota({
      action: 'set', quotaSeat, percentRemaining,
      source: 'operator_reported', provenance,
      observedAt: new Date(observedMs).toISOString(),
      expiresAt: new Date(expiresMs).toISOString(),
      recordedAt: new Date(current).toISOString(),
    });
  }

  function clearOperatorQuota(quotaSeatValue) {
    const quotaSeat = typeof quotaSeatValue === 'string' ? quotaSeatValue.trim() : '';
    if (!QUOTA_SEAT_RE.test(quotaSeat)) return null;
    return appendOperatorQuota({
      action: 'clear', quotaSeat, source: 'operator_action',
      recordedAt: new Date(now()).toISOString(),
    });
  }

  function operatorQuotaObservations({ includeExpired = false } = {}) {
    const latest = new Map();
    for (const row of parsedRows(operatorQuotaPath)) {
      try {
        if (!row || !QUOTA_SEAT_RE.test(String(row.quotaSeat || ''))) continue;
        if (row.action === 'clear') {
          latest.delete(row.quotaSeat);
          continue;
        }
        const observedMs = Date.parse(row.observedAt);
        const expiresMs = Date.parse(row.expiresAt);
        const recordedMs = Date.parse(row.recordedAt);
        if (row.action !== 'set' || row.source !== 'operator_reported'
          || !Number.isInteger(row.percentRemaining) || row.percentRemaining < 0 || row.percentRemaining > 100
          || !OPERATOR_QUOTA_PROVENANCE.includes(row.provenance)
          || !Number.isFinite(observedMs) || !Number.isFinite(expiresMs) || expiresMs <= observedMs
          || !Number.isFinite(recordedMs)) continue;
        latest.set(row.quotaSeat, {
          action: 'set', quotaSeat: row.quotaSeat, percentRemaining: row.percentRemaining,
          source: 'operator_reported', provenance: row.provenance,
          observedAt: new Date(observedMs).toISOString(),
          expiresAt: new Date(expiresMs).toISOString(),
          recordedAt: new Date(recordedMs).toISOString(),
        });
      } catch { /* skip malformed observation */ }
    }
    const current = now();
    return Object.fromEntries([...latest.entries()]
      .filter(([, row]) => includeExpired || Date.parse(row.expiresAt) > current)
      .sort(([left], [right]) => left.localeCompare(right)));
  }

  function activeOperatorQuota(quotaSeat) {
    return operatorQuotaObservations()[String(quotaSeat)] || null;
  }

  function record(entry) {
    const now = Date.now();
    const row = {
      ts: now,
      seat: String(entry.seat || 'unknown'),
      // An explicit quotaSeat wins over the seat->quotaSeat map: with several
      // accounts on one provider the seat is the same ('claude') but the
      // allowance being drawn down is not, and attribution has to follow the
      // account or three plans would pool back into one gauge.
      quotaSeat: (typeof entry.quotaSeat === 'string' && entry.quotaSeat.trim())
        || quotaSeatFor(entry.seat || 'unknown'),
      model: entry.model || null,
      costClass: entry.costClass || 'metered',
      inputTokens: Number(entry.inputTokens) || 0,
      outputTokens: Number(entry.outputTokens) || 0,
      // Claude reports single-digit input_tokens against tens of thousands of
      // cache-read tokens on a resumed session. Booking only input+output made
      // the seat with the largest budget look almost untouched, so its gauge sat
      // near 100% and stressOf() returned 0 for exactly the seat load-levelling
      // exists to protect. server.js forwards all four counts.
      cacheReadTokens: Number(entry.cacheReadTokens) || 0,
      cacheCreationTokens: Number(entry.cacheCreationTokens) || 0,
      elapsedMs: Number(entry.elapsedMs) || 0,
      ok: entry.ok !== false,
      failureKind: entry.failureKind || null,
      taskId: entry.taskId || null,
      project: entry.project || null,
    };
    // Prefer the provider's own total when it gave one; otherwise sum every
    // count we have. With no cache fields (the common case, and what the tests
    // exercise) this is still exactly input + output.
    const summed = row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreationTokens;
    row.totalTokens = Number.isFinite(Number(entry.totalTokens)) && Number(entry.totalTokens) > 0
      ? Number(entry.totalTokens)
      : summed;
    // A provider-reported cost is ground truth; the list-rate table is an
    // estimate. Record which one this is so the dashboard can stop presenting
    // an estimate as if it were billed spend.
    const providerCost = typeof entry.providerCostUsd === 'number'
      && Number.isFinite(entry.providerCostUsd) && entry.providerCostUsd >= 0
      ? entry.providerCostUsd : null;
    if (providerCost !== null) {
      row.costUsd = providerCost;
      row.costSource = 'provider';
    } else {
      row.costUsd = costOf({
        model: row.model, inputTokens: row.inputTokens,
        outputTokens: row.outputTokens, costClass: row.costClass,
      }, pricing);
      row.costSource = 'estimated';
    }
    try {
      fs.appendFileSync(filePath(), JSON.stringify(row) + '\n', 'utf8');
    } catch (err) {
      log(`[RelayBridge] usage ledger write failed: ${err.message}`);
    }
    return row;
  }

  // Parsed JSONL files, keyed by path. Every reader here re-parsed whole files
  // per call: gaugeAll asks for the window once per seat and each gauge asks
  // again for its burn rate, so a 14-seat fleet re-parsed the same day files 28
  // times on every /api/route, /api/plan and 10s dashboard poll — measured at
  // 265ms of blocked event loop for a 24h window over 8 files of 5,000 rows,
  // 595ms for 7 days. These files are append-only, so (size, mtime) is a sound
  // invalidation key: an append always changes the size. Rows are handed out by
  // reference, not copied — every reader below treats them as read-only, and
  // callers of the exported rows() must do the same.
  const parsedFiles = new Map();
  const PARSE_CACHE_MAX = 64; // a month of day files plus the two quota logs

  function parsedRows(fp) {
    let stat;
    try { stat = fs.statSync(fp); } catch { parsedFiles.delete(fp); return []; }
    const hit = parsedFiles.get(fp);
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.rows;
    let text;
    try { text = fs.readFileSync(fp, 'utf8'); } catch { parsedFiles.delete(fp); return []; }
    const parsed = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { parsed.push(JSON.parse(line)); } catch { /* skip malformed line */ }
    }
    parsedFiles.set(fp, { size: stat.size, mtimeMs: stat.mtimeMs, rows: parsed });
    // Bounded, so a bridge that runs for months does not retain every day file
    // it ever read. A Map iterates in insertion order, so this drops the oldest.
    while (parsedFiles.size > PARSE_CACHE_MAX) parsedFiles.delete(parsedFiles.keys().next().value);
    return parsed;
  }

  // Read rows over a window. Reads day files rather than one giant file so a
  // long-running bridge does not re-parse months of history for a 1h question.
  function rows({ sinceMs = DAY_MS, seat = null } = {}) {
    const cutoff = Date.now() - sinceMs;
    const out = [];
    const days = Math.ceil(sinceMs / DAY_MS) + 1;
    for (let i = 0; i < days; i++) {
      for (const r of parsedRows(filePath(new Date(Date.now() - i * DAY_MS)))) {
        if (r.ts >= cutoff && (!seat || r.seat === seat)) out.push(r);
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
  function burnRate(seat, windowMs = 3600000, quotaSeatOverride = null) {
    const quotaSeat = quotaSeatOverride || quotaSeatFor(seat);
    const list = rows({ sinceMs: windowMs }).filter((row) =>
      (row.quotaSeat || quotaSeatFor(row.seat)) === quotaSeat);
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
    // The window is caller-chosen (the dashboard offers 1h/24h/7d, the MCP
    // usage_gauges tool up to 30 days) and it scales the usage, so it has to
    // scale the budget with it. It did not: a 7-day window measured seven days
    // of usage against ONE day of budget and reported capacity 8,000,000,
    // remaining 0, 0% — an empty red bar — for a seat sitting at 20% of its
    // daily allowance, while the 1h window reported ~100% for a seat that was
    // nearly drained. A non-positive or non-numeric window would make capacity
    // zero or negative, so it falls back to a day.
    const win = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0 ? Number(windowMs) : DAY_MS;
    const windowDays = win / DAY_MS;
    const costClass = seatConfig.costClass || 'metered';
    const quotaSeat = seatConfig.quotaSeat || quotaSeatFor(seat);
    const aliases = Array.isArray(seatConfig.aliases) && seatConfig.aliases.length
      ? [...seatConfig.aliases].sort() : (aliasesFor(quotaSeat).length ? aliasesFor(quotaSeat) : [seat]);
    const used = summarize(rows({ sinceMs: win }).filter((row) =>
      (row.quotaSeat || quotaSeatFor(row.seat)) === quotaSeat));
    // The burn rate stays a ONE-HOUR measurement whatever the gauge window is:
    // hoursToEmpty divides a remaining by a per-hour rate, which is
    // dimensionally correct either way, and widening it to the gauge window
    // would smooth away exactly the recent spike routing needs to see.
    const burn = burnRate(seat, 3600000, quotaSeat);
    // A linked account's quotaSeat is the seat's own with a '#<account>' suffix
    // (lib/provider-accounts.js). Each plan is a separate allowance of the SAME
    // size, so fall back to the base seat's budget rather than reporting the
    // second plan as unbudgeted — that fallback is what makes three linked
    // subscriptions read as three times the quota instead of one measured plan
    // and two unmeasured ones.
    const baseQuotaSeat = String(quotaSeat).includes('#')
      ? String(quotaSeat).slice(0, String(quotaSeat).indexOf('#'))
      : null;
    const budget = budgets[quotaSeat]
      || (baseQuotaSeat ? budgets[baseQuotaSeat] : null)
      || budgets[seat] || {};

    let basis = 'unmetered';
    let capacity = null;
    let remaining = null;
    let percentRemaining = null;
    // Which unit the capacity is in, so the projection below divides by the
    // rate in the SAME unit. Reading it back off budget.tokensPerDay was wrong
    // whenever that field was present but unusable (0, negative, or not a
    // number) and the usdPerDay branch had supplied the capacity.
    let capacityUnit = null;

    if (costClass === 'local' || costClass === 'none') {
      basis = 'unmetered';
      percentRemaining = 100; // free and effectively infinite
    } else if (Number.isFinite(Number(budget.tokensPerDay)) && Number(budget.tokensPerDay) > 0) {
      basis = costClass === 'subscription' ? 'configured' : 'metered';
      capacity = Math.round(Number(budget.tokensPerDay) * windowDays);
      capacityUnit = 'tokens';
      remaining = Math.max(0, capacity - used.totalTokens);
      percentRemaining = Math.round((remaining / capacity) * 100);
    } else if (Number.isFinite(Number(budget.usdPerDay)) && Number(budget.usdPerDay) > 0) {
      basis = 'metered';
      capacity = Number((Number(budget.usdPerDay) * windowDays).toFixed(4));
      capacityUnit = 'usd';
      remaining = Math.max(0, capacity - used.costUsd);
      percentRemaining = Math.round((remaining / capacity) * 100);
    }

    let hoursToEmpty = null;
    // No burn in the capacity's own unit means no projection — not an enormous
    // one. The USD branch used to be gated on the TOKEN rate and then divide by
    // a usdPerHour that burnRate rounds to 4dp, clamped at 1e-9: a seat with a
    // $5/day budget that had spent $0.00003 in the last hour reported
    // "~5000000000h to empty", which the Fuel panel printed verbatim.
    if (remaining !== null && basis !== 'unmetered') {
      if (capacityUnit === 'tokens' && burn.tokensPerHour > 0) {
        hoursToEmpty = Number((remaining / burn.tokensPerHour).toFixed(1));
      } else if (capacityUnit === 'usd' && burn.usdPerHour > 0) {
        hoursToEmpty = Number((remaining / burn.usdPerHour).toFixed(1));
      }
    }

    const configuredEstimate = {
      basis, capacity, remaining, percentRemaining, hoursToEmpty,
    };
    const vendorQuota = activeVendorQuota(seat, seatConfig.model || null, quotaSeat);
    const operatorQuota = activeOperatorQuota(quotaSeat);
    if (vendorQuota) {
      basis = 'vendor_observed';
      capacity = vendorQuota.limit;
      remaining = Math.max(0, vendorQuota.limit - vendorQuota.actual);
      percentRemaining = Math.max(0, Math.round((remaining / capacity) * 100));
      hoursToEmpty = null;
    } else if (operatorQuota) {
      basis = 'operator_observed';
      capacity = null;
      remaining = null;
      percentRemaining = operatorQuota.percentRemaining;
      hoursToEmpty = null;
    }

    return {
      seat, quotaSeat, aliases, costClass, basis,
      capacity, remaining, percentRemaining, hoursToEmpty,
      vendorQuota, operatorQuota,
      configuredEstimate: (vendorQuota || operatorQuota) && configuredEstimate.basis !== 'unmetered' ? configuredEstimate : null,
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
        : basis === 'operator_observed'
        ? 'expiring operator-reported quota observation; not scraped or vendor-verified'
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
      b.runs += 1; b.tokens += r.totalTokens; b.costUsd += r.costUsd;
    }
    // Round ONCE at the end, the way summarize() rounds the fleet total.
    // Rounding inside the loop discarded every run under $0.00005: 10,000
    // sub-cent utility runs accumulated to exactly $0.00 per seat while
    // totals.costUsd in the same response body showed $0.30.
    for (const b of Object.values(bySeat)) b.costUsd = Number(b.costUsd.toFixed(4));
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
    observeOperatorQuota, clearOperatorQuota, activeOperatorQuota, operatorQuotaObservations,
    pricing, budgets, costOf: (e) => costOf(e, pricing),
  };
}

module.exports = {
  createUsageLedger, costOf, priceFor, DEFAULT_PRICING,
  OPERATOR_QUOTA_PROVENANCE, MAX_OPERATOR_QUOTA_TTL_MS,
};
