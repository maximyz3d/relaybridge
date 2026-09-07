'use strict';

// Delegation: turning a list of asks into bounded, queued, resumable work.
//
// This is deliberately *not* another supervisor. It owns no processes and no
// second queue; it classifies and ranks the asks, picks the cheapest provider
// that can actually do each one, writes a handoff contract, and hands the task
// to the one existing task queue. Everything it knows is written to disk before
// the task becomes runnable, so a different surface — Cowork, the CLI, a fresh
// MCP session — can pick the work up by id and see exactly the same state.
//
// The escalation rule is the important one. A delegated task moves to a bigger
// model only when something was *observed* to go wrong: a wrong, empty, partial
// or failed result. Never because the task looked hard up front. That rule is
// the difference between a fleet that saves money and one that quietly routes
// everything to the most expensive seat.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  TASK_TIERS,
  buildHandoffContract,
  requestEscalation,
  resolveEscalation,
  applyApprovedEscalation,
  ownershipConflicts,
  renderHandoffBrief,
} = require('./handoff-contract');
const { COST_CLASS } = require('./task-plan');
const { validateProviderBudget } = require('./provider-budget');

const TIER_RANK = Object.fromEntries(TASK_TIERS.map((tier, index) => [tier, index]));

// Only observed outcomes. See docs/BLUEPRINT.md: escalate on evidence, never on
// "feels hard".
const ESCALATION_OUTCOMES = Object.freeze(['wrong_result', 'empty_result', 'partial_result', 'failed_result']);

const TERMINAL_TASK_STATES = new Set(['done', 'failed', 'cancelled', 'interrupted']);
const SETTLED_ENTRY_STATES = new Set([...TERMINAL_TASK_STATES, 'accepted', 'escalation_denied', 'blocked']);

function assertDispatchBoundary(contract) {
  // This coordinator has no tool interceptor or scoped writer lease. Only the
  // provider's existing read-only execution policy can be requested here.
  if (contract.permissions.dangerous || contract.toolPolicy.allow.some((tool) => !['read', 'search'].includes(tool))) {
    fail('WRITE_SCOPE_UNENFORCED', 'Delegation cannot enforce writable or additional tool scopes; use the managed writer workflow for implementation.');
  }
}

function assertEscalationFeasible(contract, escalation) {
  const requested = escalation.requested;
  assertDispatchBoundary({
    permissions: {
      dangerous: escalation.kinds.includes('permission') ? requested.dangerous : contract.permissions.dangerous,
    },
    toolPolicy: {
      allow: contract.toolPolicy.allow.concat(escalation.kinds.includes('tool_policy')
        ? requested.tools.filter((tool) => !contract.toolPolicy.deny.includes(tool)) : []),
    },
  });
}

function executionBudget(contract, planned = {}) {
  if (contract.budget.maxUsd || contract.budget.maxWallClockMs) {
    fail('BUDGET_UNSUPPORTED', 'Delegation cannot enforce maxUsd or maxWallClockMs. Use supported provider token/turn budgets.');
  }
  return validateProviderBudget({
    ...planned,
    ...(contract.budget.maxTokens !== null ? { maxTotalTokens: contract.budget.maxTokens } : {}),
    ...(contract.budget.maxTurns !== null ? { maxTurns: contract.budget.maxTurns } : {}),
  });
}

class DelegationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DelegationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DelegationError(code, message);
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * @param {object}   opts
 * @param {string}   opts.dataDir
 * @param {object}   opts.taskQueue     the existing task queue; never a new one
 * @param {function} opts.classify      (prompt) => {tier, tags?, confidence?}
 * @param {function} opts.selectProvider ({tier, task}) => {kind, modelTier, effort, costClass, ready, reason, alternates}
 * @param {object}   [opts.incidents]   incident log, for escalation records
 * @param {function} [opts.now]
 * @param {function} [opts.log]
 */
