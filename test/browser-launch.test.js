'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const {
  validateBrowserUrl,
  chromeOpeners,
  defaultOpeners,
  browserOpeners,
} = require('../lib/browser-launch');
const {
  createProxy,
  isPrivateIpv4,
  normalizeIpv4,
  parsePort,
} = require('../tools/chrome-wsl-tcp-proxy.cjs');

const repoRoot = path.resolve(__dirname, '..');
const installScript = path.join(repoRoot, 'install-chrome-mcp.sh');
const relayInstallScript = path.join(repoRoot, 'install-mcp.sh');
const startScript = path.join(repoRoot, 'start-chrome-debug.sh');
const windowsProxyScript = path.join(repoRoot, 'tools', 'chrome-wsl-tcp-proxy.cjs');

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
  const proxyCheck = spawnSync(process.execPath, ['--check', windowsProxyScript], { encoding: 'utf8' });
  assert.equal(proxyCheck.status, 0, proxyCheck.stderr);
});

test('WSL Chrome proxy accepts only strict private IPv4 values and decimal ports', () => {
  for (const address of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1']) {
    assert.equal(isPrivateIpv4(address), true, address);
  }
  for (const address of [
    '', '0.0.0.0', '8.8.8.8', '127.0.0.1', '169.254.1.1',
    '172.15.255.255', '172.32.0.1', '::1', '192.168.1.1;whoami',
  ]) {
    assert.equal(isPrivateIpv4(address), false, address);
  }
  assert.equal(parsePort('1'), 1);
  assert.equal(parsePort('65535'), 65535);
  for (const port of ['', '0', '65536', ' 9222 ', '9.222e3', '0x2406', '9222.0', '9222;whoami']) {
    assert.equal(parsePort(port), null, port);
  }
  assert.equal(normalizeIpv4('::ffff:172.29.1.2'), '172.29.1.2');
});

test('WSL Chrome proxy rejects other sources before opening the Chrome upstream', () => {
  let acceptClient;
  let listenArgs;
  const upstreamOptions = [];
  const server = new EventEmitter();
  server.listen = (...args) => {
    listenArgs = args.slice(0, 2);
    args.at(-1)();
  };
  const fakeNet = {
    createServer(handler) {
      acceptClient = handler;
      return server;
    },
    connect(options) {
      upstreamOptions.push(options);
      return makeSocket();
    },
  };
  function makeSocket(remoteAddress = '') {
    const socket = new EventEmitter();
    socket.remoteAddress = remoteAddress;
    socket.destroyed = false;
    socket.destroy = () => { socket.destroyed = true; };
    socket.setNoDelay = () => {};
    socket.pipe = (destination) => destination;
    return socket;
  }

  createProxy({
    host: '172.29.64.1',
    port: 49222,
    destinationPort: 9222,
    source: '172.29.71.9',
  }, fakeNet);
  assert.deepEqual(listenArgs, [49222, '172.29.64.1']);
  assert.equal(server.maxConnections, 64);

  const denied = makeSocket('172.29.71.10');
  acceptClient(denied);
  assert.equal(denied.destroyed, true);
  assert.equal(upstreamOptions.length, 0);

  const allowed = makeSocket('::ffff:172.29.71.9');
  acceptClient(allowed);
  assert.deepEqual(upstreamOptions, [{ host: '127.0.0.1', port: 9222 }]);
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

test('WSL NAT fallback is exact-bound, source-restricted, and validates process ownership', () => {
  const source = fs.readFileSync(startScript, 'utf8');
  assert.match(source, /--disable --noproxy '\*'/);
  assert.match(source, /Get-NetIPAddress -AddressFamily IPv4 -IPAddress \$listenAddress/);
  assert.match(source, /InterfaceAlias -notmatch "\(\?i\)WSL"/);
  assert.match(source, /Get-NetTCPConnection -State Listen -LocalAddress \$listenAddress/);
  assert.match(source, /\.OwningProcess -eq \$child\.Id/);
  assert.match(source, /TCP4-LISTEN:\$PORT,bind=127\.0\.0\.1,reuseaddr,fork/);
  assert.match(source, /runtime_dir="\$runtime_base\/relaybridge-\$UID"/);
  assert.doesNotMatch(source, /(?:0\.0\.0\.0|IPAddress\.Any|netsh|portproxy|New-NetFirewallRule)/i);
});

test('WSL launcher passes an injection-safe literal port and verifies Chrome JSON', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-browser-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const binDir = path.join(tempDir, 'bin');
  const capturedArgs = path.join(tempDir, 'powershell-args.txt');
  const natAttempted = path.join(tempDir, 'nat-attempted');
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
  fs.writeFileSync(
    path.join(binDir, 'ip'),
    '#!/bin/sh\ntouch "$RELAYBRIDGE_TEST_NAT_ATTEMPTED"\nexit 1\n',
    { mode: 0o700 },
  );

  const result = spawnSync('bash', [startScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      RELAYBRIDGE_CHROME_PORT: '9333',
      RELAYBRIDGE_TEST_ARGS: capturedArgs,
      RELAYBRIDGE_TEST_NAT_ATTEMPTED: natAttempted,
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
  assert.equal(fs.existsSync(natAttempted), false, 'a directly reachable endpoint must bypass NAT setup');
});

test('Chrome launcher rejects invalid ports before invoking an opener', () => {
  const result = spawnSync('bash', [startScript], {
    encoding: 'utf8',
    env: { ...process.env, RELAYBRIDGE_CHROME_PORT: '9222;whoami', WSL_DISTRO_NAME: 'RelayBridgeTest' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be 1-65535/);
});

test('Chrome launcher rejects a colliding or malformed WSL bridge port', () => {
  for (const bridgePort of ['9222', '49222;whoami']) {
    const result = spawnSync('bash', [startScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RELAYBRIDGE_CHROME_PORT: '9222',
        RELAYBRIDGE_CHROME_WSL_BRIDGE_PORT: bridgePort,
        WSL_DISTRO_NAME: 'RelayBridgeTest',
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must (?:be 1-65535|differ)/);
  }
});
