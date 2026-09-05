'use strict';

// These checks protect onboarding against repository-controlled paths inside
// its private, single-writer clone. They are not an OS sandbox against another
// malicious process running as the same user and swapping ancestors mid-syscall.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_TEMPLATE_BYTES = 1024 * 1024;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function fail(code) { throw Object.assign(new Error(code), { code }); }
function validRepo(repo) {
  return typeof repo === 'string' && REPO_RE.test(repo) &&
    repo.split('/').every((part) => part !== '.' && part !== '..');
}
function githubRepoFromOrigin(value) {
  if (typeof value !== 'string' || /[\s\0\\]/.test(value)) return null;
  let repo;
  const scp = /^git@github\.com:([^?#]+)$/i.exec(value);
  if (scp) repo = scp[1];
  else {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.hostname.toLowerCase() !== 'github.com' || url.search || url.hash || url.password ||
        url.port || !['https:', 'ssh:'].includes(url.protocol) ||
        (url.protocol === 'https:' ? !!url.username : url.username !== 'git')) return null;
    repo = url.pathname.slice(1);
  }
  repo = repo.replace(/\.git$/i, '');
  return validRepo(repo) ? repo.toLowerCase() : null;
}

function gitEnvironment(base = process.env) {
  // Git accepts path/config redirections beyond GIT_DIR. No inherited GIT_*
  // control variable may turn a root/origin check into inspection of another
  // repository, config, index or object database.
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !/^GIT_/i.test(key)));
  return { ...env, GH_HOST: 'github.com', GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };
}

function identity(stat) { return `${stat.dev}:${stat.ino}`; }
function snapshot(stat) {
  return stat ? [identity(stat), stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(':') : null;
}
function regularDirectory(file, io) {
  const stat = io.lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_onboarding_directory');
  return stat;
}
function canonical(file, io) { return io.realpathSync(file); }
function samePath(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }

async function validateCheckoutIdentity({ requestedRepo, checkoutPath, gitRun, fsApi = fs }) {
  if (!validRepo(requestedRepo)) fail('invalid_onboarding_repository');
  const root = canonical(checkoutPath, fsApi);
  const rootIdentity = identity(regularDirectory(root, fsApi));
  const inspect = async (args) => {
    const result = await gitRun(args, { cwd: root, env: gitEnvironment(), maxOutputBytes: MAX_TEMPLATE_BYTES });
    if (result.code !== 0) fail('onboarding_checkout_identity_unavailable');
    return String(result.stdout).trim();
  };
  if (await inspect(['rev-parse', '--is-bare-repository']) !== 'false') fail('onboarding_checkout_must_be_worktree');
  const top = await inspect(['rev-parse', '--show-toplevel']);
  if (!samePath(canonical(top, fsApi), root)) fail('onboarding_checkout_must_be_root');
  const fetchOrigin = await inspect(['remote', 'get-url', '--all', 'origin']);
  const pushOrigin = await inspect(['remote', 'get-url', '--push', '--all', 'origin']);
  const expected = requestedRepo.toLowerCase();
  if (githubRepoFromOrigin(fetchOrigin) !== expected || githubRepoFromOrigin(pushOrigin) !== expected) {
    // Never include rejected URLs: embedded credentials are a common mistake.
    fail('onboarding_checkout_origin_mismatch');
  }
  if (identity(regularDirectory(root, fsApi)) !== rootIdentity) fail('onboarding_checkout_changed');
  return { canonicalRoot: root, canonicalRepo: expected, rootIdentity };
}

function targetPath(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') ||
      path.isAbsolute(relative) || relative.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':'))) {
    fail('invalid_onboarding_target');
  }
  return path.join(root, ...relative.split('/'));
}

