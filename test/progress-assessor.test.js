'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createProgressAssessor } = require('../lib/progress-assessor');
const { RunSupervisor, resolveSupervisorOptions } = require('../lib/run-supervisor');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-assessor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let at = 0;
  const controls = new Map(), tasks = new Map(), calls = [], cancels = [];
  const settings = { dynamicSupervision: true, assessorEnabled: true };
  const queue = { get: (id) => tasks.get(id), submitDurable(id, intent) {
    calls.push(id); if (!tasks.has(id)) tasks.set(id, { id, intent, status: 'queued', execution: { state: 'never_started' } });
  }, cancel(id) { cancels.push(id); tasks.get(id).status = 'cancelled'; } };
  const options = { dataDir: dir, queue, controls, getSettings: () => settings, now: () => at,
    hasCapacity: () => true, selectCandidate: () => ({ kind: 'claude', accountId: 'default', quotaSeat: 'claude' }) };
  const controller = createProgressAssessor(options);
  function run(id = 'run_parent') {
    const supervisor = new RunSupervisor({ ...resolveSupervisorOptions({ startedAt: 0 }), runId: id, attemptId: `attempt_${id}` });
    const value = { runId: id, supervisor, cwd: dir, kind: 'claude', route: { request_id: 'parent' }, objective: 'Complete this project' };
    controls.set(id, value); return value;
  }
  function settle(id, verdict = 'unknown') {
    const task = tasks.get(id), snapshot = JSON.parse(fs.readFileSync(path.join(dir, 'continuity', 'assessors.json')))[id].snapshot;
    Object.assign(task, { status: 'done', execution: { state: 'settled' }, receiptId: `receipt_${id}`, result: JSON.stringify({
      runId: snapshot.runId, attemptId: snapshot.attemptId, evidenceHash: snapshot.hash,
      verdict, evidenceIds: snapshot.evidence.slice(0, 1).map((e) => e.id), reason: 'Bounded evidence' }) });
  }
  return { dir, options, controller, controls, tasks, calls, cancels, settings, run, settle, at: (value) => { at = value; } };
}
test('healthy 120-minute work defers all checks, then a later stall gets bounded assessments and useful work renews them', (t) => {
  const f = fixture(t), run = f.run();
  for (let minute = 1; minute <= 120; minute++) {
    f.at(minute * 60000); run.supervisor.recordOutput(`Completed milestone ${minute}\n`, minute * 60000);
    f.controller.observe(run); assert.equal(run.supervisor.evaluate(minute * 60000).action, 'continue');
  }
  assert.equal(f.calls.length, 0); assert.equal(run.supervisor.assessor.state, 'deferred_progress');
  for (const minute of [140, 145, 150]) {
    f.at(minute * 60000); f.controller.observe(run); f.settle(f.calls.at(-1)); f.controller.tick();
  }
  f.at(155 * 60000); f.controller.observe(run);
  assert.equal(f.calls.length, 3); assert.equal(run.supervisor.assessor.state, 'exhausted_until_progress');
  assert.equal(run.supervisor.evaluate(155 * 60000).action, 'continue', 'unknown plus silence cannot stop');
  run.supervisor.recordOutput('Completed a new verified milestone\n', 156 * 60000);
  f.at(156 * 60000); f.controller.observe(run); assert.equal(run.supervisor.assessor.count, 0);
  f.at(176 * 60000); f.controller.observe(run); assert.equal(f.calls.length, 4);
  const intent = f.tasks.get(f.calls.at(-1)).intent;
  assert.equal(intent.timeoutMs, 120000); assert.equal(intent.requireFreshUsage, true);
  assert.equal(intent.dangerous, false); assert.equal(intent.modelTier, 'light'); assert.equal(intent.providerBudget.maxOutputTokens, 1000);
});
test('live disable revokes an accepted stuck verdict immediately without changing timer mode', (t) => {
  const f = fixture(t), run = f.run(), s = run.supervisor;
  for (let i = 0; i < 13; i++) s.recordOutput('Repeated unchanged work\n', i * 1000);
  f.at(1200000); f.controller.observe(run); f.settle(f.calls[0], 'stuck'); f.controller.tick();
  assert.equal(s.progress.corroboratedStall(1200000, 240000), true);
  f.settings.dynamicSupervision = false; f.controller.syncSettings();
  assert.equal(s.progress.assessment, null); assert.equal(s.evaluate(1200001).action, 'continue');
  assert.equal(s.opts.adaptive, true); assert.equal(s.opts.hardDeadline, false);
  f.settings.dynamicSupervision = true; f.controller.syncSettings();
  assert.notEqual(s.assessor.state, 'assessor_disabled');
  assert.equal(s.evaluate(1800000).action, 'continue');
});
test('off-on rejects an in-flight verdict and holds the global slot through cancelled uncertain execution', (t) => {
  const f = fixture(t), run = f.run(), other = f.run('run_other');
  f.at(1200000); f.controller.observe(run); const id = f.calls[0], task = f.tasks.get(id);
  task.status = 'running'; task.execution.state = 'in_flight';
  f.controller.assertActive(`queued:${id}`);
  f.settings.assessorEnabled = false; f.controller.syncSettings();
  assert.equal(task.status, 'cancelled'); assert.equal(run.supervisor.assessor.taskId, id);
  assert.throws(() => f.controller.assertActive(`queued:${id}`), /revoked/);
  f.settings.assessorEnabled = true; f.controller.syncSettings();
  task.execution.state = 'uncertain'; f.at(1500000); f.controller.observe(other);
  assert.equal(f.calls.length, 1); assert.equal(other.supervisor.assessor.state, 'waiting_for_assessor');
  f.settle(id, 'stuck'); f.controller.tick();
  assert.equal(run.supervisor.progress.assessment, null); assert.equal(run.supervisor.assessor.taskId, null);
  f.controller.observe(other); assert.equal(f.calls.length, 2);
});
test('orphan cancellation persists across restart and does not free reservation until physical settlement', (t) => {
  const f = fixture(t), run = f.run(); f.at(1200000); f.controller.observe(run);
  const id = f.calls[0], task = f.tasks.get(id); task.status = 'running'; task.execution.state = 'in_flight';
  f.controls.delete(run.runId); f.controller.tick(); assert.deepEqual(f.cancels, [id]);
  const restored = createProgressAssessor(f.options), other = f.run('run_new');
  restored.tick(); restored.observe(other); assert.equal(f.calls.length, 1);
  task.execution.state = 'settled'; restored.tick(); restored.observe(other); assert.equal(f.calls.length, 2);
});
test('durable intent retries retain identity; missing obsolete intent is never launched', (t) => {
  const f = fixture(t), run = f.run(); f.at(1200000); f.controller.observe(run);
  const id = f.calls[0]; f.tasks.delete(id);
  const restored = createProgressAssessor(f.options); restored.tick();
  assert.deepEqual(f.calls, [id, id]);
  f.tasks.delete(id); f.controls.clear(); restored.tick(); assert.equal(f.calls.length, 2);
  const stored = JSON.parse(fs.readFileSync(path.join(f.dir, 'continuity', 'assessors.json')))[id];
  assert.equal(stored.finished, true); assert.equal(stored.intent, undefined);
});
test('late tool completion rejects stale assessment and renews only useful progress', (t) => {
  const f = fixture(t), run = f.run(), s = run.supervisor;
  s.progress.parser = 'claude_json';
  s.progress.event({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool' }] } }, 1000);
  f.at(1200000); f.controller.observe(run); const id = f.calls[0];
  s.progress.event({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'private result' }] } }, 1201000);
  f.at(1201000); f.settle(id, 'productive'); f.controller.tick(); f.controller.observe(run);
  assert.equal(s.progress.assessment, null); assert.equal(s.assessor.count, 0); assert.equal(f.calls.length, 1);
});
test('unavailable capacity and fresh quota do not spend attempts or fabricate a verdict', (t) => {
  const f = fixture(t), run = f.run(); f.at(1200000);
  const noCapacity = createProgressAssessor({ ...f.options, hasCapacity: () => false }); noCapacity.observe(run);
  assert.equal(run.supervisor.assessor.state, 'unavailable_capacity'); assert.equal(f.calls.length, 0);
  f.at(1500000); const noQuota = createProgressAssessor({ ...f.options, selectCandidate: () => null }); noQuota.observe(run);
  assert.equal(run.supervisor.assessor.state, 'unavailable_headroom'); assert.equal(run.supervisor.assessor.count, 0);
  assert.equal(run.supervisor.evaluate(7200000).action, 'continue');
});
test('real queue preserves assessor identity through delayed admission and cancellation prevents late execution', async (t) => {
  const { createTaskQueue } = require('../lib/task-queue');
  const f = fixture(t), run = f.run();
  let entered, release;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let launched = false, seenBody;
  const queue = createTaskQueue({ dataDir: path.join(f.dir, 'tasks'), receiptStoreId: '1'.repeat(64), executeOneShot: async (body, res) => {
    seenBody = body; entered(); await gate;
    try { controller.assertDispatch(body); launched = true; res.json({ stdout: 'Should not launch', exitCode: 0 }); }
    catch { res.status(409).json({ failureClass: 'assessment_revoked', model_invocation: false }); }
  } });
  t.after(() => queue.shutdown());
  const controller = createProgressAssessor({ ...f.options, queue });
  f.at(1200000); controller.observe(run); const id = run.supervisor.assessor.taskId;
  await enteredPromise;
  assert.equal(seenBody.source, undefined); assert.equal(seenBody.requestId, `queued:${id}`);
  f.settings.assessorEnabled = false; controller.syncSettings();
  assert.equal(queue.get(id).execution.state, 'in_flight'); assert.equal(run.supervisor.assessor.taskId, id);
  f.settings.assessorEnabled = true; controller.syncSettings();
  release();
  for (let i = 0; i < 100 && queue.get(id).execution.state === 'in_flight'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(launched, false); assert.equal(queue.get(id).execution.state, 'not_invoked');
  controller.tick(); assert.equal(run.supervisor.assessor.taskId, null);
});
