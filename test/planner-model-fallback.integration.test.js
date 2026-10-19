'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startTestBridge, waitFor, completeJsonLines } = require('./helpers/temporary-bridge');

// These fixtures are synthetic local processes. They exercise the Bridge's
// own classification, receipts, queue and workflow lifecycle; they are not
// evidence that any real vendor emits this stream. Vendor compatibility for
// the Fable model_not_found pair remains PENDING until a retained real pair.
function fakeProvider(dir) {
  const fs = require('node:fs');
  const path = require('node:path');
  const argv = process.argv.slice(2);
  const valueAfter = (flag) => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : null; };
  const model = valueAfter('--model');
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    const modes = JSON.parse(fs.readFileSync(path.join(dir, 'mode.json'), 'utf8'));
    fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ model, effort: valueAfter('--effort'), argv,
      inputChars: input.length }) + '\n');
    const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const retry = (uuid, attempt, fields = {}) => ({ type: 'system', subtype: 'api_retry', uuid, attempt, max_retries: 10,
      retry_delay_ms: 0, error_status: 404, error: 'model_not_found', ...fields });
    const notFound = (fields = {}) => ({ type: 'result', subtype: 'error_during_execution', is_error: true,
      api_error_status: 404, terminal_reason: 'model_error', errors: [], permission_denials: [], modelUsage: {},
      usage: zero, ...fields });
    const limited = { type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 429,
      terminal_reason: 'api_error', errors: ['Retry-After: 120'], permission_denials: [], usage: zero };
    const success = { type: 'result', subtype: 'success', is_error: false, result: 'Fixture plan.\nPLAN_STATUS: READY',
      num_turns: 1, usage: { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    const zeroRow = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 };
    const assistant = { type: 'assistant', message: { id: 'm1', usage: zero, content: [{ type: 'text', text: 'Working.' }] } };
    const fable = {
      model_not_found: [retry('r1', 1), notFound()],
      with_init: [{ type: 'system', subtype: 'init', session_id: 'fixture' }, retry('r1', 1), retry('r2', 2), notFound()],
      bare_404: [notFound()],
      retry_then_success: [retry('r1', 1), success],
      then_429: [retry('r1', 1), limited],
      then_401: [retry('r1', 1), notFound({ api_error_status: 401 })],
      then_403: [retry('r1', 1), notFound({ api_error_status: 403 })],
      rate_limit_then_404: [retry('r0', 1, { error_status: 429, error: 'rate_limit' }), retry('r1', 2), notFound()],
      malformed_middle: [retry('r1', 1), '{"type":"system",', notFound()],
      no_final_newline: [retry('r1', 1), notFound()],
      too_many_retries: [...Array.from({ length: 257 }, (_, index) => retry(`r${index + 1}`, index + 1)), notFound()],
      duplicate_uuid: [retry('r1', 1), retry('r1', 2), notFound()],
      non_monotonic: [retry('r1', 1), retry('r2', 3), retry('r3', 2), notFound()],
      prior_assistant: [assistant, retry('r1', 1), notFound()],
      // 13 MiB of blank padding passes the default 12 MiB spill threshold and
      // pushes the forbidden assistant line out of the retained 8 MiB tail.
      spilled_prefix: [assistant, ...Array.from({ length: 13 * 1024 }, () => ' '.repeat(1023)), retry('r1', 1), notFound()],
      line_after_result: [retry('r1', 1), notFound(), retry('r2', 2)],
      errors_present: [retry('r1', 1), notFound({ errors: ['model_not_found'] })],
      errors_not_array: [retry('r1', 1), notFound({ errors: 'model_not_found' })],
      denial_present: [retry('r1', 1), notFound({ permission_denials: [{ tool_name: 'Read', tool_use_id: 'tu_1' }] })],
      denials_not_array: [retry('r1', 1), notFound({ permission_denials: {} })],
      model_usage_fable: [retry('r1', 1), notFound({ modelUsage: { fable: zeroRow } })],
      model_usage_other: [retry('r1', 1), notFound({ modelUsage: { 'claude-sonnet-5-5': zeroRow } })],
      usage_string_count: [retry('r1', 1), notFound({ usage: { input_tokens: 'bad', output_tokens: 1 } })],
      usage_unsafe_count: [retry('r1', 1), notFound({ usage: { ...zero, input_tokens: 2 ** 60 } })],
      usage_missing_count: [retry('r1', 1), notFound({ usage: { input_tokens: 0 } })],
      stop_refusal: [retry('r1', 1), notFound({ stop_reason: 'refusal' })],
    };
    const claude = { success: [success], rate_limit: [limited] };
    const mode = model === 'fable' ? modes.fable : modes.claude;
    if (mode === 'stderr_only') {
      process.stderr.write('API Error: 404 model_not_found: fable\n');
      process.exitCode = 1;
      return;
    }
    const lines = (model === 'fable' ? fable : claude)[mode];
    const text = lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n');
    process.stdout.write(mode === 'no_final_newline' ? text : text + '\n');
    process.exitCode = lines.at(-1) === success ? 0 : 1;
  });
}

