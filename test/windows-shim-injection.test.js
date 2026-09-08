'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { resolveWindowsLaunch } = require('../lib/win-shim-launch');

const FIXTURES = path.join(__dirname, 'fixtures', 'windows-shims');
const ADVERSARIAL_ARGS = [
  '', 'normal', 'spaces and Unicode 雪', 'hello" & echo RB_INJECTED & rem "',
  '&|<>^()%!', '%COMSPEC%', '!PATH!', 'a\r\nb', 'trailing slash with space\\',
  '"quoted"', 'backslash\\"quote', '--flag=with space',
];

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixture(t, kind = 'npm-package.cmd') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-shim-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const shim = path.join(root, 'provider.cmd');
  const executable = path.join(root, 'node.exe');
  write(shim, fs.readFileSync(path.join(FIXTURES, kind)));
  write(executable, 'fixture native runtime');
  return { root, shim, executable, resolve: (options = {}) => resolveWindowsLaunch({
    file: shim, args: ADVERSARIAL_ARGS, platform: 'win32', nodeExecutable: executable, ...options,
  }) };
}

test('known npm package shim decodes to direct Node argv without interpreting any shell bytes', (t) => {
  const { root, shim, executable, resolve } = fixture(t);
  const script = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  write(script, 'fixture entry point');
  const result = resolve();
  assert.equal(result.mode, 'direct');
  assert.equal(result.adapter, 'npm-package-shim');
  assert.equal(result.file, executable);
  assert.deepEqual(result.args, [script, ...ADVERSARIAL_ARGS]);
  assert.equal(result.templateHash.length, 64);
  const original = fs.readFileSync(shim, 'utf8');
  write(shim, '\ufeff' + original.replace(/\r?\n/g, '\r\n'));
  assert.deepEqual(resolve(), result, 'LF and CRLF templates have identical qualification');
});

test('npm and npx core shims use bundled entry points, never the prefix shell command', (t) => {
  for (const kind of ['npm', 'npx']) {
    const { root, executable, resolve } = fixture(t, `${kind}.cmd`);
    const script = path.join(root, 'node_modules', 'npm', 'bin', `${kind}-cli.js`);
    write(script, 'fixture bundled entry point');
    const result = resolve();
    assert.equal(result.mode, 'direct');
    assert.equal(result.file, executable);
    assert.equal(result.adapter, `npm-bundled-${kind}`);
    assert.deepEqual(result.args, [script, ...ADVERSARIAL_ARGS]);
  }
});

test('unknown, appended, traversal, oversized and PowerShell wrappers fail closed', (t) => {
  const { shim, resolve } = fixture(t);
  const original = fs.readFileSync(shim, 'utf8');
  const malformed = [
    '@echo off\nnode %*', `${original}\necho appended`,
    original.replace('node_modules\\@openai', 'node_modules\\..\\outside'),
    original.replace('codex.js', 'codex.js" & echo injected & "'),
    original.replace('codex.js', 'codex.ps1'),
    original.replace('codex.js', 'codex.js:alternate'),
    'x'.repeat(65537), Buffer.from([0xff, 0xfe]),
  ];
  for (const content of malformed) {
    write(shim, content);
    assert.equal(resolve().mode, 'unsupported');
  }
  assert.equal(resolve({ file: path.join(path.dirname(shim), 'arbitrary.ps1') }).mode, 'unsupported');
  assert.equal(resolve({ file: 'unresolved-command' }).mode, 'unsupported');
  assert.equal(resolve({ args: ['bad\0arg'] }).mode, 'unsupported');
  assert.equal(resolve({ args: [42] }).mode, 'unsupported');
});

test('Cursor known wrapper pair resolves directly to bundled Node and exact argv', (t) => {
  const { root, executable, resolve } = fixture(t, 'cursor-agent.cmd');
  write(path.join(root, 'cursor-agent.ps1'), fs.readFileSync(path.join(FIXTURES, 'cursor-agent.ps1')));
  const script = path.join(root, 'index.js');
  write(script, 'fixture cursor entry point');
  const env = { LOCALAPPDATA: path.join(root, 'local'), CURSOR_INVOKED_AS: 'untrusted inherited value' };
  const result = resolve({ env });
  assert.equal(result.mode, 'direct');
  assert.equal(result.file, executable);
  assert.equal(result.adapter, 'cursor-bundled-node');
  assert.deepEqual(result.args, [script, ...ADVERSARIAL_ARGS]);
  assert.deepEqual(result.envPatch, {
    CURSOR_INVOKED_AS: 'provider.cmd', NODE_COMPILE_CACHE: path.join(env.LOCALAPPDATA, 'cursor-compile-cache'),
  });
  write(path.join(root, 'cursor-agent.ps1'), '$args | Invoke-Expression');
  assert.equal(resolve().mode, 'unsupported', 'unqualified PowerShell is never executed');
});

