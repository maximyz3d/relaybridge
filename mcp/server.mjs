#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import TIMEOUT_POLICY from '../timeout-policy.cjs';
import {
  BASE_URL,
  BRIDGE_ROOT,
  BridgeError,
  bridgeRequest,
  health,
  restartBridge,
  startBridge,
  stopBridge,
} from './bridge-client.mjs';
import { classifyTask, estimateTokens, loadRoutingData, routeTask } from './router.mjs';
import {
  appendReceipt as persistReceipt,
  findReceiptByRequestId,
  listReceiptCursorPage,
  listReceiptPage,
  listReceipts,
  listRunPage,
  listRuns,
  readCache,
  readReceipt,
  readRun,
  stableHash,
  writeCache,
  writeRun as persistRun,
} from './receipts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = JSON.parse(fs.readFileSync(path.join(BRIDGE_ROOT, 'package.json'), 'utf8'));
function envFirst(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && String(value).trim() !== '') return value;
  }
  return '';
}

const CLI_CONFIG_PATH = path.resolve(envFirst('RELAYBRIDGE_CONFIG_FILE', 'PS_BRIDGE_CONFIG_FILE') || path.join(BRIDGE_ROOT, 'cli-config.json'));

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const EXTERNAL_READ = { ...READ_ONLY, openWorldHint: true };
const AUDITED_READ = { ...READ_ONLY, idempotentHint: false };
const ACTION = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

function loadCliConfig() {
  return JSON.parse(fs.readFileSync(CLI_CONFIG_PATH, 'utf8'));
}

function providerIdentityMaterial(kind) {
  const entry = loadCliConfig()[kind];
  if (entry?.transport !== 'local:ollama' || !entry.model || !process.env.USERPROFILE) return '';
  const match = /^([A-Za-z0-9._-]+)(?::([A-Za-z0-9._-]+))?$/.exec(String(entry.model));
  if (!match) return '';
  const manifestPath = path.join(
    process.env.USERPROFILE,
    '.ollama', 'models', 'manifests', 'registry.ollama.ai', 'library',
    match[1], match[2] || 'latest',
  );
  try { return fs.readFileSync(manifestPath, 'utf8'); }
  catch { return ''; }
}

function clip(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return { text, truncated: false, originalChars: text.length };
  const marker = '\n\n...[truncated by RelayBridge MCP]...\n\n';
  const head = Math.floor((maxChars - marker.length) * 0.35);
  const tail = Math.max(0, maxChars - marker.length - head);
  return {
    text: text.slice(0, head) + marker + text.slice(-tail),
    truncated: true,
    originalChars: text.length,
  };
}

function boundTranscript(messages, maxChars) {
  const original = Array.isArray(messages) ? messages : [];
  const items = [...original];
  while (items.length && JSON.stringify(items).length > maxChars) items.shift();
  if (items.length || !original.length) {
    return { items, truncated: items.length !== original.length };
  }

  // Preserve valid JSON even when a single message is larger than the budget.
  // A preview is deliberately wrapped instead of clipping serialized JSON.
  const preview = clip(JSON.stringify(original.at(-1)), Math.max(256, maxChars - 256));
  return {
    items: [{ _psBridgeTruncated: true, preview: preview.text }],
    truncated: true,
  };
}

// The running-run list is derived from the runs directory rather than from a
// caller-supplied limit, so it needs its own cap to stay inside the budget.
const MAX_RUNNING_RUNS = 25;

function result(data, { isError = false, textOverride } = {}) {
  const structured = data && typeof data === 'object' && !Array.isArray(data) ? data : { value: data };
  return {
    content: [{ type: 'text', text: textOverride === undefined ? JSON.stringify(structured, null, 2) : String(textOverride) }],
    structuredContent: structured,
    ...(isError ? { isError: true } : {}),
  };
}

function toolError(error) {
  const payload = {
    ok: false,
    error: error?.message || String(error),
  };
  if (error instanceof BridgeError) {
    payload.route = error.route;
    payload.status = error.status;
    payload.detail = error.detail;
  }
  return result(payload, { isError: true });
}

function safeHandler(handler) {
  return async (args, context) => {
    try { return await handler(args || {}, context); }
    catch (error) { return toolError(error); }
  };
}

function appendReceipt(event) {
  try { return persistReceipt(event); }
  catch (error) {
    return {
      ...event,
      receiptId: event.receiptId || `rcpt_unpersisted_${Date.now().toString(36)}`,
      timestamp: event.timestamp || new Date().toISOString(),
      receiptPersistenceError: error?.message || String(error),
    };
  }
}

function writeRun(run) {
  try { return persistRun(run); }
  catch (error) {
    return {
      ...run,
      runId: run.runId || `run_unpersisted_${Date.now().toString(36)}`,
      createdAt: run.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      receiptPersistenceError: error?.message || String(error),
    };
  }
}

function providerSummaries(diagnostics = {}) {
  const config = loadCliConfig();
  const { evidence } = loadRoutingData();
  return Object.entries(evidence.providers).map(([kind, item]) => {
    const cli = config[kind] || {};
    const diag = diagnostics[kind] || {};
    return {
      kind,
      label: cli.label || kind,
      company: cli.company || '',
      transport: cli.transport || (kind === 'powershell' ? 'local:process' : 'cli'),
      configuredModel: cli.model || item.modelIdentity,
      usageCapability: diag.usageCapability || null,
      safeOneShot: diag.safeFilesystem ? {
        ...diag.safeFilesystem,
        ready: diag.safeReady ?? null,
      } : null,
      readiness: {
        found: diag.found ?? null,
        ready: diag.ready ?? null,
        safeReady: diag.safeReady ?? null,
        detail: diag.detail || '',
        path: Array.isArray(diag.paths) ? diag.paths[0] || null : null,
        runtimeVersion: diag.runtimeVersion || null,
      },
      costClass: item.costClass,
      privacyBoundary: item.privacyBoundary,
      qualification: item.qualification,
      capabilities: item.capabilities,
      evidence: item.evidence || [],
      references: item.references || [],
      capabilityProvenance: item.capabilityProvenance || {},
      qualificationEvidence: item.qualificationEvidence || null,
      runtimeLicense: item.runtimeLicense || null,
      modelLicense: item.modelLicense || null,
      serviceTerms: item.serviceTerms || null,
      limitations: item.limitations || [],
    };
  });
}

const DIAGNOSTIC_CACHE_TTL_MS = Math.max(0, Math.min(Number(envFirst('RELAYBRIDGE_DIAGNOSTIC_CACHE_TTL_MS', 'PS_BRIDGE_DIAGNOSTIC_CACHE_TTL_MS')) || 5000, 60000));
const DIAGNOSTIC_UPSTREAM_TIMEOUT_MS = 30000;
let diagnosticCache = null;
let diagnosticFlight = null;

// Test seam: readiness probes spawn real child processes, so the cache and the
// in-flight request are process-global. Tests need a deterministic start.
export function resetDiagnosticState() {
  const flight = diagnosticFlight;
  diagnosticCache = null;
  diagnosticFlight = null;
  if (flight && !flight.settled) flight.controller.abort(new Error('diagnostic state reset'));
}

function startDiagnosticFlight() {
  const controller = new AbortController();
  const flight = { controller, subscribers: 0, settled: false, promise: null };
  flight.promise = bridgeRequest('/api/diag', {
    timeoutMs: DIAGNOSTIC_UPSTREAM_TIMEOUT_MS,
    signal: controller.signal,
  }).then((response) => {
    const value = response.results || {};
    diagnosticCache = { at: Date.now(), value };
    return value;
  }).finally(() => {
    flight.settled = true;
    if (diagnosticFlight === flight) diagnosticFlight = null;
  });
  // Promise.race below attaches the only rejection handler. Guarantee one now so
  // a flight that loses its last subscriber can never surface as an unhandled
  // rejection during interpreter teardown.
  flight.promise.catch(() => {});
  return flight;
}

async function getDiagnostics(signal, timeoutMs = DIAGNOSTIC_UPSTREAM_TIMEOUT_MS) {
  if (signal?.aborted) throw signal.reason || new Error('diagnostic request cancelled');
  if (diagnosticCache && Date.now() - diagnosticCache.at <= DIAGNOSTIC_CACHE_TTL_MS) return diagnosticCache.value;

  if (!diagnosticFlight) diagnosticFlight = startDiagnosticFlight();

  const flight = diagnosticFlight;
  flight.subscribers += 1;
  const boundedTimeout = Math.max(1, Math.min(Number(timeoutMs) || DIAGNOSTIC_UPSTREAM_TIMEOUT_MS, DIAGNOSTIC_UPSTREAM_TIMEOUT_MS));
  const timeoutSignal = AbortSignal.timeout(boundedTimeout);
  const callerSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const abortReason = () => {
    const reason = callerSignal.reason;
    if (reason?.name === 'TimeoutError') {
      return new Error(`provider readiness did not return within the ${boundedTimeout}ms remaining for this call`);
    }
    return reason || new Error('diagnostic request cancelled');
  };
  let abortHandler = null;
  const releaseFlight = () => {
    flight.subscribers -= 1;
    if (flight.settled || flight.subscribers > 0) return;
    // Drop the shared flight before aborting it. A caller arriving in the same
    // tick must start a fresh request instead of subscribing to a doomed one.
    if (diagnosticFlight === flight) diagnosticFlight = null;
    flight.controller.abort(new Error('all diagnostic subscribers disconnected'));
  };
  if (callerSignal.aborted) {
    releaseFlight();
    throw abortReason();
  }
  const callerAbort = new Promise((_, reject) => {
    abortHandler = () => reject(abortReason());
    callerSignal.addEventListener('abort', abortHandler, { once: true });
  });
  try {
    return await Promise.race([flight.promise, callerAbort]);
  } finally {
    if (abortHandler) callerSignal.removeEventListener('abort', abortHandler);
    releaseFlight();
  }
}

