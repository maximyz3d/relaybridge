'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createRequestLimiter, createOperationSlots, createReadOperationPool } = require('../lib/operation-admission');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('child admission stays bounded until its idempotent release', () => {
  const slots = createOperationSlots({ limit: 1 });
  const release = slots.acquire();
  assert.throws(() => slots.acquire(), { code: 'operation_admission_limit' });
  release(); release();
  assert.equal(slots.snapshot().active, 0);
  slots.acquire()();
  assert.equal(slots.snapshot().active, 0);
});

test('read singleflight shares execution and permits independent subscriber cancellation', async () => {
  const pool = createReadOperationPool({ maxActive: 1 });
  const done = deferred();
  const caller = new AbortController();
  let invoked = 0, workerSignal;
  const work = (signal) => { invoked++; workerSignal = signal; return done.promise; };
  const first = pool.run('same', work, { signal: caller.signal });
  const firstRejected = assert.rejects(first, { name: 'AbortError', code: 'operation_cancelled' });
  const second = pool.run('same', work);
  await tick();
  caller.abort();
  await firstRejected;
  assert.equal(invoked, 1);
  assert.equal(workerSignal.aborted, false);
  done.resolve({ ok: true });
  assert.deepEqual(await second, { ok: true });
  assert.equal(pool.snapshot().active, 0);
});

test('last cancellation aborts work but retains admission until cleanup settles', async () => {
  const pool = createReadOperationPool({ maxActive: 1, maxQueued: 1 });
  const done = deferred(), caller = new AbortController();
  let oldSignal, newInvocations = 0;
  const first = pool.run('same', (signal) => { oldSignal = signal; return done.promise; }, { signal: caller.signal });
  const rejected = assert.rejects(first, { code: 'operation_cancelled' });
  await tick();
  caller.abort();
  await rejected;
  await assert.rejects(pool.run('same', () => assert.fail('draining duplicate')), /still draining/);
  const second = pool.run('different', () => { newInvocations++; return 'new'; });
  await tick();
  assert.equal(oldSignal.aborted, true);
  assert.equal(pool.snapshot().active, 1);
  assert.equal(pool.snapshot().queued, 1);
  assert.equal(newInvocations, 0);
  await assert.rejects(pool.run('overflow', () => 'no'), { code: 'operation_admission_limit' });
  done.resolve('abandoned');
  assert.equal(await second, 'new');
  assert.equal(newInvocations, 1);
  assert.equal(pool.snapshot().shared, 0);
});

test('draining singleflight cannot restart the same key even when another global slot is free', async () => {
  const pool = createReadOperationPool({ maxActive: 2 });
  const done = deferred(), caller = new AbortController();
  const first = pool.run('same', () => done.promise, { signal: caller.signal });
  const rejected = assert.rejects(first, { code: 'operation_cancelled' });
  await tick();
  caller.abort();
  await rejected;
  await assert.rejects(pool.run('same', () => assert.fail('overlapping keyed operation')), /still draining/);
  assert.equal(await pool.run('other', () => 'independent'), 'independent');
  assert.equal(pool.snapshot().active, 1);
  done.resolve();
  await tick();
  assert.equal(await pool.run('same', () => 'clean restart'), 'clean restart');
});

test('bounded queue drains FIFO, removes cancelled queued jobs, and recovers after failures', async () => {
  const pool = createReadOperationPool({ maxActive: 1, maxQueued: 2 });
  const done = deferred(), queuedCaller = new AbortController(), order = [];
  const first = pool.run('first', () => { order.push('first'); return done.promise; });
  const firstRejected = assert.rejects(first, /worker failed/);
  const cancelled = pool.run('cancelled', () => { throw new Error('must not run'); }, { signal: queuedCaller.signal });
  const cancelledRejected = assert.rejects(cancelled, { code: 'operation_cancelled' });
  const second = pool.run('second', () => { order.push('second'); throw new Error('sync failure'); });
  const secondRejected = assert.rejects(second, /sync failure/);
  await assert.rejects(pool.run('full', () => null), { code: 'operation_admission_limit' });
  queuedCaller.abort();
  await cancelledRejected;
  const third = pool.run('third', () => { order.push('third'); return 3; });
  done.reject(new Error('worker failed'));
  await firstRejected;
  await secondRejected;
  assert.equal(await third, 3);
  assert.deepEqual(order, ['first', 'second', 'third']);
  assert.deepEqual(pool.snapshot(), { active: 0, queued: 0, shared: 0, maxActive: 1, maxQueued: 2 });
});

test('singleflight subscribers and zero-queue configuration are bounded', async () => {
  const pool = createReadOperationPool({ maxActive: 1, maxQueued: 0, maxSubscribers: 2 });
  const done = deferred();
  const first = pool.run('same', () => done.promise);
  const second = pool.run('same', () => 'must not run');
  await assert.rejects(pool.run('same', () => null), /too many subscribers/);
  await assert.rejects(pool.run('other', () => null), /queue is full/);
  done.resolve('shared');
  assert.deepEqual(await Promise.all([first, second]), ['shared', 'shared']);
});

test('pre-cancelled and invalid requests never execute or occupy capacity', async () => {
  const pool = createReadOperationPool();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(pool.run('cancelled', () => assert.fail('must not run'), { signal: controller.signal }), { code: 'operation_cancelled' });
  await assert.rejects(pool.run('', () => null), TypeError);
  await assert.rejects(pool.run('key', null), TypeError);
  for (const signal of [{}, null, { aborted: false }, 'signal']) {
    await assert.rejects(pool.run('malformed', () => assert.fail('must not run'), { signal }), TypeError);
  }
  assert.equal(pool.snapshot().active, 0);
  assert.equal(pool.snapshot().shared, 0);
  assert.throws(() => createReadOperationPool({ maxActive: 0 }), TypeError);
  assert.throws(() => createOperationSlots({ limit: Infinity }), TypeError);
  assert.throws(() => createRequestLimiter({ family: '../bad' }), TypeError);
});

test('falsy worker rejection values remain rejections and release capacity', async () => {
  const pool = createReadOperationPool({ maxActive: 1 });
  for (const reason of [undefined, null, false, 0, '']) {
    const [result] = await Promise.allSettled([pool.run('key', () => Promise.reject(reason))]);
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, reason);
    assert.equal(pool.snapshot().active, 0);
  }
});

test('request rate limiting runs after authentication and returns typed zero-spend 429', async (t) => {
  const app = express(); let work = 0;
  app.use((req, res, next) => req.headers.authorization === 'fixture' ? next() : res.sendStatus(401));
  app.get('/expensive', createRequestLimiter({ family: 'test_read', limit: 2 }), (req, res) => { work++; res.json({ ok: true }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/expensive`;
  for (let n = 0; n < 3; n++) assert.equal((await fetch(url)).status, 401);
  for (let n = 0; n < 2; n++) assert.equal((await fetch(url, { headers: { authorization: 'fixture' } })).status, 200);
  const limited = await fetch(url, { headers: { authorization: 'fixture' } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  const body = await limited.json();
  assert.deepEqual(body.validation, { code: 'operation_rate_limit', field: 'request', reason: 'operation request rate limit reached' });
  assert.equal(body.model_invocation, false);
  assert.equal(body.physical_attempt_count, 0);
  assert.equal(body.token_usage_source, 'not_invoked');
  assert.equal(work, 2);
});
