'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PHASES,
  TRANSITIONS,
  TASK_TIERS,
  PERMISSION_MODES,
  PROVIDER_TASK_PHASES,
  WorkflowPipelineError,
  createWorkflowPipeline,
} = require('../lib/workflow-pipeline');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-workflow-'));
  const dataDir = path.join(root, 'data');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const clock = { value: options.startTime ?? 1000000 };
  const baseOptions = {
    dataDir,
    now: () => clock.value,
    ...(options.pipeline || {}),
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    dataDir,
    cwd,
    clock,
    pipeline: createWorkflowPipeline(baseOptions),
    restart: () => createWorkflowPipeline(baseOptions),
  };
}

function create(pipeline, cwd, runId, extra = {}) {
  return pipeline.createWorkflow({
    runId,
    cwd,
    objective: '# Objective\nBuild the requested change.',
    constraints: ['Stay bounded', 'Keep state durable'],
    nonGoals: ['Unrelated refactors'],
    acceptance: '# Acceptance\nAll deterministic tests pass.',
    ...extra,
  });
}

function advanceToPlanReady(pipeline, cwd, runId, extra = {}) {
  create(pipeline, cwd, runId, extra);
  pipeline.completeResearch(runId, { markdown: '# Research\nEvidence collected.' });
  pipeline.startPlanning(runId);
  pipeline.completePlanning(runId, { markdown: '# Plan\nImplement and verify.' });
  return pipeline.get(runId);
}

function advanceToReviewReady(pipeline, cwd, runId, revisionRequested = true) {
  advanceToPlanReady(pipeline, cwd, runId);
  const { lease } = pipeline.startImplementation(runId);
  pipeline.completeImplementation(runId, {
    leaseToken: lease.leaseToken,
    markdown: '# Implementation\nChanged the target files.',
  });
  pipeline.startReview(runId);
  return pipeline.completeReview(runId, {
    markdown: '# Review\nReview is complete.',
    revisionRequested,
  });
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof WorkflowPipelineError);
    assert.equal(error.code, code);
    return true;
  });
}

