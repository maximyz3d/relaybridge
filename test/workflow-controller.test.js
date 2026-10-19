'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkflowPipeline } = require('../lib/workflow-pipeline');
const { createWorkflowController, WorkflowControllerError } = require('../lib/workflow-controller');
const { createIncidentLog } = require('../lib/incident-log');
const { createRequestLedger } = require('../lib/request-ledger');
const { createTaskQueue } = require('../lib/task-queue');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-controller-'));
  const cwd = path.join(root, 'project');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = { value: 1000000 };

  const tasks = new Map();
  let sequence = 0;
  const taskQueue = {
    newTaskId() { return `t_fake_${++sequence}`; },
    submit(input) { return this.submitReserved(this.newTaskId(), input); },
    submitReserved(id, input) {
      if (tasks.has(id)) throw new Error('task id already exists');
      const task = { id, status: 'queued', startedAt: null, execution: { state: 'never_started' }, ...input, body: { ...input } };
      tasks.set(task.id, task);
      return task;
    },
    get(id) { return tasks.get(id) || null; },
    cancel(id) {
      const task = tasks.get(id);
      if (!task) throw new Error('task not found');
      task.status = 'cancelled';
      return task;
    },
  };
  const config = {
    claude: { oneshot_safe: ['claude-safe'], oneshot_dangerous: ['claude-writer'] },
    claude_fable: { oneshot_safe: ['fable-safe'], oneshot_dangerous: [] },
  };
  const pipeline = createWorkflowPipeline({ dataDir, now: () => clock.value });
  const incidents = createIncidentLog({ dataDir: path.join(root, 'incidents') });
  const controller = createWorkflowController({
    pipeline, taskQueue, incidents, loadConfig: () => config, now: () => clock.value,
  });
  t.after(() => controller.shutdown());
  return {
    cwd,
    dataDir,
    clock,
    tasks,
    taskQueue,
    config,
    pipeline,
    controller,
    incidents,
    finish(task, result, status = 'done', extra = {}) {
      Object.assign(tasks.get(task.id), {
        status,
        result,
        error: status === 'done' ? null : result,
        finishedAt: clock.value,
        ...extra,
      });
    },
  };
}

function reachReviewReady(f, input = createInput(f.cwd), verdict = 'REVISE') {
  const created = f.controller.create(input);
  const planning = f.controller.submitResearch(created.runId, { markdown: 'Research evidence.' });
  f.finish(planning.task, 'Plan details.\nPLAN_STATUS: READY');
  f.controller.reconcile(created.runId);
  const implementation = f.controller.startImplementation(created.runId);
  const review = f.controller.completeImplementation(created.runId, {
    leaseToken: implementation.lease.leaseToken,
    markdown: 'Implementation evidence.',
  });
  f.finish(review.task, `Initial review context unique.\nREVIEW_VERDICT: ${verdict}`);
  f.controller.reconcile(created.runId);
  return created;
}

test('Codex-only policy survives external revision restart with exact Astra/ultra and no provider writer', (t) => {
  const f = fixture(t);
  f.config.codex = { oneshot_safe: ['codex-safe'] };
  const created = reachReviewReady(f, { ...createInput(f.cwd), profile: 'codex-astra-ultra', permissionMode: 'full' });
  assert.deepEqual(f.controller.view(created.runId).nextActions, ['claim_pipeline_revision']);
  assert.throws(() => f.controller.startRevision(created.runId), { code: 'INVALID_WRITER_MODE' });
  const count = f.tasks.size;
  const claimed = f.controller.claimRevision(created.runId);
  const token = claimed.lease.leaseToken;
  assert.equal(claimed.workflow.writerLease.mode, 'external');
  assert.equal(f.tasks.size, count);
  const restarted = createWorkflowController({ pipeline: createWorkflowPipeline({ dataDir: f.dataDir, now: () => f.clock.value }),
    taskQueue: f.taskQueue, loadConfig: () => f.config, now: () => f.clock.value });
  t.after(() => restarted.shutdown());
  assert.equal(restarted.reconcile(created.runId).workflow.phase, 'revising');
  assert.deepEqual(restarted.view(created.runId).nextActions, ['complete_pipeline_revision', 'renew_pipeline_writer_lease']);
  assert.throws(() => restarted.cancel(created.runId, { reason: 'No token' }), { code: 'INVALID_LEASE_TOKEN' });
  assert.throws(() => restarted.completeRevision(created.runId, { leaseToken: 'a'.repeat(64), markdown: 'invalid' }), { code: 'LEASE_MISMATCH' });
  assert.throws(() => restarted.startFinalReview(created.runId), { code: 'INVALID_TRANSITION' });
  restarted.renewWriterLease(created.runId, { leaseToken: token, leaseMs: 60000 });
  const completed = restarted.completeRevision(created.runId, { leaseToken: token, markdown: 'Corrections and exact test evidence.' });
  assert.equal(completed.phase, 'revision_ready');
  assert.equal(completed.writerLease, null);
  assert.equal(f.tasks.size, count, 'external completion never dispatches or approves');
  const closing = restarted.startFinalReview(created.runId);
  f.finish(closing.task, 'Independent closing evidence.\nREVIEW_VERDICT: APPROVE');
  assert.equal(restarted.reconcile(created.runId).workflow.phase, 'complete');
  for (const task of f.tasks.values()) {
    assert.equal(task.kind, 'codex'); assert.equal(task.model, 'gpt-6-astra');
    assert.equal(task.effort, 'ultra'); assert.equal(task.maxEffortOverride, true); assert.equal(task.dangerous, false);
    assert.match(task.prompt, /bounded read-only commands/); assert.doesNotMatch(task.prompt, /Claude|Read\/Glob\/Grep/);
  }
  assert.equal(f.pipeline.list()[0].profile, 'codex-astra-ultra');
});

test('Codex-only unavailable provider, retries, and missing verdicts never select Claude', (t) => {
  const f = fixture(t);
  assert.throws(() => f.controller.create({ ...createInput(f.cwd), profile: 'codex-astra-ultra',
    providerPreferences: { planning: ['claude'] } }), { code: 'INVALID_ARGUMENT' });
  const unavailable = f.controller.create({ ...createInput(f.cwd), profile: 'codex-astra-ultra' });
  assert.throws(() => f.controller.submitResearch(unavailable.runId, { markdown: 'evidence' }), { code: 'PROVIDER_UNAVAILABLE' });
  assert.equal(f.tasks.size, 0);
  f.config.codex = { oneshot_safe: ['codex-safe'] };
  const created = f.controller.create({ ...createInput(f.cwd), profile: 'codex-astra-ultra' });
  const planning = f.controller.submitResearch(created.runId, { markdown: 'evidence' });
  f.finish(planning.task, 'overloaded', 'failed', { failureClass: 'overloaded', execution: { state: 'settled' } });
  f.controller.reconcile(created.runId);
  f.clock.value += 20000;
  const retry = f.controller.reconcile(created.runId).workflow.providerTask;
  assert.equal(retry.provider, 'codex'); assert.equal(retry.model, 'gpt-6-astra'); assert.equal(retry.effort, 'ultra');
  f.finish(f.tasks.get(retry.taskId), 'Missing final plan marker.');
  assert.equal(f.controller.reconcile(created.runId).workflow.phase, 'failed');
  assert.ok([...f.tasks.values()].every((task) => task.kind === 'codex'));
});

test('expired external and legacy ambiguous revisions remain held across read and reconcile', (t) => {
  for (const legacy of [false, true]) {
    const f = fixture(t);
    const created = reachReviewReady(f);
    const claimed = f.controller.claimRevision(created.runId, { leaseMs: 60000 });
    if (legacy) {
      const file = path.join(f.dataDir, 'workflows', created.runId, 'state.json');
      const state = JSON.parse(fs.readFileSync(file));
      state.schemaVersion = 1; delete state.profile; delete state.phasePolicy; delete state.writerLease.mode;
      fs.writeFileSync(file, JSON.stringify(state));
    }
    f.clock.value += 60001;
    assert.equal(f.controller.reconcile(created.runId).workflow.phase, 'revising');
    assert.deepEqual(f.controller.view(created.runId).nextActions, []);
    assert.throws(() => f.controller.cancel(created.runId, { leaseToken: claimed.lease.leaseToken }), { code: 'LEASE_EXPIRED' });
    assert.throws(() => f.pipeline.failOrphanedRevision(created.runId, {}), { code: 'WRITER_EXECUTION_UNCERTAIN' });
    assert.ok(f.pipeline.get(created.runId).writerLease);
  }
});

