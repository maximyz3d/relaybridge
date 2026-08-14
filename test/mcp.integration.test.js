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
  const configPath = path.join(tempRoot, 'config.json');
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
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bridgeOutput = '';
  bridge.stdout.on('data', (chunk) => { bridgeOutput += chunk; });
  bridge.stderr.on('data', (chunk) => { bridgeOutput += chunk; });

  let client;
  let transport;
  t.after(async () => {
    try { await client?.close(); } catch {}
    try { await transport?.close(); } catch {}
    if (bridge.exitCode === null) bridge.kill('SIGTERM');
    await new Promise((resolve) => bridge.exitCode !== null ? resolve() : bridge.once('exit', resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
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
  assert.equal(healthPayload.capabilityAuth, true);
  assert.deepEqual(healthPayload.oneShotTimeoutPolicy, { minimumMs: 1000, defaultMs: 1200000, maxMs: 2700000 });

  const capability = await (await fetch(`${baseUrl}/api/capability`)).json();
  const collabHeaders = { 'X-PS-Bridge-Token': capability.token, 'Content-Type': 'application/json' };
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
      const candidate = JSON.parse(fs.readFileSync(path.join(runsDir, name), 'utf8'));
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
  const committeeCancellationDeadline = Date.now() + 5000;
  let cancelledRun = null;
  while (Date.now() < committeeCancellationDeadline && !cancelledRun) {
    for (const name of fs.readdirSync(runsDir)) {
      if (runsBeforeCancellation.has(name)) continue;
      const candidate = JSON.parse(fs.readFileSync(path.join(runsDir, name), 'utf8'));
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
  assert.ok(Array.isArray(dereferencedReceipt.structuredContent.chain));
  assert.ok(fs.existsSync(path.join(dataDir, 'receipts')));
});