test('exports the closed phase graph and validates review/revision gates through completion', (t) => {
  const { pipeline, cwd, dataDir } = fixture(t);
  const runId = 'wf_flow_111111111111';
  const created = create(pipeline, cwd, runId, {
    taskTier: 'complex',
    permissionMode: 'full',
    providerPreferences: {
      planning: ['claude_fable', 'claude'],
      implementation: ['codex'],
      review: ['claude'],
      revision: ['codex'],
      finalReview: ['claude_fable'],
    },
  });

  assert.deepEqual(PHASES.filter((phase) => !['failed', 'cancelled'].includes(phase)), [
    'scoping', 'research_ready', 'planning', 'plan_ready', 'implementing',
    'implementation_ready', 'reviewing', 'review_ready', 'revising',
    'revision_ready', 'final_reviewing', 'complete',
  ]);
  assert.ok(TRANSITIONS.review_ready.includes('final_reviewing'));
  assert.equal(created.taskTier, 'complex');
  assert.equal(created.permissionMode, 'full');
  assert.deepEqual(created.providerPreferences.planning, ['claude_fable', 'claude']);
  throwsCode(() => pipeline.startPlanning(runId), 'INVALID_TRANSITION');
  throwsCode(() => pipeline.bindProviderTask(runId, {
    actor: 'claude-planner', taskId: 't_too_early', provider: 'claude', purpose: 'planning',
  }), 'INVALID_TRANSITION');

  pipeline.completeResearch(runId, { markdown: '# Research\nCurrent evidence.' });
  pipeline.startPlanning(runId);
  pipeline.bindProviderTask(runId, {
    actor: 'claude-planner',
    taskId: 't_plan_1',
    provider: 'claude_fable',
    modelTier: 'heavy',
    effort: 'high',
    attempt: 1,
    purpose: 'planning',
  });
  throwsCode(() => pipeline.bindProviderTask(runId, {
    actor: 'claude-planner', taskId: 't_plan_2', provider: 'claude', purpose: 'planning',
  }), 'PROVIDER_TASK_ACTIVE');
  pipeline.completePlanning(runId, { markdown: '# Plan\nA concrete plan.' });
  assert.equal(pipeline.get(runId).providerTask, null);
  assert.equal(pipeline.get(runId).providerTaskHistory[0].outcome, 'completed');

  const implementation = pipeline.startImplementation(runId);
  assert.equal(implementation.workflow.phase, 'implementing');
  const stateText = fs.readFileSync(path.join(dataDir, 'workflows', runId, 'state.json'), 'utf8');
  assert.equal(stateText.includes(implementation.lease.leaseToken), false, 'plaintext lease token must not enter state');
  pipeline.completeImplementation(runId, {
    leaseToken: implementation.lease.leaseToken,
    markdown: '# Implementation\nInitial implementation.',
  });

  pipeline.startReview(runId);
  pipeline.bindProviderTask(runId, {
    actor: 'claude-reviewer', taskId: 't_review_1', provider: 'claude',
    modelTier: 'heavy', effort: 'high', attempt: 1, purpose: 'review',
  });
  pipeline.completeReview(runId, {
    actor: 'claude-reviewer', markdown: '# Review\nApproved as implemented.', revisionRequested: false,
  });
  throwsCode(() => pipeline.startRevision(runId), 'REVISION_NOT_REQUESTED');

  pipeline.startFinalReview(runId);
  pipeline.bindProviderTask(runId, {
    actor: 'claude-final-reviewer', taskId: 't_final_1', provider: 'claude_fable',
    modelTier: 'heavy', effort: 'high', attempt: 1, purpose: 'final-review',
  });
  const rejected = pipeline.completeFinalReview(runId, {
    markdown: '# Final review\nOne issue remains.', approved: false,
  });
  assert.equal(rejected.phase, 'review_ready');
  assert.equal(rejected.revisionRequested, true);
  throwsCode(() => pipeline.startFinalReview(runId), 'REVISION_REQUIRED');

  pipeline.startRevision(runId, { actor: 'codex' });
  pipeline.bindProviderTask(runId, {
    actor: 'codex', taskId: 't_revision_1', provider: 'codex',
    modelTier: 'standard', effort: 'medium', attempt: 1, purpose: 'revision',
  });
  const renewedBoundLease = pipeline.renewBoundWriterLease(runId, {
    actor: 'codex', taskId: 't_revision_1', leaseMs: 5000,
  });
  assert.equal(renewedBoundLease.lease.expiresAt, 1005000);
  assert.equal(Object.hasOwn(renewedBoundLease.lease, 'leaseToken'), false,
    'bound-task renewal must not expose the plaintext token');
  throwsCode(() => pipeline.completeBoundRevision(runId, {
    actor: 'codex', taskId: 't_wrong_revision', markdown: '# Revision\nWrong task.',
  }), 'PROVIDER_TASK_MISMATCH');
  const revised = pipeline.completeBoundRevision(runId, {
    actor: 'codex', taskId: 't_revision_1', markdown: '# Revision\nIssue fixed.',
  });
  assert.equal(revised.phase, 'revision_ready');
  assert.equal(revised.revisionCycle, 1);
  assert.equal(revised.revisionRequested, false);
  assert.equal(revised.writerLease, null);

  pipeline.startFinalReview(runId);
  pipeline.completeFinalReview(runId, {
    markdown: '# Final review\nA second issue remains.', approved: false,
  });
  const secondRevision = pipeline.startRevision(runId);
  pipeline.completeRevision(runId, {
    leaseToken: secondRevision.lease.leaseToken,
    markdown: '# Revision\nSecond issue fixed.',
  });
  pipeline.requestAdditionalReview(runId, { reason: 'Verify the actual fix.' });
  pipeline.completeReview(runId, {
    markdown: '# Review\nVerified; no further change.', revisionRequested: false,
  });
  pipeline.startFinalReview(runId);
  const completed = pipeline.completeFinalReview(runId, {
    markdown: '# Final review\nApproved.', approved: true,
  });
  assert.equal(completed.phase, 'complete');
  assert.equal(completed.terminal.status, 'complete');
  throwsCode(() => pipeline.cancel(runId, {}), 'WORKFLOW_TERMINAL');
  assert.equal(pipeline.list({ phase: 'complete' })[0].runId, runId);
});

