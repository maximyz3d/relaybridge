'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildQuotaSeatGroups } = require('../lib/quota-seat');
const { createUsageLedger } = require('../lib/usage-ledger');
const { fleetBalance, applyCooldownsToDiagnostics } = require('../lib/load-leveller');

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
