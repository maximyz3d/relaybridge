'use strict';

// The writable-handoff contract.
//
// A cheap coordinator (Codex, a local model, a script) is allowed to *prepare*
// work for an expensive writer, but preparing is not the same as authorizing.
// Everything the writer is permitted to touch has to be named up front, in one
// frozen record, so that three separate failure modes become impossible:
//
//   silent scope creep   the writer decides mid-run that it also needs to edit
//                        four other files, and nobody finds out until review
//   silent escalation    a utility-tier task quietly re-dispatches itself onto
//                        a frontier seat because it "felt hard"
//   ambiguous ownership  two writers hold overlapping file sets and the later
//                        one clobbers the earlier one's edits
//
// So an out-of-bound request never widens the contract. It returns an
// escalation-needed record that a human or the delegator must resolve, and the
// approved widening produces a *new* contract with its own id and lineage.

const path = require('path');
const crypto = require('crypto');

const TASK_TIERS = Object.freeze(['deterministic', 'utility', 'standard', 'complex', 'critical']);
const TIER_RANK = Object.freeze(Object.fromEntries(TASK_TIERS.map((tier, index) => [tier, index])));

const MODEL_TIERS = Object.freeze(['light', 'standard', 'heavy']);
const MODEL_TIER_RANK = Object.freeze(Object.fromEntries(MODEL_TIERS.map((tier, index) => [tier, index])));

const EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const EFFORT_RANK = Object.freeze(Object.fromEntries(EFFORTS.map((effort, index) => [effort, index])));

// A request may only leave the contract's bounds for one of these reasons, and
// each has to be evidenced. "This looked hard" is not on the list.
const ESCALATION_KINDS = Object.freeze([
  'file_scope',        // wants to write a file the contract does not own
  'tool_policy',       // wants a tool the policy does not allow
  'task_tier',         // wants a higher task tier than was delegated
  'model_tier',        // wants a bigger model than was delegated
  'effort',            // wants more reasoning effort than was delegated
  'budget',            // wants more budget than was delegated
  'permission',        // wants dangerous/write permission it was not granted
  'cwd',               // wants to work outside the delegated workspace
]);

// Only observed outcomes justify escalation; see docs/BLUEPRINT.md ("Escalate
// on evidence ... never on 'feels hard'").
const ESCALATION_EVIDENCE = Object.freeze([
  'wrong_result',
  'empty_result',
  'partial_result',
  'failed_result',
  'out_of_scope_request',
  'blocked_by_permission',
]);

// Who may approve a widening. A model may never approve its own escalation:
// the whole point of the gate is that the decision leaves the escalating agent.
const APPROVERS = Object.freeze(['human', 'delegator']);

const DEFAULT_TOOL_ALLOW = Object.freeze(['read', 'search', 'write', 'run_tests']);

class HandoffError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'HandoffError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new HandoffError(code, message, details);
}

function text(value) {
  return String(value == null ? '' : value).replace(/\u0000/g, '').trim();
}

function cleanList(value, { limit = 200, itemChars = 2000 } = {}) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = [];
  for (const item of values) {
    const cleaned = text(item).slice(0, itemChars);
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    if (out.length >= limit) break;
  }
  return out;
}

function newContractId(now = Date.now()) {
  return `hc_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function newEscalationId(now = Date.now()) {
  return `esc_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function tierOf(value, fallback = 'standard') {
  const tier = text(value).toLowerCase();
  return TASK_TIERS.includes(tier) ? tier : fallback;
}

function modelTierOf(value, fallback = 'standard') {
  const tier = text(value).toLowerCase();
  return MODEL_TIERS.includes(tier) ? tier : fallback;
}

function effortOf(value, fallback = 'medium') {
  const effort = text(value).toLowerCase();
  return EFFORTS.includes(effort) ? effort : fallback;
}

// Owned files are stored workspace-relative and POSIX-separated so that two
// contracts written on different platforms still compare equal, and so that a
// path can never point outside the workspace it was delegated for.
function normalizeOwnedFile(file, cwd) {
  const raw = text(file);
  if (!raw) fail('INVALID_OWNED_FILE', 'an owned file entry was empty');
  if (raw.includes('\u0000')) fail('INVALID_OWNED_FILE', 'an owned file entry contained a null byte');
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw);
  const relative = path.relative(cwd, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('OWNED_FILE_OUTSIDE_WORKSPACE', `owned file "${raw}" resolves outside the delegated workspace`, { file: raw });
  }
  return relative.split(path.sep).join('/');
}