test('restart preserves workflow routing, state, artifacts, and a live writer lease', (t) => {
  const { pipeline, restart, cwd } = fixture(t);
  const runId = 'wf_restart_222222222222';
  advanceToPlanReady(pipeline, cwd, runId, {
    taskTier: 'critical',
    permissionMode: 'safe',
    providerPreferences: { planning: ['claude_fable'], revision: ['codex'] },
  });
  const started = pipeline.startImplementation(runId, { actor: 'codex', leaseMs: 5000 });

  const afterRestart = restart();
  const restored = afterRestart.get(runId);
  assert.equal(restored.phase, 'implementing');
  assert.equal(restored.taskTier, 'critical');
  assert.equal(restored.permissionMode, 'safe');
  assert.deepEqual(restored.providerPreferences.planning, ['claude_fable']);
  assert.match(afterRestart.readArtifact(runId, 'plan').content, /Implement and verify/);
  const finished = afterRestart.completeImplementation(runId, {
    actor: 'codex',
    leaseToken: started.lease.leaseToken,
    markdown: '# Implementation\nCompleted after process restart.',
  });
  assert.equal(finished.phase, 'implementation_ready');
});

test('one canonical cwd has one writer; only an expired lock may be reclaimed', (t) => {
  const { pipeline, cwd, root, clock } = fixture(t, { pipeline: { leaseMs: 100 } });
  const alias = path.join(root, 'project-alias');
  fs.symlinkSync(cwd, alias, 'dir');
  const firstId = 'wf_first_333333333333';
  const secondId = 'wf_second_444444444444';
  advanceToPlanReady(pipeline, cwd, firstId);
  advanceToPlanReady(pipeline, alias, secondId);
  assert.equal(pipeline.get(firstId).cwd, pipeline.get(secondId).cwd, 'symlink paths must canonicalize');

  const first = pipeline.startImplementation(firstId, { actor: 'codex-a' });
  clock.value += 99;
  throwsCode(() => pipeline.startImplementation(secondId, { actor: 'codex-b' }), 'WRITER_CONFLICT');
  clock.value += 1;
  const second = pipeline.startImplementation(secondId, { actor: 'codex-b' });
  assert.notEqual(second.lease.leaseToken, first.lease.leaseToken);
  throwsCode(() => pipeline.completeImplementation(firstId, {
    actor: 'codex-a', leaseToken: first.lease.leaseToken, markdown: '# Implementation\nStale writer.',
  }), 'LEASE_MISMATCH');
  const done = pipeline.completeImplementation(secondId, {
    actor: 'codex-b', leaseToken: second.lease.leaseToken, markdown: '# Implementation\nCurrent writer.',
  });
  assert.equal(done.phase, 'implementation_ready');
});

test('wrong actor or token cannot complete, renew, release, or terminate a writer lease', (t) => {
  const { pipeline, cwd, clock } = fixture(t);
  const runId = 'wf_tokens_555555555555';
  advanceToPlanReady(pipeline, cwd, runId);
  const started = pipeline.startImplementation(runId, { actor: 'codex', leaseMs: 1000 });
  const wrong = `${started.lease.leaseToken[0] === '0' ? '1' : '0'}${started.lease.leaseToken.slice(1)}`;

  throwsCode(() => pipeline.completeImplementation(runId, {
    actor: 'codex', leaseToken: wrong, markdown: '# Implementation\nNo.',
  }), 'LEASE_MISMATCH');
  throwsCode(() => pipeline.renewWriterLease(runId, {
    actor: 'intruder', leaseToken: started.lease.leaseToken,
  }), 'LEASE_MISMATCH');
  throwsCode(() => pipeline.cancel(runId, {
    actor: 'codex', leaseToken: wrong, reason: 'Should not release.',
  }), 'LEASE_MISMATCH');
  assert.equal(pipeline.get(runId).phase, 'implementing');

  clock.value += 10;
  const renewed = pipeline.renewWriterLease(runId, {
    actor: 'codex', leaseToken: started.lease.leaseToken, leaseMs: 2000,
  });
  assert.equal(renewed.lease.expiresAt, clock.value + 2000);
  const cancelled = pipeline.cancel(runId, {
    actor: 'codex', leaseToken: started.lease.leaseToken, reason: 'Operator cancelled the run.',
  });
  assert.equal(cancelled.phase, 'cancelled');

  const replacement = 'wf_replace_666666666666';
  advanceToPlanReady(pipeline, cwd, replacement);
  assert.equal(pipeline.startImplementation(replacement).workflow.phase, 'implementing');
});

