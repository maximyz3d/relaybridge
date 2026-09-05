'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readBoundedJson } = require('../lib/bounded-json-read');
const { createReadOperationPool } = require('../lib/operation-admission');
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { resolve, promise }; };

test('metadata lease owns full response body, not only response headers', async () => {
  const reading = deferred(), finish = deferred();
  const pool = createReadOperationPool({ maxActive: 1 });
  const fetchImpl = async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    return { ok: true, status: 200, body: { getReader: () => {
      let read = false;
      return { async read() {
        if (read) return { done: true }; read = true; reading.resolve(); await finish.promise;
        return { done: false, value: Buffer.from('{"models":[]}') };
      }, releaseLock() {} };
    } } };
  };
  const result = pool.run('tags', (signal) => readBoundedJson('http://127.0.0.1/tags', { signal, fetchImpl }));
  await reading.promise;
  assert.equal(pool.snapshot().active, 1);
  finish.resolve();
  assert.deepEqual((await result).body, { models: [] });
  assert.equal(pool.snapshot().active, 0);
});

test('overflow retains draining physical admission until cancellation cleanup completes', async () => {
  const cleaning = deferred(), cleaned = deferred();
  const pool = createReadOperationPool({ maxActive: 1 });
  const result = pool.run('tags', (signal) => readBoundedJson('http://127.0.0.1/tags', {
    signal, maxBytes: 2, fetchImpl: async () => ({ ok: true, status: 200, body: { getReader: () => ({
      async read() { return { done: false, value: Buffer.from('too many bytes') }; },
      async cancel() { cleaning.resolve(); await cleaned.promise; }, releaseLock() {},
    }) } }),
  }));
  await cleaning.promise;
  assert.equal(pool.snapshot().active, 1);
  cleaned.resolve();
  const value = await result;
  assert.equal(value.completed, false); assert.match(value.error, /byte limit/);
  assert.equal(pool.snapshot().active, 0);
});

test('redirect/non-success bodies are cancelled without following targets; malformed JSON is not complete', async () => {
  let cancelled = 0;
  const redirected = await readBoundedJson('http://127.0.0.1/tags', { fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    return { ok: false, status: 302, body: { cancel: async () => { cancelled++; } } };
  } });
  assert.equal(redirected.status, 302); assert.equal(cancelled, 1);
  const malformed = await readBoundedJson('http://127.0.0.1/tags', { fetchImpl: async () => new Response('not json') });
  assert.equal(malformed.completed, false);
});
