'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUnifiedRuns } = require('../lib/unified-run');
const { workspacesOverlap, canonicalWorkspace } = require('../lib/continuity');
const { intentHash } = require('../lib/result-delivery');

test('posix workspaces overlap in both directions and for parent/child, never for siblings or prefixes', () => {
  const o = (a, b) => workspacesOverlap(a, b, { platform: 'linux' });
  assert.equal(o('/srv/repo', '/srv/repo'), true);
  assert.equal(o('/srv/repo', '/srv/repo/sub'), true);
  assert.equal(o('/srv/repo/sub', '/srv/repo'), true);
  assert.equal(o('/srv/repo/sub/deep', '/srv/repo'), true);
  assert.equal(o('/srv/repo/', '/srv/repo/./sub/../sub'), true);
  assert.equal(o('/srv/repo', '/srv/repo-two'), false);
  assert.equal(o('/srv/repo/a', '/srv/repo/b'), false);
  assert.equal(o('/srv/Repo', '/srv/repo'), false);
  // An unknown path cannot prove disjointness.
  for (const bad of ['', null, undefined, 'a\0b']) assert.equal(o(bad, '/srv/repo'), true);
});

test('win32 workspaces fold case and separators, and differ across drives', () => {
  const o = (a, b) => workspacesOverlap(a, b, { platform: 'win32' });
  assert.equal(canonicalWorkspace('C:\\Repo\\Sub\\', 'win32'), 'c:\\repo\\sub');
  assert.equal(o('C:\\Repo', 'c:\\repo'), true);
  assert.equal(o('C:\\Repo\\Sub', 'c:\\REPO'), true);
  assert.equal(o('c:\\repo', 'C:/Repo/sub'), true);
  assert.equal(o('C:\\Repo', 'C:\\Repo-two'), false);
  assert.equal(o('C:\\Repo', 'D:\\Repo'), false);
});

function harness(t, options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-unified-holds-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const ws = path.join(base, 'ws'); const sub = path.join(ws, 'sub'); const other = path.join(base, 'other');
  fs.mkdirSync(sub, { recursive: true }); fs.mkdirSync(other);
  const tasks = new Map(); const submits = [];
  const h = { base, ws, sub, other, tasks, submits, external: null, percent: {} };
  h.options = {
    dataDir: path.join(base, 'data'),
    queue: { get: (id) => tasks.get(id) || null,
      submitDurable: (id, input) => {
        if (h.submitFault) return h.submitFault(id, input);
        // Mirrors the queue: an existing id is never replayed, and other intent conflicts.
        if (tasks.has(id)) {
          if (tasks.get(id).delivery?.intentHash !== intentHash(input)) throw Object.assign(new Error('conflict'), { code: 'TASK_INTENT_CONFLICT' });
          return tasks.get(id);
        }
        submits.push(id);
        const task = { id, status: 'queued', body: input, delivery: { intentHash: intentHash(input) }, startedAt: null, execution: { state: 'never_started' } };
        tasks.set(id, task); return task;
      },
      cancel: (id) => { const task = tasks.get(id); if (task && task.status === 'queued') task.status = 'cancelled'; return task; } },
    bindSegment: (entry) => ({ accountId: entry.accountId, quotaSeat: entry.accountId === 'default' ? 'claude' : `claude#${entry.accountId}` }),
    headroom: (entry, binding) => ({ freshness: 'fresh', percentRemaining: h.percent[binding.quotaSeat] ?? 80 }),
    // Writers see other runs through the engine's own holder view.
    externalHolder: (cwd, { runId }) => h.external || h.runs.holderFor(cwd, { exceptRunId: runId }),
    snapshot: () => ({ available: true, head: 'h', entries: new Map(), fingerprints: new Map() }),
    // The directory barrier can be failed on demand for one directory class.
    syncDirectory: (dir) => { h.syncCalls.push(dir); if (h.failSync?.(dir)) throw Object.assign(new Error('EIO'), { code: 'EIO' }); },
    // The barrier is injected, so the engine's durable contract is exercised
    // on every host; the unsupported-platform refusal is tested explicitly.
    platform: 'linux',
    ...options,
  };
  // A fresh engine over the same store models a restarted process.
  h.make = () => createUnifiedRuns(h.options);
  h.runs = h.make();
  h.syncCalls = []; h.failSync = null;
  h.request = (cwd, dangerous) => ({ objective: 'x', cwd, ...(dangerous ? { dangerous: true, acknowledgeFilesystemWrites: true } : {}),
    segments: [{ kind: 'claude', accountId: 'default', transport: 'native', model: 'm', effort: 'low' }] });
  h.manifest = (id) => JSON.parse(fs.readFileSync(path.join(base, 'data', 'unified-runs', id, 'manifest.json'), 'utf8'));
  h.runDirs = () => { try { return fs.readdirSync(path.join(base, 'data', 'unified-runs')); } catch { return []; } };
  return h;
}

