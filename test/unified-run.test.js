'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUnifiedRuns, WRITE_BOUNDARY, apiCheckpointRunId, normalizeWriteContract } = require('../lib/unified-run');
const { selectSegment, assertReserveSegmentAdmission, apiReleaseBinding } = require('../lib/funding-routing');
const { buildNeutralHandoff } = require('../lib/neutral-handoff');
const { resolveApiModel } = require('../lib/api-agent-wire');
const { intentHash } = require('../lib/result-delivery');
// The engine's durable contract uses the real directory barrier, which is
// enforced only on Linux; elsewhere every unified mutation is refused, which
// test/unified-run-writer-holds.test.js and the integration suite cover.
const linuxOnly = { skip: process.platform !== 'linux' && 'unified run durability is Linux-only' };

const fresh = (percentRemaining, extra = {}) => ({ freshness: 'fresh', percentRemaining, protected: percentRemaining <= 10, vendorBlocked: false, ...extra });
const native = (patch = {}) => ({ kind: 'claude', accountId: 'default', transport: 'native', model: 'fixture-model', effort: 'low', ...patch });
const api = (patch = {}) => ({ kind: 'claude', accountId: 'default', transport: 'api', model: 'claude-opus-5-5', effort: 'medium',
  fundingProfileId: 'grant', expectedProfileRevision: 1, ...patch });
const qualified = (patch = {}) => ({ actual: 'included_api_credit', apiDispatchAllowed: true,
  identity: { provider: 'anthropic', organization: 'org', project: null, creditPeriod: '2026-10', profileRevision: 1, ...patch.identity },
  qualification: { qualificationId: 'q1', credentialFingerprint: 'f', ...patch.qualification } });
const goodRelease = (patch = {}) => ({ index: 1, errorClass: 'funding_exhausted', reserveReleaseEvidence: true, qualificationId: 'q1',
  binding: apiReleaseBinding(qualified()), taskId: 't_api', consumedBy: null, ...patch });

// A fake durable queue and fake authority hooks. Every counter is observable.
function harness(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-unified-unit-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const cwd = path.join(dataDir, 'ws'); fs.mkdirSync(cwd);
  const h = {
    dataDir, cwd, tasks: new Map(), submits: [], bindCalls: 0, nativeFundingCalls: 0, apiDecisionCalls: 0,
    // accountId -> { quotaSeat } for the accounts the operator authorized.
    accounts: { default: { quotaSeat: 'claude' }, work: { quotaSeat: 'claude#work' }, spare: { quotaSeat: 'claude#spare' }, ...options.accounts },
    headrooms: { claude: fresh(80), 'claude#work': fresh(70), 'claude#spare': fresh(95) },
    decision: null, holder: null, settled: true,
    files: new Map([['a.txt', 'start']]), snapshotAvailable: true,
  };
  h.queue = {
    get: (id) => h.tasks.get(id) || null,
    submitDurable: (id, input) => {
      if (h.tasks.has(id)) return h.tasks.get(id);
      h.submits.push({ id, input });
      const task = { id, status: 'queued', body: input, delivery: { intentHash: intentHash(input) }, startedAt: null, execution: { state: 'never_started' } };
      h.tasks.set(id, task);
      return task;
    },
    // Mirrors the queue: a missing task throws, a terminal task is unchanged
    // and a queued task stays never_started.
    cancel: (id) => {
      h.cancelCalls.push(id);
      const task = h.tasks.get(id);
      if (!task) throw Object.assign(new Error('missing'), { code: 'TASK_NOT_FOUND' });
      if (['done', 'failed', 'cancelled'].includes(task.status)) return task;
      task.status = 'cancelled';
      return task;
    },
    isTaskContext: (context) => h.contexts.has(context) && h.tasks.get(context.taskId)?.status === 'running',
    isOwnedSettled: () => false,
  };
  h.cancelCalls = []; h.contexts = new WeakSet();
  // The queue's private running-task context; only it satisfies reserve authority.
  h.start = (id) => {
    Object.assign(h.tasks.get(id), { status: 'running', startedAt: new Date().toISOString(), execution: { state: 'in_flight' } });
    const context = Object.freeze({ taskId: id, reservationId: null, requiresOwner: false, executionOwner: null });
    h.contexts.add(context);
    return context;
  };
  h.finish = (id, patch = {}) => Object.assign(h.tasks.get(id), { status: 'done', result: 'segment output', execution: { state: 'settled' }, ...patch });
  h.snapshot = () => (h.snapshotAvailable
    ? { available: true, head: 'h1', entries: new Map([...h.files].map(([name]) => [name, ' M'])), fingerprints: new Map(h.files), fingerprintsTruncated: false }
    : { available: false, reason: 'not_a_git_repository', entries: new Map() });
  h.make = () => createUnifiedRuns({
    dataDir, queue: h.queue,
    bindSegment: (entry) => {
      h.bindCalls++;
      const account = Object.hasOwn(h.accounts, entry.accountId) ? h.accounts[entry.accountId] : null;
      if (!account) throw Object.assign(new Error('unavailable'), { code: 'account_binding_required', status: 409 });
      return { accountId: entry.accountId, quotaSeat: account.quotaSeat };
    },
    headroom: (entry, binding) => h.headrooms[binding.quotaSeat] || null,
    apiDecision: () => { h.apiDecisionCalls++; return h.decision; },
    nativeFunding: () => { h.nativeFundingCalls++; },
    externalHolder: () => h.holder,
    physicallySettled: () => h.settled,
    snapshot: () => h.snapshot(),
    summarize: (before, after) => (!after?.available ? { available: false, reason: after?.reason } : { changedFileCount: [...after.fingerprints].filter(([name, fp]) => before.fingerprints?.get(name) !== fp).length,
      statusHash: JSON.stringify([...after.fingerprints]) }),
    ...options.engine,
  });
  h.runs = h.make();
  h.runDirs = () => { try { return fs.readdirSync(path.join(dataDir, 'unified-runs')); } catch { return []; } };
  h.manifest = (id) => JSON.parse(fs.readFileSync(path.join(dataDir, 'unified-runs', id, 'manifest.json'), 'utf8'));
  h.writeManifest = (id, run) => fs.writeFileSync(path.join(dataDir, 'unified-runs', id, 'manifest.json'), JSON.stringify(run));
  return h;
}
const refuse = (fn, code) => assert.throws(fn, (error) => { assert.equal(error.code, code, error.message); return true; });

test('native accountId default without a funding profile binds the existing login and submits no funding', linuxOnly, (t) => {
  const h = harness(t);
  const run = h.runs.create({ objective: 'Summarize', cwd: h.cwd, segments: [native()] });
  assert.equal(run.writeBoundary, WRITE_BOUNDARY);
  assert.equal(h.submits.length, 1);
  const { input } = h.submits[0];
  assert.equal(Object.hasOwn(input, 'funding'), false);
  assert.equal(input.expectedAccountId, 'default'); assert.equal(input.expectedQuotaSeat, 'claude');
  assert.equal(input.model, 'fixture-model'); assert.equal(input.effort, 'low');
  assert.equal(h.nativeFundingCalls, 0); assert.equal(h.apiDecisionCalls, 0);
  assert.deepEqual(h.manifest(run.id).bindings, [{ accountId: 'default', quotaSeat: 'claude' }]);
  h.finish(input.requestId.slice('queued:'.length));
  const done = h.runs.status(run.id);
  assert.equal(done.state, 'complete');
  assert.equal(done.segments[0].accountId, 'default'); assert.equal(done.segments[0].quotaSeat, 'claude');
});

test('a missing, null or unavailable account is refused before any directory or submit', linuxOnly, (t) => {
  const h = harness(t, { accounts: { default: null } });
  delete h.accounts.default;
  const { accountId, ...omitted } = native();
  refuse(() => h.runs.create({ objective: 'x', cwd: h.cwd, segments: [omitted] }), 'account_binding_required');
  refuse(() => h.runs.create({ objective: 'x', cwd: h.cwd, segments: [native({ accountId: null })] }), 'account_binding_required');
  refuse(() => h.runs.create({ objective: 'x', cwd: h.cwd, segments: [native()] }), 'account_binding_required');
  refuse(() => h.runs.create({ objective: 'x', cwd: h.cwd, segments: [native({ accountId: 'unlisted' })] }), 'account_binding_required');
  assert.deepEqual(h.runDirs(), []); assert.equal(h.submits.length, 0);
});

test('public input refuses internal fields, funding aliases, exact write contracts and banned reasoning keys with no trace', linuxOnly, (t) => {
  const h = harness(t);
  const base = { objective: 'x', cwd: h.cwd, segments: [native()] };
  refuse(() => h.runs.create({ ...base, unifiedRun: { id: 'ur_x' } }), 'invalid_funding_envelope');
  refuse(() => h.runs.create({ ...base, reserveRelease: { reserveReleaseEvidence: true } }), 'invalid_funding_envelope');
  refuse(() => h.runs.create({ ...base, funding: { route: 'subscription' } }), 'funding_envelope_unsupported');
  refuse(() => h.runs.create({ ...base, billing_mode: 'x' }), 'funding_alias_unsupported');
  refuse(() => h.runs.create({ ...base, allowedWritePaths: ['a.txt'] }), 'filesystem_contract_unsupported');
  refuse(() => h.runs.create({ ...base, dangerous: true }), 'filesystem_acknowledgement_required');
  refuse(() => h.runs.create({ ...base, constraints: 'x', segments: [{ ...native(), thinking: 'private' }] }), 'handoff_banned_content');
  refuse(() => h.runs.create({ ...base, segments: [{ ...native(), note: 'x' }] }), 'invalid_unified_run');
  refuse(() => h.runs.create({ ...base, context: { type: 'redacted_thinking' } }), 'handoff_banned_content');
  refuse(() => h.runs.create({ ...base, segments: [api({ fundingProfileId: undefined, expectedProfileRevision: undefined })] }), 'invalid_funding_envelope');
  assert.deepEqual(h.runDirs(), []); assert.equal(h.submits.length, 0);
});

