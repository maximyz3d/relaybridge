'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

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
    if (proc.exitCode !== null) throw new Error(`bridge exited ${proc.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('bridge health timeout');
}

async function exerciseInvalidAllowedRoots(t, allowedRootsValue) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-empty-roots-'));
  const marker = path.join(tempRoot, 'invoked.txt');
  const config = path.join(tempRoot, 'config.json');
  const helper = path.join(ROOT, 'test', 'prompt-file-cli.js');
  fs.writeFileSync(config, JSON.stringify({
    echo: {
      label: 'Echo',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [process.execPath, helper, '--prompt-file', '{prompt_file}', '--invocation-marker', marker],
      oneshot_dangerous: [process.execPath, helper, '--prompt-file', '{prompt_file}', '--invocation-marker', marker],
      diagnostic_binary: process.execPath,
      probe: [process.execPath, helper, '--version'],
    },
  }), 'utf8');
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      PTY_MODE: 'none',
      NODE_ENV: 'test',
      RELAYBRIDGE_CONFIG_FILE: config,
      RELAYBRIDGE_TOKEN_FILE: path.join(tempRoot, 'token'),
      RELAYBRIDGE_DATA_DIR: path.join(tempRoot, 'data'),
      RELAYBRIDGE_ALLOWED_ROOTS: allowedRootsValue,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (chunk) => { output += chunk; });
  proc.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (proc.exitCode === null) proc.kill('SIGTERM');
    await new Promise((resolve) => proc.exitCode !== null ? resolve() : proc.once('exit', resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await waitForHealth(baseUrl, proc);
  const capability = await (await fetch(`${baseUrl}/api/capability`)).json();
  const response = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-RelayBridge-Token': capability.token },
    body: JSON.stringify({ kind: 'echo', prompt: 'must not invoke', requestId: `invalid-roots:${path.basename(tempRoot)}` }),
  });
  assert.equal(response.status, 400, output);
  const payload = await response.json();
  assert.equal(payload.failureClass, 'validation');
  assert.equal(payload.model_invocation, false);
  assert.equal(payload.token_usage_source, 'not_invoked');
  assert.equal(fs.existsSync(marker), false);
  assert.equal(JSON.stringify(payload).includes(allowedRootsValue), false);
  if (process.env.USERPROFILE) {
    assert.equal(JSON.stringify(payload).includes(process.env.USERPROFILE), false);
  }
  assert.equal(payload.error, 'No usable default working directory exists inside the configured RelayBridge allowed roots.');
}

test('explicit whitespace allowed roots fail closed instead of enabling USERPROFILE', async (t) => {
  await exerciseInvalidAllowedRoots(t, ' ;  ; ');
});

test('nonexistent-only allowed roots fail closed without disclosing the configured path', async (t) => {
  const nonexistent = path.join(os.tmpdir(), `relaybridge-never-created-${process.pid}-${Date.now()}`);
  await exerciseInvalidAllowedRoots(t, nonexistent);
});