test('an active writer run holds its workspace, parents and children; siblings and plain runs are unaffected', (t) => {
  const h = harness(t);
  const writer = h.runs.create(h.request(h.ws, true));
  for (const cwd of [h.ws, h.sub, h.base]) assert.deepEqual(h.runs.holderFor(cwd), { holder: 'unified_run', id: writer.id }, cwd);
  assert.equal(h.runs.holderFor(h.other), null);
  assert.equal(h.runs.holderFor(h.ws, { exceptRunId: writer.id }), null);
  // Overlapping writers are refused in both directions, before any directory.
  for (const cwd of [h.ws, h.sub, h.base]) assert.throws(() => h.runs.create(h.request(cwd, true)), { code: 'workspace_writer_busy' });
  assert.equal(h.runDirs().length, 1);
  // A disjoint writer and plain runs in the held workspace still start.
  h.runs.create(h.request(h.other, true));
  h.runs.create(h.request(h.ws, false));
  h.runs.create(h.request(h.ws, false));
  assert.equal(h.submits.length, 4);
  // The disjoint writer holds only its own workspace; plain runs never hold.
  assert.deepEqual(h.runs.holderFor(h.other), { holder: 'unified_run', id: h.runDirs().find((id) => h.manifest(id).cwd === fs.realpathSync(h.other)) });
});

test('only the run\'s own current segment task with its exact intent is exempt', (t) => {
  const h = harness(t);
  const writer = h.runs.create(h.request(h.ws, true));
  const segment = h.manifest(writer.id).segments[0];
  assert.equal(h.runs.holderFor(h.ws, { taskId: segment.taskId, intentHash: segment.intentHash }), null);
  assert.ok(h.runs.holderFor(h.ws, { taskId: segment.taskId, intentHash: 'f'.repeat(64) }));
  assert.ok(h.runs.holderFor(h.ws, { taskId: segment.taskId }));
  assert.ok(h.runs.holderFor(h.ws, { taskId: 't_other', intentHash: segment.intentHash }));
});

test('a terminal writer releases its hold; an unreadable manifest holds every workspace', (t) => {
  const h = harness(t);
  const writer = h.runs.create(h.request(h.ws, true));
  Object.assign(h.tasks.get(writer.segments[0].taskId), { status: 'done', result: 'ok', execution: { state: 'settled' } });
  assert.equal(h.runs.status(writer.id).state, 'complete');
  assert.equal(h.runs.holderFor(h.ws), null);
  const corrupt = path.join(h.base, 'data', 'unified-runs', `ur_${'0'.repeat(24)}`);
  fs.mkdirSync(corrupt); fs.writeFileSync(path.join(corrupt, 'manifest.json'), '{');
  for (const cwd of [h.ws, h.other]) assert.deepEqual(h.runs.holderFor(cwd), { holder: 'unified_run', id: `ur_${'0'.repeat(24)}` });
  assert.throws(() => h.runs.create(h.request(h.other, true)), { code: 'workspace_writer_busy' });
  h.runs.create(h.request(h.other, false));
});

