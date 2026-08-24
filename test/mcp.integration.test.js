'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function containsPath(value, candidate) {
  const needle = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  if (typeof value === 'string') {
    const text = process.platform === 'win32' ? value.toLowerCase() : value;
    return text.includes(needle);
  }
  if (Array.isArray(value)) return value.some((item) => containsPath(item, candidate));
  if (value && typeof value === 'object') return Object.values(value).some((item) => containsPath(item, candidate));
  return false;
}

test('MCP provider accounting rejects malformed usage and contradictory retry aggregates', async () => {
  const { normalizeProviderUsage, normalizeProviderRetries } = await import('../mcp/server.mjs');
  assert.equal(normalizeProviderUsage({
    input_tokens: 10, output_tokens: 5, cache_read_input_tokens: '999',
    cache_creation_input_tokens: 0, total_tokens: 15,
  }, true), null);
  for (const malformedCost of [false, '1.25', -1, Infinity]) {
    assert.equal(normalizeProviderUsage({
      input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0, total_tokens: 2, cost_usd: malformedCost,
    }, true), null);
  }
  assert.equal(normalizeProviderUsage({
    input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0, total_tokens: 15,
    model_usage: [{
      model: 'm', provider: '', input_tokens: -1, output_tokens: 5,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: null,
    }],
  }, true), null);
  const impossibleRetries = {
    count: 5, total_delay_ms: 100, max_attempt: 1, declared_max_retries: 5,
    by_error: { rate_limit: 99 }, by_status: { 429: 99 },
    events: [{
      event_id_hash: 'a'.repeat(64), attempt: 1, max_retries: 5,
      retry_delay_ms: 100, error_status: 429, error: 'rate_limit',
    }],
    truncated: false, observed_events: 1, invalid_events: 0, duplicate_events: 0,
  };
  assert.equal(normalizeProviderRetries(impossibleRetries, true), null);
  assert.deepEqual(normalizeProviderRetries(impossibleRetries, false), {
    count: 0, total_delay_ms: 0, max_attempt: 0, declared_max_retries: 0,
    by_error: {}, by_status: {}, events: [], truncated: false,
    observed_events: 0, invalid_events: 0, duplicate_events: 0,
  });
});