test('a persisted provider mode cannot override the Codex-only external ownership policy', (t) => {
  const f = fixture(t); f.config.codex = { oneshot_safe: ['codex-safe'] };
  const created = reachReviewReady(f, { ...createInput(f.cwd), profile: 'codex-astra-ultra', permissionMode: 'full' });
  f.controller.claimRevision(created.runId);
  const stateFile = path.join(f.dataDir, 'workflows', created.runId, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile));
  const lockDirectory = path.join(f.dataDir, 'writer-locks');
  const locks = fs.readdirSync(lockDirectory).map((name) => [name, fs.readFileSync(path.join(lockDirectory, name))]);
  state.writerLease.mode = 'provider'; fs.writeFileSync(stateFile, JSON.stringify(state));
  for (const action of [() => f.controller.reconcile(created.runId), () => f.controller.cancel(created.runId),
    () => f.pipeline.failOrphanedRevision(created.runId, {}), () => f.pipeline.cancelOrphanedRevision(created.runId, {})]) {
    assert.throws(action, { code: 'STATE_CORRUPT' });
    for (const [name, bytes] of locks) assert.deepEqual(fs.readFileSync(path.join(lockDirectory, name)), bytes);
  }
});

test('status reads are inert and explicit reconciliation advances persisted handoffs', (t) => {
  const f = fixture(t);
  const created = f.controller.create(createInput(f.cwd));
  f.pipeline.completeResearch(created.runId, { markdown: 'durable research' });

  const viewed = f.controller.view(created.runId);
  assert.equal(viewed.workflow.phase, 'research_ready');
  assert.deepEqual(viewed.nextActions, ['reconcile_pipeline']);
  assert.equal(f.tasks.size, 0, 'a status read must not dispatch provider work');

  const reconciled = f.controller.reconcile(created.runId);
  assert.equal(reconciled.workflow.phase, 'planning');
  assert.ok(reconciled.workflow.providerTask);
  assert.equal(f.tasks.size, 1, 'only explicit reconciliation may dispatch the handoff');
});

test('failed planning writes a correlated budget incident before failing without approval', (t) => {
  const f = fixture(t);
  const created = f.controller.create(createInput(f.cwd));
  const planning = f.controller.submitResearch(created.runId, { markdown: 'Research evidence.' });
  f.finish(planning.task, '50060 exceeded maxTotalTokens 50000', 'failed', {
    failureClass: 'budget_exceeded', flags: { budget_exceeded: true }, receiptId: 'rcpt_budget',
  });
  const result = f.controller.reconcile(created.runId);
  assert.equal(result.workflow.phase, 'failed');
  const [incident] = f.incidents.list();
  assert.equal(incident.classification, 'budget_exceeded');
  assert.equal(incident.correlation.taskId, planning.task.id);
  assert.equal(incident.correlation.receiptId, 'rcpt_budget');
  assert.equal(incident.phase, 'planning');
  assert.equal(incident.summary.includes('50060'), false);
  f.controller.reconcile(created.runId);
  assert.equal(f.incidents.stats().total, 1);
});

function createInput(cwd, taskTier = 'complex', permissionMode = 'full') {
  return {
    cwd,
    objective: 'Implement the bounded change.',
    constraints: ['Preserve compatibility.'],
    nonGoals: ['No unrelated refactor.'],
    fileScope: ['lib/target.js', 'test/target.test.js'],
    baseRevision: 'abc123',
    acceptance: ['Focused tests pass.'],
    taskTier,
    permissionMode,
  };
}

test('expired implementation status is inert and explains why renewal/completion are unavailable', (t) => {
  const f = fixture(t);
  const created = f.controller.create(createInput(f.cwd));
  f.pipeline.completeResearch(created.runId, { markdown: 'Research.' });
  f.pipeline.startPlanning(created.runId);
  f.pipeline.completePlanning(created.runId, { markdown: 'Accepted bounded plan.' });
  const started = f.controller.startImplementation(created.runId, { leaseMs: 100 });
  const before = JSON.stringify(f.pipeline.get(created.runId));
  const live = f.controller.view(created.runId, { includeArtifacts: false });
  assert.deepEqual(live.nextActions, ['complete_pipeline_implementation', 'renew_pipeline_writer_lease']);
  assert.equal(live.blockedActions, undefined);
  f.clock.value = started.lease.expiresAt;
  for (let read = 0; read < 3; read += 1) {
    const view = f.controller.view(created.runId, { includeArtifacts: false });
    assert.equal(view.workflow.phase, 'implementing');
    assert.deepEqual(view.nextActions, []);
    assert.deepEqual(view.blockedActions, [{ code: 'LEASE_EXPIRED', recovery: 'unavailable_unbound_owner',
      actions: ['complete_pipeline_implementation', 'renew_pipeline_writer_lease'] }]);
    assert.equal(JSON.stringify(f.pipeline.get(created.runId)), before);
    assert.equal(f.tasks.size, 0, 'status never dispatches a replacement provider');
  }
  assert.throws(() => f.controller.renewWriterLease(created.runId, { leaseToken: started.lease.leaseToken }),
    (error) => error.code === 'LEASE_EXPIRED');
  assert.throws(() => f.controller.completeImplementation(created.runId, {
    leaseToken: started.lease.leaseToken, markdown: 'Must not advance expired work.' }),
  (error) => error.code === 'LEASE_EXPIRED');
  assert.equal(JSON.stringify(f.pipeline.get(created.runId)), before);
});

test('missing implementation lease identity never advertises completion or renewal', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.controller.nextActions({ phase: 'implementing', writerLease: null }), []);
  assert.deepEqual(f.controller.nextActions({ phase: 'implementing', writerLease: { expiresAt: 'later' } }), []);
});

