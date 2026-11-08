'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createCheckpointStore, procStartTime, processState, readProcessIdentity, turnName, toolName, parseRecordName } = require('../lib/api-agent-checkpoint');
const { isolatedEnv } = require('./helpers/isolated-env');

const POSIX = process.platform !== 'win32';
const LINUX = process.platform === 'linux';

function tmpData(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-ckpt-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return path.join(base, 'data');
}

function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { env: isolatedEnv(), encoding: 'utf8' });
  return Number(child.stdout);
}

function forgeLease(dir, patch) {
  const file = path.join(dir, 'lease.json');
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, JSON.stringify({ pid: 1, procStartTime: '1', hostname: os.hostname(), ...readProcessIdentity(),
    nonce: 'a'.repeat(32), at: 'x', ...patch }), { mode: 0o600 });
}
const reclaimMarkers = (dir) => fs.readdirSync(dir).filter((name) => name.startsWith('reclaim-'));

test('store and records are private and atomically written', (t) => {
  const dataDir = tmpData(t);
  const store = createCheckpointStore({ dataDir });
  const runId = store.newRunId();
  const h = store.create(runId, { binding: { provider: 'claude' }, initial: { state: { messages: [] } } });
  h.writeTurn({ index: 1, state: 'intent' });
  h.writeTool({ turn: 1, index: 0, state: 'done' });
  if (POSIX) {
    assert.equal(fs.statSync(store.root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(h.dir).mode & 0o777, 0o700);
    for (const name of fs.readdirSync(h.dir)) assert.equal(fs.statSync(path.join(h.dir, name)).mode & 0o777, 0o600, name);
  }
  const loaded = store.load(runId);
  assert.equal(loaded.manifest.status, 'active'); assert.equal(loaded.manifest.version, 1);
  assert.equal(loaded.turns.length, 1); assert.equal(loaded.tools.get('1:0').state, 'done');
  assert.throws(() => store.create(runId, {}), { code: 'checkpoint_run_exists' });
  for (const bad of ['../x', 'aar_x', 'aar_abcdefgh_zz', '']) assert.throws(() => store.load(bad), { code: 'checkpoint_run_invalid' });
  h.release();
});

test('torn temporary files are ignored and non-contiguous turns are refused', (t) => {
  const store = createCheckpointStore({ dataDir: tmpData(t) });
  const runId = store.newRunId();
  const h = store.create(runId, { initial: { state: {} } });
  h.writeTurn({ index: 1, state: 'received' });
  fs.writeFileSync(path.join(h.dir, 'turn-000002.json.0000.tmp'), '{"index":2,', { mode: 0o600 });
  assert.equal(store.load(runId).turns.length, 1);
  fs.writeFileSync(path.join(h.dir, 'turn-000003.json'), JSON.stringify({ index: 3 }), { mode: 0o600 });
  assert.throws(() => store.load(runId), { code: 'checkpoint_store_invalid' });
  fs.writeFileSync(path.join(h.dir, 'turn-000003.json'), '{bad', { mode: 0o600 });
  assert.throws(() => store.load(runId), { code: 'checkpoint_store_invalid' });
  h.release();
});

test('record names widen past their pad width and only canonical safe-integer names are accepted', (t) => {
  for (const n of [1, 999, 1000, 999999, 1000000, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(parseRecordName(turnName(n)), { kind: 'turn', turn: n }, String(n));
  }
  assert.equal(turnName(999999), 'turn-999999.json'); assert.equal(turnName(1000000), 'turn-1000000.json');
  for (const i of [0, 999, 1000, 123456]) assert.deepEqual(parseRecordName(toolName(7, i)), { kind: 'tool', turn: 7, index: i }, String(i));
  assert.equal(toolName(1, 999), 'tool-000001-999.json'); assert.equal(toolName(1, 1000), 'tool-000001-1000.json');
  for (const bad of ['turn-0000001.json', 'turn-000000.json', 'turn-9007199254740993.json', 'turn-1.json', 'tool-000001-0001.json',
    'tool-0000001-000.json', 'tool-000000-000.json', 'tool-000001-9007199254740993.json', 'turn-000001.json.bak', 'turn-00000a.json']) {
    assert.equal(parseRecordName(bad), null, bad);
  }
  for (const bad of [0, -1, 1.5, 9007199254740993, NaN, '1']) assert.throws(() => turnName(bad), { code: 'checkpoint_store_invalid' }, String(bad));
  for (const [turn, index] of [[0, 0], [1, -1], [1, 0.5], [1, 9007199254740993]]) assert.throws(() => toolName(turn, index), { code: 'checkpoint_store_invalid' });

  const store = createCheckpointStore({ dataDir: tmpData(t) });
  const runId = store.newRunId();
  const h = store.create(runId, { initial: { state: {} } });
  h.writeTurn({ index: 1, state: 'received' });
  for (const index of [998, 999, 1000, 1001]) h.writeTool({ turn: 1, index, state: 'done' });
  const loaded = store.load(runId);
  for (const index of [999, 1000, 1001]) assert.equal(loaded.tools.get(`1:${index}`).index, index);
  assert.throws(() => h.writeTurn({ index: 0, state: 'intent' }), { code: 'checkpoint_store_invalid' });
  assert.throws(() => h.writeTool({ turn: 1, index: 9007199254740993, state: 'intent' }), { code: 'checkpoint_store_invalid' });
  // A wide canonical name is read, not skipped: the gap is what refuses it.
  h.writeTurn({ index: 1000000, state: 'received' });
  assert.throws(() => store.load(runId), (error) => error.code === 'checkpoint_store_invalid' && /contiguous/.test(error.message));
  fs.rmSync(path.join(h.dir, 'turn-1000000.json'));
  for (const alias of ['turn-0000001.json', 'turn-9007199254740993.json', 'tool-000001-0000.json']) {
    fs.writeFileSync(path.join(h.dir, alias), JSON.stringify({ index: 1, turn: 1 }), { mode: 0o600 });
    assert.throws(() => store.load(runId), (error) => error.code === 'checkpoint_store_invalid' && /canonical/.test(error.message), alias);
    fs.rmSync(path.join(h.dir, alias));
  }
  assert.equal(store.load(runId).turns.length, 1);
  h.release();
});

test('symlinked, shared or loose stores and records are refused', { skip: !POSIX && 'POSIX modes' }, (t) => {
  const dataDir = tmpData(t);
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const elsewhere = path.join(path.dirname(dataDir), 'elsewhere'); fs.mkdirSync(elsewhere, { mode: 0o700 });
  fs.symlinkSync(elsewhere, path.join(dataDir, 'api-agent'));
  const store = createCheckpointStore({ dataDir });
  assert.throws(() => store.create(store.newRunId(), {}), { code: 'checkpoint_store_invalid' });
  assert.throws(() => store.fingerprint('k'.repeat(20)), { code: 'checkpoint_store_invalid' });
  fs.unlinkSync(path.join(dataDir, 'api-agent'));
  fs.mkdirSync(path.join(dataDir, 'api-agent'), { mode: 0o755 }); fs.chmodSync(path.join(dataDir, 'api-agent'), 0o755);
  assert.throws(() => store.create(store.newRunId(), {}), { code: 'checkpoint_store_invalid' });
  fs.chmodSync(path.join(dataDir, 'api-agent'), 0o700);
  const runId = store.newRunId();
  const h = store.create(runId, { initial: { state: {} } });
  fs.chmodSync(path.join(h.dir, 'manifest.json'), 0o644);
  assert.throws(() => store.load(runId), { code: 'checkpoint_store_invalid' });
  fs.chmodSync(path.join(h.dir, 'manifest.json'), 0o600);
  fs.linkSync(path.join(h.dir, 'manifest.json'), path.join(dataDir, 'hard'));
  assert.throws(() => store.load(runId), { code: 'checkpoint_store_invalid' });
  fs.unlinkSync(path.join(dataDir, 'hard'));
  fs.renameSync(path.join(h.dir, 'manifest.json'), path.join(dataDir, 'm.json'));
  fs.symlinkSync(path.join(dataDir, 'm.json'), path.join(h.dir, 'manifest.json'));
  assert.throws(() => store.load(runId), { code: 'checkpoint_store_invalid' });
});

test('fingerprint is a salted HMAC stable per DATA_DIR and never the key', (t) => {
  const a = createCheckpointStore({ dataDir: tmpData(t) });
  const b = createCheckpointStore({ dataDir: tmpData(t) });
  const key = 'sk-test-0123456789abcdef';
  const fa = a.fingerprint(key);
  assert.match(fa, /^hmac-sha256:[a-f0-9]{64}$/);
  assert.equal(a.fingerprint(key), fa);
  assert.notEqual(b.fingerprint(key), fa);
  assert.notEqual(a.fingerprint(key + 'x'), fa);
  assert.ok(!fa.includes(key));
  assert.throws(() => a.fingerprint(''), { code: 'api_credential_unbound' });
});

test('a live or unverifiable owner is never displaced; writes require the held lease', (t) => {
  const store = createCheckpointStore({ dataDir: tmpData(t) });
  const runId = store.newRunId();
  const h = store.create(runId, { initial: { state: {} } });
  assert.throws(() => store.acquire(runId), { code: 'owner_live_or_unknown' });
  h.release();
  assert.throws(() => h.writeTurn({ index: 1 }), { code: 'checkpoint_lease_released' });
  const h2 = store.acquire(runId);
  forgeLease(h2.dir, { hostname: 'other-host' });
  assert.throws(() => store.acquire(runId), { code: 'owner_live_or_unknown' });
  assert.throws(() => h2.writeTurn({ index: 1 }), { code: 'checkpoint_lease_lost' });
  forgeLease(h2.dir, { nonce: 'not-hex' });
  assert.throws(() => store.acquire(runId), { code: 'owner_live_or_unknown' });
  if (LINUX) {
    // This process is alive with a matching start time, so a peer must not displace it.
    forgeLease(h2.dir, { pid: process.pid, procStartTime: procStartTime(process.pid) });
    const peer = createCheckpointStore({ dataDir: path.dirname(store.root), pid: 999999999 });
    assert.throws(() => peer.acquire(runId), { code: 'owner_live_or_unknown' });
  }
});

test('a proven-dead owner is reclaimed and reconcile leaves live owners alone', { skip: !LINUX && 'needs /proc identity' }, (t) => {
  const store = createCheckpointStore({ dataDir: tmpData(t) });
  const dead = store.newRunId(), live = store.newRunId(), idle = store.newRunId();
  const hd = store.create(dead, { initial: { state: {} } });
  hd.writeTurn({ index: 1, state: 'intent' });
  forgeLease(hd.dir, { pid: deadPid(), procStartTime: '12345' });
  assert.equal(processState(deadPid(), '1'), 'dead');
  const hl = store.create(live, { initial: { state: {} } });
  hl.writeTurn({ index: 1, state: 'intent' });
  const hi = store.create(idle, { initial: { state: {} } });
  hi.writeTurn({ index: 1, state: 'received' });
  forgeLease(hi.dir, { pid: deadPid(), procStartTime: '1' });
  const results = Object.fromEntries(store.reconcile().map((r) => [r.runId, r.action]));
  assert.equal(results[dead], 'outcome_uncertain');
  assert.equal(results[live], 'owner_live_or_unknown');
  assert.equal(results[idle], 'interrupted');
  const d = store.load(dead);
  assert.equal(d.manifest.status, 'terminal'); assert.equal(d.manifest.outcome.class, 'outcome_uncertain');
  assert.equal(d.turns[0].state, 'uncertain');
  assert.equal(store.load(live).turns[0].state, 'intent');
  assert.equal(store.load(live).manifest.status, 'active');
  assert.equal(store.load(idle).manifest.status, 'resumable');
  hl.release();
});

test('leases record boot and PID namespace; a dead pid elsewhere or a legacy lease is unknown, never reclaimed', { skip: !LINUX && 'needs /proc identity' }, (t) => {
  const store = createCheckpointStore({ dataDir: tmpData(t) });
  const runId = store.newRunId();
  const h = store.create(runId, { initial: { state: {} } });
  h.writeTurn({ index: 1, state: 'intent' });
  const lease = JSON.parse(fs.readFileSync(path.join(h.dir, 'lease.json'), 'utf8'));
  assert.match(lease.bootId, /^[0-9a-f-]{36}$/); assert.match(lease.pidNamespace, /^pid:\[\d+\]$/);
  assert.deepEqual({ bootId: lease.bootId, pidNamespace: lease.pidNamespace }, readProcessIdentity());
  const manifestFile = path.join(h.dir, 'manifest.json');
  const manifestBytes = fs.readFileSync(manifestFile);
  const pid = deadPid();
  const unknown = [
    ['foreign namespace', { pid, procStartTime: '12345', pidNamespace: 'pid:[1]' }],
    ['other boot', { pid, procStartTime: '12345', bootId: '00000000-0000-0000-0000-000000000000' }],
    ['legacy lease', { pid, procStartTime: '12345', bootId: undefined, pidNamespace: undefined }],
    ['null identity', { pid, procStartTime: '12345', bootId: null, pidNamespace: null }],
  ];
  for (const [name, patch] of unknown) {
    forgeLease(h.dir, patch);
    const leaseBytes = fs.readFileSync(path.join(h.dir, 'lease.json'));
    assert.throws(() => store.acquire(runId), { code: 'owner_live_or_unknown' }, name);
    const row = store.reconcile().find((r) => r.runId === runId);
    assert.equal(row.action, 'owner_live_or_unknown', name);
    assert.deepEqual(fs.readFileSync(manifestFile), manifestBytes, name);
    assert.deepEqual(fs.readFileSync(path.join(h.dir, 'lease.json')), leaseBytes, name);
    assert.deepEqual(reclaimMarkers(h.dir), [], name);
  }
  // A process whose own identity cannot be read proves nothing about others.
  forgeLease(h.dir, { pid, procStartTime: '12345' });
  for (const processIdentity of [() => ({ bootId: null, pidNamespace: null }), { bootId: readProcessIdentity().bootId }]) {
    const blind = createCheckpointStore({ dataDir: path.dirname(store.root), processIdentity });
    assert.throws(() => blind.acquire(runId), { code: 'owner_live_or_unknown' });
    assert.equal(blind.reconcile().find((r) => r.runId === runId).action, 'owner_live_or_unknown');
  }
  assert.deepEqual(fs.readFileSync(manifestFile), manifestBytes);
  // Same host, boot and namespace with a dead pid is proven dead and reclaimed once.
  const h2 = store.acquire(runId);
  assert.deepEqual(reclaimMarkers(h2.dir), []);
  h2.release();
});

test('reclaim re-reads the lease under its marker and always removes the marker', { skip: !LINUX && 'needs /proc identity' }, (t) => {
  const dataDir = tmpData(t);
  let swap = null;
  const store = createCheckpointStore({ dataDir, hooks: { afterReclaimMarker(dir) { if (swap) swap(dir); } } });
  const runId = store.newRunId();
  const h = store.create(runId, { initial: { state: {} } });
  forgeLease(h.dir, { pid: deadPid(), procStartTime: '12345' });
  // A peer replaces the dead lease after this reclaimer created its marker.
  swap = (dir) => { forgeLease(dir, { pid: process.pid, procStartTime: procStartTime(process.pid), nonce: 'b'.repeat(32) }); swap = null; };
  assert.throws(() => store.acquire(runId), { code: 'owner_live_or_unknown' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'lease.json'), 'utf8')).nonce, 'b'.repeat(32), 'the peer lease survives');
  assert.deepEqual(reclaimMarkers(h.dir), []);
  // A hook failure under the marker still removes it.
  forgeLease(h.dir, { pid: deadPid(), procStartTime: '12345' });
  swap = () => { throw new Error('injected'); };
  assert.throws(() => store.acquire(runId), /injected/);
  assert.deepEqual(reclaimMarkers(h.dir), []);
  swap = null;
  const owned = store.acquire(runId);
  assert.deepEqual(reclaimMarkers(owned.dir), []);
  owned.release();
});