function providerConfig(script) {
  const seat = (label, model, effort) => ({ label, transport: 'subscription:anthropic',
    quota_seat: 'subscription:anthropic:default', oneshot_output_parser: 'claude_json',
    oneshot_safe: [process.execPath, script, '--model', model, '--effort', effort], oneshot_dangerous: [],
    oneshot_safe_filesystem_policy: 'read_only_enforced',
    // Mirrors cli-config.json: planning needs declared workspace grounding.
    oneshot_capabilities: { safe: ['model_invocation', 'workspace_read', 'tool_use'] } });
  const tier = (model) => ({ args: ['--model', model], model });
  return {
    _models: { discoverOnBoot: false },
    claude: { ...seat('Claude fixture', 'sonnet', 'medium'), models_static: ['opus', 'sonnet', 'haiku'],
      model_tiers: { light: tier('haiku'), standard: tier('sonnet'), heavy: tier('opus') } },
    claude_fable: { ...seat('Claude Fable fixture', 'fable', 'high'), model: 'fable', models_static: ['fable'],
      model_tiers: { heavy: tier('fable') } },
  };
}

async function startBridge(t, modes, { dir } = {}) {
  let stateDir;
  const bridge = await startTestBridge(t, (root) => {
    stateDir = dir || root;
    const script = path.join(stateDir, 'provider.cjs');
    fs.writeFileSync(script, `'use strict';(${fakeProvider})(${JSON.stringify(stateDir)});\n`);
    fs.writeFileSync(path.join(stateDir, 'mode.json'), JSON.stringify(modes));
    return providerConfig(script);
  }, { env: { RELAYBRIDGE_WARM_DIAG: '0', RELAYBRIDGE_REMOTE_MCP: '0',
    ...(dir ? { RELAYBRIDGE_DATA_DIR: path.join(dir, 'data'), RELAYBRIDGE_ALLOWED_ROOTS: dir } : {}) } });
  return { ...bridge, stateDir, dataDir: path.join(stateDir, 'data') };
}

async function shutdown(bridge) {
  try { await fetch(bridge.base + '/api/admin/shutdown', { method: 'POST', headers: bridge.headers }); } catch {}
  await waitFor(() => bridge.proc.exitCode !== null || bridge.proc.signalCode !== null, 10000);
}

const calls = (bridge) => completeJsonLines(path.join(bridge.stateDir, 'calls.jsonl'));
const callModels = (bridge) => calls(bridge).map((call) => [call.model, call.effort]);

function receipts(bridge) {
  const dir = path.join(bridge.dataDir, 'receipts');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort()
    .flatMap((name) => completeJsonLines(path.join(dir, name)));
}
const providerCalls = (bridge) => receipts(bridge).filter((receipt) => receipt.event === 'bridge_provider_call');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function settledTask(bridge, taskId) {
  let task;
  await waitFor(async () => {
    task = (await bridge.request('/api/tasks/' + taskId)).body;
    return !!task?.status && !['queued', 'running'].includes(task.status);
  }, 20000);
  return task;
}