test('an external holder (lock, owner or queue writer) blocks create and a waiting writer retries without a submit', (t) => {
  const h = harness(t);
  h.external = { holder: 'workflow_writer_lock', id: null };
  assert.throws(() => h.runs.create(h.request(h.ws, true)), (error) => error.code === 'workspace_writer_busy' && error.holder.holder === 'workflow_writer_lock');
  assert.equal(h.submits.length, 0);
  h.external = null;
  const request = h.request(h.ws, true);
  request.segments.push({ ...request.segments[0], accountId: 'work' });
  const run = h.runs.create(request);
  h.percent.claude = 1;
  Object.assign(h.tasks.get(run.segments[0].taskId), { status: 'failed', failureClass: 'quota_reserve', execution: { state: 'settled' } });
  h.external = { holder: 'dangerous_queue_task', id: null };
  // The successor waits for the writer instead of starting.
  const waiting = h.runs.status(run.id);
  assert.equal(waiting.state, 'waiting_for_writer'); assert.equal(waiting.holder.holder, 'dangerous_queue_task');
  h.runs.tick(); assert.equal(h.submits.length, 1);
  assert.deepEqual(h.runs.holderFor(h.ws), { holder: 'unified_run', id: run.id });
  h.external = null;
  h.runs.tick();
  assert.equal(h.submits.length, 2);
  assert.equal(h.runs.status(run.id).segments[1].accountId, 'work');
});

const isRunDir = (dir) => /[\\/]unified-runs[\\/]ur_[a-f0-9]+$/.test(dir);

// Rebinds a valid record to another id with its queue intent re-derived, so a
// mutation of it differs from a valid record only where it says.
function rebase(good, id, { segment = {}, input = {}, rehash = true } = {}) {
  const taskId = `t_ur_${id.slice(3)}_s001`;
  const original = good.segments[0];
  const queueInput = { ...original.queueInput, unifiedRun: { id, segment: 1 }, requestId: `queued:${taskId}`, ...input };
  return { ...good, id, segments: [{ ...original, taskId, queueInput, intentHash: rehash ? intentHash(queueInput) : original.intentHash, ...segment }] };
}

