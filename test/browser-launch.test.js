'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  validateBrowserUrl,
  chromeOpeners,
  defaultOpeners,
  browserOpeners,
} = require('../lib/browser-launch');

const repoRoot = path.resolve(__dirname, '..');
const installScript = path.join(repoRoot, 'install-chrome-mcp.sh');
const relayInstallScript = path.join(repoRoot, 'install-mcp.sh');
const startScript = path.join(repoRoot, 'start-chrome-debug.sh');

test('browser URLs are bounded HTTP(S) values without embedded credentials', () => {
  assert.equal(validateBrowserUrl('https://example.com/a?q=1'), 'https://example.com/a?q=1');
  assert.throws(() => validateBrowserUrl('file:///etc/passwd'), /http/);
  assert.throws(() => validateBrowserUrl('https://user:secret@example.com'), /credentials/);
  assert.throws(() => validateBrowserUrl(' https://example.com/'), /whitespace/);
  assert.throws(() => validateBrowserUrl('https://example.com/\n'), /whitespace|control/);
  assert.throws(() => validateBrowserUrl('x'.repeat(9000)), /exceeds/);
});

test('WSL Chrome launch is an explicit GUI interop exception with argv-safe URLs', () => {
  const url = 'https://example.com/?a=1&b=$(touch nope)';
  const openers = chromeOpeners({ isWSL: true }, url);
  assert.match(openers[0].bin, /^\/mnt\/c\/Program Files\/Google\/Chrome/);
  assert.deepEqual(openers[0].args, [url]);
  assert.ok(openers.some((entry) => entry.bin === 'google-chrome'));
});

test('Windows Chrome paths use Windows separators even when planned on Linux', () => {
  const openers = chromeOpeners(
    { isWindows: true },
    'https://example.com/',
    { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\Test User\\AppData\\Local' },
  );
  assert.equal(openers[0].bin, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(openers[1].bin, 'C:\\Users\\Test User\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe');
});

test('WSL default opener selection wins over overlapping Windows platform flags', () => {
  const openers = defaultOpeners({ isWSL: true, isWindows: true }, 'https://example.com/');
  assert.equal(openers[0].bin, 'wslview');
});

test('unknown browser choices fail closed', () => {
  assert.throws(() => browserOpeners('mystery', { isLinux: true }, 'https://example.com/'), /default or chrome/);
});

test('Chrome setup scripts pass their native shell syntax checks', () => {
  const installCheck = spawnSync('sh', ['-n', installScript], { encoding: 'utf8' });
  assert.equal(installCheck.status, 0, installCheck.stderr);
  const relayInstallCheck = spawnSync('sh', ['-n', relayInstallScript], { encoding: 'utf8' });
  assert.equal(relayInstallCheck.status, 0, relayInstallCheck.stderr);
  const startCheck = spawnSync('bash', ['-n', startScript], { encoding: 'utf8' });
  assert.equal(startCheck.status, 0, startCheck.stderr);
});

test('RelayBridge MCP installer converts signals to failures before transactional cleanup', () => {
  const source = fs.readFileSync(relayInstallScript, 'utf8');
  assert.match(source, /^trap on_exit EXIT$/m);
  assert.match(source, /^trap 'exit 129' HUP$/m);
  assert.match(source, /^trap 'exit 130' INT$/m);
  assert.match(source, /^trap 'exit 143' TERM$/m);
  assert.doesNotMatch(source, /trap on_exit EXIT HUP INT TERM/);
});

test('Chrome MCP installer fails closed when both clients are skipped', () => {
  const result = spawnSync('sh', [installScript, '--skip-codex', '--skip-claude'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /both clients were skipped/);
});

test('Chrome MCP installer pins and privacy-hardens the official MCP command', () => {
  const source = fs.readFileSync(installScript, 'utf8');
  assert.match(source, /package_version=1\.8\.0/);
  for (const argument of [
    '--slim',
    '--no-usage-statistics',
    '--no-performance-crux',
    '--redact-network-headers',
  ]) {
    assert.ok(source.includes(argument), `missing ${argument}`);
  }
  assert.match(source, /major === 20 && minor >= 19/);
  assert.match(source, /major === 22 && minor >= 12/);
  assert.match(source, /major >= 23/);
  assert.match(source, /CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS/);
});

test('WSL launcher passes an injection-safe literal port and verifies Chrome JSON', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-browser-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const binDir = path.join(tempDir, 'bin');
  const capturedArgs = path.join(tempDir, 'powershell-args.txt');
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, 'powershell.exe'),
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$RELAYBRIDGE_TEST_ARGS"\n',
    { mode: 0o700 },
  );
  fs.writeFileSync(
    path.join(binDir, 'curl'),
    '#!/bin/sh\nprintf \'%s\\n\' \'{"Browser":"Chrome/151.0.0.0","webSocketDebuggerUrl":"ws://127.0.0.1:9333/devtools/browser/test"}\'\n',
    { mode: 0o700 },
  );

  const result = spawnSync('bash', [startScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      RELAYBRIDGE_CHROME_PORT: '9333',
      RELAYBRIDGE_TEST_ARGS: capturedArgs,
      WSL_DISTRO_NAME: 'RelayBridgeTest',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const args = fs.readFileSync(capturedArgs, 'utf8');
  assert.match(args, /--remote-debugging-port=9333/);
  assert.match(args, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(args, /\$profileArgument = \$quote \+ "--user-data-dir=\$profile" \+ \$quote/);
  assert.doesNotMatch(args, /RELAYBRIDGE_CHROME_PORT/);
  assert.match(result.stdout, /grants full control/);
});

test('Chrome launcher rejects invalid ports before invoking an opener', () => {
  const result = spawnSync('bash', [startScript], {
    encoding: 'utf8',
    env: { ...process.env, RELAYBRIDGE_CHROME_PORT: '9222;whoami', WSL_DISTRO_NAME: 'RelayBridgeTest' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be 1-65535/);
});
