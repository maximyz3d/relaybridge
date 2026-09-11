'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createContinuity } = require('../lib/continuity');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-continuity-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const records = new Map(), calls = [], controls = [];
  let values = { claude: 80, codex: 80 }, settings = { usageProtection: true, reservePercent: 5, autoHandoff: true };
  const headroom = (seat) => ({ quotaSeat: seat, freshness: values[seat] == null ? 'unknown' : 'fresh',
    percentRemaining: values[seat], protected: values[seat] != null && values[seat] <= 5 });
  const queue = { get: (id) => records.get(id), submitDurable(id, input) {
    if (!records.has(id)) { calls.push({ id, input }); records.set(id, { id, status: 'queued', execution: { state: 'never_started' }, body: input }); }
    return records.get(id);
  }, cancel(id) { const task = records.get(id); if (task) task.status = 'cancelled'; } };
  const options = { dataDir: dir, queue, quota: { getSettings: () => settings, headroom,
    verdict: (seat) => ({ ...headroom(seat), admit: !settings.usageProtection || !headroom(seat).protected }) },
    activeControls: () => controls, resolveCandidate: ({ kind, modelTier, effort, model, accountId }) => ({ kind, quotaSeat: kind, modelTier, effort, model: model || 'default-model', accountId: accountId || 'default' }) };
  const controller = createContinuity(options);
  const register = (extra = {}) => controller.register({ mode: 'managed', kind: 'claude', allowedProviders: ['claude', 'codex'],
    cwd: dir, objective: 'Inspect the project and delegate bounded reviews', ...extra });
  return { dir, controller, register, records, calls, controls, options, values, settings };
}
test('managed reserve transfer dispatches an actual comparable successor exactly once after settlement', (t) => {
  const f = fixture(t), source = f.register(), first = f.records.get(source.activeTaskId);
  first.status = 'running'; first.execution.state = 'in_flight'; f.values.claude = 4;
  f.controller.advance(source.id); assert.equal(f.calls.length, 1);
  assert.equal(f.controller.get(source.id).state, 'stopping_for_handoff');
  first.status = 'failed'; first.execution.state = 'settled'; first.error = 'quota reserve';
  f.controller.advance(source.id);
  const next = f.controller.get(source.id);
  assert.equal(next.owner.kind, 'codex'); assert.equal(next.epoch, 2); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].input.kind, 'codex'); assert.equal(f.calls[1].input.dangerous, false);
  assert.ok(fs.readFileSync(next.handoffPath, 'utf8').includes('Inspect the project'));
  createContinuity(f.options).advance(source.id); assert.equal(f.calls.length, 2);
});
test('unknown alternate leaves a durable handoff and never starts an unverified successor', (t) => {
  const f = fixture(t), source = f.register(); f.values.claude = 0; f.values.codex = null;
  Object.assign(f.records.get(source.activeTaskId), { status: 'failed', execution: { state: 'settled' } });
  f.controller.advance(source.id); assert.equal(f.controller.get(source.id).state, 'waiting_for_quota');
  assert.equal(f.calls.length, 1); assert.ok(f.controller.handoff(source.id).includes('pending'));
});
test('external owner explicitly checkpoints/yields, stale tokens cannot resume work, physical owners fence takeover', (t) => {
  const f = fixture(t), source = f.register({ mode: 'external' });
  const auth = { ownerToken: source.ownerToken, epoch: source.epoch, checkpoint: { decisions: 'Keep API stable', pending: 'Review parser', tests: 'Not run' } };
  f.controller.checkpoint(source.id, auth); f.values.claude = 3;
  f.controls.push({ cwd: f.dir, settled: false });
  assert.throws(() => f.controller.yieldOwner(source.id, { ...auth, releaseEvidence: 'Host stopped' }), /physically/);
  assert.equal(f.calls.length, 0); f.controls.length = 0;
  f.controller.yieldOwner(source.id, { ...auth, releaseEvidence: 'Host and all owned writers stopped' });
  assert.equal(f.calls.length, 1); assert.equal(f.controller.get(source.id).owner.kind, 'codex');
  assert.throws(() => f.controller.checkpoint(source.id, auth), /token/);
  assert.ok(f.controller.handoff(source.id).includes('Keep API stable'));
});
test('cancelled in-flight coordinator retains workspace exclusion and cannot be replayed', (t) => {
  const f = fixture(t), source = f.register(), task = f.records.get(source.activeTaskId);
  task.status = 'running'; task.execution.state = 'in_flight'; f.controller.cancel(source.id);
  assert.throws(() => f.register({ mode: 'external' }), /already/);
  createContinuity(f.options).advance(source.id); assert.equal(f.calls.length, 1);
});
test('quota-refused worker delegation is retained until it can be dispatched', (t) => {
  const f = fixture(t), source = f.register(), task = f.records.get(source.activeTaskId);
  Object.assign(task, { status: 'done', execution: { state: 'settled' }, result: JSON.stringify({
    checkpoint: { pending: 'Delegate parser review' }, delegations: [{ kind: 'codex', prompt: 'Review the parser read-only' }], complete: false }) });
  f.values.codex = 3; f.controller.advance(source.id);
  assert.equal(f.calls.length, 1); assert.equal(f.controller.get(source.id).delegations.length, 1);
});
test('resuming settled cancellation does not bypass a newer workspace owner', (t) => {
  const f = fixture(t), source = f.register(), task = f.records.get(source.activeTaskId);
  task.status = 'running'; task.execution.state = 'in_flight'; f.controller.cancel(source.id);
  task.execution.state = 'settled';
  const other = f.register({ mode: 'external' });
  assert.ok(other.ownerToken); assert.throws(() => f.controller.resume(source.id, { kind: 'codex' }), /settle and release/);
});
test('durable uncertain work fences release after a controller restart', (t) => {
  const f = fixture(t), source = f.register({ mode: 'external' });
  f.options.queue.unsettledInWorkspace = () => true;
  const restored = createContinuity(f.options);
  assert.throws(() => restored.yieldOwner(source.id, { ownerToken: source.ownerToken, epoch: 1,
    checkpoint: { pending: 'Verify orphan process' }, releaseEvidence: 'Host chat has stopped' }), /physically/);
  assert.equal(f.calls.length, 0);
});
test('registration retries after a lost response/restart preserve new checkpoints and keep acquisition secrets private', (t) => {
  const f = fixture(t), token = 'a'.repeat(64), input = { mode: 'external', ownerToken: token,
    checkpoint: { decisions: 'Original decision' } };
  const source = f.register(input);
  f.controller.checkpoint(source.id, { ownerToken: token, epoch: 1, checkpoint: { decisions: 'New decision after acquisition' } });
  // Simulate JSON committing but Markdown delivery/write failing.
  fs.unlinkSync(source.handoffPath);
  const restored = createContinuity(f.options), retry = restored.register({ mode: 'external', kind: 'claude',
    allowedProviders: ['claude', 'codex'], cwd: f.dir, objective: 'Inspect the project and delegate bounded reviews', ...input });
  assert.equal(retry.id, source.id); assert.equal(retry.epoch, 1); assert.equal(retry.ownerToken, token);
  assert.equal(retry.checkpoint.decisions, 'New decision after acquisition'); assert.equal(f.calls.length, 0);
  assert.match(fs.readFileSync(source.handoffPath, 'utf8'), /New decision after acquisition/);
  assert.throws(() => f.register({ ...input, objective: 'Changed objective' }), /intent changed/);
  assert.throws(() => f.register({ ...input, ownerToken: 'b'.repeat(64) }), /already/);
  const projections = JSON.stringify([restored.get(source.id), restored.list(), restored.handoff(source.id)]);
  for (const secret of [token, 'ownerTokenHash', 'registrationHash', 'lastAcquisition', 'requestHash']) assert.equal(projections.includes(secret), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'continuity', source.id+'.json'), 'utf8').includes(token), false);
  f.settings.autoHandoff = false;
  f.controller.yieldOwner(source.id, { ownerToken: token, epoch: 1, checkpoint: {}, releaseEvidence: 'All writers stopped' });
  assert.throws(() => f.register(input), /token/);
});
test('settled coordinator result and receipt are harvested before resume without dispatching its proposed worker', (t) => {
  const f = fixture(t), source = f.register(), task = f.records.get(source.activeTaskId);
  Object.assign(task, { status: 'done', execution: { state: 'settled' }, receiptId: 'receipt-original', result: JSON.stringify({
    checkpoint: { decisions: 'Harvest this completed result' }, delegations: [{ kind: 'codex', prompt: 'Next review' }], complete: false }) });
  const next = f.controller.resume(source.id, { kind: 'codex' });
  assert.equal(next.checkpoint.decisions, 'Harvest this completed result'); assert.equal(next.tasks[0].status, 'done');
  assert.equal(next.tasks[0].receiptId, 'receipt-original'); assert.equal(next.activeTaskId, null);
  assert.equal(f.calls.length, 1); f.controller.advance(source.id); assert.equal(f.calls.length, 1);
});
test('settled worker evidence is harvested exactly once on resume and completed objectives stay complete', (t) => {
  const f = fixture(t), source = f.register(), first = f.records.get(source.activeTaskId);
  Object.assign(first, { status: 'done', execution: { state: 'settled' }, result: JSON.stringify({ delegations: [{ kind: 'codex', prompt: 'Read-only review' }] }) });
  f.controller.advance(source.id); const worker = f.records.get(f.controller.get(source.id).activeTaskId);
  Object.assign(worker, { status: 'done', execution: { state: 'settled' }, result: 'Unique worker evidence', receiptId: 'receipt-worker' });
  const input = { kind: 'codex', ownerToken: 'c'.repeat(64), expectedEpoch: 1 };
  const next = f.controller.resume(source.id, input);
  createContinuity(f.options).resume(source.id, input);
  assert.equal(next.tasks.at(-1).receiptId, 'receipt-worker'); assert.equal(f.calls.length, 2);
  assert.equal(f.controller.get(source.id).checkpoint.completed.match(/Unique worker evidence/g).length, 1);
  f.settings.autoHandoff = false;
  f.controller.yieldOwner(source.id, { ownerToken: next.ownerToken, epoch: next.epoch, checkpoint: {}, releaseEvidence: 'All writers stopped' });
  f.controller.cancel(source.id);
  const second = f.register(), last = f.records.get(second.activeTaskId);
  Object.assign(last, { status: 'done', execution: { state: 'settled' }, result: JSON.stringify({ complete: true, checkpoint: { completed: 'Objective verified' } }) });
  assert.throws(() => f.controller.resume(second.id, { kind: 'codex' }), /already complete/);
  assert.equal(f.controller.get(second.id).state, 'complete'); assert.equal(f.controller.get(second.id).checkpoint.completed, 'Objective verified');
});
test('resume retains a same-provider model/account and validates explicitly changed routes', (t) => {
  const f = fixture(t), source = f.register({ model: 'selected-model', accountId: 'linked' });
  Object.assign(f.records.get(source.activeTaskId), { status: 'failed', execution: { state: 'settled' } });
  const same = f.controller.resume(source.id, { kind: 'claude' });
  assert.equal(same.owner.model, 'selected-model'); assert.equal(same.owner.accountId, 'linked');
  f.settings.autoHandoff = false;
  f.controller.yieldOwner(source.id, { ownerToken: same.ownerToken, epoch: same.epoch, checkpoint: {}, releaseEvidence: 'Stopped' });
  assert.throws(() => f.controller.resume(source.id, { kind: 'claude', model: null }), /invalid coordinator model/);
  assert.throws(() => f.controller.resume(source.id, { kind: 'claude', accountId: [] }), /invalid coordinator accountId/);
  const explicit = f.controller.resume(source.id, { kind: 'codex', model: 'alternate-model', accountId: 'alternate-account' });
  assert.equal(explicit.owner.model, 'alternate-model'); assert.equal(explicit.owner.accountId, 'alternate-account');
  f.controller.yieldOwner(source.id, { ownerToken: explicit.ownerToken, epoch: explicit.epoch, checkpoint: {}, releaseEvidence: 'Stopped' });
  const other = f.controller.resume(source.id, { kind: 'claude' });
  assert.equal(other.owner.model, 'default-model'); assert.equal(other.owner.accountId, 'default');
});
test('resume retries require the identical acquisition intent and live ownership generation, including after restart', (t) => {
  const f = fixture(t), source = f.register();
  Object.assign(f.records.get(source.activeTaskId), { status: 'failed', execution: { state: 'settled' } });
  const input = { kind: 'codex', model: 'specific', accountId: 'linked', ownerToken: 'd'.repeat(64), expectedEpoch: 1 };
  const next = f.controller.resume(source.id, input);
  f.controller.checkpoint(source.id, { ownerToken: input.ownerToken, epoch: next.epoch, checkpoint: { decisions: 'Keep latest' } });
  const restored = createContinuity(f.options), retry = restored.resume(source.id, input);
  assert.equal(retry.epoch, 2); assert.equal(retry.ownerToken, input.ownerToken); assert.equal(retry.checkpoint.decisions, 'Keep latest');
  assert.equal(f.calls.length, 1);
  for (const changed of [{ model: 'changed' }, { ownerToken: 'e'.repeat(64) }, { expectedEpoch: 2 }]) assert.throws(() => restored.resume(source.id, { ...input, ...changed }), /generation or token changed/);
  const stored = fs.readFileSync(path.join(f.dir, 'continuity', source.id+'.json'), 'utf8');
  assert.equal(stored.includes(input.ownerToken), false);
  for (const value of [restored.get(source.id), restored.list(), retry.handoff]) assert.equal(JSON.stringify(value).includes('lastAcquisition'), false);
  f.settings.autoHandoff = false;
  f.controller.yieldOwner(source.id, { ownerToken: input.ownerToken, epoch: 2, checkpoint: {}, releaseEvidence: 'Stopped' });
  assert.throws(() => restored.resume(source.id, input), /token/);
  const newer = restored.resume(source.id, { kind: 'claude', ownerToken: 'f'.repeat(64), expectedEpoch: 2 });
  assert.equal(newer.epoch, 3); assert.throws(() => restored.resume(source.id, input), /generation or token changed/);
});
test('retryable ownership tokens reject coercible REST values and incomplete resume pairs', (t) => {
  const f = fixture(t);
  assert.throws(() => f.register({ mode: 'external', ownerToken: ['a'.repeat(64)] }), /ownerToken/);
  assert.throws(() => f.register({ ownerToken: 'a'.repeat(64) }), /external ownerToken/);
  const source = f.register();
  for (const input of [{ ownerToken: ['a'.repeat(64)], expectedEpoch: 1 }, { ownerToken: 'a'.repeat(64) }, { expectedEpoch: 1 }]) {
    assert.throws(() => f.controller.resume(source.id, { kind: 'codex', ...input }), /ownerToken and expectedEpoch/);
  }
});
test('explicit resume cannot downgrade the original comparable tier', (t) => {
  const f = fixture(t), source = f.register({ modelTier: 'heavy' });
  Object.assign(f.records.get(source.activeTaskId), { status: 'failed', execution: { state: 'settled' } });
  const original = f.options.resolveCandidate;
  const controller = createContinuity({ ...f.options, resolveCandidate: (input) => ({ ...original(input), modelTier: 'light' }) });
  assert.throws(() => controller.resume(source.id, { kind: 'codex', model: 'smaller-model' }), /provider\/model restrictions/);
  assert.equal(controller.get(source.id).epoch, 1);
});

test('retryable resume of an unknown continuity id fails without acquiring ownership', (t) => {
  const f = fixture(t);
  assert.throws(() => f.controller.resume('ct_'+'0'.repeat(24), { kind: 'codex', ownerToken: 'a'.repeat(64), expectedEpoch: 1 }), /generation or token changed/);
});