function createDelegationCoordinator(opts = {}) {
  if (typeof opts.dataDir !== 'string' || !opts.dataDir.trim()) fail('INVALID_ARGUMENT', 'dataDir is required');
  const requestedDir = path.resolve(opts.dataDir);
  const taskQueue = opts.taskQueue;
  if (!taskQueue || ['submitReserved', 'newTaskId', 'get', 'stats'].some((method) => typeof taskQueue[method] !== 'function')) {
    fail('INVALID_ARGUMENT', 'taskQueue must support reserved task IDs, lookup, and stats');
  }
  if (typeof opts.classify !== 'function') fail('INVALID_ARGUMENT', 'classify is required');
  if (typeof opts.selectProvider !== 'function') fail('INVALID_ARGUMENT', 'selectProvider is required');
  const incidents = opts.incidents && typeof opts.incidents.report === 'function' ? opts.incidents : null;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  fs.mkdirSync(requestedDir, { recursive: true });
  const dir = fs.realpathSync(requestedDir);
  const validRecordId = (id) => typeof id === 'string' && id.length <= 128
    && id === id.trim() && /^dlg_[A-Za-z0-9_]+$/.test(id);
  const recordNames = () => fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json') && validRecordId(name.slice(0, -5)));

  const recordPath = (id) => {
    if (!validRecordId(id)) {
      fail('INVALID_ARGUMENT', 'invalid delegation id');
    }
    const filename = path.basename(`${id}.json`);
    if (filename !== `${id}.json`) fail('INVALID_ARGUMENT', 'invalid delegation filename');
    const candidate = path.resolve(dir, filename);
    if (!candidate.startsWith(`${dir}${path.sep}`) || path.dirname(candidate) !== dir) {
      fail('PATH_ESCAPE', 'delegation record escaped its storage directory');
    }
    try {
      if (fs.lstatSync(candidate).isSymbolicLink()) fail('PATH_ESCAPE', 'delegation records must not be symbolic links');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return candidate;
  };

  function write(record) {
    const fp = recordPath(record.delegationId);
    const tmp = path.join(dir, path.basename(`${fp}.${crypto.randomBytes(8).toString('hex')}.tmp`));
    // Write-then-rename, matching the task queue: a crash mid-write must not
    // leave a delegation that another surface cannot parse.
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, fp);
    return record;
  }

  function read(id) {
    const fp = recordPath(id);
    try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
    catch { return null; }
  }

  function newDelegationId() {
    return `dlg_${now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  }

  function updateStatus(record) {
    record.status = record.entries.some((entry) => entry.escalation?.status === 'pending')
      ? 'awaiting_escalation'
      : record.entries.some((entry) => !SETTLED_ENTRY_STATES.has(entry.status)) ? 'active' : 'settled';
    return record;
  }

  function submitEntry(record, entry, body) {
    const taskId = taskQueue.newTaskId();
    entry.correlation = { ...entry.correlation, taskId };
    entry.status = 'submitting';
    record.updatedAt = new Date(now()).toISOString();
    write(updateStatus(record));
    try {
      const submitted = taskQueue.submitReserved(taskId, body);
      entry.status = submitted.status || 'queued';
      entry.blockedReason = null;
    } catch (error) {
      // Keep the reserved ID: the queue may already have persisted the task.
      entry.status = 'blocked';
      entry.blockedReason = `queue submission failed: ${error.message}`;
    }
    record.updatedAt = new Date(now()).toISOString();
    write(updateStatus(record));
    return taskId;
  }

  // Ranking is by tier first (the riskiest work should be visible at the top of
  // the queue), then by the caller's own priority, then by submission order so
  // ranking is stable and reproducible.
  function rank(entries) {
    return entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => (TIER_RANK[b.entry.classification.tier] - TIER_RANK[a.entry.classification.tier])
        || ((Number(b.entry.priority) || 0) - (Number(a.entry.priority) || 0))
        || (a.index - b.index))
      .map(({ entry }, position) => ({ ...entry, rank: position + 1 }));
  }

  function capacitySnapshot() {
    const stats = taskQueue.stats();
    return {
      active: Number(stats.active) || 0,
      queued: Number(stats.queued) || 0,
      maxConcurrent: Number(stats.maxConcurrent) || 0,
      // Not an error condition: the queue is durable, so "no capacity" means
      // the task waits, not that the delegation failed.
      atCapacity: (Number(stats.active) || 0) >= (Number(stats.maxConcurrent) || 0),
    };
  }

  /**
   * Accepts a batch of asks and queues each as bounded work.
   *
   * Returns the persisted delegation record. Tasks that could not be planned
   * are recorded as `blocked` with the planner's reason rather than dropped.
   */
  function delegate(input = {}) {
    const tasks = Array.isArray(input.tasks) ? input.tasks : [];
    if (!tasks.length) fail('INVALID_ARGUMENT', 'tasks is required and must not be empty');
    if (tasks.length > 50) fail('INVALID_ARGUMENT', 'a delegation batch is limited to 50 tasks');
    const requestId = text(input.requestId) || `req_${now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const actor = text(input.actor) || 'delegator';
    const delegationId = newDelegationId();
    const createdAt = new Date(now()).toISOString();

    const classified = tasks.map((task, index) => {
      const prompt = text(task.prompt || task.objective);
      if (!prompt) fail('INVALID_ARGUMENT', `tasks[${index}] needs a prompt`);
      const classification = opts.classify(prompt) || {};
      const declared = text(task.taskTier).toLowerCase();
      // A caller may only *lower* the tier from what the classifier decided.
      // Raising it here would be an ungated escalation by another name.
      const tier = TASK_TIERS.includes(declared)
        && TIER_RANK[declared] <= TIER_RANK[classification.tier || 'standard']
        ? declared : (TASK_TIERS.includes(classification.tier) ? classification.tier : 'standard');
      return {
        index,
        task,
        prompt,
        priority: Number(task.priority) || 0,
        classification: {
          tier,
          classifiedTier: classification.tier || 'standard',
          tags: Array.isArray(classification.tags) ? classification.tags.slice(0, 12) : [],
          confidence: classification.confidence ?? null,
        },
      };
    });

    const capacity = capacitySnapshot();
    const entries = [];
    const contracts = [];

    for (const item of rank(classified)) {
      const { task, prompt, classification } = item;
      const attemptCorrelation = {
        requestId,
        invocationId: `${requestId}:task:${item.index + 1}`,
        attempt: 1,
        delegationId,
      };
      let selection = null;
      let blockedReason = null;
      try {
        selection = opts.selectProvider({ tier: classification.tier, task, prompt }) || null;
      } catch (error) {
        blockedReason = error.message;
      }
      if (selection && selection.ready === false) {
        blockedReason = selection.reason || 'no ready provider for this task';
      }
      if (!selection || blockedReason) {
        entries.push({
          taskRef: `${delegationId}#${item.index + 1}`,
          rank: item.rank,
          status: 'blocked',
          title: text(task.title) || prompt.slice(0, 120),
          prompt,
          classification,
          correlation: { ...attemptCorrelation, attemptId: `${attemptCorrelation.invocationId}:attempt:1`, taskId: null, receiptId: null },
          provider: selection?.kind || null,
          blockedReason: blockedReason || 'no provider was selected',
          contract: null,
          outcome: null,
          escalation: null,
        });
        continue;
      }

      const providerBudget = validateProviderBudget(task.providerBudget ?? selection.providerBudget) || {};
      const contractBudget = { maxTokens: providerBudget.maxTotalTokens, maxTurns: providerBudget.maxTurns, ...task.budget };
      // The legacy task.budget aliases must not silently widen a finite bound
      // the selected provider plan already resolved. Null remains an explicit
      // absence of a contract limit; the execution budget retains plan limits.
      for (const [contractField, providerField] of [['maxTokens', 'maxTotalTokens'], ['maxTurns', 'maxTurns']]) {
        const plannedLimit = selection.providerBudget?.[providerField];
        if (Number.isSafeInteger(plannedLimit) && plannedLimit > 0 && Number(contractBudget[contractField]) > plannedLimit) {
          contractBudget[contractField] = plannedLimit;
        }
      }
      const contract = buildHandoffContract({
        now: now(),
        correlation: attemptCorrelation,
        delegator: { actor, tier: text(input.delegatorTier) || 'utility' },
        writer: selection.kind,
        objective: text(task.objective) || prompt,
        cwd: task.cwd || input.cwd || process.cwd(),
        baseSha: text(task.baseSha) || text(input.baseSha),
        ownedFiles: task.ownedFiles || task.files,
        taskTier: classification.tier,
        provider: selection.kind,
        modelTier: selection.modelTier,
        effort: selection.effort,
        costClass: selection.costClass,
        toolPolicy: task.toolPolicy || { allow: ['read', 'search'] },
        dangerous: task.dangerous === true,
        budget: contractBudget,
        doneWhen: task.doneWhen,
        nonGoals: task.nonGoals,
        constraints: task.constraints,
        writerLeaseId: text(task.writerLeaseId) || null,
      });
      assertDispatchBoundary(contract);
      const resolvedBudget = executionBudget(contract, providerBudget);
      contracts.push(contract);

      entries.push({
        taskRef: `${delegationId}#${item.index + 1}`,
        rank: item.rank,
        status: 'planned',
        title: text(task.title) || prompt.slice(0, 120),
        prompt,
        classification,
        provider: selection.kind,
        costClass: selection.costClass || null,
        costRank: COST_CLASS[selection.costClass]?.rank ?? null,
        alternates: Array.isArray(selection.alternates) ? selection.alternates.slice(0, 3) : [],
        correlation: { ...contract.correlation, taskId: null, receiptId: null },
        contract,
        providerBudget: resolvedBudget,
        outcome: null,
        escalation: null,
        blockedReason: null,
      });
    }

    // One writer per path: refuse the whole batch rather than queue two tasks
    // that will fight over the same file.
    const conflicts = ownershipConflicts(contracts);
    if (conflicts.length) {
      fail('OWNERSHIP_CONFLICT', `delegated tasks claim overlapping files: ${conflicts
        .map((conflict) => `${conflict.contracts.join(' vs ')} on ${conflict.overlap.join(', ')}`).join('; ')}`);
    }

    const record = {
      delegationId,
      version: 1,
      requestId,
      actor,
      createdAt,
      updatedAt: createdAt,
      status: 'active',
      capacityAtSubmit: capacity,
      entries,
    };
    // Persist the plan before anything becomes runnable. If the process dies
    // during submission, resume() sees a `planned` entry with no taskId and can
    // report it instead of silently losing the ask.
    write(record);

    for (const entry of record.entries) {
      if (entry.status !== 'planned') continue;
      const body = {
        kind: entry.provider,
        prompt: `${renderHandoffBrief(entry.contract)}\n\n---\n\n${entry.prompt}`,
        cwd: entry.contract.cwd,
        dangerous: entry.contract.permissions.dangerous,
        taskTier: entry.contract.taskTier,
        modelTier: entry.contract.model.modelTier,
        effort: entry.contract.model.effort,
        providerBudget: entry.providerBudget,
        maxEffortOverride: false,
        user: actor,
        source: 'delegation',
        title: entry.title,
        intent: `${delegationId} ${entry.taskRef}; ${entry.contract.objective.slice(0, 160)}`,
      };
      submitEntry(record, entry, body);
    }
    record.updatedAt = new Date(now()).toISOString();
    write(updateStatus(record));
    log(`[RelayBridge] delegation ${delegationId}: ${record.entries.length} task(s) planned by ${actor}`);
    return record;
  }

  function get(delegationId) {
    const record = read(delegationId);
    return record ? reconcile(record) : null;
  }

  function list({ status, limit = 50 } = {}) {
    const bounded = Math.max(1, Math.min(Number(limit) || 50, 200));
    const names = recordNames();
    const records = [];
    for (const name of names.sort().reverse()) {
      const record = get(name.slice(0, -5));
      if (!record) continue;
      if (status && record.status !== status) continue;
      records.push(record);
      if (records.length >= bounded) break;
    }
    return records;
  }

  /**
   * Refreshes a delegation from the task queue.
   *
   * This is what makes a delegation resumable from a different surface: nothing
   * is held in memory, so the current truth is always "the record on disk plus
   * the task states the queue reports right now".
   */
  function resume(delegationId) {
    const record = read(delegationId);
    if (!record) fail('NOT_FOUND', 'delegation not found');
    return reconcile(record);
  }

  function reconcile(record) {
    const before = JSON.stringify(record);
    for (const entry of record.entries) {
      const taskId = entry.correlation?.taskId;
      const task = taskId ? taskQueue.get(taskId) : null;
      if (!task) {
        if (['planned', 'submitting', 'queued', 'running'].includes(entry.status)) {
          entry.status = 'blocked';
          entry.blockedReason = 'Queue submission is not confirmed; retained for operator reconciliation.';
        }
        continue;
      }
      if (entry.escalation?.status === 'pending') entry.status = 'awaiting_escalation';
      else if (entry.escalation?.status === 'denied') entry.status = 'escalation_denied';
      else if (entry.outcome?.classification === 'accepted' && task.status === 'done'
        && task.receiptId && entry.outcome.receiptId === task.receiptId) entry.status = 'accepted';
      else entry.status = task.status || entry.status;
      if (!['blocked', 'escalation_denied'].includes(entry.status)) entry.blockedReason = null;
      if (task.receiptId && entry.correlation.receiptId !== task.receiptId) {
        entry.correlation = { ...entry.correlation, receiptId: task.receiptId };
      }
    }
    updateStatus(record);
    if (before !== JSON.stringify(record)) {
      record.updatedAt = new Date(now()).toISOString();
      write(record);
    }
    return record;
  }

  function entryOf(record, taskRef) {
    const entry = record.entries.find((item) => item.taskRef === taskRef
      || item.correlation?.taskId === taskRef);
    if (!entry) fail('NOT_FOUND', `delegated task ${taskRef} not found`);
    return entry;
  }

  /**
   * Records what actually happened to a delegated task and, only on evidence,
   * opens an escalation.
   */
  function recordOutcome(delegationId, taskRef, outcome = {}) {
    const record = resume(delegationId);
    const entry = entryOf(record, taskRef);
    const classification = text(outcome.classification).toLowerCase();
    const accepted = ['accepted', ...ESCALATION_OUTCOMES];
    if (!accepted.includes(classification)) {
      fail('INVALID_OUTCOME', `classification must be one of ${accepted.join(', ')}`);
    }
    const observed = text(outcome.observed);
    if (classification !== 'accepted' && !observed) {
      fail('INVALID_OUTCOME', 'observed is required: state what the result actually was');
    }

    const task = entry.correlation?.taskId ? taskQueue.get(entry.correlation.taskId) : null;
    if (classification === 'accepted') {
      if (task?.status !== 'done' || !task.receiptId
        || (outcome.receiptId && outcome.receiptId !== task.receiptId)) {
        fail('COMPLETION_EVIDENCE_REQUIRED', 'Acceptance requires a done task and its matching queue receipt.');
      }
      if (entry.escalation?.status === 'pending') fail('ESCALATION_PENDING', 'Resolve the pending escalation before accepting a result.');
    } else if (!entry.contract) {
      fail('CONTRACT_MISSING', 'This blocked task has no contract; repair routing before escalation.');
    } else if (!task || !TERMINAL_TASK_STATES.has(task.status)) {
      fail('TERMINAL_TASK_REQUIRED', 'Wait for the original task to finish before recording an escalation outcome.');
    }

    entry.outcome = {
      classification,
      observed: observed || null,
      recordedAt: new Date(now()).toISOString(),
      recordedBy: text(outcome.actor) || 'operator',
      receiptId: text(outcome.receiptId) || entry.correlation?.receiptId || null,
    };

    if (classification === 'accepted') {
      entry.status = 'accepted';
      record.updatedAt = new Date(now()).toISOString();
      write(updateStatus(record));
      return { delegation: record, entry, escalation: null };
    }

    // Evidence exists, so an escalation may be *requested*. It is still gated:
    // nothing re-dispatches until a human or the delegator approves.
    const escalation = requestEscalation(entry.contract, {
      now: now(),
      kinds: outcome.kinds || ['model_tier'],
      evidence: [classification],
      observed,
      blockedWithout: text(outcome.blockedWithout) || `The delegated ${entry.classification.tier} task cannot be completed on ${entry.provider}.`,
      attemptsMade: Number(outcome.attemptsMade) || 1,
      requested: outcome.requested || {},
    });
    assertEscalationFeasible(entry.contract, escalation);
    entry.escalation = escalation;
    entry.status = 'awaiting_escalation';
    record.status = 'awaiting_escalation';
    record.updatedAt = new Date(now()).toISOString();
    write(record);

    if (incidents) {
      incidents.report({
        classification: 'delegation_escalation',
        summary: `${entry.provider} produced a ${classification} for ${entry.taskRef}; escalation ${escalation.escalationId} is awaiting approval`,
        provider: entry.provider,
        modelTier: entry.contract.model.modelTier,
        effort: entry.contract.model.effort,
        correlation: {
          requestId: entry.correlation.requestId,
          invocationId: entry.correlation.invocationId,
          attemptId: entry.correlation.attemptId,
          receiptId: entry.outcome.receiptId,
          taskId: entry.correlation.taskId,
          contractId: entry.contract.contractId,
          delegationId,
        },
        failureClass: classification,
      });
    }
    log(`[RelayBridge] delegation ${delegationId}: ${entry.taskRef} escalation ${escalation.escalationId} pending (${classification})`);
    return { delegation: record, entry, escalation };
  }

  /** Applies a human/delegator decision and, if approved, requeues under the widened contract. */
  function decideEscalation(delegationId, taskRef, decision = {}) {
    const record = resume(delegationId);
    const entry = entryOf(record, taskRef);
    if (!entry.escalation) fail('NOT_FOUND', 'no escalation is pending for this task');
    const resolved = resolveEscalation(entry.escalation, { ...decision, now: now() });

    if (!resolved.resolution.approved) {
      entry.escalation = resolved;
      entry.status = 'escalation_denied';
      record.updatedAt = new Date(now()).toISOString();
      write(updateStatus(record));
      return { delegation: record, entry, requeuedTaskId: null };
    }

    if (!entry.contract) fail('CONTRACT_MISSING', 'This blocked task has no contract; repair routing before escalation.');
    // Recheck durable queue state independently of the original outcome. An
    // older caller or a restarted coordinator may hold a pending escalation
    // whose task is still executing.
    const priorTask = entry.correlation?.taskId ? taskQueue.get(entry.correlation.taskId) : null;
    if (!priorTask || !TERMINAL_TASK_STATES.has(priorTask.status)) {
      fail('TERMINAL_TASK_REQUIRED', 'The original task must finish before an approved escalation can dispatch.');
    }
    if (text(decision.provider) && text(decision.provider) !== entry.provider) {
      fail('PROVIDER_REPLAN_REQUIRED', 'Changing providers requires a new route plan and correctly attributed contract.');
    }

    try {
      assertEscalationFeasible(entry.contract, entry.escalation);
    } catch (error) {
      if (error.code !== 'WRITE_SCOPE_UNENFORCED') throw error;
      // Legacy pending records may predate feasibility validation. Record why
      // this request cannot execute so repeated approvals do not wedge it.
      entry.escalation = resolveEscalation(entry.escalation, {
        ...decision, approved: false, note: error.message, now: now(),
      });
      entry.status = 'escalation_denied';
      entry.blockedReason = error.message;
      record.updatedAt = new Date(now()).toISOString();
      write(updateStatus(record));
      return { delegation: record, entry, requeuedTaskId: null };
    }
    const widened = applyApprovedEscalation(entry.contract, resolved, { now: now() });
    assertDispatchBoundary(widened);
    const providerBudget = executionBudget(widened, entry.providerBudget);
    entry.escalation = resolved;
    entry.contract = widened;
    entry.providerBudget = providerBudget;
    entry.outcome = null;
    entry.correlation = { ...widened.correlation, taskId: null, receiptId: null };
    const provider = text(decision.provider) || entry.provider;
    const body = {
      kind: provider,
      prompt: `${renderHandoffBrief(widened)}\n\n---\n\n${entry.prompt}`,
      cwd: widened.cwd,
      dangerous: widened.permissions.dangerous,
      taskTier: widened.taskTier,
      modelTier: widened.model.modelTier,
      effort: widened.model.effort,
      providerBudget,
      maxEffortOverride: false,
      user: resolved.resolution.approver,
      source: 'delegation_escalation',
      title: entry.title,
      intent: `${delegationId} ${entry.taskRef} escalated by ${resolved.resolution.approverKind}`,
    };
    entry.provider = provider;
    const taskId = submitEntry(record, entry, body);
    log(`[RelayBridge] delegation ${delegationId}: ${entry.taskRef} submission ${taskId} is ${entry.status} after ${resolved.resolution.approverKind} approval`);
    return { delegation: record, entry, requeuedTaskId: entry.status === 'blocked' ? null : taskId };
  }

  function stats() {
    const counts = { queued: 0, running: 0, awaitingEscalation: 0, settled: 0, blocked: 0 };
    for (const name of recordNames()) {
      const record = get(name.slice(0, -5));
      if (!record) continue;
      for (const entry of record.entries) {
        if (entry.status === 'queued') counts.queued += 1;
        else if (entry.status === 'running') counts.running += 1;
        else if (entry.status === 'awaiting_escalation') counts.awaitingEscalation += 1;
        else if (entry.status === 'blocked') counts.blocked += 1;
        else counts.settled += 1;
      }
    }
    return counts;
  }

  return { delegate, get, list, resume, recordOutcome, decideEscalation, stats, ESCALATION_OUTCOMES };
}

module.exports = { createDelegationCoordinator, DelegationError, ESCALATION_OUTCOMES };
