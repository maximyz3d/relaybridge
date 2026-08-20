'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tracker = require('../lib/github-tracker');
const onboard = require('../lib/github-onboard');

// ---- run association -------------------------------------------------------

test('parseRunTags reads issue, bump, and explicit version from a prompt', () => {
  const t = tracker.parseRunTags('Fix the pinch valve logic #412 bump:minor');
  assert.equal(t.issue, 412);
  assert.equal(t.bump, 'minor');
  assert.equal(t.setVersion, null);
  const t2 = tracker.parseRunTags('big overhaul issue:9 version:2.0.0');
  assert.equal(t2.issue, 9);
  assert.equal(t2.setVersion, '2.0.0');
});

test('parseRunTags does not misread hex colors or markdown headers as issues', () => {
  assert.equal(tracker.parseRunTags('set the panel to #1b222b').issue, null);
  assert.equal(tracker.parseRunTags('## heading only').issue, null);
});

test('bump labels default to patch and honor explicit versions', () => {
  const repo = tracker.defaultRepoEntry({ name: 'a/b', path: '/x' });
  assert.equal(tracker.bumpLabelFor({ bump: null, setVersion: null }, repo), 'bump:patch');
  assert.equal(tracker.bumpLabelFor({ bump: 'major', setVersion: null }, repo), 'bump:major');
  assert.equal(tracker.bumpLabelFor({ bump: null, setVersion: '1.4.0' }, repo), 'set-version:1.4.0');
});

// ---- secret skip-list ------------------------------------------------------

test('the secret skip-list blocks credentials even when not gitignored', () => {
  for (const bad of ['.env', '.env.production', 'server.pem', 'deploy.key',
    'id_rsa', 'credentials.json', '.bridge-token', 'aws-secrets.yaml', 'api_token.txt',
    '.npmrc', '.netrc', 'accesstoken.json', 'refreshcredential.toml', '.pgpass',
    '.pypirc', '.envrc', 'deploy_key', 'nested/deploy_key', 'prod.env', 'staging.env',
    '.docker/config.json', 'nested/.docker/config.json', 'service-account.json',
    'service-account-key.json', 'gcp-key.json', 'my-app-sa-key.json']) {
    assert.ok(tracker.isSecretPath(bad), `${bad} must be skipped`);
  }
  for (const ok of ['server.js', 'README.md', 'lib/github-tracker.js', 'docs/DEVLOG.md', 'monkey.ts']) {
    assert.ok(!tracker.isSecretPath(ok), `${ok} must not be skipped`);
  }
  const { safe, skipped } = tracker.partitionSecretPaths(['a.js', '.env', 'b.md']);
  assert.deepEqual(safe, ['a.js', 'b.md']);
  assert.deepEqual(skipped, ['.env']);
});

test('tracking user attribution is bounded at the library boundary', () => {
  const bounded = tracker.boundedTrackingUser(`  user\u0000name-${'x'.repeat(200)}  `);
  assert.equal(bounded.length, 80);
  assert.doesNotMatch(bounded, /[\u0000-\u001f\u007f]/);
  assert.equal(tracker.boundedTrackingUser('   '), null);
});

// ---- registry --------------------------------------------------------------

test('registry entries default to safe settings (autoPush off, bump dictation on)', () => {
  const e = tracker.defaultRepoEntry({ name: 'o/r', path: '/tmp/r' });
  assert.equal(e.autoPush, false);
  assert.equal(e.versioning.dictateBump, true);
  assert.equal(e.versioning.defaultBump, 'patch');
  assert.equal(e.trackingMode, 'checkpoint-on-branch');
});

test('loadRegistry validates names and tracking modes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-'));
  const file = path.join(dir, 'repos.json');
  fs.writeFileSync(file, JSON.stringify({ repos: [{ name: 'not a repo', path: '/x' }] }));
  assert.throws(() => tracker.loadRegistry(file), /invalid repo name/);
  fs.writeFileSync(file, JSON.stringify({ repos: [{ name: 'o/r', path: '/x', trackingMode: 'yolo' }] }));
  assert.throws(() => tracker.loadRegistry(file), /unknown trackingMode/);
  fs.writeFileSync(file, JSON.stringify({ repos: [{ name: 'o/r', path: '/x' }] }));
  assert.equal(tracker.loadRegistry(file).repos[0].autoPush, false);
});

