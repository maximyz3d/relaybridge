'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tracker = require('../lib/github-tracker');
const onboard = require('../lib/github-onboard');
const HOST_PLATFORM = process.platform === 'win32'
  ? { isWindows: true, isWSL: false, label: 'Windows' }
  : { isWindows: false, isWSL: false, label: 'POSIX' };
const posixOnly = process.platform === 'win32' ? test.skip : test;

function assertImmutableActionUses(source, action) {
  const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const uses = [...source.matchAll(new RegExp(`(?:^|\\n)\\s*- uses: ${escaped}@([^\\s#]+)`, 'g'))];
  assert.ok(uses.length > 0, `${action} must be used`);
  for (const [, revision] of uses) {
    assert.match(revision, /^[0-9a-f]{40}$/, `${action} must be pinned to an immutable commit SHA`);
  }
}

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
  const repoPath = path.join(dir, 'repo');
  fs.writeFileSync(file, JSON.stringify({ repos: [{ name: 'not a repo', path: repoPath }] }));
  assert.throws(() => tracker.loadRegistry(file), /invalid repo name/);
  fs.writeFileSync(file, JSON.stringify({ repos: [{ name: 'o/r', path: repoPath, trackingMode: 'yolo' }] }));
  assert.throws(() => tracker.loadRegistry(file), /unknown trackingMode/);
  fs.writeFileSync(file, JSON.stringify({ repos: [{ name: 'o/r', path: repoPath }] }));
  assert.equal(tracker.loadRegistry(file).repos[0].autoPush, false);
});

test('registry location precedence keeps machine state in ignored data', () => {
  const root = path.join(os.tmpdir(), 'rb-registry-root');
  const posixRoot = '/home/relaybridge/test-root';
  const relayData = path.join(os.tmpdir(), 'rb-relay-data');
  const psData = path.join(os.tmpdir(), 'rb-ps-data');
  const explicit = path.join(os.tmpdir(), 'rb-explicit', 'repos.json');

  assert.equal(tracker.registryPaths({ root, env: {} }).runtimeFile,
    path.join(root, 'data', 'github-repos.json'));
  assert.equal(tracker.registryPaths({ root, env: { PS_BRIDGE_DATA_DIR: psData } }).runtimeFile,
    path.join(psData, 'github-repos.json'));
  assert.equal(tracker.registryPaths({ root, env: {
    PS_BRIDGE_DATA_DIR: psData,
    RELAYBRIDGE_DATA_DIR: relayData,
  } }).runtimeFile, path.join(relayData, 'github-repos.json'));
  assert.equal(tracker.registryPaths({ root, env: {
    PS_BRIDGE_DATA_DIR: psData,
    RELAYBRIDGE_DATA_DIR: relayData,
    RELAYBRIDGE_GITHUB_REPOS: explicit,
  } }).runtimeFile, explicit);
  assert.throws(() => tracker.registryPaths({
    root: posixRoot,
    env: { RELAYBRIDGE_GITHUB_REPOS: '/mnt/c/relay/github-repos.json' },
    platform: { isWindows: false, isWSL: true, label: 'WSL' },
  }), /GitHub registry must use the WSL Linux filesystem/);
  for (const foreignPath of [
    'C:\\Users\\person\\RelayBridge\\github-repos.json',
    '\\\\fileserver\\relaybridge\\github-repos.json',
  ]) {
    for (const detected of [
      { isWindows: false, isWSL: false, label: 'POSIX' },
      { isWindows: false, isWSL: true, label: 'WSL' },
    ]) {
      assert.throws(() => tracker.registryPaths({
        root: posixRoot,
        env: { RELAYBRIDGE_GITHUB_REPOS: foreignPath },
        platform: detected,
      }), /GitHub registry file must be an absolute path/,
      `${detected.label} must reject the raw Windows path before resolving it under cwd`);
    }
  }
  assert.throws(() => tracker.registryPaths({
    root: posixRoot,
    env: { RELAYBRIDGE_DATA_DIR: 'C:\\Users\\person\\RelayBridge\\data' },
    platform: { isWindows: false, isWSL: true, label: 'WSL' },
  }), /GitHub registry data directory must be an absolute path/);
  assert.throws(() => tracker.registryPaths({
    root: posixRoot,
    env: {},
    runtimeFile: 'C:\\Users\\person\\RelayBridge\\github-repos.json',
    platform: { isWindows: false, isWSL: true, label: 'WSL' },
  }), /GitHub registry file must be an absolute path/);
  assert.throws(() => tracker.registryPaths({
    root: posixRoot,
    env: {},
    legacyFile: '\\\\fileserver\\relaybridge\\legacy.json',
    platform: { isWindows: false, isWSL: false, label: 'POSIX' },
  }), /legacy GitHub registry file must be an absolute path/);
  for (const foreignRoot of [
    'C:\\Users\\person\\RelayBridge',
    '\\\\fileserver\\relaybridge\\RelayBridge',
  ]) {
    assert.throws(() => tracker.registryPaths({
      root: foreignRoot,
      env: {},
      platform: { isWindows: false, isWSL: true, label: 'WSL' },
    }), /RelayBridge root must be an absolute path/,
    'options.root must be validated before native path resolution');
  }
});