test('concurrent acquisition across processes admits exactly one owner', { skip: !LINUX && 'needs /proc identity' }, async (t) => {
  const dataDir = tmpData(t);
  const store = createCheckpointStore({ dataDir });
  const runId = store.newRunId();
  store.create(runId, { initial: { state: {} } }).release();
  const script = `const { createCheckpointStore } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'api-agent-checkpoint.js'))});
    const s = createCheckpointStore({ dataDir: process.argv[1] });
    try { s.acquire(process.argv[2]); process.stdout.write('won'); setTimeout(() => {}, 1500); }
    catch (e) { process.stdout.write(e.code); }`;
  const children = Array.from({ length: 6 }, () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script, dataDir, runId], { env: isolatedEnv(), stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; if (out) { resolve(out); } });
    child.on('exit', () => resolve(out));
  }));
  const outcomes = await Promise.all(children);
  assert.equal(outcomes.filter((o) => o === 'won').length, 1, outcomes.join(','));
  assert.deepEqual(reclaimMarkers(path.join(store.root, runId)), []);
  assert.ok(outcomes.filter((o) => o !== 'won').every((o) => o === 'owner_live_or_unknown'), outcomes.join(','));
});

// ---- writer-run stopped evidence and attempt sets ---------------------------
const { executionBindingHash } = require('../lib/api-agent-checkpoint');

