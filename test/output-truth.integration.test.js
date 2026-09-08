'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startTestBridge, completeJsonLines } = require('./helpers/temporary-bridge');
const ROOT = path.resolve(__dirname, '..');
const refusal = 'Sorry, I cannot fulfill your request. I am unable to perform adversarial reviews, vulnerability scanning, or security analysis on user-provided codebases.';
const progress = 'I am downloading the datasheets. This should just take a moment.';

test('semantic evidence cannot overwrite an authoritative isolation cleanup failure or its ledger entry', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = source.indexOf('function sendOneShotResult(');
  const end = source.indexOf('\nfunction loadConfig()', start);
  for (const stdout of [refusal, progress]) {
    const recorded = []; let response;
    const context = { classifyRunFailure: require('../lib/provider-failure').classifyRunFailure,
      receiptFailureKind: require('../lib/provider-failure').receiptFailureKind,
      cleanOutput: (value) => String(value || '').trim(), recordRunUsage: (row) => recorded.push(row),
      quotaSeatForProvider: (kind) => kind, cooldowns: { noteFailure: () => null },
      appendBridgeProviderReceipt: () => ({ receiptId: 'rcpt_fixture' }), parseRetryAfter: () => null, Date };
    vm.createContext(context); vm.runInContext(source.slice(start, end), context);
    context.sendOneShotResult({ json: (value) => { response = value; } }, {
      exitCode: 0, stdout, stderr: '', failureClass: 'isolation_cleanup', dropped_out: true,
      model_invocation: true, supervisor_stop_reason: null, stop_reason: 'isolation_cleanup',
      stop_detail: 'preserved workspace requires recovery',
    }, { kind: 'gemini', prompt: 'Return findings.', route: {}, startedAt: Date.now() });
    assert.equal(response.failureClass, 'isolation_cleanup');
    assert.equal(recorded[0].failureKind, 'isolation_cleanup');
    assert.equal(response.stop_reason, 'isolation_cleanup');
    assert.equal(response.stop_detail, 'preserved workspace requires recovery');
    assert.equal(response.stdout, ''); assert.equal(response.partial_diagnostic, stdout);
    assert.ok(response.output_detector);
  }
});

test('output detector hashes must be scalar strings, never coercible objects', async () => {
  const { normalizeOutputDetector } = await import('../mcp/server.mjs');
  const detector = { id: 'gemini_progress_only', version: 1, source: 'provider_terminal_text',
    outputChars: progress.length, outputHash: crypto.createHash('sha256').update(progress).digest('hex') };
  assert.deepEqual(normalizeOutputDetector(detector), detector);
  for (const outputHash of [[detector.outputHash], [[detector.outputHash]], null, 123]) {
    assert.equal(normalizeOutputDetector({ ...detector, outputHash }), null);
  }
});

