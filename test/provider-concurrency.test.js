'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestBridge, waitFor, completeJsonLines } = require('./helpers/temporary-bridge');

const DEFAULT_ENV = Object.fromEntries(['RELAYBRIDGE_', 'PS_BRIDGE_'].flatMap((prefix) =>
  ['MAX_ACTIVE_ONESHOTS', 'MAX_ACTIVE_PER_PROVIDER', 'MAX_TASKS'].map((name) => [prefix + name, ''])));

async function fixture(t, env = {}) {
  let events, releaseAll;
  // Always unblock children before the bridge's shutdown hook, including on
  // assertion failures. The fixture never launches a real vendor CLI.
  const cleanup = { after(fn) { t.after(async () => {
    if (releaseAll) fs.writeFileSync(releaseAll, 'release');
    await fn();
  }); } };
  const bridge = await startTestBridge(cleanup, (root) => {
    events = path.join(root, 'events.jsonl'); releaseAll = path.join(root, 'release-all');
    const script = path.join(root, 'controlled-provider.cjs');
    fs.writeFileSync(script, [
      "const fs=require('node:fs'),path=require('node:path');",
      "const [kind,root]=process.argv.slice(2);let raw='';",
      "process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>raw+=chunk);",
      "process.stdin.on('end',()=>{",
      "const id=raw.match(/RB_CASE_[A-Za-z0-9]+/)[0];",
      "const event=event=>fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify({id,kind,event,pid:process.pid})+'\\n');",
      "event('started');process.on('SIGTERM',()=>event('termination_requested'));",
      "const timer=setInterval(()=>{if(fs.existsSync(path.join(root,'release-all'))||fs.existsSync(path.join(root,id))){clearInterval(timer);event('finished');process.stdout.write('Completed result for '+id+'.');}},10);",
      "});",
    ].join('\n'));
    return Object.fromEntries(['claude', 'codex', 'copilot'].map((kind) => [kind, {
      label: kind, safe: [process.execPath], probe: [process.execPath, '--version'],
      version_probe: [process.execPath, '--version'],
      oneshot_safe: [process.execPath, script, kind, root],
      oneshot_safe_filesystem_policy: 'read_only_enforced',
      oneshot_capabilities: { safe: ['model_invocation', 'workspace_read', 'tool_use'] },
    }]));
  }, { env: { ...DEFAULT_ENV, ...env } });
  const started = () => completeJsonLines(events).filter((event) => event.event === 'started');
  const health = async () => (await bridge.request('/api/health')).body;
  const release = (id) => fs.writeFileSync(path.join(bridge.root, id), 'release');
  const releaseEverything = () => fs.writeFileSync(releaseAll, 'release');
  const body = (kind, id) => ({ kind, prompt: `Return the result for ${id}.`, cwd: bridge.root,
    requestId: `parallel:${id}`, dangerous: false });
  const call = (kind, id, options) => bridge.request('/api/oneshot', body(kind, id), options);
  const receipts = () => {
    const dir = path.join(bridge.root, 'data', 'receipts');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
      .flatMap((name) => completeJsonLines(path.join(dir, name))) : [];
  };
  return { ...bridge, started, health, release, releaseEverything, body, call, receipts,
    events: () => completeJsonLines(events) };
}

test('default capacity runs four Claude and four Codex processes with isolated results', { timeout: 30000 }, async (t) => {
  const bridge = await fixture(t);
  const calls = [];
  for (let i = 0; i < 4; i++) {
    const id = `RB_CASE_claude${i}`; calls.push({ id, promise: bridge.call('claude', id) });
  }
  await waitFor(() => bridge.started().length === 4);
  const providerFull = await bridge.call('claude', 'RB_CASE_providerFull');
  assert.equal(providerFull.status, 429);
  assert.equal(providerFull.body.failureClass, 'admission_limit');
  assert.equal(providerFull.body.activeForKind, 4);
  assert.equal(providerFull.body.maxActivePerProvider, 4);
  assert.equal(providerFull.body.activeOneShotCount, 4);
  assert.equal(providerFull.body.physical_attempt_count, 0);
  for (let i = 0; i < 4; i++) {
    const id = `RB_CASE_codex${i}`; calls.push({ id, promise: bridge.call('codex', id) });
  }
  await waitFor(() => bridge.started().length === 8);
  assert.equal(new Set(bridge.started().map((event) => event.pid)).size, 8);
  const health = await bridge.health();
  assert.equal(health.activeOneShotCount, 8);
  assert.equal(health.maxActiveOneShots, 8);
  assert.equal(health.maxConcurrentTasks, 8);
  assert.deepEqual(health.activeOneShotsByProvider, { claude: 4, codex: 4 });
  const globalFull = await bridge.call('copilot', 'RB_CASE_globalFull');
  assert.equal(globalFull.status, 429);
  assert.equal(globalFull.body.activeForKind, 0);
  assert.equal(globalFull.body.activeOneShotCount, 8);
  assert.equal(globalFull.body.physical_attempt_count, 0);
  const receiptIds = new Set();
  // Finish out of submission order: correlation must never rely on "latest".
  for (const { id, promise } of calls.reverse()) {
    bridge.release(id);
    const response = await promise;
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.stdout, `Completed result for ${id}.`);
    assert.equal(response.body.requestId, `parallel:${id}`);
    assert.equal(response.body.invocationId, `parallel:${id}`);
    receiptIds.add(response.body.receiptId);
    const rows = bridge.receipts().filter((row) => row.requestId === `parallel:${id}`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].receiptId, response.body.receiptId);
  }
  assert.equal(receiptIds.size, 8);
  await waitFor(async () => (await bridge.health()).activeOneShotCount === 0);
  assert.deepEqual((await bridge.health()).activeOneShotsByProvider, {});
});

