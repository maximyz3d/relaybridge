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

test('a failing run is recorded as failed with its reason, not silently lost', async () => {
  const dir = tmpdir();
  const q = createTaskQueue({ dataDir: dir, executeOneShot: fakeExecutor(async () => ({ payload: { stdout: '', exitCode: 1, dropped_out: true, stop_detail: 'provider stalled' } })) });
  const { id } = q.submit({ kind: 'grok', prompt: 'x' });
  const t = await settled(q, id);
  assert.equal(t.status, 'failed');
  assert.match(t.error, /stalled/);
  assert.equal(t.flags.dropped_out, true);
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

test('tasks interrupted by a bridge restart are reconciled, never left running', () => {
  const dir = tmpdir();
  // Simulate what a killed process leaves behind.
  fs.writeFileSync(path.join(dir, 't_abc123.json'), JSON.stringify({
    id: 't_abc123', status: 'running', kind: 'claude', createdAt: Date.now(), body: {},
  }));
  fs.writeFileSync(path.join(dir, 't_def456.json'), JSON.stringify({
    id: 't_def456', status: 'queued', kind: 'claude', createdAt: Date.now(), body: {},
  }));

  const q = createTaskQueue({ dataDir: dir, executeOneShot: async () => {} });
  for (const id of ['t_abc123', 't_def456']) {
    const t = q.get(id);
    assert.equal(t.status, 'interrupted', `${id} must not still claim to be running`);
    assert.match(t.error, /resubmit/);
    assert.ok(t.finishedAt, 'an interrupted task needs a finish time so pollers stop waiting');
  }
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