function writerRun(t, hooks = {}) {
  const dataDir = tmpData(t);
  const store = createCheckpointStore({ dataDir, hooks });
  const runId = store.newRunId();
  const h = store.create(runId, { binding: {}, execution: { unifiedRunId: 'ur_fixture', segment: 1 }, initial: { state: {} } });
  const dir = path.join(store.root, runId);
  const bindingHash = executionBindingHash(store.load(runId).manifest);
  const json = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  const put = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value), { mode: 0o600 });
  return { store, runId, h, dir, bindingHash, json, put, stopped: () => store.effectsOwnerStopped(runId, bindingHash) };
}

// Replaces fs[method] for one test; `fault(...args)` may throw before the call.
function intercept(t, method, fault) {
  const original = fs[method];
  fs[method] = (...args) => { fault(...args); return original.apply(fs, args); };
  t.after(() => { fs[method] = original; });
}
const fdPath = (fd) => { try { return fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { return ''; } };

test('reused stopped evidence repeats its file and directory barriers; a failed barrier keeps the lease', { skip: !LINUX && 'needs /proc identity' }, (t) => {
  const hooks = {};
  const env = writerRun(t, hooks);
  const name = `stopped-${env.h.attemptNonce}.json`;
  // The first attempt writes the evidence but its directory barrier fails.
  hooks.afterStoppedEvidence = () => { throw Object.assign(new Error('injected'), { code: 'EIO' }); };
  assert.equal(env.h.release({ stopped: true }), false);
  hooks.afterStoppedEvidence = null;
  assert.ok(fs.existsSync(path.join(env.dir, name)), 'evidence exists but is not proven durable');
  assert.ok(fs.existsSync(path.join(env.dir, 'lease.json')), 'lease kept');
  assert.equal(env.stopped(), false);
  // Reuse must fsync the record itself and the directory; each failure keeps the lease.
  const synced = [];
  let failOn = path.join(env.dir, name);
  intercept(t, 'fsyncSync', (fd) => {
    const target = fdPath(fd);
    synced.push(target);
    if (target === failOn) throw Object.assign(new Error('injected'), { code: 'EIO' });
  });
  assert.equal(env.h.release({ stopped: true }), false, 'file barrier failure');
  assert.ok(fs.existsSync(path.join(env.dir, 'lease.json')));
  failOn = env.dir;
  assert.equal(env.h.release({ stopped: true }), false, 'directory barrier failure');
  assert.ok(fs.existsSync(path.join(env.dir, 'lease.json')));
  assert.equal(createCheckpointStore({ dataDir: path.dirname(env.store.root) }).effectsOwnerStopped(env.runId, env.bindingHash), false,
    'a reopened store still sees the attempt unproven');
  failOn = null; synced.length = 0;
  assert.equal(env.h.release({ stopped: true }), true);
  assert.ok(synced.includes(path.join(env.dir, name)) && synced.includes(env.dir), synced.join());
  assert.equal(env.stopped(), true);
});

test('stopped evidence has an exact schema with full owner identity and must name its own attempt', { skip: !LINUX && 'needs /proc identity' }, (t) => {
  const env = writerRun(t);
  const nonce = env.h.attemptNonce, name = `stopped-${nonce}.json`;
  // Same-nonce evidence planted for another owner is never reused.
  const attempt = env.json(`attempt-${nonce}.json`);
  const forged = { v: 1, checkpointRunId: env.runId, executionBindingHash: env.bindingHash, nonce,
    owner: { ...attempt.owner, pid: attempt.owner.pid + 1 }, purpose: 'execution', proof: 'lifecycle_settled',
    observedAt: new Date().toISOString(), observer: attempt.owner };
  env.put(name, forged);
  assert.equal(env.h.release({ stopped: true }), false);
  assert.ok(fs.existsSync(path.join(env.dir, 'lease.json')), 'lease kept');
  fs.unlinkSync(path.join(env.dir, name));
  assert.equal(env.h.release({ stopped: true }), true);
  assert.equal(env.stopped(), true);
  const good = env.json(name);
  assert.deepEqual(good.owner, attempt.owner);
  for (const [label, bad] of [
    ['extra key', { ...good, note: 'x' }],
    ['missing observer', (({ observer, ...rest }) => rest)(good)],
    ['partial owner', { ...good, owner: { pid: good.owner.pid } }],
    ['null boot id', { ...good, owner: { ...good.owner, bootId: null } }],
    ['null start time', { ...good, owner: { ...good.owner, procStartTime: null } }],
    ['other pid', { ...good, owner: { ...good.owner, pid: good.owner.pid + 1 } }],
    ['other purpose', { ...good, purpose: 'recovery' }],
    ['unbounded time', { ...good, observedAt: 'x'.repeat(4096) }],
    ['bad namespace', { ...good, observer: { ...good.observer, pidNamespace: 'net:[1]' } }],
    ['unknown proof', { ...good, proof: 'assumed' }],
  ]) {
    env.put(name, bad);
    assert.equal(env.stopped(), false, label);
  }
  env.put(name, good);
  assert.equal(env.stopped(), true);
});

test('attempt sets are validated strictly and an empty set never passes on absence alone', { skip: !LINUX && 'needs /proc identity' }, (t) => {
  const env = writerRun(t);
  const nonce = env.h.attemptNonce, attemptName = `attempt-${nonce}.json`;
  assert.equal(env.h.release({ stopped: true }), true);
  assert.deepEqual(env.store.stoppedAttempts(env.runId, env.bindingHash), [nonce]);
  const attempt = env.json(attemptName);
  const recoveryRefused = (code) => assert.throws(() => env.store.acquireEffectsRecovery(env.runId, { executionBindingHash: env.bindingHash }), { code });
  // Non-canonical attempt names are never skipped.
  for (const odd of ['attempt-ABC.json', `attempt-${nonce}.json.bak`, 'attempt-.json']) {
    env.put(odd, attempt);
    assert.equal(env.stopped(), false, odd);
    recoveryRefused('checkpoint_store_invalid');
    fs.unlinkSync(path.join(env.dir, odd));
  }
  for (const [label, bad] of [
    ['extra key', { ...attempt, note: 'x' }],
    ['other nonce', { ...attempt, nonce: 'f'.repeat(32) }],
    ['other run', { ...attempt, checkpointRunId: 'aar_x_' + 'e'.repeat(16) }],
    ['other binding', { ...attempt, executionBindingHash: 'f'.repeat(64) }],
    ['missing owner', (({ owner, ...rest }) => rest)(attempt)],
    ['reconcile purpose', { ...attempt, purpose: 'reconcile' }],
    // Evidence for the nonce exists but names another owner than the attempt.
    ['owner mismatch', { ...attempt, owner: { ...attempt.owner, pid: attempt.owner.pid + 1 } }],
  ]) {
    env.put(attemptName, bad);
    assert.equal(env.stopped(), false, label);
  }
  env.put(attemptName, attempt);
  assert.equal(env.stopped(), true);
  // A missing attempt record with no dispatch record is still not proof: the
  // only stopped evidence is lifecycle_settled, not not_dispatched.
  const parked = path.join(path.dirname(env.dir), 'parked.json');
  fs.renameSync(path.join(env.dir, attemptName), parked);
  assert.equal(env.store.stoppedAttempts(env.runId, env.bindingHash), null);
  recoveryRefused('owner_not_proven_stopped');
  // Once anything was dispatched, an empty set proves nothing either.
  env.put('turn-000001.json', { index: 1, state: 'intent' });
  assert.equal(env.store.stoppedAttempts(env.runId, env.bindingHash), null);
  recoveryRefused('owner_not_proven_stopped');
  fs.renameSync(parked, path.join(env.dir, attemptName));
  assert.equal(env.stopped(), true);
});

test('a failed attempt write keeps recovery authority: settled evidence first, else the lease stays', { skip: !LINUX && 'needs /proc identity' }, (t) => {
  const hooks = {};
  const env = writerRun(t, hooks);
  assert.equal(env.h.release({ stopped: true }), true);
  // The attempt record lands but its directory barrier fails.
  let armed = false;
  intercept(t, 'renameSync', (from, to) => { if (/attempt-[a-f0-9]{32}\.json$/.test(String(to))) armed = true; });
  intercept(t, 'fsyncSync', () => { if (armed) { armed = false; throw Object.assign(new Error('injected'), { code: 'EIO' }); } });
  const attemptsBefore = fs.readdirSync(env.dir).filter((n) => /^attempt-[a-f0-9]{32}\.json$/.test(n));
  assert.throws(() => env.store.acquire(env.runId), { code: 'EIO' });
  const landed = fs.readdirSync(env.dir).filter((n) => /^attempt-[a-f0-9]{32}\.json$/.test(n) && !attemptsBefore.includes(n));
  assert.equal(landed.length, 1, 'the half-persisted attempt record exists');
  const nonce = landed[0].slice('attempt-'.length, -'.json'.length);
  assert.equal(env.json(`stopped-${nonce}.json`).proof, 'lifecycle_settled');
  assert.ok(!fs.existsSync(path.join(env.dir, 'lease.json')), 'lease released only after durable evidence');
  assert.equal(env.stopped(), true);
  // Same failure in recovery, now with the evidence write failing too: the lease is kept.
  hooks.afterStoppedEvidence = () => { throw Object.assign(new Error('injected'), { code: 'EIO' }); };
  assert.throws(() => env.store.acquireEffectsRecovery(env.runId, { executionBindingHash: env.bindingHash }), { code: 'EIO' });
  const lease = env.json('lease.json');
  assert.equal(lease.purpose, 'recovery', 'the recovery lease is kept');
  assert.ok(fs.existsSync(path.join(env.dir, `attempt-${lease.nonce}.json`)));
  assert.equal(env.stopped(), false);
  assert.throws(() => env.store.acquire(env.runId), { code: 'owner_live_or_unknown' });
});

// ---- positive never-dispatched proof (N3) -----------------------------------
const EIO = () => Object.assign(new Error('injected'), { code: 'EIO' });

// A writer run whose create fails on its attempt rename: the lease never
// reached a handle, so nothing could have been dispatched.
function failedCreate(t, { evidenceFails = false } = {}) {
  const hooks = {};
  const dataDir = tmpData(t);
  const store = createCheckpointStore({ dataDir, hooks });
  const runId = store.newRunId();
  let armed = true;
  intercept(t, 'renameSync', (from, to) => {
    if (armed && /attempt-[a-f0-9]{32}\.json$/.test(String(to))) { armed = false; throw EIO(); }
  });
  if (evidenceFails) hooks.afterStoppedEvidence = () => { throw EIO(); };
  assert.throws(() => store.create(runId, { binding: {}, execution: { unifiedRunId: 'ur_fixture', segment: 1 }, initial: { state: {} } }),
    { code: 'EIO' });
  hooks.afterStoppedEvidence = null;
  const dir = path.join(store.root, runId);
  const bindingHash = executionBindingHash(store.load(runId).manifest);
  const json = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  const put = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value), { mode: 0o600 });
  const stoppedNames = () => fs.readdirSync(dir).filter((n) => /^stopped-[a-f0-9]{32}\.json$/.test(n));
  const owners = () => store.stoppedAttempts(runId, bindingHash);
  const recover = () => store.acquireEffectsRecovery(runId, { executionBindingHash: bindingHash });
  return { store, runId, dir, bindingHash, json, put, stoppedNames, owners, recover };
}

