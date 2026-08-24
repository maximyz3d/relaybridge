'use strict';

// Load levelling: decide WHICH capable seat takes the next unit of work, and
// whether the task actually needs the expensive one.
//
// Two goals, in priority order:
//
//   1. Don't spend depth you don't need. A trivial lookup routed to a frontier
//      seat is pure waste, and it is waste that compounds: it drains the seat
//      you will want later for something hard.
//   2. Drain seats evenly. One seat hitting a wall while others sit at 90%
//      means work stops even though capacity exists. Levelling trades a
//      slightly-less-preferred seat now for not hitting a wall later.
//
// This module only ADVISES. It ranks candidates the router already judged
// capable; it never widens the candidate set, never picks an unauthenticated
// seat, and never overrides an explicit user request. Capability always wins
// over economy — a cheap seat that cannot do the job is not a saving.

// Tier ordering, cheapest first. Used to decide whether a downgrade is even
// meaningful for a given task.
const TIERS = ['deterministic', 'utility', 'standard', 'complex', 'critical'];

function tierIndex(tier) {
  const i = TIERS.indexOf(String(tier || 'standard'));
  return i < 0 ? TIERS.indexOf('standard') : i;
}

// A seat is "stressed" when it is low on fuel or burning fast enough to empty
// within the hour. Both matter: 15% left and idle is fine; 40% left and
// emptying in 20 minutes is not.
function stressOf(gauge) {
  if (!gauge || gauge.basis === 'unmetered') return 0;
  const pct = Number.isFinite(gauge.percentRemaining) ? gauge.percentRemaining : 100;
  let stress = (100 - pct) / 100;                       // 0 (full) .. 1 (empty)
  if (Number.isFinite(gauge.hoursToEmpty) && gauge.hoursToEmpty !== null) {
    if (gauge.hoursToEmpty < 1) stress = Math.max(stress, 0.9);
    else if (gauge.hoursToEmpty < 4) stress = Math.max(stress, 0.7);
  }
  return Math.min(1, stress);
}

/**
 * Should this task use a cheaper seat than its tier suggests?
 *
 * Only ever downgrades by ONE step, and never below `utility`, and never for
 * high-stakes work. A wrong answer on a critical task costs far more than the
 * tokens saved, so the guard is deliberately conservative.
 */
function suggestTierAdjustment({ tier, gauge, highStakes = false, explicitProvider = false }) {
  const idx = tierIndex(tier);
  const reasons = [];
  if (explicitProvider) return { tier, changed: false, reason: 'an explicitly requested seat is never downgraded' };
  if (highStakes || tier === 'critical') {
    return { tier, changed: false, reason: 'high-stakes work is never downgraded to save budget' };
  }
  if (idx <= TIERS.indexOf('utility')) {
    return { tier, changed: false, reason: 'already at or below the utility tier' };
  }
  const stress = stressOf(gauge);
  if (stress < 0.6) return { tier, changed: false, reason: 'seat has comfortable headroom' };

  const next = TIERS[Math.max(TIERS.indexOf('utility'), idx - 1)];
  if (gauge?.percentRemaining !== null && gauge?.percentRemaining !== undefined) {
    reasons.push(`${gauge.seat} at ${gauge.percentRemaining}% remaining`);
  }
  if (gauge?.hoursToEmpty !== null && gauge?.hoursToEmpty !== undefined) {
    reasons.push(`~${gauge.hoursToEmpty}h to empty at current burn`);
  }
  return {
    tier: next,
    changed: next !== tier,
    reason: `downgraded ${tier} -> ${next}: ${reasons.join(', ') || 'seat under pressure'}`,
  };
}

/**
 * Rank capable seats so the fleet drains evenly.
 *
 * @param {Array} candidates  [{ seat, rank, costClass }] — already filtered to
 *                            seats the router judged capable AND ready. `rank`
 *                            is the router's own preference (lower = better).
 * @param {object} gauges     seat -> gauge from the usage ledger
 * @returns {Array} same objects plus { score, stress, levelledRank, why }
 */
