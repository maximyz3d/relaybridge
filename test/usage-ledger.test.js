'use strict';

// The fuel gauge answers "how much is left and how fast are we burning it".
// Its job is to be honest about what it knows: a configured budget is a guess
// we wrote down, not a vendor quota, and it must say so.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createUsageLedger, costOf, priceFor } = require('../lib/usage-ledger');
const {
  levelCandidates, suggestTierAdjustment, fleetBalance, stressOf,
  applyCooldownsToDiagnostics, levelRouteSelection,
} = require('../lib/load-leveller');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rbusage-'));

// ---- pricing ---------------------------------------------------------------

test('pricing matches the most specific model family, not the first hit', () => {
  assert.equal(priceFor('claude-opus-4-20250101').out, 75.00);
  assert.equal(priceFor('claude-haiku-4-5').out, 4.00);
  assert.equal(priceFor('gemini-2.5-flash').in, 0.30);
  assert.equal(priceFor('something-unheard-of').in, 1.00, 'unknown models fall back rather than throwing');
});

test('local seats cost nothing — pretending otherwise would distort levelling', () => {
  assert.equal(costOf({ model: 'qwen2.5-coder', inputTokens: 1e6, outputTokens: 1e6, costClass: 'local' }), 0);
  assert.equal(costOf({ model: 'powershell', inputTokens: 500, costClass: 'none' }), 0);
});

test('shadow cost is computed from real token counts', () => {
  // 1M in + 1M out on sonnet = 3.00 + 15.00
  const c = costOf({ model: 'claude-sonnet-4-6', inputTokens: 1e6, outputTokens: 1e6, costClass: 'subscription' });
  assert.equal(Number(c.toFixed(2)), 18.00);
});

// ---- ledger ----------------------------------------------------------------