test('a create that fails before its attempt exists leaves self-attested not_dispatched proof and stays recoverable', { skip: !LINUX && 'needs /proc identity' }, (t) => {
  const env = failedCreate(t);
  assert.ok(!fs.existsSync(path.join(env.dir, 'lease.json')), 'lease released after durable evidence');
  assert.deepEqual(fs.readdirSync(env.dir).filter((n) => /^attempt-[a-f0-9]{32}\.json$/.test(n)), []);
  const [name] = env.stoppedNames();
  const evidence = env.json(name);
  assert.equal(evidence.proof, 'not_dispatched'); assert.equal(evidence.purpose, 'execution');
  assert.deepEqual(evidence.owner, evidence.observer);
  assert.equal(env.store.load(env.runId).manifest.status, 'active');
  assert.deepEqual(env.owners(), []);
  // Startup reconcile turns the pristine manifest into resumable "interrupted"; the proof still holds.
  assert.equal(env.store.reconcile().find((r) => r.runId === env.runId).action, 'interrupted');
  const manifest = env.store.load(env.runId).manifest;
  assert.equal(manifest.status, 'resumable'); assert.deepEqual(Object.keys(manifest.outcome).sort(), ['at', 'class']);
  assert.deepEqual(env.owners(), []);
  // Effects recovery is admitted, records its own attempt, and leaves the original evidence in place.
  const h = env.recover();
  assert.deepEqual(h.stoppedNonces, []); assert.equal(h.purpose, 'recovery');
  assert.ok(fs.existsSync(path.join(env.dir, `attempt-${h.attemptNonce}.json`)));
  assert.equal(h.release({ stopped: true }), true);
  assert.deepEqual(env.owners(), [h.attemptNonce]);
  assert.deepEqual(env.json(name), evidence);
});

