'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApiAgentDispatcher } = require('../lib/api-agent-dispatch');
const { createCheckpointStore } = require('../lib/api-agent-checkpoint');
const { createQualificationAuthority } = require('../lib/api-agent-qualification');
const { createReadOnlyTools } = require('../lib/api-agent-tools');
const { resolveFundingRoute } = require('../lib/funding-routing');
const { CREDIT_SECRET_NAMES } = require('../lib/allocated-credit');
const { startFakeProvider, reply } = require('./helpers/fake-provider-api');

const KEY = 'sk-test-dispatch-credential-0123456789';
const MODEL = { claude: { model: 'claude-opus-5-5', effort: 'medium' }, openai: { model: 'gpt-6.1-sol', effort: 'low' } };
const READ = (p) => ({ name: 'read_file', input: { path: p, offset: null, length: null } });
const ok = (provider, spec) => ({ status: 200, json: reply(provider, spec) });

function profileSnapshot(provider, revision = 3) {
  return { storeState: 'valid', selected: { profileId: 'one', profileRevision: revision }, profiles: [{
    id: 'one', provider, revision, subscription: { kind: provider === 'claude' ? 'claude' : 'codex', accountId: 'default' },
    organization: { ref: 'org_fixture' }, project: { ref: 'proj_fixture' },
    credentialRef: { type: 'reserved_env', name: CREDIT_SECRET_NAMES[provider === 'claude' ? 0 : 1] },
    creditPeriod: { start: '2020-01-01T00:00:00.000Z', end: '2099-01-01T00:00:00.000Z' } }] };
}

async function setup(t, provider, script) {
  const respond = typeof script === 'function' ? script : (req) => script[Math.min(req.index, script.length) - 1];
  const fake = await startFakeProvider(t, { provider, respond });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-dispatch-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'ws'); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'README.md'), `readme mentions ${KEY}\n`);
  const store = createCheckpointStore({ dataDir: path.join(base, 'data') });
  const registry = new Map();
  const env = { provider, fake, store, registry, cwd, credential: KEY, revision: 3, qualificationId: 'q_fixture',
    credentialReads: 0, releases: 0, delivered: [], sourcesBuilt: [], credentialProviders: [] };
  env.authority = createQualificationAuthority({ adapters: { [provider]: () => ({ qualified: true, qualificationId: env.qualificationId }) } });
  env.decide = () => resolveFundingRoute({ envelope: { route: 'included_api_credit', fallback: 'none' },
    snapshot: profileSnapshot(provider, env.revision), kind: provider === 'claude' ? 'claude' : 'codex',
    entry: { transport: provider === 'claude' ? 'subscription:anthropic' : 'subscription:chatgpt' },
    qualificationAuthority: env.authority, credentialSourceFor: (p) => { env.sourcesBuilt.push(p); return () => ({ value: KEY, fingerprint: store.fingerprint(KEY) }); } });
  env.admission = (patch = {}) => ({ resolveDecision: env.decide, cwd, cwdIdentityHash: 'cwd-identity-1', ...patch });
  env.dispatcher = createApiAgentDispatcher({ fetchImpl: fake.fetchImpl, store, registry,
    readCredential: (p) => { env.credentialProviders.push(p); env.credentialReads++; return env.credential; },
    createTools: () => createReadOnlyTools({ cwd }) });
  env.common = (patch = {}) => ({ admission: env.admission(), ...MODEL[provider], kind: provider === 'claude' ? 'claude' : 'codex',
    deliver: async (r) => { env.delivered.push(r); }, releaseAdmission: () => { env.releases++; }, ...patch });
  env.runDirs = () => fs.existsSync(store.root) ? fs.readdirSync(store.root).filter((n) => n.startsWith('aar_')) : [];
  return env;
}

function dirDigest(dir) {
  const h = crypto.createHash('sha256');
  for (const name of fs.readdirSync(dir).filter((n) => n !== 'lease.json').sort()) h.update(name).update(fs.readFileSync(path.join(dir, name)));
  return h.digest('hex');
}

for (const provider of ['claude', 'openai']) {
  test(`${provider}: an admitted run completes with a full receipt and releases admission exactly once`, async (t) => {
    const env = await setup(t, provider, [ok(provider, { tools: [READ('README.md')] }), ok(provider, { text: `done ${KEY}` })]);
    const receipt = await env.dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'read the readme', route: { mode: 'oneshot' } });
    assert.equal(receipt.exitCode, 0, JSON.stringify(receipt));
    assert.equal(receipt.failureClass, null); assert.equal(receipt.model_invocation, true);
    assert.equal(receipt.physical_attempt_count, 2); assert.equal(env.fake.requests.length, 2);
    assert.match(receipt.stdout, /^done /); assert.ok(!receipt.stdout.includes(KEY));
    const api = receipt.route.api_agent;
    assert.equal(api.provider, provider); assert.equal(api.outcome_class, 'completed'); assert.equal(api.checkpoint_status, 'terminal');
    assert.equal(api.turns.length, 2); assert.equal(api.resumable, false); assert.equal(api.reserve_release_evidence, false);
    assert.ok(api.total_usage.input_tokens > 0); assert.equal(api.requested_model, provider === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-sol');
    assert.equal(receipt.route.funding.actual, 'included_api_credit'); assert.equal(receipt.route.funding.qualificationId, 'q_fixture');
    assert.equal(receipt.route.mode, 'oneshot');
    assert.equal(env.releases, 1); assert.equal(env.delivered.length, 1); assert.equal(env.registry.size, 0);
    // Both credential reads are bound to the profile's provider (openai for kind codex), never the CLI kind.
    assert.deepEqual([...new Set(env.sourcesBuilt)], [provider]);
    assert.ok(env.credentialReads >= 1); assert.deepEqual([...new Set(env.credentialProviders)], [provider]);
    assert.equal(env.delivered[0].transport_lifecycle.physicalEvidence, 'http_transport_settled');
    assert.equal(env.credentialReads, 1);
    const serialized = JSON.stringify(env.delivered[0]);
    assert.ok(!serialized.includes(KEY)); assert.ok(!serialized.includes(env.cwd));
    // The second request replayed the redacted tool output, never the raw key.
    assert.ok(!JSON.stringify(env.fake.requests[1].body).includes(KEY));
    const headers = env.fake.requests[0].headers;
    if (provider === 'openai') {
      assert.equal(headers.authorization, `Bearer ${KEY}`);
      assert.equal(headers['openai-organization'], 'org_fixture'); assert.equal(headers['openai-project'], 'proj_fixture');
    } else {
      assert.equal(headers['x-api-key'], KEY); assert.equal(headers['anthropic-organization-id'], undefined);
    }
    // The checkpoint binds the admission but never holds the key.
    const runDir = path.join(env.store.root, api.checkpoint_run_id);
    for (const name of fs.readdirSync(runDir)) assert.ok(!fs.readFileSync(path.join(runDir, name), 'utf8').includes(KEY), name);
  });
}