test('the neutral handoff refuses provider-private reasoning and binds its exact text', () => {
  for (const segments of [[{ thinking: 'x' }], [{ signature: 'x' }], [{ encrypted_content: 'x' }], [{ reasoning_item_ids: ['r'] }], [{ type: 'reasoning' }]]) {
    assert.throws(() => buildNeutralHandoff({ objective: 'x', segments }), { code: 'handoff_banned_content' });
  }
  const one = buildNeutralHandoff({ runId: 'ur_1', objective: 'Edit', advisoryFileScope: ['a.txt'] });
  assert.match(one.text, /Advisory file scope \(not enforced\)/);
  assert.equal(one.digest, buildNeutralHandoff({ runId: 'ur_1', objective: 'Edit', advisoryFileScope: ['a.txt'] }).digest);
  assert.notEqual(one.digest, buildNeutralHandoff({ runId: 'ur_1', objective: 'Edit more', advisoryFileScope: ['a.txt'] }).digest);
});

test('a protected first account hands off to the next listed account with its own model and effort; unlisted is never used', linuxOnly, (t) => {
  const h = harness(t);
  h.headrooms.claude = fresh(5);
  const segments = [native(), native({ accountId: 'work', model: 'work-model', effort: 'high' })];
  const run = h.runs.create({ objective: 'x', cwd: h.cwd, segments });
  assert.equal(h.submits.length, 1);
  const [segment] = run.segments;
  // 'spare' has the most headroom but was not listed.
  assert.equal(segment.accountId, 'work'); assert.equal(segment.quotaSeat, 'claude#work');
  assert.equal(segment.model, 'work-model'); assert.equal(segment.effort, 'high');
  assert.match(segment.handoffDigest, /^[a-f0-9]{64}$/);
  assert.equal(h.submits[0].input.expectedAccountId, 'work');
  assert.ok(!h.submits.some((s) => s.input.expectedAccountId === 'spare'));

  h.headrooms['claude#work'] = { freshness: 'stale', percentRemaining: 70 };
  refuse(() => h.runs.create({ objective: 'x', cwd: h.cwd, segments }), 'waiting_for_quota');
  assert.equal(h.runDirs().length, 1); assert.equal(h.submits.length, 1);
});

test('a segment stopped at the reserve transfers once to the next listed account with a new handoff', linuxOnly, (t) => {
  const h = harness(t);
  const run = h.runs.create({ objective: 'x', cwd: h.cwd, segments: [native(), native({ accountId: 'work' })] });
  h.headrooms.claude = fresh(1);
  h.finish(run.segments[0].taskId, { status: 'failed', failureClass: 'quota_reserve', result: 'partial progress' });
  const next = h.runs.status(run.id);
  assert.equal(h.submits.length, 2);
  assert.equal(next.segments.length, 2);
  assert.equal(next.segments[1].accountId, 'work');
  assert.notEqual(next.segments[1].handoffDigest, next.segments[0].handoffDigest);
  assert.match(h.submits[1].input.prompt, /partial progress/);
  h.runs.status(run.id); h.runs.tick();
  assert.equal(h.submits.length, 2);
});

test('an account or quota seat change before the next segment stops without substitution', linuxOnly, (t) => {
  const h = harness(t);
  const run = h.runs.create({ objective: 'x', cwd: h.cwd, segments: [native(), native({ accountId: 'work' })] });
  h.accounts.work = { quotaSeat: 'claude#other' };
  h.headrooms.claude = fresh(1);
  h.finish(run.segments[0].taskId, { status: 'failed', failureClass: 'quota_reserve' });
  const stopped = h.runs.status(run.id);
  assert.equal(stopped.state, 'needs_attention'); assert.equal(stopped.stopReason, 'account_identity_changed');
  assert.equal(h.submits.length, 1);
});

test('segment selection: subscription, then qualified API, then released reserve, then stop', () => {
  const entries = [native(), api()];
  const decisions = [undefined, qualified()];
  assert.equal(selectSegment({ entries, headrooms: [fresh(50)], apiDecisions: decisions }).phase, 'subscription');
  assert.equal(selectSegment({ entries, headrooms: [fresh(5)], apiDecisions: decisions }).phase, 'api');
  const release = goodRelease();
  const reserve = selectSegment({ entries, headrooms: [fresh(5)], apiDecisions: decisions, exhaustedApi: [1], reserveRelease: release });
  assert.equal(reserve.phase, 'reserve'); assert.equal(reserve.index, 0);
  // Below the native floor the released reserve still admits while any headroom remains; zero stops.
  assert.equal(selectSegment({ entries, headrooms: [fresh(2)], apiDecisions: decisions, exhaustedApi: [1], reserveRelease: release }).phase, 'reserve');
  assert.equal(selectSegment({ entries, headrooms: [fresh(0)], apiDecisions: decisions, exhaustedApi: [1], reserveRelease: release }).stop, 'waiting_for_quota');
  // A release already consumed by a reserve segment is never selected again.
  assert.equal(selectSegment({ entries, headrooms: [fresh(5)], apiDecisions: decisions, exhaustedApi: [1], reserveRelease: goodRelease({ consumedBy: 't_reserve' }) }).stop, 'waiting_for_quota');
  assert.equal(selectSegment({ entries, headrooms: [fresh(5)], apiDecisions: [undefined, { actual: 'none', apiDispatchAllowed: false, blockedReason: 'grant_only_funding_unverified' }] }).stop,
    'grant_only_funding_unverified');
  assert.equal(selectSegment({ entries, writer: true, headrooms: [fresh(5)], apiDecisions: decisions }).stop, 'api_write_unavailable');
  assert.equal(selectSegment({ entries: [native()], headrooms: [{ freshness: 'stale', percentRemaining: 90 }] }).stop, 'waiting_for_quota');
});

test('rate limit, auth, permission and provider errors never release the reserve', () => {
  const entries = [native(), api()];
  for (const errorClass of ['rate_limited', 'auth_failed', 'permission_denied', 'provider_error', 'http_429', 'http_401', 'http_403', 'http_500']) {
    for (const reserveReleaseEvidence of [true, false]) {
      const release = goodRelease({ errorClass, reserveReleaseEvidence });
      assert.throws(() => assertReserveSegmentAdmission({ release, decision: qualified(), headroom: fresh(5) }), { code: 'reserve_release_unavailable' });
      assert.equal(selectSegment({ entries, headrooms: [fresh(5)], apiDecisions: [undefined, qualified()], exhaustedApi: [1], reserveRelease: release }).index, null, errorClass);
    }
  }
  const good = goodRelease();
  const unavailable = { code: 'reserve_release_unavailable' };
  assert.throws(() => assertReserveSegmentAdmission({ release: { ...good, qualificationId: 'other' }, decision: qualified(), headroom: fresh(5) }), unavailable);
  assert.throws(() => assertReserveSegmentAdmission({ release: { ...good, binding: undefined }, decision: qualified(), headroom: fresh(5) }), unavailable);
  // The prior API binding is revalidated: profile revision, credential, period and qualification.
  for (const decision of [qualified({ identity: { profileRevision: 2 } }), qualified({ qualification: { credentialFingerprint: 'g' } }),
    qualified({ identity: { creditPeriod: '2026-11' } }), qualified({ qualification: { qualificationId: 'q2' } }),
    qualified({ identity: { organization: 'other' } }), { ...qualified(), apiDispatchAllowed: false }, null]) {
    assert.throws(() => assertReserveSegmentAdmission({ release: good, decision, headroom: fresh(5) }), unavailable);
  }
  // A consumed release is usable only by its consuming task.
  const consumed = goodRelease({ consumedBy: 't_reserve' });
  assert.throws(() => assertReserveSegmentAdmission({ release: consumed, decision: qualified(), headroom: fresh(5) }), unavailable);
  assert.throws(() => assertReserveSegmentAdmission({ release: consumed, decision: qualified(), headroom: fresh(5), taskId: 't_other' }), unavailable);
  assertReserveSegmentAdmission({ release: consumed, decision: qualified(), headroom: fresh(5), taskId: 't_reserve' });
  assert.throws(() => assertReserveSegmentAdmission({ release: good, decision: qualified(), headroom: { freshness: 'stale', percentRemaining: 50 } }), { code: 'quota_unknown' });
  assert.throws(() => assertReserveSegmentAdmission({ release: good, decision: qualified(), headroom: fresh(0) }), { code: 'quota_reserve' });
  assert.throws(() => assertReserveSegmentAdmission({ release: good, decision: qualified(), headroom: fresh(5, { vendorBlocked: true }) }), { code: 'quota_reserve' });
  assertReserveSegmentAdmission({ release: good, decision: qualified(), headroom: fresh(2) });
  assertReserveSegmentAdmission({ release: good, decision: qualified(), headroom: fresh(1) });
});