test('controller drives the complete Codex-Claude handoff without overlapping writers', (t) => {
  const f = fixture(t);
  const created = f.controller.create(createInput(f.cwd));
  assert.equal(created.phase, 'scoping');

  const planning = f.controller.submitResearch(created.runId, {
    markdown: '# Research\nLocated the implementation boundary.',
  });
  assert.equal(planning.workflow.phase, 'planning');
  assert.equal(planning.task.kind, 'claude');
  assert.equal(planning.task.modelTier, 'heavy');
  assert.equal(planning.task.effort, 'high');
  assert.equal(planning.task.dangerous, false);
  assert.match(planning.task.prompt, /## File scope\n\n- lib\/target\.js/);
  assert.doesNotMatch(planning.task.prompt, /- - lib\/target\.js/);

  f.finish(planning.task, '# Plan\n1. Change the target.\n2. Test it.\n\nPLAN_STATUS: READY');
  assert.equal(f.controller.reconcile(created.runId).workflow.phase, 'plan_ready');

  const implementation = f.controller.startImplementation(created.runId);
  assert.equal(implementation.workflow.phase, 'implementing');
  assert.equal(implementation.lease.actor, 'codex');

  const review = f.controller.completeImplementation(created.runId, {
    leaseToken: implementation.lease.leaseToken,
    markdown: '# Implementation\nChanged both scoped files and ran focused tests.',
  });
  assert.equal(review.workflow.phase, 'reviewing');
  assert.equal(review.task.kind, 'claude');
  assert.equal(review.task.modelTier, 'standard');
  assert.equal(review.task.effort, 'high');
  assert.equal(review.task.dangerous, false);
  assert.equal(review.workflow.writerLease, null);

  f.finish(review.task, '# Review\nAdd one boundary assertion.\n\nREVIEW_VERDICT: REVISE');
  const reviewed = f.controller.reconcile(created.runId);
  assert.equal(reviewed.workflow.phase, 'review_ready');
  assert.deepEqual(reviewed.nextActions, ['start_pipeline_revision']);

  const revision = f.controller.startRevision(created.runId);
  assert.equal(revision.workflow.phase, 'revising');
  assert.equal(revision.task.kind, 'claude');
  assert.equal(revision.task.modelTier, 'heavy');
  assert.equal(revision.task.effort, 'high');
  assert.equal(revision.task.dangerous, true);
  assert.equal(revision.workflow.writerLease.actor, 'claude-reviser');

  f.finish(revision.task, '# Revision\nAdded the assertion; tests pass.\n\nREVISION_STATUS: APPLIED');
  const revised = f.controller.reconcile(created.runId);
  assert.equal(revised.workflow.phase, 'revision_ready');
  assert.equal(revised.workflow.writerLease, null);

  const finalReview = f.controller.startFinalReview(created.runId);
  assert.equal(finalReview.workflow.phase, 'final_reviewing');
  assert.match(finalReview.task.title, /final-review/);
  f.finish(finalReview.task, '# Final review\nNo material findings.\n\nREVIEW_VERDICT: APPROVE');
  const completed = f.controller.reconcile(created.runId);
  assert.equal(completed.workflow.phase, 'complete');
  assert.deepEqual(completed.nextActions, []);
});

test('a local token-budget stop never retries even with independent accepted 429 evidence', (t) => {
  const f = fixture(t);
  const created = reachReviewReady(f, createInput(f.cwd), 'APPROVE');
  const first = f.controller.startFinalReview(created.runId);
  f.finish(first.task, 'local cache-read budget crossed; provider also returned 429', 'failed', {
    failureClass: 'token_budget', flags: { rate_limited: true, timed_out: true },
    retryAt: f.clock.value + 300000,
  });
  const failed = f.controller.reconcile(created.runId);
  assert.equal(failed.workflow.phase, 'failed');
  assert.equal(failed.workflow.providerRetry, null);
  assert.equal(failed.workflow.providerTask, null);
  assert.equal(failed.workflow.providerTaskHistory.filter((item) => item.purpose === 'final-review').length, 1);
  assert.equal(failed.nextActions.includes('retry_failed_pipeline_provider'), false);
});

test('typed transient review failures retry after backoff and stop at the bounded attempt limit', (t) => {
  const f = fixture(t);
  const created = reachReviewReady(f, createInput(f.cwd), 'APPROVE');
  const first = f.controller.startFinalReview(created.runId);
  f.finish(first.task, 'provider 429', 'failed', {
    failureClass: 'rate_limit',
    flags: { rate_limited: true, timed_out: false },
    retryAt: f.clock.value + 300000,
  });

  const scheduledSecond = f.controller.reconcile(created.runId);
  assert.equal(scheduledSecond.workflow.phase, 'final_reviewing');
  assert.equal(scheduledSecond.workflow.providerTask, null);
  assert.equal(scheduledSecond.workflow.providerRetry.nextAttempt, 2);
  assert.equal(scheduledSecond.workflow.providerRetry.retryAt, 1300000,
    'the workflow must inherit the cooldown store deadline instead of guessing 60 seconds');
  assert.deepEqual(scheduledSecond.nextActions, ['reconcile_pipeline']);
  assert.equal(f.controller.reconcile(created.runId).workflow.providerTask, null,
    'polling before retryAt must not spend another provider attempt');

  f.clock.value = scheduledSecond.workflow.providerRetry.retryAt;
  const secondState = f.controller.reconcile(created.runId).workflow;
  const second = f.tasks.get(secondState.providerTask.taskId);
  assert.equal(secondState.providerTask.attempt, 2);
  f.finish(second, 'provider 429 again', 'failed', {
    failureClass: 'rate_limit',
    flags: { rate_limited: true, timed_out: false },
  });
  const scheduledThird = f.controller.reconcile(created.runId).workflow;
  assert.equal(scheduledThird.providerRetry.nextAttempt, 3);

  f.clock.value = scheduledThird.providerRetry.retryAt;
  const thirdState = f.controller.reconcile(created.runId).workflow;
  const third = f.tasks.get(thirdState.providerTask.taskId);
  assert.equal(thirdState.providerTask.attempt, 3);
  f.finish(third, 'provider 429 exhausted', 'failed', {
    failureClass: 'rate_limit',
    flags: { rate_limited: true, timed_out: false },
  });
  const failed = f.controller.reconcile(created.runId).workflow;
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.providerTaskHistory.filter((item) => item.purpose === 'final-review').length, 3);
  assert.deepEqual(
    failed.providerTaskHistory.filter((item) => item.purpose === 'final-review').map((item) => item.outcome),
    ['retry_scheduled', 'retry_scheduled', 'failed'],
  );
  assert.deepEqual(f.controller.nextActions(failed), [], 'an exhausted failure must not advertise retry');
});

test('an older terminal 429 can be explicitly recovered but an untyped semantic failure cannot', (t) => {
  const f = fixture(t);
  const created = reachReviewReady(f, createInput(f.cwd), 'APPROVE');
  const finalReview = f.controller.startFinalReview(created.runId);
  f.finish(finalReview.task, 'provider 429', 'failed', {
    failureClass: 'rate_limit', flags: { rate_limited: true },
  });
  f.pipeline.fail(created.runId, { actor: 'relaybridge', reason: 'legacy terminal behavior' });
  assert.deepEqual(f.controller.nextActions(f.pipeline.get(created.runId)), ['retry_failed_pipeline_provider']);
  f.clock.value += 60000;
  const recovered = f.controller.retryFailedProvider(created.runId, { actor: 'codex' });
  assert.equal(recovered.workflow.phase, 'final_reviewing');
  assert.equal(recovered.workflow.providerTask.attempt, 2);
  const replacement = f.tasks.get(recovered.workflow.providerTask.taskId);
  f.finish(replacement, 'REVIEW_VERDICT: APPROVE');
  assert.equal(f.controller.reconcile(created.runId).workflow.phase, 'complete');

  const other = reachReviewReady(f, { ...createInput(f.cwd), objective: 'Second workflow.' }, 'APPROVE');
  const invalid = f.controller.startFinalReview(other.runId);
  f.finish(invalid.task, 'missing marker', 'failed', { failureClass: 'provider_error' });
  f.pipeline.fail(other.runId, { actor: 'relaybridge', reason: 'semantic provider failure' });
  assert.deepEqual(f.controller.nextActions(f.pipeline.get(other.runId)), []);
  assert.throws(() => f.controller.retryFailedProvider(other.runId), (error) => {
    assert.ok(error instanceof WorkflowControllerError);
    assert.equal(error.code, 'PROVIDER_RETRY_NOT_ALLOWED');
    return true;
  });
});

test('bridge-interrupted tasks require explicit recovery instead of automatic replay', (t) => {
  const f = fixture(t);
  const created = f.controller.create(createInput(f.cwd));
  const planning = f.controller.submitResearch(created.runId, { markdown: 'research' });
  f.finish(planning.task, 'bridge restarted', 'interrupted', { execution: { state: 'uncertain' } });

  const stopped = f.controller.reconcile(created.runId);
  assert.equal(stopped.workflow.phase, 'failed');
  assert.equal(stopped.workflow.providerTask, null);
  assert.deepEqual(stopped.nextActions, []);
  assert.equal(f.tasks.size, 1, 'status polling must not overlap a potentially surviving process');

  assert.throws(() => f.controller.retryFailedProvider(created.runId, { actor: 'operator' }),
    (error) => error.code === 'EXECUTION_TERMINATION_REQUIRED');
  f.tasks.get(planning.task.id).execution = { state: 'fenced', proof: { evidenceId: 'fence_1' } };
  const recovered = f.controller.retryFailedProvider(created.runId, { actor: 'operator' });
  assert.equal(recovered.workflow.phase, 'planning');
  assert.equal(recovered.workflow.providerTask.attempt, 2);
  assert.equal(f.tasks.size, 2, 'only the explicit recovery action may dispatch a replacement');
});

test('critical planning uses Fable while safe workflows cannot grant Claude a writer lease', (t) => {
  const f = fixture(t);
  const critical = f.controller.create(createInput(f.cwd, 'critical', 'safe'));
  const planning = f.controller.submitResearch(critical.runId, { markdown: 'Critical research.' });
  assert.equal(planning.task.kind, 'claude_fable');
  assert.equal(planning.task.modelTier, 'heavy');
  assert.equal(planning.task.effort, 'high');

  f.finish(planning.task, 'PLAN_STATUS: READY');
  f.controller.reconcile(critical.runId);
  const implementation = f.controller.startImplementation(critical.runId);
  const review = f.controller.completeImplementation(critical.runId, {
    leaseToken: implementation.lease.leaseToken,
    markdown: 'Implementation evidence.',
  });
  f.finish(review.task, 'REVIEW_VERDICT: REVISE');
  f.controller.reconcile(critical.runId);
  assert.throws(() => f.controller.startRevision(critical.runId), (error) => {
    assert.ok(error instanceof WorkflowControllerError);
    assert.equal(error.code, 'FULL_PERMISSION_REQUIRED');
    return true;
  });
});

