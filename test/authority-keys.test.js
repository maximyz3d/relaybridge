'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const accounts = require('../lib/provider-accounts');
const { createCooldownStore } = require('../lib/provider-cooldown');
const { buildQuotaSeatGroups, validBaseQuotaSeat, validQuotaSeat } = require('../lib/quota-seat');

const HOSTILE_KEYS = ['constructor', 'prototype', '__proto__', 'toString', 'hasOwnProperty'];
const INVALID_KEYS = [...HOSTILE_KEYS, '', '../escape', 'base#work#extra', 7, { toString: () => 'claude' }];
const CLAUDE = { quota_seat: 'subscription:anthropic:default', credential_env: 'CLAUDE_CONFIG_DIR' };
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-authority-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('account authority rejects inherited dictionary keys before any mutation', (t) => {
  const dir = temporary(t);
  const constructorBefore = Object.getOwnPropertyDescriptors(Object);
  const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);
  for (const key of INVALID_KEYS) {
    assert.equal(accounts.validProviderKey(key), false);
    assert.throws(() => accounts.addAccount(dir, key, { id: 'work' }), /invalid provider key/);
    assert.throws(() => accounts.accountsFor(key, CLAUDE, { providers: {} }), /invalid provider key/);
    assert.throws(() => accounts.accountDir(dir, key, 'work'), /invalid provider key/);
  }
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object), constructorBefore);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototypeBefore);
  assert.equal(accounts.validAccountId({ toString: () => 'work' }), false);
  assert.equal(accounts.validAccountId('work.constructor'), true);
});

test('strict account load rejects hostile own JSON keys without rewriting authority bytes', (t) => {
  const dir = temporary(t);
  const file = path.join(dir, 'accounts.json');
  for (const key of HOSTILE_KEYS) {
    const bytes = JSON.stringify({ providers: Object.fromEntries([[key, { accounts: [] }]]) });
    fs.writeFileSync(file, bytes);
    assert.throws(() => accounts.loadRegistry(dir, { strict: true }), /invalid provider/);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.throws(() => accounts.saveRegistry(dir, JSON.parse(bytes)), /invalid provider/);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.equal(Object.getPrototypeOf(accounts.loadRegistry(dir).providers), null);
  }
});

test('normalized account dictionaries preserve pristine defaults and managed-empty tombstones', (t) => {
  const dir = temporary(t);
  assert.equal(Object.getPrototypeOf(accounts.loadRegistry(dir, { strict: true }).providers), null);
  assert.equal(accounts.accountsFor('claude', CLAUDE, accounts.loadRegistry(dir))[0].implicit, true);
  accounts.addAccount(dir, 'claude', { id: 'work.constructor' });
  accounts.removeAccount(dir, 'claude', 'default');
  accounts.removeAccount(dir, 'claude', 'work.constructor');
  const loaded = accounts.loadRegistry(dir, { strict: true });
  assert.equal(Object.getPrototypeOf(loaded.providers), null);
  assert.deepEqual(accounts.accountsFor('claude', CLAUDE, loaded), []);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded)), { providers: { claude: { accounts: [] } } });
});

test('account lookup ignores inherited providers and gauges but rejects own malformed provider rows', (t) => {
  const dir = temporary(t);
  const registry = { providers: Object.create({ claude: { accounts: [] } }) };
  assert.equal(accounts.accountsFor('claude', CLAUDE, registry)[0].implicit, true);
  assert.throws(() => accounts.accountsFor('claude', CLAUDE, { providers: { claude: {} } }), /accounts array/);
  const gauges = Object.create({
    [CLAUDE.quota_seat]: { basis: 'vendor_observed', vendorQuota: {}, remaining: 0 },
  });
  assert.equal(accounts.selectAccount({ kind: 'claude', entry: CLAUDE, registry, dataDir: dir, gauges }).id, 'default');
});

