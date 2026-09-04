'use strict';

// Durable state for the opinionated Codex -> Claude workflow. This module does
// not execute either provider. It records the handoff contract, enforces the
// phase gates, and guarantees that only one workflow can write a canonical
// workspace at a time.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const PHASES = Object.freeze([
  'scoping',
  'research_ready',
  'planning',
  'plan_ready',
  'implementing',
  'implementation_ready',
  'reviewing',
  'review_ready',
  'revising',
  'revision_ready',
  'final_reviewing',
  'complete',
  'failed',
  'cancelled',
]);
const TERMINAL_PHASES = Object.freeze(['complete', 'failed', 'cancelled']);
const WRITER_PHASES = Object.freeze(['implementing', 'revising']);
const TERMINAL_SET = new Set(TERMINAL_PHASES);
const WRITER_SET = new Set(WRITER_PHASES);
const PHASE_SET = new Set(PHASES);

const ARTIFACT_KINDS = Object.freeze([
  'objective',
  'constraints',
  'non-goals',
  'file-scope',
  'base-revision',
  'acceptance',
  'research',
  'plan',
  'implementation',
  'review',
  'revision',
  'final-review',
]);
const ARTIFACT_SET = new Set(ARTIFACT_KINDS);
const ARTIFACT_FILES = Object.freeze(Object.fromEntries(
  ARTIFACT_KINDS.map((kind) => [kind, `${kind}.md`]),
));
const DEFAULT_ARTIFACT_CAPS = Object.freeze({
  objective: 12000,
  constraints: 12000,
  'non-goals': 8000,
  'file-scope': 12000,
  'base-revision': 1024,
  acceptance: 12000,
  research: 24000,
  plan: 24000,
  implementation: 24000,
  review: 24000,
  revision: 24000,
  'final-review': 24000,
});
const DEFAULT_MAX_HISTORY = 100;
const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
const MAX_PROVIDER_RETRY_DELAY_MS = 4 * 60 * 60 * 1000;
const RUN_ID_RE = /^wf_[a-z0-9]+_[a-f0-9]{12}$/;
const ACTOR_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}$/;
const LEASE_TOKEN_RE = /^[a-f0-9]{64}$/;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const PROVIDER_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const FAILURE_CLASS_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const TASK_TIERS = Object.freeze(['deterministic', 'utility', 'standard', 'complex', 'critical']);
const PERMISSION_MODES = Object.freeze(['safe', 'full']);
const MODEL_TIERS = Object.freeze(['light', 'standard', 'heavy']);
const EFFORT_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const PROVIDER_PREFERENCE_KEYS = Object.freeze([
  'planning',
  'implementation',
  'review',
  'revision',
  'finalReview',
]);
const PROVIDER_TASK_PHASES = Object.freeze({
  planning: 'planning',
  reviewing: 'review',
  revising: 'revision',
  final_reviewing: 'final-review',
});
const RETRYABLE_PROVIDER_PHASES = Object.freeze(['planning', 'reviewing', 'final_reviewing']);
const RETRYABLE_PROVIDER_SET = new Set(RETRYABLE_PROVIDER_PHASES);

const TRANSITIONS = Object.freeze({
  scoping: Object.freeze(['research_ready', 'failed', 'cancelled']),
  research_ready: Object.freeze(['planning', 'failed', 'cancelled']),
  planning: Object.freeze(['plan_ready', 'failed', 'cancelled']),
  plan_ready: Object.freeze(['implementing', 'failed', 'cancelled']),
  implementing: Object.freeze(['implementation_ready', 'failed', 'cancelled']),
  implementation_ready: Object.freeze(['reviewing', 'failed', 'cancelled']),
  reviewing: Object.freeze(['review_ready', 'failed', 'cancelled']),
  review_ready: Object.freeze(['revising', 'final_reviewing', 'failed', 'cancelled']),
  revising: Object.freeze(['revision_ready', 'failed', 'cancelled']),
  revision_ready: Object.freeze(['reviewing', 'final_reviewing', 'failed', 'cancelled']),
  final_reviewing: Object.freeze(['complete', 'review_ready', 'failed', 'cancelled']),
  complete: Object.freeze([]),
  // Only retryFailedReadOnlyProviderTask may leave `failed`, and only after it
  // proves the last failed task belonged to one of these non-writer phases.
  failed: RETRYABLE_PROVIDER_PHASES,
  cancelled: Object.freeze([]),
});

class WorkflowPipelineError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'WorkflowPipelineError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new WorkflowPipelineError(code, message, details);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_ARGUMENT', `${label} must be an object`);
  }
}

function assertRunId(runId) {
  const value = String(runId || '');
  if (!RUN_ID_RE.test(value)) fail('INVALID_RUN_ID', 'invalid workflow run ID');
  return value;
}

function assertActor(actor, fallback) {
  const value = String(actor || fallback || '');
  if (!ACTOR_RE.test(value)) fail('INVALID_ACTOR', 'actor must be a short identifier');
  return value;
}

function assertLeaseToken(token) {
  const value = String(token || '');
  if (!LEASE_TOKEN_RE.test(value)) fail('INVALID_LEASE_TOKEN', 'invalid writer lease token');
  return value;
}

function enumValue(value, fallback, allowed, label) {
  const normalized = String(value == null ? fallback : value).toLowerCase();
  if (!allowed.includes(normalized)) {
    fail('INVALID_ARGUMENT', `${label} must be one of: ${allowed.join(', ')}`);
  }
  return normalized;
}

function assertTaskId(taskId) {
  const value = String(taskId || '');
  if (!TASK_ID_RE.test(value)) fail('INVALID_PROVIDER_TASK', 'taskId must be a short opaque identifier');
  return value;
}

function assertProvider(provider) {
  const value = String(provider || '');
  if (!PROVIDER_RE.test(value)) {
    fail('INVALID_PROVIDER_TASK', 'provider must be a lowercase provider identifier');
  }
  return value;
}

function normalizeProviderPreferences(value) {
  if (value == null) return Object.fromEntries(PROVIDER_PREFERENCE_KEYS.map((key) => [key, []]));
  assertPlainObject(value, 'providerPreferences');
  const unknown = Object.keys(value).filter((key) => !PROVIDER_PREFERENCE_KEYS.includes(key));
  if (unknown.length) fail('INVALID_ARGUMENT', `unknown provider preference: ${unknown[0]}`);
  const normalized = {};
  for (const key of PROVIDER_PREFERENCE_KEYS) {
    const providers = value[key] == null ? [] : value[key];
    if (!Array.isArray(providers) || providers.length > 16) {
      fail('INVALID_ARGUMENT', `providerPreferences.${key} must be an array of at most 16 providers`);
    }
    normalized[key] = [...new Set(providers.map(assertProvider))];
  }
  return normalized;
}

function normalizedMarkdown(value, label, { required = true } = {}) {
  let text;
  if (Array.isArray(value)) {
    text = value.map((item) => {
      if (typeof item !== 'string') fail('INVALID_ARTIFACT', `${label} entries must be strings`);
      return `- ${item}`;
    }).join('\n');
  } else if (typeof value === 'string') {
    text = value;
  } else if (value == null && !required) {
    text = '';
  } else {
    fail('INVALID_ARTIFACT', `${label} must be Markdown text or an array of strings`);
  }
  if (text.includes('\0')) fail('INVALID_ARTIFACT', `${label} must not contain NUL bytes`);
  text = text.replace(/\r\n?/g, '\n');
  if (required && !text.trim()) fail('INVALID_ARTIFACT', `${label} must not be empty`);
  return text;
}

