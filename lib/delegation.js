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

const TIER_RANK = Object.fromEntries(TASK_TIERS.map((tier, index) => [tier, index]));

// Only observed outcomes. See docs/BLUEPRINT.md: escalate on evidence, never on
// "feels hard".
const ESCALATION_OUTCOMES = Object.freeze(['wrong_result', 'empty_result', 'partial_result', 'failed_result']);

const TERMINAL_TASK_STATES = new Set(['done', 'failed', 'cancelled', 'interrupted']);

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
  const dir = opts.dataDir;
  if (!dir) fail('INVALID_ARGUMENT', 'dataDir is required');
  const taskQueue = opts.taskQueue;
  if (!taskQueue || typeof taskQueue.submit !== 'function' || typeof taskQueue.stats !== 'function') {
    fail('INVALID_ARGUMENT', 'taskQueue is required');
  }
  if (typeof opts.classify !== 'function') fail('INVALID_ARGUMENT', 'classify is required');
  if (typeof opts.selectProvider !== 'function') fail('INVALID_ARGUMENT', 'selectProvider is required');
  const incidents = opts.incidents && typeof opts.incidents.report === 'function' ? opts.incidents : null;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  fs.mkdirSync(dir, { recursive: true });

  const recordPath = (id) => {
    if (!/^dlg_[A-Za-z0-9_]+$/.test(String(id))) fail('INVALID_ARGUMENT', 'invalid delegation id');
    return path.join(dir, `${id}.json`);
  };

  function write(record) {
    const fp = recordPath(record.delegationId);
    const tmp = `${fp}.tmp`;
    // Write-then-rename, matching the task queue: a crash mid-write must not
    // leave a delegation that another surface cannot parse.
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
    return record;
  }

  function read(id) {
    try { return JSON.parse(fs.readFileSync(recordPath(id), 'utf8')); }
    catch { return null; }
  }

  function newDelegationId() {
    return `dlg_${now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
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
        toolPolicy: task.toolPolicy,
        dangerous: task.dangerous === true,
        budget: task.budget || selection.providerBudget || {},
        doneWhen: task.doneWhen,
        nonGoals: task.nonGoals,
        constraints: task.constraints,
        writerLeaseId: text(task.writerLeaseId) || null,
      });
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
      const taskId = typeof taskQueue.newTaskId === 'function' ? taskQueue.newTaskId() : null;
      const body = {
        kind: entry.provider,
        prompt: `${renderHandoffBrief(entry.contract)}\n\n---\n\n${entry.prompt}`,
        cwd: entry.contract.cwd,
        dangerous: entry.contract.permissions.dangerous,
        taskTier: entry.contract.taskTier,
        modelTier: entry.contract.model.modelTier,
        effort: entry.contract.model.effort,
        maxEffortOverride: false,
        user: actor,
        source: 'delegation',
        title: entry.title,
        intent: `${delegationId} ${entry.taskRef}; ${entry.contract.objective.slice(0, 160)}`,
      };
      try {
        const submitted = taskId && typeof taskQueue.submitReserved === 'function'
          ? taskQueue.submitReserved(taskId, body)
          : taskQueue.submit(body);
        entry.correlation = { ...entry.correlation, taskId: submitted.id };
        // The queue itself decides whether this runs now; "queued" here means
        // accepted and durable, not necessarily started.
        entry.status = submitted.status === 'running' ? 'running' : 'queued';
      } catch (error) {
        entry.status = 'blocked';
        entry.blockedReason = `queue submission failed: ${error.message}`;
      }
    }
    record.updatedAt = new Date(now()).toISOString();
    write(record);
    log(`[RelayBridge] delegation ${delegationId}: ${record.entries.length} task(s) planned by ${actor}`);
    return record;
  }

  function get(delegationId) {
    return read(delegationId);
  }

  function list({ status, limit = 50 } = {}) {
    const bounded = Math.max(1, Math.min(Number(limit) || 50, 200));
    const names = fs.readdirSync(dir).filter((name) => name.startsWith('dlg_') && name.endsWith('.json'));
    const records = [];
    for (const name of names.sort().reverse()) {
      const record = read(name.slice(0, -5));
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
    let changed = false;
    for (const entry of record.entries) {
      const taskId = entry.correlation?.taskId;
      if (!taskId) continue;
      const task = taskQueue.get(taskId);
      if (!task) continue;
      const status = TERMINAL_TASK_STATES.has(task.status) ? task.status : (task.status || entry.status);
      if (status !== entry.status) { entry.status = status; changed = true; }
      if (task.receiptId && entry.correlation.receiptId !== task.receiptId) {
        entry.correlation = { ...entry.correlation, receiptId: task.receiptId };
        changed = true;
      }
    }
    const open = record.entries.some((entry) => !TERMINAL_TASK_STATES.has(entry.status) && entry.status !== 'blocked');
    const awaiting = record.entries.some((entry) => entry.escalation?.status === 'pending');
    const status = awaiting ? 'awaiting_escalation' : open ? 'active' : 'settled';
    if (status !== record.status) { record.status = status; changed = true; }
    if (changed) {
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
    const record = read(delegationId);
    if (!record) fail('NOT_FOUND', 'delegation not found');
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
      write(record);
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
    const record = read(delegationId);
    if (!record) fail('NOT_FOUND', 'delegation not found');
    const entry = entryOf(record, taskRef);
    if (!entry.escalation) fail('NOT_FOUND', 'no escalation is pending for this task');
    const resolved = resolveEscalation(entry.escalation, { ...decision, now: now() });
    entry.escalation = resolved;

    if (!resolved.resolution.approved) {
      entry.status = 'escalation_denied';
      record.status = record.entries.some((item) => item.escalation?.status === 'pending')
        ? 'awaiting_escalation' : 'settled';
      record.updatedAt = new Date(now()).toISOString();
      write(record);
      return { delegation: record, entry, requeuedTaskId: null };
    }

    const widened = applyApprovedEscalation(entry.contract, resolved, { now: now() });
    entry.contract = widened;
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
      maxEffortOverride: false,
      user: resolved.resolution.approver,
      source: 'delegation_escalation',
      title: entry.title,
      intent: `${delegationId} ${entry.taskRef} escalated by ${resolved.resolution.approverKind}`,
    };
    const submitted = taskQueue.submit(body);
    entry.provider = provider;
    entry.correlation = { ...entry.correlation, taskId: submitted.id };
    entry.status = submitted.status === 'running' ? 'running' : 'queued';
    record.status = record.entries.some((item) => item.escalation?.status === 'pending')
      ? 'awaiting_escalation' : 'active';
    record.updatedAt = new Date(now()).toISOString();
    write(record);
    log(`[RelayBridge] delegation ${delegationId}: ${entry.taskRef} requeued as ${submitted.id} after ${resolved.resolution.approverKind} approval`);
    return { delegation: record, entry, requeuedTaskId: submitted.id };
  }

  function stats() {
    const counts = { queued: 0, running: 0, awaitingEscalation: 0, settled: 0, blocked: 0 };
    for (const record of list({ limit: 200 })) {
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