test('engine: API failures without exhaustion evidence leave the reserve held; exhaustion evidence releases it once', linuxOnly, (t) => {
  for (const failureClass of ['rate_limited', 'auth_failed', 'permission_denied', 'provider_error']) {
    const h = harness(t);
    h.headrooms.claude = fresh(5); h.decision = qualified();
    const run = h.runs.create({ objective: 'x', cwd: h.cwd, segments: [native(), api()] });
    assert.equal(run.segments[0].phase, 'api');
    h.finish(run.segments[0].taskId, { status: 'failed', failureClass, route: { api_agent: { reserve_release_evidence: false } } });
    const after = h.runs.status(run.id);
    assert.equal(h.submits.length, 1, failureClass);
    assert.notEqual(after.state, 'complete');
    assert.ok(!after.segments.some((s) => s.phase === 'reserve'), failureClass);
  }
  const h = harness(t);
  h.headrooms.claude = fresh(5); h.decision = qualified();
  const run = h.runs.create({ objective: 'x', cwd: h.cwd, segments: [native(), api()] });
  h.finish(run.segments[0].taskId, { status: 'failed', failureClass: 'funding_exhausted', route: { funding: { qualificationId: 'q1' }, api_agent: { reserve_release_evidence: true } } });
  const released = h.runs.status(run.id);
  assert.equal(h.submits.length, 2);
  assert.equal(released.segments[1].phase, 'reserve'); assert.equal(released.segments[1].accountId, 'default');
  assert.equal(Object.hasOwn(h.submits[1].input, 'funding'), false);
});

test('API is unavailable to writers and an unqualified API stops with no submit', linuxOnly, (t) => {
  const h = harness(t);
  h.headrooms.claude = fresh(5); h.decision = qualified();
  refuse(() => h.runs.create({ objective: 'x', cwd: h.cwd, dangerous: true, acknowledgeFilesystemWrites: true, segments: [native(), api()] }), 'api_write_unavailable');
  assert.equal(h.apiDecisionCalls, 0);
  h.decision = { actual: 'none', apiDispatchAllowed: false, blockedReason: 'grant_only_funding_unverified', qualification: null };
  refuse(() => h.runs.create({ objective: 'x', cwd: h.cwd, segments: [native(), api()] }), 'grant_only_funding_unverified');
  assert.deepEqual(h.runDirs(), []); assert.equal(h.submits.length, 0);
});

test('a CLI alias on the API transport is unmapped, never translated', () => {
  for (const model of ['opus', 'sonnet', 'fixture-model', 'claude-opus']) assert.throws(() => resolveApiModel('claude', model, 'medium'), { code: 'api_model_unmapped' });
  assert.throws(() => resolveApiModel('openai', 'claude-opus-5-5', 'medium'), { code: 'api_model_unmapped' });
  assert.equal(resolveApiModel('claude', 'claude-opus-5-5', 'medium').apiModel, 'claude-opus-5-5');
});

test('terminal resume and status make no submit and no call', linuxOnly, (t) => {
  const h = harness(t);
  const run = h.runs.create({ objective: 'x', cwd: h.cwd, segments: [native()] });
  h.finish(run.segments[0].taskId);
  assert.equal(h.runs.status(run.id).state, 'complete');
  const binds = h.bindCalls, decisions = h.apiDecisionCalls;
  for (let i = 0; i < 3; i++) { assert.equal(h.runs.resume(run.id).state, 'complete'); h.runs.status(run.id); h.runs.tick(); }
  assert.equal(h.submits.length, 1); assert.equal(h.bindCalls, binds); assert.equal(h.apiDecisionCalls, decisions);
  refuse(() => h.runs.resume(run.id, { reserveRelease: { reserveReleaseEvidence: true } }), 'invalid_funding_envelope');
  refuse(() => h.runs.link(run.id, {}), 'linked_attempt_parent_not_terminal');
});

test('a restart after intent, dispatch or settle never submits a segment twice', linuxOnly, (t) => {
  // Crash after intent, before submit: restart submits the recorded intent exactly once.
  const h = harness(t);
  const run = h.runs.create({ objective: 'x', cwd: h.cwd, segments: [native(), native({ accountId: 'work' })] });
  const taskId = run.segments[0].taskId;
  const recorded = h.manifest(run.id);
  h.tasks.delete(taskId); h.submits.length = 0;
  recorded.segments[0].state = 'intent'; h.writeManifest(run.id, recorded);
  h.runs = h.make(); h.runs.tick(); h.runs.tick();
  assert.equal(h.submits.length, 1);
  assert.equal(h.submits[0].id, taskId);
  assert.equal(h.submits[0].input.prompt, recorded.segments[0].queueInput.prompt);

  // Crash after submit, before the dispatched record: the existing task is adopted.
  recorded.segments[0].state = 'intent'; h.writeManifest(run.id, recorded);
  h.runs = h.make(); h.runs.tick();
  assert.equal(h.submits.length, 1);
  assert.equal(h.manifest(run.id).segments[0].state, 'dispatched');

  // Dispatched and still running: restarts only observe.
  h.runs = h.make(); h.runs.tick(); h.runs.status(run.id); h.runs.resume(run.id);
  assert.equal(h.submits.length, 1);

  // Crash after the settle that recorded a transfer, before the successor started.
  h.headrooms.claude = fresh(1);
  h.finish(taskId, { status: 'failed', failureClass: 'quota_reserve' });
  const settled = h.manifest(run.id);
  settled.segments[0].state = 'settled'; settled.segments[0].outcome = 'quota_reserve';
  settled.pendingStart = { source: { index: 0, quotaSeat: 'claude', ...fresh(1) } };
  h.writeManifest(run.id, settled);
  h.runs = h.make(); h.runs.tick(); h.runs.tick();
  assert.equal(h.submits.length, 2);
  assert.equal(h.manifest(run.id).segments.length, 2);
  h.runs = h.make(); h.runs.tick(); h.runs.status(run.id);
  assert.equal(h.submits.length, 2);
});

function uncertainWriter(t, patch = {}) {
  const h = harness(t);
  Object.assign(h, patch);
  const run = h.runs.create({ objective: 'Edit a.txt', cwd: h.cwd, dangerous: true, acknowledgeFilesystemWrites: true,
    advisoryFileScope: ['a.txt'], segments: [native()] });
  const task = h.tasks.get(run.segments[0].taskId);
  task.execution = { state: 'uncertain' };
  h.files.set('a.txt', 'edited');
  return { h, run, task };
}

test('an uncertain writer links only after a physical fence and a fresh workspace digest, then starts exactly one segment', linuxOnly, (t) => {
  const { h, run, task } = uncertainWriter(t);
  const view = h.runs.status(run.id);
  assert.equal(view.state, 'needs_attention'); assert.equal(view.stopReason, 'writer_execution_uncertain');
  refuse(() => h.runs.resume(run.id), 'writer_execution_uncertain');
  // Not physically stopped yet.
  refuse(() => h.runs.link(run.id, { workspaceEffectsDigest: view.workspaceReconciliation?.workspaceEffectsDigest, confirmDuplicateBillingRisk: true }), 'writer_execution_uncertain');
  Object.assign(task, { status: 'interrupted', execution: { state: 'fenced' } });
  const fenced = h.runs.status(run.id);
  assert.equal(fenced.workspaceReconciliation.available, true);
  const digest = fenced.workspaceReconciliation.workspaceEffectsDigest;
  assert.match(digest, /^[a-f0-9]{64}$/);
  // The billing acknowledgement alone is not reconciliation.
  refuse(() => h.runs.link(run.id, { confirmDuplicateBillingRisk: true }), 'writer_execution_uncertain');
  refuse(() => h.runs.link(run.id, { workspaceEffectsDigest: 'f'.repeat(64), confirmDuplicateBillingRisk: true }), 'writer_execution_uncertain');
  h.files.set('a.txt', 'edited again');
  refuse(() => h.runs.link(run.id, { workspaceEffectsDigest: digest, confirmDuplicateBillingRisk: true }), 'writer_execution_uncertain');
  const current = h.runs.status(run.id).workspaceReconciliation.workspaceEffectsDigest;
  refuse(() => h.runs.link(run.id, { workspaceEffectsDigest: current }), 'linked_attempt_unauthorized');
  h.settled = false;
  refuse(() => h.runs.link(run.id, { workspaceEffectsDigest: current, confirmDuplicateBillingRisk: true }), 'writer_execution_uncertain');
  h.settled = true;
  h.holder = { holder: 'workflow_writer_lock', id: null };
  refuse(() => h.runs.link(run.id, { workspaceEffectsDigest: current, confirmDuplicateBillingRisk: true }), 'workspace_writer_busy');
  h.holder = null;
  assert.equal(h.submits.length, 1);
  const linked = h.runs.link(run.id, { workspaceEffectsDigest: current, confirmDuplicateBillingRisk: true });
  assert.equal(h.submits.length, 2);
  assert.equal(linked.segments.length, 2);
  assert.equal(linked.segments[1].linkedFrom, run.segments[0].taskId);
  assert.equal(linked.segments[0].outcome, 'linked_after_uncertain');
  refuse(() => h.runs.link(run.id, { workspaceEffectsDigest: current, confirmDuplicateBillingRisk: true }), 'linked_attempt_invalid');
  assert.equal(h.submits.length, 2);
});

