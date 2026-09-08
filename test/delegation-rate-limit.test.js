'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { delegationRateLimitOptions } = require('../lib/delegation-rate-limit');

test('local submission throttle reports no acceptance and leaves reads available', async (t) => {
  assert.equal(delegationRateLimitOptions.limit, 60);
  const app = express();
  let accepted = 0;
  app.post('/submit', rateLimit({ ...delegationRateLimitOptions, limit: 2 }), (_req, res) => {
    accepted += 1;
    res.json({ accepted: true });
  });
  app.get('/status', (_req, res) => res.json({ accepted }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (let i = 0; i < 2; i += 1) assert.equal((await fetch(`${base}/submit`, { method: 'POST' })).status, 200);
  const blocked = await fetch(`${base}/submit`, { method: 'POST' });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
  assert.deepEqual(await blocked.json(), delegationRateLimitOptions.message);
  assert.deepEqual(await (await fetch(`${base}/status`)).json(), { accepted: 2 });
});
