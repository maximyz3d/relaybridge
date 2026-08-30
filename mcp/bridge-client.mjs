import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import TIMEOUT_POLICY from '../timeout-policy.cjs';
import receiptStoreIdentityModule from '../lib/receipt-store-identity.cjs';

const { receiptStoreIdentity } = receiptStoreIdentityModule;

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BRIDGE_ROOT = path.resolve(HERE, '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(BRIDGE_ROOT, 'package.json'), 'utf8'));
function loadExpectedBuildId() {
  const testValue = process.env.NODE_ENV === 'test' ? process.env.RELAYBRIDGE_TEST_BUILD_ID : '';
  if (/^[A-Za-z0-9._+-]{1,128}$/.test(String(testValue || ''))) return String(testValue);
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
const DATA_DIR = path.resolve(envFirst('RELAYBRIDGE_DATA_DIR', 'PS_BRIDGE_DATA_DIR') || path.join(BRIDGE_ROOT, 'data'));
const EXPECTED_RECEIPT_STORE_IDENTITY = receiptStoreIdentity(DATA_DIR);
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

// Routes server.js exempts from the MCP action-identity check so a mismatched
// MCP can still shut down or restart the bridge it is talking to.
const LIFECYCLE_ROUTES = new Set(['/api/admin/shutdown', '/api/admin/restart']);

export async function bridgeRequest(route, {
  method = 'GET',
  body,
  timeoutMs = 30000,
  signal,
  tokenRequired = route !== '/api/health' && route !== '/api/capability',
  actionIdentity = false,
} = {}) {
  if (typeof route !== 'string' || !route.startsWith('/api/')) throw new Error('bridge route must start with /api/');
  const token = await getCapabilityToken();
  if (tokenRequired && !token) {
    throw new BridgeError('RelayBridge capability token is unavailable; restart the hardened bridge', { route });
  }

  // The REST bridge requires build/store identity on every MCP mutation. Make
  // that invariant automatic for non-read HTTP methods so a newly added MCP
  // POST cannot accidentally omit the preflight and fail with a 409 (or, on an
  // older bridge, bypass the intended split-brain guard).
  //
  // The lifecycle routes are the one exception, and server.js already codes it
  // (requiresMcpActionIdentity: "Lifecycle endpoints are the recovery path for
  // replacing a stale build"). Without the same exemption here the preflight
  // fires client-side and stop_bridge/restart_bridge fail with the very 409
  // whose remedy is "restart RelayBridge" - the MCP surface would have no way
  // out of a mismatch and the server-side exemption would be unreachable.
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const identityRequired = (actionIdentity || !['GET', 'HEAD', 'OPTIONS'].includes(normalizedMethod))
    && !LIFECYCLE_ROUTES.has(route);
  let actionPreflight = null;
  if (identityRequired) actionPreflight = await requireExpectedActionIdentity({ signal });

  // Tags every MCP-originated call so bridge telemetry can attribute it; the
  // dashboard shows these alongside its own calls.
  const headers = { Accept: 'application/json', 'X-RelayBridge-Client': 'mcp' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['X-RelayBridge-Token'] = token;
  if (actionPreflight) {
    headers['X-RelayBridge-Expected-Build-Id'] = EXPECTED_BUILD_ID;
    headers['X-RelayBridge-Expected-Receipt-Store-Id'] = EXPECTED_RECEIPT_STORE_IDENTITY.id;
  }
  const requestTimeoutMs = boundedBridgeRequestTimeoutMs(timeoutMs);
  if (route === '/api/oneshot') {
    headers['X-RelayBridge-Client-Deadline-At'] = String(Date.now() + requestTimeoutMs);
  }
  let response;
  try {
    response = await fetch(new URL(route, BASE_URL), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)])
        : AbortSignal.timeout(requestTimeoutMs),
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
  if (actionPreflight && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return { ...payload, actionPreflight };
  }
  return payload;
}

export async function health({ signal } = {}) {
  return bridgeRequest('/api/health', { timeoutMs: 3000, tokenRequired: false, signal });
}

function actionIdentityDetail(live) {
  const currentBuildId = String(live?.buildId || '');
  const currentReceiptStoreId = typeof live?.receiptStoreId === 'string' ? live.receiptStoreId : null;
  const buildMatches = !!currentBuildId && currentBuildId === EXPECTED_BUILD_ID;
  const receiptStoreMatches = EXPECTED_RECEIPT_STORE_IDENTITY.ready
    && currentReceiptStoreId !== null
    && currentReceiptStoreId === EXPECTED_RECEIPT_STORE_IDENTITY.id;
  return {
    ok: buildMatches && receiptStoreMatches,
    expectedBuildId: EXPECTED_BUILD_ID,
    currentBuildId: currentBuildId || null,
    expectedReceiptStoreId: EXPECTED_RECEIPT_STORE_IDENTITY.id,
    currentReceiptStoreId,
    buildMatches,
    receiptStoreMatches,
    // The mismatch a second checkout produces is otherwise undiagnosable: the
    // ids are salted hashes and the remedy text may not name any path, so the
    // operator gets no way to tell WHICH process owns the port. The pid is the
    // one non-secret handle that leads to it.
    currentPid: Number.isInteger(live?.pid) ? live.pid : null,
  };
}

export async function requireExpectedActionIdentity({ signal } = {}) {
  const live = await health({ signal });
  const actionPreflight = actionIdentityDetail(live);
  if (live?.capabilityAuth && actionPreflight.ok) return actionPreflight;
  throw new BridgeError(
    'RelayBridge action identity mismatch: the bridge answering this port reports a different build or receipt store. '
    + 'Restart/reinstall so MCP and REST use the same build and receipt store, or - if a second RelayBridge installation '
    + 'owns the port (its pid is actionPreflight.currentPid) - point RELAYBRIDGE_URL and RELAYBRIDGE_DATA_DIR at the one this MCP was installed from',
    {
      route: '/api/health',
      status: 409,
      detail: {
        failureClass: 'bridge_identity_mismatch',
        model_invocation: false,
        token_usage_source: 'not_invoked',
        transport_retry_count: 0,
        provider_retries: {
          count: 0, total_delay_ms: 0, max_attempt: 0, declared_max_retries: 0,
          by_error: {}, by_status: {}, events: [], truncated: false,
          observed_events: 0, invalid_events: 0, duplicate_events: 0,
        },
        actionPreflight,
      },
    },
  );
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
  const identity = actionIdentityDetail(result);
  if (result?.capabilityAuth && identity.ok) return result;
  throw new BridgeError(
    `RelayBridge build ${result?.buildId || result?.version || 'unknown'} is using this port, but MCP expects ${EXPECTED_BUILD_ID} with receipt store ${EXPECTED_RECEIPT_STORE_IDENTITY.id || 'unavailable'}; perform a one-time restart before MCP can manage it`,
    { status: 409, detail: { failureClass: 'bridge_identity_mismatch', actionPreflight: identity } },
  );
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
