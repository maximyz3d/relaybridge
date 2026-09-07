'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  buildHandoffContract,
  evaluateRequest,
  requestEscalation,
  resolveEscalation,
  applyApprovedEscalation,
  ownershipConflicts,
  renderHandoffBrief,
} = require('../lib/handoff-contract');

const CWD = path.resolve('/tmp/relaybridge-handoff-fixture');

function contract(overrides = {}) {
  return buildHandoffContract({
    correlation: { requestId: 'req_1' },
    actor: 'codex-coordinator',
    objective: 'Add a retry counter to the queue',
    cwd: CWD,
    baseSha: 'abc1234',
    ownedFiles: ['lib/task-queue.js'],
    taskTier: 'standard',
    provider: 'claude',
    modelTier: 'standard',
    effort: 'medium',
    toolPolicy: { allow: ['read', 'write'], deny: ['shell'] },
    budget: { maxTokens: 50000 },
    doneWhen: ['node --test test/task-queue.test.js passes'],
    nonGoals: ['Do not change the receipt schema'],
    ...overrides,
  });
}

test('a contract names every bound the writer is held to', () => {
  const c = contract();
  assert.match(c.contractId, /^hc_/);
  assert.deepEqual([...c.ownedFiles], ['lib/task-queue.js']);
  assert.equal(c.cwd, CWD);
  assert.equal(c.baseSha, 'abc1234');
  assert.equal(c.taskTier, 'standard');
  assert.equal(c.model.modelTier, 'standard');
  assert.equal(c.model.effort, 'medium');
  assert.equal(c.toolPolicy.mode, 'fail_closed');
  assert.equal(c.budget.maxTokens, 50000);
  assert.deepEqual([...c.doneWhen], ['node --test test/task-queue.test.js passes']);
  assert.deepEqual([...c.nonGoals], ['Do not change the receipt schema']);
  // Correlation follows the server's canonical attempt identity.
  assert.equal(c.correlation.invocationId, 'req_1');
  assert.equal(c.correlation.attemptId, 'req_1:attempt:1');
  assert.equal(c.escalation.allowed, false);
  assert.equal(c.escalation.requiresJustification, true);
});

test('a contract without owned files, a base sha, or done-when is refused', () => {
  assert.throws(() => contract({ ownedFiles: [] }), /ownedFiles is required/);
  assert.throws(() => contract({ baseSha: '' }), /baseSha is required/);
  assert.throws(() => contract({ doneWhen: [] }), /doneWhen is required/);
});

test('owned files are normalized and cannot escape the workspace', () => {
  const c = contract({ ownedFiles: [`${CWD}/lib/b.js`, 'lib/a.js', 'lib/a.js'] });
  assert.deepEqual([...c.ownedFiles], ['lib/a.js', 'lib/b.js']);
  assert.throws(() => contract({ ownedFiles: ['../outside.js'] }), /outside the delegated workspace/);
});

test('permissions fail closed: read-only unless the delegator said dangerous', () => {
  assert.equal(contract().permissions.filesystem, 'read_only_enforced');
  assert.equal(contract({ dangerous: true }).permissions.filesystem, 'writer_authorized');
});

test('an explicit deny beats a copied-forward allow', () => {
  const c = contract({ toolPolicy: { allow: ['read', 'shell'], deny: ['shell'] } });
  assert.deepEqual([...c.toolPolicy.allow], ['read']);
});

test('an in-bounds request is allowed', () => {
  const decision = evaluateRequest(contract(), {
    files: ['lib/task-queue.js'], tools: ['read', 'write'], taskTier: 'standard',
  });
  assert.equal(decision.decision, 'allowed');
  assert.deepEqual([...decision.files], ['lib/task-queue.js']);
});

test('an out-of-bound request returns escalation-needed and never widens scope', () => {
  const decision = evaluateRequest(contract(), {
    files: ['server.js'],
    tools: ['shell'],
    taskTier: 'critical',
    modelTier: 'heavy',
    effort: 'max',
    dangerous: true,
    budget: { maxTokens: 500000 },
    cwd: '/tmp/somewhere-else',
  });
  assert.equal(decision.decision, 'escalation_needed');
  assert.equal(decision.scopeExpanded, false);
  assert.deepEqual(new Set(decision.kinds), new Set([
    'file_scope', 'tool_policy', 'task_tier', 'model_tier', 'effort', 'permission', 'budget', 'cwd',
  ]));
  assert.equal(decision.gate.requiresJustification, true);
  assert.deepEqual([...decision.gate.approvers], ['human', 'delegator']);
});

test('a path escaping the workspace is an escalation, not a crash', () => {
  const decision = evaluateRequest(contract(), { files: ['../../etc/passwd'] });
  assert.equal(decision.decision, 'escalation_needed');
  assert.ok(decision.kinds.includes('file_scope'));
});

