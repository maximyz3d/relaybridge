'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDelegationCoordinator } = require('../lib/delegation');
const { createIncidentLog } = require('../lib/incident-log');

const CWD = path.resolve('/tmp/relaybridge-delegation-fixture');

// A stand-in for the one real task queue. It records what was submitted and
// lets a test drive task states, which is all the coordinator ever reads.
function fakeQueue({ maxConcurrent = 3, active = 0, queued = 0 } = {}) {
  const tasks = new Map();
  let seq = 0;
  return {
    submitted: [],
    tasks,
    stats: () => ({ active, queued, maxConcurrent }),
    newTaskId: () => `t_fake_${++seq}`,
    submitReserved(id, body) {
      this.submitted.push({ id, body, reserved: true });
      const task = { id, status: active >= maxConcurrent ? 'queued' : 'running', receiptId: null, ...body };
      tasks.set(id, task);
      return task;
    },
    submit(body) {
      const id = `t_fake_${++seq}`;
      this.submitted.push({ id, body, reserved: false });
      const task = { id, status: 'queued', receiptId: null, ...body };
      tasks.set(id, task);
      return task;
    },
    get: (id) => tasks.get(id) || null,
  };
}

function coordinator({ queue = fakeQueue(), classify, selectProvider, incidents } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-delegation-'));
  return {
    dir,
    queue,
    delegation: createDelegationCoordinator({
      dataDir: dir,
      taskQueue: queue,
      incidents,
      classify: classify || ((prompt) => ({ tier: /migration/i.test(prompt) ? 'critical' : 'standard' })),
      selectProvider: selectProvider || (({ tier }) => (tier === 'critical'
        ? { kind: 'claude', modelTier: 'heavy', effort: 'high', costClass: 'subscription' }
        : { kind: 'gemini', modelTier: 'light', effort: 'low', costClass: 'local' })),
    }),
  };
}

function task(overrides = {}) {
  return {
    prompt: 'tidy the helper',
    baseSha: 'abc1234',
    ownedFiles: ['lib/helper.js'],
    doneWhen: ['tests pass'],
    ...overrides,
  };
}

test('a batch is classified, ranked by tier, and queued as bounded work', () => {
  const { delegation, queue } = coordinator();
  const record = delegation.delegate({
    requestId: 'req_batch',
    actor: 'codex-coordinator',
    cwd: CWD,
    tasks: [
      task({ prompt: 'tidy the helper', ownedFiles: ['lib/helper.js'] }),
      task({ prompt: 'run the schema migration', ownedFiles: ['lib/migrate.js'] }),
      task({ prompt: 'rename a variable', ownedFiles: ['lib/rename.js'], priority: 5 }),
    ],
  });

  assert.match(record.delegationId, /^dlg_/);
  assert.equal(record.entries.length, 3);
  // Critical first; among equal tiers the caller's priority breaks the tie.
  assert.deepEqual(record.entries.map((e) => e.rank), [1, 2, 3]);
  assert.deepEqual(record.entries.map((e) => e.classification.tier), ['critical', 'standard', 'standard']);
  assert.deepEqual(record.entries.map((e) => e.prompt), [
    'run the schema migration', 'rename a variable', 'tidy the helper',
  ]);
  assert.equal(queue.submitted.length, 3);

  // The queued prompt carries the contract, so the writer sees its bounds even
  // if it never reads the delegation record.
  const migration = queue.submitted.find((s) => s.body.prompt.includes('run the schema migration'));
  assert.equal(migration.body.kind, 'claude');
  assert.equal(migration.body.source, 'delegation');
  assert.match(migration.body.prompt, /Base revision: abc1234/);
  assert.match(migration.body.prompt, /lib\/migrate\.js/);
  assert.match(migration.body.prompt, /Do not expand scope yourself/);
});