async function reconcile(bridge, prefix) {
  const response = await bridge.request(prefix + '/reconcile', {});
  assert.equal(response.status, 202, JSON.stringify(response.body));
  return response.body.workflow;
}

async function startPlanning(bridge, taskTier) {
  const created = await bridge.request('/api/workflows', { cwd: bridge.stateDir,
    objective: 'Plan the connected planner fallback fixture.', acceptance: 'A complete read-only plan.',
    taskTier, providerPreferences: { planning: ['claude_fable'] } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const prefix = '/api/workflows/' + created.body.workflow.runId;
  const research = await bridge.request(prefix + '/research', { markdown: 'Fixture research.' });
  assert.equal(research.status, 202, JSON.stringify(research.body));
  assert.equal(research.body.task.kind, 'claude_fable');
  return { prefix, runId: created.body.workflow.runId, fable: await settledTask(bridge, research.body.task.id) };
}

// The real queue, receipt and route for the Fable attempt: a launched model
// invocation that settled with Bridge-owned model_unavailable evidence.
function assertFableModelUnavailable(bridge, fable, effort) {
  assert.equal(fable.kind, 'claude_fable');
  assert.equal(fable.status, 'failed', JSON.stringify(fable));
  assert.equal(fable.failureClass, 'model_unavailable');
  assert.deepEqual(fable.execution, { state: 'settled', settledAt: fable.execution.settledAt, receiptId: fable.receiptId });
  assert.equal(fable.route.requested_model, 'fable');
  assert.equal(fable.route.resolved_outgoing_model, 'fable');
  assert.equal(fable.route.model_flag_sent, '--model');
  assert.equal(fable.route.observed_model, null);
  assert.equal(fable.providerMetadata.model_invocation, true);
  assert.equal(fable.providerMetadata.physical_attempt_count, 1);
  const evidence = fable.providerMetadata.provider_action_required;
  assert.equal(evidence.kind, 'bridge_claude_model_unavailable');
  assert.equal(evidence.vendorModelEcho, null);
  assert.equal(evidence.selectedModelSource, 'bridge_dispatch');
  const fableReceipts = providerCalls(bridge).filter((receipt) => receipt.provider === 'claude_fable');
  assert.equal(fableReceipts.length, 1);
  const [receipt] = fableReceipts;
  assert.equal(receipt.receiptId, fable.receiptId);
  assert.equal(receipt.status, 'dropped');
  assert.equal(receipt.modelInvocation, true);
  assert.equal(receipt.physicalAttemptCount, 1);
  assert.equal(receipt.tokenUsageSource, 'provider_reported');
  assert.equal(receipt.actualOutputTokens, 0);
  assert.deepEqual(receipt.modelUsage, []);
  assert.equal(receipt.providerApiErrorStatus, 404);
  assert.equal(receipt.providerTerminalReason, 'model_error');
  assert.deepEqual(receipt.providerRetryByError, { model_not_found: evidence.retryEvents.length });
  assert.deepEqual(receipt.providerActionRequired, evidence);
  assert.equal(receipt.cooldown, null);
  assert.deepEqual(calls(bridge).filter((call) => call.model === 'fable').map((call) => call.effort), [effort]);
  return evidence;
}

function assertReplacementBound(workflow, fable, evidence, modelTier, effort) {
  assert.equal(workflow.phase, 'planning');
  assert.equal(workflow.writerLease, null);
  assert.equal(workflow.providerRetry, null);
  assert.equal(workflow.providerTask.provider, 'claude');
  assert.equal(workflow.providerTask.purpose, 'planning');
  assert.equal(workflow.providerTask.attempt, 1);
  assert.equal(workflow.providerTask.modelTier, modelTier);
  assert.equal(workflow.providerTask.effort, effort);
  assert.notEqual(workflow.providerTask.taskId, fable.id);
  assert.deepEqual(workflow.planningReplacement, {
    version: 1,
    failed: { taskId: fable.id, provider: 'claude_fable', model: 'fable', attemptId: `${fable.id}:attempt:1`,
      receiptId: fable.receiptId, evidenceHash: crypto.createHash('sha256').update(canonicalJson(evidence)).digest('hex'),
      failureClass: 'model_unavailable' },
    replacementProvider: 'claude',
    excludedProviders: ['claude_fable'],
    scheduledAt: workflow.planningReplacement.scheduledAt,
    firstReplacementTaskId: workflow.providerTask.taskId,
    currentTaskId: workflow.providerTask.taskId,
  });
  const archived = workflow.providerTaskHistory.at(-1);
  assert.equal(archived.taskId, fable.id);
  assert.equal(archived.provider, 'claude_fable');
  assert.equal(archived.outcome, 'replacement_scheduled');
}

async function assertReplacementCompletes(bridge, prefix, bound, model, effort, fableEffort) {
  const replacement = await settledTask(bridge, bound.providerTask.taskId);
  assert.equal(replacement.kind, 'claude');
  assert.equal(replacement.status, 'done', JSON.stringify(replacement));
  assert.equal(replacement.body.dangerous, false);
  assert.equal(replacement.body.model, null);
  assert.equal(replacement.route.requested_model, model);
  const ready = await reconcile(bridge, prefix);
  assert.equal(ready.phase, 'plan_ready');
  assert.equal(ready.writerLease, null);
  assert.deepEqual(ready.planningReplacement, bound.planningReplacement);
  assert.deepEqual(callModels(bridge), [['fable', fableEffort], [model, effort]]);
  const provider = providerCalls(bridge);
  assert.deepEqual(provider.map((receipt) => receipt.provider), ['claude_fable', 'claude']);
  assert.equal(provider[1].receiptId, replacement.receiptId);
  assert.equal(provider[1].status, 'completed');
  assert.equal(provider[1].modelInvocation, true);
  const tasks = (await bridge.request('/api/tasks')).body.tasks;
  assert.deepEqual(tasks.map((task) => task.kind).sort(), ['claude', 'claude_fable']);
  return ready;
}

for (const [label, taskTier, model, effort] of [
  ['complex Fable planning continues on Claude opus in the same reconcile', 'complex', 'opus', 'high'],
  ['standard Fable planning continues on Claude sonnet in the same reconcile', 'standard', 'sonnet', 'medium'],
]) {
  test(label, { timeout: 60000 }, async (t) => {
    const bridge = await startBridge(t, { fable: 'model_not_found', claude: 'success' });
    const { prefix, fable } = await startPlanning(bridge, taskTier);
    const evidence = assertFableModelUnavailable(bridge, fable, effort);
    const bound = await reconcile(bridge, prefix);
    assertReplacementBound(bound, fable, evidence, taskTier === 'complex' ? 'heavy' : 'standard', effort);
    await assertReplacementCompletes(bridge, prefix, bound, model, effort, effort);
    const after = (await bridge.request('/api/tasks/' + fable.id)).body;
    assert.equal(after.failureClass, 'model_unavailable');
    assert.equal(after.receiptId, fable.receiptId);
  });
}

test('an init line and several ordered model_not_found retries remain eligible', { timeout: 60000 }, async (t) => {
  const bridge = await startBridge(t, { fable: 'with_init', claude: 'success' });
  const { prefix, fable } = await startPlanning(bridge, 'complex');
  const evidence = assertFableModelUnavailable(bridge, fable, 'high');
  assert.deepEqual(evidence.retryEvents.map((event) => [event.line, event.attempt]), [[2, 1], [3, 2]]);
  const bound = await reconcile(bridge, prefix);
  assertReplacementBound(bound, fable, evidence, 'heavy', 'high');
  await assertReplacementCompletes(bridge, prefix, bound, 'opus', 'high', 'high');
});

test('a bridge restart after the Fable settle continues exactly once on Claude', { timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-planner-fallback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const modes = { fable: 'model_not_found', claude: 'success' };
  const first = await startBridge(t, modes, { dir });
  const { prefix, fable } = await startPlanning(first, 'complex');
  const evidence = assertFableModelUnavailable(first, fable, 'high');
  await shutdown(first);

  const second = await startBridge(t, modes, { dir });
  const restored = (await second.request('/api/tasks/' + fable.id)).body;
  assert.equal(restored.failureClass, 'model_unavailable');
  assert.deepEqual(restored.providerMetadata.provider_action_required, evidence);
  const viewed = (await second.request(prefix + '?includeArtifacts=false')).body.workflow;
  assert.equal(viewed.planningReplacement, null);
  const bound = await reconcile(second, prefix);
  assertReplacementBound(bound, fable, evidence, 'heavy', 'high');
  const repeated = await reconcile(second, prefix);
  assert.equal(repeated.planningReplacement.firstReplacementTaskId, bound.providerTask.taskId);
  await assertReplacementCompletes(second, prefix, bound, 'opus', 'high', 'high');
  await shutdown(second);
});

test('concurrent reconciles schedule and dispatch one replacement', { timeout: 60000 }, async (t) => {
  const bridge = await startBridge(t, { fable: 'model_not_found', claude: 'success' });
  const { prefix, fable } = await startPlanning(bridge, 'complex');
  const evidence = assertFableModelUnavailable(bridge, fable, 'high');
  const responses = await Promise.all([1, 2, 3, 4].map(() => bridge.request(prefix + '/reconcile', {})));
  for (const response of responses) assert.equal(response.status, 202, JSON.stringify(response.body));
  const replacementIds = new Set(responses.map((response) => response.body.workflow.planningReplacement?.firstReplacementTaskId));
  assert.equal(replacementIds.size, 1);
  assert.equal([...replacementIds][0].length > 0, true);
  const bound = responses[0].body.workflow;
  assertReplacementBound(bound, fable, evidence, 'heavy', 'high');
  await assertReplacementCompletes(bridge, prefix, bound, 'opus', 'high', 'high');
});

test('an admitted Claude 429 retries on Claude only and differs from a pre-admission refusal', { timeout: 60000 }, async (t) => {
  const bridge = await startBridge(t, { fable: 'model_not_found', claude: 'rate_limit' });
  const { prefix, fable } = await startPlanning(bridge, 'complex');
  const evidence = assertFableModelUnavailable(bridge, fable, 'high');
  const bound = await reconcile(bridge, prefix);
  assertReplacementBound(bound, fable, evidence, 'heavy', 'high');
  const limited = await settledTask(bridge, bound.providerTask.taskId);
  assert.equal(limited.kind, 'claude');
  assert.equal(limited.status, 'failed');
  assert.equal(limited.failureClass, 'rate_limit');
  assert.equal(limited.execution.state, 'settled');
  assert.equal(limited.flags.rate_limited, true);

  const retrying = await reconcile(bridge, prefix);
  assert.equal(retrying.phase, 'planning');
  assert.equal(retrying.providerTask, null);
  assert.equal(retrying.providerRetry.failedProvider, 'claude');
  assert.equal(retrying.providerRetry.failedTaskId, limited.id);
  assert.equal(retrying.providerRetry.nextAttempt, 2);
  assert.ok(retrying.providerRetry.retryAt > Date.now());
  assert.equal(retrying.planningReplacement.firstReplacementTaskId, limited.id);
  assert.equal(retrying.planningReplacement.currentTaskId, limited.id);

  // The admitted 429 launched the model once; the shared seat now cools.
  const admitted = providerCalls(bridge).find((receipt) => receipt.receiptId === limited.receiptId);
  assert.equal(admitted.provider, 'claude');
  assert.equal(admitted.status, 'dropped');
  assert.equal(admitted.modelInvocation, true);
  assert.equal(admitted.physicalAttemptCount, 1);
  assert.equal(admitted.providerApiErrorStatus, 429);
  // A refusal while that seat cools never launches the model.
  const refused = await bridge.request('/api/oneshot', { kind: 'claude', prompt: 'Pre-admission fixture.', dangerous: false });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.model_invocation, false);
  assert.equal(refused.body.physical_attempt_count, 0);
  const rejection = receipts(bridge).find((receipt) => receipt.receiptId === refused.body.receiptId);
  assert.equal(rejection.event, 'bridge_provider_rejection');
  assert.equal(rejection.modelInvocation, false);
  assert.equal(rejection.physicalAttemptCount, 0);

  const waiting = await reconcile(bridge, prefix);
  assert.equal(waiting.providerTask, null);
  assert.deepEqual(waiting.providerRetry, retrying.providerRetry);
  assert.deepEqual(callModels(bridge), [['fable', 'high'], ['opus', 'high']]);
  assert.deepEqual(providerCalls(bridge).map((receipt) => receipt.provider), ['claude_fable', 'claude']);
  const tasks = (await bridge.request('/api/tasks')).body.tasks;
  assert.deepEqual(tasks.map((task) => task.kind).sort(), ['claude', 'claude_fable']);
});

for (const mode of ['bare_404', 'stderr_only', 'retry_then_success', 'then_429', 'then_401', 'then_403',
  'rate_limit_then_404', 'malformed_middle', 'no_final_newline', 'too_many_retries', 'duplicate_uuid', 'non_monotonic',
  'prior_assistant', 'line_after_result', 'errors_present', 'errors_not_array', 'denial_present', 'denials_not_array',
  'model_usage_fable', 'model_usage_other', 'usage_string_count', 'usage_unsafe_count', 'usage_missing_count',
  'stop_refusal', 'spilled_prefix']) {
  test(`no Claude replacement for an ineligible Fable stream: ${mode}`, { timeout: 60000 }, async (t) => {
    const bridge = await startBridge(t, { fable: mode, claude: 'success' });
    const { prefix, fable } = await startPlanning(bridge, 'complex');
    if (mode === 'retry_then_success') assert.equal(fable.status, 'done', JSON.stringify(fable));
    else assert.equal(fable.status, 'failed', JSON.stringify(fable));
    assert.notEqual(fable.failureClass, 'model_unavailable');
    assert.notEqual(fable.providerMetadata?.provider_action_required?.kind, 'bridge_claude_model_unavailable');
    const [receipt, ...rest] = providerCalls(bridge);
    assert.ok(receipt, `the Fable CLI must launch and persist a provider-call receipt: ${JSON.stringify(fable)}`);
    assert.equal(rest.length, 0);
    assert.equal(receipt.provider, 'claude_fable');
    assert.equal(receipt.receiptId, fable.receiptId);
    assert.equal(receipt.modelInvocation, true);
    assert.equal(receipt.physicalAttemptCount, 1);
    assert.notEqual(receipt.providerActionRequired?.kind, 'bridge_claude_model_unavailable');
    if (mode === 'spilled_prefix') {
      // Real spill happened and only the tail without the assistant line was retained.
      const runsDir = path.join(bridge.dataDir, 'runs');
      assert.ok(fs.readdirSync(runsDir).some((name) => name.endsWith('.output-spill.log')));
      assert.ok(receipt.transportOutputChars <= 8 * 1024 * 1024, String(receipt.transportOutputChars));
    }

    const workflow = await reconcile(bridge, prefix);
    assert.equal(workflow.planningReplacement, null);
    assert.notEqual(workflow.providerTask?.provider, 'claude');
    assert.notEqual(workflow.providerRetry?.failedProvider, 'claude');
    if (mode === 'retry_then_success') assert.equal(workflow.phase, 'plan_ready');
    const tasks = (await bridge.request('/api/tasks')).body.tasks;
    assert.equal(tasks.some((task) => task.kind === 'claude'), false);
    assert.equal(calls(bridge).some((call) => call.model !== 'fable'), false);
  });
}