test('onboarding preflight can read legacy registry authority without migration or writes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-registry-peek-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { root, env: {}, migrate: false };
  const paths = tracker.registryPaths(options);
  fs.mkdirSync(path.dirname(paths.legacyFile), { recursive: true });
  const original = JSON.stringify({ repos: [{ name: 'acme/project', path: root }] });
  fs.writeFileSync(paths.legacyFile, original);
  assert.equal(tracker.loadRegistry(undefined, options).repos[0].name, 'acme/project');
  assert.equal(fs.existsSync(paths.runtimeFile), false);
  assert.equal(fs.readFileSync(paths.legacyFile, 'utf8'), original);
  fs.mkdirSync(path.dirname(paths.runtimeFile), { recursive: true });
  fs.writeFileSync(paths.runtimeFile, '{bad json');
  assert.throws(() => tracker.loadRegistry(undefined, options));
  assert.equal(fs.readFileSync(paths.runtimeFile, 'utf8'), '{bad json');
});

posixOnly('migration CLI rejects raw Windows runtime and root paths before host normalization', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-cli-foreign-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tool = path.join(__dirname, '..', 'tools', 'migrate-github-registry.cjs');
  for (const fixture of [
    {
      args: ['--root', root, '--runtime-file', 'C:\\Users\\person\\RelayBridge\\github-repos.json'],
      expected: /GitHub registry file must be an absolute path/,
    },
    {
      args: ['--root', 'C:\\Users\\person\\RelayBridge'],
      expected: /RelayBridge root must be an absolute path/,
    },
    {
      args: ['--root', '\\\\fileserver\\relaybridge\\RelayBridge'],
      expected: /RelayBridge root must be an absolute path/,
    },
  ]) {
    const result = spawnSync(process.execPath, [tool, ...fixture.args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, fixture.expected);
  }
  assert.equal(fs.readdirSync(root).length, 0,
    'a foreign path must be rejected before it can become a cwd-relative state path');
});

test('a valid legacy registry is atomically migrated only when runtime is absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-migrate-'));
  const legacy = path.join(root, 'config', 'github-repos.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  const old = { repos: [{ name: 'o/r', path: path.join(root, 'repo'), autoPush: true }] };
  fs.writeFileSync(legacy, JSON.stringify(old));
  const options = {
    root,
    env: {},
    platform: HOST_PLATFORM,
  };

  const migrated = tracker.migrateLegacyRegistry(options);
  assert.equal(migrated.status, 'migrated');
  assert.equal(migrated.runtimeFile, path.join(root, 'data', 'github-repos.json'));
  assert.equal(tracker.loadRegistry(undefined, options).repos[0].name, 'o/r');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(migrated.runtimeFile).mode & 0o777, 0o600);
  }
});

posixOnly('migration never follows a publication-time target replacement for metadata writes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-migrate-publish-swap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = path.join(root, 'config', 'github-repos.json');
  const runtime = path.join(root, 'data', 'github-repos.json');
  const victim = path.join(root, 'outside-victim.txt');
  const victimBytes = 'external bytes must remain untouched\n';
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ repos: [] }));
  fs.writeFileSync(victim, victimBytes);
  fs.chmodSync(victim, 0o644);

  const originalLinkSync = fs.linkSync;
  const originalChmodSync = fs.chmodSync;
  let swapped = false;
  let targetChmods = 0;
  t.after(() => {
    fs.linkSync = originalLinkSync;
    fs.chmodSync = originalChmodSync;
  });
  fs.linkSync = (source, target) => {
    originalLinkSync.call(fs, source, target);
    fs.unlinkSync(target);
    fs.symlinkSync(victim, target);
    swapped = true;
  };
  fs.chmodSync = (file, ...args) => {
    if (path.resolve(String(file)) === runtime) targetChmods += 1;
    return originalChmodSync.call(fs, file, ...args);
  };

  const result = tracker.migrateLegacyRegistry({ root, env: {}, platform: HOST_PLATFORM });
  assert.equal(result.status, 'migrated');
  assert.equal(swapped, true, 'the adversary must replace the published directory entry');
  assert.equal(targetChmods, 0, 'migration must perform no path-based chmod after publication');
  assert.equal(fs.lstatSync(runtime).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(victim, 'utf8'), victimBytes);
  assert.equal(fs.statSync(victim).mode & 0o777, 0o644, 'victim permissions must remain unchanged');
});

posixOnly('legacy registry symlinks and dangling symlinks fail closed without reading target bytes', (t) => {
  for (const linkedTargetExists of [true, false]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-legacy-symlink-'));
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-legacy-external-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    t.after(() => fs.rmSync(externalRoot, { recursive: true, force: true }));
    const legacy = path.join(root, 'config', 'github-repos.json');
    const runtime = path.join(root, 'data', 'github-repos.json');
    const external = path.join(externalRoot, 'outside-registry.json');
    const externalBytes = JSON.stringify({
      repos: [{ name: 'external/bytes', path: path.join(externalRoot, 'repo') }],
    });
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    if (linkedTargetExists) fs.writeFileSync(external, externalBytes);
    fs.symlinkSync(external, legacy);

    const fsApi = Object.create(fs);
    let byteReads = 0;
    fsApi.readFileSync = (...args) => {
      byteReads += 1;
      throw new Error(`unexpected legacy byte read: ${String(args[0])}`);
    };

    assert.throws(() => tracker.migrateLegacyRegistry({
      root, env: {}, platform: HOST_PLATFORM, fsApi,
    }), /legacy GitHub registry.*must be a regular file; symbolic links are not allowed/);
    assert.equal(byteReads, 0, 'neither a live nor dangling legacy symlink may be followed');
    assert.equal(fs.existsSync(runtime), false, 'an unsafe legacy entry must not create runtime authority state');
    assert.equal(fs.lstatSync(legacy).isSymbolicLink(), true);
    if (linkedTargetExists) assert.equal(fs.readFileSync(external, 'utf8'), externalBytes);
  }
});