function normalizeOwnedFiles(files, cwd) {
  const workspace = path.resolve(text(cwd) || process.cwd());
  const out = [];
  for (const file of Array.isArray(files) ? files : files == null ? [] : [files]) {
    const normalized = normalizeOwnedFile(file, workspace);
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out.sort();
}

// Ownership is by prefix, not by string equality: owning `lib/` owns
// `lib/task-queue.js`, and two contracts that own `lib/` and `lib/task-queue.js`
// respectively are in conflict even though neither string equals the other.
function pathCovers(owned, candidate) {
  return owned === candidate || candidate.startsWith(`${owned}/`) || owned.startsWith(`${candidate}/`);
}

function ownsPath(ownedFiles, candidate) {
  return ownedFiles.some((owned) => owned === candidate || candidate.startsWith(`${owned}/`));
}

function toolPolicyOf(input = {}) {
  const allow = cleanList(input.allow ?? DEFAULT_TOOL_ALLOW, { limit: 64, itemChars: 120 })
    .map((tool) => tool.toLowerCase());
  const deny = cleanList(input.deny, { limit: 64, itemChars: 120 }).map((tool) => tool.toLowerCase());
  // Fail closed: an unlisted tool is denied, and an explicit deny always beats
  // an allow, so a copied-forward allow list cannot re-enable something the
  // delegator removed.
  return Object.freeze({
    mode: 'fail_closed',
    allow: Object.freeze(allow.filter((tool) => !deny.includes(tool))),
    deny: Object.freeze(deny),
  });
}

function budgetOf(input = {}) {
  const number = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);
  return Object.freeze({
    maxTokens: number(input.maxTokens),
    maxWallClockMs: number(input.maxWallClockMs),
    maxTurns: number(input.maxTurns),
    maxUsd: number(input.maxUsd),
    costClass: text(input.costClass) || null,
  });
}

function correlationOf(input = {}) {
  const requestId = text(input.requestId);
  if (!requestId) fail('INVALID_CORRELATION', 'correlation.requestId is required');
  // Mirrors server.js canonicalAttemptIdentity(): an invocation defaults to the
  // request that caused it, and attempts are numbered under the invocation.
  const invocationId = text(input.invocationId) || requestId;
  const attempt = Math.max(1, Math.floor(Number(input.attempt) || 1));
  return Object.freeze({
    requestId,
    invocationId,
    attemptId: text(input.attemptId) || `${invocationId}:attempt:${attempt}`,
    attempt,
    receiptId: text(input.receiptId) || null,
    delegationId: text(input.delegationId) || null,
    taskId: text(input.taskId) || null,
    runId: text(input.runId) || null,
  });
}

/**
 * Builds the frozen contract handed to a writer.
 *
 * Every bound the writer is expected to respect is explicit here, because a
 * bound that is only implied cannot be checked by evaluateRequest() later.
 */
