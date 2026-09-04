'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { prepareBuildInfo } = require('../lib/build-identity.cjs');

const ROOT = path.resolve(__dirname, '..');
const posixOnly = process.platform === 'win32' ? test.skip : test;

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
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

async function waitUntil(predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condition timeout');
}

function copySourceFixture(parent) {
  const root = path.join(parent, 'source');
  const excludedTopLevel = new Set(['.git', 'node_modules', 'data', 'migration-backups']);
  const excludedLeaf = new Set([
    '.bridge-token', '.state.json', '.mcp-start.lock', 'build-info.json',
    'mcp-config.json', '.bridge.pid',
  ]);
  fs.cpSync(ROOT, root, {
    recursive: true,
    dereference: false,
    filter(source) {
      const relative = path.relative(ROOT, source);
      if (!relative) return true;
      const parts = relative.split(path.sep);
      const leaf = parts.at(-1);
      if (excludedTopLevel.has(parts[0]) || excludedLeaf.has(leaf)) return false;
      return !leaf.endsWith('.log')
        && !/^\.bridge\..*\.pid$/.test(leaf)
        && !/^\.build-info\..*\.tmp$/.test(leaf);
    },
  });
  return root;
}

test('server has no request-time repo-local module loader after its final identity gate', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const dynamicImports = [...source.matchAll(/\bimport\((['"])(\.\/[^'"]+)\1\)/g)]
    .map((match) => match[2]);
  assert.deepEqual(dynamicImports, ['./mcp/router.mjs', './mcp/server.mjs'],
    'repo-local ESM must be represented only by the two eager cached imports');
  assert.doesNotMatch(source, /^[ \t]+.*\brequire\((['"])\.\/[^'"]+\1\)/m,
    'a handler-scoped repo-local require could load changed source after the final gate');

  const finalGate = source.lastIndexOf('const currentIdentity = loadBuildIdentity(ROOT);');
  const listen = source.indexOf('server.listen(PORT, HOST', finalGate);
  assert.ok(finalGate >= 0 && listen > finalGate, 'final identity validation must immediately guard listen');
  assert.doesNotMatch(source.slice(finalGate), /\b(?:require|import)\((['"])\.\/[^'"]+\1\)/,
    'no repo-local loader call may follow the final build identity read');
});

posixOnly('startup refuses a ready source identity changed while deferred modules load', async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-startup-identity-'));
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGKILL');
      await new Promise((resolve) => child.exitCode === null ? child.once('exit', resolve) : resolve());
    }
    fs.rmSync(parent, { recursive: true, force: true });
  });

  const root = copySourceFixture(parent);
  const barrierDir = path.join(parent, 'barrier');
  const barrierReady = path.join(barrierDir, 'ready');
  const barrierRelease = path.join(barrierDir, 'release');
  fs.mkdirSync(barrierDir);
  fs.mkdirSync(path.join(parent, 'runtime'));

  // This code exists only in the disposable fixture. It makes the real ESM
  // loader pause after the server's initial identity read, without adding a
  // production test hook to server.js.
  fs.appendFileSync(path.join(root, 'mcp', 'router.mjs'), `
const startupIdentityBarrier = process.env.RELAYBRIDGE_TEST_ROUTER_BARRIER;
if (startupIdentityBarrier) {
  fs.writeFileSync(path.join(startupIdentityBarrier, 'ready'), 'ready');
  const startupIdentityDeadline = Date.now() + 20000;
  while (!fs.existsSync(path.join(startupIdentityBarrier, 'release'))) {
    if (Date.now() > startupIdentityDeadline) throw new Error('startup identity fixture barrier timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
`);

  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'relaybridge-test@example.invalid');
  git(root, 'config', 'user.name', 'RelayBridge Test');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'startup identity fixture');
  write(path.join(root, '.git', 'info', 'exclude'), '/node_modules\n');
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  assert.equal(git(root, 'status', '--porcelain'), '', 'fixture must be clean before identity preparation');

  const prepared = prepareBuildInfo(root);
  assert.equal(prepared.identity.ready, true);
  const port = await reservePort();
  const env = {
    ...process.env,
    PORT: String(port),
    PTY_MODE: 'none',
    RELAYBRIDGE_EXPECTED_BUILD_ID: prepared.identity.buildId,
    RELAYBRIDGE_TEST_ROUTER_BARRIER: barrierDir,
    RELAYBRIDGE_TOKEN_FILE: path.join(parent, 'runtime', 'token'),
    RELAYBRIDGE_DATA_DIR: path.join(parent, 'runtime', 'data'),
    RELAYBRIDGE_CONFIG_FILE: path.join(root, 'cli-config.json'),
    RELAYBRIDGE_ALLOWED_ROOTS: root,
    RELAYBRIDGE_REMOTE_MCP: '0',
  };
  delete env.NODE_ENV;
  delete env.RELAYBRIDGE_TEST_BUILD_ID;
  delete env.RELAYBRIDGE_TEST_BUILD_IDENTITY_UNREADY;
  delete env.RELAYBRIDGE_GITHUB_REPOS;
  delete env.PS_BRIDGE_GITHUB_REPOS;

  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  await waitUntil(() => {
    if (child.exitCode !== null) throw new Error(`bridge exited before module barrier (${child.exitCode})\n${output}`);
    return fs.existsSync(barrierReady);
  });
  fs.appendFileSync(path.join(root, 'lib', 'task-queue.js'), '\n// changed after initial identity\n');
  write(barrierRelease, 'release');

  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`startup mutation process did not exit\n${output}`));
    }, 20000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  assert.notEqual(exitCode, 0, output);
  assert.match(output, /source changed while runtime modules were loading; refusing to listen/);
  assert.doesNotMatch(output, /listening on http:/);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`, {
    signal: AbortSignal.timeout(500),
  }), 'a stale ready identity must never become reachable');
});