test('admission refusals make zero requests, create no checkpoint and release admission once', async (t) => {
  const env = await setup(t, 'claude', [ok('claude', { text: 'never' })]);
  const production = createQualificationAuthority({ adapters: Object.freeze({}) });
  let thunkCalls = 0;
  const built = [];
  const refuse = async (patch, code) => {
    const before = env.releases;
    await assert.rejects(env.dispatcher.runApiAgentOneShot({ ...env.common(patch), prompt: 'x' }), { code });
    assert.equal(env.releases, before + 1, code);
  };
  await refuse({ admission: env.admission({ resolveDecision: () => resolveFundingRoute({ envelope: { route: 'included_api_credit', fallback: 'none' },
    snapshot: profileSnapshot('claude'), kind: 'claude', entry: { transport: 'subscription:anthropic' }, qualificationAuthority: production,
    credentialSourceFor: (p) => { built.push(p); return () => { thunkCalls++; return { value: KEY, fingerprint: 'x' }; }; } }) }) }, 'grant_only_funding_unverified');
  assert.equal(thunkCalls, 0); assert.deepEqual(built, ['claude']);
  await refuse({ admission: env.admission({ resolveDecision: () => ({ ...env.decide(), apiDispatchAllowed: false }) }) }, 'api_dispatch_unavailable');
  await refuse({ admission: env.admission({ resolveDecision: () => ({ ...env.decide(), qualification: null }) }) }, 'api_dispatch_unavailable');
  await refuse({ admission: null }, 'api_dispatch_unavailable');
  await refuse({ admission: env.admission({ expectedDecisionHash: 'f'.repeat(64) }) }, 'funding_decision_changed');
  await refuse({ model: 'claude-unlisted-model' }, 'api_model_unmapped');
  await refuse({ admission: env.admission({ cwdIdentityHash: undefined }) }, 'api_dispatch_unavailable');
  env.credential = KEY + '-rotated';
  await refuse({}, 'funding_decision_changed');
  env.credential = '';
  await refuse({}, 'api_credential_unbound');
  env.credential = 'sk-1234'; // seven characters: too short to scan or redact safely
  await refuse({}, 'api_credential_unbound');
  assert.equal(env.fake.requests.length, 0); assert.deepEqual(env.runDirs(), []); assert.equal(env.registry.size, 0);
});

test('a tools factory failure releases the checkpoint lease and admission without dispatch', async (t) => {
  const env = await setup(t, 'claude', [ok('claude', { text: 'never' })]);
  const dispatcher = createApiAgentDispatcher({ fetchImpl: env.fake.fetchImpl, store: env.store, registry: env.registry,
    readCredential: () => KEY, createTools: () => { throw Object.assign(new Error('no workspace'), { code: 'cwd_identity_changed' }); } });
  await assert.rejects(dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'x' }), { code: 'cwd_identity_changed' });
  assert.equal(env.releases, 1); assert.equal(env.fake.requests.length, 0); assert.equal(env.registry.size, 0);
  const [runId] = env.runDirs();
  env.store.acquire(runId).release();
});

test('resume re-admits, refuses a stale binding with zero requests, and returns terminal checkpoints unchanged', async (t) => {
  const env = await setup(t, 'openai', (req) => req.index === 1
    ? { status: 429, json: { error: { type: 'requests', code: 'rate_limit_exceeded', message: 'slow down' } } }
    : ok('openai', { text: 'resumed answer' }));
  const first = await env.dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'x' });
  assert.equal(first.failureClass, 'rate_limited'); assert.equal(first.rate_limited, true);
  assert.equal(first.route.api_agent.resumable, true); assert.equal(first.route.api_agent.reserve_release_evidence, false);
  const runId = first.route.api_agent.checkpoint_run_id;
  assert.equal(env.fake.requests.length, 1); assert.equal(env.releases, 1);

  // A profile edit changes the decision hash and revision: refused before any request.
  env.revision = 4;
  await assert.rejects(env.dispatcher.resumeApiAgentRun({ ...env.common(), runId }), (error) => {
    assert.equal(error.code, 'checkpoint_binding_stale');
    assert.ok(error.changedFields.includes('profileRevision') && error.changedFields.includes('decisionHash'), error.changedFields.join());
    return true;
  });
  env.revision = 3;
  await assert.rejects(env.dispatcher.resumeApiAgentRun({ ...env.common({ effort: 'high' }), runId }), { code: 'checkpoint_binding_stale' });
  await assert.rejects(env.dispatcher.resumeApiAgentRun({ ...env.common({ admission: env.admission({ cwdIdentityHash: 'other' }) }), runId }),
    { code: 'checkpoint_binding_stale' });
  env.qualificationId = 'q_other';
  await assert.rejects(env.dispatcher.resumeApiAgentRun({ ...env.common(), runId }), { code: 'checkpoint_binding_stale' });
  env.qualificationId = 'q_fixture';
  assert.equal(env.fake.requests.length, 1); assert.equal(env.releases, 5);

  const resumed = await env.dispatcher.resumeApiAgentRun({ ...env.common(), runId });
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed)); assert.equal(resumed.stdout, 'resumed answer');
  assert.equal(resumed.route.api_agent.checkpoint_run_id, runId); assert.equal(resumed.physical_attempt_count, 1);
  assert.equal(env.fake.requests.length, 2); assert.equal(env.releases, 6);

  const again = await env.dispatcher.resumeApiAgentRun({ ...env.common(), runId });
  assert.equal(again.exitCode, 0); assert.equal(again.physical_attempt_count, 0);
  assert.equal(again.transport_lifecycle.physicalEvidence, 'not_dispatched');
  assert.equal(env.fake.requests.length, 2); assert.equal(env.releases, 7); assert.equal(env.registry.size, 0);
});

