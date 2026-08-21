import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import TIMEOUT_POLICY from '../timeout-policy.cjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEFAULT_COMMITTEE_PROVIDERS = Object.freeze(['ollama_fast', 'ollama_coder']);
const DEFAULT_CLEANUP_BUDGET_MS = 5000;

function content(result) {
  return result?.structuredContent && typeof result.structuredContent === 'object'
    ? result.structuredContent
    : {};
}

function toolSucceeded(result) {
  return !!result && result.isError !== true && content(result).ok !== false;
}

function memberSucceeded(member) {
  return !!member && member.exitCode === 0 && !member.droppedOut;
}

export function assessCommittee(result, expectedProviders = DEFAULT_COMMITTEE_PROVIDERS) {
  const data = content(result);
  const members = Array.isArray(data.members) ? data.members : [];
  const byKind = new Map(members.map((member) => [member?.kind, member]));
  const missingProviders = expectedProviders.filter((kind) => !byKind.has(kind));
  const failedProviders = expectedProviders.filter((kind) => {
    const member = byKind.get(kind);
    return member && !memberSucceeded(member);
  });
  const persistenceErrors = [
    data.runPersistenceError,
    data.receiptPersistenceError,
  ].filter(Boolean);
  const persisted = !!data.runId && !!data.receiptId && persistenceErrors.length === 0;
  const ok = toolSucceeded(result)
    && data.status === 'completed'
    && data.allSeatsSucceeded === true
    && persisted
    && missingProviders.length === 0
    && failedProviders.length === 0;
  return {
    ok,
    status: data.status || 'unknown',
    allSeatsSucceeded: data.allSeatsSucceeded === true,
    persisted,
    missingProviders,
    failedProviders,
    persistenceErrors,
    runId: data.runId || null,
    receiptId: data.receiptId || null,
    members: members.map((member) => ({
      kind: member?.kind,
      role: member?.role,
      succeeded: memberSucceeded(member),
      usage: member?.usage,
      receiptId: member?.receiptId || null,
    })),
  };
}

function findIdentityEvidence(value, path = [], seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  const preflight = value.actionPreflight;
  if (value.failureClass === 'bridge_identity_mismatch'
      && preflight && typeof preflight === 'object'
      && (preflight.buildMatches === false || preflight.receiptStoreMatches === false)) {
    return { diagnostic: value, preflight, path };
  }
  for (const [key, child] of Object.entries(value)) {
    const found = findIdentityEvidence(child, [...path, key], seen);
    if (found) return found;
  }
  return null;
}

function identityFailure(results) {
  for (const [phase, result] of Object.entries(results)) {
    const evidence = findIdentityEvidence(result);
    if (!evidence) continue;
    return {
      phase,
      kind: 'source_build_identity_mismatch',
      failureClass: 'bridge_identity_mismatch',
      diagnosticPath: evidence.path.join('.'),
      diagnostic: evidence.diagnostic,
      detail: evidence.preflight,
      guidance: 'This source checkout does not match the running RelayBridge build or receipt store. Run smoke from the installed root, or regenerate build-info.json and restart that exact build before retrying. The rejected action invoked no provider.',
    };
  }
  return null;
}

