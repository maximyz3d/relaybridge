'use strict';

// Requirement evidence only. Workflow, task, receipt and incident stores remain
// authoritative for execution. This ledger stores references, never their bodies.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sanitizeText } = require('./incident-log');

const MILESTONES = Object.freeze(['planned', 'implemented', 'tested', 'approved', 'merged', 'deployed']);
const OUTCOMES = new Set(['confirmed', 'rejected', 'missing']);
const EVIDENCE_KINDS = new Set(['artifact', 'test', 'review', 'merge', 'deployment', 'incident', 'receipt']);
const CORRELATIONS = ['runId', 'taskId', 'incidentId', 'receiptId', 'invocationId', 'attemptId'];

function identifier(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,199}$/.test(value)
    || value.includes('..') || /(?:^|[/:])(?:sk[-_]|gh[pousr]_|github_pat_|Bearer)/i.test(value)
    || /^[A-Za-z]:\//.test(value)
    || /\b(?:bearer|token|authorization|api[-_]?key|secret|password)\s*[:=]/i.test(value)
    || /\b[A-Za-z0-9_-]*(?:sk|pat|ghp|gho|ghs|github_pat)[-_][A-Za-z0-9_-]{16,}\b/i.test(value)) throw new Error(`invalid ${field}`);
  return value;
}

function boundedText(value, field, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`invalid ${field}`);
  return sanitizeText(value, limit - 1);
}