test('an uncertain turn is terminal; only an authorized linked attempt continues and the parent is untouched', async (t) => {
  const env = await setup(t, 'claude', (req) => {
    if (req.index === 1) return ok('claude', { tools: [READ('README.md')] });
    if (req.index === 2) return { destroy: true };
    return ok('claude', { text: 'linked answer' });
  });
  const parent = await env.dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'x' });
  assert.equal(parent.failureClass, 'outcome_uncertain'); assert.equal(parent.route.api_agent.uncertain_turn, 2);
  assert.equal(parent.route.api_agent.resumable, false); assert.equal(parent.route.api_agent.checkpoint_status, 'terminal');
  const parentRunId = parent.route.api_agent.checkpoint_run_id;
  const parentDir = path.join(env.store.root, parentRunId);
  const digest = dirDigest(parentDir);

  const resumed = await env.dispatcher.resumeApiAgentRun({ ...env.common(), runId: parentRunId });
  assert.equal(resumed.failureClass, 'outcome_uncertain'); assert.equal(resumed.physical_attempt_count, 0);
  assert.equal(env.fake.requests.length, 2);

  for (const authorization of [undefined, { parentRunId, fromTurn: 2 }, { parentRunId, fromTurn: 3, confirmDuplicateBillingRisk: true },
    { parentRunId: 'aar_other', fromTurn: 2, confirmDuplicateBillingRisk: true }]) {
    await assert.rejects(env.dispatcher.startLinkedAttempt({ ...env.common(), parentRunId, fromTurn: 2, authorization }), { code: 'linked_attempt_unauthorized' });
  }
  await assert.rejects(env.dispatcher.startLinkedAttempt({ ...env.common({ model: 'claude-sonnet-5-5' }), parentRunId, fromTurn: 2,
    authorization: { parentRunId, fromTurn: 2, confirmDuplicateBillingRisk: true } }), { code: 'checkpoint_binding_stale' });
  await assert.rejects(env.dispatcher.startLinkedAttempt({ ...env.common(), parentRunId, fromTurn: 3,
    authorization: { parentRunId, fromTurn: 3, confirmDuplicateBillingRisk: true } }), { code: 'linked_attempt_invalid' });
  assert.equal(env.fake.requests.length, 2);
  const releasesBefore = env.releases;

  const linked = await env.dispatcher.startLinkedAttempt({ ...env.common(), parentRunId, fromTurn: 2,
    authorization: { parentRunId, fromTurn: 2, confirmDuplicateBillingRisk: true } });
  assert.equal(linked.exitCode, 0, JSON.stringify(linked)); assert.equal(linked.stdout, 'linked answer');
  assert.deepEqual(linked.route.api_agent.supersedes, { parentRunId, fromTurn: 2, parentOutcome: 'outcome_uncertain' });
  assert.notEqual(linked.route.api_agent.checkpoint_run_id, parentRunId);
  assert.equal(env.releases, releasesBefore + 1);
  // The linked request carries the parent's completed tool round.
  assert.equal(env.fake.requests[2].body.messages.length, 3);
  assert.equal(dirDigest(parentDir), digest);
  assert.equal(env.store.load(parentRunId).manifest.outcome.class, 'outcome_uncertain');
});

test('caller cancellation before dispatch is resumable; mid-request cancellation is uncertain', async (t) => {
  let arrived;
  const arrival = new Promise((resolve) => { arrived = resolve; });
  const env = await setup(t, 'claude', () => { arrived(); return { hang: true }; });
  const early = new AbortController(); early.abort();
  const before = await env.dispatcher.runApiAgentOneShot({ ...env.common({ signal: early.signal }), prompt: 'x' });
  assert.equal(before.failureClass, 'cancelled'); assert.equal(before.cancelled, true);
  assert.equal(before.route.api_agent.resumable, true); assert.equal(before.physical_attempt_count, 0);
  assert.equal(before.transport_lifecycle.physicalEvidence, 'not_dispatched'); assert.equal(env.fake.requests.length, 0);

  const controller = new AbortController();
  const running = env.dispatcher.runApiAgentOneShot({ ...env.common({ signal: controller.signal }), prompt: 'x' });
  await arrival;
  assert.equal(env.registry.size, 1);
  const [entry] = env.registry.values();
  assert.equal(entry.lifecycle.snapshot().dispatched, true);
  controller.abort();
  const during = await running;
  assert.equal(during.failureClass, 'outcome_uncertain'); assert.equal(during.route.api_agent.resumable, false);
  assert.equal(during.route.api_agent.uncertain_turn, 1); assert.equal(during.physical_attempt_count, 1);
  assert.equal(during.transport_lifecycle.stop.reason, 'client_cancelled');
  assert.equal(env.releases, 2); assert.equal(env.registry.size, 0);
});

// Unified-run reauthorization: any profile, account, credential or period
// change after admission stops the run before the next turn is sent.
for (const [name, change] of [
  ['profile revision', (s) => { s.revision = 4; }],
  ['subscription account', (s) => { s.accountId = 'work'; }],
  ['credential', (s) => { s.fingerprintOf = `${KEY}-rotated`; }],
  ['credit period', (s) => { s.end = '2098-01-01T00:00:00.000Z'; }],
]) test(`reauthorize: a ${name} change leaves the next turn not_sent`, async (t) => {
  const state = { revision: 3, accountId: 'default', end: '2099-01-01T00:00:00.000Z', fingerprintOf: KEY };
  const env = await setup(t, 'claude', (req) => { if (req.index === 1) change(state); return ok('claude', req.index === 1 ? { tools: [READ('README.md')] } : { text: 'never' }); });
  const decide = () => {
    const snapshot = profileSnapshot('claude', state.revision);
    snapshot.profiles[0].subscription.accountId = state.accountId;
    snapshot.profiles[0].creditPeriod = { ...snapshot.profiles[0].creditPeriod, end: state.end };
    return resolveFundingRoute({ envelope: { route: 'included_api_credit', fallback: 'none' }, snapshot, kind: 'claude',
      entry: { transport: 'subscription:anthropic' }, qualificationAuthority: env.authority,
      credentialSourceFor: () => () => ({ value: KEY, fingerprint: env.store.fingerprint(state.fingerprintOf) }) });
  };
  const admitted = decide().decisionHash;
  let checks = 0;
  const receipt = await env.dispatcher.runApiAgentOneShot({ ...env.common({ admission: env.admission({ resolveDecision: decide }) }), prompt: 'read the readme',
    reauthorize: () => { checks++; return decide().decisionHash === admitted; } });
  assert.equal(env.fake.requests.length, 1, JSON.stringify(receipt.route?.api_agent));
  assert.equal(checks, 2);
  assert.deepEqual(receipt.route.api_agent.turns.map((turn) => turn.state), ['received', 'not_sent']);
  assert.notEqual(receipt.exitCode, 0);
  assert.equal(receipt.route.api_agent.reserve_release_evidence, false);
  assert.equal(env.releases, 1);
});

// ---- writer admission (N2) --------------------------------------------------
const { createWorkspaceTools } = require('../lib/api-agent-tools');
const { WORKSPACE_FS_TYPES } = require('../lib/linux-durable-file');
const { normalizeWriteContract } = require('../lib/unified-run');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function writerEnv(env) {
  const cwd = fs.realpathSync(env.cwd);
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'one\ntwo\n');
  const contract = normalizeWriteContract(['notes.txt']);
  env.holdChecks = 0;
  env.writer = (patch = {}) => ({ allowedWritePaths: [...contract.paths], writePathsHash: contract.pathsHash,
    assertHeld: () => { env.holdChecks++; }, execution: { unifiedRunId: 'ur_fixture', segment: 1, taskId: 'task_fixture' }, ...patch });
  env.expect = { unifiedRunId: 'ur_fixture', segment: 1, writePathsHash: contract.pathsHash, allowedWritePaths: [...contract.paths] };
  env.writerAdmission = (patch = {}) => env.admission({ cwd, writer: env.writer(), ...patch });
  env.dispatcher = createApiAgentDispatcher({ fetchImpl: env.fake.fetchImpl, store: env.store, registry: env.registry,
    readCredential: () => env.credential,
    createTools: ({ writer } = {}) => createWorkspaceTools({ cwd, writer: writer ? { ...writer, allowedTypes: WORKSPACE_FS_TYPES } : null }) });
  env.wcwd = cwd;
  return env;
}