test('a never-started fenced writer links with a fresh digest and no billing acknowledgement', linuxOnly, (t) => {
  const { h, run, task } = uncertainWriter(t);
  assert.equal(h.runs.status(run.id).stopReason, 'writer_execution_uncertain');
  Object.assign(task, { status: 'interrupted', execution: { state: 'never_started' } });
  const digest = h.runs.status(run.id).workspaceReconciliation.workspaceEffectsDigest;
  assert.equal(h.runs.link(run.id, { workspaceEffectsDigest: digest }).segments.length, 2);
  assert.equal(h.submits.length, 2);
});

test('a non-git workspace cannot be reconciled after an uncertain writer', linuxOnly, (t) => {
  const { h, run, task } = uncertainWriter(t, { snapshotAvailable: false });
  assert.equal(h.runs.status(run.id).stopReason, 'writer_execution_uncertain');
  Object.assign(task, { status: 'interrupted', execution: { state: 'fenced' } });
  const view = h.runs.status(run.id);
  assert.deepEqual(view.workspaceReconciliation, { available: false, reason: 'not_a_git_repository' });
  refuse(() => h.runs.link(run.id, { workspaceEffectsDigest: 'f'.repeat(64), confirmDuplicateBillingRisk: true }), 'workspace_reconciliation_unavailable');
  assert.equal(h.submits.length, 1);
});

test('a lost queue task for a dispatched writer is uncertain, never replayed', linuxOnly, (t) => {
  const h = harness(t);
  const run = h.runs.create({ objective: 'x', cwd: h.cwd, dangerous: true, acknowledgeFilesystemWrites: true, segments: [native()] });
  h.tasks.delete(run.segments[0].taskId);
  const view = h.runs.status(run.id);
  assert.equal(view.stopReason, 'writer_execution_uncertain');
  h.runs.tick(); refuse(() => h.runs.resume(run.id), 'writer_execution_uncertain');
  assert.equal(h.submits.length, 1);
});

// A run whose API segment exhausted its qualified credit and whose released
// reserve segment is now queued.
function reserveRun(t) {
  const h = harness(t);
  h.headrooms.claude = fresh(5); h.decision = qualified();
  const run = h.runs.create({ objective: 'x', cwd: h.cwd, segments: [native(), api()] });
  h.finish(run.segments[0].taskId, { status: 'failed', failureClass: 'funding_exhausted',
    route: { funding: { qualificationId: 'q1' }, api_agent: { reserve_release_evidence: true } } });
  const released = h.runs.status(run.id);
  const segment = released.segments[1];
  assert.equal(segment.phase, 'reserve');
  return { h, run: released, segment, task: h.tasks.get(segment.taskId) };
}

test('engine: release evidence counts only for the dispatched qualification on the receipt\'s funding record', linuxOnly, (t) => {
  for (const route of [
    { funding: { qualificationId: 'q2' }, api_agent: { reserve_release_evidence: true } },
    // The legacy api_agent qualification field is not authoritative.
    { api_agent: { reserve_release_evidence: true, qualification_id: 'q1' } },
    { funding: { qualificationId: 'q1' }, api_agent: { reserve_release_evidence: false } },
  ]) {
    const h = harness(t);
    h.headrooms.claude = fresh(5); h.decision = qualified();
    const run = h.runs.create({ objective: 'x', cwd: h.cwd, segments: [native(), api()] });
    h.finish(run.segments[0].taskId, { status: 'failed', failureClass: 'funding_exhausted', route });
    const after = h.runs.status(run.id);
    assert.equal(h.submits.length, 1, JSON.stringify(route));
    assert.equal(h.manifest(run.id).reserveRelease ?? null, null);
    assert.ok(!after.segments.some((s) => s.phase === 'reserve'));
  }
});

test('engine: a reserve segment consumes the release once; a changed API binding admits no reserve', linuxOnly, (t) => {
  const { h, run, segment } = reserveRun(t);
  assert.equal(h.manifest(run.id).reserveRelease.consumedBy, segment.taskId);
  // The reserve segment itself stops at the reserve: the consumed release never admits a second one.
  h.finish(segment.taskId, { status: 'failed', failureClass: 'quota_reserve' });
  for (let i = 0; i < 3; i++) { h.runs.tick(); h.runs.status(run.id); }
  assert.equal(h.submits.length, 2);
  assert.notEqual(h.runs.status(run.id).segments.at(-1).state, 'intent');

  // A profile revision change after the release blocks the reserve before any submit.
  const second = harness(t);
  second.headrooms.claude = fresh(5); second.decision = qualified();
  const other = second.runs.create({ objective: 'x', cwd: second.cwd, segments: [native(), api()] });
  second.decision = qualified({ identity: { profileRevision: 2 } });
  second.finish(other.segments[0].taskId, { status: 'failed', failureClass: 'funding_exhausted',
    route: { funding: { qualificationId: 'q1' }, api_agent: { reserve_release_evidence: true } } });
  const stopped = second.runs.status(other.id);
  assert.equal(second.submits.length, 1);
  assert.ok(!stopped.segments.some((s) => s.phase === 'reserve'));
});

test('reserve authority: only the queue\'s private context for the exact running reserve task, with fresh evidence', linuxOnly, (t) => {
  const { h, run, segment, task } = reserveRun(t);
  const body = task.body;
  assert.deepEqual(body.unifiedRun, { id: run.id, segment: segment.index });
  // Queued work has no running context yet.
  refuse(() => h.runs.reserveAuthority(body, { taskId: segment.taskId }), 'reserve_release_unavailable');
  const context = h.start(segment.taskId);
  const granted = h.runs.reserveAuthority(body, context);
  assert.equal(granted.taskId, segment.taskId); assert.equal(granted.qualificationId, 'q1');
  assert.equal(h.runs.reserveAuthority({ kind: 'claude' }, context), null);
  // Supplied usage is checked as well: 2% admits, zero, vendor-blocked and stale refuse.
  h.runs.reserveAuthority(body, context, { usage: { freshness: 'fresh', percentRemaining: 2 } });
  refuse(() => h.runs.reserveAuthority(body, context, { usage: { freshness: 'fresh', percentRemaining: 0 } }), 'quota_reserve');
  refuse(() => h.runs.reserveAuthority(body, context, { usage: { freshness: 'fresh', percentRemaining: 40, vendorBlocked: true } }), 'quota_reserve');
  refuse(() => h.runs.reserveAuthority(body, context, { usage: { freshness: 'stale', percentRemaining: 40 } }), 'quota_unknown');
  // The engine's own headroom view is rechecked too.
  h.headrooms.claude = fresh(0);
  refuse(() => h.runs.reserveAuthority(body, context), 'quota_reserve');
  h.headrooms.claude = { freshness: 'stale', percentRemaining: 50 };
  refuse(() => h.runs.reserveAuthority(body, context), 'quota_unknown');
  h.headrooms.claude = fresh(1);
  h.runs.reserveAuthority(body, context);
  // A forged or copied context, a spoofed body and a different task are refused.
  refuse(() => h.runs.reserveAuthority(body, { ...context }), 'reserve_release_unavailable');
  for (const spoof of [{ ...body, expectedAccountId: 'work' }, { ...body, expectedQuotaSeat: 'claude#work' }, { ...body, kind: 'codex' },
    { ...body, unifiedRun: { id: run.id, segment: 1 } }, { ...body, unifiedRun: { id: run.id, segment: '2' } },
    { ...body, unifiedRun: { id: 'ur_nope', segment: 2 } }, { ...body, unifiedRun: null }]) {
    refuse(() => h.runs.reserveAuthority(spoof, context), 'reserve_release_unavailable');
  }
  const [otherId] = h.submits.map((s) => s.id).filter((id) => id !== segment.taskId);
  Object.assign(h.tasks.get(otherId), { status: 'queued' });
  refuse(() => h.runs.reserveAuthority(body, h.start(otherId)), 'reserve_release_unavailable');
  // A changed intent, a changed binding or a manifest release consumed by another task is refused.
  const hash = task.delivery.intentHash;
  task.delivery.intentHash = 'f'.repeat(64);
  refuse(() => h.runs.reserveAuthority(body, context), 'reserve_release_unavailable');
  task.delivery.intentHash = hash;
  for (const decision of [qualified({ qualification: { credentialFingerprint: 'g' } }), qualified({ identity: { creditPeriod: '2026-11' } }), null]) {
    h.decision = decision;
    refuse(() => h.runs.reserveAuthority(body, context), 'reserve_release_unavailable');
  }
  h.decision = qualified();
  h.accounts.default = { quotaSeat: 'claude#moved' };
  refuse(() => h.runs.reserveAuthority(body, context), 'reserve_release_unavailable');
  h.accounts.default = { quotaSeat: 'claude' };
  const recorded = h.manifest(run.id);
  h.writeManifest(run.id, { ...recorded, reserveRelease: { ...recorded.reserveRelease, consumedBy: 't_ur_other_s009' } });
  refuse(() => h.runs.reserveAuthority(body, context), 'reserve_release_unavailable');
  h.writeManifest(run.id, recorded);
  h.runs.reserveAuthority(body, context);
  // Once the task stops running, its context no longer authorizes anything.
  h.finish(segment.taskId);
  refuse(() => h.runs.reserveAuthority(body, context), 'reserve_release_unavailable');
});

test('reserve authority is null for subscription segments and refuses an unproven unified claim', linuxOnly, (t) => {
  const h = harness(t);
  const run = h.runs.create({ objective: 'x', cwd: h.cwd, segments: [native()] });
  const task = h.tasks.get(run.segments[0].taskId);
  const context = h.start(task.id);
  assert.equal(h.runs.reserveAuthority(task.body, context), null);
  refuse(() => h.runs.reserveAuthority(task.body, { taskId: task.id }), 'reserve_release_unavailable');
});