test('a create whose not_dispatched evidence cannot be made durable keeps its lease and proves nothing', { skip: !LINUX && 'needs /proc identity' }, (t) => {
  const env = failedCreate(t, { evidenceFails: true });
  assert.ok(fs.existsSync(path.join(env.dir, 'lease.json')), 'lease kept');
  assert.equal(env.owners(), null);
  assert.throws(() => env.store.acquire(env.runId), { code: 'owner_live_or_unknown' });
  assert.throws(() => env.recover(), { code: 'owner_live_or_unknown' });
});

test('a manifest that contradicts never-dispatched is refused even with not_dispatched proof', { skip: !LINUX && 'needs /proc identity' }, (t) => {
  const env = failedCreate(t);
  const base = env.json('manifest.json');
  const at = new Date().toISOString();
  for (const [label, patch] of [
    ['terminal completed', { status: 'terminal', outcome: { class: 'completed', at } }],
    ['completed status', { status: 'completed', outcome: { class: 'completed', at } }],
    ['effects reconciled', { status: 'terminal', outcome: { class: 'effects_reconciled', at } }],
    ['patch uncertain', { status: 'terminal', outcome: { class: 'patch_outcome_uncertain', effectsPending: [], at } }],
    ['outcome uncertain', { status: 'terminal', outcome: { class: 'outcome_uncertain', uncertainTurn: 1, at } }],
    ['provider class', { status: 'resumable', outcome: { class: 'rate_limited', at } }],
    ['cancelled', { status: 'resumable', outcome: { class: 'cancelled', at } }],
    ['interrupted with extra', { status: 'resumable', outcome: { class: 'interrupted', at, uncertainTurn: 1 } }],
    ['interrupted unbounded time', { status: 'resumable', outcome: { class: 'interrupted', at: 'x'.repeat(4096) } }],
    ['active with outcome', { status: 'active', outcome: { class: 'interrupted', at } }],
    ['other run', { runId: 'aar_x_' + 'e'.repeat(16) }],
  ]) {
    env.put('manifest.json', { ...base, ...patch });
    assert.equal(env.owners(), null, label);
    assert.throws(() => env.recover(), { code: 'owner_not_proven_stopped' }, label);
  }
  // A different execution binding is stale, never settled.
  env.put('manifest.json', { ...base, execution: { unifiedRunId: 'ur_other', segment: 1 } });
  assert.equal(env.owners(), null);
  assert.throws(() => env.recover(), { code: 'checkpoint_binding_stale' });
  env.put('manifest.json', base);
  assert.deepEqual(env.owners(), []);
});