function createRequestLedger(options = {}) {
  if (!options.dataDir) throw new Error('dataDir is required');
  const now = options.now || Date.now;
  function capacity(value, fallback, maximum) {
    if (value == null) return fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('capacity must be a positive integer within supported bounds');
    return value;
  }
  const maxRequests = capacity(options.maxRequests, 200, 1000);
  const maxEvents = capacity(options.maxEvents, 1000, 5000);
  const maxBytes = capacity(options.maxBytes, 32 * 1024 * 1024, 32 * 1024 * 1024);
  function timestamp(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid timestamp');
    return value;
  }
  function revisionId(value) {
    if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error('revision must be an immutable full commit or artifact digest');
    return value;
  }
  fs.mkdirSync(options.dataDir, { recursive: true });
  const file = path.join(options.dataDir, 'request-ledger.json');
  let state = { version: 1, requests: [] };

  function normalizeEvent(input) {
    const event = {
      eventId: identifier(input.eventId, 'eventId'),
      requirementId: identifier(input.requirementId, 'requirementId'),
      actor: identifier(input.actor, 'actor'),
      revision: revisionId(input.revision),
      milestone: input.milestone,
      outcome: input.outcome,
      evidence: [],
      reason: input.reason == null ? null : boundedText(input.reason, 'reason', 600),
      correlation: {},
    };
    if (!MILESTONES.includes(event.milestone) || !OUTCOMES.has(event.outcome)) throw new Error('invalid milestone or outcome');
    if (!Array.isArray(input.evidence) || input.evidence.length > 16) throw new Error('evidence must contain at most 16 references');
    event.evidence = input.evidence.map((item) => {
      if (!item || !EVIDENCE_KINDS.has(item.kind)) throw new Error('invalid evidence kind');
      if (item.digest != null && !/^[a-f0-9]{64}$/.test(item.digest)) throw new Error('invalid evidence digest');
      return { kind: item.kind, ref: identifier(item.ref, 'evidence ref'), digest: item.digest || null };
    });
    if (event.outcome === 'confirmed' && !event.evidence.length) throw new Error('confirmed milestones require evidence');
    if (event.outcome !== 'confirmed' && !event.reason) throw new Error('rejected or missing evidence requires a reason');
    for (const key of CORRELATIONS) {
      if (input.correlation?.[key] != null) event.correlation[key] = identifier(input.correlation[key], key);
    }
    return event;
  }

  // Corruption is visible and never overwritten with an apparently empty ledger.
  if (fs.existsSync(file)) {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('invalid file');
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (loaded?.version !== 1 || !Array.isArray(loaded.requests) || loaded.requests.length > maxRequests) throw new Error('invalid schema');
      const ids = new Set();
      for (const request of loaded.requests) {
        identifier(request.requestId, 'requestId');
        identifier(request.actor, 'actor');
        if (ids.has(request.requestId)) throw new Error('duplicate request');
        ids.add(request.requestId);
        request.requirements = validateRequirements(request.requirements);
        timestamp(request.createdAt);
        if (!Array.isArray(request.workflows) || request.workflows.length > 64
          || !Array.isArray(request.events) || request.events.length > maxEvents) throw new Error('invalid bounds');
        request.workflows = request.workflows.map((link) => ({ runId: identifier(link.runId, 'runId'),
          actor: identifier(link.actor, 'actor'), at: timestamp(link.at) }));
        if (new Set(request.workflows.map((link) => link.runId)).size !== request.workflows.length) throw new Error('duplicate workflow link');
        const eventIds = new Set();
        for (const event of request.events) {
          normalizeEvent(event);
          timestamp(event.recordedAt);
          if (eventIds.has(event.eventId) || !request.requirements.some((r) => r.requirementId === event.requirementId)) throw new Error('invalid event');
          eventIds.add(event.eventId);
        }
      }
      state = { version: 1, requests: loaded.requests.map((request) => ({ requestId: request.requestId, actor: request.actor,
        requirements: request.requirements, createdAt: request.createdAt, workflows: request.workflows,
        events: request.events.map((event) => ({ ...normalizeEvent(event), recordedAt: event.recordedAt })) })) };
    } catch { throw new Error('request ledger is corrupt, incompatible, or exceeds configured bounds; preserve it for repair'); }
  }

  function commit(next) {
    const serialized = JSON.stringify(next, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new Error('request ledger byte capacity reached; prior evidence was preserved');
    const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, serialized, { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, file);
      state = next; // Only publish after persistence succeeded.
    } finally { try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }

  function validateRequirements(input) {
    if (!Array.isArray(input) || !input.length || input.length > 64) throw new Error('requirements must contain 1-64 entries');
    const result = input.map((r) => ({ requirementId: identifier(r.requirementId, 'requirementId'), summary: boundedText(r.summary, 'summary', 600) }));
    if (new Set(result.map((r) => r.requirementId)).size !== result.length) throw new Error('duplicate requirementId');
    return result;
  }

  function requireRequest(data, requestId) {
    identifier(requestId, 'requestId');
    const request = data.requests.find((r) => r.requestId === requestId);
    if (!request) throw new Error('request not found');
    return request;
  }

  function create(input = {}) {
    const requestId = identifier(input.requestId, 'requestId');
    if (state.requests.some((r) => r.requestId === requestId)) throw new Error('request already exists');
    if (state.requests.length >= maxRequests) throw new Error('request ledger capacity reached; archive explicitly before adding requests');
    const request = { requestId, actor: identifier(input.actor, 'actor'), requirements: validateRequirements(input.requirements),
      createdAt: timestamp(now()), workflows: [], events: [] };
    const next = structuredClone(state);
    next.requests.push(request);
    commit(next);
    return structuredClone(request);
  }

  function linkWorkflow(requestId, input = {}) {
    const runId = identifier(input.runId, 'runId');
    const actor = identifier(input.actor, 'actor');
    const next = structuredClone(state);
    const request = requireRequest(next, requestId);
    const existing = request.workflows.find((link) => link.runId === runId);
    if (existing) return structuredClone(existing);
    if (request.workflows.length >= 64) throw new Error('workflow link capacity reached');
    const link = { runId, actor, at: timestamp(now()) };
    request.workflows.push(link);
    commit(next);
    return structuredClone(link);
  }

  function record(requestId, input = {}) {
    const event = normalizeEvent(input);
    const next = structuredClone(state);
    const request = requireRequest(next, requestId);
    if (!request.requirements.some((r) => r.requirementId === event.requirementId)) throw new Error('requirement not found');
    const existing = request.events.find((item) => item.eventId === event.eventId);
    if (existing) {
      if (JSON.stringify(normalizeEvent(existing)) !== JSON.stringify(event)) throw new Error('conflicting eventId');
      return structuredClone(existing);
    }
    if (request.events.length >= maxEvents) throw new Error('event capacity reached; evidence history was preserved');
    event.recordedAt = timestamp(now());
    request.events.push(event);
    commit(next);
    return structuredClone(event);
  }

  function get(requestId, { revision } = {}) {
    const request = structuredClone(requireRequest(state, requestId));
    if (revision != null) {
      revisionId(revision);
      request.coverage = request.requirements.map(({ requirementId }) => {
        const milestones = Object.fromEntries(MILESTONES.map((m) => [m, { outcome: 'unknown', eventId: null }]));
        for (const event of request.events) {
          if (event.requirementId === requirementId && event.revision === revision) {
            milestones[event.milestone] = { outcome: event.outcome, eventId: event.eventId };
          }
        }
        return { requirementId, revision, milestones };
      });
    }
    return request;
  }

  function forWorkflow(runId) {
    return state.requests.filter((r) => r.workflows.some((link) => link.runId === runId))
      .map((r) => ({ requestId: r.requestId, requirementIds: r.requirements.map((item) => item.requirementId) }));
  }

  return Object.freeze({ create, linkWorkflow, record, get, forWorkflow,
    list: () => state.requests.map((r) => ({ requestId: r.requestId, requirementCount: r.requirements.length, evidenceCount: r.events.length })) });
}

module.exports = { createRequestLedger, MILESTONES };
