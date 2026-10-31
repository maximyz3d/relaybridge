'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFundingProfiles } = require('../lib/funding-profiles');
const { allocatedCreditStatus } = require('../lib/allocated-credit');
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-profiles-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, store: createFundingProfiles({ dataDir }), file: path.join(dataDir, 'funding-profiles/profiles.json') };
}
const profile = () => ({ id: 'personal', provider: 'claude', label: 'Personal', subscription: { kind: 'claude', accountId: 'default' },
  organization: { ref: 'org_fixture', label: 'Organization' }, project: { ref: 'workspace_fixture', label: 'Workspace' },
  credentialRef: { type: 'reserved_env', name: 'RELAYBRIDGE_ANTHROPIC_CREDIT_API_KEY' },
  creditPeriod: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' } });

test('profile CRUD, selection and CAS persist with private modes and no delete/recreate revision reuse', t => {
  const { dataDir, file, store } = fixture(t);
  assert.equal(store.snapshot().storeRevision, 0);
  store.set({ profile: profile(), expectedRevision: 0 });
  store.select({ profileId: 'personal', expectedRevision: 1 });
  assert.throws(() => store.set({ profile: profile(), expectedRevision: 1 }), { code: 'funding_store_revision_conflict' });
  const next = store.set({ profile: { ...profile(), organization: { ref: 'org_other', label: 'Other' } }, expectedRevision: 2 });
  assert.equal(next.selected.profileRevision, 3);
  assert.deepEqual(createFundingProfiles({ dataDir }).snapshot(), next);
  next.profiles[0].organization.ref = 'mutated';
  assert.equal(store.snapshot().profiles[0].organization.ref, 'org_other');
  store.remove({ profileId: 'personal', expectedRevision: 3 });
  assert.equal(store.snapshot().selected, null);
  store.set({ profile: profile(), expectedRevision: 4 });
  assert.equal(store.snapshot().profiles[0].revision, 5);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  const status = allocatedCreditStatus({}, { mode: 'auto' }, store.snapshot());
  assert.equal(status.fundingProfiles.profiles[0].dispatchAllowed, false);
});

test('inputs cannot assert funding or store keys; rejection never echoes supplied fields', t => {
  const { store } = fixture(t);
  const secret = 'sk-ant-private-test-sentinel';
  for (const patch of [{ fundingVerified: true }, { balance: 200 }, { label: secret }, { id: secret },
    { organization: { ref: secret, label: 'Org' } }, { credentialRef: { type: 'file', name: secret } },
    { credentialRef: { type: 'reserved_env', name: 'RELAYBRIDGE_OPENAI_CREDIT_API_KEY' } },
    { subscription: { kind: 'codex', accountId: 'default' } }, { [secret]: true },
    { creditPeriod: { start: '2026-11-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' } }]) {
    assert.throws(() => store.set({ profile: { ...profile(), ...patch }, expectedRevision: 0 }), e => e.code === 'invalid_funding_profile' && !e.message.includes(secret));
    assert.equal(store.snapshot().storeRevision, 0);
  }
});

test('failed atomic replacement preserves the previous selected profile', t => {
  const { store, file } = fixture(t);
  store.set({ profile: profile(), expectedRevision: 0 });
  store.select({ profileId: 'personal', expectedRevision: 1 });
  const before = store.snapshot();
  const rename = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === file) throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' });
    return rename(source, target);
  });
  assert.throws(() => store.set({ profile: { ...profile(), label: 'Changed' }, expectedRevision: 2 }), { code: 'funding_profile_write_failed' });
  mocked.mock.restore();
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['profiles.json']);
});

test('corrupt, missing, permissive and symlinked stores fail closed across readers', t => {
  const { dataDir, file, store } = fixture(t);
  store.set({ profile: profile(), expectedRevision: 0 });
  const valid = fs.readFileSync(file);
  for (const bad of ['{', 'x'.repeat(65537), JSON.stringify({ schemaVersion: 1, storeRevision: 1, profiles: [], selected: {} })]) {
    fs.writeFileSync(file, bad);
    assert.equal(store.snapshot().storeState, 'invalid');
    assert.throws(() => store.set({ profile: profile(), expectedRevision: 0 }), { code: 'funding_profile_store_invalid' });
  }
  fs.writeFileSync(file, valid);
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o644); assert.equal(store.snapshot().storeState, 'invalid'); fs.chmodSync(file, 0o600);
    const target = path.join(dataDir, 'private'); fs.writeFileSync(target, 'unchanged');
    fs.unlinkSync(file); fs.symlinkSync(target, file);
    assert.equal(store.snapshot().storeState, 'invalid'); assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged');
    fs.unlinkSync(file);
  } else fs.unlinkSync(file);
  assert.equal(createFundingProfiles({ dataDir }).snapshot().storeState, 'invalid');
  fs.rmSync(path.dirname(file), { recursive: true });
  assert.equal(createFundingProfiles({ dataDir }).snapshot().storeState, 'invalid');
});