test('quota grouping rejects prototype collisions and keeps linked namespace limits intact', () => {
  for (const key of HOSTILE_KEYS) {
    assert.throws(() => buildQuotaSeatGroups(Object.fromEntries([[key, {}]])), /dictionary key/);
    assert.throws(() => buildQuotaSeatGroups({ claude: { quota_seat: key } }), /dictionary key/);
    assert.equal(validBaseQuotaSeat(key), false);
    assert.equal(validQuotaSeat(`${key}#work`), false);
  }
  const config = Object.create({ inherited: { quota_seat: 'unwanted' } });
  config.claude = CLAUDE;
  const grouping = buildQuotaSeatGroups(config);
  assert.equal(Object.getPrototypeOf(grouping.groups), null);
  assert.equal(Object.getPrototypeOf(grouping.providerToQuotaSeat), null);
  assert.deepEqual(Object.keys(grouping.providerToQuotaSeat), ['claude']);
  assert.equal(validQuotaSeat(`${'a'.repeat(128)}#${'b'.repeat(64)}`), true);
  assert.equal(validQuotaSeat('subscription:anthropic:default#work.constructor'), true);
});

test('cooldown public operations reject hostile keys without file, state or prototype mutation', (t) => {
  const dir = temporary(t);
  const file = path.join(dir, 'cooldowns.json');
  const store = createCooldownStore({ file, now: () => 1000 });
  const before = Object.getOwnPropertyDescriptors(Object.prototype);
  for (const seat of INVALID_KEYS) {
    for (const operation of [
      () => store.noteFailure(seat, 'rate_limited'), () => store.noteFailure(seat, 'ok'),
      () => store.noteSuccess(seat), () => store.status(seat), () => store.filterCandidates([seat]),
    ]) assert.throws(operation, { code: 'invalid_quota_seat' });
  }
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(Object.keys(store._state()), []);
  assert.equal(Object.getPrototypeOf(store._state()), null);
  assert.equal(Object.getPrototypeOf(store.all()), null);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
});

test('cooldown startup and refresh normalize own keys and reject malformed numeric clocks', (t) => {
  const dir = temporary(t);
  const file = path.join(dir, 'cooldowns.json');
  const good = { until: 9000, lastOffenceAt: 1000, offences: 1, reason: 'rate_limited', source: 'backoff' };
  const raw = Object.fromEntries(HOSTILE_KEYS.map((key) => [key, good]));
  Object.assign(raw, {
    claude: { ...good, untrustedExtra: 'must not persist' },
    negative: { ...good, until: -1 }, string: { ...good, until: '9000' },
    fractional: { ...good, offences: 1.5 }, missing: {},
  });
  fs.writeFileSync(file, JSON.stringify(raw));
  const store = createCooldownStore({ file, now: () => 2000 });
  assert.deepEqual(Object.keys(store._state()), ['claude']);
  assert.equal(store.status('claude').cooling, true);
  assert.equal(Object.hasOwn(store._state().claude, 'untrustedExtra'), false);
  raw.codex = { ...good, lastOffenceAt: 3000 };
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(store.status('codex').cooling, true);
  assert.deepEqual(Object.keys(store._state()).sort(), ['claude', 'codex']);
  assert.equal(Object.getPrototypeOf(store._state()), null);
  assert.equal(Object.hasOwn(Object.prototype, 'until'), false);
});

test('cooldown normalized refresh keeps newer clocks, accepts equal-clock clear and rejects stale overwrite', (t) => {
  const dir = temporary(t);
  const file = path.join(dir, 'cooldowns.json');
  const store = createCooldownStore({ file, now: () => 5000 });
  store.noteFailure('claude', 'rate_limited');
  const baseline = { ...store._state().claude };
  fs.writeFileSync(file, JSON.stringify({ claude: { ...baseline, lastOffenceAt: 4000, until: 0 } }, null, 3));
  assert.equal(store.status('claude').cooling, true);
  fs.writeFileSync(file, JSON.stringify({ claude: { ...baseline, until: 0, reason: null, source: null } }, null, 4));
  assert.equal(store.status('claude').cooling, false);
  assert.equal(store.status('claude').offences, 1);
});