function boundedMarkdown(value, maxChars) {
  if (value.length <= maxChars) {
    return { content: value, originalChars: value.length, storedChars: value.length, truncated: false };
  }

  let marker = '';
  let available = maxChars;
  // The omitted count appears in the marker, so iterate until its digit count
  // stabilizes. Keep both the opening context and the final conclusions.
  for (let i = 0; i < 4; i += 1) {
    const omitted = Math.max(0, value.length - available);
    marker = `\n\n<!-- RelayBridge truncated ${omitted} characters -->\n\n`;
    available = Math.max(0, maxChars - marker.length);
  }
  if (available === 0) {
    const content = marker.slice(0, maxChars);
    return { content, originalChars: value.length, storedChars: content.length, truncated: true };
  }
  const headChars = Math.ceil(available * 2 / 3);
  const tailChars = available - headChars;
  const omitted = value.length - headChars - tailChars;
  marker = `\n\n<!-- RelayBridge truncated ${omitted} characters -->\n\n`;
  // Rebalance once if the final omitted count changed the marker width.
  const finalAvailable = Math.max(0, maxChars - marker.length);
  const finalHead = Math.ceil(finalAvailable * 2 / 3);
  const finalTail = finalAvailable - finalHead;
  const content = value.slice(0, finalHead) + marker + (finalTail ? value.slice(-finalTail) : '');
  return { content, originalChars: value.length, storedChars: content.length, truncated: true };
}

