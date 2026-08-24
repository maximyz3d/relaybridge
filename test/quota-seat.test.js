'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildQuotaSeatGroups } = require('../lib/quota-seat');
const { createUsageLedger } = require('../lib/usage-ledger');
const {
  fleetBalance, applyCooldownsToDiagnostics, applyVendorQuotaExhaustionToDiagnostics,
} = require('../lib/load-leveller');

const GROUP = 'subscription:anthropic:default';
const mapping = { claude: GROUP, claude_fable: GROUP, codex: 'codex' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rb-quota-seat-'));

test('quota grouping is explicit and does not infer shared accounts from transport alone', () => {
  const result = buildQuotaSeatGroups({
    claude: { transport: 'subscription:anthropic', quota_seat: GROUP },
    claude_fable: { transport: 'subscription:anthropic', quota_seat: GROUP },
    second_account: { transport: 'subscription:anthropic' },
  });
  assert.deepEqual(result.groups[GROUP].providers, ['claude', 'claude_fable']);
  assert.equal(result.providerToQuotaSeat.second_account, 'second_account');
});

test('Claude aliases share configured fuel and burn while retaining per-model detail', () => {
  const dir = tmp();
  const ledger = createUsageLedger({
    dataDir: dir,
    quotaSeats: mapping,
    budgets: { [GROUP]: { tokensPerDay: 1000 } },
  });
  ledger.record({ seat: 'claude', model: 'opus', costClass: 'subscription', inputTokens: 300, outputTokens: 200 });
  ledger.record({ seat: 'claude_fable', model: 'fable', costClass: 'subscription', inputTokens: 200, outputTokens: 100 });
  const configs = {
    claude: { costClass: 'subscription', model: 'opus', quotaSeat: GROUP, aliases: ['claude', 'claude_fable'] },
    claude_fable: { costClass: 'subscription', model: 'fable', quotaSeat: GROUP, aliases: ['claude', 'claude_fable'] },
  };
  const gauges = ledger.gaugeAll(configs);
  for (const provider of Object.keys(configs)) {
    assert.equal(gauges[provider].quotaSeat, GROUP);
    assert.equal(gauges[provider].used.totalTokens, 800);
    assert.equal(gauges[provider].percentRemaining, 20);
    assert.deepEqual(gauges[provider].aliases, ['claude', 'claude_fable']);
    assert.deepEqual(Object.keys(gauges[provider].models).sort(), ['fable', 'opus']);
  }
  const balance = fleetBalance(gauges);
  assert.equal(balance.seats, 1);
  assert.equal(balance.mostDrained, undefined);
  assert.equal(balance.freshest, undefined);
  assert.deepEqual(balance.quotaSeats[0].aliases, ['claude', 'claude_fable']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('explicit model-scoped vendor quota does not contaminate another alias', () => {
  const dir = tmp();
  let now = Date.parse('2026-08-24T12:00:00Z');
  const ledger = createUsageLedger({ dataDir: dir, quotaSeats: mapping, now: () => now });
  ledger.observeVendorQuota({
    provider: 'claude_fable', model: 'fable', scope: 'model', unit: 'tokens',
    actual: 90, limit: 100, observedAt: new Date(now).toISOString(),
    reset: { expiresAt: new Date(now + 3600000).toISOString() },
  });
  assert.equal(ledger.gauge('claude_fable', { costClass: 'subscription', model: 'fable' }).basis, 'vendor_observed');
  assert.notEqual(ledger.gauge('claude', { costClass: 'subscription', model: 'opus' }).basis, 'vendor_observed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('account-scoped vendor quota is shared across aliases in one quota seat', () => {
  const dir = tmp();
  const now = Date.parse('2026-08-24T12:00:00Z');
  const ledger = createUsageLedger({ dataDir: dir, quotaSeats: mapping, now: () => now });
  ledger.observeVendorQuota({
    provider: 'claude', model: 'opus', scope: 'account', unit: 'tokens', actual: 75, limit: 100,
    observedAt: new Date(now).toISOString(),
    reset: { expiresAt: new Date(now + 3600000).toISOString() },
  });
  for (const provider of ['claude', 'claude_fable']) {
    const gauge = ledger.gauge(provider, { costClass: 'subscription' });
    assert.equal(gauge.basis, 'vendor_observed');
    assert.equal(gauge.percentRemaining, 25);
    assert.equal(gauge.vendorQuota.scope, 'account');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('active account-scoped vendor exhaustion hard-blocks every shared-seat alias with typed reset guidance', () => {
  const dir = tmp();
  const now = Date.parse('2026-08-24T12:00:00Z');
  const ledger = createUsageLedger({ dataDir: dir, quotaSeats: mapping, now: () => now });
  ledger.observeVendorQuota({
    provider: 'claude', model: 'opus', scope: 'account', unit: 'tokens', actual: 101, limit: 100,
    overLimit: true, observedAt: new Date(now).toISOString(),
    reset: { kind: 'vendor_window', expiresAt: new Date(now + 3600000).toISOString() },
  });
  const aliases = ['claude', 'claude_fable'];
  const gauges = ledger.gaugeAll({
    claude: { costClass: 'subscription', model: 'opus', quotaSeat: GROUP, aliases },
    claude_fable: { costClass: 'subscription', model: 'fable', quotaSeat: GROUP, aliases },
    codex: { costClass: 'subscription', quotaSeat: 'codex', aliases: ['codex'] },
  });
  const gated = applyVendorQuotaExhaustionToDiagnostics({
    claude: { found: true, ready: true, detail: 'authenticated' },
    claude_fable: { found: true, ready: true, detail: 'authenticated' },
    codex: { found: true, ready: true, detail: 'authenticated' },
  }, gauges, { now });

  assert.deepEqual(gated.skipped.map((item) => item.kind), aliases);
  for (const provider of aliases) {
    assert.equal(gated.diagnostics[provider].found, true, 'quota does not rewrite install readiness');
    assert.equal(gated.diagnostics[provider].ready, false);
    assert.equal(gated.diagnostics[provider].vendorQuotaExhausted, true);
    const block = gated.diagnostics[provider].vendorQuotaBlock;
    assert.equal(block.reason, 'vendor_quota_exhausted');
    assert.equal(block.authoritative, true);
    assert.equal(block.scope, 'account');
    assert.equal(block.quotaSeat, GROUP);
    assert.deepEqual(block.aliases, aliases);
    assert.equal(block.retry.allowedAfter, new Date(now + 3600000).toISOString());
    assert.equal(block.retry.action, 'use_alternate_quota_seat_until_reset');
  }
  assert.equal(gated.diagnostics.codex.ready, true, 'unaffected readiness is preserved');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('model-scoped exhaustion blocks only its matching alias and becomes eligible after expiry', () => {
  const dir = tmp();
  let now = Date.parse('2026-08-24T12:00:00Z');
  const ledger = createUsageLedger({ dataDir: dir, quotaSeats: mapping, now: () => now });
  ledger.observeVendorQuota({
    provider: 'claude_fable', model: 'fable', scope: 'model', unit: 'tokens', actual: 100, limit: 100,
    overLimit: false, observedAt: new Date(now).toISOString(),
    reset: { kind: 'vendor_window', expiresAt: new Date(now + 3600000).toISOString() },
  });
  const configs = {
    claude: { costClass: 'subscription', model: 'opus', quotaSeat: GROUP, aliases: ['claude', 'claude_fable'] },
    claude_fable: { costClass: 'subscription', model: 'fable', quotaSeat: GROUP, aliases: ['claude', 'claude_fable'] },
  };
  const diagnostics = {
    claude: { found: true, ready: true },
    claude_fable: { found: true, ready: true },
    already_unready: { found: true, ready: false, detail: 'signed out' },
  };
  let gated = applyVendorQuotaExhaustionToDiagnostics(diagnostics, ledger.gaugeAll(configs), { now });
  assert.deepEqual(gated.skipped.map((item) => item.kind), ['claude_fable']);
  assert.equal(gated.diagnostics.claude.ready, true);
  assert.equal(gated.diagnostics.claude_fable.ready, false);
  assert.equal(gated.diagnostics.already_unready.ready, false, 'existing readiness failures remain failures');

  now += 3600001;
  gated = applyVendorQuotaExhaustionToDiagnostics(diagnostics, ledger.gaugeAll(configs), { now });
  assert.deepEqual(gated.skipped, []);
  assert.equal(gated.diagnostics.claude_fable.ready, true, 'routing resumes automatically after vendor expiry');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('one operator observation is shared by every alias while model vendor evidence keeps precedence', () => {
  const dir = tmp();
  const now = Date.parse('2026-08-24T12:00:00Z');
  const ledger = createUsageLedger({
    dataDir: dir, quotaSeats: mapping, now: () => now,
    budgets: { [GROUP]: { tokensPerDay: 1000 } },
  });
  ledger.observeOperatorQuota({
    quotaSeat: GROUP, percentRemaining: 4, source: 'operator_reported',
    provenance: 'human_account_owner', observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3600000).toISOString(),
  });
  ledger.observeVendorQuota({
    provider: 'claude_fable', model: 'fable', scope: 'model', unit: 'tokens',
    actual: 90, limit: 100, observedAt: new Date(now).toISOString(),
    reset: { expiresAt: new Date(now + 3600000).toISOString() },
  });
  const claude = ledger.gauge('claude', { costClass: 'subscription', model: 'opus' });
  const fable = ledger.gauge('claude_fable', { costClass: 'subscription', model: 'fable' });
  assert.equal(claude.basis, 'operator_observed');
  assert.equal(claude.percentRemaining, 4);
  assert.equal(fable.basis, 'vendor_observed');
  assert.equal(fable.percentRemaining, 10);
  assert.equal(fable.vendorQuota.scope, 'model');
  assert.equal(fable.operatorQuota.quotaSeat, GROUP, 'operator evidence remains disclosed even when vendor evidence wins');
  assert.ok(ledger.clearOperatorQuota(GROUP));
  assert.equal(ledger.activeOperatorQuota(GROUP), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a shared cooldown blocks every alias except the explicitly requested provider', () => {
  const diagnostics = {
    claude: { found: true, ready: true },
    claude_fable: { found: true, ready: true },
    codex: { found: true, ready: true },
  };
  const cooling = [{
    seat: GROUP, quotaSeat: GROUP, aliases: ['claude', 'claude_fable'],
    cooling: true, reason: 'rate_limited', remainingSec: 60,
  }];
  const normal = applyCooldownsToDiagnostics(diagnostics, cooling);
  assert.equal(normal.diagnostics.claude.ready, false);
  assert.equal(normal.diagnostics.claude_fable.ready, false);
  assert.deepEqual(normal.skipped.sort(), ['claude', 'claude_fable']);

  const explicit = applyCooldownsToDiagnostics(diagnostics, cooling, ['claude_fable']);
  assert.equal(explicit.diagnostics.claude.ready, false);
  assert.equal(explicit.diagnostics.claude_fable.ready, true);
  assert.deepEqual(explicit.skipped, ['claude']);
});