test('a rejected final review is carried into revision and queued revision cancellation releases its lock', (t) => {
  const f = fixture(t);
  const input = {
    ...createInput(f.cwd),
    providerPreferences: { revision: ['claude_fable'], finalReview: ['claude'] },
  };
  const created = reachReviewReady(f, input, 'APPROVE');
  const finalReview = f.controller.startFinalReview(created.runId);
  f.finish(finalReview.task, 'Final-only stale-cache race finding.\nREVIEW_VERDICT: REVISE');
  const rejected = f.controller.reconcile(created.runId);
  assert.equal(rejected.workflow.phase, 'review_ready');
  assert.equal(rejected.workflow.revisionRequested, true);

  const revision = f.controller.startRevision(created.runId);
  assert.equal(revision.task.kind, 'claude', 'Fable must never receive a writer lease');
  assert.match(revision.task.prompt, /## Initial review context[\s\S]*Initial review context unique/);
  assert.match(revision.task.prompt,
    /## Latest final-review findings requiring revision[\s\S]*Final-only stale-cache race finding/);

  const cancelled = f.controller.cancel(created.runId, { reason: 'Stop before the queued writer begins.' });
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(cancelled.writerLease, null);
  assert.equal(f.tasks.get(revision.task.id).status, 'cancelled');

  const replacement = reachReviewReady(f, createInput(f.cwd), 'APPROVE');
  const replacementFinal = f.controller.startFinalReview(replacement.runId);
  assert.equal(replacementFinal.workflow.phase, 'final_reviewing', 'the cancelled writer left no stale cwd lock');
});

test('invalid provider markers and task identity fail closed without authorizing a writer', (t) => {
  const planningFixture = fixture(t);
  const planningRun = planningFixture.controller.create(createInput(planningFixture.cwd));
  const planning = planningFixture.controller.submitResearch(planningRun.runId, { markdown: 'research' });
  planningFixture.finish(planning.task, 'Cannot plan this safely.\nPLAN_STATUS: BLOCKED');
  assert.equal(planningFixture.controller.reconcile(planningRun.runId).workflow.phase, 'failed');

  const identityFixture = fixture(t);
  const identityRun = identityFixture.controller.create(createInput(identityFixture.cwd));
  const identityTask = identityFixture.controller.submitResearch(identityRun.runId, { markdown: 'research' }).task;
  identityFixture.tasks.get(identityTask.id).kind = 'codex';
  assert.equal(identityFixture.controller.reconcile(identityRun.runId).workflow.phase, 'failed');

  const revisionFixture = fixture(t);
  const revisionRun = reachReviewReady(revisionFixture);
  const revision = revisionFixture.controller.startRevision(revisionRun.runId);
  revisionFixture.finish(revision.task, 'No trustworthy completion marker.');
  const failed = revisionFixture.controller.reconcile(revisionRun.runId).workflow;
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.writerLease, null);
  assert.equal(failed.providerTaskHistory.at(-1).outcome, 'failed');

  const runningFixture = fixture(t);
  const runningRun = reachReviewReady(runningFixture);
  const runningRevision = runningFixture.controller.startRevision(runningRun.runId);
  Object.assign(runningFixture.tasks.get(runningRevision.task.id), { status: 'running', kind: 'unexpected_writer' });
  assert.throws(() => runningFixture.controller.reconcile(runningRun.runId), (error) => {
    assert.ok(error instanceof WorkflowControllerError);
    assert.equal(error.code, 'WRITER_TASK_RUNNING');
    return true;
  });
  assert.equal(runningFixture.pipeline.get(runningRun.runId).phase, 'revising');
  assert.ok(runningFixture.pipeline.get(runningRun.runId).writerLease,
    'a mismatched running process must remain fenced by its lease');
  Object.assign(runningFixture.tasks.get(runningRevision.task.id), {
    status: 'failed', kind: 'claude', error: 'fixture cleanup',
  });
  runningFixture.controller.reconcile(runningRun.runId);
  assert.equal(runningFixture.pipeline.get(runningRun.runId).phase, 'failed');
});

test('reserved task IDs are bound before queue persistence and restart recovers an unbound revision', (t) => {
  const f = fixture(t);
  const created = f.controller.create(createInput(f.cwd));
  const originalSubmit = f.taskQueue.submitReserved.bind(f.taskQueue);
  f.taskQueue.submitReserved = (id, input) => {
    const state = f.pipeline.get(created.runId);
    assert.equal(state.providerTask.taskId, id, 'task correlation must be durable before queue admission');
    return originalSubmit(id, input);
  };
  const planning = f.controller.submitResearch(created.runId, { markdown: 'research' });
  assert.equal(planning.workflow.providerTask.taskId, planning.task.id);

  f.finish(planning.task, 'plan\nPLAN_STATUS: READY');
  f.controller.reconcile(created.runId);
  const implementation = f.controller.startImplementation(created.runId);
  const review = f.controller.completeImplementation(created.runId, {
    leaseToken: implementation.lease.leaseToken, markdown: 'implementation',
  });
  f.finish(review.task, 'review\nREVIEW_VERDICT: REVISE');
  f.controller.reconcile(created.runId);

  // Simulate a hard stop after lease acquisition but before an ID was bound.
  f.pipeline.startRevision(created.runId, { actor: 'claude-reviser', mode: 'provider' });
  const restartedPipeline = createWorkflowPipeline({ dataDir: f.dataDir });
  const restartedController = createWorkflowController({
    pipeline: restartedPipeline,
    taskQueue: f.taskQueue,
    loadConfig: () => f.config,
  });
  const recovered = restartedController.reconcile(created.runId).workflow;
  assert.equal(recovered.phase, 'failed');
  assert.equal(recovered.writerLease, null);
});

test('sync resumes crash-interrupted research and implementation handoffs', (t) => {
  const f = fixture(t);
  const created = f.controller.create(createInput(f.cwd));

  // Simulate a crash after the artifact transition but before controller
  // dispatch. Explicit reconciliation must perform the missing read-only handoff.
  f.pipeline.completeResearch(created.runId, { markdown: 'durable research' });
  assert.equal(f.pipeline.get(created.runId).phase, 'research_ready');
  const planning = f.controller.reconcile(created.runId).workflow;
  assert.equal(planning.phase, 'planning');
  assert.ok(planning.providerTask);
  const planningTask = f.tasks.get(planning.providerTask.taskId);
  assert.ok(planningTask);

  f.finish(planningTask, 'plan\nPLAN_STATUS: READY');
  f.controller.reconcile(created.runId);
  const implementation = f.pipeline.startImplementation(created.runId);
  f.pipeline.completeImplementation(created.runId, {
    leaseToken: implementation.lease.leaseToken,
    markdown: 'durable implementation evidence',
  });
  assert.equal(f.pipeline.get(created.runId).phase, 'implementation_ready');
  const reviewing = f.controller.reconcile(created.runId).workflow;
  assert.equal(reviewing.phase, 'reviewing');
  assert.ok(f.tasks.has(reviewing.providerTask.taskId));

  const second = f.controller.create({ ...createInput(f.cwd), objective: 'Recover an unbound planning phase.' });
  f.pipeline.completeResearch(second.runId, { markdown: 'research' });
  f.pipeline.startPlanning(second.runId);
  assert.equal(f.pipeline.get(second.runId).providerTask, null);
  assert.ok(f.controller.reconcile(second.runId).workflow.providerTask,
    'a read-only provider phase without a binding is safe to redispatch');
});

for (const state of ['interrupted', 'cancelled', 'missing', 'malformed']) {
  test(`a ${state} bound writer retains its lease until execution is fenced`, (t) => {
    const f = fixture(t);
    const created = reachReviewReady(f);
    const revision = f.controller.startRevision(created.runId);
    if (state === 'missing') f.tasks.delete(revision.task.id);
    else Object.assign(f.tasks.get(revision.task.id), { status: state === 'malformed' ? 'failed' : state,
      execution: state === 'malformed' ? {} : { state: 'uncertain' } });
    const before = f.pipeline.get(created.runId);
    assert.throws(() => f.controller.reconcile(created.runId), (e) => e.code === 'WRITER_EXECUTION_UNCERTAIN');
    assert.throws(() => f.controller.cancel(created.runId), (e) => e.code === 'WRITER_EXECUTION_UNCERTAIN');
    assert.equal(f.pipeline.get(created.runId).phase, 'revising');
    assert.equal(f.pipeline.get(created.runId).writerLease.leaseToken, before.writerLease.leaseToken);
    assert.equal(f.pipeline.get(created.runId).providerTask.taskId, revision.task.id);
    if (state !== 'missing') {
      f.tasks.get(revision.task.id).execution = { state: 'fenced', proof: { evidenceId: 'process-fence' } };
      assert.equal(f.controller.cancel(created.runId).phase, 'cancelled');
      assert.equal(f.pipeline.get(created.runId).writerLease, null);
    }
  });
}

test('a partial terminal task cannot approve a review even when its text contains APPROVE', (t) => {
  const f = fixture(t);
  const created = reachReviewReady(f, createInput(f.cwd), 'APPROVE');
  const final = f.controller.startFinalReview(created.runId);
  f.finish(final.task, 'REVIEW_VERDICT: APPROVE', 'done', { flags: { partial_result: true }, receiptId: 'rcpt_partial' });
  assert.equal(f.controller.reconcile(created.runId).workflow.phase, 'failed');
  assert.equal(f.incidents.list()[0].classification, 'partial_output');
});

test('workflow request links persist but planning success and status reads do not assert feature milestones', (t) => {
  const f = fixture(t);
  const ledgerDir = path.join(f.dataDir, 'requirements');
  const ledger = createRequestLedger({ dataDir: ledgerDir });
  const controller = createWorkflowController({ pipeline: f.pipeline, taskQueue: f.taskQueue,
    loadConfig: () => f.config, requestLedger: ledger });
  t.after(() => controller.shutdown());
  const created = controller.create(createInput(f.cwd));
  controller.createRequest({ requestId: 'req_queue', actor: 'operator', requirements: [{ requirementId: 'R13', summary: 'Counts' }] });
  controller.linkRequest(created.runId, { requestId: 'req_queue', actor: 'operator' });
  const planning = controller.submitResearch(created.runId, { markdown: 'research' });
  f.finish(planning.task, 'PLAN_STATUS: READY');
  controller.reconcile(created.runId);
  const file = path.join(ledgerDir, 'request-ledger.json');
  const before = fs.readFileSync(file, 'utf8');
  assert.deepEqual(controller.view(created.runId).requestLinks, [{ requestId: 'req_queue', requirementIds: ['R13'] }]);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(controller.getRequest('req_queue').events.length, 0);
  const revision = 'a'.repeat(40);
  controller.recordRequirementEvidence('req_queue', { eventId: 'evt_plan', requirementId: 'R13', actor: 'planner',
    revision, milestone: 'planned', outcome: 'confirmed', evidence: [{ kind: 'artifact', ref: 'plan-artifact' }],
    correlation: { runId: created.runId, taskId: planning.task.id } });
  const coverage = createRequestLedger({ dataDir: ledgerDir }).get('req_queue', { revision }).coverage[0];
  assert.equal(coverage.milestones.planned.outcome, 'confirmed');
  for (const key of ['implemented', 'tested', 'approved', 'merged', 'deployed']) assert.equal(coverage.milestones[key].outcome, 'unknown');
  assert.throws(() => f.controller.createRequest({}), (e) => e.code === 'REQUEST_LEDGER_UNAVAILABLE');
});

test('frequent uncertain-writer reconciliation cannot postpone its lease heartbeat', (t) => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const created = reachReviewReady(f);
  const revision = f.controller.startRevision(created.runId, { leaseMs: 60000 });
  Object.assign(f.tasks.get(revision.task.id), { status: 'cancelled', execution: { state: 'uncertain' } });
  const originalExpiry = f.pipeline.get(created.runId).writerLease.expiresAt;
  for (let i = 0; i < 25; i++) {
    f.clock.value += 1000;
    assert.throws(() => f.controller.reconcile(created.runId), (e) => e.code === 'WRITER_EXECUTION_UNCERTAIN');
    t.mock.timers.tick(1000);
  }
  assert.ok(f.pipeline.get(created.runId).writerLease.expiresAt > originalExpiry,
    'the existing heartbeat must run despite reconciliation on every second');
});