test('a bound terminal manifest with every execution record absent is never settled', { skip: !LINUX && 'needs /proc identity' }, (t) => {
  const env = writerRun(t);
  const at = new Date().toISOString();
  env.h.writeTurn({ index: 1, state: 'received' });
  env.h.writeManifest({ ...env.json('manifest.json'), status: 'terminal', outcome: { class: 'completed', at }, updatedAt: at });
  assert.equal(env.h.release({ stopped: true }), true);
  assert.equal(env.stopped(), true);
  for (const name of fs.readdirSync(env.dir)) if (/^(attempt|turn|tool|patch)-/.test(name)) fs.unlinkSync(path.join(env.dir, name));
  const recover = () => env.store.acquireEffectsRecovery(env.runId, { executionBindingHash: env.bindingHash });
  // Only lifecycle_settled evidence, then owner_dead evidence, then none: all refused.
  assert.equal(env.store.stoppedAttempts(env.runId, env.bindingHash), null);
  assert.throws(recover, { code: 'owner_not_proven_stopped' });
  for (const name of fs.readdirSync(env.dir)) if (name.startsWith('stopped-')) {
    const value = env.json(name);
    env.put(name, { ...value, proof: 'owner_dead' });
  }
  assert.equal(env.store.stoppedAttempts(env.runId, env.bindingHash), null);
  for (const name of fs.readdirSync(env.dir)) if (name.startsWith('stopped-')) fs.unlinkSync(path.join(env.dir, name));
  assert.equal(env.store.stoppedAttempts(env.runId, env.bindingHash), null);
  assert.throws(recover, { code: 'owner_not_proven_stopped' });
});

