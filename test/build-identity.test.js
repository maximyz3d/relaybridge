'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const {
  buildSourceInfo,
  loadBuildIdentity,
  prepareBuildInfo,
  writeBuildInfoAtomic,
} = require('../lib/build-identity.cjs');
const { receiptStoreIdentity } = require('../lib/receipt-store-identity.cjs');

const ROOT = path.resolve(__dirname, '..');
const posixOnly = process.platform === 'win32' ? test.skip : test;
const POSIX_MCP_INSTALL_LOCK = process.platform === 'win32'
  ? null
  : path.join('/tmp', `relaybridge-mcp-install-${process.getuid()}.lock`);

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function makeSourceRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-build-id-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(path.join(root, 'package.json'), '{"name":"fixture","version":"2.0.1"}\n');
  write(path.join(root, '.gitignore'), [
    'node_modules/', 'data/', '.bridge-token', '.state.json', '.mcp-start.lock', '.mcp-install.lock/',
    '*.log', 'build-info.json', '.build-info.*.tmp', '.bridge.pid', '.bridge.*.pid', '.env',
  ].join('\n') + '\n');
  write(path.join(root, 'server.js'), 'module.exports = 1;\n');
  write(path.join(root, 'lib', 'feature.js'), 'module.exports = "baseline";\n');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'relaybridge-test@example.invalid');
  git(root, 'config', 'user.name', 'RelayBridge Test');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  return root;
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, proc) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`bridge exited early with ${proc.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error('bridge health timeout');
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condition timeout');
}

function isLiveProcess(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  const state = (result.stdout || '').trim();
  return result.status === 0 && state !== '' && !state.startsWith('Z');
}

test('installed manifests are exact while missing or malformed manifests are explicitly unready', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-installed-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(path.join(root, 'package.json'), '{"name":"fixture","version":"2.0.1"}\n');

  assert.deepEqual(loadBuildIdentity(root), {
    version: '2.0.1', buildId: '2.0.1', ready: false,
    source: 'package_version_fallback', reason: 'build_info_missing',
  });
  write(path.join(root, 'build-info.json'), '{broken');
  assert.equal(loadBuildIdentity(root).ready, false);
  assert.equal(loadBuildIdentity(root).reason, 'build_info_invalid');
  write(path.join(root, 'build-info.json'), JSON.stringify({
    version: '2.0.0', buildId: '2.0.0+0123456789abcdef',
  }));
  assert.equal(loadBuildIdentity(root).reason, 'build_info_version_mismatch');

  const exact = { version: '2.0.1', buildId: '2.0.1+0123456789abcdef', source: 'release' };
  write(path.join(root, 'build-info.json'), JSON.stringify(exact));
  assert.deepEqual(loadBuildIdentity(root), {
    version: '2.0.1', buildId: exact.buildId, ready: true, source: 'build_info', reason: null,
  });
  const before = fs.readFileSync(path.join(root, 'build-info.json'), 'utf8');
  const preserved = prepareBuildInfo(root);
  assert.equal(preserved.updated, false);
  assert.equal(fs.readFileSync(path.join(root, 'build-info.json'), 'utf8'), before,
    'a release install without .git must retain the installer-owned manifest byte for byte');
});

test('source identity covers dirty working-tree bytes but never reads ignored secrets or runtime state', (t) => {
  const root = makeSourceRepo(t);
  const first = prepareBuildInfo(root);
  assert.equal(first.updated, true);
  assert.match(first.identity.buildId, /^2\.0\.1\+[a-f0-9]{16}$/);
  assert.notEqual(first.identity.buildId, '2.0.1');
  assert.equal(loadBuildIdentity(root).ready, true);
  const stable = buildSourceInfo(root).buildId;
  assert.equal(stable, first.identity.buildId);

  const ignored = [
    ['.bridge-token', 'guessable-secret'],
    ['.state.json', '{"fullPermissions":true}'],
    ['.mcp-start.lock', 'runtime-lock'],
    ['.mcp-install.lock/owner', 'registration-lock-owner'],
    ['bridge.start.out.log', 'runtime-log'],
    ['.bridge.pid', '123'],
    ['.bridge.8787.pid', '456'],
    ['data/receipts/private.json', 'private-runtime-receipt'],
    ['node_modules/pkg/index.js', 'dependency-runtime'],
    ['.env', 'API_TOKEN=do-not-read'],
  ];
  for (const [name, body] of ignored) write(path.join(root, name), body);

  const reads = [];
  const fsApi = Object.create(fs);
  fsApi.readFileSync = (file, ...args) => {
    reads.push(path.resolve(String(file)));
    return fs.readFileSync(file, ...args);
  };
  assert.equal(buildSourceInfo(root, { fsApi }).buildId, stable);
  for (const [name] of ignored) {
    assert.ok(!reads.includes(path.resolve(root, name)), `ignored runtime file was read: ${name}`);
  }
  write(path.join(root, '.npmrc'), '//registry.example.invalid/:_authToken=must-not-be-read');
  assert.throws(() => buildSourceInfo(root, { fsApi }), /secret-looking path/);
  assert.ok(!reads.includes(path.resolve(root, '.npmrc')),
    'a nonignored secret-looking file must be rejected before reading its bytes');
  fs.unlinkSync(path.join(root, '.npmrc'));
  const beforeTrackedIgnoredEdit = buildSourceInfo(root).buildId;
  git(root, 'add', '-f', '.env');
  write(path.join(root, '.env'), 'API_TOKEN=changed-but-still-ignored');
  assert.throws(() => buildSourceInfo(root), /tracked paths matched by ignore rules/,
    'a tracked-but-ignored path must fail closed before its bytes are silently omitted or read');
  git(root, 'reset', '-q', 'HEAD', '--', '.env');
  assert.equal(buildSourceInfo(root).buildId, beforeTrackedIgnoredEdit);
  const manifestText = fs.readFileSync(path.join(root, 'build-info.json'), 'utf8');
  assert.ok(!manifestText.includes(root));
  assert.ok(!manifestText.includes('guessable-secret'));

  write(path.join(root, 'lib', 'feature.js'), 'module.exports = "dirty-one";\n');
  const dirtyTracked = buildSourceInfo(root).buildId;
  assert.notEqual(dirtyTracked, stable);
  write(path.join(root, 'lib', 'new-feature.js'), 'module.exports = "untracked-one";\n');
  const dirtyUntracked = buildSourceInfo(root).buildId;
  assert.notEqual(dirtyUntracked, dirtyTracked);
  write(path.join(root, 'lib', 'new-feature.js'), 'module.exports = "untracked-two";\n');
  assert.notEqual(buildSourceInfo(root).buildId, dirtyUntracked);
  fs.unlinkSync(path.join(root, 'server.js'));
  assert.notEqual(buildSourceInfo(root).buildId, dirtyUntracked, 'tracked deletion must affect identity');
});

posixOnly('source identity uses Git executable semantics and rejects symlinks outside its source closure', (t) => {
  const root = makeSourceRepo(t);
  const target = path.join(root, 'lib', 'feature.js');
  const baseline = buildSourceInfo(root).buildId;
  git(root, 'update-index', '--chmod=+x', 'lib/feature.js');
  const executable = buildSourceInfo(root).buildId;
  assert.notEqual(executable, baseline);

  fs.chmodSync(target, 0o644);
  assert.equal(buildSourceInfo(root).buildId, executable,
    'host stat mode must not change Git-canonical executable semantics');

  const outside = path.join(path.dirname(root), `relaybridge-outside-${path.basename(root)}.txt`);
  t.after(() => { try { fs.unlinkSync(outside); } catch {} });
  write(outside, 'outside-secret-one');
  fs.symlinkSync(outside, path.join(root, 'outside-link'));
  assert.throws(() => buildSourceInfo(root), /symlink target outside the worktree/,
    'runtime code outside the identified source set must never share a ready identity');

  fs.unlinkSync(path.join(root, 'outside-link'));
  write(path.join(root, 'data', 'excluded-target.js'), 'module.exports = "runtime";\n');
  fs.symlinkSync('data/excluded-target.js', path.join(root, 'excluded-link'));
  assert.throws(() => buildSourceInfo(root), /outside the identified source set/,
    'a symlink must not smuggle ignored runtime bytes into executable source');
  fs.unlinkSync(path.join(root, 'excluded-link'));
  fs.symlinkSync('lib/feature.js', path.join(root, 'internal-link'));
  const firstLink = buildSourceInfo(root).buildId;
  fs.unlinkSync(path.join(root, 'internal-link'));
  fs.symlinkSync('server.js', path.join(root, 'internal-link'));
  assert.notEqual(buildSourceInfo(root).buildId, firstLink,
    'the exact link text must affect identity when its internal target is identified separately');
});

posixOnly('source identity reads raw symlink target bytes and fails closed when they are not UTF-8', (t) => {
  const root = makeSourceRepo(t);
  fs.symlinkSync(Buffer.from([0x6c, 0x69, 0x62, 0x2f, 0xff]), path.join(root, 'raw-target-link'));
  assert.throws(() => buildSourceInfo(root), /symlink target that is not valid UTF-8/);
});

posixOnly('source identity distinguishes a tracked symlink from a regular file with the same bytes', (t) => {
  const root = makeSourceRepo(t);
  const alias = path.join(root, 'alias.js');
  const targetText = 'lib/feature.js';
  fs.symlinkSync(targetText, alias);
  git(root, 'add', 'alias.js');
  git(root, 'commit', '-qm', 'track source alias');
  const symlinkBuild = buildSourceInfo(root).buildId;

  fs.unlinkSync(alias);
  write(alias, targetText);
  assert.match(git(root, 'status', '--short', '--', 'alias.js'), /^T alias\.js$/,
    'fixture must be a tracked symlink replaced by a regular file');
  const regularFileBuild = buildSourceInfo(root).buildId;
  assert.notEqual(regularFileBuild, symlinkBuild,
    'behaviorally different source file types must never share an exact build identity');
});

posixOnly('source closure rejects an outside package symlink without reading package or target bytes', (t) => {
  const root = makeSourceRepo(t);
  const packagePath = path.join(root, 'package.json');
  const outside = path.join(path.dirname(root), `relaybridge-package-secret-${path.basename(root)}.json`);
  const sentinel = 'EXTERNAL_PACKAGE_BYTES_MUST_NEVER_BE_READ';
  t.after(() => { try { fs.unlinkSync(outside); } catch {} });
  write(outside, `{${sentinel}`);
  fs.unlinkSync(packagePath);
  fs.symlinkSync(outside, packagePath);

  const byteReads = [];
  const opens = [];
  const fsApi = Object.create(fs);
  fsApi.openSync = (file, ...args) => {
    opens.push(path.resolve(String(file)));
    return fs.openSync(file, ...args);
  };
  fsApi.readFileSync = (file, ...args) => {
    if (typeof file !== 'number') byteReads.push(path.resolve(String(file)));
    return fs.readFileSync(file, ...args);
  };

  for (const operation of [
    () => buildSourceInfo(root, { fsApi }),
    () => loadBuildIdentity(root, { fsApi }),
  ]) {
    let failure;
    try { operation(); } catch (error) { failure = error; }
    assert.ok(failure, 'outside package symlink must fail closed');
    assert.match(failure.message, /symlink target outside the worktree/);
    assert.ok(!failure.message.includes(sentinel), 'external package bytes must not leak through an error');
  }
  assert.ok(!byteReads.includes(path.resolve(packagePath)), 'package symlink must be inspected with readlink, not followed');
  assert.ok(!byteReads.includes(path.resolve(outside)), 'outside package bytes must never be read');
  assert.ok(!opens.includes(path.resolve(packagePath)), 'package symlink must never be opened');
  assert.ok(!opens.includes(path.resolve(outside)), 'outside package target must never be opened');
});

posixOnly('source closure validates later symlinks before reading regular package bytes', (t) => {
  const root = makeSourceRepo(t);
  const packagePath = path.join(root, 'package.json');
  const outside = path.join(path.dirname(root), `relaybridge-late-secret-${path.basename(root)}.txt`);
  t.after(() => { try { fs.unlinkSync(outside); } catch {} });
  write(outside, 'LATE_EXTERNAL_BYTES_MUST_NEVER_BE_READ');
  fs.symlinkSync(outside, path.join(root, 'zz-outside-link'));

  const byteReads = [];
  const fsApi = Object.create(fs);
  fsApi.readFileSync = (file, ...args) => {
    if (typeof file !== 'number') byteReads.push(path.resolve(String(file)));
    return fs.readFileSync(file, ...args);
  };
  assert.throws(() => buildSourceInfo(root, { fsApi }), /symlink target outside the worktree/);
  assert.ok(!byteReads.includes(path.resolve(packagePath)),
    'the full source closure must validate before regular package bytes are read');
  assert.ok(!byteReads.includes(path.resolve(outside)), 'outside target bytes must never be read');
});

posixOnly('source closure rejects dot-dot traversal through an ignored directory symlink', (t) => {
  const root = makeSourceRepo(t);
  write(path.join(root, 'inside.txt'), 'identified in-worktree bytes');
  const externalParent = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-link-traversal-'));
  t.after(() => fs.rmSync(externalParent, { recursive: true, force: true }));
  const externalChild = path.join(externalParent, 'child');
  fs.mkdirSync(externalChild);
  const outsideTarget = path.join(externalParent, 'inside.txt');
  const sentinel = 'EXTERNAL_TRAVERSAL_BYTES_MUST_NEVER_BE_READ';
  write(outsideTarget, sentinel);
  fs.symlinkSync(externalChild, path.join(root, '.bridge-token'), 'dir');
  fs.symlinkSync('.bridge-token/../inside.txt', path.join(root, 'escape-link'));

  const byteReads = [];
  const opens = [];
  const fsApi = Object.create(fs);
  fsApi.openSync = (file, ...args) => {
    if (typeof file !== 'number') opens.push(path.resolve(String(file)));
    return fs.openSync(file, ...args);
  };
  fsApi.readFileSync = (file, ...args) => {
    if (typeof file !== 'number') byteReads.push(path.resolve(String(file)));
    return fs.readFileSync(file, ...args);
  };
  for (const operation of [
    () => buildSourceInfo(root, { fsApi }),
    () => loadBuildIdentity(root, { fsApi }),
  ]) {
    let failure;
    try { operation(); } catch (error) { failure = error; }
    assert.ok(failure, 'dot-dot symlink traversal must fail closed');
    assert.match(failure.message, /unsafe symlink target traversal/);
    assert.ok(!failure.message.includes(sentinel));
  }
  assert.ok(!byteReads.includes(path.resolve(outsideTarget)), 'escaped target bytes must never be read');
  assert.ok(!opens.includes(path.resolve(outsideTarget)), 'escaped target must never be opened');
});

test('package JSON parse errors are generic and never expose source bytes', (t) => {
  const root = makeSourceRepo(t);
  const sentinel = 'PRIVATE_PACKAGE_PARSE_SENTINEL';
  write(path.join(root, 'package.json'), `{${sentinel}`);
  for (const operation of [
    () => buildSourceInfo(root),
    () => loadBuildIdentity(root),
  ]) {
    let failure;
    try { operation(); } catch (error) { failure = error; }
    assert.ok(failure);
    assert.equal(failure.message, 'package.json is not valid JSON');
    assert.ok(!failure.message.includes(sentinel));
  }
});

posixOnly('installed build-info symlinks are rejected without reading or overwriting their targets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-installed-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(path.join(root, 'package.json'), '{"name":"fixture","version":"2.0.1"}\n');
  const outside = path.join(path.dirname(root), `relaybridge-release-secret-${path.basename(root)}.json`);
  const outsideBytes = JSON.stringify({
    version: '2.0.1',
    buildId: '2.0.1+0123456789abcdef',
    source: 'release',
    sentinel: 'EXTERNAL_BUILD_INFO_MUST_NEVER_BE_READ',
  });
  t.after(() => { try { fs.unlinkSync(outside); } catch {} });
  write(outside, outsideBytes);
  const manifestPath = path.join(root, 'build-info.json');
  fs.symlinkSync(outside, manifestPath);

  const byteReads = [];
  const opens = [];
  const fsApi = Object.create(fs);
  fsApi.openSync = (file, ...args) => {
    opens.push(path.resolve(String(file)));
    return fs.openSync(file, ...args);
  };
  fsApi.readFileSync = (file, ...args) => {
    if (typeof file !== 'number') byteReads.push(path.resolve(String(file)));
    return fs.readFileSync(file, ...args);
  };
  assert.deepEqual(loadBuildIdentity(root, { fsApi }), {
    version: '2.0.1', buildId: '2.0.1', ready: false,
    source: 'package_version_fallback', reason: 'build_info_invalid',
  });
  assert.throws(() => prepareBuildInfo(root, { fsApi }), /exact build-info\.json is required/);
  assert.equal(fs.lstatSync(manifestPath).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(outside, 'utf8'), outsideBytes);
  assert.ok(!byteReads.includes(path.resolve(manifestPath)));
  assert.ok(!byteReads.includes(path.resolve(outside)));
  assert.ok(!opens.includes(path.resolve(manifestPath)));
  assert.ok(!opens.includes(path.resolve(outside)));
});

posixOnly('source identity fails closed on a Git path that is not valid UTF-8', (t) => {
  const root = makeSourceRepo(t);
  const invalidPath = Buffer.concat([
    Buffer.from(`${root}${path.sep}invalid-`, 'utf8'),
    Buffer.from([0xff]),
  ]);
  fs.writeFileSync(invalidPath, 'unrepresentable source path');
  assert.throws(() => buildSourceInfo(root), /not valid UTF-8/);
});

test('a stale source manifest becomes unready after an edit even without rerunning a launcher', (t) => {
  const root = makeSourceRepo(t);
  const prepared = prepareBuildInfo(root);
  assert.equal(prepared.identity.ready, true);
  write(path.join(root, 'server.js'), 'module.exports = 2;\n');
  const stale = loadBuildIdentity(root);
  assert.deepEqual(stale, {
    version: '2.0.1', buildId: '2.0.1', ready: false,
    source: 'package_version_fallback', reason: 'build_info_stale',
  });
});

test('a source-owned manifest becomes unready when its Git checkout cannot be revalidated', (t) => {
  const root = makeSourceRepo(t);
  const prepared = prepareBuildInfo(root);
  assert.equal(prepared.identity.ready, true);
  fs.renameSync(path.join(root, '.git'), path.join(root, '.git-away'));
  assert.deepEqual(loadBuildIdentity(root), {
    version: '2.0.1', buildId: '2.0.1', ready: false,
    source: 'package_version_fallback', reason: 'source_verification_failed',
  });
});

test('atomic manifest failure preserves the prior complete file and removes its temporary', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-build-atomic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'build-info.json');
  const prior = '{"version":"2.0.1","buildId":"2.0.1+aaaaaaaaaaaaaaaa"}\n';
  write(target, prior);
  const fsApi = Object.create(fs);
  fsApi.renameSync = () => { throw Object.assign(new Error('injected rename failure'), { code: 'EIO' }); };
  assert.throws(() => writeBuildInfoAtomic(root, {
    version: '2.0.1', buildId: '2.0.1+bbbbbbbbbbbbbbbb',
  }, { fsApi, randomUUID: () => 'fixed' }), /injected rename failure/);
  assert.equal(fs.readFileSync(target, 'utf8'), prior);
  assert.deepEqual(fs.readdirSync(root).sort(), ['build-info.json']);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(target, 'utf8')));
});

test('atomic manifest publication retries transient Windows destination contention', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-build-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'build-info.json');
  const prior = '{"version":"2.0.0","buildId":"prior"}\n';
  write(target, prior);
  const fsApi = Object.create(fs);
  let attempts = 0;
  fsApi.renameSync = (from, to) => {
    attempts += 1;
    if (attempts === 1) {
      assert.equal(fs.readFileSync(target, 'utf8'), prior,
        'the prior complete manifest must remain visible while replacement is contended');
      throw Object.assign(new Error('injected Windows contention'), { code: 'EPERM' });
    }
    return fs.renameSync(from, to);
  };
  writeBuildInfoAtomic(root, { version: '2.0.1', buildId: 'current' }, {
    fsApi,
    platform: 'win32',
    randomUUID: () => 'fixed',
  });
  assert.equal(attempts, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), {
    version: '2.0.1', buildId: 'current',
  });
});

test('concurrent source preparations publish one complete deterministic manifest', async (t) => {
  const root = makeSourceRepo(t);
  const tool = path.join(ROOT, 'tools', 'prepare-build-info.cjs');
  const runs = Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tool, root], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout: stdout.trim(), stderr }));
  }));
  const results = await Promise.all(runs);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(new Set(results.map((result) => result.stdout)).size, 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'build-info.json'), 'utf8'));
  assert.equal(manifest.buildId, results[0].stdout);
  assert.equal(loadBuildIdentity(root).ready, true);
  assert.ok(!fs.readdirSync(root).some((name) => /^\.build-info\..*\.tmp$/.test(name)));
});

posixOnly('POSIX MCP registration cannot strand a new token on snapshot or build preparation failure', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-mcp-token-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installer = path.join(root, 'install-mcp.sh');
  fs.copyFileSync(path.join(ROOT, 'install-mcp.sh'), installer);
  write(path.join(root, 'mcp', 'server.mjs'), '// fixture\n');
  write(path.join(root, 'config', 'timeout-policy.json'), JSON.stringify({
    oneShotMaxMs: 1000, transportGraceMs: 1000, mcpHostGraceMs: 1000,
  }));
  const generatedManifest = '{"version":"2.0.1","buildId":"2.0.1+cccccccccccccccc"}\n';
  write(path.join(root, 'tools', 'prepare-build-info.cjs'), `
    require('node:fs').writeFileSync(
      require('node:path').join(process.argv[2], 'build-info.json'),
      ${JSON.stringify(generatedManifest)}
    );
    process.exit(17);
  `);
  const home = path.join(root, 'home');
  write(path.join(home, '.codex', 'config.toml'), '[fixture]\n');
  write(path.join(home, '.claude.json'), '{"mcpServers":{}}\n');
  const token = path.join(root, '.bridge-token');
  const privateTmp = path.join(root, 'private-tmp');
  fs.mkdirSync(privateTmp);

  const earlyFailureEnv = { ...process.env, TMPDIR: privateTmp };
  delete earlyFailureEnv.HOME;
  delete earlyFailureEnv.CODEX_HOME;
  delete earlyFailureEnv.CLAUDE_CONFIG_DIR;
  let result = spawnSync('sh', [installer, '--skip-codex', '--skip-claude'], {
    cwd: root,
    env: earlyFailureEnv,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(fs.readdirSync(privateTmp), [],
    'an early config-path failure after mktemp must remove its private temporary tree');
  assert.equal(fs.existsSync(token), false);
  assert.equal(fs.existsSync(POSIX_MCP_INSTALL_LOCK), false,
    'an early failure must release only its owned registration lock');

  const fakeBin = path.join(root, 'fake-bin');
  write(path.join(fakeBin, 'cp'), '#!/bin/sh\nexit 86\n');
  fs.chmodSync(path.join(fakeBin, 'cp'), 0o755);
  result = spawnSync('sh', [installer, '--skip-codex', '--skip-claude'], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: path.join(home, '.codex'),
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      TMPDIR: privateTmp,
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(token), false, 'snapshot failure must occur before any token is created');
  assert.deepEqual(fs.readdirSync(privateTmp), [], 'snapshot failure must remove its private temporary tree');
  assert.equal(fs.existsSync(POSIX_MCP_INSTALL_LOCK), false);

  result = spawnSync('sh', [installer, '--skip-codex', '--skip-claude'], {
    cwd: root,
    env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), TMPDIR: privateTmp },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /exact source build identity/);
  assert.equal(fs.existsSync(token), false, 'build preparation failure must roll back the newly created token');
  assert.equal(fs.readFileSync(path.join(root, 'build-info.json'), 'utf8'), generatedManifest,
    'registration rollback must not clobber deterministic generated identity state');
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith('.bridge-token.tmp.')), []);
  assert.deepEqual(fs.readdirSync(privateTmp), []);
  assert.equal(fs.existsSync(POSIX_MCP_INSTALL_LOCK), false);
});

posixOnly('POSIX MCP registrations from distinct worktrees serialize global configuration rollback', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-mcp-concurrent-'));
  const rootA = path.join(fixture, 'worktree-a');
  const rootB = path.join(fixture, 'worktree-b');
  const children = [];
  const control = path.join(fixture, 'control');
  const home = path.join(fixture, 'home');
  const codexHome = path.join(home, '.codex');
  const codexConfig = path.join(codexHome, 'config.toml');
  const tokenA = path.join(rootA, '.bridge-token');
  const tokenB = path.join(rootB, '.bridge-token');
  const lock = POSIX_MCP_INSTALL_LOCK;
  const releaseA = path.join(control, 'release-a');
  fs.mkdirSync(control, { recursive: true });
  t.after(async () => {
    write(releaseA, 'release');
    for (const { child } of children) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await Promise.all(children.map(({ closed }) => closed.catch(() => {})));
    // Remove only the deterministic stale record this test publishes. A
    // foreign owner must remain untouched even during test cleanup.
    try {
      const owner = fs.readFileSync(path.join(lock, 'owner'), 'utf8');
      if (owner === '99999999:stale-owner-bytes\n') fs.rmSync(lock, { recursive: true });
    } catch {}
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  for (const root of [rootA, rootB]) {
    fs.mkdirSync(root, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'install-mcp.sh'), path.join(root, 'install-mcp.sh'));
    write(path.join(root, 'mcp', 'server.mjs'), '// concurrent fixture\n');
    write(path.join(root, 'config', 'timeout-policy.json'), JSON.stringify({
      oneShotMaxMs: 1000, transportGraceMs: 1000, mcpHostGraceMs: 1000,
    }));
    write(path.join(root, 'tools', 'prepare-build-info.cjs'), `
      const fs = require('node:fs');
      const path = require('node:path');
      fs.writeFileSync(path.join(process.env.RELAYBRIDGE_TEST_CONTROL, process.env.RELAYBRIDGE_TEST_ROLE + '-build-entered'), 'yes');
      process.stdout.write('2.0.1+aaaaaaaaaaaaaaaa\\n');
    `);
  }
  write(codexConfig, '# baseline configuration\n');
  write(path.join(home, '.claude.json'), '{"mcpServers":{}}\n');

  const fakeBin = path.join(fixture, 'fake-bin');
  write(path.join(fakeBin, 'codex'), `#!/bin/sh
set -eu
case "\${2:-}" in
  remove) exit 0 ;;
  add)
    printf '[mcp_servers.relaybridge]\\n# role=%s\\n' "$RELAYBRIDGE_TEST_ROLE" > "$CODEX_HOME/config.toml"
    exit 0
    ;;
  get)
    if [ "$RELAYBRIDGE_TEST_ROLE" = A ]; then
      : > "$RELAYBRIDGE_TEST_CONTROL/a-blocked"
      while [ ! -f "$RELAYBRIDGE_TEST_CONTROL/release-a" ]; do sleep 0.02; done
      printf '{}\\n'
    else
      printf '{"args":["%s"],"env":{"RELAYBRIDGE_URL":"http://127.0.0.1:8787","RELAYBRIDGE_TOKEN_FILE":"%s"}}\\n' \\
        "$RELAYBRIDGE_TEST_MCP_SERVER" "$RELAYBRIDGE_TEST_TOKEN_FILE"
    fi
    exit 0
    ;;