test('incomplete instruction or verdict authority fails durably before automatic retry', (t) => {
  for (const patch of [{ route: { prompt_truncated: true } }, { resultIntegrity: { truncated: true } },
    { resultIntegrity: { inputTruncated: true } }]) {
    const f = fixture(t);
    const created = f.controller.create(createInput(f.cwd));
    const planning = f.controller.submitResearch(created.runId, { markdown: 'Research evidence.' });
    f.finish(planning.task, 'PLAN_STATUS: READY', 'failed', { flags: { rate_limited: true }, ...patch });
    const state = f.controller.reconcile(created.runId);
    const stored = f.pipeline.get(created.runId);
    assert.equal(stored.phase, 'failed'); assert.equal(stored.providerRetry, null);
    assert.match(stored.terminal.reason, /artifact_truncated/);
    assert.equal(f.tasks.size, 1);
  }
});

// Managed-writer tests use the real durable pipeline and a fake queue, never a provider.
function reachPlanReady(f, extra = {}) {
  const run = f.controller.create({ ...createInput(f.cwd), ...extra });
  const planning = f.controller.submitResearch(run.runId, { markdown: 'Research evidence.' });
  f.finish(planning.task, 'Accepted plan.\nPLAN_STATUS: READY');
  return f.controller.reconcile(run.runId).workflow;
}

function writerFiles(f, runId) {
  return [fs.readFileSync(path.join(f.dataDir, 'workflows', runId, 'state.json'), 'utf8'),
    fs.readdirSync(path.join(f.dataDir, 'writer-locks')).map((name) =>
      [name, fs.readFileSync(path.join(f.dataDir, 'writer-locks', name), 'utf8')])];
}

test('managed initial writer binds before queue admission, completes once, and requests fresh review', (t) => {
  const f = fixture(t), run = reachPlanReady(f);
  assert.deepEqual(f.controller.view(run.runId).nextActions, ['claim_pipeline_implementation', 'start_pipeline_implementation']);
  const submit = f.taskQueue.submitReserved.bind(f.taskQueue);
  f.taskQueue.submitReserved = (id, input) => {
    const state = f.pipeline.get(run.runId);
    assert.equal(state.phase, 'implementing');
    assert.equal(state.providerTask.taskId, id);
    assert.equal(state.writerLease.mode, 'provider');
    assert.ok(!state.history.some((row) => row.event === 'implementation_completed'));
    return submit(id, input);
  };
  const started = f.controller.startManagedImplementation(run.runId);
  f.taskQueue.submitReserved = submit;
  assert.equal(f.tasks.size, 2);
  assert.equal(started.task.kind, 'claude');
  assert.equal(started.task.user, 'claude-implementer');
  assert.equal(started.task.dangerous, true);
  assert.deepEqual(started.task.correlation, { runId: run.runId, requestId: started.task.id,
    invocationId: started.task.id, attemptId: `${started.task.id}:attempt:1` });
  assert.ok(!JSON.stringify(started).includes('"leaseToken":'));
  assert.deepEqual(f.controller.view(run.runId).nextActions, ['reconcile_pipeline']);
  assert.throws(() => f.controller.completeImplementation(run.runId, { markdown: 'forged' }), { code: 'INVALID_WRITER_MODE' });
  assert.throws(() => f.controller.renewWriterLease(run.runId, {}), { code: 'INVALID_WRITER_MODE' });
  f.finish(started.task, 'Changed the scoped files; fixture checks passed.\nIMPLEMENTATION_STATUS: COMPLETE',
    'done', { execution: { state: 'settled' } });
  const reviewed = f.controller.reconcile(run.runId).workflow;
  assert.equal(reviewed.phase, 'reviewing');
  assert.equal(reviewed.writerLease, null);
  assert.equal(reviewed.providerTaskHistory.at(-1).purpose, 'implementation');
  assert.equal(reviewed.providerTaskHistory.at(-1).outcome, 'completed');
  assert.match(f.tasks.get(reviewed.providerTask.taskId).prompt, /Implementation evidence from the managed Claude writer/);
  assert.equal(f.tasks.get(reviewed.providerTask.taskId).modelTier, 'standard');
  assert.equal(f.tasks.get(reviewed.providerTask.taskId).effort, 'high');
  assert.match(f.pipeline.readArtifact(run.runId, 'implementation').content, /IMPLEMENTATION_STATUS: COMPLETE/);
  f.controller.reconcile(run.runId);
  assert.equal(f.tasks.size, 3, 'repeat reconciliation does not dispatch a second review');
});