test('not_dispatched proof must be canonical, bound and self-attested, and every stopped record beside it valid', { skip: !LINUX && 'needs /proc identity' }, (t) => {
  const env = failedCreate(t);
  const [name] = env.stoppedNames();
  const good = env.json(name);
  const otherNonce = 'c'.repeat(32);
  for (const [label, bad] of [
    ['other binding', { ...good, executionBindingHash: 'f'.repeat(64) }],
    ['other run', { ...good, checkpointRunId: 'aar_x_' + 'e'.repeat(16) }],
    ['owner is not observer', { ...good, observer: { ...good.observer, pid: good.observer.pid + 1 } }],
    ['extra key', { ...good, note: 'x' }],
    ['unknown proof', { ...good, proof: 'assumed' }],
    ['owner_dead only', { ...good, proof: 'owner_dead' }],
    ['lifecycle_settled only', { ...good, proof: 'lifecycle_settled' }],
    ['recovery purpose', { ...good, purpose: 'recovery' }],
    ['partial owner', { ...good, owner: { pid: good.owner.pid } }],
  ]) {
    env.put(name, bad);
    assert.equal(env.owners(), null, label);
    assert.throws(() => env.recover(), { code: 'owner_not_proven_stopped' }, label);
    env.put(name, good);
    assert.deepEqual(env.owners(), [], label);
  }
  // A record filed under another nonce does not bind.
  fs.renameSync(path.join(env.dir, name), path.join(env.dir, `stopped-${otherNonce}.json`));
  assert.equal(env.owners(), null, 'nonce mismatch');
  fs.renameSync(path.join(env.dir, `stopped-${otherNonce}.json`), path.join(env.dir, name));
  // Valid proof next to a malformed or non-canonical stopped record fails closed.
  for (const [odd, value] of [
    [`stopped-${otherNonce}.json`, { ...good, nonce: otherNonce, proof: 'assumed' }],
    [`stopped-${otherNonce}.json`, '{torn'],
    ['stopped-ABC.json', good],
    [`stopped-${good.nonce}.json.bak`, good],
  ]) {
    if (typeof value === 'string') fs.writeFileSync(path.join(env.dir, odd), value, { mode: 0o600 }); else env.put(odd, value);
    assert.equal(env.owners(), null, odd);
    assert.throws(() => env.recover(), { code: 'owner_not_proven_stopped' }, odd);
    fs.unlinkSync(path.join(env.dir, odd));
  }
  // Any turn, tool, patch or attempt record, torn or not, contradicts the proof.
  for (const extra of ['turn-000001.json', 'tool-000001-000.json.1.tmp', 'patch-000001-000.json']) {
    fs.writeFileSync(path.join(env.dir, extra), '{}', { mode: 0o600 });
    assert.equal(env.owners(), null, extra);
    fs.unlinkSync(path.join(env.dir, extra));
  }
  // Deleting the proof leaves nothing.
  fs.unlinkSync(path.join(env.dir, name));
  assert.equal(env.owners(), null);
  assert.throws(() => env.recover(), { code: 'owner_not_proven_stopped' });
});

