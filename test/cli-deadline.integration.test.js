'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestBridge, completeJsonLines } = require('./helpers/temporary-bridge');
const { buildAskBody } = require('../bin/relaybridge');
const ROOT = path.resolve(__dirname, '..');

test('Gemini deadline is identical in REST/CLI/MCP plans, dispatched argv, and receipts', { timeout: 30000 }, async (t) => {
  let marker;
  const bridge = await startTestBridge(t, (root) => {
    marker = path.join(root, 'invocations.jsonl');
    const script = path.join(root, 'gemini.js');
    fs.writeFileSync(script, [
      "const fs=require('fs');const args=process.argv.slice(2);",
      "if(args[0]==='--version'){process.stdout.write('fixture v1');process.exit(0);}",
      "const at=args.indexOf('--marker');fs.appendFileSync(args[at+1],JSON.stringify(args)+'\\n');",
      "process.stdout.write('A complete bounded answer with clear verification steps.');",
    ].join('\n'));
    const slot = [process.execPath, script, '--print-timeout', '{supervisor_print_timeout}', '--marker', marker, '--prompt-file', '{prompt_file}'];
    return { gemini: { label: 'Gemini fixture', transport: 'subscription:fixture',
      safe: [process.execPath], probe: [process.execPath, script, '--version'],
      oneshot_capabilities: { safe: ['model_invocation'], dangerous: ['model_invocation'] },
      oneshot_safe: slot, oneshot_dangerous: slot, print_timeout_policy: 'supervisor_margin_v1',
      oneshot_safe_filesystem_policy: 'read_only_enforced' } };
  });
  const task = 'Explain how a bounded cache works and list its invariants.';
  const checkArgv = (deadline) => {
    const args = completeJsonLines(marker).at(-1);
    assert.equal(args[args.indexOf('--print-timeout') + 1], deadline.printTimeout);
    assert.equal(args.filter((arg) => arg === '--print-timeout').length, 1);
    assert.ok(!args.some((arg) => arg.includes('{supervisor_print_timeout}')));
  };
  for (const dangerous of [false, true]) {
    for (const timeoutMs of [undefined, 4000, 3600000]) {
      const planned = await bridge.request('/api/plan', { task, kind: 'gemini', timeoutMs,
        dangerous, acknowledgeFilesystemWrites: dangerous, cwd: bridge.root });
      assert.equal(planned.status, 200, JSON.stringify(planned.body));
      const primary = planned.body.primary;
      assert.equal(primary.validation, null, JSON.stringify(primary));
      assert.equal(primary.effectiveTimeoutMs, timeoutMs === 4000 ? 4000 : 2700000);
      const body = buildAskBody(planned.body, task, bridge.root);
      assert.equal(body.timeoutMs, timeoutMs);
      const result = await bridge.request('/api/oneshot', { ...body, dangerous });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.dropped_out, false, JSON.stringify(result.body));
      assert.equal(result.body.route.effective_timeout_ms, primary.effectiveTimeoutMs);
      assert.deepEqual(result.body.route.execution, primary.execution);
      assert.deepEqual(result.body.route.cli_deadline, primary.cliDeadline);
      checkArgv(primary.cliDeadline);
    }
  }
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/client'), import('@modelcontextprotocol/client/stdio'),
  ]);
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp/server.mjs')], cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', RELAYBRIDGE_TEST_BUILD_ID: 'security-integration-fixture',
      RELAYBRIDGE_URL: bridge.base, RELAYBRIDGE_TOKEN_FILE: path.join(bridge.root, 'token'),
      RELAYBRIDGE_DATA_DIR: path.join(bridge.root, 'data'), RELAYBRIDGE_CONFIG_FILE: bridge.configPath }, stderr: 'pipe' });
  const client = new Client({ name: 'cli-deadline-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await transport.close(); });
  await client.connect(transport);
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  for (const timeoutMs of [undefined, 4000]) {
    const plan = await call('plan_task', { task, kind: 'gemini', cwd: bridge.root, timeoutMs });
    assert.equal(plan.primary.effectiveTimeoutMs, timeoutMs || 1200000);
    const result = await call('ask_provider', { kind: 'gemini', prompt: task, cwd: bridge.root,
      timeoutMs, execution: plan.primary.execution, useCache: false });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.deepEqual(result.route.cli_deadline, plan.primary.cliDeadline); checkArgv(plan.primary.cliDeadline);
    const receipt = await call('get_receipt', { receiptId: result.receiptId });
    assert.deepEqual(receipt.receipt.route.cli_deadline, plan.primary.cliDeadline);
    const preview = await call('route_preview', { task, preferredProviders: ['gemini'], cwd: bridge.root, timeoutMs });
    assert.deepEqual(preview.selected[0].cliDeadline, plan.primary.cliDeadline);
  }
  const before = completeJsonLines(marker).length;
  const config = JSON.parse(fs.readFileSync(bridge.configPath, 'utf8'));
  config.gemini.oneshot_safe.push('--print-timeout=1s');
  fs.writeFileSync(bridge.configPath, JSON.stringify(config));
  const rejected = await call('ask_provider', { kind: 'gemini', prompt: task, cwd: bridge.root, useCache: true });
  assert.equal(rejected.validation.code, 'invalid_print_timeout', JSON.stringify(rejected));
  assert.equal(rejected.physicalAttemptCount, 0);
  const bad = await bridge.request('/api/oneshot', { kind: 'gemini', prompt: task, cwd: bridge.root, dangerous: false });
  assert.equal(bad.body.validation.code, 'invalid_print_timeout');
  assert.equal(bad.body.physical_attempt_count, 0);
  assert.equal(completeJsonLines(marker).length, before);
});