test('a legacy regular-file replacement after lstat is rejected before reading replacement bytes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-legacy-regular-swap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = path.join(root, 'config', 'github-repos.json');
  const runtime = path.join(root, 'data', 'github-repos.json');
  const replacement = path.join(root, 'replacement-registry.json');
  const replacementBytes = JSON.stringify({
    repos: [{ name: 'replacement/bytes', path: path.join(root, 'replacement') }],
  });
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ repos: [] }));
  fs.writeFileSync(replacement, replacementBytes);

  const fsApi = Object.create(fs);
  let swapped = false;
  let byteReads = 0;
  fsApi.lstatSync = (file, ...args) => {
    const stat = fs.lstatSync(file, ...args);
    if (!swapped && path.resolve(String(file)) === legacy) {
      fs.renameSync(replacement, legacy);
      swapped = true;
    }
    return stat;
  };
  fsApi.readFileSync = (...args) => {
    byteReads += 1;
    throw new Error(`unexpected legacy byte read: ${String(args[0])}`);
  };

  assert.throws(() => tracker.migrateLegacyRegistry({
    root, env: {}, platform: HOST_PLATFORM, fsApi,
  }), /cannot securely read legacy GitHub registry.*target changed before it could be opened/);
  assert.equal(swapped, true);
  assert.equal(byteReads, 0, 'replacement legacy bytes must not be read after inode identity changes');
  assert.equal(fs.readFileSync(legacy, 'utf8'), replacementBytes);
  assert.equal(fs.existsSync(runtime), false);
});

test('a legacy disappearance after initial lstat is an error, not a missing registry', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-legacy-disappear-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = path.join(root, 'config', 'github-repos.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ repos: [] }));

  const fsApi = Object.create(fs);
  let removed = false;
  let byteReads = 0;
  fsApi.lstatSync = (file, ...args) => {
    const stat = fs.lstatSync(file, ...args);
    if (!removed && path.resolve(String(file)) === legacy) {
      fs.unlinkSync(legacy);
      removed = true;
    }
    return stat;
  };
  fsApi.readFileSync = (...args) => {
    byteReads += 1;
    throw new Error(`unexpected legacy byte read: ${String(args[0])}`);
  };

  assert.throws(() => tracker.migrateLegacyRegistry({
    root, env: {}, platform: HOST_PLATFORM, fsApi,
  }), /cannot securely read legacy GitHub registry.*ENOENT/);
  assert.equal(removed, true);
  assert.equal(byteReads, 0);
});

