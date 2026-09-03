'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkflowPipeline } = require('../lib/workflow-pipeline');
const { createWorkflowController, WorkflowControllerError } = require('../lib/workflow-controller');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-controller-'));
  const cwd = path.join(root, 'project');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const tasks = new Map();
  let sequence = 0;
  const taskQueue = {
    newTaskId() { return `t_fake_${++sequence}`; },
    submit(input) { return this.submitReserved(this.newTaskId(), input); },
    submitReserved(id, input) {
      if (tasks.has(id)) throw new Error('task id already exists');
      const task = { id, status: 'queued', ...input };
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
  const pipeline = createWorkflowPipeline({ dataDir });
  const controller = createWorkflowController({ pipeline, taskQueue, loadConfig: () => config });
  return {
    cwd,
    dataDir,
    tasks,
    taskQueue,
    config,
    pipeline,
    controller,
    finish(task, result, status = 'done') {
      Object.assign(tasks.get(task.id), { status, result, error: status === 'done' ? null : result });
    },
  };
}

function reachReviewReady(f, input = createInput(f.cwd), verdict = 'REVISE') {
  const created = f.controller.create(input);
  const planning = f.controller.submitResearch(created.runId, { markdown: 'Research evidence.' });
  f.finish(planning.task, 'Plan details.\nPLAN_STATUS: READY');
  f.controller.view(created.runId);
  const implementation = f.controller.startImplementation(created.runId);
  const review = f.controller.completeImplementation(created.runId, {
    leaseToken: implementation.lease.leaseToken,
    markdown: 'Implementation evidence.',
  });
  f.finish(review.task, `Initial review context unique.\nREVIEW_VERDICT: ${verdict}`);
  f.controller.view(created.runId);
  return created;
}

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
  assert.equal(f.controller.view(created.runId).workflow.phase, 'plan_ready');

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
  const reviewed = f.controller.view(created.runId);
  assert.equal(reviewed.workflow.phase, 'review_ready');
  assert.deepEqual(reviewed.nextActions, ['start_pipeline_revision']);

  const revision = f.controller.startRevision(created.runId);
  assert.equal(revision.workflow.phase, 'revising');
  assert.equal(revision.task.kind, 'claude');
  assert.equal(revision.task.modelTier, 'standard');
  assert.equal(revision.task.effort, 'medium');
  assert.equal(revision.task.dangerous, true);
  assert.equal(revision.workflow.writerLease.actor, 'claude-reviser');

  f.finish(revision.task, '# Revision\nAdded the assertion; tests pass.\n\nREVISION_STATUS: APPLIED');
  const revised = f.controller.view(created.runId);
  assert.equal(revised.workflow.phase, 'revision_ready');
  assert.equal(revised.workflow.writerLease, null);

  const finalReview = f.controller.startFinalReview(created.runId);
  assert.equal(finalReview.workflow.phase, 'final_reviewing');
  assert.match(finalReview.task.title, /final-review/);
  f.finish(finalReview.task, '# Final review\nNo material findings.\n\nREVIEW_VERDICT: APPROVE');
  const completed = f.controller.view(created.runId);
  assert.equal(completed.workflow.phase, 'complete');
  assert.deepEqual(completed.nextActions, []);
});