async function waitForHealth(baseUrl, proc) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`test bridge exited early with ${proc.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error('timed out waiting for test bridge');
}

test('MCP stdio exposes resources, safe tools, routing, and provider receipts', { timeout: 30000 }, async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-bridge-mcp-test-'));
  const tokenPath = path.join(tempRoot, 'capability.token');
  const dataDir = path.join(tempRoot, 'data');
  const staleDataDir = path.join(tempRoot, 'stale-mcp-data');
  const configPath = path.join(tempRoot, 'config.json');
  const invocationMarker = path.join(tempRoot, 'identity-provider-invocations.txt');
  const allowedRootA = path.join(tempRoot, 'allowed-a');
  const allowedRootB = path.join(tempRoot, 'allowed-b');
  const outsideRoot = path.join(tempRoot, 'outside');
  fs.mkdirSync(allowedRootA, { recursive: true });
  fs.mkdirSync(allowedRootB, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
  const helper = path.join(ROOT, 'test', 'prompt-file-cli.js');
  const echoProvider = {
      label: 'Echo',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [process.execPath, helper, '--prompt-file', '{prompt_file}'],
      oneshot_dangerous: [process.execPath, helper, '--prompt-file', '{prompt_file}', '--exit', '9'],
      diagnostic_binary: process.execPath,
      probe: [process.execPath, helper, '--version'],
  };
  fs.writeFileSync(configPath, JSON.stringify({
    echo: echoProvider,
    ollama: { ...echoProvider, label: 'Fake local utility' },
    ollama_coder: { ...echoProvider, label: 'Fake local coder' },
    codex: { ...echoProvider, label: 'Fake Codex' },
    claude: { ...echoProvider, label: 'Fake Claude' },
    gemini: { ...echoProvider, label: 'Fake Gemini' },
    usage_json: {
      ...echoProvider,
      label: 'Structured Claude usage fixture',
      oneshot_safe: [process.execPath, helper, '--prompt-file', '{prompt_file}', '--claude-json'],
      oneshot_output_parser: 'claude_json',
    },
    schema_disagreement: {
      ...echoProvider,
      label: 'Structured Claude schema disagreement fixture',
      oneshot_safe: [
        process.execPath, helper, '--prompt-file', '{prompt_file}',
        '--claude-json-success-error-disagreement',
      ],
      oneshot_output_parser: 'claude_json',
    },
    provider_internal_timeout: {
      ...echoProvider,
      label: 'Provider internal timeout fixture',
      oneshot_safe: [
        process.execPath, helper, '--prompt-file', '{prompt_file}',
        '--stderr', 'Error: timeout waiting for response', '--exit', '1',
      ],
    },
    narration_only: {
      ...echoProvider,
      label: 'Narration-only Grok fixture',
      oneshot_safe: [
        process.execPath, helper, '--prompt-file', '{prompt_file}', '--output',
        'I will inspect the repository and trace the pipeline.\nNext I will review the tests and report any defects.',
      ],
    },
    retry_json: {
      ...echoProvider,
      label: 'Structured Claude retry fixture',
      oneshot_safe: [process.execPath, helper, '--prompt-file', '{prompt_file}', '--claude-json-retries'],
      oneshot_output_parser: 'claude_json',
    },
    identity_guard: {
      ...echoProvider,
      label: 'Identity preflight fixture',
      oneshot_safe: [process.execPath, helper, '--prompt-file', '{prompt_file}', '--invocation-marker', invocationMarker],
    },
    slow: {
      ...echoProvider,
      label: 'Slow cancellable provider',
      oneshot_safe: [process.execPath, helper, '--prompt-file', '{prompt_file}', '--delay', '10000'],
    },
  }), 'utf8');

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const bridge = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      PTY_MODE: 'none',
      PS_BRIDGE_CONFIG_FILE: configPath,
      PS_BRIDGE_TOKEN_FILE: tokenPath,
      PS_BRIDGE_DATA_DIR: dataDir,
      NODE_ENV: 'test',
      RELAYBRIDGE_TEST_BUILD_ID: 'integration-current',
      RELAYBRIDGE_ALLOWED_ROOTS: `${allowedRootA};${allowedRootB}`,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bridgeOutput = '';
  bridge.stdout.on('data', (chunk) => { bridgeOutput += chunk; });
  bridge.stderr.on('data', (chunk) => { bridgeOutput += chunk; });

  let client;
  let transport;
  let staleClient;
  let staleTransport;
  t.after(async () => {
    try { await staleClient?.close(); } catch {}
    try { await staleTransport?.close(); } catch {}
    try { await client?.close(); } catch {}
    try { await transport?.close(); } catch {}
    if (bridge.exitCode === null) bridge.kill('SIGTERM');
    await new Promise((resolve) => bridge.exitCode !== null ? resolve() : bridge.once('exit', resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  try {
    await waitForHealth(baseUrl, bridge);
  } catch (error) {
    throw new Error(`${error.message}\n${bridgeOutput}`);
  }

  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/client'),
    import('@modelcontextprotocol/client/stdio'),
  ]);
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'mcp', 'server.mjs')],
    cwd: ROOT,
    env: {
      ...process.env,
      PS_BRIDGE_URL: baseUrl,
      PS_BRIDGE_TOKEN_FILE: tokenPath,
      PS_BRIDGE_DATA_DIR: dataDir,
      PS_BRIDGE_CONFIG_FILE: configPath,
      NODE_ENV: 'test',
      RELAYBRIDGE_TEST_BUILD_ID: 'integration-current',
    },
    stderr: 'pipe',
  });
  let mcpStderr = '';
  transport.stderr.on('data', (chunk) => { mcpStderr += chunk; });
  client = new Client({ name: 'ps-bridge-integration-test', version: '1.0.0' });
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`${error.message}\n${mcpStderr}`);
  }

  const listedTools = await client.listTools();
  const toolNames = new Set(listedTools.tools.map((tool) => tool.name));
  for (const expected of ['bridge_status', 'list_providers', 'get_context_bundle', 'route_preview', 'ask_provider', 'route_and_ask', 'run_committee', 'get_receipt', 'restart_bridge', 'list_agents', 'set_agent_tags', 'broadcast']) {
    assert.ok(toolNames.has(expected), `missing MCP tool ${expected}`);
  }
  for (const toolName of ['ask_provider', 'route_and_ask', 'run_committee', 'broadcast']) {
    const timeoutSchema = listedTools.tools.find((tool) => tool.name === toolName).inputSchema.properties.timeoutMs;
    assert.equal(timeoutSchema.default, 1200000, `${toolName} uses the centralized 20-minute default`);
    assert.equal(timeoutSchema.maximum, 2700000, `${toolName} accepts up to the transport ceiling (supervisor hard cap)`);
  }
  assert.ok(!toolNames.has('exec'), 'raw command execution must not be exposed over MCP');
  assert.ok(!toolNames.has('set_full_permissions'), 'the sticky dangerous toggle must not be exposed over MCP');

  const listedResources = await client.listResources();
  assert.ok(listedResources.resources.some((resource) => resource.uri === 'psbridge://health'));
  assert.ok(listedResources.resources.some((resource) => resource.uri === 'psbridge://context'));
  const healthResource = await client.readResource({ uri: 'psbridge://health' });
  const healthPayload = JSON.parse(healthResource.contents[0].text);
  assert.equal(healthPayload.version, '2.0.1');
  assert.equal(healthPayload.buildId, 'integration-current');
  assert.match(healthPayload.receiptStoreId, /^[0-9a-f]{64}$/);
  assert.equal(healthPayload.receiptStoreIdentityReady, true);
  assert.ok(!JSON.stringify(healthPayload).includes(dataDir));
  const storedIdentitySeed = fs.readFileSync(path.join(dataDir, '.receipt-store-id'), 'utf8').trim();
  assert.match(storedIdentitySeed, /^[0-9a-f]{64}$/);
  assert.notEqual(storedIdentitySeed, healthPayload.receiptStoreId, 'the exposed identity must bind the seed to its canonical store without exposing either');
  assert.equal(healthPayload.capabilityAuth, true);
  assert.deepEqual(healthPayload.oneShotTimeoutPolicy, { minimumMs: 1000, defaultMs: 1200000, maxMs: 2700000 });

  const capability = await (await fetch(`${baseUrl}/api/capability`)).json();
  const collabHeaders = { 'X-PS-Bridge-Token': capability.token, 'Content-Type': 'application/json' };
  const oldMcpResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST',
    headers: {
      ...collabHeaders,
      'X-RelayBridge-Client': 'mcp',
    },
    body: JSON.stringify({ kind: 'identity_guard', prompt: 'OLD_MCP_MUST_NOT_INVOKE', dangerous: false }),
  });
  assert.equal(oldMcpResponse.status, 409);
  const oldMcpRejected = await oldMcpResponse.json();
  assert.equal(oldMcpRejected.failureClass, 'bridge_identity_mismatch');
  assert.equal(oldMcpRejected.model_invocation, false);
  assert.equal(oldMcpRejected.token_usage_source, 'not_invoked');
  assert.equal(oldMcpRejected.transport_retry_count, 0);
  assert.equal(oldMcpRejected.provider_retries.count, 0);
  assert.equal(oldMcpRejected.actionPreflight.expectedBuildId, null);
  assert.equal(fs.existsSync(invocationMarker), false, 'an old MCP without identity headers must not start a provider process');
  const racedStoreResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST',
    headers: {
      ...collabHeaders,
      'X-RelayBridge-Client': 'mcp',
      'X-RelayBridge-Expected-Build-Id': 'integration-current',
      'X-RelayBridge-Expected-Receipt-Store-Id': '0'.repeat(64),
    },
    body: JSON.stringify({ kind: 'identity_guard', prompt: 'RACED_STORE_MUST_NOT_INVOKE', dangerous: false }),
  });
  assert.equal(racedStoreResponse.status, 409);
  const racedStoreRejected = await racedStoreResponse.json();
  assert.equal(racedStoreRejected.actionPreflight.buildMatches, true);
  assert.equal(racedStoreRejected.actionPreflight.receiptStoreMatches, false);
  assert.equal(racedStoreRejected.model_invocation, false);
  assert.equal(racedStoreRejected.provider_retries.count, 0);
  assert.equal(fs.existsSync(invocationMarker), false, 'the server-side race check must run before provider admission');
  const racedBuildResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST',
    headers: {
      ...collabHeaders,
      'X-RelayBridge-Client': 'mcp',
      'X-RelayBridge-Expected-Build-Id': 'integration-stale',
      'X-RelayBridge-Expected-Receipt-Store-Id': healthPayload.receiptStoreId,
    },
    body: JSON.stringify({ kind: 'identity_guard', prompt: 'RACED_BUILD_MUST_NOT_INVOKE', dangerous: false }),
  });
  assert.equal(racedBuildResponse.status, 409);
  const racedBuildRejected = await racedBuildResponse.json();
  assert.equal(racedBuildRejected.actionPreflight.buildMatches, false);
  assert.equal(racedBuildRejected.actionPreflight.receiptStoreMatches, true);
  assert.equal(racedBuildRejected.model_invocation, false);
  assert.equal(racedBuildRejected.provider_retries.count, 0);
  assert.equal(fs.existsSync(invocationMarker), false, 'a build-only mismatch must fail before provider admission');
  const collab = await (await fetch(`${baseUrl}/api/collabs`, {
    method: 'POST',
    headers: collabHeaders,
    body: JSON.stringify({ name: 'Context budget fixture', participants: ['codex'] }),
  })).json();
  const fixtureTranscript = Array.from({ length: 5 }, (_, index) => ({ who: 'codex', text: `message-${index}` }));
  const updatedCollab = await fetch(`${baseUrl}/api/collabs/${collab.id}`, {
    method: 'PUT',
    headers: collabHeaders,
    body: JSON.stringify({ sharedContext: 'x'.repeat(13000), transcript: fixtureTranscript }),
  });
  assert.equal(updatedCollab.status, 200);

  const contextBundle = await client.callTool({
    name: 'get_context_bundle',
    arguments: {
      includeSessionOutput: true,
      includeCollabMessages: true,
      maxMessagesPerCollab: 2,
      recentRuns: 5,
      recentReceipts: 5,
      maxChars: 50000,
    },
  });
  assert.equal(contextBundle.isError, undefined, JSON.stringify(contextBundle.structuredContent));
  assert.match(contextBundle.structuredContent.bundleId, /^ctx_/);
  assert.equal(contextBundle.structuredContent.bundleId, `ctx_${contextBundle.structuredContent.contentSha256.slice(0, 20)}`);
  assert.equal(contextBundle.structuredContent.bridge.health.version, '2.0.1');
  assert.ok(contextBundle.structuredContent.providers.length >= 3);
  assert.equal(contextBundle.structuredContent.transfer.withinBudget, true);
  assert.ok(contextBundle.structuredContent.transferGuide.delegatedWork.includes('get_run'));
  assert.ok(contextBundle.structuredContent.transferGuide.resources.includes('psbridge://context'));
  assert.match(contextBundle.structuredContent.receiptId, /^rcpt_/);
  assert.equal(contextBundle.structuredContent.collaborations.included[0].sharedContextChars, 13000);
  assert.equal(contextBundle.structuredContent.collaborations.included[0].sharedContextTruncated, true);
  assert.equal(contextBundle.structuredContent.collaborations.included[0].transcriptTruncated, true);
  assert.equal(contextBundle.structuredContent.transfer.truncated, true);
  assert.ok(contextBundle.structuredContent.transfer.omissions.some((item) => /shared context/.test(item)));
  assert.equal(contextBundle.structuredContent.receiptPersisted, true);

  const providers = await client.callTool({
    name: 'list_providers',
    arguments: { includeCandidates: true },
  });
  assert.equal(providers.isError, undefined, JSON.stringify(providers.structuredContent));
  assert.ok(providers.structuredContent.providers.some((provider) => provider.kind === 'codex' && provider.readiness.ready));
  assert.ok(Array.isArray(providers.structuredContent.candidateIntegrations));

  const preview = await client.callTool({
    name: 'route_preview',
    arguments: { task: 'Define the word deterministic in one sentence.' },
  });
  assert.equal(preview.isError, undefined);
  assert.equal(preview.structuredContent.classification.tier, 'utility');
  assert.match(preview.structuredContent.note, /not a universal model-quality score/);

  const agents = await client.callTool({ name: 'list_agents', arguments: {} });
  assert.equal(agents.isError, undefined, JSON.stringify(agents.structuredContent));
  assert.ok(agents.structuredContent.agents.some((agent) => agent.id === 'echo'));

  const taggedAgent = await client.callTool({
    name: 'set_agent_tags',
    arguments: { providerId: 'echo', tags: ['utility'] },
  });
  assert.equal(taggedAgent.isError, undefined, JSON.stringify(taggedAgent.structuredContent));
  assert.deepEqual(taggedAgent.structuredContent.tags, ['utility']);
  assert.match(taggedAgent.structuredContent.receiptId, /^rcpt_/);

  const broadcastReply = await client.callTool({
    name: 'broadcast',
    arguments: { prompt: 'broadcast smoke', tag: 'utility', timeoutMs: 600002 },
  });
  assert.equal(broadcastReply.isError, undefined, JSON.stringify(broadcastReply.structuredContent));
  assert.deepEqual(broadcastReply.structuredContent.targets, ['echo']);
  assert.equal(broadcastReply.structuredContent.results[0].ok, true);
  assert.equal(broadcastReply.structuredContent.results[0].output, 'broadcast smoke');
  assert.match(broadcastReply.structuredContent.runId, /^run_/);
  assert.equal(broadcastReply.structuredContent.timeoutMs, 600002);

  const prompt = 'MCP_SAFE_MARKER_42';
  const provider = await client.callTool({
    name: 'ask_provider',
    arguments: { kind: 'echo', prompt, useCache: false, timeoutMs: 600001 },
  });
  assert.equal(provider.isError, undefined, JSON.stringify(provider.structuredContent));
  assert.equal(provider.structuredContent.stdout, prompt);
  assert.equal(provider.structuredContent.route.dangerous, false);
  assert.equal(provider.structuredContent.route.requested_timeout_ms, 600001);
  assert.equal(provider.structuredContent.route.effective_timeout_ms, 600001);
  assert.match(provider.structuredContent.receiptId, /^rcpt_/);

  const identitySuccess = await client.callTool({
    name: 'ask_provider',
    arguments: { kind: 'identity_guard', prompt: 'SAME_STORE_IDENTITY_OK', useCache: false },
  });
  assert.equal(identitySuccess.isError, undefined, JSON.stringify(identitySuccess.structuredContent));
  assert.equal(identitySuccess.structuredContent.modelInvocation, true);
  assert.equal(identitySuccess.structuredContent.stdout, 'SAME_STORE_IDENTITY_OK');
  assert.equal(identitySuccess.structuredContent.actionPreflight.ok, true);
  assert.equal(identitySuccess.structuredContent.actionPreflight.expectedBuildId, 'integration-current');
  assert.equal(identitySuccess.structuredContent.actionPreflight.currentBuildId, 'integration-current');
  assert.equal(identitySuccess.structuredContent.actionPreflight.expectedReceiptStoreId, healthPayload.receiptStoreId);
  assert.equal(identitySuccess.structuredContent.actionPreflight.currentReceiptStoreId, healthPayload.receiptStoreId);
  assert.equal(fs.readFileSync(invocationMarker, 'utf8').trim(), 'SAME_STORE_IDENTITY_OK');

  const planned = await client.callTool({
    name: 'plan_task',
    arguments: { task: 'rename a CSS class in one stylesheet' },
  });
  assert.equal(planned.isError, undefined, JSON.stringify(planned.structuredContent));
  assert.equal(planned.structuredContent.ok, true);
  assert.ok(planned.structuredContent.primary, 'a fresh MCP read-only POST must reach the live planner');
  assert.equal(planned.structuredContent.actionPreflight.ok, true);
  assert.equal(planned.structuredContent.actionPreflight.expectedBuildId, 'integration-current');
  assert.equal(planned.structuredContent.actionPreflight.expectedReceiptStoreId, healthPayload.receiptStoreId);

  staleTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'mcp', 'server.mjs')],
    cwd: ROOT,
    env: {
      ...process.env,
      PS_BRIDGE_URL: baseUrl,
      PS_BRIDGE_TOKEN_FILE: tokenPath,
      PS_BRIDGE_DATA_DIR: staleDataDir,
      PS_BRIDGE_CONFIG_FILE: configPath,
      NODE_ENV: 'test',
      RELAYBRIDGE_TEST_BUILD_ID: 'integration-stale',
    },
    stderr: 'pipe',
  });
  let staleMcpStderr = '';
  staleTransport.stderr.on('data', (chunk) => { staleMcpStderr += chunk; });
  staleClient = new Client({ name: 'ps-bridge-stale-mcp-test', version: '1.0.0' });
  try {
    await staleClient.connect(staleTransport);
  } catch (error) {
    throw new Error(`${error.message}\n${staleMcpStderr}`);
  }
  const staleStatus = await staleClient.callTool({
    name: 'bridge_status',
    arguments: { includeDiagnostics: false },
  });
  assert.equal(staleStatus.isError, undefined, JSON.stringify(staleStatus.structuredContent));
  assert.equal(staleStatus.structuredContent.health.buildId, 'integration-current');
  assert.equal(staleStatus.structuredContent.health.receiptStoreId, healthPayload.receiptStoreId);

  const staleProvider = await staleClient.callTool({
    name: 'ask_provider',
    arguments: { kind: 'identity_guard', prompt: 'STALE_MCP_MUST_NOT_INVOKE', useCache: false },
  });
  assert.equal(staleProvider.isError, undefined, JSON.stringify(staleProvider.structuredContent));
  assert.equal(staleProvider.structuredContent.modelInvocation, false);
  assert.equal(staleProvider.structuredContent.tokenUsageSource, 'not_invoked');
  assert.equal(staleProvider.structuredContent.transportRetryCount, 0);
  assert.equal(staleProvider.structuredContent.providerRetries.count, 0);
  assert.equal(staleProvider.structuredContent.transportReceiptId, null);
  assert.equal(staleProvider.structuredContent.failureClass, 'bridge_identity_mismatch');
  assert.equal(staleProvider.structuredContent.actionPreflight.expectedBuildId, 'integration-stale');
  assert.equal(staleProvider.structuredContent.actionPreflight.currentBuildId, 'integration-current');
  assert.equal(staleProvider.structuredContent.actionPreflight.buildMatches, false);
  assert.equal(staleProvider.structuredContent.actionPreflight.receiptStoreMatches, false);
  assert.match(staleProvider.structuredContent.actionPreflight.expectedReceiptStoreId, /^[0-9a-f]{64}$/);
  assert.match(staleProvider.structuredContent.actionPreflight.currentReceiptStoreId, /^[0-9a-f]{64}$/);
  assert.notEqual(
    staleProvider.structuredContent.actionPreflight.expectedReceiptStoreId,
    staleProvider.structuredContent.actionPreflight.currentReceiptStoreId,
  );
  assert.ok(!JSON.stringify(staleProvider.structuredContent).includes(staleDataDir));
  assert.ok(!JSON.stringify(staleProvider.structuredContent).includes(dataDir));
  assert.equal(fs.readFileSync(invocationMarker, 'utf8').trim(), 'SAME_STORE_IDENTITY_OK');

  const staleReceipts = await staleClient.callTool({ name: 'list_receipts', arguments: { limit: 20 } });
  const staleOuterReceipt = staleReceipts.structuredContent.receipts.find((receipt) =>
    receipt.receiptId === staleProvider.structuredContent.receiptId);
  assert.ok(staleOuterReceipt, 'the failed preflight must still have an outer MCP receipt');
  assert.equal(staleOuterReceipt.modelInvocation, false);
  assert.equal(staleOuterReceipt.tokenUsageSource, 'not_invoked');
  assert.equal(staleOuterReceipt.providerRetryCount, 0);
  assert.equal(staleOuterReceipt.transportRetryCount, 0);
  assert.equal(staleOuterReceipt.transportReceiptId, null);
  assert.equal(staleOuterReceipt.receiptStoreId, staleProvider.structuredContent.actionPreflight.expectedReceiptStoreId);

  const usageProvider = await client.callTool({
    name: 'ask_provider',
    arguments: { kind: 'usage_json', prompt: 'MCP_USAGE_LINK_MARKER', useCache: false },
  });
  assert.equal(usageProvider.structuredContent.modelInvocation, true);
  assert.equal(usageProvider.structuredContent.usage.total_tokens, 35453);

  const disagreementProvider = await client.callTool({
    name: 'ask_provider',
    arguments: { kind: 'schema_disagreement', prompt: 'MCP_SCHEMA_DISAGREEMENT_MARKER', useCache: false },
  });
  assert.equal(disagreementProvider.structuredContent.modelInvocation, true);
  assert.equal(disagreementProvider.structuredContent.stdout, '');
  assert.equal(disagreementProvider.structuredContent.resultSubtype, 'success');
  assert.equal(disagreementProvider.structuredContent.resultSchemaDisagreement, true);
  assert.equal(disagreementProvider.structuredContent.failureClass, 'rate_limit');
  assert.equal(disagreementProvider.structuredContent.usage.total_tokens, 36);
  assert.equal(disagreementProvider.structuredContent.providerRetries.count, 1);

  const providerTimeout = await client.callTool({
    name: 'ask_provider',
    arguments: { kind: 'provider_internal_timeout', prompt: 'MCP_PROVIDER_TIMEOUT_MARKER', useCache: false },
  });
  assert.equal(providerTimeout.structuredContent.modelInvocation, true);
  assert.equal(providerTimeout.structuredContent.droppedOut, true);
  assert.equal(providerTimeout.structuredContent.timedOut, true);
  assert.equal(providerTimeout.structuredContent.failureClass, 'timeout');
  assert.equal(providerTimeout.structuredContent.stopReason, 'provider_internal_timeout');
  assert.equal(providerTimeout.structuredContent.supervisorStopReason, null);
  assert.equal(providerTimeout.structuredContent.providerTimeoutSource, 'provider_cli_diagnostic');

  const narrationOnly = await client.callTool({
    name: 'ask_provider',
    arguments: { kind: 'narration_only', prompt: 'Audit this repository and return concrete findings.', useCache: false },
  });
  assert.equal(narrationOnly.structuredContent.modelInvocation, true);
  assert.equal(narrationOnly.structuredContent.droppedOut, true);
  assert.equal(narrationOnly.structuredContent.failureClass, 'incomplete_response');
  assert.equal(narrationOnly.structuredContent.stopReason, 'provider_incomplete_response');
  assert.match(narrationOnly.structuredContent.stdout, /^I will inspect/);

  const retryPrompt = 'MCP_RETRY_ACCOUNTING_MARKER';
  const retryProvider = await client.callTool({
    name: 'ask_provider',
    arguments: { kind: 'retry_json', prompt: retryPrompt, useCache: true },
  });
  assert.equal(retryProvider.structuredContent.modelInvocation, true);
  assert.equal(retryProvider.structuredContent.providerRetries.count, 2);
  assert.equal(retryProvider.structuredContent.providerRetries.total_delay_ms, 300);
  assert.equal(retryProvider.structuredContent.providerRetries.observed_events, 5);
  assert.equal(retryProvider.structuredContent.providerRetries.invalid_events, 2);
  assert.equal(retryProvider.structuredContent.providerRetries.duplicate_events, 1);
  assert.equal(retryProvider.structuredContent.providerNumTurns, 3);
  assert.equal(retryProvider.structuredContent.providerDurationMs, 987);
  assert.equal(retryProvider.structuredContent.providerApiDurationMs, 654);
  assert.equal(retryProvider.structuredContent.providerTerminalReason, 'completed');
  assert.equal(retryProvider.structuredContent.providerPermissionDenials.count, 1);
  assert.deepEqual(retryProvider.structuredContent.providerPermissionDenials.byTool, { WebFetch: 1 });
  const retryReplay = await client.callTool({
    name: 'ask_provider',
    arguments: { kind: 'retry_json', prompt: retryPrompt, useCache: true },
  });
  assert.equal(retryReplay.structuredContent.cacheHit, true);
  assert.equal(retryReplay.structuredContent.modelInvocation, false);
  assert.equal(retryReplay.structuredContent.providerRetries.count, 0);
  assert.deepEqual(retryReplay.structuredContent.providerRetries.events, []);
  assert.equal(retryReplay.structuredContent.resultSubtype, null);
  assert.equal(retryReplay.structuredContent.providerStopReason, null);
  assert.equal(retryReplay.structuredContent.providerNumTurns, null);
  assert.equal(retryReplay.structuredContent.providerDurationMs, null);
  assert.equal(retryReplay.structuredContent.providerTerminalReason, null);
  assert.equal(retryReplay.structuredContent.providerPermissionDenials.count, 0);
  assert.equal(retryReplay.structuredContent.transportReceiptId, null);

  const cachePrompt = 'MCP_CACHE_ACCOUNTING_MARKER';
  const cacheSource = await client.callTool({
    name: 'ask_provider',
    arguments: { kind: 'echo', prompt: cachePrompt, useCache: true },
  });
  assert.equal(cacheSource.structuredContent.cacheHit, false);
  assert.equal(cacheSource.structuredContent.modelInvocation, true);
  const cacheReplay = await client.callTool({
    name: 'ask_provider',
    arguments: { kind: 'echo', prompt: cachePrompt, useCache: true },
  });
  assert.equal(cacheReplay.structuredContent.cacheHit, true);
  assert.equal(cacheReplay.structuredContent.modelInvocation, false);
  assert.equal(cacheReplay.structuredContent.usage, null);
  assert.equal(cacheReplay.structuredContent.transportReceiptId, null);
  assert.equal(cacheReplay.structuredContent.sourceReceiptId, cacheSource.structuredContent.receiptId);

  const preflightRejected = await client.callTool({
    name: 'ask_provider',
    arguments: { kind: 'missing-provider', prompt: 'PRE_PROVIDER_REJECTION', useCache: false },
  });
  assert.equal(preflightRejected.structuredContent.modelInvocation, false);
  assert.equal(preflightRejected.structuredContent.admissionLimited, false);

  const expectedCwdDiagnostic = {
    code: 'cwd_outside_allowed_roots',
    field: 'cwd',
    reason: 'The requested working directory resolves outside RelayBridge allowed roots.',
    retryable: false,
    requestedRootHash: /^[0-9a-f]{64}$/,
    normalizedRootHash: /^[0-9a-f]{64}$/,
    canonicalRootHash: null,
    allowedRootHashes: [/^[0-9a-f]{64}$/, /^[0-9a-f]{64}$/],
    allowedRootHashCount: 2,
    allowedRootHashesTruncated: false,
    guidance: 'Use an existing allowed working directory, or explicitly add the intended root to RELAYBRIDGE_ALLOWED_ROOTS and restart RelayBridge. RelayBridge did not change the allowlist.',
    allowlistChanged: false,
    restartRequiredForEnrollment: true,
  };
  const assertCwdDiagnostic = (value) => {
    assert.equal(value.errorCode, expectedCwdDiagnostic.code);
    assert.equal(value.validation.code, expectedCwdDiagnostic.code);
    assert.equal(value.validation.field, expectedCwdDiagnostic.field);
    assert.equal(value.validation.reason, expectedCwdDiagnostic.reason);
    assert.equal(value.validation.retryable, false);
    assert.match(value.validation.requestedRootHash, expectedCwdDiagnostic.requestedRootHash);
    assert.match(value.validation.normalizedRootHash, expectedCwdDiagnostic.normalizedRootHash);
    assert.equal(value.validation.canonicalRootHash, null);
    assert.equal(value.validation.allowedRootHashes.length, 2);
    value.validation.allowedRootHashes.forEach((hash) => assert.match(hash, /^[0-9a-f]{64}$/));
    assert.equal(value.validation.allowedRootHashCount, 2);
    assert.equal(value.validation.allowedRootHashesTruncated, false);
    assert.equal(value.validation.guidance, expectedCwdDiagnostic.guidance);
    assert.equal(value.validation.allowlistChanged, false);
    assert.equal(value.validation.restartRequiredForEnrollment, true);
    assert.equal(value.failureClass, 'validation');
    assert.equal(value.modelInvocation, false);
    assert.equal(value.tokenUsageSource, 'not_invoked');
    assert.equal(value.transportRetryCount, 0);
    assert.equal(value.providerRetries.count, 0);
    assert.equal(value.usage, undefined);
    assert.equal(value.stderr, expectedCwdDiagnostic.reason);
    assert.equal(containsPath(value, outsideRoot), false);
  };

  const cwdRoute = await client.callTool({
    name: 'route_and_ask',
    arguments: {
      task: 'Review this JavaScript function for a simple bug.',
      cwd: outsideRoot,
      preferredProviders: ['codex'],
      maxEscalations: 2,
      useCache: false,
    },
  });
  assert.equal(cwdRoute.structuredContent.status, 'failed');
  assert.ok(cwdRoute.structuredContent.route.candidates.length > 1, 'the route had alternatives but must not replay a deterministic cwd rejection');
  assert.equal(cwdRoute.structuredContent.attempts.length, 1);
  assertCwdDiagnostic(cwdRoute.structuredContent.attempts[0]);

  const cwdCommittee = await client.callTool({
    name: 'run_committee',
    arguments: {
      task: 'Review this JavaScript function for a simple bug.',
      cwd: outsideRoot,
      providers: ['codex', 'claude'],
      maxProviders: 2,
      mode: 'advisory',
      useCache: false,
    },
  });
  assert.equal(cwdCommittee.structuredContent.status, 'failed');
  assert.equal(cwdCommittee.structuredContent.members.length, 2);
  cwdCommittee.structuredContent.members.forEach(assertCwdDiagnostic);

  for (const rejectedMember of [cwdRoute.structuredContent.attempts[0], ...cwdCommittee.structuredContent.members]) {
    assert.match(rejectedMember.transportReceiptId, /^rcpt_/);
    assert.equal(rejectedMember.transportReceiptPersisted, true);
    const outer = await client.callTool({
      name: 'get_receipt', arguments: { receiptId: rejectedMember.receiptId },
    });
    assert.equal(outer.structuredContent.receipt.errorCode, expectedCwdDiagnostic.code);
    assert.deepEqual(outer.structuredContent.receipt.validation, rejectedMember.validation);
    assert.equal(outer.structuredContent.receipt.transportReceiptId, rejectedMember.transportReceiptId);
    assert.equal(outer.structuredContent.receipt.modelInvocation, false);
    assert.equal(outer.structuredContent.receipt.tokenUsageSource, 'not_invoked');
    assert.equal(outer.structuredContent.receipt.providerRetryCount, 0);
    assert.equal(outer.structuredContent.receipt.transportRetryCount, 0);
    const transportReceipt = await client.callTool({
      name: 'get_receipt', arguments: { receiptId: rejectedMember.transportReceiptId },
    });
    assert.equal(transportReceipt.structuredContent.receipt.errorCode, expectedCwdDiagnostic.code);
    assert.deepEqual(transportReceipt.structuredContent.receipt.validation, rejectedMember.validation);
    assert.equal(transportReceipt.structuredContent.receipt.modelInvocation, false);
    assert.equal(transportReceipt.structuredContent.receipt.physicalAttemptCount, 0);
    assert.equal(transportReceipt.structuredContent.receipt.providerRetryCount, 0);
    assert.equal(containsPath(transportReceipt.structuredContent.receipt, outsideRoot), false);
  }

  const cwdCommitteeRun = await client.callTool({
    name: 'get_run', arguments: { runId: cwdCommittee.structuredContent.runId },
  });
  assert.equal(cwdCommitteeRun.structuredContent.members.length, 2);
  cwdCommitteeRun.structuredContent.members.forEach(assertCwdDiagnostic);

  const routedProvider = await client.callTool({
    name: 'route_and_ask',
    arguments: {
      task: 'Review this JavaScript function for a simple bug.',
      preferredProviders: ['codex'],
      maxEscalations: 0,
      useCache: false,
      timeoutMs: 600004,
    },
  });
  assert.equal(routedProvider.isError, undefined, JSON.stringify(routedProvider.structuredContent));
  assert.equal(routedProvider.structuredContent.winner.kind, 'codex');
  assert.ok(routedProvider.structuredContent.winner.route.effective_timeout_ms > 300000);

  const gated = await client.callTool({
    name: 'ask_provider',
    arguments: { kind: 'echo', prompt: 'Make an investment decision using this API key.' },
  });
  assert.equal(gated.isError, true);
  assert.equal(gated.structuredContent.blocked, true);
  assert.ok(gated.structuredContent.humanGateReasons.includes('financial'));
  assert.ok(gated.structuredContent.humanGateReasons.includes('secrets'));

  const strictCommittee = await client.callTool({
    name: 'run_committee',
    arguments: {
      task: 'Review this JavaScript function for a simple bug.',
      providers: ['codex'],
      maxProviders: 3,
      mode: 'advisory',
      useCache: false,
      timeoutMs: 600003,
    },
  });
  assert.equal(strictCommittee.isError, undefined, JSON.stringify(strictCommittee.structuredContent));
  assert.deepEqual(strictCommittee.structuredContent.members.map((member) => member.kind), ['codex']);
  assert.ok(strictCommittee.structuredContent.members[0].route.effective_timeout_ms > 300000);

  const localConsensus = await client.callTool({
    name: 'run_committee',
    arguments: {
      task: 'Review this JavaScript function and propose a test.',
      providers: ['ollama', 'ollama_coder'],
      maxProviders: 2,
      localOnly: true,
      mode: 'consensus',
      synthesisProvider: 'claude',
      useCache: false,
      timeoutMs: 5000,
    },
  });
  assert.equal(localConsensus.structuredContent.consensusAchieved, false);
  assert.equal(localConsensus.structuredContent.status, 'partial');
  assert.deepEqual(new Set(localConsensus.structuredContent.members.map((member) => member.kind)), new Set(['ollama', 'ollama_coder']));
  assert.equal(localConsensus.structuredContent.synthesis.failureClass, 'policy');

  const unprovenConsensus = await client.callTool({
    name: 'run_committee',
    arguments: {
      task: 'Review this JavaScript function and state whether the reviewers actually agree.',
      providers: ['ollama', 'ollama_coder'],
      maxProviders: 2,
      localOnly: true,
      mode: 'consensus',
      synthesisProvider: 'ollama',
      useCache: false,
      timeoutMs: 5000,
    },
  });
  assert.equal(unprovenConsensus.structuredContent.synthesisCompleted, true);
  assert.equal(unprovenConsensus.structuredContent.consensusAchieved, false, 'successful chair text must not be mislabeled as consensus');
  assert.equal(unprovenConsensus.structuredContent.consensusVerdict, 'unknown');
  assert.equal(unprovenConsensus.structuredContent.status, 'partial');

  const controller = new AbortController();
  const slowCall = client.callTool({
    name: 'ask_provider',
    arguments: { kind: 'slow', prompt: 'CANCELLATION_MARKER', useCache: false, timeoutMs: 20000 },
  }, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('test cancellation')), 150);
  await assert.rejects(slowCall);
  const cancellationDeadline = Date.now() + 5000;
  let activeTaskCount = -1;
  while (Date.now() < cancellationDeadline) {
    const health = await (await fetch(`${baseUrl}/api/health`)).json();
    activeTaskCount = health.activeTaskCount;
    if (activeTaskCount === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(activeTaskCount, 0, 'cancelled provider process should not outlive the MCP request');

  const configForCancellation = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  configForCancellation.ollama.oneshot_safe = [process.execPath, helper, '--prompt-file', '{prompt_file}', '--delay', '10000'];
  fs.writeFileSync(configPath, JSON.stringify(configForCancellation), 'utf8');
  const runsDir = path.join(dataDir, 'runs');
  const runsBeforeCancellation = new Set(fs.readdirSync(runsDir));
  const committeeController = new AbortController();
  const cancelledCommittee = client.callTool({
    name: 'run_committee',
    arguments: {
      task: 'Review this JavaScript function for cancellation behavior.',
      providers: ['ollama', 'ollama_coder'],
      maxProviders: 2,
      localOnly: true,
      mode: 'advisory',
      useCache: false,
      timeoutMs: 20000,
    },
  }, { signal: committeeController.signal });
  const runningRunDeadline = Date.now() + 5000;
  let runningRunObserved = false;
  while (Date.now() < runningRunDeadline && !runningRunObserved) {
    for (const name of fs.readdirSync(runsDir)) {
      if (runsBeforeCancellation.has(name)) continue;
      let candidate;
      try { candidate = JSON.parse(fs.readFileSync(path.join(runsDir, name), 'utf8')); }
      catch { continue; }
      if (candidate.mode === 'committee:advisory' && candidate.status === 'running') {
        runningRunObserved = true;
        break;
      }
    }
    if (!runningRunObserved) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(runningRunObserved, true, 'committee should checkpoint a running record before cancellation');
  committeeController.abort(new Error('committee cancellation test'));
  await assert.rejects(cancelledCommittee);
  // On loaded Windows hosts the MCP cancellation can take longer than five
  // seconds to traverse stdio, abort both HTTP seats, persist their receipts,
  // and atomically replace the run checkpoint. The provider helpers remain at
  // ten seconds, so this still fails if cancellation is not propagated.
  const committeeCancellationDeadline = Date.now() + 15000;
  let cancelledRun = null;
  while (Date.now() < committeeCancellationDeadline && !cancelledRun) {
    for (const name of fs.readdirSync(runsDir)) {
      if (runsBeforeCancellation.has(name)) continue;
      let candidate;
      try { candidate = JSON.parse(fs.readFileSync(path.join(runsDir, name), 'utf8')); }
      catch { continue; }
      if (candidate.mode === 'committee:advisory' && candidate.status === 'cancelled') {
        cancelledRun = candidate;
        break;
      }
    }
    if (!cancelledRun) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(cancelledRun, 'cancelled committee should persist a terminal cancelled run');
  assert.ok(cancelledRun.members.some((member) => member.cancelled || member.failureClass === 'cancelled'));

  const receipts = await client.callTool({ name: 'list_receipts', arguments: { limit: 500 } });
  assert.ok(receipts.structuredContent.receipts.some((receipt) => receipt.receiptId === provider.structuredContent.receiptId));
  const cancelledTransportReceipt = receipts.structuredContent.receipts.find((receipt) =>
    receipt.event === 'bridge_provider_call' && receipt.provider === 'slow' && receipt.status === 'cancelled');
  assert.ok(cancelledTransportReceipt, 'client disconnect must persist a transport cancellation receipt');
  assert.equal(cancelledTransportReceipt.failureClass, 'cancelled');
  assert.equal(cancelledTransportReceipt.tokenUsageSource, 'chars_div_4');
  const usageOuterReceipt = receipts.structuredContent.receipts.find((receipt) => receipt.receiptId === usageProvider.structuredContent.receiptId);
  assert.equal(usageOuterReceipt.actualTotalTokens, 35453);
  assert.equal(usageOuterReceipt.tokenUsageSource, 'provider_reported');
  assert.match(usageOuterReceipt.transportReceiptId, /^rcpt_/);
  const usageTransport = await client.callTool({
    name: 'get_receipt',
    arguments: { receiptId: usageOuterReceipt.transportReceiptId },
  });
  assert.equal(usageTransport.structuredContent.receipt.actualTotalTokens, usageOuterReceipt.actualTotalTokens);
  assert.equal(usageTransport.structuredContent.receipt.requestId, usageOuterReceipt.requestId);
  const disagreementOuterReceipt = receipts.structuredContent.receipts.find((receipt) =>
    receipt.receiptId === disagreementProvider.structuredContent.receiptId);
  assert.equal(disagreementOuterReceipt.resultSchemaDisagreement, true);
  assert.equal(disagreementOuterReceipt.actualTotalTokens, 36);
  assert.match(disagreementOuterReceipt.transportReceiptId, /^rcpt_/);
  const disagreementTransport = await client.callTool({
    name: 'get_receipt', arguments: { receiptId: disagreementOuterReceipt.transportReceiptId },
  });
  assert.equal(disagreementTransport.structuredContent.receipt.resultSchemaDisagreement, true);
  assert.equal(disagreementTransport.structuredContent.receipt.actualTotalTokens, 36);
  const providerTimeoutOuter = receipts.structuredContent.receipts.find((receipt) =>
    receipt.receiptId === providerTimeout.structuredContent.receiptId);
  assert.equal(providerTimeoutOuter.status, 'timed_out');
  assert.equal(providerTimeoutOuter.failureClass, 'timeout');
  assert.equal(providerTimeoutOuter.stopReason, 'provider_internal_timeout');
  assert.equal(providerTimeoutOuter.supervisorStopReason, null);
  assert.equal(providerTimeoutOuter.providerTimeoutSource, 'provider_cli_diagnostic');
  assert.match(providerTimeoutOuter.transportReceiptId, /^rcpt_/);
  const providerTimeoutTransport = await client.callTool({
    name: 'get_receipt', arguments: { receiptId: providerTimeoutOuter.transportReceiptId },
  });
  assert.equal(providerTimeoutTransport.structuredContent.receipt.status, providerTimeoutOuter.status);
  assert.equal(providerTimeoutTransport.structuredContent.receipt.failureClass, providerTimeoutOuter.failureClass);
  assert.equal(providerTimeoutTransport.structuredContent.receipt.stopReason, providerTimeoutOuter.stopReason);
  assert.equal(providerTimeoutTransport.structuredContent.receipt.supervisorStopReason, providerTimeoutOuter.supervisorStopReason);
  assert.equal(providerTimeoutTransport.structuredContent.receipt.providerTimeoutSource, providerTimeoutOuter.providerTimeoutSource);
  const retryOuterReceipt = receipts.structuredContent.receipts.find((receipt) => receipt.receiptId === retryProvider.structuredContent.receiptId);
  assert.equal(retryOuterReceipt.providerRetryCount, 2);
  assert.equal(retryOuterReceipt.providerRetryDelayMs, 300);
  assert.match(retryOuterReceipt.transportReceiptId, /^rcpt_/);
  const retryTransport = await client.callTool({
    name: 'get_receipt', arguments: { receiptId: retryOuterReceipt.transportReceiptId },
  });
  assert.equal(retryTransport.structuredContent.receipt.providerRetryCount, retryOuterReceipt.providerRetryCount);
  assert.equal(retryTransport.structuredContent.receipt.providerRetryDelayMs, retryOuterReceipt.providerRetryDelayMs);
  assert.deepEqual(retryTransport.structuredContent.receipt.providerRetryByError, retryOuterReceipt.providerRetryByError);
  assert.equal(retryTransport.structuredContent.receipt.providerRetryObservedEvents, retryOuterReceipt.providerRetryObservedEvents);
  assert.equal(retryTransport.structuredContent.receipt.providerTerminalReason, retryOuterReceipt.providerTerminalReason);
  assert.equal(retryTransport.structuredContent.receipt.providerPermissionDenialCount, retryOuterReceipt.providerPermissionDenialCount);
  assert.deepEqual(retryTransport.structuredContent.receipt.providerPermissionDenialsByTool, retryOuterReceipt.providerPermissionDenialsByTool);
  const retryCacheReceipt = receipts.structuredContent.receipts.find((receipt) => receipt.receiptId === retryReplay.structuredContent.receiptId);
  assert.equal(retryCacheReceipt.status, 'cached');
  assert.equal(retryCacheReceipt.modelInvocation, false);
  assert.equal(retryCacheReceipt.providerRetryCount, 0);
  assert.deepEqual(retryCacheReceipt.providerRetryEvents, []);
  const cacheReceipt = receipts.structuredContent.receipts.find((receipt) => receipt.receiptId === cacheReplay.structuredContent.receiptId);
  assert.equal(cacheReceipt.status, 'cached');
  assert.equal(cacheReceipt.modelInvocation, false);
  assert.equal(cacheReceipt.tokenUsageSource, 'not_invoked');
  const rejectedReceipt = receipts.structuredContent.receipts.find((receipt) => receipt.receiptId === preflightRejected.structuredContent.receiptId);
  assert.equal(rejectedReceipt.modelInvocation, false);
  assert.equal(rejectedReceipt.tokenUsageSource, 'not_invoked');
  assert.equal(typeof receipts.structuredContent.total, 'number');
  assert.ok(Object.prototype.hasOwnProperty.call(receipts.structuredContent, 'nextOffset'));
  const firstReceiptPage = await client.callTool({ name: 'list_receipts', arguments: { limit: 2 } });
  assert.equal(firstReceiptPage.isError, undefined, JSON.stringify(firstReceiptPage.structuredContent));
  assert.equal(firstReceiptPage.structuredContent.receipts.length, 2);
  assert.equal(typeof firstReceiptPage.structuredContent.nextCursor, 'string');
  const secondReceiptPage = await client.callTool({
    name: 'list_receipts',
    arguments: { limit: 2, cursor: firstReceiptPage.structuredContent.nextCursor },
  });
  assert.equal(secondReceiptPage.isError, undefined, JSON.stringify(secondReceiptPage.structuredContent));
  const firstIds = new Set(firstReceiptPage.structuredContent.receipts.map((item) => item.receiptId));
  assert.ok(secondReceiptPage.structuredContent.receipts.every((item) => !firstIds.has(item.receiptId)));
  const dereferencedReceipt = await client.callTool({
    name: 'get_receipt',
    arguments: { receiptId: provider.structuredContent.receiptId, followSource: true },
  });
  assert.equal(dereferencedReceipt.isError, undefined, JSON.stringify(dereferencedReceipt.structuredContent));
  assert.equal(dereferencedReceipt.structuredContent.receipt.receiptId, provider.structuredContent.receiptId);
  assert.match(dereferencedReceipt.structuredContent.receipt.transportReceiptId, /^rcpt_/);
  assert.match(dereferencedReceipt.structuredContent.receipt.requestId, /^mcp:/);
  const transportReceipt = await client.callTool({
    name: 'get_receipt',
    arguments: { receiptId: dereferencedReceipt.structuredContent.receipt.transportReceiptId },
  });
  assert.equal(transportReceipt.structuredContent.receipt.requestId, dereferencedReceipt.structuredContent.receipt.requestId);
  const identityOuterReceipt = receipts.structuredContent.receipts.find((receipt) =>
    receipt.receiptId === identitySuccess.structuredContent.receiptId);
  assert.ok(identityOuterReceipt, 'same-store provider result must persist an outer receipt');
  assert.match(identityOuterReceipt.transportReceiptId, /^rcpt_/);
  assert.equal(identityOuterReceipt.receiptStoreId, healthPayload.receiptStoreId);
  assert.equal(identityOuterReceipt.actionPreflight.ok, true);
  const identityTransportReceipt = await client.callTool({
    name: 'get_receipt',
    arguments: { receiptId: identityOuterReceipt.transportReceiptId },
  });
  assert.equal(identityTransportReceipt.isError, undefined, JSON.stringify(identityTransportReceipt.structuredContent));
  assert.equal(identityTransportReceipt.structuredContent.receipt.requestId, identityOuterReceipt.requestId);
  assert.equal(identityTransportReceipt.structuredContent.receipt.bridgeBuildId, 'integration-current');
  assert.equal(identityTransportReceipt.structuredContent.receipt.receiptStoreId, identityOuterReceipt.receiptStoreId);
  assert.ok(Array.isArray(dereferencedReceipt.structuredContent.chain));
  assert.ok(fs.existsSync(path.join(dataDir, 'receipts')));
});
