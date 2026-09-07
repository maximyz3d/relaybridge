'use strict';

// The task queue exists so work survives the surface that started it: submit
// from a chat, collect from Cowork, or from the CLI, hours later.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTaskQueue } = require('../lib/task-queue');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rbtask-')); }

// A stand-in for executeOneShot that resolves when the test says so.
function fakeExecutor(behavior) {
  return async (body, res) => {
    const out = await behavior(body);
    if (out.throw) throw new Error(out.throw);
    if (out.statusCode) res.status(out.statusCode);
    res.json(out.payload);
  };
}

const settled = async (q, id, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    const t = q.get(id);
    if (t && ['done', 'failed', 'cancelled', 'interrupted'].includes(t.status)) return t;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`task ${id} never settled (status ${q.get(id)?.status})`);
};

test('aggregate queued includes admission backoff and removes cancelled waits', async (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const q = createTaskQueue({
    dataDir: dir,
    executeOneShot: async (_body, res) => {
      calls++;
      res.status(429).json({ failureClass: 'admission_limit', model_invocation: false });
    },
  });
  const task = q.submit({ kind: 'claude', prompt: 'wait for a seat' });
  q._pump();
  await new Promise(setImmediate);
  assert.equal(q.get(task.id).status, 'queued');
  assert.equal(q.stats().active, 0);
  assert.equal(q.stats().queued, 1, 'deferred admission is still queued work');
  q.cancel(task.id);
  assert.equal(q.stats().queued, 0);
  t.mock.timers.tick(1000);
  await new Promise(setImmediate);
  assert.equal(calls, 1, 'a cancelled admission wait never executes again');
});