test('managed admission refusals leave durable state, cwd locks and queue unchanged', (t) => {
  const cases = [
    ['safe', { permissionMode: 'safe' }, {}, 'FULL_PERMISSION_REQUIRED'],
    ['profile', { profile: 'codex-astra-ultra' }, {}, 'INVALID_WRITER_MODE'],
    ['preference', { providerPreferences: { implementation: ['claude_fable'] } }, {}, 'PROVIDER_RESTRICTION'],
    ['actor', {}, { actor: 'codex' }, 'PROVIDER_RESTRICTION'],
    ['owned', {}, { ownedLease: false }, 'INVALID_ARGUMENT'],
    ['scope', {}, { allowedWritePaths: ['lib/target.js'] }, 'INVALID_ARGUMENT'],
    ['model', {}, { model: 'opus' }, 'INVALID_ARGUMENT'],
    ['null lease', {}, { leaseMs: null }, 'INVALID_ARGUMENT'],
    ['small lease', {}, { leaseMs: 59999 }, 'INVALID_ARGUMENT'],
    ['large lease', {}, { leaseMs: 86400001 }, 'INVALID_ARGUMENT'],
    ['missing slot', {}, {}, 'PROVIDER_UNAVAILABLE'],
    ['conflict', {}, {}, 'WRITER_CONFLICT'],
  ];
  for (const [name, extra, input, code] of cases) {
    const f = fixture(t);
    f.config.codex = { oneshot_safe: ['codex-safe'] };
    const run = reachPlanReady(f, extra);
    if (name === 'missing slot') f.config.claude.oneshot_dangerous = [];
    if (name === 'conflict') {
      const other = reachPlanReady(f);
      f.controller.startImplementation(other.runId);
    }
    const before = writerFiles(f, run.runId), count = f.tasks.size;
    assert.throws(() => f.controller.startManagedImplementation(run.runId, input), { code }, name);
    assert.deepEqual(writerFiles(f, run.runId), before, name);
    assert.equal(f.tasks.size, count, name);
    if (name === 'safe' || name === 'profile') {
      assert.deepEqual(f.controller.view(run.runId).nextActions, ['claim_pipeline_implementation']);
    }
  }
});

test('wrong-phase managed admission never reconciles or dispatches a pending handoff', (t) => {
  for (const phase of ['research_ready', 'implementation_ready']) {
    const f = fixture(t);
    let run;
    if (phase === 'research_ready') {
      run = f.controller.create(createInput(f.cwd));
      f.pipeline.completeResearch(run.runId, { markdown: 'Research.' });
    } else {
      run = reachPlanReady(f);
      const count = f.tasks.size;
      const claimed = f.controller.startImplementation(run.runId);
      assert.equal(f.tasks.size, count, 'external claim dispatches nothing');
      f.pipeline.completeImplementation(run.runId, { leaseToken: claimed.lease.leaseToken, markdown: 'Real external evidence.' });
    }
    const before = writerFiles(f, run.runId), count = f.tasks.size;
    assert.throws(() => f.controller.startManagedImplementation(run.runId), { code: 'INVALID_TRANSITION' });
    assert.deepEqual(writerFiles(f, run.runId), before);
    assert.equal(f.tasks.size, count);
  }
});

test('unbound provider crash releases only its own reservation', (t) => {
  for (const mode of ['orphan reconcile', 'orphan cancel']) {
    const f = fixture(t), run = reachPlanReady(f);
    f.pipeline.startImplementation(run.runId, { actor: 'claude-implementer', mode: 'provider' });
    const restarted = createWorkflowController({ pipeline: createWorkflowPipeline({ dataDir: f.dataDir }),
      taskQueue: f.taskQueue, loadConfig: () => f.config });
    t.after(() => restarted.shutdown());
    if (mode === 'orphan cancel') restarted.cancel(run.runId);
    else { restarted.reconcile(run.runId); restarted.reconcile(run.runId); }
    assert.equal(f.pipeline.get(run.runId).phase, mode === 'orphan cancel' ? 'cancelled' : 'failed');
    assert.equal(f.pipeline.get(run.runId).writerLease, null);
    assert.deepEqual(fs.readdirSync(path.join(f.dataDir, 'writer-locks')), []);
    assert.equal(f.tasks.size, 1);
  }
});

for (const phase of ['implementation', 'revision']) {
  test(`${phase} submission directory-fsync failure cancels the published task before releasing the writer`,
    { skip: process.platform === 'win32' ? 'directory fsync is a POSIX queue durability barrier' : false }, (t) => {
    const f = fixture(t), run = phase === 'implementation' ? reachPlanReady(f) : reachReviewReady(f);
    const dir = path.join(f.dataDir, 'durable-tasks');
    const queue = createTaskQueue({ dataDir: dir, autoStart: false, now: () => f.clock.value,
      executeOneShot() { assert.fail('no provider should be invoked'); } });
    t.after(() => queue.shutdown());
    const controller = createWorkflowController({ pipeline: f.pipeline, taskQueue: queue,
      loadConfig: () => f.config, now: () => f.clock.value });
    t.after(() => controller.shutdown());
    const originalSync = fs.fsyncSync;
    const originalOpen = fs.openSync;
    let queueDirectoryFd = null;
    let published = null;
    t.mock.method(fs, 'openSync', (file, ...args) => {
      const fd = originalOpen(file, ...args);
      if (file === dir) queueDirectoryFd = fd;
      return fd;
    });
    t.mock.method(fs, 'fsyncSync', (fd) => {
      // Inject exactly the post-rename directory barrier failure, not a
      // fabricated submission result or a workflow-store failure.
      if (!published && fd === queueDirectoryFd && fs.fstatSync(fd).isDirectory()) {
        const name = fs.readdirSync(dir).find((entry) => /^t_.*\.json$/.test(entry));
        published = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        throw Object.assign(new Error('fixture queue directory fsync EIO'), { code: 'EIO' });
      }
      return originalSync(fd);
    });
    const start = () => phase === 'implementation' ? controller.startManagedImplementation(run.runId) : controller.startRevision(run.runId);
    assert.throws(start, /fixture queue directory fsync EIO/);
    assert.equal(published.status, 'queued');
    assert.equal(published.execution.state, 'never_started');
    const cancelled = queue.get(published.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.startedAt, null);
    assert.equal(cancelled.execution.state, 'never_started');
    assert.equal(f.pipeline.get(run.runId).phase, 'failed');
    assert.equal(f.pipeline.get(run.runId).writerLease, null);
    assert.deepEqual(fs.readdirSync(path.join(f.dataDir, 'writer-locks')), []);
    queue.shutdown();
    const restarted = createTaskQueue({ dataDir: dir, autoStart: false });
    t.after(() => restarted.shutdown());
    assert.equal(restarted.get(published.id).status, 'cancelled');
    assert.equal(restarted.stats().queued, 0, 'published work cannot re-enter the queue on restart');
  });
}

test('ambiguous submission outcomes retain the initial writer binding and fence', (t) => {
  for (const outcome of ['missing', 'identity mismatch', 'running', 'no execution proof', 'cancel throws', 'cancel not durable']) {
    const f = fixture(t), run = reachPlanReady(f);
    const submit = f.taskQueue.submitReserved.bind(f.taskQueue);
    let cancellations = 0;
    const cancel = f.taskQueue.cancel.bind(f.taskQueue);
    f.taskQueue.cancel = (id) => {
      cancellations++;
      if (outcome === 'cancel throws') throw new Error('fixture cancellation persistence failure');
      if (outcome === 'cancel not durable') return { ...f.taskQueue.get(id), status: 'cancelled' };
      return cancel(id);
    };
    f.taskQueue.submitReserved = (id, input) => {
      if (outcome !== 'missing') {
        const task = submit(id, input);
        task.execution = { state: 'never_started' };
        if (outcome === 'identity mismatch') task.body.cwd = path.join(f.cwd, 'other');
        if (outcome === 'running') Object.assign(task, { status: 'running', startedAt: f.clock.value, execution: { state: 'in_flight' } });
        if (outcome === 'no execution proof') delete task.execution;
      }
      throw new Error('fixture ambiguous submission failure');
    };
    assert.throws(() => f.controller.startManagedImplementation(run.runId), /fixture ambiguous submission failure/);
    const current = f.pipeline.get(run.runId);
    assert.equal(current.phase, 'implementing');
    assert.equal(current.providerTask.purpose, 'implementation');
    assert.equal(current.writerLease.mode, 'provider');
    assert.equal(fs.readdirSync(path.join(f.dataDir, 'writer-locks')).length, 1);
    assert.equal(cancellations, outcome.startsWith('cancel ') ? 1 : 0);
    const held = writerFiles(f, run.runId);
    if (['missing', 'identity mismatch'].includes(outcome)) {
      assert.throws(() => f.controller.reconcile(run.runId), { code: 'WRITER_EXECUTION_UNCERTAIN' });
    } else {
      assert.equal(f.controller.reconcile(run.runId).workflow.phase, 'implementing');
    }
    assert.throws(() => f.controller.cancel(run.runId), outcome === 'cancel throws'
      ? /fixture cancellation persistence failure/
      : { code: outcome === 'running' ? 'WRITER_TASK_RUNNING' : 'WRITER_EXECUTION_UNCERTAIN' });
    assert.deepEqual(writerFiles(f, run.runId), held, 'later reconcile/cancel cannot convert ambiguous admission into release');
  }
});

