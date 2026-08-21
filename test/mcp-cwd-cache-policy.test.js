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
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, proc) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`bridge exited ${proc.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('bridge health timeout');
}

async function startPair({ port, configPath, tokenPath, dataDir, allowedRoots }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const commonEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PTY_MODE: 'none',
    PORT: String(port),
    RELAYBRIDGE_TEST_BUILD_ID: 'cwd-cache-policy-test',
    RELAYBRIDGE_CONFIG_FILE: configPath,
    RELAYBRIDGE_TOKEN_FILE: tokenPath,
    RELAYBRIDGE_DATA_DIR: dataDir,
    RELAYBRIDGE_ALLOWED_ROOTS: allowedRoots.join(';'),
  };
  const bridge = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, env: commonEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bridgeOutput = '';
  bridge.stdout.on('data', (chunk) => { bridgeOutput += chunk; });
  bridge.stderr.on('data', (chunk) => { bridgeOutput += chunk; });
  await waitForHealth(baseUrl, bridge);
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/client'),
    import('@modelcontextprotocol/client/stdio'),
  ]);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'mcp', 'server.mjs')],
    cwd: ROOT,
    env: { ...commonEnv, PS_BRIDGE_URL: baseUrl },
    stderr: 'pipe',
  });
  let mcpOutput = '';
  transport.stderr.on('data', (chunk) => { mcpOutput += chunk; });
  const client = new Client({ name: 'cwd-cache-policy-test', version: '1.0.0' });
  try { await client.connect(transport); }
  catch (error) { throw new Error(`${error.message}\n${bridgeOutput}\n${mcpOutput}`); }
  return {
    bridge, client, transport,
    async close() {
      try { await client.close(); } catch {}
      try { await transport.close(); } catch {}
      if (bridge.exitCode === null) bridge.kill('SIGTERM');
      await new Promise((resolve) => bridge.exitCode !== null ? resolve() : bridge.once('exit', resolve));
    },
  };
}

function routeArgs(task, cwd) {
  return {
    task, cwd, preferredProviders: ['ollama_coder'], excludedProviders: [],
    localOnly: false, maxEscalations: 0, useCache: true,
    allowModelForDeterministic: true,
  };
}

function committeeArgs(task, cwd) {
  return {
    task, cwd, providers: ['ollama_coder'], excludedProviders: [],
    mode: 'advisory', maxProviders: 1, localOnly: false, useCache: true,
  };
}

function assertCwdBlocked(value) {
  assert.equal(value.modelInvocation, false);
  assert.equal(value.tokenUsageSource, 'not_invoked');
  assert.equal(value.transportRetryCount, 0);
  assert.equal(value.providerRetries.count, 0);
  assert.equal(value.errorCode, 'cwd_outside_allowed_roots');
  assert.equal(value.failureClass, 'validation');
  assert.equal(value.cacheHit, false);
  assert.match(value.transportReceiptId, /^rcpt_/);
}

test('live cwd admission invalidates stale route and committee cache across restart', { timeout: 60000 }, async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-cwd-cache-'));
  const allowedA = path.join(tempRoot, 'allowed-a');
  const allowedB = path.join(tempRoot, 'allowed-b');
  const outside = path.join(tempRoot, 'outside');
  const link = path.join(allowedA, 'linked-cwd');
  const targetA = path.join(allowedA, 'target-a');
  const targetB = path.join(allowedA, 'target-b');
  const inRootLink = path.join(allowedA, 'in-root-link');
  for (const dir of [allowedA, allowedB, outside]) fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(targetA, { recursive: true });
  fs.mkdirSync(targetB, { recursive: true });
  fs.mkdirSync(path.join(allowedB, 'nested'), { recursive: true });
  const lexicalB = `${allowedB}${path.sep}nested${path.sep}..`;
  fs.symlinkSync(allowedB, link, process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(targetA, inRootLink, process.platform === 'win32' ? 'junction' : 'dir');
  const dataDir = path.join(tempRoot, 'data');
  const tokenPath = path.join(tempRoot, 'token');
  const configPath = path.join(tempRoot, 'config.json');
  const marker = path.join(tempRoot, 'invocations.txt');
  const helper = path.join(ROOT, 'test', 'prompt-file-cli.js');
  const providerScript = [
    "const fs=require('node:fs')",
    `fs.appendFileSync(${JSON.stringify(marker)}, '1')`,
    "let prompt=''",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data',(chunk)=>{prompt+=chunk})",
    "process.stdin.on('end',()=>process.stdout.write(prompt))",
  ].join(';');
  const provider = {
    label: 'Local coder fixture',
    safe: [process.execPath, helper, '--version'],
    dangerous: [process.execPath, helper, '--version'],
    oneshot_safe: [process.execPath, '-e', providerScript],
    oneshot_dangerous: [process.execPath, '-e', providerScript],
    diagnostic_binary: process.execPath,
    probe: [process.execPath, helper, '--version'],
    tags: ['coding', 'general'],
  };
  fs.writeFileSync(configPath, JSON.stringify({ ollama_coder: provider }), 'utf8');
  const port1 = await reservePort();
  const first = await startPair({ port: port1, configPath, tokenPath, dataDir, allowedRoots: [allowedA, allowedB] });
  let current = first;
  t.after(async () => {
    if (current) await current.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const routeTaskB = 'Explain a robust software cache invalidation design for a bounded coding task B.';
  const routeTaskA = 'Explain a robust software cache invalidation design for a bounded coding task A.';
  const routeTaskLink = 'Explain a robust software cache invalidation design for a linked working directory.';
  const routeTaskLexical = 'Explain a robust software cache invalidation design for a noncanonical working directory.';
  const routeTaskRetarget = 'Explain a robust software cache invalidation design for an allowed retargeted directory.';
  const committeeTaskB = 'Review a software cache invalidation design and list deterministic tests for B.';
  const committeeTaskA = 'Review a software cache invalidation design and list deterministic tests for A.';
  const committeeTaskRetarget = 'Review a software cache invalidation design after an allowed directory retarget.';
  for (const args of [
    routeArgs(routeTaskB, allowedB), routeArgs(routeTaskA, allowedA),
    routeArgs(routeTaskLink, link), routeArgs(routeTaskLexical, lexicalB),
    routeArgs(routeTaskRetarget, inRootLink),
  ]) {
    const seeded = await first.client.callTool({ name: 'route_and_ask', arguments: args });
    assert.ok(seeded.structuredContent.winner, JSON.stringify(seeded.structuredContent));
    assert.equal(seeded.structuredContent.winner.modelInvocation, true);
    assert.equal(seeded.structuredContent.winner.cacheHit, false);
  }
  for (const args of [
    committeeArgs(committeeTaskB, allowedB), committeeArgs(committeeTaskA, allowedA),
    committeeArgs(committeeTaskRetarget, inRootLink),
  ]) {
    const seeded = await first.client.callTool({ name: 'run_committee', arguments: args });
    assert.equal(seeded.structuredContent.members[0].modelInvocation, true);
    assert.equal(seeded.structuredContent.members[0].cacheHit, false);
  }
  const seededInvocationCount = fs.readFileSync(marker, 'utf8').length;
  assert.equal(seededInvocationCount, 8);

  fs.rmSync(inRootLink, { recursive: true, force: true });
  fs.symlinkSync(targetB, inRootLink, process.platform === 'win32' ? 'junction' : 'dir');
  const retargetedRoute = await first.client.callTool({
    name: 'route_and_ask', arguments: routeArgs(routeTaskRetarget, inRootLink),
  });
  assert.equal(retargetedRoute.structuredContent.winner.cacheHit, false);
  assert.equal(retargetedRoute.structuredContent.winner.modelInvocation, true);
  const retargetedRouteReceipt = retargetedRoute.structuredContent.winner.receiptId;
  const retargetedRouteHit = await first.client.callTool({
    name: 'route_and_ask', arguments: routeArgs(routeTaskRetarget, inRootLink),
  });
  assert.equal(retargetedRouteHit.structuredContent.winner.cacheHit, true);
  assert.equal(retargetedRouteHit.structuredContent.winner.sourceReceiptId, retargetedRouteReceipt);

  const retargetedCommittee = await first.client.callTool({
    name: 'run_committee', arguments: committeeArgs(committeeTaskRetarget, inRootLink),
  });
  assert.equal(retargetedCommittee.structuredContent.members[0].cacheHit, false);
  assert.equal(retargetedCommittee.structuredContent.members[0].modelInvocation, true);
  const retargetedCommitteeReceipt = retargetedCommittee.structuredContent.members[0].receiptId;
  const retargetedCommitteeHit = await first.client.callTool({
    name: 'run_committee', arguments: committeeArgs(committeeTaskRetarget, inRootLink),
  });
  assert.equal(retargetedCommitteeHit.structuredContent.members[0].cacheHit, true);
  assert.equal(
    retargetedCommitteeHit.structuredContent.members[0].sourceReceiptId,
    retargetedCommitteeReceipt,
  );
  const postRetargetInvocationCount = fs.readFileSync(marker, 'utf8').length;
  assert.equal(postRetargetInvocationCount, seededInvocationCount + 2);
  await first.close();
  current = null;

  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const port2 = await reservePort();
  const second = await startPair({ port: port2, configPath, tokenPath, dataDir, allowedRoots: [allowedA] });
  current = second;

  const blockedRoute = await second.client.callTool({
    name: 'route_and_ask', arguments: routeArgs(routeTaskB, allowedB),
  });
  assert.equal(blockedRoute.structuredContent.status, 'failed');
  assert.equal(blockedRoute.structuredContent.attempts.length, 1);
  assertCwdBlocked(blockedRoute.structuredContent.attempts[0]);

  const blockedCommittee = await second.client.callTool({
    name: 'run_committee', arguments: committeeArgs(committeeTaskB, allowedB),
  });
  assert.equal(blockedCommittee.structuredContent.status, 'failed');
  assert.equal(blockedCommittee.structuredContent.members.length, 1);
  assertCwdBlocked(blockedCommittee.structuredContent.members[0]);

  const blockedLink = await second.client.callTool({
    name: 'route_and_ask', arguments: routeArgs(routeTaskLink, link),
  });
  assertCwdBlocked(blockedLink.structuredContent.attempts[0]);

  const blockedLexical = await second.client.callTool({
    name: 'route_and_ask', arguments: routeArgs(routeTaskLexical, lexicalB),
  });
  assertCwdBlocked(blockedLexical.structuredContent.attempts[0]);

  const allowedRoute = await second.client.callTool({
    name: 'route_and_ask', arguments: routeArgs(routeTaskA, allowedA),
  });
  assert.equal(allowedRoute.structuredContent.winner.cacheHit, false);
  assert.equal(allowedRoute.structuredContent.winner.modelInvocation, true);
  const allowedRouteReceipt = allowedRoute.structuredContent.winner.receiptId;
  const allowedRouteHit = await second.client.callTool({
    name: 'route_and_ask', arguments: routeArgs(routeTaskA, allowedA),
  });
  assert.equal(allowedRouteHit.structuredContent.winner.cacheHit, true);
  assert.equal(allowedRouteHit.structuredContent.winner.modelInvocation, false);
  assert.equal(allowedRouteHit.structuredContent.winner.sourceReceiptId, allowedRouteReceipt);

  const allowedCommittee = await second.client.callTool({
    name: 'run_committee', arguments: committeeArgs(committeeTaskA, allowedA),
  });
  assert.equal(allowedCommittee.structuredContent.members[0].cacheHit, false);
  assert.equal(allowedCommittee.structuredContent.members[0].modelInvocation, true);
  const allowedCommitteeReceipt = allowedCommittee.structuredContent.members[0].receiptId;
  const allowedCommitteeHit = await second.client.callTool({
    name: 'run_committee', arguments: committeeArgs(committeeTaskA, allowedA),
  });
  assert.equal(allowedCommitteeHit.structuredContent.members[0].cacheHit, true);
  assert.equal(allowedCommitteeHit.structuredContent.members[0].modelInvocation, false);
  assert.equal(
    allowedCommitteeHit.structuredContent.members[0].sourceReceiptId,
    allowedCommitteeReceipt,
  );
  assert.equal(
    fs.readFileSync(marker, 'utf8').length,
    postRetargetInvocationCount + 2,
    'policy identity changes re-invoke allowed work once while stale cwd rejections never invoke',
  );
});