posixOnly('a legacy regular-file-to-FIFO replacement is rejected without reading or blocking', (t) => {
  if (spawnSync('sh', ['-c', 'command -v mkfifo'], { encoding: 'utf8' }).status !== 0) {
    t.skip('mkfifo is unavailable');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-legacy-fifo-swap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = path.join(root, 'config', 'github-repos.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ repos: [] }));
  const script = `
    const fs = require('fs');
    const path = require('path');
    const { spawnSync } = require('child_process');
    const tracker = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'github-tracker.js'))});
    const root = ${JSON.stringify(root)};
    const target = ${JSON.stringify(legacy)};
    const originalLstatSync = fs.lstatSync;
    const originalReadFileSync = fs.readFileSync;
    let swapped = false;
    let byteReads = 0;
    fs.lstatSync = (file, ...args) => {
      const stat = originalLstatSync.call(fs, file, ...args);
      if (!swapped && path.resolve(String(file)) === target) {
        fs.unlinkSync(target);
        const made = spawnSync('mkfifo', [target]);
        if (made.status !== 0) process.exit(3);
        swapped = true;
      }
      return stat;
    };
    fs.readFileSync = (...args) => {
      byteReads += 1;
      throw new Error('unexpected legacy byte read');
    };
    try {
      tracker.migrateLegacyRegistry({
        root, env: {}, platform: { isWindows: false, isWSL: false, label: 'POSIX' },
      });
      process.exit(4);
    } catch (error) {
      process.stdout.write(JSON.stringify({
        rejected: /opened target is not a regular file/.test(error.message),
        swapped,
        byteReads,
      }));
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 2000,
  });
  assert.notEqual(result.error && result.error.code, 'ETIMEDOUT',
    'O_NONBLOCK must prevent a swapped legacy FIFO from hanging migration');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { rejected: true, swapped: true, byteReads: 0 });
});

test('an existing runtime registry always wins and legacy is never read or overwritten', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-runtime-wins-'));
  const runtime = path.join(root, 'data', 'github-repos.json');
  const legacy = path.join(root, 'config', 'github-repos.json');
  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  const current = `${JSON.stringify({ repos: [{ name: 'new/current', path: path.join(root, 'current') }] }, null, 2)}\n`;
  fs.writeFileSync(runtime, current);
  fs.writeFileSync(legacy, '{ definitely not JSON');
  const options = {
    root,
    env: {},
    platform: HOST_PLATFORM,
  };

  assert.equal(tracker.migrateLegacyRegistry(options).status, 'runtime-present');
  assert.equal(fs.readFileSync(runtime, 'utf8'), current);
  assert.equal(tracker.loadRegistry(undefined, options).repos[0].name, 'new/current');
});

test('a malformed runtime registry fails closed and is never replaced by valid legacy enrollment', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-invalid-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'data', 'github-repos.json');
  const legacy = path.join(root, 'config', 'github-repos.json');
  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  const invalidRuntime = '{ definitely not JSON';
  fs.writeFileSync(runtime, invalidRuntime);
  fs.writeFileSync(legacy, JSON.stringify({
    repos: [{ name: 'valid/legacy', path: path.join(root, 'legacy') }],
  }));
  const options = { root, env: {}, platform: HOST_PLATFORM };

  assert.throws(() => tracker.migrateLegacyRegistry(options), /not valid JSON/);
  assert.throws(() => tracker.loadRegistry(undefined, options), /not valid JSON/);
  assert.equal(fs.readFileSync(runtime, 'utf8'), invalidRuntime,
    'fail-closed validation must never overwrite the current authority entry');
});

posixOnly('runtime registry symlinks fail closed without suppressing valid legacy enrollment', (t) => {
  for (const linkedTargetExists of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-symlink-runtime-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runtime = path.join(root, 'data', 'github-repos.json');
    const legacy = path.join(root, 'config', 'github-repos.json');
    const linkedTarget = path.join(root, 'outside-registry.json');
    fs.mkdirSync(path.dirname(runtime), { recursive: true });
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    const legacyBytes = JSON.stringify({
      repos: [{ name: 'valid/legacy', path: path.join(root, 'legacy') }],
    });
    fs.writeFileSync(legacy, legacyBytes);
    if (linkedTargetExists) fs.writeFileSync(linkedTarget, JSON.stringify({ repos: [] }));
    fs.symlinkSync(linkedTarget, runtime);
    const options = { root, env: {}, platform: HOST_PLATFORM };
    const originalReadFileSync = fs.readFileSync;
    let linkedTargetReads = 0;
    fs.readFileSync = (file, ...args) => {
      if (path.resolve(String(file)) === linkedTarget) linkedTargetReads += 1;
      return originalReadFileSync.call(fs, file, ...args);
    };

    try {
      assert.throws(() => tracker.migrateLegacyRegistry(options), /must be a regular file; symbolic links are not allowed/);
      assert.throws(() => tracker.loadRegistry(undefined, options), /must be a regular file; symbolic links are not allowed/,
        'a dangling symlink must not be converted from ENOENT into an empty registry');
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
    assert.equal(linkedTargetReads, 0, 'runtime symlink target bytes must never be read');
    assert.equal(fs.lstatSync(runtime).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(legacy, 'utf8'), legacyBytes);
  }
});

posixOnly('a symlink replacement after lstat is rejected without reading external bytes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-lstat-swap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const stripNoFollow of [false, true]) {
    const suffix = stripNoFollow ? 'fallback' : 'nofollow';
    const runtime = path.join(root, `${suffix}-github-repos.json`);
    const external = path.join(root, `${suffix}-external-registry.json`);
    const externalBytes = JSON.stringify({
      repos: [{ name: 'external/bytes', path: path.join(root, 'external') }],
    });
    fs.writeFileSync(runtime, JSON.stringify({ repos: [] }));
    fs.writeFileSync(external, externalBytes);

    const fsApi = Object.create(fs);
    let swapped = false;
    let observedFlags = null;
    let readCalls = 0;
    let closeCalls = 0;
    fsApi.lstatSync = (file, ...args) => {
      const stat = fs.lstatSync(file, ...args);
      if (!swapped && path.resolve(String(file)) === runtime) {
        fs.unlinkSync(runtime);
        fs.symlinkSync(external, runtime);
        swapped = true;
      }
      return stat;
    };
    fsApi.openSync = (file, flags, ...args) => {
      observedFlags = flags;
      const forwardedFlags = stripNoFollow
        ? flags & ~fs.constants.O_NOFOLLOW
        : flags;
      return fs.openSync(file, forwardedFlags, ...args);
    };
    fsApi.readFileSync = (...args) => {
      readCalls += 1;
      throw new Error(`unexpected registry byte read: ${String(args[0])}`);
    };
    fsApi.closeSync = (fd) => {
      closeCalls += 1;
      fs.closeSync(fd);
    };

    assert.throws(() => tracker.loadRegistry(runtime, { platform: HOST_PLATFORM, fsApi }),
      /cannot securely read GitHub registry/);
    assert.equal(swapped, true);
    assert.equal(observedFlags & fs.constants.O_NOFOLLOW, fs.constants.O_NOFOLLOW);
    assert.equal(observedFlags & fs.constants.O_NONBLOCK, fs.constants.O_NONBLOCK);
    assert.equal(readCalls, 0, 'neither no-follow nor identity fallback may read external bytes');
    assert.equal(closeCalls, stripNoFollow ? 1 : 0,
      'a fallback-opened descriptor must be closed after identity rejection');
    assert.equal(fs.lstatSync(runtime).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(external, 'utf8'), externalBytes);
  }
});

test('a regular-file replacement after lstat fails inode validation before reading bytes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-regular-swap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'github-repos.json');
  const replacement = path.join(root, 'replacement-registry.json');
  fs.writeFileSync(runtime, JSON.stringify({ repos: [] }));
  fs.writeFileSync(replacement, JSON.stringify({
    repos: [{ name: 'replacement/bytes', path: path.join(root, 'replacement') }],
  }));

  const originalLstatSync = fs.lstatSync;
  const originalReadFileSync = fs.readFileSync;
  let swapped = false;
  let descriptorReads = 0;
  t.after(() => {
    fs.lstatSync = originalLstatSync;
    fs.readFileSync = originalReadFileSync;
  });
  fs.lstatSync = (file, ...args) => {
    const stat = originalLstatSync.call(fs, file, ...args);
    if (!swapped && path.resolve(String(file)) === runtime) {
      fs.renameSync(replacement, runtime);
      swapped = true;
    }
    return stat;
  };
  fs.readFileSync = (file, ...args) => {
    if (typeof file === 'number') descriptorReads += 1;
    return originalReadFileSync.call(fs, file, ...args);
  };

  assert.throws(() => tracker.loadRegistry(runtime, { platform: HOST_PLATFORM }),
    /registry target changed before it could be opened/);
  assert.equal(swapped, true);
  assert.equal(descriptorReads, 0, 'replacement bytes must not be read after inode identity changes');
});

posixOnly('a regular-file-to-FIFO replacement is rejected without blocking', (t) => {
  if (spawnSync('sh', ['-c', 'command -v mkfifo'], { encoding: 'utf8' }).status !== 0) {
    t.skip('mkfifo is unavailable');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-fifo-swap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'github-repos.json');
  fs.writeFileSync(runtime, JSON.stringify({ repos: [] }));
  const script = `
    const fs = require('fs');
    const { spawnSync } = require('child_process');
    const tracker = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'github-tracker.js'))});
    const target = ${JSON.stringify(runtime)};
    const originalLstatSync = fs.lstatSync;
    let swapped = false;
    fs.lstatSync = (file, ...args) => {
      const stat = originalLstatSync.call(fs, file, ...args);
      if (!swapped && require('path').resolve(String(file)) === target) {
        fs.unlinkSync(target);
        const made = spawnSync('mkfifo', [target]);
        if (made.status !== 0) process.exit(3);
        swapped = true;
      }
      return stat;
    };
    try {
      tracker.loadRegistry(target, { platform: { isWindows: false, isWSL: false, label: 'POSIX' } });
      process.exit(4);
    } catch {
      process.stdout.write('rejected');
    }
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 2000,
  });
  assert.notEqual(result.error && result.error.code, 'ETIMEDOUT',
    'O_NONBLOCK must prevent a swapped FIFO from hanging registry startup');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'rejected');
});