test('revision submission with a missing outcome cannot fall through to token-based release', (t) => {
  const f = fixture(t), run = reachReviewReady(f);
  f.taskQueue.submitReserved = () => { throw new Error('fixture ambiguous revision submission'); };
  assert.throws(() => f.controller.startRevision(run.runId), /fixture ambiguous revision submission/);
  const current = f.pipeline.get(run.runId);
  assert.equal(current.phase, 'revising');
  assert.equal(current.providerTask.purpose, 'revision');
  assert.equal(current.writerLease.mode, 'provider');
  assert.equal(fs.readdirSync(path.join(f.dataDir, 'writer-locks')).length, 1);
});

test('managed queued cancellation rechecks durable settlement before releasing the fence', (t) => {
  const f = fixture(t), run = reachPlanReady(f);
  const started = f.controller.startManagedImplementation(run.runId);
  const before = writerFiles(f, run.runId);
  const cancel = f.taskQueue.cancel.bind(f.taskQueue);
  f.taskQueue.cancel = (id) => ({ ...f.taskQueue.get(id), status: 'cancelled' });
  assert.throws(() => f.controller.cancel(run.runId), { code: 'WRITER_EXECUTION_UNCERTAIN' });
  assert.deepEqual(writerFiles(f, run.runId), before);
  f.taskQueue.cancel = () => { throw new Error('fixture cancellation write failed'); };
  assert.throws(() => f.controller.cancel(run.runId), /fixture cancellation write failed/);
  assert.deepEqual(writerFiles(f, run.runId), before);
  f.taskQueue.cancel = cancel;
  f.tasks.get(started.task.id).kind = 'wrong';
  assert.throws(() => f.controller.reconcile(run.runId), { code: 'WRITER_EXECUTION_UNCERTAIN' });
  assert.equal(f.tasks.get(started.task.id).status, 'queued', 'mismatched identity is not cancelled');
  assert.deepEqual(writerFiles(f, run.runId), before);
  f.tasks.get(started.task.id).kind = 'claude';
  assert.equal(f.controller.cancel(run.runId).phase, 'cancelled');
});

for (const mode of ['missing', 'interrupted', 'cancelled', 'malformed', 'running mismatch', 'running']) {
  test(`restarted initial writer with ${mode} task keeps its reservation until authoritative settlement`, (t) => {
    const f = fixture(t), run = reachPlanReady(f);
    const started = f.controller.startManagedImplementation(run.runId, mode === 'running' ? { leaseMs: 60000 } : {});
    f.controller.shutdown();
    if (mode === 'missing') f.tasks.delete(started.task.id);
    else Object.assign(f.tasks.get(started.task.id), mode.startsWith('running')
      ? { status: 'running', ...(mode === 'running mismatch' ? { kind: 'wrong' } : {}) }
      : { status: mode === 'malformed' ? 'failed' : mode, execution: mode === 'malformed' ? {} : { state: 'uncertain' } });
    if (mode === 'running') {
      assert.equal(started.workflow.writerLease.expiresAt - f.clock.value, 60000);
      // A bridge outage can outlast its heartbeat lease while the writer lives.
      f.clock.value = started.workflow.writerLease.expiresAt + 1;
    }
    const restored = createWorkflowController({ pipeline: createWorkflowPipeline({ dataDir: f.dataDir, now: () => f.clock.value }),
      taskQueue: f.taskQueue, loadConfig: () => f.config, now: () => f.clock.value });
    t.after(() => restored.shutdown());
    const before = writerFiles(f, run.runId), count = f.tasks.size;
    restored.view(run.runId);
    if (mode === 'running') {
      assert.ok(f.pipeline.get(run.runId).writerLease.expiresAt < f.clock.value);
      assert.equal(restored.reconcile(run.runId).workflow.phase, 'implementing');
      assert.equal(f.tasks.get(started.task.id).status, 'running');
    } else assert.throws(() => restored.reconcile(run.runId), { code: mode === 'running mismatch' ? 'WRITER_TASK_RUNNING' : 'WRITER_EXECUTION_UNCERTAIN' });
    assert.throws(() => restored.cancel(run.runId), { code: mode.startsWith('running') ? 'WRITER_TASK_RUNNING' : 'WRITER_EXECUTION_UNCERTAIN' });
    assert.deepEqual(writerFiles(f, run.runId), before, 'restart, expiry and refused cancellation retain the exact fence');
    assert.equal(f.tasks.size, count, 'no replacement writer or review is dispatched');
    if (mode !== 'missing') {
      Object.assign(f.tasks.get(started.task.id), { kind: 'claude', status: 'failed', execution: { state: 'fenced' } });
      assert.equal(restored.cancel(run.runId).phase, 'cancelled');
    }
  });
}

for (const status of ['done', 'failed']) {
  for (const evidence of ['omitted', 'null']) {
    test(`initial ${status} task with ${evidence} execution evidence retains its fence across restart and cancel`, (t) => {
      const f = fixture(t), run = reachPlanReady(f), contender = reachPlanReady(f);
      const started = f.controller.startManagedImplementation(run.runId);
      f.finish(started.task, 'Scoped implementation.\nIMPLEMENTATION_STATUS: COMPLETE', status, { execution: null });
      if (evidence === 'omitted') delete started.task.execution;
      f.controller.shutdown();
      const restored = createWorkflowController({ pipeline: createWorkflowPipeline({ dataDir: f.dataDir, now: () => f.clock.value }),
        taskQueue: f.taskQueue, loadConfig: () => f.config, now: () => f.clock.value });
      t.after(() => restored.shutdown());
      const before = writerFiles(f, run.runId), count = f.tasks.size;
      assert.throws(() => restored.reconcile(run.runId), { code: 'WRITER_EXECUTION_UNCERTAIN' });
      assert.throws(() => restored.cancel(run.runId), { code: 'WRITER_EXECUTION_UNCERTAIN' });
      assert.throws(() => restored.startImplementation(contender.runId), { code: 'WRITER_CONFLICT' });
      assert.deepEqual(writerFiles(f, run.runId), before, 'the exact lease and binding remain held');
      assert.equal(f.tasks.size, count, 'no review or replacement writer is dispatched');
      started.task.execution = { state: status === 'done' ? 'settled' : 'fenced' };
      const settled = restored.reconcile(run.runId).workflow;
      assert.equal(settled.phase, status === 'done' ? 'reviewing' : 'failed');
      assert.equal(settled.writerLease, null, 'affirmative matching terminal evidence permits settlement');
    });
  }
}

for (const [field, status, mutate] of [
  ['id', 'done', task => { task.id += '_other'; }],
  ['actor', 'failed', task => { task.user = 'other-writer'; }],
  ['provider', 'done', task => { task.kind = 'wrong-provider'; }],
  ['cwd', 'failed', task => { task.body.cwd += '-other'; }],
  ['request', 'done', task => { task.correlation.requestId += '_other'; }],
  ['invocation', 'failed', task => { task.correlation.invocationId += '_other'; }],
]) {
  test(`initial terminal ${field} mismatch cannot settle or cancel the original bound writer`, (t) => {
    const f = fixture(t), run = reachPlanReady(f), contender = reachPlanReady(f);
    const started = f.controller.startManagedImplementation(run.runId);
    f.finish(started.task, 'Scoped implementation.\nIMPLEMENTATION_STATUS: COMPLETE', status,
      { execution: { state: 'settled' } });
    const original = structuredClone(started.task);
    mutate(started.task);
    f.controller.shutdown();
    const restored = createWorkflowController({ pipeline: createWorkflowPipeline({ dataDir: f.dataDir, now: () => f.clock.value }),
      taskQueue: f.taskQueue, loadConfig: () => f.config, now: () => f.clock.value });
    t.after(() => restored.shutdown());
    const before = writerFiles(f, run.runId), count = f.tasks.size;
    assert.throws(() => restored.reconcile(run.runId), { code: 'WRITER_EXECUTION_UNCERTAIN' });
    assert.throws(() => restored.cancel(run.runId), { code: 'WRITER_EXECUTION_UNCERTAIN' });
    assert.throws(() => restored.startImplementation(contender.runId), { code: 'WRITER_CONFLICT' });
    assert.deepEqual(writerFiles(f, run.runId), before);
    assert.equal(f.tasks.size, count, 'a mismatched terminal record cannot dispatch review or retry');
    Object.assign(started.task, original, { status: 'failed', execution: { state: 'fenced' } });
    assert.equal(restored.cancel(run.runId).phase, 'cancelled', 'the exact fenced task permits operator cancellation');
  });
}