test('a read-only checkpoint never becomes a writer through resume or link', { skip: process.platform !== 'linux' }, async (t) => {
  const env = writerEnv(await setup(t, 'claude', [ok('claude', { text: 'read only' })]));
  const first = await env.dispatcher.runApiAgentOneShot({ ...env.common({ admission: env.admission({ cwd: env.wcwd }) }), prompt: 'x' });
  assert.equal(first.exitCode, 0, JSON.stringify(first));
  const runId = first.route.api_agent.checkpoint_run_id;
  assert.equal(env.store.load(runId).manifest.execution ?? null, null);
  assert.equal(env.fake.requests.length, 1);

  await assert.rejects(env.dispatcher.resumeApiAgentRun({ ...env.common({ admission: env.writerAdmission() }), runId }), (error) => {
    assert.equal(error.code, 'checkpoint_binding_stale');
    assert.ok(error.changedFields.includes('toolsetHash') && error.changedFields.includes('writePathsHash'), error.changedFields.join());
    return true;
  });
  await assert.rejects(env.dispatcher.startLinkedAttempt({ ...env.common({ admission: env.writerAdmission() }), parentRunId: runId, fromTurn: 1,
    authorization: { parentRunId: runId, fromTurn: 1, confirmDuplicateBillingRisk: true } }), { code: 'checkpoint_binding_stale' });
  // An incomplete writer admission is refused before any checkpoint or request.
  const dirs = env.runDirs().length;
  for (const writer of [{}, env.writer({ allowedWritePaths: [] }), env.writer({ writePathsHash: 'x' }), env.writer({ assertHeld: null }),
    env.writer({ execution: { unifiedRunId: 'ur_fixture', segment: '1', taskId: 'task_fixture' } })]) {
    await assert.rejects(env.dispatcher.runApiAgentOneShot({ ...env.common({ admission: env.admission({ cwd: env.wcwd, writer }) }), prompt: 'x' }),
      { code: 'api_write_contract_invalid' });
  }
  assert.equal(env.runDirs().length, dirs); assert.equal(env.fake.requests.length, 1);
  assert.equal(fs.readFileSync(path.join(env.wcwd, 'notes.txt'), 'utf8'), 'one\ntwo\n'); assert.equal(env.holdChecks, 0);
});

test('a writer run edits once, is settled only for its own segment, and reconciliation is a no-op', { skip: process.platform !== 'linux' }, async (t) => {
  const env = writerEnv(await setup(t, 'claude', (req) => req.index === 1
    ? ok('claude', { tools: [{ name: 'apply_patch', input: { path: 'notes.txt', expectedSha256: sha('one\ntwo\n'), edits: [{ oldText: 'two', newText: 'three' }] } }] })
    : ok('claude', { text: 'edited' })));
  const runId = env.store.newRunId();
  assert.deepEqual(env.dispatcher.apiEffectsSettled({ runId, expect: env.expect }), { settled: true, exists: false });
  const receipt = await env.dispatcher.runApiAgentOneShot({ ...env.common({ admission: env.writerAdmission() }), prompt: 'edit', runId });
  assert.equal(receipt.exitCode, 0, JSON.stringify(receipt)); assert.equal(receipt.stdout, 'edited');
  assert.equal(fs.readFileSync(path.join(env.wcwd, 'notes.txt'), 'utf8'), 'one\nthree\n');
  assert.deepEqual(receipt.route.api_agent.allowed_write_paths, ['notes.txt']);
  assert.ok(env.holdChecks >= 1);
  const execution = env.store.load(runId).manifest.execution;
  assert.equal(execution.unifiedRunId, 'ur_fixture'); assert.equal(execution.segment, 1);

  const settled = env.dispatcher.apiEffectsSettled({ runId, expect: env.expect });
  assert.equal(settled.settled, true, JSON.stringify(settled)); assert.equal(settled.exists, true);
  for (const expect of [{ ...env.expect, segment: 2 }, { ...env.expect, unifiedRunId: 'ur_other' }, { ...env.expect, writePathsHash: sha('x') }, null]) {
    assert.deepEqual(env.dispatcher.apiEffectsSettled({ runId, expect }), { settled: false, exists: true, reason: 'checkpoint_binding_stale' });
    assert.throws(() => env.dispatcher.reconcileApiEffects({ runId, expect, cwd: env.wcwd, allowedWritePaths: ['notes.txt'], assertHeld: () => {} }),
      { code: 'checkpoint_binding_stale' });
  }
  // A write list that is missing or does not hash to the bound one settles nothing.
  for (const allowedWritePaths of [undefined, ['notes.txt', 'other.txt'], ['other.txt']]) {
    assert.deepEqual(env.dispatcher.apiEffectsSettled({ runId, expect: { ...env.expect, allowedWritePaths } }),
      { settled: false, exists: true, reason: 'write_paths_unbound' });
  }
  // Committed records are not trusted by state alone: a tampered record, a
  // record naming an attempt outside the stopped set, or an attempt set
  // emptied after dispatch keeps the effects unsettled.
  const dir = path.join(env.store.root, runId);
  const patchFile = path.join(dir, 'patch-000001-000.json');
  const original = fs.readFileSync(patchFile, 'utf8');
  const record = JSON.parse(original);
  assert.equal(record.state, 'committed');
  const tampered = (value) => { fs.writeFileSync(patchFile, JSON.stringify(value)); return env.dispatcher.apiEffectsSettled({ runId, expect: env.expect }); };
  assert.deepEqual(tampered({ ...record, postBytesB64: Buffer.from('forged\n').toString('base64') }),
    { settled: false, exists: true, reason: 'patch_record_invalid', effectsPending: ['1:0'] });
  assert.deepEqual(tampered({ ...record, callId: 'call_other' }), { settled: false, exists: true, reason: 'patch_record_invalid', effectsPending: ['1:0'] });
  assert.deepEqual(tampered({ ...record, attemptNonce: 'f'.repeat(32) }),
    { settled: false, exists: true, reason: 'owner_not_proven_stopped', effectsPending: ['1:0'] });
  assert.deepEqual(tampered({ ...record, recoveryNonce: 'e'.repeat(32) }),
    { settled: false, exists: true, reason: 'owner_not_proven_stopped', effectsPending: ['1:0'] });
  fs.writeFileSync(patchFile, original);
  const attemptFiles = fs.readdirSync(dir).filter((name) => name.startsWith('attempt-'));
  assert.equal(attemptFiles.length, 1);
  const parked = path.join(path.dirname(dir), 'parked-attempt.json');
  fs.renameSync(path.join(dir, attemptFiles[0]), parked);
  assert.deepEqual(env.dispatcher.apiEffectsSettled({ runId, expect: env.expect }), { settled: false, exists: true, reason: 'owner_not_proven_stopped' });
  fs.renameSync(parked, path.join(dir, attemptFiles[0]));
  assert.equal(env.dispatcher.apiEffectsSettled({ runId, expect: env.expect }).settled, true);
  const before = fs.statSync(path.join(env.wcwd, 'notes.txt'));
  const recovered = env.dispatcher.reconcileApiEffects({ runId, expect: env.expect, cwd: env.wcwd, allowedWritePaths: ['notes.txt'], assertHeld: () => {} });
  assert.equal(recovered.exists, true); assert.deepEqual(recovered.uncertain, []);
  const after = fs.statSync(path.join(env.wcwd, 'notes.txt'));
  assert.equal(after.ino, before.ino); assert.equal(fs.readFileSync(path.join(env.wcwd, 'notes.txt'), 'utf8'), 'one\nthree\n');
  assert.equal(env.fake.requests.length, 2);
  // The writer's own resume is bound to its execution: a different segment is refused with zero requests.
  await assert.rejects(env.dispatcher.resumeApiAgentRun({ ...env.common({ admission: env.writerAdmission({ writer: env.writer({ execution: { unifiedRunId: 'ur_fixture', segment: 2, taskId: 'task_fixture' } }) }) }), runId }),
    { code: 'checkpoint_binding_stale' });
  assert.equal(env.fake.requests.length, 2);
});