test('a nonregular runtime target fails closed before legacy migration', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-directory-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'data', 'github-repos.json');
  const legacy = path.join(root, 'config', 'github-repos.json');
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({
    repos: [{ name: 'valid/legacy', path: path.join(root, 'legacy') }],
  }));
  const options = { root, env: {}, platform: HOST_PLATFORM };

  assert.throws(() => tracker.migrateLegacyRegistry(options), /target is not a regular file/);
  assert.throws(() => tracker.loadRegistry(undefined, options), /target is not a regular file/);
  assert.equal(fs.statSync(runtime).isDirectory(), true);
});

test('a migration race reports the winner and never overwrites its registry', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-migrate-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'data', 'github-repos.json');
  const legacy = path.join(root, 'config', 'github-repos.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  const old = `${JSON.stringify({ repos: [{ name: 'old/legacy', path: path.join(root, 'old') }] })}\n`;
  const winner = `${JSON.stringify({ repos: [{ name: 'race/winner', path: path.join(root, 'winner') }] })}\n`;
  fs.writeFileSync(legacy, old);

  const originalLinkSync = fs.linkSync;
  t.after(() => { fs.linkSync = originalLinkSync; });
  let raced = false;
  fs.linkSync = (source, target) => {
    assert.equal(target, runtime);
    assert.equal(fs.existsSync(target), false, 'the competing writer wins after the initial absence check');
    fs.writeFileSync(target, winner, { mode: 0o600 });
    raced = true;
    const error = new Error('destination exists');
    error.code = 'EEXIST';
    throw error;
  };

  const result = tracker.migrateLegacyRegistry({ root, env: {}, platform: HOST_PLATFORM });
  assert.equal(raced, true);
  assert.equal(result.status, 'runtime-present');
  assert.equal(fs.readFileSync(runtime, 'utf8'), winner, 'the losing migration must not replace the winner');
  assert.deepEqual(fs.readdirSync(path.dirname(runtime)).filter((name) => name.endsWith('.tmp')), [],
    'the losing private temp is removed');
});

test('a migration race rejects a malformed regular-file winner', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-migrate-invalid-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'data', 'github-repos.json');
  const legacy = path.join(root, 'config', 'github-repos.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({
    repos: [{ name: 'valid/legacy', path: path.join(root, 'legacy') }],
  }));

  const originalLinkSync = fs.linkSync;
  t.after(() => { fs.linkSync = originalLinkSync; });
  fs.linkSync = (_source, target) => {
    fs.writeFileSync(target, '{ malformed race winner', { mode: 0o600 });
    const error = new Error('destination exists');
    error.code = 'EEXIST';
    throw error;
  };

  assert.throws(() => tracker.migrateLegacyRegistry({ root, env: {}, platform: HOST_PLATFORM }),
    /not valid JSON/);
  assert.equal(fs.readFileSync(runtime, 'utf8'), '{ malformed race winner');
  assert.deepEqual(fs.readdirSync(path.dirname(runtime)).filter((name) => name.endsWith('.tmp')), []);
});

test('a migration race rejects a nonregular directory winner', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-migrate-directory-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'data', 'github-repos.json');
  const legacy = path.join(root, 'config', 'github-repos.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({
    repos: [{ name: 'valid/legacy', path: path.join(root, 'legacy') }],
  }));

  const originalLinkSync = fs.linkSync;
  t.after(() => { fs.linkSync = originalLinkSync; });
  fs.linkSync = (_source, target) => {
    fs.mkdirSync(target);
    const error = new Error('destination exists');
    error.code = 'EEXIST';
    throw error;
  };

  assert.throws(() => tracker.migrateLegacyRegistry({ root, env: {}, platform: HOST_PLATFORM }),
    /target is not a regular file/);
  assert.equal(fs.statSync(runtime).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(path.dirname(runtime)).filter((name) => name.endsWith('.tmp')), []);
});

