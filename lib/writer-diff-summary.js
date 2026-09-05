'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isSecretPath } = require('./github-tracker');

const MAX_FILES = 50;
const MAX_FINGERPRINT_FILES = 200;

function git(cwd, args, options = {}) {
  // Keep the caller-selected workspace out of ChildProcessOptions.cwd, which
  // is a filesystem path sink. Git's -C consumes the workspace as one argv
  // value (shell execution is never enabled), preserving unusual but valid
  // directory names without turning path text into process-launch control.
  const result = spawnSync('git', ['-C', String(cwd), ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
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
  const rootDir = root.stdout.trim();
  const head = git(rootDir, ['rev-parse', 'HEAD']);
  const status = git(rootDir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!status.ok) return { available: false, reason: 'git_status_failed', head: null, entries: new Map() };
  const entries = parseStatus(status.stdout);
  const fingerprints = new Map();
  const candidates = [...entries.keys()]
    .filter((file) => !/[\r\n]/.test(file) && fs.existsSync(path.join(rootDir, file)))
    .sort((left, right) => left.localeCompare(right));
  const boundedCandidates = candidates.slice(0, MAX_FINGERPRINT_FILES);
  // One bounded git process fingerprints all present dirty files. Spawning one
  // process per path blocked the bridge event loop for large writer diffs.
  if (boundedCandidates.length) {
    const hashed = git(rootDir, ['hash-object', '--no-filters', '--stdin-paths'], {
      input: `${boundedCandidates.join('\n')}\n`,
    });
    const hashes = hashed.ok ? hashed.stdout.trim().split(/\r?\n/) : [];
    boundedCandidates.forEach((file, index) => {
      const value = hashes[index];
      fingerprints.set(file, /^[0-9a-f]{40,64}$/i.test(String(value || ''))
        ? value.toLowerCase() : null);
    });
  }
  return {
    available: true,
    reason: null,
    head: head.ok && /^[0-9a-f]{40,64}$/i.test(head.stdout.trim()) ? head.stdout.trim().toLowerCase() : null,
    entries,
    fingerprints,
    fingerprintFileCount: boundedCandidates.length,
    fingerprintsTruncated: candidates.length > boundedCandidates.length,
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
    // Common secret paths such as .env have almost no entropy; hashing them is
    // reversible by dictionary. Omit the hash at the same trust boundary.
    pathHash: isSecretPath(file) ? null
      : crypto.createHash('sha256').update(file).digest('hex'),
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
    fingerprintsTruncated: before.fingerprintsTruncated === true || after.fingerprintsTruncated === true,
    statusHash: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
  };
}

module.exports = {
  MAX_FILES,
  MAX_FINGERPRINT_FILES,
  captureWriterWorkspaceSnapshot,
  summarizeWriterWorkspaceDiff,
};
