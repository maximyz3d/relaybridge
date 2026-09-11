'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveConcurrencyPolicy } = require('../lib/concurrency-policy');

test('defaults allow four instances per provider and eight direct/background calls', () => {
  assert.deepEqual(resolveConcurrencyPolicy({}), {
    maxActiveOneShots: 8, maxActivePerProvider: 4, maxConcurrentTasks: 8,
  });
});

test('preferred and legacy overrides preserve explicit lower limits and precedence', () => {
  for (const prefix of ['RELAYBRIDGE_', 'PS_BRIDGE_']) {
    assert.deepEqual(resolveConcurrencyPolicy({
      [`${prefix}MAX_ACTIVE_ONESHOTS`]: '3',
      [`${prefix}MAX_ACTIVE_PER_PROVIDER`]: '1',
      [`${prefix}MAX_TASKS`]: '2',
    }), { maxActiveOneShots: 3, maxActivePerProvider: 1, maxConcurrentTasks: 2 });
  }
  assert.deepEqual(resolveConcurrencyPolicy({
    RELAYBRIDGE_MAX_ACTIVE_ONESHOTS: '2', PS_BRIDGE_MAX_ACTIVE_ONESHOTS: '16',
    RELAYBRIDGE_MAX_ACTIVE_PER_PROVIDER: '1', PS_BRIDGE_MAX_ACTIVE_PER_PROVIDER: '4',
    RELAYBRIDGE_MAX_TASKS: '1', PS_BRIDGE_MAX_TASKS: '16',
  }), { maxActiveOneShots: 2, maxActivePerProvider: 1, maxConcurrentTasks: 1 });
  assert.equal(resolveConcurrencyPolicy({ RELAYBRIDGE_MAX_TASKS: ' ', PS_BRIDGE_MAX_TASKS: '2' }).maxConcurrentTasks, 2);
});

test('malformed, non-finite, fractional and unsafe limits cannot disable admission', () => {
  for (const value of ['invalid', 'NaN', 'Infinity', '-Infinity', '0', '-1', '1.5', '9007199254740992']) {
    assert.deepEqual(resolveConcurrencyPolicy({
      RELAYBRIDGE_MAX_ACTIVE_ONESHOTS: value,
      RELAYBRIDGE_MAX_ACTIVE_PER_PROVIDER: value,
      RELAYBRIDGE_MAX_TASKS: value,
    }), { maxActiveOneShots: 8, maxActivePerProvider: 4, maxConcurrentTasks: 8 }, value);
  }
});

test('hard caps and effective global capacity bound every dispatch limit', () => {
  assert.deepEqual(resolveConcurrencyPolicy({
    RELAYBRIDGE_MAX_ACTIVE_ONESHOTS: '999',
    RELAYBRIDGE_MAX_ACTIVE_PER_PROVIDER: '999',
    RELAYBRIDGE_MAX_TASKS: '999',
  }), { maxActiveOneShots: 16, maxActivePerProvider: 4, maxConcurrentTasks: 16 });
  assert.deepEqual(resolveConcurrencyPolicy({ RELAYBRIDGE_MAX_ACTIVE_ONESHOTS: '1' }), {
    maxActiveOneShots: 1, maxActivePerProvider: 1, maxConcurrentTasks: 1,
  });
});