test('cancel: a waiting run with no open segment closes, and no later tick, status or resume starts work', linuxOnly, (t) => {
  const h = harness(t);
  const run = h.runs.create({ objective: 'x', cwd: h.cwd, segments: [native(), native({ accountId: 'work' })] });
  h.headrooms.claude = fresh(1); h.headrooms['claude#work'] = fresh(1);
  h.finish(run.segments[0].taskId, { status: 'failed', failureClass: 'quota_reserve' });
  const waiting = h.runs.status(run.id);
  assert.equal(waiting.state, 'waiting_for_quota');
  assert.equal(waiting.recovery.cancel, 'available'); assert.equal(waiting.recovery.automaticRetry, false);
  assert.ok(h.manifest(run.id).pendingStart);
  const cancelled = h.runs.cancel(run.id);
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.recovery.cancel, 'not_applicable');
  assert.equal(h.manifest(run.id).pendingStart, null);
  h.headrooms['claude#work'] = fresh(90);
  for (let i = 0; i < 3; i++) { h.runs.tick(); h.runs.status(run.id); h.runs.resume(run.id); h.runs = h.make(); }
  assert.equal(h.submits.length, 1); assert.deepEqual(h.cancelCalls, []);
  // Cancelling a terminal run is a no-op.
  assert.equal(h.runs.cancel(run.id).state, 'cancelled');

  // A waiting record with no segment at all also closes without a queue call.
  const empty = { ...h.manifest(run.id), segments: [], state: 'waiting_for_quota', stopReason: 'waiting_for_quota', pendingStart: {} };
  h.writeManifest(run.id, empty);
  h.runs = h.make();
  assert.equal(h.runs.cancel(run.id).state, 'cancelled');
  h.runs.tick();
  assert.equal(h.submits.length, 1); assert.deepEqual(h.cancelCalls, []);
});

test('cancel: a durable never-started queued segment is cancelled and re-read against its exact intent', linuxOnly, (t) => {
  const h = harness(t);
  const run = h.runs.create({ objective: 'x', cwd: h.cwd, dangerous: true, acknowledgeFilesystemWrites: true, segments: [native(), native({ accountId: 'work' })] });
  const taskId = run.segments[0].taskId;
  const cancelled = h.runs.cancel(run.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.segments[0].state, 'cancelled'); assert.equal(cancelled.segments[0].outcome, 'cancelled_before_start');
  assert.deepEqual(h.cancelCalls, [taskId]);
  assert.equal(h.tasks.get(taskId).status, 'cancelled');
  assert.equal(h.runs.holderFor(h.cwd), null);
  for (let i = 0; i < 3; i++) { h.runs.tick(); h.runs.resume(run.id); }
  assert.equal(h.submits.length, 1);
});

test('cancel refuses an intent mismatch, an owned task and an unverified queue cancel', linuxOnly, (t) => {
  const conflict = harness(t);
  const a = conflict.runs.create({ objective: 'x', cwd: conflict.cwd, segments: [native()] });
  conflict.tasks.get(a.segments[0].taskId).delivery.intentHash = 'f'.repeat(64);
  refuse(() => conflict.runs.cancel(a.id), 'TASK_INTENT_CONFLICT');
  assert.deepEqual(conflict.cancelCalls, []); assert.equal(conflict.manifest(a.id).state, 'running');

  const owned = harness(t);
  const b = owned.runs.create({ objective: 'x', cwd: owned.cwd, segments: [native()] });
  owned.tasks.get(b.segments[0].taskId).executionReservation = { reservationId: 'r1' };
  refuse(() => owned.runs.cancel(b.id), 'owned_task_cancel_unsupported');
  assert.deepEqual(owned.cancelCalls, []);

  // The queue started the task between the plan and the cancel: the re-read refuses.
  const raced = harness(t);
  const c = raced.runs.create({ objective: 'x', cwd: raced.cwd, segments: [native()] });
  raced.queue.cancel = (id) => { raced.cancelCalls.push(id); raced.start(id); return raced.tasks.get(id); };
  refuse(() => raced.runs.cancel(c.id), 'unified_run_cancel_unverified');
  assert.equal(raced.manifest(c.id).state, 'running');
  assert.equal(raced.manifest(c.id).segments[0].state, 'dispatched');
});

test('cancel records prior settled work without starting the successor', linuxOnly, (t) => {
  const h = harness(t);
  const run = h.runs.create({ objective: 'x', cwd: h.cwd, segments: [native(), native({ accountId: 'work' })] });
  h.headrooms.claude = fresh(1);
  h.finish(run.segments[0].taskId, { status: 'failed', failureClass: 'quota_reserve' });
  const cancelled = h.runs.cancel(run.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.segments.length, 1); assert.equal(cancelled.segments[0].state, 'settled');
  assert.deepEqual(h.cancelCalls, []);
  for (let i = 0; i < 3; i++) { h.runs.tick(); h.runs.resume(run.id); }
  assert.equal(h.submits.length, 1);
});

test('cancel refuses running work, uncertain work and a crash gap with no queue record, synthesizing nothing', linuxOnly, (t) => {
  const running = harness(t);
  const a = running.runs.create({ objective: 'x', cwd: running.cwd, segments: [native()] });
  running.start(a.segments[0].taskId);
  refuse(() => running.runs.cancel(a.id), 'unified_run_segment_running');
  const view = running.runs.status(a.id);
  assert.equal(view.recovery.cancel, 'refused'); assert.equal(view.recovery.cancelRefusal, 'unified_run_segment_running');
  assert.equal(running.tasks.get(a.segments[0].taskId).status, 'running');

  const uncertain = harness(t);
  const b = uncertain.runs.create({ objective: 'x', cwd: uncertain.cwd, dangerous: true, acknowledgeFilesystemWrites: true, segments: [native()] });
  Object.assign(uncertain.tasks.get(b.segments[0].taskId), { status: 'failed', execution: { state: 'uncertain' } });
  refuse(() => uncertain.runs.cancel(b.id), 'writer_execution_uncertain');
  uncertain.runs.status(b.id);
  refuse(() => uncertain.runs.cancel(b.id), 'writer_execution_uncertain');
  assert.equal(uncertain.runs.status(b.id).recovery.link, 'after_physical_settlement_and_reconciliation');

  // Intent recorded, submit outcome unknown: the queue record is absent.
  const gap = harness(t);
  const c = gap.runs.create({ objective: 'x', cwd: gap.cwd, segments: [native()] });
  const taskId = c.segments[0].taskId;
  const recorded = gap.manifest(c.id);
  recorded.segments[0].state = 'intent';
  gap.writeManifest(c.id, recorded); gap.tasks.delete(taskId); gap.submits.length = 0;
  gap.runs = gap.make();
  refuse(() => gap.runs.cancel(c.id), 'outcome_uncertain');
  assert.equal(gap.tasks.has(taskId), false); assert.equal(gap.submits.length, 0); assert.deepEqual(gap.cancelCalls, []);
  assert.deepEqual(gap.manifest(c.id), recorded);
  // Dispatched with a missing record is uncertain too.
  recorded.segments[0].state = 'dispatched';
  gap.writeManifest(c.id, recorded);
  refuse(() => gap.runs.cancel(c.id), 'outcome_uncertain');
  assert.equal(gap.tasks.has(taskId), false);
});

test('cancel takes no fields and refuses server-internal ones', linuxOnly, (t) => {
  const h = harness(t);
  const run = h.runs.create({ objective: 'x', cwd: h.cwd, segments: [native()] });
  refuse(() => h.runs.cancel(run.id, { force: true }), 'invalid_unified_run');
  refuse(() => h.runs.cancel(run.id, { reserveRelease: {} }), 'invalid_funding_envelope');
  refuse(() => h.runs.cancel('ur_missing'), 'unified_run_not_found');
  assert.equal(h.manifest(run.id).state, 'running'); assert.deepEqual(h.cancelCalls, []);
});

// ---- API-only writer contract runs -----------------------------------------

function writerHarness(t, journal = {}) {
  const calls = { settled: [], reconcile: [] };
  const h = harness(t, { engine: {
    apiJournalSettled: (args) => { calls.settled.push(args); return journal.settled ? journal.settled(args) : { settled: true, exists: true }; },
    apiReconcileEffects: (args) => { calls.reconcile.push(args); if (!journal.reconcile) throw Object.assign(new Error('x'), { code: 'api_reconciliation_unavailable' });
      return journal.reconcile(args); },
  } });
  h.files.set('src/a.txt', 'start');
  h.headrooms.claude = fresh(5); h.decision = qualified();
  h.calls = calls;
  h.createWriter = (patch = {}) => h.runs.create({ objective: 'Edit', cwd: h.cwd, dangerous: true, acknowledgeFilesystemWrites: true,
    allowedWritePaths: ['src/a.txt'], segments: [api()], ...patch });
  return h;
}