test('a caller-reserved task id is persisted exactly once', async () => {
  const dir = tmpdir();
  const q = createTaskQueue({
    dataDir: dir,
    executeOneShot: fakeExecutor(async () => ({ payload: { stdout: 'reserved', exitCode: 0 } })),
  });
  const task = q.submitReserved('t_reserved_1', { kind: 'claude', prompt: 'bounded work' });
  assert.equal(task.id, 't_reserved_1');
  assert.throws(() => q.submitReserved('t_reserved_1', { kind: 'claude', prompt: 'duplicate' }),
    /task id already exists/);
  assert.equal((await settled(q, task.id)).status, 'done');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('submit returns immediately with an id; the result arrives later', async () => {
  const dir = tmpdir();
  let released;
  const gate = new Promise((r) => { released = r; });
  const q = createTaskQueue({
    dataDir: dir,
    executeOneShot: fakeExecutor(async () => { await gate; return { payload: { stdout: 'the answer', exitCode: 0 } }; }),
  });

  const task = q.submit({ kind: 'claude', prompt: 'do a long thing' });
  assert.match(task.id, /^t_/);
  assert.equal(task.status, 'queued');
  assert.equal(task.result, null, 'submit must not block for the result');

  released();
  const done = await settled(q, task.id);
  assert.equal(done.status, 'done');
  assert.equal(done.result, 'the answer');
  assert.equal(done.exitCode, 0);
  assert.ok(done.finishedAt >= done.startedAt);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('background tasks preserve every supported one-shot execution control', async () => {
  const dir = tmpdir();
  let executedBody;
  const q = createTaskQueue({
    dataDir: dir,
    executeOneShot: fakeExecutor(async (body) => {
      executedBody = body;
      return { payload: { stdout: 'done', exitCode: 0 } };
    }),
  });
  const { id } = q.submit({
    kind: 'claude',
    prompt: 'review a repository',
    providerBudget: { maxCacheReadTokens: 10000000 },
    budgetTaskTier: 'complex',
    taskTier: 'complex',
    modelTier: 'heavy',
    effort: 'max',
    maxEffortOverride: true,
    groundingOverride: true,
  });
  await settled(q, id);
  assert.deepEqual(executedBody.providerBudget, { maxCacheReadTokens: 10000000 });
  assert.equal(executedBody.budgetTaskTier, 'complex');
  assert.equal(executedBody.taskTier, 'complex');
  assert.equal(executedBody.modelTier, 'heavy');
  assert.equal(executedBody.effort, 'max');
  assert.equal(executedBody.maxEffortOverride, true);
  assert.equal(executedBody.groundingOverride, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('background tasks preserve invalid explicit controls so execution rejects instead of defaulting', async () => {
  const dir = tmpdir();
  let executedBody;
  const q = createTaskQueue({
    dataDir: dir,
    executeOneShot: fakeExecutor(async (body) => {
      executedBody = body;
      return { statusCode: 400, payload: { error: 'providerBudget must be an object', dropped_out: true } };
    }),
  });
  const { id } = q.submit({
    kind: 'claude', prompt: 'x', providerBudget: null, effort: 'invalid',
    taskTier: 7, modelTier: null, maxEffortOverride: 'true', groundingOverride: 1,
  });
  const failed = await settled(q, id);
  assert.equal(executedBody.providerBudget, null, 'explicit invalid null must not be erased into an inherited default');
  assert.equal(executedBody.effort, 'invalid', 'execution owns final validation of direct one-shot controls');
  assert.equal(executedBody.taskTier, 7);
  assert.equal(executedBody.modelTier, null);
  assert.equal(executedBody.maxEffortOverride, 'true');
  assert.equal(executedBody.groundingOverride, 1);
  assert.equal(failed.status, 'failed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a result written by one caller is readable by any other (durable on disk)', async () => {
  const dir = tmpdir();
  const q = createTaskQueue({ dataDir: dir, executeOneShot: fakeExecutor(async () => ({ payload: { stdout: 'persisted', exitCode: 0 } })) });
  const { id } = q.submit({ kind: 'codex', prompt: 'x', source: 'chat' });
  await settled(q, id);

  // A completely separate queue instance — as a different surface would be.
  const other = createTaskQueue({ dataDir: dir, executeOneShot: async () => {} });
  const seen = other.get(id);
  assert.equal(seen.result, 'persisted');
  assert.equal(seen.source, 'chat');
  assert.equal(other.list({ status: 'done' }).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failing run preserves typed retry evidence with its reason', async () => {
  const dir = tmpdir();
  const q = createTaskQueue({ dataDir: dir, executeOneShot: fakeExecutor(async () => ({ payload: {
    stdout: '', exitCode: 1, dropped_out: true, stop_detail: 'provider stalled',
    failureClass: 'rate_limit', rate_limited: true, retry_after: 17, retry_at: 1234567,
  } })) });
  const { id } = q.submit({ kind: 'grok', prompt: 'x' });
  const t = await settled(q, id);
  assert.equal(t.status, 'failed');
  assert.match(t.error, /stalled/);
  assert.equal(t.flags.dropped_out, true);
  assert.equal(t.failureClass, 'rate_limit');
  assert.equal(t.retryAfterSec, 17);
  assert.equal(t.retryAt, 1234567);
  assert.equal(q.list({ status: 'failed' })[0].failureClass, 'rate_limit');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an executor that throws still settles the task', async () => {
  const dir = tmpdir();
  const q = createTaskQueue({ dataDir: dir, executeOneShot: fakeExecutor(async () => ({ throw: 'spawn ENOENT' })) });
  const { id } = q.submit({ kind: 'missing', prompt: 'x' });
  const t = await settled(q, id);
  assert.equal(t.status, 'failed');
  assert.match(t.error, /ENOENT/);
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const [label, payload, expectedClass] of [
  ['budget exhaustion', { stdout: 'partial review', exitCode: 0, budget_exceeded: true, stop_reason: 'token_budget_total', stop_detail: 'cumulative token budget exceeded' }, 'budget'],
  ['timeout', { stdout: 'partial review', exitCode: 0, timed_out: true }, 'timeout'],
  ['nonzero exit', { stdout: 'partial review', exitCode: 2 }, 'provider_exit'],
  ['signal exit', { stdout: 'partial review', exitCode: -1 }, 'provider_exit'],
  ['typed failure', { stdout: 'partial review', exitCode: 0, failureClass: 'token_budget_total' }, 'token_budget_total'],
  ['empty output', { stdout: '  \n', exitCode: 0 }, 'no_verdict'],
  ['partial checkpoint', { stdout: 'unfinished review', exitCode: 0, partial_result: true }, 'no_verdict'],
  ['rate limit', { stdout: 'try later', exitCode: 0, rate_limited: true }, 'rate_limit'],
]) {
  test(`${label} at HTTP 200 is failed, never a completed verdict`, async () => {
    const dir = tmpdir();
    const failures = [];
    const q = createTaskQueue({
      dataDir: dir,
      onFailure: (task) => {
        assert.equal(q.get(task.id).status, 'failed', 'persist before reporting');
        failures.push(task);
      },
      executeOneShot: fakeExecutor(async () => ({ payload: { ...payload, receiptId: 'receipt_exact' } })),
    });
    const { id } = q.submit({ kind: 'claude', prompt: 'review' });
    const task = await settled(q, id);
    assert.equal(task.status, 'failed');
    assert.equal(task.failureClass, expectedClass);
    assert.equal(task.result, payload.stdout);
    assert.equal(task.receiptId, 'receipt_exact');
    assert.equal(task.stopReason, payload.stop_reason || null);
    assert.equal(task.stopDetail, payload.stop_detail || '');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].id, id);
    assert.equal(q.list({ status: 'done' }).length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

for (const asynchronous of [false, true]) {
  test(`a ${asynchronous ? 'rejecting' : 'throwing'} diagnostic sink cannot change failure or stop queue progress`, async () => {
    const dir = tmpdir();
    const messages = [];
    let calls = 0;
    const q = createTaskQueue({
      dataDir: dir, maxConcurrent: 1,
      log: (message) => messages.push(message),
      onFailure: (task) => {
        calls++;
        task.status = 'done';
        task.body.prompt = 'tampered';
        if (asynchronous) return Promise.reject(new Error('PRIVATE_SINK_DETAIL'));
        throw new Error('PRIVATE_SINK_DETAIL');
      },
      executeOneShot: fakeExecutor(async (body) => body.prompt === 'fail'
        ? { payload: { error: 'provider failed', model_invocation: false } } : { payload: { stdout: 'answer', exitCode: 0 } }),
    });
    const failedId = q.submit({ kind: 'claude', prompt: 'fail' }).id;
    const successId = q.submit({ kind: 'claude', prompt: 'success' }).id;
    const failed = await settled(q, failedId);
    assert.equal((await settled(q, successId)).status, 'done');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.body.prompt, 'fail');
    assert.equal(calls, 1, 'successful tasks must not invoke failure sink');
    assert.ok(messages.some((message) => message.includes('diagnostic sink failed')));
    assert.ok(messages.every((message) => !message.includes('PRIVATE_SINK_DETAIL')));
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('a silent handler is reported exactly once to the failure sink', async () => {
  const dir = tmpdir();
  const failures = [];
  const q = createTaskQueue({ dataDir: dir, executeOneShot: async () => {}, onFailure: (task) => failures.push(task) });
  const { id } = q.submit({ kind: 'claude', prompt: 'review' });
  assert.equal((await settled(q, id)).status, 'failed');
  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /without a response/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tasks interrupted by a bridge restart are reconciled, never left running', () => {
  const dir = tmpdir();
  // Simulate what a killed process leaves behind.
  fs.writeFileSync(path.join(dir, 't_abc123.json'), JSON.stringify({
    id: 't_abc123', status: 'running', kind: 'claude', createdAt: Date.now(), body: {},
  }));
  fs.writeFileSync(path.join(dir, 't_def456.json'), JSON.stringify({
    id: 't_def456', status: 'queued', kind: 'claude', createdAt: Date.now(), body: {},
  }));

  const failures = [];
  let executions = 0;
  const q = createTaskQueue({
    dataDir: dir, executeOneShot: async () => { executions++; },
    onFailure: (task) => {
      failures.push(task);
      throw new Error('diagnostic unavailable');
    },
  });
  for (const id of ['t_abc123', 't_def456']) {
    const t = q.get(id);
    assert.equal(t.status, 'interrupted', `${id} must not still claim to be running`);
    assert.equal(t.failureClass, 'interrupted');
    assert.match(t.error, /resubmit/);
    assert.ok(t.finishedAt, 'an interrupted task needs a finish time so pollers stop waiting');
  }
  assert.equal(failures.length, 2);
  q.reconcileOnStartup();
  assert.equal(failures.length, 2, 'terminal tasks must not be reported repeatedly');
  assert.equal(executions, 0, 'interrupted writes must never automatically replay');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('concurrency is capped; the rest queue rather than all firing at once', async () => {
  const dir = tmpdir();
  let concurrent = 0, peak = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const q = createTaskQueue({
    dataDir: dir, maxConcurrent: 2,
    executeOneShot: fakeExecutor(async () => {
      concurrent += 1; peak = Math.max(peak, concurrent);
      await gate;
      concurrent -= 1;
      return { payload: { stdout: 'ok', exitCode: 0 } };
    }),
  });

  const ids = [1, 2, 3, 4, 5].map((n) => q.submit({ kind: 'claude', prompt: `job ${n}` }).id);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(peak <= 2, `peak concurrency was ${peak}, cap was 2`);
  assert.equal(q.stats().queued, 3);

  release();
  for (const id of ids) await settled(q, id);
  assert.ok(peak <= 2, 'the cap must hold for the whole drain');
  assert.equal(q.list({ status: 'done' }).length, 5, 'every queued task must still run');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a queued task can be cancelled and never runs', async () => {
  const dir = tmpdir();
  let ran = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const q = createTaskQueue({
    dataDir: dir, maxConcurrent: 1,
    executeOneShot: fakeExecutor(async () => { ran += 1; await gate; return { payload: { stdout: 'ok', exitCode: 0 } }; }),
  });
  const first = q.submit({ kind: 'claude', prompt: 'blocker' });
  const second = q.submit({ kind: 'claude', prompt: 'cancel me' });
  await new Promise((r) => setTimeout(r, 30));

  const cancelled = q.cancel(second.id);
  assert.equal(cancelled.status, 'cancelled');
  release();
  await settled(q, first.id);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(ran, 1, 'the cancelled task must never have executed');
  assert.equal(q.get(second.id).status, 'cancelled');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a linked collab receives the result, so any surface can read the thread', async () => {
  const dir = tmpdir();
  const collabs = { c_1: { id: 'c_1', transcript: [] } };
  const q = createTaskQueue({
    dataDir: dir,
    executeOneShot: fakeExecutor(async () => ({ payload: { stdout: 'committee says yes', exitCode: 0 } })),
    readCollab: (id) => collabs[id] || null,
    writeCollab: (id, data) => { collabs[id] = data; return data; },
  });
  const { id } = q.submit({ kind: 'claude', prompt: 'ask the committee', collab: 'c_1' });
  await settled(q, id);
  assert.equal(collabs.c_1.transcript.length, 1);
  assert.equal(collabs.c_1.transcript[0].text, 'committee says yes');
  assert.equal(collabs.c_1.transcript[0].taskId, id);
  assert.equal(q.list({ collab: 'c_1' }).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('submission validates input and ids cannot escape the task directory', () => {
  const dir = tmpdir();
  const q = createTaskQueue({ dataDir: dir, executeOneShot: async () => {} });
  assert.throws(() => q.submit({ kind: 'claude', prompt: '   ' }), /prompt is required/);
  assert.throws(() => q.submit({ prompt: 'x' }), /kind/);
  for (const bad of ['../../etc/passwd', 't_../escape', 'nope']) {
    assert.throws(() => q.get(bad), /invalid task id/, `${bad} must be rejected`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('oversized output is truncated rather than filling the disk', async () => {
  const dir = tmpdir();
  const huge = 'x'.repeat(500000);
  const q = createTaskQueue({ dataDir: dir, executeOneShot: fakeExecutor(async () => ({ payload: { stdout: huge, exitCode: 0 } })) });
  const { id } = q.submit({ kind: 'claude', prompt: 'flood' });
  const t = await settled(q, id);
  assert.ok(t.result.length < huge.length, 'the result must be capped');
  assert.match(t.result, /truncated/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Regression: the capture response must satisfy the WHOLE Express interface
// executeOneShot uses, not just json/status. It registered disconnect listeners
// with res.once, the shim lacked it, and every task failed instantly with
// "res.once is not a function". The fake executor in the tests above never
// touched those methods, so nothing caught it.
test('the capture response supports every response method the real handler uses', async () => {
  const dir = tmpdir();
  const used = [];
  const q = createTaskQueue({
    dataDir: dir,
    // Exercise the same surface server.js actually calls on res.
    executeOneShot: async (body, res) => {
      res.once('close', () => {});   used.push('once');
      res.on('aborted', () => {});   used.push('on');
      res.setHeader('X-Test', '1');  used.push('setHeader');
      res.type('json');              used.push('type');
      if (res.writableEnded || res.destroyed) throw new Error('should not be ended yet');
      res.status(200).json({ stdout: 'ok', exitCode: 0 });
    },
  });
  const { id } = q.submit({ kind: 'claude', prompt: 'x' });
  const t = await settled(q, id);
  assert.equal(t.status, 'done', `task failed: ${t.error}`);
  assert.equal(t.result, 'ok');
  assert.deepEqual(used, ['once', 'on', 'setHeader', 'type']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a handler that writes twice settles the task once', async () => {
  const dir = tmpdir();
  const q = createTaskQueue({
    dataDir: dir,
    executeOneShot: async (body, res) => {
      res.json({ stdout: 'first', exitCode: 0 });
      res.json({ stdout: 'second', exitCode: 1 }); // late write, must be ignored
    },
  });
  const { id } = q.submit({ kind: 'claude', prompt: 'x' });
  const t = await settled(q, id);
  assert.equal(t.result, 'first', 'the first response wins, as with a real socket');
  assert.equal(t.status, 'done');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Regression: the bridge releases a one-shot admission slot on res 'finish' /
// 'close'. A real Express response emits those; the shim did not, so every
// background task leaked a slot. Four tasks wedged the bridge at "provider
// concurrency limit reached" with zero runs active, and restarting did not
// help because the same leak rebuilt the count.
test('the capture response emits finish/close so the concurrency slot is released', async () => {
  const dir = tmpdir();
  let released = 0;
  const q = createTaskQueue({
    dataDir: dir,
    executeOneShot: async (body, res) => {
      // Exactly what acquireOneShot() does.
      let done = false;
      const release = () => { if (!done) { done = true; released += 1; } };
      res.once('finish', release);
      res.once('close', release);
      res.json({ stdout: 'ok', exitCode: 0 });
    },
  });
  const { id } = q.submit({ kind: 'claude', prompt: 'x' });
  await settled(q, id);
  await new Promise((r) => setTimeout(r, 30)); // finish is emitted on the next tick
  assert.equal(released, 1, 'the admission slot must be released exactly once');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a handler that throws still releases its slot', async () => {
  const dir = tmpdir();
  let released = 0;
  const q = createTaskQueue({
    dataDir: dir,
    executeOneShot: async (body, res) => {
      res.once('finish', () => { released += 1; });
      throw new Error('provider blew up');
    },
  });
  const { id } = q.submit({ kind: 'claude', prompt: 'x' });
  const t = await settled(q, id);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(t.status, 'failed');
  assert.equal(released, 1, 'a crash must not leak the slot');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a handler that returns without responding is failed, not left hanging', async () => {
  const dir = tmpdir();
  let released = 0;
  const q = createTaskQueue({
    dataDir: dir,
    executeOneShot: async (body, res) => { res.once('close', () => { released += 1; }); /* no response */ },
  });
  const { id } = q.submit({ kind: 'claude', prompt: 'x' });
  const t = await settled(q, id);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(t.status, 'failed');
  assert.match(t.error, /without a response/);
  assert.equal(released, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a CLI-style handler may return before its child-process response arrives', async () => {
  const dir = tmpdir();
  const q = createTaskQueue({
    dataDir: dir,
    executeOneShot: async (body, res) => {
      res._relayDeferredResponse = true;
      setTimeout(() => res.json({ stdout: 'late CLI result', exitCode: 0 }), 25);
      // executeOneShot's CLI branch returns here after registering proc events.
    },
  });
  const { id } = q.submit({ kind: 'claude', prompt: 'x' });
  const t = await settled(q, id);
  assert.equal(t.status, 'done');
  assert.equal(t.result, 'late CLI result');
  fs.rmSync(dir, { recursive: true, force: true });
});

const flushQueue = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
const recoveryAuthorization = () => ({ authorized: true, ownerFenced: true, actor: 'test-owner', evidenceId: 'fence_1' });
const resumable = { mode: 'never-started', actor: 'operator', evidenceId: 'request_1' };

function durableFixture(t, overrides = {}) {
  const dir = tmpdir();
  const clock = { value: 10000 };
  const timers = new Map();
  let sequence = 0;
  const calls = [];
  const queues = [];
  const options = {
    dataDir: dir, now: () => clock.value,
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: clock.value + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    executeOneShot: async (body, res) => { calls.push(body); res.json({ stdout: 'done', exitCode: 0 }); },
    ...overrides,
  };
  const open = (extra = {}) => { const q = createTaskQueue({ ...options, ...extra }); queues.push(q); return q; };
  t.after(() => { for (const q of queues) q.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, clock, timers, calls, open,
    async advance(ms) {
      clock.value += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= clock.value) { timers.delete(id); timer.fn(); }
      await flushQueue();
    },
  };
}

test('deferred recovery preserves the deadline, controls and dependency ordering without duplicate dispatch', async (t) => {
  const f = durableFixture(t);
  const first = f.open();
  const a = first.submit({ kind: 'claude', prompt: 'first', notBefore: 12000, recovery: resumable,
    requestId: 'request_1', expectedCwdIdentityHash: 'exact-hash', expectedCwdPolicyId: 'exact-policy' });
  const b = first.submit({ kind: 'claude', prompt: 'second', dependsOn: [a.id], recovery: resumable });
  assert.deepEqual(first.stats(), { active: 0, queued: 2, maxConcurrent: 3, ready: 0, deferred: 1, blocked: 1, uncertain: 0 });
  first.shutdown();
  const restarted = f.open({ authorizeRecovery: recoveryAuthorization });
  restarted.reconcileOnStartup();
  restarted._pump();
  await f.advance(1999);
  assert.equal(f.calls.length, 0);
  await f.advance(1);
  await flushQueue();
  assert.deepEqual(f.calls.map((body) => body.prompt), ['first', 'second']);
  assert.equal(f.calls[0].requestId, 'request_1');
  assert.equal(f.calls[0].expectedCwdIdentityHash, 'exact-hash');
  assert.equal(f.calls[0].expectedCwdPolicyId, 'exact-policy');
  assert.equal(restarted.get(b.id).status, 'done');
  assert.equal(restarted.get(a.id).recovery.lastRecovery.evidenceId, 'fence_1');
});

test('admission due time survives restart and retries only a proven non-invocation', async (t) => {
  let attempts = 0;
  const f = durableFixture(t, { executeOneShot: async (_body, res) => {
    attempts++;
    if (attempts === 1) res.status(429).json({ failureClass: 'admission_limit', model_invocation: false, receiptId: 'rejection_1' });
    else res.json({ stdout: 'done', exitCode: 0 });
  } });
  const q = f.open();
  const task = q.submit({ kind: 'claude', prompt: 'wait', recovery: resumable });
  await flushQueue();
  assert.equal(q.get(task.id).nextAttemptAt, 11000);
  assert.equal(q.get(task.id).execution.state, 'not_invoked');
  assert.equal(q.stats().deferred, 1);
  q.shutdown();
  assert.equal(f.timers.size, 0);
  const next = f.open({ authorizeRecovery: recoveryAuthorization });
  await f.advance(999);
  assert.equal(attempts, 1);
  await f.advance(1);
  assert.equal(attempts, 2);
  assert.equal(next.get(task.id).status, 'done');
});

for (const proof of [undefined, () => [], () => ({ authorized: true }), () => { throw new Error('probe unavailable'); }]) {
  test('missing or incomplete recovery authority never resumes queued work', async (t) => {
    const f = durableFixture(t);
    const q = f.open();
    const task = q.submit({ kind: 'claude', prompt: 'never started', notBefore: 11000, recovery: resumable });
    q.shutdown();
    const restarted = f.open({ authorizeRecovery: proof });
    await f.advance(2000);
    assert.equal(restarted.get(task.id).status, 'interrupted');
    assert.equal(f.calls.length, 0);
  });
}

test('interrupted and legacy writers never replay, even with recovery authorization', async (t) => {
  const f = durableFixture(t);
  fs.writeFileSync(path.join(f.dir, 't_writer_1.json'), JSON.stringify({ id: 't_writer_1', status: 'running',
    body: { dangerous: true }, execution: { state: 'in_flight' } }));
  fs.writeFileSync(path.join(f.dir, 't_legacy_1.json'), JSON.stringify({ id: 't_legacy_1', status: 'queued', body: {} }));
  const q = f.open({ authorizeRecovery: recoveryAuthorization });
  await flushQueue();
  assert.equal(f.calls.length, 0);
  assert.equal(q.get('t_writer_1').status, 'interrupted');
  assert.equal(q.get('t_writer_1').execution.state, 'fenced');
  assert.equal(q.get('t_legacy_1').status, 'interrupted');
  assert.throws(() => q.submit({ kind: 'claude', prompt: 'writer', dangerous: true, recovery: resumable }), /read-only/);
});

for (const payload of [
  { failureClass: 'admission_limit' },
  { failureClass: 'admission_limit', model_invocation: true },
  { failureClass: 'admission_limit', model_invocation: false, physicalAttemptCount: 1 },
  { failureClass: 'vendor_exhausted', model_invocation: false },
  { failureClass: 'auth', model_invocation: false },
]) {
  test(`real provider gates and uncertain admission are terminal: ${JSON.stringify(payload)}`, async (t) => {
    let attempts = 0;
    const f = durableFixture(t, { executeOneShot: async (_body, res) => { attempts++; res.status(429).json(payload); } });
    const q = f.open();
    const task = q.submit({ kind: 'claude', prompt: 'bounded work' });
    await flushQueue();
    await f.advance(60000);
    assert.equal(q.get(task.id).status, 'failed');
    assert.equal(attempts, 1);
    assert.equal(f.timers.size, 0);
  });
}

test('admission backoff is bounded, cancellable, and expires without another dispatch', async (t) => {
  let attempts = 0;
  const f = durableFixture(t, { admissionWaitMs: 1500, executeOneShot: async (_body, res) => {
    attempts++; res.status(429).json({ failureClass: 'admission_limit', model_invocation: false });
  } });
  const q = f.open();
  const task = q.submit({ kind: 'claude', prompt: 'wait' });
  await flushQueue();
  await f.advance(1000);
  assert.equal(q.get(task.id).nextAttemptAt, 11500);
  await f.advance(500);
  assert.equal(q.get(task.id).status, 'failed');
  assert.equal(attempts, 2);
  assert.equal(f.timers.size, 0);
  const cancelled = q.submit({ kind: 'claude', prompt: 'cancel wait' });
  await flushQueue();
  q.cancel(cancelled.id);
  assert.equal(f.timers.size, 0);
  await f.advance(5000);
  assert.equal(attempts, 3);
  q.shutdown();
  q.shutdown();
  assert.throws(() => q.submit({ kind: 'claude', prompt: 'after shutdown' }), /shut down/);
});

test('dependencies fail closed and blocked tasks do not starve independent work', async (t) => {
  const f = durableFixture(t, { maxConcurrent: 1 });
  const q = f.open();
  const a = q.submit({ kind: 'claude', prompt: 'parent', notBefore: 12000 });
  const b = q.submit({ kind: 'claude', prompt: 'dependent', dependsOn: [a.id] });
  q.submit({ kind: 'claude', prompt: 'independent' });
  await flushQueue();
  assert.deepEqual(f.calls.map((body) => body.prompt), ['independent']);
  q.cancel(a.id);
  await flushQueue();
  assert.equal(q.get(b.id).failureClass, 'dependency_failed');
  assert.throws(() => q.submit({ kind: 'claude', prompt: 'bad edge', dependsOn: ['t_missing_1'] }), /existing tasks/);
  assert.throws(() => q.submit({ kind: 'claude', prompt: 'bad edge', dependsOn: [a.id, a.id] }), /distinct/);
});

test('running cancellation and repeated startup reconciliation retain a live execution slot', async (t) => {
  let response;
  const f = durableFixture(t, { maxConcurrent: 1, executeOneShot: async (_body, res) => {
    res._relayDeferredResponse = true; response = res;
  } });
  const q = f.open();
  const task = q.submit({ kind: 'claude', prompt: 'writer', dangerous: true });
  await flushQueue();
  q.cancel(task.id);
  q.reconcileOnStartup();
  assert.equal(q.stats().active, 1);
  assert.equal(q.get(task.id).execution.state, 'in_flight');
  q.shutdown();
  response.json({ stdout: 'late', exitCode: 0 });
  await flushQueue();
  assert.equal(q.get(task.id).status, 'cancelled');
  assert.equal(q.get(task.id).execution.state, 'settled');
  assert.equal(q.stats().active, 0);
});

test('silent or throwing executors reserve uncertain capacity until affirmative fencing', async (t) => {
  let proof = [];
  let attempts = 0;
  const f = durableFixture(t, { maxConcurrent: 1, authorizeRecovery: () => proof,
    executeOneShot: async (_body, res) => { attempts++; if (attempts === 1) throw new Error('unknown outcome'); res.json({ stdout: 'done' }); },
  });
  const q = f.open();
  const task = q.submit({ kind: 'claude', prompt: 'uncertain writer', dangerous: true });
  q.submit({ kind: 'claude', prompt: 'next' });
  await flushQueue();
  assert.equal(q.stats().uncertain, 1);
  assert.equal(attempts, 1);
  assert.throws(() => q.confirmStopped(task.id), /authoritative/);
  q._pump();
  assert.equal(attempts, 1);
  proof = recoveryAuthorization();
  q.confirmStopped(task.id);
  await flushQueue();
  assert.equal(attempts, 2);
  assert.equal(q.get(task.id).status, 'failed', 'fencing never replays the interrupted operation');
});
