'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  resolveFilesystemPolicy, providerFilesystemEligibility,
  createIsolatedProviderHome, cleanupIsolatedProviderHome,
} = require('../lib/provider-filesystem-policy');

test('safe filesystem policy defaults fail closed and writer authorization is explicit', () => {
  assert.equal(resolveFilesystemPolicy({}, false), 'unverified_provider_policy');
  assert.equal(resolveFilesystemPolicy({}, true), 'writer_authorized');
  assert.throws(() => resolveFilesystemPolicy({ oneshot_safe_filesystem_policy: 'wishful' }, false));
});

test('eligibility separates normal safe routing from explicitly authorized writers', () => {
  const entry = { oneshot_safe_filesystem_policy: 'unverified_provider_policy' };
  assert.deepEqual(providerFilesystemEligibility(entry), {
    policy: 'unverified_provider_policy', eligible: false, readOnlyEnforced: false,
    isolatedHome: false, blockedReason: 'safe one-shot blocked: provider filesystem policy is unverified',
  });
  assert.equal(providerFilesystemEligibility(entry, { dangerous: true }).policy, 'writer_authorized');
  assert.equal(providerFilesystemEligibility(entry, { dangerous: true }).eligible, true);
});

test('isolated provider home redirects all provider state and exact cleanup removes only its owned tree', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-policy-test-'));
  const sibling = path.join(tempRoot, 'real-provider-home');
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, 'keep.txt'), 'keep');
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const home = createIsolatedProviderHome({ tempRoot });
  for (const value of Object.values(home.env)) {
    assert.equal(path.relative(home.root, value).startsWith('..'), false);
  }
  fs.writeFileSync(path.join(home.env.HOME, 'provider-plan.txt'), 'temporary');
  assert.deepEqual(cleanupIsolatedProviderHome(home), { ok: true, status: 'complete', detail: '' });
  assert.equal(fs.existsSync(home.root), false);
  assert.equal(fs.readFileSync(path.join(sibling, 'keep.txt'), 'utf8'), 'keep');
});

test('cleanup fails closed and preserves a tree whose ownership marker changed', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-policy-test-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const home = createIsolatedProviderHome({ tempRoot });
  fs.writeFileSync(path.join(home.root, '.relaybridge-isolated-home.json'), '{"owner":"other","version":1}');
  const result = cleanupIsolatedProviderHome(home);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed_preserved');
  assert.equal(fs.existsSync(result.preservedPath), true);
});

test('cleanup refuses an unowned path outside its exact temp child namespace', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-policy-test-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-policy-outside-'));
  t.after(() => { fs.rmSync(tempRoot, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const result = cleanupIsolatedProviderHome({ tempRoot, root: outside, owner: 'x' });
  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(outside), true);
});

test('cleanup renames then refuses a provider-replaced root link without touching its target', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-policy-test-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-policy-target-'));
  t.after(() => { fs.rmSync(tempRoot, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const home = createIsolatedProviderHome({ tempRoot });
  fs.rmSync(home.root, { recursive: true, force: true });
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  fs.writeFileSync(path.join(outside, '.relaybridge-isolated-home.json'), JSON.stringify({ owner: home.owner, version: 1 }));
  fs.symlinkSync(outside, home.root, process.platform === 'win32' ? 'junction' : 'dir');
  const result = cleanupIsolatedProviderHome(home);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed_preserved');
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('cleanup removes a nested link itself without traversing or deleting its target', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-policy-test-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-policy-nested-target-'));
  t.after(() => { fs.rmSync(tempRoot, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const home = createIsolatedProviderHome({ tempRoot });
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  fs.symlinkSync(outside, path.join(home.root, 'nested-provider-link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(cleanupIsolatedProviderHome(home).ok, true);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
});