test('write contracts: exact normalized paths, API-only, dangerous and acknowledged, refused with no trace otherwise', linuxOnly, (t) => {
  const h = writerHarness(t);
  const base = { objective: 'x', cwd: h.cwd, dangerous: true, acknowledgeFilesystemWrites: true, segments: [api()] };
  for (const paths of [[], ['.env'], ['src/.hidden/a.txt'], ['config/server.pem'], ['id_rsa'], ['../a.txt'], ['/abs.txt'], ['a/./b'], 'a.txt', [7]]) {
    assert.throws(() => h.runs.create({ ...base, allowedWritePaths: paths }), (error) => ['invalid_write_contract', 'invalid_unified_run'].includes(error.code), JSON.stringify(paths));
  }
  refuse(() => h.runs.create({ ...base, acknowledgeFilesystemWrites: false, allowedWritePaths: ['a.txt'] }), 'filesystem_acknowledgement_required');
  refuse(() => h.runs.create({ ...base, dangerous: false, allowedWritePaths: ['a.txt'] }), 'filesystem_acknowledgement_required');
  refuse(() => h.runs.create({ ...base, segments: [native(), api()], allowedWritePaths: ['a.txt'] }), 'filesystem_contract_unsupported');
  assert.deepEqual(h.runDirs(), []); assert.equal(h.submits.length, 0);
  const contract = normalizeWriteContract(['src/a.txt']);
  assert.deepEqual(contract.paths, ['src/a.txt']); assert.match(contract.pathsHash, /^[a-f0-9]{64}$/);
  assert.equal(apiCheckpointRunId('ur_' + 'a'.repeat(24), 1), apiCheckpointRunId('ur_' + 'a'.repeat(24), 1));
  assert.notEqual(apiCheckpointRunId('ur_' + 'a'.repeat(24), 1), apiCheckpointRunId('ur_' + 'a'.repeat(24), 2));
});

test('a contract run plans its API segment as a writer-capable task bound to its checkpoint and write paths', linuxOnly, (t) => {
  const h = writerHarness(t);
  const run = h.createWriter();
  assert.equal(run.writeBoundary, 'per_segment');
  assert.deepEqual(run.allowedWritePaths, ['src/a.txt']);
  assert.equal(run.segments[0].phase, 'api');
  assert.equal(run.segments[0].writeBoundary.kind, 'in_process_tool_contract');
  assert.equal(run.segments[0].writeBoundary.osSandbox, false);
  const { input } = h.submits[0];
  assert.equal(input.dangerous, true);
  assert.deepEqual(Object.keys(input.unifiedRun).sort(), ['apiCheckpointRunId', 'id', 'segment', 'writePathsHash']);
  assert.equal(input.unifiedRun.apiCheckpointRunId, apiCheckpointRunId(run.id, run.segments[0].index));
  assert.equal(input.unifiedRun.writePathsHash, run.writePathsHash);
  // The planned API writer holds the workspace against every native or unrelated dangerous writer.
  assert.deepEqual(h.runs.holderFor(h.cwd, {}), { holder: 'unified_run', id: run.id });
  assert.deepEqual(h.runs.holderFor(path.join(h.cwd, 'src'), { taskId: 't_other', intentHash: 'x' }), { holder: 'unified_run', id: run.id });
  assert.equal(h.runs.holderFor(h.cwd, { taskId: run.segments[0].taskId, intentHash: h.tasks.get(run.segments[0].taskId).delivery.intentHash }), null);
});

test('writer authority is proven only from the running task context and the exact durable binding', linuxOnly, (t) => {
  const h = writerHarness(t);
  const run = h.createWriter();
  const taskId = run.segments[0].taskId;
  const body = h.tasks.get(taskId).body;
  refuse(() => h.runs.apiWriterAuthority(body, { taskId }), 'api_write_unauthorized'); // not running, forged context
  const context = h.start(taskId);
  const authority = h.runs.apiWriterAuthority(body, context);
  assert.deepEqual({ ...authority, allowedWritePaths: [...authority.allowedWritePaths] }, { runId: run.id, segment: run.segments[0].index, taskId, cwd: h.cwd,
    checkpointRunId: body.unifiedRun.apiCheckpointRunId, allowedWritePaths: ['src/a.txt'], writePathsHash: run.writePathsHash });
  assert.ok(Object.isFrozen(authority));
  refuse(() => h.runs.apiWriterAuthority(body, Object.freeze({ ...context })), 'api_write_unauthorized');
  for (const forged of [
    { ...body, unifiedRun: { ...body.unifiedRun, writePathsHash: 'f'.repeat(64) } },
    { ...body, unifiedRun: { ...body.unifiedRun, apiCheckpointRunId: apiCheckpointRunId(run.id, 9) } },
    { ...body, unifiedRun: { ...body.unifiedRun, segment: 2 } },
    { ...body, unifiedRun: { ...body.unifiedRun, extra: true } },
    { ...body, unifiedRun: { id: body.unifiedRun.id, segment: body.unifiedRun.segment, apiCheckpointRunId: body.unifiedRun.apiCheckpointRunId } },
    { ...body, dangerous: false }, { ...body, cwd: path.join(h.cwd, 'src') }, { ...body, kind: 'codex' },
  ]) refuse(() => h.runs.apiWriterAuthority(forged, context), 'api_write_unauthorized');
  // A read-only task reference is never a writer.
  assert.equal(h.runs.apiWriterAuthority({ ...body, unifiedRun: { id: body.unifiedRun.id, segment: body.unifiedRun.segment } }, context), null);
});

test('a contract segment settles only when its journal is settled; otherwise it stays uncertain and holds', linuxOnly, (t) => {
  let journal = { settled: false, reason: 'patch_outcome_uncertain', effectsPending: ['1:0'] };
  const h = writerHarness(t, { settled: () => journal, reconcile: () => ({ settled: true, outcome: { class: 'effects_reconciled' },
    patches: [{ turn: 1, index: 0, path: 'src/a.txt', state: 'committed' }], uncertain: [] }) });
  const run = h.createWriter();
  const taskId = run.segments[0].taskId;
  h.start(taskId);
  h.finish(taskId, { route: { api_agent: { patches: [] } } });
  let view = h.runs.status(run.id);
  assert.equal(view.segments[0].state, 'uncertain');
  assert.equal(view.state, 'needs_attention'); assert.equal(view.stopReason, 'writer_execution_uncertain');
  assert.equal(view.recovery.effectsRecovery, 'resume_reconciles_journal');
  assert.deepEqual(h.calls.settled.at(-1).expect, { unifiedRunId: run.id, segment: run.segments[0].index, writePathsHash: run.writePathsHash,
    allowedWritePaths: run.allowedWritePaths });
  assert.equal(h.calls.settled.at(-1).checkpointRunId, apiCheckpointRunId(run.id, run.segments[0].index));
  // Uncertainty holds the workspace; API transport alone never releases it.
  assert.deepEqual(h.runs.holderFor(h.cwd, {}), { holder: 'unified_run', id: run.id });
  assert.equal(h.runs.status(run.id).recovery.cancel, 'refused');
  refuse(() => h.runs.link(run.id, { confirmDuplicateBillingRisk: true }), 'writer_execution_uncertain');
  assert.equal(h.submits.length, 1);
  // Resume reconciles the journal under the retained hold, never replays.
  h.holder = { holder: 'continuity', id: 'other' };
  refuse(() => h.runs.resume(run.id), 'writer_hold_lost');
  assert.equal(h.calls.reconcile.length, 0, 'another writer blocks recovery before any effect');
  h.holder = null;
  view = h.runs.resume(run.id);
  assert.equal(h.calls.reconcile.length, 1);
  assert.deepEqual(h.calls.reconcile[0].allowedWritePaths, ['src/a.txt']);
  assert.equal(view.segments[0].state, 'settled'); assert.equal(view.segments[0].outcome, 'effects_reconciled');
  assert.equal(view.stopReason, 'effects_reconciled');
  assert.equal(h.submits.length, 1, 'recovery never dispatches');
});

test('an unsettled reconciliation keeps the segment uncertain with its evidence', linuxOnly, (t) => {
  const h = writerHarness(t, { settled: () => ({ settled: false, reason: 'owner_not_proven_stopped' }),
    reconcile: () => ({ settled: false, outcome: { class: 'patch_outcome_uncertain' }, patches: [], uncertain: [{ key: '1:0', reason: 'unproven_temp' }] }) });
  const run = h.createWriter();
  const taskId = run.segments[0].taskId;
  h.start(taskId); h.finish(taskId);
  assert.equal(h.runs.status(run.id).segments[0].state, 'uncertain');
  const view = h.runs.resume(run.id);
  assert.equal(view.segments[0].state, 'uncertain');
  assert.deepEqual(view.segments[0].effectsRecovery.uncertain, [{ key: '1:0', reason: 'unproven_temp' }]);
  assert.deepEqual(h.runs.holderFor(h.cwd, {}), { holder: 'unified_run', id: run.id });
  // A missing reconciler leaves it uncertain too.
  const bare = writerHarness(t, { settled: () => ({ settled: false, reason: 'api_journal_unavailable' }) });
  const other = bare.createWriter();
  bare.start(other.segments[0].taskId); bare.finish(other.segments[0].taskId);
  bare.runs.status(other.id);
  refuse(() => bare.runs.resume(other.id), 'writer_execution_uncertain');
  assert.equal(bare.runs.status(other.id).segments[0].state, 'uncertain');
});