test('bound writer recovery survives restart and releases only its own expired lock', (t) => {
  const { pipeline, restart, cwd, clock } = fixture(t, { pipeline: { leaseMs: 100 } });
  const runId = 'wf_recover_777777777777';
  advanceToReviewReady(pipeline, cwd, runId, true);
  pipeline.startRevision(runId, { actor: 'claude-reviser' });
  pipeline.bindProviderTask(runId, {
    actor: 'claude-reviser', taskId: 't_revision_recovery', provider: 'claude',
    modelTier: 'heavy', effort: 'high', attempt: 2, purpose: 'revision',
  });
  clock.value += 101;

  const recovered = restart();
  throwsCode(() => recovered.failBoundWriterTask(runId, {
    actor: 'claude-reviser', taskId: 't_someone_else', reason: 'No.',
  }), 'PROVIDER_TASK_MISMATCH');
  const failed = recovered.failBoundWriterTask(runId, {
    actor: 'claude-reviser', taskId: 't_revision_recovery', reason: 'Provider process was interrupted.',
  });
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.writerLease, null);
  assert.equal(failed.providerTask, null);
  assert.equal(failed.providerTaskHistory.at(-1).outcome, 'failed');

  const nextId = 'wf_after_888888888888';
  advanceToPlanReady(recovered, cwd, nextId);
  assert.equal(recovered.startImplementation(nextId).workflow.phase, 'implementing');
});

test('every Markdown artifact is capped and content hashes are verified', (t) => {
  const { pipeline, cwd, dataDir } = fixture(t, {
    pipeline: { maxArtifactChars: 96, maxHistoryEntries: 3 },
  });
  const runId = 'wf_caps_999999999999';
  const long = `BEGIN-${'x'.repeat(1000)}-END`;
  pipeline.createWorkflow({
    runId,
    cwd,
    objective: long,
    constraints: long,
    nonGoals: long,
    acceptance: long,
  });

  for (const kind of ['objective', 'constraints', 'non-goals', 'acceptance']) {
    const artifact = pipeline.readArtifact(runId, kind);
    assert.ok(artifact.content.length <= 96);
    assert.equal(artifact.storedChars, artifact.content.length);
    assert.equal(artifact.originalChars, long.length);
    assert.equal(artifact.truncated, true);
    assert.equal(artifact.sha256, crypto.createHash('sha256').update(artifact.content).digest('hex'));
    assert.match(artifact.content, /RelayBridge truncated/);
  }

  pipeline.completeResearch(runId, { markdown: long });
  pipeline.startPlanning(runId);
  pipeline.completePlanning(runId, { markdown: long });
  const state = pipeline.get(runId);
  assert.ok(state.history.length <= 3);
  assert.ok(state.artifactHistory.length <= 3);
  assert.ok(state.historyDropped > 0);
  assert.ok(state.artifactHistoryDropped > 0);

  const researchPath = path.join(dataDir, 'workflows', runId, 'artifacts', 'research.md');
  fs.writeFileSync(researchPath, 'tampered', 'utf8');
  throwsCode(() => pipeline.readArtifact(runId, 'research'), 'ARTIFACT_INTEGRITY');
});