function inspectTarget(root, relative, io) {
  const file = targetPath(root, relative);
  const parents = [{ file: root, identity: identity(regularDirectory(root, io)) }];
  const segments = relative.split('/');
  let parent = root;
  let missing = false;
  for (const segment of segments.slice(0, -1)) {
    parent = path.join(parent, segment);
    if (missing) { parents.push({ file: parent, identity: null }); continue; }
    try { parents.push({ file: parent, identity: identity(regularDirectory(parent, io)) }); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing = true;
      parents.push({ file: parent, identity: null });
    }
  }
  let leaf = null;
  if (!missing) {
    try {
      leaf = io.lstatSync(file);
      if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1) fail('unsafe_onboarding_template');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { file, relative, parents, leaf: snapshot(leaf), mode: leaf?.mode ?? 0o644 };
}

async function prepareTemplateTargets({ root, relativePaths, gitRun, fsApi = fs }) {
  root = canonical(root, fsApi);
  const targets = relativePaths.map((relative) => inspectTarget(root, relative, fsApi));
  const relevant = new Set(relativePaths.flatMap((relative) => {
    const parts = relative.split('/');
    return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
  }));
  const result = await gitRun(['ls-files', '--stage', '-z', '--', ...relativePaths, '.github'], {
    cwd: root, env: gitEnvironment(), maxOutputBytes: MAX_TEMPLATE_BYTES,
  });
  if (result.code !== 0 || Buffer.byteLength(result.stdout) > MAX_TEMPLATE_BYTES) fail('onboarding_index_unavailable');
  const blobs = new Map();
  for (const record of String(result.stdout).split('\0').filter(Boolean)) {
    const match = /^(\d{6}) ([a-f0-9]{40,64}) ([0-3])\t(.+)$/.exec(record);
    if (!match) fail('onboarding_index_invalid');
    const [, mode, oid, stage, name] = match;
    if (!relevant.has(name)) continue;
    if (stage !== '0' || !['100644', '100755'].includes(mode)) fail('unsafe_onboarding_index_mode');
    blobs.set(name, oid);
  }
  for (const target of targets) {
    const oid = blobs.get(target.relative);
    if (!oid) {
      if (target.leaf !== null) fail('untracked_onboarding_template');
      target.text = null;
      continue;
    }
    if (target.leaf === null) fail('missing_onboarding_template');
    const opts = { cwd: root, env: gitEnvironment(), maxOutputBytes: MAX_TEMPLATE_BYTES };
    const size = await gitRun(['cat-file', '-s', oid], opts);
    if (size.code !== 0 || !/^\d+\s*$/.test(String(size.stdout)) || Number(size.stdout) > MAX_TEMPLATE_BYTES) {
      fail('onboarding_template_too_large');
    }
    // Read immutable Git blob identity, never the destination filesystem path.
    const content = await gitRun(['cat-file', 'blob', oid], opts);
    if (content.code !== 0 || Buffer.byteLength(content.stdout) !== Number(size.stdout)) fail('onboarding_template_unreadable');
    target.text = String(content.stdout);
  }
  return { root, rootIdentity: identity(regularDirectory(root, fsApi)), targets };
}

function publishTemplateTargets({ plan, writes, fsApi = fs }) {
  const { root, targets, rootIdentity } = plan;
  const selected = new Map(targets.map((target) => [target.relative, target]));
  if (identity(regularDirectory(root, fsApi)) !== rootIdentity) fail('onboarding_checkout_changed');
  // Validate the entire candidate set before the first write.
  for (const target of targets) {
    const current = inspectTarget(root, target.relative, fsApi);
    if (current.leaf !== target.leaf || current.parents.some((parent, index) =>
      parent.identity !== target.parents[index].identity)) fail('onboarding_template_changed');
  }
  const seenWrites = new Set();
  for (const write of writes) {
    if (!selected.has(write.relative) || typeof write.content !== 'string' ||
        seenWrites.has(write.relative) || Buffer.byteLength(write.content) > MAX_TEMPLATE_BYTES) fail('invalid_onboarding_write');
    seenWrites.add(write.relative);
  }
  for (const write of writes) {
    const target = selected.get(write.relative);
    for (const parent of target.parents) {
      try {
        const current = regularDirectory(parent.file, fsApi);
        if (parent.identity && identity(current) !== parent.identity) fail('onboarding_directory_changed');
      } catch (error) {
        if (error.code !== 'ENOENT' || parent.identity) throw error;
        fsApi.mkdirSync(parent.file, { mode: 0o755 });
        regularDirectory(parent.file, fsApi);
      }
    }
    const current = inspectTarget(root, target.relative, fsApi);
    if (current.leaf !== target.leaf) fail('onboarding_template_changed');
    const temporary = path.join(path.dirname(target.file), `.rb-template-${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = fsApi.openSync(temporary, 'wx', target.mode & 0o777);
      fsApi.writeFileSync(handle, write.content, 'utf8');
      fsApi.fsyncSync(handle);
      fsApi.closeSync(handle);
      handle = undefined;
      const final = inspectTarget(root, target.relative, fsApi);
      if (final.leaf !== target.leaf || final.parents.some((parent, index) =>
        parent.identity !== current.parents[index].identity)) fail('onboarding_template_changed');
      fsApi.renameSync(temporary, target.file);
    } finally {
      if (handle !== undefined) fsApi.closeSync(handle);
      try { fsApi.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

module.exports = { githubRepoFromOrigin, gitEnvironment, validateCheckoutIdentity, prepareTemplateTargets, publishTemplateTargets };