async function buildContextBundle({
  includeDiagnostics = true,
  includeSessionOutput = true,
  sessionTailChars = 2000,
  maxSessions = 8,
  includeCollabMessages = true,
  maxCollabs = 5,
  maxMessagesPerCollab = 8,
  recentRuns = 10,
  recentReceipts = 20,
  maxChars = 90000,
  signal,
} = {}) {
  const sectionErrors = [];
  const capture = async (name, loader, fallback) => {
    try { return await loader(); }
    catch (error) {
      sectionErrors.push({ section: name, error: error?.message || String(error) });
      return fallback;
    }
  };
  const routing = loadRoutingData();
  const [diagnostics, sessionsRaw, collabsRaw, projectsRaw] = await Promise.all([
    includeDiagnostics ? capture('diagnostics', () => getDiagnostics(signal), {}) : {},
    capture('sessions', () => bridgeRequest('/api/sessions', { signal }), []),
    capture('collaborations', () => bridgeRequest('/api/collabs', { signal }), { collabs: [] }),
    capture('projects', () => bridgeRequest('/api/projects', { signal }), { projects: [] }),
  ]);
  // Read health after diagnostics so the bundle does not count its own short-
  // lived readiness probes as active delegated work.
  const live = await capture('health', () => health(), {});

  const sessionList = (Array.isArray(sessionsRaw) ? sessionsRaw : []).slice(0, maxSessions);
  const sessions = await Promise.all(sessionList.map(async (session) => {
    if (!includeSessionOutput) return { ...session, outputTail: null };
    const output = await capture(
      `session:${session.id}`,
      () => bridgeRequest(`/api/sessions/${encodeURIComponent(session.id)}/buffer`, { signal }),
      null,
    );
    const text = String(output?.text || '');
    return {
      ...session,
      outputTail: text.slice(-sessionTailChars),
      outputChars: text.length,
      outputTruncated: text.length > sessionTailChars,
      exited: output?.exited ?? session.exited ?? null,
      exitCode: output?.exitCode ?? session.exitCode ?? null,
    };
  }));

  const collabSummaries = (Array.isArray(collabsRaw?.collabs) ? collabsRaw.collabs : []).slice(0, maxCollabs);
  const collaborations = await Promise.all(collabSummaries.map(async (summary) => {
    if (!includeCollabMessages) return { ...summary, sharedContext: null, transcript: [] };
    const data = await capture(
      `collaboration:${summary.id}`,
      () => bridgeRequest(`/api/collabs/${encodeURIComponent(summary.id)}`, { signal }),
      null,
    );
    if (!data) return { ...summary, sharedContext: null, transcript: [], unavailable: true };
    const original = Array.isArray(data.transcript) ? data.transcript : [];
    const transcript = original.slice(-maxMessagesPerCollab);
    const bounded = boundTranscript(transcript, Math.max(2000, Math.floor(maxChars / 4)));
    const originalSharedContext = String(data.sharedContext || '');
    const boundedSharedContext = clip(originalSharedContext, 12000);
    return {
      ...summary,
      participants: data.participants || summary.participants || [],
      respond: data.respond || [],
      dropped: data.dropped || [],
      sharedContext: boundedSharedContext.text,
      sharedContextChars: originalSharedContext.length,
      sharedContextTruncated: boundedSharedContext.truncated,
      transcript: bounded.items,
      transcriptTruncated: bounded.truncated || original.length > transcript.length,
    };
  }));

  const runningRuns = listRuns(200).filter((run) => run.status === 'running');
  const bundle = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    bridge: { baseUrl: BASE_URL.href, health: live },
    registries: {
      fingerprints: routing.fingerprints,
      evidenceUpdatedAt: routing.evidence.updatedAt,
      policyUpdatedAt: routing.policy.updatedAt,
      policyMode: routing.policy.mode,
      qualificationBoundary: routing.evidence.qualificationPolicy.rule,
    },
    providers: providerSummaries(diagnostics),
    activeWork: {
      // activeOneShotCount is the provider-call gauge; activeTaskCount also
      // counts readiness probes and other short-lived bridge children.
      activeProviderCalls: Number(live.activeOneShotCount || 0),
      maxActiveProviderCalls: Number(live.maxActiveOneShots || 0) || null,
      activeChildProcesses: Number(live.activeTaskCount || 0),
      openTerminalSessions: Number(live.sessionCount || sessionList.length),
      runningRuns: runningRuns.slice(0, MAX_RUNNING_RUNS),
      runningRunsTotal: runningRuns.length,
      runningRunsTruncated: runningRuns.length > MAX_RUNNING_RUNS,
    },
    sessions: {
      total: Array.isArray(sessionsRaw) ? sessionsRaw.length : 0,
      included: sessions,
      truncated: Array.isArray(sessionsRaw) && sessionsRaw.length > sessions.length,
    },
    collaborations: {
      total: Array.isArray(collabsRaw?.collabs) ? collabsRaw.collabs.length : 0,
      included: collaborations,
      truncated: Array.isArray(collabsRaw?.collabs) && collabsRaw.collabs.length > collaborations.length,
    },
    projects: Array.isArray(projectsRaw?.projects) ? projectsRaw.projects : [],
    recentRuns: listRuns(recentRuns),
    recentReceipts: listReceipts(recentReceipts),
    sectionErrors,
    transferGuide: {
      statusAndRouting: ['bridge_status', 'list_providers', 'route_preview'],
      terminalDetail: ['list_sessions', 'read_session_output'],
      collaborationDetail: ['list_collabs', 'read_collab', 'list_projects'],
      delegatedWork: ['list_runs', 'get_run', 'list_receipts', 'get_receipt'],
      safeActions: ['start_safe_session', 'ask_provider', 'route_and_ask', 'run_committee'],
      lifecycleActions: ['start_bridge', 'restart_bridge', 'stop_bridge', 'send_session_input', 'stop_session'],
      resources: [
        'psbridge://context', 'psbridge://health', 'psbridge://providers', 'psbridge://routing-policy',
        'psbridge://evidence', 'psbridge://sessions', 'psbridge://collabs', 'psbridge://runs',
      ],
      note: 'This bundle is a bounded handoff. Use the named detail tools for omitted history or longer output; no secret token is included.',
      cancellation: 'Cancellation is request-scoped only. Aborting an MCP call aborts its HTTP requests, and the bridge kills that provider process tree, but there is no job registry: a cancelled run is checkpointed as cancelled and cannot be resumed, and no tool can cancel a run started by a different MCP request.',
    },
    transfer: {
      requestedMaxChars: maxChars,
      truncated: false,
      omissions: [],
      actualChars: 0,
      withinBudget: false,
    },
  };

  const noteInitialOmission = (condition, label) => {
    if (!condition) return;
    bundle.transfer.truncated = true;
    if (!bundle.transfer.omissions.includes(label)) bundle.transfer.omissions.push(label);
  };
  noteInitialOmission(!includeDiagnostics, 'live provider readiness probes (includeDiagnostics=false); call list_providers');
  noteInitialOmission(bundle.sessions.truncated, 'session summaries beyond maxSessions');
  noteInitialOmission(!includeSessionOutput && bundle.sessions.included.length > 0, 'all terminal output (includeSessionOutput=false); call read_session_output');
  noteInitialOmission(bundle.sessions.included.some((item) => item.outputTruncated), 'terminal output before requested tails');
  noteInitialOmission(bundle.collaborations.truncated, 'collaboration summaries beyond maxCollabs');
  noteInitialOmission(!includeCollabMessages && bundle.collaborations.included.length > 0, 'all collaboration transcripts and shared context (includeCollabMessages=false); call read_collab');
  noteInitialOmission(bundle.collaborations.included.some((item) => item.transcriptTruncated), 'collaboration messages beyond maxMessagesPerCollab');
  noteInitialOmission(bundle.collaborations.included.some((item) => item.sharedContextTruncated), 'collaboration shared context beyond 12000 characters');
  noteInitialOmission(bundle.collaborations.included.some((item) => item.unavailable), 'unreadable collaboration detail; see sectionErrors');
  noteInitialOmission(bundle.activeWork.runningRunsTruncated, `running runs beyond ${MAX_RUNNING_RUNS}; call list_runs`);
  noteInitialOmission(bundle.sectionErrors.length > 0, 'sections that failed to load; see sectionErrors');
  noteInitialOmission(recentRuns === 0, 'recent run summaries (recentRuns=0); call list_runs');
  noteInitialOmission(recentReceipts === 0, 'recent receipts (recentReceipts=0); call list_receipts');

  const size = () => JSON.stringify(bundle).length;
  // Keep a reserve for the bundle ID, receipt ID, and size metadata added after
  // trimming so the final MCP payload stays inside the caller's character cap.
  const targetMaxChars = Math.max(1000, maxChars - 2048);
  while (size() > targetMaxChars && bundle.recentReceipts.length) {
    bundle.recentReceipts.pop();
    bundle.transfer.truncated = true;
    if (!bundle.transfer.omissions.includes('older receipts')) bundle.transfer.omissions.push('older receipts');
  }
  while (size() > targetMaxChars && bundle.activeWork.runningRuns.length) {
    bundle.activeWork.runningRuns.pop();
    bundle.activeWork.runningRunsTruncated = true;
    bundle.transfer.truncated = true;
    if (!bundle.transfer.omissions.includes('older running runs')) bundle.transfer.omissions.push('older running runs');
  }
  while (size() > targetMaxChars && bundle.recentRuns.length) {
    bundle.recentRuns.pop();
    bundle.transfer.truncated = true;
    if (!bundle.transfer.omissions.includes('older run summaries')) bundle.transfer.omissions.push('older run summaries');
  }
  while (size() > targetMaxChars && bundle.collaborations.included.some((item) => item.transcript?.length)) {
    const item = bundle.collaborations.included.find((entry) => entry.transcript?.length);
    item.transcript.shift();
    item.transcriptTruncated = true;
    bundle.transfer.truncated = true;
    if (!bundle.transfer.omissions.includes('older collaboration messages')) bundle.transfer.omissions.push('older collaboration messages');
  }
  while (size() > targetMaxChars && bundle.collaborations.included.some((item) => String(item.sharedContext || '').length > 512)) {
    const item = bundle.collaborations.included.find((entry) => String(entry.sharedContext || '').length > 512);
    item.sharedContext = clip(item.sharedContext, Math.max(512, Math.floor(item.sharedContext.length / 2))).text;
    item.sharedContextTruncated = true;
    bundle.transfer.truncated = true;
    if (!bundle.transfer.omissions.includes('long collaboration shared context')) bundle.transfer.omissions.push('long collaboration shared context');
  }
  if (size() > targetMaxChars) {
    for (const session of bundle.sessions.included) {
      if (!session.outputTail) continue;
      session.outputTail = clip(session.outputTail, 512).text;
      session.outputTruncated = true;
    }
    bundle.transfer.truncated = true;
    bundle.transfer.omissions.push('long terminal output tails');
  }
  if (size() > targetMaxChars) {
    bundle.providers = bundle.providers.map((provider) => ({
      kind: provider.kind,
      label: provider.label,
      configuredModel: provider.configuredModel,
      readiness: provider.readiness,
      costClass: provider.costClass,
      privacyBoundary: provider.privacyBoundary,
      qualification: provider.qualification,
      capabilities: provider.capabilities,
      evidence: provider.evidence,
    }));
    bundle.transfer.truncated = true;
    bundle.transfer.omissions.push('verbose provider provenance; call list_providers for full records');
  }
  while (size() > targetMaxChars && bundle.projects.length) {
    bundle.projects.pop();
    bundle.transfer.truncated = true;
    if (!bundle.transfer.omissions.includes('older project labels')) bundle.transfer.omissions.push('older project labels');
  }
  while (size() > targetMaxChars && bundle.collaborations.included.length) {
    bundle.collaborations.included.pop();
    bundle.collaborations.truncated = true;
    bundle.transfer.truncated = true;
    if (!bundle.transfer.omissions.includes('older collaboration summaries')) bundle.transfer.omissions.push('older collaboration summaries');
  }
  while (size() > targetMaxChars && bundle.sessions.included.length) {
    bundle.sessions.included.pop();
    bundle.sessions.truncated = true;
    bundle.transfer.truncated = true;
    if (!bundle.transfer.omissions.includes('older session summaries')) bundle.transfer.omissions.push('older session summaries');
  }
  const contentHashMaterial = {
    ...bundle,
    transfer: { ...bundle.transfer, actualChars: 0, withinBudget: false },
  };
  bundle.contentSha256 = stableHash(contentHashMaterial);
  bundle.contentHashScope = 'structured bundle before bundleId, receiptId, receipt persistence flags, and final size counters';
  bundle.bundleId = `ctx_${bundle.contentSha256.slice(0, 20)}`;
  // A second assignment accounts for the digits in actualChars itself.
  bundle.transfer.actualChars = size();
  bundle.transfer.actualChars = size();
  bundle.transfer.withinBudget = size() <= maxChars;
  return bundle;
}

function cacheTtlFor(classification, requestedTtlMs) {
  const { policy } = loadRoutingData();
  if (policy.cache.enabled === false) return 0;
  if (Number.isInteger(requestedTtlMs)) return Math.max(0, Math.min(requestedTtlMs, 86400000));
  return classification.tags.includes('research') ? policy.cache.researchTtlMs : policy.cache.defaultTtlMs;
}

function strictTokenCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value : null;
}

function strictProviderCost(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value : null;
}

function strictTokenSum(values) {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

export function normalizeProviderUsage(value, modelInvocation) {
  if (!modelInvocation || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const has = (name) => Object.prototype.hasOwnProperty.call(value, name);
  const strictOptionalCount = (name, absentValue = null) => {
    if (!has(name)) return absentValue;
    return strictTokenCount(value[name]);
  };
  const inputTokens = strictOptionalCount('input_tokens');
  const outputTokens = strictOptionalCount('output_tokens');
  const cacheReadTokens = strictOptionalCount('cache_read_input_tokens', 0);
  const cacheCreationTokens = strictOptionalCount('cache_creation_input_tokens', 0);
  const reportedTotal = strictOptionalCount('total_tokens');
  if (
    (has('input_tokens') && inputTokens === null)
    || (has('output_tokens') && outputTokens === null)
    || (has('cache_read_input_tokens') && cacheReadTokens === null)
    || (has('cache_creation_input_tokens') && cacheCreationTokens === null)
    || (has('total_tokens') && reportedTotal === null)
  ) return null;
  const computedTotal = inputTokens !== null && outputTokens !== null
    ? strictTokenSum([inputTokens, outputTokens, cacheReadTokens || 0, cacheCreationTokens || 0])
    : null;
  const totalTokens = computedTotal ?? reportedTotal;
  const thinkingCandidate = strictOptionalCount('thinking_tokens');
  if (has('thinking_tokens') && thinkingCandidate === null) return null;
  const thinkingTokens = thinkingCandidate !== null
    && (outputTokens === null || thinkingCandidate <= outputTokens) ? thinkingCandidate : null;
  const cost = strictProviderCost(value.cost_usd);
  if (has('cost_usd') && value.cost_usd !== null && cost === null) return null;
  if (totalTokens === null && inputTokens === null && outputTokens === null && cost === null) return null;
  if (has('model_usage') && !Array.isArray(value.model_usage)) return null;
  const modelUsage = [];
  const seenModels = new Set();
  for (const row of value.model_usage || []) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const model = strictBoundedString(row.model, 160);
    const provider = row.provider === '' ? '' : strictBoundedString(row.provider, 80);
    const rowInput = strictTokenCount(row.input_tokens);
    const rowOutput = strictTokenCount(row.output_tokens);
    const rowCacheRead = strictTokenCount(row.cache_read_input_tokens);
    const rowCacheCreation = strictTokenCount(row.cache_creation_input_tokens);
    const rowCost = row.cost_usd === null ? null : strictProviderCost(row.cost_usd);
    if (!model || seenModels.has(model) || provider === null
      || [rowInput, rowOutput, rowCacheRead, rowCacheCreation].some((item) => item === null)
      || (row.cost_usd !== null && rowCost === null)) return null;
    seenModels.add(model);
    modelUsage.push({
      model, provider, input_tokens: rowInput, output_tokens: rowOutput,
      cache_read_input_tokens: rowCacheRead,
      cache_creation_input_tokens: rowCacheCreation,
      cost_usd: rowCost,
    });
  }
  if (modelUsage.length) {
    const sumRows = (name) => strictTokenSum(modelUsage.map((row) => row[name]));
    if (inputTokens === null || outputTokens === null
      || inputTokens !== sumRows('input_tokens') || outputTokens !== sumRows('output_tokens')
      || cacheReadTokens !== sumRows('cache_read_input_tokens')
      || cacheCreationTokens !== sumRows('cache_creation_input_tokens')) return null;
  }
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    total_tokens: totalTokens,
    thinking_tokens: thinkingTokens,
    cost_usd: cost,
    token_source: totalTokens !== null || inputTokens !== null || outputTokens !== null
      ? 'provider_reported' : 'provider_reported_cost_only',
    model_usage: modelUsage,
  };
}

const PROVIDER_RETRY_ERROR_CATEGORIES = new Set([
  'authentication_failed', 'oauth_org_not_allowed', 'billing_error', 'rate_limit',
  'overloaded', 'invalid_request', 'model_not_found', 'server_error',
  'max_output_tokens', 'unknown',
]);

const PROVIDER_FAILURE_CLASSES = new Set([
  'cancelled', 'rate_limit', 'budget', 'auth', 'timeout', 'policy',
  'max_tokens', 'refusal', 'max_turns', 'structured_output_retry_exhausted',
  'tool_deferred', 'aborted_streaming', 'aborted_tools', 'hook_stopped',
  'stop_hook_prevented', 'blocking_limit', 'prompt_too_long',
  'provider_error', 'admission_limit', 'bridge_identity_mismatch',
  'incomplete_response', 'token_budget', 'plan_restriction',
  'client_cancelled', 'mcp_deadline_cancelled',
]);

const PROVIDER_BUDGET_SCHEMA = z.object({
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  maxTotalTokens: z.number().int().positive().nullable().optional(),
  maxCacheReadTokens: z.number().int().positive().nullable().optional(),
  maxCacheCreationTokens: z.number().int().positive().nullable().optional(),
  maxTurns: z.number().int().positive().nullable().optional(),
}).strict();

const PROVIDER_TERMINAL_REASONS = new Set([
  'completed', 'max_turns', 'tool_deferred', 'aborted_streaming', 'aborted_tools',
  'hook_stopped', 'stop_hook_prevented', 'blocking_limit', 'rapid_refill_breaker',
  'prompt_too_long', 'image_error', 'model_error',
]);

function strictBoundedString(value, maxChars = 128) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxChars) : null;
}

const CWD_OUTSIDE_ALLOWED_ROOTS = 'cwd_outside_allowed_roots';
const CWD_OUTSIDE_REASON = 'The requested working directory resolves outside RelayBridge allowed roots.';
const CWD_IDENTITY_CHANGED = 'cwd_identity_changed';
const CWD_IDENTITY_CHANGED_REASON = 'The working directory identity changed after admission and before provider execution.';
const CWD_ENROLLMENT_GUIDANCE = 'Use an existing allowed working directory, or explicitly add the intended root to RELAYBRIDGE_ALLOWED_ROOTS and restart RelayBridge. RelayBridge did not change the allowlist.';

function strictSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function normalizeValidationDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.code === CWD_IDENTITY_CHANGED && value.field === 'cwd') {
    const expectedCwdIdentityHash = strictSha256(value.expectedCwdIdentityHash);
    const observedCwdIdentityHash = strictSha256(value.observedCwdIdentityHash);
    const cwdPolicyId = strictSha256(value.cwdPolicyId);
    if (!expectedCwdIdentityHash || !observedCwdIdentityHash || !cwdPolicyId
      || value.retryable !== false) return null;
    return {
      code: CWD_IDENTITY_CHANGED,
      field: 'cwd',
      reason: CWD_IDENTITY_CHANGED_REASON,
      retryable: false,
      expectedCwdIdentityHash,
      observedCwdIdentityHash,
      cwdPolicyId,
      guidance: 'Repeat admission with the intended working directory. RelayBridge did not execute a provider.',
    };
  }
  if (value.code !== CWD_OUTSIDE_ALLOWED_ROOTS || value.field !== 'cwd') return null;
  const requestedRootHash = strictSha256(value.requestedRootHash);
  const normalizedRootHash = strictSha256(value.normalizedRootHash);
  const canonicalRootHash = value.canonicalRootHash === null
    ? null : strictSha256(value.canonicalRootHash);
  if (!requestedRootHash || !normalizedRootHash
    || (value.canonicalRootHash !== null && !canonicalRootHash)
    || !Array.isArray(value.allowedRootHashes)
    || value.allowedRootHashes.length < 1 || value.allowedRootHashes.length > 32
    || value.retryable !== false || value.allowlistChanged !== false
    || value.restartRequiredForEnrollment !== true) return null;
  const allowedRootHashes = value.allowedRootHashes.map(strictSha256);
  const allowedRootHashCount = strictTokenCount(value.allowedRootHashCount);
  if (allowedRootHashes.some((item) => !item)
    || new Set(allowedRootHashes).size !== allowedRootHashes.length
    || allowedRootHashCount === null || allowedRootHashCount < allowedRootHashes.length
    || value.allowedRootHashesTruncated !== (allowedRootHashCount > allowedRootHashes.length)) return null;
  return {
    code: CWD_OUTSIDE_ALLOWED_ROOTS,
    field: 'cwd',
    reason: CWD_OUTSIDE_REASON,
    retryable: false,
    requestedRootHash,
    normalizedRootHash,
    canonicalRootHash,
    allowedRootHashes,
    allowedRootHashCount,
    allowedRootHashesTruncated: value.allowedRootHashesTruncated,
    guidance: CWD_ENROLLMENT_GUIDANCE,
    allowlistChanged: false,
    restartRequiredForEnrollment: true,
  };
}