test('the cheapest capable provider is used, not the strongest available', () => {
  const seen = [];
  const { delegation } = coordinator({
    selectProvider: (args) => {
      seen.push(args.tier);
      return args.tier === 'critical'
        ? { kind: 'claude', modelTier: 'heavy', effort: 'high', costClass: 'metered' }
        : { kind: 'gemini', modelTier: 'light', effort: 'low', costClass: 'local' };
    },
  });
  const record = delegation.delegate({
    cwd: CWD,
    tasks: [task({ prompt: 'rename a variable' }), task({ prompt: 'run the schema migration', ownedFiles: ['lib/m.js'] })],
  });
  assert.deepEqual(seen.sort(), ['critical', 'standard']);
  const cheap = record.entries.find((e) => e.classification.tier === 'standard');
  assert.equal(cheap.provider, 'gemini');
  assert.equal(cheap.costClass, 'local');
  assert.equal(cheap.costRank, 1);
  assert.equal(cheap.contract.model.modelTier, 'light');
  const dear = record.entries.find((e) => e.classification.tier === 'critical');
  assert.ok(dear.costRank > cheap.costRank);
});

test('a caller may lower a task tier but not raise one without a gate', () => {
  const { delegation } = coordinator({ classify: () => ({ tier: 'standard' }) });
  const record = delegation.delegate({
    cwd: CWD,
    tasks: [
      task({ prompt: 'trivial fix', taskTier: 'utility', ownedFiles: ['lib/a.js'] }),
      task({ prompt: 'self-declared emergency', taskTier: 'critical', ownedFiles: ['lib/b.js'] }),
    ],
  });
  const byPrompt = Object.fromEntries(record.entries.map((e) => [e.prompt, e]));
  assert.equal(byPrompt['trivial fix'].classification.tier, 'utility');
  assert.equal(byPrompt['self-declared emergency'].classification.tier, 'standard');
  assert.equal(byPrompt['self-declared emergency'].classification.classifiedTier, 'standard');
});

test('no capacity means the work waits in the durable queue, not a failure', () => {
  const queue = fakeQueue({ maxConcurrent: 2, active: 2, queued: 4 });
  const { delegation } = coordinator({ queue });
  const record = delegation.delegate({ cwd: CWD, tasks: [task()] });
  assert.deepEqual(record.capacityAtSubmit, { active: 2, queued: 4, maxConcurrent: 2, atCapacity: true });
  assert.equal(record.entries[0].status, 'queued');
  assert.equal(record.status, 'active');
  assert.equal(queue.submitted.length, 1);
});

test('two tasks claiming the same file are refused as a batch', () => {
  const { delegation, queue } = coordinator();
  assert.throws(() => delegation.delegate({
    cwd: CWD,
    tasks: [task({ ownedFiles: ['lib'] }), task({ prompt: 'other', ownedFiles: ['lib/helper.js'] })],
  }), (error) => error.code === 'OWNERSHIP_CONFLICT' && /overlapping files/.test(error.message));
  // Nothing was queued: one writer per path is enforced before dispatch.
  assert.equal(queue.submitted.length, 0);
});

test('a task with no ready provider is recorded as blocked, not dropped', () => {
  const { delegation } = coordinator({
    selectProvider: ({ prompt }) => (prompt === 'unroutable'
      ? { ready: false, reason: 'every seat is in cooldown' }
      : { kind: 'gemini', modelTier: 'light', effort: 'low', costClass: 'local' }),
  });
  const record = delegation.delegate({
    cwd: CWD,
    tasks: [task({ prompt: 'unroutable' }), task({ prompt: 'routable', ownedFiles: ['lib/b.js'] })],
  });
  const blocked = record.entries.find((e) => e.status === 'blocked');
  assert.equal(blocked.blockedReason, 'every seat is in cooldown');
  assert.equal(blocked.contract, null);
  assert.equal(record.entries.filter((e) => e.status !== 'blocked').length, 1);
});

