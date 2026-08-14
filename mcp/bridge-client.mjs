import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import TIMEOUT_POLICY from '../timeout-policy.cjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BRIDGE_ROOT = path.resolve(HERE, '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(BRIDGE_ROOT, 'package.json'), 'utf8'));
function loadExpectedBuildId() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(BRIDGE_ROOT, 'build-info.json'), 'utf8')).buildId;
    if (/^[A-Za-z0-9._+-]{1,128}$/.test(String(value || ''))) return String(value);
  } catch {}
  return PACKAGE.version;
}
const EXPECTED_BUILD_ID = loadExpectedBuildId();
function envFirst(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && String(value).trim() !== '') return value;
  }
  return '';
}

const TOKEN_FILE = path.resolve(envFirst('RELAYBRIDGE_TOKEN_FILE', 'PS_BRIDGE_TOKEN_FILE') || path.join(BRIDGE_ROOT, '.bridge-token'));
const START_LOCK = path.join(BRIDGE_ROOT, '.mcp-start.lock');
const OUT_LOG = path.join(BRIDGE_ROOT, 'bridge.mcp.out.log');
const ERR_LOG = path.join(BRIDGE_ROOT, 'bridge.mcp.err.log');
const MAX_BRIDGE_REQUEST_TIMEOUT_MS = TIMEOUT_POLICY.oneShotMaxMs + TIMEOUT_POLICY.transportGraceMs;

function boundedBridgeRequestTimeoutMs(value) {
  const parsed = Number(value);
  const selected = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 30000;
  return Math.max(TIMEOUT_POLICY.minimumMs, Math.min(selected, MAX_BRIDGE_REQUEST_TIMEOUT_MS));
}

function validatedBaseUrl(value) {
  const url = new URL(value || 'http://127.0.0.1:8787');
  const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (url.protocol !== 'http:' || !loopback.has(url.hostname) || url.username || url.password) {
    throw new Error('RELAYBRIDGE_URL must be an unauthenticated http:// loopback URL');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

export const BASE_URL = validatedBaseUrl(envFirst('RELAYBRIDGE_URL', 'PS_BRIDGE_URL'));

export class BridgeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BridgeError';
    Object.assign(this, details);
  }
}

let cachedToken = null;
let tokenCheckedAt = 0;