test('load fails closed if an accepted migration race winner disappears', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-migrate-disappear-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'data', 'github-repos.json');
  const legacy = path.join(root, 'config', 'github-repos.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({
    repos: [{ name: 'valid/legacy', path: path.join(root, 'legacy') }],
  }));
  const winner = JSON.stringify({
    repos: [{ name: 'race/winner', path: path.join(root, 'winner') }],
  });

  const originalLinkSync = fs.linkSync;
  const originalOpenSync = fs.openSync;
  const originalReadFileSync = fs.readFileSync;
  const runtimeFds = new Set();
  t.after(() => {
    fs.linkSync = originalLinkSync;
    fs.openSync = originalOpenSync;
    fs.readFileSync = originalReadFileSync;
  });
  fs.linkSync = (_source, target) => {
    fs.writeFileSync(target, winner, { mode: 0o600 });
    const error = new Error('destination exists');
    error.code = 'EEXIST';
    throw error;
  };
  fs.openSync = (file, ...args) => {
    const fd = originalOpenSync.call(fs, file, ...args);
    if (path.resolve(String(file)) === runtime) runtimeFds.add(fd);
    return fd;
  };
  fs.readFileSync = (file, ...args) => {
    const bytes = originalReadFileSync.call(fs, file, ...args);
    if (typeof file === 'number' && runtimeFds.has(file)) fs.unlinkSync(runtime);
    return bytes;
  };

  assert.throws(() => tracker.loadRegistry(undefined, { root, env: {}, platform: HOST_PLATFORM }),
    /GitHub registry disappeared before it could be loaded/);
  assert.deepEqual(fs.readdirSync(path.dirname(runtime)).filter((name) => name.endsWith('.tmp')), []);
});

posixOnly('a migration race rejects a symlink winner without following it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-migrate-symlink-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'data', 'github-repos.json');
  const legacy = path.join(root, 'config', 'github-repos.json');
  const linkedTarget = path.join(root, 'winner-target.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({
    repos: [{ name: 'valid/legacy', path: path.join(root, 'legacy') }],
  }));
  const targetBytes = JSON.stringify({ repos: [] });
  fs.writeFileSync(linkedTarget, targetBytes);

  const originalLinkSync = fs.linkSync;
  const originalReadFileSync = fs.readFileSync;
  let linkedTargetReads = 0;
  t.after(() => { fs.linkSync = originalLinkSync; });
  t.after(() => { fs.readFileSync = originalReadFileSync; });
  fs.readFileSync = (file, ...args) => {
    if (path.resolve(String(file)) === linkedTarget) linkedTargetReads += 1;
    return originalReadFileSync.call(fs, file, ...args);
  };
  fs.linkSync = (_source, target) => {
    fs.symlinkSync(linkedTarget, target);
    const error = new Error('destination exists');
    error.code = 'EEXIST';
    throw error;
  };

  assert.throws(() => tracker.migrateLegacyRegistry({ root, env: {}, platform: HOST_PLATFORM }),
    /must be a regular file; symbolic links are not allowed/);
  fs.readFileSync = originalReadFileSync;
  assert.equal(linkedTargetReads, 0, 'an EEXIST symlink winner must be rejected before target bytes are read');
  assert.equal(fs.lstatSync(runtime).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(linkedTarget, 'utf8'), targetBytes);
  assert.deepEqual(fs.readdirSync(path.dirname(runtime)).filter((name) => name.endsWith('.tmp')), []);
});

test('invalid legacy enrollment fails closed without creating a runtime file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-invalid-legacy-'));
  const legacy = path.join(root, 'config', 'github-repos.json');
  const runtime = path.join(root, 'data', 'github-repos.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ repos: [{ name: 'o/r', path: 'relative/repo' }] }));
  assert.throws(() => tracker.migrateLegacyRegistry({
    root,
    env: {},
    platform: HOST_PLATFORM,
  }), /not migrated/);
  assert.equal(fs.existsSync(runtime), false);
});

test('registry paths are native to the host and WSL rejects DrvFs enrollments', () => {
  const windows = { isWindows: true, isWSL: false, label: 'Windows' };
  const linux = { isWindows: false, isWSL: false, label: 'Linux' };
  const wsl = { isWindows: false, isWSL: true, label: 'WSL' };

  assert.equal(tracker.normalizeRepoPath('C:\\Users\\person\\repo', {
    platform: windows, skipRealpath: true,
  }), 'C:\\Users\\person\\repo');
  assert.throws(() => tracker.normalizeRepoPath('\\rooted-but-drive-relative', {
    platform: windows, skipRealpath: true,
  }), /drive or UNC share/);
  assert.throws(() => tracker.normalizeRepoPath('C:\\Users\\person\\repo', {
    platform: linux, skipRealpath: true,
  }), /absolute|Windows path/);
  assert.equal(tracker.normalizeRepoPath('/home/person/repo', {
    platform: wsl, env: {}, skipRealpath: true,
  }), '/home/person/repo');
  assert.throws(() => tracker.normalizeRepoPath('/mnt/c/Users/person/repo', {
    platform: wsl, env: {}, skipRealpath: true,
  }), /Linux filesystem, not \/mnt/);
  assert.equal(tracker.normalizeRepoPath('/mnt/c/Users/person/repo', {
    platform: wsl,
    env: { RELAYBRIDGE_ALLOW_SLOW_WSL_FS: '1' },
    skipRealpath: true,
  }), '/mnt/c/Users/person/repo');
});

