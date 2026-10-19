'use strict';

const crypto = require('crypto');
const {
  buildPlanningPrompt,
  buildImplementationPrompt,
  buildReviewPrompt,
  buildRevisionPrompt,
  parsePlanStatus,
  parseReviewVerdict,
  parseRevisionStatus,
  parseImplementationStatus,
} = require('./workflow-prompts');
const { requireIntactArtifact } = require('./instruction-integrity');
const { taskFailureDetails, sanitizeText } = require('./incident-log');

const TASK_TERMINAL = new Set(['done', 'failed', 'cancelled', 'interrupted']);
const WORKFLOW_TERMINAL = new Set(['complete', 'failed', 'cancelled']);
const PROVIDER_PHASES = new Set(['planning', 'implementing', 'reviewing', 'revising', 'final_reviewing']);
const WRITER_PHASES = new Set(['implementing', 'revising']);
const DEFAULT_CODEX_LEASE_MS = 4 * 60 * 60 * 1000;
const DEFAULT_CLAUDE_LEASE_MS = 60 * 60 * 1000;
const MIN_CLAUDE_LEASE_MS = 60 * 1000;
const MAX_PROVIDER_ATTEMPTS = 3;
const MAX_PROVIDER_RETRY_DELAY_MS = 4 * 60 * 60 * 1000;
const RETRYABLE_READ_ONLY_PHASES = new Set(['planning', 'reviewing', 'final_reviewing']);

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

function writerRouting(value) {
  return value === 'complex' || value === 'critical'
    ? { modelTier: 'heavy', effort: 'high' }
    : { modelTier: 'standard', effort: 'medium' };
}

function managedWriter(workflow) {
  return WRITER_PHASES.has(workflow.phase)
    && (workflow.writerLease?.mode === 'provider' || !!workflow.providerTask);
}