function normalizeWorkspaceAdmission(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ok !== true
    || value.model_invocation !== false || value.token_usage_source !== 'not_invoked'
    || value.transport_retry_count !== 0) return null;
  const cwdIdentityHash = strictSha256(value.cwdIdentityHash);
  const cwdPolicyId = strictSha256(value.cwdPolicyId);
  const bridgeBuildId = strictBoundedString(value.bridgeBuildId, 180);
  const receiptStoreId = strictSha256(value.receiptStoreId);
  if (!cwdIdentityHash || !cwdPolicyId || !bridgeBuildId || !receiptStoreId) return null;
  return { cwdIdentityHash, cwdPolicyId, bridgeBuildId, receiptStoreId };
}

function strictCountMap(value, allowedKey) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const rows = [];
  for (const [key, rawCount] of Object.entries(value)) {
    if (!allowedKey(key)) continue;
    const count = strictTokenCount(rawCount);
    if (count === null) continue;
    rows.push([key, count]);
  }
  rows.sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(rows);
}

function zeroProviderRetries() {
  return {
    count: 0,
    total_delay_ms: 0,
    max_attempt: 0,
    declared_max_retries: 0,
    by_error: {},
    by_status: {},
    events: [],
    truncated: false,
    observed_events: 0,
    invalid_events: 0,
    duplicate_events: 0,
  };
}

export function normalizeProviderRetries(value, modelInvocation) {
  if (modelInvocation === false) return zeroProviderRetries();
  if (modelInvocation !== true || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const events = [];
  const eventIds = new Set();
  if (Array.isArray(value.events)) {
    for (const event of value.events.slice(0, 256)) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
      const attempt = strictTokenCount(event.attempt);
      const maxRetries = strictTokenCount(event.max_retries);
      const retryDelayMs = strictTokenCount(event.retry_delay_ms);
      const eventIdHash = typeof event.event_id_hash === 'string' && /^[0-9a-f]{64}$/.test(event.event_id_hash)
        ? event.event_id_hash : null;
      const statusAbsent = event.error_status === null || event.error_status === undefined;
      const status = statusAbsent ? null : strictTokenCount(event.error_status);
      const category = typeof event.error === 'string' && PROVIDER_RETRY_ERROR_CATEGORIES.has(event.error)
        ? event.error : 'unknown';
      if (!eventIdHash || attempt === null || attempt < 1 || maxRetries === null || retryDelayMs === null) continue;
      if (!statusAbsent && (status === null || status < 100 || status > 599)) continue;
      if (eventIds.has(eventIdHash)) continue;
      eventIds.add(eventIdHash);
      events.push({
        event_id_hash: eventIdHash,
        attempt,
        max_retries: maxRetries,
        retry_delay_ms: retryDelayMs,
        error_status: status,
        error: category,
      });
    }
  }
  const count = strictTokenCount(value.count);
  const totalDelayMs = value.total_delay_ms === null ? null : strictTokenCount(value.total_delay_ms);
  const maxAttempt = strictTokenCount(value.max_attempt);
  const declaredMaxRetries = strictTokenCount(value.declared_max_retries);
  const observedEvents = strictTokenCount(value.observed_events);
  const invalidEvents = strictTokenCount(value.invalid_events);
  const duplicateEvents = strictTokenCount(value.duplicate_events);
  const byError = strictCountMap(value.by_error, (key) => PROVIDER_RETRY_ERROR_CATEGORIES.has(key));
  const byStatus = strictCountMap(value.by_status, (key) => key === 'none' || /^(?:[1-5]\d\d)$/.test(key));
  const mapSum = (mapping) => strictTokenSum(Object.values(mapping));
  const expectedRetained = count === null ? null : Math.min(count, 256);
  const expectedTruncated = count !== null && count > events.length;
  const observedBreakdown = strictTokenSum([count ?? -1, invalidEvents ?? -1, duplicateEvents ?? -1]);
  if (
    count === null || maxAttempt === null || declaredMaxRetries === null
    || observedEvents === null || invalidEvents === null || duplicateEvents === null
    || observedBreakdown === null || observedEvents !== observedBreakdown
    || events.length !== expectedRetained
    || value.truncated !== expectedTruncated
    || mapSum(byError) !== count || mapSum(byStatus) !== count
  ) return null;
  if (!expectedTruncated) {
    const eventDelay = strictTokenSum(events.map((event) => event.retry_delay_ms));
    const eventMaxAttempt = events.reduce((current, event) => Math.max(current, event.attempt), 0);
    const eventMaxRetries = events.reduce((current, event) => Math.max(current, event.max_retries), 0);
    if (totalDelayMs !== eventDelay || maxAttempt !== eventMaxAttempt || declaredMaxRetries !== eventMaxRetries) return null;
  }
  return {
    count,
    total_delay_ms: totalDelayMs,
    max_attempt: maxAttempt,
    declared_max_retries: declaredMaxRetries,
    by_error: byError,
    by_status: byStatus,
    events,
    truncated: value.truncated === true,
    observed_events: observedEvents,
    invalid_events: invalidEvents,
    duplicate_events: duplicateEvents,
  };
}

function zeroProviderPermissionDenials() {
  return { retained: [], count: 0, observed: 0, invalid: 0, truncated: false, byTool: {} };
}

export function normalizeProviderPermissionDenials(value, modelInvocation) {
  if (modelInvocation === false) return zeroProviderPermissionDenials();
  if (modelInvocation !== true || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const retained = [];
  const ids = new Set();
  for (const row of Array.isArray(value.retained) ? value.retained.slice(0, 256) : []) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const toolName = strictBoundedString(row.tool_name, 160);
    const idHash = typeof row.tool_use_id_hash === 'string' && /^[0-9a-f]{64}$/.test(row.tool_use_id_hash)
      ? row.tool_use_id_hash : null;
    if (!toolName || !idHash || ids.has(idHash)) return null;
    ids.add(idHash);
    retained.push({ tool_name: toolName, tool_use_id_hash: idHash });
  }
  const count = strictTokenCount(value.count);
  const observed = strictTokenCount(value.observed);
  const invalid = strictTokenCount(value.invalid);
  const byTool = strictCountMap(value.byTool, (key) => strictBoundedString(key, 160) === key.trim());
  const observedBreakdown = strictTokenSum([count ?? -1, invalid ?? -1]);
  if (count === null || observed === null || invalid === null
    || observedBreakdown === null || observed !== observedBreakdown || retained.length !== Math.min(count, 256)
    || value.truncated !== (count > retained.length)
    || strictTokenSum(Object.values(byTool)) !== count) return null;
  if (!value.truncated) {
    const retainedByTool = Object.create(null);
    for (const row of retained) retainedByTool[row.tool_name] = (retainedByTool[row.tool_name] || 0) + 1;
    if (JSON.stringify(Object.entries(retainedByTool).sort()) !== JSON.stringify(Object.entries(byTool).sort())) return null;
  }
  return { retained, count, observed, invalid, truncated: value.truncated, byTool };
}

export function normalizeVendorQuota(value) {
  if (!value || typeof value !== 'object') return null;
  const actual = strictTokenCount(value.actual);
  const limit = strictTokenCount(value.limit);
  const remaining = strictTokenCount(value.remaining);
  const percentRemaining = strictTokenCount(value.percentRemaining);
  const model = strictBoundedString(value.model, 120);
  const observedAt = strictBoundedString(value.observedAt, 40);
  const expiresAt = strictBoundedString(value.reset?.expiresAt, 40);
  const windowMs = strictTokenCount(value.window?.durationMs);
  if (value.provider !== 'grok' || value.unit !== 'tokens'
    || value.source !== 'grok_429_subscription_free_usage_exhausted'
    || !/^grok-[a-z0-9._-]+$/i.test(model || '')
    || actual === null || limit === null || limit < 1 || remaining === null
    || percentRemaining === null || percentRemaining > 100
    || remaining !== Math.max(0, limit - actual)
    || value.overLimit !== (actual > limit)
    || value.window?.kind !== 'rolling' || windowMs === null || windowMs < 3600000 || windowMs > 604800000
    || value.reset?.kind !== 'conservative_expiry'
    || !Number.isFinite(Date.parse(observedAt)) || !Number.isFinite(Date.parse(expiresAt))
    || Date.parse(expiresAt) - Date.parse(observedAt) !== windowMs
    || !/^[0-9a-f]{64}$/.test(String(value.evidenceHash || ''))) return null;
  return {
    provider: 'grok', model, unit: 'tokens', actual, limit, remaining, percentRemaining,
    overLimit: value.overLimit,
    source: value.source,
    observedAt,
    window: {
      kind: 'rolling', durationMs: windowMs,
      label: strictBoundedString(value.window?.label, 120),
    },
    reset: {
      kind: 'conservative_expiry', expiresAt,
      note: strictBoundedString(value.reset?.note, 240),
    },
    evidenceHash: value.evidenceHash,
  };
}

export function normalizeQuotaEvidence(value) {
  if (!value || typeof value !== 'object') return null;
  const stderrChars = strictTokenCount(value.stderrChars);
  const observedAt = strictBoundedString(value.observedAt, 40);
  if (value.provider !== 'copilot' || value.scope !== 'seat'
    || value.kind !== 'monthly_quota_exhausted'
    || value.source !== 'copilot_cli_stderr'
    || value.diagnostic !== 'You have exceeded your monthly quota'
    || stderrChars === null || !Number.isFinite(Date.parse(observedAt))
    || new Date(observedAt).toISOString() !== observedAt
    || !/^[0-9a-f]{64}$/.test(String(value.stderrHash || ''))) return null;
  return {
    provider: 'copilot', scope: 'seat', kind: value.kind, source: value.source,
    diagnostic: value.diagnostic, observedAt, stderrChars, stderrHash: value.stderrHash,
  };
}

export function normalizeProviderActionRequired(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.provider !== 'cursor' || typeof value.modelFlagSent !== 'boolean') return null;
  const source = value.source === 'cursor_cli_stderr' || value.source === 'cursor_cli_stdout'
    ? value.source : null;
  if (!source) return null;
  if (value.kind === 'named_models_unavailable' && value.scope === 'plan'
    && value.diagnostic === 'Named models unavailable; Free plans can only use Auto') {
    return {
      provider: 'cursor', kind: value.kind, scope: 'plan', source,
      diagnostic: value.diagnostic, modelFlagSent: value.modelFlagSent,
    };
  }
  if (value.kind === 'usage_quota_exhausted' && value.scope === 'seat'
    && value.diagnostic === "You've hit your usage limit") {
    return {
      provider: 'cursor', kind: value.kind, scope: 'seat', source,
      diagnostic: value.diagnostic, modelFlagSent: value.modelFlagSent,
    };
  }
  return null;
}

function sanitizeProviderResponse(response) {
  const stdout = clip(response.stdout || '', 24000);
  const stderr = clip(response.stderr || '', 4000);
  const modelInvocation = response.model_invocation === false ? false
    : response.model_invocation === null ? null : true;
  const rawFailureClass = strictBoundedString(response.failureClass);
  const terminalReason = strictBoundedString(response.provider_terminal_reason);
  const partialDiagnostic = clip(response.partial_diagnostic || '', 12000);
  const apiErrorStatusCandidate = response.provider_api_error_status === null
    || response.provider_api_error_status === undefined ? null
    : strictTokenCount(response.provider_api_error_status);
  return {
    kind: response.kind,
    route: response.route || {},
    transportReceiptId: response.receiptId || null,
    transportReceiptPersisted: response.receiptPersisted ?? null,
    transportReceiptPersistenceError: response.receiptPersistenceError || null,
    actionPreflight: response.actionPreflight || null,
    transportRetryCount: 0,
    invocationId: strictBoundedString(response.invocationId),
    attemptId: strictBoundedString(response.attemptId),
    physicalAttemptCount: strictTokenCount(response.physical_attempt_count),
    exitCode: response.exitCode,
    droppedOut: !!response.dropped_out,
    rateLimited: !!response.rate_limited,
    budgetExceeded: !!response.budget_exceeded,
    authFailed: !!response.auth_failed,
    permissionDenied: !!response.permission_denied,
    timedOut: !!response.timed_out,
    cancelled: !!response.cancelled,
    modelInvocation,
    failureClass: PROVIDER_FAILURE_CLASSES.has(rawFailureClass) ? rawFailureClass : null,
    resultSubtype: strictBoundedString(response.result_subtype),
    resultSchemaDisagreement: response.result_schema_disagreement === true,
    providerStopReason: strictBoundedString(response.provider_stop_reason),
    providerTerminalReason: PROVIDER_TERMINAL_REASONS.has(terminalReason) ? terminalReason : null,
    stopReason: strictBoundedString(response.stop_reason),
    supervisorStopReason: strictBoundedString(response.supervisor_stop_reason),
    providerTimeoutSource: strictBoundedString(response.provider_timeout_source),
    providerBudget: response.provider_budget && typeof response.provider_budget === 'object'
      ? response.provider_budget : null,
    providerBudgetEnforcement: strictBoundedString(response.provider_budget_enforcement),
    providerApiErrorStatus: apiErrorStatusCandidate !== null
      && apiErrorStatusCandidate >= 100 && apiErrorStatusCandidate <= 599 ? apiErrorStatusCandidate : null,
    providerPermissionDenials: normalizeProviderPermissionDenials(response.provider_permission_denials, modelInvocation),
    providerNumTurns: strictTokenCount(response.provider_num_turns),
    providerDurationMs: strictTokenCount(response.provider_duration_ms),
    providerApiDurationMs: strictTokenCount(response.provider_api_duration_ms),
    providerErrorCount: strictTokenCount(response.provider_error_count),
    providerErrorObserved: strictTokenCount(response.provider_error_observed),
    providerErrorInvalid: strictTokenCount(response.provider_error_invalid),
    providerErrorDiagnosticTruncated: response.provider_error_diagnostic_truncated === true,
    partialResult: response.partial_result === true,
    failureSentinel: strictBoundedString(response.failure_sentinel),
    failureSentinelSource: strictBoundedString(response.failure_sentinel_source),
    partialDiagnostic: partialDiagnostic.text,
    partialDiagnosticChars: partialDiagnostic.originalChars,
    partialDiagnosticSha256: stableHash(response.partial_diagnostic || ''),
    partialDiagnosticTruncated: partialDiagnostic.truncated,
    progressAtCancellation: response.progress_at_cancellation
      || (response.cancelled ? response.progress || null : null),
    cleanedOutputUnavailable: response.cleaned_output_unavailable ?? null,
    transportOutputChars: strictTokenCount(response.transport_output_chars),
    transportOutputHash: typeof response.transport_output_hash === 'string'
      && /^[0-9a-f]{64}$/.test(response.transport_output_hash) ? response.transport_output_hash : null,
    providerRetries: normalizeProviderRetries(response.provider_retries, modelInvocation),
    vendorQuota: normalizeVendorQuota(response.vendor_quota),
    quotaEvidence: normalizeQuotaEvidence(response.quota_evidence),
    providerActionRequired: normalizeProviderActionRequired(response.provider_action_required),
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutChars: stdout.originalChars,
    stderrChars: stderr.originalChars,
    stdoutSha256: stableHash(response.stdout || ''),
    stderrSha256: stableHash(response.stderr || ''),
    outputTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    usage: normalizeProviderUsage(response.usage, modelInvocation),
  };
}

function providerSucceeded(response) {
  return !!response &&
    response.exitCode === 0 &&
    !response.droppedOut &&
    !response.rateLimited &&
    !response.budgetExceeded &&
    !response.authFailed &&
    !response.permissionDenied &&
    !response.timedOut &&
    !response.cancelled &&
    !!String(response.stdout || '').trim();
}