test('configured limits retain a cancelled process slot until physical exit without cancelling siblings', {
  skip: process.platform === 'win32', timeout: 30000,
}, async (t) => {
  const bridge = await fixture(t, { RELAYBRIDGE_MAX_ACTIVE_ONESHOTS: '3', RELAYBRIDGE_MAX_ACTIVE_PER_PROVIDER: '2' });
  const cancelId = 'RB_CASE_cancel';
  const cancelled = bridge.call('claude', cancelId);
  const sibling = bridge.call('claude', 'RB_CASE_sibling');
  const codexController = new AbortController();
  const codex = bridge.call('codex', 'RB_CASE_codex', { signal: codexController.signal });
  const codexRejected = assert.rejects(codex, { name: 'AbortError' });
  await waitFor(() => bridge.started().length === 3);

  // A plain client disconnect (HTTP abort) now detaches under F2/F5: the run
  // keeps going and its slot is NOT freed early. Only an explicit cancel does.
  codexController.abort(); await codexRejected;
  const afterAbort = await bridge.call('copilot', 'RB_CASE_afterAbort');
  assert.equal(afterAbort.status, 429);
  assert.equal(afterAbort.body.activeOneShotCount, 3);
  assert.equal(bridge.events().filter((event) => event.event === 'termination_requested').length, 0);

  // Explicit cancel via POST /api/runs/:runId/cancel -> cancelActiveRun.
  const cancelStartedEvent = bridge.started().find((event) => event.id === cancelId);
  const activeRuns = (await bridge.request('/api/runs/active')).body.runs;
  const cancelRun = activeRuns.find((run) => run.pid === cancelStartedEvent.pid);
  assert.ok(cancelRun, 'active run for RB_CASE_cancel not found');
  const cancelResponse = await bridge.request(`/api/runs/${cancelRun.runId}/cancel`, {
    requestId: `parallel:${cancelId}`, invocationId: `parallel:${cancelId}`, attemptId: `parallel:${cancelId}:attempt:1`,
  });
  assert.equal(cancelResponse.status, 202);
  assert.equal(cancelResponse.body.stopRequested, true);
  await waitFor(() => bridge.events().some((event) => event.id === cancelId && event.event === 'termination_requested'));
  const held = await bridge.call('claude', 'RB_CASE_stillHeld');
  assert.equal(held.status, 429);
  assert.equal(held.body.activeForKind, 2);
  assert.equal(held.body.activeOneShotCount, 3);
  bridge.release(cancelId);
  await waitFor(async () => (await bridge.health()).activeOneShotCount === 2);
  const replacement = bridge.call('claude', 'RB_CASE_replacement');
  await waitFor(() => bridge.started().length === 4);
  assert.equal(bridge.events().filter((event) => event.event === 'termination_requested').length, 1);
  bridge.releaseEverything();
  for (const response of await Promise.all([sibling, replacement])) assert.equal(response.status, 200);
  await waitFor(async () => (await bridge.health()).activeOneShotCount === 0);
  // Two receipt rows are expected: the operator-cancel intent binding
  // (event: 'active_run_cancel_requested') and the final delivery receipt
  // once the process physically exits (status: 'cancelled').
  const rows = bridge.receipts().filter((row) => row.requestId === `parallel:${cancelId}`);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((row) => row.event === 'active_run_cancel_requested').length, 1);
  const delivered = rows.filter((row) => row.status === 'cancelled');
  assert.equal(delivered.length, 1);
});