function buildHandoffContract(input = {}) {
  const now = Number(input.now) || Date.now();
  const cwd = path.resolve(text(input.cwd) || process.cwd());
  const objective = text(input.objective);
  if (!objective) fail('INVALID_ARGUMENT', 'objective is required');
  const baseSha = text(input.baseSha);
  if (!baseSha) fail('INVALID_ARGUMENT', 'baseSha is required so the writer knows exactly what it is editing');
  const ownedFiles = normalizeOwnedFiles(input.ownedFiles, cwd);
  if (!ownedFiles.length) fail('INVALID_ARGUMENT', 'ownedFiles is required; a writer with no declared scope cannot be bounded');
  const doneWhen = cleanList(input.doneWhen);
  if (!doneWhen.length) fail('INVALID_ARGUMENT', 'doneWhen is required; without it "done" is the writer\'s opinion');

  const dangerous = input.dangerous === true;
  return Object.freeze({
    contractId: text(input.contractId) || newContractId(now),
    version: 1,
    createdAt: new Date(now).toISOString(),
    correlation: correlationOf(input.correlation || input),
    delegator: Object.freeze({
      actor: text(input.delegator?.actor || input.actor) || 'unknown',
      tier: tierOf(input.delegator?.tier, 'utility'),
    }),
    writer: text(input.writer) || 'claude',
    objective,
    cwd,
    baseSha,
    ownedFiles: Object.freeze(ownedFiles),
    // One writer per file set. The lease itself lives in workflow-pipeline; the
    // contract records which lease this authorization belongs to so a stale
    // contract cannot be replayed against a lease someone else now holds.
    ownership: Object.freeze({
      mode: 'exclusive',
      writerLeaseId: text(input.writerLeaseId) || null,
      note: 'Exactly one writer may hold these paths. Do not edit a path outside ownedFiles.',
    }),
    taskTier: tierOf(input.taskTier),
    model: Object.freeze({
      provider: text(input.provider) || null,
      modelTier: modelTierOf(input.modelTier),
      effort: effortOf(input.effort),
      costClass: text(input.costClass) || null,
    }),
    toolPolicy: toolPolicyOf(input.toolPolicy),
    permissions: Object.freeze({
      dangerous,
      // Writing is authorized only when the delegator explicitly said so; an
      // unverified provider policy must never be read as permission.
      filesystem: dangerous ? 'writer_authorized' : 'read_only_enforced',
      mode: 'fail_closed',
    }),
    budget: budgetOf(input.budget),
    doneWhen: Object.freeze(doneWhen),
    nonGoals: Object.freeze(cleanList(input.nonGoals)),
    constraints: Object.freeze(cleanList(input.constraints)),
    escalation: Object.freeze({
      allowed: false,
      requiresJustification: true,
      requiresApprovalFrom: Object.freeze([...APPROVERS]),
      note: 'Out-of-bound work stops and returns an escalation record. It is never performed under this contract.',
    }),
    lineage: Object.freeze(cleanList(input.lineage, { limit: 20, itemChars: 200 })),
  });
}

/**
 * Checks a writer's request against the contract.
 *
 * Returns `{ decision: 'allowed' }` or an escalation-needed record. It never
 * returns a widened contract: widening is a separate, gated step.
 */