// ---- never-dispatched proof (N3) --------------------------------------------
test('a writer run that failed before its attempt settles only with not_dispatched proof and a matching manifest', { skip: process.platform !== 'linux' }, async (t) => {
  const env = writerEnv(await setup(t, 'claude', [ok('claude', { text: 'never' })]));
  const runId = env.store.newRunId();
  const original = fs.renameSync;
  let armed = true;
  fs.renameSync = (from, to) => {
    if (armed && /attempt-[a-f0-9]{32}\.json$/.test(String(to))) { armed = false; throw Object.assign(new Error('injected'), { code: 'EIO' }); }
    return original.call(fs, from, to);
  };
  t.after(() => { fs.renameSync = original; });
  await assert.rejects(env.dispatcher.runApiAgentOneShot({ ...env.common({ admission: env.writerAdmission() }), prompt: 'edit', runId }), { code: 'EIO' });
  fs.renameSync = original;
  assert.equal(env.fake.requests.length, 0); assert.equal(env.releases, 1); assert.equal(env.holdChecks, 0);
  const dir = path.join(env.store.root, runId);
  const stopped = fs.readdirSync(dir).filter((n) => n.startsWith('stopped-'));
  assert.equal(stopped.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, stopped[0]), 'utf8')).proof, 'not_dispatched');
  assert.deepEqual(env.dispatcher.apiEffectsSettled({ runId, expect: env.expect }), { settled: false, exists: true, reason: 'execution_active' });
  env.store.reconcile();
  assert.deepEqual(env.dispatcher.apiEffectsSettled({ runId, expect: env.expect }), { settled: true, exists: true, outcome: 'interrupted' });
  const recovered = env.dispatcher.reconcileApiEffects({ runId, expect: env.expect, cwd: env.wcwd, allowedWritePaths: ['notes.txt'], assertHeld: () => {} });
  assert.equal(recovered.exists, true); assert.deepEqual(recovered.uncertain, []);
  assert.equal(fs.readFileSync(path.join(env.wcwd, 'notes.txt'), 'utf8'), 'one\ntwo\n');
  assert.equal(env.fake.requests.length, 0, 'recovery never replays a provider request');
  // The same proof next to a manifest that claims execution is a contradiction.
  const manifestFile = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const at = new Date().toISOString();
  for (const name of fs.readdirSync(dir)) if (name.startsWith('attempt-')) fs.unlinkSync(path.join(dir, name));
  for (const outcome of [{ class: 'completed', at }, { class: 'effects_reconciled', at }]) {
    fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, status: 'terminal', outcome }));
    assert.deepEqual(env.dispatcher.apiEffectsSettled({ runId, expect: env.expect }), { settled: false, exists: true, reason: 'owner_not_proven_stopped' });
    assert.throws(() => env.dispatcher.reconcileApiEffects({ runId, expect: env.expect, cwd: env.wcwd, allowedWritePaths: ['notes.txt'], assertHeld: () => {} }),
      { code: 'owner_not_proven_stopped' });
  }
  assert.equal(env.fake.requests.length, 0);
});

test('a completed writer run stripped of every execution record is never settled', { skip: process.platform !== 'linux' }, async (t) => {
  const env = writerEnv(await setup(t, 'claude', (req) => req.index === 1
    ? ok('claude', { tools: [{ name: 'apply_patch', input: { path: 'notes.txt', expectedSha256: sha('one\ntwo\n'), edits: [{ oldText: 'two', newText: 'three' }] } }] })
    : ok('claude', { text: 'edited' })));
  const runId = env.store.newRunId();
  const receipt = await env.dispatcher.runApiAgentOneShot({ ...env.common({ admission: env.writerAdmission() }), prompt: 'edit', runId });
  assert.equal(receipt.exitCode, 0, JSON.stringify(receipt));
  assert.equal(env.dispatcher.apiEffectsSettled({ runId, expect: env.expect }).settled, true);
  // Belt and braces: an empty owner set beside recorded history is refused even if the store reported it.
  const lying = createApiAgentDispatcher({ fetchImpl: env.fake.fetchImpl, store: { ...env.store, stoppedAttempts: () => Object.freeze([]) },
    registry: env.registry, readCredential: () => env.credential, createTools: () => { throw new Error('unused'); } });
  assert.deepEqual(lying.apiEffectsSettled({ runId, expect: env.expect }), { settled: false, exists: true, reason: 'owner_not_proven_stopped' });
  const dir = path.join(env.store.root, runId);
  assert.equal(env.store.load(runId).manifest.status, 'terminal');
  for (const name of fs.readdirSync(dir)) if (/^(attempt|turn|tool|patch)-/.test(name)) fs.unlinkSync(path.join(dir, name));
  assert.deepEqual(env.dispatcher.apiEffectsSettled({ runId, expect: env.expect }), { settled: false, exists: true, reason: 'owner_not_proven_stopped' });
  assert.throws(() => env.dispatcher.reconcileApiEffects({ runId, expect: env.expect, cwd: env.wcwd, allowedWritePaths: ['notes.txt'], assertHeld: () => {} }),
    { code: 'owner_not_proven_stopped' });
  assert.equal(env.fake.requests.length, 2);
});

