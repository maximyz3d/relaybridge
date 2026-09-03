'use strict';

const {
  buildPlanningPrompt,
  buildReviewPrompt,
  buildRevisionPrompt,
  parsePlanStatus,
  parseReviewVerdict,
  parseRevisionStatus,
} = require('./workflow-prompts');

const TASK_TERMINAL = new Set(['done', 'failed', 'cancelled', 'interrupted']);
const WORKFLOW_TERMINAL = new Set(['complete', 'failed', 'cancelled']);
const PROVIDER_PHASES = new Set(['planning', 'reviewing', 'revising', 'final_reviewing']);
const DEFAULT_CODEX_LEASE_MS = 4 * 60 * 60 * 1000;
const DEFAULT_CLAUDE_LEASE_MS = 60 * 60 * 1000;
const MIN_CLAUDE_LEASE_MS = 60 * 1000;

class WorkflowControllerError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'WorkflowControllerError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new WorkflowControllerError(code, message, details);
}

function taskTier(value) {
  return ['utility', 'standard', 'complex', 'critical'].includes(value) ? value : 'standard';
}

function modelTierFor(value) {
  return value === 'utility' ? 'light'
    : value === 'complex' || value === 'critical' ? 'heavy' : 'standard';
}

function effortFor(value) {
  return value === 'utility' ? 'low'
    : value === 'complex' || value === 'critical' ? 'high' : 'medium';
}

function cleanList(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function artifactList(value) {
  return String(value || '')
    .split('\n')
    .map((item) => item.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '').trim())
    .filter(Boolean);
}