function ensureInteger(value, label, { min, max }) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    fail('INVALID_ARGUMENT', `${label} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function isContained(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync is unsupported on some Windows filesystems. The file was
    // still fully written and renamed atomically.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function atomicWriteFile(filePath, content) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
    fsyncDirectory(directory);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
  }
}

function atomicWriteJson(filePath, value) {
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createExclusiveJson(filePath, value) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // A hard link is an atomic no-overwrite publish: only one contender can
    // give the complete temporary file the canonical lock name.
    fs.linkSync(tempPath, filePath);
    fsyncDirectory(directory);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
  }
}

function createWorkflowPipeline(options = {}) {
  assertPlainObject(options, 'options');
  if (typeof options.dataDir !== 'string' || !options.dataDir.trim() || options.dataDir.includes('\0')) {
    fail('INVALID_ARGUMENT', 'dataDir must be a non-empty path');
  }

  const now = options.now || Date.now;
  if (typeof now !== 'function') fail('INVALID_ARGUMENT', 'now must be a function');
  const currentTime = () => {
    const value = Number(now());
    if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_CLOCK', 'clock returned an invalid timestamp');
    return value;
  };

  const requestedDataDir = path.resolve(options.dataDir);
  fs.mkdirSync(requestedDataDir, { recursive: true, mode: 0o700 });
  const dataDir = fs.realpathSync(requestedDataDir);
  const workflowsDir = path.join(dataDir, 'workflows');
  const locksDir = path.join(dataDir, 'writer-locks');
  fs.mkdirSync(workflowsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
  const workflowsReal = fs.realpathSync(workflowsDir);
  const locksReal = fs.realpathSync(locksDir);

  const maxHistoryEntries = options.maxHistoryEntries == null
    ? DEFAULT_MAX_HISTORY
    : ensureInteger(options.maxHistoryEntries, 'maxHistoryEntries', { min: 1, max: 1000 });
  const defaultLeaseMs = options.leaseMs == null
    ? DEFAULT_LEASE_MS
    : ensureInteger(options.leaseMs, 'leaseMs', { min: 1, max: MAX_LEASE_MS });

  const artifactCaps = { ...DEFAULT_ARTIFACT_CAPS };
  if (options.maxArtifactChars != null) {
    const cap = ensureInteger(options.maxArtifactChars, 'maxArtifactChars', { min: 64, max: 1000000 });
    for (const kind of ARTIFACT_KINDS) artifactCaps[kind] = cap;
  }
  if (options.artifactCaps != null) {
    assertPlainObject(options.artifactCaps, 'artifactCaps');
    for (const [kind, cap] of Object.entries(options.artifactCaps)) {
      if (!ARTIFACT_SET.has(kind)) fail('INVALID_ARTIFACT_KIND', `unknown artifact kind: ${kind}`);
      artifactCaps[kind] = ensureInteger(cap, `artifactCaps.${kind}`, { min: 64, max: 1000000 });
    }
  }

  function safeDirectory(candidate, baseReal, { create = false } = {}) {
    const resolved = path.resolve(candidate);
    if (!isContained(baseReal, resolved)) fail('PATH_ESCAPE', 'resolved storage path escaped its root');
    if (create) fs.mkdirSync(resolved, { recursive: false, mode: 0o700 });
    let stat;
    try { stat = fs.lstatSync(resolved); }
    catch (error) { fail('NOT_FOUND', `storage directory is unavailable: ${error.code || error.message}`); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('PATH_ESCAPE', 'storage directory must not be a symlink');
    const real = fs.realpathSync(resolved);
    if (!isContained(baseReal, real)) fail('PATH_ESCAPE', 'storage directory escaped its root');
    return resolved;
  }

  function workflowDirectory(runId, { create = false } = {}) {
    const id = assertRunId(runId);
    const candidate = path.join(workflowsDir, id);
    if (!isContained(workflowsDir, candidate)) fail('PATH_ESCAPE', 'workflow path escaped its root');
    return safeDirectory(candidate, workflowsReal, { create });
  }

  function artifactsDirectory(runId, { create = false } = {}) {
    const workflowDir = workflowDirectory(runId);
    const candidate = path.join(workflowDir, 'artifacts');
    if (create) fs.mkdirSync(candidate, { recursive: false, mode: 0o700 });
    return safeDirectory(candidate, fs.realpathSync(workflowDir));
  }

  function statePath(runId) {
    const candidate = path.join(workflowDirectory(runId), 'state.json');
    if (!isContained(workflowsReal, candidate)) fail('PATH_ESCAPE', 'workflow state path escaped its root');
    return candidate;
  }

  function artifactPath(runId, kind) {
    if (!ARTIFACT_SET.has(kind)) fail('INVALID_ARTIFACT_KIND', `unknown artifact kind: ${kind}`);
    const directory = artifactsDirectory(runId);
    const candidate = path.join(directory, ARTIFACT_FILES[kind]);
    if (!isContained(fs.realpathSync(directory), candidate)) fail('PATH_ESCAPE', 'artifact path escaped its root');
    return candidate;
  }

  function canonicalizeCwd(cwd) {
    if (typeof cwd !== 'string' || !cwd.trim() || cwd.includes('\0') || !path.isAbsolute(cwd)) {
      fail('INVALID_CWD', 'cwd must be an existing absolute directory');
    }
    let real;
    let stat;
    try {
      real = fs.realpathSync(cwd);
      stat = fs.statSync(real);
    } catch (error) {
      fail('INVALID_CWD', `cwd is unavailable: ${error.code || error.message}`);
    }
    if (!stat.isDirectory()) fail('INVALID_CWD', 'cwd must be a directory');
    return process.platform === 'win32' ? path.normalize(real).toLowerCase() : path.normalize(real);
  }

  function validateState(state, expectedRunId) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) fail('STATE_CORRUPT', 'workflow state is not an object');
    if (state.schemaVersion !== SCHEMA_VERSION) fail('STATE_CORRUPT', 'unsupported workflow state schema');
    if (state.runId !== expectedRunId || !RUN_ID_RE.test(state.runId)) fail('STATE_CORRUPT', 'workflow state identity mismatch');
    if (!PHASE_SET.has(state.phase)) fail('STATE_CORRUPT', 'workflow state contains an invalid phase');
    if (!path.isAbsolute(state.cwd) || state.cwd.includes('\0')) fail('STATE_CORRUPT', 'workflow state contains an invalid cwd');
    if (!state.artifacts || typeof state.artifacts !== 'object') fail('STATE_CORRUPT', 'workflow artifact index is missing');
    if (!Array.isArray(state.history)) fail('STATE_CORRUPT', 'workflow history is missing');
    if (!TASK_TIERS.includes(state.taskTier) || !PERMISSION_MODES.includes(state.permissionMode)) {
      fail('STATE_CORRUPT', 'workflow routing policy is invalid');
    }
    if (!state.providerPreferences || typeof state.providerPreferences !== 'object'
      || PROVIDER_PREFERENCE_KEYS.some((key) => !Array.isArray(state.providerPreferences[key])
        || state.providerPreferences[key].some((provider) => !PROVIDER_RE.test(String(provider))))) {
      fail('STATE_CORRUPT', 'workflow provider preferences are invalid');
    }
    if (!Array.isArray(state.providerTaskHistory)) fail('STATE_CORRUPT', 'provider task history is missing');
    if (state.providerTask != null && (!state.providerTask || typeof state.providerTask !== 'object'
      || !TASK_ID_RE.test(String(state.providerTask.taskId || ''))
      || !PROVIDER_RE.test(String(state.providerTask.provider || ''))
      || !ACTOR_RE.test(String(state.providerTask.actor || '')))) {
      fail('STATE_CORRUPT', 'current provider task is invalid');
    }
    if (state.providerRetry != null && (!state.providerRetry || typeof state.providerRetry !== 'object'
      || !RETRYABLE_PROVIDER_SET.has(state.providerRetry.phase)
      || state.providerRetry.phase !== state.phase
      || state.providerRetry.purpose !== PROVIDER_TASK_PHASES[state.providerRetry.phase]
      || !PROVIDER_RE.test(String(state.providerRetry.failedProvider || ''))
      || !FAILURE_CLASS_RE.test(String(state.providerRetry.failureClass || ''))
      || !Number.isSafeInteger(state.providerRetry.previousAttempt) || state.providerRetry.previousAttempt < 1
      || !Number.isSafeInteger(state.providerRetry.nextAttempt) || state.providerRetry.nextAttempt < 2
      || state.providerRetry.nextAttempt !== state.providerRetry.previousAttempt + 1
      || !Number.isSafeInteger(state.providerRetry.maxAttempts)
      || state.providerRetry.maxAttempts < state.providerRetry.nextAttempt
      || !Number.isSafeInteger(state.providerRetry.scheduledAt) || state.providerRetry.scheduledAt < 0
      || !Number.isSafeInteger(state.providerRetry.retryAt) || state.providerRetry.retryAt < 0
      || state.providerRetry.retryAt < state.providerRetry.scheduledAt
      || !TASK_ID_RE.test(String(state.providerRetry.failedTaskId || ''))
      || state.providerTask != null)) {
      fail('STATE_CORRUPT', 'provider retry state is invalid');
    }
    return state;
  }

  function readState(runId) {
    const id = assertRunId(runId);
    // statePath() deliberately requires a real, non-symlink workflow
    // directory. Check the lexical location first so get() can still return
    // null for a well-formed ID that has never existed.
    const directory = path.join(workflowsDir, id);
    if (!fs.existsSync(directory)) return null;
    let raw;
    try {
      const filePath = statePath(id);
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) fail('PATH_ESCAPE', 'workflow state must be a regular file');
      raw = fs.readFileSync(filePath, 'utf8');
    }
    catch (error) {
      if (error instanceof WorkflowPipelineError) throw error;
      if (error.code === 'ENOENT') return null;
      fail('STATE_READ_FAILED', `could not read workflow state: ${error.code || error.message}`);
    }
    try { return validateState(JSON.parse(raw), id); }
    catch (error) {
      if (error instanceof WorkflowPipelineError) throw error;
      fail('STATE_CORRUPT', 'workflow state is not valid JSON');
    }
  }

  function requireState(runId) {
    const state = readState(runId);
    if (!state) fail('WORKFLOW_NOT_FOUND', 'workflow was not found');
    return state;
  }

  function addHistory(state, { event, from = state.phase, to = state.phase, actor, detail = null }) {
    state.eventSequence = Number(state.eventSequence || 0) + 1;
    const entry = {
      sequence: state.eventSequence,
      at: currentTime(),
      event,
      from,
      to,
      actor,
      ...(detail ? { detail } : {}),
    };
    state.history.push(entry);
    if (state.history.length > maxHistoryEntries) {
      const dropCount = state.history.length - maxHistoryEntries;
      state.history.splice(0, dropCount);
      state.historyDropped = Number(state.historyDropped || 0) + dropCount;
    }
  }

  function persistState(state) {
    state.revision = Number(state.revision || 0) + 1;
    state.updatedAt = currentTime();
    atomicWriteJson(statePath(state.runId), state);
    return clone(state);
  }

  function requirePhase(state, expected, action) {
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (!allowed.includes(state.phase)) {
      fail('INVALID_TRANSITION', `${action} requires phase ${allowed.join(' or ')}, not ${state.phase}`, {
        runId: state.runId,
        phase: state.phase,
        expected: allowed,
      });
    }
    if (TERMINAL_SET.has(state.phase)) fail('WORKFLOW_TERMINAL', 'terminal workflows cannot transition');
  }

  function transition(state, to, event, actor, detail = null) {
    const from = state.phase;
    if (!TRANSITIONS[from]?.includes(to)) fail('INVALID_TRANSITION', `transition ${from} -> ${to} is not allowed`);
    state.phase = to;
    addHistory(state, { event, from, to, actor, detail });
    return persistState(state);
  }

  function writeArtifact(runId, kind, markdown) {
    const bounded = boundedMarkdown(markdown, artifactCaps[kind]);
    atomicWriteFile(artifactPath(runId, kind), bounded.content);
    return {
      kind,
      file: `artifacts/${ARTIFACT_FILES[kind]}`,
      sha256: sha256(bounded.content),
      originalChars: bounded.originalChars,
      storedChars: bounded.storedChars,
      truncated: bounded.truncated,
      updatedAt: currentTime(),
    };
  }

  function installArtifact(state, kind, markdown) {
    const previous = state.artifacts[kind] || null;
    const record = writeArtifact(state.runId, kind, markdown);
    state.artifacts[kind] = record;
    state.artifactSequence = Number(state.artifactSequence || 0) + 1;
    state.artifactHistory = Array.isArray(state.artifactHistory) ? state.artifactHistory : [];
    state.artifactHistory.push({
      sequence: state.artifactSequence,
      at: record.updatedAt,
      kind,
      sha256: record.sha256,
      replacedSha256: previous?.sha256 || null,
      truncated: record.truncated,
    });
    if (state.artifactHistory.length > maxHistoryEntries) {
      const dropCount = state.artifactHistory.length - maxHistoryEntries;
      state.artifactHistory.splice(0, dropCount);
      state.artifactHistoryDropped = Number(state.artifactHistoryDropped || 0) + dropCount;
    }
    return record;
  }

  function archiveProviderTask(state, outcome, actor, { requireActor = true } = {}) {
    const task = state.providerTask;
    if (!task) return null;
    if (requireActor && task.actor !== actor) {
      fail('PROVIDER_TASK_MISMATCH', 'completion actor does not own the current provider task');
    }
    const archived = {
      ...task,
      outcome,
      finishedAt: currentTime(),
      finishedBy: actor,
    };
    state.providerTaskHistory.push(archived);
    if (state.providerTaskHistory.length > maxHistoryEntries) {
      const dropCount = state.providerTaskHistory.length - maxHistoryEntries;
      state.providerTaskHistory.splice(0, dropCount);
      state.providerTaskHistoryDropped = Number(state.providerTaskHistoryDropped || 0) + dropCount;
    }
    state.providerTask = null;
    return archived;
  }

  function lockIdentity(cwd) {
    const cwdSha256 = sha256(cwd);
    const filePath = path.join(locksDir, `${cwdSha256}.json`);
    if (!isContained(locksReal, filePath)) fail('PATH_ESCAPE', 'writer lock path escaped its root');
    return { cwdSha256, filePath };
  }

  function parseLock(filePath, expectedCwd) {
    let lock;
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        fail('LOCK_CORRUPT', 'writer lock must be a regular file and will not be reclaimed');
      }
      lock = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    catch (error) {
      if (error instanceof WorkflowPipelineError) throw error;
      fail('LOCK_CORRUPT', `writer lock is unreadable and will not be reclaimed: ${error.code || error.message}`);
    }
    if (!lock || lock.schemaVersion !== SCHEMA_VERSION || !RUN_ID_RE.test(String(lock.runId || ''))
      || !ACTOR_RE.test(String(lock.actor || '')) || !LEASE_TOKEN_RE.test(String(lock.leaseToken || ''))
      || !Number.isSafeInteger(lock.expiresAt) || !Number.isSafeInteger(lock.acquiredAt)
      || lock.cwd !== expectedCwd || lock.cwdSha256 !== sha256(expectedCwd)) {
      fail('LOCK_CORRUPT', 'writer lock failed validation and will not be reclaimed');
    }
    return lock;
  }

  function acquireWriterLease(state, actor, requestedLeaseMs) {
    if (canonicalizeCwd(state.cwd) !== state.cwd) {
      fail('CWD_IDENTITY_CHANGED', 'workflow cwd no longer resolves to its original canonical directory');
    }
    const leaseMs = requestedLeaseMs == null
      ? defaultLeaseMs
      : ensureInteger(requestedLeaseMs, 'leaseMs', { min: 1, max: MAX_LEASE_MS });
    const { cwdSha256, filePath } = lockIdentity(state.cwd);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const acquiredAt = currentTime();
      const leaseToken = crypto.randomBytes(32).toString('hex');
      const lock = {
        schemaVersion: SCHEMA_VERSION,
        cwd: state.cwd,
        cwdSha256,
        runId: state.runId,
        actor,
        leaseToken,
        acquiredAt,
        expiresAt: acquiredAt + leaseMs,
      };
      try {
        createExclusiveJson(filePath, lock);
        return lock;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = parseLock(filePath, state.cwd);
        if (existing.expiresAt > currentTime()) {
          fail('WRITER_CONFLICT', 'another workflow holds the writer lease for this workspace', {
            cwd: state.cwd,
            runId: existing.runId,
            actor: existing.actor,
            expiresAt: existing.expiresAt,
          });
        }
        // Re-read immediately before removal. A changed token means another
        // contender already reclaimed the expired lock; retry without touching
        // its new lease.
        const latest = parseLock(filePath, state.cwd);
        if (latest.leaseToken !== existing.leaseToken || latest.expiresAt !== existing.expiresAt) continue;
        try { fs.unlinkSync(filePath); }
        catch (unlinkError) {
          if (unlinkError.code === 'ENOENT') continue;
          throw unlinkError;
        }
      }
    }
    fail('WRITER_CONFLICT', 'writer lease changed repeatedly during acquisition');
  }

  function validateWriterLease(state, actor, leaseToken, { allowExpired = false } = {}) {
    if (!WRITER_SET.has(state.phase)) fail('LEASE_NOT_REQUIRED', 'this phase does not hold a writer lease');
    const token = assertLeaseToken(leaseToken);
    const { filePath } = lockIdentity(state.cwd);
    if (!fs.existsSync(filePath)) fail('LEASE_MISSING', 'writer lease file is missing');
    const lock = parseLock(filePath, state.cwd);
    const tokenHash = sha256(token);
    if (lock.runId !== state.runId || lock.actor !== actor || lock.leaseToken !== token
      || state.writerLease?.leaseTokenSha256 !== tokenHash || state.writerLease?.actor !== actor) {
      fail('LEASE_MISMATCH', 'writer lease token, actor, or workflow does not match');
    }
    if (!allowExpired && lock.expiresAt <= currentTime()) fail('LEASE_EXPIRED', 'writer lease has expired');
    return { lock, filePath };
  }

  function releaseWriterLease(state, actor, leaseToken, { allowExpired = false } = {}) {
    const validated = validateWriterLease(state, actor, leaseToken, { allowExpired });
    // Validate a second time immediately before unlinking so an intervening
    // replacement is never released by an old token.
    const latest = parseLock(validated.filePath, state.cwd);
    if (latest.leaseToken !== validated.lock.leaseToken || latest.runId !== state.runId) {
      fail('LEASE_MISMATCH', 'writer lease changed before release');
    }
    try { fs.unlinkSync(validated.filePath); }
    catch (error) {
      if (error.code === 'ENOENT') fail('LEASE_MISSING', 'writer lease disappeared before release');
      throw error;
    }
    fsyncDirectory(locksDir);
  }

  function beginWriterPhase(runId, expectedPhase, targetPhase, event, input, fallbackActor) {
    assertPlainObject(input, 'writer phase options');
    const state = requireState(runId);
    requirePhase(state, expectedPhase, event);
    const actor = assertActor(input.actor, fallbackActor);
    const lock = acquireWriterLease(state, actor, input.leaseMs);
    state.writerLease = {
      actor,
      acquiredAt: lock.acquiredAt,
      expiresAt: lock.expiresAt,
      cwdSha256: lock.cwdSha256,
      leaseTokenSha256: sha256(lock.leaseToken),
    };
    try {
      const workflow = transition(state, targetPhase, event, actor, { expiresAt: lock.expiresAt });
      return {
        workflow,
        lease: { actor, leaseToken: lock.leaseToken, acquiredAt: lock.acquiredAt, expiresAt: lock.expiresAt },
      };
    } catch (error) {
      try {
        const latest = parseLock(lockIdentity(state.cwd).filePath, state.cwd);
        if (latest.leaseToken === lock.leaseToken) fs.unlinkSync(lockIdentity(state.cwd).filePath);
      } catch {}
      throw error;
    }
  }

  function finishWriterPhase(
    runId,
    expectedPhase,
    targetPhase,
    event,
    artifactKind,
    input,
    fallbackActor,
    beforeTransition = null,
  ) {
    assertPlainObject(input, 'writer completion');
    const state = requireState(runId);
    requirePhase(state, expectedPhase, event);
    const actor = assertActor(input.actor, fallbackActor);
    const token = assertLeaseToken(input.leaseToken);
    validateWriterLease(state, actor, token);
    const markdown = normalizedMarkdown(input.markdown, artifactKind);
    archiveProviderTask(state, 'completed', actor);
    const artifact = installArtifact(state, artifactKind, markdown);
    const extraDetail = beforeTransition ? beforeTransition(state, actor) : null;
    const writerState = clone(state);
    state.writerLease = null;
    const result = transition(state, targetPhase, event, actor, {
      artifactSha256: artifact.sha256,
      ...(extraDetail || {}),
    });
    // Completion already proved the lease live before writing state. Crossing
    // the expiry boundary during the atomic writes must not strand that lock.
    releaseWriterLease(writerState, actor, token, { allowExpired: true });
    return result;
  }

  function createWorkflow(input) {
    assertPlainObject(input, 'workflow');
    const actor = assertActor(input.actor, 'codex');
    const cwd = canonicalizeCwd(input.cwd);
    const requestedId = input.runId == null ? null : assertRunId(input.runId);
    let runId = requestedId;
    let directory;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      runId = runId || `wf_${currentTime().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
      try {
        directory = workflowDirectory(runId, { create: true });
        break;
      } catch (error) {
        if (error.code !== 'EEXIST' && !String(error.message).includes('EEXIST')) throw error;
        if (requestedId) fail('WORKFLOW_EXISTS', 'workflow run ID already exists');
        runId = null;
      }
    }
    if (!directory) fail('ID_COLLISION', 'could not allocate a unique workflow run ID');

    try {
      fs.mkdirSync(path.join(directory, 'artifacts'), { recursive: false, mode: 0o700 });
      safeDirectory(path.join(directory, 'artifacts'), fs.realpathSync(directory));
      const createdAt = currentTime();
      const state = {
        schemaVersion: SCHEMA_VERSION,
        runId,
        cwd,
        phase: 'scoping',
        revision: 0,
        eventSequence: 0,
        artifactSequence: 0,
        createdAt,
        updatedAt: createdAt,
        createdBy: actor,
        taskTier: enumValue(input.taskTier, 'standard', TASK_TIERS, 'taskTier'),
        permissionMode: enumValue(input.permissionMode, 'safe', PERMISSION_MODES, 'permissionMode'),
        providerPreferences: normalizeProviderPreferences(input.providerPreferences),
        reviewCycle: 0,
        revisionCycle: 0,
        revisionRequested: false,
        writerLease: null,
        providerTask: null,
        providerRetry: null,
        providerTaskHistory: [],
        providerTaskHistoryDropped: 0,
        terminal: null,
        artifacts: {},
        artifactHistory: [],
        artifactHistoryDropped: 0,
        history: [],
        historyDropped: 0,
      };
      const scope = {
        objective: normalizedMarkdown(input.objective, 'objective'),
        constraints: normalizedMarkdown(input.constraints, 'constraints', { required: false }),
        'non-goals': normalizedMarkdown(input.nonGoals, 'nonGoals', { required: false }),
        'file-scope': normalizedMarkdown(input.fileScope, 'fileScope', { required: false }),
        'base-revision': normalizedMarkdown(input.baseRevision, 'baseRevision', { required: false }),
        acceptance: normalizedMarkdown(input.acceptance, 'acceptance'),
      };
      for (const [kind, markdown] of Object.entries(scope)) installArtifact(state, kind, markdown);
      addHistory(state, { event: 'workflow_created', from: null, to: 'scoping', actor });
      return persistState(state);
    } catch (error) {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
      throw error;
    }
  }

  function updateScope(runId, input) {
    assertPlainObject(input, 'scope update');
    const state = requireState(runId);
    requirePhase(state, 'scoping', 'updateScope');
    const actor = assertActor(input.actor, 'codex');
    const supplied = [
      ['objective', 'objective', true],
      ['constraints', 'constraints', false],
      ['nonGoals', 'non-goals', false],
      ['fileScope', 'file-scope', false],
      ['baseRevision', 'base-revision', false],
      ['acceptance', 'acceptance', true],
    ].filter(([field]) => Object.prototype.hasOwnProperty.call(input, field));
    if (!supplied.length) fail('INVALID_ARGUMENT', 'scope update did not include any scope fields');
    const hashes = {};
    for (const [field, kind, required] of supplied) {
      const artifact = installArtifact(
        state,
        kind,
        normalizedMarkdown(input[field], field, { required }),
      );
      hashes[kind] = artifact.sha256;
    }
    addHistory(state, { event: 'scope_updated', actor, detail: { artifactSha256: hashes } });
    return persistState(state);
  }

  function completeResearch(runId, input) {
    assertPlainObject(input, 'research completion');
    const state = requireState(runId);
    requirePhase(state, 'scoping', 'completeResearch');
    const actor = assertActor(input.actor, 'codex');
    const artifact = installArtifact(state, 'research', normalizedMarkdown(input.markdown, 'research'));
    return transition(state, 'research_ready', 'research_completed', actor, { artifactSha256: artifact.sha256 });
  }

  function startPlanning(runId, input = {}) {
    assertPlainObject(input, 'planning options');
    const state = requireState(runId);
    requirePhase(state, 'research_ready', 'startPlanning');
    return transition(state, 'planning', 'planning_started', assertActor(input.actor, 'claude-planner'));
  }

  function completePlanning(runId, input) {
    assertPlainObject(input, 'planning completion');
    const state = requireState(runId);
    requirePhase(state, 'planning', 'completePlanning');
    const actor = assertActor(input.actor, 'claude-planner');
    const markdown = normalizedMarkdown(input.markdown, 'plan');
    archiveProviderTask(state, 'completed', actor);
    const artifact = installArtifact(state, 'plan', markdown);
    return transition(state, 'plan_ready', 'planning_completed', actor, { artifactSha256: artifact.sha256 });
  }

  function startImplementation(runId, input = {}) {
    return beginWriterPhase(runId, 'plan_ready', 'implementing', 'implementation_started', input, 'codex');
  }

  function completeImplementation(runId, input) {
    return finishWriterPhase(
      runId, 'implementing', 'implementation_ready', 'implementation_completed', 'implementation', input, 'codex',
    );
  }

  function startReview(runId, input = {}) {
    assertPlainObject(input, 'review options');
    const state = requireState(runId);
    requirePhase(state, 'implementation_ready', 'startReview');
    return transition(state, 'reviewing', 'review_started', assertActor(input.actor, 'claude-reviewer'));
  }

  function completeReview(runId, input) {
    assertPlainObject(input, 'review completion');
    if (typeof input.revisionRequested !== 'boolean') {
      fail('INVALID_ARGUMENT', 'revisionRequested must be boolean');
    }
    const state = requireState(runId);
    requirePhase(state, 'reviewing', 'completeReview');
    const actor = assertActor(input.actor, 'claude-reviewer');
    const markdown = normalizedMarkdown(input.markdown, 'review');
    archiveProviderTask(state, 'completed', actor);
    const artifact = installArtifact(state, 'review', markdown);
    state.reviewCycle = Number(state.reviewCycle || 0) + 1;
    state.revisionRequested = input.revisionRequested;
    return transition(state, 'review_ready', 'review_completed', actor, {
      artifactSha256: artifact.sha256,
      revisionRequested: input.revisionRequested,
      reviewCycle: state.reviewCycle,
    });
  }

  function startRevision(runId, input = {}) {
    const state = requireState(runId);
    requirePhase(state, 'review_ready', 'startRevision');
    if (state.revisionRequested !== true) {
      fail('REVISION_NOT_REQUESTED', 'revision can start only when the review requested changes');
    }
    return beginWriterPhase(runId, 'review_ready', 'revising', 'revision_started', input, 'codex');
  }

  function completeRevision(runId, input) {
    return finishWriterPhase(
      runId, 'revising', 'revision_ready', 'revision_completed', 'revision', input, 'codex',
      (state) => {
        state.revisionCycle = Number(state.revisionCycle || 0) + 1;
        state.revisionRequested = false;
        return { revisionCycle: state.revisionCycle };
      },
    );
  }

  function requestAdditionalReview(runId, input = {}) {
    assertPlainObject(input, 'additional review request');
    const state = requireState(runId);
    requirePhase(state, 'revision_ready', 'requestAdditionalReview');
    const actor = assertActor(input.actor, 'codex');
    const reason = normalizedMarkdown(input.reason || 'Additional review requested.', 'reason');
    return transition(state, 'reviewing', 'additional_review_requested', actor, {
      reason: reason.slice(0, 2000),
    });
  }

  function startFinalReview(runId, input = {}) {
    assertPlainObject(input, 'final review options');
    const state = requireState(runId);
    requirePhase(state, ['review_ready', 'revision_ready'], 'startFinalReview');
    if (state.phase === 'review_ready' && state.revisionRequested !== false) {
      fail('REVISION_REQUIRED', 'final review cannot start while changes are requested');
    }
    return transition(state, 'final_reviewing', 'final_review_started', assertActor(input.actor, 'claude-final-reviewer'));
  }

  function completeFinalReview(runId, input) {
    assertPlainObject(input, 'final review completion');
    if (typeof input.approved !== 'boolean') fail('INVALID_ARGUMENT', 'approved must be boolean');
    const state = requireState(runId);
    requirePhase(state, 'final_reviewing', 'completeFinalReview');
    const actor = assertActor(input.actor, 'claude-final-reviewer');
    const markdown = normalizedMarkdown(input.markdown, 'finalReview');
    archiveProviderTask(state, 'completed', actor);
    const artifact = installArtifact(state, 'final-review', markdown);
    if (input.approved) {
      state.revisionRequested = false;
      state.terminal = { status: 'complete', at: currentTime(), actor };
      return transition(state, 'complete', 'final_review_approved', actor, { artifactSha256: artifact.sha256 });
    }
    state.revisionRequested = true;
    return transition(state, 'review_ready', 'final_review_requested_revision', actor, {
      artifactSha256: artifact.sha256,
      revisionRequested: true,
    });
  }

  function bindProviderTask(runId, input) {
    assertPlainObject(input, 'provider task');
    const state = requireState(runId);
    const expectedPurpose = PROVIDER_TASK_PHASES[state.phase];
    if (!expectedPurpose) {
      fail('INVALID_TRANSITION', 'provider tasks can be bound only while planning, reviewing, revising, or final reviewing');
    }
    const actor = assertActor(input.actor);
    const taskId = assertTaskId(input.taskId);
    const provider = assertProvider(input.provider);
    const purpose = String(input.purpose || '');
    if (purpose !== expectedPurpose) {
      fail('INVALID_PROVIDER_TASK', `purpose must be ${expectedPurpose} during ${state.phase}`);
    }
    const modelTier = input.modelTier == null
      ? null
      : enumValue(input.modelTier, null, MODEL_TIERS, 'modelTier');
    const effort = input.effort == null
      ? null
      : enumValue(input.effort, null, EFFORT_LEVELS, 'effort');
    const attempt = input.attempt == null
      ? 1
      : ensureInteger(input.attempt, 'attempt', { min: 1, max: 100 });

    if (state.phase === 'revising' && state.writerLease?.actor !== actor) {
      fail('PROVIDER_TASK_MISMATCH', 'revision task actor must own the writer lease');
    }
    if (state.providerTask) {
      fail('PROVIDER_TASK_ACTIVE', 'a provider task is already bound to this workflow');
    }
    if (state.providerTaskHistory.some((task) => task.taskId === taskId && task.provider === provider)) {
      fail('PROVIDER_TASK_REUSED', 'that provider task has already been archived for this workflow');
    }
    if (state.providerRetry) {
      if (state.providerRetry.phase !== state.phase || state.providerRetry.purpose !== purpose
        || state.providerRetry.nextAttempt !== attempt) {
        fail('PROVIDER_RETRY_MISMATCH', 'provider retry attempt does not match the scheduled retry');
      }
      state.providerRetry = null;
    }

    state.providerTask = {
      actor,
      taskId,
      provider,
      modelTier,
      effort,
      attempt,
      purpose,
      phase: state.phase,
      boundAt: currentTime(),
    };
    addHistory(state, {
      event: 'provider_task_bound',
      actor,
      detail: { taskId, provider, purpose, attempt },
    });
    return persistState(state);
  }

  function providerRetryRecord(state, task, input) {
    if (!Number.isSafeInteger(task.attempt) || task.attempt < 1) {
      fail('PROVIDER_RETRY_NOT_ALLOWED', 'provider task has no valid attempt number');
    }
    const maxAttempts = ensureInteger(input.maxAttempts, 'maxAttempts', { min: 2, max: 100 });
    if (task.attempt >= maxAttempts) {
      fail('PROVIDER_RETRY_EXHAUSTED', `provider retry limit of ${maxAttempts} attempts is exhausted`);
    }
    const delayMs = input.delayMs == null
      ? 0
      : ensureInteger(input.delayMs, 'delayMs', { min: 0, max: MAX_PROVIDER_RETRY_DELAY_MS });
    const reason = normalizedMarkdown(input.reason || 'Transient provider failure.', 'reason');
    const failureClass = String(input.failureClass || 'transient_provider_failure').trim().toLowerCase();
    if (!FAILURE_CLASS_RE.test(failureClass)) {
      fail('INVALID_ARGUMENT', 'failureClass must be a short lowercase identifier');
    }
    const scheduledAt = currentTime();
    return {
      phase: task.phase,
      purpose: task.purpose,
      failedTaskId: task.taskId,
      failedProvider: task.provider,
      failureClass,
      reason: reason.slice(0, 2000),
      previousAttempt: task.attempt,
      nextAttempt: task.attempt + 1,
      maxAttempts,
      scheduledAt,
      retryAt: scheduledAt + delayMs,
    };
  }

  // A read-only provider can be retried after it has definitely terminated.
  // Writer failures remain terminal because a failed writer may have changed
  // the workspace before exiting, making an automatic replay unsafe.
  function scheduleProviderRetry(runId, input) {
    assertPlainObject(input, 'provider retry');
    const state = requireState(runId);
    requirePhase(state, RETRYABLE_PROVIDER_PHASES, 'scheduleProviderRetry');
    const task = state.providerTask;
    const actor = assertActor(input.actor, task?.actor);
    const taskId = assertTaskId(input.taskId);
    if (!task || task.taskId !== taskId || task.actor !== actor || task.phase !== state.phase) {
      fail('PROVIDER_TASK_MISMATCH', 'provider retry does not match the current provider task');
    }
    const retry = providerRetryRecord(state, task, input);
    archiveProviderTask(state, 'retry_scheduled', actor);
    state.providerRetry = retry;
    addHistory(state, {
      event: 'provider_task_retry_scheduled',
      from: state.phase,
      to: state.phase,
      actor,
      detail: {
        failedTaskId: retry.failedTaskId,
        failureClass: retry.failureClass,
        nextAttempt: retry.nextAttempt,
        maxAttempts: retry.maxAttempts,
        retryAt: retry.retryAt,
      },
    });
    return persistState(state);
  }

  // Explicit recovery exists for workflows written by older bridge versions,
  // which terminally failed even when a read-only task ended on a typed 429 or
  // transport interruption. The caller must independently prove that the
  // archived task failure is retryable before invoking this narrow transition.
  function retryFailedReadOnlyProviderTask(runId, input) {
    assertPlainObject(input, 'failed provider retry');
    const state = requireState(runId);
    if (state.phase !== 'failed' || state.terminal?.status !== 'failed' || state.providerTask) {
      fail('INVALID_TRANSITION', 'only a terminal failed workflow without an active task can be recovered');
    }
    const task = state.providerTaskHistory.at(-1);
    if (!task || task.outcome !== 'failed' || !RETRYABLE_PROVIDER_SET.has(task.phase)
      || task.purpose !== PROVIDER_TASK_PHASES[task.phase]) {
      fail('PROVIDER_RETRY_NOT_ALLOWED', 'the last failed task was not a recoverable read-only provider phase');
    }
    const actor = assertActor(input.actor, 'operator');
    const retry = providerRetryRecord(state, task, input);
    state.terminal = null;
    state.providerRetry = retry;
    return transition(state, task.phase, 'failed_provider_retry_requested', actor, {
      failedTaskId: retry.failedTaskId,
      failureClass: retry.failureClass,
      nextAttempt: retry.nextAttempt,
      maxAttempts: retry.maxAttempts,
      retryAt: retry.retryAt,
    });
  }

  function readBoundWriterContext(runId, input, expectedPhase, { allowMissingLock = false } = {}) {
    assertPlainObject(input, 'bound writer task');
    const state = requireState(runId);
    requirePhase(state, expectedPhase, 'boundWriterTask');
    const actor = assertActor(input.actor);
    const taskId = assertTaskId(input.taskId);
    const task = state.providerTask;
    if (!task || task.taskId !== taskId || task.actor !== actor || task.phase !== state.phase
      || state.writerLease?.actor !== actor) {
      fail('PROVIDER_TASK_MISMATCH', 'bound provider task, actor, and writer lease do not match');
    }
    const { filePath } = lockIdentity(state.cwd);
    if (!fs.existsSync(filePath)) {
      if (allowMissingLock) return { state, actor, task, lock: null, filePath };
      fail('LEASE_MISSING', 'writer lease file is missing');
    }
    const lock = parseLock(filePath, state.cwd);
    if (lock.runId !== state.runId || lock.actor !== actor
      || sha256(lock.leaseToken) !== state.writerLease.leaseTokenSha256) {
      fail('LEASE_MISMATCH', 'bound provider task does not own the current workspace lock');
    }
    return { state, actor, task, lock, filePath };
  }

  // Provider task runners persist their opaque task ID, never the lease token.
  // On restart this method proves that the bound task still owns the live lock,
  // then uses its on-disk token internally without returning it to the caller.
  function completeBoundRevision(runId, input) {
    const context = readBoundWriterContext(runId, input, 'revising');
    if (context.lock.expiresAt <= currentTime()) fail('LEASE_EXPIRED', 'writer lease has expired');
    return completeRevision(runId, {
      actor: context.actor,
      leaseToken: context.lock.leaseToken,
      markdown: input.markdown,
    });
  }

  function renewBoundWriterLease(runId, input) {
    const context = readBoundWriterContext(runId, input, 'revising');
    const renewed = renewWriterLease(runId, {
      actor: context.actor,
      leaseToken: context.lock.leaseToken,
      leaseMs: input.leaseMs,
    });
    return {
      workflow: renewed.workflow,
      lease: {
        actor: renewed.lease.actor,
        acquiredAt: renewed.lease.acquiredAt,
        expiresAt: renewed.lease.expiresAt,
      },
    };
  }

  // Failure recovery may run after the lease expired or after a crash between
  // unlink and state persistence. It never removes a replacement lock: an
  // existing lock must still match the hash retained in this workflow.
  function finishBoundWriterTask(runId, input, status) {
    const context = readBoundWriterContext(runId, input, 'revising', { allowMissingLock: true });
    if (context.lock) {
      const latest = parseLock(context.filePath, context.state.cwd);
      if (latest.runId !== context.state.runId || latest.leaseToken !== context.lock.leaseToken
        || sha256(latest.leaseToken) !== context.state.writerLease.leaseTokenSha256) {
        fail('LEASE_MISMATCH', 'writer lease changed before recovery release');
      }
      fs.unlinkSync(context.filePath);
      fsyncDirectory(locksDir);
    }
    const state = requireState(runId);
    requirePhase(state, 'revising', `${status}BoundWriterTask`);
    if (!state.providerTask || state.providerTask.taskId !== context.task.taskId
      || state.providerTask.actor !== context.actor) {
      fail('PROVIDER_TASK_MISMATCH', 'bound provider task changed during failure recovery');
    }
    const reason = normalizedMarkdown(input.reason || `Bound provider task ${status}.`, 'reason');
    archiveProviderTask(state, status, context.actor);
    state.writerLease = null;
    state.terminal = {
      status,
      at: currentTime(),
      actor: context.actor,
      reason: reason.slice(0, 2000),
    };
    return transition(state, status, `bound_writer_task_${status}`, context.actor, {
      taskId: context.task.taskId,
      reason: reason.slice(0, 2000),
    });
  }

  function failBoundWriterTask(runId, input) {
    return finishBoundWriterTask(runId, input, 'failed');
  }

  function cancelBoundWriterTask(runId, input) {
    return finishBoundWriterTask(runId, input, 'cancelled');
  }

  // Acquiring a revision lease and binding the separately durable queue task
  // cannot be one filesystem transaction. Recover that narrow crash gap only
  // when no task was ever bound and the current lock still matches the token
  // hash already committed in this workflow.
  function finishOrphanedRevision(runId, input, status) {
    assertPlainObject(input, 'orphaned revision recovery');
    const state = requireState(runId);
    requirePhase(state, 'revising', `${status}OrphanedRevision`);
    if (state.providerTask) fail('PROVIDER_TASK_ACTIVE', 'a bound revision must use bound-task recovery');
    const actor = assertActor(input.actor, state.writerLease?.actor);
    if (!state.writerLease || state.writerLease.actor !== actor) {
      fail('LEASE_MISMATCH', 'orphaned revision actor does not own the stored writer lease');
    }
    const { filePath } = lockIdentity(state.cwd);
    if (fs.existsSync(filePath)) {
      const lock = parseLock(filePath, state.cwd);
      if (lock.runId !== state.runId || lock.actor !== actor
        || sha256(lock.leaseToken) !== state.writerLease.leaseTokenSha256) {
        fail('LEASE_MISMATCH', 'orphaned revision does not own the current workspace lock');
      }
      const latest = parseLock(filePath, state.cwd);
      if (latest.runId !== lock.runId || latest.leaseToken !== lock.leaseToken) {
        fail('LEASE_MISMATCH', 'writer lease changed before orphan recovery');
      }
      fs.unlinkSync(filePath);
      fsyncDirectory(locksDir);
    }
    const latestState = requireState(runId);
    requirePhase(latestState, 'revising', `${status}OrphanedRevision`);
    if (latestState.providerTask || latestState.writerLease?.actor !== actor
      || latestState.writerLease.leaseTokenSha256 !== state.writerLease.leaseTokenSha256) {
      fail('LEASE_MISMATCH', 'orphaned revision state changed during recovery');
    }
    const reason = normalizedMarkdown(input.reason || `Orphaned revision ${status}.`, 'reason');
    latestState.writerLease = null;
    latestState.terminal = { status, at: currentTime(), actor, reason: reason.slice(0, 2000) };
    return transition(latestState, status, `orphaned_revision_${status}`, actor, {
      reason: reason.slice(0, 2000),
    });
  }

  function failOrphanedRevision(runId, input) {
    return finishOrphanedRevision(runId, input, 'failed');
  }

  function cancelOrphanedRevision(runId, input) {
    return finishOrphanedRevision(runId, input, 'cancelled');
  }

  function renewWriterLease(runId, input) {
    assertPlainObject(input, 'lease renewal');
    const state = requireState(runId);
    if (!WRITER_SET.has(state.phase)) fail('LEASE_NOT_REQUIRED', 'workflow is not in a writer phase');
    const actor = assertActor(input.actor, 'codex');
    const token = assertLeaseToken(input.leaseToken);
    const leaseMs = input.leaseMs == null
      ? defaultLeaseMs
      : ensureInteger(input.leaseMs, 'leaseMs', { min: 1, max: MAX_LEASE_MS });
    const { lock, filePath } = validateWriterLease(state, actor, token);
    const renewedAt = currentTime();
    const renewed = { ...lock, renewedAt, expiresAt: renewedAt + leaseMs };
    atomicWriteJson(filePath, renewed);
    state.writerLease.expiresAt = renewed.expiresAt;
    addHistory(state, {
      event: 'writer_lease_renewed',
      actor,
      detail: { expiresAt: renewed.expiresAt },
    });
    const workflow = persistState(state);
    return { workflow, lease: { actor, leaseToken: token, acquiredAt: lock.acquiredAt, expiresAt: renewed.expiresAt } };
  }

  function finishTerminal(runId, status, input = {}) {
    assertPlainObject(input, `${status} options`);
    const state = requireState(runId);
    if (TERMINAL_SET.has(state.phase)) fail('WORKFLOW_TERMINAL', 'workflow is already terminal');
    const actor = assertActor(input.actor, state.writerLease?.actor || 'operator');
    const reason = normalizedMarkdown(input.reason || `${status} by ${actor}`, 'reason');
    let writerState = null;
    let token = null;
    if (WRITER_SET.has(state.phase)) {
      token = assertLeaseToken(input.leaseToken);
      validateWriterLease(state, actor, token);
      writerState = clone(state);
      state.writerLease = null;
    } else if (input.leaseToken != null) {
      fail('LEASE_NOT_REQUIRED', 'leaseToken is valid only while terminating a writer phase');
    }
    archiveProviderTask(state, status, actor, { requireActor: WRITER_SET.has(state.phase) });
    // A scheduled read-only retry has no active task to archive. Terminalizing
    // it must clear the same-phase retry record before state validation.
    state.providerRetry = null;
    state.terminal = { status, at: currentTime(), actor, reason: reason.slice(0, 2000) };
    const result = transition(state, status, `workflow_${status}`, actor, { reason: reason.slice(0, 2000) });
    if (writerState) releaseWriterLease(writerState, actor, token, { allowExpired: true });
    return result;
  }

  function get(runId) {
    const state = readState(runId);
    return state ? clone(state) : null;
  }

  function list({ phase, limit = 50 } = {}) {
    if (phase != null && !PHASE_SET.has(phase)) fail('INVALID_PHASE', 'unknown workflow phase');
    const boundedLimit = ensureInteger(limit, 'limit', { min: 1, max: 200 });
    const rows = [];
    for (const name of fs.readdirSync(workflowsDir)) {
      if (!RUN_ID_RE.test(name)) continue;
      const candidate = path.join(workflowsDir, name);
      let stat;
      try { stat = fs.lstatSync(candidate); } catch { continue; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      try {
        const state = readState(name);
        if (!state || (phase && state.phase !== phase)) continue;
        rows.push({
          runId: state.runId,
          cwd: state.cwd,
          phase: state.phase,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
          revision: state.revision,
          writer: state.writerLease ? {
            actor: state.writerLease.actor,
            expiresAt: state.writerLease.expiresAt,
          } : null,
          providerRetry: state.providerRetry ? {
            purpose: state.providerRetry.purpose,
            nextAttempt: state.providerRetry.nextAttempt,
            maxAttempts: state.providerRetry.maxAttempts,
            retryAt: state.providerRetry.retryAt,
            failureClass: state.providerRetry.failureClass,
          } : null,
        });
      } catch {
        // A corrupt workflow is still available through get(), which reports a
        // precise error; it cannot poison every list call.
      }
    }
    return rows.sort((left, right) => right.updatedAt - left.updatedAt || right.runId.localeCompare(left.runId))
      .slice(0, boundedLimit);
  }

  function readArtifact(runId, kind) {
    const state = requireState(runId);
    if (!ARTIFACT_SET.has(kind)) fail('INVALID_ARTIFACT_KIND', `unknown artifact kind: ${kind}`);
    const metadata = state.artifacts[kind];
    if (!metadata) return null;
    let content;
    try {
      const filePath = artifactPath(state.runId, kind);
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) fail('PATH_ESCAPE', `${kind} artifact must be a regular file`);
      content = fs.readFileSync(filePath, 'utf8');
    }
    catch (error) {
      if (error instanceof WorkflowPipelineError) throw error;
      fail('ARTIFACT_READ_FAILED', `could not read ${kind}: ${error.code || error.message}`);
    }
    const actualHash = sha256(content);
    if (actualHash !== metadata.sha256 || content.length !== metadata.storedChars) {
      fail('ARTIFACT_INTEGRITY', `${kind} artifact does not match workflow state`);
    }
    return clone({ ...metadata, content });
  }

  return Object.freeze({
    createWorkflow,
    updateScope,
    completeResearch,
    startPlanning,
    completePlanning,
    startImplementation,
    completeImplementation,
    startReview,
    completeReview,
    startRevision,
    completeRevision,
    requestAdditionalReview,
    startFinalReview,
    completeFinalReview,
    bindProviderTask,
    scheduleProviderRetry,
    retryFailedReadOnlyProviderTask,
    completeBoundRevision,
    renewBoundWriterLease,
    failBoundWriterTask,
    cancelBoundWriterTask,
    failOrphanedRevision,
    cancelOrphanedRevision,
    renewWriterLease,
    fail: (runId, input) => finishTerminal(runId, 'failed', input),
    cancel: (runId, input) => finishTerminal(runId, 'cancelled', input),
    get,
    list,
    readArtifact,
  });
}

module.exports = {
  SCHEMA_VERSION,
  PHASES,
  TERMINAL_PHASES,
  WRITER_PHASES,
  ARTIFACT_KINDS,
  ARTIFACT_FILES,
  DEFAULT_ARTIFACT_CAPS,
  DEFAULT_MAX_HISTORY,
  DEFAULT_LEASE_MS,
  MAX_LEASE_MS,
  MAX_PROVIDER_RETRY_DELAY_MS,
  RUN_ID_RE,
  TASK_ID_RE,
  PROVIDER_RE,
  TASK_TIERS,
  PERMISSION_MODES,
  MODEL_TIERS,
  EFFORT_LEVELS,
  PROVIDER_PREFERENCE_KEYS,
  PROVIDER_TASK_PHASES,
  RETRYABLE_PROVIDER_PHASES,
  TRANSITIONS,
  WorkflowPipelineError,
  createWorkflowPipeline,
};