function levelCandidates(candidates = [], gauges = {}, opts = {}) {
  // How much levelling is allowed to override the router's preference. At 0.5
  // a seat must be meaningfully fresher to jump ahead of a better-ranked one,
  // so levelling nudges rather than scrambles the order.
  const weight = Number.isFinite(opts.weight) ? opts.weight : 0.5;

  const scored = candidates.map((c) => {
    const gauge = gauges[c.seat];
    const stress = stressOf(gauge);
    const free = c.costClass === 'local' || c.costClass === 'none';
    // Local seats never carry stress cost — using them is how you SAVE the
    // metered ones, so they should sort forward, not be penalised.
    //
    // Stress is SQUARED so the curve matches intent: a small fuel difference
    // (90% vs 85%) barely moves the score and the router's preference stands,
    // while a genuinely drained seat (8% vs 95%) is penalised hard enough to
    // fall behind. A linear penalty capped at one rank step, which meant a
    // nearly-empty seat could never actually be overtaken.
    const penalty = free ? 0 : (stress ** 2) * weight * candidates.length * 2;
    const base = Number.isFinite(c.rank) ? c.rank : 0;
    const why = [];
    if (free) why.push('free seat');
    else if (gauge?.percentRemaining !== null && gauge?.percentRemaining !== undefined) {
      why.push(`${gauge.percentRemaining}% fuel`);
    }
    if (stress >= 0.9) why.push('nearly empty — deprioritised');
    else if (stress >= 0.6) why.push('under pressure');
    return { ...c, stress: Number(stress.toFixed(2)), score: Number((base + penalty).toFixed(3)), why: why.join(', ') };
  });

  scored.sort((a, b) => a.score - b.score || (a.rank ?? 0) - (b.rank ?? 0));
  return scored.map((s, i) => ({ ...s, levelledRank: i }));
}

/**
 * Fleet view: is usage actually even, and what should shift?
 * `spread` is the gap between the freshest and most-drained metered seat —
 * the single number that says whether levelling is working.
 */
function fleetBalance(gauges = {}) {
  const metered = Object.values(gauges).filter((g) => g.basis !== 'unmetered' && Number.isFinite(g.percentRemaining));
  if (metered.length < 2) {
    return { balanced: true, spread: 0, advice: null, seats: metered.length };
  }
  const pcts = metered.map((g) => g.percentRemaining);
  const max = Math.max(...pcts);
  const min = Math.min(...pcts);
  const spread = max - min;
  const lowest = metered.find((g) => g.percentRemaining === min);
  const highest = metered.find((g) => g.percentRemaining === max);
  return {
    balanced: spread <= 20,
    spread,
    seats: metered.length,
    mostDrained: lowest.seat,
    freshest: highest.seat,
    advice: spread > 20
      ? `shift work from ${lowest.seat} (${min}%) toward ${highest.seat} (${max}%) — ${spread}pt spread`
      : null,
  };
}

/**
 * Overlay durable quota state onto live diagnostics before the policy router
 * chooses candidates. This is what makes cooldowns affect normal route/plan
 * calls instead of existing only on the advisory usage endpoint.
 */
function applyCooldownsToDiagnostics(diagnostics = {}, cooling = [], explicitKinds = []) {
  const out = {};
  for (const [seat, info] of Object.entries(diagnostics || {})) {
    out[seat] = info && typeof info === 'object' ? { ...info } : info;
  }
  const explicit = new Set((explicitKinds || []).filter(Boolean).map(String));
  const skipped = [];
  for (const state of cooling || []) {
    const seat = String(state?.seat || '');
    if (!seat || explicit.has(seat)) continue;
    const prior = out[seat] && typeof out[seat] === 'object' ? out[seat] : {};
    out[seat] = {
      ...prior,
      ready: false,
      cooling: true,
      cooldown: state,
      detail: `cooling after ${state.reason || 'quota failure'}; ${state.remainingSec || 0}s remaining`,
    };
    skipped.push(seat);
  }
  return { diagnostics: out, skipped };
}

/** Reorder only the providers the policy router already accepted. */
function levelRouteSelection(route, gauges = {}, costClasses = {}) {
  const selected = Array.isArray(route?.selected) ? route.selected : [];
  if (selected.length < 2) return route;
  const byKind = new Map(selected.map((pick) => [pick.kind, pick]));
  const ranked = levelCandidates(selected.map((pick, rank) => ({
    seat: pick.kind,
    rank,
    costClass: costClasses[pick.kind] || pick.costClass || 'metered',
  })), gauges);
  return {
    ...route,
    selected: ranked.map((item) => ({
      ...byKind.get(item.seat),
      loadLevelling: {
        originalRank: item.rank,
        levelledRank: item.levelledRank,
        stress: item.stress,
        score: item.score,
        why: item.why,
      },
    })),
  };
}

module.exports = {
  levelCandidates, suggestTierAdjustment, fleetBalance, stressOf, TIERS,
  applyCooldownsToDiagnostics, levelRouteSelection,
};
