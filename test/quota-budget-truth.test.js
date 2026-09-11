'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestBridge, completeJsonLines } = require('./helpers/temporary-bridge');
const ROOT = path.resolve(__dirname, '..');
const budget = { maxOutputTokens: null, maxTotalTokens: null, maxCacheReadTokens: 650000,
  maxCacheCreationTokens: null, maxTurns: null };

async function fixture(t) {
  return startTestBridge(t, (root) => {
    const script = path.join(root, 'provider.js');
    fs.writeFileSync(script, [
      "let mode='';process.stdin.on('data',c=>mode+=c);process.stdin.on('end',()=>{mode=mode.trim();",
      "const assistant={type:'assistant',message:{id:'before-stop',usage:{input_tokens:1,output_tokens:1,cache_read_input_tokens:1,cache_creation_input_tokens:0},content:[{type:'text',text:'Analysis of rate limit 429. Retry-After: 14400'}]}};",
      "const terminal={type:'result',subtype:'success',is_error:false,result:'TERMINAL_ANSWER_MUST_NOT_ESCAPE: 429 retry-after: 14400',num_turns:1,usage:{input_tokens:1,output_tokens:1,cache_read_input_tokens:651048,cache_creation_input_tokens:0}};",
      "if(mode.startsWith('accepted')){terminal.subtype='error_during_execution';terminal.is_error=true;terminal.api_error_status=429;terminal.terminal_reason='api_error';terminal.errors=mode.includes('no-reset')?['Too many requests']:['Retry-After: 120'];}",
      "if(mode.startsWith('string-status'))terminal.api_error_status='429';",
      "if(mode.startsWith('invalid-document')){terminal.api_error_status=429;terminal.subtype='invalid';}",
      "let lateRetry='';if(mode==='late-same-chunk'){assistant.message.usage.cache_read_input_tokens=651048;terminal.usage.cache_read_input_tokens=9000000;terminal.num_turns=42;terminal.api_error_status=429;terminal.errors=['Retry-After: 120'];lateRetry=JSON.stringify({type:'system',subtype:'api_retry',uuid:'late-retry',attempt:1,max_retries:5,retry_delay_ms:120000,error_status:429,error:'rate_limit'})+'\\n';}",
      "process.stderr.write('Decoy stderr: rate limit 429 retry-after: 14400\\n');",
      "process.stdout.write(JSON.stringify(assistant)+'\\n'+lateRetry+JSON.stringify(terminal)+(mode.endsWith('no-newline')?'':'\\n'));",
      "});",
    ].join('\n'));
    const seat = (quota_seat) => ({ label: 'Quota fixture', transport: 'subscription:anthropic', quota_seat,
      oneshot_output_parser: 'claude_json', oneshot_safe: [process.execPath, script],
      supervisor: { providerBudget: { ...budget, maxCacheReadTokens: 900000 }, providerBudgetByTaskTier: { critical: budget } },
      oneshot_safe_filesystem_policy: 'read_only_enforced' });
    return { claude: seat('subscription:anthropic:default'), claude_fable: seat('subscription:anthropic:default'),
      unrelated: seat('subscription:anthropic:other') };
  });
}