test('repoForCwd matches nested paths and prefers the deepest enrolled root', () => {
  const registry = { repos: [
    tracker.defaultRepoEntry({ name: 'o/outer', path: '/work/outer' }),
    tracker.defaultRepoEntry({ name: 'o/inner', path: '/work/outer/vendor/inner' }),
  ] };
  assert.equal(tracker.repoForCwd('/work/outer/src', registry).name, 'o/outer');
  assert.equal(tracker.repoForCwd('/work/outer/vendor/inner/lib', registry).name, 'o/inner');
  assert.equal(tracker.repoForCwd('/somewhere/else', registry), null);
  assert.equal(tracker.repoForCwd(null, registry), null);
});

test('an unenrolled cwd is a strict no-op', async () => {
  const r = await tracker.trackRun({ runId: 'r1', kind: 'claude', prompt: 'x', cwd: '/nope' }, { repos: [] });
  assert.equal(r.tracked, false);
  assert.match(r.reason, /not enrolled/);
});

// ---- commit message / devlog ----------------------------------------------

test('checkpoint commits carry run id, intent, issue, and attribution', () => {
  const msg = tracker.checkpointMessage({
    runId: 'run_abc', intent: 'Fix Z-axis pin swap detection', issue: 17,
    files: ['lib/a.js', 'docs/DEVLOG.md'], provider: 'claude', user: 'sover',
  });
  assert.match(msg, /^relaybridge\(run run_abc\): Fix Z-axis pin swap detection \[#17\]/);
  assert.match(msg, /provider: claude/);
  assert.match(msg, /user: sover/);
  assert.match(msg, /- lib\/a\.js/);
});

test('devlog entries are structured and bounded', () => {
  const entry = tracker.devlogEntry({ runId: 'r', ts: '2026-08-18T00:00:00Z', user: 'u', provider: 'p', issue: 3, intent: 'x'.repeat(999), diffstat: ' 1 file changed' });
  assert.match(entry, /run r/);
  assert.match(entry, /issue: #3/);
  assert.ok(entry.length < 1200, 'devlog entries must stay bounded');
});

// ---- onboarding templates --------------------------------------------------

test('canonical templates exist and carry rb-template versions', () => {
  for (const t of onboard.TEMPLATE_TARGETS) {
    const f = path.join(onboard.TEMPLATE_DIR, t.src);
    assert.ok(fs.existsSync(f), `template ${t.src} must exist`);
  }
  assert.ok(onboard.canonicalVersion() >= 1);
  assert.equal(onboard.templateVersion('# rb-template v3\nname: x'), 3);
  assert.equal(onboard.templateVersion('no header'), 0);
});

test('version-on-merge template keeps history append-only and claim template warns on duplicates', () => {
  const vm = fs.readFileSync(path.join(onboard.TEMPLATE_DIR, 'version-on-merge.yml'), 'utf8');
  assert.match(vm, /aborting to keep history append-only/);
  assert.match(vm, /bump:major/);
  assert.doesNotMatch(vm, /--notes[^\n]*\$\{\{\s*github\.event\.pull_request\.title\s*\}\}/,
    'untrusted PR titles must not be interpolated directly into a shell script');
  assert.match(vm, /RELEASE_NOTES:/, 'release notes must cross into the shell through env');
  const claim = fs.readFileSync(path.join(onboard.TEMPLATE_DIR, 'claim-on-start.yml'), 'utf8');
  assert.match(claim, /Possible duplicate work/);
});

test('labels.json provides every label the workflows key off', () => {
  const labels = JSON.parse(fs.readFileSync(path.join(onboard.TEMPLATE_DIR, 'labels.json'), 'utf8'));
  const names = labels.map((l) => l.name);
  for (const need of ['bump:patch', 'bump:minor', 'bump:major']) assert.ok(names.includes(need), need);
});

// ---- regression: secret skip-list vs untracked directories -----------------
// `git status --porcelain` collapses an untracked directory to one "newdir/"
// entry. The skip-list would see a directory name (never a secret) and
// `git add newdir/` would then stage newdir/.env. -uall lists files
// individually, which is what makes the guarantee real.

const { execFileSync } = require('child_process');

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgit-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'x');
  g('add', '-A'); g('commit', '-qm', 'init');
  return { dir, g };
}

test('secrets inside a NEW directory are still caught (the -uall guarantee)', () => {
  const { dir, g } = tempRepo();
  fs.mkdirSync(path.join(dir, 'feature'));
  fs.writeFileSync(path.join(dir, 'feature', 'app.js'), 'code');
  fs.writeFileSync(path.join(dir, 'feature', '.env'), 'SECRET=hunter2');

  const collapsed = execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString();
  assert.match(collapsed, /feature\//, 'precondition: plain porcelain collapses the directory');

  const raw = execFileSync('git', ['status', '--porcelain', '-uall', '-z'], { cwd: dir }).toString();
  const paths = tracker.parsePorcelainZ(raw);
  assert.ok(paths.includes('feature/.env'), 'the secret must be listed individually');
  const { safe, skipped } = tracker.partitionSecretPaths(paths);
  assert.ok(skipped.includes('feature/.env'), 'the secret must be SKIPPED');
  assert.ok(safe.includes('feature/app.js'), 'the real work must still be staged');
  assert.ok(!safe.some((p) => p.endsWith('.env')), 'no .env may reach the staging set');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a pre-staged secret is never included in checkpoint or devlog commits', async () => {
  const { dir, g } = tempRepo();
  g('checkout', '-qb', 'feature/safe-checkpoint');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=hunter2');
  fs.writeFileSync(path.join(dir, 'safe.js'), 'module.exports = 1;');
  g('add', '--', '.env');
  const registry = { repos: [{
    ...tracker.defaultRepoEntry({ name: 'o/r', path: dir }),
    dryRun: false,
    autoPush: false,
  }] };

  const result = await tracker.trackRun({
    runId: 'run_safe', kind: 'claude', prompt: 'checkpoint safe work', cwd: dir,
  }, registry);

  assert.equal(result.tracked, true);
  assert.ok(result.secretsSkipped.includes('.env'));
  const committed = g('log', '--format=', '--name-only', '-2').toString().split(/\r?\n/).filter(Boolean);
  assert.ok(committed.includes('safe.js'));
  assert.ok(committed.includes('docs/DEVLOG.md'));
  assert.ok(!committed.includes('.env'), 'pre-staged secret must not enter either commit');
  assert.match(g('status', '--porcelain').toString(), /^A  \.env/m, 'the caller\'s staged secret remains staged but uncommitted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('paths with spaces and non-ASCII survive parsing (-z, no octal escapes)', () => {
  const { dir } = tempRepo();
  fs.mkdirSync(path.join(dir, 'dir with space'));
  fs.writeFileSync(path.join(dir, 'dir with space', 'café.js'), 'y');
  const paths = tracker.parsePorcelainZ(
    execFileSync('git', ['status', '--porcelain', '-uall', '-z'], { cwd: dir }).toString());
  assert.ok(paths.includes('dir with space/café.js'), `got ${JSON.stringify(paths)}`);
  assert.ok(!paths.some((p) => p.includes('\\303')), 'octal escapes must not survive into a path');
  // The parsed path must be usable as-is by git add.
  execFileSync('git', ['add', '--', ...paths], { cwd: dir });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('renames yield both new and old paths so the deletion is staged', () => {
  const raw = 'R  new/name.js\0old/name.js\0M  other.js\0';
  assert.deepEqual(tracker.parsePorcelainZ(raw), ['new/name.js', 'old/name.js', 'other.js']);
});

test('rollback creates a branch WITHOUT switching the working tree', async () => {
  const { dir, g } = tempRepo();
  g('tag', '-a', 'v1.0.0', '-m', 'v1');
  g('checkout', '-qb', 'wip');
  fs.writeFileSync(path.join(dir, 'inprogress.txt'), 'uncommitted work');
  const registry = { repos: [tracker.defaultRepoEntry({ name: 'o/r', path: dir })] };

  const res = await tracker.checkoutVersion('o/r', 'v1.0.0', registry);
  assert.match(res.branch, /^restore\/v1\.0\.0-/);
  assert.equal(res.switched, false);
  const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).toString().trim();
  assert.equal(head, 'wip', 'the working branch must be left alone');
  assert.ok(fs.existsSync(path.join(dir, 'inprogress.txt')), 'uncommitted work must survive');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rollback refuses a tag that does not exist', async () => {
  const { dir } = tempRepo();
  const registry = { repos: [tracker.defaultRepoEntry({ name: 'o/r', path: dir })] };
  await assert.rejects(() => tracker.checkoutVersion('o/r', 'v9.9.9', registry), /not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});