// Owner-authorized prepaid: the same dispatcher, admitted by a private permit.
const { createPrepaidAuthority, credentialHmac, PREPAID_POLICY } = require('../lib/prepaid-authorization');
const PREPAID_NOW = Date.parse('2026-11-10T12:00:00.000Z');
const prepaidPermit = (patch = {}) => {
  const id = patch.authorizationId || 'pa_dispatch_1';
  return { schemaVersion: 1, authorizationId: id, policy: PREPAID_POLICY, provider: 'openai', surface: 'openai_responses_agent',
    supervised: true, noPurchases: true, profileId: 'one', profileRevision: 3, organization: 'org_fixture', project: 'proj_fixture',
    credentialHmac: credentialHmac(id, KEY), models: ['gpt-6.1-sol'], issuedAt: '2026-11-10T11:59:00.000Z', expiresAt: '2026-11-11T10:59:00.000Z',
    revokedAt: null, providerControls: { autoReload: 'off', hardLimitCents: 12000, hardLimitScope: 'organization', hardLimitEnforced: true,
      observedAt: '2026-11-10T10:59:00.000Z' },
    balance: { observedBalanceCents: 20100, observedAt: '2026-11-10T10:59:00.000Z', earliestCreditExpiry: '2026-11-13' }, ...patch };
};
async function setupPrepaid(t, script) {
  const env = await setup(t, 'openai', script);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-dispatch-prepaid-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  env.permitFile = path.join(dataDir, 'prepaid-authorization.json');
  env.writePermit = (value = prepaidPermit()) => { fs.writeFileSync(env.permitFile, JSON.stringify(value), { mode: 0o600 }); fs.chmodSync(env.permitFile, 0o600); };
  env.writePermit();
  env.prepaid = createPrepaidAuthority({ dataDir });
  env.route = 'authorized_prepaid';
  env.decide = () => resolveFundingRoute({ envelope: { route: env.route, fallback: 'none' }, snapshot: profileSnapshot('openai', env.revision),
    kind: 'codex', entry: { transport: 'subscription:chatgpt' }, prepaidAuthority: env.prepaid, qualificationAuthority: env.authority, now: PREPAID_NOW,
    credentialSourceFor: (p) => { env.sourcesBuilt.push(p); return () => ({ value: KEY, fingerprint: env.store.fingerprint(KEY) }); } });
  return env;
}
const queue = (items) => () => items.shift();

test('prepaid: an admitted run records the policy, permit and limitations, never reserve evidence', async (t) => {
  const env = await setupPrepaid(t, [ok('openai', { tools: [READ('README.md')] }), ok('openai', { text: 'prepaid done' })]);
  const receipt = await env.dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'read the readme', route: { mode: 'oneshot' } });
  assert.equal(receipt.exitCode, 0, JSON.stringify(receipt));
  const funding = receipt.route.funding;
  assert.equal(funding.actual, 'authorized_prepaid'); assert.equal(funding.policy, PREPAID_POLICY); assert.equal(funding.grantOnly, false);
  assert.equal(funding.authorizationId, 'pa_dispatch_1'); assert.equal(funding.qualificationId, 'prepaid:pa_dispatch_1');
  assert.equal(funding.expiresAt, '2026-11-11T10:59:00.000Z'); assert.equal(funding.providerControls.hardLimitCents, 12000);
  assert.ok(funding.limitations.includes('provider_cap_enforcement_lag') && funding.limitations.includes('no_local_spend_accounting'));
  assert.equal(receipt.route.api_agent.reserve_release_evidence, false);
  assert.equal(env.fake.requests[0].headers['openai-organization'], 'org_fixture'); assert.equal(env.fake.requests[0].headers['openai-project'], 'proj_fixture');
  const serialized = JSON.stringify(env.delivered[0]);
  assert.ok(!serialized.includes(KEY)); assert.ok(!serialized.includes(prepaidPermit().credentialHmac));
  const runDir = path.join(env.store.root, receipt.route.api_agent.checkpoint_run_id);
  for (const name of fs.readdirSync(runDir)) assert.ok(!fs.readFileSync(path.join(runDir, name), 'utf8').includes(KEY), name);
});

test('prepaid: exhaustion under the permit is terminal and carries no reserve-release evidence', async (t) => {
  const env = await setupPrepaid(t, [{ status: 429, json: { error: { code: 'credit_balance_exhausted', message: 'out' } } }]);
  const receipt = await env.dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'x' });
  assert.equal(receipt.failureClass, 'funding_exhausted'); assert.equal(receipt.route.api_agent.resumable, false);
  assert.equal(receipt.route.api_agent.reserve_release_evidence, false); assert.equal(env.fake.requests.length, 1);
  const again = await env.dispatcher.resumeApiAgentRun({ ...env.common(), runId: receipt.route.api_agent.checkpoint_run_id });
  assert.equal(again.physical_attempt_count, 0); assert.equal(env.fake.requests.length, 1);
});

test('prepaid: model membership and the permit binding are checked for one-shot, resume and linked attempts', async (t) => {
  const responses = [{ status: 429, json: { error: { type: 'requests', code: 'rate_limit_exceeded', message: 'slow down' } } },
    ok('openai', { text: 'resumed' }), ok('openai', { tools: [READ('README.md')] }), { destroy: true }, ok('openai', { text: 'linked' })];
  const env = await setupPrepaid(t, queue(responses));
  const notPermitted = { model: 'gpt-5', effort: 'low' };
  const reads = env.credentialReads;
  await assert.rejects(env.dispatcher.runApiAgentOneShot({ ...env.common(notPermitted), prompt: 'x' }), { code: 'prepaid_model_not_permitted' });
  assert.equal(env.credentialReads, reads); assert.equal(env.fake.requests.length, 0); assert.deepEqual(env.runDirs(), []);

  const first = await env.dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'x' });
  assert.equal(first.failureClass, 'rate_limited');
  const runId = first.route.api_agent.checkpoint_run_id;
  await assert.rejects(env.dispatcher.resumeApiAgentRun({ ...env.common(notPermitted), runId }), { code: 'prepaid_model_not_permitted' });
  // Any permit edit changes the bound permit hash: resume is refused.
  env.writePermit(prepaidPermit({ models: ['gpt-6.1-sol', 'gpt-5'] }));
  await assert.rejects(env.dispatcher.resumeApiAgentRun({ ...env.common(), runId }), (error) => {
    assert.equal(error.code, 'checkpoint_binding_stale');
    assert.ok(error.changedFields.includes('fundingPolicy') && error.changedFields.includes('decisionHash'), error.changedFields.join());
    return true;
  });
  // Even a qualified grant decision never resumes a prepaid checkpoint.
  env.route = 'included_api_credit';
  await assert.rejects(env.dispatcher.resumeApiAgentRun({ ...env.common(), runId }), (error) => {
    assert.equal(error.code, 'checkpoint_binding_stale'); assert.ok(error.changedFields.includes('fundingPolicy'), error.changedFields.join());
    return true;
  });
  env.route = 'authorized_prepaid';
  fs.rmSync(env.permitFile);
  await assert.rejects(env.dispatcher.resumeApiAgentRun({ ...env.common(), runId }), { code: 'prepaid_authorization_missing' });
  env.writePermit();
  assert.equal(env.fake.requests.length, 1);
  const resumed = await env.dispatcher.resumeApiAgentRun({ ...env.common(), runId });
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed)); assert.equal(resumed.stdout, 'resumed');

  const parent = await env.dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'y' });
  assert.equal(parent.failureClass, 'outcome_uncertain');
  const parentRunId = parent.route.api_agent.checkpoint_run_id;
  const authorization = { parentRunId, fromTurn: 2, confirmDuplicateBillingRisk: true };
  await assert.rejects(env.dispatcher.startLinkedAttempt({ ...env.common(notPermitted), parentRunId, fromTurn: 2, authorization }), { code: 'prepaid_model_not_permitted' });
  // A renewed permit (new authorizationId) never inherits a linked attempt.
  env.writePermit(prepaidPermit({ authorizationId: 'pa_dispatch_2' }));
  await assert.rejects(env.dispatcher.startLinkedAttempt({ ...env.common(), parentRunId, fromTurn: 2, authorization }), (error) => {
    assert.equal(error.code, 'checkpoint_binding_stale'); assert.ok(error.changedFields.includes('fundingPolicy'), error.changedFields.join());
    return true;
  });
  env.writePermit();
  assert.equal(env.fake.requests.length, 4);
  const linked = await env.dispatcher.startLinkedAttempt({ ...env.common(), parentRunId, fromTurn: 2, authorization });
  assert.equal(linked.exitCode, 0, JSON.stringify(linked)); assert.equal(linked.stdout, 'linked');
  assert.equal(linked.route.funding.authorizationId, 'pa_dispatch_1');
});