test('critical planning uses Fable while safe workflows cannot grant Claude a writer lease', (t) => {
  const f = fixture(t);
  const critical = f.controller.create(createInput(f.cwd, 'critical', 'safe'));
  const planning = f.controller.submitResearch(critical.runId, { markdown: 'Critical research.' });
  assert.equal(planning.task.kind, 'claude_fable');
  assert.equal(planning.task.modelTier, 'heavy');
  assert.equal(planning.task.effort, 'high');

  f.finish(planning.task, 'PLAN_STATUS: READY');
  f.controller.view(critical.runId);
  const implementation = f.controller.startImplementation(critical.runId);
  const review = f.controller.completeImplementation(critical.runId, {
    leaseToken: implementation.lease.leaseToken,
    markdown: 'Implementation evidence.',
  });
  f.finish(review.task, 'REVIEW_VERDICT: REVISE');
  f.controller.view(critical.runId);
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
  const rejected = f.controller.view(created.runId);
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
  assert.equal(planningFixture.controller.view(planningRun.runId).workflow.phase, 'failed');

  const identityFixture = fixture(t);
  const identityRun = identityFixture.controller.create(createInput(identityFixture.cwd));
  const identityTask = identityFixture.controller.submitResearch(identityRun.runId, { markdown: 'research' }).task;
  identityFixture.tasks.get(identityTask.id).kind = 'codex';
  assert.equal(identityFixture.controller.view(identityRun.runId).workflow.phase, 'failed');

  const revisionFixture = fixture(t);
  const revisionRun = reachReviewReady(revisionFixture);
  const revision = revisionFixture.controller.startRevision(revisionRun.runId);
  revisionFixture.finish(revision.task, 'No trustworthy completion marker.');
  const failed = revisionFixture.controller.view(revisionRun.runId).workflow;
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.writerLease, null);
  assert.equal(failed.providerTaskHistory.at(-1).outcome, 'failed');

  const runningFixture = fixture(t);
  const runningRun = reachReviewReady(runningFixture);
  const runningRevision = runningFixture.controller.startRevision(runningRun.runId);
  Object.assign(runningFixture.tasks.get(runningRevision.task.id), { status: 'running', kind: 'unexpected_writer' });
  assert.throws(() => runningFixture.controller.view(runningRun.runId), (error) => {
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
  runningFixture.controller.view(runningRun.runId);
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
  f.controller.view(created.runId);
  const implementation = f.controller.startImplementation(created.runId);
  const review = f.controller.completeImplementation(created.runId, {
    leaseToken: implementation.lease.leaseToken, markdown: 'implementation',
  });
  f.finish(review.task, 'review\nREVIEW_VERDICT: REVISE');
  f.controller.view(created.runId);

  // Simulate a hard stop after lease acquisition but before an ID was bound.
  f.pipeline.startRevision(created.runId, { actor: 'claude-reviser' });
  const restartedPipeline = createWorkflowPipeline({ dataDir: f.dataDir });
  const restartedController = createWorkflowController({
    pipeline: restartedPipeline,
    taskQueue: f.taskQueue,
    loadConfig: () => f.config,
  });
  const recovered = restartedController.view(created.runId).workflow;
  assert.equal(recovered.phase, 'failed');
  assert.equal(recovered.writerLease, null);
});

test('sync resumes crash-interrupted research and implementation handoffs', (t) => {
  const f = fixture(t);
  const created = f.controller.create(createInput(f.cwd));

  // Simulate a crash after the artifact transition but before controller
  // dispatch. GET/sync must perform the missing read-only handoff.
  f.pipeline.completeResearch(created.runId, { markdown: 'durable research' });
  assert.equal(f.pipeline.get(created.runId).phase, 'research_ready');
  const planning = f.controller.view(created.runId).workflow;
  assert.equal(planning.phase, 'planning');
  assert.ok(planning.providerTask);
  const planningTask = f.tasks.get(planning.providerTask.taskId);
  assert.ok(planningTask);

  f.finish(planningTask, 'plan\nPLAN_STATUS: READY');
  f.controller.view(created.runId);
  const implementation = f.pipeline.startImplementation(created.runId);
  f.pipeline.completeImplementation(created.runId, {
    leaseToken: implementation.lease.leaseToken,
    markdown: 'durable implementation evidence',
  });
  assert.equal(f.pipeline.get(created.runId).phase, 'implementation_ready');
  const reviewing = f.controller.view(created.runId).workflow;
  assert.equal(reviewing.phase, 'reviewing');
  assert.ok(f.tasks.has(reviewing.providerTask.taskId));

  const second = f.controller.create({ ...createInput(f.cwd), objective: 'Recover an unbound planning phase.' });
  f.pipeline.completeResearch(second.runId, { markdown: 'research' });
  f.pipeline.startPlanning(second.runId);
  assert.equal(f.pipeline.get(second.runId).providerTask, null);
  assert.ok(f.controller.view(second.runId).workflow.providerTask,
    'a read-only provider phase without a binding is safe to redispatch');
});