function evaluateRequest(contract, request = {}) {
  if (!contract || !contract.contractId) fail('INVALID_ARGUMENT', 'contract is required');
  const reasons = [];

  const requestedCwd = text(request.cwd);
  if (requestedCwd && path.resolve(requestedCwd) !== contract.cwd) {
    reasons.push({
      kind: 'cwd',
      requested: path.resolve(requestedCwd),
      permitted: contract.cwd,
      reason: 'the request targets a workspace outside the delegated cwd',
    });
  }

  const requestedFiles = [];
  for (const file of cleanList(request.files ?? request.writes)) {
    let normalized;
    try {
      normalized = normalizeOwnedFile(file, contract.cwd);
    } catch (error) {
      // A path that escapes the workspace is out of bounds by definition; it is
      // reported as an escalation rather than throwing, so the caller gets one
      // uniform record for every kind of out-of-bound request.
      reasons.push({ kind: 'file_scope', requested: text(file), permitted: contract.ownedFiles, reason: error.message });
      continue;
    }
    requestedFiles.push(normalized);
    if (!ownsPath(contract.ownedFiles, normalized)) {
      reasons.push({
        kind: 'file_scope',
        requested: normalized,
        permitted: contract.ownedFiles,
        reason: `"${normalized}" is not in the contract's owned file set`,
      });
    }
  }

  for (const tool of cleanList(request.tools, { limit: 64, itemChars: 120 })) {
    const name = tool.toLowerCase();
    if (contract.toolPolicy.deny.includes(name) || !contract.toolPolicy.allow.includes(name)) {
      reasons.push({
        kind: 'tool_policy',
        requested: name,
        permitted: contract.toolPolicy.allow,
        reason: `tool "${name}" is not permitted under the fail-closed tool policy`,
      });
    }
  }

  if (request.dangerous === true && !contract.permissions.dangerous) {
    reasons.push({
      kind: 'permission',
      requested: 'dangerous',
      permitted: contract.permissions.filesystem,
      reason: 'the contract authorizes read-only work; write permission was not delegated',
    });
  }

  const requestedTier = text(request.taskTier).toLowerCase();
  if (requestedTier && TIER_RANK[requestedTier] > TIER_RANK[contract.taskTier]) {
    reasons.push({
      kind: 'task_tier',
      requested: requestedTier,
      permitted: contract.taskTier,
      reason: `task tier ${requestedTier} exceeds the delegated tier ${contract.taskTier}`,
    });
  }

  const requestedModelTier = text(request.modelTier).toLowerCase();
  if (requestedModelTier && MODEL_TIER_RANK[requestedModelTier] > MODEL_TIER_RANK[contract.model.modelTier]) {
    reasons.push({
      kind: 'model_tier',
      requested: requestedModelTier,
      permitted: contract.model.modelTier,
      reason: `model tier ${requestedModelTier} exceeds the delegated tier ${contract.model.modelTier}`,
    });
  }

  const requestedEffort = text(request.effort).toLowerCase();
  if (requestedEffort && EFFORT_RANK[requestedEffort] > EFFORT_RANK[contract.model.effort]) {
    reasons.push({
      kind: 'effort',
      requested: requestedEffort,
      permitted: contract.model.effort,
      reason: `effort ${requestedEffort} exceeds the delegated effort ${contract.model.effort}`,
    });
  }

  for (const [field, limit] of [['maxTokens', contract.budget.maxTokens], ['maxUsd', contract.budget.maxUsd],
    ['maxTurns', contract.budget.maxTurns], ['maxWallClockMs', contract.budget.maxWallClockMs]]) {
    const wanted = Number(request.budget?.[field]);
    if (Number.isFinite(wanted) && limit !== null && wanted > limit) {
      reasons.push({
        kind: 'budget',
        requested: `${field}=${wanted}`,
        permitted: `${field}=${limit}`,
        reason: `requested ${field} exceeds the delegated budget`,
      });
    }
  }

  if (!reasons.length) {
    return Object.freeze({
      decision: 'allowed',
      contractId: contract.contractId,
      correlation: contract.correlation,
      files: Object.freeze(requestedFiles),
    });
  }

  return Object.freeze({
    decision: 'escalation_needed',
    contractId: contract.contractId,
    correlation: contract.correlation,
    // Stated so a caller cannot mistake this for a partial grant.
    scopeExpanded: false,
    kinds: Object.freeze([...new Set(reasons.map((item) => item.kind))]),
    reasons: Object.freeze(reasons.map((item) => Object.freeze(item))),
    requiredAction: 'requestEscalation',
    gate: Object.freeze({ requiresJustification: true, approvers: Object.freeze([...APPROVERS]) }),
  });
}

/**
 * Turns an out-of-bound finding into a structured, gated escalation request.
 *
 * The justification is mandatory and must cite observed evidence, not a
 * subjective difficulty judgement.
 */