test('state persists to disk so another surface can resume by id', () => {
  const { delegation, queue, dir } = coordinator();
  const record = delegation.delegate({ requestId: 'req_resume', cwd: CWD, tasks: [task()] });
  const taskId = record.entries[0].correlation.taskId;

  // A fresh coordinator over the same directory — a different process, as far
  // as this module is concerned.
  const reopened = createDelegationCoordinator({
    dataDir: dir, taskQueue: queue, classify: () => ({ tier: 'standard' }), selectProvider: () => ({ kind: 'gemini' }),
  });
  const loaded = reopened.get(record.delegationId);
  assert.equal(loaded.requestId, 'req_resume');
  assert.equal(loaded.entries[0].correlation.taskId, taskId);
  assert.equal(loaded.entries[0].correlation.attemptId, 'req_resume:task:1:attempt:1');
  assert.equal(loaded.entries[0].contract.baseSha, 'abc1234');

  // The queue moves on; resume() reconciles against it.
  queue.tasks.get(taskId).status = 'done';
  queue.tasks.get(taskId).receiptId = 'rcpt_9';
  const resumed = reopened.resume(record.delegationId);
  assert.equal(resumed.entries[0].status, 'done');
  assert.equal(resumed.entries[0].correlation.receiptId, 'rcpt_9');
  assert.equal(resumed.status, 'settled');
  // And the reconciliation is durable, not just returned.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${record.delegationId}.json`), 'utf8')).status, 'settled');
});

test('an accepted result closes a task without any escalation', () => {
  const { delegation } = coordinator();
  const record = delegation.delegate({ cwd: CWD, tasks: [task()] });
  const result = delegation.recordOutcome(record.delegationId, record.entries[0].taskRef, {
    classification: 'accepted', actor: 'operator',
  });
  assert.equal(result.escalation, null);
  assert.equal(result.entry.status, 'accepted');
  assert.equal(result.delegation.status, 'active');
});

test('escalation happens only on observed evidence', () => {
  const { delegation } = coordinator();
  const record = delegation.delegate({ cwd: CWD, tasks: [task()] });
  const ref = record.entries[0].taskRef;

  assert.throws(() => delegation.recordOutcome(record.delegationId, ref, { classification: 'looks_hard' }), /classification must be one of/);
  assert.throws(() => delegation.recordOutcome(record.delegationId, ref, { classification: 'partial_result' }), /observed is required/);

  const { escalation, entry } = delegation.recordOutcome(record.delegationId, ref, {
    classification: 'partial_result',
    observed: 'gemini wrote the function but left the caller untouched',
    attemptsMade: 2,
  });
  assert.equal(escalation.status, 'pending');
  assert.deepEqual([...escalation.evidence], ['partial_result']);
  assert.match(escalation.observed, /left the caller untouched/);
  assert.equal(escalation.attemptsMade, 2);
  assert.equal(entry.status, 'awaiting_escalation');
  assert.equal(delegation.get(record.delegationId).status, 'awaiting_escalation');
});

test('a pending escalation does not re-dispatch until it is approved', () => {
  const { delegation, queue } = coordinator();
  const record = delegation.delegate({ cwd: CWD, tasks: [task()] });
  const ref = record.entries[0].taskRef;
  delegation.recordOutcome(record.delegationId, ref, {
    classification: 'wrong_result', observed: 'the change was made in the wrong file',
  });
  assert.equal(queue.submitted.length, 1, 'nothing was requeued while the escalation was pending');

  // A model tier escalation needs a human; the delegator cannot self-approve.
  assert.throws(() => delegation.decideEscalation(record.delegationId, ref, {
    approved: true, approver: 'codex-coordinator', approverKind: 'delegator',
  }), /requires a human approver/);
  assert.equal(queue.submitted.length, 1);

  const decided = delegation.decideEscalation(record.delegationId, ref, {
    approved: true, approver: 'operator', approverKind: 'human', provider: 'claude',
  });
  assert.equal(queue.submitted.length, 2);
  assert.equal(decided.requeuedTaskId, queue.submitted[1].id);
  assert.equal(decided.entry.provider, 'claude');
  assert.equal(queue.submitted[1].body.source, 'delegation_escalation');
  assert.equal(decided.entry.contract.lineage.length, 1);
  assert.equal(decided.delegation.status, 'active');
});