test('every malformed manifest, and a run directory without one, holds every workspace and refuses status', (t) => {
  const h = harness(t);
  const writer = h.runs.create(h.request(h.other, true));
  const good = h.manifest(writer.id);
  const segment = good.segments[0];
  const id = `ur_${'1'.repeat(24)}`;
  const dir = path.join(h.base, 'data', 'unified-runs', id);
  const base = rebase(good, id);
  const seg = base.segments[0];
  const elsewhere = fs.realpathSync(h.ws);
  const mutations = {
    array: [], nullValue: null, version: { version: 2 }, id: { id: `ur_${'2'.repeat(24)}` }, state: { state: 'bogus' },
    dangerous: { dangerous: 'yes' }, cwd: { cwd: 'relative/ws' }, entries: { entries: [] }, bindings: { bindings: [] },
    segments: { segments: 'x' }, segmentState: { segments: [{ ...seg, state: 'bogus' }] },
    segmentTask: { segments: [{ ...seg, taskId: 't_other' }] }, segmentHash: { segments: [{ ...seg, intentHash: 'abc' }] },
    segmentAccount: { segments: [{ ...seg, accountId: 'work' }] },
    twoOpen: { segments: [seg, { ...seg, index: 2, taskId: `t_ur_${'1'.repeat(24)}_s002` }] },
    completeOpen: { state: 'complete' }, terminalPending: { state: 'cancelled', pendingStart: {}, segments: [] },
    release: { reserveRelease: { index: 0, errorClass: 'funding_exhausted', reserveReleaseEvidence: true, qualificationId: 'q', binding: { qualificationId: 'q' } } },
    holder: { holder: 'lock' },
    // Cross-field identity: the run, its segment and the stored queue intent
    // must agree even when the intent's digest has been recomputed to match.
    runNotDangerous: { dangerous: false },
    runCwdMoved: { cwd: elsewhere },
    intentNotDangerous: rebase(good, id, { input: { dangerous: false } }),
    intentCwdMoved: rebase(good, id, { input: { cwd: elsewhere } }),
    intentAccount: rebase(good, id, { input: { expectedAccountId: 'work' } }),
    intentSeat: rebase(good, id, { input: { expectedQuotaSeat: 'claude#work' } }),
    intentModel: rebase(good, id, { input: { model: 'other' } }),
    intentRunId: rebase(good, id, { input: { unifiedRun: { id: `ur_${'2'.repeat(24)}`, segment: 1 } } }),
    intentRequest: rebase(good, id, { input: { requestId: 'queued:t_other' } }),
    intentFunding: rebase(good, id, { input: { funding: { route: 'subscription', profileId: 'p', expectedProfileRevision: 1, fallback: 'none' } } }),
    segmentModel: rebase(good, id, { segment: { model: 'other' } }),
    // A tampered intent whose digest was not recomputed.
    intentPrompt: rebase(good, id, { input: { prompt: 'something else' }, rehash: false }),
  };
  // h.base also contains the valid writer's workspace, and run directories are
  // scanned in filesystem order, so either run may be reported as its holder.
  const heldByCorruptOrWriter = (cwd, name) => {
    const held = h.runs.holderFor(cwd);
    assert.equal(held?.holder, 'unified_run', `${name} ${cwd}`);
    assert.ok([id, writer.id].includes(held.id), `${name} ${cwd} ${held.id}`);
  };
  const submitted = h.submits.length;
  for (const [name, patch] of Object.entries(mutations)) {
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
    const value = Array.isArray(patch) || patch === null ? patch : patch.version === 1 ? patch : { ...base, ...patch };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(value));
    for (const cwd of [h.ws, h.sub]) assert.deepEqual(h.runs.holderFor(cwd), { holder: 'unified_run', id }, `${name} ${cwd}`);
    heldByCorruptOrWriter(h.base, name);
    assert.throws(() => h.runs.status(id), { code: 'unified_run_corrupt' }, name);
    assert.throws(() => h.runs.resume(id), { code: 'unified_run_corrupt' }, name);
    assert.throws(() => h.runs.cancel(id), { code: 'unified_run_corrupt' }, name);
    assert.throws(() => h.runs.create(h.request(h.ws, true)), { code: 'workspace_writer_busy' }, name);
    h.runs.tick();
    assert.equal(h.submits.length, submitted, name);
    assert.equal(h.tasks.has(`t_ur_${'1'.repeat(24)}_s001`), false, name);
  }
  // Rewritten to its valid shape under its own id, the same record validates.
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(base));
  assert.equal(h.runs.status(id).id, id);
  // A run directory with no manifest is an interrupted or damaged create.
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
  assert.deepEqual(h.runs.holderFor(h.ws), { holder: 'unified_run', id });
  heldByCorruptOrWriter(h.base, 'no manifest');
  assert.throws(() => h.runs.status(id), { code: 'unified_run_corrupt' });
});

test('a failed directory barrier keeps the run uncertain and holding; later ticks submit nothing until the barrier is confirmed', (t) => {
  const h = harness(t);
  h.failSync = isRunDir;
  assert.throws(() => h.runs.create(h.request(h.ws, true)), (error) => {
    assert.equal(error.code, 'unified_run_publication_uncertain'); assert.equal(error.publication, 'uncertain');
    assert.match(error.runId, /^ur_/);
    return true;
  });
  assert.equal(h.submits.length, 0);
  const [id] = h.runDirs();
  assert.equal(h.manifest(id).segments[0].state, 'intent');
  // The uncertain run holds its workspace even from a fresh writer.
  assert.deepEqual(h.runs.holderFor(h.ws), { holder: 'unified_run', id });
  assert.throws(() => h.runs.create(h.request(h.ws, true)), { code: 'workspace_writer_busy' });
  // Status, resume and later ticks with the barrier still failing submit nothing.
  for (let i = 0; i < 3; i++) {
    h.runs.tick();
    assert.throws(() => h.runs.status(id), { code: 'unified_run_publication_uncertain' });
    assert.throws(() => h.runs.resume(id), { code: 'unified_run_publication_uncertain' });
    assert.throws(() => h.runs.cancel(id), { code: 'unified_run_publication_uncertain' });
  }
  assert.equal(h.submits.length, 0);
  // Once the barrier holds, the next tick confirms the record and submits the recorded intent exactly once.
  h.failSync = null;
  h.runs.tick();
  assert.equal(h.submits.length, 1);
  h.runs.tick(); h.runs.status(id);
  assert.equal(h.submits.length, 1);
  const view = h.runs.status(id);
  assert.equal(view.durability.publication, 'confirmed'); assert.equal(view.durability.directoryBarrier, 'enforced');
  assert.equal(view.segments[0].state, 'dispatched');
});