function bridgeFailureResult(error, { kind, signal }) {
  const bridgeStatus = error instanceof BridgeError && Number.isInteger(error.status)
    ? error.status : null;
  const deterministicPreflightRejection = bridgeStatus !== null
    && bridgeStatus >= 400 && bridgeStatus < 500;
  const authRequired = error instanceof BridgeError && error.detail?.auth_required === true;
  const transportTimedOut = !signal?.aborted && error instanceof BridgeError
    && (error.cause?.name === 'TimeoutError' || error.cause?.cause?.name === 'TimeoutError');
  const validation = error instanceof BridgeError
    ? normalizeValidationDiagnostic(error.detail?.validation) : null;
  const transportReceiptId = error instanceof BridgeError
    && /^rcpt_[A-Za-z0-9._:-]{1,180}$/.test(String(error.detail?.receiptId || ''))
    ? String(error.detail.receiptId) : null;
  const cancellationClass = signal?.aborted
    ? (signal.reason?.name === 'TimeoutError' ? 'mcp_deadline_cancelled' : 'client_cancelled')
    : transportTimedOut ? 'mcp_deadline_cancelled' : null;
  return {
    status: cancellationClass ? 'cancelled' : 'failed',
    sanitized: {
      kind,
      exitCode: -1,
      droppedOut: true,
      stdout: '',
      stderr: validation?.reason || error.message,
      route: {},
      cancelled: !!cancellationClass,
      timedOut: false,
      authFailed: authRequired,
      admissionLimited: bridgeStatus === 429,
      modelInvocation: deterministicPreflightRejection ? false : null,
      tokenUsageSource: deterministicPreflightRejection ? 'not_invoked' : 'unknown',
      transportRetryCount: 0,
      providerRetries: deterministicPreflightRejection || cancellationClass
        ? zeroProviderRetries() : null,
      transportReceiptId,
      transportReceiptPersisted: transportReceiptId ? error.detail?.receiptPersisted ?? null : null,
      transportReceiptPersistenceError: transportReceiptId
        ? strictBoundedString(error.detail?.receiptPersistenceError, 500) : null,
      failureClass: deterministicPreflightRejection
        ? (error.detail?.failureClass || 'policy') : cancellationClass,
      stopReason: cancellationClass,
      actionPreflight: error.detail?.actionPreflight || null,
      errorCode: validation?.code || null,
      validation,
    },
  };
}

function providerRetriesFromReceipt(receipt) {
  return {
    count: receipt.providerRetryCount ?? 0,
    total_delay_ms: receipt.providerRetryDelayMs ?? 0,
    max_attempt: receipt.providerRetryMaxAttempt ?? 0,
    declared_max_retries: receipt.providerDeclaredMaxRetries ?? 0,
    by_error: receipt.providerRetryByError || {},
    by_status: receipt.providerRetryByStatus || {},
    events: receipt.providerRetryEvents || [],
    truncated: receipt.providerRetryEventsTruncated === true,
    observed_events: receipt.providerRetryObservedEvents ?? 0,
    invalid_events: receipt.providerRetryInvalidEvents ?? 0,
    duplicate_events: receipt.providerRetryDuplicateEvents ?? 0,
  };
}

function usageFromTransportReceipt(receipt) {
  if (receipt.tokenUsageSource !== 'provider_reported') return null;
  return {
    input_tokens: receipt.actualInputTokens ?? null,
    output_tokens: receipt.actualOutputTokens ?? null,
    cache_read_input_tokens: receipt.actualCacheReadInputTokens ?? null,
    cache_creation_input_tokens: receipt.actualCacheCreationInputTokens ?? null,
    total_tokens: receipt.actualTotalTokens ?? null,
    thinking_tokens: receipt.actualThinkingTokens ?? null,
    cost_usd: receipt.provider_reported_cost_usd ?? null,
    token_source: 'provider_reported',
    model_usage: receipt.modelUsage || [],
  };
}

