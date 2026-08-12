'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, proc) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error('test server exited early with ' + proc.exitCode);
    try {
      const response = await fetch(baseUrl + '/api/health');
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error('timed out waiting for test server');
}

test('Windows child PATH discovers the official Cursor install directory and keeps narrowed cwd defaults inside policy', {
  skip: process.platform !== 'win32',
  timeout: 30000,
}, async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-cursor-path-'));
  const localAppData = path.join(tempRoot, 'local-app-data');
  const cursorDir = path.join(localAppData, 'cursor-agent');
  const cursorShim = path.join(cursorDir, 'agent.cmd');
  const allowedRoot = path.join(tempRoot, 'allowed-workspace');
  const configPath = path.join(tempRoot, 'config.json');
  const tokenPath = path.join(tempRoot, 'capability.token');
  fs.mkdirSync(cursorDir, { recursive: true });
  fs.mkdirSync(allowedRoot, { recursive: true });
  fs.writeFileSync(cursorShim, [
    '@echo off',
    'if /I "%1"=="mixed" (',
    '  echo Logged in as cached-user',
    '  echo Not logged in 1>&2',
    '  exit /b 0',
    ')',
    'echo Not logged in',
    'exit /b 0',
    '',
  ].join('\r\n'), 'utf8');
  const cursorSeat = {
    label: 'Cursor Agent',
    diagnostic_binary: 'agent',
    probe: ['agent', 'status'],
    probe_expect: 'Logged in as',
    probe_reject: ['not logged in'],
    probe_redact: true,
    safe: [process.execPath, '-e', 'process.stdout.write(process.cwd())'],
    dangerous: [process.execPath, '-e', 'process.stdout.write(process.cwd())'],
    oneshot_safe: [process.execPath, '-e', 'process.stdout.write(process.cwd())'],
    oneshot_dangerous: [process.execPath, '-e', 'process.stdout.write(process.cwd())'],
  };
  fs.writeFileSync(configPath, JSON.stringify({
    cursor: cursorSeat,
    cursor_mixed: { ...cursorSeat, label: 'Cursor Mixed Probe', probe: ['agent', 'mixed'] },
  }), 'utf8');

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverEnv = {
    ...process.env,
    PORT: String(port),
    PTY_MODE: 'none',
    LOCALAPPDATA: localAppData,
    RELAYBRIDGE_CONFIG_FILE: configPath,
    RELAYBRIDGE_TOKEN_FILE: tokenPath,
    RELAYBRIDGE_DATA_DIR: path.join(tempRoot, 'data'),
    RELAYBRIDGE_ALLOWED_ROOTS: allowedRoot,
  };
  for (const key of Object.keys(serverEnv)) {
    if (key.toUpperCase() === 'PATH') delete serverEnv[key];
  }
  serverEnv.Path = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: serverEnv,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  proc.stdout.on('data', (chunk) => { serverOutput += chunk; });
  proc.stderr.on('data', (chunk) => { serverOutput += chunk; });
  t.after(async () => {
    if (proc.exitCode === null) proc.kill('SIGTERM');
    await new Promise((resolve) => proc.exitCode !== null ? resolve() : proc.once('exit', resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  try { await waitForHealth(baseUrl, proc); }
  catch (err) { throw new Error(err.message + '\n' + serverOutput); }

  const capability = await (await fetch(baseUrl + '/api/capability')).json();
  const headers = { 'X-RelayBridge-Token': capability.token };
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

  const diag = await (await fetch(baseUrl + '/api/diag', { headers })).json();
  assert.equal(diag.results.cursor.found, true);
  assert.equal(diag.results.cursor.ready, false);
  assert.equal(diag.results.cursor.detail, 'readiness check failed');
  assert.equal(path.resolve(diag.results.cursor.paths[0]), path.resolve(cursorShim));
  assert.equal(diag.results.cursor_mixed.ready, false, 'negative stderr must override positive stdout on an exit-zero probe');

  const workspace = await (await fetch(baseUrl + '/api/workspace', { headers })).json();
  assert.equal(workspace.explicit, true);
  assert.equal(workspace.defaultSource, 'allowed-root');
  assert.equal(path.resolve(workspace.defaultCwd), path.resolve(allowedRoot));
  assert.deepEqual(workspace.allowedRoots.map((value) => path.resolve(value)), [path.resolve(allowedRoot)]);

  const oneShotResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ kind: 'cursor', prompt: 'verify default cwd', dangerous: false }),
  });
  assert.equal(oneShotResponse.status, 200);
  assert.equal(path.resolve((await oneShotResponse.json()).stdout), path.resolve(allowedRoot));

  const sessionResponse = await fetch(baseUrl + '/api/sessions', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ kind: 'cursor', dangerous: false }),
  });
  assert.equal(sessionResponse.status, 200);
  assert.equal(path.resolve((await sessionResponse.json()).cwd), path.resolve(allowedRoot));

  const rejected = await fetch(baseUrl + '/api/sessions', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ kind: 'cursor', cwd: tempRoot, dangerous: false }),
  });
  assert.equal(rejected.status, 400);
  const rejection = await rejected.json();
  assert.match(rejection.error, /outside RELAYBRIDGE_ALLOWED_ROOTS/);
  assert.ok(rejection.error.toLowerCase().includes(allowedRoot.toLowerCase()));
});