esac
exit 2
`);
  fs.chmodSync(path.join(fakeBin, 'codex'), 0o755);

  function launch(role, checkoutRoot) {
    const checkoutToken = path.join(checkoutRoot, '.bridge-token');
    const child = spawn('sh', [path.join(checkoutRoot, 'install-mcp.sh'), '--skip-claude'], {
      cwd: checkoutRoot,
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: codexHome,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        RELAYBRIDGE_TEST_ROLE: role,
        RELAYBRIDGE_TEST_CONTROL: control,
        RELAYBRIDGE_TEST_MCP_SERVER: path.join(checkoutRoot, 'mcp', 'server.mjs'),
        RELAYBRIDGE_TEST_TOKEN_FILE: checkoutToken,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, output }));
    });
    const tracked = { child, closed };
    children.push(tracked);
    return tracked;
  }

  const first = launch('A', rootA);
  await waitUntil(() => fs.existsSync(path.join(control, 'a-blocked')));
  const firstToken = fs.readFileSync(tokenA, 'utf8').trim();
  assert.match(firstToken, /^[a-f0-9]{64}$/);
  assert.match(fs.readFileSync(codexConfig, 'utf8'), /# role=A/);

  const second = launch('B', rootB);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(second.child.exitCode, null, 'second installer must wait for the active transaction');
  assert.equal(fs.existsSync(path.join(control, 'B-build-entered')), false,
    'the second installer must not snapshot, adopt a token, or prepare a build while the first owns the lock');
  assert.equal(fs.existsSync(tokenB), false,
    'a distinct checkout must not create its token before acquiring the shared user transaction lock');

  write(releaseA, 'release');
  const [firstResult, secondResult] = await Promise.all([first.closed, second.closed]);
  assert.notEqual(firstResult.code, 0, firstResult.output);
  assert.equal(secondResult.code, 0, secondResult.output);
  assert.equal(fs.existsSync(tokenA), false, 'the failed checkout must remove only its own new token');
  const finalToken = fs.readFileSync(tokenB, 'utf8').trim();
  assert.match(finalToken, /^[a-f0-9]{64}$/);
  assert.notEqual(finalToken, firstToken,
    'the successful checkout must create its own token after the failed owner rolls back');
  assert.match(fs.readFileSync(codexConfig, 'utf8'), /# role=B/,
    'the failed transaction rollback must complete before the successful waiter snapshots and writes config');
  assert.equal(fs.existsSync(lock), false, 'the successful owner must release the shared user lock directory');

  fs.mkdirSync(lock, { mode: 0o700 });
  const staleOwner = '99999999:stale-owner-bytes\n';
  write(path.join(lock, 'owner'), staleOwner);
  const staleAttempt = spawnSync('sh', [path.join(rootB, 'install-mcp.sh'), '--skip-codex', '--skip-claude'], {
    cwd: rootB,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      RELAYBRIDGE_MCP_INSTALL_LOCK_WAIT_ATTEMPTS: '1',
    },
    encoding: 'utf8',
  });
  assert.notEqual(staleAttempt.status, 0);
  assert.match(staleAttempt.stderr, /stale lock was left intact/);
  assert.equal(fs.readFileSync(path.join(lock, 'owner'), 'utf8'), staleOwner,
    'a contender must never delete or rewrite another transaction lock');
  assert.equal(fs.readFileSync(tokenB, 'utf8').trim(), finalToken,
    'lock contention must not touch the successful transaction token');
});

test('same-version stale MCP identity is rejected with the same receipt store', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-build-store-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = receiptStoreIdentity(dataDir);
  assert.equal(store.ready, true);
  const port = await reservePort();
  const listener = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        version: '2.0.1', buildId: '2.0.1+bbbbbbbbbbbbbbbb', buildIdentityReady: true,
        receiptStoreId: store.id, receiptStoreIdentityReady: true, capabilityAuth: true,
      }));
      return;
    }
    res.writeHead(500);
    res.end('unexpected request');
  });
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => listener.close(resolve)));

  const moduleUrl = pathToFileURL(path.join(ROOT, 'mcp', 'bridge-client.mjs')).href;
  const childScript = `
    import { requireExpectedActionIdentity } from ${JSON.stringify(moduleUrl)};
    try {
      await requireExpectedActionIdentity();
      process.exit(2);
    } catch (error) {
      const detail = error?.detail?.actionPreflight || {};
      process.stdout.write(JSON.stringify(detail));
      process.exit(detail.buildMatches === false && detail.receiptStoreMatches === true ? 0 : 3);
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', childScript], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      RELAYBRIDGE_TEST_BUILD_ID: '2.0.1+aaaaaaaaaaaaaaaa',
      RELAYBRIDGE_URL: `http://127.0.0.1:${port}`,
      RELAYBRIDGE_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(exitCode, 0, output);
  const detail = JSON.parse(output);
  assert.equal(detail.expectedBuildIdentityReady, true);
  assert.equal(detail.currentBuildIdentityReady, true);
  assert.equal(detail.buildMatches, false);
  assert.equal(detail.receiptStoreMatches, true);
});