test('provider task history is bounded and task identity/purpose are strict', (t) => {
  const { pipeline, cwd } = fixture(t, { pipeline: { maxHistoryEntries: 2 } });
  const runId = 'wf_tasks_aaaaaaaaaaaa';
  create(pipeline, cwd, runId);
  pipeline.completeResearch(runId, { markdown: 'research' });
  pipeline.startPlanning(runId);
  throwsCode(() => pipeline.bindProviderTask(runId, {
    actor: 'planner', taskId: '../escape', provider: 'claude', purpose: 'planning',
  }), 'INVALID_PROVIDER_TASK');
  throwsCode(() => pipeline.bindProviderTask(runId, {
    actor: 'planner', taskId: 't_plan', provider: 'Claude', purpose: 'planning',
  }), 'INVALID_PROVIDER_TASK');
  throwsCode(() => pipeline.bindProviderTask(runId, {
    actor: 'planner', taskId: 't_plan', provider: 'claude', purpose: 'review',
  }), 'INVALID_PROVIDER_TASK');
  pipeline.bindProviderTask(runId, {
    actor: 'planner', taskId: 't_plan', provider: 'claude', purpose: 'planning',
  });
  pipeline.completePlanning(runId, { actor: 'planner', markdown: 'plan' });
  const lease = pipeline.startImplementation(runId).lease;
  pipeline.completeImplementation(runId, { leaseToken: lease.leaseToken, markdown: 'implementation' });
  pipeline.startReview(runId);
  pipeline.bindProviderTask(runId, {
    actor: 'reviewer', taskId: 't_review', provider: 'claude', purpose: 'review',
  });
  pipeline.completeReview(runId, { actor: 'reviewer', markdown: 'review', revisionRequested: false });
  pipeline.startFinalReview(runId);
  pipeline.bindProviderTask(runId, {
    actor: 'final-reviewer', taskId: 't_final', provider: 'claude', purpose: 'final-review',
  });
  const complete = pipeline.completeFinalReview(runId, {
    actor: 'final-reviewer', markdown: 'approved', approved: true,
  });
  assert.equal(complete.providerTaskHistory.length, 2);
  assert.equal(complete.providerTaskHistoryDropped, 1);
  assert.deepEqual(complete.providerTaskHistory.map((task) => task.taskId), ['t_review', 't_final']);
});

test('strict IDs, routing values, missing gets, and symlink storage escapes fail closed', (t) => {
  const { pipeline, cwd, dataDir, root } = fixture(t);
  assert.equal(pipeline.get('wf_missing_bbbbbbbbbbbb'), null);
  throwsCode(() => pipeline.get('../state'), 'INVALID_RUN_ID');
  throwsCode(() => create(pipeline, 'relative/path', 'wf_relative_cccccccccccc'), 'INVALID_CWD');
  throwsCode(() => create(pipeline, cwd, 'wf_tier_dddddddddddd', { taskTier: 'enormous' }), 'INVALID_ARGUMENT');
  throwsCode(() => create(pipeline, cwd, 'wf_mode_eeeeeeeeeeee', { permissionMode: 'dangerous' }), 'INVALID_ARGUMENT');
  throwsCode(() => create(pipeline, cwd, 'wf_pref_ffffffffffff', {
    providerPreferences: { unknownStage: ['claude'] },
  }), 'INVALID_ARGUMENT');
  assert.deepEqual(TASK_TIERS, ['deterministic', 'utility', 'standard', 'complex', 'critical']);
  assert.deepEqual(PERMISSION_MODES, ['safe', 'full']);
  assert.equal(PROVIDER_TASK_PHASES.final_reviewing, 'final-review');

  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  const evilId = 'wf_evil_abcdefabcdef';
  fs.symlinkSync(outside, path.join(dataDir, 'workflows', evilId), 'dir');
  throwsCode(() => pipeline.get(evilId), 'PATH_ESCAPE');
  assert.equal(pipeline.list().some((row) => row.runId === evilId), false);
});