function managedInitialWriter(workflow) {
  return workflow?.phase === 'implementing' && workflow.writerLease?.mode === 'provider';
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

function incompleteAuthority(task) {
  return task.resultIntegrity?.truncated || task.resultIntegrity?.inputTruncated || task.route?.prompt_truncated
    || task.route?.prompt_evidence?.truncated || task.resultEnvelope?.truncated
    || ['artifact_too_large', 'artifact_truncated'].includes(task.failureClass);
}

function retryableProviderFailure(task = {}) {
  if (task.status === 'cancelled' || incompleteAuthority(task)) return null;
  if (task.status === 'interrupted') {
    return { failureClass: 'bridge_interrupted', baseDelayMs: 0, automatic: false };
  }
  const failureClass = String(task.failureClass || '').toLowerCase();
  // An accepted provider 429 may independently cool its account, but it cannot
  // authorize replaying a workflow task that already crossed our own ceiling.
  if (failureClass === 'token_budget') return null;
  if (task.flags?.rate_limited === true || ['rate_limit', 'rate_limited'].includes(failureClass)) {
    return { failureClass: 'rate_limit', baseDelayMs: 60000 };
  }
  if (task.flags?.timed_out === true || failureClass === 'timeout') {
    return { failureClass: 'timeout', baseDelayMs: 5000 };
  }
  if (failureClass === 'overloaded') {
    return { failureClass: 'overloaded', baseDelayMs: 15000 };
  }
  return null;
}

const MODEL_UNAVAILABLE_EVIDENCE_KEYS = Object.freeze(['kind', 'version', 'source', 'provider', 'selectedModel',
  'selectedModelSource', 'vendorModelEcho', 'requestId', 'invocationId', 'attemptId', 'retryEvents', 'terminal',
  'streamHash', 'streamLines']);
const HEX64_RE = /^[a-f0-9]{64}$/;

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// The only automatic planner replacement: the default unrestricted Fable
// planning task settled after a real invocation with Bridge-owned
// model_unavailable evidence that joins this exact task, binding, run,
// receipt and dispatch route. Anything else keeps its ordinary failure path.
function modelUnavailableReplacementEvidence(workflow, task) {
  const binding = workflow?.providerTask;
  if (!binding || !task || workflow.phase !== 'planning' || workflow.phasePolicy || workflow.writerLease
    || workflow.planningReplacement != null || workflow.providerRetry != null) return null;
  if (binding.purpose !== 'planning' || binding.phase !== 'planning' || binding.provider !== 'claude_fable'
    || binding.actor !== 'claude-planner' || binding.attempt !== 1 || binding.model !== null) return null;
  const taskId = binding.taskId;
  const attemptId = `${taskId}:attempt:1`;
  if (task.id !== taskId || task.kind !== binding.provider || task.user !== binding.actor || task.source !== 'workflow') return null;
  if (task.status !== 'failed' || task.failureClass !== 'model_unavailable' || incompleteAuthority(task)) return null;
  const body = task.body;
  if (!plainObject(body) || body.kind !== binding.provider || body.cwd !== workflow.cwd || body.dangerous !== false
    || body.user !== binding.actor || body.requestId !== taskId || body.taskTier !== workflow.taskTier
    || body.modelTier !== binding.modelTier || body.effort !== binding.effort || body.model !== binding.model
    || body.maxEffortOverride !== false) return null;
  const correlation = task.correlation;
  if (!plainObject(correlation) || correlation.runId !== workflow.runId || correlation.requestId !== taskId
    || correlation.invocationId !== taskId || correlation.attemptId !== attemptId) return null;
  // The submission stores no explicit model; Fable is selected by the
  // configured dispatch controls, so the real route is the model authority.
  const route = task.route;
  if (!plainObject(route) || route.provider !== binding.provider || route.requested_model !== 'fable'
    || route.resolved_outgoing_model !== 'fable' || !route.model_flag_sent || route.observed_model != null
    || route.request_id !== taskId || route.invocation_id !== taskId || route.attempt_id !== attemptId) return null;
  const execution = task.execution;
  const metadata = task.providerMetadata;
  if (!plainObject(execution) || !plainObject(metadata) || execution.state !== 'settled'
    || typeof task.receiptId !== 'string' || !task.receiptId || execution.receiptId !== task.receiptId
    || metadata.receiptPersisted !== true || metadata.model_invocation !== true
    || metadata.physical_attempt_count !== 1) return null;
  const flags = task.flags;
  if (!plainObject(flags) || ['cancelled', 'rate_limited', 'budget_exceeded', 'auth_failed', 'timed_out',
    'permission_denied', 'partial_result'].some((key) => flags[key] !== false) || flags.dropped_out !== true) return null;
  if (task.stopReason || task.partialCheckpoint || metadata.supervisor_stop_reason || metadata.partial_diagnostic
    || metadata.partial_checkpoint || metadata.cooldown || metadata.quota_evidence || metadata.vendor_quota
    || metadata.retry_at !== undefined || metadata.retry_after !== undefined
    || task.retryAt != null || task.retryAfterSec != null) return null;
  const denials = metadata.provider_permission_denials;
  if (!plainObject(denials) || denials.count !== 0 || denials.observed !== 0 || denials.invalid !== 0
    || denials.truncated !== false || !Array.isArray(denials.retained) || denials.retained.length) return null;
  const evidence = metadata.provider_action_required;
  if (!plainObject(evidence) || Object.keys(evidence).length !== MODEL_UNAVAILABLE_EVIDENCE_KEYS.length
    || !MODEL_UNAVAILABLE_EVIDENCE_KEYS.every((key) => Object.hasOwn(evidence, key))) return null;
  if (evidence.kind !== 'bridge_claude_model_unavailable' || evidence.version !== 1
    || evidence.source !== 'claude_json_stream' || evidence.provider !== binding.provider
    || evidence.selectedModel !== 'fable' || evidence.selectedModelSource !== 'bridge_dispatch'
    || evidence.vendorModelEcho !== null || evidence.requestId !== taskId || evidence.invocationId !== taskId
    || evidence.attemptId !== attemptId || typeof evidence.streamHash !== 'string' || !HEX64_RE.test(evidence.streamHash)
    || !Number.isSafeInteger(evidence.streamLines) || evidence.streamLines < 2) return null;
  const retryEvents = evidence.retryEvents;
  if (!Array.isArray(retryEvents) || !retryEvents.length || retryEvents.length > 256 || retryEvents.some((event, index) => !plainObject(event)
    || event.error !== 'model_not_found' || event.errorStatus !== 404 || !HEX64_RE.test(String(event.eventIdHash))
    || !Number.isSafeInteger(event.attempt) || event.attempt < 1
    || (index === 0 ? event.attempt !== 1 : event.attempt <= retryEvents[index - 1].attempt))) return null;
  const terminal = evidence.terminal;
  if (!plainObject(terminal) || terminal.subtype !== 'error_during_execution' || terminal.apiErrorStatus !== 404
    || terminal.terminalReason !== 'model_error' || !HEX64_RE.test(String(terminal.hash))) return null;
  return evidence;
}

function providerRetryDelayMs(task, failure, attempt, now) {
  const storedRetryAt = Number(task?.retryAt);
  if (Number.isSafeInteger(storedRetryAt) && storedRetryAt > now) {
    return Math.min(MAX_PROVIDER_RETRY_DELAY_MS, storedRetryAt - now);
  }
  const retryAfterSeconds = Number(task?.retryAfterSec);
  const requestedDelay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? Math.min(retryAfterSeconds * 1000, MAX_PROVIDER_RETRY_DELAY_MS)
    : failure.baseDelayMs * (2 ** Math.max(0, Number(attempt || 1) - 1));
  const finishedAt = Number(task?.finishedAt);
  const retryAt = (Number.isFinite(finishedAt) && finishedAt >= 0 ? finishedAt : now) + requestedDelay;
  return Math.max(0, Math.min(MAX_PROVIDER_RETRY_DELAY_MS, retryAt - now));
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
  const now = typeof options.now === 'function' ? options.now : Date.now;
  // Optional: a phase that refuses to advance is diagnosable only if the reason
  // is written down somewhere an operator will look.
  const incidents = options.incidents && typeof options.incidents.report === 'function' ? options.incidents : null;
  const requestLedger = options.requestLedger || null;
  const writerHeartbeats = new Map();
  const ownedExecution = options.ownedExecution || null;
  const isOwnedWriter = workflow => !!workflow.writerLease?.ownerProtocol;

  function reconcileOwnedWriter(workflow) {
    const ownerId = workflow.writerLease?.executionOwner?.ownerId;
    if (ownerId && ownedExecution) ownedExecution.requestFinalizeTask(ownerId);
    // The private backend applies the durable workflow and physical task
    // projections. Missing enrollment never authorizes the ordinary release.
    return requireWorkflow(workflow.runId);
  }

  // Reporting an incident must never be able to fail a workflow that is already
  // failing: the inbox is diagnostic, not part of the transition.
  function reportIncident(workflow, task, details) {
    if (!incidents) return;
    const attempt = Number(workflow.providerTask?.attempt || 1);
    try {
      incidents.report({
        classification: details.classification,
        summary: details.summary,
        nextAction: details.nextAction,
        requirementIds: task?.requirementIds || [],
        runId: workflow.runId,
        phase: workflow.phase,
        provider: workflow.providerTask?.provider || task?.kind || null,
        modelTier: workflow.providerTask?.modelTier || null,
        effort: workflow.providerTask?.effort || null,
        correlation: {
          requestId: task?.correlation?.requestId || task?.route?.request_id || workflow.runId,
          invocationId: task?.correlation?.invocationId || task?.route?.invocation_id || task?.id || null,
          attemptId: task?.correlation?.attemptId || task?.route?.attempt_id || (task?.id ? `${task.id}:attempt:${attempt}` : null),
          receiptId: task?.receiptId || null,
          taskId: task?.id || null,
        },
        output: details.output ?? null,
        failureClass: task?.failureClass || null,
        markerSeen: details.markerSeen || null,
        markerExpected: details.markerExpected || null,
      });
    } catch (error) {
      log(`[RelayBridge] workflow ${workflow.runId}: incident logging failed: ${sanitizeText(error.message)}`);
    }
  }

  function clearWriterHeartbeat(runId) {
    const heartbeat = writerHeartbeats.get(runId);
    if (heartbeat) clearInterval(heartbeat.timer);
    writerHeartbeats.delete(runId);
  }

  function maintainWriterLease(runId, actor, taskId, leaseMs, phase) {
    if (typeof pipeline.renewBoundWriterLease !== 'function') {
      fail('PIPELINE_CAPABILITY_MISSING', 'pipeline lacks bound-writer lease renewal');
    }
    // Polling an uncertain writer must not keep postponing its next renewal.
    const current = writerHeartbeats.get(runId);
    if (current?.taskId === taskId && current.actor === actor && current.phase === phase) return;
    clearWriterHeartbeat(runId);
    const intervalMs = Math.max(1000, Math.min(30000, Math.floor(leaseMs / 3)));
    const timer = setInterval(() => {
      const workflow = pipeline.get(runId);
      if (!workflow || workflow.phase !== phase || workflow.providerTask?.taskId !== taskId
        || workflow.providerTask.actor !== actor) {
        clearWriterHeartbeat(runId);
        return;
      }
      const task = taskQueue.get(taskId);
      if ((!task || TASK_TERMINAL.has(task.status)) && !executionUncertain(task, workflow)) {
        clearWriterHeartbeat(runId);
        try { sync(runId); }
        catch (error) { log(`[RelayBridge] workflow ${runId}: terminal writer reconciliation failed: ${sanitizeText(error.message)}`); }
        return;
      }
      try {
        pipeline.renewBoundWriterLease(runId, { actor, taskId, leaseMs });
      } catch (error) {
        // Never release a lease merely because its heartbeat failed: the
        // provider may still be modifying the workspace. Keep polling so its
        // terminal state can be reconciled without authorizing another writer.
        log(`[RelayBridge] workflow ${runId}: writer lease heartbeat failed: ${sanitizeText(error.message)}`);
      }
    }, intervalMs);
    timer.unref?.();
    writerHeartbeats.set(runId, { timer, taskId, actor, phase });
  }

  function requireWorkflow(runId) {
    const workflow = pipeline.get(runId);
    if (!workflow) fail('WORKFLOW_NOT_FOUND', 'workflow was not found');
    return workflow;
  }

  function artifact(runId, kind, authoritative = true) {
    const record = pipeline.readArtifact(runId, kind);
    if (authoritative) requireIntactArtifact(record, kind);
    return record?.content || '';
  }

  function promptInput(workflow) {
    return {
      runId: workflow.runId,
      cwd: workflow.cwd,
      taskTier: workflow.taskTier,
      provider: workflow.phasePolicy ? 'codex' : 'claude',
      implementationExecutor: workflow.providerTaskHistory?.findLast((task) => task.purpose === 'implementation')?.outcome === 'completed'
        ? 'claude' : 'codex',
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
    if (workflow.phasePolicy) {
      const policy = workflow.phasePolicy[purpose];
      if (!policy || policy.mode === 'external') fail('INVALID_WRITER_MODE', 'this phase requires an external writer');
      const slot = config[policy.provider]?.oneshot_safe;
      if (dangerous || !Array.isArray(slot) || !slot.length) {
        fail('PROVIDER_UNAVAILABLE', 'the persisted Codex-only provider is unavailable', { purpose, candidates: [policy.provider] });
      }
      return policy.provider;
    }
    // A durable planning replacement pins every later planning dispatch,
    // automatic retry and explicit retry to its recorded provider. Never scan
    // preferences for a third planner or return to the replaced one.
    const replacement = purpose === 'planning' ? workflow.planningReplacement || null : null;
    if (replacement) {
      const kind = replacement.replacementProvider;
      const slot = config[kind]?.oneshot_safe;
      if (kind !== 'claude' || replacement.version !== 1 || dangerous || !Array.isArray(slot) || !slot.length) {
        fail('PROVIDER_UNAVAILABLE', 'the durable planning replacement provider is unavailable', { purpose, candidates: [kind] });
      }
      return kind;
    }
    const preferred = cleanList(workflow.providerPreferences?.[purpose]);
    // Writer prompts have a real writer lease. Keep that capability on the
    // deliberately configured Claude seat even if a persisted routing
    // preference names Fable or another planning-only provider.
    const candidates = purpose === 'revision' || purpose === 'implementation'
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
    const dangerous = purpose === 'revision' || purpose === 'implementation';
    const provider = chooseProvider(workflow, purpose, { dangerous });
    if (workflow.phasePolicy) return { ...workflow.phasePolicy[purpose], provider, dangerous: false,
      modelTier: 'heavy', routeReason: 'explicit Codex-only Astra/ultra workflow policy; no provider fallback' };
    const planning = purpose === 'planning';
    const reviewing = purpose === 'review' || purpose === 'finalReview';
    const hardPlan = planning && (workflow.taskTier === 'complex' || workflow.taskTier === 'critical');
    return {
      provider,
      dangerous,
      modelTier: dangerous ? writerRouting(workflow.taskTier).modelTier : reviewing ? 'standard' : modelTierFor(workflow.taskTier),
      effort: dangerous ? writerRouting(workflow.taskTier).effort : reviewing ? 'high' : effortFor(workflow.taskTier),
      routeReason: dangerous
        ? `${workflow.taskTier === 'complex' || workflow.taskTier === 'critical' ? 'complex' : 'baseline'} Claude writer ${purpose} under an exclusive workspace lease`
        : reviewing ? 'fresh read-only review uses Sonnet with high reasoning effort'
          : planning && workflow.planningReplacement ? 'planning_replacement_after_model_unavailable'
          : hardPlan ? 'hard read-only planning uses Opus or the explicit Fable tier'
            : 'standard read-only planning uses Sonnet-class reasoning',
    };
  }

  function submitProviderTask(workflow, purpose, prompt, actor, spec) {
    const taskId = taskQueue.newTaskId();
    const attempt = Number(workflow.providerRetry?.nextAttempt || 1);
    const taskInput = {
      kind: spec.provider,
      prompt,
      cwd: workflow.cwd,
      dangerous: spec.dangerous,
      taskTier: workflow.taskTier,
      modelTier: spec.modelTier,
      model: spec.model || null,
      effort: spec.effort,
      maxEffortOverride: spec.maxEffortOverride === true,
      requestId: taskId,
      correlation: { runId: workflow.runId, requestId: taskId, invocationId: taskId, attemptId: `${taskId}:attempt:1` },
      user: actor,
      source: 'workflow',
      title: `${workflow.runId}: ${purpose}`,
      intent: `${workflow.runId} ${purpose}; ${spec.routeReason}`,
    };
    // Commit the correlation before making the provider task runnable. If the
    // process dies after this write, sync() sees a missing task and retains the
    // writer fence; the inverse ordering could leave an untracked
    // dangerous task executing after restart.
    pipeline.bindProviderTask(workflow.runId, {
      actor,
      taskId,
      provider: spec.provider,
      modelTier: spec.modelTier,
      model: spec.model || null,
      effort: spec.effort,
      attempt,
      purpose,
    });
    let task;
    try {
      task = taskQueue.submitReserved(taskId, taskInput);
    } catch (error) {
      const reason = `${purpose} task persistence failed: ${sanitizeText(error.message)}`;
      if (purpose === 'revision' && isOwnedWriter(requireWorkflow(workflow.runId))) {
        // No durable owner exists yet. Preserve this enrollment gap as held;
        // a missing task is not proof that a writer never started.
      } else if (managedWriter(requireWorkflow(workflow.runId))) {
        // Queue publication precedes its directory durability barrier. A throw
        // can therefore leave a runnable task behind. Release only after the
        // exact never-started submission is durably cancelled and re-read.
        const matchesSubmission = (candidate) => candidate?.id === taskId
          && candidate.kind === taskInput.kind && candidate.user === actor
          && candidate.source === 'workflow' && !candidate.executionReservation
          && ['runId', 'requestId', 'invocationId', 'attemptId'].every((key) =>
            candidate.correlation?.[key] === taskInput.correlation[key])
          && ['kind', 'requestId', 'prompt', 'cwd', 'dangerous', 'modelTier', 'model',
            'effort', 'maxEffortOverride', 'user', 'taskTier'].every((key) => candidate.body?.[key] === taskInput[key]);
        const unstarted = (candidate) => candidate?.startedAt == null
          && ['never_started', 'not_invoked'].includes(candidate?.execution?.state);
        let released = false;
        try {
          const queued = taskQueue.get(taskId);
          if (matchesSubmission(queued) && queued.status === 'queued' && unstarted(queued)) {
            taskQueue.cancel(taskId);
            const cancelled = taskQueue.get(taskId);
            if (matchesSubmission(cancelled) && cancelled.status === 'cancelled' && unstarted(cancelled)) {
              pipeline.failBoundWriterTask(workflow.runId, { actor, taskId, reason });
              released = true;
            }
          }
        } catch (recoveryError) {
          log(`[RelayBridge] workflow ${workflow.runId}: submission recovery retained writer fence: ${sanitizeText(recoveryError.message)}`);
        }
        if (!released) {
          maintainWriterLease(workflow.runId, actor, taskId, DEFAULT_CLAUDE_LEASE_MS, workflow.phase);
        }
      } else {
        pipeline.fail(workflow.runId, { actor: 'relaybridge', reason });
      }
      throw error;
    }
    log(`[RelayBridge] workflow ${workflow.runId}: ${purpose} queued as ${task.id} on ${spec.provider}`);
    return { workflow: requireWorkflow(workflow.runId), task, dispatch: spec };
  }

  function dispatchPlanning(started) {
    const actor = phaseActor(started, 'planner');
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
        pipeline.fail(started.runId, { actor: 'relaybridge', reason: `planning dispatch failed: ${sanitizeText(error.message)}` });
      }
      throw error;
    }
  }

  function beginPlanning(workflow) {
    buildPlanningPrompt(promptInput(workflow));
    pipeline.startPlanning(workflow.runId, { actor: phaseActor(workflow, 'planner') });
    return dispatchPlanning(requireWorkflow(workflow.runId));
  }

  function dispatchReview(started, { final = false } = {}) {
    const preferenceKey = final ? 'finalReview' : 'review';
    const purpose = final ? 'final-review' : 'review';
    const actor = phaseActor(started, final ? 'final-reviewer' : 'reviewer');
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
        pipeline.fail(started.runId, { actor: 'relaybridge', reason: `${preferenceKey} dispatch failed: ${sanitizeText(error.message)}` });
      }
      throw error;
    }
  }

  function beginReview(workflow, { final = false } = {}) {
    buildReviewPrompt(promptInput(workflow), { final });
    const actor = phaseActor(workflow, final ? 'final-reviewer' : 'reviewer');
    if (final) pipeline.startFinalReview(workflow.runId, { actor });
    else pipeline.startReview(workflow.runId, { actor });
    return dispatchReview(requireWorkflow(workflow.runId), { final });
  }

  function phaseActor(workflow, role) {
    return `${workflow.phasePolicy ? 'codex' : 'claude'}-${role}`;
  }

  function executionUncertain(task, workflow) {
    if (!task) return true;
    // This new mode has an explicit queue execution and submission contract.
    // A terminal label on an unidentified task, or without execution evidence,
    // cannot establish that the bound writer stopped. Keep legacy readers as-is.
    if (managedInitialWriter(workflow) && (!task.execution || !taskIdentityMatches(workflow, task))) return true;
    if (task.execution && !['fenced', 'settled', 'not_invoked', 'never_started'].includes(task.execution.state)) return true;
    if (task.status === 'interrupted') return !['fenced', 'not_invoked', 'never_started'].includes(task.execution?.state);
    if (task.status === 'cancelled') return !['fenced', 'settled', 'not_invoked', 'never_started'].includes(task.execution?.state);
    return false;
  }

  function taskIdentityMatches(workflow, task) {
    const bound = workflow.providerTask;
    if (!task || task.id !== bound.taskId || task.kind !== bound.provider || task.user !== bound.actor) return false;
    // Only the new explicit initial-provider mode has this complete submission
    // contract. Preserve retained legacy revision/advisor identity rules.
    if (managedInitialWriter(workflow)) {
      return task.body?.kind === bound.provider && task.body?.cwd === workflow.cwd
        && task.body?.dangerous === true && task.body?.modelTier === bound.modelTier
        && task.body?.model === bound.model && task.body?.effort === bound.effort
        && task.body?.user === bound.actor && task.body?.requestId === bound.taskId
        && task.correlation?.runId === workflow.runId && task.correlation?.requestId === bound.taskId
        && task.correlation?.invocationId === bound.taskId && task.correlation?.attemptId === `${bound.taskId}:attempt:1`;
    }
    return !workflow.phasePolicy || (task.body?.kind === bound.provider && task.body?.cwd === workflow.cwd
      && task.body?.model === bound.model && task.body?.effort === bound.effort
      && task.body?.dangerous === false && task.body?.maxEffortOverride === true);
  }

  function requireWriterStopped(task, workflow) {
    if (task?.status === 'running') fail('WRITER_TASK_RUNNING', 'cannot release the writer lease while the Claude writer process is still running');
    if (executionUncertain(task, workflow)) {
      fail('WRITER_EXECUTION_UNCERTAIN', 'retain the writer lease until authoritative termination or fencing is recorded; missing activity is not proof');
    }
  }

  function stopBoundWriterTask(workflow, task) {
    requireWriterStopped(task, workflow);
    if (TASK_TERMINAL.has(task.status)) return;
    const matches = (candidate) => taskIdentityMatches(workflow, candidate);
    if (!matches(task) || task.status !== 'queued' || task.startedAt != null
      || !['never_started', 'not_invoked'].includes(task.execution?.state)) {
      fail('WRITER_EXECUTION_UNCERTAIN', 'retain the writer lease until the exact bound task has authoritative non-execution evidence');
    }
    taskQueue.cancel(task.id);
    const cancelled = taskQueue.get(task.id);
    if (!matches(cancelled) || !TASK_TERMINAL.has(cancelled.status)) {
      fail('WRITER_EXECUTION_UNCERTAIN', 'queue cancellation did not establish a terminal bound writer task');
    }
    requireWriterStopped(cancelled, workflow);
  }

  function replacementPlannerConfigured() {
    const slot = loadConfig()?.claude?.oneshot_safe;
    return Array.isArray(slot) && slot.length > 0;
  }

  // A Fable planning binding, and any planning after its replacement, keeps
  // the observed task identity: a mismatched record never authorizes a
  // replacement or an automatic or explicit retry of the bound task.
  function planningReplacementLineage(workflow, binding) {
    return binding?.phase === 'planning' && (binding.provider === 'claude_fable' || !!workflow.planningReplacement);
  }

  function archivedIdentityMatches(binding, task) {
    return !!task && task.id === binding.taskId && task.kind === binding.provider && task.user === binding.actor;
  }

  function providerFailure(workflow, task, { identityMismatch = false } = {}) {
    if (isOwnedWriter(workflow)) return reconcileOwnedWriter(workflow);
    const replacementEvidence = identityMismatch ? null : modelUnavailableReplacementEvidence(workflow, task);
    if (replacementEvidence && replacementPlannerConfigured() && typeof pipeline.schedulePlanningReplacement === 'function') {
      log(`[RelayBridge] workflow ${workflow.runId}: planning task ${task.id} reported model_unavailable on claude_fable; replacement scheduled on claude`);
      const scheduled = pipeline.schedulePlanningReplacement(workflow.runId, {
        actor: workflow.providerTask.actor,
        failedTaskId: task.id,
        replacementProvider: 'claude',
        failed: {
          model: replacementEvidence.selectedModel,
          attemptId: replacementEvidence.attemptId,
          receiptId: task.receiptId,
          evidenceHash: crypto.createHash('sha256').update(canonicalJson(replacementEvidence)).digest('hex'),
          failureClass: task.failureClass,
        },
      });
      // Continue in this reconcile. A stop before the bind leaves only the
      // durable record, which sync's no-task branch dispatches exactly once.
      if (scheduled.phase !== 'planning' || scheduled.providerTask) return scheduled;
      return dispatchPlanning(scheduled).workflow;
    }
    const details = taskFailureDetails(task);
    const reason = incompleteAuthority(task)
      ? `${workflow.phase} provider task ${task.id}: ${task.failureClass || 'artifact_truncated'}: ${sanitizeText(task.error || 'Incomplete instructions or verdict; restore complete bounded evidence.')}`
      : `${workflow.phase} provider task ${task.id} ${task.status}: ${details.summary} ${details.nextAction}`;
    const transient = retryableProviderFailure(task);
    const attempt = Number(workflow.providerTask?.attempt || 1);
    const retryIdentityRefused = identityMismatch && planningReplacementLineage(workflow, workflow.providerTask);
    if (transient && !retryIdentityRefused && !executionUncertain(task) && transient.automatic !== false && RETRYABLE_READ_ONLY_PHASES.has(workflow.phase)
      && workflow.providerTask?.taskId === task.id && attempt < MAX_PROVIDER_ATTEMPTS
      && typeof pipeline.scheduleProviderRetry === 'function') {
      const delayMs = providerRetryDelayMs(task, transient, attempt, now());
      log(`[RelayBridge] workflow ${workflow.runId}: ${transient.failureClass} on attempt ${attempt}; retry ${attempt + 1}/${MAX_PROVIDER_ATTEMPTS} scheduled in ${delayMs}ms`);
      return pipeline.scheduleProviderRetry(workflow.runId, {
        actor: workflow.providerTask.actor,
        taskId: task.id,
        failureClass: transient.failureClass,
        reason,
        delayMs,
        maxAttempts: MAX_PROVIDER_ATTEMPTS,
      });
    }
    if (managedWriter(workflow) && typeof pipeline.failBoundWriterTask === 'function') {
      stopBoundWriterTask(workflow, task);
      clearWriterHeartbeat(workflow.runId);
      return pipeline.failBoundWriterTask(workflow.runId, {
        actor: workflow.providerTask?.actor || 'claude-reviser',
        taskId: task.id,
        reason,
      });
    }
    return pipeline.fail(workflow.runId, { actor: 'relaybridge', reason });
  }

  function settleProviderTask(workflow, task) {
    try { return settleCompleteProviderTask(workflow, task); }
    catch (error) {
      if (!['ARTIFACT_TOO_LARGE', 'ARTIFACT_TRUNCATED'].includes(error.code)) throw error;
      return providerFailure(workflow, { ...task, status: 'failed', failureClass: error.code.toLowerCase(), error: error.message });
    }
  }

  function settleCompleteProviderTask(workflow, task) {
    if (isOwnedWriter(workflow)) return reconcileOwnedWriter(workflow);
    if (managedWriter(workflow)) {
      requireWriterStopped(task, workflow);
      clearWriterHeartbeat(workflow.runId);
    }
    if (incompleteAuthority(task)) {
      return providerFailure(workflow, { ...task, status: 'failed', failureClass: 'artifact_truncated', error: 'Provider instructions or artifact were truncated; a complete verdict is required.' });
    }
    if (task.status !== 'done') {
      if (task.status !== 'cancelled') reportIncident(workflow, task, taskFailureDetails(task));
      return providerFailure(workflow, task);
    }
    if (task.failureClass || Object.values(task.flags || {}).some((value) => value === true)) {
      const failed = { ...task, status: 'failed' };
      reportIncident(workflow, failed, taskFailureDetails(failed));
      return providerFailure(workflow, failed);
    }
    const markdown = String(task.result || '').trim();
    if (!markdown) {
      reportIncident(workflow, task, {
        classification: 'empty_output',
        summary: `${workflow.phase} provider returned no output at all`,
        output: String(task.result || ''),
      });
      return providerFailure(workflow, { ...task, status: 'failed', error: 'provider returned empty output' });
    }

    switch (workflow.phase) {
      case 'planning': {
        const status = parsePlanStatus(markdown);
        if (status !== 'READY') {
          reportIncident(workflow, task, {
            classification: 'plan_not_ready',
            summary: `planning finished without PLAN_STATUS: READY (received ${status})`,
            output: markdown,
            markerSeen: status,
            markerExpected: 'PLAN_STATUS: READY',
          });
          return providerFailure(workflow, {
            ...task,
            error: `Provider planning did not produce a READY completion marker (received ${status}).`,
          });
        }
        return pipeline.completePlanning(workflow.runId, { actor: workflow.providerTask.actor, markdown });
      }
      case 'implementing': {
        const status = parseImplementationStatus(markdown);
        if (status !== 'COMPLETE') {
          reportIncident(workflow, task, {
            classification: 'implementation_not_complete',
            summary: `implementation finished without IMPLEMENTATION_STATUS: COMPLETE (received ${status})`,
            output: markdown, markerSeen: status, markerExpected: 'IMPLEMENTATION_STATUS: COMPLETE',
          });
          return pipeline.failBoundWriterTask(workflow.runId, {
            actor: workflow.providerTask.actor, taskId: task.id,
            reason: `Claude implementation did not produce a COMPLETE completion marker (received ${status}).`,
          });
        }
        buildReviewPrompt({ ...promptInput(workflow), implementation: markdown, implementationExecutor: 'claude' });
        const implemented = pipeline.completeBoundImplementation(workflow.runId, {
          actor: workflow.providerTask.actor, taskId: task.id, markdown,
        });
        return beginReview(implemented).workflow;
      }
      case 'reviewing': {
        const verdict = parseReviewVerdict(markdown);
        if (verdict === 'UNKNOWN' || verdict === 'BLOCK') {
          reportIncident(workflow, task, {
            classification: verdict === 'BLOCK' ? 'blocked_verdict' : 'no_verdict',
            summary: verdict === 'BLOCK'
              ? 'review reported a blocker that requires operator intervention'
              : 'review returned output but omitted a REVIEW_VERDICT marker',
            output: markdown,
            markerSeen: verdict,
            markerExpected: 'REVIEW_VERDICT: APPROVE|REVISE|BLOCK',
          });
          return providerFailure(workflow, {
            ...task,
            error: verdict === 'BLOCK'
              ? 'Provider review reported a blocker that requires operator intervention.'
              : 'Provider review omitted a valid verdict marker.',
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
          reportIncident(workflow, task, {
            classification: 'revision_not_applied',
            summary: `revision finished without REVISION_STATUS: APPLIED (received ${status})`,
            output: markdown,
            markerSeen: status,
            markerExpected: 'REVISION_STATUS: APPLIED',
          });
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
          reportIncident(workflow, task, {
            classification: verdict === 'BLOCK' ? 'blocked_verdict' : 'no_verdict',
            summary: verdict === 'BLOCK'
              ? 'final review reported a blocker that requires operator intervention'
              : 'final review returned output but omitted a REVIEW_VERDICT marker',
            output: markdown,
            markerSeen: verdict,
            markerExpected: 'REVIEW_VERDICT: APPROVE|REVISE|BLOCK',
          });
          return providerFailure(workflow, {
            ...task,
            error: verdict === 'BLOCK'
              ? 'Provider final review reported a blocker that requires operator intervention.'
              : 'Provider final review omitted a valid verdict marker.',
          });
        }
        return pipeline.completeFinalReview(workflow.runId, {
          actor: workflow.providerTask.actor,
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
    // Explicit reconciliation after a hard stop must finish that handoff
    // rather than returning an action list that can only poll forever.
    if (workflow.phase === 'research_ready') return beginPlanning(workflow).workflow;
    if (workflow.phase === 'implementation_ready') return beginReview(workflow).workflow;
    if (!PROVIDER_PHASES.has(workflow.phase)) return workflow;
    if (isOwnedWriter(workflow)) return reconcileOwnedWriter(workflow);
    // External and historically ambiguous owners have no queue task. Missing
    // task activity is not authority to release their workspace reservation.
    if (WRITER_PHASES.has(workflow.phase) && !workflow.providerTask && workflow.writerLease?.mode !== 'provider') return workflow;
    if (!workflow.providerTask) {
      if (workflow.providerRetry && workflow.providerRetry.retryAt > now()) return workflow;
      if (workflow.phase === 'planning') return dispatchPlanning(workflow).workflow;
      if (workflow.phase === 'reviewing') return dispatchReview(workflow).workflow;
      if (workflow.phase === 'final_reviewing') return dispatchReview(workflow, { final: true }).workflow;
      const reason = `${workflow.phase} has no durable provider-task binding after restart`;
      if (workflow.phase === 'implementing') {
        return pipeline.failOrphanedImplementation(workflow.runId, {
          actor: workflow.writerLease?.actor || 'claude-implementer', reason,
        });
      }
      if (workflow.phase === 'revising' && typeof pipeline.failOrphanedRevision === 'function') {
        return pipeline.failOrphanedRevision(workflow.runId, {
          actor: workflow.writerLease?.actor || 'claude-reviser',
          reason,
        });
      }
      return pipeline.fail(workflow.runId, { actor: 'relaybridge', reason });
    }
    const task = taskQueue.get(workflow.providerTask.taskId);
    if (managedWriter(workflow) && (!TASK_TERMINAL.has(task?.status) || executionUncertain(task, workflow))) {
      maintainWriterLease(workflow.runId, workflow.providerTask.actor, workflow.providerTask.taskId, DEFAULT_CLAUDE_LEASE_MS, workflow.phase);
    }
    if (!task) {
      return providerFailure(workflow, {
        id: workflow.providerTask.taskId,
        status: 'failed',
        error: 'durable provider task record is missing',
        execution: { state: 'uncertain' },
      });
    }
    if (!taskIdentityMatches(workflow, task)) {
      const replacementLineage = workflow.phase === 'planning'
        && planningReplacementLineage(workflow, workflow.providerTask);
      return providerFailure(workflow, {
        ...task,
        // Preserve the observed identity for the explicit initial mode. A
        // substituted ID must never become evidence that its bound task stopped.
        id: managedInitialWriter(workflow) || replacementLineage ? task.id : workflow.providerTask.taskId,
        error: 'durable provider task identity does not match its workflow binding',
      }, { identityMismatch: true });
    }
    if (!TASK_TERMINAL.has(task.status)) return workflow;
    return settleProviderTask(workflow, task);
  }

  function create(input) {
    return pipeline.createWorkflow(input);
  }

  function submitResearch(runId, input) {
    buildPlanningPrompt({ ...promptInput(requireWorkflow(runId)), research: input?.markdown });
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
    const actor = input.actor || 'codex';
    if (workflow.phasePolicy?.implementation?.provider && actor !== workflow.phasePolicy.implementation.provider
      || workflow.providerPreferences?.implementation?.length && !workflow.providerPreferences.implementation.includes(actor)) {
      fail('PROVIDER_RESTRICTION', 'implementation actor must satisfy the original workflow provider policy');
    }
    return pipeline.startImplementation(runId, {
      actor,
      leaseMs: input.leaseMs == null ? DEFAULT_CODEX_LEASE_MS : input.leaseMs,
    });
  }

  function completeImplementation(runId, input) {
    if (requireWorkflow(runId).writerLease?.mode === 'provider') {
      fail('INVALID_WRITER_MODE', 'managed implementation completion requires provider-task reconciliation');
    }
    buildReviewPrompt({ ...promptInput(requireWorkflow(runId)), implementation: input?.markdown });
    const implemented = pipeline.completeImplementation(runId, {
      actor: input?.actor || 'codex',
      leaseToken: input?.leaseToken,
      markdown: input?.markdown,
    });
    return beginReview(implemented);
  }

  function startManagedImplementation(runId, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['actor', 'leaseMs'].includes(key))) {
      fail('INVALID_ARGUMENT', 'managed implementation accepts only actor and leaseMs');
    }
    if (input.actor !== undefined && input.actor !== 'claude') {
      fail('PROVIDER_RESTRICTION', 'managed implementation requires Claude');
    }
    // Admission must not settle or dispatch an unrelated phase as a side effect.
    const workflow = requireWorkflow(runId);
    if (workflow.phase !== 'plan_ready') fail('INVALID_TRANSITION', `implementation requires plan_ready, not ${workflow.phase}`);
    if (workflow.phasePolicy?.implementation.mode === 'external') {
      fail('INVALID_WRITER_MODE', 'use claim_pipeline_implementation for this external-writer profile');
    }
    if (workflow.permissionMode !== 'full') fail('FULL_PERMISSION_REQUIRED', 'Claude implementation requires permissionMode=full');
    if (workflow.providerPreferences?.implementation?.length && !workflow.providerPreferences.implementation.includes('claude')) {
      fail('PROVIDER_RESTRICTION', 'implementation provider must satisfy the original workflow provider policy');
    }
    const leaseMs = input.leaseMs === undefined ? DEFAULT_CLAUDE_LEASE_MS : input.leaseMs;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_CLAUDE_LEASE_MS || leaseMs > 86400000) {
      fail('INVALID_ARGUMENT', 'Claude implementation leaseMs must be an integer from 60000 to 86400000');
    }
    const prompt = buildImplementationPrompt(promptInput(workflow));
    const spec = dispatchSpec(workflow, 'implementation');
    const actor = 'claude-implementer';
    const started = pipeline.startImplementation(runId, { actor, leaseMs, mode: 'provider' });
    try {
      const dispatched = submitProviderTask(started.workflow, 'implementation', prompt, actor, spec);
      maintainWriterLease(runId, actor, dispatched.task.id, leaseMs, 'implementing');
      return dispatched;
    } catch (error) {
      const current = requireWorkflow(runId);
      if (!WORKFLOW_TERMINAL.has(current.phase) && !current.providerTask) {
        pipeline.fail(runId, { actor, leaseToken: started.lease.leaseToken,
          reason: `implementation dispatch failed: ${sanitizeText(error.message)}` });
      }
      throw error;
    }
  }

  function startRevision(runId, input = {}) {
    if (input.ownedLease !== undefined && typeof input.ownedLease !== 'boolean') {
      fail('INVALID_ARGUMENT', 'ownedLease must be boolean');
    }
    const workflow = sync(runId);
    if (workflow.phasePolicy?.revision.mode === 'external') {
      fail('INVALID_WRITER_MODE', 'use claim_pipeline_revision for this external-writer profile');
    }
    if (workflow.permissionMode !== 'full') {
      fail('FULL_PERMISSION_REQUIRED', 'Claude revision requires a workflow created with permissionMode=full');
    }
    const actor = 'claude-reviser';
    const leaseMs = input.leaseMs == null ? DEFAULT_CLAUDE_LEASE_MS : Number(input.leaseMs);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_CLAUDE_LEASE_MS) {
      fail('INVALID_ARGUMENT', `Claude revision leaseMs must be at least ${MIN_CLAUDE_LEASE_MS}`);
    }
    buildRevisionPrompt(promptInput(workflow));
    const owned = input.ownedLease === true;
    if (owned) {
      if (!ownedExecution) fail('OWNER_BACKEND_UNAVAILABLE', 'qualified owned execution is unavailable');
      ownedExecution.assertQualifiedRevision({ workflow, provider: dispatchSpec(workflow, 'revision').provider, cwd: workflow.cwd });
    }
    const started = owned ? pipeline.startOwnedRevision(runId, { actor, leaseMs }) : pipeline.startRevision(runId, {
      actor,
      leaseMs,
      mode: 'provider',
    });
    try {
      const dispatched = submitProviderTask(
        started.workflow,
        'revision',
        buildRevisionPrompt(promptInput(started.workflow)),
        actor,
        dispatchSpec(started.workflow, 'revision'),
      );
      if (!owned) maintainWriterLease(runId, actor, dispatched.task.id, leaseMs, 'revising');
      return dispatched;
    } catch (error) {
      const current = requireWorkflow(runId);
      if (!isOwnedWriter(current) && !WORKFLOW_TERMINAL.has(current.phase) && !current.providerTask) {
        pipeline.fail(runId, {
          actor,
          leaseToken: started.lease.leaseToken,
          reason: `revision dispatch failed: ${sanitizeText(error.message)}`,
        });
      }
      throw error;
    }
  }

  function claimRevision(runId, input = {}) {
    const workflow = requireWorkflow(runId);
    if (workflow.permissionMode !== 'full') fail('FULL_PERMISSION_REQUIRED', 'revision requires permissionMode=full');
    return pipeline.startRevision(runId, { actor: input.actor || 'codex', mode: 'external',
      leaseMs: input.leaseMs == null ? DEFAULT_CODEX_LEASE_MS : input.leaseMs });
  }

  function completeRevision(runId, input = {}) {
    const workflow = requireWorkflow(runId);
    if (workflow.writerLease?.mode !== 'external') fail('INVALID_WRITER_MODE', 'completion requires a claimed external revision');
    return pipeline.completeRevision(runId, { actor: input.actor || 'codex', leaseToken: input.leaseToken, markdown: input.markdown });
  }

  function startFinalReview(runId) {
    return beginReview(sync(runId), { final: true });
  }

  function retryFailedProvider(runId, input = {}) {
    const workflow = requireWorkflow(runId);
    const last = workflow.providerTaskHistory?.at(-1);
    const task = last ? taskQueue.get(last.taskId) : null;
    const transient = task && retryableProviderFailure(task);
    if (executionUncertain(task)) {
      fail('EXECUTION_TERMINATION_REQUIRED', 'confirm authoritative termination or fencing before retrying an interrupted provider task');
    }
    if (planningReplacementLineage(workflow, last) && !archivedIdentityMatches(last, task)) {
      fail('PROVIDER_RETRY_NOT_ALLOWED', 'the terminal provider task identity does not match its archived planning binding');
    }
    if (!transient) {
      fail('PROVIDER_RETRY_NOT_ALLOWED', 'the terminal provider task has no typed transient failure evidence');
    }
    if (typeof pipeline.retryFailedReadOnlyProviderTask !== 'function') {
      fail('PIPELINE_CAPABILITY_MISSING', 'pipeline lacks failed read-only provider recovery');
    }
    const attempt = Number(last?.attempt || 1);
    const recovered = pipeline.retryFailedReadOnlyProviderTask(runId, {
      actor: input.actor || 'operator',
      failureClass: transient.failureClass,
      reason: `Explicit retry of ${last.taskId}: ${taskFailureDetails(task).summary}`,
      delayMs: providerRetryDelayMs(task, transient, attempt, now()),
      maxAttempts: MAX_PROVIDER_ATTEMPTS,
    });
    const synced = sync(recovered.runId);
    return { workflow: synced, nextActions: nextActions(synced) };
  }

  function cancel(runId, input = {}) {
    // Cancellation is an operator decision, so it must not first settle a
    // completed provider task and advance the workflow as a side effect.
    const workflow = requireWorkflow(runId);
    if (isOwnedWriter(workflow)) {
      const task = workflow.providerTask && taskQueue.get(workflow.providerTask.taskId);
      if (task && !TASK_TERMINAL.has(task.status)) taskQueue.cancel(task.id);
      const ownerId = workflow.writerLease.executionOwner?.ownerId;
      if (ownerId && ownedExecution) ownedExecution.stop(ownerId);
      return reconcileOwnedWriter(workflow);
    }
    if (WRITER_PHASES.has(workflow.phase) && !workflow.providerTask && workflow.writerLease?.mode !== 'provider') {
      return pipeline.cancel(runId, input);
    }
    if (managedWriter(workflow) && !workflow.providerTask) {
      const action = workflow.phase === 'implementing' ? 'cancelOrphanedImplementation' : 'cancelOrphanedRevision';
      if (typeof pipeline[action] !== 'function') {
        fail('PIPELINE_CAPABILITY_MISSING', 'pipeline lacks orphaned writer cancellation');
      }
      return pipeline[action](runId, {
        actor: workflow.writerLease.actor,
        reason: input.reason || 'Operator cancelled an unbound Claude writer.',
      });
    }
    if (managedWriter(workflow) && workflow.providerTask) {
      const task = taskQueue.get(workflow.providerTask.taskId);
      stopBoundWriterTask(workflow, task);
      if (typeof pipeline.cancelBoundWriterTask !== 'function') {
        fail('PIPELINE_CAPABILITY_MISSING', 'pipeline lacks bound-writer cancellation');
      }
      clearWriterHeartbeat(runId);
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

  function failedProviderRetryAvailable(workflow) {
    if (workflow.phase !== 'failed' || workflow.providerTask) return false;
    const last = workflow.providerTaskHistory?.at(-1);
    if (!last || last.outcome !== 'failed' || !RETRYABLE_READ_ONLY_PHASES.has(last.phase)
      || Number(last.attempt || 0) >= MAX_PROVIDER_ATTEMPTS) return false;
    const task = taskQueue.get(last.taskId);
    if (planningReplacementLineage(workflow, last) && !archivedIdentityMatches(last, task)) return false;
    return !!task && !executionUncertain(task) && !!retryableProviderFailure(task);
  }

  function implementationLeaseBlock(workflow, at) {
    if (managedWriter(workflow)) return null;
    const externalRevision = workflow.phase === 'revising' && !workflow.providerTask && workflow.writerLease?.mode !== 'provider';
    if (workflow.phase !== 'implementing' && !externalRevision) return null;
    const expiry = workflow.writerLease?.expiresAt;
    if (Number.isSafeInteger(expiry) && expiry > at) return null;
    return {
      code: Number.isSafeInteger(expiry) ? 'LEASE_EXPIRED' : 'LEASE_IDENTITY_UNAVAILABLE',
      recovery: 'unavailable_unbound_owner',
      actions: [externalRevision ? 'complete_pipeline_revision' : 'complete_pipeline_implementation', 'renew_pipeline_writer_lease'],
    };
  }

  function nextActions(workflow, at = now()) {
    switch (workflow.phase) {
      case 'scoping': return ['submit_pipeline_research'];
      case 'research_ready':
      case 'implementation_ready':
      case 'planning':
      case 'reviewing':
      case 'final_reviewing': return ['reconcile_pipeline'];
      case 'revising': return workflow.writerLease?.mode === 'external'
        ? implementationLeaseBlock(workflow, at) ? [] : ['complete_pipeline_revision', 'renew_pipeline_writer_lease']
        : workflow.providerTask || workflow.writerLease?.mode === 'provider' ? ['reconcile_pipeline'] : [];
      case 'plan_ready': return ['claim_pipeline_implementation',
        ...(workflow.permissionMode === 'full' && workflow.phasePolicy?.implementation.mode !== 'external'
          ? ['start_pipeline_implementation'] : [])];
      case 'implementing': return managedWriter(workflow) ? ['reconcile_pipeline'] : implementationLeaseBlock(workflow, at)
        ? [] : ['complete_pipeline_implementation', 'renew_pipeline_writer_lease'];
      case 'review_ready': return workflow.revisionRequested
        ? [workflow.phasePolicy ? 'claim_pipeline_revision' : 'start_pipeline_revision'] : ['start_pipeline_final_review'];
      case 'revision_ready': return ['start_pipeline_final_review'];
      case 'complete': return [];
      case 'failed': return failedProviderRetryAvailable(workflow)
        ? ['retry_failed_pipeline_provider'] : [];
      case 'cancelled': return [];
      default: return ['get_pipeline'];
    }
  }

  function present(workflow, { includeArtifacts = true } = {}) {
    const at = now();
    const leaseBlock = implementationLeaseBlock(workflow, at);
    const contents = {};
    if (includeArtifacts) {
      for (const kind of Object.keys(workflow.artifacts || {})) contents[kind] = artifact(workflow.runId, kind, false);
    }
    return {
      workflow,
      ...(requestLedger ? { requestLinks: requestLedger.forWorkflow(workflow.runId) } : {}),
      ...(includeArtifacts ? { artifactContents: contents } : {}),
      nextActions: nextActions(workflow, at),
      ...(leaseBlock ? { blockedActions: [leaseBlock] } : {}),
    };
  }

  // Status reads must stay side-effect free. Provider settlement, crash-handoff
  // recovery, and due retry dispatch all go through reconcile(), whose REST
  // surface is an identity-gated POST. This prevents a stale MCP process from
  // spending quota merely by polling a newer bridge instance with GET.
  function view(runId, options = {}) {
    return present(requireWorkflow(runId), options);
  }

  function reconcile(runId, options = {}) {
    return present(sync(runId), options);
  }

  function requireLedger() {
    if (!requestLedger) fail('REQUEST_LEDGER_UNAVAILABLE', 'request ledger runtime integration is not configured');
    return requestLedger;
  }

  function linkRequest(runId, input = {}) {
    requireWorkflow(runId);
    return requireLedger().linkWorkflow(input.requestId, { runId, actor: input.actor });
  }

  return Object.freeze({
    create,
    shutdown: () => { for (const runId of writerHeartbeats.keys()) clearWriterHeartbeat(runId); },
    submitResearch,
    startImplementation,
    startManagedImplementation,
    completeImplementation,
    startRevision,
    claimRevision,
    completeRevision,
    startFinalReview,
    retryFailedProvider,
    sync,
    view,
    reconcile,
    createRequest: (input) => requireLedger().create(input),
    linkRequest,
    recordRequirementEvidence: (requestId, input) => requireLedger().record(requestId, input),
    getRequest: (requestId, options) => requireLedger().get(requestId, options),
    list: (query) => pipeline.list(query),
    renewWriterLease: (runId, input) => {
      if (requireWorkflow(runId).writerLease?.mode === 'provider') {
        fail('INVALID_WRITER_MODE', 'managed writer renewal requires its bound provider task');
      }
      return pipeline.renewWriterLease(runId, input);
    },
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
  MAX_PROVIDER_ATTEMPTS,
  MAX_PROVIDER_RETRY_DELAY_MS,
  retryableProviderFailure,
  providerRetryDelayMs,
  WorkflowControllerError,
  taskTier,
  modelTierFor,
  effortFor,
  writerRouting,
  artifactList,
  createWorkflowController,
};
