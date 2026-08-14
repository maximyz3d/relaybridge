import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import TIMEOUT_POLICY from '../timeout-policy.cjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const includeCommittee = process.argv.includes('--committee');
const includeAllLocal = process.argv.includes('--all-local');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'mcp', 'server.mjs')],
  cwd: ROOT,
  env: { ...process.env },
  stderr: 'pipe',
});
const client = new Client({ name: 'ps-bridge-smoke', version: '2.0.0' });
const call = (name, args, timeout = TIMEOUT_POLICY.oneShotDefaultMs + TIMEOUT_POLICY.mcpHostGraceMs) => client.callTool(
  { name, arguments: args },
  { timeout, maxTotalTimeout: timeout },
);

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const resources = await client.listResources();
  const status = await call('bridge_status', { includeDiagnostics: true });
  const context = await call('get_context_bundle', {
    includeSessionOutput: true,
    includeCollabMessages: true,
    recentRuns: 5,
    recentReceipts: 10,
    maxChars: 60000,
  });
  const preview = await call('route_preview', { task: 'Define deterministic in one sentence.' });
  const routed = await call('route_and_ask', {
      task: 'Reply with exactly MCP_LOCAL_ROUTE_OK and nothing else.',
      localOnly: true,
      preferredProviders: ['ollama_fast'],
      maxEscalations: 0,
      timeoutMs: 120000,
      useCache: false,
  });
  let committee = null;
  let reasoning = null;
  if (includeAllLocal) {
    reasoning = await call('ask_provider', {
      kind: 'ollama',
      prompt: 'Reply with exactly MCP_LOCAL_REASONING_OK and nothing else.',
      timeoutMs: 120000,
      useCache: false,
    });
  }
  if (includeCommittee) {
    committee = await call('run_committee', {
        task: 'Review the JavaScript expression a == null and state one benefit and one limitation.',
        providers: ['ollama_fast', 'ollama_coder'],
        maxProviders: 2,
        localOnly: true,
        mode: 'advisory',
        timeoutMs: 120000,
        useCache: false,
    }, 300000);
  }
  const payload = {
    ok: !status.isError && !context.isError && !preview.isError && !routed.isError && !reasoning?.isError && !committee?.isError,
    bridge: status.structuredContent?.health,
    readyProviders: status.structuredContent?.providers?.filter((provider) => provider.readiness?.ready).map((provider) => provider.kind),
    toolCount: tools.tools.length,
    resourceCount: resources.resources.length,
    context: {
      bundleId: context.structuredContent?.bundleId,
      receiptId: context.structuredContent?.receiptId,
      withinBudget: context.structuredContent?.transfer?.withinBudget,
      includedProviders: context.structuredContent?.providers?.length,
      activeWork: context.structuredContent?.activeWork,
      policyFingerprint: context.structuredContent?.registries?.fingerprints?.policySha256,
    },
    utilityRoute: preview.structuredContent?.route?.selected?.[0]?.kind || preview.structuredContent?.selected?.[0]?.kind,
    routed: {
      provider: routed.structuredContent?.winner?.kind,
      stdout: routed.structuredContent?.winner?.stdout,
      usage: routed.structuredContent?.winner?.usage,
      runId: routed.structuredContent?.runId,
      receiptId: routed.structuredContent?.receiptId,
    },
    reasoning: reasoning ? {
      provider: reasoning.structuredContent?.kind,
      stdout: reasoning.structuredContent?.stdout,
      usage: reasoning.structuredContent?.usage,
      receiptId: reasoning.structuredContent?.receiptId,
    } : null,
    committee: committee ? {
      status: committee.structuredContent?.status,
      members: committee.structuredContent?.members?.map((member) => ({
        kind: member.kind,
        role: member.role,
        succeeded: member.exitCode === 0 && !member.droppedOut,
        usage: member.usage,
      })),
      runId: committee.structuredContent?.runId,
      receiptId: committee.structuredContent?.receiptId,
    } : null,
  };
  console.log(JSON.stringify(payload, null, 2));
  if (!payload.ok) process.exitCode = 1;
} finally {
  try { await client.close(); } catch {}
  try { await transport.close(); } catch {}
}