test('WSL native-path enforcement resolves an existing symlink parent', (t) => {
  if (process.platform === 'win32' || !fs.existsSync('/mnt')) {
    t.skip('requires a POSIX host with /mnt');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-wsl-link-'));
  const linked = path.join(root, 'mounted');
  fs.symlinkSync('/mnt', linked, 'dir');
  const hiddenDrvFsPath = path.join(linked, 'future-repository');
  assert.equal(require('../lib/platform').isSlowWslInteropPath(hiddenDrvFsPath), true);
  assert.throws(() => tracker.normalizeRepoPath(hiddenDrvFsPath, {
    platform: { isWindows: false, isWSL: true, label: 'WSL' }, env: {},
  }), /Linux filesystem, not \/mnt/);
});

test('saveRegistry writes through the same data-dir precedence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-save-'));
  const dataDir = path.join(root, 'durable-data');
  const options = {
    root,
    env: { RELAYBRIDGE_DATA_DIR: dataDir },
    platform: HOST_PLATFORM,
  };
  tracker.saveRegistry({ repos: [{ name: 'o/r', path: path.join(root, 'repo') }] }, undefined, options);
  assert.equal(fs.existsSync(path.join(dataDir, 'github-repos.json')), true);
  assert.equal(tracker.loadRegistry(undefined, options).repos[0].name, 'o/r');
});

posixOnly('save never follows a publication-time target replacement for metadata writes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-save-publish-swap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'data', 'github-repos.json');
  const victim = path.join(root, 'outside-victim.txt');
  const victimBytes = 'save must not alter external bytes\n';
  fs.writeFileSync(victim, victimBytes);
  fs.chmodSync(victim, 0o644);

  const originalRenameSync = fs.renameSync;
  const originalChmodSync = fs.chmodSync;
  let swapped = false;
  let targetChmods = 0;
  t.after(() => {
    fs.renameSync = originalRenameSync;
    fs.chmodSync = originalChmodSync;
  });
  fs.renameSync = (source, target) => {
    originalRenameSync.call(fs, source, target);
    if (path.resolve(String(target)) === runtime) {
      fs.unlinkSync(target);
      fs.symlinkSync(victim, target);
      swapped = true;
    }
  };
  fs.chmodSync = (file, ...args) => {
    if (path.resolve(String(file)) === runtime) targetChmods += 1;
    return originalChmodSync.call(fs, file, ...args);
  };

  tracker.saveRegistry({ repos: [] }, undefined, { root, env: {}, platform: HOST_PLATFORM });
  assert.equal(swapped, true, 'the adversary must replace the renamed directory entry');
  assert.equal(targetChmods, 0, 'save must perform no path-based chmod after publication');
  assert.equal(fs.lstatSync(runtime).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(victim, 'utf8'), victimBytes);
  assert.equal(fs.statSync(victim).mode & 0o777, 0o644, 'victim permissions must remain unchanged');
});

test('directory fsync is attempted after registry publication where supported', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbgh-dir-fsync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'data', 'github-repos.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const result = tracker.fsyncParentDirectory(target);
  assert.equal(typeof result, 'boolean');
  if (process.platform === 'linux') assert.equal(result, true);
});

