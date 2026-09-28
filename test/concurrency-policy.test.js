'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveConcurrencyPolicy, scaleOneShotCapacity, providerCapacity,
} = require('../lib/concurrency-policy');

// A single-account install must keep exactly the width it had before accounts
// could be pooled: 8 concurrent calls, 4 per provider.
const DEFAULTS = {
  maxActiveOneShots: 8, maxActivePerProvider: 4, maxActivePerAccount: 4,
  oneShotCapacityCeiling: 32, maxConcurrentTasks: 8,
};

test('defaults allow four instances per provider and eight direct/background calls', () => {
  assert.deepEqual(resolveConcurrencyPolicy({}), DEFAULTS);
});

test('preferred and legacy overrides preserve explicit lower limits and precedence', () => {
  for (const prefix of ['RELAYBRIDGE_', 'PS_BRIDGE_']) {
    assert.deepEqual(resolveConcurrencyPolicy({
      [`${prefix}MAX_ACTIVE_ONESHOTS`]: '3',
      [`${prefix}MAX_ACTIVE_PER_PROVIDER`]: '1',
      [`${prefix}MAX_TASKS`]: '2',
    }), { ...DEFAULTS, maxActiveOneShots: 3, maxActivePerProvider: 1, maxActivePerAccount: 1, maxConcurrentTasks: 2 });
  }
  assert.deepEqual(resolveConcurrencyPolicy({
    RELAYBRIDGE_MAX_ACTIVE_ONESHOTS: '2', PS_BRIDGE_MAX_ACTIVE_ONESHOTS: '16',
    RELAYBRIDGE_MAX_ACTIVE_PER_PROVIDER: '1', PS_BRIDGE_MAX_ACTIVE_PER_PROVIDER: '4',
    RELAYBRIDGE_MAX_TASKS: '1', PS_BRIDGE_MAX_TASKS: '16',
  }), { ...DEFAULTS, maxActiveOneShots: 2, maxActivePerProvider: 1, maxActivePerAccount: 1, maxConcurrentTasks: 1 });
  assert.equal(resolveConcurrencyPolicy({ RELAYBRIDGE_MAX_TASKS: ' ', PS_BRIDGE_MAX_TASKS: '2' }).maxConcurrentTasks, 2);
});

test('malformed, non-finite, fractional and unsafe limits cannot disable admission', () => {
  for (const value of ['invalid', 'NaN', 'Infinity', '-Infinity', '0', '-1', '1.5', '9007199254740992']) {
    assert.deepEqual(resolveConcurrencyPolicy({
      RELAYBRIDGE_MAX_ACTIVE_ONESHOTS: value,
      RELAYBRIDGE_MAX_ACTIVE_PER_PROVIDER: value,
      RELAYBRIDGE_MAX_ACTIVE_PER_ACCOUNT: value,
      RELAYBRIDGE_MAX_TASKS: value,
      RELAYBRIDGE_ONESHOT_CAPACITY_CEILING: value,
    }), DEFAULTS, value);
  }
});

test('hard caps and effective global capacity bound every dispatch limit', () => {
  assert.deepEqual(resolveConcurrencyPolicy({
    RELAYBRIDGE_MAX_ACTIVE_ONESHOTS: '999',
    RELAYBRIDGE_MAX_ACTIVE_PER_PROVIDER: '999',
    RELAYBRIDGE_MAX_ACTIVE_PER_ACCOUNT: '999',
    RELAYBRIDGE_MAX_TASKS: '999',
    RELAYBRIDGE_ONESHOT_CAPACITY_CEILING: '999',
  }), {
    maxActiveOneShots: 64, maxActivePerProvider: 4, maxActivePerAccount: 64,
    oneShotCapacityCeiling: 64, maxConcurrentTasks: 64,
  });
  assert.deepEqual(resolveConcurrencyPolicy({ RELAYBRIDGE_MAX_ACTIVE_ONESHOTS: '1' }), {
    maxActiveOneShots: 1, maxActivePerProvider: 1, maxActivePerAccount: 1,
    oneShotCapacityCeiling: 32, maxConcurrentTasks: 1,
  });
});

test('an operator may widen the fleet beyond the old sixteen-call ceiling', () => {
  assert.equal(resolveConcurrencyPolicy({ RELAYBRIDGE_MAX_ACTIVE_ONESHOTS: '24' }).maxActiveOneShots, 24);
  // Per-provider stays pinned at 4 regardless: extra width has to come from
  // extra accounts, never from hammering one login harder.
  assert.equal(resolveConcurrencyPolicy({ RELAYBRIDGE_MAX_ACTIVE_ONESHOTS: '24' }).maxActivePerProvider, 4);
});

test('a pristine install keeps its configured width; each linked plan widens it', () => {
  const policy = resolveConcurrencyPolicy({});
  const scale = (linkedAccountCount) => scaleOneShotCapacity({
    base: policy.maxActiveOneShots,
    perAccount: policy.maxActivePerAccount,
    ceiling: policy.oneShotCapacityCeiling,
    linkedAccountCount,
  });
  assert.equal(scale(0), 8, 'no linked accounts must not change the fleet width');
  assert.equal(scale(1), 12);
  assert.equal(scale(3), 20);
  assert.equal(scale(100), 32, 'the machine-wide ceiling is absolute');
});

test('capacity scaling rejects nonsense instead of removing the limit', () => {
  assert.equal(scaleOneShotCapacity({}), 1);
  assert.equal(scaleOneShotCapacity({ base: 8, perAccount: 4, ceiling: 32, linkedAccountCount: -5 }), 8);
  assert.equal(scaleOneShotCapacity({ base: 8, perAccount: 4, ceiling: 32, linkedAccountCount: 1.5 }), 8);
  assert.equal(scaleOneShotCapacity({ base: 8, perAccount: 4, ceiling: 2, linkedAccountCount: 4 }),
    8, 'a ceiling below the configured base never narrows the base');
});

test('one provider gets one account-worth of slots per usable account', () => {
  assert.equal(providerCapacity({ perAccount: 4, usableAccountCount: 1, fleetCapacity: 8 }), 4);
  assert.equal(providerCapacity({ perAccount: 4, usableAccountCount: 3, fleetCapacity: 20 }), 12);
  assert.equal(providerCapacity({ perAccount: 4, usableAccountCount: 3, fleetCapacity: 8 }),
    8, 'a provider can never exceed the whole fleet');
  assert.equal(providerCapacity({}), 1);
  assert.equal(providerCapacity({ perAccount: 4, usableAccountCount: 0, fleetCapacity: 8 }), 4);
});