test('runs are recorded durably and summed per seat', () => {
  const dir = tmp();
  const l = createUsageLedger({ dataDir: dir });
  l.record({ seat: 'claude', model: 'claude-sonnet-4-6', costClass: 'subscription', inputTokens: 1000, outputTokens: 2000, elapsedMs: 5000 });
  l.record({ seat: 'claude', model: 'claude-sonnet-4-6', costClass: 'subscription', inputTokens: 500, outputTokens: 500, elapsedMs: 3000 });
  l.record({ seat: 'codex', model: 'gpt-5', costClass: 'subscription', inputTokens: 100, outputTokens: 100, elapsedMs: 1000 });

  const t = l.totals();
  assert.equal(t.runs, 3);
  assert.equal(t.totalTokens, 4200);
  assert.equal(t.bySeat.claude.tokens, 4000);
  assert.equal(t.bySeat.codex.tokens, 200);
  assert.ok(t.shadowCostUsd > 0, 'subscription runs still accrue a shadow cost');

  // A separate instance reads the same history — the ledger is on disk.
  const other = createUsageLedger({ dataDir: dir });
  assert.equal(other.totals().runs, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('shadow and metered cost are reported separately so a plan\'s value is visible', () => {
  const dir = tmp();
  const l = createUsageLedger({ dataDir: dir });
  l.record({ seat: 'claude', model: 'claude-opus-4', costClass: 'subscription', inputTokens: 1e6, outputTokens: 0 });
  l.record({ seat: 'api', model: 'gpt-5', costClass: 'metered', inputTokens: 1e6, outputTokens: 0 });
  const t = l.totals();
  assert.equal(Number(t.shadowCostUsd.toFixed(2)), 15.00, 'what the plan saved');
  assert.equal(Number(t.meteredCostUsd.toFixed(2)), 1.25, 'what actually billed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a malformed ledger line is skipped rather than crashing the gauge', () => {
  const dir = tmp();
  const l = createUsageLedger({ dataDir: dir });
  l.record({ seat: 'claude', costClass: 'subscription', inputTokens: 10, outputTokens: 10 });
  const fp = path.join(dir, `usage-${new Date().toISOString().slice(0,10)}.jsonl`);
  fs.appendFileSync(fp, 'this is not json\n');
  assert.equal(l.totals().runs, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- fuel gauge ------------------------------------------------------------

test('the gauge labels a configured budget as configured, never as a vendor quota', () => {
  const dir = tmp();
  const l = createUsageLedger({ dataDir: dir, budgets: { claude: { tokensPerDay: 1000000 } } });
  l.record({ seat: 'claude', model: 'claude-sonnet-4-6', costClass: 'subscription', inputTokens: 200000, outputTokens: 300000 });
  const g = l.gauge('claude', { costClass: 'subscription' });
  assert.equal(g.basis, 'configured');
  assert.equal(g.percentRemaining, 50);
  assert.match(g.note, /not a vendor-published quota/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('local seats read full and are never treated as exhaustible', () => {
  const dir = tmp();
  const l = createUsageLedger({ dataDir: dir });
  l.record({ seat: 'ollama_coder', model: 'qwen', costClass: 'local', inputTokens: 5e6, outputTokens: 5e6 });
  const g = l.gauge('ollama_coder', { costClass: 'local' });
  assert.equal(g.percentRemaining, 100);
  assert.equal(g.basis, 'unmetered');
  assert.equal(g.used.costUsd, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('burn rate projects time-to-empty from actual usage', () => {
  const dir = tmp();
  const l = createUsageLedger({ dataDir: dir, budgets: { claude: { tokensPerDay: 100000 } } });
  for (let i = 0; i < 5; i++) l.record({ seat: 'claude', model: 'claude-sonnet-4-6', costClass: 'subscription', inputTokens: 2000, outputTokens: 2000 });
  const g = l.gauge('claude', { costClass: 'subscription' });
  assert.equal(g.used.totalTokens, 20000);
  assert.equal(g.percentRemaining, 80);
  assert.ok(g.burn.tokensPerHour > 0, 'burn rate must be measured');
  assert.ok(g.hoursToEmpty > 0, 'a projection must exist when burning against a budget');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- levelling -------------------------------------------------------------

test('a drained seat is deprioritised but a capable order is still respected', () => {
  const gauges = {
    claude: { seat: 'claude', basis: 'configured', percentRemaining: 8, hoursToEmpty: 0.5 },
    codex:  { seat: 'codex',  basis: 'configured', percentRemaining: 95, hoursToEmpty: 40 },
  };
  const ranked = levelCandidates(
    [{ seat: 'claude', rank: 0, costClass: 'subscription' }, { seat: 'codex', rank: 1, costClass: 'subscription' }],
    gauges);
  assert.equal(ranked[0].seat, 'codex', 'the fresh seat should take the work');
  assert.match(ranked[0].why, /95% fuel/);
  assert.match(ranked[1].why, /nearly empty/);
});

test('free local seats sort forward — using them is how metered seats are saved', () => {
  const ranked = levelCandidates([
    { seat: 'claude', rank: 0, costClass: 'subscription' },
    { seat: 'ollama_coder', rank: 1, costClass: 'local' },
  ], { claude: { seat: 'claude', basis: 'configured', percentRemaining: 20, hoursToEmpty: 2 } });
  assert.equal(ranked[0].seat, 'ollama_coder');
  assert.equal(ranked[0].stress, 0, 'a free seat carries no stress penalty');
});

test('levelling nudges rather than scrambles: a healthy fleet keeps router order', () => {
  const gauges = {
    a: { seat: 'a', basis: 'configured', percentRemaining: 90, hoursToEmpty: 30 },
    b: { seat: 'b', basis: 'configured', percentRemaining: 85, hoursToEmpty: 28 },
  };
  const ranked = levelCandidates([{ seat: 'a', rank: 0, costClass: 'subscription' }, { seat: 'b', rank: 1, costClass: 'subscription' }], gauges);
  assert.equal(ranked[0].seat, 'a', 'a small fuel difference must not override the router');
});

test('a stressed seat downgrades one tier — never more, never below utility', () => {
  const stressed = { seat: 'claude', basis: 'configured', percentRemaining: 10, hoursToEmpty: 0.5 };
  const r = suggestTierAdjustment({ tier: 'complex', gauge: stressed });
  assert.equal(r.tier, 'standard');
  assert.equal(r.changed, true);
  assert.match(r.reason, /10% remaining/);

  const floor = suggestTierAdjustment({ tier: 'utility', gauge: stressed });
  assert.equal(floor.changed, false, 'utility is the floor');
});

test('high-stakes and explicitly requested work are never downgraded to save budget', () => {
  const empty = { seat: 'claude', basis: 'configured', percentRemaining: 2, hoursToEmpty: 0.1 };
  assert.equal(suggestTierAdjustment({ tier: 'critical', gauge: empty }).changed, false);
  assert.equal(suggestTierAdjustment({ tier: 'complex', gauge: empty, highStakes: true }).changed, false);
  const explicit = suggestTierAdjustment({ tier: 'complex', gauge: empty, explicitProvider: true });
  assert.equal(explicit.changed, false);
  assert.match(explicit.reason, /explicitly requested/);
});

test('a comfortable seat is not downgraded', () => {
  const healthy = { seat: 'claude', basis: 'configured', percentRemaining: 80, hoursToEmpty: 20 };
  assert.equal(suggestTierAdjustment({ tier: 'complex', gauge: healthy }).changed, false);
});

test('fleet balance names which seat to shift work away from', () => {
  const uneven = fleetBalance({
    claude: { seat: 'claude', basis: 'configured', percentRemaining: 10 },
    codex:  { seat: 'codex',  basis: 'configured', percentRemaining: 90 },
  });
  assert.equal(uneven.balanced, false);
  assert.equal(uneven.spread, 80);
  assert.equal(uneven.mostDrained, 'claude');
  assert.equal(uneven.freshest, 'codex');
  assert.match(uneven.advice, /shift work from claude/);

  const even = fleetBalance({
    a: { seat: 'a', basis: 'configured', percentRemaining: 70 },
    b: { seat: 'b', basis: 'configured', percentRemaining: 62 },
  });
  assert.equal(even.balanced, true);
  assert.equal(even.advice, null);
});

test('unmetered seats are excluded from balance — they cannot be drained', () => {
  const b = fleetBalance({
    ollama: { seat: 'ollama', basis: 'unmetered', percentRemaining: 100 },
    claude: { seat: 'claude', basis: 'configured', percentRemaining: 20 },
  });
  assert.equal(b.seats, 1, 'only metered seats count toward balance');
  assert.equal(b.balanced, true, 'a single metered seat cannot be unbalanced against itself');
});

test('stress rises on low fuel OR fast burn, not only on low fuel', () => {
  assert.ok(stressOf({ basis: 'configured', percentRemaining: 95, hoursToEmpty: 0.5 }) >= 0.9,
    'emptying within the hour is stressful even at 95%');
  assert.equal(stressOf({ basis: 'unmetered', percentRemaining: 0 }), 0, 'free seats are never stressed');
});

test('cooling seats are made unavailable to normal route diagnostics', () => {
  const result = applyCooldownsToDiagnostics({
    claude: { found: true, ready: true, detail: 'authenticated' },
    codex: { found: true, ready: true, detail: 'authenticated' },
  }, [{ seat: 'claude', cooling: true, reason: 'rate_limited', remainingSec: 120 }]);
  assert.equal(result.diagnostics.claude.ready, false);
  assert.equal(result.diagnostics.codex.ready, true);
  assert.deepEqual(result.skipped, ['claude']);
});

test('an explicitly requested cooling seat remains available', () => {
  const result = applyCooldownsToDiagnostics(
    { claude: { found: true, ready: true } },
    [{ seat: 'claude', cooling: true, reason: 'rate_limited', remainingSec: 120 }],
    ['claude'],
  );
  assert.equal(result.diagnostics.claude.ready, true);
  assert.deepEqual(result.skipped, []);
});

test('normal route selections are reordered by fuel without widening capability', () => {
  const route = { selected: [{ kind: 'claude', policyScore: 100 }, { kind: 'codex', policyScore: 90 }] };
  const levelled = levelRouteSelection(route, {
    claude: { basis: 'configured', percentRemaining: 2, hoursToEmpty: 0.2 },
    codex: { basis: 'configured', percentRemaining: 95, hoursToEmpty: 30 },
  }, { claude: 'subscription', codex: 'subscription' });
  assert.deepEqual(levelled.selected.map((pick) => pick.kind), ['codex', 'claude']);
  assert.equal(levelled.selected.length, 2, 'levelling must not add providers');
  assert.equal(levelled.selected[0].loadLevelling.originalRank, 1);
});

test('a nearly empty capable seat may move several ranks to preserve remaining quota', () => {
  const candidates = ['a', 'b', 'c', 'd', 'e'].map((seat, rank) => ({ seat, rank, costClass: 'subscription' }));
  const gauges = {
    a: { basis: 'configured', percentRemaining: 1, hoursToEmpty: 0.1 },
    b: { basis: 'configured', percentRemaining: 95, hoursToEmpty: 30 },
    c: { basis: 'configured', percentRemaining: 95, hoursToEmpty: 30 },
    d: { basis: 'configured', percentRemaining: 95, hoursToEmpty: 30 },
    e: { basis: 'configured', percentRemaining: 95, hoursToEmpty: 30 },
  };
  const ranked = levelCandidates(candidates, gauges);
  assert.ok(ranked.find((item) => item.seat === 'a').levelledRank >= 3,
    'capability was already enforced; severe depletion may justify a multi-rank move');
});