test('the tracked registry example contains no machine-specific path', () => {
  const example = fs.readFileSync(path.join(__dirname, '..', 'config', 'github-repos.example.json'), 'utf8');
  const parsed = JSON.parse(example);
  assert.deepEqual(parsed.repos, []);
  assert.doesNotMatch(example, /[A-Za-z]:\\\\|\/(?:home|mnt)\//);
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
  assert.equal(onboard.templateVersion(
    '<!-- BEGIN relaybridge-contributing (rb-template v3) -->\ntext\n<!-- END relaybridge-contributing -->\n'), 3);
  assert.equal(onboard.templateVersion('no header'), 0);
});

test('managed CONTRIBUTING upgrades preserve user bytes and refuse edited or malformed blocks', () => {
  const current = fs.readFileSync(path.join(onboard.TEMPLATE_DIR, 'CONTRIBUTING-snippet.md'), 'utf8');
  const prior = fs.readFileSync(path.join(onboard.TEMPLATE_DIR, 'history', 'CONTRIBUTING-snippet.v1.md'), 'utf8');
  const prefix = '# Operator guidance\n\nKeep this exactly.\n\n';
  const suffix = '\n\n## Local policy\n\nAlso exact.\n';
  const upgraded = onboard.planContributingUpdate(prefix + prior.trimEnd() + suffix, current);
  assert.equal(upgraded.action, 'replace');
  assert.equal(upgraded.text, prefix + current.trimEnd() + suffix);

  const edited = onboard.planContributingUpdate(
    prefix + prior.replace('Pick a bump label', 'Choose our custom release policy').trimEnd() + suffix,
    current,
  );
  assert.equal(edited.action, 'manual');
  assert.match(edited.reason, /edited|not a known shipped block/);

  const malformed = onboard.planContributingUpdate(
    prefix + '<!-- BEGIN relaybridge-contributing (rb-template v1) -->\nbroken\n' + suffix,
    current,
  );
  assert.equal(malformed.action, 'manual');
  assert.equal(onboard.planContributingUpdate(
    '# Local\n<!-- END relaybridge-contributing -->\n', current).action, 'manual');
  assert.equal(onboard.planContributingUpdate('# No managed block\n', current).action, 'append');
});

test('repository onboarding files are exact copies of their canonical templates', () => {
  const root = path.resolve(__dirname, '..');
  for (const target of onboard.TEMPLATE_TARGETS) {
    const canonical = fs.readFileSync(path.join(onboard.TEMPLATE_DIR, target.src), 'utf8');
    const installed = fs.readFileSync(path.join(root, target.dest), 'utf8');
    assert.equal(installed, canonical, `${target.dest} must match ${target.src}`);
  }
});

test('version-on-merge is serialized, strict, immutable, and history append-only', () => {
  const vm = fs.readFileSync(path.join(onboard.TEMPLATE_DIR, 'version-on-merge.yml'), 'utf8');
  assert.match(vm, /aborting to keep history append-only/);
  assert.match(vm, /bump:major/);
  assert.match(vm, /group: version-on-merge-\$\{\{ github\.repository \}\}/);
  assert.match(vm, /cancel-in-progress: false/);
  assert.match(vm, /queue: max/);
  assert.match(vm, /pull_request_target:/);
  assert.match(vm, /base\.ref == github\.event\.repository\.default_branch/);
  assert.doesNotMatch(vm, /checkout[^\n]*\n(?:.*\n){0,8}\s+ref:\s*\$\{\{\s*github\.event\.pull_request\.head/,
    'target-context release workflow must never check out the untrusted PR head');
  assert.match(vm, /node \.github\/scripts\/compute-version\.cjs/);
  assert.match(vm, /HEAD:refs\/heads\/\$BASE_REF/);
  assert.match(vm, /refs\/tags\/v\$NEW_VERSION:refs\/tags\/v\$NEW_VERSION/);
  assertImmutableActionUses(vm, 'actions/checkout');
  assert.match(vm, /actions\/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9\.0\.0/);
  assert.doesNotMatch(vm, /--notes[^\n]*\$\{\{\s*github\.event\.pull_request\.title\s*\}\}/,
    'untrusted PR titles must not be interpolated directly into a shell script');
  assert.match(vm, /RELEASE_NOTES:/, 'release notes must cross into the shell through env');
});

test('claim workflow warns on duplicates and uses least required immutable action permissions', () => {
  const claim = fs.readFileSync(path.join(onboard.TEMPLATE_DIR, 'claim-on-start.yml'), 'utf8');
  assert.match(claim, /opened, edited, ready_for_review, reopened, closed/);
  assert.match(claim, /contents: read/);
  assert.match(claim, /pull-requests: write/, 'claim reconciliation persists its ownership marker on the PR');
  assert.doesNotMatch(claim, /contents: write/, 'claim reconciliation never needs repository contents write access');
  assert.match(claim, /head\.repo\.full_name == github\.repository/);
  assert.match(claim, /pull_request\.user\.login != 'dependabot\[bot\]'/);
  assert.match(claim, /pull_request_target:/);
  assert.doesNotMatch(claim, /^\s+pull_request:\s*$/m);
  assert.match(claim, /group: issue-claims-\$\{\{ github\.repository \}\}/);
  assert.match(claim, /cancel-in-progress: false/);
  assert.match(claim, /queue: max/);
  assert.match(claim, /timeout-minutes: 10/);
  assert.match(claim, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(claim, /persist-credentials: false/);
  assert.doesNotMatch(claim, /ref: \$\{\{ github\.event\.pull_request\.(?:head|base)\.sha \}\}/,
    'a write-token workflow must never execute PR-controlled head/base helper code');
  assert.match(claim, /\.github', 'scripts', 'claim-issues\.cjs/);
  assert.match(claim, /steps\.claim-helper\.outputs\.available == 'true'/);
  assertImmutableActionUses(claim, 'actions/checkout');
  assert.match(claim, /actions\/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9\.0\.0/);
});

test('RelayBridge CI uses Node 24, immutable actions, least permissions, and stale-run cancellation', () => {
  const ci = fs.readFileSync(path.resolve(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8')
    .replace(/\r\n/g, '\n');
  assert.match(ci, /^permissions:\n  contents: read$/m);
  assertImmutableActionUses(ci, 'actions/checkout');
  assert.match(ci, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7\.0\.0/);
  assert.match(ci, /node-version: 24/);
  assert.match(ci, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.match(ci, /name: Linux \/ Node 24\n    runs-on: ubuntu-latest/);
  assert.match(ci, /name: Windows \/ Node 24\n    runs-on: windows-latest/);
  for (const command of [
    'npm ci', 'npm test', 'npm run test:install', 'npm run test:install-mcp', 'npm audit --omit=dev',
  ]) {
    assert.match(ci, new RegExp(`run: ${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
});

test('security reporting and grouped weekly dependency updates are configured', () => {
  const root = path.resolve(__dirname, '..');
  const security = fs.readFileSync(path.join(root, 'SECURITY.md'), 'utf8');
  const dependabot = fs.readFileSync(path.join(root, '.github', 'dependabot.yml'), 'utf8');
  assert.match(security, /private vulnerability reporting/i);
  assert.match(security, /security\/advisories\/new/);
  assert.match(security, /Redact capability tokens/i);
  assert.match(dependabot, /package-ecosystem: npm/);
  assert.match(dependabot, /package-ecosystem: github-actions/);
  assert.equal((dependabot.match(/interval: weekly/g) || []).length, 2);
  assert.match(dependabot, /npm-minor-and-patch:/);
  assert.match(dependabot, /actions-minor-and-patch:/);
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