test('a crash between manifest and attempt reclaimed as owner_dead stays unproven', { skip: !LINUX && 'needs /proc identity' }, (t) => {
  const env = writerRun(t);
  fs.unlinkSync(path.join(env.dir, `attempt-${env.h.attemptNonce}.json`));
  forgeLease(env.dir, { pid: deadPid(), procStartTime: '12345', purpose: 'execution' });
  assert.equal(env.store.reconcile().find((r) => r.runId === env.runId).action, 'interrupted');
  assert.equal(env.json(`stopped-${'a'.repeat(32)}.json`).proof, 'owner_dead');
  assert.equal(env.store.stoppedAttempts(env.runId, env.bindingHash), null);
  assert.throws(() => env.store.acquireEffectsRecovery(env.runId, { executionBindingHash: env.bindingHash }), { code: 'owner_not_proven_stopped' });
});

test('valid stopped and committed recovery keeps every ownership record', { skip: !LINUX && 'needs /proc identity' }, (t) => {
  const env = writerRun(t);
  const first = env.h.attemptNonce;
  env.h.writeTurn({ index: 1, state: 'received' });
  assert.equal(env.h.release({ stopped: true }), true);
  assert.deepEqual(env.store.stoppedAttempts(env.runId, env.bindingHash), [first]);
  const h = env.store.acquireEffectsRecovery(env.runId, { executionBindingHash: env.bindingHash });
  assert.deepEqual(h.stoppedNonces, [first]);
  assert.equal(h.release({ stopped: true }), true);
  assert.deepEqual([...env.store.stoppedAttempts(env.runId, env.bindingHash)].sort(), [first, h.attemptNonce].sort());
  for (const nonce of [first, h.attemptNonce]) {
    assert.ok(fs.existsSync(path.join(env.dir, `attempt-${nonce}.json`)));
    assert.equal(env.json(`stopped-${nonce}.json`).proof, 'lifecycle_settled');
  }
});
