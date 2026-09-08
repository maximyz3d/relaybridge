'use strict';

// The no-verdict incident inbox.
//
// A provider that returns prose but no verdict marker is the worst kind of
// failure: the pipeline correctly refuses to advance, but from the operator's
// side it looks identical to a crash, a timeout, or a quota block. Without a
// record of *which* it was, the same broken prompt gets retried for days.
//
// Two properties matter more than completeness here:
//
//   sanitized     the offending output is exactly the thing most likely to
//                 contain a capability token, an absolute home path, or an API
//                 key, so the raw text is never stored. A digest and a length
//                 are enough to tell "the same failure again" from "a new one".
//   deduplicated  a stuck workflow can re-settle the same attempt many times.
//                 One incident per (classification, exact correlation ids) with
//                 an occurrence counter, not one per observation.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CLASSIFICATIONS = Object.freeze([
  'no_verdict',            // marker absent entirely (parse returned UNKNOWN)
  'blocked_verdict',       // an explicit BLOCK that needs an operator
  'partial_output',        // checkpoint or truncated provider result cannot establish a verdict
  'admission_limit',       // local execution concurrency admission
  'authentication',        // authentication must not be confused with provider quota
  'provider_quota',        // observed vendor exhaustion/rate limit
  'cooldown',
  'dependency_blocked',
  'approval_required',
  'capacity_unknown',
  'empty_output',          // provider returned nothing at all
  'plan_not_ready',        // planning finished without PLAN_STATUS: READY
  'revision_not_applied',  // revision finished without REVISION_STATUS: APPLIED
  'contract_escalation',   // writer asked for something outside its contract
  'delegation_escalation', // delegated work escalated on observed evidence
  'budget_exceeded',      // budget/usage failure; summary distinguishes known local limits
  'context_limit',        // explicitly reported provider context capacity
  'provider_failure',
  'provider_timeout',
  'provider_unavailable',
  'bridge_interrupted',
]);

const MAX_DETAIL_CHARS = 600;
const DEFAULT_MAX_ENTRIES = 500;

