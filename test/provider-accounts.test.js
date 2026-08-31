'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('../lib/provider-accounts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rb-accounts-'));
const CLAUDE = { label: 'Claude Code', quota_seat: 'subscription:anthropic:default', credential_env: 'CLAUDE_CONFIG_DIR' };

test('a seat with no configured accounts is unchanged: one implicit account, no env injected', () => {
  const dir = tmp();
  const registry = A.loadRegistry(dir);
  const accounts = A.accountsFor('claude', CLAUDE, registry);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, 'default');
  assert.equal(accounts[0].implicit, true);
  // The quotaSeat must stay byte-identical or existing ledger rows stop matching.
  assert.equal(accounts[0].quotaSeat, 'subscription:anthropic:default');
  assert.deepEqual(A.envForAccount({ entry: CLAUDE, account: accounts[0], dataDir: dir, kind: 'claude' }), {});
  assert.equal(A.hasMultipleAccounts('claude', CLAUDE, registry), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('adding a second account preserves the existing sign-in as an addressable default', () => {
  const dir = tmp();
  A.addAccount(dir, 'claude', { id: 'work', label: 'Work plan' });
  const accounts = A.accountsFor('claude', CLAUDE, A.loadRegistry(dir));
  assert.deepEqual(accounts.map((a) => a.id), ['default', 'work']);
  // Without this the operator's current login would become unreachable the
  // moment they added a second plan.
  assert.equal(accounts[0].quotaSeat, 'subscription:anthropic:default');
  assert.equal(accounts[1].quotaSeat, 'subscription:anthropic:default#work');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('each account gets its own credential directory, created 0700', () => {
  const dir = tmp();
  A.addAccount(dir, 'claude', { id: 'work' });
  const work = A.accountsFor('claude', CLAUDE, A.loadRegistry(dir)).find((a) => a.id === 'work');
  const env = A.envForAccount({ entry: CLAUDE, account: work, dataDir: dir, kind: 'claude' });
  assert.equal(Object.keys(env).length, 1);
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join(dir, 'accounts', 'claude', 'work'));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(env.CLAUDE_CONFIG_DIR).mode & 0o777, 0o700, 'credential dirs hold live session tokens');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a seat whose CLI cannot relocate its credentials never gets an env overlay', () => {
  const dir = tmp();
  const noEnv = { quota_seat: 'grok', label: 'Grok' }; // no credential_env
  A.addAccount(dir, 'grok', { id: 'second' });
  const second = A.accountsFor('grok', noEnv, A.loadRegistry(dir)).find((a) => a.id === 'second');
  assert.deepEqual(A.envForAccount({ entry: noEnv, account: second, dataDir: dir, kind: 'grok' }), {});
  // ...and it must not be selectable, or the run would silently execute on the
  // operator's only account while being billed to a different quotaSeat.
  assert.equal(A.accountIsProvisioned({ entry: noEnv, account: second, dataDir: dir, kind: 'grok' }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('selection prefers the account with the most quota left', () => {
  const dir = tmp();
  A.addAccount(dir, 'claude', { id: 'work' });
  A.addAccount(dir, 'claude', { id: 'spare' });
  const registry = A.loadRegistry(dir);
  for (const id of ['default', 'work', 'spare']) {
    fs.mkdirSync(path.join(dir, 'accounts', 'claude', id), { recursive: true });
    fs.writeFileSync(path.join(dir, 'accounts', 'claude', id, '.credentials.json'), '{}');
  }
  const gauges = {
    'subscription:anthropic:default': { percentRemaining: 12 },
    'subscription:anthropic:default#work': { percentRemaining: 88 },
    'subscription:anthropic:default#spare': { percentRemaining: 40 },
  };
  const picked = A.selectAccount({ kind: 'claude', entry: CLAUDE, registry, dataDir: dir, gauges });
  assert.equal(picked.id, 'work');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a cooling account is skipped even when it has the most quota left', () => {
  const dir = tmp();
  A.addAccount(dir, 'claude', { id: 'work' });
  const registry = A.loadRegistry(dir);
  for (const id of ['default', 'work']) {
    fs.mkdirSync(path.join(dir, 'accounts', 'claude', id), { recursive: true });
    fs.writeFileSync(path.join(dir, 'accounts', 'claude', id, '.credentials.json'), '{}');
  }
  const gauges = {
    'subscription:anthropic:default': { percentRemaining: 5 },
    'subscription:anthropic:default#work': { percentRemaining: 99 },
  };
  const picked = A.selectAccount({
    kind: 'claude', entry: CLAUDE, registry, dataDir: dir, gauges,
    coolingQuotaSeats: new Set(['subscription:anthropic:default#work']),
  });
  // A 429 on the fullest plan must move work to the next one, not fail the seat.
  assert.equal(picked.id, 'default');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an account that was never signed in is not selectable', () => {
  const dir = tmp();
  A.addAccount(dir, 'claude', { id: 'work' });
  const registry = A.loadRegistry(dir);
  fs.mkdirSync(path.join(dir, 'accounts', 'claude', 'work'), { recursive: true }); // empty
  const picked = A.selectAccount({ kind: 'claude', entry: CLAUDE, registry, dataDir: dir, gauges: {} });
  // 'default' is implicit and always provisioned, so it wins over an empty dir.
  assert.equal(picked.id, 'default');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('disabling every account yields null rather than an arbitrary fallback', () => {
  const dir = tmp();
  A.addAccount(dir, 'claude', { id: 'work' });
  A.setAccountEnabled(dir, 'claude', 'default', false);
  A.setAccountEnabled(dir, 'claude', 'work', false);
  const picked = A.selectAccount({ kind: 'claude', entry: CLAUDE, registry: A.loadRegistry(dir), dataDir: dir, gauges: {} });
  // Falling back would run work on a plan the operator explicitly disabled.
  assert.equal(picked, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('forgetting credentials refuses to escape the account namespace', () => {
  const dir = tmp();
  assert.throws(() => A.forgetAccountCredentials(dir, 'claude', '../../../etc'), /invalid account id/);
  assert.throws(() => A.forgetAccountCredentials(dir, 'claude', 'a/b'), /invalid account id/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('account ids are constrained', () => {
  const dir = tmp();
  assert.throws(() => A.addAccount(dir, 'claude', { id: '' }), /account id/);
  assert.throws(() => A.addAccount(dir, 'claude', { id: '../evil' }), /account id/);
  A.addAccount(dir, 'claude', { id: 'work-2.prod_x' });
  assert.ok(A.loadRegistry(dir).providers.claude.accounts.some((a) => a.id === 'work-2.prod_x'));
  assert.throws(() => A.addAccount(dir, 'claude', { id: 'work-2.prod_x' }), /already exists/);
  fs.rmSync(dir, { recursive: true, force: true });
});
