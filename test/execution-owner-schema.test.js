'use strict';
// These schemas are portable; only native flock/bwrap suites skip off Linux.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBinding, validateProfile, hash, canonical, VERSION, MAX_JOURNAL_FILES, MAX_OWNER_EVENTS } = require('../lib/execution-owner');
const binding = { requestId: 'request_one', invocationId: 'invoke_one', attemptId: 'attempt_one', runId: 'run_one', taskId: 'task_one',
  provider: 'fixture', accountId: 'default', executionHash: hash('execution'), cwdIdentityHash: hash('cwd'), cwdPolicyId: hash('policy'), reservationId: 'reservation_one' };
const profile = { version: 1, kind: 'linux_pid1_owner', policyId: binding.cwdPolicyId, cwdIdentityHash: binding.cwdIdentityHash,
  executionHash: binding.executionHash, writeRoots: [] };
test('owner binding has closed immutable identity and rejects caller proof fields', () => {
  const copy = validateBinding(binding); assert.deepEqual(copy, binding); assert.notEqual(copy, binding);
  for (const field of ['ownerFenced', 'pid', 'proof', 'force', 'replay']) assert.throws(() => validateBinding({ ...binding, [field]: true }), { code: 'OWNER_SCHEMA_INVALID' });
  assert.throws(() => validateBinding({ ...binding, cwdPolicyId: 'unknown' }), { code: 'OWNER_BINDING_INVALID' });
  assert.throws(() => validateBinding({ ...binding, runId: 'not_a_run' }), { code: 'OWNER_BINDING_INVALID' });
});
test('closed launch descriptor binds execution and cwd policy without accepting raw bwrap arguments', () => {
  assert.deepEqual(validateProfile(profile, binding), profile);
  assert.throws(() => validateProfile({ ...profile, bwrapArgs: ['--dev-bind', '/', '/'] }, binding), { code: 'OWNER_SCHEMA_INVALID' });
  assert.throws(() => validateProfile({ ...profile, policyId: hash('other') }, binding), { code: 'OWNER_LAUNCH_PROFILE_INVALID' });
  assert.throws(() => validateProfile({ ...profile, kind: 'unqualified_backend' }, binding), { code: 'OWNER_LAUNCH_PROFILE_INVALID' });
});
test('canonical identity and v2 fixed event bound are deterministic', () => {
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
  assert.equal(VERSION, 2); assert.equal(MAX_OWNER_EVENTS, 6); assert.equal(MAX_JOURNAL_FILES, 2048);
});