test('background tasks use all eight default slots and queued overflow completes', { timeout: 30000 }, async (t) => {
  const bridge = await fixture(t);
  const tasks = [];
  for (let i = 0; i < 8; i++) {
    const response = await bridge.request('/api/tasks', bridge.body(i < 4 ? 'claude' : 'codex', `RB_CASE_task${i}`));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    tasks.push(response.body.id);
  }
  await waitFor(() => bridge.started().length === 8);
  const overflow = await bridge.request('/api/tasks', bridge.body('claude', 'RB_CASE_overflow'));
  assert.equal(overflow.status, 200); tasks.push(overflow.body.id);
  await waitFor(async () => (await bridge.health()).queuedTaskCount === 1);
  const health = await bridge.health();
  assert.equal(health.activeTaskQueueCount, 8);
  assert.equal(health.activeOneShotCount, 8);
  bridge.release('RB_CASE_task0');
  await waitFor(() => bridge.started().some((event) => event.id === 'RB_CASE_overflow'));
  bridge.releaseEverything();
  await waitFor(async () => (await Promise.all(tasks.map((id) => bridge.request(`/api/tasks/${id}`))))
    .every((response) => response.body.status === 'done'));
  await waitFor(async () => (await bridge.health()).activeOneShotCount === 0);
});

test('two independent MCP clients overlap same-provider calls and preserve each correlation tuple', { timeout: 30000 }, async (t) => {
  const bridge = await fixture(t);
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/client'), import('@modelcontextprotocol/client/stdio'),
  ]);
  const clients = [];
  for (let i = 0; i < 2; i++) {
    const root = path.resolve(__dirname, '..');
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'mcp/server.mjs')], cwd: root,
      env: { ...process.env, NODE_ENV: 'test', RELAYBRIDGE_TEST_BUILD_ID: 'security-integration-fixture',
        RELAYBRIDGE_URL: bridge.base, RELAYBRIDGE_TOKEN_FILE: path.join(bridge.root, 'token'),
        RELAYBRIDGE_DATA_DIR: path.join(bridge.root, 'data'), RELAYBRIDGE_CONFIG_FILE: bridge.configPath }, stderr: 'pipe' });
    const client = new Client({ name: `parallel-client-${i}`, version: '1' });
    t.after(async () => { await client.close(); await transport.close(); });
    await client.connect(transport); clients.push(client);
  }
  const calls = clients.flatMap((client, i) => ['claude', 'codex'].map((kind) => {
    const id = `RB_CASE_mcp${kind}${i}`;
    return { id, client, promise: client.callTool({ name: 'ask_provider', arguments: {
      kind, prompt: `Return the result for ${id}.`, cwd: bridge.root, useCache: false,
    } }) };
  }));
  await waitFor(() => bridge.started().length === 4);
  assert.deepEqual((await bridge.health()).activeOneShotsByProvider, { claude: 2, codex: 2 });
  bridge.releaseEverything();
  const requests = new Set(), invocations = new Set(), receipts = new Set();
  for (const { id, client, promise } of calls) {
    const response = await promise;
    assert.notEqual(response.isError, true, JSON.stringify(response));
    let result = response.structuredContent;
    if (result.pending === true) {
      // The 10 s inline collection window (callProvider's default
      // collectionMs) can end before releaseEverything() unblocks the
      // fixture under CI load; follow the documented pending contract.
      const task = await waitFor(async () => {
        const taskResponse = await client.callTool({ name: 'get_task', arguments: { id: result.taskId } });
        const value = taskResponse.structuredContent;
        return ['done', 'failed', 'cancelled', 'interrupted'].includes(value.status) ? value : null;
      }, 20000);
      assert.equal(task.result, `Completed result for ${id}.`);
    } else {
      assert.equal(result.stdout, `Completed result for ${id}.`);
    }
    const outer = bridge.receipts().find((entry) => entry.receiptId === result.receiptId);
    assert.ok(outer.requestId); assert.ok(outer.invocationId); assert.ok(result.receiptId);
    requests.add(outer.requestId); invocations.add(outer.invocationId); receipts.add(result.receiptId);
    if (result.pending !== true) {
      const row = bridge.receipts().find((entry) => entry.receiptId === result.transportReceiptId);
      assert.equal(row.requestId, outer.requestId);
      assert.equal(row.invocationId, outer.invocationId);
      assert.equal(result.route.request_id, outer.requestId);
    } else {
      assert.equal(result.requestId, outer.requestId);
      assert.equal(result.invocationId, outer.invocationId);
    }
  }
  assert.equal(requests.size, 4); assert.equal(invocations.size, 4); assert.equal(receipts.size, 4);
});
