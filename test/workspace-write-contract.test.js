'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateWorkspaceWriteContract } = require('../lib/workspace-write-contract');
const { startTestBridge } = require('./helpers/temporary-bridge');

test('an explicit write contract never degrades to prompt-only guidance', async t => {
  assert.equal(validateWorkspaceWriteContract({}), null);
  for (const allowedWritePaths of [null, ['../escape'], ['*.js']]) {
    assert.throws(() => validateWorkspaceWriteContract({ allowedWritePaths }), { code: 'invalid_write_contract' });
  }
  const bridge = await startTestBridge(t, () => ({}));
  for (const allowedWritePaths of [[], ['allowed.txt']]) {
    const response = await bridge.request('/api/oneshot', { kind: 'claude', prompt: 'fixture must never dispatch', dangerous: true, allowedWritePaths });
    const value = response.body;
    assert.equal(response.status, 409);
    assert.equal(value.failureClass, 'filesystem_contract_unsupported');
    assert.equal(value.model_invocation, false);
    assert.equal(value.physical_attempt_count, 0);
  }
});