function createWorkflowController(options = {}) {
  const { pipeline, taskQueue, loadConfig } = options;
  if (!pipeline || typeof pipeline.get !== 'function') fail('INVALID_ARGUMENT', 'pipeline is required');
  if (!taskQueue || typeof taskQueue.submit !== 'function' || typeof taskQueue.submitReserved !== 'function'
    || typeof taskQueue.newTaskId !== 'function' || typeof taskQueue.get !== 'function') {
    fail('INVALID_ARGUMENT', 'taskQueue is required');
  }
  if (typeof loadConfig !== 'function') fail('INVALID_ARGUMENT', 'loadConfig is required');
  const log = typeof options.log === 'function' ? options.log : () => {};
  const revisionHeartbeats = new Map();

  function clearRevisionHeartbeat(runId) {
    const timer = revisionHeartbeats.get(runId);
    if (timer) clearInterval(timer);
    revisionHeartbeats.delete(runId);
  }

  function maintainRevisionLease(runId, actor, taskId, leaseMs) {
    if (typeof pipeline.renewBoundWriterLease !== 'function') {
      fail('PIPELINE_CAPABILITY_MISSING', 'pipeline lacks bound-writer lease renewal');
    }
    clearRevisionHeartbeat(runId);
    const intervalMs = Math.max(1000, Math.min(30000, Math.floor(leaseMs / 3)));
    const timer = setInterval(() => {
      const workflow = pipeline.get(runId);
      if (!workflow || workflow.phase !== 'revising' || workflow.providerTask?.taskId !== taskId) {
        clearRevisionHeartbeat(runId);
        return;
      }
      const task = taskQueue.get(taskId);
      if (!task || TASK_TERMINAL.has(task.status)) {
        clearRevisionHeartbeat(runId);
        try { sync(runId); }
        catch (error) { log(`[RelayBridge] workflow ${runId}: terminal revision reconciliation failed: ${error.message}`); }
        return;
      }
      try {
        pipeline.renewBoundWriterLease(runId, { actor, taskId, leaseMs });
      } catch (error) {
        // Never release a lease merely because its heartbeat failed: the
        // provider may still be modifying the workspace. Keep polling so its
        // terminal state can be reconciled without authorizing another writer.
        log(`[RelayBridge] workflow ${runId}: revision lease heartbeat failed: ${error.message}`);
      }
    }, intervalMs);
    timer.unref?.();
    revisionHeartbeats.set(runId, timer);
  }

  function requireWorkflow(runId) {
    const workflow = pipeline.get(runId);
    if (!workflow) fail('WORKFLOW_NOT_FOUND', 'workflow was not found');
    return workflow;
  }

  function artifact(runId, kind) {
    return pipeline.readArtifact(runId, kind)?.content || '';
  }

  function promptInput(workflow) {
    return {
      runId: workflow.runId,
      cwd: workflow.cwd,
      taskTier: workflow.taskTier,
      objective: artifact(workflow.runId, 'objective'),
      constraints: artifactList(artifact(workflow.runId, 'constraints')),
      nonGoals: artifactList(artifact(workflow.runId, 'non-goals')),
      fileScope: artifactList(artifact(workflow.runId, 'file-scope')),
      baseRevision: artifact(workflow.runId, 'base-revision'),
      acceptanceCriteria: artifactList(artifact(workflow.runId, 'acceptance')),
      research: artifact(workflow.runId, 'research'),
      plan: artifact(workflow.runId, 'plan'),
      implementation: artifact(workflow.runId, 'implementation'),
      review: artifact(workflow.runId, 'review'),
      revision: artifact(workflow.runId, 'revision'),
      finalReview: artifact(workflow.runId, 'final-review'),
    };
  }

  function defaultProviders(workflow, purpose) {
    if (purpose === 'revision') return ['claude'];
    if (purpose === 'planning' && workflow.taskTier === 'critical') return ['claude_fable', 'claude'];
    return ['claude'];
  }

  function chooseProvider(workflow, purpose, { dangerous = false } = {}) {
    const config = loadConfig();
    const preferred = cleanList(workflow.providerPreferences?.[purpose]);
    // The revision prompt has a real writer lease. Keep that capability on the
    // deliberately configured Claude/Sonnet seat even if a persisted routing
    // preference names Fable or another planning-only provider.
    const candidates = purpose === 'revision'
      ? ['claude']
      : [...new Set([...preferred, ...defaultProviders(workflow, purpose)])];
    for (const kind of candidates) {
      const entry = config[kind];
      const slot = dangerous ? entry?.oneshot_dangerous : entry?.oneshot_safe;
      if (entry && Array.isArray(slot) && slot.length) return kind;
    }
    fail('PROVIDER_UNAVAILABLE', `no configured ${dangerous ? 'writer' : 'read-only'} provider can run ${purpose}`, {
      purpose,
      candidates,
    });
  }

  function dispatchSpec(workflow, purpose) {
    const dangerous = purpose === 'revision';
    const provider = chooseProvider(workflow, purpose, { dangerous });
    const planning = purpose === 'planning';
    const reviewing = purpose === 'review' || purpose === 'finalReview';
    const hardPlan = planning && (workflow.taskTier === 'complex' || workflow.taskTier === 'critical');
    return {
      provider,
      dangerous,
      // A detailed plan makes revision a bounded coding task: keep it on
      // Sonnet/standard even when Fable or Opus prepared a complex plan.
      modelTier: dangerous || reviewing ? 'standard' : modelTierFor(workflow.taskTier),
      effort: dangerous ? 'medium' : reviewing ? 'high' : effortFor(workflow.taskTier),
      routeReason: dangerous
        ? 'bounded Claude writer revision after an accepted plan and independent review'
        : reviewing ? 'fresh read-only review uses Sonnet with high reasoning effort'
          : hardPlan ? 'hard read-only planning uses Opus or the explicit Fable tier'
            : 'standard read-only planning uses Sonnet-class reasoning',
    };
  }

  function submitProviderTask(workflow, purpose, prompt, actor, spec) {
    const taskId = taskQueue.newTaskId();
    const taskInput = {
      kind: spec.provider,
      prompt,
      cwd: workflow.cwd,
      dangerous: spec.dangerous,
      taskTier: workflow.taskTier,
      modelTier: spec.modelTier,
      effort: spec.effort,
      maxEffortOverride: false,
      user: actor,
      source: 'workflow',
      title: `${workflow.runId}: ${purpose}`,
      intent: `${workflow.runId} ${purpose}; ${spec.routeReason}`,
    };
    // Commit the correlation before making the provider task runnable. If the
    // process dies after this write, sync() sees a missing task and releases a
    // revision lease safely; the inverse ordering could leave an untracked
    // dangerous task executing after restart.
    pipeline.bindProviderTask(workflow.runId, {
      actor,
      taskId,
      provider: spec.provider,
      modelTier: spec.modelTier,
      effort: spec.effort,
      attempt: 1,
      purpose,
    });
    let task;
    try {
      task = taskQueue.submitReserved(taskId, taskInput);
    } catch (error) {
      const reason = `${purpose} task persistence failed: ${error.message}`;
      if (purpose === 'revision') {
        pipeline.failBoundWriterTask(workflow.runId, { actor, taskId, reason });
      } else {
        pipeline.fail(workflow.runId, { actor: 'relaybridge', reason });
      }
      throw error;
    }
    log(`[RelayBridge] workflow ${workflow.runId}: ${purpose} queued as ${task.id} on ${spec.provider}`);
    return { workflow: requireWorkflow(workflow.runId), task, dispatch: spec };
  }

  function dispatchPlanning(started) {
    const actor = 'claude-planner';
    try {
      return submitProviderTask(
        started,
        'planning',
        buildPlanningPrompt(promptInput(started)),
        actor,
        dispatchSpec(started, 'planning'),
      );
    } catch (error) {
      if (!WORKFLOW_TERMINAL.has(requireWorkflow(started.runId).phase)) {
        pipeline.fail(started.runId, { actor: 'relaybridge', reason: `planning dispatch failed: ${error.message}` });
      }
      throw error;
    }
  }

  function beginPlanning(workflow) {
    pipeline.startPlanning(workflow.runId, { actor: 'claude-planner' });
    return dispatchPlanning(requireWorkflow(workflow.runId));
  }

  function dispatchReview(started, { final = false } = {}) {
    const preferenceKey = final ? 'finalReview' : 'review';
    const purpose = final ? 'final-review' : 'review';
    const actor = final ? 'claude-final-reviewer' : 'claude-reviewer';
    try {
      return submitProviderTask(
        started,
        purpose,
        buildReviewPrompt(promptInput(started), { final }),
        actor,
        dispatchSpec(started, preferenceKey),
      );
    } catch (error) {
      if (!WORKFLOW_TERMINAL.has(requireWorkflow(started.runId).phase)) {
        pipeline.fail(started.runId, { actor: 'relaybridge', reason: `${preferenceKey} dispatch failed: ${error.message}` });
      }
      throw error;
    }
  }

  function beginReview(workflow, { final = false } = {}) {
    const actor = final ? 'claude-final-reviewer' : 'claude-reviewer';
    if (final) pipeline.startFinalReview(workflow.runId, { actor });
    else pipeline.startReview(workflow.runId, { actor });
    return dispatchReview(requireWorkflow(workflow.runId), { final });
  }

  function providerFailure(workflow, task) {
    const reason = `${workflow.phase} provider task ${task.id} ${task.status}: ${task.error || task.stderr || 'no result'}`;
    if (workflow.phase === 'revising' && typeof pipeline.failBoundWriterTask === 'function') {
      if (task.status === 'running') {
        fail('WRITER_TASK_RUNNING', 'cannot release the writer lease while the Claude writer process is still running');
      }
      if (!TASK_TERMINAL.has(task.status)) {
        try { taskQueue.cancel(task.id); } catch {}
      }
      clearRevisionHeartbeat(workflow.runId);
      return pipeline.failBoundWriterTask(workflow.runId, {
        actor: workflow.providerTask?.actor || 'claude-reviser',
        taskId: task.id,
        reason,
      });
    }
    return pipeline.fail(workflow.runId, { actor: 'relaybridge', reason });
  }

  function settleProviderTask(workflow, task) {
    if (workflow.phase === 'revising') clearRevisionHeartbeat(workflow.runId);
    if (task.status !== 'done') return providerFailure(workflow, task);
    const markdown = String(task.result || '').trim();
    if (!markdown) return providerFailure(workflow, { ...task, status: 'failed', error: 'provider returned empty output' });

    switch (workflow.phase) {
      case 'planning': {
        const status = parsePlanStatus(markdown);
        if (status !== 'READY') {
          return providerFailure(workflow, {
            ...task,
            error: `Claude planning did not produce a READY completion marker (received ${status}).`,
          });
        }
        return pipeline.completePlanning(workflow.runId, { actor: 'claude-planner', markdown });
      }
      case 'reviewing': {
        const verdict = parseReviewVerdict(markdown);
        if (verdict === 'UNKNOWN' || verdict === 'BLOCK') {
          return providerFailure(workflow, {
            ...task,
            error: verdict === 'BLOCK'
              ? 'Claude review reported a blocker that requires operator intervention.'
              : 'Claude review omitted a valid verdict marker.',
          });
        }
        return pipeline.completeReview(workflow.runId, {
          actor: workflow.providerTask?.actor || 'claude-reviewer',
          markdown,
          revisionRequested: verdict === 'REVISE',
          verdict,
        });
      }
      case 'revising': {
        const status = parseRevisionStatus(markdown);
        if (typeof pipeline.completeBoundRevision !== 'function') {
          fail('PIPELINE_CAPABILITY_MISSING', 'pipeline lacks restart-safe bound revision completion');
        }
        if (status !== 'APPLIED') {
          return pipeline.failBoundWriterTask(workflow.runId, {
            actor: workflow.providerTask?.actor || 'claude-reviser',
            taskId: task.id,
            reason: `Claude revision did not produce an APPLIED completion marker (received ${status}).`,
          });
        }
        return pipeline.completeBoundRevision(workflow.runId, {
          actor: workflow.providerTask?.actor || 'claude-reviser',
          taskId: task.id,
          markdown,
        });
      }
      case 'final_reviewing': {
        const verdict = parseReviewVerdict(markdown);
        if (verdict === 'UNKNOWN' || verdict === 'BLOCK') {
          return providerFailure(workflow, {
            ...task,
            error: verdict === 'BLOCK'
              ? 'Claude final review reported a blocker that requires operator intervention.'
              : 'Claude final review omitted a valid verdict marker.',
          });
        }
        return pipeline.completeFinalReview(workflow.runId, {
          actor: 'claude-final-reviewer',
          markdown,
          approved: verdict === 'APPROVE',
          verdict,
        });
      }
      default:
        fail('INVALID_PROVIDER_PHASE', `cannot settle a provider task while phase is ${workflow.phase}`);
    }
  }

  function sync(runId) {
    const workflow = requireWorkflow(runId);
    // These handoff states are persisted before the next task is dispatched.
    // Re-entering through GET after a hard stop must finish that handoff rather
    // than returning an action list that can only poll forever.
    if (workflow.phase === 'research_ready') return beginPlanning(workflow).workflow;
    if (workflow.phase === 'implementation_ready') return beginReview(workflow).workflow;
    if (!PROVIDER_PHASES.has(workflow.phase)) return workflow;
    if (!workflow.providerTask) {
      if (workflow.phase === 'planning') return dispatchPlanning(workflow).workflow;
      if (workflow.phase === 'reviewing') return dispatchReview(workflow).workflow;
      if (workflow.phase === 'final_reviewing') return dispatchReview(workflow, { final: true }).workflow;
      const reason = `${workflow.phase} has no durable provider-task binding after restart`;
      if (workflow.phase === 'revising' && typeof pipeline.failOrphanedRevision === 'function') {
        return pipeline.failOrphanedRevision(workflow.runId, {
          actor: workflow.writerLease?.actor || 'claude-reviser',
          reason,
        });
      }
      return pipeline.fail(workflow.runId, { actor: 'relaybridge', reason });
    }
    const task = taskQueue.get(workflow.providerTask.taskId);
    if (!task) {
      return providerFailure(workflow, {
        id: workflow.providerTask.taskId,
        status: 'failed',
        error: 'durable provider task record is missing',
      });
    }
    if (task.id !== workflow.providerTask.taskId || task.kind !== workflow.providerTask.provider
      || task.user !== workflow.providerTask.actor) {
      return providerFailure(workflow, {
        ...task,
        id: workflow.providerTask.taskId,
        error: 'durable provider task identity does not match its workflow binding',
      });
    }
    if (!TASK_TERMINAL.has(task.status)) return workflow;
    return settleProviderTask(workflow, task);
  }

  function create(input) {
    return pipeline.createWorkflow(input);
  }

  function submitResearch(runId, input) {
    const researched = pipeline.completeResearch(runId, {
      actor: input?.actor || 'codex',
      markdown: input?.markdown,
    });
    return beginPlanning(researched);
  }

  function startImplementation(runId, input = {}) {
    const workflow = sync(runId);
    if (workflow.phase !== 'plan_ready') {
      fail('INVALID_TRANSITION', `implementation requires plan_ready, not ${workflow.phase}`);
    }
    return pipeline.startImplementation(runId, {
      actor: input.actor || 'codex',
      leaseMs: input.leaseMs == null ? DEFAULT_CODEX_LEASE_MS : input.leaseMs,
    });
  }

  function completeImplementation(runId, input) {
    const implemented = pipeline.completeImplementation(runId, {
      actor: input?.actor || 'codex',
      leaseToken: input?.leaseToken,
      markdown: input?.markdown,
    });
    return beginReview(implemented);
  }

  function startRevision(runId, input = {}) {
    const workflow = sync(runId);
    if (workflow.permissionMode !== 'full') {
      fail('FULL_PERMISSION_REQUIRED', 'Claude revision requires a workflow created with permissionMode=full');
    }
    const actor = 'claude-reviser';
    const leaseMs = input.leaseMs == null ? DEFAULT_CLAUDE_LEASE_MS : Number(input.leaseMs);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_CLAUDE_LEASE_MS) {
      fail('INVALID_ARGUMENT', `Claude revision leaseMs must be at least ${MIN_CLAUDE_LEASE_MS}`);
    }
    const started = pipeline.startRevision(runId, {
      actor,
      leaseMs,
    });
    try {
      const dispatched = submitProviderTask(
        started.workflow,
        'revision',
        buildRevisionPrompt(promptInput(started.workflow)),
        actor,
        dispatchSpec(started.workflow, 'revision'),
      );
      maintainRevisionLease(runId, actor, dispatched.task.id, leaseMs);
      return dispatched;
    } catch (error) {
      if (!WORKFLOW_TERMINAL.has(requireWorkflow(runId).phase)) {
        pipeline.fail(runId, {
          actor,
          leaseToken: started.lease.leaseToken,
          reason: `revision dispatch failed: ${error.message}`,
        });
      }
      throw error;
    }
  }

  function startFinalReview(runId) {
    return beginReview(sync(runId), { final: true });
  }

  function cancel(runId, input = {}) {
    // Cancellation is an operator decision, so it must not first settle a
    // completed provider task and advance the workflow as a side effect.
    const workflow = requireWorkflow(runId);
    if (workflow.phase === 'revising' && !workflow.providerTask) {
      if (typeof pipeline.cancelOrphanedRevision !== 'function') {
        fail('PIPELINE_CAPABILITY_MISSING', 'pipeline lacks orphaned revision cancellation');
      }
      return pipeline.cancelOrphanedRevision(runId, {
        actor: workflow.writerLease?.actor || 'claude-reviser',
        reason: input.reason || 'Operator cancelled an unbound Claude revision.',
      });
    }
    if (workflow.phase === 'revising' && workflow.providerTask) {
      const task = taskQueue.get(workflow.providerTask.taskId);
      if (task?.status === 'running') {
        fail('WRITER_TASK_RUNNING', 'cannot release the writer lease while the Claude writer process is still running');
      }
      if (task && !TASK_TERMINAL.has(task.status)) taskQueue.cancel(task.id);
      if (typeof pipeline.cancelBoundWriterTask !== 'function') {
        fail('PIPELINE_CAPABILITY_MISSING', 'pipeline lacks bound-writer cancellation');
      }
      clearRevisionHeartbeat(runId);
      return pipeline.cancelBoundWriterTask(runId, {
        actor: workflow.providerTask.actor,
        taskId: workflow.providerTask.taskId,
        reason: input.reason || 'Operator cancelled the workflow before the Claude writer started.',
      });
    }
    if (workflow.providerTask) {
      const task = taskQueue.get(workflow.providerTask.taskId);
      if (task && !TASK_TERMINAL.has(task.status)) taskQueue.cancel(task.id);
    }
    return pipeline.cancel(runId, input);
  }

  function nextActions(workflow) {
    switch (workflow.phase) {
      case 'scoping': return ['submit_pipeline_research'];
      case 'planning':
      case 'reviewing':
      case 'revising':
      case 'final_reviewing': return ['get_pipeline'];
      case 'plan_ready': return ['claim_pipeline_implementation'];
      case 'implementing': return ['complete_pipeline_implementation', 'renew_pipeline_writer_lease'];
      case 'review_ready': return workflow.revisionRequested ? ['start_pipeline_revision'] : ['start_pipeline_final_review'];
      case 'revision_ready': return ['start_pipeline_final_review'];
      case 'complete': return [];
      default: return ['get_pipeline'];
    }
  }

  function view(runId, { includeArtifacts = true } = {}) {
    const workflow = sync(runId);
    const contents = {};
    if (includeArtifacts) {
      for (const kind of Object.keys(workflow.artifacts || {})) contents[kind] = artifact(runId, kind);
    }
    return {
      workflow,
      ...(includeArtifacts ? { artifactContents: contents } : {}),
      nextActions: nextActions(workflow),
    };
  }

  return Object.freeze({
    create,
    submitResearch,
    startImplementation,
    completeImplementation,
    startRevision,
    startFinalReview,
    sync,
    view,
    list: (query) => pipeline.list(query),
    renewWriterLease: (runId, input) => pipeline.renewWriterLease(runId, input),
    cancel,
    nextActions,
  });
}

module.exports = {
  TASK_TERMINAL,
  PROVIDER_PHASES,
  DEFAULT_CODEX_LEASE_MS,
  DEFAULT_CLAUDE_LEASE_MS,
  MIN_CLAUDE_LEASE_MS,
  WorkflowControllerError,
  taskTier,
  modelTierFor,
  effortFor,
  artifactList,
  createWorkflowController,
};
