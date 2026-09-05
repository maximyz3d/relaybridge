'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { onboardRepo } = require('../lib/github-onboard');
const { gitEnvironment } = require('../lib/onboard-safety');
const { runBoundedCommand } = require('../lib/bounded-command');

function git(cwd, args, extra = {}) {
  const result = spawnSync('git', args, { cwd, env: gitEnvironment(), encoding: 'utf8', ...extra });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-onboard-integration-'));
  const source = path.join(root, 'caller');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(source); fs.mkdirSync(outside);
  git(source, ['init', '-b', 'main']);
  git(source, ['config', 'user.name', 'Onboarding Fixture']);
  git(source, ['config', 'user.email', 'fixture@example.invalid']);
  git(source, ['remote', 'add', 'origin', 'https://github.com/acme/project.git']);
  fs.writeFileSync(path.join(source, 'README.md'), 'Original 世界 🌍\n');
  fs.writeFileSync(path.join(source, 'CONTRIBUTING.md'), 'Operator contribution policy 世界 🌍\n');
  git(source, ['add', '.']); git(source, ['commit', '-m', 'fixture']);
  fs.writeFileSync(path.join(source, 'README.md'), 'Uncommitted caller work\n');
  fs.writeFileSync(path.join(source, 'private-note.txt'), 'untracked caller work\n');
  const state = { calls: [], clones: [], registry: { repos: [] }, saves: 0, fleets: 0,
    logs: 0, cloned: null, gitFailure: null, ghFailure: null, beforePublish: null };
  const deps = {
    git: async (args, opts) => {
      state.calls.push(['git', ...args]);
      if (state.gitFailure?.(args, opts)) return { code: -1, stdout: '', stderr: 'injected git failure' };
      if (['fetch', 'push'].includes(args[0])) return { code: 0, stdout: '', stderr: '' };
      return runBoundedCommand('git', args, { ...opts, env: gitEnvironment(opts?.env) });
    },
    gh: async (args) => {
      state.calls.push(['gh', ...args]);
      if (args[0] === 'repo' && args[1] === 'clone') {
        const cwd = args[3]; state.clones.push(path.dirname(cwd));
        git(root, ['clone', '--no-hardlinks', source, cwd]);
        git(cwd, ['remote', 'set-url', 'origin', 'https://github.com/acme/project.git']);
        git(cwd, ['config', 'user.name', 'Onboarding Fixture']);
        git(cwd, ['config', 'user.email', 'fixture@example.invalid']);
        state.cloned = cwd;
        state.beforePublish?.(cwd);
      }
      if (state.ghFailure?.(args)) return { code: -1, stdout: '', stderr: 'injected gh failure' };
      if (args[0] === 'auth') return { code: 0, stdout: 'workflow', stderr: '' };
      if (args[0] === 'api') return { code: 0, stdout: 'true\n', stderr: '' };
      if (args[0] === 'pr') return { code: 0, stdout: 'https://github.com/acme/project/pull/1\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    tracker: {
      normalizeRepoPath: (value) => path.resolve(value),
      loadRegistry: () => structuredClone(state.registry),
      defaultRepoEntry: (value) => ({ ...value, autoPush: false }),
      saveRegistry: (value) => { state.saves++; state.registry = structuredClone(value); },
      logActivity: () => { state.logs++; },
    },
    loadFleet: () => ({ repos: [] }),
    saveFleet: () => { state.fleets++; },
  };
  t.after(() => {
    for (const clone of state.clones) assert.equal(fs.existsSync(clone), false, 'every temporary clone must be cleaned');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { root, source, outside, state, deps };
}

test('onboarding uses a private clone, preserves dirty caller and enrolls only verified canonical caller', async (t) => {
  const { source, state, deps } = fixture(t);
  const before = git(source, ['status', '--porcelain=v1', '-z', '-uall']);
  const branch = git(source, ['rev-parse', '--abbrev-ref', 'HEAD']);
  let publishedContributing;
  const originalGit = deps.git;
  deps.git = async (args, opts) => {
    if (args[0] === 'commit') publishedContributing = fs.readFileSync(path.join(opts.cwd, 'CONTRIBUTING.md'), 'utf8');
    return originalGit(args, opts);
  };
  const result = await onboardRepo({ name: 'acme/project', path: source }, deps);
  assert.equal(result.prNumber, 1);
  assert.equal(state.registry.repos[0].path, fs.realpathSync(source));
  assert.equal(state.saves, 1); assert.equal(state.fleets, 1);
  assert.equal(git(source, ['status', '--porcelain=v1', '-z', '-uall']), before);
  assert.equal(git(source, ['rev-parse', '--abbrev-ref', 'HEAD']), branch);
  assert.equal(fs.readFileSync(path.join(source, 'README.md'), 'utf8'), 'Uncommitted caller work\n');
  assert.match(publishedContributing, /^Operator contribution policy 世界 🌍/);
  assert.match(publishedContributing, /BEGIN relaybridge-contributing/);
});

test('no-checkout onboarding never enrolls its disposable clone', async (t) => {
  const { state, deps } = fixture(t);
  const result = await onboardRepo({ name: 'acme/project' }, deps);
  assert.equal(result.prNumber, 1);
  assert.equal(state.saves, 0);
  assert.ok(result.skipped.some((item) => item.startsWith('registry entry (no local')));
});

test('invalid caller root, effective origins and existing registry conflicts fail before any external mutation', async (t) => {
  for (const mode of ['subdirectory', 'fetch-rewrite', 'push-rewrite', 'multiple-push', 'registry-conflict']) {
    await t.test(mode, async (sub) => {
      const { source, outside, state, deps } = fixture(sub);
      let supplied = source;
      if (mode === 'subdirectory') { supplied = path.join(source, 'nested'); fs.mkdirSync(supplied); }
      if (mode === 'fetch-rewrite') git(source, ['config', 'url.https://example.invalid/.insteadOf', 'https://github.com/']);
      if (mode === 'push-rewrite') git(source, ['config', 'url.https://example.invalid/.pushInsteadOf', 'https://github.com/']);
      if (mode === 'multiple-push') {
        git(source, ['remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/acme/project.git']);
        git(source, ['remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/acme/other.git']);
      }
      if (mode === 'registry-conflict') state.registry.repos.push({ name: 'acme/project', path: outside });
      await assert.rejects(onboardRepo({ name: 'acme/project', path: supplied }, deps), /onboarding_/);
      assert.equal(state.calls.filter((call) => call[0] === 'gh').length, 0);
      assert.equal(state.saves, 0); assert.equal(state.fleets, 0);
    });
  }
});

test('repository symlinked targets reject before label or registry mutations and leave outside bytes intact', async (t) => {
  const { source, outside, state, deps } = fixture(t);
  fs.writeFileSync(path.join(outside, 'sentinel'), 'outside original');
  state.beforePublish = (cwd) => fs.symlinkSync(outside, path.join(cwd, '.github'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(onboardRepo({ name: 'acme/project', path: source }, deps), /unsafe_onboarding_directory/);
  assert.equal(state.calls.some((call) => call[0] === 'gh' && ['label', 'pr'].includes(call[1])), false);
  assert.equal(state.saves, 0); assert.equal(state.fleets, 0);
  assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'outside original');
});

test('clone, fetch, commit and PR errors clean temporary trees and cannot masquerade as current/enrolled success', async (t) => {
  for (const phase of ['clone', 'fetch', 'commit', 'pr']) {
    await t.test(phase, async (sub) => {
      const { source, state, deps } = fixture(sub);
      state.gitFailure = (args) => args[0] === phase;
      state.ghFailure = (args) => args[0] === phase || (phase === 'clone' && args[0] === 'repo');
      await assert.rejects(onboardRepo({ name: 'acme/project', path: source }, deps), /failed/);
      assert.equal(state.saves, 0); assert.equal(state.fleets, 0); assert.equal(state.logs, 0);
    });
  }
});

test('identity output overflow fails closed before clone or writes', async (t) => {
  const { source, state, deps } = fixture(t);
  const originalGit = deps.git;
  deps.git = (args, opts) => args[0] === 'rev-parse'
    ? runBoundedCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(2000000))"], opts)
    : originalGit(args, opts);
  await assert.rejects(onboardRepo({ name: 'acme/project', path: source }, deps), /identity_unavailable/);
  assert.equal(state.clones.length, 0); assert.equal(state.saves, 0);
});

test('supplied empty or non-string checkout paths cannot silently trigger clone-only onboarding', async (t) => {
  const { state, deps } = fixture(t);
  for (const supplied of ['', '   ', false, 0, {}, []]) {
    await assert.rejects(onboardRepo({ name: 'acme/project', path: supplied }, deps), { code: 'invalid_onboarding_checkout_path' });
  }
  assert.equal(state.calls.length, 0);
});

test('production Git runner ignores inherited repository/index/config redirections', async (t) => {
  const { source, outside, deps, state } = fixture(t);
  delete deps.git;
  // Deliberately wrong requested identity stops before gh. The inspected
  // repository must be the caller despite inherited Git authority variables.
  const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
  const saved = keys.map((key) => [key, process.env[key]]);
  Object.assign(process.env, { GIT_DIR: path.join(outside, 'missing.git'), GIT_WORK_TREE: outside,
    GIT_INDEX_FILE: path.join(outside, 'redirect-index'), GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'remote.origin.url', GIT_CONFIG_VALUE_0: 'https://github.com/acme/other.git' });
  try {
    await assert.rejects(onboardRepo({ name: 'acme/other', path: source }, deps), { code: 'onboarding_checkout_origin_mismatch' });
    assert.equal(state.calls.length, 0);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('cleanup failure preserves the original error and reports retained private-clone identity', async (t) => {
  const { source, state, deps } = fixture(t);
  state.ghFailure = (args) => args[0] === 'repo';
  const remove = fs.rmSync;
  fs.rmSync = (target, options) => {
    if (state.clones.includes(target)) throw Object.assign(new Error('injected cleanup busy'), { code: 'EBUSY' });
    return remove(target, options);
  };
  try {
    await assert.rejects(onboardRepo({ name: 'acme/project', path: source }, deps), (error) => {
      assert.match(error.message, /temporary clone failed: injected gh failure/);
      assert.match(error.message, /cleanup failed \(private clone retained\)/);
      assert.equal(error.cleanupFailure.code, 'onboarding_cleanup_failed');
      assert.equal(error.cleanupFailure.retainedPath, state.clones[0]);
      assert.equal(fs.existsSync(error.cleanupFailure.retainedPath), true);
      return true;
    });
  } finally {
    fs.rmSync = remove;
    for (const clone of state.clones) remove(clone, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
