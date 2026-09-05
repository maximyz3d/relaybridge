'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isSecretPath } = require('./github-tracker');

const BUILD_ID_RE = /^[A-Za-z0-9._+-]{1,128}$/;
const BUILD_INFO_FILE = 'build-info.json';
const BUILD_INFO_MAX_BYTES = 64 * 1024;
const SOURCE_LIST_MAX_BYTES = 64 * 1024 * 1024;
const TEMP_NAME_RE = /^\.build-info\.[A-Za-z0-9.-]+\.tmp$/;

function readStableRegularFile(filePath, initialStat, fsApi, failureMessage) {
  let handle = null;
  try {
    if (!initialStat?.isFile() || initialStat.isSymbolicLink()) throw new Error(failureMessage);
    const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
    handle = fsApi.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const opened = fsApi.fstatSync(handle);
    if (!opened.isFile() || opened.dev !== initialStat.dev || opened.ino !== initialStat.ino) {
      throw new Error(failureMessage);
    }
    const content = fsApi.readFileSync(handle);
    const afterHandle = fsApi.fstatSync(handle);
    const afterPath = fsApi.lstatSync(filePath);
    if (stableStat(opened) !== stableStat(afterHandle) ||
        afterPath.isSymbolicLink() || stableStat(initialStat) !== stableStat(afterPath)) {
      throw new Error(failureMessage);
    }
    return Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  } catch {
    throw new Error(failureMessage);
  } finally {
    if (handle !== null) {
      try { fsApi.closeSync(handle); } catch {}
    }
  }
}

function parsePackageVersion(content) {
  let parsed;
  try {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('invalid UTF-8');
    parsed = JSON.parse(text);
  } catch {
    // Never include JSON parser excerpts: package.json can be attacker-selected
    // until a source checkout has passed its closure validation.
    throw new Error('package.json is not valid JSON');
  }
  const version = String(parsed?.version || '');
  if (!version || !BUILD_ID_RE.test(version)) throw new Error('package.json contains an invalid version');
  return version;
}

function packageVersion(root, fsApi = fs) {
  const packagePath = path.join(root, 'package.json');
  let stat;
  try { stat = fsApi.lstatSync(packagePath); }
  catch { throw new Error('package.json could not be read safely'); }
  const content = readStableRegularFile(packagePath, stat, fsApi, 'package.json could not be read safely');
  return parsePackageVersion(content);
}