test('prepaid: a permit removed or edited between turns stops the run before the next request', async (t) => {
  const env = await setupPrepaid(t, [ok('openai', { tools: [READ('README.md')] }), ok('openai', { text: 'never' })]);
  let turns = 0;
  const reauthorize = () => {
    if (++turns === 2) fs.rmSync(env.permitFile);
    try { return env.decide().decisionHash === admittedHash; } catch { return false; }
  };
  const admittedHash = env.decide().decisionHash;
  const receipt = await env.dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'x', reauthorize });
  assert.equal(env.fake.requests.length, 1); assert.notEqual(receipt.exitCode, 0);
  assert.equal(turns, 2);
  assert.deepEqual(receipt.route.api_agent.turns.map((turn) => turn.state), ['received', 'not_sent']);
  assert.match(JSON.stringify(receipt), /funding_decision_changed/);
  assert.equal(receipt.route.api_agent.reserve_release_evidence, false); assert.equal(env.releases, 1);
});

// Owner-authorized promotional (Claude): the same dispatcher, admitted by a
// separate private permit. Read-only only; never reserve evidence.
const { createPromotionalAuthority, PROMOTIONAL_POLICY } = require('../lib/promotional-authorization');
const PROMO_NOW = Date.parse('2026-11-02T12:00:00.000Z');
const promoPermit = (patch = {}) => {
  const id = patch.authorizationId || 'pp_dispatch_1';
  return { schemaVersion: 1, authorizationId: id, policy: PROMOTIONAL_POLICY, provider: 'claude', surface: 'claude_messages_agent',
    supervised: true, noPurchases: true, profileId: 'one', profileRevision: 3, organization: 'org_fixture', workspace: 'proj_fixture',
    credentialHmac: credentialHmac(id, KEY), models: ['claude-opus-5-5'], issuedAt: '2026-11-02T11:59:00.000Z', expiresAt: '2026-11-03T11:59:00.000Z',
    revokedAt: null, providerControls: { autoReload: 'off', billingMode: 'pay_as_you_go', operatorSpendLimitCents: 12000,
      operatorSpendLimitScope: 'organization', operatorSpendLimitActive: true, observedAt: '2026-11-02T11:00:00.000Z' },
    balance: { observedPromotionalCents: 19999, observedPurchasedCents: 370, observedMonthSpendCents: 0, promotionalExpiry: '2026-11-05',
      observedAt: '2026-11-02T11:00:00.000Z' }, ...patch };
};
async function setupPromo(t, script) {
  const env = await setup(t, 'claude', script);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-dispatch-promo-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  env.permitFile = path.join(dataDir, 'promotional-authorization.json');
  env.writePermit = (value = promoPermit()) => { fs.writeFileSync(env.permitFile, JSON.stringify(value), { mode: 0o600 }); fs.chmodSync(env.permitFile, 0o600); };
  env.writePermit();
  env.promotional = createPromotionalAuthority({ dataDir });
  env.route = 'authorized_promotional';
  env.decide = () => resolveFundingRoute({ envelope: { route: env.route, fallback: 'none' }, snapshot: profileSnapshot('claude', env.revision),
    kind: 'claude', entry: { transport: 'subscription:anthropic' }, promotionalAuthority: env.promotional, qualificationAuthority: env.authority, now: PROMO_NOW,
    credentialSourceFor: (p) => { env.sourcesBuilt.push(p); return () => ({ value: KEY, fingerprint: env.store.fingerprint(KEY) }); } });
  return env;
}

test('promotional: an admitted read-only run records the policy and limitations, is not grant-only and never reserve evidence', async (t) => {
  const env = await setupPromo(t, [ok('claude', { tools: [READ('README.md')] }), ok('claude', { text: 'promo done' })]);
  const receipt = await env.dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'read the readme', route: { mode: 'oneshot' } });
  assert.equal(receipt.exitCode, 0, JSON.stringify(receipt));
  const funding = receipt.route.funding;
  assert.equal(funding.actual, 'authorized_promotional'); assert.equal(funding.policy, PROMOTIONAL_POLICY); assert.equal(funding.grantOnly, false);
  assert.equal(funding.fundingSource, 'promotional_credit_first'); assert.equal(funding.reserveRelease, 'never');
  assert.equal(funding.authorizationId, 'pp_dispatch_1'); assert.equal(funding.qualificationId, 'promotional:pp_dispatch_1');
  assert.equal(funding.expiresAt, '2026-11-03T11:59:00.000Z'); assert.equal(funding.providerControls.operatorSpendLimitCents, 12000);
  for (const limitation of ['provider_cap_enforcement_lag', 'external_spend_unseen', 'purchased_balance_at_risk_on_overshoot', 'not_grant_only']) {
    assert.ok(funding.limitations.includes(limitation), limitation);
  }
  assert.equal(Object.hasOwn(funding, 'balance'), false);
  assert.equal(receipt.route.api_agent.reserve_release_evidence, false);
  const headers = env.fake.requests[0].headers;
  assert.equal(headers['x-api-key'], KEY); assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers.authorization, undefined); assert.equal(headers['openai-organization'], undefined);
  assert.equal(env.fake.requests[0].body.model, 'claude-opus-5-5');
  const serialized = JSON.stringify(env.delivered[0]);
  assert.ok(!serialized.includes(KEY)); assert.ok(!serialized.includes(promoPermit().credentialHmac));
  const runDir = path.join(env.store.root, receipt.route.api_agent.checkpoint_run_id);
  for (const name of fs.readdirSync(runDir)) assert.ok(!fs.readFileSync(path.join(runDir, name), 'utf8').includes(KEY), name);
});