test('a barrier failure after a settle keeps the successor unstarted until it is confirmed', (t) => {
  const h = harness(t);
  const request = h.request(h.ws, true);
  request.segments.push({ ...request.segments[0], accountId: 'work' });
  const run = h.runs.create(request);
  h.percent.claude = 1;
  Object.assign(h.tasks.get(run.segments[0].taskId), { status: 'failed', failureClass: 'quota_reserve', execution: { state: 'settled' } });
  h.failSync = isRunDir;
  assert.throws(() => h.runs.status(run.id), { code: 'unified_run_publication_uncertain' });
  h.runs.tick(); h.runs.tick();
  assert.equal(h.submits.length, 1);
  assert.deepEqual(h.runs.holderFor(h.ws), { holder: 'unified_run', id: run.id });
  h.failSync = null;
  h.runs.tick(); h.runs.tick();
  assert.equal(h.submits.length, 2);
});

test('a reopened engine re-establishes the directory barrier before any submit while the failure persists', (t) => {
  const h = harness(t);
  h.failSync = isRunDir;
  assert.throws(() => h.runs.create(h.request(h.ws, true)), { code: 'unified_run_publication_uncertain' });
  const [id] = h.runDirs();
  assert.equal(h.manifest(id).segments[0].state, 'intent');
  // The process restarts with the barrier still failing: the surviving bytes
  // are visible, but nothing proves they survive a crash.
  h.runs = h.make();
  assert.equal(h.runs.get(id).durability.publication, 'unconfirmed');
  for (let i = 0; i < 3; i++) {
    h.runs.tick();
    assert.throws(() => h.runs.status(id), { code: 'unified_run_publication_uncertain' });
    assert.throws(() => h.runs.resume(id), { code: 'unified_run_publication_uncertain' });
    assert.throws(() => h.runs.cancel(id), { code: 'unified_run_publication_uncertain' });
    assert.deepEqual(h.runs.holderFor(h.ws), { holder: 'unified_run', id });
  }
  assert.equal(h.runs.get(id).durability.publication, 'uncertain');
  assert.equal(h.submits.length, 0);
  assert.ok(h.syncCalls.some((dir) => dir === path.join(h.base, 'data', 'unified-runs', id)));
  // Once the barrier succeeds the recorded intent is submitted exactly once.
  h.failSync = null;
  h.runs.tick(); h.runs.tick();
  assert.equal(h.submits.length, 1);
  const view = h.runs.status(id);
  assert.equal(view.durability.publication, 'confirmed');
  assert.equal(view.segments[0].state, 'dispatched');
});

test('after a restart even a confirmed-before run is barriered again before its successor or its release', (t) => {
  const h = harness(t);
  const request = h.request(h.ws, true);
  request.segments.push({ ...request.segments[0], accountId: 'work' });
  const run = h.runs.create(request);
  h.percent.claude = 1;
  Object.assign(h.tasks.get(run.segments[0].taskId), { status: 'failed', failureClass: 'quota_reserve', execution: { state: 'settled' } });
  h.runs = h.make();
  h.failSync = isRunDir;
  h.runs.tick(); h.runs.tick();
  assert.throws(() => h.runs.resume(run.id), { code: 'unified_run_publication_uncertain' });
  assert.equal(h.submits.length, 1);
  assert.deepEqual(h.runs.holderFor(h.ws), { holder: 'unified_run', id: run.id });
  h.failSync = null;
  h.runs.tick();
  assert.equal(h.submits.length, 2);
  // A terminal writer reopened under a failing barrier still holds: its
  // terminal bytes may revert to the earlier running record.
  Object.assign(h.tasks.get(h.manifest(run.id).segments[1].taskId), { status: 'done', result: 'ok', execution: { state: 'settled' } });
  assert.equal(h.runs.status(run.id).state, 'complete');
  h.runs = h.make();
  h.failSync = isRunDir;
  assert.deepEqual(h.runs.holderFor(h.ws), { holder: 'unified_run', id: run.id });
  assert.throws(() => h.runs.create(h.request(h.sub, true)), { code: 'workspace_writer_busy' });
  h.failSync = null;
  assert.equal(h.runs.holderFor(h.ws), null);
  assert.equal(h.submits.length, 2);
});