for (const evidence of ['uncertain', 'missing execution', 'terminal identity mismatch']) {
  test(`initial writer heartbeat survives ${evidence} reconciliation and stops after phase change`, (t) => {
    const f = fixture(t);
    t.mock.timers.enable({ apis: ['setInterval'] });
    const run = reachPlanReady(f), started = f.controller.startManagedImplementation(run.runId, { leaseMs: 60000 });
    Object.assign(f.tasks.get(started.task.id), { status: 'cancelled', execution: { state: 'uncertain' } });
    if (evidence === 'missing execution') {
      started.task.status = 'done';
      delete started.task.execution;
    } else if (evidence === 'terminal identity mismatch') {
      Object.assign(started.task, { status: 'done', execution: { state: 'settled' } });
      started.task.correlation.invocationId = 'other-task';
    }
    const expiry = started.workflow.writerLease.expiresAt;
    for (let i = 0; i < 25; i++) {
      f.clock.value += 1000;
      assert.throws(() => f.controller.reconcile(run.runId), { code: 'WRITER_EXECUTION_UNCERTAIN' });
      t.mock.timers.tick(1000);
    }
    assert.ok(f.pipeline.get(run.runId).writerLease.expiresAt > expiry);
    started.task.correlation.invocationId = started.task.id;
    f.finish(started.task, 'Scoped implementation.\nIMPLEMENTATION_STATUS: COMPLETE', 'done', { execution: { state: 'settled' } });
    f.controller.reconcile(run.runId);
    const before = writerFiles(f, run.runId);
    f.clock.value += 60000; t.mock.timers.tick(60000);
    assert.deepEqual(writerFiles(f, run.runId), before);
  });
}

test('initial writer terminal refusals never dispatch review or retry a writer', (t) => {
  const cases = [
    ['', {}], ['No marker.', {}], ['IMPLEMENTATION_STATUS: BLOCKED', {}],
    ['text IMPLEMENTATION_STATUS: COMPLETE', {}],
    ['IMPLEMENTATION_STATUS: COMPLETE', { resultIntegrity: { truncated: true } }],
    ['IMPLEMENTATION_STATUS: COMPLETE', { flags: { timed_out: true } }],
  ];
  for (const [result, extra] of cases) {
    const f = fixture(t), run = reachPlanReady(f), started = f.controller.startManagedImplementation(run.runId);
    f.finish(started.task, result, 'done', { execution: { state: 'settled' }, ...extra });
    const view = f.controller.reconcile(run.runId);
    assert.equal(view.workflow.phase, 'failed');
    assert.equal(view.workflow.writerLease, null);
    assert.deepEqual(view.nextActions, []);
    assert.equal(f.tasks.size, 2);
  }
});

test('retained advisor and revision records without execution metadata keep their legacy settlement behavior', (t) => {
  const f = fixture(t), run = f.controller.create(createInput(f.cwd));
  const planning = f.controller.submitResearch(run.runId, { markdown: 'Research evidence.' });
  delete planning.task.execution;
  f.finish(planning.task, 'Accepted legacy plan.\nPLAN_STATUS: READY');
  assert.equal(f.controller.reconcile(run.runId).workflow.phase, 'plan_ready');
  const claimed = f.controller.startImplementation(run.runId);
  const review = f.controller.completeImplementation(run.runId, { leaseToken: claimed.lease.leaseToken, markdown: 'External implementation.' });
  delete review.task.execution;
  f.finish(review.task, 'Legacy revision finding.\nREVIEW_VERDICT: REVISE');
  f.controller.reconcile(run.runId);
  const revision = f.controller.startRevision(run.runId);
  delete revision.task.execution;
  f.finish(revision.task, 'Legacy revision evidence.\nREVISION_STATUS: APPLIED');
  assert.equal(f.controller.reconcile(run.runId).workflow.phase, 'revision_ready');
  assert.equal(f.pipeline.get(run.runId).writerLease, null);
});

for (const taskTier of ['complex', 'critical', 'standard', 'utility', 'deterministic']) {
  test(`both managed writer phases request the accepted ${taskTier} tier`, (t) => {
    const expected = ['complex', 'critical'].includes(taskTier) ? ['heavy', 'high'] : ['standard', 'medium'];
    const f = fixture(t), run = reachPlanReady(f, { taskTier });
    const initial = f.controller.startManagedImplementation(run.runId);
    assert.deepEqual([initial.task.modelTier, initial.task.effort], expected);
    f.finish(initial.task, 'Implemented.\nIMPLEMENTATION_STATUS: COMPLETE');
    const review = f.controller.reconcile(run.runId).workflow;
    f.finish(f.tasks.get(review.providerTask.taskId), 'Finding.\nREVIEW_VERDICT: REVISE');
    f.controller.reconcile(run.runId);
    const revision = f.controller.startRevision(run.runId);
    assert.deepEqual([revision.task.modelTier, revision.task.effort], expected);
  });
}

for (const historical of [false, true]) {
  test(`reconcile preserves ${historical ? 'historical' : 'external'} initial owner without queue activity`, (t) => {
    const f = fixture(t), run = reachPlanReady(f);
    f.controller.startImplementation(run.runId);
    if (historical) {
      const file = path.join(f.dataDir, 'workflows', run.runId, 'state.json');
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      state.schemaVersion = 1; delete state.profile; delete state.phasePolicy; delete state.writerLease.mode;
      fs.writeFileSync(file, JSON.stringify(state));
    }
    const before = writerFiles(f, run.runId), count = f.tasks.size;
    f.controller.reconcile(run.runId); f.controller.reconcile(run.runId);
    assert.deepEqual(writerFiles(f, run.runId), before);
    assert.equal(f.tasks.size, count);
    assert.deepEqual(f.controller.view(run.runId).nextActions, ['complete_pipeline_implementation', 'renew_pipeline_writer_lease']);
  });
}

test('initial bound-before-submit crash remains held and a restarted running task renews', (t) => {
  const f = fixture(t), run = reachPlanReady(f), actor = 'claude-implementer', taskId = 't_reserved_only';
  t.mock.timers.enable({ apis: ['setInterval'] });
  f.pipeline.startImplementation(run.runId, { actor, mode: 'provider', leaseMs: 60000 });
  f.pipeline.bindProviderTask(run.runId, { actor, taskId, provider: 'claude', purpose: 'implementation', modelTier: 'standard', effort: 'medium' });
  const restored = createWorkflowController({ pipeline: createWorkflowPipeline({ dataDir: f.dataDir, now: () => f.clock.value }),
    taskQueue: f.taskQueue, loadConfig: () => f.config, now: () => f.clock.value });
  t.after(() => restored.shutdown());
  assert.throws(() => restored.reconcile(run.runId), { code: 'WRITER_EXECUTION_UNCERTAIN' });
  assert.equal(f.tasks.size, 1, 'restart does not invent a replacement writer');
  f.taskQueue.submitReserved(taskId, { kind: 'claude', user: actor, cwd: f.cwd, dangerous: true,
    modelTier: 'standard', model: null, effort: 'medium', requestId: taskId,
    correlation: { runId: run.runId, requestId: taskId, invocationId: taskId, attemptId: `${taskId}:attempt:1` } });
  f.tasks.get(taskId).status = 'running';
  const original = f.pipeline.get(run.runId).writerLease.expiresAt;
  restored.reconcile(run.runId);
  f.clock.value += 30000; t.mock.timers.tick(30000);
  assert.ok(f.pipeline.get(run.runId).writerLease.expiresAt > original);
});