test('owning a directory owns the files under it', () => {
  const decision = evaluateRequest(contract({ ownedFiles: ['lib'] }), { files: ['lib/deep/nested.js'] });
  assert.equal(decision.decision, 'allowed');
});

test('escalation requires observed evidence, not a difficulty claim', () => {
  const c = contract();
  assert.throws(() => requestEscalation(c, {
    kinds: ['model_tier'], observed: 'this is hard', blockedWithout: 'a bigger model',
  }), /evidence is required/);
  assert.throws(() => requestEscalation(c, {
    kinds: ['model_tier'], evidence: ['feels_hard'], observed: 'x', blockedWithout: 'y',
  }), /not recognized evidence/);
  assert.throws(() => requestEscalation(c, {
    kinds: ['model_tier'], evidence: ['wrong_result'], blockedWithout: 'y',
  }), /observed is required/);
});

test('a tier escalation is gated on a human, not the delegator', () => {
  const c = contract();
  const escalation = requestEscalation(c, {
    kinds: ['model_tier'],
    evidence: ['partial_result'],
    observed: 'the standard model produced 2 of 5 required functions',
    blockedWithout: 'the remaining functions cannot be written',
    attemptsMade: 2,
  });
  assert.equal(escalation.status, 'pending');
  assert.equal(escalation.gate.humanRequired, true);
  assert.throws(() => resolveEscalation(escalation, {
    approved: true, approver: 'codex-coordinator', approverKind: 'delegator',
  }), /requires a human approver/);

  const approved = resolveEscalation(escalation, {
    approved: true, approver: 'operator', approverKind: 'human', note: 'ok',
  });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.resolution.approverKind, 'human');
  assert.throws(() => resolveEscalation(approved, { approved: false, approver: 'operator', approverKind: 'human' }), /already approved/);
});

test('a denied escalation cannot widen a contract', () => {
  const c = contract();
  const denied = resolveEscalation(requestEscalation(c, {
    kinds: ['file_scope'], evidence: ['out_of_scope_request'],
    observed: 'the writer asked for server.js', blockedWithout: 'nothing',
  }), { approved: false, approver: 'operator', approverKind: 'human' });
  assert.throws(() => applyApprovedEscalation(c, denied), /only an approved escalation/);
});

test('an approved escalation produces a new contract with lineage, not an edit', () => {
  const c = contract();
  const approved = resolveEscalation(requestEscalation(c, {
    kinds: ['file_scope'],
    evidence: ['partial_result'],
    observed: 'the change requires a matching route in server.js',
    blockedWithout: 'the queue change is unreachable',
    requested: { ownedFiles: ['server.js'] },
  }), { approved: true, approver: 'codex-coordinator', approverKind: 'delegator' });

  const widened = applyApprovedEscalation(c, approved);
  assert.notEqual(widened.contractId, c.contractId);
  assert.deepEqual([...widened.ownedFiles], ['lib/task-queue.js', 'server.js']);
  assert.equal(widened.lineage.length, 1);
  assert.match(widened.lineage[0], new RegExp(`^${c.contractId} widened by ${approved.escalationId}$`));
  // The original is untouched, so receipts written under it still describe the
  // bounds that were actually in force.
  assert.deepEqual([...c.ownedFiles], ['lib/task-queue.js']);
  assert.equal(widened.correlation.attempt, 2);
  assert.equal(widened.correlation.attemptId, 'req_1:attempt:2');
});

test('overlapping ownership in the same workspace is detected', () => {
  const a = contract({ ownedFiles: ['lib'] });
  const b = contract({ ownedFiles: ['lib/task-queue.js'] });
  const c = contract({ ownedFiles: ['docs/README.md'] });
  const conflicts = ownershipConflicts([a, b, c]);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].contracts, [a.contractId, b.contractId]);
  assert.deepEqual(conflicts[0].overlap, ['lib']);
  assert.equal(ownershipConflicts([a, c]).length, 0);
});

test('the same paths in different workspaces are not a conflict', () => {
  const a = contract({ ownedFiles: ['lib/task-queue.js'] });
  const b = contract({ cwd: '/tmp/relaybridge-other', ownedFiles: ['lib/task-queue.js'] });
  assert.equal(ownershipConflicts([a, b]).length, 0);
});

test('the rendered brief states the bounds and the stop rule', () => {
  const brief = renderHandoffBrief(contract());
  assert.match(brief, /Base revision: abc1234/);
  assert.match(brief, /Files you own \(exclusive writer\)/);
  assert.match(brief, /- lib\/task-queue\.js/);
  assert.match(brief, /fail-closed/);
  assert.match(brief, /maxTokens=50000/);
  assert.match(brief, /## Done when/);
  assert.match(brief, /## Non-goals/);
  assert.match(brief, /Do not expand scope yourself/);
});