for (const mode of ['pure-budget', 'accepted-newline', 'accepted-no-newline', 'accepted-no-reset', 'late-same-chunk', 'string-status', 'invalid-document', 'string-status-no-newline', 'invalid-document-no-newline']) {
  test(`budget primary and accepted quota boundary: ${mode}`, { timeout: 20000 }, async (t) => {
    const bridge = await fixture(t);
    const response = await bridge.request('/api/oneshot', { kind: 'claude', prompt: mode, dangerous: false, providerBudget: budget });
    const value = response.body;
    assert.equal(response.status, 200, JSON.stringify(value));
    assert.equal(value.failureClass, 'token_budget');
    assert.equal(value.stop_reason, 'token_budget'); assert.equal(value.supervisor_stop_reason, 'token_budget');
    assert.equal(value.budget_exceeded, true); assert.equal(value.dropped_out, true);
    assert.equal(value.stdout, ''); assert.equal(value.model_invocation, true);
    assert.equal(value.usage.cache_read_input_tokens, 651048);
    assert.equal(value.partial_result, true);
    assert.equal(value.partial_diagnostic, 'Analysis of rate limit 429. Retry-After: 14400');
    assert.doesNotMatch(value.partial_diagnostic, /TERMINAL_ANSWER/);
    const accepted = mode.startsWith('accepted');
    assert.equal(value.rate_limited, accepted);
    assert.equal(value.provider_api_error_status, accepted ? 429 : null);
    if (mode === 'late-same-chunk') {
      assert.equal(value.provider_retries.count, 0);
      assert.notEqual(value.provider_num_turns, 42);
    }
    const rows = (await bridge.request('/api/cooldowns')).body.cooling;
    assert.equal(rows.length, accepted ? 1 : 0);
    if (accepted) {
      assert.equal(rows[0].seat, 'subscription:anthropic:default');
      assert.equal(value.cooldown.scope, 'account');
      assert.equal(value.quota_evidence.source, 'claude_terminal_api_status');
      const expected = mode.includes('no-reset') ? 300 : 120;
      assert.equal(value.cooldown.source, mode.includes('no-reset') ? 'backoff' : 'retry-after');
      assert.ok(value.retry_after > expected - 5 && value.retry_after <= expected, JSON.stringify(value.cooldown));
      assert.equal(rows.some((row) => row.seat === 'subscription:anthropic:other'), false);
    }
    const receipt = completeJsonLines(path.join(bridge.root, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'))
      .find((row) => row.receiptId === value.receiptId);
    assert.equal(receipt.failureClass, 'token_budget');
    assert.equal(receipt.providerApiErrorStatus, accepted ? 429 : null);
    assert.deepEqual(receipt.quotaEvidence, value.quota_evidence);
    assert.deepEqual(receipt.cooldown, value.cooldown || null);
    const ledgerDir = path.join(bridge.root, 'data', 'usage');
    const usageRows = fs.existsSync(ledgerDir) ? fs.readdirSync(ledgerDir).filter((name) => name.endsWith('.jsonl'))
      .flatMap((name) => completeJsonLines(path.join(ledgerDir, name))) : [];
    assert.ok(usageRows.length, 'usage ledger must retain the physical attempt');
    assert.equal(usageRows.at(-1).failureKind, 'token_budget', 'independent 429 must not rewrite ledger primary failure');
  });
}

test('a replayed execution tuple retains its task-tier budget when flat tier fields are omitted', async (t) => {
  const bridge = await fixture(t);
  const { resolveProviderControls } = require('../lib/execution-contract');
  const entry = JSON.parse(fs.readFileSync(bridge.configPath, 'utf8')).claude;
  const execution = resolveProviderControls({ kind: 'claude', entry, slot: entry.oneshot_safe,
    taskTier: 'critical', phase: 'plan' }).execution;
  const response = await bridge.request('/api/oneshot', { kind: 'claude', prompt: 'pure-budget', dangerous: false, execution });
  assert.equal(response.body.failureClass, 'token_budget', JSON.stringify(response.body));
  assert.equal(response.body.provider_budget.maxCacheReadTokens, 650000);
});

for (const mode of ['accepted-newline', 'accepted-no-reset']) {
  test(`accepted 429 reset provenance also excludes stderr without a local budget stop: ${mode}`, async (t) => {
    const bridge = await fixture(t);
    const response = await bridge.request('/api/oneshot', { kind: 'claude', prompt: mode, dangerous: false,
      providerBudget: { ...budget, maxCacheReadTokens: 900000 } });
    assert.equal(response.body.failureClass, 'rate_limit', JSON.stringify(response.body));
    assert.equal(response.body.budget_exceeded, false);
    const seconds = mode.includes('no-reset') ? 300 : 120;
    assert.equal(response.body.cooldown.source, mode.includes('no-reset') ? 'backoff' : 'retry-after');
    assert.ok(response.body.retry_after > seconds - 5 && response.body.retry_after <= seconds);
  });
}

test('MCP quota/cooldown normalization and cancellation reconciliation retain typed provenance', async () => {
  const { normalizeQuotaEvidence, normalizeProviderCooldown, reconcileTransportReceipt } = await import('../mcp/server.mjs');
  const evidence = { provider: 'claude', scope: 'account', kind: 'rate_limit', source: 'claude_terminal_api_status',
    status: 429, errorCount: 1, errorDiagnosticHash: 'a'.repeat(64) };
  assert.deepEqual(normalizeQuotaEvidence({ ...evidence, privateText: 'discard' }), evidence);
  assert.equal(normalizeQuotaEvidence({ ...evidence, provider: 'claude.team' }).provider, 'claude.team');
  for (const patch of [{ status: '429' }, { errorCount: -1 }, { provider: '__proto__' }, { errorDiagnosticHash: 'not-a-hash' }]) {
    assert.equal(normalizeQuotaEvidence({ ...evidence, ...patch }), null);
  }
  const cooldown = { seat: 'subscription:anthropic:default', scope: 'account', reason: 'rate_limited', source: 'retry-after',
    until: Date.now() + 120000, offences: 1 };
  assert.deepEqual(normalizeProviderCooldown({ ...cooldown, privateText: 'discard' }), cooldown);
  assert.equal(normalizeProviderCooldown({ ...cooldown, seat: 'subscription:anthropic:default#work' }).seat, 'subscription:anthropic:default#work');
  for (const patch of [{ until: '123' }, { scope: 'global' }, { source: 'model-prose' }, { offences: -1 }]) {
    assert.equal(normalizeProviderCooldown({ ...cooldown, ...patch }), null);
  }
  const reconciled = reconcileTransportReceipt({ requestId: 'mcp:test', sanitized: { failureClass: 'client_cancelled' },
    transportReceipt: { receiptId: 'rcpt_test', failureClass: 'token_budget', supervisorStopReason: 'token_budget',
      stopReason: 'token_budget', modelInvocation: true, physicalAttemptCount: 1, tokenUsageSource: 'provider_reported',
      providerApiErrorStatus: 429, quotaEvidence: evidence, cooldown, retryAt: cooldown.until, retryAfterSec: 120 } });
  assert.equal(reconciled.failureClass, 'token_budget');
  assert.equal(reconciled.cancelled, false);
  assert.equal(reconciled.providerApiErrorStatus, 429);
  assert.equal(reconciled.rateLimited, true); assert.equal(reconciled.budgetExceeded, true);
  assert.deepEqual(reconciled.quotaEvidence, evidence); assert.deepEqual(reconciled.cooldown, cooldown);
  assert.equal(reconciled.retryAt, cooldown.until); assert.equal(reconciled.retryAfterSec, 120);
});

test('pure budget stop does not clear or extend an existing shared Claude/Fable cooldown', async (t) => {
  const bridge = await fixture(t);
  const invoke = (kind, prompt) => bridge.request('/api/oneshot', { kind, prompt, dangerous: false, providerBudget: budget });
  const first = await invoke('claude', 'accepted-newline');
  assert.equal(first.body.failureClass, 'token_budget');
  const file = path.join(bridge.root, 'data', 'cooldowns.json');
  const before = fs.readFileSync(file, 'utf8');
  const second = await invoke('claude_fable', 'pure-budget');
  assert.equal(second.body.failureClass, 'provider_cooldown');
  assert.equal(second.body.model_invocation, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('MCP and exact receipts preserve budget primary plus independent accepted quota evidence', { timeout: 20000 }, async (t) => {
  const bridge = await fixture(t);
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/client'), import('@modelcontextprotocol/client/stdio'),
  ]);
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp/server.mjs')], cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', RELAYBRIDGE_TEST_BUILD_ID: 'security-integration-fixture',
      RELAYBRIDGE_URL: bridge.base, RELAYBRIDGE_TOKEN_FILE: path.join(bridge.root, 'token'),
      RELAYBRIDGE_DATA_DIR: path.join(bridge.root, 'data'), RELAYBRIDGE_CONFIG_FILE: bridge.configPath }, stderr: 'pipe' });
  const client = new Client({ name: 'quota-budget-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await transport.close(); });
  await client.connect(transport);
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  const result = await call('ask_provider', { kind: 'claude', prompt: 'accepted-no-newline', cwd: bridge.root,
    providerBudget: budget, useCache: true });
  assert.equal(result.failureClass, 'token_budget', JSON.stringify(result));
  assert.equal(result.rateLimited, true); assert.equal(result.budgetExceeded, true);
  assert.equal(result.stdout, ''); assert.equal(result.providerApiErrorStatus, 429);
  assert.equal(result.cooldown.source, 'retry-after'); assert.equal(result.cooldown.scope, 'account');
  assert.equal(result.quotaEvidence.status, 429);
  for (const receiptId of [result.receiptId, result.transportReceiptId]) {
    const { receipt } = await call('get_receipt', { receiptId });
    assert.equal(receipt.failureClass, 'token_budget');
    assert.equal(receipt.providerApiErrorStatus, 429);
    assert.deepEqual(receipt.quotaEvidence, result.quotaEvidence);
    assert.deepEqual(receipt.cooldown, result.cooldown);
    assert.equal(receipt.modelInvocation, true);
  }
});