test('promotional: cap, low-credit and unrecognized 400 errors are terminal with no reserve-release evidence', async (t) => {
  const cases = [
    [{ status: 429, json: { type: 'error', error: { type: 'rate_limit_error', message: 'limit', details: { error_code: 'enforced_spend_limit_reached' } } } }, 'spend_limit'],
    [{ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'You have reached your specified API usage limits.' } } }, 'spend_limit'],
    [{ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the API.' } } }, 'account_credit_low'],
    [{ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'something else' } } }, 'provider_request_rejected'],
  ];
  for (const [response, failureClass] of cases) {
    const env = await setupPromo(t, [response]);
    const receipt = await env.dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'x' });
    assert.equal(receipt.failureClass, failureClass); assert.equal(receipt.route.api_agent.resumable, false, failureClass);
    assert.equal(receipt.route.api_agent.reserve_release_evidence, false, failureClass); assert.equal(env.fake.requests.length, 1);
    const again = await env.dispatcher.resumeApiAgentRun({ ...env.common(), runId: receipt.route.api_agent.checkpoint_run_id });
    assert.equal(again.physical_attempt_count, 0); assert.equal(env.fake.requests.length, 1);
    assert.equal(env.releases, 2);
  }
});

test('promotional: a writer is refused and model membership and the permit binding hold for one-shot, resume and linked attempts', async (t) => {
  const responses = [{ status: 429, json: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } },
    ok('claude', { text: 'resumed' }), ok('claude', { tools: [READ('README.md')] }), { destroy: true }, ok('claude', { text: 'linked' })];
  const env = await setupPromo(t, queue(responses));
  const writer = { allowedWritePaths: ['README.md'], writePathsHash: 'a'.repeat(64), assertHeld: () => {},
    execution: { unifiedRunId: 'ur_fixture', segment: 1, taskId: 'task_fixture' } };
  const reads = env.credentialReads;
  await assert.rejects(env.dispatcher.runApiAgentOneShot({ ...env.common({ admission: env.admission({ writer }) }), prompt: 'x' }), { code: 'api_write_unauthorized' });
  const notPermitted = { model: 'claude-sonnet-5-5', effort: 'medium' };
  await assert.rejects(env.dispatcher.runApiAgentOneShot({ ...env.common(notPermitted), prompt: 'x' }), { code: 'promotional_model_not_permitted' });
  assert.equal(env.credentialReads, reads); assert.equal(env.fake.requests.length, 0); assert.deepEqual(env.runDirs(), []);

  const first = await env.dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'x' });
  assert.equal(first.failureClass, 'rate_limited');
  const runId = first.route.api_agent.checkpoint_run_id;
  await assert.rejects(env.dispatcher.resumeApiAgentRun({ ...env.common(notPermitted), runId }), { code: 'promotional_model_not_permitted' });
  env.writePermit(promoPermit({ models: ['claude-opus-5-5', 'claude-sonnet-5-5'] }));
  await assert.rejects(env.dispatcher.resumeApiAgentRun({ ...env.common(), runId }), (error) => {
    assert.equal(error.code, 'checkpoint_binding_stale');
    assert.ok(error.changedFields.includes('fundingPolicy') && error.changedFields.includes('decisionHash'), error.changedFields.join());
    return true;
  });
  // Neither a qualified grant decision nor any other route resumes a promotional checkpoint.
  env.route = 'included_api_credit';
  await assert.rejects(env.dispatcher.resumeApiAgentRun({ ...env.common(), runId }), (error) => {
    assert.equal(error.code, 'checkpoint_binding_stale'); assert.ok(error.changedFields.includes('fundingPolicy'), error.changedFields.join());
    return true;
  });
  env.route = 'authorized_prepaid';
  await assert.rejects(env.dispatcher.resumeApiAgentRun({ ...env.common(), runId }), { code: 'prepaid_provider_unsupported' });
  env.route = 'authorized_promotional';
  fs.rmSync(env.permitFile);
  await assert.rejects(env.dispatcher.resumeApiAgentRun({ ...env.common(), runId }), { code: 'promotional_authorization_missing' });
  env.writePermit();
  assert.equal(env.fake.requests.length, 1);
  const resumed = await env.dispatcher.resumeApiAgentRun({ ...env.common(), runId });
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed)); assert.equal(resumed.stdout, 'resumed');

  const parent = await env.dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'y' });
  assert.equal(parent.failureClass, 'outcome_uncertain');
  const parentRunId = parent.route.api_agent.checkpoint_run_id;
  const authorization = { parentRunId, fromTurn: 2, confirmDuplicateBillingRisk: true };
  await assert.rejects(env.dispatcher.startLinkedAttempt({ ...env.common(notPermitted), parentRunId, fromTurn: 2, authorization }), { code: 'promotional_model_not_permitted' });
  env.writePermit(promoPermit({ authorizationId: 'pp_dispatch_2' }));
  await assert.rejects(env.dispatcher.startLinkedAttempt({ ...env.common(), parentRunId, fromTurn: 2, authorization }), (error) => {
    assert.equal(error.code, 'checkpoint_binding_stale'); assert.ok(error.changedFields.includes('fundingPolicy'), error.changedFields.join());
    return true;
  });
  env.writePermit();
  assert.equal(env.fake.requests.length, 4);
  const linked = await env.dispatcher.startLinkedAttempt({ ...env.common(), parentRunId, fromTurn: 2, authorization });
  assert.equal(linked.exitCode, 0, JSON.stringify(linked)); assert.equal(linked.stdout, 'linked');
  assert.equal(linked.route.funding.authorizationId, 'pp_dispatch_1');
});

test('promotional: a permit edited between turns stops the run before the next request', async (t) => {
  const env = await setupPromo(t, [ok('claude', { tools: [READ('README.md')] }), ok('claude', { text: 'never' })]);
  let turns = 0;
  const reauthorize = () => {
    if (++turns === 2) env.writePermit(promoPermit({ balance: { ...promoPermit().balance, observedMonthSpendCents: 1 } }));
    try { return env.decide().decisionHash === admittedHash; } catch { return false; }
  };
  const admittedHash = env.decide().decisionHash;
  const receipt = await env.dispatcher.runApiAgentOneShot({ ...env.common(), prompt: 'x', reauthorize });
  assert.equal(env.fake.requests.length, 1); assert.notEqual(receipt.exitCode, 0);
  assert.equal(turns, 2);
  assert.deepEqual(receipt.route.api_agent.turns.map((turn) => turn.state), ['received', 'not_sent']);
  assert.match(JSON.stringify(receipt), /funding_decision_changed/);
  assert.equal(receipt.route.api_agent.reserve_release_evidence, false); assert.equal(env.releases, 1);
});
