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
    activeControls: () => controls, resolveCandidate: ({ kind, modelTier, effort }) => ({ kind, quotaSeat: kind, modelTier, effort }) };
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
