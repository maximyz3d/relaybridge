'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestBridge, completeJsonLines } = require('./helpers/temporary-bridge');

async function fixture(t) {
  return startTestBridge(t, (root) => {
    const file = path.join(root, 'fake-codex.js');
    fs.writeFileSync(file, [
      "let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{",
      "process.stderr.write('exec\\nFile contents: rate limit 429, max-budget-usd, budget cap reached, authentication failed, deadline exceeded\\nPRIVATE_TRANSCRIPT');",
      "if(!prompt.includes('no-answer'))process.stdout.write('Completed advisory map: derive the CLI wait from the resolved hard cap.');",
      "if(prompt.includes('failure'))process.exitCode=1;});",
    ].join('\n'));
    const seat = { label: 'Fake Codex', safe: [process.execPath], oneshot_safe: [process.execPath, file],
      oneshot_safe_filesystem_policy: 'read_only_enforced', oneshot_capabilities: { safe: ['model_invocation', 'workspace_read', 'tool_use'] } };
    return { codex: seat, codex_alias: { ...seat, npm_package: '@openai/codex' }, unrelated: seat };
  });
}

test('successful Codex text progress is not provider failure or stored transcript', async (t) => {
  const bridge = await fixture(t);
  for (const kind of ['codex', 'codex_alias']) {
    const result = (await bridge.request('/api/oneshot', { kind, prompt: 'bounded advisory', dangerous: false })).body;
    assert.equal(result.exitCode, 0); assert.equal(result.dropped_out, false); assert.equal(result.failureClass, null);
    assert.equal(result.rate_limited, false); assert.equal(result.budget_exceeded, false); assert.equal(result.auth_failed, false);
    assert.equal(result.timed_out, false); assert.equal(result.stderr, ''); assert.match(result.stdout, /^Completed advisory/);
    assert.ok(result.provider_diagnostic_chars > 100); assert.match(result.provider_diagnostic_hash, /^[a-f0-9]{64}$/);
    const rows = completeJsonLines(path.join(bridge.root, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'));
    const row = rows.find((entry) => entry.receiptId === result.receiptId);
    assert.equal(row.status, 'completed'); assert.equal(row.providerDiagnosticHash, result.provider_diagnostic_hash);
    assert.equal(JSON.stringify(rows).includes('PRIVATE_TRANSCRIPT'), false);
  }
  assert.equal((await bridge.request('/api/cooldowns')).body.cooling.length, 0);
});

test('Codex failed/no-answer runs and unrelated providers keep authoritative diagnostic handling', async (t) => {
  const bridge = await fixture(t);
  for (const [kind, prompt] of [['codex', 'failure'], ['codex_alias', 'no-answer'], ['unrelated', 'normal']]) {
    const result = (await bridge.request('/api/oneshot', { kind, prompt, dangerous: false })).body;
    assert.equal(result.dropped_out, true); assert.equal(result.rate_limited, true); assert.equal(result.provider_diagnostic_hash, undefined);
  }
});

test('background task and MCP preserve the completed answer without forwarding progress transcript', { timeout: 20000 }, async (t) => {
  const bridge = await fixture(t);
  const [{ Client }, { StdioClientTransport }] = await Promise.all([import('@modelcontextprotocol/client'), import('@modelcontextprotocol/client/stdio')]);
  const root = path.resolve(__dirname, '..');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'mcp/server.mjs')], cwd: root,
    env: { ...process.env, NODE_ENV: 'test', RELAYBRIDGE_TEST_BUILD_ID: 'security-integration-fixture', RELAYBRIDGE_URL: bridge.base,
      RELAYBRIDGE_TOKEN_FILE: path.join(bridge.root, 'token'), RELAYBRIDGE_DATA_DIR: path.join(bridge.root, 'data'), RELAYBRIDGE_CONFIG_FILE: bridge.configPath }, stderr: 'pipe' });
  const client = new Client({ name: 'codex-progress-test', version: '1' });
  t.after(async () => { await client.close(); await transport.close(); }); await client.connect(transport);
  const result = (await client.callTool({ name: 'ask_provider', arguments: { kind: 'codex', prompt: 'bounded advisory', cwd: bridge.root, useCache: false } })).structuredContent;
  assert.equal(result.droppedOut, false); assert.equal(result.stderr, ''); assert.equal(result.rateLimited, false);
  assert.match(result.providerDiagnosticHash, /^[a-f0-9]{64}$/);
  const row = (await client.callTool({ name: 'get_receipt', arguments: { receiptId: result.receiptId } })).structuredContent.receipt;
  assert.equal(row.providerDiagnosticHash, result.providerDiagnosticHash);
  const task = (await bridge.request('/api/tasks', { kind: 'codex', prompt: 'bounded advisory' })).body;
  const { waitFor } = require('./helpers/temporary-bridge');
  const done = await waitFor(async () => { const item = (await bridge.request(`/api/tasks/${task.id}`)).body; return item.status === 'done' ? item : false; });
  assert.match(done.result, /^Completed advisory/); assert.equal(done.stderr, ''); assert.equal(done.failureClass, null);
});
test('Codex JSONL native errors retain auth/quota classification without private stderr', async (t) => {
  for (const [message, expected] of [['Authentication failed.', 'auth'], ['You have hit your usage limit.', 'rate_limit']]) {
    await t.test(expected, async (t) => {
      const bridge = await startTestBridge(t, (root) => {
        const script = path.join(root, 'codex-error.cjs');
        fs.writeFileSync(script, `process.stderr.write('PRIVATE_REASONING_TOOL_OUTPUT');console.log(JSON.stringify({type:'turn.failed',error:{message:${JSON.stringify(message)}}}));process.exitCode=1;`);
        return { codex: { label: 'Codex JSONL fixture', safe: [process.execPath], probe: [process.execPath, '--version'],
          oneshot_safe: [process.execPath, script], oneshot_output_parser: 'codex_json',
          oneshot_safe_filesystem_policy: 'read_only_enforced', oneshot_capabilities: { safe: ['model_invocation'] } } };
      });
      const result = (await bridge.request('/api/oneshot', { kind: 'codex', prompt: 'Explain a cache', dangerous: false })).body;
      assert.equal(result.failureClass, expected, JSON.stringify(result)); assert.equal(result.dropped_out, true);
      assert.equal(result.model_invocation, true); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_REASONING_TOOL_OUTPUT/);
    });
  }
});