test('an existing task under the fixed id with other intent is uncertain, never replayed or cancelled', (t) => {
  const h = harness(t);
  h.failSync = isRunDir;
  assert.throws(() => h.runs.create(h.request(h.ws, true)), { code: 'unified_run_publication_uncertain' });
  const [id] = h.runDirs();
  const { taskId } = h.manifest(id).segments[0];
  h.tasks.set(taskId, { id: taskId, status: 'running', delivery: { intentHash: 'f'.repeat(64) }, startedAt: 'x', execution: { state: 'in_flight' } });
  h.runs = h.make(); h.failSync = null;
  h.runs.tick();
  const view = h.runs.status(id);
  assert.equal(view.state, 'needs_attention'); assert.equal(view.stopReason, 'writer_execution_uncertain');
  assert.equal(view.segments[0].state, 'uncertain'); assert.equal(view.segments[0].outcome, 'TASK_INTENT_CONFLICT');
  assert.throws(() => h.runs.cancel(id), { code: 'writer_execution_uncertain' });
  assert.throws(() => h.runs.resume(id), { code: 'writer_execution_uncertain' });
  assert.deepEqual(h.runs.holderFor(h.ws), { holder: 'unified_run', id });
  assert.equal(h.submits.length, 0); assert.equal(h.tasks.get(taskId).delivery.intentHash, 'f'.repeat(64));
});

test('a submit that throws while its task exists is uncertain; cancel is refused and the hold is kept', (t) => {
  const h = harness(t);
  // The task landed, but the queue could not project its delivery.
  h.submitFault = (id, input) => {
    h.tasks.set(id, { id, status: 'queued', body: input, delivery: { intentHash: intentHash(input) }, startedAt: null, execution: { state: 'never_started' } });
    throw Object.assign(new Error('receipts unavailable'), { code: 'DELIVERY_UNAVAILABLE' });
  };
  const run = h.runs.create(h.request(h.ws, true));
  h.submitFault = null;
  assert.equal(run.state, 'needs_attention'); assert.equal(run.stopReason, 'writer_execution_uncertain');
  assert.equal(run.segments[0].state, 'uncertain'); assert.equal(run.segments[0].outcome, 'DELIVERY_UNAVAILABLE');
  for (const engine of [h.runs, h.make()]) {
    assert.throws(() => engine.cancel(run.id), { code: 'writer_execution_uncertain' });
    engine.tick();
    assert.deepEqual(engine.holderFor(h.ws), { holder: 'unified_run', id: run.id });
    assert.equal(engine.status(run.id).recovery.cancel, 'refused');
  }
  assert.equal(h.tasks.get(run.segments[0].taskId).status, 'queued');
  assert.equal(h.manifest(run.id).segments.length, 1);
});

