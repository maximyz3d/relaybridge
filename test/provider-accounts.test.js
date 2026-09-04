'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('../lib/provider-accounts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rb-accounts-'));
const CLAUDE = {
  label: 'Claude Code',
  quota_seat: 'subscription:anthropic:default',
  credential_env: 'CLAUDE_CONFIG_DIR',
  credential_markers: ['.credentials.json'],
};
const COPILOT = {
  label: 'GitHub Copilot CLI',
  quota_seat: 'subscription:github-copilot',
  credential_env: 'COPILOT_HOME',
  credential_aux_env: ['GH_CONFIG_DIR'],
  credential_markers: ['config.json'],
  linked_account_args: ['--no-auto-login'],
};

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

test('Copilot linked accounts isolate auxiliary GitHub auth and disable auto-login', () => {
  const dir = tmp();
  A.addAccount(dir, 'copilot', { id: 'work' });
  const work = A.accountsFor('copilot', COPILOT, A.loadRegistry(dir)).find((a) => a.id === 'work');
  const credentialDir = path.join(dir, 'accounts', 'copilot', 'work');
  assert.deepEqual(A.envForAccount({ entry: COPILOT, account: work, dataDir: dir, kind: 'copilot' }), {
    COPILOT_HOME: credentialDir,
    GH_CONFIG_DIR: credentialDir,
  });
  assert.deepEqual(A.linkedAccountArgsFor(COPILOT), ['--no-auto-login']);
  assert.throws(() => A.credentialAuxEnvsFor({
    ...COPILOT, credential_aux_env: ['GH_CONFIG_DIR', 'GH_CONFIG_DIR'],
  }), /invalid or duplicate/);
  assert.throws(() => A.linkedAccountArgsFor({ linked_account_args: ['{prompt}'] }), /non-placeholder/);
  const unsupported = { ...COPILOT, linked_accounts_supported: false };
  assert.equal(A.supportsLinkedAccounts(unsupported), false);
  assert.equal(A.accountIsProvisioned({ entry: unsupported, account: work, dataDir: dir, kind: 'copilot' }), false);
  assert.throws(() => A.envForAccount({ entry: unsupported, account: work, dataDir: dir, kind: 'copilot' }),
    /does not support attribution-safe linked accounts/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a seat whose CLI cannot relocate its credentials never gets an env overlay', () => {
  const dir = tmp();
  const noEnv = { quota_seat: 'grok', label: 'Grok' }; // no credential_env
  A.addAccount(dir, 'grok', { id: 'second' });
  const second = A.accountsFor('grok', noEnv, A.loadRegistry(dir)).find((a) => a.id === 'second');
  assert.throws(() => A.envForAccount({ entry: noEnv, account: second, dataDir: dir, kind: 'grok' }),
    /does not support attribution-safe linked accounts/);
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

test('selection fails closed when every provisioned account is cooling', () => {
  const dir = tmp();
  A.addAccount(dir, 'claude', { id: 'work' });
  const registry = A.loadRegistry(dir);
  fs.mkdirSync(path.join(dir, 'accounts', 'claude', 'work'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'accounts', 'claude', 'work', '.credentials.json'), '{}');
  const picked = A.selectAccount({
    kind: 'claude', entry: CLAUDE, registry, dataDir: dir, gauges: {},
    coolingQuotaSeats: new Set([
      'subscription:anthropic:default',
      'subscription:anthropic:default#work',
    ]),
  });
  assert.equal(picked, null, 'an exhausted pool must not silently use a cooling account');
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

test('a live auth failure quarantines a managed default until positive evidence clears it', () => {
  const dir = tmp();
  A.addAccount(dir, 'claude', { id: 'work' });
  const workDir = path.join(dir, 'accounts', 'claude', 'work');
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, '.credentials.json'), '{}');

  A.noteAccountAuthFailure(dir, 'claude', 'default', CLAUDE);
  let registry = A.loadRegistry(dir, { strict: true });
  const failedDefault = A.accountsFor('claude', CLAUDE, registry).find((account) => account.id === 'default');
  assert.equal(failedDefault.authFailureMarker, A.DEFAULT_AUTH_FAILURE_MARKER);
  assert.equal(A.accountAuthAvailable({ entry: CLAUDE, account: failedDefault, dataDir: dir, kind: 'claude' }), false);
  assert.equal(A.selectAccount({ kind: 'claude', entry: CLAUDE, registry, dataDir: dir }).id, 'work');

  A.clearAccountAuthFailure(dir, 'claude', 'default');
  registry = A.loadRegistry(dir, { strict: true });
  assert.equal(A.selectAccount({ kind: 'claude', entry: CLAUDE, registry, dataDir: dir }).id, 'default');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a first auth failure materializes and durably quarantines a pristine implicit default', () => {
  const dir = tmp();
  assert.equal(A.accountsFor('claude', CLAUDE, A.loadRegistry(dir))[0].implicit, true);
  const failed = A.noteAccountAuthFailure(dir, 'claude', 'default', CLAUDE);
  assert.equal(failed.accountId, 'default');
  const registry = A.loadRegistry(dir, { strict: true });
  const account = A.accountsFor('claude', CLAUDE, registry)[0];
  assert.equal(account.implicit, true);
  assert.equal(account.authFailureMarker, A.DEFAULT_AUTH_FAILURE_MARKER);
  assert.equal(A.accountAuthAvailable({ entry: CLAUDE, account, dataDir: dir, kind: 'claude' }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('non-credential artifacts do not make a cancelled sign-in selectable', () => {
  const dir = tmp();
  A.addAccount(dir, 'claude', { id: 'work' });
  A.setAccountEnabled(dir, 'claude', 'default', false);
  const accountDir = path.join(dir, 'accounts', 'claude', 'work');
  fs.mkdirSync(accountDir, { recursive: true });
  fs.writeFileSync(path.join(accountDir, 'debug.log'), 'oauth cancelled');
  const picked = A.selectAccount({
    kind: 'claude', entry: CLAUDE, registry: A.loadRegistry(dir), dataDir: dir, gauges: {},
  });
  assert.equal(picked, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('null fuel is unknown and does not outrank an observed empty account', () => {
  const dir = tmp();
  A.addAccount(dir, 'claude', { id: 'work' });
  const registry = A.loadRegistry(dir);
  const accountDir = path.join(dir, 'accounts', 'claude', 'work');
  fs.mkdirSync(accountDir, { recursive: true });
  fs.writeFileSync(path.join(accountDir, '.credentials.json'), '{}');
  const picked = A.selectAccount({
    kind: 'claude', entry: CLAUDE, registry, dataDir: dir,
    gauges: {
      'subscription:anthropic:default': { percentRemaining: null },
      'subscription:anthropic:default#work': { percentRemaining: 0 },
    },
  });
  assert.equal(picked.id, 'work', 'a real measurement outranks an unknown estimate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('authoritative vendor exhaustion is never selected or bypassed as a cooldown override', () => {
  const dir = tmp();
  A.addAccount(dir, 'claude', { id: 'work' });
  const registry = A.loadRegistry(dir);
  const accountDir = path.join(dir, 'accounts', 'claude', 'work');
  fs.mkdirSync(accountDir, { recursive: true });
  fs.writeFileSync(path.join(accountDir, '.credentials.json'), '{}');
  const exhausted = {
    basis: 'vendor_observed', remaining: 0,
    vendorQuota: { actual: 100, limit: 100 },
  };
  let picked = A.selectAccount({
    kind: 'claude', entry: CLAUDE, registry, dataDir: dir,
    gauges: {
      'subscription:anthropic:default': exhausted,
      'subscription:anthropic:default#work': { percentRemaining: null },
    },
  });
  assert.equal(picked.id, 'work');
  picked = A.selectAccount({
    kind: 'claude', entry: CLAUDE, registry, dataDir: dir,
    gauges: {
      'subscription:anthropic:default': exhausted,
      'subscription:anthropic:default#work': exhausted,
    },
    allowCoolingFallback: true,
  });
  assert.equal(picked, null);
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
  assert.throws(() => A.addAccount(dir, 'claude', { id: 'default' }), /reserved/);
  for (const id of ['Work', 'work.', 'con', 'nul.txt']) {
    assert.throws(() => A.addAccount(dir, 'claude', { id }), /account id/, id);
  }
  A.addAccount(dir, 'claude', { id: 'work-2.prod_x' });
  assert.ok(A.loadRegistry(dir).providers.claude.accounts.some((a) => a.id === 'work-2.prod_x'));
  assert.throws(() => A.addAccount(dir, 'claude', { id: 'work-2.prod_x' }), /already exists/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('managed-empty account pools stay empty instead of resurrecting default credentials', () => {
  const dir = tmp();
  A.addAccount(dir, 'claude', { id: 'work' });
  A.removeAccount(dir, 'claude', 'default');
  A.removeAccount(dir, 'claude', 'work');
  const tombstone = A.loadRegistry(dir, { strict: true });
  assert.deepEqual(tombstone.providers.claude.accounts, []);
  assert.deepEqual(A.accountsFor('claude', CLAUDE, tombstone), []);
  assert.equal(A.selectAccount({
    kind: 'claude', entry: CLAUDE, registry: tombstone, dataDir: dir,
  }), null);
  A.addAccount(dir, 'claude', { id: 'spare' });
  assert.deepEqual(A.accountsFor('claude', CLAUDE, A.loadRegistry(dir)).map((account) => account.id), ['spare'],
    'adding after a tombstone must not silently re-enable default');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('strict registry validation preserves malformed authority data byte-for-byte', () => {
  const dir = tmp();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'accounts.json');
  for (const malformed of [
    '{ not json',
    JSON.stringify({ providers: { claude: { accounts: 'oops' } } }),
    JSON.stringify({ providers: { claude: { accounts: [{ id: '../escape' }] } } }),
  ]) {
    fs.writeFileSync(file, malformed, 'utf8');
    assert.throws(() => A.loadRegistry(dir, { strict: true }), /account registry/);
    assert.throws(() => A.addAccount(dir, 'claude', { id: 'work' }), /account registry/);
    assert.equal(fs.readFileSync(file, 'utf8'), malformed);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('strict reads fail closed when an initialized account registry disappears', () => {
  const dir = tmp();
  assert.deepEqual(A.loadRegistry(dir, { strict: true }), { providers: {} },
    'an actually pristine install retains the legacy implicit-default behavior');
  A.addAccount(dir, 'claude', { id: 'work' });
  assert.equal(fs.readFileSync(path.join(dir, 'accounts.initialized'), 'utf8'), '1\n');
  fs.rmSync(path.join(dir, 'accounts.json'));
  assert.throws(() => A.loadRegistry(dir, { strict: true }), /registry is missing.*initialized/);
  assert.throws(() => A.addAccount(dir, 'claude', { id: 'spare' }), /registry is missing.*initialized/,
    'a mutation must not recreate an empty registry and resurrect default');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('provider paths and sign-in instructions are portable and safely quoted', () => {
  const dir = tmp();
  assert.throws(() => A.accountDir(dir, '../usage', 'victim'), /provider key/);
  assert.equal(
    A.formatSignInCommand({
      envName: 'CLAUDE_CONFIG_DIR', credentialDir: "/tmp/Relay Bridge/o'hare", argv: ['claude', '/login'], platform: 'linux',
    }),
    "CLAUDE_CONFIG_DIR='/tmp/Relay Bridge/o'\"'\"'hare' 'claude' '/login'",
  );
  assert.equal(
    A.formatSignInCommand({
      envName: 'CLAUDE_CONFIG_DIR', credentialDir: "C:\\Relay Bridge\\O'Hare", argv: ['claude', '/login'], platform: 'win32',
    }),
    "$env:CLAUDE_CONFIG_DIR = 'C:\\Relay Bridge\\O''Hare'; & 'claude' '/login'",
  );
  assert.equal(
    A.formatSignInCommand({
      environment: { COPILOT_HOME: '/tmp/copilot work', GH_CONFIG_DIR: '/tmp/copilot work' },
      argv: ['copilot', 'login'], platform: 'linux',
    }),
    "COPILOT_HOME='/tmp/copilot work' GH_CONFIG_DIR='/tmp/copilot work' 'copilot' 'login'",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