function tokenFromDisk() {
  const fromEnv = String(envFirst('RELAYBRIDGE_TOKEN', 'PS_BRIDGE_TOKEN')).trim();
  if (fromEnv) return fromEnv;
  try {
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    return /^[A-Fa-f0-9]{64}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

export async function getCapabilityToken({ refresh = false } = {}) {
  if (!refresh && Date.now() - tokenCheckedAt < 5000) return cachedToken;
  tokenCheckedAt = Date.now();
  cachedToken = tokenFromDisk();
  if (cachedToken) return cachedToken;
  try {
    const response = await fetch(new URL('/api/capability', BASE_URL), {
      redirect: 'error',
      signal: AbortSignal.timeout(2000),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (/^[A-Fa-f0-9]{64}$/.test(String(data.token || ''))) {
      cachedToken = data.token;
      return cachedToken;
    }
  } catch {}
  return null;
}

export async function bridgeRequest(route, {
  method = 'GET',
  body,
  timeoutMs = 30000,
  signal,
  tokenRequired = route !== '/api/health' && route !== '/api/capability',
} = {}) {
  if (typeof route !== 'string' || !route.startsWith('/api/')) throw new Error('bridge route must start with /api/');
  const token = await getCapabilityToken();
  if (tokenRequired && !token) {
    throw new BridgeError('RelayBridge capability token is unavailable; restart the hardened bridge', { route });
  }

  // Tags every MCP-originated call so bridge telemetry can attribute it; the
  // dashboard shows these alongside its own calls.
  const headers = { Accept: 'application/json', 'X-RelayBridge-Client': 'mcp' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['X-RelayBridge-Token'] = token;
  let response;
  try {
    response = await fetch(new URL(route, BASE_URL), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(boundedBridgeRequestTimeoutMs(timeoutMs))])
        : AbortSignal.timeout(boundedBridgeRequestTimeoutMs(timeoutMs)),
    });
  } catch (error) {
    throw new BridgeError(`RelayBridge request failed: ${error.message}`, { route, cause: error });
  }
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch { payload = { text: text.slice(0, 10000) }; }
  if (!response.ok) {
    throw new BridgeError(`RelayBridge returned HTTP ${response.status}`, {
      route,
      status: response.status,
      detail: payload,
    });
  }
  return payload;
}

export async function health() {
  return bridgeRequest('/api/health', { timeoutMs: 3000, tokenRequired: false });
}

export async function waitForHealth({ timeoutMs = 15000, expectDown = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await health();
      if (!expectDown) return result;
    } catch (error) {
      lastError = error;
      if (expectDown) return { ok: true, down: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (expectDown) throw new BridgeError('RelayBridge did not stop before timeout');
  throw new BridgeError(`RelayBridge did not become healthy: ${lastError?.message || 'timeout'}`);
}

function requireExpectedBuild(result) {
  if (result?.capabilityAuth && String(result.buildId || '') === EXPECTED_BUILD_ID) return result;
  throw new BridgeError(`RelayBridge build ${result?.buildId || result?.version || 'unknown'} is using this port, but MCP expects ${EXPECTED_BUILD_ID}; perform a one-time restart before MCP can manage it`);
}

function acquireStartLock() {
  try {
    const handle = fs.openSync(START_LOCK, 'wx');
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    fs.closeSync(handle);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      const age = Date.now() - fs.statSync(START_LOCK).mtimeMs;
      if (age > 60000) {
        fs.unlinkSync(START_LOCK);
        return acquireStartLock();
      }
    } catch {}
    return false;
  }
}

function releaseStartLock() {
  try { fs.unlinkSync(START_LOCK); } catch {}
}

export async function startBridge() {
  let existing = null;
  try { existing = await health(); } catch {}
  if (existing) {
    return { started: false, health: requireExpectedBuild(existing) };
  }

  if (!acquireStartLock()) {
    return { started: false, waitedForPeer: true, health: requireExpectedBuild(await waitForHealth({ timeoutMs: 20000 })) };
  }
  try {
    const stdoutFd = fs.openSync(OUT_LOG, 'a');
    const stderrFd = fs.openSync(ERR_LOG, 'a');
    const child = spawn(process.execPath, ['server.js'], {
      cwd: BRIDGE_ROOT,
      env: { ...process.env, PORT: String(BASE_URL.port || 80) },
      detached: true,
      windowsHide: true,
      stdio: ['ignore', stdoutFd, stderrFd],
    });
    child.unref();
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    let live;
    try { live = requireExpectedBuild(await waitForHealth({ timeoutMs: 20000 })); }
    catch (error) {
      try { process.kill(child.pid, 'SIGTERM'); } catch {}
      throw error;
    }
    await getCapabilityToken({ refresh: true });
    return { started: true, pid: child.pid, health: live, logs: { stdout: OUT_LOG, stderr: ERR_LOG } };
  } finally {
    releaseStartLock();
  }
}

export async function stopBridge() {
  const before = await health();
  await bridgeRequest('/api/admin/shutdown', { method: 'POST', body: {}, timeoutMs: 5000 });
  await waitForHealth({ timeoutMs: 10000, expectDown: true });
  return { stopped: true, previous: before };
}

export async function restartBridge() {
  const before = await health();
  await bridgeRequest('/api/admin/shutdown', { method: 'POST', body: {}, timeoutMs: 5000 });
  await waitForHealth({ timeoutMs: 10000, expectDown: true });
  const started = await startBridge();
  return { restarted: true, previous: before, ...started };
}