test('a running contract segment is never reconciled or replayed and a forged stored contract is corrupt', linuxOnly, (t) => {
  const h = writerHarness(t);
  const run = h.createWriter();
  h.start(run.segments[0].taskId);
  try { h.runs.resume(run.id); } catch {}
  assert.equal(h.calls.reconcile.length, 0, 'a live segment is never reconciled');
  assert.equal(h.submits.length, 1, 'and never replayed');
  const stored = h.manifest(run.id);
  stored.apiWriteContract = { ...stored.apiWriteContract, paths: ['src/a.txt', 'src/b.txt'] };
  h.writeManifest(run.id, stored);
  h.runs = h.make();
  assert.throws(() => h.runs.status(run.id), (error) => /corrupt|invalid/.test(error.code));
  // A corrupt record still holds the workspace.
  assert.ok(h.runs.holderFor(h.cwd, {}));
});

// Owner-authorized prepaid: an explicit per-entry opt-in, read-only, chosen
// only after every listed native seat is positively exhausted.
const { PREPAID_POLICY } = require('../lib/prepaid-authorization');
const exhausted = () => fresh(0, { vendorBlocked: true });
const codexNative = (patch = {}) => native({ kind: 'codex', ...patch });
const prepaidApi = (patch = {}) => api({ kind: 'codex', model: 'gpt-5', fundingProfileId: 'api_openai', fundingRoute: 'authorized_prepaid', ...patch });
const prepaidDecision = (patch = {}) => ({ actual: 'authorized_prepaid', apiDispatchAllowed: true, fundingPolicy: PREPAID_POLICY, grantOnly: false,
  blockedReason: null, identity: { provider: 'openai', organization: 'org', project: null, creditPeriod: null, profileRevision: 1, ...patch.identity },
  qualification: { qualificationId: 'prepaid:pa_1', credentialFingerprint: 'f' },
  prepaid: { authorizationId: 'pa_1', authorizationHash: 'a'.repeat(64), models: ['gpt-5'], ...patch.prepaid } });
// A native segment that ends at the reserve with its seat now exhausted plans
// the prepaid segment.
function prepaidRun(t, { segments = [codexNative(), prepaidApi()] } = {}) {
  const h = harness(t);
  h.decision = prepaidDecision();
  const run = h.runs.create({ objective: 'Review the change', cwd: h.cwd, segments });
  assert.equal(run.segments[0].phase, 'subscription');
  for (const seat of Object.keys(h.headrooms)) h.headrooms[seat] = exhausted();
  h.finish(run.segments[0].taskId, { status: 'failed', failureClass: 'quota_reserve', result: 'native progress' });
  const after = h.runs.status(run.id);
  return { h, run: after, segment: after.segments[after.segments.length - 1] };
}

test('prepaid opt-in: refused for writers, contracts, natives, other values and without a same-account native source', linuxOnly, (t) => {
  const h = harness(t);
  h.decision = prepaidDecision();
  const base = { objective: 'x', cwd: h.cwd, segments: [codexNative(), prepaidApi()] };
  const refused = (input, code, status) => assert.throws(() => h.runs.create(input), (error) => {
    assert.equal(error.code, code, error.message); assert.equal(error.status, status); return true;
  });
  refused({ ...base, dangerous: true, acknowledgeFilesystemWrites: true }, 'api_agent_read_only', 409);
  refused({ ...base, segments: [prepaidApi()], dangerous: true, acknowledgeFilesystemWrites: true, allowedWritePaths: ['a.txt'] }, 'api_agent_read_only', 409);
  refused({ ...base, allowedWritePaths: ['a.txt'] }, 'api_agent_read_only', 409);
  refused({ ...base, segments: [prepaidApi()] }, 'prepaid_exhaustion_source_required', 400);
  refused({ ...base, segments: [codexNative({ accountId: 'work' }), prepaidApi()] }, 'prepaid_exhaustion_source_required', 400);
  refused({ ...base, segments: [native(), prepaidApi()] }, 'prepaid_exhaustion_source_required', 400);
  refused({ ...base, segments: [codexNative({ fundingRoute: 'authorized_prepaid' }), prepaidApi()] }, 'invalid_funding_envelope', 400);
  for (const fundingRoute of ['included_api_credit', 'subscription', 'auto', null, true]) {
    refused({ ...base, segments: [codexNative(), prepaidApi({ fundingRoute })] }, 'invalid_funding_envelope', 400);
  }
  assert.deepEqual(h.runDirs(), []); assert.equal(h.submits.length, 0); assert.equal(h.apiDecisionCalls, 0);
});

test('prepaid is planned only after every listed native seat is positively exhausted, with its permit and evidence recorded', linuxOnly, (t) => {
  const { h, run, segment } = prepaidRun(t, { segments: [codexNative(), codexNative({ accountId: 'work' }), prepaidApi()] });
  assert.equal(h.submits.length, 2);
  assert.equal(segment.phase, 'api');
  const stored = h.manifest(run.id).segments[1];
  assert.equal(stored.entryIndex, 2);
  assert.deepEqual(stored.prepaidBinding, { authorizationId: 'pa_1', authorizationHash: 'a'.repeat(64), profileRevision: 1 });
  assert.deepEqual(stored.exhaustionEvidence.map((e) => [e.accountId, e.quotaSeat, e.percentRemaining]),
    [['default', 'claude', 0], ['work', 'claude#work', 0]]);
  assert.equal(Object.hasOwn(stored, 'apiBinding'), false);
  const { input } = h.submits[1];
  assert.deepEqual(input.funding, { route: 'authorized_prepaid', profileId: 'api_openai', expectedProfileRevision: 1, fallback: 'none' });
  assert.equal(input.dangerous, false); assert.deepEqual(input.unifiedRun, { id: run.id, segment: 2 });
  assert.equal(Object.hasOwn(input, 'expectedQuotaSeat'), false);
  assert.match(input.prompt, /native progress/);
  // Prepaid exhaustion never releases the subscription reserve.
  h.finish(segment.taskId, { status: 'failed', failureClass: 'funding_exhausted',
    route: { funding: { qualificationId: 'prepaid:pa_1' }, api_agent: { reserve_release_evidence: true } } });
  const after = h.runs.status(run.id);
  assert.equal(h.manifest(run.id).reserveRelease ?? null, null);
  assert.equal(after.state, 'waiting_for_quota'); assert.equal(h.submits.length, 2);
  assert.deepEqual(h.manifest(run.id).exhaustedApi, [2]);
});

test('prepaid waits on any unproven seat: stale, unknown, protected band, vendor-blocked or rate limited', linuxOnly, (t) => {
  for (const [label, second] of [['stale', { freshness: 'stale', percentRemaining: 0 }], ['unknown', null],
    ['protected 1%', fresh(1)], ['vendor blocked 40%', fresh(40, { vendorBlocked: true })],
    ['rate limited 40%', fresh(40, { vendorBlocked: true, reachedType: 'rate_limit_reached' })]]) {
    const h = harness(t);
    h.decision = prepaidDecision();
    const run = h.runs.create({ objective: 'x', cwd: h.cwd, segments: [codexNative(), codexNative({ accountId: 'work' }), prepaidApi()] });
    h.headrooms.claude = exhausted(); h.headrooms['claude#work'] = second;
    h.finish(run.segments[0].taskId, { status: 'failed', failureClass: 'quota_reserve' });
    const after = h.runs.status(run.id);
    assert.equal(after.state, 'waiting_for_quota', label); assert.equal(h.submits.length, 1, label);
    // Once that seat is proven exhausted too, the next tick plans prepaid.
    h.headrooms['claude#work'] = exhausted();
    h.runs.tick();
    assert.equal(h.submits.length, 2, label); assert.equal(h.submits[1].input.funding.route, 'authorized_prepaid', label);
  }
});

test('without the opt-in an API entry is never prepaid, and a grant run is unchanged', linuxOnly, (t) => {
  const h = harness(t);
  h.decision = prepaidDecision();
  const run = h.runs.create({ objective: 'x', cwd: h.cwd, segments: [codexNative(), prepaidApi({ fundingRoute: undefined })] });
  for (const seat of Object.keys(h.headrooms)) h.headrooms[seat] = exhausted();
  h.finish(run.segments[0].taskId, { status: 'failed', failureClass: 'quota_reserve' });
  assert.equal(h.runs.status(run.id).state, 'stopped'); assert.equal(h.submits.length, 1);
  // A grant entry stores no prepaid field and its funding route is unchanged.
  const g = harness(t);
  g.headrooms.claude = fresh(5); g.decision = qualified();
  const grant = g.runs.create({ objective: 'x', cwd: g.cwd, segments: [native(), api()] });
  const stored = g.manifest(grant.id);
  assert.equal(Object.hasOwn(stored.entries[1], 'fundingRoute'), false);
  assert.equal(stored.segments[0].queueInput.funding.route, 'included_api_credit');
  assert.equal(stored.segments[0].intentHash, intentHash(stored.segments[0].queueInput));
  for (const key of ['prepaidBinding', 'exhaustionEvidence']) assert.equal(Object.hasOwn(stored.segments[0], key), false);
  assert.ok(stored.segments[0].apiBinding);
  g.runs = g.make();
  assert.equal(g.runs.status(grant.id).segments.length, 1);
  assert.equal(g.manifest(grant.id).segments[0].intentHash, stored.segments[0].intentHash);
});

