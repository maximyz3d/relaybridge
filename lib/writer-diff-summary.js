'use strict';

const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { isSecretPath } = require('./github-tracker');

const MAX_FILES = 50;

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function parseStatus(raw) {
  const fields = String(raw || '').split('\0');
  const entries = new Map();
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field || field.length < 4) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3);
    entries.set(path, status);
    if (/[RC]/.test(status)) {
      const priorPath = fields[++index];
      if (priorPath) entries.set(priorPath, `${status}:source`);
    }
  }
  return entries;
}

function captureWriterWorkspaceSnapshot(cwd) {
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root.ok) return { available: false, reason: 'not_git_repository', head: null, entries: new Map() };
  const head = git(cwd, ['rev-parse', 'HEAD']);
  const status = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!status.ok) return { available: false, reason: 'git_status_failed', head: null, entries: new Map() };
  const entries = parseStatus(status.stdout);
  const fingerprints = new Map();
  for (const file of entries.keys()) {
    const hashed = git(cwd, ['hash-object', '--no-filters', '--', file]);
    fingerprints.set(file, hashed.ok && /^[0-9a-f]{40,64}$/i.test(hashed.stdout.trim())
      ? hashed.stdout.trim().toLowerCase() : null);
  }
  return {
    available: true,
    reason: null,
    head: head.ok && /^[0-9a-f]{40,64}$/i.test(head.stdout.trim()) ? head.stdout.trim().toLowerCase() : null,
    entries,
    fingerprints,
  };
}

function summarizeWriterWorkspaceDiff(before, after) {
  if (!before?.available || !after?.available) {
    return {
      available: false,
      reason: after?.reason || before?.reason || 'workspace_snapshot_unavailable',
      changedFileCount: 0,
      files: [],
      filesTruncated: false,
    };
  }
  const paths = new Set([...before.entries.keys(), ...after.entries.keys()]);
  const changed = [...paths]
    .filter((file) => before.entries.get(file) !== after.entries.get(file)
      || before.fingerprints?.get(file) !== after.fingerprints?.get(file))
    .sort((left, right) => left.localeCompare(right));
  const files = changed.slice(0, MAX_FILES).map((file) => ({
    path: isSecretPath(file) ? '[redacted-sensitive-path]' : file,
    pathHash: crypto.createHash('sha256').update(file).digest('hex'),
    beforeStatus: before.entries.get(file) || null,
    afterStatus: after.entries.get(file) || null,
    sensitivePath: isSecretPath(file),
  }));
  const canonical = changed.map((file) => [file, before.entries.get(file) || null, after.entries.get(file) || null]);
  return {
    available: true,
    reason: null,
    beforeHead: before.head,
    afterHead: after.head,
    headChanged: before.head !== after.head,
    changedFileCount: changed.length,
    files,
    filesTruncated: changed.length > files.length,
    statusHash: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
  };
}

module.exports = {
  MAX_FILES,
  captureWriterWorkspaceSnapshot,
  summarizeWriterWorkspaceDiff,
};