test('Cursor version selection handles legacy hashes and timestamped releases deterministically', (t) => {
  const { root, executable, resolve } = fixture(t, 'cursor-agent.cmd');
  fs.unlinkSync(executable);
  write(path.join(root, 'cursor-agent.ps1'), fs.readFileSync(path.join(FIXTURES, 'cursor-agent.ps1')));
  for (const version of ['2026.9.3-999999', '2026.9.4-ffffffff', '2026.9.4-09-30-01-abc123']) {
    write(path.join(root, 'versions', version, 'node.exe'), 'fixture runtime');
    write(path.join(root, 'versions', version, 'index.js'), 'fixture entry point');
  }
  const result = resolve();
  assert.equal(result.mode, 'direct');
  assert.equal(result.file, path.join(root, 'versions', '2026.9.4-09-30-01-abc123', 'node.exe'));
});

test('missing runtime and symlinked launch files cannot fall back to a shell', (t) => {
  const { root, shim, executable, resolve } = fixture(t);
  const script = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  assert.equal(resolve().mode, 'unsupported');
  write(script, 'fixture');
  for (const indirect of [shim, executable, script, path.dirname(script)]) {
    let observed = false;
    const io = Object.create(fs);
    io.lstatSync = (file) => {
      const stat = fs.lstatSync(file);
      if (file === indirect) {
        observed = true;
        stat.isSymbolicLink = () => true;
      }
      return stat;
    };
    assert.equal(resolve({ fsApi: io }).mode, 'unsupported');
    assert.equal(observed, true, 'each independent leaf/ancestor check must actually be reached');
  }
});

test('shim replacement during descriptor open is rejected without reading replacement bytes', (t) => {
  const { shim, resolve } = fixture(t);
  const io = Object.create(fs);
  let readCount = 0;
  io.openSync = (file, flags) => {
    const handle = fs.openSync(file, flags);
    write(shim, 'replaced');
    return handle;
  };
  io.readSync = (...args) => { readCount += 1; return fs.readSync(...args); };
  assert.equal(resolve({ fsApi: io }).mode, 'unsupported');
  assert.equal(readCount, 0);
});

test('qualified native executables and POSIX commands keep their original argv', (t) => {
  const { executable } = fixture(t);
  for (const [platform, file] of [['win32', executable], ['linux', '/usr/bin/claude']]) {
    const result = resolveWindowsLaunch({ platform, file, args: ADVERSARIAL_ARGS });
    assert.equal(result.mode, 'direct');
    assert.equal(result.file, file);
    assert.deepEqual(result.args, ADVERSARIAL_ARGS);
  }
  for (const file of ['provider.exe', '.\\provider.exe', 'C:provider.exe', path.join(path.dirname(executable), 'missing.exe')]) {
    assert.equal(resolveWindowsLaunch({ platform: 'win32', file }).mode, 'unsupported',
      'a failed PATH lookup must never fall back to an executable in the requested workspace');
  }
});

test('native Windows roundtrip preserves all adversarial argv and cannot run an injected sentinel', {
  skip: process.platform !== 'win32',
}, (t) => {
  const { root, executable, resolve } = fixture(t);
  fs.copyFileSync(process.execPath, executable);
  const script = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const sentinel = path.join(root, 'injected.txt');
  write(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const args = [...ADVERSARIAL_ARGS, `" & echo INJECTED > "${sentinel}" & rem "`];
  const launch = resolve({ args });
  assert.equal(launch.mode, 'direct');
  const result = spawnSync(launch.file, launch.args, {
    shell: false, windowsHide: true, encoding: 'utf8', cwd: root,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
  assert.equal(fs.existsSync(sentinel), false);
});