test('a submit that throws with no queue record keeps the intent open: no close, no second segment, cancel refused until the queue proves non-start', (t) => {
  const h = harness(t);
  h.submitFault = () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); };
  const run = h.runs.create(h.request(h.ws, true));
  assert.equal(run.state, 'needs_attention'); assert.equal(run.stopReason, 'EIO');
  assert.equal(run.segments[0].state, 'intent');
  const file = path.join(h.base, 'data', 'unified-runs', run.id, 'manifest.json');
  const stored = fs.readFileSync(file, 'utf8');
  // A record from earlier builds that called this not_submitted is read the same way.
  const legacy = h.manifest(run.id); legacy.segments[0].state = 'not_submitted';
  for (const record of [stored, JSON.stringify(legacy)]) {
    fs.writeFileSync(file, record);
    const engine = h.make();
    assert.throws(() => engine.cancel(run.id), { code: 'writer_execution_uncertain' });
    engine.tick(); engine.resume(run.id); engine.tick();
    assert.deepEqual(engine.holderFor(h.ws), { holder: 'unified_run', id: run.id });
    assert.equal(h.manifest(run.id).segments.length, 1);
    assert.equal(engine.status(run.id).recovery.cancelRefusal, 'writer_execution_uncertain');
  }
  // Repeated failures do not rewrite the record.
  fs.writeFileSync(file, stored);
  h.runs = h.make(); h.runs.tick();
  const settledBytes = fs.readFileSync(file, 'utf8');
  h.runs.tick(); h.runs.tick();
  assert.equal(fs.readFileSync(file, 'utf8'), settledBytes);
  assert.equal(h.submits.length, 0);
  // The same intent is submitted idempotently once the queue accepts it, and
  // only then can a cancel prove the task never started.
  h.submitFault = null;
  h.runs.tick();
  assert.equal(h.submits.length, 1);
  assert.equal(h.runs.status(run.id).segments[0].state, 'dispatched');
  assert.equal(h.runs.cancel(run.id).state, 'cancelled');
  assert.equal(h.tasks.get(run.segments[0].taskId).status, 'cancelled');
  assert.equal(h.runs.holderFor(h.ws), null);
  // A safely cancelled run submits nothing after a restart.
  h.runs = h.make();
  h.runs.tick(); h.runs.tick();
  assert.equal(h.runs.resume(run.id).state, 'cancelled');
  assert.equal(h.submits.length, 1); assert.equal(h.manifest(run.id).segments.length, 1);
});

test('a create whose record cannot be written leaves no run directory and no submit', (t) => {
  const h = harness(t);
  // The root barrier fails before any manifest exists.
  h.failSync = (dir) => /[\\/]unified-runs$/.test(dir);
  assert.throws(() => h.runs.create(h.request(h.ws, true)), (error) => error.code === 'unified_run_write_failed' && error.publication === 'unchanged' && !error.runId);
  assert.deepEqual(h.runDirs(), []);
  h.failSync = null;
  // The manifest write itself fails before its rename.
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); });
  assert.throws(() => h.runs.create(h.request(h.ws, true)), (error) => error.code === 'unified_run_write_failed' && !error.runId);
  t.mock.restoreAll();
  assert.deepEqual(h.runDirs(), []);
  assert.equal(h.submits.length, 0);
  assert.equal(h.runs.holderFor(h.ws), null);
});

test('an unsupported durability platform refuses every unified mutation before any effect', (t) => {
  const linux = harness(t);
  const existing = linux.runs.create(linux.request(linux.other, true));
  const h = harness(t, { platform: 'win32' });
  assert.equal(h.runs.durable, false);
  assert.throws(() => h.runs.create(h.request(h.ws, true)), { code: 'unified_run_platform_unsupported' });
  assert.throws(() => h.runs.create(h.request(h.ws, false)), { code: 'unified_run_platform_unsupported' });
  assert.deepEqual(h.runDirs(), []); assert.equal(h.submits.length, 0); assert.deepEqual(h.syncCalls, []);
  // A record written by a durable platform is readable but never advanced here.
  fs.mkdirSync(path.join(h.base, 'data', 'unified-runs'), { recursive: true });
  fs.cpSync(path.join(linux.base, 'data', 'unified-runs', existing.id), path.join(h.base, 'data', 'unified-runs', existing.id), { recursive: true });
  const before = fs.readFileSync(path.join(h.base, 'data', 'unified-runs', existing.id, 'manifest.json'), 'utf8');
  for (const action of ['resume', 'cancel']) assert.throws(() => h.runs[action](existing.id), { code: 'unified_run_platform_unsupported' });
  assert.throws(() => h.runs.link(existing.id, {}), { code: 'unified_run_platform_unsupported' });
  h.runs.tick();
  const view = h.runs.status(existing.id);
  assert.equal(view.durability.directoryBarrier, 'unsupported');
  assert.equal(view.recovery.cancel, 'refused'); assert.equal(view.recovery.cancelRefusal, 'unified_run_platform_unsupported');
  assert.equal(fs.readFileSync(path.join(h.base, 'data', 'unified-runs', existing.id, 'manifest.json'), 'utf8'), before);
  assert.equal(h.submits.length, 0);
});