test('prepaid authority: only the exact running prepaid task, its planned permit and still-exhausted seats', linuxOnly, (t) => {
  const { h, run, segment } = prepaidRun(t);
  const task = h.tasks.get(segment.taskId);
  const body = task.body;
  refuse(() => h.runs.prepaidAuthority(body, { taskId: segment.taskId }), 'prepaid_authorization_invalid');
  const context = h.start(segment.taskId);
  const granted = h.runs.prepaidAuthority(body, context, { decision: prepaidDecision() });
  assert.equal(granted.taskId, segment.taskId); assert.equal(granted.authorizationId, 'pa_1');
  assert.equal(h.runs.prepaidAuthority({ kind: 'codex' }, context), null);
  // A replaced or edited permit is not the planned one.
  for (const decision of [prepaidDecision({ prepaid: { authorizationId: 'pa_2' } }), prepaidDecision({ prepaid: { authorizationHash: 'b'.repeat(64) } }),
    prepaidDecision({ identity: { profileRevision: 2 } })]) refuse(() => h.runs.prepaidAuthority(body, context, { decision }), 'funding_decision_changed');
  // Recovered allowance hands back; unproven exhaustion waits. Both refuse with quota_unknown.
  const transfer = (code) => assert.throws(() => h.runs.prepaidAuthority(body, context), (error) => {
    assert.equal(error.code, code); assert.equal(error.failureClass, 'quota_unknown'); return true;
  });
  h.headrooms.claude = fresh(60); transfer('prepaid_subscription_available');
  for (const view of [{ freshness: 'stale', percentRemaining: 0 }, null, fresh(1), fresh(40, { vendorBlocked: true })]) {
    h.headrooms.claude = view; transfer('quota_unknown');
  }
  h.headrooms.claude = exhausted();
  h.accounts.default = { quotaSeat: 'claude#moved' };
  refuse(() => h.runs.prepaidAuthority(body, context), 'account_identity_changed');
  h.accounts.default = { quotaSeat: 'claude' };
  for (const spoof of [{ ...body, kind: 'claude' }, { ...body, expectedAccountId: 'work' }, { ...body, dangerous: true },
    { ...body, unifiedRun: { id: run.id, segment: 1 } }, { ...body, unifiedRun: { ...body.unifiedRun, apiCheckpointRunId: 'x', writePathsHash: 'y' } },
    { ...body, unifiedRun: null }]) refuse(() => h.runs.prepaidAuthority(spoof, context), 'prepaid_authorization_invalid');
  refuse(() => h.runs.prepaidAuthority(body, { ...context }), 'prepaid_authorization_invalid');
  h.runs.prepaidAuthority(body, context);
  // A native segment is never prepaid authority.
  const n = harness(t);
  const nativeRun = n.runs.create({ objective: 'x', cwd: n.cwd, segments: [codexNative()] });
  const nativeTask = n.tasks.get(nativeRun.segments[0].taskId);
  refuse(() => n.runs.prepaidAuthority(nativeTask.body, n.start(nativeTask.id)), 'prepaid_authorization_invalid');
  h.finish(segment.taskId);
  refuse(() => h.runs.prepaidAuthority(body, context), 'prepaid_authorization_invalid');
});

test('recovered allowance is used at the next segment boundary, never mid-turn', linuxOnly, (t) => {
  const { h, run, segment } = prepaidRun(t);
  h.start(segment.taskId);
  // Recovery while the prepaid turn runs changes nothing.
  h.headrooms.claude = fresh(80);
  h.runs.tick(); h.runs.status(run.id); h.runs.resume(run.id);
  assert.equal(h.submits.length, 2);
  // The admission refusal (no model invoked) hands the objective back to native.
  h.finish(segment.taskId, { status: 'failed', failureClass: 'quota_unknown', result: '', execution: { state: 'not_invoked' } });
  const after = h.runs.status(run.id);
  assert.equal(h.submits.length, 3);
  assert.equal(after.segments[2].phase, 'subscription'); assert.equal(after.segments[2].accountId, 'default');
  assert.ok(!(h.manifest(run.id).exhaustedApi || []).includes(1), 'a not-invoked refusal leaves the prepaid entry usable');
  // A completed prepaid segment completes the run without another submit.
  const second = prepaidRun(t);
  second.h.headrooms.claude = fresh(80);
  second.h.finish(second.segment.taskId);
  assert.equal(second.h.runs.status(second.run.id).state, 'complete'); assert.equal(second.h.submits.length, 2);
});

test('a restart around a prepaid intent never submits it twice', linuxOnly, (t) => {
  const { h, run, segment } = prepaidRun(t);
  const recorded = h.manifest(run.id);
  h.tasks.delete(segment.taskId); h.submits.length = 0;
  recorded.segments[1].state = 'intent'; h.writeManifest(run.id, recorded);
  h.runs = h.make(); h.runs.tick(); h.runs.tick();
  assert.equal(h.submits.length, 1); assert.equal(h.submits[0].id, segment.taskId);
  assert.equal(h.submits[0].input.funding.route, 'authorized_prepaid');
  h.runs = h.make(); h.runs.tick(); h.runs.status(run.id);
  assert.equal(h.submits.length, 1);
});

test('a prepaid manifest is corrupt with writer danger, missing or misplaced prepaid fields, or a prepaid reserve release', linuxOnly, (t) => {
  const { h, run } = prepaidRun(t);
  const good = h.manifest(run.id);
  const corrupted = (mutate) => {
    const copy = JSON.parse(JSON.stringify(good)); mutate(copy);
    h.writeManifest(run.id, copy); h.runs = h.make();
    refuse(() => h.runs.status(run.id), 'unified_run_corrupt');
  };
  corrupted((m) => { m.dangerous = true; });
  corrupted((m) => { delete m.segments[1].prepaidBinding; });
  corrupted((m) => { m.segments[1].prepaidBinding.authorizationHash = 'nothex'; });
  corrupted((m) => { m.segments[1].prepaidBinding.profileRevision = 9; });
  corrupted((m) => { m.segments[1].exhaustionEvidence = []; });
  corrupted((m) => { m.segments[1].exhaustionEvidence[0].percentRemaining = 5; });
  corrupted((m) => { m.segments[1].apiBinding = { qualificationId: 'prepaid:pa_1' }; });
  corrupted((m) => { m.segments[0].prepaidBinding = good.segments[1].prepaidBinding; });
  corrupted((m) => { m.reserveRelease = goodRelease({ qualificationId: 'prepaid:pa_1', binding: { qualificationId: 'prepaid:pa_1' } }); });
  corrupted((m) => { delete m.entries[1].fundingRoute; });
  h.writeManifest(run.id, good); h.runs = h.make();
  assert.equal(h.runs.status(run.id).segments.length, 2);
});

// Unified Claude promotional fallback: same gate as prepaid, plus a v2 ledger permit.
const { PROMOTIONAL_POLICY } = require('../lib/promotional-authorization');
const promoApi = (patch = {}) => api({ kind: 'claude', model: 'claude-sonnet-4-5', fundingProfileId: 'api_claude', fundingRoute: 'authorized_promotional', ...patch });
const promoDecision = ({ ledger = true } = {}) => ({ actual: 'authorized_promotional', apiDispatchAllowed: true, fundingPolicy: PROMOTIONAL_POLICY, grantOnly: false, blockedReason: null,
  identity: { provider: 'anthropic', organization: 'org', project: null, creditPeriod: null, profileRevision: 1 },
  qualification: { qualificationId: 'promo:pa_2', credentialFingerprint: 'f' },
  promotional: { authorizationId: 'pa_2', authorizationHash: 'b'.repeat(64), models: ['claude-sonnet-4-5'], reserveRelease: 'never', ...(ledger ? { ledger: { budgetCents: 100 } } : {}) } });
function promoRun(t, { ledger = true, exhaust = true } = {}) {
  const h = harness(t);
  h.decision = promoDecision({ ledger });
  const run = h.runs.create({ objective: 'Review the change', cwd: h.cwd, segments: [native(), promoApi()] });
  if (exhaust) for (const seat of Object.keys(h.headrooms)) h.headrooms[seat] = exhausted();
  h.finish(run.segments[0].taskId, { status: 'failed', failureClass: 'quota_reserve', result: 'native progress' });
  const after = h.runs.status(run.id);
  return { h, run: after, segment: after.segments[after.segments.length - 1] };
}

test('unified Claude promotional fallback is planned only after positive native exhaustion and a v2 permit', linuxOnly, (t) => {
  const { h, run, segment } = promoRun(t);
  assert.equal(h.submits.length, 2); assert.equal(segment.phase, 'api');
  const stored = h.manifest(run.id).segments[1];
  assert.deepEqual(stored.prepaidBinding, { authorizationId: 'pa_2', authorizationHash: 'b'.repeat(64), profileRevision: 1, route: 'authorized_promotional' });
  assert.equal(h.submits[1].input.funding.route, 'authorized_promotional');
  assert.equal(h.submits[1].input.dangerous, false);
  // Promotional exhaustion never releases the reserve.
  h.finish(segment.taskId, { status: 'failed', failureClass: 'funding_exhausted',
    route: { funding: { qualificationId: 'promo:pa_2' }, api_agent: { reserve_release_evidence: true } } });
  assert.equal(h.manifest(run.id).reserveRelease ?? null, null);
  assert.equal(h.submits.length, 2);
});

test('unified Claude promotional fallback never spends with a v1 permit or without exhaustion', linuxOnly, (t) => {
  const v1 = promoRun(t, { ledger: false });
  assert.equal(v1.h.submits.length, 1, 'v1 permit: no api segment submitted');
  assert.notEqual(v1.segment.phase, 'api');
  const live = promoRun(t, { exhaust: false });
  assert.equal(live.h.submits.length, 1, 'native seat not exhausted: no spend');
  assert.notEqual(live.segment?.phase, 'api');
});
