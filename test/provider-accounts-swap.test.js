'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('../lib/provider-accounts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rb-swap-'));
const CLAUDE = {
  label: 'Claude Code',
  quota_seat: 'subscription:anthropic:default',
  credential_env: 'CLAUDE_CONFIG_DIR',
  credential_markers: ['.credentials.json'],
};
const CODEX = {
  label: 'Codex',
  quota_seat: 'codex',
  credential_env: 'CODEX_HOME',
  credential_markers: ['auth.json'],
};

// Sign an account in the only way that matters to this module: put a non-empty
// credential marker in the directory it owns.
function signIn(dir, kind, id, entry) {
  const target = A.accountDir(dir, kind, id);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(target, entry.credential_markers[0]), '{"token":"x"}');
  return target;
}

function pool(dir) {
  A.addAccount(dir, 'claude', { id: 'work', label: 'Work plan' });
  A.addAccount(dir, 'claude', { id: 'personal', label: 'Personal plan' });
  signIn(dir, 'claude', 'work', CLAUDE);
  signIn(dir, 'claude', 'personal', CLAUDE);
  return A.loadRegistry(dir);
}

test('a pristine seat reports automatic selection and no pinned provider', () => {
  const dir = tmp();
  const registry = A.loadRegistry(dir);
  assert.equal(A.activeAccountIdFor('claude', registry), null);
  assert.equal(A.activeProviderOf(registry), null);
  // The implicit default reads as active because it is the only account there is.
  assert.equal(A.accountsFor('claude', CLAUDE, registry)[0].active, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('swapping to another plan on the same AI pins that account and that provider', () => {
  const dir = tmp();
  pool(dir);
  const swap = A.swapSeat(dir, { kind: 'claude', accountId: 'work', entry: CLAUDE });
  assert.equal(swap.accountId, 'work');
  assert.equal(swap.activeProvider, 'claude');
  assert.equal(swap.previous.accountId, null);
  const registry = A.loadRegistry(dir);
  assert.equal(A.activeAccountIdFor('claude', registry), 'work');
  const accounts = A.accountsFor('claude', CLAUDE, registry);
  assert.deepEqual(accounts.filter((a) => a.active).map((a) => a.id), ['work']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('swapping to a different AI moves the provider pin without touching its account pin', () => {
  const dir = tmp();
  pool(dir);
  A.swapSeat(dir, { kind: 'claude', accountId: 'work', entry: CLAUDE });
  const swap = A.swapSeat(dir, { kind: 'codex', entry: CODEX });
  assert.equal(swap.activeProvider, 'codex');
  assert.equal(swap.accountId, null, 'codex was never pinned to a specific account');
  const registry = A.loadRegistry(dir);
  assert.equal(A.activeProviderOf(registry), 'codex');
  assert.equal(A.activeAccountIdFor('claude', registry), 'work', 'the Claude pin must survive an AI swap');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setProvider:false pins the account without changing which AI runs unqualified work', () => {
  const dir = tmp();
  pool(dir);
  A.swapSeat(dir, { kind: 'codex', entry: CODEX });
  const swap = A.swapSeat(dir, { kind: 'claude', accountId: 'personal', entry: CLAUDE, setProvider: false });
  assert.equal(swap.accountId, 'personal');
  assert.equal(swap.activeProvider, 'codex');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('accountId null returns a seat to automatic least-drained selection', () => {
  const dir = tmp();
  pool(dir);
  A.swapSeat(dir, { kind: 'claude', accountId: 'work', entry: CLAUDE });
  const swap = A.swapSeat(dir, { kind: 'claude', accountId: null, entry: CLAUDE });
  assert.equal(swap.accountId, null);
  assert.equal(swap.previous.accountId, 'work');
  assert.equal(A.activeAccountIdFor('claude', A.loadRegistry(dir)), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('swapping onto an unknown or disabled plan is refused before anything is written', () => {
  const dir = tmp();
  pool(dir);
  assert.throws(() => A.swapSeat(dir, { kind: 'claude', accountId: 'nope', entry: CLAUDE }), /unknown account/);
  A.setAccountEnabled(dir, 'claude', 'personal', false);
  assert.throws(() => A.swapSeat(dir, { kind: 'claude', accountId: 'personal', entry: CLAUDE }), /disabled/);
  assert.equal(A.activeProviderOf(A.loadRegistry(dir)), null, 'a refused swap must not pin the provider either');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the pin wins over the least-drained account whenever it can take work', () => {
  const dir = tmp();
  const registry = pool(dir);
  const gauges = {
    'subscription:anthropic:default#work': { quotaSeat: 'subscription:anthropic:default#work', percentRemaining: 11 },
    'subscription:anthropic:default#personal': { quotaSeat: 'subscription:anthropic:default#personal', percentRemaining: 96 },
  };
  // Without a pin, load levelling takes the fresher plan.
  assert.equal(A.selectAccount({ kind: 'claude', entry: CLAUDE, registry, dataDir: dir, gauges }).id, 'personal');
  // With one, the operator's choice wins even though it is nearly drained.
  assert.equal(A.selectAccount({
    kind: 'claude', entry: CLAUDE, registry, dataDir: dir, gauges, preferredAccountId: 'work',
  }).id, 'work');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the pin is soft: an unusable pinned plan falls through instead of failing', () => {
  const dir = tmp();
  const registry = pool(dir);
  A.setAccountEnabled(dir, 'claude', 'work', false);
  const after = A.loadRegistry(dir);
  const picked = A.selectAccount({
    kind: 'claude', entry: CLAUDE, registry: after, dataDir: dir, preferredAccountId: 'work',
  });
  assert.ok(picked, 'a disabled pin must not strand the seat');
  assert.notEqual(picked.id, 'work', 'a disabled account is never dispatched to');
  // A pin naming an account that was never signed in behaves the same way.
  A.addAccount(dir, 'claude', { id: 'unsigned', label: 'never signed in' });
  const picked2 = A.selectAccount({
    kind: 'claude', entry: CLAUDE, registry: A.loadRegistry(dir), dataDir: dir, preferredAccountId: 'unsigned',
  });
  assert.ok(picked2);
  assert.notEqual(picked2.id, 'unsigned', 'an account with no credentials is never dispatched to');
  assert.ok(registry, 'registry loaded');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a pin never resurrects a cooling or quota-blocked plan', () => {
  const dir = tmp();
  pool(dir);
  A.swapSeat(dir, { kind: 'claude', accountId: 'work', entry: CLAUDE });
  const registry = A.loadRegistry(dir);
  // Cool everything except the one plan that should absorb the work, so the
  // fallback target is unambiguous.
  const picked = A.selectAccount({
    kind: 'claude', entry: CLAUDE, registry, dataDir: dir,
    coolingQuotaSeats: new Set([
      'subscription:anthropic:default#work',
      'subscription:anthropic:default',
    ]),
    preferredAccountId: 'work',
  });
  assert.equal(picked.id, 'personal', 'cooling is a hard filter the pin cannot cross');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('disabling the pinned account releases the pin in the same write', () => {
  const dir = tmp();
  pool(dir);
  A.swapSeat(dir, { kind: 'claude', accountId: 'work', entry: CLAUDE });
  A.setAccountEnabled(dir, 'claude', 'work', false);
  assert.equal(A.activeAccountIdFor('claude', A.loadRegistry(dir)), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('removing the pinned account cannot leave the registry unreadable', () => {
  const dir = tmp();
  pool(dir);
  A.swapSeat(dir, { kind: 'claude', accountId: 'work', entry: CLAUDE });
  A.removeAccount(dir, 'claude', 'work');
  // A dangling pin would make every strict load throw, which disables dispatch
  // entirely: losing the swap is acceptable, losing the bridge is not.
  const registry = A.loadRegistry(dir, { strict: true });
  assert.equal(A.activeAccountIdFor('claude', registry), null);
  assert.equal(A.activeProviderOf(registry), 'claude', 'the provider pin is still valid and stays');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a hand-edited registry pinning a missing account fails the load closed', () => {
  const dir = tmp();
  pool(dir);
  const file = path.join(dir, 'accounts.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  registry.providers.claude.active = 'ghost';
  fs.writeFileSync(file, JSON.stringify(registry));
  assert.throws(() => A.loadRegistry(dir, { strict: true }), /pins a missing active account/);
  registry.providers.claude.active = 'NOT VALID';
  fs.writeFileSync(file, JSON.stringify(registry));
  assert.throws(() => A.loadRegistry(dir, { strict: true }), /invalid active account id/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an invalid activeProvider fails the load rather than redirecting dispatch', () => {
  const dir = tmp();
  pool(dir);
  const file = path.join(dir, 'accounts.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  registry.activeProvider = 'Not A Key';
  fs.writeFileSync(file, JSON.stringify(registry));
  assert.throws(() => A.loadRegistry(dir, { strict: true }), /invalid activeProvider/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a provider pinned with no row of its own is still a legal swap', () => {
  const dir = tmp();
  pool(dir);
  // codex has no accounts.json row: it runs on its implicit login.
  A.swapSeat(dir, { kind: 'codex', entry: CODEX });
  const registry = A.loadRegistry(dir, { strict: true });
  assert.equal(A.activeProviderOf(registry), 'codex');
  assert.equal(A.activeAccountIdFor('codex', registry), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pinning the existing sign-in materializes a row without changing its identity', () => {
  const dir = tmp();
  A.swapSeat(dir, { kind: 'claude', accountId: 'default', entry: CLAUDE });
  const registry = A.loadRegistry(dir, { strict: true });
  const accounts = A.accountsFor('claude', CLAUDE, registry);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, 'default');
  assert.equal(accounts[0].implicit, true, 'default must stay implicit or it would read an empty credential dir');
  assert.equal(accounts[0].quotaSeat, 'subscription:anthropic:default', 'the ledger identity must not move');
  assert.deepEqual(A.envForAccount({ entry: CLAUDE, account: accounts[0], dataDir: dir, kind: 'claude' }), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('clearing the provider pin hands seat choice back to the router', () => {
  const dir = tmp();
  pool(dir);
  A.swapSeat(dir, { kind: 'claude', accountId: 'work', entry: CLAUDE });
  assert.deepEqual(A.clearActiveProvider(dir), { activeProvider: null, cleared: true });
  const registry = A.loadRegistry(dir, { strict: true });
  assert.equal(A.activeProviderOf(registry), null);
  assert.equal(A.activeAccountIdFor('claude', registry), 'work', 'only the provider pin is cleared');
  assert.deepEqual(A.clearActiveProvider(dir), { activeProvider: null, cleared: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('each linked plan keeps its own credential directory and quota seat', () => {
  const dir = tmp();
  const registry = pool(dir);
  const accounts = A.accountsFor('claude', CLAUDE, registry);
  const seats = accounts.map((a) => a.quotaSeat);
  assert.equal(new Set(seats).size, seats.length, 'pooled usage would make the gauges lie');
  const work = accounts.find((a) => a.id === 'work');
  const personal = accounts.find((a) => a.id === 'personal');
  const envWork = A.envForAccount({ entry: CLAUDE, account: work, dataDir: dir, kind: 'claude' });
  const envPersonal = A.envForAccount({ entry: CLAUDE, account: personal, dataDir: dir, kind: 'claude' });
  assert.notEqual(envWork.CLAUDE_CONFIG_DIR, envPersonal.CLAUDE_CONFIG_DIR);
  assert.equal(envWork.CLAUDE_CONFIG_DIR, A.accountDir(dir, 'claude', 'work'));
  fs.rmSync(dir, { recursive: true, force: true });
});
