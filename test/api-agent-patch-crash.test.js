'use strict';
// A writer killed at each patch failpoint is recovered exactly once: the edit
// is either committed once or left uncertain with its evidence, and an
// artifact whose ownership was never recorded is never removed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { recoverPatchEffects, tempNameFor } = require('../lib/api-agent-patch');
const { createCheckpointStore, executionBindingHash, newRunId } = require('../lib/api-agent-checkpoint');
const { isolatedEnv } = require('./helpers/isolated-env');

const LINUX = { skip: process.platform !== 'linux' && 'the patch writer uses Linux directory descriptors' };
const FIXTURE = path.join(__dirname, 'fixtures', 'api-agent-patch-crash-child.js');

function crash(t, failpoint) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rb-patch-crash-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'ws'), dataDir = path.join(base, 'data');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'one\ntwo\n');
  const runId = newRunId();
  const child = spawnSync(process.execPath, [FIXTURE, dataDir, runId, cwd, failpoint], { env: isolatedEnv(), encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', `${failpoint}: ${child.stderr}`);
  const store = createCheckpointStore({ dataDir });
  const bindingHash = executionBindingHash(store.load(runId).manifest);
  const recover = () => recoverPatchEffects({ store, runId, executionBindingHash: bindingHash, cwd, allowedWritePaths: ['notes.txt'],
    assertHeld: () => {} });
  const entries = () => fs.readdirSync(cwd).sort();
  return { cwd, store, runId, recover, entries, read: () => fs.readFileSync(path.join(cwd, 'notes.txt'), 'utf8') };
}

for (const failpoint of ['patch-prepared', 'patch-temp-bound', 'patch-temp-written', 'patch-before-publish', 'patch-renamed', 'patch-published', 'patch-committed']) {
  test(`a writer killed at ${failpoint} is committed exactly once by recovery`, LINUX, (t) => {
    const env = crash(t, failpoint);
    const first = env.recover();
    assert.equal(first.settled, true, JSON.stringify(first.uncertain));
    assert.equal(first.outcome.class, 'effects_reconciled');
    assert.equal(env.read(), 'one\nthree\n');
    assert.deepEqual(env.entries(), ['notes.txt'], 'only the edited file remains');
    const loaded = env.store.load(env.runId);
    assert.equal(loaded.patches.get('1:0').state, 'committed');
    assert.equal(loaded.tools.get('1:0').state, 'done');
    assert.equal(JSON.parse(loaded.tools.get('1:0').result.output).applied, true);
    // A second recovery is a no-op: the edit is never applied twice.
    const second = env.recover();
    assert.equal(second.settled, true);
    assert.equal(env.read(), 'one\nthree\n');
  });
}

test('a writer killed after creating its temp but before binding it keeps the unproven temp and the file', LINUX, (t) => {
  const env = crash(t, 'patch-temp-created');
  const result = env.recover();
  assert.equal(result.settled, false);
  assert.deepEqual(result.uncertain, [{ key: '1:0', reason: 'unproven_temp' }]);
  assert.equal(env.read(), 'one\ntwo\n');
  const record = env.store.load(env.runId).patches.get('1:0');
  assert.equal(record.state, 'prepared');
  assert.ok(env.entries().includes(record.tempName), 'unproven artifact preserved');
  assert.equal(env.store.load(env.runId).manifest.outcome.class, 'patch_outcome_uncertain');
  // Retrying does not upgrade an unproven artifact into owned evidence.
  assert.equal(env.recover().settled, false);
  assert.ok(env.entries().includes(record.tempName));
});

test('a foreign file at the temp name is never removed and keeps the edit uncertain', LINUX, (t) => {
  const env = crash(t, 'patch-prepared');
  const record = env.store.load(env.runId).patches.get('1:0');
  assert.equal(record.tempName, tempNameFor(record.opId));
  fs.writeFileSync(path.join(env.cwd, record.tempName), 'not ours\n');
  const result = env.recover();
  assert.deepEqual(result.uncertain, [{ key: '1:0', reason: 'unproven_temp' }]);
  assert.equal(fs.readFileSync(path.join(env.cwd, record.tempName), 'utf8'), 'not ours\n');
  assert.equal(env.read(), 'one\ntwo\n');
});

test('a bound temp replaced by a different inode is never removed', LINUX, (t) => {
  const env = crash(t, 'patch-temp-written');
  const record = env.store.load(env.runId).patches.get('1:0');
  const tempPath = path.join(env.cwd, record.tempName);
  fs.unlinkSync(tempPath);
  fs.writeFileSync(tempPath, 'replacement\n');
  const result = env.recover();
  assert.deepEqual(result.uncertain, [{ key: '1:0', reason: 'unproven_temp' }]);
  assert.equal(fs.readFileSync(tempPath, 'utf8'), 'replacement\n');
  assert.equal(env.read(), 'one\ntwo\n');
});

test('a target changed after the crash is displaced, not overwritten', LINUX, (t) => {
  const env = crash(t, 'patch-before-publish');
  fs.writeFileSync(path.join(env.cwd, 'notes.txt'), 'user edit\n');
  const record = env.store.load(env.runId).patches.get('1:0');
  const result = env.recover();
  assert.deepEqual(result.uncertain, [{ key: '1:0', reason: 'target_displaced' }]);
  assert.equal(env.read(), 'user edit\n');
  assert.ok(env.entries().includes(record.tempName), 'temp evidence kept');
});
