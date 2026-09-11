'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskQueue } = require('../lib/task-queue');
const { deliveryRecord, sanitizeResult, resultProjection, acknowledgeResult, MAX_RESULT_BYTES } = require('../lib/result-delivery');
const STORE = 'a'.repeat(64);
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const input = { kind: 'codex', prompt: 'bounded fixture', requestId: 'req_fixture' };
function payload(overrides = {}) { return { stdout: 'A complete answer 🙂', exitCode: 0, model_invocation: true,
  requestId: input.requestId, invocationId: input.requestId, attemptId: input.requestId + ':attempt:1', ...overrides }; }
function taskRecord(overrides = {}) {
  const record = { id: 't_fixture', body: input, status: 'done', delivery: deliveryRecord(input, STORE) };
  const clean = sanitizeResult(payload(), false, record);
  return { ...record, result: clean.text, resultEnvelope: clean.metadata, ...overrides };
}
function queue(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-delivery-'));
  let calls = 0;
  const opts = { dataDir, receiptStoreId: STORE, executeOneShot: async (body, res) => {
    calls++; res.json(payload({ requestId: body.requestId, invocationId: body.requestId, attemptId: body.requestId + ':attempt:1' }));
  }, ...options };
  const q = createTaskQueue(opts);
  t.after(() => { q.shutdown(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { q, opts, dataDir, calls: () => calls };
}
async function finished(q, id) {
  for (let i = 0; i < 100; i++) {
    if (['done', 'failed', 'interrupted', 'cancelled'].includes(q.get(id)?.status)) return q.get(id);
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('fixture result did not settle');
}

test('sanitization precedes bounding and hashes exact retained Unicode bytes', () => {
  const secret = 'x'.repeat(MAX_RESULT_BYTES + 10);
  const safe = sanitizeResult(payload({ stdout: 'Answer 🙂\napi_key=' + secret }), false, taskRecord());
  assert.equal(safe.text, 'Answer 🙂\napi_key=[REDACTED]');
  assert.equal(safe.metadata.bytes, Buffer.byteLength(safe.text));
  assert.equal(safe.metadata.sha256, sha(safe.text));
  assert.equal(safe.metadata.complete, true);
  const huge = sanitizeResult(payload({ stdout: 'x'.repeat(MAX_RESULT_BYTES + 1) }), false, taskRecord());
  assert.equal(huge.text, ''); assert.equal(huge.metadata.unavailableReason, 'result_size_limit');
  const excess = sanitizeResult(payload({ stdout: 'x'.repeat(2 * 1024 * 1024 + 1) }), false, taskRecord());
  assert.equal(excess.metadata.unavailableReason, 'redaction_input_limit');
});

test('recognized environment credentials are redacted without erasing evidence hashes', () => {
  for (const name of ['RELAYBRIDGE_TOKEN', 'PS_BRIDGE_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) {
    for (const assignment of [`${name}=${'a'.repeat(64)}`, `"${name}": "${'a'.repeat(64)}"`, `${name}='${'a'.repeat(64)}'`]) {
      const clean = sanitizeResult(payload({ stdout: assignment }), false, taskRecord());
      assert.doesNotMatch(clean.text, /a{64}/); assert.match(clean.text, /REDACTED/);
    }
  }
  const evidence = `source_sha256=${'b'.repeat(64)}`;
  assert.equal(sanitizeResult(payload({ stdout: evidence }), false, taskRecord()).text, evidence);
});

test('failure, partial, missing and contradictory output never becomes a complete answer', () => {
  for (const fields of [{ ok: false }, { partial_result: true }, { dropped_out: true }, { failureClass: 'timeout' },
    { error: 'provider failed' }, { exitCode: 2 }, { auth_failed: true }, { budget_exceeded: true }, { timed_out: true },
    { stdout_truncated: true }, { stdoutTruncated: true }, { prompt_truncated: true },
    { route: { prompt_truncated: true } }, { route: { prompt_evidence: { truncated: true } } }]) {
    const value = sanitizeResult(payload({ ...fields, provider_terminal_reason: 'end_turn' }), false, taskRecord());
    assert.equal(value.metadata.complete, false); assert.equal(value.metadata.partial, true);
    assert.equal(value.metadata.providerCompleted, null);
  }
  assert.equal(sanitizeResult(payload({ stdout: '' }), false, taskRecord()).metadata.complete, false);
  assert.equal(sanitizeResult(null, false, taskRecord()).metadata.complete, false);
});

test('collection rejects unverified or mismatched result correlation', () => {
  for (const fields of [{ requestId: null }, { requestId: 'req_wrong' }, { invocationId: 'req_wrong' },
    { attemptId: null }, { attemptId: 'req_fixture:attempt:0' }, { attemptId: 'req_other:attempt:1' }]) {
    const value = sanitizeResult(payload(fields), false, taskRecord());
    assert.equal(value.text, ''); assert.equal(value.metadata.unavailableReason, 'result_correlation_unverified');
  }
  const pinned = taskRecord({ correlation: { invocationId: input.requestId, attemptId: input.requestId + ':attempt:2' } });
  assert.equal(sanitizeResult(payload(), false, pinned).metadata.complete, false);
});

test('stored result validation fails closed on tampering, old schemas and impossible metadata', () => {
  const good = taskRecord();
  assert.equal(resultProjection(good, STORE).result, good.result);
  for (const patch of [{ bytes: 2 }, { sha256: 'f'.repeat(64) }, { complete: true, partial: true },
    { providerCompleted: true, partial: true }, { sanitizerVersion: 'unknown' }, { requestId: 'req_wrong' },
    { originalBytes: -1 }, { modelInvocation: 'yes' }]) {
    assert.equal(resultProjection({ ...good, resultEnvelope: { ...good.resultEnvelope, ...patch } }, STORE).resultPersisted, false);
  }
  assert.equal(resultProjection({ ...good, result: 'api_key=secret', resultEnvelope: {
    ...good.resultEnvelope, sha256: sha('api_key=secret'), bytes: 14 } }, STORE).resultPersisted, false);
  assert.throws(() => resultProjection({ ...good, delivery: undefined }, STORE), { code: 'DELIVERY_UNAVAILABLE' });
  assert.throws(() => resultProjection(good, 'b'.repeat(64)), { code: 'DELIVERY_UNAVAILABLE' });
});

test('acknowledgement binds exact sanitized bytes and store, is idempotent, and never approves', () => {
  const record = taskRecord();
  const identity = { receiptStoreId: STORE, sha256: record.resultEnvelope.sha256 };
  for (const bad of [{ ...identity, receiptStoreId: 'b'.repeat(64) }, { ...identity, sha256: 'f'.repeat(64) }]) {
    assert.throws(() => acknowledgeResult(record, bad, STORE, 1), { code: 'RESULT_IDENTITY_MISMATCH' });
  }
  const acked = acknowledgeResult(record, identity, STORE, 2);
  assert.equal(acked.status, record.status);
  assert.equal(resultProjection(acked, STORE).acknowledged, true);
  assert.equal(acknowledgeResult(acked, identity, STORE, 3), acked);
  assert.throws(() => resultProjection({ ...record, delivery: { ...record.delivery, acknowledgedAt: 0 } }, STORE), { code: 'DELIVERY_UNAVAILABLE' });
});

test('caller-known queued submission and collection survive recreation without replay or read writes', async t => {
  const { q, opts, dataDir, calls } = queue(t);
  const queuedInput = { ...input, requestId: undefined };
  const record = q.submitDurable('t_idempotent', queuedInput);
  assert.equal(q.getResult(record.id).resultState, 'pending');
  assert.equal(q.submitDurable(record.id, { ...queuedInput }).id, record.id);
  assert.throws(() => q.submitDurable(record.id, { ...queuedInput, prompt: 'different' }), { code: 'TASK_INTENT_CONFLICT' });
  await finished(q, record.id);
  assert.equal(calls(), 1);
  const filename = path.join(dataDir, record.id + '.json');
  const bytes = fs.readFileSync(filename), mtime = fs.statSync(filename).mtimeMs;
  const result = q.getResult(record.id);
  assert.equal(result.resultPersisted, true); assert.equal(result.acknowledged, false);
  assert.equal(result.metadata.providerCompleted, null, 'process response is not a provider terminal event');
  assert.equal(q.getResult(record.id).metadata.sha256, result.metadata.sha256);
  assert.deepEqual(fs.readFileSync(filename), bytes); assert.equal(fs.statSync(filename).mtimeMs, mtime);
  q.acknowledgeResult(record.id, { receiptStoreId: STORE, sha256: result.metadata.sha256 });
  q.shutdown();
  const restored = createTaskQueue(opts); t.after(() => restored.shutdown());
  assert.equal(restored.getResult(record.id).acknowledged, true);
  restored.submitDurable(record.id, queuedInput);
  await new Promise(setImmediate);
  assert.equal(calls(), 1);
});

test('cancelled queued delivery never installs a late answer or replays', async t => {
  let release, calls = 0;
  const { q } = queue(t, { executeOneShot: async (body, res) => {
    calls++; await new Promise(r => { release = r; }); res.json(payload());
  } });
  q.submitDurable('t_cancel', { ...input, requestId: undefined }); q._pump();
  await new Promise(setImmediate);
  q.cancel('t_cancel'); release(); await new Promise(setImmediate);
  assert.equal(q.getResult('t_cancel').resultState, 'unavailable');
  assert.equal(q.submitDurable('t_cancel', { ...input, requestId: undefined }).status, 'cancelled');
  assert.equal(calls, 1);
});

test('unknown legacy reservations block new delivery and remain unchanged', t => {
  const { q, opts, dataDir } = queue(t, { maxConcurrent: 1 }); q.shutdown();
  const legacy = { id: 't_legacy', kind: 'codex', status: 'interrupted', body: { prompt: 'legacy' } };
  const filename = path.join(dataDir, 't_legacy.json');
  fs.writeFileSync(filename, JSON.stringify(legacy));
  const other = createTaskQueue(opts); t.after(() => other.shutdown());
  const bytes = fs.readFileSync(filename);
  assert.equal(other.stats().uncertain, 1);
  assert.throws(() => other.submitDurable('t_blocked', { ...input, requestId: undefined }), { code: 'QUEUE_EXECUTION_UNCERTAIN' });
  assert.deepEqual(fs.readFileSync(filename), bytes);
  assert.equal(fs.existsSync(path.join(dataDir, 't_blocked.json')), false);
});

test('oversize prompts reject before persistence instead of silently losing the tail', t => {
  const { q, dataDir } = queue(t);
  assert.throws(() => q.submitDurable('t_oversize', { ...input, prompt: 'x'.repeat(100001) }), { code: 'INVALID_DELIVERY' });
  assert.equal(fs.existsSync(path.join(dataDir, 't_oversize.json')), false);
});

test('short task ids get accepted stable request ids and invalid explicit correlation cannot spend a call', async t => {
  const { q, calls } = queue(t);
  const record = q.submitDurable('t_a', { kind: 'codex', prompt: 'fixture' });
  await finished(q, record.id);
  assert.equal(q.getResult(record.id).metadata.requestId, 'queued:t_a');
  for (const patch of [{ requestId: 'short' }, { requestId: null }, { correlation: { invocationId: 'wrong' } },
    { correlation: { attemptId: 'req_fixture:attempt:2' } }]) {
    assert.throws(() => q.submitDurable('t_rejected', { ...input, ...patch }), { code: 'INVALID_DELIVERY' });
  }
  assert.equal(calls(), 1);
  assert.equal(sanitizeResult(payload(), 'provider_error', taskRecord()).metadata.partial, true);
});

test('collection rejects corrupt stored identities instead of projecting unchecked data', () => {
  for (const patch of [{ id: { secret: 'private' } }, { status: { secret: 'private' } }, { id: 't_other' }]) {
    assert.throws(() => resultProjection(taskRecord(patch), STORE, 't_fixture'), { code: 'DELIVERY_UNAVAILABLE' });
  }
});

test('acknowledging a corrupt file cannot overwrite a different task', t => {
  const { q, dataDir } = queue(t);
  const record = taskRecord({ id: 't_victim' });
  const source = path.join(dataDir, 't_source.json'), victim = path.join(dataDir, 't_victim.json');
  fs.writeFileSync(source, JSON.stringify(record));
  fs.writeFileSync(victim, JSON.stringify({ id: 't_victim', status: 'interrupted', body: { prompt: 'legacy' } }));
  const before = [fs.readFileSync(source), fs.readFileSync(victim)];
  assert.throws(() => q.acknowledgeResult('t_source', { receiptStoreId: STORE, sha256: record.resultEnvelope.sha256 }), { code: 'DELIVERY_UNAVAILABLE' });
  assert.deepEqual([fs.readFileSync(source), fs.readFileSync(victim)], before);
});

test('delivery receipts repair after restart without provider replay or duplicate acknowledgement', async t => {
  const { deliveryReceipts, createDeliveryReceiptSink } = require('../lib/delivery-receipts');
  const receipts = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-delivery-receipts-'));
  t.after(() => fs.rmSync(receipts, { recursive: true, force: true }));
  let unavailable = true;
  const sink = createDeliveryReceiptSink({ directory: receipts, append: receipt => {
    if (unavailable) throw new Error('fixture disk unavailable');
    fs.appendFileSync(path.join(receipts, receipt.timestamp.slice(0, 10) + '.jsonl'), JSON.stringify(receipt) + '\n');
  } });
  const { q, opts, calls } = queue(t, { appendDeliveryReceipt: sink });
  q.submitDurable('t_delivery_receipts', { kind: input.kind, prompt: input.prompt });
  const done = await finished(q, 't_delivery_receipts');
  assert.equal(done.status, 'done'); assert.equal(calls(), 1);
  assert.deepEqual(fs.readdirSync(receipts), []);
  unavailable = false;
  q.shutdown();
  const restored = createTaskQueue(opts); t.after(() => restored.shutdown());
  const result = restored.getResult(done.id);
  const acknowledgement = { receiptStoreId: STORE, sha256: result.metadata.sha256 };
  restored.acknowledgeResult(done.id, acknowledgement);
  restored.acknowledgeResult(done.id, acknowledgement);
  const rows = fs.readdirSync(receipts).flatMap(file => fs.readFileSync(path.join(receipts, file), 'utf8').trim().split('\n').map(JSON.parse));
  assert.deepEqual(rows.map(row => row.event), ['delivery_persisted', 'delivery_acknowledged']);
  assert.equal(rows[0].resultDelivered, false); assert.equal(rows[1].resultDelivered, true);
  assert.equal(rows[0].resultHash, result.metadata.sha256); assert.equal(calls(), 1);
  const conflicting = { ...deliveryReceipts(restored.get(done.id), STORE)[0], resultBytes: 1 };
  assert.throws(() => sink(conflicting), /identity conflict/);
  const before = JSON.stringify(rows);
  restored.getResult(done.id);
  assert.equal(JSON.stringify(rows), before);
});

test('cache/turn amplification is bounded provider-usage advice, never a stop', () => {
  const { usageAmplification } = require('../lib/usage-amplification');
  const advice = usageAmplification({ cacheReadTokens: 4651565, inputTokens: 0, outputTokens: 36998, turns: 51 });
  assert.equal(advice.action, 'review_efficiency'); assert.equal(advice.automaticStop, false);
  assert.equal(advice.repeatedTurnAmplification, true);
  assert.equal(usageAmplification({ turns: 100 }).action, 'none');
  assert.deepEqual(usageAmplification({ cacheReadTokens: 2000000, cacheCreationTokens: 100,
    inputTokens: 2000600, cacheInputIncluded: true, outputTokens: 100, turns: 50 }),
  usageAmplification({ cacheReadTokens: 2000000, cacheCreationTokens: 100,
    inputTokens: 500, cacheInputIncluded: false, outputTokens: 100, turns: 50 }));
});

test('legacy truncation metadata cannot publish complete delivery evidence', () => {
  const { deliveryReceipts } = require('../lib/delivery-receipts');
  for (const resultIntegrity of [{ truncated: true }, { inputTruncated: true }]) {
    const task = taskRecord({ resultIntegrity, finishedAt: 1000 });
    const projected = resultProjection(task, STORE);
    assert.equal(projected.metadata.complete, false);
    assert.equal(projected.metadata.partial, true);
    assert.equal(projected.metadata.providerCompleted, null);
    const receipt = deliveryReceipts(task, STORE)[0];
    assert.equal(receipt.complete, false);
    assert.equal(receipt.partial, true);
    assert.equal(receipt.providerCompleted, null);
  }
});
