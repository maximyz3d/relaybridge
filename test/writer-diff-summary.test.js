'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const {
  captureWriterWorkspaceSnapshot,
  summarizeWriterWorkspaceDiff,
} = require('../lib/writer-diff-summary');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}

test('an unavailable workspace snapshot reports an unknown change count, not zero', () => {
  const summary = summarizeWriterWorkspaceDiff({ available: false, reason: 'git_status_failed' }, null);
  assert.equal(summary.available, false);
  assert.equal(summary.reason, 'git_status_failed');
  assert.equal(summary.changedFileCount, null);
  assert.equal(summary.changedFileCountLowerBound, 0);
  assert.equal(summary.changeCountComplete, false);
});

test('writer diff summary reports bounded status without leaking secret paths or contents', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-writer-summary-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'test@example.invalid');
  git(cwd, 'config', 'user.name', 'Relay Test');
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'before\n');
  git(cwd, 'add', 'tracked.txt');
  git(cwd, 'commit', '-qm', 'base');

  const before = captureWriterWorkspaceSnapshot(cwd);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'after\n');
  fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=hunter2\n');
  const after = captureWriterWorkspaceSnapshot(cwd);
  const summary = summarizeWriterWorkspaceDiff(before, after);

  assert.equal(summary.available, true);
  assert.equal(summary.changedFileCount, 2);
  assert.equal(summary.headChanged, false);
  assert.match(summary.statusHash, /^[0-9a-f]{64}$/);
  assert.ok(summary.files.some((file) => file.path === 'tracked.txt'));
  const secret = summary.files.find((file) => file.sensitivePath);
  assert.equal(secret.path, '[redacted-sensitive-path]');
  assert.equal(secret.pathHash, null);
  assert.doesNotMatch(JSON.stringify(summary), /\.env|hunter2/);
  const publicCanonical = summary.files.map((file) => [file.path, file.beforeStatus, file.afterStatus])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.equal(summary.statusHash, crypto.createHash('sha256').update(JSON.stringify(publicCanonical)).digest('hex'));
  const guessedRawCanonical = [['.env', null, '??'], ['tracked.txt', null, ' M']];
  assert.notEqual(summary.statusHash, crypto.createHash('sha256').update(JSON.stringify(guessedRawCanonical)).digest('hex'));

  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'changed again with identical porcelain status\n');
  const changedAgain = captureWriterWorkspaceSnapshot(cwd);
  const repeatedStatus = summarizeWriterWorkspaceDiff(after, changedAgain);
  assert.equal(repeatedStatus.changedFileCount, 1,
    'content changes to an already-dirty path must not disappear behind an unchanged XY status');
  assert.equal(repeatedStatus.files[0].path, 'tracked.txt');
});

test('writer snapshots bound fingerprint work and report truncation', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-writer-many-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'test@example.invalid');
  git(cwd, 'config', 'user.name', 'Relay Test');
  fs.writeFileSync(path.join(cwd, 'base.txt'), 'base\n');
  git(cwd, 'add', 'base.txt');
  git(cwd, 'commit', '-qm', 'base');
  const before = captureWriterWorkspaceSnapshot(cwd);
  for (let index = 0; index < 230; index += 1) {
    fs.writeFileSync(path.join(cwd, `new-${String(index).padStart(3, '0')}.txt`), `${index}\n`);
  }

  const snapshot = captureWriterWorkspaceSnapshot(cwd);
  assert.equal(snapshot.fingerprintFileCount, 200);
  assert.equal(snapshot.fingerprintsTruncated, true);
  const summary = summarizeWriterWorkspaceDiff(before, snapshot);
  assert.equal(summary.available, true);
  assert.equal(summary.changedFileCount, 230);
  assert.equal(summary.filesTruncated, true);
  assert.equal(summary.fingerprintsTruncated, true);

  fs.writeFileSync(path.join(cwd, 'new-229.txt'), 'modified beyond fingerprint coverage\n');
  const later = captureWriterWorkspaceSnapshot(cwd);
  const uncertain = summarizeWriterWorkspaceDiff(snapshot, later);
  assert.equal(uncertain.changedFileCount, null, 'unknown content must not be reported as zero changes');
  assert.equal(uncertain.changedFileCountLowerBound, 0);
  assert.equal(uncertain.unverifiedFileCount, 30);
  assert.equal(uncertain.changeCountComplete, false);
});

test('non-repository writer summary fails closed', () => {
  const before = captureWriterWorkspaceSnapshot(os.tmpdir());
  const summary = summarizeWriterWorkspaceDiff(before, before);
  assert.equal(summary.available, false);
  assert.equal(summary.changedFileCount, null);
});

test('failed fingerprints remain explicitly unknown even without truncation', () => {
  const snapshot = { available: true, head: 'a'.repeat(40), entries: new Map([['dirty.txt', ' M']]),
    fingerprints: new Map([['dirty.txt', null]]), fingerprintsTruncated: false };
  const summary = summarizeWriterWorkspaceDiff(snapshot, snapshot);
  assert.equal(summary.changedFileCount, null);
  assert.equal(summary.unverifiedFileCount, 1);
  assert.equal(summary.changeCountComplete, false);
});

test('writer snapshot treats control-shaped workspace text as one git path argument', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-writer-path-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  // Newlines are control characters that Win32 correctly rejects in path
  // components. A leading option plus `&` remains legal on every supported
  // filesystem while still detecting either argv splitting or shell parsing.
  const cwd = path.join(parent, '--help & echo injected');
  fs.mkdirSync(cwd);
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'test@example.invalid');
  git(cwd, 'config', 'user.name', 'Relay Test');
  fs.writeFileSync(path.join(cwd, 'local.txt'), 'synthetic\n');

  const snapshot = captureWriterWorkspaceSnapshot(cwd);
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.entries.get('local.txt'), '??');
  assert.equal(snapshot.fingerprintFileCount, 1);
});