function errorSummary(error) {
  return {
    name: String(error?.name || 'Error'),
    message: String(error?.message || error || 'unknown smoke failure').slice(0, 2000),
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settleWithin(operation, budgetMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation).then(
        () => ({ settled: true, error: null }),
        (error) => ({ settled: true, error: errorSummary(error) }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ settled: false, error: null }), budgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function terminateTransportPid(pid, {
  kill = process.kill.bind(process),
  pause = wait,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { kill(pid, 'SIGTERM'); } catch (error) {
    if (error?.code === 'ESRCH') return true;
    return false;
  }
  await pause(100);
  try { kill(pid, 0); } catch (error) {
    if (error?.code === 'ESRCH') return true;
    return false;
  }
  try { kill(pid, 'SIGKILL'); } catch (error) {
    return error?.code === 'ESRCH';
  }
  return true;
}

export async function closeMcpHandles({
  client,
  transport,
  cleanupBudgetMs = DEFAULT_CLEANUP_BUDGET_MS,
  terminatePid = terminateTransportPid,
} = {}) {
  const boundedBudget = Number.isSafeInteger(cleanupBudgetMs) && cleanupBudgetMs > 0
    ? cleanupBudgetMs
    : DEFAULT_CLEANUP_BUDGET_MS;
  const transportPid = Number.isSafeInteger(transport?.pid) ? transport.pid : null;
  const clientBudget = Math.max(1, Math.floor(boundedBudget / 2));
  const transportBudget = Math.max(1, boundedBudget - clientBudget);
  const clientClose = await settleWithin(
    () => typeof client?.close === 'function' ? client.close() : undefined,
    clientBudget,
  );
  const transportClose = await settleWithin(
    () => typeof transport?.close === 'function' ? transport.close() : undefined,
    transportBudget,
  );
  try { transport?.stderr?.destroy?.(); } catch {}
  let terminated = false;
  if ((!clientClose.settled || clientClose.error
      || !transportClose.settled || transportClose.error) && transportPid) {
    terminated = await terminatePid(transportPid);
  }
  return {
    boundedMs: boundedBudget,
    clientClose,
    transportClose,
    transportPid,
    terminated,
  };
}

async function writeJson(payload, stream = process.stdout) {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  await new Promise((resolve, reject) => {
    stream.write(text, (error) => error ? reject(error) : resolve());
  });
}

export async function runSmoke({
  client,
  transport,
  includeCommittee = false,
  includeAllLocal = false,
  expectedCommitteeProviders = DEFAULT_COMMITTEE_PROVIDERS,
  cleanupBudgetMs = DEFAULT_CLEANUP_BUDGET_MS,
  terminatePid = terminateTransportPid,
  emit = writeJson,
} = {}) {
  const results = {};
  let phase = 'connect';
  let payload;
  let exitCode = 1;
  const call = (name, args) => client.callTool(
    { name, arguments: args },
    {
      timeout: TIMEOUT_POLICY.oneShotDefaultMs + TIMEOUT_POLICY.mcpHostGraceMs,
      maxTotalTimeout: TIMEOUT_POLICY.oneShotDefaultMs + TIMEOUT_POLICY.mcpHostGraceMs,
    },
  );

  try {
    await client.connect(transport);
    phase = 'list_tools';
    const tools = await client.listTools();
    phase = 'list_resources';
    const resources = await client.listResources();
    phase = 'bridge_status';
    results.status = await call('bridge_status', { includeDiagnostics: true });
    phase = 'get_context_bundle';
    results.context = await call('get_context_bundle', {
      includeSessionOutput: true,
      includeCollabMessages: true,
      recentRuns: 5,
      recentReceipts: 10,
      maxChars: 60000,
    });
    phase = 'route_preview';
    results.preview = await call('route_preview', {
      task: 'Define deterministic in one sentence.',
    });
    phase = 'route_and_ask';
    results.routed = await call('route_and_ask', {
      task: 'Reply with exactly MCP_LOCAL_ROUTE_OK and nothing else.',
      localOnly: true,
      preferredProviders: ['ollama_fast'],
      maxEscalations: 0,
      useCache: false,
    });
    if (includeAllLocal) {
      phase = 'ask_provider';
      results.reasoning = await call('ask_provider', {
        kind: 'ollama',
        prompt: 'Reply with exactly MCP_LOCAL_REASONING_OK and nothing else.',
        useCache: false,
      });
    }
    if (includeCommittee) {
      phase = 'run_committee';
      results.committee = await call('run_committee', {
        task: 'Review the JavaScript expression a == null and state one benefit and one limitation.',
        providers: [...expectedCommitteeProviders],
        maxProviders: expectedCommitteeProviders.length,
        localOnly: true,
        mode: 'advisory',
        useCache: false,
      });
    }

    const statusData = content(results.status);
    const contextData = content(results.context);
    const previewData = content(results.preview);
    const routedData = content(results.routed);
    const reasoningData = content(results.reasoning);
    const committee = includeCommittee
      ? assessCommittee(results.committee, expectedCommitteeProviders)
      : null;
    const requestedResults = [
      results.status,
      results.context,
      results.preview,
      results.routed,
      ...(includeAllLocal ? [results.reasoning] : []),
    ];
    const identity = identityFailure(results);
    const baseSucceeded = requestedResults.every(toolSucceeded);
    const ok = baseSucceeded && !identity && (!includeCommittee || committee.ok);
    payload = {
      ok,
      bridge: statusData.health,
      readyProviders: statusData.providers
        ?.filter((provider) => provider.readiness?.ready)
        .map((provider) => provider.kind),
      toolCount: tools.tools.length,
      resourceCount: resources.resources.length,
      context: {
        bundleId: contextData.bundleId,
        receiptId: contextData.receiptId,
        withinBudget: contextData.transfer?.withinBudget,
        includedProviders: contextData.providers?.length,
        activeWork: contextData.activeWork,
        policyFingerprint: contextData.registries?.fingerprints?.policySha256,
      },
      utilityRoute: previewData.route?.selected?.[0]?.kind || previewData.selected?.[0]?.kind,
      routed: {
        provider: routedData.winner?.kind,
        stdout: routedData.winner?.stdout,
        usage: routedData.winner?.usage,
        runId: routedData.runId,
        receiptId: routedData.receiptId,
      },
      reasoning: includeAllLocal ? {
        provider: reasoningData.kind,
        stdout: reasoningData.stdout,
        usage: reasoningData.usage,
        receiptId: reasoningData.receiptId,
      } : null,
      committee,
      failure: identity || (!baseSucceeded ? {
        phase: Object.entries(results).find(([, result]) => !toolSucceeded(result))?.[0] || phase,
        kind: 'mcp_tool_failure',
      } : includeCommittee && !committee.ok ? {
        phase: 'run_committee',
        kind: 'requested_committee_failed',
        status: committee.status,
        missingProviders: committee.missingProviders,
        failedProviders: committee.failedProviders,
        persisted: committee.persisted,
      } : null),
      cleanup: { status: 'pending', boundedMs: cleanupBudgetMs },
    };
    exitCode = ok ? 0 : 1;
  } catch (error) {
    payload = {
      ok: false,
      failure: {
        phase,
        kind: 'smoke_exception',
        ...errorSummary(error),
      },
      partial: {
        completedPhases: Object.keys(results),
        committee: results.committee
          ? assessCommittee(results.committee, expectedCommitteeProviders)
          : null,
      },
      cleanup: { status: 'pending', boundedMs: cleanupBudgetMs },
    };
    exitCode = 1;
  }

  // The report is the caller's durable observation. Flush it before teardown
  // so a wedged SDK close cannot erase a committee result that already has a
  // canonical run/receipt.
  let cleanup;
  try {
    await emit(payload);
  } finally {
    cleanup = await closeMcpHandles({
      client,
      transport,
      cleanupBudgetMs,
      terminatePid,
    });
  }
  return { exitCode, payload, cleanup };
}

export function createDefaultSmoke() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'mcp', 'server.mjs')],
    cwd: ROOT,
    env: { ...process.env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'relaybridge-smoke', version: '2.0.1' });
  return { client, transport };
}

export async function main(argv = process.argv.slice(2)) {
  const { client, transport } = createDefaultSmoke();
  return runSmoke({
    client,
    transport,
    includeCommittee: argv.includes('--committee'),
    includeAllLocal: argv.includes('--all-local'),
  });
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const outcome = await main();
  process.exitCode = outcome.exitCode;
}