test('a denied escalation settles the task instead of requeuing it', () => {
  const { delegation, queue } = coordinator();
  const record = delegation.delegate({ cwd: CWD, tasks: [task()] });
  const ref = record.entries[0].taskRef;
  delegation.recordOutcome(record.delegationId, ref, {
    classification: 'empty_result', observed: 'gemini returned no output at all',
  });
  const decided = delegation.decideEscalation(record.delegationId, ref, {
    approved: false, approver: 'operator', approverKind: 'human', note: 'reword the prompt instead',
  });
  assert.equal(decided.requeuedTaskId, null);
  assert.equal(decided.entry.status, 'escalation_denied');
  assert.equal(decided.delegation.status, 'settled');
  assert.equal(queue.submitted.length, 1);
});

test('an escalation files a sanitized incident with the correlation ids intact', () => {
  const incidentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-dlg-inc-'));
  const incidents = createIncidentLog({ dataDir: incidentDir });
  const { delegation } = coordinator({ incidents });
  const record = delegation.delegate({ requestId: 'req_inc', cwd: CWD, tasks: [task()] });
  const entry = record.entries[0];
  delegation.recordOutcome(record.delegationId, entry.taskRef, {
    classification: 'failed_result', observed: 'the run failed while reading /home/someone/.bridge-token',
  });

  const open = incidents.list();
  assert.equal(open.length, 1);
  assert.equal(open[0].classification, 'delegation_escalation');
  assert.equal(open[0].correlation.requestId, 'req_inc');
  assert.equal(open[0].correlation.invocationId, 'req_inc:task:1');
  assert.equal(open[0].correlation.attemptId, 'req_inc:task:1:attempt:1');
  assert.equal(open[0].correlation.taskId, entry.correlation.taskId);
  assert.equal(open[0].correlation.contractId, entry.contract.contractId);
  assert.equal(open[0].correlation.delegationId, record.delegationId);
  assert.equal(open[0].evidence.failureClass, 'failed_result');
});

test('stats summarize the fleet backlog for the fuel gauge', () => {
  const queue = fakeQueue({ maxConcurrent: 1, active: 1 });
  const { delegation } = coordinator({ queue });
  const record = delegation.delegate({
    cwd: CWD,
    tasks: [task({ ownedFiles: ['lib/a.js'] }), task({ prompt: 'second', ownedFiles: ['lib/b.js'] })],
  });
  assert.deepEqual(delegation.stats(), { queued: 2, running: 0, awaitingEscalation: 0, settled: 0, blocked: 0 });
  delegation.recordOutcome(record.delegationId, record.entries[0].taskRef, {
    classification: 'wrong_result', observed: 'wrong file',
  });
  assert.deepEqual(delegation.stats(), { queued: 1, running: 0, awaitingEscalation: 1, settled: 0, blocked: 0 });
});

test('the batch shape is validated before anything is queued', () => {
  const { delegation, queue } = coordinator();
  assert.throws(() => delegation.delegate({ tasks: [] }), /tasks is required/);
  assert.throws(() => delegation.delegate({ tasks: new Array(51).fill(task()) }), /limited to 50 tasks/);
  assert.throws(() => delegation.delegate({ cwd: CWD, tasks: [{ prompt: '' }] }), /needs a prompt/);
  // A contract that cannot be built (no owned files) fails loudly rather than
  // queueing unbounded work.
  assert.throws(() => delegation.delegate({ cwd: CWD, tasks: [task({ ownedFiles: [] })] }), /ownedFiles is required/);
  assert.equal(queue.submitted.length, 0);
});