function requestEscalation(contract, justification = {}) {
  if (!contract || !contract.contractId) fail('INVALID_ARGUMENT', 'contract is required');
  const kinds = cleanList(justification.kinds ?? justification.kind, { limit: 8, itemChars: 40 })
    .map((kind) => kind.toLowerCase());
  if (!kinds.length) fail('INVALID_ESCALATION', 'kinds is required');
  const unknownKind = kinds.find((kind) => !ESCALATION_KINDS.includes(kind));
  if (unknownKind) fail('INVALID_ESCALATION', `unknown escalation kind "${unknownKind}"`, { allowed: ESCALATION_KINDS });

  const evidence = cleanList(justification.evidence, { limit: 8, itemChars: 40 }).map((item) => item.toLowerCase());
  if (!evidence.length) fail('ESCALATION_EVIDENCE_REQUIRED', 'evidence is required; escalate on observed outcomes, never on difficulty');
  const unknownEvidence = evidence.find((item) => !ESCALATION_EVIDENCE.includes(item));
  if (unknownEvidence) {
    fail('ESCALATION_EVIDENCE_REQUIRED', `"${unknownEvidence}" is not recognized evidence`, { allowed: ESCALATION_EVIDENCE });
  }

  const observed = text(justification.observed);
  if (!observed) fail('INVALID_ESCALATION', 'observed is required: state what actually happened');
  const blockedWithout = text(justification.blockedWithout);
  if (!blockedWithout) fail('INVALID_ESCALATION', 'blockedWithout is required: state what cannot be completed without this');

  const now = Number(justification.now) || Date.now();
  return Object.freeze({
    escalationId: text(justification.escalationId) || newEscalationId(now),
    contractId: contract.contractId,
    correlation: contract.correlation,
    createdAt: new Date(now).toISOString(),
    status: 'pending',
    kinds: Object.freeze(kinds),
    evidence: Object.freeze(evidence),
    observed,
    blockedWithout,
    attemptsMade: Math.max(0, Math.floor(Number(justification.attemptsMade) || 0)),
    requested: Object.freeze({
      ownedFiles: Object.freeze(cleanList(justification.requested?.ownedFiles)),
      tools: Object.freeze(cleanList(justification.requested?.tools, { limit: 32, itemChars: 120 })
        .map((tool) => tool.toLowerCase())),
      taskTier: justification.requested?.taskTier ? tierOf(justification.requested.taskTier) : null,
      modelTier: justification.requested?.modelTier ? modelTierOf(justification.requested.modelTier) : null,
      effort: justification.requested?.effort ? effortOf(justification.requested.effort) : null,
      dangerous: justification.requested?.dangerous === true,
      budget: budgetOf(justification.requested?.budget || {}),
    }),
    gate: Object.freeze({
      approvers: Object.freeze([...APPROVERS]),
      // A higher tier or a bigger model is money, so it is never auto-approved
      // even when the evidence is impeccable.
      humanRequired: kinds.some((kind) => kind === 'task_tier' || kind === 'model_tier' || kind === 'permission'),
    }),
    resolution: null,
  });
}

/** Records a human/delegator decision on an escalation. */
function resolveEscalation(escalation, decision = {}) {
  if (!escalation || !escalation.escalationId) fail('INVALID_ARGUMENT', 'escalation is required');
  if (escalation.status !== 'pending') fail('ESCALATION_SETTLED', `escalation ${escalation.escalationId} is already ${escalation.status}`);
  const approverKind = text(decision.approverKind).toLowerCase();
  if (!APPROVERS.includes(approverKind)) {
    fail('INVALID_APPROVER', 'approverKind must be human or delegator', { allowed: APPROVERS });
  }
  const approver = text(decision.approver);
  if (!approver) fail('INVALID_APPROVER', 'approver is required');
  const approved = decision.approved === true;
  if (approved && escalation.gate.humanRequired && approverKind !== 'human') {
    fail('HUMAN_GATE_REQUIRED', 'this escalation raises tier, model, or permission and requires a human approver');
  }
  const now = Number(decision.now) || Date.now();
  return Object.freeze({
    ...escalation,
    status: approved ? 'approved' : 'denied',
    resolution: Object.freeze({
      approved,
      approver,
      approverKind,
      note: text(decision.note) || null,
      decidedAt: new Date(now).toISOString(),
    }),
  });
}

/**
 * Produces the successor contract for an approved escalation.
 *
 * A new contract id and a lineage entry, rather than an in-place edit, so that
 * receipts written under the old bounds still describe the bounds that were
 * actually in force at the time.
 */
