'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  githubRepoFromOrigin, gitEnvironment, validateCheckoutIdentity, prepareTemplateTargets, publishTemplateTargets,
} = require('../lib/onboard-safety');

function git(args, opts = {}) {
  const result = spawnSync('git', args, { ...opts, encoding: 'utf8', windowsHide: true });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-onboard-safety-'));
  const root = path.join(temp, 'repo');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const run = (...args) => {
    const result = git(args, { cwd: root, env: gitEnvironment() });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  run('init', '-q');
  run('config', 'user.name', 'RelayBridge Test');
  run('config', 'user.email', 'relaybridge-test@example.invalid');
  run('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  return { root, temp, run };
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function prepare(root, relativePaths, options = {}) {
  return prepareTemplateTargets({ root, relativePaths, gitRun: git, ...options });
}

test('GitHub origin parsing accepts only unambiguous credential-free GitHub repository identities', () => {
  for (const origin of ['https://github.com/Owner/Repo.git', 'git@github.com:owner/repo.git', 'ssh://git@github.com/owner/repo']) {
    assert.equal(githubRepoFromOrigin(origin), 'owner/repo');
  }
  for (const origin of [
    'https://github.com.evil/owner/repo', 'https://token@github.com/owner/repo',
    'https://github.com/owner/repo?secret=x', 'https://github.com/owner/repo#fragment',
    'https://github.com/owner/repo/extra', 'http://github.com/owner/repo',
    'ssh://other@github.com/owner/repo', 'git@elsewhere:owner/repo',
    '/local/repo', 'owner/repo', 'https://github.com/owner/repo\nhttps://github.com/owner/repo',
    'https://github.com/owner/%72epo',
  ]) assert.equal(githubRepoFromOrigin(origin), null, origin);
  const env = gitEnvironment({ PATH: 'keep', GIT_DIR: 'bad', GIT_WORK_TREE: 'bad',
    GIT_INDEX_FILE: 'bad', GIT_COMMON_DIR: 'bad', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'bad', GH_HOST: 'evil' });
  assert.deepEqual(env, { PATH: 'keep', GH_HOST: 'github.com', GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' });
});

test('checkout identity checks exact root and both fetch/push origins without changing dirty work', async (t) => {
  const { root, run } = fixture(t);
  write(path.join(root, 'file'), 'committed'); run('add', 'file'); run('commit', '-qm', 'fixture');
  write(path.join(root, 'file'), 'dirty bytes');
  const before = run('status', '--porcelain=v1');
  const identity = await validateCheckoutIdentity({ requestedRepo: 'OWNER/REPO', checkoutPath: root, gitRun: git });
  assert.equal(identity.canonicalRoot, fs.realpathSync.native ? fs.realpathSync.native(root) : fs.realpathSync(root));
  assert.equal(identity.canonicalRepo, 'owner/repo');
  assert.equal(run('status', '--porcelain=v1'), before);
  assert.equal(fs.readFileSync(path.join(root, 'file'), 'utf8'), 'dirty bytes');
  const nested = path.join(root, 'nested'); fs.mkdirSync(nested);
  await assert.rejects(validateCheckoutIdentity({ requestedRepo: 'owner/repo', checkoutPath: nested, gitRun: git }),
    { code: 'onboarding_checkout_must_be_root' });
  for (const url of ['https://github.com/owner/other.git', 'https://secret@github.com/owner/repo']) {
    run('remote', 'set-url', '--push', 'origin', url);
    await assert.rejects(validateCheckoutIdentity({ requestedRepo: 'owner/repo', checkoutPath: root, gitRun: git }),
      (error) => error.code === 'onboarding_checkout_origin_mismatch' && !error.message.includes('secret'));
  }
});

test('linked worktrees are accepted but ambiguous origins are rejected', async (t) => {
  const { root, temp, run } = fixture(t);
  write(path.join(root, 'file'), 'committed'); run('add', 'file'); run('commit', '-qm', 'fixture');
  const linked = path.join(temp, 'linked');
  run('worktree', 'add', '-q', '-b', 'fixture-linked', linked);
  assert.equal(fs.lstatSync(path.join(linked, '.git')).isFile(), true);
  assert.equal((await validateCheckoutIdentity({ requestedRepo: 'owner/repo', checkoutPath: linked, gitRun: git })).canonicalRepo, 'owner/repo');
  run('remote', 'set-url', '--add', 'origin', 'https://github.com/owner/repo.git');
  await assert.rejects(validateCheckoutIdentity({ requestedRepo: 'owner/repo', checkoutPath: root, gitRun: git }),
    { code: 'onboarding_checkout_origin_mismatch' });
});

test('template planning reads immutable Git blobs and publication creates/replaces only planned paths', async (t) => {
  const { root, run } = fixture(t);
  write(path.join(root, 'CONTRIBUTING.md'), 'preserve this\n'); run('add', 'CONTRIBUTING.md');
  const io = Object.create(fs);
  io.readFileSync = () => { throw new Error('destination path bytes must never be read'); };
  const plan = await prepare(root, ['CONTRIBUTING.md', '.github/workflows/new.yml'], { fsApi: io });
  assert.equal(plan.targets[0].text, 'preserve this\n');
  assert.equal(plan.targets[1].text, null);
  publishTemplateTargets({ plan, writes: [
    { relative: 'CONTRIBUTING.md', content: plan.targets[0].text + 'managed addition\n' },
    { relative: '.github/workflows/new.yml', content: 'workflow bytes\n' },
  ] });
  assert.equal(fs.readFileSync(path.join(root, 'CONTRIBUTING.md'), 'utf8'), 'preserve this\nmanaged addition\n');
  assert.equal(fs.readFileSync(path.join(root, '.github/workflows/new.yml'), 'utf8'), 'workflow bytes\n');
  assert.ok(!fs.readdirSync(root).some((name) => name.startsWith('.rb-template-')));
});

test('repository-controlled directory symlinks/junctions reject before any content read', async (t) => {
  const { root, temp } = fixture(t);
  const outside = path.join(temp, 'outside'); fs.mkdirSync(outside);
  write(path.join(outside, 'sentinel'), 'outside bytes');
  fs.symlinkSync(outside, path.join(root, '.github'), process.platform === 'win32' ? 'junction' : 'dir');
  let reads = 0;
  const io = Object.create(fs);
  io.readFileSync = () => { reads += 1; throw new Error('no read allowed'); };
  await assert.rejects(prepare(root, ['CONTRIBUTING.md', '.github/workflows/new.yml'], { fsApi: io }),
    { code: 'unsafe_onboarding_directory' });
  assert.equal(reads, 0);
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'outside bytes');
  assert.equal(fs.existsSync(path.join(root, 'CONTRIBUTING.md')), false);
});

test('materialized tracked symlinks and gitlink ancestors reject from index modes', async (t) => {
  const { root, run } = fixture(t);
  write(path.join(root, 'CONTRIBUTING.md'), 'outside-target');
  const oid = run('hash-object', '-w', 'CONTRIBUTING.md');
  run('update-index', '--add', '--cacheinfo', `120000,${oid},CONTRIBUTING.md`);
  await assert.rejects(prepare(root, ['CONTRIBUTING.md']), { code: 'unsafe_onboarding_index_mode' });
  run('update-index', '--force-remove', 'CONTRIBUTING.md');
  fs.unlinkSync(path.join(root, 'CONTRIBUTING.md'));
  write(path.join(root, 'file'), 'fixture'); run('add', 'file'); run('commit', '-qm', 'fixture');
  const commit = run('rev-parse', 'HEAD');
  fs.mkdirSync(path.join(root, '.github'));
  run('update-index', '--add', '--cacheinfo', `160000,${commit},.github`);
  await assert.rejects(prepare(root, ['.github/workflows/new.yml']), { code: 'unsafe_onboarding_index_mode' });
});

test('leaf symlink and dangling symlink targets reject without reading outside bytes', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { root, temp } = fixture(t);
  const outside = path.join(temp, 'outside'); write(outside, 'secret outside bytes');
  for (const target of [outside, path.join(temp, 'absent')]) {
    const leaf = path.join(root, 'CONTRIBUTING.md');
    fs.symlinkSync(target, leaf);
    await assert.rejects(prepare(root, ['CONTRIBUTING.md']), { code: 'unsafe_onboarding_template' });
    fs.unlinkSync(leaf);
  }
  assert.equal(fs.readFileSync(outside, 'utf8'), 'secret outside bytes');
});

test('changed destination or ancestor rejects before publication', async (t) => {
  const { root, temp, run } = fixture(t);
  write(path.join(root, '.github/workflows/existing.yml'), 'original'); run('add', '.github');
  const plan = await prepare(root, ['.github/workflows/existing.yml']);
  write(path.join(root, '.github/workflows/existing.yml'), 'concurrent edit');
  assert.throws(() => publishTemplateTargets({ plan, writes: [{ relative: '.github/workflows/existing.yml', content: 'replacement' }] }),
    { code: 'onboarding_template_changed' });
  assert.equal(fs.readFileSync(path.join(root, '.github/workflows/existing.yml'), 'utf8'), 'concurrent edit');
  const next = await prepare(root, ['.github/workflows/existing.yml']);
  const outside = path.join(temp, 'outside'); fs.mkdirSync(outside);
  fs.renameSync(path.join(root, '.github'), path.join(root, '.github-held'));
  fs.symlinkSync(outside, path.join(root, '.github'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => publishTemplateTargets({ plan: next, writes: [{ relative: '.github/workflows/existing.yml', content: 'replacement' }] }),
    { code: 'unsafe_onboarding_directory' });
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('unplanned, duplicate, traversing and untracked template targets fail closed', async (t) => {
  const { root } = fixture(t);
  for (const relative of ['../escape', '/absolute', 'a\\escape', 'a/../escape', 'file:stream', '.git/../escape']) {
    await assert.rejects(prepare(root, [relative]), { code: 'invalid_onboarding_target' });
  }
  write(path.join(root, 'CONTRIBUTING.md'), 'untracked bytes');
  await assert.rejects(prepare(root, ['CONTRIBUTING.md']), { code: 'untracked_onboarding_template' });
  const plan = await prepare(root, ['new.md']);
  for (const writes of [
    [{ relative: '../escape', content: 'bad' }],
    [{ relative: 'new.md', content: 'one' }, { relative: 'new.md', content: 'two' }],
  ]) assert.throws(() => publishTemplateTargets({ plan, writes }), { code: 'invalid_onboarding_write' });
  assert.equal(fs.existsSync(path.join(root, 'new.md')), false);
});
