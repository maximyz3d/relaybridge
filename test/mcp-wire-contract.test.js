'use strict';

// A rebuild of the same installation used to strand every connected MCP client,
// because the preflight compared whole-source build hashes. These cover the
// distinction that replaced it: the wire contract answers "do we agree on the
// protocol", the receipt store answers "are we the same installation", and only
// a build hash moving on its own is tolerable drift.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { receiptStoreIdentity } = require('../lib/receipt-store-identity.cjs');
const { wireContractId } = require('../lib/wire-contract.cjs');

let requireExpectedActionIdentity, server, data, otherData, receiptStoreId, otherReceiptStoreId;
let healthPayload;
const buildId = 'mcp-wire-fixture';
const token = 'b'.repeat(64);
const saved = new Map();

test.before(async () => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-wire-'));
  otherData = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-wire-other-'));
  receiptStoreId = receiptStoreIdentity(data).id;
  otherReceiptStoreId = receiptStoreIdentity(otherData).id;
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(healthPayload));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  for (const [key, value] of Object.entries({ NODE_ENV: 'test',
    RELAYBRIDGE_TEST_BUILD_ID: buildId, RELAYBRIDGE_DATA_DIR: data,
    RELAYBRIDGE_TOKEN: token, RELAYBRIDGE_URL: `http://127.0.0.1:${server.address().port}` })) {
    saved.set(key, process.env[key]); process.env[key] = value;
  }
  ({ requireExpectedActionIdentity } = await import('../mcp/bridge-client.mjs'));
});

test.after(async () => {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const dir of [data, otherData]) fs.rmSync(dir, { recursive: true, force: true });
});

const health = (over = {}) => ({
  capabilityAuth: true, buildIdentityReady: true,
  buildId, receiptStoreId, wireContractId: wireContractId(), pid: 4242, ...over,
});

test('the matching build is accepted and reports no drift', async () => {
  healthPayload = health();
  const preflight = await requireExpectedActionIdentity();
  assert.equal(preflight.ok, true);
  assert.equal(preflight.buildMatches, true);
  assert.equal(preflight.buildDrift, false);
  assert.equal(preflight.wireContractMatches, true);
});

test('a rebuild that kept the wire contract is drift, and calls continue', async () => {
  healthPayload = health({ buildId: 'rebuilt-somewhere-else' });
  const preflight = await requireExpectedActionIdentity();
  assert.equal(preflight.ok, true, 'a live session must not be stranded by a rebuild');
  assert.equal(preflight.buildMatches, false);
  assert.equal(preflight.buildDrift, true);
  assert.equal(preflight.receiptStoreMatches, true);
});

test('a changed wire contract still fails closed, and says to restart the client', async () => {
  healthPayload = health({ buildId: 'rebuilt', wireContractId: 'f00dbabef00dbabe' });
  await assert.rejects(() => requireExpectedActionIdentity(), (error) => {
    assert.match(error.message, /same installation/);
    assert.match(error.message, /Restart this MCP client/);
    assert.match(error.message, /no configuration change is needed/);
    assert.equal(error.detail.actionPreflight.ok, false);
    assert.equal(error.detail.actionPreflight.wireContractMatches, false);
    return true;
  });
});

test('a bridge too old to declare a wire contract is not assumed compatible', async () => {
  healthPayload = health({ buildId: 'rebuilt' });
  delete healthPayload.wireContractId;
  await assert.rejects(() => requireExpectedActionIdentity(), (error) => {
    assert.match(error.message, /too old to declare its MCP wire contract/);
    assert.equal(error.detail.actionPreflight.currentWireContractId, null);
    return true;
  });
});

test('a different installation on the port is named as such, with its pid', async () => {
  // The old message sent the operator to change RELAYBRIDGE_URL in every case.
  // Here that is the right advice; in the rebuild case above it was not.
  healthPayload = health({ receiptStoreId: otherReceiptStoreId });
  await assert.rejects(() => requireExpectedActionIdentity(), (error) => {
    assert.match(error.message, /a different RelayBridge installation is answering this port/);
    assert.match(error.message, /4242/);
    assert.equal(error.detail.actionPreflight.receiptStoreMatches, false);
    return true;
  });
});

test('the wire contract id covers the surfaces both sides enforce', () => {
  const { SURFACES } = require('../lib/wire-contract.cjs');
  for (const key of ['executionContractFields', 'supportedEfforts', 'extremeEfforts',
    'effortByTaskTier', 'taskTiers', 'modelTiers']) {
    assert.ok(key in SURFACES, `${key} must be part of the wire contract`);
  }
  // The ladder's ORDER is contractual: step-downs walk it.
  assert.deepEqual(SURFACES.supportedEfforts,
    ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.match(wireContractId(), /^[0-9a-f]{16}$/);
});