function applyApprovedEscalation(contract, escalation, { now = Date.now() } = {}) {
  if (!escalation || escalation.status !== 'approved') fail('ESCALATION_NOT_APPROVED', 'only an approved escalation can widen a contract');
  if (escalation.contractId !== contract.contractId) fail('CONTRACT_MISMATCH', 'escalation does not belong to this contract');
  const requested = escalation.requested;
  const ownedFiles = contract.ownedFiles.concat(
    escalation.kinds.includes('file_scope') ? requested.ownedFiles : [],
  );
  const allow = contract.toolPolicy.allow.concat(
    escalation.kinds.includes('tool_policy') ? requested.tools : [],
  );
  return buildHandoffContract({
    now,
    contractId: newContractId(now),
    correlation: { ...contract.correlation, attempt: contract.correlation.attempt + 1, attemptId: null },
    delegator: contract.delegator,
    writer: contract.writer,
    objective: contract.objective,
    cwd: contract.cwd,
    baseSha: contract.baseSha,
    ownedFiles,
    writerLeaseId: contract.ownership.writerLeaseId,
    taskTier: escalation.kinds.includes('task_tier') && requested.taskTier ? requested.taskTier : contract.taskTier,
    provider: contract.model.provider,
    modelTier: escalation.kinds.includes('model_tier') && requested.modelTier ? requested.modelTier : contract.model.modelTier,
    effort: escalation.kinds.includes('effort') && requested.effort ? requested.effort : contract.model.effort,
    costClass: contract.model.costClass,
    toolPolicy: { allow, deny: contract.toolPolicy.deny },
    dangerous: escalation.kinds.includes('permission') ? requested.dangerous : contract.permissions.dangerous,
    budget: escalation.kinds.includes('budget')
      ? { ...contract.budget, ...Object.fromEntries(Object.entries(requested.budget).filter(([, v]) => v !== null)) }
      : contract.budget,
    doneWhen: contract.doneWhen,
    nonGoals: contract.nonGoals,
    constraints: contract.constraints,
    lineage: contract.lineage.concat([`${contract.contractId} widened by ${escalation.escalationId}`]),
  });
}

/**
 * Finds contracts that claim overlapping paths in the same workspace.
 *
 * This is the one-writer rule expressed as a check rather than a convention.
 */
function ownershipConflicts(contracts = []) {
  const conflicts = [];
  const active = contracts.filter(Boolean);
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i];
      const b = active[j];
      if (a.cwd !== b.cwd) continue;
      const overlap = a.ownedFiles.filter((file) => b.ownedFiles.some((other) => pathCovers(other, file)));
      if (overlap.length) {
        conflicts.push({ contracts: [a.contractId, b.contractId], cwd: a.cwd, overlap });
      }
    }
  }
  return conflicts;
}

/** The contract as the writer sees it in its prompt. */
function renderHandoffBrief(contract) {
  const bullets = (items) => (items.length ? items.map((item) => `- ${item}`).join('\n') : '- None supplied.');
  const budget = Object.entries(contract.budget).filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}=${value}`);
  return [
    '## Handoff contract',
    '',
    `Contract: ${contract.contractId}`,
    `Request: ${contract.correlation.requestId} · invocation ${contract.correlation.invocationId} · attempt ${contract.correlation.attemptId}`,
    `Workspace: ${contract.cwd}`,
    `Base revision: ${contract.baseSha}`,
    `Task tier: ${contract.taskTier} · model tier ${contract.model.modelTier} · effort ${contract.model.effort}`,
    `Requested permissions: ${contract.permissions.filesystem}; runtime enforcement must be verified separately.`,
    '',
    '## Objective',
    '',
    contract.objective,
    '',
    '## Assigned file scope (not a filesystem sandbox or writer lease)',
    '',
    bullets([...contract.ownedFiles]),
    '',
    '## Requested tool policy (do not use unlisted tools; this prompt is not an interceptor)',
    '',
    `Allowed: ${contract.toolPolicy.allow.join(', ') || 'none'}`,
    `Denied: ${contract.toolPolicy.deny.join(', ') || 'none explicitly'}`,
    '',
    '## Budget',
    '',
    bullets(budget.length ? budget : []),
    '',
    '## Done when',
    '',
    bullets([...contract.doneWhen]),
    '',
    '## Non-goals',
    '',
    bullets([...contract.nonGoals]),
    '',
    '## Out of bounds',
    '',
    'If the work requires a file, tool, permission, tier, model, or budget not listed above, stop and report an escalation with observed evidence. Do not expand scope yourself; a human or the delegator must approve any widening.',
  ].join('\n');
}

module.exports = {
  TASK_TIERS,
  MODEL_TIERS,
  EFFORTS,
  ESCALATION_KINDS,
  ESCALATION_EVIDENCE,
  APPROVERS,
  HandoffError,
  normalizeOwnedFiles,
  buildHandoffContract,
  evaluateRequest,
  requestEscalation,
  resolveEscalation,
  applyApprovedEscalation,
  ownershipConflicts,
  renderHandoffBrief,
};