test('an unready REST build rejects an MCP mutation even when display version and store match', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-unready-rest-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const port = await reservePort();
  const tokenPath = path.join(tempRoot, 'token');
  const dataDir = path.join(tempRoot, 'data');
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      RELAYBRIDGE_TEST_BUILD_IDENTITY_UNREADY: '1',
      PORT: String(port),
      PTY_MODE: 'none',
      RELAYBRIDGE_TOKEN_FILE: tokenPath,
      RELAYBRIDGE_DATA_DIR: dataDir,
      RELAYBRIDGE_ALLOWED_ROOTS: tempRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  proc.stdout.on('data', (chunk) => { output += chunk; });
  proc.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (proc.exitCode === null) proc.kill('SIGTERM');
    await new Promise((resolve) => proc.exitCode === null ? proc.once('exit', resolve) : resolve());
  });
  let health;
  try { health = await waitForHealth(`http://127.0.0.1:${port}`, proc); }
  catch (error) { throw new Error(`${error.message}\n${output}`); }
  assert.equal(health.buildId, '2.0.1');
  assert.equal(health.buildIdentityReady, false);
  assert.equal(health.buildIdentitySource, 'package_version_fallback');
  assert.equal(health.buildIdentityReason, 'test_unready');
  assert.ok(!JSON.stringify(health).includes(ROOT));
  const capability = await (await fetch(`http://127.0.0.1:${port}/api/capability`)).json();
  const response = await fetch(`http://127.0.0.1:${port}/api/oneshot`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-RelayBridge-Token': capability.token,
      'X-RelayBridge-Client': 'mcp',
      'X-RelayBridge-Expected-Build-Id': health.version,
      'X-RelayBridge-Expected-Receipt-Store-Id': health.receiptStoreId,
    },
    body: JSON.stringify({ kind: 'does_not_matter', prompt: 'must not invoke' }),
  });
  assert.equal(response.status, 409);
  const rejected = await response.json();
  assert.equal(rejected.model_invocation, false);
  assert.equal(rejected.token_usage_source, 'not_invoked');
  assert.equal(rejected.actionPreflight.buildMatches, false);
  assert.equal(rejected.actionPreflight.currentBuildIdentityReady, false);
  assert.equal(rejected.actionPreflight.receiptStoreMatches, true);
});

