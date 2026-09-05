'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestBridge } = require('./helpers/temporary-bridge');
const ROOT = path.resolve(__dirname, '..');

test('MCP preserves typed prompt gates, null budgets, all-member admission and uncut chair evidence', { timeout: 30000 }, async (t) => {
  let marker;
  const bridge = await startTestBridge(t, (root) => {
    marker = path.join(root, 'invocations.jsonl');
    const script = path.join(root, 'provider.js');
    fs.writeFileSync(script, [
      "const fs=require('fs');const [marker,kind,file]=process.argv.slice(2);",
      "if(marker==='--version'){process.stdout.write('fixture 1');process.exit(0);}",
      "const prompt=fs.readFileSync(file,'utf8');fs.appendFileSync(marker,JSON.stringify({kind,prompt})+'\\n');",
      "process.stdout.write(Array.from({length:600},(_,i)=>'Finding '+i+': consider deterministic tests.').join('\\n'));",
    ].join('\n'));
    const seat = (kind, max) => ({ label: kind, company: kind, transport: 'subscription:fixture',
      safe: [process.execPath], probe: [process.execPath, script, '--version'],
      oneshot_safe: [process.execPath, script, marker, kind, '{prompt_file}'],
      oneshot_safe_filesystem_policy: 'read_only_enforced', ...(max ? { prompt_input_max_chars: max } : {}) });
    return { claude: seat('claude'), codex: seat('codex'), small: seat('small', 100) };
  });
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/client'), import('@modelcontextprotocol/client/stdio'),
  ]);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(ROOT, 'mcp/server.mjs')], cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', RELAYBRIDGE_TEST_BUILD_ID: 'security-integration-fixture',
      RELAYBRIDGE_URL: bridge.base, RELAYBRIDGE_TOKEN_FILE: path.join(bridge.root, 'token'),
      RELAYBRIDGE_DATA_DIR: path.join(bridge.root, 'data'), RELAYBRIDGE_CONFIG_FILE: bridge.configPath }, stderr: 'pipe' });
  const client = new Client({ name: 'prompt-preflight-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await transport.close(); });
  await client.connect(transport);
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  const tooLarge = await call('ask_provider', { kind: 'small', prompt: 'x'.repeat(101), cwd: bridge.root, providerBudget: null });
  assert.equal(tooLarge.validation.code, 'prompt_too_large');
  assert.equal(tooLarge.validation.inputChars, 101);
  assert.equal(tooLarge.modelInvocation, false); assert.equal(tooLarge.physicalAttemptCount, 0);
  assert.equal(tooLarge.tokenUsageSource, 'not_invoked');
  assert.equal(fs.existsSync(marker), false);
  const receipt = await call('get_receipt', { receiptId: tooLarge.receiptId });
  assert.equal((receipt.receipt || receipt).validation.code, 'prompt_too_large');

  const longTask = 'Design the architecture of a concurrent cache and explain the invariants. ' + 'x'.repeat(25000);
  const rejectedRoute = await call('route_and_ask', { task: longTask, cwd: bridge.root,
    preferredProviders: ['claude'], acknowledgeHumanGate: true, allowInputTruncation: true, useCache: false });
  assert.equal(rejectedRoute.validation?.code, 'prompt_too_large', rejectedRoute.error);
  assert.equal(rejectedRoute.modelInvocation, false);
  const rejectedCommittee = await call('run_committee', { task: longTask, cwd: bridge.root,
    providers: ['claude', 'codex'], maxProviders: 2, mode: 'consensus', acknowledgeHumanGate: true, useCache: false });
  assert.equal(rejectedCommittee.validation?.code, 'prompt_too_large', rejectedCommittee.error);
  assert.equal(rejectedCommittee.physicalAttemptCount, 0);
  assert.equal(fs.existsSync(marker), false);

  const task = 'Design the architecture of a concurrent cache and explain the invariants and failure-handling strategies.';
  const originalConfig = fs.readFileSync(bridge.configPath, 'utf8');
  const narrowerSecondSeat = JSON.parse(originalConfig);
  narrowerSecondSeat.codex.prompt_input_max_chars = 100;
  fs.writeFileSync(bridge.configPath, JSON.stringify(narrowerSecondSeat));
  const laterMemberRejected = await call('run_committee', { task, cwd: bridge.root, providers: ['claude', 'codex'],
    maxProviders: 2, mode: 'consensus', acknowledgeHumanGate: true, useCache: false });
  assert.equal(laterMemberRejected.validation?.code, 'prompt_too_large', laterMemberRejected.error);
  assert.equal(laterMemberRejected.physicalAttemptCount, 0);
  assert.equal(fs.existsSync(marker), false, 'a valid earlier seat must not start before a later seat fails preflight');
  fs.writeFileSync(bridge.configPath, originalConfig);
  const committee = await call('run_committee', { task, cwd: bridge.root, providers: ['claude', 'codex'],
    maxProviders: 2, mode: 'consensus', acknowledgeHumanGate: true, acknowledgeTruncatedEvidence: true,
    useCache: false, providerBudget: null });
  assert.equal(committee.status, 'partial', committee.error);
  assert.equal(committee.members.length, 2);
  assert.equal(committee.synthesis.validation.code, 'prompt_too_large');
  assert.equal(committee.synthesis.modelInvocation, false);
  assert.equal(committee.consensusAchieved, false);
  const invoked = fs.readFileSync(marker, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(invoked.length, 2, 'only independent members execute; oversized chair does not');
  assert.ok(invoked.every((entry) => entry.prompt.endsWith(task)));
});