test('refusal/progress remain non-success across REST, MCP, receipt replay, cache and alternate-provider routing', { timeout: 30000 }, async (t) => {
  let marker;
  const bridge = await startTestBridge(t, (root) => {
    const script = path.join(root, 'provider.js'); marker = path.join(root, 'invocations.jsonl');
    fs.writeFileSync(script, [
      "const fs=require('fs');const [kind,marker,file]=process.argv.slice(2);",
      "if(kind==='--version'){process.stdout.write('fixture v1');process.exit(0);}",
      "const prompt=fs.readFileSync(file,'utf8');fs.appendFileSync(marker,JSON.stringify({kind,prompt})+'\\n');",
      `const refusal=${JSON.stringify(refusal)},progress=${JSON.stringify(progress)};`,
      "process.stdout.write(kind==='claude'?'Completed review: the cache is bounded and eviction has a deterministic test.':prompt.includes('PROGRESS_MARKER')?progress:refusal);",
    ].join('\n'));
    const seat = (kind) => ({ label: kind, safe: [process.execPath], probe: [process.execPath, script, '--version'],
      oneshot_capabilities: { safe: ['model_invocation'] },
      oneshot_safe: [process.execPath, script, kind, marker, '{prompt_file}'], oneshot_safe_filesystem_policy: 'read_only_enforced' });
    return { gemini: seat('gemini'), claude: seat('claude') };
  });
  for (const [prompt, output, failureClass, subtype] of [
    ['Return findings.', refusal, 'provider_refusal', 'provider_refusal'],
    ['PROGRESS_MARKER Return facts.', progress, 'incomplete_response', 'progress_only_completion'],
  ]) {
    const response = await bridge.request('/api/oneshot', { kind: 'gemini', prompt, dangerous: false, cwd: bridge.root });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const result = response.body;
    assert.equal(result.exitCode, 0); assert.equal(result.model_invocation, true);
    assert.equal(result.physical_attempt_count, 1); assert.equal(result.dropped_out, true);
    assert.equal(result.failureClass, failureClass); assert.equal(result.result_subtype, subtype);
    assert.equal(result.stdout, ''); assert.equal(result.partial_diagnostic, output);
    assert.equal(result.output_detector.outputHash, crypto.createHash('sha256').update(output).digest('hex'));
  }
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/client'), import('@modelcontextprotocol/client/stdio'),
  ]);
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp/server.mjs')], cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', RELAYBRIDGE_TEST_BUILD_ID: 'security-integration-fixture',
      RELAYBRIDGE_URL: bridge.base, RELAYBRIDGE_TOKEN_FILE: path.join(bridge.root, 'token'),
      RELAYBRIDGE_DATA_DIR: path.join(bridge.root, 'data'), RELAYBRIDGE_CONFIG_FILE: bridge.configPath }, stderr: 'pipe' });
  const client = new Client({ name: 'output-truth-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await transport.close(); });
  await client.connect(transport);
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  const before = completeJsonLines(marker).length;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await call('ask_provider', { kind: 'gemini', prompt: 'Return concrete review findings.', cwd: bridge.root, useCache: true });
    assert.equal(result.failureClass, 'provider_refusal', JSON.stringify(result));
    assert.equal(result.modelInvocation, true); assert.equal(result.droppedOut, true);
    assert.equal(result.cacheHit, false); assert.equal(result.stdout, '');
    assert.equal(result.partialDiagnostic, refusal);
    assert.equal(result.outputDetector.id, 'gemini_explicit_refusal');
    for (const receiptId of [result.receiptId, result.transportReceiptId]) {
      const { receipt } = await call('get_receipt', { receiptId });
      assert.equal(receipt.failureClass, 'provider_refusal'); assert.equal(receipt.modelInvocation, true);
      assert.equal(receipt.partialResult, true); assert.equal(receipt.partialDiagnosticChars, refusal.length);
      if (receipt.event === 'bridge_provider_call') assert.equal(receipt.outputChars, 0);
      assert.deepEqual(receipt.outputDetector, result.outputDetector);
    }
  }
  assert.equal(completeJsonLines(marker).length, before + 2, 'unusable refusal must not enter the success cache');
  const routed = await call('route_and_ask', { task: 'Review this JavaScript function and propose a deterministic test.',
    cwd: bridge.root, preferredProviders: ['gemini'], maxEscalations: 1, useCache: false });
  assert.equal(routed.attempts.length, 2, JSON.stringify(routed.attempts.map((item) => ({ kind: item.kind, failureClass: item.failureClass }))));
  assert.equal(routed.attempts[0].kind, 'gemini'); assert.equal(routed.attempts[0].failureClass, 'provider_refusal');
  assert.equal(routed.winner.kind, 'claude');
  assert.deepEqual(completeJsonLines(marker).slice(-2).map((row) => row.kind), ['gemini', 'claude'], 'no same-seat retry');
  const cooldowns = (await bridge.request('/api/cooldowns')).body.cooling;
  assert.equal(cooldowns.length, 0, 'semantic refusal/progress is not quota evidence');
});
