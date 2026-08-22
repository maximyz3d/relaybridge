'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ID_FILE_NAME, receiptStoreIdentity } = require('../lib/receipt-store-identity.cjs');

test('receipt store identity is stable, privacy-safe, and location-bound', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-store-id-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const firstDir = path.join(tempRoot, 'first-store');
  const copiedDir = path.join(tempRoot, 'copied-store');

  const first = receiptStoreIdentity(firstDir);
  const repeated = receiptStoreIdentity(firstDir);
  assert.deepEqual(first, repeated);
  assert.equal(first.ready, true);
  assert.match(first.id, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(first).includes(firstDir));

  const seed = fs.readFileSync(path.join(firstDir, ID_FILE_NAME), 'utf8').trim();
  assert.match(seed, /^[0-9a-f]{64}$/);
  assert.notEqual(seed, first.id);

  fs.mkdirSync(copiedDir, { recursive: true });
  fs.copyFileSync(path.join(firstDir, ID_FILE_NAME), path.join(copiedDir, ID_FILE_NAME));
  const copied = receiptStoreIdentity(copiedDir);
  assert.equal(copied.ready, true);
  assert.notEqual(copied.id, first.id, 'copying a seed into another directory must not clone the store identity');
});

test('an invalid persisted identity disables actions without exposing the path', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-store-id-invalid-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  fs.writeFileSync(path.join(tempRoot, ID_FILE_NAME), 'not-a-hash\n', 'utf8');

  const identity = receiptStoreIdentity(tempRoot);
  assert.deepEqual(identity, { id: null, ready: false, errorCode: 'invalid_identity_seed' });
  assert.ok(!JSON.stringify(identity).includes(tempRoot));
});
