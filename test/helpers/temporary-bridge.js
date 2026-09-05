'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');

async function waitFor(check, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('fixture condition did not become true');
}

async function startTestBridge(t, configure, { env: extraEnv = {}, nodeArgs = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-security-bridge-'));
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(configure(root)));
  const port = await new Promise((resolve, reject) => {
    const server = http.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close((error) => error ? reject(error) : resolve(value)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [...nodeArgs, path.join(ROOT, 'server.js')], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', RELAYBRIDGE_TEST_BUILD_ID: 'security-integration-fixture',
      PORT: String(port), PTY_MODE: 'none', RELAYBRIDGE_CONFIG_FILE: configPath,
      RELAYBRIDGE_TOKEN_FILE: path.join(root, 'token'), RELAYBRIDGE_DATA_DIR: path.join(root, 'data'),
      RELAYBRIDGE_ALLOWED_ROOTS: root, ...extraEnv },
  });
  let output = '', headers;
  const collect = (data) => { output = (output + data).slice(-16000); };
  proc.stdout.on('data', collect); proc.stderr.on('data', collect);
  t.after(async () => {
    if (proc.exitCode === null) {
      try { await fetch(base + '/api/admin/shutdown', { method: 'POST', headers, signal: AbortSignal.timeout(1000) }); } catch {}
      try { await waitFor(() => proc.exitCode !== null || proc.signalCode !== null, 5000); } catch { proc.kill(); }
      await new Promise((resolve) => proc.exitCode !== null || proc.signalCode !== null ? resolve() : proc.once('exit', resolve));
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  await waitFor(async () => {
    if (proc.exitCode !== null) throw new Error('fixture bridge exited: ' + output);
    try { return (await fetch(base + '/api/health')).ok; } catch { return false; }
  }, 15000);
  const capability = await (await fetch(base + '/api/capability')).json();
  headers = { 'X-RelayBridge-Token': capability.token, 'Content-Type': 'application/json' };
  const request = async (route, body, options = {}) => {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...options });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { root, base, headers, proc, request, configPath };
}

function completeJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

module.exports = { startTestBridge, waitFor, completeJsonLines };