function exactManifestBuildId(version, buildId) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}\\+[a-f0-9]{16,64}$`, 'i').test(buildId);
}

function hasGitMarker(root, fsApi = fs) {
  try {
    const stat = fsApi.lstatSync(path.join(root, '.git'));
    return stat.isFile() || stat.isDirectory();
  } catch {
    return false;
  }
}

function loadBuildIdentity(root, options = {}) {
  const { env = process.env, fsApi = fs } = options;
  const sourceCheckout = hasGitMarker(root, fsApi);
  const testUnready = env.NODE_ENV === 'test' && env.RELAYBRIDGE_TEST_BUILD_IDENTITY_UNREADY === '1';
  const testBuildId = env.NODE_ENV === 'test' ? String(env.RELAYBRIDGE_TEST_BUILD_ID || '') : '';
  let sourceSnapshot = null;
  let version;
  if (sourceCheckout) {
    if (testUnready || BUILD_ID_RE.test(testBuildId)) {
      const entries = validateSourceClosure(root, options);
      version = packageVersionFromValidatedSource(root, entries, fsApi);
    } else {
      sourceSnapshot = stableSourceSnapshot(root, options);
      version = parsePackageVersion(sourceSnapshot.packageBytes);
    }
  } else {
    version = packageVersion(root, fsApi);
  }
  if (testUnready) {
    return {
      version,
      buildId: version,
      ready: false,
      source: 'package_version_fallback',
      reason: 'test_unready',
    };
  }
  if (BUILD_ID_RE.test(testBuildId)) {
    return { version, buildId: testBuildId, ready: true, source: 'test_override', reason: null };
  }

  const manifestPath = path.join(root, BUILD_INFO_FILE);
  let reason = 'build_info_missing';
  try {
    const stat = fsApi.lstatSync(manifestPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > BUILD_INFO_MAX_BYTES) {
      reason = 'build_info_invalid';
    } else {
      const manifestBytes = readStableRegularFile(manifestPath, stat, fsApi, 'build-info.json could not be read safely');
      const parsed = JSON.parse(manifestBytes.toString('utf8'));
      const manifestVersion = String(parsed?.version || '');
      const buildId = String(parsed?.buildId || '');
      if (manifestVersion !== version) reason = 'build_info_version_mismatch';
      else if (!BUILD_ID_RE.test(buildId) || !exactManifestBuildId(version, buildId)) reason = 'build_info_invalid';
      else if (sourceCheckout) {
        try {
          const currentBuildId = `${version}+${sourceSnapshot.digest.slice(0, 16)}`;
          if (currentBuildId !== buildId) reason = 'build_info_stale';
          else return { version, buildId, ready: true, source: 'build_info', reason: null };
        } catch {
          reason = 'source_verification_failed';
        }
      } else if (parsed?.source === 'git-working-tree') {
        // A source-owned manifest is only meaningful while its Git checkout can
        // be revalidated. Do not let copying it into an installed tree (or
        // removing/breaking .git) turn an old source digest into a release ID.
        reason = 'source_verification_failed';
      } else return { version, buildId, ready: true, source: 'build_info', reason: null };
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') reason = 'build_info_invalid';
  }
  return { version, buildId: version, ready: false, source: 'package_version_fallback', reason };
}

function runGit(root, args, spawnApi = spawnSync) {
  const result = spawnApi('git', ['-C', root, ...args], {
    encoding: null,
    windowsHide: true,
    maxBuffer: SOURCE_LIST_MAX_BYTES,
  });
  if (result.error) throw new Error(`git could not inspect the source checkout: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = Buffer.from(result.stderr || '').toString('utf8').trim().split(/\r?\n/, 1)[0];
    throw new Error(`git could not inspect the source checkout${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }
  return Buffer.from(result.stdout || '');
}

function canonicalPath(value, fsApi = fs) {
  const resolved = path.resolve(value);
  try { return fsApi.realpathSync.native(resolved); } catch { return fsApi.realpathSync(resolved); }
}

function samePath(left, right) {
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function assertGitWorktreeRoot(root, options = {}) {
  const fsApi = options.fsApi || fs;
  const topLevel = runGit(root, ['rev-parse', '--show-toplevel'], options.spawnApi).toString('utf8').trim();
  if (!topLevel || !samePath(canonicalPath(root, fsApi), canonicalPath(topLevel, fsApi))) {
    throw new Error('source build preparation must run at the Git worktree root');
  }
  return topLevel;
}

function splitNullBuffers(value) {
  const parts = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) continue;
    if (index > start) parts.push(value.subarray(start, index));
    start = index + 1;
  }
  if (start < value.length) parts.push(value.subarray(start));
  return parts;
}

function stagedSourcePaths(root, options = {}) {
  const output = runGit(root, ['ls-files', '-z', '--stage', '--'], options.spawnApi);
  const entries = [];
  for (const record of splitNullBuffers(output)) {
    const separator = record.indexOf(0x09);
    if (separator <= 0 || separator === record.length - 1) {
      throw new Error('git returned malformed source index metadata');
    }
    const header = record.subarray(0, separator).toString('ascii');
    const match = /^(100644|100755|120000) [a-f0-9]{40,64} ([0-3])$/i.exec(header);
    if (!match || match[2] !== '0') {
      throw new Error('source checkout contains unsupported or unmerged index entries');
    }
    entries.push({ rawName: record.subarray(separator + 1), trackedMode: match[1] });
  }
  return entries;
}

function sourcePaths(root, options = {}) {
  assertGitWorktreeRoot(root, options);
  const trackedIgnored = runGit(root, [
    'ls-files', '-z', '--cached', '--ignored', '--exclude-standard', '--',
  ], options.spawnApi);
  if (trackedIgnored.length !== 0) {
    throw new Error('source checkout contains tracked paths matched by ignore rules');
  }
  const tracked = stagedSourcePaths(root, options);
  const untracked = runGit(root, [
    'ls-files', '-z', '--others', '--exclude-standard', '--',
  ], options.spawnApi);
  const unique = new Map();
  const candidates = [
    ...tracked,
    ...splitNullBuffers(untracked).map((rawName) => ({ rawName, trackedMode: null })),
  ];
  for (const { rawName, trackedMode } of candidates) {
    const name = rawName.toString('utf8');
    if (!Buffer.from(name, 'utf8').equals(rawName)) {
      throw new Error('source checkout contains a path that is not valid UTF-8');
    }
    if (name === BUILD_INFO_FILE || TEMP_NAME_RE.test(name)) continue;
    if (isSecretPath(name)) {
      throw new Error('source checkout contains a secret-looking path; ignore or remove it before preparing build identity');
    }
    const key = rawName.toString('hex');
    if (unique.has(key)) throw new Error('git returned duplicate source index entries');
    unique.set(key, { name, rawName, trackedMode });
  }
  const entries = [...unique.values()];
  entries.sort((a, b) => Buffer.compare(a.rawName, b.rawName));
  if (entries.length === 0) throw new Error('source checkout contains no files to identify');
  return entries;
}

function addFrame(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function stableStat(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

function decodeUtf8Exact(value, failureMessage) {
  const text = value.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(value)) throw new Error(failureMessage);
  return text;
}

function assertSymlinkTargetIncluded(root, absolute, targetText, sourceNames, fsApi = fs) {
  // Do not lexically collapse `..` before the filesystem has resolved earlier
  // components. For example, ignored-link/../tracked.js can escape when
  // ignored-link itself names an out-of-tree directory. Reject traversal
  // components rather than accidentally proving a different normalized path.
  if (targetText.split(/[\\/]/).includes('..')) {
    throw new Error('source checkout contains unsafe symlink target traversal');
  }
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(path.dirname(absolute), targetText);
  const relative = path.relative(rootPath, targetPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('source checkout contains a symlink target outside the worktree');
  }
  const portable = relative.split(path.sep).join('/');
  if (portable === '') return;
  const included = sourceNames.has(portable)
    || [...sourceNames].some((name) => name.startsWith(`${portable}/`));
  if (!included) {
    throw new Error('source checkout contains a symlink target outside the identified source set');
  }
  let resolvedRoot;
  let resolvedTarget;
  try {
    resolvedRoot = canonicalPath(rootPath, fsApi);
    resolvedTarget = canonicalPath(targetPath, fsApi);
  } catch {
    throw new Error('source checkout contains a symlink target that cannot be resolved safely');
  }
  const resolvedRelative = path.relative(resolvedRoot, resolvedTarget);
  if (resolvedRelative === '..' || resolvedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedRelative)) {
    throw new Error('source checkout contains a symlink target outside the worktree');
  }
}

function sourceEntryPath(root, name) {
  if (path.isAbsolute(name) || name === '..' || name.startsWith('../')) {
    throw new Error('git returned a source path outside the worktree');
  }
  const rootPath = path.resolve(root);
  const absolute = path.resolve(rootPath, name);
  const relative = path.relative(rootPath, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('git returned a source path outside the worktree');
  }
  return absolute;
}

function assertRegularPathWithinWorktree(root, absolute, fsApi = fs) {
  let resolvedRoot;
  let resolvedFile;
  try {
    resolvedRoot = canonicalPath(root, fsApi);
    resolvedFile = canonicalPath(absolute, fsApi);
  } catch {
    throw new Error('source checkout contains a path that cannot be resolved safely');
  }
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('source checkout contains a path outside the worktree');
  }
}

// Source inspection is deliberately split into a metadata/closure pass and a
// content pass. In particular, package.json is not opened until every source
// symlink has proved that its target remains inside the identified checkout.
function validateSourceClosure(root, options = {}) {
  const fsApi = options.fsApi || fs;
  const names = sourcePaths(root, options);
  const sourceNames = new Set(names.map(({ name }) => name));
  const entries = [];
  for (const entry of names) {
    const { name, trackedMode } = entry;
    const absolute = sourceEntryPath(root, name);
    let before;
    try { before = fsApi.lstatSync(absolute); }
    catch (error) {
      if (error?.code === 'ENOENT') {
        entries.push({ ...entry, absolute, kind: 'missing', before: null, linkBytes: null });
        continue;
      }
      throw error;
    }

    if (before.isSymbolicLink()) {
      const rawTarget = fsApi.readlinkSync(absolute, { encoding: 'buffer' });
      const linkBytes = Buffer.isBuffer(rawTarget) ? rawTarget : Buffer.from(String(rawTarget), 'utf8');
      const targetText = decodeUtf8Exact(linkBytes,
        'source checkout contains a symlink target that is not valid UTF-8');
      assertSymlinkTargetIncluded(root, absolute, targetText, sourceNames, fsApi);
      const after = fsApi.lstatSync(absolute);
      if (stableStat(before) !== stableStat(after)) {
        throw new Error('source checkout changed while build identity was being computed');
      }
      entries.push({ ...entry, absolute, kind: 'symlink', before: after, linkBytes });
    } else if (before.isFile()) {
      // lstat does not expose a symlink in a parent component. Resolve the
      // regular file before opening it so replacing a tracked directory with
      // an out-of-tree link cannot smuggle external bytes into the digest.
      assertRegularPathWithinWorktree(root, absolute, fsApi);
      // Host stat modes differ for the same checkout through WSL/Windows and
      // on filesystems with core.filemode disabled. Git's index is the portable
      // source of executable truth; untracked files have no canonical bit.
      // A regular file materialized from an index-mode 120000 entry must remain
      // distinct from a real symlink because the runtime behavior is different.
      entries.push({
        ...entry,
        absolute,
        kind: `file:${trackedMode === '120000'
          ? 'git-symlink-materialized'
          : trackedMode === '100755' ? 'executable' : 'regular'}`,
        before,
        linkBytes: null,
      });
    } else {
      throw new Error(`source checkout contains unsupported file type: ${name}`);
    }
  }
  return entries;
}

function packageVersionFromValidatedSource(root, entries, fsApi = fs) {
  const packageEntry = entries.find(({ name }) => name === 'package.json');
  if (!packageEntry || !packageEntry.before || packageEntry.kind === 'symlink' ||
      !packageEntry.kind.startsWith('file:')) {
    throw new Error('package.json could not be read safely');
  }
  const content = readStableRegularFile(
    path.join(root, 'package.json'),
    packageEntry.before,
    fsApi,
    'package.json could not be read safely',
  );
  return parsePackageVersion(content);
}

function sourceSnapshotOnce(root, options = {}) {
  const fsApi = options.fsApi || fs;
  const hash = crypto.createHash('sha256');
  const entries = validateSourceClosure(root, options);
  let packageBytes = null;
  addFrame(hash, 'relaybridge-source-build-v1');
  for (const entry of entries) {
    const { name, rawName, kind, before, absolute, linkBytes } = entry;
    addFrame(hash, rawName);
    if (kind === 'missing') {
      addFrame(hash, kind);
      addFrame(hash, Buffer.alloc(0));
      continue;
    }

    let content;
    if (kind === 'symlink') {
      const current = fsApi.lstatSync(absolute);
      if (stableStat(before) !== stableStat(current)) {
        throw new Error('source checkout changed while build identity was being computed');
      }
      const rawTarget = current.isSymbolicLink()
        ? fsApi.readlinkSync(absolute, { encoding: 'buffer' })
        : fsApi.readFileSync(absolute);
      content = Buffer.isBuffer(rawTarget) ? rawTarget : Buffer.from(String(rawTarget), 'utf8');
      if (!content.equals(linkBytes)) {
        throw new Error('source checkout changed while build identity was being computed');
      }
    } else {
      content = readStableRegularFile(
        absolute,
        before,
        fsApi,
        'source checkout changed while build identity was being computed',
      );
      if (name === 'package.json') packageBytes = Buffer.from(content);
    }
    addFrame(hash, kind);
    addFrame(hash, content);
  }
  if (packageBytes === null) throw new Error('package.json could not be read safely');
  return { digest: hash.digest('hex'), fileCount: entries.length, packageBytes };
}

function sourceDigestOnce(root, options = {}) {
  const { digest, fileCount } = sourceSnapshotOnce(root, options);
  return { digest, fileCount };
}

function stableSourceSnapshot(root, options = {}) {
  const attempts = Number.isInteger(options.stabilityAttempts) ? options.stabilityAttempts : 3;
  let previous = sourceSnapshotOnce(root, options);
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    const current = sourceSnapshotOnce(root, options);
    if (current.digest === previous.digest && current.fileCount === previous.fileCount) return current;
    previous = current;
  }
  throw new Error('source checkout did not remain stable while build identity was being computed');
}

function stableSourceDigest(root, options = {}) {
  const { digest, fileCount } = stableSourceSnapshot(root, options);
  return { digest, fileCount };
}

function sourceRevision(root, options = {}) {
  try {
    const value = runGit(root, ['rev-parse', '--verify', 'HEAD'], options.spawnApi).toString('utf8').trim();
    return /^[a-f0-9]{40,64}$/i.test(value) ? value : null;
  } catch {
    return null;
  }
}

function buildSourceInfo(root, options = {}) {
  const snapshot = stableSourceSnapshot(root, options);
  const version = parsePackageVersion(snapshot.packageBytes);
  return {
    version,
    buildId: `${version}+${snapshot.digest.slice(0, 16)}`,
    source: 'git-working-tree',
    sourceRevision: sourceRevision(root, options),
    sourceFileCount: snapshot.fileCount,
    installedAt: new Date(options.now ?? Date.now()).toISOString(),
  };
}

function writeBuildInfoAtomic(root, info, options = {}) {
  const fsApi = options.fsApi || fs;
  const target = path.join(root, BUILD_INFO_FILE);
  const nonce = (options.randomUUID || crypto.randomUUID)().replace(/[^A-Za-z0-9.-]/g, '');
  const temporary = path.join(root, `.build-info.${process.pid}.${nonce}.tmp`);
  const body = `${JSON.stringify(info, null, 2)}\n`;
  let handle = null;
  try {
    handle = fsApi.openSync(temporary, 'wx', 0o600);
    fsApi.writeFileSync(handle, body, 'utf8');
    fsApi.fsyncSync(handle);
    fsApi.closeSync(handle);
    handle = null;
    const renameDeadline = Date.now() + (options.renameRetryMs ?? 2000);
    for (;;) {
      try {
        fsApi.renameSync(temporary, target);
        break;
      } catch (error) {
        // Windows can transiently deny a replace while another concurrent
        // publisher or scanner still has the destination open. Retrying the
        // same atomic replace preserves the previous complete manifest; an
        // unlink-then-rename fallback would create an observable gap.
        const retryable = (options.platform || process.platform) === 'win32'
          && (error?.code === 'EPERM' || error?.code === 'EACCES')
          && Date.now() < renameDeadline;
        if (!retryable) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      const directory = fsApi.openSync(root, 'r');
      try { fsApi.fsyncSync(directory); } finally { fsApi.closeSync(directory); }
    } catch { /* directory fsync is unavailable on Windows and some filesystems */ }
  } finally {
    if (handle !== null) {
      try { fsApi.closeSync(handle); } catch {}
    }
    try { fsApi.unlinkSync(temporary); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return target;
}

function prepareBuildInfo(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  let gitRoot = false;
  try {
    assertGitWorktreeRoot(resolvedRoot, options);
    gitRoot = true;
  } catch {}
  if (!gitRoot) {
    const existing = loadBuildIdentity(resolvedRoot, options);
    if (existing.ready) return { updated: false, identity: existing };
    throw new Error('an exact build-info.json is required outside a Git source checkout; run the release installer');
  }

  const info = buildSourceInfo(resolvedRoot, options);
  writeBuildInfoAtomic(resolvedRoot, info, options);
  const identity = loadBuildIdentity(resolvedRoot, options);
  if (!identity.ready || identity.buildId !== info.buildId) {
    throw new Error('generated build-info.json did not verify');
  }
  return { updated: true, identity, info };
}

module.exports = {
  BUILD_ID_RE,
  BUILD_INFO_FILE,
  buildSourceInfo,
  loadBuildIdentity,
  prepareBuildInfo,
  sourceDigestOnce,
  stableSourceDigest,
  writeBuildInfoAtomic,
};