async function reconcileCancelledTransportAttempt({ requestId, outerReceiptId, kind, sanitized }) {
  if (!['client_cancelled', 'mcp_deadline_cancelled'].includes(sanitized.failureClass)) return sanitized;
  const deadline = Date.now() + 2000;
  let transportReceipt = null;
  while (Date.now() < deadline && !transportReceipt) {
    const candidate = findReceiptByRequestId(requestId, {
      event: 'bridge_provider_call', provider: kind,
    });
    if (candidate && (!candidate.outerReceiptId || candidate.outerReceiptId === outerReceiptId)) {
      transportReceipt = candidate;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!transportReceipt) return sanitized;
  const supervisorWon = !!transportReceipt.supervisorStopReason;
  const failureClass = supervisorWon
    ? (transportReceipt.failureClass || 'timeout')
    : ['client_cancelled', 'mcp_deadline_cancelled'].includes(transportReceipt.failureClass)
      ? transportReceipt.failureClass : sanitized.failureClass;
  return {
    ...sanitized,
    route: transportReceipt.route || {},
    failureClass,
    stopReason: supervisorWon ? transportReceipt.stopReason : failureClass,
    supervisorStopReason: supervisorWon ? transportReceipt.supervisorStopReason : null,
    cancelled: !supervisorWon,
    timedOut: supervisorWon && transportReceipt.status === 'timed_out',
    modelInvocation: transportReceipt.modelInvocation ?? null,
    tokenUsageSource: transportReceipt.tokenUsageSource || 'unknown',
    usage: usageFromTransportReceipt(transportReceipt),
    providerRetries: providerRetriesFromReceipt(transportReceipt),
    transportReceiptId: transportReceipt.receiptId,
    transportReceiptPersisted: true,
    transportOutputChars: transportReceipt.transportOutputChars ?? null,
    transportOutputHash: transportReceipt.transportOutputHash ?? null,
    progressAtCancellation: transportReceipt.progressAtCancellation || null,
    cleanedOutputUnavailable: transportReceipt.cleanedOutputUnavailable ?? null,
    invocationId: transportReceipt.invocationId || requestId,
    attemptId: transportReceipt.attemptId || `${requestId}:attempt:1`,
    physicalAttemptCount: transportReceipt.physicalAttemptCount ?? 1,
  };
}

async function callProvider({
  kind,
  prompt,
  cwd,
  timeoutMs = TIMEOUT_POLICY.oneShotDefaultMs,
  useCache = true,
  cacheTtlMs,
  parentReceiptId,
  purpose = 'ask_provider',
  signal,
  providerBudget,
  effort,
  maxEffortOverride = false,
}) {
  const requestId = `mcp:${crypto.randomUUID()}`;
  const invocationId = requestId;
  const attemptId = `${requestId}:attempt:1`;
  const outerReceiptId = `rcpt_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  const classification = classifyTask(prompt);
  const ttl = cacheTtlFor(classification, cacheTtlMs);
  const configFingerprint = stableHash({
    config: fs.readFileSync(CLI_CONFIG_PATH, 'utf8'),
    providerIdentity: providerIdentityMaterial(kind),
  });
  const startedAt = Date.now();
  let sanitized;
  let status = 'failed';
  let workspaceAdmission = null;
  if (signal?.aborted) throw signal.reason || new Error('provider call cancelled before admission');
  try {
    const response = await bridgeRequest('/api/workspace/validate', {
      method: 'POST',
      body: { kind, prompt, cwd, requestId },
      timeoutMs: TIMEOUT_POLICY.transportTimeoutMs(timeoutMs),
      signal,
      actionIdentity: true,
    });
    workspaceAdmission = normalizeWorkspaceAdmission(response);
    if (!workspaceAdmission) {
      throw new Error('RelayBridge returned malformed cwd admission identity; provider execution is blocked.');
    }
  } catch (error) {
    ({ sanitized, status } = bridgeFailureResult(error, { kind, signal }));
  }
  const cacheKey = {
    kind,
    prompt,
    cwd: cwd || '',
    configFingerprint,
    purpose,
    providerBudget: providerBudget || null,
    effort: effort || null,
    maxEffortOverride: maxEffortOverride === true,
    cwdIdentityHash: workspaceAdmission?.cwdIdentityHash || null,
    cwdPolicyId: workspaceAdmission?.cwdPolicyId || null,
    bridgeBuildId: workspaceAdmission?.bridgeBuildId || null,
    receiptStoreId: workspaceAdmission?.receiptStoreId || null,
  };
  const cacheKeyHash = stableHash(cacheKey);
  if (!sanitized && useCache && ttl > 0) {
    const cached = readCache(cacheKey, ttl);
    if (cached) {
      const receipt = appendReceipt({
        event: 'provider_call',
        purpose,
        parentReceiptId,
        provider: kind,
        inputHash: stableHash(prompt),
        inputChars: prompt.length,
        estimatedInputTokens: estimateTokens(prompt),
        estimatedOutputTokens: estimateTokens(cached.value?.stdout || ''),
        estimatedTotalTokens: estimateTokens(prompt) + estimateTokens(cached.value?.stdout || ''),
        cacheHit: true,
        modelInvocation: false,
        tokenUsageSource: 'not_invoked',
        providerRetryCount: 0,
        providerRetryDelayMs: 0,
        providerRetryEvents: [],
        providerPermissionDenialCount: 0,
        providerPermissionDenialObserved: 0,
        providerPermissionDenialInvalid: 0,
        providerPermissionDenialsTruncated: false,
        providerPermissionDenialsByTool: {},
        providerPermissionDenials: [],
        resultSubtype: null,
        resultSchemaDisagreement: false,
        providerStopReason: null,
        providerTerminalReason: null,
        providerApiErrorStatus: null,
        requestId,
        invocationId: parentReceiptId || requestId,
        attemptId: requestId,
        durationMs: 0,
        status: 'cached',
        sourceReceiptId: cached.value?.receiptId || null,
        cacheCreatedAt: cached.createdAt,
        cacheKeyHash,
      });
      return {
        ...cached.value,
        cacheHit: true,
        modelInvocation: false,
        usage: null,
        failureClass: null,
        resultSubtype: null,
        resultSchemaDisagreement: false,
        providerStopReason: null,
        providerTerminalReason: null,
        providerApiErrorStatus: null,
        providerPermissionDenials: zeroProviderPermissionDenials(),
        providerNumTurns: null,
        providerDurationMs: null,
        providerApiDurationMs: null,
        providerErrorCount: null,
        providerErrorObserved: null,
        providerErrorInvalid: null,
        providerErrorDiagnosticTruncated: false,
        transportOutputChars: null,
        transportOutputHash: null,
        providerRetries: zeroProviderRetries(),
        transportReceiptId: null,
        transportReceiptPersisted: null,
        transportReceiptPersistenceError: null,
        sourceReceiptId: cached.value?.receiptId || null,
        cacheCreatedAt: cached.createdAt,
        cacheKeyHash,
        receiptId: receipt.receiptId,
        receiptPersistenceError: receipt.receiptPersistenceError || null,
      };
    }
  }

  if (!sanitized) try {
    const response = await bridgeRequest('/api/oneshot', {
      method: 'POST',
      body: {
        kind,
        prompt,
        cwd,
        requestId,
        outerReceiptId,
        expectedCwdIdentityHash: workspaceAdmission.cwdIdentityHash,
        expectedCwdPolicyId: workspaceAdmission.cwdPolicyId,
        timeoutMs: TIMEOUT_POLICY.normalizeOneShotTimeoutMs(timeoutMs),
        providerBudget,
        effort,
        maxEffortOverride,
        dangerous: false,
      },
      timeoutMs: TIMEOUT_POLICY.transportTimeoutMs(timeoutMs),
      signal,
      actionIdentity: true,
    });
    sanitized = sanitizeProviderResponse(response);
    status = providerSucceeded(sanitized) ? 'completed'
      : sanitized.cancelled ? 'cancelled'
        : sanitized.timedOut ? 'timed_out' : 'dropped';
  } catch (error) {
    ({ sanitized, status } = bridgeFailureResult(error, { kind, signal }));
    sanitized = await reconcileCancelledTransportAttempt({
      requestId, outerReceiptId, kind, sanitized,
    });
    status = sanitized.cancelled ? 'cancelled'
      : sanitized.timedOut ? 'timed_out' : status;
  }

  const receipt = appendReceipt({
    receiptId: outerReceiptId,
    event: 'provider_call',
    purpose,
    parentReceiptId,
    provider: kind,
    inputHash: stableHash(prompt),
    inputChars: prompt.length,
    estimatedInputTokens: estimateTokens(prompt),
    estimatedOutputTokens: estimateTokens(sanitized.stdout || ''),
    estimatedTotalTokens: estimateTokens(prompt) + estimateTokens(sanitized.stdout || ''),
    actualInputTokens: sanitized.usage?.input_tokens ?? null,
    actualOutputTokens: sanitized.usage?.output_tokens ?? null,
    actualCacheReadInputTokens: sanitized.usage?.cache_read_input_tokens ?? null,
    actualCacheCreationInputTokens: sanitized.usage?.cache_creation_input_tokens ?? null,
    actualTotalTokens: sanitized.usage?.total_tokens ?? null,
    actualThinkingTokens: sanitized.usage?.thinking_tokens ?? null,
    provider_reported_cost_usd: sanitized.usage?.cost_usd ?? null,
    modelUsage: sanitized.usage?.model_usage ?? [],
    vendorQuota: sanitized.vendorQuota ?? null,
    quotaEvidence: sanitized.quotaEvidence ?? null,
    providerActionRequired: sanitized.providerActionRequired ?? null,
    providerRetryCount: sanitized.providerRetries?.count ?? null,
    providerRetryDelayMs: sanitized.providerRetries?.total_delay_ms ?? null,
    providerRetryMaxAttempt: sanitized.providerRetries?.max_attempt ?? null,
    providerDeclaredMaxRetries: sanitized.providerRetries?.declared_max_retries ?? null,
    providerRetryByError: sanitized.providerRetries?.by_error ?? {},
    providerRetryByStatus: sanitized.providerRetries?.by_status ?? {},
    providerRetryEvents: sanitized.providerRetries?.events ?? [],
    providerRetryEventsTruncated: sanitized.providerRetries?.truncated ?? false,
    providerRetryObservedEvents: sanitized.providerRetries?.observed_events ?? null,
    providerRetryInvalidEvents: sanitized.providerRetries?.invalid_events ?? null,
    providerRetryDuplicateEvents: sanitized.providerRetries?.duplicate_events ?? null,
    transportRetryCount: sanitized.transportRetryCount ?? 0,
    resultSubtype: sanitized.resultSubtype ?? null,
    resultSchemaDisagreement: sanitized.resultSchemaDisagreement === true,
    providerStopReason: sanitized.providerStopReason ?? null,
    providerTerminalReason: sanitized.providerTerminalReason ?? null,
    stopReason: sanitized.stopReason ?? null,
    supervisorStopReason: sanitized.supervisorStopReason ?? null,
    providerTimeoutSource: sanitized.providerTimeoutSource ?? null,
    providerBudget: sanitized.providerBudget ?? providerBudget ?? null,
    providerBudgetEnforcement: sanitized.providerBudgetEnforcement ?? null,
    providerApiErrorStatus: sanitized.providerApiErrorStatus ?? null,
    providerPermissionDenialCount: sanitized.providerPermissionDenials?.count ?? null,
    providerPermissionDenialObserved: sanitized.providerPermissionDenials?.observed ?? null,
    providerPermissionDenialInvalid: sanitized.providerPermissionDenials?.invalid ?? null,
    providerPermissionDenialsTruncated: sanitized.providerPermissionDenials?.truncated ?? false,
    providerPermissionDenialsByTool: sanitized.providerPermissionDenials?.byTool ?? {},
    providerPermissionDenials: sanitized.providerPermissionDenials?.retained ?? [],
    providerNumTurns: sanitized.providerNumTurns ?? null,
    providerDurationMs: sanitized.providerDurationMs ?? null,
    providerApiDurationMs: sanitized.providerApiDurationMs ?? null,
    providerErrorCount: sanitized.providerErrorCount ?? null,
    providerErrorObserved: sanitized.providerErrorObserved ?? null,
    providerErrorInvalid: sanitized.providerErrorInvalid ?? null,
    providerErrorDiagnosticTruncated: sanitized.providerErrorDiagnosticTruncated ?? false,
    partialResult: sanitized.partialResult === true,
    failureSentinel: sanitized.failureSentinel ?? null,
    failureSentinelSource: sanitized.failureSentinelSource ?? null,
    partialDiagnosticChars: sanitized.partialDiagnosticChars ?? 0,
    partialDiagnosticHash: sanitized.partialResult
      ? sanitized.partialDiagnosticSha256 : null,
    partialDiagnosticTruncated: sanitized.partialDiagnosticTruncated === true,
    progressAtCancellation: sanitized.progressAtCancellation || null,
    cleanedOutputUnavailable: sanitized.cleanedOutputUnavailable ?? null,
    transportOutputChars: sanitized.transportOutputChars ?? null,
    transportOutputHash: sanitized.transportOutputHash ?? null,
    modelInvocation: sanitized.modelInvocation ?? null,
    tokenUsageSource: sanitized.tokenUsageSource || sanitized.usage?.token_source
      || (sanitized.modelInvocation === false ? 'not_invoked'
        : sanitized.modelInvocation === null ? 'unknown' : 'chars_div_4'),
    requestId,
    invocationId,
    attemptId,
    physicalAttemptCount: sanitized.physicalAttemptCount
      ?? (sanitized.modelInvocation === false ? 0 : sanitized.modelInvocation === true ? 1 : null),
    transportReceiptId: sanitized.transportReceiptId || null,
    model: sanitized.route?.resolved_model_identity || sanitized.route?.requested_model || null,
    cacheHit: false,
    durationMs: Date.now() - startedAt,
    status,
    route: sanitized.route,
    actionPreflight: sanitized.actionPreflight || null,
    errorCode: sanitized.errorCode || null,
    validation: sanitized.validation || null,
    exitCode: sanitized.exitCode,
    failureClass: sanitized.cancelled ? (sanitized.failureClass || 'client_cancelled')
      : sanitized.failureClass || (sanitized.rateLimited ? 'rate_limit'
      : sanitized.budgetExceeded ? 'budget'
        : sanitized.authFailed ? 'auth'
          : sanitized.timedOut ? 'timeout'
            : sanitized.permissionDenied ? 'policy'
              : sanitized.admissionLimited ? 'admission_limit'
                : status === 'completed' ? null : 'provider_error'),
    cacheKeyHash,
  });
  const output = {
    ...sanitized,
    cacheHit: false,
    cacheKeyHash,
    receiptId: receipt.receiptId,
    receiptPersistenceError: receipt.receiptPersistenceError || null,
  };
  const { policy } = loadRoutingData();
  let cachePersistenceError = null;
  if (
    useCache && ttl > 0 && status === 'completed' &&
    JSON.stringify(output).length <= Number(policy.cache.maxEntryChars || 100000)
  ) {
    try { writeCache(cacheKey, output); }
    catch (error) { cachePersistenceError = error?.message || String(error); }
  }
  return { ...output, cachePersistenceError };
}

function eligibleOneShotKinds(route, config, { selectedOnly = false, allowedKinds = [] } = {}) {
  const seen = new Set();
  const allowed = new Set(allowedKinds);
  const candidates = selectedOnly ? [...route.selected] : [...route.selected, ...route.candidates];
  return candidates.filter((candidate) => {
    if (seen.has(candidate.kind)) return false;
    seen.add(candidate.kind);
    if (allowed.size && !allowed.has(candidate.kind)) return false;
    const entry = config[candidate.kind];
    return candidate.policyScore >= 0 && entry && Array.isArray(entry.oneshot_safe) && entry.oneshot_safe.length;
  });
}

function rolePrompt(task, role, classification, policy) {
  const cap = policy.tiers[classification.tier].maxInputChars;
  const bounded = clip(task, cap);
  const roleInstructions = {
    primary: 'Propose the strongest concrete solution and state assumptions and verification steps.',
    critic: 'Independently find failure modes, unsupported assumptions, security risks, and cheaper alternatives.',
    researcher: 'Identify which claims need current primary sources or live evidence and specify how to verify them.',
    verifier: 'Define deterministic acceptance tests, qualification boundaries, and escalation conditions.',
    chair: 'Synthesize the independent responses without hiding disagreements. Prefer evidence and executable gates.',
  };
  return [
    `You are the ${role} in a read-only RelayBridge advisory committee.`,
    'Do not edit files, run tools, or claim that a proposal was implemented. Return concise analysis only.',
    roleInstructions[role] || roleInstructions.primary,
    `Task tier: ${classification.tier}. Tags: ${classification.tags.join(', ')}.`,
    bounded.truncated ? `The task was bounded from ${bounded.originalChars} characters for this seat.` : '',
    '',
    'TASK:',
    bounded.text,
  ].filter(Boolean).join('\n');
}

function parseChairAssessment(text) {
  const raw = String(text || '').trim();
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(unfenced.slice(start, end + 1));
    if (!['agreement', 'mixed', 'disagreement'].includes(parsed.verdict)) return null;
    const confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
    if (!Array.isArray(parsed.agreements) || !Array.isArray(parsed.dissent)) return null;
    if (typeof parsed.recommendation !== 'string' || !parsed.recommendation.trim()) return null;
    const agreements = parsed.agreements.map((item) => String(item).trim()).filter(Boolean).slice(0, 20);
    const dissent = parsed.dissent.map((item) => String(item).trim()).filter(Boolean).slice(0, 20);
    if (parsed.verdict === 'agreement' && !agreements.length) return null;
    return {
      verdict: parsed.verdict,
      confidence,
      agreements,
      dissent,
      recommendation: parsed.recommendation.trim().slice(0, 8000),
    };
  } catch {
    return null;
  }
}

function remainingTime(deadlineAt, floorMs = 1000) {
  return Math.max(floorMs, deadlineAt - Date.now());
}


// Derive a human-readable range list from a zod object schema, so tool
// descriptions cannot drift from the constraints actually enforced.
// Returns e.g. "maxChars 30000-200000, maxSessions 0-20" or null.
export function describeNumericBounds(schema) {
  if (!schema || typeof schema !== 'object') return null;
  const shape = typeof schema.shape === 'object' ? schema.shape
    : (typeof schema._def?.shape === 'function' ? schema._def.shape() : schema._def?.shape);
  if (!shape) return null;
  const parts = [];
  for (const [key, field] of Object.entries(shape)) {
    const b = numericBoundsOf(field);
    if (!b) continue;
    if (b.min !== null && b.max !== null) parts.push(`${key} ${b.min}-${b.max}`);
    else if (b.min !== null) parts.push(`${key} >= ${b.min}`);
    else if (b.max !== null) parts.push(`${key} <= ${b.max}`);
  }
  return parts.length ? parts.join(', ') : null;
}

// Walks .default()/.optional() wrappers to find the underlying number checks.
function numericBoundsOf(field, depth = 0) {
  if (!field || depth > 6) return null;
  const def = field._def || {};
  const inner = def.innerType || def.schema || def.type;
  const typeName = def.typeName || def.type;
  const isNumber = typeName === 'ZodNumber' || typeName === 'number';
  if (!isNumber) return inner && typeof inner === 'object' ? numericBoundsOf(inner, depth + 1) : null;

  let min = null, max = null;
  // zod v3 exposes _def.checks; v4 exposes checks with _zod.def
  for (const check of def.checks || []) {
    const c = check?._zod?.def || check;
    const kind = c.kind || c.check;
    const value = c.value ?? c.minimum ?? c.maximum;
    if (kind === 'min' || kind === 'greater_than' || c.minimum !== undefined) min = c.minimum ?? value;
    if (kind === 'max' || kind === 'less_than' || c.maximum !== undefined) max = c.maximum ?? value;
  }
  return (min === null && max === null) ? null : { min, max };
}

export function buildServer() {
  const server = new McpServer({ name: 'relaybridge', version: PACKAGE.version }, {
    instructions: 'Read before acting: call get_context_bundle when taking over existing work, then use bridge_status, list_providers, and route_preview as needed. AI provider one-shots (ask_provider, route_and_ask, run_committee) always force dangerous:false, so they consume subscription quotas or local compute in the provider CLI\'s own safe/headless mode. Terminals are different: start_safe_session only forces the vendor bypass flags off, and start_safe_session(kind="powershell") opens a real host PowerShell shell running with your account\'s full privileges. Anything sent through send_session_input executes on the host with no sandbox and no filesystem confinement, so it needs host approval and human review. The /api/exec route, provider installs, and the global full-permissions toggle are not exposed as tools. Routing scores are operator preferences, not universal model-quality claims; use receipts and preserve the human gate for high-stakes work.',
    capabilities: { tools: {}, resources: {} },
    cacheHints: {
      'tools/list': { ttlMs: 60000, cacheScope: 'private' },
      'resources/list': { ttlMs: 60000, cacheScope: 'private' },
    },
  });

  // Issue #26: numeric bounds reach the JSON Schema (the SDK emits zod's
  // .min()/.max() as minimum/maximum), but many clients surface only the
  // human-readable description to the model. A caller then picks a plausible
  // value like maxChars=12000, and the request is rejected by validation
  // before any work is done — a wasted round trip that the description could
  // have prevented.
  //
  // Rather than hand-maintaining ranges in 30 description strings, where they
  // would immediately drift from the schema, derive them FROM the schema at
  // registration. The schema stays the single source of truth, and a new
  // bounded parameter cannot be added without its range being documented.
  const registerToolRaw = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) => {
    try {
      const ranges = describeNumericBounds(config?.inputSchema);
      if (ranges && config?.description && !config.description.includes('Accepted ranges:')) {
        config = { ...config, description: `${config.description} Accepted ranges: ${ranges}.` };
      }
    } catch { /* documentation must never block registration */ }
    return registerToolRaw(name, config, handler);
  };

  server.registerTool('bridge_status', {
    title: 'Bridge status',
    description: 'Inspect RelayBridge health, CLI readiness, instance identity, sessions, and version without changing state.',
    inputSchema: z.object({ includeDiagnostics: z.boolean().default(true) }),
    annotations: READ_ONLY,
  }, safeHandler(async ({ includeDiagnostics }, context) => {
    const live = await health();
    const diagnostics = includeDiagnostics ? await getDiagnostics(context?.mcpReq?.signal) : {};
    return result({ ok: true, baseUrl: BASE_URL.href, health: live, providers: providerSummaries(diagnostics) });
  }));

  server.registerTool('list_providers', {
    title: 'List provider capability registry',
    description: 'List configured providers, live readiness, cost/privacy class, model identity when known, qualification receipts, provenance, references, and limitations.',
    inputSchema: z.object({ includeCandidates: z.boolean().default(false) }),
    annotations: READ_ONLY,
  }, safeHandler(async ({ includeCandidates }, context) => {
    const diagnostics = await getDiagnostics(context?.mcpReq?.signal);
    const { evidence } = loadRoutingData();
    return result({
      updatedAt: evidence.updatedAt,
      qualificationPolicy: evidence.qualificationPolicy,
      providers: providerSummaries(diagnostics),
      ...(includeCandidates ? { candidateIntegrations: evidence.candidateIntegrations } : {}),
    });
  }));

  server.registerTool('route_preview', {
    title: 'Preview deterministic task routing',
    description: 'Classify a task and preview an auditable local/cheap-first route without calling any model.',
    inputSchema: z.object({
      task: z.string().min(1).max(100000),
      preferredProviders: z.array(z.string()).max(8).default([]),
      excludedProviders: z.array(z.string()).max(8).default([]),
      localOnly: z.boolean().default(false),
      maxProviders: z.number().int().min(1).max(4).optional(),
      committeeMode: z.enum(['advisory', 'consensus']).default('advisory'),
      dangerous: z.boolean().default(false).describe('preview the explicit writer route instead of normal safe routing'),
      acknowledgeFilesystemWrites: z.boolean().default(false).describe('required with dangerous=true; confirms persistent writes are authorized'),
    }),
    annotations: AUDITED_READ,
  }, safeHandler(async (args, context) => {
    const diagnostics = await getDiagnostics(context?.mcpReq?.signal);
    if (args.dangerous !== args.acknowledgeFilesystemWrites) {
      return result({ ok: false, blocked: true, error: 'dangerous=true requires acknowledgeFilesystemWrites=true, and acknowledgement is invalid for safe planning' }, { isError: true });
    }
    const route = routeTask({ ...args, diagnostics });
    const receipt = appendReceipt({
      event: 'route_preview',
      routeId: route.routeId,
      taskHash: route.classification.taskHash,
      tier: route.classification.tier,
      tags: route.classification.tags,
      selectedProviders: route.selected.map((item) => item.kind),
      humanGateRequired: route.humanGateRequired,
      status: 'previewed',
    });
    return result({ ...route, receiptId: receipt.receiptId });
  }));

  server.registerTool('plan_task', {
    title: 'Plan a task: company, model, and effort',
    description: 'Given a task description, returns the cheapest capable execution plan: which company/provider, which model inside it, and how much reasoning effort — plus fallbacks and why. Call this BEFORE delegating anything you are unsure about. It exists to stop frontier seats being spent on mechanical edits and max-effort reasoning being spent on arithmetic.',
    inputSchema: z.object({
      task: z.string().min(1).describe('what needs doing, in a sentence or two'),
      effort: z.enum(['minimal', 'low', 'medium', 'high', 'max']).optional().describe('override the effort the tier would pick'),
      kind: z.string().optional().describe('force a specific provider and plan around it'),
      dangerous: z.boolean().default(false).describe('plan an explicit writer-capable provider invocation'),
      acknowledgeFilesystemWrites: z.boolean().default(false).describe('required with dangerous=true; confirms persistent writes are authorized'),
    }),
    annotations: READ_ONLY,
  }, safeHandler(async ({ task, effort, kind, dangerous, acknowledgeFilesystemWrites }) => {
    const plan = await bridgeRequest('/api/plan', {
      method: 'POST',
      body: { task, effort: effort ?? null, kind: kind ?? null, dangerous, acknowledgeFilesystemWrites },
      timeoutMs: 20000,
    });
    return result(plan);
  }));

  server.registerTool('list_models', {
    title: 'List discovered models per provider',
    description: 'Model registry discovered from each CLI at boot: models a provider can actually run, each with a weight tier and a best-at note, plus warnings for configured pins the account no longer offers. Set refresh to re-probe after installing or upgrading a CLI.',
    inputSchema: z.object({ refresh: z.boolean().default(false) }),
    annotations: READ_ONLY,
  }, safeHandler(async ({ refresh }) => {
    const registry = await bridgeRequest(refresh ? '/api/models?refresh=1' : '/api/models', { timeoutMs: refresh ? 60000 : 15000 });
    return result(registry);
  }));

  server.registerTool('list_active_runs', {
    title: 'Inspect live provider runs',
    description: 'Supervision snapshots for in-flight provider calls: phase (streaming/working/quiet/suspect_loop), idle time, CPU evidence, and which limit fires next. Use this to tell a long-thinking run from a wedged one instead of cancelling on suspicion.',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
  }, safeHandler(async () => {
    const runs = await bridgeRequest('/api/runs/active', { timeoutMs: 10000 });
    return result(runs);
  }));

  server.registerTool('bridge_activity', {
    title: 'Read bridge activity telemetry',
    description: 'Recent bridge API calls from every client (dashboard UI and this MCP server), with method, path, status, duration, and provider kind. The same log the dashboard Activity panel shows — both sides see the same picture.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(500).default(120), sinceId: z.number().int().min(0).default(0) }),
    annotations: READ_ONLY,
  }, safeHandler(async ({ limit, sinceId }) => {
    const activity = await bridgeRequest(`/api/telemetry?limit=${limit}&sinceId=${sinceId}`, { timeoutMs: 10000 });
    return result(activity);
  }));

  server.registerTool('list_sessions', {
    title: 'List terminal sessions',
    description: 'List current PowerShell and AI CLI terminal sessions owned by the singleton bridge.',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
  }, safeHandler(async () => result({ sessions: await bridgeRequest('/api/sessions') })));

  server.registerTool('read_session_output', {
    title: 'Read terminal output',
    description: 'Read a bounded tail of an existing terminal session buffer.',
    inputSchema: z.object({ sessionId: z.string().min(1).max(64), tailChars: z.number().int().min(1).max(65536).default(12000) }),
    annotations: READ_ONLY,
  }, safeHandler(async ({ sessionId, tailChars }) => {
    const data = await bridgeRequest(`/api/sessions/${encodeURIComponent(sessionId)}/buffer`);
    const text = String(data.text || '');
    return result({ sessionId, exited: data.exited, exitCode: data.exitCode, text: text.slice(-tailChars), originalChars: text.length });
  }));

  server.registerTool('list_collabs', {
    title: 'List saved collaborations',
    description: 'List saved RelayBridge collaboration rooms and message counts.',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
  }, safeHandler(async () => result(await bridgeRequest('/api/collabs'))));

  server.registerTool('read_collab', {
    title: 'Read a saved collaboration',
    description: 'Read bounded recent messages and shared context from a saved collaboration room.',
    inputSchema: z.object({
      collabId: z.string().min(1).max(128),
      maxMessages: z.number().int().min(1).max(100).default(30),
      offsetFromEnd: z.number().int().min(0).default(0),
      maxChars: z.number().int().min(1000).max(100000).default(30000),
    }),
    annotations: READ_ONLY,
  }, safeHandler(async ({ collabId, maxMessages, offsetFromEnd, maxChars }) => {
    const data = await bridgeRequest(`/api/collabs/${encodeURIComponent(collabId)}`);
    const original = Array.isArray(data.transcript) ? data.transcript : [];
    const end = Math.max(0, original.length - offsetFromEnd);
    const start = Math.max(0, end - maxMessages);
    const transcript = original.slice(start, end);
    const bounded = boundTranscript(transcript, maxChars);
    const sharedContext = clip(data.sharedContext || '', Math.floor(maxChars / 3));
    return result({
      id: data.id,
      name: data.name,
      project: data.project,
      participants: data.participants,
      sharedContext: sharedContext.text,
      sharedContextChars: sharedContext.originalChars,
      sharedContextTruncated: sharedContext.truncated,
      transcript: bounded.items,
      totalMessages: original.length,
      range: { start, end, offsetFromEnd },
      transcriptTruncated: bounded.truncated || start > 0 || end < original.length,
      nextOlderOffset: start > 0 ? offsetFromEnd + transcript.length : null,
      updatedAt: data.updatedAt,
    });
  }));

  server.registerTool('list_projects', {
    title: 'List bridge projects',
    description: 'List project labels saved by the bridge collaboration UI.',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
  }, safeHandler(async () => result(await bridgeRequest('/api/projects'))));

  server.registerTool('list_runs', {
    title: 'List routing and committee runs',
    description: 'Page through persisted MCP routing/committee run summaries without repeating provider calls.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(25), offset: z.number().int().min(0).default(0) }),
    annotations: READ_ONLY,
  }, safeHandler(async ({ limit, offset }) => result(listRunPage(limit, offset))));

  server.registerTool('get_run', {
    title: 'Read a routing or committee run',
    description: 'Read one persisted run, including members, partial failures, routes, and receipt IDs.',
    inputSchema: z.object({ runId: z.string().min(1).max(128) }),
    annotations: READ_ONLY,
  }, safeHandler(async ({ runId }) => {
    const run = readRun(runId);
    if (!run) throw new Error('run not found');
    return result(run);
  }));

  server.registerTool('list_receipts', {
    title: 'List delegation receipts',
    description: 'Page through append-only routing, provider, cache, fallback, context, and committee receipts. Newest first. Offsets are kept for existing clients but shift whenever a receipt is appended; pass the returned nextCursor for a stable page boundary.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0),
      cursor: z.string().min(1).max(512).optional(),
    }),
    annotations: READ_ONLY,
  }, safeHandler(async ({ limit, offset, cursor }) => {
    if (cursor === undefined) return result(listReceiptPage(limit, offset));
    // A cursor is an exact append-only position, so offset is meaningless with
    // it and is rejected rather than silently ignored.
    if (offset) throw new Error('pass either cursor or offset, not both');
    const page = listReceiptCursorPage(limit, cursor);
    if (!page.cursorResolved) {
      return result({
        ...page,
        ok: false,
        error: 'the receipt file this cursor points at is no longer present; restart from the newest page',
      }, { isError: true });
    }
    return result({ ...page, ok: true, offset: null, nextOffset: null });
  }));

  server.registerTool('get_receipt', {
    title: 'Read one delegation receipt',
    description: 'Dereference a single receipt ID, including the sourceReceiptId recorded on a cache hit and the parentReceiptId chain recorded by route_and_ask and run_committee.',
    inputSchema: z.object({
      receiptId: z.string().min(1).max(128),
      followSource: z.boolean().default(false),
    }),
    annotations: READ_ONLY,
  }, safeHandler(async ({ receiptId, followSource }) => {
    const receipt = readReceipt(receiptId);
    if (!receipt) throw new Error('receipt not found; it may predate retention or the ID may be malformed');
    const chain = [];
    if (followSource) {
      const seen = new Set([receipt.receiptId]);
      let next = receipt.sourceReceiptId || receipt.parentReceiptId || null;
      while (next && !seen.has(next) && chain.length < 16) {
        seen.add(next);
        const linked = readReceipt(next);
        if (!linked) {
          chain.push({ receiptId: next, resolved: false });
          break;
        }
        chain.push({ ...linked, resolved: true });
        next = linked.sourceReceiptId || linked.parentReceiptId || null;
      }
    }
    return result({ receipt, chain, chainTruncated: chain.length >= 16 });
  }));

  server.registerTool('get_context_bundle', {
    title: 'Build an AI handoff context bundle',
    description: 'Return one bounded, provenance-aware snapshot of bridge health, providers, active work, terminal tails, collaborations, projects, recent runs, receipts, and the detail tools needed to continue. This is the preferred first call when an AI takes over an existing RelayBridge workspace.',
    inputSchema: z.object({
      includeDiagnostics: z.boolean().default(true),
      includeSessionOutput: z.boolean().default(true),
      sessionTailChars: z.number().int().min(100).max(12000).default(2000),
      maxSessions: z.number().int().min(0).max(20).default(8),
      includeCollabMessages: z.boolean().default(true),
      maxCollabs: z.number().int().min(0).max(20).default(5),
      maxMessagesPerCollab: z.number().int().min(0).max(50).default(8),
      recentRuns: z.number().int().min(0).max(100).default(10),
      recentReceipts: z.number().int().min(0).max(200).default(20),
      maxChars: z.number().int().min(30000).max(200000).default(90000),
    }),
    annotations: AUDITED_READ,
  }, safeHandler(async (args, context) => {
    const bundle = await buildContextBundle({ ...args, signal: context?.mcpReq?.signal });
    const receipt = appendReceipt({
      event: 'context_bundle',
      bundleId: bundle.bundleId,
      contentSha256: bundle.contentSha256,
      status: bundle.sectionErrors.length || bundle.transfer.truncated ? 'partial' : 'completed',
      actualChars: bundle.transfer.actualChars,
      truncated: bundle.transfer.truncated,
      omissions: bundle.transfer.omissions,
      registryFingerprints: bundle.registries.fingerprints,
    });
    bundle.receiptId = receipt.receiptId;
    bundle.receiptPersisted = !receipt.receiptPersistenceError;
    bundle.receiptPersistenceError = receipt.receiptPersistenceError || null;
    bundle.transfer.actualChars = JSON.stringify(bundle).length;
    bundle.transfer.actualChars = JSON.stringify(bundle).length;
    bundle.transfer.withinBudget = bundle.transfer.actualChars <= args.maxChars;
    const provenance = bundle.receiptPersisted
      ? `receipt ${bundle.receiptId}`
      : `receipt ${bundle.receiptId} WAS NOT PERSISTED: ${bundle.receiptPersistenceError}`;
    const omitted = bundle.transfer.truncated
      ? ` Omitted: ${bundle.transfer.omissions.join('; ')}.`
      : '';
    return result(bundle, {
      textOverride: `RelayBridge context bundle ${bundle.bundleId} is in structuredContent (${bundle.transfer.actualChars} characters; ${provenance}).${omitted}`,
    });
  }));

  server.registerTool('start_bridge', {
    title: 'Start RelayBridge',
    description: 'Start the singleton bridge only if it is not already healthy. Uses a lock to prevent two MCP clients racing for the port.',
    inputSchema: z.object({}),
    annotations: ACTION,
  }, safeHandler(async () => result(await startBridge())));

  server.registerTool('restart_bridge', {
    title: 'Restart RelayBridge',
    description: 'Gracefully end current terminal sessions, restart the singleton bridge, and wait for the new instance to become healthy.',
    inputSchema: z.object({ confirmation: z.literal('restart RelayBridge') }),
    annotations: DESTRUCTIVE,
  }, safeHandler(async () => result(await restartBridge())));

  server.registerTool('stop_bridge', {
    title: 'Stop RelayBridge',
    description: 'Gracefully stop the bridge and every terminal session it owns.',
    inputSchema: z.object({ confirmation: z.literal('stop RelayBridge') }),
    annotations: DESTRUCTIVE,
  }, safeHandler(async () => result(await stopBridge())));

  server.registerTool('start_safe_session', {
    title: 'Start a terminal session with bypass flags off',
    description: 'Start a PowerShell or AI CLI terminal with the vendor dangerous/full-permission flags forced off, independent of the sticky browser toggle. This is not a sandbox: kind="powershell" opens a real host PowerShell shell with your account\'s privileges, and every kind runs as a normal host process under RELAYBRIDGE_ALLOWED_ROOTS only for its starting directory. Nothing executes until send_session_input is approved.',
    inputSchema: z.object({ kind: z.string().min(1).max(64), cwd: z.string().max(1000).optional(), label: z.string().max(100).optional() }),
    annotations: { ...ACTION, openWorldHint: true },
  }, safeHandler(async ({ kind, cwd, label }) => {
    const session = await bridgeRequest('/api/sessions', { method: 'POST', body: { kind, cwd, label, dangerous: false }, actionIdentity: true });
    const receipt = appendReceipt({ event: 'session_start', sessionId: session.id, provider: kind, cwd: session.cwd, dangerous: false, status: 'started' });
    return result({ session, receiptId: receipt.receiptId });
  }));

  server.registerTool('send_session_input', {
    title: 'Send terminal input',
    description: 'Send bounded text to an existing terminal. For a PowerShell session this executes the text as a real host command with your account\'s privileges and no sandbox; for an AI CLI session it drives that CLI interactively. Always requires host approval and human review.',
    inputSchema: z.object({ sessionId: z.string().min(1).max(64), data: z.string().min(1).max(8192), appendNewline: z.boolean().default(true) }),
    annotations: { ...DESTRUCTIVE, openWorldHint: true },
  }, safeHandler(async ({ sessionId, data, appendNewline }) => {
    const sent = data + (appendNewline ? '\r' : '');
    const response = await bridgeRequest(`/api/sessions/${encodeURIComponent(sessionId)}/input`, { method: 'POST', body: { data: sent }, actionIdentity: true });
    const receipt = appendReceipt({ event: 'session_input', sessionId, inputHash: stableHash(data), inputChars: data.length, appendNewline, status: response.ok ? 'sent' : 'rejected' });
    return result({ ...response, sessionId, receiptId: receipt.receiptId });
  }));

  server.registerTool('stop_session', {
    title: 'Stop a terminal session',
    description: 'Terminate and remove one bridge-owned terminal session.',
    inputSchema: z.object({ sessionId: z.string().min(1).max(64) }),
    annotations: { ...DESTRUCTIVE, idempotentHint: true },
  }, safeHandler(async ({ sessionId }) => {
    const response = await bridgeRequest(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', actionIdentity: true });
    const receipt = appendReceipt({ event: 'session_stop', sessionId, status: 'stopped' });
    return result({ ...response, sessionId, receiptId: receipt.receiptId });
  }));

  server.registerTool('ask_provider', {
    title: 'Ask one provider safely',
    description: 'Run one bounded, non-agentic provider turn with dangerous:false forced, available route metadata, cache controls, quota/failure signals, and an append-only receipt. The provider CLI runs in its own safe/headless mode, which is a vendor-side restriction rather than an OS sandbox. Hosted CLIs may not reveal final model revisions, usage, plan, or provider request IDs.',
    inputSchema: z.object({
      kind: z.string().min(1).max(64),
      prompt: z.string().min(1).max(100000),
      cwd: z.string().max(1000).optional(),
      timeoutMs: z.number().int().min(TIMEOUT_POLICY.minimumMs).max(TIMEOUT_POLICY.oneShotMaxMs).default(TIMEOUT_POLICY.oneShotDefaultMs),
      useCache: z.boolean().default(true),
      cacheTtlMs: z.number().int().min(0).max(86400000).optional(),
      providerBudget: PROVIDER_BUDGET_SCHEMA.optional(),
      effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
      maxEffortOverride: z.boolean().default(false),
      acknowledgeHumanGate: z.boolean().default(false),
    }),
    annotations: EXTERNAL_READ,
  }, safeHandler(async (args, context) => {
    const classification = classifyTask(args.prompt);
    const { policy } = loadRoutingData();
    const gateReasons = classification.tags.filter((tag) => policy.neverAutoExecuteTags.includes(tag));
    if (gateReasons.length && !args.acknowledgeHumanGate) {
      return result({
        ok: false,
        blocked: true,
        classification,
        humanGateReasons: gateReasons,
        error: 'High-stakes provider call requires acknowledgeHumanGate=true and remains advisory.',
      }, { isError: true });
    }
    return result(await callProvider({ ...args, signal: context?.mcpReq?.signal }));
  }));

  server.registerTool('route_and_ask', {
    title: 'Route and ask with bounded escalation',
    description: 'Apply deterministic routing, call the first eligible safe provider, and escalate only on typed failure. High-stakes routes require explicit acknowledgement.',
    inputSchema: z.object({
      task: z.string().min(1).max(100000),
      cwd: z.string().max(1000).optional(),
      preferredProviders: z.array(z.string()).max(8).default([]),
      excludedProviders: z.array(z.string()).max(8).default([]),
      localOnly: z.boolean().default(false),
      maxEscalations: z.number().int().min(0).max(3).default(2),
      timeoutMs: z.number().int().min(TIMEOUT_POLICY.minimumMs).max(TIMEOUT_POLICY.oneShotMaxMs).default(TIMEOUT_POLICY.oneShotDefaultMs),
      useCache: z.boolean().default(true),
      acknowledgeHumanGate: z.boolean().default(false),
      allowModelForDeterministic: z.boolean().default(false),
      allowInputTruncation: z.boolean().default(false),
      providerBudget: PROVIDER_BUDGET_SCHEMA.optional(),
      effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
      maxEffortOverride: z.boolean().default(false),
    }),
    annotations: EXTERNAL_READ,
  }, safeHandler(async (args, context) => {
    const signal = context?.mcpReq?.signal;
    const requestedDeadlineAt = Date.now() + args.timeoutMs;
    const diagnostics = await getDiagnostics(signal, remainingTime(requestedDeadlineAt, 1));
    const route = routeTask({
      ...args,
      diagnostics,
      excludedProviders: [...args.excludedProviders, 'powershell'],
      maxProviders: 4,
    });
    if (route.humanGateRequired && !args.acknowledgeHumanGate) {
      return result({ ok: false, blocked: true, route, error: 'High-stakes route requires acknowledgeHumanGate=true and remains advisory.' }, { isError: true });
    }
    if (route.primaryTag === 'deterministic' && route.classification.tier === 'utility' && !args.allowModelForDeterministic) {
      const receipt = appendReceipt({
        event: 'route_execute',
        routeId: route.routeId,
        taskHash: route.classification.taskHash,
        status: 'deterministic_gate',
      });
      return result({
        ok: false,
        blocked: true,
        deterministicGate: true,
        route,
        receiptId: receipt.receiptId,
        recommendation: 'Use the host deterministic shell/file/process tool. Set allowModelForDeterministic=true only when interpretation is actually needed.',
      });
    }
    const { policy } = loadRoutingData();
    const tierPolicy = policy.tiers[route.classification.tier];
    const boundedTask = clip(args.task, tierPolicy.maxInputChars);
    if (boundedTask.truncated && !args.allowInputTruncation) {
      const receipt = appendReceipt({
        event: 'route_execute',
        routeId: route.routeId,
        taskHash: route.classification.taskHash,
        status: 'input_budget_gate',
        inputChars: args.task.length,
        maxInputChars: tierPolicy.maxInputChars,
      });
      return result({
        ok: false,
        blocked: true,
        inputBudgetExceeded: true,
        route,
        receiptId: receipt.receiptId,
        inputChars: args.task.length,
        maxInputChars: tierPolicy.maxInputChars,
        recommendation: 'Reduce the task/context or explicitly set allowInputTruncation=true.',
      }, { isError: true });
    }
    const config = loadCliConfig();
    const tierEscalations = Number.isInteger(tierPolicy.maxEscalations) ? tierPolicy.maxEscalations : 1;
    const candidates = eligibleOneShotKinds(route, config).slice(0, Math.min(args.maxEscalations, tierEscalations) + 1);
    const deadlineAt = Math.min(requestedDeadlineAt, Date.now() + tierPolicy.defaultTimeoutMs);
    const rootReceipt = appendReceipt({ event: 'route_execute', routeId: route.routeId, taskHash: route.classification.taskHash, candidates: candidates.map((item) => item.kind), status: 'started' });
    let run = writeRun({
      mode: 'route_and_ask',
      status: 'running',
      taskHash: route.classification.taskHash,
      route,
      members: [],
      parentReceiptId: rootReceipt.receiptId,
      deadlineAt: new Date(deadlineAt).toISOString(),
    });
    const attempts = [];
    for (const candidate of candidates) {
      if (signal?.aborted || Date.now() >= deadlineAt) break;
      const response = await callProvider({
        kind: candidate.kind,
        prompt: boundedTask.text,
        cwd: args.cwd,
        timeoutMs: remainingTime(deadlineAt),
        useCache: args.useCache,
        parentReceiptId: rootReceipt.receiptId,
        purpose: 'route_and_ask',
        signal,
        providerBudget: args.providerBudget,
        effort: args.effort,
        maxEffortOverride: args.maxEffortOverride,
      });
      attempts.push(response);
      run = writeRun({ ...run, status: 'running', members: attempts });
      if (providerSucceeded(response)) break;
      // A cwd policy rejection is deterministic and provider-independent.
      // Escalating the unchanged request would only create more zero-invocation
      // receipts; the operator must correct or explicitly enroll the cwd first.
      if (response.modelInvocation === false
        && response.failureClass === 'validation'
        && [CWD_OUTSIDE_ALLOWED_ROOTS, CWD_IDENTITY_CHANGED]
          .includes(response.errorCode)) break;
      if (response.failureClass === 'token_budget' || response.stopReason === 'token_budget') break;
      if (signal?.aborted) break;
    }
    const winner = attempts.find(providerSucceeded) || null;
    const cancelled = !!signal?.aborted;
    const deadlineExceeded = !cancelled && !winner && Date.now() >= deadlineAt;
    const status = cancelled ? 'cancelled' : deadlineExceeded ? 'timed_out' : winner ? 'completed' : 'failed';
    run = writeRun({
      ...run,
      mode: 'route_and_ask',
      status,
      taskHash: route.classification.taskHash,
      route,
      members: attempts,
      parentReceiptId: rootReceipt.receiptId,
    });
    const finalReceipt = appendReceipt({ event: 'route_execute', parentReceiptId: rootReceipt.receiptId, routeId: route.routeId, runId: run.runId, status: run.status, selectedProvider: winner?.kind || null });
    return result({
      ok: !!winner && !cancelled,
      status,
      cancelled,
      deadlineExceeded,
      route,
      winner,
      attempts,
      runId: run.runId,
      runPersistenceError: run.receiptPersistenceError || null,
      receiptId: rootReceipt.receiptId,
      receiptPersistenceError: rootReceipt.receiptPersistenceError || finalReceipt.receiptPersistenceError || null,
    });
  }));

  server.registerTool('run_committee', {
    title: 'Run a bounded multi-provider committee',
    description: 'Fan out independent read-only roles to up to four diverse providers, checkpoint partial results, enforce one overall deadline, and optionally ask one safe chair for a structured agreement/mixed/disagreement assessment. Consensus is never inferred from successful text generation alone.',
    inputSchema: z.object({
      task: z.string().min(1).max(100000),
      cwd: z.string().max(1000).optional(),
      providers: z.array(z.string()).max(4).default([]),
      excludedProviders: z.array(z.string()).max(8).default([]),
      mode: z.enum(['advisory', 'consensus']).default(loadRoutingData().policy.committee.defaultMode),
      maxProviders: z.number().int().min(1).max(4).default(3),
      localOnly: z.boolean().default(false),
      timeoutMs: z.number().int().min(TIMEOUT_POLICY.minimumMs).max(TIMEOUT_POLICY.oneShotMaxMs).default(TIMEOUT_POLICY.oneShotDefaultMs),
      useCache: z.boolean().default(true),
      synthesisProvider: z.string().max(64).optional(),
      acknowledgeHumanGate: z.boolean().default(false),
      acknowledgeTruncatedEvidence: z.boolean().default(false),
      providerBudget: PROVIDER_BUDGET_SCHEMA.optional(),
      effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
      maxEffortOverride: z.boolean().default(false),
    }),
    annotations: EXTERNAL_READ,
  }, safeHandler(async (args, context) => {
    const signal = context?.mcpReq?.signal;
    const requestedDeadlineAt = Date.now() + args.timeoutMs;
    const diagnostics = await getDiagnostics(signal, remainingTime(requestedDeadlineAt, 1));
    const route = routeTask({
      task: args.task,
      diagnostics,
      preferredProviders: args.providers,
      excludedProviders: [...args.excludedProviders, 'powershell'],
      localOnly: args.localOnly,
      maxProviders: args.maxProviders,
      committeeMode: args.mode,
    });
    if (route.humanGateRequired && !args.acknowledgeHumanGate) {
      return result({ ok: false, blocked: true, route, error: 'High-stakes committee requires acknowledgeHumanGate=true and remains advisory.' }, { isError: true });
    }
    if (args.mode === 'consensus' && args.maxProviders < 2) {
      return result({ ok: false, blocked: true, route, error: 'Consensus mode requires at least two independent members.' }, { isError: true });
    }
    const config = loadCliConfig();
    const { policy } = loadRoutingData();
    const tierPolicy = policy.tiers[route.classification.tier];
    const eligible = eligibleOneShotKinds(route, config, {
      selectedOnly: true,
      allowedKinds: args.providers,
    }).slice(0, Math.min(args.maxProviders, tierPolicy.maxProviders));
    if (args.mode === 'consensus' && eligible.length < 2) {
      return result({
        ok: false,
        blocked: true,
        route,
        eligibleProviders: eligible.map((item) => item.kind),
        error: 'Consensus mode requires two eligible providers after readiness, capability, locality, exclusions, and the explicit provider allowlist are applied.',
      }, { isError: true });
    }
    if (!eligible.length) {
      const receipt = appendReceipt({ event: 'committee', routeId: route.routeId, taskHash: route.classification.taskHash, status: 'no_eligible_provider' });
      return result({ ok: false, blocked: true, route, receiptId: receipt.receiptId, error: 'No eligible safe provider matched this committee policy.' }, { isError: true });
    }
    const deadlineAt = Math.min(requestedDeadlineAt, Date.now() + tierPolicy.defaultTimeoutMs);
    const rootReceipt = appendReceipt({
      event: 'committee',
      routeId: route.routeId,
      taskHash: route.classification.taskHash,
      mode: args.mode,
      providers: eligible.map((item) => item.kind),
      status: 'started',
    });
    let run = writeRun({
      mode: `committee:${args.mode}`,
      status: 'running',
      taskHash: route.classification.taskHash,
      route,
      members: [],
      synthesis: null,
      parentReceiptId: rootReceipt.receiptId,
      deadlineAt: new Date(deadlineAt).toISOString(),
    });
    const roles = policy.committee.roles.filter((role) => role !== 'chair');
    const membersByIndex = new Array(eligible.length);
    const settledMembers = await Promise.allSettled(eligible.map(async (candidate, index) => {
      const role = roles[Math.min(index, roles.length - 1)];
      let member;
      try {
        if (signal?.aborted) throw signal.reason || new Error('committee cancelled before provider admission');
        if (Date.now() >= deadlineAt) throw new Error('committee deadline exceeded before provider admission');
        const seatPrompt = rolePrompt(args.task, role, route.classification, policy);
        const response = await callProvider({
          kind: candidate.kind,
          prompt: seatPrompt,
          cwd: args.cwd,
          timeoutMs: remainingTime(deadlineAt),
          useCache: args.useCache,
          parentReceiptId: rootReceipt.receiptId,
          purpose: `committee:${role}`,
          signal,
          providerBudget: args.providerBudget,
          effort: args.effort,
          maxEffortOverride: args.maxEffortOverride,
        });
        member = {
          ...response,
          role,
          inputTruncated: args.task.length > tierPolicy.maxInputChars,
          originalTaskChars: args.task.length,
          seatPromptChars: seatPrompt.length,
          taskSha256: route.classification.taskHash,
        };
      } catch (error) {
        member = { kind: candidate.kind, role, exitCode: -1, droppedOut: true, stdout: '', stderr: error?.message || String(error), failureClass: signal?.aborted ? 'cancelled' : 'adapter_error', cancelled: !!signal?.aborted };
      }
      membersByIndex[index] = member;
      run = writeRun({ ...run, status: 'running', members: membersByIndex.filter(Boolean) });
      return member;
    }));
    const members = settledMembers.map((settled, index) => settled.status === 'fulfilled'
      ? settled.value
      : (membersByIndex[index] || { kind: eligible[index].kind, role: roles[Math.min(index, roles.length - 1)], exitCode: -1, droppedOut: true, stdout: '', stderr: settled.reason?.message || String(settled.reason), failureClass: signal?.aborted ? 'cancelled' : 'adapter_error', cancelled: !!signal?.aborted }));
    const successes = members.filter(providerSucceeded);
    let synthesis = null;
    let synthesisAssessment = null;
    const memberEvidenceIncomplete = successes.some((member) =>
      member.inputTruncated || member.outputTruncated || member.route?.prompt_truncated);
    let synthesisInputTruncated = false;
    if (args.mode === 'consensus' && successes.length >= 2 && !signal?.aborted && Date.now() < deadlineAt) {
      const chairKind = args.synthesisProvider || successes[0].kind;
      if (!successes.some((member) => member.kind === chairKind)) {
        synthesis = { kind: chairKind, exitCode: -1, droppedOut: true, stdout: '', stderr: 'synthesisProvider must be one of the successful, policy-eligible committee members', failureClass: 'policy' };
      } else {
        const packet = clip(successes.map((member) => `## ${member.kind} (${member.role})\n${member.stdout}`).join('\n\n'), policy.committee.maxSynthesisChars);
        const originalTask = clip(args.task, 8000);
        synthesisInputTruncated = packet.truncated || originalTask.truncated;
        const synthesisPrompt = [
          'You are the read-only chair of a multi-provider committee.',
          'Assess actual agreement; successful text generation alone is not consensus. Preserve material disagreements, distinguish evidence from opinion, propose explicit gates, and do not claim implementation.',
          'Return JSON only with this schema:',
          '{"verdict":"agreement|mixed|disagreement","confidence":0.0,"agreements":["..."],"dissent":["..."],"recommendation":"..."}',
          '',
          `ORIGINAL TASK:\n${originalTask.text}`,
          '',
          `MEMBER RESPONSES:\n${packet.text}`,
        ].join('\n');
        synthesis = await callProvider({
          kind: chairKind,
          prompt: synthesisPrompt,
          cwd: args.cwd,
          timeoutMs: remainingTime(deadlineAt),
          useCache: args.useCache,
          parentReceiptId: rootReceipt.receiptId,
          purpose: 'committee:chair',
          signal,
          providerBudget: args.providerBudget,
          effort: args.effort,
          maxEffortOverride: args.maxEffortOverride,
        });
        if (providerSucceeded(synthesis)) synthesisAssessment = parseChairAssessment(synthesis.stdout);
      }
    }
    const cancelled = !!signal?.aborted;
    const deadlineExceeded = !cancelled && Date.now() >= deadlineAt &&
      (successes.length < eligible.length || (args.mode === 'consensus' && !providerSucceeded(synthesis)));
    const synthesisCompleted = args.mode === 'consensus' && providerSucceeded(synthesis);
    // Any truncation on the way in or out — seat prompt clipping, the chair
    // packet, the provider's own prompt cap reported by the bridge, or the
    // sanitized stdout cap — means the committee did not see the whole task.
    const evidenceIncomplete = memberEvidenceIncomplete || synthesisInputTruncated || !!synthesis?.outputTruncated || !!synthesis?.route?.prompt_truncated;
    const evidenceComplete = !evidenceIncomplete || args.acknowledgeTruncatedEvidence;
    const consensusMinConfidence = Number(policy.committee.consensusMinConfidence ?? 0.6);
    const allSeatsSucceeded = successes.length === eligible.length;
    const consensusAchieved = args.mode === 'consensus' && successes.length >= 2 && synthesisCompleted &&
      synthesisAssessment?.verdict === 'agreement' && synthesisAssessment.confidence >= consensusMinConfidence &&
      evidenceComplete;
    // "completed" means the whole committee ran on complete evidence. A chair
    // that merely produced text, a dropped seat, or clipped evidence is partial.
    // Acknowledging truncation permits a consensus claim; it does not make the
    // evidence complete, so the status stays partial either way.
    const status = cancelled ? 'cancelled'
      : deadlineExceeded ? (successes.length ? 'partial' : 'timed_out')
        : args.mode === 'consensus'
          ? (synthesisCompleted && synthesisAssessment && allSeatsSucceeded && !evidenceIncomplete
            ? 'completed'
            : successes.length ? 'partial' : 'failed')
          : (allSeatsSucceeded && !evidenceIncomplete ? 'completed' : successes.length ? 'partial' : 'failed');
    const consensusBlockedReasons = args.mode !== 'consensus' ? [] : [
      successes.length < 2 ? 'fewer than two successful independent members' : null,
      !synthesisCompleted ? 'chair seat did not return a usable response' : null,
      synthesisCompleted && !synthesisAssessment ? 'chair response was not a complete structured verdict' : null,
      synthesisAssessment && synthesisAssessment.verdict !== 'agreement' ? `chair verdict was ${synthesisAssessment.verdict}` : null,
      synthesisAssessment?.verdict === 'agreement' && synthesisAssessment.confidence < consensusMinConfidence
        ? `chair confidence ${synthesisAssessment.confidence} is below the policy floor ${consensusMinConfidence}` : null,
      evidenceIncomplete && !args.acknowledgeTruncatedEvidence ? 'evidence was truncated and acknowledgeTruncatedEvidence was not set' : null,
    ].filter(Boolean);
    run = writeRun({
      ...run,
      mode: `committee:${args.mode}`,
      status,
      taskHash: route.classification.taskHash,
      route,
      members,
      synthesis,
      synthesisAssessment,
      synthesisCompleted,
      consensusAchieved,
      consensusMinConfidence,
      consensusBlockedReasons,
      evidenceIncomplete,
      allSeatsSucceeded,
      truncatedEvidenceAcknowledged: args.acknowledgeTruncatedEvidence,
      parentReceiptId: rootReceipt.receiptId,
    });
    const finalReceipt = appendReceipt({ event: 'committee', parentReceiptId: rootReceipt.receiptId, routeId: route.routeId, runId: run.runId, status, successfulProviders: successes.map((item) => item.kind), synthesisCompleted, consensusAchieved, consensusVerdict: synthesisAssessment?.verdict || null, consensusConfidence: synthesisAssessment?.confidence ?? null, consensusMinConfidence, evidenceIncomplete });
    return result({
      ok: !cancelled && (args.mode === 'consensus' ? synthesisCompleted : successes.length > 0),
      status,
      cancelled,
      deadlineExceeded,
      synthesisCompleted,
      consensusAchieved,
      consensusVerdict: synthesisAssessment?.verdict || (args.mode === 'consensus' ? 'unknown' : 'not_requested'),
      consensusMinConfidence,
      consensusBlockedReasons,
      synthesisAssessment,
      evidenceIncomplete,
      allSeatsSucceeded,
      truncatedEvidenceAcknowledged: args.acknowledgeTruncatedEvidence,
      route,
      members,
      synthesis,
      runId: run.runId,
      runPersistenceError: run.receiptPersistenceError || null,
      receiptId: rootReceipt.receiptId,
      receiptPersistenceError: rootReceipt.receiptPersistenceError || finalReceipt.receiptPersistenceError || null,
    });
  }));

  server.registerTool('list_agents', {
    title: 'List AI agents and routing tags',
    description: 'List the configured AI providers (PowerShell excluded) with label, model, routing tags, autoRoute opt-in flag, and the last cached readiness snapshot. Never spawns readiness probes.',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
  }, safeHandler(async () => result(await bridgeRequest('/api/agents'))));

  server.registerTool('set_agent_tags', {
    title: 'Set an agent\'s routing tags',
    description: 'Replace the routing tags for one configured provider and persist them to cli-config.json. Tags are short lowercase labels such as coding, audit, search, or local.',
    inputSchema: z.object({
      providerId: z.string().min(1).max(64),
      tags: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,23}$/)).max(16),
    }),
    annotations: ACTION,
  }, safeHandler(async ({ providerId, tags }) => {
    const response = await bridgeRequest(`/api/agents/${encodeURIComponent(providerId)}/tags`, {
      method: 'POST',
      body: { tags },
      actionIdentity: true,
    });
    const receipt = appendReceipt({ event: 'agent_tags_update', provider: providerId, tags: response.tags, status: 'updated' });
    return result({ ...response, receiptId: receipt.receiptId });
  }));

  server.registerTool('broadcast', {
    title: 'Broadcast one prompt to many providers',
    description: 'Send the same prompt to every matching AI provider in one call. WARNING: this spends quota, credits, or local compute on MULTIPLE provider accounts at once — one broadcast can consume a seat of Claude, Codex, Gemini, Grok, and more simultaneously. Target by explicit providers, by a shared tag, or all:true; tag/all selection always skips opt-in autoRoute:false hosted seats unless they are named explicitly in providers. Calls run with dangerous:false through the same bounded one-shot path and receipts as ask_provider.',
    inputSchema: z.object({
      prompt: z.string().min(1).max(100000),
      tag: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/).optional(),
      providers: z.array(z.string()).max(16).default([]),
      all: z.boolean().default(false),
      cwd: z.string().max(1000).optional(),
      timeoutMs: z.number().int().min(TIMEOUT_POLICY.minimumMs).max(TIMEOUT_POLICY.oneShotMaxMs).default(TIMEOUT_POLICY.oneShotDefaultMs),
      providerBudget: PROVIDER_BUDGET_SCHEMA.optional(),
      effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
      maxEffortOverride: z.boolean().default(false),
    }),
    annotations: { ...ACTION, openWorldHint: true },
  }, safeHandler(async ({ prompt, tag, providers, all, cwd, timeoutMs, providerBudget, effort, maxEffortOverride }, context) => {
    const response = await bridgeRequest('/api/broadcast', {
      method: 'POST',
      body: {
        prompt, tag, providers, all, cwd, timeoutMs, providerBudget, effort,
        maxEffortOverride, dangerous: false,
      },
      timeoutMs: TIMEOUT_POLICY.transportTimeoutMs(timeoutMs),
      signal: context?.mcpReq?.signal,
      actionIdentity: true,
    });
    const results = (response.results || []).map((member) => {
      const output = clip(member.output || '', 16000);
      return { ...member, output: output.text, outputChars: output.originalChars, outputTruncated: output.truncated };
    });
    const receipt = appendReceipt({
      event: 'broadcast',
      providers: response.targets || [],
      runId: response.runId || null,
      inputHash: stableHash(prompt),
      inputChars: prompt.length,
      status: response.status || 'unknown',
      succeededProviders: results.filter((member) => member.ok).map((member) => member.provider),
    });
    return result({ ...response, results, receiptId: receipt.receiptId });
  }));

  const resource = (name, uri, title, description, loader) => {
    server.registerResource(name, uri, { title, description, mimeType: 'application/json', cacheHint: { ttlMs: 5000, cacheScope: 'private' } }, async () => {
      try {
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await loader(), null, 2) }] };
      } catch (error) {
        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2),
          }],
        };
      }
    });
  };
  resource('bridge-health', 'psbridge://health', 'Bridge health', 'Current singleton bridge health.', () => health());
  resource('context', 'psbridge://context', 'AI handoff context', 'Bounded current snapshot of providers, active work, sessions, collaborations, projects, runs, receipts, registry fingerprints, and the tools for retrieving more detail.', () => buildContextBundle({ includeSessionOutput: false, maxMessagesPerCollab: 4, recentRuns: 8, recentReceipts: 12, maxChars: 60000 }));
  resource('provider-index', 'psbridge://providers', 'Provider capability index', 'Operator-maintained provider registry with live readiness, provenance, receipts, references, and limitations.', async () => ({ providers: providerSummaries(await getDiagnostics()), qualificationPolicy: loadRoutingData().evidence.qualificationPolicy }));
  resource('routing-policy', 'psbridge://routing-policy', 'Routing policy', 'Deterministic tiers, budgets, and committee policy.', () => loadRoutingData().policy);
  resource('evidence-index', 'psbridge://evidence', 'Evidence index', 'Primary sources, candidates, benchmark families, and qualification boundaries.', () => loadRoutingData().evidence);
  resource('sessions', 'psbridge://sessions', 'Terminal sessions', 'Current bridge-owned terminal sessions.', () => bridgeRequest('/api/sessions'));
  resource('collabs', 'psbridge://collabs', 'Saved collaborations', 'Saved collaboration room summaries.', () => bridgeRequest('/api/collabs'));
  resource('runs', 'psbridge://runs', 'Recent MCP runs', 'Recent routing and committee run summaries.', () => ({ runs: listRuns(50) }));

  // ---- GitHub integration tools ------------------------------------------
  // Thin clients over /api/github/*. RelayBridge dictates the bump label and
  // reads history; the project repo's version-on-merge.yml Action owns the
  // actual tags/CHANGELOG/Releases. Nothing here can delete or move a tag.

  server.registerTool('github_repo_activity', {
    title: 'GitHub tracking activity',
    description: 'Recent GitHub-integration activity for enrolled repos: checkpoint commits, devlog entries, pushes, draft PRs, bump labels, skipped secrets, and dry-run plans, newest first.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
    annotations: READ_ONLY,
  }, safeHandler(async ({ limit }) => result(await bridgeRequest(`/api/github/activity?limit=${limit}`))));

  server.registerTool('github_list_versions', {
    title: 'List repo versions',
    description: 'Read the append-only version history of an enrolled repo from its GitHub tags (vX.Y.Z). GitHub is the source of truth; RelayBridge only mirrors it.',
    inputSchema: z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }),
    annotations: EXTERNAL_READ,
  }, safeHandler(async ({ repo }) => result(await bridgeRequest(`/api/github/versions?repo=${encodeURIComponent(repo)}`))));

  server.registerTool('github_show_version', {
    title: 'Show one version',
    description: 'Show commit, author, date, and diffstat for one vX.Y.Z tag of an enrolled repo.',
    inputSchema: z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), tag: z.string().regex(/^v\d+\.\d+\.\d+$/) }),
    annotations: EXTERNAL_READ,
  }, safeHandler(async ({ repo, tag }) => result(await bridgeRequest(`/api/github/versions/show?repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`))));

  server.registerTool('github_checkout_version', {
    title: 'Roll back to a version (new branch)',
    description: 'Create a NEW local branch from a vX.Y.Z tag in an enrolled repo — the safe rollback path. Does NOT switch the working tree (returns the branch name to check out when ready), never force-resets, never deletes or moves tags.',
    inputSchema: z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), tag: z.string().regex(/^v\d+\.\d+\.\d+$/) }),
    annotations: ACTION,
  }, safeHandler(async ({ repo, tag }) => {
    const response = await bridgeRequest('/api/github/checkout-version', { method: 'POST', body: { repo, tag } });
    const receipt = appendReceipt({ event: 'github_checkout_version', status: 'branched', repo, tag, branch: response.branch });
    return result({ ...response, receiptId: receipt.receiptId });
  }));

  server.registerTool('github_track_run', {
    title: 'Track a working directory now',
    description: 'Manually run the GitHub tracking pass (checkpoint commit, devlog, optional push/draft-PR/label) for an enrolled repo working directory. Honors the repo\'s dryRun and autoPush settings; refuses to commit on the default branch. Tag the prompt/intent with #<issue> and bump:patch|minor|major to associate work.',
    inputSchema: z.object({
      cwd: z.string().min(1).max(1024),
      intent: z.string().max(4000).optional(),
      user: z.string().max(64).optional(),
    }),
    annotations: ACTION,
  }, safeHandler(async ({ cwd, intent, user }) => {
    const response = await bridgeRequest('/api/github/track', { method: 'POST', body: { cwd, intent, user } });
    const receipt = appendReceipt({ event: 'github_track_run', status: response.tracked ? 'tracked' : 'skipped', detail: response.reason || null });
    return result({ ...response, receiptId: receipt.receiptId });
  }));

  server.registerTool('github_link_issue', {
    title: 'How to link a run to an issue',
    description: 'Explains run-association tags. Include "#123" or "issue:123" in a prompt to link the run; "bump:patch|minor|major" or "version:X.Y.Z" to dictate the PR bump label that version-on-merge.yml turns into a real tag on merge.',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
  }, safeHandler(async () => result({
    tags: {
      issue: 'Put #123 or issue:123 anywhere in the prompt/intent.',
      bump: 'bump:patch (default) | bump:minor | bump:major — applied as a PR label.',
      setVersion: 'version:1.4.0 — applied as a set-version:1.4.0 PR label.',
    },
    contract: 'RelayBridge labels the PR; the project repo\'s version-on-merge.yml computes and tags the version on merge. Tags are append-only.',
  })));

  server.registerTool('github_onboard_repo', {
    title: 'Onboard a repo (one action)',
    description: 'Provision the full automation stack into a repo from the canonical templates: claim-on-start.yml, version-on-merge.yml, PR template, CONTRIBUTING snippet, bump labels, and RelayBridge enrollment with safe defaults (autoPush:false). Operates on a branch and opens a DRAFT PR — never merges, never changes branch protection.',
    inputSchema: z.object({
      name: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      path: z.string().max(1024).optional(),
    }),
    annotations: ACTION,
  }, safeHandler(async ({ name, path: localPath }) => {
    const response = await bridgeRequest('/api/github/onboard', { method: 'POST', body: { name, path: localPath } });
    const receipt = appendReceipt({ event: 'github_onboard_repo', status: 'draft_pr_opened', repo: name, prNumber: response.prNumber ?? null });
    return result({ ...response, receiptId: receipt.receiptId });
  }));

  // ---- Async tasks --------------------------------------------------------

  server.registerTool('submit_task', {
    title: 'Submit a background task',
    description: 'Queue a prompt to a provider and return a task id IMMEDIATELY without waiting for the run. Use for work longer than a chat turn, or when the result should be collectable later from a different surface. Link a collab id to append the result to that shared thread.',
    inputSchema: z.object({
      kind: z.string().min(1).max(64), prompt: z.string().min(1).max(100000),
      collab: z.string().max(64).optional(), title: z.string().max(120).optional(),
      cwd: z.string().max(1024).optional(), user: z.string().max(64).optional(),
    }),
    annotations: ACTION,
  }, safeHandler(async (input) => {
    const response = await bridgeRequest('/api/tasks', { method: 'POST', body: { ...input, source: 'mcp' } });
    const receipt = appendReceipt({ event: 'submit_task', status: 'queued', taskId: response.id, provider: input.kind });
    return result({ ...response, receiptId: receipt.receiptId });
  }));

  server.registerTool('get_task', {
    title: 'Get a task result',
    description: 'Fetch one task by id: status (queued/running/done/failed/cancelled/interrupted), full result text, exit code, route and usage. Poll this to collect work submitted earlier from any surface.',
    inputSchema: z.object({ id: z.string().regex(/^t_[A-Za-z0-9_]+$/) }),
    annotations: READ_ONLY,
  }, safeHandler(async ({ id }) => result(await bridgeRequest(`/api/tasks/${encodeURIComponent(id)}`))));

  server.registerTool('list_tasks', {
    title: 'List tasks',
    description: 'List recent tasks newest-first with status and timing, optionally filtered by collab thread or status.',
    inputSchema: z.object({
      collab: z.string().max(64).optional(),
      status: z.enum(['queued','running','done','failed','cancelled','interrupted']).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    annotations: READ_ONLY,
  }, safeHandler(async ({ collab, status, limit }) => {
    const q = new URLSearchParams();
    if (collab) q.set('collab', collab);
    if (status) q.set('status', status);
    q.set('limit', String(limit));
    return result(await bridgeRequest(`/api/tasks?${q.toString()}`));
  }));

  server.registerTool('cancel_task', {
    title: 'Cancel a task',
    description: 'Cancel a queued task so it never runs, or mark a running task cancelled so its result is not recorded.',
    inputSchema: z.object({ id: z.string().regex(/^t_[A-Za-z0-9_]+$/) }),
    annotations: ACTION,
  }, safeHandler(async ({ id }) => {
    const response = await bridgeRequest(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} });
    const receipt = appendReceipt({ event: 'cancel_task', status: response.status, taskId: id });
    return result({ ...response, receiptId: receipt.receiptId });
  }));

  server.registerTool('provider_cooldowns', {
    title: 'Which seats are rate limited right now',
    description: 'Seats currently in cooldown after a 429 or overload, with how long is left, why, and whether the window came from the provider\'s Retry-After or our backoff. A readiness probe only proves authentication — this is the quota picture, and it is shared by every client and survives a bridge restart.',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
  }, safeHandler(async () => result(await bridgeRequest('/api/cooldowns'))));

  // ---- Fuel gauge / usage ------------------------------------------------

  server.registerTool('usage_gauges', {
    title: 'Fuel gauges for every seat',
    description: 'Per quota-seat fuel with provider aliases: percent remaining, burn rate (tokens/hour), projected hours to empty, runs, tokens and shadow cost, plus fleet balance. Provider/model receipts remain separate. Basis is disclosed as vendor_observed, operator_observed, configured estimate, metered, or unmetered; observations include provenance and expiry.',
    inputSchema: z.object({ windowMs: z.number().int().min(60000).max(2592000000).default(86400000) }),
    annotations: READ_ONLY,
  }, safeHandler(async ({ windowMs }) => result(await bridgeRequest(`/api/usage/gauges?windowMs=${windowMs}`))));

  server.registerTool('usage_totals', {
    title: 'Token and cost totals',
    description: 'Aggregate tokens and runs, with cost split into shadowCostUsd (what subscription runs WOULD have cost at list API rates — the value the plans return) and meteredCostUsd (what actually billed).',
    inputSchema: z.object({ windowMs: z.number().int().min(60000).max(2592000000).default(86400000) }),
    annotations: READ_ONLY,
  }, safeHandler(async ({ windowMs }) => result(await bridgeRequest(`/api/usage/totals?windowMs=${windowMs}`))));

  server.registerTool('usage_advise', {
    title: 'Which seat should take this work',
    description: 'Given a task tier and capable seats, re-ranks them so the fleet drains evenly and says whether the tier can be safely downgraded to save budget. Never downgrades high-stakes or explicitly-requested work, never below utility. Advisory only — capability wins over economy.',
    inputSchema: z.object({
      tier: z.enum(['deterministic','utility','standard','complex','critical']).default('standard'),
      candidates: z.array(z.object({ seat: z.string().min(1).max(64), rank: z.number().optional(), costClass: z.string().max(24).optional() })).max(20),
      highStakes: z.boolean().default(false),
      explicitProvider: z.boolean().default(false),
      explicitSeat: z.string().min(1).max(64).optional(),
    }),
    annotations: READ_ONLY,
  }, safeHandler(async (input) => result(await bridgeRequest('/api/usage/advise', { method: 'POST', body: input }))));

  return server;
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  console.error(`[RelayBridge-mcp] stdio adapter ${PACKAGE.version} -> ${BASE_URL.href}`);
  serveStdio(() => buildServer());
}