test('a launcher-pinned expected identity makes server startup fail before listening on a mismatch', async () => {
  const port = await reservePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      RELAYBRIDGE_TEST_BUILD_ID: '2.0.1+aaaaaaaaaaaaaaaa',
      RELAYBRIDGE_EXPECTED_BUILD_ID: '2.0.1+bbbbbbbbbbbbbbbb',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  proc.stdout.on('data', (chunk) => { output += chunk; });
  proc.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.once('close', resolve);
  });
  assert.notEqual(code, 0);
  assert.match(output, /source changed after build identity preparation/);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
});

posixOnly('start.sh owns the exact server across a forced setsid fork', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-start-fork-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.copyFileSync(path.join(ROOT, 'start.sh'), path.join(root, 'start.sh'));
  write(path.join(root, 'tools', 'prepare-build-info.cjs'),
    "process.stdout.write('2.0.1+aaaaaaaaaaaaaaaa\\n');\n");
  write(path.join(root, 'server.js'), `
    const http = require('http');
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        pid: process.pid,
        capabilityAuth: true,
        buildId: '2.0.1+aaaaaaaaaaaaaaaa',
        buildIdentityReady: true,
      }));
    });
    server.listen(Number(process.env.PORT), '127.0.0.1');
  `);
  const realSetsid = spawnSync('sh', ['-c', 'command -v setsid'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(realSetsid, 'test host must provide setsid');
  const fakeBin = path.join(root, 'bin');
  const wrapperPidFile = path.join(root, 'setsid-wrapper.pid');
  write(path.join(fakeBin, 'setsid'), `#!/bin/sh\nprintf '%s\\n' "$$" > "$RELAYBRIDGE_TEST_SETSID_WRAPPER_PID"\nexec ${JSON.stringify(realSetsid)} "$@"\n`);
  fs.chmodSync(path.join(fakeBin, 'setsid'), 0o755);
  const port = await reservePort();
  let livePid = null;
  t.after(async () => {
    if (livePid) { try { process.kill(livePid, 'SIGKILL'); } catch {} }
  });
  const child = spawn('bash', [path.join(root, 'start.sh')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      RELAYBRIDGE_PORT: String(port),
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      RELAYBRIDGE_TEST_SETSID_WRAPPER_PID: wrapperPidFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, output);
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  livePid = health.pid;
  const wrapperPid = Number(fs.readFileSync(wrapperPidFile, 'utf8').trim());
  assert.notEqual(health.pid, wrapperPid, 'forced-fork setsid wrapper PID must differ from the real server');
  assert.equal(Number(fs.readFileSync(path.join(root, `.bridge.${port}.pid`), 'utf8').trim()), health.pid,
    'pidfile must contain the inside-session server PID');
  process.kill(health.pid, 'SIGTERM');
  await waitUntil(async () => {
    try { await fetch(`http://127.0.0.1:${port}/api/health`); return false; } catch { return true; }
  });
  livePid = null;
});

posixOnly('start.sh aborts a forced-fork child when its inside-session PID handoff cannot be written', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-start-handoff-fail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.copyFileSync(path.join(ROOT, 'start.sh'), path.join(root, 'start.sh'));
  write(path.join(root, 'tools', 'prepare-build-info.cjs'),
    "process.stdout.write('2.0.1+aaaaaaaaaaaaaaaa\\n');\n");
  const serverMarker = path.join(root, 'server-started.marker');
  write(path.join(root, 'server.js'), `
    require('node:fs').writeFileSync(${JSON.stringify(serverMarker)}, String(process.pid));
    const http = require('http');
    http.createServer((_req, res) => res.end(JSON.stringify({
      pid: process.pid,
      capabilityAuth: true,
      buildId: '2.0.1+aaaaaaaaaaaaaaaa',
      buildIdentityReady: true,
    }))).listen(Number(process.env.PORT), '127.0.0.1');
  `);
  const realSetsid = spawnSync('sh', ['-c', 'command -v setsid'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(realSetsid, 'test host must provide setsid');
  const fakeBin = path.join(root, 'bin');
  write(path.join(fakeBin, 'setsid'), `#!/bin/sh
handoff=$7
rm -f "$handoff" || exit 71
mkdir "$handoff" || exit 72
exec ${JSON.stringify(realSetsid)} "$@"
`);
  fs.chmodSync(path.join(fakeBin, 'setsid'), 0o755);
  const port = await reservePort();
  const child = spawn('bash', [path.join(root, 'start.sh')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      RELAYBRIDGE_PORT: String(port),
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.notEqual(code, 0, output);
  assert.match(output, /valid session-leader PID handoff/);
  assert.equal(fs.existsSync(serverMarker), false, 'failed handoff must prevent server.js execution');
  assert.equal(fs.existsSync(path.join(root, `.bridge.${port}.pid`)), false);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
});

posixOnly('start.sh never signals an unproven PID injected into its handoff', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-start-untrusted-handoff-'));
  const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  t.after(async () => {
    if (victim.exitCode === null) victim.kill('SIGKILL');
    await new Promise((resolve) => victim.exitCode === null ? victim.once('exit', resolve) : resolve());
    fs.rmSync(root, { recursive: true, force: true });
  });
  await waitUntil(() => isLiveProcess(victim.pid));

  fs.copyFileSync(path.join(ROOT, 'start.sh'), path.join(root, 'start.sh'));
  write(path.join(root, 'tools', 'prepare-build-info.cjs'),
    "process.stdout.write('2.0.1+aaaaaaaaaaaaaaaa\\n');\n");
  write(path.join(root, 'server.js'), 'throw new Error("must not execute");\n');
  const fakeBin = path.join(root, 'bin');
  write(path.join(fakeBin, 'setsid'), `#!/bin/sh
handoff=$7
nonce=$8
printf '%s:%s\\n' "$nonce" "$RELAYBRIDGE_TEST_UNTRUSTED_PID" > "$handoff"
exit 74
`);
  fs.chmodSync(path.join(fakeBin, 'setsid'), 0o755);

  const port = await reservePort();
  const child = spawn('bash', [path.join(root, 'start.sh')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      RELAYBRIDGE_PORT: String(port),
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      RELAYBRIDGE_TEST_UNTRUSTED_PID: String(victim.pid),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.notEqual(code, 0, output);
  assert.match(output, /valid session-leader PID handoff/);
  assert.equal(isLiveProcess(victim.pid), true,
    'cleanup must never signal a live PID before proving it owns the new session');
  assert.equal(fs.existsSync(path.join(root, `.bridge.${port}.pid`)), false);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
});

posixOnly('start.sh rejects an unrelated valid session leader without signaling it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-start-unrelated-session-'));
  const realSetsid = spawnSync('sh', ['-c', 'command -v setsid'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(realSetsid, 'test host must provide setsid');
  const victim = spawn(realSetsid, [process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  t.after(async () => {
    if (victim.exitCode === null) victim.kill('SIGKILL');
    await new Promise((resolve) => victim.exitCode === null ? victim.once('exit', resolve) : resolve());
    fs.rmSync(root, { recursive: true, force: true });
  });
  await waitUntil(() => {
    if (!isLiveProcess(victim.pid)) return false;
    const status = spawnSync('ps', ['-o', 'pgid=,sid=', '-p', String(victim.pid)], { encoding: 'utf8' });
    const [pgid, sid] = String(status.stdout || '').trim().split(/\s+/).map(Number);
    return status.status === 0 && pgid === victim.pid && sid === victim.pid;
  });

  fs.copyFileSync(path.join(ROOT, 'start.sh'), path.join(root, 'start.sh'));
  write(path.join(root, 'tools', 'prepare-build-info.cjs'),
    "process.stdout.write('2.0.1+aaaaaaaaaaaaaaaa\\n');\n");
  write(path.join(root, 'server.js'), 'throw new Error("must not execute");\n');
  const fakeBin = path.join(root, 'bin');
  write(path.join(fakeBin, 'setsid'), `#!/bin/sh
handoff=$7
nonce=$8
printf '%s:%s\\n' "$nonce" "$RELAYBRIDGE_TEST_UNRELATED_SESSION_PID" > "$handoff"
exec sleep 30
`);
  fs.chmodSync(path.join(fakeBin, 'setsid'), 0o755);

  const port = await reservePort();
  const startedAt = Date.now();
  const child = spawn('bash', [path.join(root, 'start.sh')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      RELAYBRIDGE_PORT: String(port),
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      RELAYBRIDGE_TEST_UNRELATED_SESSION_PID: String(victim.pid),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.notEqual(code, 0, output);
  assert.match(output, /valid session-leader PID handoff/);
  assert.ok(Date.now() - startedAt < 3000,
    'a structurally valid but unrelated handoff must fail immediately, not consume the handoff timeout');
  assert.equal(isLiveProcess(victim.pid), true,
    'a valid session leader is not owned unless its PPID is the retained launcher');
  assert.equal(fs.existsSync(path.join(root, `.bridge.${port}.pid`)), false);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
});

posixOnly('start.sh removes wrong or unready exact candidates without leaving a listener or pidfile', async (t) => {
  const cases = [
    { name: 'wrong build', buildId: '2.0.1+bbbbbbbbbbbbbbbb', ready: true },
    { name: 'unready build', buildId: '2.0.1+aaaaaaaaaaaaaaaa', ready: false },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async (st) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-start-cleanup-'));
      let observedServerPid = null;
      st.after(() => {
        if (!observedServerPid) {
          try { observedServerPid = Number(fs.readFileSync(path.join(root, 'server.pid'), 'utf8')); } catch {}
        }
        if (observedServerPid && isLiveProcess(observedServerPid)) {
          try { process.kill(observedServerPid, 'SIGKILL'); } catch {}
        }
        fs.rmSync(root, { recursive: true, force: true });
      });
      fs.copyFileSync(path.join(ROOT, 'start.sh'), path.join(root, 'start.sh'));
      write(path.join(root, 'tools', 'prepare-build-info.cjs'),
        "process.stdout.write('2.0.1+aaaaaaaaaaaaaaaa\\n');\n");
      const serverPidFile = path.join(root, 'server.pid');
      write(path.join(root, 'server.js'), `
        require('node:fs').writeFileSync(process.env.RELAYBRIDGE_TEST_SERVER_PID_FILE, String(process.pid));
        const http = require('http');
        const server = http.createServer((req, res) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            pid: process.pid,
            capabilityAuth: true,
            buildId: ${JSON.stringify(fixture.buildId)},
            buildIdentityReady: ${JSON.stringify(fixture.ready)},
          }));
        });
        server.listen(Number(process.env.PORT), '127.0.0.1');
      `);
      const port = await reservePort();
      const child = spawn('bash', [path.join(root, 'start.sh')], {
        cwd: root,
        env: {
          ...process.env,
          PORT: String(port),
          RELAYBRIDGE_PORT: String(port),
          RELAYBRIDGE_TEST_SERVER_PID_FILE: serverPidFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      assert.notEqual(code, 0, output);
      assert.match(output, /health identity\/capability mismatch/);
      assert.equal(fs.existsSync(path.join(root, `.bridge.${port}.pid`)), false);
      observedServerPid = Number(fs.readFileSync(serverPidFile, 'utf8'));
      await waitUntil(() => !isLiveProcess(observedServerPid));
      assert.equal(isLiveProcess(observedServerPid), false, 'rejected exact candidate process must not survive');
      await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
    });
  }
});

posixOnly('start.sh signal cleanup terminates its exact detached session', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-start-signal-'));
  let serverPid = null;
  t.after(() => {
    if (serverPid && isLiveProcess(serverPid)) { try { process.kill(serverPid, 'SIGKILL'); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.copyFileSync(path.join(ROOT, 'start.sh'), path.join(root, 'start.sh'));
  write(path.join(root, 'tools', 'prepare-build-info.cjs'),
    "process.stdout.write('2.0.1+aaaaaaaaaaaaaaaa\\n');\n");
  write(path.join(root, 'server.js'), `
    const http = require('http');
    const server = http.createServer((_req, res) => { res.statusCode = 503; res.end('not ready'); });
    server.listen(Number(process.env.PORT), '127.0.0.1');
  `);
  const port = await reservePort();
  const pidfile = path.join(root, `.bridge.${port}.pid`);
  const child = spawn('bash', [path.join(root, 'start.sh')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), RELAYBRIDGE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  await waitUntil(() => fs.existsSync(pidfile));
  serverPid = Number(fs.readFileSync(pidfile, 'utf8').trim());
  child.kill('SIGTERM');
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 143, output);
  assert.equal(fs.existsSync(pidfile), false);
  await waitUntil(() => !isLiveProcess(serverPid));
  assert.equal(isLiveProcess(serverPid), false);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
});

test('lifecycle scripts guard credentials, preserve generated identity, and require exact ready health', () => {
  const install = fs.readFileSync(path.join(ROOT, 'install-mcp.sh'), 'utf8').replace(/\r\n/g, '\n');
  const releaseInstall = fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');
  const start = fs.readFileSync(path.join(ROOT, 'start.sh'), 'utf8');
  const windowsStart = fs.readFileSync(path.join(ROOT, 'start.ps1'), 'utf8');
  const windowsMcp = fs.readFileSync(path.join(ROOT, 'install-mcp.ps1'), 'utf8');
  assert.equal(spawnSync('sh', ['-n', path.join(ROOT, 'install-mcp.sh')]).status, 0);
  assert.equal(spawnSync('bash', ['-n', path.join(ROOT, 'start.sh')]).status, 0);
  assert.doesNotMatch(install, /snapshot "\$build_info" build-info/);
  assert.doesNotMatch(install, /restore "\$build_info" build-info/);
  assert.match(install, /"\$node_path" "\$build_info_tool" "\$script_dir"/);
  const posixLock = install.lastIndexOf('\nacquire_install_lock\n');
  const posixSnapshot = install.indexOf('snapshot "$codex_config" codex');
  assert.ok(posixLock >= 0 && posixSnapshot > posixLock,
    'POSIX registration must acquire its full-transaction lock before configuration snapshots');
  assert.match(install, /lock_dir=\/tmp\/relaybridge-mcp-install-\$lock_uid\.lock/,
    'POSIX registration must use one checkout-independent lock per OS user');
  assert.doesNotMatch(install, /lock_dir=\$script_dir\/\.mcp-install\.lock/);
  const stopExit = start.indexOf('if [[ "${1:-}" == "--stop" ]]');
  const prepare = start.indexOf('expected_build_id=$("$node_bin" "$build_info_tool" "$ROOT")');
  assert.ok(stopExit >= 0 && prepare > stopExit, '--stop must exit before source build preparation');
  assert.match(start, /value\.capabilityAuth === true && value\.buildIdentityReady === true/);
  assert.match(start, /value\.pid === expectedPid/);
  assert.match(start, /setsid --fork --wait sh -c/,
    'setsid must retain the direct launcher parent while the detached server runs');
  assert.match(start, /printf "%s:%s\\n" "\$nonce" "\$\$" > "\$handoff" \|\| exit 70/,
    'the detached child must never execute server.js after a failed PID handoff write');
  const handoffWrite = start.indexOf('printf "%s:%s\\n" "$nonce" "$$" > "$handoff" || exit 70');
  const detachedExec = start.indexOf('exec "$node_bin" "$server_path"', handoffWrite);
  assert.ok(handoffWrite >= 0 && detachedExec > handoffWrite,
    'the authenticated nonce:PID handoff must be published successfully before server exec');
  const candidateAssigned = start.indexOf('started_pid="$candidate"');
  const parentProof = start.indexOf('"$ppid" != "$launcher_pid"');
  const sessionProof = start.indexOf('"$sid" != "$candidate"');
  assert.ok(parentProof >= 0 && sessionProof > parentProof && candidateAssigned > sessionProof,
    'handoff bytes must not become signalable until parent, process-group, and session ownership are proven');
  assert.match(start, /cleanup_started_process/);
  assert.match(start, /RELAYBRIDGE_EXPECTED_BUILD_ID/);
  assert.match(releaseInstall, /\.build-info\.\*\.tmp/,
    'Windows release staging must exclude an interrupted source-manifest temporary');
  for (const runtime of ['mcp-config.json', '.bridge.pid', '.bridge.*.pid', '.mcp-install.lock']) {
    assert.ok(releaseInstall.includes(runtime), `Windows release staging must exclude ${runtime}`);
  }
  assert.match(releaseInstall, /FileAttributes\]::ReparsePoint/);
  assert.match(releaseInstall, /buildIdentityReady -ne \$true/);
  assert.match(releaseInstall, /\$reportedPid -ne \[int64\]\$proc\.Id/);
  assert.match(windowsStart, /prepare-build-info\.cjs/);
  assert.match(windowsStart, /buildIdentityReady -ne \$true/);
  assert.match(windowsStart, /\$reportedPid -ne \[int64\]\$process\.Id/);
  assert.match(windowsStart, /RELAYBRIDGE_EXPECTED_BUILD_ID/);
  assert.match(windowsMcp, /prepare-build-info\.cjs/);
  assert.match(windowsMcp, /Enter-McpRegistrationLock[\s\S]*Get-ConfigSnapshot \$codexConfigPath/);
  assert.doesNotMatch(windowsMcp, /Get-ConfigSnapshot \$buildInfoPath/);
});