// Anything that looks like a credential is removed before storage. This runs on
// operator-visible text only; it is a defence against accidental disclosure in
// the inbox and in logs, not a claim that the source text was untrusted.
const REDACTIONS = [
  [/\b(?:authorization\s*[:=]\s*)?bearer\s+[^\s,;"']+/gi, 'Bearer [redacted]'],
  [/\b[A-Za-z0-9_-]*(?:sk|pat|ghp|gho|ghs|github_pat)[-_][A-Za-z0-9_-]{16,}\b/gi, '[redacted-token]'],
  [/\b(bearer|token|authorization|api[-_]?key|secret|password)\b(\s*[:=]\s*)\S+/gi, '$1$2[redacted]'],
  [/\b[A-Fa-f0-9]{32,}\b/g, '[redacted-hex]'],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[redacted-blob]'],
];

function sanitizeText(value, limit = MAX_DETAIL_CHARS) {
  let out = String(value == null ? '' : value).replace(/\u0000/g, '').trim();
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, typeof replacement === 'string' ? replacement : '[redacted]');
  }
  // Absolute paths leak the operator's home directory and username into a file
  // that is meant to be safe to paste into an issue.
  out = out.replace(/(?:[A-Za-z]:)?[\\/](?:Users|home)[\\/][^\s"']+/g, '[redacted-path]');
  return out.length > limit ? `${out.slice(0, limit)}…` : out;
}

function digestOf(value) {
  const text = String(value == null ? '' : value);
  if (!text) return null;
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function idOf(value) {
  return sanitizeText(value, 200) || null;
}

// Keep local budget exhaustion distinct from a provider's context limit.
// Raw errors are hashed, never copied into the operator-facing summary.
function taskFailureDetails(task = {}) {
  const failure = String(task.failureClass || '').toLowerCase();
  const localBudget = /^token_budget(?:_|$)/.test(failure) || /^token_budget(?:_|$)/.test(task.stopReason || '');
  const classification = task.status === 'interrupted' ? 'bridge_interrupted'
    : localBudget || task.flags?.budget_exceeded || ['budget_exceeded', 'budget'].includes(failure) ? 'budget_exceeded'
    : ['context_limit', 'context_length_exceeded', 'context_window_exceeded'].includes(failure) ? 'context_limit'
    : task.flags?.auth_failed || ['auth_unavailable', 'auth_failed', 'auth', 'authentication'].includes(failure) ? 'authentication'
    : ['vendor_exhausted', 'provider_quota', 'rate_limit', 'rate_limited'].includes(failure) || task.flags?.rate_limited ? 'provider_quota'
    : ['admission_limit', 'concurrency_limit'].includes(failure) ? 'admission_limit'
    : ['cooldown', 'provider_cooldown'].includes(failure) ? 'cooldown'
    : /^dependency(?:_|$)/.test(failure) ? 'dependency_blocked'
    : ['approval_required', 'permission_denied', 'policy'].includes(failure) ? 'approval_required'
    : ['capacity_unknown', 'unknown_capacity'].includes(failure) ? 'capacity_unknown'
    : task.flags?.timed_out || failure === 'timeout' ? 'provider_timeout'
    : ['account_unavailable', 'provider_unavailable'].includes(failure) ? 'provider_unavailable'
    : task.flags?.partial_result || ['partial_output', 'partial_result'].includes(failure) ? 'partial_output'
    : failure === 'empty_output' || (failure === 'no_verdict' && !String(task.result || '').trim()) ? 'empty_output'
    : failure === 'no_verdict' ? 'no_verdict' : 'provider_failure';
  const actions = {
    bridge_interrupted: 'Confirm termination or fencing of the prior execution, inspect its artifacts, then explicitly decide whether new work is safe. Never replay an uncertain writer.',
    budget_exceeded: 'Inspect local budget and usage evidence; adjust the scoped task or authorized budget before a fresh attempt.',
    context_limit: 'Use the explicit provider context-limit receipt to reduce context before a fresh attempt.',
    authentication: 'Restore the selected provider authentication through the operator; keep its authentication gate enabled.',
    provider_quota: 'Respect the observed vendor retry/reset time or obtain new authoritative capacity evidence; configured token budgets do not establish subscription allowance.',
    admission_limit: 'Wait for an admitted execution to finish; inspect correlated admission receipts without reclaiming slots from empty activity probes.',
    cooldown: 'Wait for the recorded cooldown deadline; keep genuine vendor safeguards enabled.',
    dependency_blocked: 'Inspect the required task outcomes; resolve or explicitly replace failed dependencies before submitting new work.',
    approval_required: 'Obtain the required scoped approval through the authorized control surface.',
    capacity_unknown: 'Obtain current vendor or operator capacity evidence; unknown capacity is not zero capacity.',
    partial_output: 'Retain the checkpoint as partial evidence; obtain a fresh complete review before treating any marker as a verdict.',
    empty_output: 'Inspect the exact task and receipt for missing output; obtain a complete response before advancing.',
    no_verdict: 'Obtain a complete explicit verdict from a fresh review before advancing.',
  };
  const nextAction = actions[classification] || 'Inspect the exact task and receipt, confirm execution termination, and explicitly decide whether a fresh attempt is safe.';
  return {
    classification,
    summary: localBudget
      ? 'No verdict: local execution budget exceeded; this does not establish a provider context or subscription limit.'
      : classification === 'budget_exceeded'
        ? 'No verdict: reported budget or usage limit. Inspect the receipt to distinguish local limits from provider quota.'
        : `No verdict: ${classification.replace(/_/g, ' ')}.`,
    nextAction: ['uncertain', 'in_flight'].includes(task.execution?.state)
      ? `First obtain authoritative termination or fencing evidence; missing activity is not proof. ${nextAction}` : nextAction,
    requirementIds: task.requirementIds || [],
    output: task.error || task.stderr || task.result || '',
    provider: task.kind,
    failureClass: task.failureClass,
    runId: task.correlation?.runId || null,
    correlation: { ...task.correlation, taskId: task.id, receiptId: task.receiptId || task.execution?.receiptId,
      requestId: task.correlation?.requestId || task.route?.request_id || task.body?.requestId || null,
      invocationId: task.correlation?.invocationId || task.route?.invocation_id || null,
      attemptId: task.correlation?.attemptId || task.route?.attempt_id || null },
  };
}

/**
 * @param {object}   opts
 * @param {string}   opts.dataDir   directory for the durable inbox file
 * @param {function} [opts.now]
 * @param {function} [opts.log]
 * @param {number}   [opts.maxEntries] ring size; oldest acknowledged first
 */
function createIncidentLog(opts = {}) {
  const dir = opts.dataDir;
  if (!dir) throw new Error('dataDir is required');
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const maxEntries = Math.max(20, Math.min(Number(opts.maxEntries) || DEFAULT_MAX_ENTRIES, 5000));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'incidents.json');

  let entries = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed?.incidents)) entries = parsed.incidents;
  } catch {
    // A missing or corrupt inbox must not stop the bridge from booting; the
    // inbox is diagnostic, and losing it is strictly better than failing to
    // start the control plane.
  }
  const byFingerprint = new Map(entries.map((entry) => [entry.fingerprint, entry]));

  function persist() {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, incidents: entries }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  function prune() {
    if (entries.length <= maxEntries) return;
    // Acknowledged incidents are the ones the operator already dealt with, so
    // they are dropped before anything still open.
    const keep = entries.filter((entry) => entry.status === 'open');
    const acknowledged = entries.filter((entry) => entry.status !== 'open');
    const retained = new Set(keep.concat(acknowledged).slice(0, maxEntries));
    entries = entries.filter((entry) => retained.has(entry));
    for (const [fingerprint, entry] of byFingerprint) {
      if (!entries.includes(entry)) byFingerprint.delete(fingerprint);
    }
  }

  // The fingerprint is the identity of the failure, not of the observation:
  // same classification, same exact ids => same incident.
  function fingerprintOf(record) {
    // Queue failure reporting happens before workflow reconciliation. Both
    // observe the same physical task; attach workflow context to that incident.
    if (record.correlation.taskId) {
      return crypto.createHash('sha256').update(JSON.stringify([
        record.classification, record.correlation.taskId, record.correlation.receiptId,
      ])).digest('hex').slice(0, 20);
    }
    return crypto.createHash('sha256').update([
      record.classification,
      record.correlation.requestId || '',
      record.correlation.invocationId || '',
      record.correlation.attemptId || '',
      record.correlation.receiptId || '',
      record.correlation.taskId || '',
      record.correlation.contractId || '',
      record.correlation.delegationId || '',
      record.runId || '',
      record.phase || '',
    ].join('|')).digest('hex').slice(0, 20);
  }

  /**
   * Records one observation. Returns the stored incident and whether it merged
   * into an existing one.
   */
  function report(input = {}) {
    const classification = String(input.classification || '').trim();
    if (!CLASSIFICATIONS.includes(classification)) {
      throw new Error(`unknown incident classification "${classification}"`);
    }
    const at = now();
    const correlation = {
      requestId: idOf(input.correlation?.requestId ?? input.requestId),
      invocationId: idOf(input.correlation?.invocationId ?? input.invocationId),
      attemptId: idOf(input.correlation?.attemptId ?? input.attemptId),
      receiptId: idOf(input.correlation?.receiptId ?? input.receiptId),
      taskId: idOf(input.correlation?.taskId ?? input.taskId),
      contractId: idOf(input.correlation?.contractId ?? input.contractId),
      delegationId: idOf(input.correlation?.delegationId ?? input.delegationId),
    };
    const record = {
      classification,
      runId: idOf(input.runId),
      phase: idOf(input.phase),
      provider: idOf(input.provider),
      correlation,
    };
    const fingerprint = fingerprintOf(record);
    const existing = byFingerprint.get(fingerprint);
    if (existing) {
      existing.occurrences += 1;
      existing.lastSeenAt = new Date(at).toISOString();
      for (const key of ['runId', 'phase', 'provider']) {
        if (!existing[key] && record[key]) existing[key] = record[key];
      }
      for (const [key, value] of Object.entries(correlation)) {
        if (!existing.correlation[key] && value) existing.correlation[key] = value;
      }
      if (input.nextAction) existing.nextAction = sanitizeText(input.nextAction);
      existing.requirementIds = [...new Set([...(existing.requirementIds || []), ...(Array.isArray(input.requirementIds) ? input.requirementIds.map(idOf).filter(Boolean) : [])])].slice(0, 64);
      persist();
      return { incident: structuredClone(existing), deduplicated: true };
    }

    const output = input.output == null ? null : String(input.output);
    const incident = {
      incidentId: `inc_${at.toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      fingerprint,
      status: 'open',
      classification,
      // Sanitized summary only. The raw provider output is deliberately not
      // stored anywhere in this record.
      summary: sanitizeText(input.summary || input.detail || classification.replace(/_/g, ' ')),
      runId: record.runId,
      phase: record.phase,
      provider: record.provider,
      modelTier: idOf(input.modelTier),
      effort: idOf(input.effort),
      nextAction: sanitizeText(input.nextAction || 'Inspect the correlated task and receipt; no verdict does not authorize advancement.'),
      requirementIds: Array.isArray(input.requirementIds) ? [...new Set(input.requirementIds.map(idOf).filter(Boolean))].slice(0, 64) : [],
      correlation,
      evidence: {
        outputDigest: digestOf(output),
        outputChars: output === null ? null : output.length,
        failureClass: idOf(input.failureClass),
        markerSeen: idOf(input.markerSeen),
        markerExpected: idOf(input.markerExpected),
      },
      occurrences: 1,
      firstSeenAt: new Date(at).toISOString(),
      lastSeenAt: new Date(at).toISOString(),
      acknowledgedAt: null,
      acknowledgedBy: null,
      note: null,
    };
    entries.unshift(incident);
    byFingerprint.set(fingerprint, incident);
    prune();
    persist();
    log(`[RelayBridge] incident ${incident.incidentId}: ${classification}${incident.runId ? ` on ${incident.runId}` : ''}`);
    return { incident: structuredClone(incident), deduplicated: false };
  }

  function list({ status, classification, limit = 50 } = {}) {
    const bounded = Math.max(1, Math.min(Number(limit) || 50, 200));
    return entries
      .filter((entry) => (!status || entry.status === status)
        && (!classification || entry.classification === classification))
      .slice(0, bounded)
      .map((entry) => structuredClone(entry));
  }

  function get(incidentId) {
    const entry = entries.find((item) => item.incidentId === incidentId);
    return entry ? structuredClone(entry) : null;
  }

  function acknowledge(incidentId, { actor = 'operator', note = null } = {}) {
    const entry = entries.find((item) => item.incidentId === incidentId);
    if (!entry) throw new Error('incident not found');
    entry.status = 'acknowledged';
    entry.acknowledgedAt = new Date(now()).toISOString();
    entry.acknowledgedBy = sanitizeText(actor, 120) || 'operator';
    entry.note = note == null ? null : sanitizeText(note);
    persist();
    return structuredClone(entry);
  }

  function stats() {
    const open = entries.filter((entry) => entry.status === 'open');
    const byClassification = {};
    for (const entry of open) {
      byClassification[entry.classification] = (byClassification[entry.classification] || 0) + entry.occurrences;
    }
    return {
      total: entries.length,
      open: open.length,
      occurrencesOpen: open.reduce((sum, entry) => sum + entry.occurrences, 0),
      byClassification,
    };
  }

  return { report, list, get, acknowledge, stats, CLASSIFICATIONS };
}

module.exports = { createIncidentLog, CLASSIFICATIONS, sanitizeText, taskFailureDetails };
