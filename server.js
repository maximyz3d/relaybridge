// RelayBridge - local PowerShell + multi-AI-CLI bridge
// Runs on 127.0.0.1 only. Spawns real PTYs (node-pty) when available,
// falls back to child_process pipes otherwise.

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { RunSupervisor, resolveSupervisorOptions, normalizeProviderBudget } = require('./lib/run-supervisor');
const { validateProviderBudget } = require('./lib/provider-budget');
const { resolveModelArgs, applyModelArgs, modelConfigStaleness, modelTierForTaskTier } = require('./lib/model-tiers');
const { buildRegistry, parseModelList, pinIsRetired } = require('./lib/model-registry');
const { buildTaskPlan, costClassFor } = require('./lib/task-plan');
const { createWorkflowPipeline } = require('./lib/workflow-pipeline');
const { createWorkflowController } = require('./lib/workflow-controller');
const { buildQuotaSeatGroups } = require('./lib/quota-seat');
const providerAccounts = require('./lib/provider-accounts');
const { providerUsageCapability, providerUsageCapabilities } = require('./lib/provider-usage-capability');
const platform = require('./lib/platform');
const { validateBrowserUrl, browserOpeners } = require('./lib/browser-launch');
const { receiptStoreIdentity } = require('./lib/receipt-store-identity.cjs');
const {
  resolveFilesystemPolicy, providerFilesystemEligibility,
  createIsolatedProviderHome, cleanupIsolatedProviderHome,
} = require('./lib/provider-filesystem-policy');
const { WebSocketServer } = require('ws');
const { spawn, spawnSync } = require('child_process');
const TIMEOUT_POLICY = require('./timeout-policy.cjs');
const ROOT = __dirname;
// USERPROFILE is Windows-only. On POSIX the same idea is HOME; without this
// fallback the allowed roots collapse to ROOT and the bridge can only reach
// its own source tree.
const USER_HOME = process.env.USERPROFILE || process.env.HOME || os.homedir() || ROOT;
const BRIDGE_VERSION = require('./package.json').version;
function loadBuildId() {
  const testValue = process.env.NODE_ENV === 'test' ? process.env.RELAYBRIDGE_TEST_BUILD_ID : '';
  if (/^[A-Za-z0-9._+-]{1,128}$/.test(String(testValue || ''))) return String(testValue);
  try {
    const value = JSON.parse(fs.readFileSync(path.join(ROOT, 'build-info.json'), 'utf8')).buildId;
    if (/^[A-Za-z0-9._+-]{1,128}$/.test(String(value || ''))) return String(value);
  } catch {}
  return BRIDGE_VERSION;
}
const BRIDGE_BUILD_ID = loadBuildId();

// Cross-provider effort vocabulary.  `max` is deliberately an intent rather
// than a value we blindly pass to every CLI: Codex's highest normal value is
// `xhigh`, while other providers may expose a literal `max` flag.  The adapter
// below resolves the intent through provider-declared controls and records the
// value that was actually sent.
const SUPPORTED_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const EXTREME_EFFORTS = new Set(['xhigh', 'max']);
const EFFORT_BY_TASK_TIER = Object.freeze({
  deterministic: 'minimal',
  utility: 'low',
  standard: 'medium',
  complex: 'high',
  critical: 'high',
});

// ---- config ----
const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = '127.0.0.1';
const STATE_FILE = path.join(ROOT, '.state.json');
function envFirst(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && String(value).trim() !== '') return value;
  }
  return '';
}

const CONFIG_FILE = envFirst('RELAYBRIDGE_CONFIG_FILE', 'PS_BRIDGE_CONFIG_FILE') || path.join(ROOT, 'cli-config.json');
const TOKEN_FILE = envFirst('RELAYBRIDGE_TOKEN_FILE', 'PS_BRIDGE_TOKEN_FILE') || path.join(ROOT, '.bridge-token');
const STARTED_AT = new Date().toISOString();
const INSTANCE_ID = crypto.randomUUID();

// ---- capability token file protection ----------------------------------
// POSIX mode bits are a no-op on NTFS. A token file created inside a user
// profile normally inherits whatever the parent tree grants, which on a machine
// with extra local/sandbox accounts can mean a long list of principals holding
// Modify on the bridge's capability token. Harden the DACL for that one file:
// remove inheritance, keep the current user, SYSTEM, and Administrators. This is
// deliberately best-effort â€” a failure is reported loudly and never causes the
// token to be deleted or rotated, because that would lock out live clients.
const TOKEN_ACL_SKIPPED = /^(1|true|yes)$/i.test(envFirst('RELAYBRIDGE_SKIP_TOKEN_ACL', 'PS_BRIDGE_SKIP_TOKEN_ACL'));
const SID_SYSTEM = 'S-1-5-18';
const SID_ADMINISTRATORS = 'S-1-5-32-544';

function runIcacls(args) {
  const result = spawnSync('icacls.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (result.error) return { ok: false, detail: result.error.message, stdout: '' };
  const stdout = String(result.stdout || '');
  if (result.status !== 0) {
    return { ok: false, detail: (String(result.stderr || '') || stdout).trim().split('\n')[0] || `icacls exited ${result.status}`, stdout };
  }
  return { ok: true, detail: '', stdout };
}

// The "(I)" inherited flag is not localized, unlike the principal names, so the
// count of inherited access-control entries is the portable readiness signal.
function readTokenAclState(filePath) {
  const listed = runIcacls([filePath]);
  if (!listed.ok) return { ok: false, detail: listed.detail, inherited: null, entries: null };
  const entries = listed.stdout
    .split(/\r?\n/)
    .filter((line) => /:\(/.test(line))
    .map((line) => line.replace(filePath, '').trim());
  return {
    ok: true,
    detail: '',
    inherited: entries.filter((line) => line.includes('(I)')).length,
    entries: entries.length,
  };
}

function currentUserSid() {
  const result = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const match = /(S-[0-9]+(?:-[0-9]+)+)/.exec(String(result.stdout || ''));
  return match ? match[1] : null;
}

// POSIX used to assert "mode bits already restrict this file" without ever
// looking at the file. That claim is false on any filesystem that ignores mode
// bits: a checkout (or a RELAYBRIDGE_TOKEN_FILE / RELAYBRIDGE_DATA_DIR) under
// /mnt on WSL is DrvFs/9p mounted with no metadata option, where both the 0600
// in writeFileSync and the follow-up chmodSync succeed silently and leave the
// file 0777 — so the swallowing catch never fires, /api/health reported the
// token as protected, and every other local account could read full bridge
// control. Stat the result instead of describing it, and let the existing
// operator warning fire when the filesystem did not honour the request.
function verifyPosixTokenMode(filePath) {
  let mode;
  try { mode = fs.statSync(filePath).mode & 0o777; }
  catch (err) {
    return { platform: process.platform, applicable: true, hardened: false, detail: `could not stat the token file to verify its mode: ${err.message}` };
  }
  const octal = mode.toString(8).padStart(3, '0');
  const restricted = (mode & 0o077) === 0;
  return {
    platform: process.platform,
    applicable: true,
    hardened: restricted,
    mode: octal,
    detail: restricted
      ? `mode ${octal}: no group or other access`
      : `mode ${octal}: the filesystem did not honour the requested 0600 (a /mnt DrvFs or 9p mount does this) — every local account can read this token`,
  };
}

function hardenTokenFileAcl(filePath) {
  if (process.platform !== 'win32') return verifyPosixTokenMode(filePath);
  if (TOKEN_ACL_SKIPPED) return { platform: 'win32', applicable: true, hardened: null, skipped: true, detail: 'RELAYBRIDGE_SKIP_TOKEN_ACL is set' };
  const before = readTokenAclState(filePath);
  if (!before.ok) return { platform: 'win32', applicable: true, hardened: false, detail: `could not read the token ACL: ${before.detail}` };
  const sid = currentUserSid();
  if (!sid) {
    return { platform: 'win32', applicable: true, hardened: false, inheritedEntries: before.inherited, detail: 'could not resolve the current user SID; left the inherited ACL untouched' };
  }
  const applied = runIcacls([
    filePath,
    '/inheritance:r',
    '/grant:r', `*${sid}:(F)`,
    '/grant:r', `*${SID_SYSTEM}:(F)`,
    '/grant:r', `*${SID_ADMINISTRATORS}:(F)`,
  ]);
  if (!applied.ok) {
    return { platform: 'win32', applicable: true, hardened: false, inheritedEntries: before.inherited, detail: `icacls could not harden the token ACL: ${applied.detail}` };
  }
  const after = readTokenAclState(filePath);
  if (!after.ok) {
    return { platform: 'win32', applicable: true, hardened: false, detail: `applied the ACL but could not verify it: ${after.detail}` };
  }
  return {
    platform: 'win32',
    applicable: true,
    hardened: after.inherited === 0,
    inheritedEntriesBefore: before.inherited,
    inheritedEntriesAfter: after.inherited,
    principals: after.entries,
    alreadyProtected: before.inherited === 0,
    detail: after.inherited === 0
      ? `${before.inherited ? `removed ${before.inherited} inherited entries and ` : ''}granted the current user, SYSTEM, and Administrators`
      : `${after.inherited} inherited entries survived hardening`,
  };
}

let TOKEN_ACL = { applicable: false, hardened: null, detail: 'token supplied through RELAYBRIDGE_TOKEN or PS_BRIDGE_TOKEN; no file to protect' };

function loadOrCreateCapabilityToken() {
  const configured = String(envFirst('RELAYBRIDGE_TOKEN', 'PS_BRIDGE_TOKEN')).trim();
  if (/^[A-Fa-f0-9]{64}$/.test(configured)) return configured;
  let token = null;
  try {
    const saved = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (/^[A-Fa-f0-9]{64}$/.test(saved)) token = saved;
  } catch {}
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(TOKEN_FILE, token + '\n', { encoding: 'utf8', mode: 0o600 });
  }
  try { fs.chmodSync(TOKEN_FILE, 0o600); } catch {}
  try { TOKEN_ACL = hardenTokenFileAcl(TOKEN_FILE); }
  catch (err) { TOKEN_ACL = { applicable: true, hardened: false, detail: `token ACL hardening threw: ${err.message}` }; }
  if (TOKEN_ACL.applicable && TOKEN_ACL.hardened === false) {
    console.warn(`[RelayBridge] WARNING: the capability token file is not ACL-protected â€” ${TOKEN_ACL.detail}`);
    console.warn(`[RelayBridge]          ${TOKEN_FILE}`);
    console.warn('[RelayBridge]          Any account that can read it holds full bridge control. The token was NOT rotated or deleted.');
  }
  return token;
}

const CAPABILITY_TOKEN = loadOrCreateCapabilityToken();
function firstDefinedEnv(...names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(process.env, name)) {
      return { defined: true, name, value: String(process.env[name] || '') };
    }
  }
  return { defined: false, name: null, value: '' };
}

const ALLOWED_ROOTS_SETTING = firstDefinedEnv(
  'RELAYBRIDGE_ALLOWED_ROOTS', 'PS_BRIDGE_ALLOWED_ROOTS',
);
const ALLOWED_ROOTS_VALUE = ALLOWED_ROOTS_SETTING.value;
const ALLOWED_ROOTS = (ALLOWED_ROOTS_SETTING.defined
  ? ALLOWED_ROOTS_VALUE.split(';')  // ';' is the bridge's own cross-platform convention, not path.delimiter
  : [USER_HOME, ROOT])
  .map((value) => String(value).trim())
  .filter(Boolean)
  .map((value) => path.resolve(value));

const CWD_OUTSIDE_ALLOWED_ROOTS = 'cwd_outside_allowed_roots';
const CWD_OUTSIDE_REASON = 'The requested working directory resolves outside RelayBridge allowed roots.';
const CWD_IDENTITY_CHANGED = 'cwd_identity_changed';
const CWD_IDENTITY_CHANGED_REASON = 'The working directory identity changed after admission and before provider execution.';
const CWD_ENROLLMENT_GUIDANCE = 'Use an existing allowed working directory, or explicitly add the intended root to RELAYBRIDGE_ALLOWED_ROOTS and restart RelayBridge. RelayBridge did not change the allowlist.';

function pathIdentity(value) {
  const normalized = path.resolve(String(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function statDirectoryIdentity(value) {
  const stat = fs.statSync(value, { bigint: true });
  if (!stat.isDirectory()) throw new Error('not a directory');
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

function lexicalObjectIdentity(value) {
  const stat = fs.lstatSync(value, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

function snapshotAllowedRoot(value) {
  const lexical = pathIdentity(value);
  try {
    const realpath = fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
    const canonical = pathIdentity(realpath);
    return {
      lexical,
      canonical,
      lexicalObjectIdentity: lexicalObjectIdentity(value),
      directoryIdentity: statDirectoryIdentity(realpath),
      available: true,
    };
  } catch {
    // A configured root that does not exist at startup is not silently enrolled
    // if it appears later.  Enrollment is a startup-time trust decision.
    return {
      lexical, canonical: null, lexicalObjectIdentity: null,
      directoryIdentity: null, available: false,
    };
  }
}

const ALLOWED_ROOT_SNAPSHOTS = ALLOWED_ROOTS.map(snapshotAllowedRoot);

function currentAllowedRootSnapshot(snapshot) {
  if (!snapshot?.available) return null;
  try {
    const realpath = fs.realpathSync.native
      ? fs.realpathSync.native(snapshot.lexical) : fs.realpathSync(snapshot.lexical);
    const canonical = pathIdentity(realpath);
    const currentLexicalObjectIdentity = lexicalObjectIdentity(snapshot.lexical);
    const directoryIdentity = statDirectoryIdentity(realpath);
    if (canonical !== snapshot.canonical
      || currentLexicalObjectIdentity !== snapshot.lexicalObjectIdentity
      || directoryIdentity !== snapshot.directoryIdentity) return null;
    return snapshot;
  } catch {
    return null;
  }
}

function pathIdentityHash(value, { raw = false } = {}) {
  const identity = raw ? String(value) : pathIdentity(value);
  // Host paths have low entropy and an unsalted digest is a dictionary oracle.
  // The installation capability is never returned in receipts, making these
  // stable identifiers useful to the local operator but non-reversible to a
  // receipt consumer.
  return crypto.createHmac('sha256', CAPABILITY_TOKEN).update(identity).digest('hex');
}

function opaqueIdentity(value) {
  return crypto.createHmac('sha256', CAPABILITY_TOKEN)
    .update(JSON.stringify(value)).digest('hex');
}

const CWD_POLICY_IDENTITY = opaqueIdentity(ALLOWED_ROOT_SNAPSHOTS.map((root) => ({
  lexical: root.lexical,
  canonical: root.canonical,
  lexicalObjectIdentity: root.lexicalObjectIdentity,
  directoryIdentity: root.directoryIdentity,
  available: root.available,
})));

function isInsideRoots(candidate, roots) {
  const normalized = pathIdentity(candidate);
  return roots.some((root) => {
    const normalizedRoot = pathIdentity(root);
    return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + path.sep);
  });
}

function cwdOutsideAllowedRootsError(requested, normalized, canonical = null) {
  const allAllowedRootHashes = [...new Set(
    ALLOWED_ROOT_SNAPSHOTS.map((root) => pathIdentityHash(root.canonical || root.lexical)),
  )];
  const validation = {
    code: CWD_OUTSIDE_ALLOWED_ROOTS,
    field: 'cwd',
    reason: CWD_OUTSIDE_REASON,
    retryable: false,
    requestedRootHash: pathIdentityHash(requested, { raw: true }),
    normalizedRootHash: pathIdentityHash(normalized),
    canonicalRootHash: canonical ? pathIdentityHash(canonical) : null,
    allowedRootHashes: allAllowedRootHashes.slice(0, 32),
    allowedRootHashCount: allAllowedRootHashes.length,
    allowedRootHashesTruncated: allAllowedRootHashes.length > 32,
    guidance: CWD_ENROLLMENT_GUIDANCE,
    allowlistChanged: false,
    restartRequiredForEnrollment: true,
  };
  const error = new Error(CWD_OUTSIDE_REASON);
  error.code = CWD_OUTSIDE_ALLOWED_ROOTS;
  error.validation = validation;
  return error;
}

function cwdIdentityChangedError(expectedCwdIdentityHash, observedCwdIdentityHash) {
  const validation = {
    code: CWD_IDENTITY_CHANGED,
    field: 'cwd',
    reason: CWD_IDENTITY_CHANGED_REASON,
    retryable: false,
    expectedCwdIdentityHash,
    observedCwdIdentityHash,
    cwdPolicyId: CWD_POLICY_IDENTITY,
    guidance: 'Repeat admission with the intended working directory. RelayBridge did not execute a provider.',
  };
  const error = new Error(CWD_IDENTITY_CHANGED_REASON);
  error.code = CWD_IDENTITY_CHANGED;
  error.validation = validation;
  return error;
}

function isDirectory(value) {
  try { return fs.statSync(value).isDirectory(); }
  catch { return false; }
}

function isInsideAllowedRoot(candidate) {
  return isInsideRoots(candidate, ALLOWED_ROOT_SNAPSHOTS.map((root) => root.lexical));
}

function defaultAllowedCwd() {
  const preferred = path.resolve(USER_HOME);
  const candidates = [preferred, ...ALLOWED_ROOTS];
  const seen = new Set();
  for (const candidate of candidates) {
    const normalized = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (isInsideAllowedRoot(candidate) && isDirectory(candidate)) return candidate;
  }
  throw new Error('No usable default working directory exists inside the configured RelayBridge allowed roots.');
}

function resolveAllowedCwd(value, fallback) {
  const requested = value || fallback || defaultAllowedCwd();
  const resolved = path.resolve(requested);
  if (!isInsideAllowedRoot(resolved)) {
    throw cwdOutsideAllowedRootsError(requested, resolved);
  }
  const trustedLexicalRoots = ALLOWED_ROOT_SNAPSHOTS
    .filter((root) => isInsideRoots(resolved, [root.lexical]))
    .map(currentAllowedRootSnapshot)
    .filter(Boolean);
  if (!trustedLexicalRoots.length) {
    throw cwdOutsideAllowedRootsError(requested, resolved);
  }
  if (!isDirectory(resolved)) throw new Error('The requested working directory is not an existing directory.');
  let canonical;
  try {
    const realpath = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
    canonical = pathIdentity(realpath);
  } catch {
    throw new Error('The requested working directory could not be canonicalized.');
  }
  const trustedCanonicalRoots = ALLOWED_ROOT_SNAPSHOTS
    .map(currentAllowedRootSnapshot)
    .filter(Boolean);
  if (!trustedCanonicalRoots.some((root) => isInsideRoots(canonical, [root.canonical]))) {
    throw cwdOutsideAllowedRootsError(requested, resolved, canonical);
  }
  return resolved;
}

function captureAllowedCwdIdentity(value, fallback) {
  const resolved = resolveAllowedCwd(value, fallback);
  const realpath = fs.realpathSync.native
    ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  const canonical = pathIdentity(realpath);
  const directoryIdentity = statDirectoryIdentity(realpath);
  return {
    resolved,
    canonical,
    directoryIdentity,
    cwdIdentityHash: opaqueIdentity({ canonical, directoryIdentity }),
  };
}

function revalidateAllowedCwdIdentity(snapshot) {
  const current = captureAllowedCwdIdentity(snapshot.resolved);
  if (current.canonical !== snapshot.canonical
    || current.directoryIdentity !== snapshot.directoryIdentity) {
    throw cwdIdentityChangedError(snapshot.cwdIdentityHash, current.cwdIdentityHash);
  }
  return current;
}

function workspacePolicy() {
  let defaultCwd = null;
  let error = null;
  try { defaultCwd = defaultAllowedCwd(); }
  catch (err) { error = err.message; }
  const userProfile = path.resolve(USER_HOME);
  return {
    explicit: ALLOWED_ROOTS_SETTING.defined,
    allowedRoots: [...ALLOWED_ROOTS],
    defaultCwd,
    defaultSource: defaultCwd === userProfile ? 'user-profile' : (defaultCwd ? 'allowed-root' : null),
    error,
  };
}

function tokenMatches(value) {
  const supplied = Buffer.from(String(value || ''), 'utf8');
  const expected = Buffer.from(CAPABILITY_TOKEN, 'utf8');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

// ---- node-pty (optional) ----
let pty = null;
let ptyMode = process.env.PTY_MODE || 'auto';
if (ptyMode !== 'none') {
  try {
    pty = require('node-pty');
    console.log('[RelayBridge] node-pty loaded â€” using real PTY mode');
  } catch (err) {
    console.warn('[RelayBridge] node-pty unavailable, falling back to pipe mode.');
    console.warn('           ' + err.message);
    pty = null;
  }
}

// ---- persisted state (permissions toggle) ----
function loadState() {
  const stickyDangerous = envFirst('RELAYBRIDGE_ALLOW_STICKY_DANGEROUS', 'PS_BRIDGE_ALLOW_STICKY_DANGEROUS') === '1';
  const startDangerous = envFirst('RELAYBRIDGE_START_FULL_PERMISSIONS', 'PS_BRIDGE_START_FULL_PERMISSIONS') === '1';
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      fullPermissions: stickyDangerous && (startDangerous || saved.fullPermissions === true),
    };
  } catch {
    return { fullPermissions: stickyDangerous && startDangerous };
  }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
let state = loadState();

// ---- Persistent collabs (group chats) + projects -----------------------
const DATA_DIR = path.resolve(envFirst('RELAYBRIDGE_DATA_DIR', 'PS_BRIDGE_DATA_DIR') || path.join(ROOT, 'data'));
const WSL_NATIVE_RUNTIME = platform.wslNativeRuntimeStatus({
  checkout: ROOT,
  data: DATA_DIR,
  token: TOKEN_FILE,
  config: CONFIG_FILE,
  node: process.execPath,
});
if (!WSL_NATIVE_RUNTIME.ok) {
  throw new Error(
    `RelayBridge refuses slow WSL /mnt execution for: ${WSL_NATIVE_RUNTIME.issues.join(', ')}. `
    + 'Move the checkout and runtime files under the Linux home directory, use Linux-native Node/CLIs, '
    + 'or explicitly set RELAYBRIDGE_ALLOW_SLOW_WSL_FS=1 to override.',
  );
}
const COLLABS_DIR = path.join(DATA_DIR, 'collabs');
const RUNS_DIR = path.join(DATA_DIR, 'runs');
const RECEIPTS_DIR = path.join(DATA_DIR, 'receipts');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const RECEIPT_STORE_IDENTITY = receiptStoreIdentity(DATA_DIR);
const COLLAB_ID_RE = /^c_[a-z0-9]+_[a-z0-9]+$/;
for (const dir of [COLLABS_DIR, RUNS_DIR, RECEIPTS_DIR]) fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(PROJECTS_FILE)) fs.writeFileSync(PROJECTS_FILE, JSON.stringify([], null, 2));

function listCollabs() {
  try {
    const files = fs.readdirSync(COLLABS_DIR).filter((f) => COLLAB_ID_RE.test(path.basename(f, '.json')) && f.endsWith('.json'));
    return files.map((f) => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(COLLABS_DIR, f), 'utf8'));
        return {
          id: data.id,
          name: data.name || ('Collab ' + data.id),
          project: data.project || '',
          participants: data.participants || [],
          msgCount: (data.transcript || []).length,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
        };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch { return []; }
}
function collabPath(id) {
  const value = String(id || '');
  if (!COLLAB_ID_RE.test(value)) throw new Error('invalid collaboration id');
  const resolved = path.resolve(COLLABS_DIR, `${value}.json`);
  if (path.dirname(resolved) !== path.resolve(COLLABS_DIR)) throw new Error('invalid collaboration path');
  return resolved;
}
function readCollab(id) {
  const fp = collabPath(id);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}
function writeCollab(id, data) {
  const fp = collabPath(id);
  const now = Date.now();
  const record = {
    ...data,
    id,
    name: String(data?.name || '').slice(0, 200),
    project: String(data?.project || '').slice(0, 200),
    participants: Array.isArray(data?.participants)
      ? data.participants.filter((value) => /^[A-Za-z0-9_-]{1,64}$/.test(String(value))).slice(0, 20)
      : [],
    respond: Array.isArray(data?.respond)
      ? data.respond.filter((value) => /^[A-Za-z0-9_-]{1,64}$/.test(String(value))).slice(0, 20)
      : [],
    dropped: Array.isArray(data?.dropped)
      ? data.dropped.filter((value) => /^[A-Za-z0-9_-]{1,64}$/.test(String(value))).slice(0, 20)
      : [],
    transcript: Array.isArray(data?.transcript) ? data.transcript.slice(-1000) : [],
    sharedContext: String(data?.sharedContext || '').slice(0, 250000),
    createdAt: Number.isFinite(Number(data?.createdAt)) ? Number(data.createdAt) : now,
    updatedAt: now,
  };
  const tempPath = path.join(COLLABS_DIR, `.${id}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempPath, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(tempPath, fp);
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
  }
  return record;
}
function deleteCollab(id) {
  const fp = collabPath(id);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
}
function listProjects() {
  try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); }
  catch { return []; }
}
function addProject(name) {
  const list = listProjects();
  if (!list.includes(name)) {
    list.push(name);
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(list, null, 2));
  }
  return list;
}
function newCollabId() {
  return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function listAgentActivity(limit = 12) {
  const bounded = Math.max(1, Math.min(Number(limit) || 12, 50));
  const runs = fs.readdirSync(RUNS_DIR)
    .filter((name) => /^run_[A-Za-z0-9_-]+\.json$/.test(name))
    .map((name) => {
      try {
        const run = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, name), 'utf8'));
        return {
          runId: run.runId,
          mode: run.mode,
          status: run.status,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          providers: (run.members || []).map((member) => ({ kind: member.kind, role: member.role, succeeded: member.exitCode === 0 && !member.droppedOut })),
          consensusAchieved: run.consensusAchieved ?? null,
          consensusVerdict: run.synthesisAssessment?.verdict || null,
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, bounded);
  const receipts = [];
  const files = fs.readdirSync(RECEIPTS_DIR).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse();
  for (const file of files) {
    const lines = fs.readFileSync(path.join(RECEIPTS_DIR, file), 'utf8').split(/\r?\n/).filter(Boolean).reverse();
    for (const line of lines) {
      try {
        const receipt = JSON.parse(line);
        receipts.push({
          receiptId: receipt.receiptId,
          timestamp: receipt.timestamp,
          event: receipt.event,
          status: receipt.status,
          provider: receipt.provider || null,
          runId: receipt.runId || null,
          routeId: receipt.routeId || null,
          failureClass: receipt.failureClass || null,
        });
      } catch {}
      if (receipts.length >= bounded) break;
    }
    if (receipts.length >= bounded) break;
  }
  return { runs, receipts };
}

function appendBridgeProviderReceipt({ kind, prompt, route, payload, startedAt }) {
  const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage : null;
  const modelInvocation = payload.model_invocation === false ? false
    : payload.model_invocation === null ? null : true;
  const estimatedInputTokens = estimateTokenCount(prompt);
  const estimatedOutputTokens = estimateTokenCount(payload.stdout || '');
  const actualInputTokens = nonnegativeUsageNumber(usage?.input_tokens);
  const actualOutputTokens = nonnegativeUsageNumber(usage?.output_tokens);
  const actualCacheReadTokens = nonnegativeUsageNumber(usage?.cache_read_input_tokens);
  const actualCacheCreationTokens = nonnegativeUsageNumber(usage?.cache_creation_input_tokens);
  const reportedTotalTokens = nonnegativeUsageNumber(usage?.total_tokens);
  const computedTotalTokens = actualInputTokens !== null && actualOutputTokens !== null
    ? safeTokenSum([
        actualInputTokens,
        actualOutputTokens,
        actualCacheReadTokens || 0,
        actualCacheCreationTokens || 0,
      ])
    : null;
  const actualTotalTokens = computedTotalTokens ?? reportedTotalTokens;
  const tokenUsageSource = modelInvocation === false ? 'not_invoked'
    : modelInvocation === null ? 'unknown'
    : actualTotalTokens !== null || actualInputTokens !== null || actualOutputTokens !== null
      ? 'provider_reported' : payload.cancelled ? 'unknown' : 'chars_div_4';
  const requestId = route?.request_id || null;
  const invocationId = route?.invocation_id || requestId;
  const attemptId = route?.attempt_id || (requestId ? `${requestId}:attempt:1` : null);
  const receipt = {
    receiptId: `rcpt_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
    timestamp: new Date().toISOString(),
    event: 'bridge_provider_call',
    bridgeBuildId: BRIDGE_BUILD_ID,
    receiptStoreId: RECEIPT_STORE_IDENTITY.id,
    status: payload.cancelled ? 'cancelled'
      : payload.exitCode === 0 && !payload.dropped_out ? 'completed'
        : payload.timed_out ? 'timed_out' : 'dropped',
    provider: kind,
    inputHash: crypto.createHash('sha256').update(String(prompt || '')).digest('hex'),
    inputChars: String(prompt || '').length,
    estimatedInputTokens,
    outputHash: crypto.createHash('sha256').update(String(payload.stdout || '')).digest('hex'),
    outputChars: String(payload.stdout || '').length,
    estimatedOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
    actualInputTokens,
    actualOutputTokens,
    actualCacheReadInputTokens: actualCacheReadTokens,
    actualCacheCreationInputTokens: actualCacheCreationTokens,
    actualTotalTokens,
    actualThinkingTokens: nonnegativeUsageNumber(usage?.thinking_tokens),
    provider_reported_cost_usd: nonnegativeCostNumber(usage?.cost_usd),
    tokenUsageSource,
    tokenEstimateScope: tokenUsageSource === 'chars_div_4'
      ? (estimatedOutputTokens > 0 ? 'request_and_response_chars_only' : 'request_chars_only') : null,
    modelInvocation,
    requestId,
    invocationId,
    attemptId,
    physicalAttemptCount: modelInvocation === false ? 0 : 1,
    outerReceiptId: route?.outer_receipt_id || null,
    modelUsage: Array.isArray(usage?.model_usage) ? usage.model_usage : [],
    vendorQuota: payload.vendor_quota || null,
    quotaEvidence: payload.quota_evidence || null,
    providerActionRequired: payload.provider_action_required || null,
    providerRetryCount: nonnegativeUsageNumber(payload.provider_retries?.count),
    providerRetryDelayMs: nonnegativeUsageNumber(payload.provider_retries?.total_delay_ms),
    providerRetryMaxAttempt: nonnegativeUsageNumber(payload.provider_retries?.max_attempt),
    providerDeclaredMaxRetries: nonnegativeUsageNumber(payload.provider_retries?.declared_max_retries),
    providerRetryByError: payload.provider_retries?.by_error || {},
    providerRetryByStatus: payload.provider_retries?.by_status || {},
    providerRetryEvents: Array.isArray(payload.provider_retries?.events) ? payload.provider_retries.events : [],
    providerRetryEventsTruncated: payload.provider_retries?.truncated === true,
    providerRetryObservedEvents: nonnegativeUsageNumber(payload.provider_retries?.observed_events),
    providerRetryInvalidEvents: nonnegativeUsageNumber(payload.provider_retries?.invalid_events),
    providerRetryDuplicateEvents: nonnegativeUsageNumber(payload.provider_retries?.duplicate_events),
    resultSubtype: normalizeClaudeResultString(payload.result_subtype),
    resultSchemaDisagreement: payload.result_schema_disagreement === true,
    providerStopReason: normalizeClaudeResultString(payload.provider_stop_reason),
    providerTerminalReason: normalizeClaudeResultString(payload.provider_terminal_reason),
    providerApiErrorStatus: nonnegativeUsageNumber(payload.provider_api_error_status),
    providerNumTurns: nonnegativeUsageNumber(payload.provider_num_turns),
    providerDurationMs: nonnegativeUsageNumber(payload.provider_duration_ms),
    providerApiDurationMs: nonnegativeUsageNumber(payload.provider_api_duration_ms),
    providerErrorCount: nonnegativeUsageNumber(payload.provider_error_count),
    providerErrorObserved: nonnegativeUsageNumber(payload.provider_error_observed),
    providerErrorInvalid: nonnegativeUsageNumber(payload.provider_error_invalid),
    providerErrorDiagnosticTruncated: payload.provider_error_diagnostic_truncated === true,
    providerErrorHash: payload.provider_error_diagnostic
      ? crypto.createHash('sha256').update(String(payload.provider_error_diagnostic)).digest('hex') : null,
    partialResult: payload.partial_result === true,
    failureSentinel: normalizeClaudeResultString(payload.failure_sentinel),
    failureSentinelSource: normalizeClaudeResultString(payload.failure_sentinel_source),
    partialDiagnosticChars: payload.partial_result === true
      ? String(payload.partial_diagnostic || '').length : 0,
    partialDiagnosticHash: payload.partial_result === true
      ? crypto.createHash('sha256').update(String(payload.partial_diagnostic || '')).digest('hex') : null,
    partialDiagnosticTruncated: payload.partial_result === true
      ? payload.partial_diagnostic_truncated === true : false,
    stopReason: normalizeClaudeResultString(payload.stop_reason),
    supervisorStopReason: normalizeClaudeResultString(payload.supervisor_stop_reason),
    providerTimeoutSource: normalizeClaudeResultString(payload.provider_timeout_source),
    providerBudget: payload.provider_budget || null,
    providerBudgetEnforcement: normalizeClaudeResultString(payload.provider_budget_enforcement),
    providerPermissionDenialCount: nonnegativeUsageNumber(payload.provider_permission_denials?.count),
    providerPermissionDenialObserved: nonnegativeUsageNumber(payload.provider_permission_denials?.observed),
    providerPermissionDenialInvalid: nonnegativeUsageNumber(payload.provider_permission_denials?.invalid),
    providerPermissionDenialsTruncated: payload.provider_permission_denials?.truncated === true,
    providerPermissionDenialsByTool: payload.provider_permission_denials?.byTool || {},
    providerPermissionDenials: Array.isArray(payload.provider_permission_denials?.retained)
      ? payload.provider_permission_denials.retained : [],
    policyReason: normalizeClaudeResultString(payload.policy_reason),
    policyDetailHash: payload.policy_detail
      ? crypto.createHash('sha256').update(String(payload.policy_detail)).digest('hex') : null,
    transportOutputChars: nonnegativeUsageNumber(payload.transport_output_chars),
    transportOutputHash: normalizeClaudeResultString(payload.transport_output_hash, 64),
    progressAtCancellation: payload.cancelled && payload.progress
      ? payload.progress : null,
    cleanedOutputUnavailable: typeof payload.cleaned_output_unavailable === 'boolean'
      ? payload.cleaned_output_unavailable
      : payload.cancelled ? !String(payload.stdout || '').trim() : null,
    durationMs: Date.now() - startedAt,
    failureClass: payload.cancelled ? (payload.failureClass || 'cancelled')
      : payload.failureClass || (payload.rate_limited ? 'rate_limit'
        : payload.budget_exceeded ? 'budget'
          : payload.auth_failed ? 'auth'
            : payload.timed_out ? 'timeout'
              : payload.permission_denied ? 'policy'
                : payload.exitCode === 0 && !payload.dropped_out ? null : 'provider_error'),
    route,
  };
  appendBridgeReceiptRecord(receipt);
  return receipt;
}

function appendBridgeReceiptRecord(receipt) {
  const filePath = path.join(RECEIPTS_DIR, `${receipt.timestamp.slice(0, 10)}.jsonl`);
  const handle = fs.openSync(filePath, 'a');
  try {
    fs.writeFileSync(handle, `${JSON.stringify(receipt)}\n`, 'utf8');
    fs.fsyncSync(handle);
  } finally { fs.closeSync(handle); }
}

// Direct REST callers need the same durable zero-invocation accounting that an
// MCP outer receipt provides. Keep a small in-process index and fall back to the
// append-only store so a caller retrying the same requestId after a bridge
// restart dereferences the original rejection instead of appending a duplicate.
const preAdmissionReceiptByRequestId = new Map();
const MAX_PRE_ADMISSION_RECEIPT_SCAN_LINES = 500000;

function preAdmissionReceiptKey(requestId, rejectionFingerprint) {
  return `${requestId}:${rejectionFingerprint}`;
}

function findPreAdmissionReceiptByRequestId(requestId, rejectionFingerprint) {
  const cacheKey = preAdmissionReceiptKey(requestId, rejectionFingerprint);
  if (preAdmissionReceiptByRequestId.has(cacheKey)) {
    return preAdmissionReceiptByRequestId.get(cacheKey);
  }
  const requestToken = `\"requestId\":${JSON.stringify(requestId)}`;
  let scanned = 0;
  const files = fs.readdirSync(RECEIPTS_DIR)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
    .reverse();
  for (const file of files) {
    const lines = fs.readFileSync(path.join(RECEIPTS_DIR, file), 'utf8').split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if ((scanned += 1) > MAX_PRE_ADMISSION_RECEIPT_SCAN_LINES) return null;
      if (!lines[index] || !lines[index].includes(requestToken)) continue;
      try {
        const receipt = JSON.parse(lines[index]);
        if (receipt.event === 'bridge_provider_rejection'
          && receipt.requestId === requestId
          && receipt.rejectionFingerprint === rejectionFingerprint) {
          preAdmissionReceiptByRequestId.set(cacheKey, receipt);
          return receipt;
        }
      } catch {}
    }
  }
  return null;
}

function normalizeOneShotRequestId(body) {
  const supplied = String(body?.requestId || '');
  return /^[A-Za-z0-9._:-]{8,160}$/.test(supplied)
    ? supplied : `oneshot:${crypto.randomUUID()}`;
}

function canonicalAttemptIdentity(requestId) {
  return {
    invocationId: requestId,
    attemptId: `${requestId}:attempt:1`,
  };
}

function normalizeOuterReceiptId(body) {
  if (body?._relayClient !== 'mcp') return null;
  const value = String(body?.outerReceiptId || '');
  return /^rcpt_[A-Za-z0-9._:-]{1,180}$/.test(value) ? value : null;
}

function appendBridgePreAdmissionReceipt({
  kind,
  prompt,
  requestId,
  failureClass,
  httpStatus,
  startedAt,
  route = null,
  error,
  errorCode = null,
  validation = null,
}) {
  const promptText = typeof prompt === 'string' ? prompt : '';
  const inputHash = crypto.createHash('sha256').update(promptText).digest('hex');
  const rejectionFingerprint = crypto.createHash('sha256').update(JSON.stringify({
    kind: typeof kind === 'string' ? kind : null,
    inputHash,
    failureClass,
    httpStatus,
    errorCode,
    validation,
    route: route || null,
  })).digest('hex');
  const existing = findPreAdmissionReceiptByRequestId(requestId, rejectionFingerprint);
  if (existing) return { receipt: existing, deduplicated: true };
  const receipt = {
    receiptId: `rcpt_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
    timestamp: new Date().toISOString(),
    event: 'bridge_provider_rejection',
    bridgeBuildId: BRIDGE_BUILD_ID,
    bridgeInstanceId: INSTANCE_ID,
    receiptStoreId: RECEIPT_STORE_IDENTITY.id,
    status: 'rejected',
    httpStatus,
    provider: typeof kind === 'string' && kind ? kind : null,
    inputHash,
    inputChars: promptText.length,
    estimatedInputTokens: estimateTokenCount(promptText),
    outputHash: crypto.createHash('sha256').update('').digest('hex'),
    outputChars: 0,
    estimatedOutputTokens: 0,
    estimatedTotalTokens: estimateTokenCount(promptText),
    actualInputTokens: null,
    actualOutputTokens: null,
    actualCacheReadInputTokens: null,
    actualCacheCreationInputTokens: null,
    actualTotalTokens: null,
    actualThinkingTokens: null,
    provider_reported_cost_usd: null,
    tokenUsageSource: 'not_invoked',
    tokenEstimateScope: null,
    modelInvocation: false,
    requestId,
    invocationId: requestId,
    attemptId: requestId,
    physicalAttemptCount: 0,
    transportRetryCount: 0,
    providerRetryCount: 0,
    providerRetryDelayMs: 0,
    providerRetryMaxAttempt: 0,
    providerDeclaredMaxRetries: 0,
    providerRetryByError: {},
    providerRetryByStatus: {},
    providerRetryEvents: [],
    providerRetryEventsTruncated: false,
    providerRetryObservedEvents: 0,
    providerRetryInvalidEvents: 0,
    providerRetryDuplicateEvents: 0,
    transportReceiptId: null,
    durationMs: Math.max(0, Date.now() - startedAt),
    failureClass,
    errorCode,
    validation,
    rejectionFingerprint,
    errorHash: error
      ? crypto.createHash('sha256').update(String(error)).digest('hex') : null,
    route: route || {
      provider: typeof kind === 'string' && kind ? kind : null,
      request_id: requestId,
    },
  };
  appendBridgeReceiptRecord(receipt);
  preAdmissionReceiptByRequestId.set(
    preAdmissionReceiptKey(requestId, rejectionFingerprint), receipt,
  );
  return { receipt, deduplicated: false };
}

function setRejectionIdentityHeaders(res, receipt) {
  if (typeof res.setHeader !== 'function') return;
  res.setHeader('X-RelayBridge-Receipt-Id', receipt.receiptId);
  res.setHeader('X-RelayBridge-Request-Id', receipt.requestId);
  res.setHeader('X-RelayBridge-Build-Id', BRIDGE_BUILD_ID);
  res.setHeader('X-RelayBridge-Receipt-Store-Id', RECEIPT_STORE_IDENTITY.id);
}

function sendOneShotPreAdmissionRejection(res, {
  statusCode,
  payload,
  kind,
  prompt,
  requestId,
  failureClass,
  startedAt,
  route,
}) {
  const accounting = {
    model_invocation: false,
    token_usage_source: 'not_invoked',
    transportReceiptId: null,
    transport_retry_count: 0,
    provider_retries: ZERO_PROVIDER_RETRIES,
    requestId,
    invocationId: requestId,
    attemptId: requestId,
    bridgeBuildId: BRIDGE_BUILD_ID,
    receiptStoreId: RECEIPT_STORE_IDENTITY.id,
  };
  try {
    const { receipt, deduplicated } = appendBridgePreAdmissionReceipt({
      kind,
      prompt,
      requestId,
      failureClass,
      httpStatus: statusCode,
      startedAt,
      route,
      error: payload?.error,
      errorCode: payload?.errorCode || null,
      validation: payload?.validation || null,
    });
    setRejectionIdentityHeaders(res, receipt);
    return res.status(statusCode).json({
      ...payload,
      ...accounting,
      route: route || payload?.route || null,
      failureClass,
      receiptId: receipt.receiptId,
      receiptPersisted: true,
      receiptDeduplicated: deduplicated,
    });
  } catch (error) {
    const receiptId = `rcpt_unpersisted_${Date.now().toString(36)}`;
    setRejectionIdentityHeaders(res, { receiptId, requestId });
    return res.status(statusCode).json({
      ...payload,
      ...accounting,
      route: route || payload?.route || null,
      failureClass,
      receiptId,
      receiptPersisted: false,
      receiptDeduplicated: false,
      receiptPersistenceError: error.message,
    });
  }
}

function sendOneShotResult(res, payload, meta) {
  if (res.writableEnded || res.destroyed) return;
  const requestId = meta?.route?.request_id || null;
  payload = {
    ...payload,
    requestId,
    invocationId: meta?.route?.invocation_id || requestId,
    attemptId: meta?.route?.attempt_id || (requestId ? `${requestId}:attempt:1` : null),
    physical_attempt_count: payload.model_invocation === false ? 0 : 1,
  };
  const classified = classifyRunFailure({
    provider: meta?.kind,
    prompt: meta?.prompt,
    stdout: payload.stdout,
    transportStdout: meta?.transportStdout,
    stderr: payload.stderr,
    exitCode: payload.exitCode,
    elapsedMs: meta?.startedAt ? Date.now() - meta.startedAt : 0,
    // classifyRunFailure's stopReason means "the supervisor stopped this run",
    // and it short-circuits on any value before its INTERNAL_TIMEOUT patterns
    // run. stop_reason also carries provider-derived reasons — the CLI's own
    // internal timeout — so passing it turned the exact case
    // lib/provider-failure.js was written for (gemini, exit 1, "timeout waiting
    // for response") into supervisor_provider_internal_timeout with
    // failUp:false, writing a ledger failureKind that blames the bridge for a
    // provider fault. Paths that know about the supervisor say so explicitly;
    // older payloads that only carry stop_reason set it for bridge stops only.
    stopReason: Object.prototype.hasOwnProperty.call(payload, 'supervisor_stop_reason')
      ? payload.supervisor_stop_reason
      : payload.stop_reason,
    modelFlagSent: !!meta?.route?.model_flag_sent,
  });
  if (classified.partialResult) {
    payload = {
      ...payload,
      stdout: '',
      failureClass: 'incomplete_response',
      dropped_out: true,
      partial_result: true,
      failure_sentinel: classified.failureSentinel,
      failure_sentinel_source: classified.failureSentinelSource,
      partial_diagnostic: cleanOutput(classified.partialDiagnostic),
      stop_reason: 'provider_incomplete_response',
      stop_detail: classified.detail,
    };
  } else if (classified.kind === 'incomplete_response' && !payload.dropped_out) {
    payload = {
      ...payload,
      failureClass: 'incomplete_response',
      dropped_out: true,
      stop_reason: 'provider_incomplete_response',
      stop_detail: classified.detail,
    };
  }
  // Usage ledger: every run — CLI, local Ollama, hosted adapter — exits
  // through here, so this single hook catches them all. Wrapped because
  // accounting must never be able to break a response.
  try {
    if (meta && meta.kind && typeof recordRunUsage === 'function') {
      const ok = payload.exitCode === 0 && !payload.dropped_out;
      // Classify once and use it for BOTH accounting and cooldown, so the two
      // can never disagree about why a run ended.
      const failureKind = payload.provider_action_required?.kind === 'usage_quota_exhausted'
        ? 'quota_exhausted'
        : payload.rate_limited ? 'rate_limited'
        : payload.auth_failed ? 'auth_failed'
        : payload.failureClass || (classified.kind !== 'ok' ? classified.kind : null);
      const effectiveQuotaSeat = payload.route?.quota_seat || meta.route?.quota_seat
        || quotaSeatForProvider(meta.kind);
      if (failureKind === 'rate_limited') {
        const vendorQuota = parseGrokQuota429({
          provider: meta.kind,
          rateLimited: payload.rate_limited,
          failureClass: payload.failureClass,
          text: `${payload.stdout || ''}\n${payload.stderr || ''}`,
          model: payload.route?.resolved_model_identity || payload.model || null,
        });
        if (vendorQuota) {
          payload.vendor_quota = usageLedger.observeVendorQuota({
            ...vendorQuota,
            quotaSeat: effectiveQuotaSeat,
          });
        }
      }
      recordRunUsage({
        kind: meta.kind, route: payload.route || meta.route, usage: payload.usage,
        // Same precedence the vendor-quota parse above uses: the model the
        // provider says answered, then the one the route asked for.
        model: payload.route?.resolved_model_identity || payload.model || null,
        startedAt: meta.startedAt, ok, failureKind,
      });
      // Post-hoc grounding check: a seat WITH access can still hallucinate, and
      // an answer citing only nonexistent files is not about this repository.
      try {
        if (ok && meta.cwd && payload.stdout) {
          const v = verifyReferencedPaths(payload.stdout, meta.cwd);
          if (v.checked && (v.confidence === 'likely-fabricated' || v.confidence === 'suspect')) {
            payload.grounding_warning = v.note;
            payload.grounding = { confidence: v.confidence, missing: v.missing.slice(0, 10), present: v.present.slice(0, 10) };
          }
        }
      } catch { /* verification is advisory; never fail a run over it */ }
      try {
        if (ok) {
          cooldowns.noteSuccess(effectiveQuotaSeat);
          // A model-scoped cooldown is keyed by provider rather than account.
          // A successful call through any linked account proves that model is
          // available again, while the account-specific clear above remains
          // isolated to the subscription that paid for this run.
          const providerCooldown = cooldowns.status(meta.kind);
          if (effectiveQuotaSeat !== meta.kind && providerCooldown.cooling
            && providerCooldown.scope === 'model') cooldowns.noteSuccess(meta.kind);
        }
        else if (failureKind) {
          // An explicitly model-scoped vendor observation must not cool every
          // model on the account. Generic 429/overload evidence has no narrower
          // scope, so it conservatively applies to the shared quota seat.
          const cooldownSeat = payload.vendor_quota?.scope === 'model' ? meta.kind : effectiveQuotaSeat;
          const cooldown = cooldowns.noteFailure(cooldownSeat, failureKind, {
            retryAfterSec: parseRetryAfter(`${payload.stdout || ''}\n${payload.stderr || ''}`, payload.retry_after),
            scope: payload.vendor_quota?.scope === 'model' ? 'model' : 'account',
          });
          if (cooldown?.until) {
            // Return the deadline actually committed by the shared cooldown
            // store. Workflow/task retry logic must not guess a shorter delay
            // and deliberately invoke a seat the router still considers cool.
            payload.retry_at = cooldown.until;
            payload.retry_after = Math.max(1, Math.ceil((cooldown.until - Date.now()) / 1000));
            payload.cooldown = {
              seat: cooldown.seat,
              until: cooldown.until,
              reason: cooldown.reason,
              source: cooldown.source,
              offences: cooldown.offences,
            };
          }
        }
      } catch { /* cooldown bookkeeping must never break a response */ }
      try {
        const selectedAccountId = meta.accountId || payload.route?.account || meta.route?.account || null;
        if (selectedAccountId) {
          const changed = ok
            ? providerAccounts.clearAccountAuthFailure(DATA_DIR, meta.kind, selectedAccountId)
            : payload.auth_failed === true
              ? providerAccounts.noteAccountAuthFailure(
                  DATA_DIR, meta.kind, selectedAccountId, loadConfig()[meta.kind] || {},
                )
              : null;
          if (changed) invalidateAccountRegistry();
          if (selectedAccountId === providerAccounts.DEFAULT_ACCOUNT_ID) {
            if (ok) updateDefaultAccountRuntimeAuth(meta.kind, true);
            else if (payload.auth_failed === true) updateDefaultAccountRuntimeAuth(meta.kind, false);
          }
        }
      } catch { /* account health bookkeeping must never break a response */ }
    }
  } catch { /* ignored on purpose */ }
  try {
    const receipt = appendBridgeProviderReceipt({ ...meta, payload });
    res._relayReceiptPersisted = receipt.receiptId;
    res.json({ ...payload, receiptId: receipt.receiptId, receiptPersisted: true });
    return payload;
  } catch (error) {
    res.json({ ...payload, receiptId: `rcpt_unpersisted_${Date.now().toString(36)}`, receiptPersisted: false, receiptPersistenceError: error.message });
    return payload;
  }
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

// Build a child-process environment that also sees user-level CLI installs.
// This covers npm shims, Antigravity's LocalAppData directory, and Python/uv
// console scripts under ~/.local/bin even when the long-lived server inherited
// PATH before a provider was installed.
// Resolve relative script paths in a CLI slot ("tools/pplx.js") to absolute
// paths under the bridge install dir. Without this, the script path gets
// looked up relative to the spawn cwd (which is the user's home dir), so
// `node tools/pplx.js` fails with `Cannot find module 'C:\\Users\\you\\tools\\pplx.js'`.
function resolveSlot(slot) {
  if (!Array.isArray(slot)) return slot;
  return slot.map((arg, i) => {
    if (i === 0 || typeof arg !== 'string') return arg;       // command itself / non-strings: leave alone
    if (path.isAbsolute(arg)) return arg;                      // already absolute
    if (!arg.includes('/') && !arg.includes('\\')) return arg; // just a flag, no path
    const candidate = path.join(ROOT, arg);
    return fs.existsSync(candidate) ? candidate : arg;
  });
}

function normalizeEffort(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SUPPORTED_EFFORTS.includes(normalized) ? normalized : null;
}

function parseReasoningEffortAssignment(value) {
  const match = /^(model_reasoning_effort|reasoning_effort)\s*=\s*(.+)$/i.exec(String(value || '').trim());
  if (!match) return null;
  const rawValue = match[2].trim().replace(/^(["'])(.*)\1$/, '$2').toLowerCase();
  const effort = normalizeEffort(rawValue);
  return effort ? { key: match[1], effort } : null;
}

// Inspect only the explicit, documented effort forms RelayBridge knows how to
// reason about.  Unknown config assignments are left alone rather than being
// guessed at and then reported as an applied control.
function findEffortControl(args) {
  if (!Array.isArray(args)) return null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if ((arg === '--effort' || arg === '--reasoning-effort') && index + 1 < args.length) {
      const effort = normalizeEffort(String(args[index + 1]));
      if (effort) return { index, width: 2, effort, flag: arg, method: 'flag' };
    }
    if ((arg === '--config' || arg === '-c') && index + 1 < args.length) {
      const assignment = parseReasoningEffortAssignment(args[index + 1]);
      if (assignment) {
        return {
          index, width: 2, effort: assignment.effort, flag: arg,
          configKey: assignment.key, method: 'config',
        };
      }
    }
    const inlineConfig = /^--config=(.*)$/i.exec(String(arg || ''));
    const assignment = inlineConfig ? parseReasoningEffortAssignment(inlineConfig[1]) : null;
    if (assignment) {
      return {
        index, width: 1, effort: assignment.effort, flag: '--config',
        configKey: assignment.key, method: 'config',
      };
    }
  }
  return null;
}

function stripEffortControls(args) {
  const out = [];
  let firstRemovedAt = null;
  for (let index = 0; index < args.length;) {
    const control = findEffortControl(args.slice(index));
    if (!control) {
      out.push(...args.slice(index));
      break;
    }
    const absoluteIndex = index + control.index;
    out.push(...args.slice(index, absoluteIndex));
    if (firstRemovedAt == null) firstRemovedAt = out.length;
    index = absoluteIndex + control.width;
  }
  return { args: out, firstRemovedAt };
}

function effortArgsInsertIndex(slot, entry = {}, preferredIndex = null) {
  if (Number.isInteger(preferredIndex)) return Math.max(1, Math.min(preferredIndex, slot.length));
  if (Number.isInteger(entry.effort_arg_index)) {
    return Math.max(1, Math.min(entry.effort_arg_index, slot.length));
  }
  const promptFileAt = slot.findIndex((arg) => typeof arg === 'string' && arg.includes('{prompt_file}'));
  if (promptFileAt >= 0) {
    // Keep `--prompt-file {prompt_file}` together.  This also leaves a script
    // path immediately after `node`, which makes deterministic CLI fixtures a
    // faithful stand-in for real providers.
    return promptFileAt > 0 && String(slot[promptFileAt - 1]).startsWith('-')
      ? promptFileAt - 1 : promptFileAt;
  }
  const inlinePromptAt = slot.findIndex((arg) => typeof arg === 'string' && arg.includes('{prompt}'));
  if (inlinePromptAt >= 0) return inlinePromptAt;
  if (slot.length > 1 && slot.at(-1) === '-') return slot.length - 1;
  return slot.length;
}

function insertEffortArgs(slot, effortArgs, entry = {}, preferredIndex = null) {
  const out = slot.slice();
  const at = effortArgsInsertIndex(out, entry, preferredIndex);
  out.splice(at, 0, ...effortArgs);
  return out;
}

function configuredEffortArgs(entry, requestedEffort) {
  const configured = entry?.effort_flags?.[requestedEffort];
  if (!Array.isArray(configured) || !configured.length || configured.some((arg) => typeof arg !== 'string')) {
    return null;
  }
  return configured.slice();
}

function configuredReasoningEffortFamily(entry) {
  const values = entry?.effort_flags && typeof entry.effort_flags === 'object'
    ? Object.values(entry.effort_flags) : [];
  for (const args of values) {
    const control = findEffortControl(args);
    if (control?.method === 'config' && control.configKey) {
      return { flag: control.flag === '-c' ? '-c' : '--config', key: control.configKey };
    }
  }
  return null;
}

function modelImpliedEffort(modelChoice, entry = {}) {
  if (!modelChoice?.model) return null;
  const suffix = /(?:^|-)(minimal|low|medium|high|xhigh|max)$/i.exec(String(modelChoice.model));
  if (suffix) return suffix[1].toLowerCase();
  // A configured weight class is the only effort expression for several local
  // providers.  Do not make this claim for Codex-style seats, where model size
  // and reasoning effort are independent controls.
  if (entry.effort_flags && Object.keys(entry.effort_flags).length) return null;
  return { light: 'low', standard: 'medium', heavy: 'high' }[modelChoice.modelTier] || null;
}

function applyProviderEffort({ slot, entry = {}, modelChoice = {}, requestedEffort = null }) {
  const existing = findEffortControl(slot);
  if (!requestedEffort) {
    if (existing) {
      return {
        slot, appliedEffort: existing.effort,
        method: existing.method === 'config' ? 'effort_flags' : 'flag',
        control: existing.configKey ? `${existing.flag} ${existing.configKey}` : existing.flag,
      };
    }
    const implied = modelImpliedEffort(modelChoice, entry);
    return {
      slot, appliedEffort: implied,
      method: implied ? 'model_choice' : 'account_default',
      control: implied ? 'model' : null,
    };
  }

  let effortArgs = configuredEffortArgs(entry, requestedEffort);
  let method = effortArgs ? 'effort_flags' : null;

  // Current Codex accepts xhigh through model_reasoning_effort, but older
  // configurations may predate an explicit xhigh row.  Seeing that exact
  // configuration family is enough to construct xhigh safely.  Never perform
  // the same synthesis for max: Codex does not accept a literal max and must
  // use the provider's declared max fallback instead.
  const configFamily = configuredReasoningEffortFamily(entry)
    || (existing?.method === 'config' && existing.configKey
      ? { flag: existing.flag, key: existing.configKey } : null);
  if (!effortArgs && requestedEffort === 'xhigh' && configFamily) {
    effortArgs = [configFamily.flag, `${configFamily.key}=xhigh`];
    method = 'effort_flags';
  }

  if (!effortArgs && existing?.method === 'flag') {
    effortArgs = [existing.flag, requestedEffort];
    method = 'flag';
  }
  if (!effortArgs && existing?.method === 'config' && requestedEffort !== 'max') {
    effortArgs = [existing.flag, `${existing.configKey}=${requestedEffort}`];
    method = 'effort_flags';
  }

  if (effortArgs) {
    const actual = findEffortControl(effortArgs);
    if (!actual) {
      return { error: 'configured effort_flags do not contain a recognized effort control' };
    }
    const stripped = stripEffortControls(slot);
    return {
      slot: insertEffortArgs(stripped.args, effortArgs, entry, stripped.firstRemovedAt),
      appliedEffort: actual.effort,
      method,
      control: actual.configKey ? `${actual.flag} ${actual.configKey}` : actual.flag,
    };
  }

  const implied = modelImpliedEffort(modelChoice, entry);
  if (implied === requestedEffort) {
    return { slot, appliedEffort: implied, method: 'model_choice', control: 'model' };
  }
  return {
    error: `provider cannot express requested effort=${requestedEffort}`
      + (implied ? `; selected model tier applies ${implied}` : ''),
  };
}

function annotateRequestedPlanEffort(plan, config, requestedEffort) {
  plan.effort = requestedEffort;
  const candidates = new Set([
    plan.primary,
    ...(Array.isArray(plan.alternates) ? plan.alternates : []),
    plan.cheapestCapable,
  ].filter(Boolean));
  for (const candidate of candidates) {
    candidate.effort = requestedEffort;
    const entry = config?.[candidate.kind] || {};
    let effortArgs = configuredEffortArgs(entry, requestedEffort);
    const family = configuredReasoningEffortFamily(entry);
    if (!effortArgs && requestedEffort === 'xhigh' && family) {
      effortArgs = [family.flag, `${family.key}=xhigh`];
    }
    const baseSlot = Array.isArray(entry.oneshot_safe) ? entry.oneshot_safe : [];
    const baseControl = findEffortControl(baseSlot);
    if (!effortArgs && baseControl?.method === 'flag') {
      effortArgs = [baseControl.flag, requestedEffort];
    }
    if (!effortArgs && baseControl?.method === 'config' && requestedEffort !== 'max') {
      effortArgs = [baseControl.flag, `${baseControl.configKey}=${requestedEffort}`];
    }
    const actual = findEffortControl(effortArgs || []);
    if (actual) {
      candidate.args = stripEffortControls(Array.isArray(candidate.args) ? candidate.args : []).args
        .concat(effortArgs);
      candidate.effortMethod = actual.method === 'config' ? 'effort_flags' : 'flag';
      candidate.appliedEffort = actual.effort;
      candidate.effortSupported = true;
      continue;
    }
    const implied = modelImpliedEffort({ model: candidate.model, modelTier: candidate.modelTier }, entry);
    candidate.appliedEffort = implied;
    candidate.effortSupported = implied === requestedEffort;
    if (candidate.effortSupported) candidate.effortMethod = 'model_choice';
  }
  if (plan.primary?.effortSupported === false) {
    plan.guidance = [
      ...(Array.isArray(plan.guidance) ? plan.guidance : []),
      `${plan.primary.label || plan.primary.kind} cannot express effort=${requestedEffort} with its selected model/control; execution will reject before spending provider quota.`,
    ];
  }
}

function buildEnv(extras = {}, stripNames = []) {
  const env = { ...process.env, ...extras };
  const stripped = new Set((stripNames || []).map((name) => String(name).toUpperCase()));
  for (const key of Object.keys(env)) {
    if (stripped.has(key.toUpperCase())) delete env[key];
  }
  if (process.platform === 'win32') {
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'Path';
    const cur = env[pathKey] || '';
    const candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin'),
      path.join(process.env.LOCALAPPDATA || '', 'cursor-agent'),
      path.join(USER_HOME, '.local', 'bin'),
      path.join(USER_HOME, '.cursor', 'bin'),
      path.join(process.env.APPDATA || '', 'npm'),
      path.join(process.env.LOCALAPPDATA || '', 'npm'),
      path.join(process.env.LOCALAPPDATA || '', 'RelayBridge', 'tools', 'perplexity-web-mcp', '.venv', 'Scripts'),
    ].filter((p) => p && fs.existsSync(p));
    const preferred = new Set(candidates.map((p) => p.toLowerCase()));
    const remaining = cur.split(';').filter((p) => p && !preferred.has(p.toLowerCase()));
    env[pathKey] = [...candidates, ...remaining].join(';');
  } else {
    // The comment above promised ~/.local/bin coverage while the whole
    // candidate block sat inside the win32 branch — including the POSIX-only
    // ~/.local/bin entry, which is what gives away that the guard is the bug.
    // On POSIX buildEnv returned the inherited PATH untouched, so a bridge
    // started without a login shell (a systemd unit, an MCP stdio launcher, a
    // desktop entry) hands every provider spawn, probe and PTY session a PATH
    // with no user-level npm/pip prefix on it: the dashboard reports every
    // seat "not installed" while the same commands work in the operator's own
    // shell. lib/platform.js dodges this with `bash -lc`, but no provider
    // spawn in this file goes through buildExecSpawn.
    const cur = env.PATH || '';
    const candidates = [
      path.join(USER_HOME, '.local', 'bin'),
      path.join(USER_HOME, '.npm-global', 'bin'),
      path.join(USER_HOME, '.cargo', 'bin'),
      path.join(USER_HOME, '.cursor', 'bin'),
      path.join(USER_HOME, 'bin'),
    ].filter((p) => p && fs.existsSync(p));
    const preferred = new Set(candidates);
    const remaining = cur.split(path.delimiter).filter((p) => p && !preferred.has(p));
    env.PATH = [...candidates, ...remaining].join(path.delimiter);
  }
  return env;
}

function normalizeEnvOverrides(raw, fieldName = 'oneshot_env') {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(`${fieldName} must be an object of string environment values`);
  }
  const normalized = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key || key.includes('=') || key.includes('\0')) {
      throw new TypeError(`${fieldName} contains an invalid environment name`);
    }
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new TypeError(`${fieldName}.${key} must be a NUL-free string`);
    }
    normalized[key] = value;
  }
  return normalized;
}

// Windows interop binaries are executable-by-mode on WSL, so a naive POSIX PATH
// walk happily "finds" them. Opt back in with RELAYBRIDGE_ALLOW_WIN_INTEROP=1.
const ALLOW_WIN_INTEROP = /^(1|true|yes)$/i.test(String(process.env.RELAYBRIDGE_ALLOW_WIN_INTEROP || ''));
const WIN_EXEC_SUFFIX = /\.(exe|cmd|bat|ps1|com)$/i;

// Like resolveExecutable, but also reports what it deliberately walked past, so
// the dashboard can say WHY a seemingly-installed CLI is not on offer.
// A full PATH miss costs one statSync per PATH entry, and on WSL most of the
// inherited entries are 9p mounts under /mnt: ~90ms per miss here, against
// 0.015ms for a hit. /api/diag does one lookup per seat before it starts
// probing and the dashboard calls /api/diag from six places, so a sweep of
// mostly-not-installed seats spends seconds walking the same directories.
// Memoize on (command, PATH) for a short window — long enough to collapse a
// dashboard refresh burst, short enough that a CLI installed by hand outside
// the bridge appears on the next sweep. /api/install clears it outright.
const EXECUTABLE_CACHE_TTL_MS = 15000;
const executableCache = new Map();
function resolveExecutableInfo(command, env = buildEnv()) {
  // Key on the PATH the lookup will actually walk. Resolved the same
  // case-insensitive way as the walk itself: on Windows a spread of
  // process.env keeps the original casing ('Path'), and a plain-object read of
  // the wrong case would key every env to the same empty string.
  const pathKey = Object.keys(env || {}).find((k) => k.toUpperCase() === 'PATH') || 'Path';
  const cacheKey = `${command}\u0000${(env && env[pathKey]) || ''}`;
  const cached = executableCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expires > now) return cached.value;
  const value = resolveExecutableInfoUncached(command, env);
  if (executableCache.size > 256) {
    for (const [key, entry] of executableCache) if (entry.expires <= now) executableCache.delete(key);
  }
  executableCache.set(cacheKey, { value, expires: now + EXECUTABLE_CACHE_TTL_MS });
  return value;
}

function resolveExecutableInfoUncached(command, env) {
  const none = { resolved: command, interopSkipped: [] };
  if (!command) return none;
  if (path.isAbsolute(command)) return { resolved: command, interopSkipped: [] };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'Path';
  // POSIX: no PATHEXT and no case-folding — walk PATH and take the first entry
  // that is a file with an execute bit. Returning `command` unchanged here (the
  // old non-win32 early return) made seat discovery's `resolved !== binary`
  // test permanently false, so every CLI reported "not installed" on Linux.
  if (process.platform !== 'win32') {
    if (command.includes('/')) return { resolved: command, interopSkipped: [] };
    // A .exe/.cmd name cannot be a native POSIX seat. On WSL it resolves
    // through /mnt interop and launches a Win32 process that cannot chdir into
    // the POSIX workspace; on plain Linux it never resolves at all.
    const namedWindowsBinary = !ALLOW_WIN_INTEROP && WIN_EXEC_SUFFIX.test(command);
    const interopSkipped = [];
    for (const dir of String(env[pathKey] || '').split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(dir, command);
      try {
        const st = fs.statSync(candidate);
        if (!st.isFile() || !(st.mode & 0o111)) continue;
        // /mnt is the Windows filesystem reached over 9p. Everything there is
        // mode 777, so the execute bit proves nothing, and the Windows npm
        // prefix on the inherited PATH shadows real Linux installs.
        const isInterop = !ALLOW_WIN_INTEROP && candidate.startsWith('/mnt/');
        if (isInterop || namedWindowsBinary) { interopSkipped.push(candidate); continue; }
        return { resolved: candidate, interopSkipped };
      } catch {}
    }
    return { resolved: command, interopSkipped };
  }
  return { resolved: resolveExecutableWin32(command, env, pathKey), interopSkipped: [] };
}

function resolveExecutable(command, env = buildEnv()) {
  return resolveExecutableInfo(command, env).resolved;
}

function resolveExecutableWin32(command, env, pathKey) {
  const dirs = String(env[pathKey] || '').split(';').filter(Boolean);
  const hasExt = !!path.extname(command);
  const pathExt = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const names = hasExt ? [command] : pathExt.map((ext) => command + ext.toLowerCase());
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
    }
  }
  return command;
}

function quoteCmdArg(value) {
  const s = String(value);
  return /[\s"&|<>^()%!]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function capPrompt(prompt, maxChars) {
  if (!maxChars || prompt.length <= maxChars) return { text: prompt, truncated: false };
  const headChars = Math.min(1800, Math.floor(maxChars / 4));
  const marker = '\n\n...[earlier conversation trimmed by RelayBridge to fit this CLI]...\n\n';
  const tailChars = Math.max(0, maxChars - headChars - marker.length);
  return {
    text: prompt.slice(0, headChars) + marker + prompt.slice(-tailChars),
    truncated: true,
  };
}

// Strip terminal noise from a CLI's captured output so Collab Mode shows clean
// chat text instead of raw escape codes and tool chatter. Removes ANSI color /
// cursor sequences, OSC sequences, lone carriage returns, and the Windows
// taskkill lines that agentic CLIs (e.g. Codex in exec mode) emit when they
// clean up child processes.
function cleanOutput(s) {
  if (!s) return '';
  let t = String(s);
  t = t.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');        // CSI (colors, cursor)
  t = t.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ''); // OSC
  t = t.replace(/\x1b[=>]/g, '');                          // misc escapes
  t = t.replace(/\r(?!\n)/g, '');                          // lone CR
  t = t.split('\n').filter((line) =>
    !/^\s*SUCCESS: The process with PID \d+/i.test(line) &&
    !/^\s*INFO:\s+(No tasks|sent a termination)/i.test(line)
  ).join('\n');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

function nonnegativeUsageNumber(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value : null;
}

function nonnegativeCostNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value : null;
}

function safeTokenSum(values) {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function estimateTokenCount(text) {
  const chars = String(text || '').length;
  return chars ? Math.ceil(chars / 4) : 0;
}

// Claude Code's JSON result contains the subscription session's complete usage,
// including cache reads/creation and helper-model calls.  Counting only the
// top-level input/output pair can understate a real call by tens of thousands
// of tokens, so prefer the per-model census when it is present and retain the
// cache dimensions separately. Thinking tokens are a subset of output tokens
// and are never added to total_tokens a second time.
function normalizeClaudeJsonUsage(document) {
  const rows = [];
  let modelUsageComplete = true;
  if (document?.modelUsage && typeof document.modelUsage === 'object' && !Array.isArray(document.modelUsage)) {
    for (const [model, value] of Object.entries(document.modelUsage)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        modelUsageComplete = false;
        continue;
      }
      const inputTokens = nonnegativeUsageNumber(value.inputTokens ?? value.input_tokens);
      const outputTokens = nonnegativeUsageNumber(value.outputTokens ?? value.output_tokens);
      const cacheReadTokens = nonnegativeUsageNumber(value.cacheReadInputTokens ?? value.cache_read_input_tokens);
      const cacheCreationTokens = nonnegativeUsageNumber(value.cacheCreationInputTokens ?? value.cache_creation_input_tokens);
      if ([inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens]
        .some((tokenCount) => tokenCount === null)) {
        modelUsageComplete = false;
        continue;
      }
      const canonicalModel = typeof value.canonicalModel === 'string'
        ? value.canonicalModel.trim() : '';
      const modelKey = String(model).trim();
      const modelName = canonicalModel || modelKey;
      if (!modelName) {
        modelUsageComplete = false;
        continue;
      }
      rows.push({
        model: modelName.slice(0, 160),
        provider: typeof value.provider === 'string' ? value.provider.trim().slice(0, 80) : '',
        input_tokens: inputTokens ?? 0,
        output_tokens: outputTokens ?? 0,
        cache_read_input_tokens: cacheReadTokens ?? 0,
        cache_creation_input_tokens: cacheCreationTokens ?? 0,
        cost_usd: nonnegativeCostNumber(value.costUSD ?? value.cost_usd),
      });
    }
  }
  const top = document?.usage && typeof document.usage === 'object' && !Array.isArray(document.usage)
    ? document.usage : {};
  const sum = (name) => safeTokenSum(rows.map((row) => row[name]));
  let fromModels = modelUsageComplete && rows.length > 0;
  const modelTotals = fromModels ? {
    input: sum('input_tokens'),
    output: sum('output_tokens'),
    cacheRead: sum('cache_read_input_tokens'),
    cacheCreation: sum('cache_creation_input_tokens'),
  } : null;
  if (fromModels && Object.values(modelTotals).some((value) => value === null)) fromModels = false;
  const topHas = (name) => Object.prototype.hasOwnProperty.call(top, name);
  const inputTokens = fromModels ? modelTotals.input : nonnegativeUsageNumber(top.input_tokens);
  const outputTokens = fromModels ? modelTotals.output : nonnegativeUsageNumber(top.output_tokens);
  const cacheReadTokens = fromModels ? modelTotals.cacheRead
    : topHas('cache_read_input_tokens') ? nonnegativeUsageNumber(top.cache_read_input_tokens) : 0;
  const cacheCreationTokens = fromModels ? modelTotals.cacheCreation
    : topHas('cache_creation_input_tokens') ? nonnegativeUsageNumber(top.cache_creation_input_tokens) : 0;
  if (!fromModels && (inputTokens === null || outputTokens === null
    || cacheReadTokens === null || cacheCreationTokens === null)) return null;
  const thinkingCandidate = nonnegativeUsageNumber(top.output_tokens_details?.thinking_tokens);
  const thinkingLimit = topHas('output_tokens')
    ? nonnegativeUsageNumber(top.output_tokens) : outputTokens;
  const thinkingTokens = thinkingCandidate !== null
    && thinkingLimit !== null && thinkingCandidate <= thinkingLimit ? thinkingCandidate : null;
  const known = [inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens]
    .some((value) => value !== null);
  if (!known) return null;
  const totalTokens = safeTokenSum([
    inputTokens || 0,
    outputTokens || 0,
    cacheReadTokens || 0,
    cacheCreationTokens || 0,
  ]);
  if (totalTokens === null) return null;
  const modelCostsComplete = fromModels && rows.every((row) => row.cost_usd !== null);
  const providerCost = nonnegativeCostNumber(document?.total_cost_usd) !== null
    ? nonnegativeCostNumber(document.total_cost_usd)
    : modelCostsComplete
      ? nonnegativeCostNumber(rows.reduce((total, row) => total + Number(row.cost_usd || 0), 0))
      : null;
  return {
    input_tokens: inputTokens ?? 0,
    output_tokens: outputTokens ?? 0,
    cache_read_input_tokens: cacheReadTokens ?? 0,
    cache_creation_input_tokens: cacheCreationTokens ?? 0,
    total_tokens: totalTokens,
    thinking_tokens: thinkingTokens,
    cost_usd: providerCost,
    token_source: 'provider_reported',
    model_usage: fromModels
      ? rows.map((row) => ({ ...row, cost_usd: modelCostsComplete ? row.cost_usd : null }))
      : [],
  };
}

// Incremental Claude stream-json usage is authoritative when attached to a
// uniquely identified assistant message. Aggregate each message exactly once;
// the terminal result, when present, replaces the aggregate with the CLI's
// complete model census. Other providers remain explicitly terminal-only or
// unavailable rather than being policed with character-count guesses.
function createProviderUsageObserver(parserName, supervisor) {
  if (parserName !== 'claude_json') return { record() {}, flush() {} };
  let partial = '';
  const seen = new Set();
  const cumulative = {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0, total_tokens: 0, turns: 0,
  };
  const consume = (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event?.type === 'result') {
      const usage = normalizeClaudeJsonUsage(event);
      const turns = nonnegativeUsageNumber(event.num_turns);
      if (usage) supervisor.recordProviderUsage({ ...usage, turns }, { phase: 'terminal' });
      else if (turns !== null) supervisor.recordProviderUsage({ turns }, { phase: 'terminal' });
      return;
    }
    if (event?.type !== 'assistant' || !event.message || typeof event.message !== 'object') return;
    const id = typeof event.message.id === 'string' ? event.message.id.trim() : '';
    if (!id || seen.has(id)) return;
    const usage = event.message.usage;
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return;
    const values = {
      input_tokens: nonnegativeUsageNumber(usage.input_tokens),
      output_tokens: nonnegativeUsageNumber(usage.output_tokens),
      cache_read_input_tokens: nonnegativeUsageNumber(usage.cache_read_input_tokens ?? 0),
      cache_creation_input_tokens: nonnegativeUsageNumber(usage.cache_creation_input_tokens ?? 0),
    };
    if (Object.values(values).some((value) => value === null)) return;
    const total = safeTokenSum(Object.values(values));
    if (total === null) return;
    seen.add(id);
    for (const [key, value] of Object.entries(values)) cumulative[key] += value;
    cumulative.total_tokens += total;
    cumulative.turns += 1;
    supervisor.recordProviderUsage(cumulative, { phase: 'incremental' });
  };
  return {
    record(chunk) {
      const lines = (partial + String(chunk || '')).split(/\r?\n/);
      partial = lines.pop() || '';
      for (const line of lines) consume(line);
    },
    flush() { if (partial.trim()) consume(partial); partial = ''; },
  };
}

const CLAUDE_RETRY_ERROR_CATEGORIES = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'billing_error',
  'rate_limit',
  'overloaded',
  'invalid_request',
  'model_not_found',
  'server_error',
  'max_output_tokens',
  'unknown',
]);

const CLAUDE_TERMINAL_REASONS = new Set([
  'completed', 'max_turns', 'tool_deferred', 'aborted_streaming', 'aborted_tools',
  'hook_stopped', 'stop_hook_prevented', 'blocking_limit', 'rapid_refill_breaker',
  'prompt_too_long', 'image_error', 'model_error',
  // Claude Code 2.1.229 expanded TerminalReason beyond the currently
  // published SDK reference. Keep this census explicit and fail closed on
  // unknown future values, but accept the values emitted by the installed
  // subscription CLI so a valid result does not lose usage/error telemetry.
  'malformed_tool_use_exhausted', 'budget_exhausted',
  'structured_output_retry_exhausted', 'api_error', 'background_requested',
  'turn_setup_failed', 'tool_deferred_unavailable',
]);
const CLAUDE_PARTIAL_DIAGNOSTIC_MAX_CHARS = 12000;

function extractClaudeAssistantDiagnostic(events, maxChars = CLAUDE_PARTIAL_DIAGNOSTIC_MAX_CHARS) {
  const messages = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'assistant' || !event.message || typeof event.message !== 'object') continue;
    const id = typeof event.message.id === 'string' ? event.message.id.trim() : '';
    if (!id || !Array.isArray(event.message.content)) continue;
    const text = event.message.content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
    const cleaned = cleanOutput(text);
    if (!messages.has(id)) {
      messages.set(id, { text: cleaned, conflicted: false });
      continue;
    }
    const state = messages.get(id);
    if (state.conflicted || !cleaned) continue;
    const previous = state.text;
    // With --include-partial-messages Claude can emit the same message ID first
    // with no text and later with the cumulative text. Accept only monotonic
    // extensions; contradictory duplicate records remain ignored fail-closed.
    if (!previous || (cleaned.length > previous.length && cleaned.startsWith(previous))) {
      state.text = cleaned;
    } else if (previous !== cleaned && !previous.startsWith(cleaned)) state.conflicted = true;
  }
  const chunks = [...messages.values()]
    .filter((state) => !state.conflicted && state.text)
    .map((state) => state.text);
  const diagnostic = cleanOutput(chunks.join('\n\n'));
  if (!diagnostic || diagnostic.length <= maxChars) {
    return { text: diagnostic, truncated: false, originalChars: diagnostic.length };
  }
  return {
    text: diagnostic.slice(-maxChars),
    truncated: true,
    originalChars: diagnostic.length,
  };
}

function normalizeClaudeRetryEvents(events) {
  const retained = [];
  const seenIds = new Set();
  let totalEvents = 0;
  let invalidEvents = 0;
  let duplicateEvents = 0;
  let validCount = 0;
  let delayTotalMs = 0;
  let delayOverflow = false;
  let maxAttempt = 0;
  let declaredMaxRetries = 0;
  const byError = {};
  const byStatus = {};
  for (const event of events) {
    if (!event || event.type !== 'system' || event.subtype !== 'api_retry') continue;
    totalEvents += 1;
    const eventId = typeof event.uuid === 'string' ? event.uuid.trim().slice(0, 200) : '';
    if (!eventId) {
      invalidEvents += 1;
      continue;
    }
    if (seenIds.has(eventId)) {
      duplicateEvents += 1;
      continue;
    }
    seenIds.add(eventId);
    const attempt = nonnegativeUsageNumber(event.attempt);
    const maxRetries = nonnegativeUsageNumber(event.max_retries);
    const retryDelayMs = nonnegativeUsageNumber(event.retry_delay_ms);
    if (attempt === null || attempt < 1 || maxRetries === null || retryDelayMs === null) {
      invalidEvents += 1;
      continue;
    }
    const statusAbsent = event.error_status === null || event.error_status === undefined;
    const status = statusAbsent ? null : nonnegativeUsageNumber(event.error_status);
    if (!statusAbsent && (status === null || status < 100 || status > 599)) {
      invalidEvents += 1;
      continue;
    }
    const errorStatus = status;
    const rawCategory = typeof event.error === 'string' ? event.error.trim().toLowerCase() : '';
    const errorCategory = CLAUDE_RETRY_ERROR_CATEGORIES.has(rawCategory) ? rawCategory : 'unknown';
    const normalized = {
      event_id_hash: crypto.createHash('sha256').update(eventId).digest('hex'),
      attempt,
      max_retries: maxRetries,
      retry_delay_ms: retryDelayMs,
      error_status: errorStatus,
      error: errorCategory,
    };
    validCount += 1;
    const nextDelay = delayTotalMs + retryDelayMs;
    if (!Number.isSafeInteger(nextDelay)) delayOverflow = true;
    else if (!delayOverflow) delayTotalMs = nextDelay;
    maxAttempt = Math.max(maxAttempt, attempt);
    declaredMaxRetries = Math.max(declaredMaxRetries, maxRetries);
    byError[errorCategory] = (byError[errorCategory] || 0) + 1;
    const statusKey = errorStatus === null ? 'none' : String(errorStatus);
    byStatus[statusKey] = (byStatus[statusKey] || 0) + 1;
    if (retained.length < 256) retained.push(normalized);
  }
  return {
    count: validCount,
    total_delay_ms: delayOverflow ? null : delayTotalMs,
    max_attempt: maxAttempt,
    declared_max_retries: declaredMaxRetries,
    by_error: Object.fromEntries(Object.entries(byError).sort(([a], [b]) => a.localeCompare(b))),
    by_status: Object.fromEntries(Object.entries(byStatus).sort(([a], [b]) => a.localeCompare(b))),
    events: retained,
    truncated: validCount > retained.length,
    observed_events: totalEvents,
    invalid_events: invalidEvents,
    duplicate_events: duplicateEvents,
  };
}

function claudeResultFailureClass(subtype) {
  if (subtype === 'error_max_budget_usd') return 'budget';
  if (subtype === 'error_max_turns') return 'max_turns';
  if (subtype === 'error_max_structured_output_retries') return 'structured_output_retry_exhausted';
  if (subtype === 'error_during_execution') return 'provider_error';
  return /^error_/.test(subtype) ? 'provider_error' : null;
}

function claudeTerminalReasonFailureClass(reason) {
  if (!reason || reason === 'completed') return null;
  if (reason === 'rapid_refill_breaker') return 'rate_limit';
  if (reason === 'budget_exhausted') return 'budget';
  if (reason === 'image_error' || reason === 'model_error') return 'provider_error';
  return reason;
}

function claudeApiStatusFailureClass(status, diagnostic = '') {
  return status === null ? null : classifyProviderHttpFailure(status, diagnostic);
}

function normalizeClaudeResultString(value, maxChars = 128) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxChars) : null;
}

function normalizeClaudeResultErrors(value) {
  if (!Array.isArray(value)) {
    return { retained: [], count: 0, observed: 0, invalid: 0, truncated: false };
  }
  const retained = [];
  let retainedChars = 0;
  let count = 0;
  let invalid = 0;
  let clipped = false;
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      invalid += 1;
      continue;
    }
    const raw = item.trim();
    if (raw.length > 1000) clipped = true;
    const normalized = raw.slice(0, 1000);
    count += 1;
    const remaining = 4000 - retainedChars;
    if (remaining <= 0 || retained.length >= 20) continue;
    const retainedError = normalized.slice(0, remaining);
    if (retainedError.length < normalized.length) clipped = true;
    retained.push(retainedError);
    retainedChars += retainedError.length;
  }
  return {
    retained,
    count,
    observed: value.length,
    invalid,
    truncated: clipped || count > retained.length,
  };
}

function normalizeClaudePermissionDenials(value) {
  if (!Array.isArray(value)) {
    return { retained: [], count: 0, observed: 0, invalid: 0, truncated: false, byTool: {} };
  }
  const retained = [];
  const byTool = Object.create(null);
  let count = 0;
  let invalid = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      invalid += 1;
      continue;
    }
    const toolName = normalizeClaudeResultString(item.tool_name, 160);
    const toolUseId = normalizeClaudeResultString(item.tool_use_id, 200);
    if (!toolName || !toolUseId) {
      invalid += 1;
      continue;
    }
    count += 1;
    byTool[toolName] = (byTool[toolName] || 0) + 1;
    if (retained.length < 256) {
      retained.push({
        tool_name: toolName,
        tool_use_id_hash: crypto.createHash('sha256').update(toolUseId).digest('hex'),
      });
    }
  }
  return {
    retained,
    count,
    observed: value.length,
    invalid,
    truncated: count > retained.length,
    byTool: Object.fromEntries(Object.entries(byTool).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function claudeStopReasonFailureClass(stopReason) {
  if (stopReason === 'max_tokens') return 'max_tokens';
  if (stopReason === 'refusal') return 'refusal';
  if (stopReason === 'tool_deferred') return 'tool_deferred';
  return null;
}

const PROVIDER_INTERNAL_TIMEOUT_PATTERNS = [
  /\btimeout waiting for (?:a )?response\b/i,
  /\btimed out waiting for (?:a )?response\b/i,
  /\brequest timed out\b/i,
  /\bdeadline exceeded\b/i,
  /\betimedout\b/i,
];

function hasProviderInternalTimeoutDiagnostic(value) {
  const diagnostic = String(value || '');
  return PROVIDER_INTERNAL_TIMEOUT_PATTERNS.some((pattern) => pattern.test(diagnostic));
}

function parseConfiguredOneShotOutput(entry, rawOutput) {
  const parser = String(entry?.oneshot_output_parser || 'text');
  if (parser === 'text') {
    return {
      output: cleanOutput(rawOutput), usage: null, isError: false,
      resultSubtype: null, failureClass: null, retries: normalizeClaudeRetryEvents([]),
      diagnostic: '', errorCount: 0, providerStopReason: null,
      errorObserved: 0, errorInvalid: 0, errorDiagnosticTruncated: false,
      terminalReason: null, apiErrorStatus: null,
      permissionDenials: normalizeClaudePermissionDenials([]),
      numTurns: null, providerDurationMs: null, providerApiDurationMs: null,
      resultSchemaDisagreement: false,
      parseError: null,
    };
  }
  if (parser !== 'claude_json') {
    return {
      output: '', usage: null, isError: true,
      resultSubtype: null, failureClass: 'provider_error', retries: normalizeClaudeRetryEvents([]),
      diagnostic: '', errorCount: 0, providerStopReason: null,
      errorObserved: 0, errorInvalid: 0, errorDiagnosticTruncated: false,
      terminalReason: null, apiErrorStatus: null,
      permissionDenials: normalizeClaudePermissionDenials([]),
      numTurns: null, providerDurationMs: null, providerApiDurationMs: null,
      resultSchemaDisagreement: false,
      partialDiagnostic: '', partialDiagnosticTruncated: false,
      parseError: `unsupported oneshot output parser: ${parser}`,
    };
  }
  let events = [];
  try {
    const text = String(rawOutput || '').trim();
    let document;
    try {
      document = JSON.parse(text);
      events = document && typeof document === 'object' && !Array.isArray(document) ? [document] : [];
    } catch {
      events = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter((value) => value && typeof value === 'object' && !Array.isArray(value));
      document = [...events].reverse().find((value) => value.type === 'result') || null;
    }
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('result is not an object');
    if (document.type !== 'result') throw new Error('document type is not result');
    const subtype = (normalizeClaudeResultString(document.subtype) || '').toLowerCase();
    if (subtype !== 'success' && !/^error_/.test(subtype)) throw new Error('result subtype is unsupported');
    if (typeof document.is_error !== 'boolean') throw new Error('result is_error is not boolean');
    const subtypeIndicatesError = /^error_/.test(subtype);
    const resultSchemaDisagreement = document.is_error !== subtypeIndicatesError;
    const providerStopReason = (normalizeClaudeResultString(document.stop_reason) || '').toLowerCase() || null;
    const terminalReasonRaw = (normalizeClaudeResultString(document.terminal_reason) || '').toLowerCase() || null;
    if (terminalReasonRaw && !CLAUDE_TERMINAL_REASONS.has(terminalReasonRaw)) {
      throw new Error('result terminal_reason is unsupported');
    }
    const apiStatusAbsent = document.api_error_status === null || document.api_error_status === undefined;
    const apiErrorStatus = apiStatusAbsent ? null : nonnegativeUsageNumber(document.api_error_status);
    if (!apiStatusAbsent && (apiErrorStatus === null || apiErrorStatus < 100 || apiErrorStatus > 599)) {
      throw new Error('result api_error_status is invalid');
    }
    // Claude CLI versions have emitted terminal result documents where
    // `subtype` and `is_error` disagree. Treat either error signal as
    // authoritative and never expose result content unless both fields form
    // the canonical success pair. The disagreement remains observable rather
    // than turning the entire document into a parse failure that discards
    // provider-reported usage, errors, and retry events.
    const isError = subtypeIndicatesError || document.is_error === true;
    const errors = normalizeClaudeResultErrors(document.errors);
    const permissionDenials = normalizeClaudePermissionDenials(document.permission_denials);
    return {
      output: cleanOutput(!isError && typeof document.result === 'string' ? document.result : ''),
      usage: normalizeClaudeJsonUsage(document),
      isError,
      resultSubtype: subtype || null,
      failureClass: subtype === 'error_max_budget_usd' ? 'budget'
        : claudeApiStatusFailureClass(apiErrorStatus, errors.retained.join('\n'))
        || claudeStopReasonFailureClass(providerStopReason)
        || claudeTerminalReasonFailureClass(terminalReasonRaw)
        || claudeResultFailureClass(subtype)
        || (isError ? 'provider_error' : null),
      retries: normalizeClaudeRetryEvents(events),
      diagnostic: cleanOutput(errors.retained.join('\n')),
      errorCount: errors.count,
      errorObserved: errors.observed,
      errorInvalid: errors.invalid,
      errorDiagnosticTruncated: errors.truncated,
      providerStopReason,
      terminalReason: terminalReasonRaw,
      apiErrorStatus,
      permissionDenials,
      numTurns: nonnegativeUsageNumber(document.num_turns),
      providerDurationMs: nonnegativeUsageNumber(document.duration_ms),
      providerApiDurationMs: nonnegativeUsageNumber(document.duration_api_ms),
      resultSchemaDisagreement,
      partialDiagnostic: '', partialDiagnosticTruncated: false,
      parseError: null,
    };
  } catch (error) {
    const partial = extractClaudeAssistantDiagnostic(events);
    return {
      output: '', usage: null, isError: true,
      resultSubtype: null, failureClass: 'provider_error',
      diagnostic: '', errorCount: 0, providerStopReason: null,
      errorObserved: 0, errorInvalid: 0, errorDiagnosticTruncated: false,
      terminalReason: null, apiErrorStatus: null,
      permissionDenials: normalizeClaudePermissionDenials([]),
      numTurns: null, providerDurationMs: null, providerApiDurationMs: null,
      resultSchemaDisagreement: false,
      retries: normalizeClaudeRetryEvents(events),
      partialDiagnostic: partial.text,
      partialDiagnosticTruncated: partial.truncated,
      parseError: `claude_json parse failed: ${error.message}`,
    };
  }
}

function ollamaManifestIdentity(entry) {
  if (entry?.transport !== 'local:ollama' || !entry.model) return null;
  const match = /^([A-Za-z0-9._-]+)(?::([A-Za-z0-9._-]+))?$/.exec(String(entry.model));
  if (!match) return null;
  // The manifest store is not always under the bridge's own HOME. On WSL the
  // ollama daemon reachable on loopback is typically the Windows one, whose
  // weights live in the Windows profile — USER_HOME/.ollama does not exist, so
  // every local-seat receipt silently degraded to a bare tag with no @sha256,
  // losing the one fact that proves which weights answered. OLLAMA_MODELS is
  // ollama's own documented override for the store location, which lets the
  // operator state it instead of the bridge guessing at /mnt paths.
  const roots = [
    String(process.env.OLLAMA_MODELS || '').trim(),
    USER_HOME ? path.join(USER_HOME, '.ollama', 'models') : '',
  ].filter(Boolean);
  for (const root of roots) {
    const manifestPath = path.join(
      root, 'manifests', 'registry.ollama.ai', 'library',
      match[1], match[2] || 'latest',
    );
    try {
      const bytes = fs.readFileSync(manifestPath);
      return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    } catch { /* try the next configured store */ }
  }
  return null;
}

function localOllamaUrl() {
  const raw = String(envFirst('RELAYBRIDGE_OLLAMA_URL', 'PS_BRIDGE_OLLAMA_URL') || 'http://127.0.0.1:11434').trim();
  const url = new URL('/api/generate', raw.endsWith('/') ? raw : raw + '/');
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error('RELAYBRIDGE_OLLAMA_URL must be a loopback HTTP endpoint');
  }
  return url;
}

const BLOCKED_HOSTED_AI_HOSTS = new Set([
  'api.deepseek.com',
  'api-docs.deepseek.com',
  'dashscope.aliyuncs.com',
]);

function isBlockedHostedAiHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (BLOCKED_HOSTED_AI_HOSTS.has(host)) return true;
  return host.endsWith('.aliyuncs.com');
}

function hostedChatUrl(entry) {
  const raw = String(entry.api_base_url || '').trim();
  if (!raw) throw new Error('hosted provider missing api_base_url');
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('hosted provider api_base_url must use HTTPS');
  if (isBlockedHostedAiHost(url.hostname)) {
    throw new Error(`hosted provider is blocked by geo/supply-chain policy: ${url.hostname}`);
  }
  return url;
}

function hostedApiKey(entry) {
  const names = [
    entry.api_key_env,
    ...(Array.isArray(entry.api_key_env_aliases) ? entry.api_key_env_aliases : []),
  ].filter(Boolean);
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) return { name, value: String(value) };
  }
  const error = new Error(`hosted provider key is not set; define ${names[0] || 'the configured API key environment variable'}`);
  error.code = HOSTED_API_KEY_MISSING_CODE;
  throw error;
}

function rejectedHttpModelInvocation(status) {
  return new Set([400, 401, 403, 404, 409, 422, 429]).has(Number(status))
    ? false : null;
}

function isUpstreamTimeoutStatus(status) {
  return Number(status) === 408 || Number(status) === 504;
}

function terminalProviderBudgetOutcome(usage, providerBudget, turns = null) {
  const supervisor = new RunSupervisor({ providerBudget });
  supervisor.recordProviderUsage({ ...(usage || {}), turns }, { phase: 'terminal' });
  const verdict = supervisor.evaluate();
  return verdict.action === 'kill' && verdict.reason === 'token_budget'
    ? { exceeded: true, detail: verdict.detail, budget: supervisor.snapshot().providerBudget }
    : { exceeded: false, detail: '', budget: supervisor.snapshot().providerBudget };
}

async function runOpenAIChatOneShot({ entry, prompt, timeoutMs, res, route, startedAt, providerBudget, accountId }) {
  const bounded = capPrompt(prompt, Number(entry.prompt_max_chars || 12000));
  route.prompt_transport = 'hosted_openai_compatible';
  route.prompt_truncated = bounded.truncated;
  route.allow_paid_fallback = entry.allow_paid_fallback === true;
  route.hosting_region = entry.hosting_region || null;
  route.requires_explicit_preference = entry.autoRoute === false || null;

  const controller = new AbortController();
  let timedOut = false;
  let clientGone = false;
  let requestStarted = false;
  res._relayCancellationPayload = () => ({
    kind: route.provider,
    route,
    exitCode: -1,
    stdout: '',
    stderr: '',
    failureClass: timedOut ? 'timeout' : disconnectFailureClass({
      client: route.client_surface, deadlineAt: route.client_deadline_at,
    }),
    stop_reason: timedOut ? 'hard_cap' : disconnectFailureClass({
      client: route.client_surface, deadlineAt: route.client_deadline_at,
    }),
    cancelled: !timedOut,
    timed_out: timedOut,
    dropped_out: true,
    model_invocation: requestStarted ? null : false,
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('hosted provider request timed out'));
  }, TIMEOUT_POLICY.normalizeOneShotTimeoutMs(timeoutMs));
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      controller.abort(new Error('bridge client disconnected'));
    }
  });

  try {
    const url = hostedChatUrl(entry);
    const key = hostedApiKey(entry);
    route.endpoint_host = url.hostname;
    route.api_key_env = key.name;
    requestStarted = true;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key.value}`,
        ...(entry.http_referer ? { 'HTTP-Referer': String(entry.http_referer) } : {}),
        ...(entry.x_title ? { 'X-Title': String(entry.x_title) } : {}),
      },
      body: JSON.stringify({
        model: entry.model,
        messages: [
          ...(entry.system_prompt ? [{ role: 'system', content: String(entry.system_prompt) }] : []),
          { role: 'user', content: bounded.text },
        ],
        temperature: Number.isFinite(Number(entry.temperature)) ? Number(entry.temperature) : 0.2,
        max_tokens: Math.max(64, Math.min(Number(entry.max_output_tokens || 1024), 4096)),
        stream: false,
      }),
      signal: controller.signal,
    });
    const responseText = await response.text();
    let payload = {};
    try { payload = responseText ? JSON.parse(responseText) : {}; } catch {}
    if (!response.ok) {
      const detail = cleanOutput(payload.error?.message || payload.error || responseText || `hosted provider HTTP ${response.status}`);
      const httpFailure = classifyProviderHttpFailure(response.status, detail);
      if (!clientGone && !res.writableEnded) {
        sendOneShotResult(res, {
          kind: route.provider,
          route,
          exitCode: response.status,
          stdout: '',
          stderr: detail,
          failureClass: httpFailure,
          rate_limited: httpFailure === 'rate_limit',
          budget_exceeded: httpFailure === 'budget',
          auth_failed: httpFailure === 'auth',
          permission_denied: httpFailure === 'permission',
          timed_out: isUpstreamTimeoutStatus(response.status),
          dropped_out: true,
          model_invocation: rejectedHttpModelInvocation(response.status),
        }, { kind: route.provider, prompt, route, startedAt, accountId });
      }
      return;
    }
    const stdout = cleanOutput(payload.choices?.[0]?.message?.content || payload.output_text || '');
    const providerModel = typeof payload.model === 'string' ? payload.model.trim().slice(0, 160) : '';
    const configuredModel = typeof entry.model === 'string' ? entry.model.trim().slice(0, 160) : '';
    const existingIdentity = typeof route.resolved_model_identity === 'string'
      ? route.resolved_model_identity.trim().slice(0, 160) : '';
    route.resolved_model = providerModel || configuredModel || null;
    route.resolved_model_identity = providerModel || existingIdentity || configuredModel || null;
    route.resolved_model_source = providerModel ? 'provider_response'
      : existingIdentity ? route.resolved_model_source : configuredModel ? 'configured_model' : null;
    const usage = payload.usage ? (() => {
      const inputTokens = nonnegativeUsageNumber(payload.usage.prompt_tokens);
      const outputTokens = nonnegativeUsageNumber(payload.usage.completion_tokens);
      const computedTotal = inputTokens !== null && outputTokens !== null
        ? safeTokenSum([inputTokens, outputTokens]) : null;
      return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: computedTotal ?? nonnegativeUsageNumber(payload.usage.total_tokens),
      };
    })() : null;
    const budgetOutcome = terminalProviderBudgetOutcome(usage, providerBudget);
    if (!clientGone && !res.writableEnded) {
      sendOneShotResult(res, {
        kind: route.provider,
        route,
        exitCode: 0,
        stdout,
        stderr: '',
        usage,
        failureClass: budgetOutcome.exceeded ? 'token_budget' : null,
        stop_reason: budgetOutcome.exceeded ? 'token_budget' : null,
        supervisor_stop_reason: budgetOutcome.exceeded ? 'token_budget' : null,
        stop_detail: budgetOutcome.detail,
        provider_budget: budgetOutcome.budget,
        provider_budget_enforcement: usage ? 'terminal' : 'unavailable',
        rate_limited: false,
        budget_exceeded: false,
        auth_failed: false,
        permission_denied: false,
        timed_out: false,
        dropped_out: budgetOutcome.exceeded || !stdout,
        model_invocation: true,
      }, { kind: route.provider, prompt, route, startedAt, accountId });
    }
  } catch (error) {
    if (!clientGone && !res.writableEnded) {
      sendOneShotResult(res, {
        kind: route.provider,
        route,
        exitCode: -1,
        stdout: '',
        stderr: cleanOutput(error?.message || String(error)),
        auth_failed: isHostedApiKeyMissingError(error),
        timed_out: timedOut,
        dropped_out: true,
        model_invocation: requestStarted ? null : false,
      }, { kind: route.provider, prompt, route, startedAt, accountId });
    }
  } finally {
    clearTimeout(timer);
  }
}

async function runOllamaApiOneShot({ entry, prompt, timeoutMs, res, route, startedAt, providerBudget, accountId }) {
  const bounded = capPrompt(prompt, Number(entry.prompt_max_chars || 24000));
  route.prompt_transport = 'local_http';
  route.prompt_truncated = bounded.truncated;
  const controller = new AbortController();
  let timedOut = false;
  let clientGone = false;
  let requestStarted = false;
  res._relayCancellationPayload = () => ({
    kind: route.provider,
    route,
    exitCode: -1,
    stdout: '',
    stderr: '',
    failureClass: timedOut ? 'timeout' : disconnectFailureClass({
      client: route.client_surface, deadlineAt: route.client_deadline_at,
    }),
    stop_reason: timedOut ? 'hard_cap' : disconnectFailureClass({
      client: route.client_surface, deadlineAt: route.client_deadline_at,
    }),
    cancelled: !timedOut,
    timed_out: timedOut,
    dropped_out: true,
    model_invocation: requestStarted ? null : false,
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('local Ollama request timed out'));
  }, TIMEOUT_POLICY.normalizeOneShotTimeoutMs(timeoutMs));
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      controller.abort(new Error('bridge client disconnected'));
    }
  });

  try {
    const url = localOllamaUrl();
    requestStarted = true;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: entry.model,
        prompt: bounded.text,
        stream: false,
        think: false,
        options: {
          num_predict: Math.max(64, Math.min(Number(entry.max_output_tokens || 1024), 4096)),
        },
      }),
      signal: controller.signal,
    });
    const responseText = await response.text();
    let payload = {};
    try { payload = responseText ? JSON.parse(responseText) : {}; } catch {}
    if (!response.ok) {
      const detail = cleanOutput(payload.error || responseText || `Ollama HTTP ${response.status}`);
      if (!clientGone && !res.writableEnded) {
        sendOneShotResult(res, {
          kind: route.provider,
          route,
          exitCode: response.status,
          stdout: '',
          stderr: detail,
          timed_out: isUpstreamTimeoutStatus(response.status),
          dropped_out: true,
          model_invocation: rejectedHttpModelInvocation(response.status),
        }, { kind: route.provider, prompt, route, startedAt, accountId });
      }
      return;
    }

    let rawOutput = payload.response || payload.message?.content || '';
    if (entry.strip_thinking) {
      const closeTag = String(rawOutput).lastIndexOf('</think>');
      if (closeTag >= 0) rawOutput = String(rawOutput).slice(closeTag + '</think>'.length);
    }
    const stdout = cleanOutput(rawOutput);
    const providerModel = typeof payload.model === 'string' ? payload.model.trim().slice(0, 160) : '';
    const configuredModel = typeof entry.model === 'string' ? entry.model.trim().slice(0, 160) : '';
    route.resolved_model = providerModel || configuredModel || null;
    const inputTokens = nonnegativeUsageNumber(payload.prompt_eval_count);
    const outputTokens = nonnegativeUsageNumber(payload.eval_count);
    const usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens !== null && outputTokens !== null
        ? safeTokenSum([inputTokens, outputTokens]) : null,
      total_duration_ns: Number.isFinite(Number(payload.total_duration)) ? Number(payload.total_duration) : null,
      load_duration_ns: Number.isFinite(Number(payload.load_duration)) ? Number(payload.load_duration) : null,
      done_reason: payload.done_reason || null,
    };
    const budgetOutcome = terminalProviderBudgetOutcome(usage, providerBudget);
    if (!clientGone && !res.writableEnded) {
      sendOneShotResult(res, {
        kind: route.provider,
        route,
        exitCode: 0,
        stdout,
        stderr: '',
        usage,
        failureClass: budgetOutcome.exceeded ? 'token_budget' : null,
        stop_reason: budgetOutcome.exceeded ? 'token_budget' : null,
        supervisor_stop_reason: budgetOutcome.exceeded ? 'token_budget' : null,
        stop_detail: budgetOutcome.detail,
        provider_budget: budgetOutcome.budget,
        provider_budget_enforcement: inputTokens !== null || outputTokens !== null ? 'terminal' : 'unavailable',
        rate_limited: false,
        budget_exceeded: false,
        auth_failed: false,
        permission_denied: false,
        timed_out: false,
        dropped_out: budgetOutcome.exceeded || !stdout,
        model_invocation: true,
      }, { kind: route.provider, prompt, route, startedAt, accountId });
    }
  } catch (error) {
    if (!clientGone && !res.writableEnded) {
      sendOneShotResult(res, {
        kind: route.provider,
        route,
        exitCode: -1,
        stdout: '',
        stderr: cleanOutput(error?.message || String(error)),
        timed_out: timedOut,
        dropped_out: true,
        model_invocation: requestStarted ? null : false,
      }, { kind: route.provider, prompt, route, startedAt, accountId });
    }
  } finally {
    clearTimeout(timer);
  }
}

const activeChildren = new Set();
const activeOneShots = new Map();
const MAX_ACTIVE_ONESHOTS = Math.max(1, Math.min(Number(envFirst('RELAYBRIDGE_MAX_ACTIVE_ONESHOTS', 'PS_BRIDGE_MAX_ACTIVE_ONESHOTS') || 4), 16));
const MAX_ACTIVE_PER_PROVIDER = Math.max(1, Math.min(Number(envFirst('RELAYBRIDGE_MAX_ACTIVE_PER_PROVIDER', 'PS_BRIDGE_MAX_ACTIVE_PER_PROVIDER') || 1), 4));
let activeOneShotCount = 0;

function acquireOneShot(kind, res) {
  const providerCount = activeOneShots.get(kind) || 0;
  if (activeOneShotCount >= MAX_ACTIVE_ONESHOTS || providerCount >= MAX_ACTIVE_PER_PROVIDER) return null;
  activeOneShotCount++;
  activeOneShots.set(kind, providerCount + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeOneShotCount = Math.max(0, activeOneShotCount - 1);
    const next = Math.max(0, (activeOneShots.get(kind) || 1) - 1);
    if (next) activeOneShots.set(kind, next); else activeOneShots.delete(kind);
  };
  res.once('finish', release);
  res.once('close', release);
  return release;
}
function trackChild(proc) {
  if (!proc) return proc;
  activeChildren.add(proc);
  const forget = () => activeChildren.delete(proc);
  proc.once('close', forget);
  proc.once('error', forget);
  return proc;
}

// child_process.kill() only terminates the cmd.exe wrapper on Windows; npm
// shims can leave the actual AI CLI running and consuming quota.  Kill the
// verified wrapper tree on timeout or client disconnect.
function killProcessTree(proc) {
  // Delegated to lib/platform.js. The old POSIX branch was proc.kill('SIGTERM')
  // — the CLI died but the subprocesses it spawned (node shims, MCP servers)
  // survived, holding ports and file locks. killTree signals the whole tree,
  // group-kill first, ps-walk fallback, SIGKILL escalation after 3s.
  try { platform.killTree(proc); }
  catch { try { proc?.kill(); } catch { /* already gone */ } }
}

// ---- session management ----
const sessions = new Map(); // id -> Session
// How long an exited session stays listed and readable before it is reaped.
// Long enough for a dashboard that reconnects after a reload to see how the
// process ended; short enough that a long-lived bridge does not accumulate
// dead sessions and their output buffers.
const EXITED_SESSION_TTL_MS = 600000;
// Per-client WebSocket send queue ceiling, in bytes, before session output is
// dropped for that client instead of queued on the bridge's heap.
const WS_CLIENT_BUFFER_MAX = 4194304;

// Live provider runs, keyed by runId, so a human (or the dashboard) can vet
// whether a quiet run is working or wedged instead of guessing.
const activeRuns = new Map();


// What each provider can actually run, discovered at boot. Configured pins rot,
// and a retired pin fails every call to that provider, so the bridge asks each
// CLI for its own list and reports pins that no longer appear in it.
let modelRegistry = null;
let discoveryInFlight = null;
const MODEL_REGISTRY_FILE = path.join(DATA_DIR, 'model-registry.json');

const sampleTreeCpuMs = platform.sampleTreeCpuMs;

async function discoverModels() {
  if (discoveryInFlight) return discoveryInFlight;
  const cfg = loadConfig();
  const globals = cfg._models || {};
  const timeoutMs = Number(globals.discoveryTimeoutMs) > 0 ? Number(globals.discoveryTimeoutMs) : 20000;
  discoveryInFlight = (async () => {
    const probeResults = {};
    for (const kind of Object.keys(cfg).filter((k) => !k.startsWith('_') && k !== 'powershell')) {
      const entry = cfg[kind];
      if (!entry || typeof entry !== "object") continue;
      if (Array.isArray(entry.models_static) && entry.models_static.length) {
        probeResults[kind] = { models: entry.models_static.slice() };
        continue;
      }
      if (!Array.isArray(entry.models_probe) || !entry.models_probe.length) continue;
      try {
        const result = await Promise.race([runProbe(entry.models_probe, timeoutMs, entry.strip_env || []), new Promise((r) => setTimeout(() => r({ exitCode: -1, stdout: "", stderr: "probe timeout" }), timeoutMs + 5000))]);
        if (result.exitCode === 0) {
          const models = parseModelList(result.stdout, entry);
          probeResults[kind] = models.length ? { models } : { error: 'probe returned no recognizable model ids' };
        } else {
          probeResults[kind] = { error: (result.stderr || 'probe failed').split('\n')[0].slice(0, 200) };
        }
      } catch (err) {
        probeResults[kind] = { error: err.message };
      }
    }
    const registry = buildRegistry({ probeResults, config: cfg });
    modelRegistry = registry;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(MODEL_REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf8');
    } catch { /* cache write is best effort */ }
    for (const warning of registry.warnings) console.warn('[RelayBridge] ' + warning);
    if (registry.totalModels) {
      console.log(`[RelayBridge] model discovery: ${registry.totalModels} models across ${registry.probedCount} provider(s)`);
    }
    return registry;
  })().finally(() => { discoveryInFlight = null; });
  return discoveryInFlight;
}

function loadCachedRegistry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MODEL_REGISTRY_FILE, 'utf8'));
    if (parsed && parsed.providers) modelRegistry = parsed;
  } catch { /* no cache yet */ }
}
let nextId = 1;

class Session {
  constructor(id, kind, label, command, args, cwd) {
    this.id = id;
    this.kind = kind;
    this.label = label;
    this.command = command;
    this.args = args;
    this.cwd = cwd || USER_HOME || ROOT;
    this.buffer = []; // ring buffer of recent output
    this.bufferMax = 2000; // lines
    this.clients = new Set(); // WebSocket clients
    this._starved = new Set(); // clients currently being skipped for backpressure
    this.proc = null;
    this.exited = false;
    this.exitCode = null;
    this.startedAt = Date.now();
    this._spawn();
  }

  _spawn() {
    const env = buildEnv({ TERM: 'xterm-256color' });
    const resolvedCommand = resolveExecutable(this.command, env);
    if (pty) {
      try {
        // On Windows, ConPTY (used by node-pty) can't resolve .cmd / .bat / .ps1
        // shims directly â€” pty.spawn('claude', ...) fails because the shim isn't
        // a real .exe. Wrap any non-.exe command with `cmd.exe /c` so the shim
        // resolves through cmd.exe's path search. PowerShell.exe etc. skip this.
        let spawnCmd = resolvedCommand;
        let spawnArgs = this.args;
        if (process.platform === 'win32' && !/\.exe$/i.test(resolvedCommand)) {
          spawnCmd = process.env.ComSpec || 'cmd.exe';
          spawnArgs = ['/d', '/s', '/c', [resolvedCommand, ...this.args].map(quoteCmdArg).join(' ')];
        }
        this.proc = pty.spawn(spawnCmd, spawnArgs, {
          name: 'xterm-256color',
          cols: 120,
          rows: 30,
          cwd: this.cwd,
          env,
        });
        this._mode = 'pty';
        this.proc.onData((data) => this._onData(data));
        this.proc.onExit(({ exitCode }) => this._onExit(exitCode));
        return;
      } catch (err) {
        console.warn(`[session ${this.id}] PTY spawn failed: ${err.message}, falling back to pipe`);
      }
    }
    // pipe fallback
    // On Windows, npm-installed CLIs are usually .cmd shims (claude.cmd,
    // codex.cmd, gemini.cmd). spawn('claude', ...) with shell:false won't
    // resolve those â€” you get ENOENT. Setting shell:true lets cmd.exe
    // look up the command and find the shim. (Localhost-only server with
    // user-controlled cli-config.json, so no injection surface.)
    const isWindowsShim = process.platform === 'win32' && !/\.exe$/i.test(resolvedCommand);
    const pipeCommand = isWindowsShim ? (process.env.ComSpec || 'cmd.exe') : resolvedCommand;
    const pipeArgs = isWindowsShim
      ? ['/d', '/s', '/c', [resolvedCommand, ...this.args].map(quoteCmdArg).join(' ')]
      : this.args;
    this.proc = spawn(pipeCommand, pipeArgs, {
      cwd: this.cwd,
      env,
      windowsHide: true,
      // Same reason as the one-shot spawn: killProcessTree can only take out
      // the whole tree with a single signal when the child leads its own
      // group. Pipe mode has no controlling terminal to lose.
      detached: process.platform !== 'win32',
    });
    this._mode = 'pipe';
    this.proc.stdout.on('data', (d) => this._onData(d.toString('utf8')));
    this.proc.stderr.on('data', (d) => this._onData(d.toString('utf8')));
    this.proc.on('close', (code) => this._onExit(code));
    this.proc.on('error', (err) => {
      this._onData(`\r\n[RelayBridge] spawn error: ${err.message}\r\n`);
      this._onExit(-1);
    });
    // The child has an 'error' handler; its stdin stream does not. Writing to a
    // CLI that has already exited raises EPIPE as an 'error' event ON THE
    // STREAM, and an unhandled one exits the whole bridge. Keystrokes into a
    // dead pipe-mode tab are the normal way to hit this.
    this.proc.stdin.on('error', (err) => {
      this._onData(`\r\n[RelayBridge] input not delivered: ${err.code || err.message}\r\n`);
    });
  }

  // ws queues every unsent frame on the bridge's heap with no ceiling, so a
  // child flooding stdout while one client is slow — a backgrounded Chrome tab
  // throttles its socket reads, which is the common case — made the bridge's
  // memory track the slowest browser tab. Past the threshold, drop frames for
  // that client and say so once, rather than buffering on its behalf: the
  // scrollback it missed is still available from GET /api/sessions/:id/buffer.
  _sendTo(ws, frame) {
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > WS_CLIENT_BUFFER_MAX) {
      if (!this._starved.has(ws)) {
        this._starved.add(ws);
        try { ws.send(JSON.stringify({ type: 'data', data: '\r\n[RelayBridge] output skipped — this client is not reading fast enough; reload the tab to resync\r\n' })); } catch {}
      }
      return;
    }
    this._starved.delete(ws);
    try { ws.send(frame); } catch {}
  }

  _onData(text) {
    this.buffer.push(text);
    if (this.buffer.length > this.bufferMax) {
      this.buffer.splice(0, this.buffer.length - this.bufferMax);
    }
    const frame = JSON.stringify({ type: 'data', data: text });
    for (const ws of this.clients) this._sendTo(ws, frame);
  }

  _onExit(code) {
    if (this.exited) return;   // pipe mode can deliver both 'error' and 'close'
    this.exited = true;
    this.exitCode = code;
    const msg = `\r\n[RelayBridge] process exited with code ${code}\r\n`;
    this.buffer.push(msg);
    // The banner pushed past bufferMax without the trim _onData does.
    if (this.buffer.length > this.bufferMax) {
      this.buffer.splice(0, this.buffer.length - this.bufferMax);
    }
    for (const ws of this.clients) {
      this._sendTo(ws, JSON.stringify({ type: 'data', data: msg }));
      // The exit frame is terminal state, not output: send it even to a client
      // whose queue is over the cap, or a backed-up tab would never learn the
      // process ended and would sit on a live-looking terminal forever.
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'exit', code })); } catch {}
      }
    }
    // Nothing removed an exited session from the `sessions` map: only DELETE
    // /api/sessions/:id does, and only public/index.html issues it, so every
    // CLI that finished on its own — plus every tab closed with the browser
    // rather than the X — left a Session holding its buffer for the life of
    // the bridge, and GET /api/sessions kept listing the corpses. Keep it
    // addressable long enough for a reconnecting dashboard to read the exit,
    // then drop it. unref'd so it never holds the process open.
    const reaper = setTimeout(() => {
      if (sessions.get(this.id) === this) sessions.delete(this.id);
    }, EXITED_SESSION_TTL_MS);
    if (typeof reaper.unref === 'function') reaper.unref();
  }

  write(input) {
    if (this.exited) return false;
    try {
      if (this._mode === 'pty') {
        this.proc.write(input);
      } else {
        if (!this.proc.stdin || this.proc.stdin.destroyed) return false;
        this.proc.stdin.write(input);
      }
    } catch {
      return false; // stream torn down between the exited check and the write
    }
    return true;
  }

  resize(cols, rows) {
    if (this._mode === 'pty' && !this.exited) {
      try { this.proc.resize(cols, rows); } catch {}
    }
  }

  kill() {
    if (this.exited) return;
    killProcessTree(this.proc);
  }

  attach(ws) {
    this.clients.add(ws);
    const replay = this.buffer.join('');
    if (replay) ws.send(JSON.stringify({ type: 'data', data: replay }));
    if (this.exited) ws.send(JSON.stringify({ type: 'exit', code: this.exitCode }));
  }

  detach(ws) {
    this.clients.delete(ws);
    this._starved.delete(ws);
  }

  meta() {
    return {
      id: this.id,
      kind: this.kind,
      label: this.label,
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      exited: this.exited,
      exitCode: this.exitCode,
      mode: this._mode,
      startedAt: this.startedAt,
    };
  }
}

function createSessionFromKind(kind, opts = {}) {
  const cfg = loadConfig();
  let entry = cfg[kind];
  // The terminal kind is platform-resolved: on Windows it is PowerShell as
  // configured; on WSL/Linux/macOS the same request opens the platform shell.
  // Aliasing here (not in config) keeps one cli-config.json valid everywhere
  // and keeps every existing client that sends kind:"powershell" working.
  if ((kind === 'powershell' || kind === 'shell') && process.platform !== 'win32') {
    entry = platform.platformShellEntry();
  } else if (kind === 'shell' && !entry) {
    entry = cfg.powershell;
  }
  if (!entry) throw new Error(`unknown CLI kind: ${kind}`);
  const useDanger = typeof opts.dangerous === 'boolean' ? opts.dangerous : state.fullPermissions;
  // Sign-in mode runs the provider's own interactive login flow in a real PTY.
  // These CLIs authenticate through a browser or device code and have no
  // headless path, so the only honest option is to hand the user a terminal.
  // Never dangerous: signing in must not also grant filesystem authority.
  if (opts.mode === 'login') {
    const loginRaw = entry.login_command;
    if (!loginRaw || !loginRaw.length) throw new Error(`no login_command configured for kind=${kind}; sign in manually in a terminal`);
    const loginSlot = resolveSlot(loginRaw);
    const [loginCommand, ...loginArgs] = loginSlot;
    const loginId = String(nextId++);
    const loginSession = new Session(loginId, kind, `${entry.label} — sign in`, loginCommand, loginArgs, resolveAllowedCwd(opts.cwd));
    sessions.set(loginId, loginSession);
    return loginSession;
  }
  const slotRaw = useDanger ? entry.dangerous : entry.safe;
  if (!slotRaw || !slotRaw.length) throw new Error(`no command configured for kind=${kind}`);
  const slot = resolveSlot(slotRaw);
  const [command, ...args] = slot;
  const id = String(nextId++);
  const labelSuffix = useDanger ? ' (FULL)' : '';
  const session = new Session(
    id,
    kind,
    (opts.label || entry.label) + labelSuffix,
    command,
    args,
    resolveAllowedCwd(opts.cwd)
  );
  sessions.set(id, session);
  return session;
}

// ---- HTTP / WS server ----
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const ALLOWED_ORIGINS = new Set([
  `http://${HOST}:${PORT}`,
  `http://localhost:${PORT}`,
]);

// DNS rebinding turns "loopback-only" into "any web page can reach the bridge":
// the attacker's page resolves its own hostname to 127.0.0.1, so the socket
// really is loopback, and per Fetch a same-origin GET carries no Origin header
// — isDirectLoopbackRequest and the Origin gate below both pass, and
// /api/capability hands that page the master token. Host is the one header the
// browser will not let it forge, so pin it to the names this process is
// actually reachable under (it binds HOST only). lib/remote-mcp.js already
// documents this check as part of its posture; /mcp itself is exempt because it
// is bearer-gated and deliberately reached through a tunnel under a public
// hostname, which is the only supported non-loopback surface.
// Derived from ALLOWED_ORIGINS so the two gates can never disagree about which
// names this bridge answers to. Both forms: a browser omits the port only when
// it is the scheme default.
const ALLOWED_HOSTS = new Set([...ALLOWED_ORIGINS].flatMap((origin) => {
  const parsed = new URL(origin);
  return [parsed.host, parsed.hostname];
}));

function isDirectLoopbackRequest(req) {
  const remote = String(req.socket?.remoteAddress || '').toLowerCase();
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const forwarded = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']
    .some((header) => req.headers[header] != null);
  return loopback && !forwarded;
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  // An absent Host cannot come from a browser (HTTP/1.1 requires it), so it is
  // not a rebinding vector; a handwritten loopback client that omits it keeps
  // working. Compared lowercase because only browsers normalize it.
  const host = String(req.headers.host || '').toLowerCase();
  const remoteMcpPath = req.path === '/mcp' || req.path.startsWith('/mcp/');
  if (host && !ALLOWED_HOSTS.has(host) && !remoteMcpPath) {
    return res.status(403).json({ error: 'host not allowed' });
  }
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).json({ error: 'origin not allowed' });
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-RelayBridge-Token, X-PS-Bridge-Token, X-RelayBridge-Expected-Build-Id, X-RelayBridge-Expected-Receipt-Store-Id');
  res.setHeader('Access-Control-Expose-Headers', 'X-RelayBridge-Receipt-Id, X-RelayBridge-Request-Id, X-RelayBridge-Build-Id, X-RelayBridge-Receipt-Store-Id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (origin) res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const INDEX_TEMPLATE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
app.use('/vendor/xterm', express.static(path.join(ROOT, 'node_modules', '@xterm', 'xterm'), { index: false, dotfiles: 'deny', maxAge: '1y', immutable: true }));
app.use('/vendor/xterm-addon-fit', express.static(path.join(ROOT, 'node_modules', '@xterm', 'addon-fit'), { index: false, dotfiles: 'deny', maxAge: '1y', immutable: true }));
app.get(['/', '/index.html'], (req, res) => {
  const nonce = crypto.randomBytes(18).toString('base64');
  const html = INDEX_TEMPLATE
    .replace('<style>', `<style nonce="${nonce}">`)
    .replace('<script>', `<script nonce="${nonce}">`)
    .replace('__ONE_SHOT_DEFAULT_TIMEOUT_MS__', String(TIMEOUT_POLICY.oneShotDefaultMs));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "script-src-attr 'none'",
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self' ws://${HOST}:${PORT} ws://localhost:${PORT}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; '));
  res.type('html').send(html);
});
// The static mount below serves public/index.html for any path the route
// matcher above misses — '//index.html' and '/%2findex.html' both reach it —
// and that copy carries no CSP header, no per-response nonce and no
// __ONE_SHOT_DEFAULT_TIMEOUT_MS__ substitution, so one extra slash yields an
// unprotected page whose inline script dies on an unbound identifier. The
// template is only ever served by the handler above; anything else asking for
// it by path is not a real client.
app.use((req, res, next) => {
  let requested = req.path;
  try { requested = decodeURIComponent(req.path); } catch { /* malformed escape: judge the raw path */ }
  if (/(?:^|[\\/])index\.html$/i.test(requested)) return res.status(404).json({ error: 'not found' });
  next();
});
app.use(express.static(path.join(ROOT, 'public'), { index: false, dotfiles: 'deny' }));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    ptyMode: pty ? 'pty' : 'pipe',
    fullPermissions: state.fullPermissions,
    sessionCount: sessions.size,
    activeTaskCount: activeChildren.size,
    activeOneShotCount,
    maxActiveOneShots: MAX_ACTIVE_ONESHOTS,
    oneShotTimeoutPolicy: {
      minimumMs: TIMEOUT_POLICY.minimumMs,
      defaultMs: TIMEOUT_POLICY.oneShotDefaultMs,
      maxMs: TIMEOUT_POLICY.oneShotMaxMs,
    },
    version: BRIDGE_VERSION,
    buildId: BRIDGE_BUILD_ID,
    receiptStoreId: RECEIPT_STORE_IDENTITY.id,
    receiptStoreIdentityReady: RECEIPT_STORE_IDENTITY.ready,
    capabilityAuth: true,
    tokenAcl: TOKEN_ACL,
    stickyDangerousEnabled: envFirst('RELAYBRIDGE_ALLOW_STICKY_DANGEROUS', 'PS_BRIDGE_ALLOW_STICKY_DANGEROUS') === '1',
    startFullPermissionsEnabled: envFirst('RELAYBRIDGE_START_FULL_PERMISSIONS', 'PS_BRIDGE_START_FULL_PERMISSIONS') === '1',
    runtime: {
      platform: platform.detectPlatform().label,
      wslNative: WSL_NATIVE_RUNTIME,
      nativeProviderBinariesOnly: !ALLOW_WIN_INTEROP,
    },
    pid: process.pid,
    instanceId: INSTANCE_ID,
    startedAt: STARTED_AT,
  });
});

// Same-origin browser clients use this bootstrap endpoint once, then attach
// the token as a non-simple request header. Never disclose the master token
// through a reverse proxy: remote MCP exposes only /mcp, and a path-scoped
// tunnel must not turn the local dashboard bootstrap into a public endpoint.
app.get('/api/capability', (req, res) => {
  if (!isDirectLoopbackRequest(req)) {
    return res.status(403).json({ error: 'capability bootstrap is loopback-only' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ token: CAPABILITY_TOKEN, header: 'X-RelayBridge-Token', legacyHeader: 'X-PS-Bridge-Token' });
});

// ---- request telemetry ----
// Every /api call is recorded with its origin so the dashboard can show what
// the MCP server is doing and MCP agents can see what the dashboard did.
// The MCP client tags itself with X-RelayBridge-Client: mcp; everything else
// counts as the UI. Ring-buffered in memory; /api/telemetry reads it.
const TELEMETRY_MAX = 500;
const telemetryLog = [];
const telemetryTotals = { ui: 0, mcp: 0, other: 0 };
let telemetrySeq = 0;
function recordTelemetry(entry) {
  telemetryLog.push(entry);
  if (telemetryLog.length > TELEMETRY_MAX) telemetryLog.shift();
  const bucket = entry.client === 'mcp' ? 'mcp' : entry.client === 'ui' ? 'ui' : 'other';
  telemetryTotals[bucket] += 1;
}

app.use('/api', (req, res, next) => {
  // Reading the log must not pollute the log.
  if (req.path !== '/telemetry') {
    const startedAt = Date.now();
    const rawClient = String(req.get('x-relaybridge-client') || 'ui').toLowerCase().slice(0, 16);
    res.on('finish', () => {
      let kind = null;
      try { if (req.body && typeof req.body.kind === 'string') kind = req.body.kind.slice(0, 32); } catch { /* body may be absent */ }
      recordTelemetry({
        id: ++telemetrySeq,
        ts: new Date(startedAt).toISOString(),
        client: rawClient,
        method: req.method,
        path: (req.originalUrl || req.url).split('?')[0],
        status: res.statusCode,
        ms: Date.now() - startedAt,
        kind,
      });
    });
  }
  const providedToken = req.headers['x-relaybridge-token'] || req.headers['x-ps-bridge-token'];
  if (!tokenMatches(providedToken)) {
    return res.status(401).json({ error: 'valid X-RelayBridge-Token required' });
  }
  next();
});

const ZERO_PROVIDER_RETRIES = Object.freeze({
  count: 0,
  total_delay_ms: 0,
  max_attempt: 0,
  declared_max_retries: 0,
  by_error: {},
  by_status: {},
  events: [],
  truncated: false,
  observed_events: 0,
  invalid_events: 0,
  duplicate_events: 0,
});

function requiresMcpActionIdentity(req) {
  if (String(req.get('x-relaybridge-client') || '').toLowerCase() !== 'mcp') return false;
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return false;
  // Lifecycle endpoints are the recovery path for replacing a stale build.
  return req.path !== '/admin/shutdown' && req.path !== '/admin/restart';
}

// A stale MCP process can otherwise submit work to a newer REST process that
// writes transport receipts into a different store. Require the MCP's expected
// build and receipt-store hashes on every mutating call. Current MCP clients
// also perform a health preflight; this server-side check closes the restart
// race and rejects older clients that do not send identity headers.
app.use('/api', (req, res, next) => {
  if (!requiresMcpActionIdentity(req)) return next();
  const expectedBuildId = String(req.get('x-relaybridge-expected-build-id') || '');
  const expectedReceiptStoreId = String(req.get('x-relaybridge-expected-receipt-store-id') || '');
  const buildMatches = expectedBuildId !== '' && expectedBuildId === BRIDGE_BUILD_ID;
  const receiptStoreMatches = expectedReceiptStoreId !== ''
    && RECEIPT_STORE_IDENTITY.ready
    && expectedReceiptStoreId === RECEIPT_STORE_IDENTITY.id;
  if (buildMatches && receiptStoreMatches) return next();
  return res.status(409).json({
    error: 'MCP action identity preflight failed; restart/reinstall RelayBridge so MCP and REST use the same build and receipt store',
    failureClass: 'bridge_identity_mismatch',
    model_invocation: false,
    token_usage_source: 'not_invoked',
    transport_retry_count: 0,
    provider_retries: ZERO_PROVIDER_RETRIES,
    actionPreflight: {
      ok: false,
      expectedBuildId: expectedBuildId || null,
      currentBuildId: BRIDGE_BUILD_ID,
      expectedReceiptStoreId: expectedReceiptStoreId || null,
      currentReceiptStoreId: RECEIPT_STORE_IDENTITY.id,
      buildMatches,
      receiptStoreMatches,
    },
  });
});

app.get('/api/config', (req, res) => {
  res.json(loadConfig());
});

// Authenticated workspace-policy discovery keeps browser defaults aligned with
// an operator-supplied allowlist. The public health endpoint intentionally does
// not expose local filesystem paths.
app.get('/api/workspace', (req, res) => {
  res.json(workspacePolicy());
});

// MCP cache admission must consult the live REST process before trusting a
// cached provider result.  This endpoint performs the same startup-pinned cwd
// validation as /api/oneshot without invoking a provider or exposing a host
// path.  Rejections receive the normal durable zero-invocation receipt.
app.post('/api/workspace/validate', (req, res) => {
  const startedAt = Date.now();
  const body = req.body || {};
  const requestId = normalizeOneShotRequestId(body);
  try {
    const snapshot = captureAllowedCwdIdentity(body.cwd);
    revalidateAllowedCwdIdentity(snapshot);
    return res.json({
      ok: true,
      cwdIdentityHash: snapshot.cwdIdentityHash,
      cwdPolicyId: CWD_POLICY_IDENTITY,
      model_invocation: false,
      token_usage_source: 'not_invoked',
      transport_retry_count: 0,
      provider_retries: ZERO_PROVIDER_RETRIES,
      requestId,
      bridgeBuildId: BRIDGE_BUILD_ID,
      receiptStoreId: RECEIPT_STORE_IDENTITY.id,
    });
  } catch (err) {
    return sendOneShotPreAdmissionRejection(res, {
      statusCode: 400,
      payload: {
        error: err.validation?.reason || err.message,
        errorCode: err.code || null,
        validation: err.validation || null,
      },
      kind: typeof body.kind === 'string' ? body.kind : null,
      prompt: typeof body.prompt === 'string' ? body.prompt : '',
      requestId,
      failureClass: 'validation',
      startedAt,
      route: { provider: typeof body.kind === 'string' ? body.kind : null, request_id: requestId },
    });
  }
});

function runProbe(slotRaw, timeoutMs = 15000, stripEnv = [], signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ exitCode: -1, stdout: '', stderr: 'diagnostic cancelled', timedOut: false, aborted: true });
    const slot = resolveSlot(slotRaw);
    const env = buildEnv({}, stripEnv);
    const [configuredBinary, ...args] = slot;
    const resolvedBinary = resolveExecutable(configuredBinary, env);
    const isWindowsShim = process.platform === 'win32' && !/\.exe$/i.test(resolvedBinary);
    const spawnBinary = isWindowsShim ? (process.env.ComSpec || 'cmd.exe') : resolvedBinary;
    const spawnArgs = isWindowsShim
      ? ['/d', '/s', '/c', [resolvedBinary, ...args].map(quoteCmdArg).join(' ')]
      : args;
    let proc;
    try {
      // detached on POSIX so the timeout kill signals the probe's whole group
      // instead of orphaning whatever it spawned — see the one-shot spawnOpts
      // for why killTree's ps-walk fallback is not equivalent.
      proc = trackChild(spawn(spawnBinary, spawnArgs, { cwd: ROOT, env, windowsHide: true, detached: process.platform !== 'win32' }));
    } catch (err) {
      return resolve({ exitCode: -1, stdout: '', stderr: err.message, timedOut: false });
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let abortHandler = null;
    const finish = (exitCode, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortHandler) signal?.removeEventListener('abort', abortHandler);
      // Join instead of prefixing: when the child never starts, stderr is '' and
      // the old concatenation produced '\nspawn agy ENOENT', whose FIRST line is
      // empty — and every consumer takes the first line (discoverModels,
      // /api/auth/status). The most common failure on a fresh box, "that CLI is
      // not installed under this name", was therefore recorded as no error at
      // all: model-registry rows landed with error:null and no warning.
      resolve({ exitCode, stdout, stderr: [stderr, error && error.message].filter(Boolean).join('\n'), timedOut, aborted: !!signal?.aborted });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(proc);
      // Resolve on a grace delay even if the child never emits close: killing
      // the tree is not a guarantee of an exit event, and a pending probe would
      // otherwise wedge readiness checks and model discovery forever.
      const graceful = setTimeout(() => finish(-1, new Error('probe timed out and did not exit')), 2000);
      if (typeof graceful.unref === 'function') graceful.unref();
    }, timeoutMs);
    abortHandler = () => {
      killProcessTree(proc);
      finish(-1, new Error('diagnostic cancelled'));
    };
    signal?.addEventListener('abort', abortHandler, { once: true });
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => { if (stdout.length < 32768) stdout += d; });
    proc.stderr.on('data', (d) => { if (stderr.length < 32768) stderr += d; });
    proc.on('error', (err) => finish(-1, err));
    proc.on('close', (code) => finish(code));
    try { proc.stdin.end(); } catch {}
  });
}

// Latest completed /api/diag snapshot. /api/agents reuses it instead of
// spawning fresh readiness probes on every listing.
let lastDiagnostics = null;

function updateDefaultAccountRuntimeAuth(kind, authenticated) {
  if (!kind) return;
  const priorResults = lastDiagnostics?.results && typeof lastDiagnostics.results === 'object'
    ? lastDiagnostics.results : {};
  const prior = priorResults[kind] && typeof priorResults[kind] === 'object'
    ? priorResults[kind] : {};
  lastDiagnostics = {
    at: Date.now(),
    results: {
      ...priorResults,
      [kind]: {
        ...prior,
        found: true,
        ready: authenticated,
        authFailed: !authenticated,
        authAuthoritative: true,
        detail: authenticated
          ? 'authenticated by successful default-account dispatch'
          : 'default account authentication failed during live dispatch',
      },
    },
  };
}

function armDefaultAccountRuntimeAuthRetry(kind) {
  const priorResults = lastDiagnostics?.results && typeof lastDiagnostics.results === 'object'
    ? lastDiagnostics.results : {};
  const prior = priorResults[kind] && typeof priorResults[kind] === 'object'
    ? priorResults[kind] : {};
  // Pending is intentionally neither ready nor signed out. The operator action
  // authorizes one live validation; only that dispatch may prove success.
  lastDiagnostics = {
    at: Date.now(),
    results: {
      ...priorResults,
      [kind]: {
        ...prior,
        ready: null,
        authFailed: false,
        authAuthoritative: false,
        detail: 'operator requested an authentication retry; live validation is pending',
      },
    },
  };
}

// A refreshed provider probe is the generic positive signal that the implicit
// credential home was repaired. Keep the persisted managed-default quarantine
// aligned with that live evidence; linked account markers remain independent.
function reconcileManagedDefaultAuth(cfg, results) {
  let changed = false;
  for (const [kind, result] of Object.entries(results || {})) {
    const entry = cfg?.[kind];
    if (!entry || !providerAccounts.credentialEnvFor(entry) || !result?.found
      || entry.probe_auth_authoritative !== true) continue;
    try {
      const mutation = result.ready === true
        ? providerAccounts.clearAccountAuthFailure(
            DATA_DIR, kind, providerAccounts.DEFAULT_ACCOUNT_ID,
          )
        : result.authFailed === true
          ? providerAccounts.noteAccountAuthFailure(
              DATA_DIR, kind, providerAccounts.DEFAULT_ACCOUNT_ID, entry,
            )
          : null;
      changed = !!mutation || changed;
    } catch { /* diagnostics must still return when account authority needs repair */ }
  }
  if (changed) invalidateAccountRegistry();
}

const PROVIDER_TAG_RE = /^[a-z][a-z0-9-]{0,23}$/;
const MAX_PROVIDER_TAGS = 16;

// An "AI provider" is any configured entry with a one-shot path. Plain
// PowerShell (interactive-only, no oneshot slots) is deliberately excluded.
function isAiProviderEntry(kind, entry) {
  if (!entry || typeof entry !== 'object' || kind.startsWith('_')) return false;
  return !!(entry.oneshot_adapter ||
    (Array.isArray(entry.oneshot_safe) && entry.oneshot_safe.length) ||
    (Array.isArray(entry.oneshot_dangerous) && entry.oneshot_dangerous.length));
}

function planningFilesystemAuthority(body = {}) {
  const dangerous = body?.dangerous === true;
  const acknowledged = body?.acknowledgeFilesystemWrites === true;
  if (dangerous && !acknowledged) {
    throw new Error('dangerous=true planning requires acknowledgeFilesystemWrites=true');
  }
  if (!dangerous && acknowledged) {
    throw new Error('acknowledgeFilesystemWrites is valid only with dangerous=true');
  }
  return { dangerous, acknowledged };
}

function runtimeFilesystemPolicyEntry(entry = {}) {
  return process.env.NODE_ENV === 'test' && entry.oneshot_safe_filesystem_policy == null
    ? { ...entry, oneshot_safe_filesystem_policy: 'read_only_enforced' }
    : entry;
}

function applyFilesystemEligibilityToDiagnostics(diagnostics = {}, cfg = {}, { dangerous = false } = {}) {
  const out = {};
  const skipped = [];
  const kinds = new Set([...Object.keys(diagnostics || {}), ...Object.keys(cfg || {}).filter((kind) => !kind.startsWith('_'))]);
  for (const kind of kinds) {
    const prior = diagnostics?.[kind] && typeof diagnostics[kind] === 'object' ? diagnostics[kind] : {};
    if (!isAiProviderEntry(kind, cfg[kind])) {
      out[kind] = { ...prior };
      continue;
    }
    const eligibility = providerFilesystemEligibility(runtimeFilesystemPolicyEntry(cfg[kind] || {}), { dangerous });
    const transportReady = prior.ready ?? null;
    const executionReady = transportReady === false ? false : eligibility.eligible;
    out[kind] = {
      ...prior,
      safeFilesystem: eligibility,
      executionReady,
      safeReady: dangerous ? null : executionReady,
      executionDetail: executionReady ? (prior.detail || '')
        : (eligibility.blockedReason || prior.detail || 'provider is not executable'),
    };
    if (!executionReady && eligibility.blockedReason) {
      skipped.push({ kind, reason: eligibility.blockedReason, policy: eligibility.policy });
    }
  }
  return { diagnostics: out, skipped, dangerous };
}

function agentSummary(kind, entry) {
  const diag = lastDiagnostics?.results?.[kind] || null;
  const safeFilesystem = diag?.safeFilesystem || providerFilesystemEligibility(runtimeFilesystemPolicyEntry(entry));
  return {
    id: kind,
    label: entry.label || kind,
    model: entry.model || null,
    tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => PROVIDER_TAG_RE.test(String(tag))) : [],
    autoRoute: entry.autoRoute !== false,
    usageCapability: diag?.usageCapability || providerUsageCapability(entry),
    safeOneShot: {
      ...safeFilesystem,
      ready: diag?.safeReady ?? ((diag?.ready ?? null) === false ? false : safeFilesystem.eligible),
    },
    readiness: diag ? {
      found: diag.found ?? null,
      ready: diag.ready ?? null,
      safeReady: diag.safeReady ?? null,
      detail: diag.detail || '',
      checkedAt: new Date(lastDiagnostics.at).toISOString(),
    } : null,
  };
}

async function probeOllamaReadiness(entry) {
  let found = false;
  let ready = false;
  let detail = '';
  let runtimeVersion = '';
  const model = entry.model || entry.oneshot_model
    || (Array.isArray(entry.safe) ? entry.safe[2] : '') || '';
  try {
    const base = localOllamaUrl();
    const tagsUrl = new URL('/api/tags', base.origin);
    const resp = await fetch(tagsUrl, { signal: AbortSignal.timeout(4000) });
    found = true;
    if (!resp.ok) {
      detail = `ollama daemon at ${base.origin} returned HTTP ${resp.status}`;
    } else {
      const body = await resp.json();
      const names = Array.isArray(body?.models) ? body.models.map((item) => String(item?.name || '')) : [];
      runtimeVersion = `${names.length} model(s) loaded`;
      ready = !model || names.some((name) => name === model
        || name.split(':')[0] === String(model).split(':')[0]);
      detail = ready
        ? `daemon up at ${base.origin} with ${model || 'any model'}`
        : `daemon up at ${base.origin} but ${model} is not pulled (have: ${names.slice(0, 4).join(', ') || 'none'})`;
    }
  } catch (err) {
    detail = err.name === 'TimeoutError'
      ? `no ollama daemon answering at ${String(envFirst('RELAYBRIDGE_OLLAMA_URL', 'PS_BRIDGE_OLLAMA_URL') || 'http://127.0.0.1:11434')} (timed out)`
      : `no ollama daemon reachable: ${err.message}`;
  }
  return {
    binary: null,
    found,
    ready,
    paths: [],
    label: entry.label,
    detail,
    probeExitCode: null,
    runtimeVersion,
    usageCapability: providerUsageCapability(entry, { runtimeVersion }),
  };
}

async function coldPlanningDiagnostics(cfg, pathDetail) {
  const env = buildEnv();
  const pairs = await Promise.all(Object.keys(cfg).filter((kind) => !kind.startsWith('_')).map(async (kind) => {
    const entry = cfg[kind];
    if (entry.oneshot_adapter === 'ollama_api') {
      return [kind, await probeOllamaReadiness(entry)];
    }
    let found = false;
    try {
      const probeBin = (entry.version_probe || entry.probe || entry.safe || [])[0];
      // resolveExecutable returns an unresolved command unchanged. Only a
      // changed or already-absolute path proves that a CLI transport exists.
      const resolvedProbe = probeBin ? resolveExecutable(probeBin, env) : '';
      found = !!probeBin && (resolvedProbe !== probeBin || path.isAbsolute(resolvedProbe));
    } catch { found = false; }
    return [kind, { found, ready: found, detail: pathDetail }];
  }));
  return Object.fromEntries(pairs);
}

// Live dispatch can update one provider's authentication state before a full
// readiness sweep has ever run. Such a partial snapshot must not make every
// absent provider look eligible. Fill only missing configured keys with cheap
// path/transport evidence and preserve every live result already observed.
async function completePlanningDiagnostics(cfg, existing, pathDetail) {
  const preserved = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing : {};
  const missingKinds = Object.keys(cfg).filter((kind) => !kind.startsWith('_')
    && !Object.prototype.hasOwnProperty.call(preserved, kind));
  if (!missingKinds.length) return preserved;
  const missingConfig = Object.fromEntries(missingKinds.map((kind) => [kind, cfg[kind]]));
  const missing = await coldPlanningDiagnostics(missingConfig, pathDetail);
  return { ...missing, ...preserved };
}

function normalizeProviderTags(raw) {
  if (!Array.isArray(raw)) throw new Error('tags must be an array of strings');
  if (raw.length > MAX_PROVIDER_TAGS) throw new Error(`tags cannot exceed ${MAX_PROVIDER_TAGS} entries`);
  const tags = [];
  for (const value of raw) {
    if (typeof value !== 'string' || !PROVIDER_TAG_RE.test(value)) {
      throw new Error(`invalid tag ${JSON.stringify(String(value ?? '')).slice(0, 40)}; tags must match ${PROVIDER_TAG_RE}`);
    }
    if (!tags.includes(value)) tags.push(value);
  }
  return tags;
}

// Persist the whole registry atomically with the same 2-space formatting the
// repo file uses. server.js re-reads CONFIG_FILE on every request, so the
// rewrite is also the in-memory routing update.
function saveConfig(cfg) {
  const tempPath = path.join(path.dirname(CONFIG_FILE), `.cli-config.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    fs.renameSync(tempPath, CONFIG_FILE);
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
  }
}

// Resolve the target providers for one broadcast. Explicitly named providers
// are honored even when opt-in (autoRoute:false); tag and all selection always
// skip opt-in hosted quota seats so a broad fan-out cannot silently spend them.
function resolveBroadcastTargets(cfg, { providers, tag, all, dangerous = false } = {}) {
  const aiKinds = Object.entries(cfg).filter(([kind, entry]) => isAiProviderEntry(kind, entry));
  const explicit = Array.isArray(providers) ? [...new Set(providers.map((value) => String(value)))] : [];
  if (explicit.length) {
    const unknown = explicit.filter((kind) => !aiKinds.some(([known]) => known === kind));
    if (unknown.length) throw new Error('unknown or non-AI provider(s): ' + unknown.join(', '));
    return explicit;
  }
  let matched;
  if (typeof tag === 'string' && tag.trim()) {
    matched = aiKinds.filter(([, entry]) => Array.isArray(entry.tags) && entry.tags.includes(tag.trim()));
  } else if (all === true) {
    matched = aiKinds;
  } else {
    matched = [];
  }
  return matched.filter(([, entry]) => entry.autoRoute !== false
    && providerFilesystemEligibility(runtimeFilesystemPolicyEntry(entry), { dangerous }).eligible)
    .map(([kind]) => kind);
}

// Minimal Express-response stand-in that executeOneShot can drive. It captures
// the JSON payload and emits 'finish' so the one-shot admission slot releases
// exactly like it does for a real HTTP response.
class CapturedOneShotResponse extends require('events').EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.writableEnded = false;
    this.destroyed = false;
    this.done = new Promise((resolve) => { this._resolve = resolve; });
  }
  status(code) { this.statusCode = code; return this; }
  json(payload) {
    if (this.writableEnded) return this;
    this.writableEnded = true;
    this.emit('finish');
    this._resolve({ statusCode: this.statusCode, body: payload });
    return this;
  }
  cancel(reason = 'broadcast client disconnected') {
    if (this.writableEnded) return;
    this.destroyed = true;
    // Emit before marking writableEnded so executeOneShot observes a genuine
    // caller disconnect and terminates the provider process tree.
    this.emit('close');
    this.writableEnded = true;
    this._resolve({ statusCode: 499, body: { error: reason, dropped_out: true, cancelled: true } });
  }
}

function writeBroadcastRun(run) {
  const runId = run.runId || `run_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  const record = {
    runId,
    createdAt: run.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...run,
    runId,
  };
  const tempPath = path.join(RUNS_DIR, `.${runId}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempPath, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(tempPath, path.join(RUNS_DIR, `${runId}.json`));
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
  }
  return record;
}

// Resolve the real provider dependency and optionally run its non-mutating
// readiness probe. In particular, Perplexity must prove pwm authentication;
// merely finding node.exe is not an operational signal.
// Activity log: what the UI and the MCP server have each been asking the
// bridge to do. sinceId supports incremental polling.
app.get('/api/telemetry', (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 120, TELEMETRY_MAX));
  const sinceId = Number(req.query.sinceId) || 0;
  const calls = (sinceId > 0 ? telemetryLog.filter((c) => c.id > sinceId) : telemetryLog).slice(-limit);
  res.json({ ok: true, totals: { ...telemetryTotals }, lastId: telemetrySeq, calls: calls.slice().reverse() });
});

// Vetting endpoint: is that quiet run working, or is it stuck? Returns the
// evidence rather than a guess.
app.get('/api/runs/active', (req, res) => {
  const now = Date.now();
  const runs = [];
  for (const run of activeRuns.values()) {
    const snap = run.supervisor.snapshot(now);
    runs.push({
      runId: run.runId, kind: run.kind, route: run.route, pid: run.pid,
      startedAt: new Date(run.startedAt).toISOString(),
      ...snap,
      assessment: snap.phase === 'streaming' ? 'producing output right now â€” leave it alone'
        : snap.phase === 'working' ? 'recently active â€” still working'
          : snap.phase === 'suspect_loop' ? 'repeating itself â€” watch this one'
            : snap.phase === 'quiet' || snap.phase === 'quiet_start'
              ? (snap.cpuMs != null ? 'silent but burning CPU â€” thinking, not stuck' : 'silent, liveness unverified')
              : 'starting up',
    });
  }
  res.json({ ok: true, count: runs.length, runs });
});

// What models each provider can actually run, plus what each is best at.
app.get('/api/models', async (req, res) => {
  if (req.query.refresh === '1' || !modelRegistry) {
    try { await discoverModels(); } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
  }
  const cfg = loadConfig();
  res.json({ ok: true, ...(modelRegistry || { providers: {}, warnings: [] }), staleness: modelConfigStaleness(cfg._models || {}) });
});

app.post('/api/models/refresh', async (req, res) => {
  try { res.json({ ok: true, ...(await discoverModels()) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Full execution plan for a task: company, model, AND effort together.
// Routing alone answers "which CLI"; that is not enough to avoid waste. Sending
// a CSS tweak to a frontier seat, or arithmetic to a max-effort reasoning model,
// costs real money for no gain. This returns the cheapest capable combination
// and says why, so callers do not have to guess.
app.post('/api/plan', async (req, res) => {
  const { task, effort, kind, providerBudget: rawBudget } = req.body || {};
  if (!task || typeof task !== 'string' || !task.trim()) {
    return res.status(400).json({ error: 'task (non-empty string) required' });
  }
  const requestedEffort = effort ? normalizeEffort(String(effort)) : null;
  if (effort && !requestedEffort) {
    return res.status(400).json({ error: `effort must be one of: ${SUPPORTED_EFFORTS.join(', ')}` });
  }
  let requestedProviderBudget;
  try {
    requestedProviderBudget = validateProviderBudget(rawBudget);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  let filesystemAuthority;
  try { filesystemAuthority = planningFilesystemAuthority(req.body || {}); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    const router = await import('./mcp/router.mjs');
    const cfg = loadConfig();
    let diagnostics = await completePlanningDiagnostics(
      cfg,
      lastDiagnostics?.results,
      'path-only check',
    );
    const gauges = usageLedger.gaugeAll(seatCostClasses());
    const routingInputs = accountAwareRoutingInputs(cfg, diagnostics, gauges, coolingQuotaStates());
    const fleetInput = applyCooldownsToDiagnostics(
      routingInputs.diagnostics, routingInputs.cooling, kind ? [kind] : [],
    );
    const vendorQuotaInput = applyVendorQuotaExhaustionToDiagnostics(
      fleetInput.diagnostics, routingInputs.gauges,
    );
    const filesystemInput = applyFilesystemEligibilityToDiagnostics(vendorQuotaInput.diagnostics, cfg, filesystemAuthority);
    diagnostics = filesystemInput.diagnostics;
    let route = router.routeTask({ task, diagnostics, dangerous: filesystemAuthority.dangerous });
    route = levelRouteSelection(route, routingInputs.gauges, seatCostClassMap());
    route.fleetState = {
      cooldownSkipped: fleetInput.skipped,
      vendorQuotaSkipped: vendorQuotaInput.skipped,
      balance: fleetBalance(gauges),
      vendorQuota: vendorQuotaFleet(gauges),
      operatorQuota: operatorQuotaFleet(gauges),
      quotaSeats: currentQuotaSeatGroups(),
      accountSelection: routingInputs.accountSelection,
      filesystemSkipped: filesystemInput.skipped,
      filesystemAuthority,
    };
    const plan = buildTaskPlan({
      route,
      config: cfg,
      registry: modelRegistry,
      resolveModelArgs,
      // lib/task-plan predates xhigh.  Use its conservative high mechanics to
      // choose the same provider/model, then restore the caller's explicit
      // xhigh intent below; execution performs the provider capability check.
      requestedEffort: requestedEffort === 'xhigh' ? 'high' : requestedEffort,
      requestedKind: kind || null,
      requestedProviderBudget,
    });
    if (requestedEffort) annotateRequestedPlanEffort(plan, cfg, requestedEffort);
    res.json({ ok: true, task: task.slice(0, 400), ...plan, fleetState: route.fleetState });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Delegation: classify a task, rank providers by tier, and pick the model
// weight class inside each. Advisory — it returns a plan, it does not dispatch.
app.post('/api/route', async (req, res) => {
  const {
    task, diagnostics: supplied, preferKinds, excludeKinds, providerBudget: rawBudget,
    localOnly = false, maxProviders, committeeMode = 'advisory',
  } = req.body || {};
  if (!task || typeof task !== 'string' || !task.trim()) {
    return res.status(400).json({ error: 'task (non-empty string) required' });
  }
  if (maxProviders !== undefined
    && (!Number.isInteger(maxProviders) || maxProviders < 1 || maxProviders > 4)) {
    return res.status(400).json({ error: 'maxProviders must be an integer from 1 to 4' });
  }
  if (!['advisory', 'consensus'].includes(committeeMode)) {
    return res.status(400).json({ error: 'committeeMode must be advisory or consensus' });
  }
  let requestedProviderBudget;
  try {
    requestedProviderBudget = validateProviderBudget(rawBudget);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  let filesystemAuthority;
  try { filesystemAuthority = planningFilesystemAuthority(req.body || {}); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    const router = await import('./mcp/router.mjs');
    const cfg = loadConfig();
    let diagnostics = await completePlanningDiagnostics(
      cfg,
      supplied && typeof supplied === 'object' ? supplied : lastDiagnostics?.results,
      'path-only check; run /api/diag for auth status',
    );
    const explicitKinds = Array.isArray(preferKinds) ? preferKinds : [];
    const gauges = usageLedger.gaugeAll(seatCostClasses());
    const routingInputs = accountAwareRoutingInputs(cfg, diagnostics, gauges, coolingQuotaStates());
    const fleetInput = applyCooldownsToDiagnostics(
      routingInputs.diagnostics, routingInputs.cooling, explicitKinds,
    );
    const vendorQuotaInput = applyVendorQuotaExhaustionToDiagnostics(
      fleetInput.diagnostics, routingInputs.gauges,
    );
    const filesystemInput = applyFilesystemEligibilityToDiagnostics(vendorQuotaInput.diagnostics, cfg, filesystemAuthority);
    diagnostics = filesystemInput.diagnostics;
    let route = router.routeTask({
      task, diagnostics,
      dangerous: filesystemAuthority.dangerous,
      preferredProviders: explicitKinds.length ? explicitKinds : undefined,
      excludedProviders: Array.isArray(excludeKinds) ? excludeKinds : undefined,
      localOnly: localOnly === true,
      maxProviders,
      committeeMode,
    });
    route = levelRouteSelection(route, routingInputs.gauges, seatCostClassMap());
    route.fleetState = {
      cooldownSkipped: fleetInput.skipped,
      vendorQuotaSkipped: vendorQuotaInput.skipped,
      balance: fleetBalance(gauges),
      vendorQuota: vendorQuotaFleet(gauges),
      operatorQuota: operatorQuotaFleet(gauges),
      quotaSeats: currentQuotaSeatGroups(),
      accountSelection: routingInputs.accountSelection,
      filesystemSkipped: filesystemInput.skipped,
      filesystemAuthority,
    };
    const taskTier = route.classification?.tier;
    const selected = (route.selected || []).map((pick) => {
      const entry = cfg[pick.kind] || {};
      const resolved = resolveModelArgs({ entry, taskTier });
      const retired = resolved.model ? pinIsRetired(modelRegistry, pick.kind, resolved.model) : false;
      const budget = resolveSupervisorOptions({
        entry,
        globals: cfg._supervisor || {},
        providerBudget: requestedProviderBudget,
        taskTier,
      }).providerBudget;
      return {
        ...pick,
        modelTier: resolved.modelTier,
        model: retired ? null : resolved.model,
        modelArgs: retired ? [] : resolved.args,
        modelSource: retired ? 'account_default_retired_pin' : resolved.source,
        modelNote: retired ? `configured model "${resolved.model}" is no longer offered by this account` : resolved.note,
        providerBudget: budget,
      };
    });
    res.json({ ok: true, ...route, selected, modelTier: modelTierForTaskTier(taskTier), modelConfig: modelConfigStaleness(cfg._models || {}) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Which providers are installed but not signed in. "found && !ready" is exactly
// that state: the CLI resolves on PATH but its own probe reports no session.
// Returns the interactive login command so the UI can offer a sign-in terminal
// instead of letting the next call fail.
function signedOutProviders(diagnostics, cfg) {
  const results = diagnostics?.results || diagnostics || {};
  const out = [];
  for (const [kind, info] of Object.entries(results)) {
    if (!info || !info.found || info.ready || info.authFailed !== true) continue;
    const entry = cfg[kind];
    if (!entry) continue;
    out.push({
      kind,
      label: entry.label || kind,
      detail: info.detail || '',
      loginCommand: Array.isArray(entry.login_command) ? entry.login_command : null,
      canSignIn: Array.isArray(entry.login_command) && entry.login_command.length > 0,
    });
  }
  return out;
}

const AUTH_FAILURE_RE = /(?:not (?:logged|signed) in|not authenticated|unauthenticated|authentication required|please (?:log|sign) in|login required|no active (?:session|account)|invalid (?:api key|credentials)|"loggedIn"\s*:\s*false)/i;
function probeIndicatesAuthFailure(text) {
  return AUTH_FAILURE_RE.test(String(text || ''));
}

app.get('/api/auth/status', async (req, res) => {
  const cfg = loadConfig();
  let diagnostics = lastDiagnostics;
  // Only probe when asked or when nothing has been checked yet: a readiness
  // sweep spawns one process per provider and should not run on every poll.
  if (req.query.refresh === '1' || !diagnostics) {
    try {
      const env = buildEnv();
      const kinds = Object.keys(cfg).filter((k) => !k.startsWith('_') && k !== 'powershell');
      const pairs = await Promise.all(kinds.map(async (kind) => {
        const entry = cfg[kind];
        if (entry?.oneshot_adapter === 'ollama_api') {
          return [kind, await probeOllamaReadiness(entry)];
        }
        if (!entry || !Array.isArray(entry.probe) || !entry.probe.length) return [kind, null];
        let found = false;
        try {
          const probeBin = (entry.version_probe || entry.probe || entry.safe || [])[0];
          // resolveExecutable returns the command UNCHANGED when it cannot
          // resolve it, and a non-empty string is truthy — so the old
          // `!!resolveExecutable(...)` was true for every provider, including
          // ones that are not installed. Compare against the input the way the
          // main /api/diag sweep does.
          const resolvedProbe = probeBin ? resolveExecutable(probeBin, env) : '';
          found = !!probeBin && (resolvedProbe !== probeBin || path.isAbsolute(resolvedProbe));
        } catch { found = false; }
        if (!found) return [kind, { found: false, ready: false, detail: 'not installed' }];
        const result = await runProbe(entry.probe, Number(entry.probe_timeout_ms || 30000), entry.strip_env || []);
        const probeText = cleanOutput([result.stdout, result.stderr].filter(Boolean).join('\n'));
        return [kind, {
          found: true,
          ready: result.exitCode === 0,
          authFailed: result.exitCode !== 0 && probeIndicatesAuthFailure(probeText),
          authAuthoritative: entry.probe_auth_authoritative === true,
          detail: result.exitCode === 0 ? 'authenticated' : probeText.split('\n')[0].slice(0, 160),
        }];
      }));
      const refreshedResults = Object.fromEntries(pairs.filter(([, v]) => v));
      reconcileManagedDefaultAuth(cfg, refreshedResults);
      diagnostics = { at: Date.now(), results: refreshedResults };
      lastDiagnostics = diagnostics;
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
  const signedOut = signedOutProviders(diagnostics, cfg);
  // Credential-location diagnostics. Repeated "please sign in" almost always
  // means the CLI is reading a different profile than the one you logged into —
  // typically because the bridge was started elevated once and unelevated
  // another time, which changes USERPROFILE and therefore the credential path.
  // Reporting what the bridge's children actually see turns that into a
  // checkable fact instead of a guess.
  const childEnv = buildEnv();
  const homeDir = childEnv.USERPROFILE || childEnv.HOME || '';
  const credentialPaths = {
    claude: path.join(homeDir, '.claude', '.credentials.json'),
    codex: path.join(homeDir, '.codex', 'auth.json'),
    cursor: path.join(homeDir, '.cursor', 'cli-config.json'),
  };
  const credentials = {};
  for (const [kind, file] of Object.entries(credentialPaths)) {
    let exists = false;
    try { exists = fs.existsSync(file); } catch { exists = false; }
    credentials[kind] = { path: file, exists };
  }
  res.json({
    ok: true,
    checkedAt: diagnostics?.at ? new Date(diagnostics.at).toISOString() : null,
    signedOutCount: signedOut.length,
    signedOut,
    credentialHome: homeDir,
    bridgeHome: process.env.USERPROFILE || process.env.HOME || '',
    // When these differ, children look for credentials somewhere the sign-in
    // never wrote, and every call will report signed-out however often you log in.
    homeMismatch: (process.env.USERPROFILE || process.env.HOME || '') !== homeDir,
    credentials,
  });
});

app.get('/api/diag', async (req, res) => {
  const controller = new AbortController();
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      controller.abort(new Error('diagnostic client disconnected'));
    }
  });
  const cfg = loadConfig();
  const env = buildEnv();
  const kinds = Object.keys(cfg).filter((k) => !k.startsWith('_'));
  const pairs = await Promise.all(kinds.map(async (kind) => {
    const entry = cfg[kind];
    if (entry.oneshot_adapter === 'openai_chat_api') {
      let ready = false;
      let detail = '';
      let found = false;
      try {
        const url = hostedChatUrl(entry);
        const key = hostedApiKey(entry);
        found = true;
        ready = true;
        detail = `API key present in ${key.name}; live quota untested for ${url.hostname}`;
      } catch (err) {
        detail = err.message;
      }
      return [kind, {
        binary: null,
        found,
        ready,
        paths: [],
        label: entry.label,
        detail,
        probeExitCode: null,
        runtimeVersion: '',
        usageCapability: providerUsageCapability(entry),
      }];
    }
    // Probe the transport that actually executes. These seats run over
    // localOllamaUrl() HTTP, but their configured probe shells out to the
    // ollama binary — so a machine with the CLI installed and the daemon down
    // reported ready and then failed every dispatch with "fetch failed". Worse,
    // routing-policy scores local seats +30 and a "live diagnostic ready" seat
    // +20, so those dead seats won the default utility route.
    if (entry.oneshot_adapter === 'ollama_api') {
      return [kind, await probeOllamaReadiness(entry)];
    }
    const binary = entry.diagnostic_binary ||
      (entry.safe && entry.safe[0]) || (entry.dangerous && entry.dangerous[0]);
    if (!binary) return [kind, { binary: null, found: false, ready: false, paths: [], label: entry.label }];
    const resolvedInfo = resolveExecutableInfo(binary, env);
    const resolved = resolvedInfo.resolved;
    const found = resolved !== binary || path.isAbsolute(resolved) && fs.existsSync(resolved);
    let ready = found;
    let detail = '';
    let probeExitCode = null;
    let authFailed = false;
    // Say WHY a CLI that is plainly on PATH is not being offered, instead of
    // reporting a bare "not installed" the operator cannot act on.
    if (!found && resolvedInfo.interopSkipped.length) {
      detail = `found only as a Windows binary (${resolvedInfo.interopSkipped[0]}) — `
        + 'install the native Linux CLI, or set RELAYBRIDGE_ALLOW_WIN_INTEROP=1 to use it over WSL interop';
    }
    // Authentication and version probes are independent read-only calls. Run
    // them under one wall-clock envelope instead of spending up to 30s and
    // then another 15s sequentially; the MCP diagnostic deadline can now cover
    // every server-legal probe plus process-close grace.
    const [probe, versionProbe] = await Promise.all([
      found && Array.isArray(entry.probe) && entry.probe.length
        ? runProbe(entry.probe, Number(entry.probe_timeout_ms || 30000), entry.strip_env || [], controller.signal)
        : Promise.resolve(null),
      found && Array.isArray(entry.version_probe) && entry.version_probe.length
        ? runProbe(entry.version_probe, 15000, entry.strip_env || [], controller.signal)
        : Promise.resolve(null),
    ]);
    if (probe) {
      probeExitCode = probe.exitCode;
      ready = !probe.timedOut && probe.exitCode === 0;
      const probeText = cleanOutput([probe.stdout, probe.stderr].filter(Boolean).join('\n'));
      if (entry.probe_expect && !probeText.toLowerCase().includes(String(entry.probe_expect).toLowerCase())) ready = false;
      const probeReject = Array.isArray(entry.probe_reject) ? entry.probe_reject : [];
      if (probeReject.some((value) => probeText.toLowerCase().includes(String(value).toLowerCase()))) ready = false;
      authFailed = !ready && probeIndicatesAuthFailure(probeText);
      detail = ready && entry.probe_success_detail
        ? String(entry.probe_success_detail).slice(0, 300)
        : (entry.probe_redact ? (ready ? 'readiness check passed' : 'readiness check failed') : probeText.split('\n')[0].slice(0, 300));
      if (probe.timedOut) detail = 'readiness check timed out';
      if (probe.aborted) detail = 'readiness check cancelled';
    }
    let runtimeVersion = '';
    if (versionProbe) {
      if (!versionProbe.timedOut && versionProbe.exitCode === 0) {
        runtimeVersion = cleanOutput(versionProbe.stdout || versionProbe.stderr).split('\n')[0].slice(0, 200);
      }
    }
    return [kind, {
      binary,
      found,
      ready,
      paths: found ? [resolved] : [],
      label: entry.label,
      detail,
      probeExitCode,
      authFailed,
      authAuthoritative: entry.probe_auth_authoritative === true,
      runtimeVersion,
      usageCapability: providerUsageCapability(entry, { runtimeVersion }),
    }];
  }));
  const rawResults = Object.fromEntries(pairs);
  const results = applyFilesystemEligibilityToDiagnostics(rawResults, cfg).diagnostics;
  if (!controller.signal.aborted) {
    reconcileManagedDefaultAuth(cfg, results);
    lastDiagnostics = { at: Date.now(), results };
  }
  if (!clientGone && !res.writableEnded) {
    let routing = null;
    try {
      const gauges = usageLedger.gaugeAll(seatCostClasses());
      const accountInputs = accountAwareRoutingInputs(cfg, results, gauges, coolingQuotaStates());
      const cooldownInput = applyCooldownsToDiagnostics(accountInputs.diagnostics, accountInputs.cooling, []);
      const vendorInput = applyVendorQuotaExhaustionToDiagnostics(
        cooldownInput.diagnostics, accountInputs.gauges,
      );
      const filesystemInput = applyFilesystemEligibilityToDiagnostics(vendorInput.diagnostics, cfg);
      const projectedResults = Object.fromEntries(Object.entries(filesystemInput.diagnostics)
        .map(([kind, info]) => [kind, info && typeof info === 'object' ? {
          ...info,
          accountSelection: accountInputs.accountSelection[kind] || null,
        } : info]));
      routing = {
        results: projectedResults,
        accountSelection: accountInputs.accountSelection,
        cooldownSkipped: cooldownInput.skipped,
        vendorQuotaSkipped: vendorInput.skipped,
        filesystemSkipped: filesystemInput.skipped,
      };
    } catch (err) {
      routing = { results, unavailable: true, detail: err.message };
    }
    res.json({ results, routing });
  }
});

app.get('/api/permissions', (req, res) => {
  res.json({ fullPermissions: state.fullPermissions });
});

app.post('/api/permissions', (req, res) => {
  const v = !!req.body.fullPermissions;
  state.fullPermissions = v;
  saveState(state);
  res.json({ fullPermissions: state.fullPermissions });
});

app.get('/api/sessions', (req, res) => {
  res.json(Array.from(sessions.values()).map((s) => s.meta()));
});

app.post('/api/sessions', (req, res) => {
  try {
    const { kind, label, cwd, dangerous, mode } = req.body || {};
    if (!kind) return res.status(400).json({ error: 'kind required' });
    const s = createSessionFromKind(kind, { label, cwd, dangerous, mode });
    res.json(s.meta());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/sessions/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  s.kill();
  sessions.delete(req.params.id);
  res.json({ ok: true });
});

app.post('/api/sessions/:id/input', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const ok = s.write(req.body.data || '');
  res.json({ ok });
});

app.get('/api/sessions/:id/buffer', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json({
    text: s.buffer.join(''),
    exited: s.exited,
    exitCode: s.exitCode,
  });
});

// One-shot exec â€” for Cowork to run a PowerShell command and get output back.
const EXEC_OUTPUT_MAX = 1048576;
app.post('/api/exec', (req, res) => {
  if (!isDirectLoopbackRequest(req)) {
    return res.status(403).json({ error: 'command execution is loopback-only' });
  }
  const { command, shell = 'powershell', timeoutMs = 60000, cwd } = req.body || {};
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: 'command (string) required' });
  }
  let execCwd;
  try { execCwd = resolveAllowedCwd(cwd); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  // Route through the platform abstraction rather than hardcoding
  // powershell.exe: off Windows that name only resolves through WSL interop,
  // which runs the caller's command as Win32 PowerShell against a POSIX cwd.
  // buildExecSpawn also sets detached on POSIX, which killProcessTree needs to
  // signal the whole group instead of orphaning grandchildren.
  const built = platform.buildExecSpawn(command, {
    shell,
    cwd: execCwd,
    env: buildEnv(),
  });
  const proc = trackChild(spawn(built.exe, built.args, built.options));
  let stdout = '';
  let stderr = '';
  // 'error' and 'close' can both fire for one spawn (ENOENT emits error, then
  // close), so a single reply guard keeps the second one from throwing
  // ERR_HTTP_HEADERS_SENT out of an EventEmitter callback.
  let settled = false;
  const t = setTimeout(() => {
    killProcessTree(proc);
  }, TIMEOUT_POLICY.normalizeOneShotTimeoutMs(timeoutMs));
  res.on('close', () => { if (!res.writableEnded) killProcessTree(proc); });
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  // Cap the accumulation. A command that streams faster than the timeout grew
  // two JS strings without limit, which is the OOM the one-shot path is
  // hardened against by supervisor.recordOutput and runProbe by its 32 KB
  // ceiling; this route had neither. `truncated` tells the caller the output
  // is short rather than the command being quiet.
  let truncated = false;
  proc.stdout.on('data', (d) => { if (stdout.length < EXEC_OUTPUT_MAX) stdout += d; else truncated = true; });
  proc.stderr.on('data', (d) => { if (stderr.length < EXEC_OUTPUT_MAX) stderr += d; else truncated = true; });
  proc.on('close', (code) => {
    clearTimeout(t);
    if (settled) return;
    settled = true;
    res.json({ stdout, stderr, exitCode: code, truncated: truncated || undefined, shell: built.shellKind, shellNote: built.fallbackNote || undefined });
  });
  proc.on('error', (err) => {
    clearTimeout(t);
    if (settled) return;
    settled = true;
    res.status(500).json({ error: err.message, stdout, stderr });
  });
});


// One-shot AI invocation â€” used by Collab Mode. Spawns the configured CLI in
// non-interactive mode, transports the prompt by stdin/argument/temp file as
// declared in config, and captures full output. Returns
// stdout/stderr/exitCode + heuristic flags (rate_limited, budget_exceeded) so
// the frontend can mark a participant as dropped-out and continue without it.
// The full one-shot execution path, factored out of the route handler so
// /api/broadcast can fan the same prompt out through identical provider
// resolution, admission control, receipts, and cleanup. `res` only needs the
// Express response surface this function touches (status/json/on/once/
// writableEnded/destroyed), so broadcast passes a captured stand-in.
// How long to wait after the child's own 'exit' for the stdio pipes to reach
// EOF before settling anyway. Matches runProbe's 2s post-kill grace.
const ONESHOT_CLOSE_GRACE_MS = 2000;
async function executeOneShot(body, res) {
  const startedAt = Date.now();
  const { kind, prompt, timeoutMs, cwd, dangerous } = body || {};

  // Issue #16: a workspace-inspection task sent to a seat with no filesystem
  // access produces a confident, fabricated answer that records as a success.
  // Refuse BEFORE dispatch — the tokens are wasted either way, but a refusal
  // is visible and a fabricated audit is not. `groundingOverride` exists for
  // the caller who genuinely wants an ungrounded opinion; it is flagged.
  try {
    const cfgAll = loadConfig();
    const grounding = checkGrounding({
      prompt, cwd, seat: kind, seatConfig: cfgAll?.[kind] || {},
      override: body?.groundingOverride === true,
    });
    if (!grounding.allowed) {
      return sendOneShotResult(res, {
        ok: false, exitCode: null, stdout: '', stderr: grounding.reason,
        error: grounding.reason, remedy: grounding.remedy,
        failure_class: 'workspace_grounding',
        model_invocation: false, dropped_out: true,
        usage: { input_tokens: 0, output_tokens: 0 },
      }, { kind, prompt, startedAt });
    }
    if (grounding.overridden) body = { ...body, _groundingOverridden: true, _groundingOverrideReason: grounding.reason };
  } catch (err) {
    // The gate is advisory when it cannot evaluate, but losing it must be
    // visible rather than silently disabling a safety layer.
    console.warn(`[RelayBridge] workspace grounding check unavailable: ${err.message}`);
  }

  // Run association for the GitHub tracker: who did this, and any
  // explicit intent. Falls back to the OS account so checkpoint commits
  // are always attributed (maximyz3d / sover / 3DCPAI machines differ).
  const runUser = typeof body?.user === 'string' && body.user.trim()
    ? body.user.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80)
    : os.userInfo().username;
  const runIntent = typeof body?.intent === 'string'
    ? body.intent.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 2000)
    : null;
  const requestId = normalizeOneShotRequestId(body);
  const { invocationId, attemptId } = canonicalAttemptIdentity(requestId);
  const outerReceiptId = normalizeOuterReceiptId(body);
  const rejectBeforeAdmission = (statusCode, failureClass, payload, route = null) =>
    sendOneShotPreAdmissionRejection(res, {
      statusCode,
      payload,
      kind,
      prompt,
      requestId,
      failureClass,
      startedAt,
      route,
    });
  // Two timeout regimes compose here. The timeout policy bounds any EXPLICIT
  // caller timeout, so a caller can neither starve a run nor exceed the
  // transport ceiling the MCP client allows. When the caller sends nothing, no
  // clock is armed for CLI runs at all â€” the progress-based supervisor decides
  // when a run is actually stuck (lib/run-supervisor.js). The hosted adapter
  // paths (Ollama/OpenAI-compatible HTTP) are not supervised and keep a fixed
  // clock: the caller's bounded value, or the policy default.
  const explicitTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? TIMEOUT_POLICY.normalizeOneShotTimeoutMs(timeoutMs)
    : null;
  const adapterTimeoutMs = explicitTimeout ?? TIMEOUT_POLICY.oneShotDefaultMs;
  if (!kind || typeof prompt !== 'string' || !prompt.trim()) {
    return rejectBeforeAdmission(400, 'validation', { error: 'kind + non-empty prompt required' });
  }
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    return rejectBeforeAdmission(500, 'configuration', { error: `could not load provider configuration: ${err.message}` });
  }
  const entry = cfg[kind];
  if (!entry) return rejectBeforeAdmission(400, 'validation', { error: 'unknown kind: ' + kind });
  let requestedProviderBudget;
  try {
    requestedProviderBudget = validateProviderBudget(body?.providerBudget);
  } catch (err) {
    return rejectBeforeAdmission(400, 'validation', { error: err.message });
  }
  const requestedEffort = typeof body?.effort === 'string' ? body.effort.trim().toLowerCase() : null;
  if (requestedEffort && !SUPPORTED_EFFORTS.includes(requestedEffort)) {
    return rejectBeforeAdmission(400, 'validation', {
      error: `effort must be one of: ${SUPPORTED_EFFORTS.join(', ')}`,
    });
  }
  if (EXTREME_EFFORTS.has(requestedEffort) && body?.maxEffortOverride !== true) {
    return rejectBeforeAdmission(400, 'validation', {
      error: `effort=${requestedEffort} requires maxEffortOverride=true; RelayBridge never infers xhigh/max effort`,
    });
  }
  if (body?.maxEffortOverride === true && !EXTREME_EFFORTS.has(requestedEffort)) {
    return rejectBeforeAdmission(400, 'validation', {
      error: 'maxEffortOverride is valid only with effort=xhigh or effort=max',
    });
  }
  const tierEffort = !requestedEffort && typeof body?.taskTier === 'string'
    ? EFFORT_BY_TASK_TIER[body.taskTier.trim().toLowerCase()] || null
    : null;
  const effectiveEffort = requestedEffort || tierEffort;
  // A provider-wide readiness probe describes the operator's implicit/default
  // login. Linked credential directories are separate authority domains, so a
  // positive signed-out result excludes only that implicit account; account
  // selection below may still choose a provisioned linked login.
  const readiness = lastDiagnostics?.results?.[kind];
  const defaultAccountSignedOut = !!(readiness && readiness.found
    && readiness.ready === false && readiness.authFailed === true
    && readiness.authAuthoritative === true
    && Array.isArray(entry.login_command));
  let oneShotEnv;
  try {
    oneShotEnv = normalizeEnvOverrides(entry.oneshot_env);
  } catch (err) {
    return rejectBeforeAdmission(500, 'configuration', { error: `invalid oneshot environment for ${kind}: ${err.message}` });
  }
  // Collab Mode is a discussion, not an agentic task â€” it passes dangerous:false
  // so CLIs run non-agentically (no auto tool/command execution). When the
  // caller doesn't specify, fall back to the global Full Permissions toggle.
  const useDanger = (typeof dangerous === 'boolean') ? dangerous : state.fullPermissions;
  let filesystemPolicy;
  try {
    // Existing test fixtures predate this mandatory production contract. They
    // execute a local deterministic helper, so treat only missing test policy
    // fields as enforced; explicit fixture policies still exercise fail-close.
    const policyEntry = runtimeFilesystemPolicyEntry(entry);
    filesystemPolicy = resolveFilesystemPolicy(policyEntry, useDanger);
  } catch (err) {
    return rejectBeforeAdmission(500, 'configuration', { error: `invalid safe filesystem policy for ${kind}: ${err.message}` });
  }
  if (!useDanger && filesystemPolicy === 'unverified_provider_policy') {
    return rejectBeforeAdmission(409, 'safe_filesystem_unverified', {
      ok: false,
      error: `${entry.label || kind} has no verified no-write boundary for safe one-shots`,
      remedy: `Configure and test oneshot_safe_filesystem_policy as read_only_enforced or isolated_home. Use dangerous=true only when a human explicitly authorizes persistent writes.`,
      kind,
      dropped_out: true,
      usage: { input_tokens: 0, output_tokens: 0 },
    }, {
      provider: kind,
      dangerous: false,
      filesystem_policy: filesystemPolicy,
      read_only_enforced: false,
      isolated_home: false,
      request_id: requestId,
    });
  }
  const slotRaw = useDanger ? entry.oneshot_dangerous : entry.oneshot_safe;
  if (!slotRaw || !slotRaw.length) {
    return rejectBeforeAdmission(400, 'configuration', { error: 'no oneshot config for ' + kind });
  }
  // Model selection inside the provider: taskTier/modelTier picks the weight
  // class. A pin discovery proved is retired is dropped rather than sent â€” a
  // missing flag runs on the account default, a dead id fails every call.
  let modelChoice = resolveModelArgs({
    entry,
    taskTier: typeof body?.taskTier === 'string' ? body.taskTier : undefined,
    modelTier: typeof body?.modelTier === 'string' ? body.modelTier : undefined,
  });
  if (modelChoice.model && pinIsRetired(modelRegistry, kind, modelChoice.model)) {
    console.warn(`[RelayBridge] ${kind}: pinned model "${modelChoice.model}" is not in this account's model list â€” falling back to the account default`);
    modelChoice = { ...modelChoice, args: [], model: null, source: 'account_default_retired_pin' };
  }
  let slot = applyModelArgs(
    resolveSlot(slotRaw),
    modelChoice.args,
    entry,
    modelChoice.suppressArgs,
  );
  let effortResolution = applyProviderEffort({
    slot, entry, modelChoice, requestedEffort: effectiveEffort,
  });
  let effortFallbackReason = null;
  // A task tier is a routing preference, not an assertion that every custom
  // provider exposes an effort knob. Apply the inferred value when the
  // provider can express it; otherwise run on its honest account default.
  // An explicit caller request remains strict and still fails before launch.
  if (effortResolution.error && !requestedEffort && tierEffort) {
    effortFallbackReason = effortResolution.error;
    effortResolution = applyProviderEffort({
      slot, entry, modelChoice, requestedEffort: null,
    });
  }
  if (effortResolution.error) {
    return rejectBeforeAdmission(400, 'validation', {
      error: `${kind} ${effortResolution.error}`,
      requestedEffort: effectiveEffort,
      appliedEffort: null,
    }, {
      provider: kind,
      task_tier: typeof body?.taskTier === 'string' ? body.taskTier : null,
      model_tier: modelChoice.modelTier,
      requested_effort: requestedEffort,
      target_effort: effectiveEffort,
      applied_effort: null,
      effort_explicit: !!requestedEffort,
      effort_source: requestedEffort ? 'request' : (tierEffort ? 'task_tier' : 'provider_default'),
      max_effort_override: EXTREME_EFFORTS.has(requestedEffort) && body?.maxEffortOverride === true,
      effort_method: 'unsupported',
      request_id: requestId,
    });
  }
  slot = effortResolution.slot;
  const safePromptPrefix = !useDanger && typeof entry.oneshot_safe_prompt_prefix === 'string'
    ? entry.oneshot_safe_prompt_prefix.trim() : '';
  if (safePromptPrefix.length > 4096) {
    return rejectBeforeAdmission(400, 'configuration', {
      error: 'oneshot_safe_prompt_prefix exceeds the 4096-character safety limit',
    });
  }
  const hasInlinePrompt = slot.some((a) => typeof a === 'string' && a.includes('{prompt}'));
  const hasPromptFile = slot.some((a) => typeof a === 'string' && a.includes('{prompt_file}'));
  if (hasInlinePrompt && hasPromptFile) {
    return rejectBeforeAdmission(400, 'configuration', { error: 'oneshot config cannot mix {prompt} and {prompt_file}' });
  }
  let resolvedCwd;
  let resolvedCwdIdentity;
  const expectedCwdIdentityHash = body?.expectedCwdIdentityHash;
  const expectedCwdPolicyId = body?.expectedCwdPolicyId;
  if ((expectedCwdIdentityHash !== undefined
      && !/^[0-9a-f]{64}$/.test(String(expectedCwdIdentityHash)))
    || (expectedCwdPolicyId !== undefined
      && !/^[0-9a-f]{64}$/.test(String(expectedCwdPolicyId)))) {
    return rejectBeforeAdmission(400, 'validation', {
      error: 'Expected cwd identity fields must be lowercase SHA-256 identifiers.',
    });
  }
  try {
    resolvedCwdIdentity = captureAllowedCwdIdentity(cwd);
    resolvedCwd = resolvedCwdIdentity.resolved;
    if ((expectedCwdPolicyId && expectedCwdPolicyId !== CWD_POLICY_IDENTITY)
      || (expectedCwdIdentityHash
        && expectedCwdIdentityHash !== resolvedCwdIdentity.cwdIdentityHash)) {
      throw cwdIdentityChangedError(
        expectedCwdIdentityHash || resolvedCwdIdentity.cwdIdentityHash,
        resolvedCwdIdentity.cwdIdentityHash,
      );
    }
  } catch (err) {
    return rejectBeforeAdmission(400, 'validation', {
      error: err.validation?.reason || err.message,
      errorCode: err.code || null,
      validation: err.validation || null,
    });
  }
  // Account selection is part of admission, not spawn setup. If every linked
  // account is disabled, unsigned, or cooling, an empty env would silently run
  // against the operator's default credentials and misattribute the receipt.
  const dispatchAccount = resolveDispatchAccount(kind, entry, {
    unavailableAccountIds: defaultAccountSignedOut
      ? new Set([providerAccounts.DEFAULT_ACCOUNT_ID]) : new Set(),
  });
  if (dispatchAccount.exhausted) {
    if (defaultAccountSignedOut && !dispatchAccount.resolutionError
      && !dispatchAccount.providerManaged) {
      return rejectBeforeAdmission(409, 'auth', {
        ok: false,
        auth_required: true,
        kind,
        label: entry.label || kind,
        login_command: entry.login_command,
        detail: readiness.detail || 'the provider CLI reports no active session',
        error: `${entry.label || kind} is installed but not signed in`,
        dropped_out: true,
      });
    }
    const registryInvalid = dispatchAccount.reason === 'registry_invalid';
    const vendorExhausted = dispatchAccount.reason === 'vendor_exhausted';
    const relocationMissing = dispatchAccount.reason === 'credential_relocation_unavailable';
    const isolationUnsupported = dispatchAccount.reason === 'linked_account_isolation_unsupported';
    const failureClass = registryInvalid ? 'account_registry_invalid'
      : relocationMissing || isolationUnsupported ? 'account_configuration_invalid'
        : vendorExhausted ? 'vendor_quota_exhausted' : 'account_unavailable';
    return rejectBeforeAdmission(registryInvalid || relocationMissing ? 500 : 409, failureClass, {
      ok: false,
      account_unavailable: !vendorExhausted,
      vendor_quota_exhausted: vendorExhausted,
      kind,
      error: registryInvalid
        ? 'The linked-account registry is invalid; dispatch is disabled to protect credential attribution'
        : relocationMissing
          ? `Managed linked accounts for ${entry.label || kind} cannot be isolated because credential_env is missing or invalid`
        : isolationUnsupported
          ? `Linked accounts are disabled for ${entry.label || kind} because its authentication cannot be isolated safely`
        : vendorExhausted
          ? `Every available account for ${entry.label || kind} has authoritative exhausted-quota evidence`
          : `No enabled and provisioned account is available for ${entry.label || kind}`,
      remedy: registryInvalid
        ? 'Repair the account registry shown by /api/accounts before retrying.'
        : relocationMissing
          ? 'Restore this provider\'s credential_env configuration before dispatching any managed linked account.'
        : isolationUnsupported
          ? (entry.linked_accounts_unavailable_reason || 'Use this provider\'s implicit default account only.')
        : vendorExhausted
          ? 'Use another provider or wait until the reported vendor reset.'
          : 'Check /api/accounts, then sign in or enable an account.',
      retryAt: dispatchAccount.retryAt || null,
      dropped_out: true,
      usage: { input_tokens: 0, output_tokens: 0 },
    }, {
      provider: kind,
      account: null,
      quota_seat: null,
      request_id: requestId,
    });
  }
  if (dispatchAccount.account && !dispatchAccount.account.implicit) {
    try {
      slot = [...slot, ...providerAccounts.linkedAccountArgsFor(entry)];
    } catch (err) {
      return rejectBeforeAdmission(500, 'account_configuration_invalid', {
        error: `invalid linked-account arguments for ${kind}: ${err.message}`,
        model_invocation: false,
        dropped_out: true,
      });
    }
  }
  if (!acquireOneShot(kind, res)) {
    return rejectBeforeAdmission(429, 'admission_limit', {
      error: 'provider concurrency limit reached; retry with backoff',
      kind,
      retryable: true,
      failureClass: 'admission_limit',
      activeOneShotCount,
      maxActiveOneShots: MAX_ACTIVE_ONESHOTS,
    });
  }
  let promptFileDir = null;
  let isolatedProviderHome = null;
  if (!useDanger && filesystemPolicy === 'isolated_home') {
    try {
      isolatedProviderHome = createIsolatedProviderHome();
    } catch (err) {
      return rejectBeforeAdmission(500, 'safe_isolation_setup', {
        error: `could not create isolated provider home: ${err.message}`,
        dropped_out: true,
      }, {
        provider: kind, dangerous: false, filesystem_policy: filesystemPolicy,
        read_only_enforced: false, isolated_home: true, isolated_home_cleanup: 'setup_failed', request_id: requestId,
      });
    }
  }
  let promptFile = '';
  let userPromptForProvider = prompt;
  let promptTruncated = false;
  if (hasInlinePrompt) {
    // Preserve the established user-prompt allowance. The policy prefix is a
    // separate bounded transport envelope, not text that silently consumes
    // the tail of a request which previously fit prompt_max_chars.
    const capped = capPrompt(prompt, Number(entry.prompt_max_chars || 6000));
    userPromptForProvider = capped.text;
    promptTruncated = capped.truncated;
  }
  const effectivePrompt = safePromptPrefix
    ? `${safePromptPrefix}\n\nUser request:\n${userPromptForProvider}` : userPromptForProvider;
  const promptForArgs = effectivePrompt;
  if (hasPromptFile) {
    try {
      promptFileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'RelayBridge-prompt-'));
      promptFile = path.join(promptFileDir, 'prompt.txt');
      fs.writeFileSync(promptFile, effectivePrompt, 'utf8');
    } catch (err) {
      const isolationCleanup = isolatedProviderHome
        ? cleanupIsolatedProviderHome(isolatedProviderHome)
        : { status: 'not_applicable', detail: '' };
      isolatedProviderHome = null;
      return rejectBeforeAdmission(500, isolationCleanup.status === 'failed_preserved' ? 'isolation_cleanup' : 'configuration', {
        error: 'could not create temporary prompt file: ' + err.message,
      }, {
        provider: kind, dangerous: false, filesystem_policy: filesystemPolicy,
        read_only_enforced: false, isolated_home: true,
        isolated_home_cleanup: isolationCleanup.status,
        isolated_home_cleanup_detail: isolationCleanup.detail || null,
        request_id: requestId,
      });
    }
  }
  const slotResolved = slot.map((arg) => {
    if (typeof arg !== 'string') return arg;
    return arg
      .replace('{prompt_file}', promptFile)
      .replace('{prompt}', promptForArgs)
      .replace('{cwd}', resolvedCwd);
  });
  const promptTransport = hasPromptFile ? 'file' : (hasInlinePrompt ? 'argument' : 'stdin');
  const cleanupPromptFile = () => {
    if (!promptFileDir) return;
    try { fs.rmSync(promptFileDir, { recursive: true, force: true }); } catch {}
    promptFileDir = null;
  };
  const [bin, ...args] = slotResolved;
  // Multi-account: point the CLI's credential directory at the selected
  // account before anything resolves the binary or builds the route metadata.
  const childEnv = buildEnv(
    { ...oneShotEnv, ...(isolatedProviderHome?.env || {}) },
    entry.strip_env || [],
  );
  // Applied AFTER buildEnv, never through it. strip_env is applied last inside
  // buildEnv, so a seat that ever listed its own credential variable there
  // would have it silently removed — and the run would then execute against
  // whichever account the operator's own config directory holds. Running work
  // on the wrong plan is worse than failing, so this assignment is not
  // strippable.
  Object.assign(childEnv, dispatchAccount.env);
  const resolvedBin = resolveExecutable(bin, childEnv);
  const flagValue = (name) => {
    const index = args.indexOf(name);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
  };
  const modelFlagSent = ['--model', '-m', '--model-id', '--llm', '--model-name']
    .find((flag) => args.includes(flag)) || null;
  // Return non-secret route metadata with every one-shot response.  This lets
  // committee callers prove which model/effort was requested instead of
  // guessing from a generic "Claude" label.
  const route = {
    provider: kind,
    // Which of the provider's accounts paid for this run. Null for a seat with
    // a single sign-in, so existing receipts are unchanged. It rides on the
    // route because that is what reaches both the receipt and the ledger.
    account: dispatchAccount.account && !dispatchAccount.account.implicit
      ? dispatchAccount.account.id : null,
    quota_seat: dispatchAccount.quotaSeat || null,
    transport: entry.transport || 'cli',
    configured_binary: bin,
    resolved_binary: resolvedBin,
    task_tier: typeof body?.taskTier === 'string' ? body.taskTier : null,
    requested_model_tier: typeof body?.modelTier === 'string' ? body.modelTier : null,
    model_tier: modelChoice.modelTier,
    requested_model: (modelFlagSent ? flagValue(modelFlagSent) : null) || entry.model || null,
    model_flag_sent: modelFlagSent,
    resolved_model_identity: entry.model
      ? `${entry.model}${ollamaManifestIdentity(entry) ? `@${ollamaManifestIdentity(entry)}` : ''}`
      : null,
    requested_effort: requestedEffort,
    target_effort: effectiveEffort,
    applied_effort: effortResolution.appliedEffort,
    effort_explicit: !!requestedEffort,
    effort_source: requestedEffort ? 'request' : (tierEffort ? 'task_tier' : 'provider_default'),
    max_effort_override: EXTREME_EFFORTS.has(requestedEffort) && body?.maxEffortOverride === true,
    effort_method: effortResolution.method,
    effort_control: effortResolution.control,
    effort_fallback_reason: effortFallbackReason,
    suppressed_cli_flags: (modelChoice.suppressArgs || []).map((spec) => spec.flag),
    dangerous: useDanger,
    filesystem_policy: filesystemPolicy,
    read_only_enforced: !useDanger && filesystemPolicy === 'read_only_enforced',
    isolated_home: filesystemPolicy === 'isolated_home',
    isolated_home_id: isolatedProviderHome?.id || null,
    isolated_home_cleanup: isolatedProviderHome ? 'pending' : 'not_applicable',
    prompt_transport: promptTransport,
    prompt_truncated: promptTruncated,
    prompt_policy: safePromptPrefix
      ? (entry.oneshot_safe_prompt_policy || 'configured_safe_prompt_prefix') : null,
    prompt_policy_chars: safePromptPrefix.length,
    transport_prompt_chars: effectivePrompt.length,
    requested_timeout_ms: Number.isFinite(Number(timeoutMs)) ? Math.trunc(Number(timeoutMs)) : null,
    // With no explicit timeout the CLI path is governed by supervision, so the
    // effective ceiling is resolved after the supervisor is constructed below;
    // this records the caller-facing view.
    effective_timeout_ms: explicitTimeout,
    timeout_clamped: explicitTimeout != null && Math.trunc(Number(timeoutMs)) !== explicitTimeout,
    environment_overrides: Object.keys({ ...oneShotEnv, ...(isolatedProviderHome?.env || {}) }).sort(),
    request_id: requestId,
    invocation_id: invocationId,
    attempt_id: attemptId,
    outer_receipt_id: outerReceiptId,
    client_surface: body?._relayClient || null,
    client_deadline_at: body?._relayClientDeadlineAt !== null
      && body?._relayClientDeadlineAt !== ''
      && Number.isFinite(Number(body._relayClientDeadlineAt))
      ? Number(body._relayClientDeadlineAt) : null,
    grounding_override: body?._groundingOverridden === true || null,
    grounding_note: body?._groundingOverridden ? body._groundingOverrideReason : null,
  };
  const cleanupProviderHome = () => {
    if (!isolatedProviderHome || route.isolated_home_cleanup !== 'pending') {
      return { ok: true, status: route.isolated_home_cleanup };
    }
    const result = cleanupIsolatedProviderHome(isolatedProviderHome);
    route.isolated_home_cleanup = result.status;
    route.isolated_home_cleanup_detail = result.detail || null;
    isolatedProviderHome = null;
    return result;
  };
  const persistCancellationReceipt = () => {
    if (res._relayReceiptPersisted) return;
    const payload = typeof res._relayCancellationPayload === 'function'
      ? res._relayCancellationPayload()
      : {
          kind,
          route,
          exitCode: -1,
          stdout: '',
          stderr: '',
          failureClass: disconnectFailureClass({
            client: route.client_surface, deadlineAt: route.client_deadline_at,
          }),
          stop_reason: disconnectFailureClass({
            client: route.client_surface, deadlineAt: route.client_deadline_at,
          }),
          cancelled: true,
          timed_out: false,
          dropped_out: true,
          model_invocation: true,
        };
    try {
      const receipt = appendBridgeProviderReceipt({ kind, prompt, route, payload, startedAt });
      res._relayReceiptPersisted = receipt.receiptId;
    } catch (error) {
      res._relayReceiptPersisted = `rcpt_unpersisted_${Date.now().toString(36)}`;
      console.error(`[RelayBridge] cancellation receipt persistence failed: ${error.message}`);
    }
  };
  // Persist a terminal cancellation even when the HTTP client is already
  // gone. Previously the provider was killed but its token/time attempt
  // disappeared because sendOneShotResult refuses to write to a dead socket.
  // An isolated home cannot be cleaned while its provider is still alive: the
  // process could recreate state after deletion. Defer that receipt until the
  // child close/error path has confirmed termination and terminal cleanup.
  res.once('close', () => {
    if (res.writableEnded || res._relayReceiptPersisted) return;
    if (route.isolated_home_cleanup === 'pending') {
      res._relayIsolationReceiptDeferred = true;
      return;
    }
    persistCancellationReceipt();
  });
  const resolvedProviderBudget = resolveSupervisorOptions({
    entry,
    globals: cfg._supervisor || {},
    providerBudget: requestedProviderBudget,
    taskTier: typeof body?.budgetTaskTier === 'string'
      ? body.budgetTaskTier
      : (typeof body?.taskTier === 'string' ? body.taskTier : null),
  }).providerBudget;
  if (entry.oneshot_adapter === 'ollama_api') {
    cleanupPromptFile();
    return runOllamaApiOneShot({
      entry, prompt, timeoutMs: adapterTimeoutMs, res, route, startedAt,
      providerBudget: resolvedProviderBudget,
      accountId: dispatchAccount.account?.id || null,
    });
  }
  if (entry.oneshot_adapter === 'openai_chat_api') {
    cleanupPromptFile();
    return runOpenAIChatOneShot({
      entry, prompt, timeoutMs: adapterTimeoutMs, res, route, startedAt,
      providerBudget: resolvedProviderBudget,
      accountId: dispatchAccount.account?.id || null,
    });
  }
  const isWindows = process.platform === 'win32';
  let proc;
  try {
    // Re-check both the startup-pinned allowed-root identity and the selected
    // directory immediately before child creation. Node's spawn API has no
    // portable cwd-by-handle primitive, so this is the narrowest available
    // TOCTOU boundary without changing provider execution semantics.
    const spawnCwdIdentity = revalidateAllowedCwdIdentity(resolvedCwdIdentity);
    if (expectedCwdIdentityHash
      && expectedCwdIdentityHash !== spawnCwdIdentity.cwdIdentityHash) {
      throw cwdIdentityChangedError(
        expectedCwdIdentityHash, spawnCwdIdentity.cwdIdentityHash,
      );
    }
    resolvedCwd = spawnCwdIdentity.resolved;
    // Build the actual spawn target. On Windows, wrap non-.exe (npm shims like
    // claude.cmd) with cmd.exe /c so the shim resolves. Use single-string form
    // for cmd.exe so arg quoting is preserved (shell:true would split prompts
    // containing spaces into separate args, breaking gemini -p "my prompt").
    let spawnBin = resolvedBin;
    let spawnArgs = args;
    let spawnOpts = {
      cwd: resolvedCwd,
      env: childEnv,
      windowsHide: true,
      // NOTE: this spawn deliberately does NOT set `detached`, even though
      // killProcessTree's fast path (process.kill(-pid)) needs a process group
      // to exist and therefore always ESRCHes here, falling back to a racy `ps`
      // walk. Adding it is a real fix for that, but it also converts every
      // killProcessTree call on this child from a harmless no-op into a real
      // group kill, and doing so fails the prompt-file transport test with
      // exitCode null (signal death) — the kill paths around a normal run have
      // to be audited before the group can be created. Tracked separately.
    };
    if (isWindows && !/\.exe$/i.test(resolvedBin)) {
      spawnBin = process.env.ComSpec || 'cmd.exe';
      spawnArgs = ['/d', '/s', '/c', [resolvedBin, ...args].map(quoteCmdArg).join(' ')];
      spawnOpts.windowsVerbatimArguments = true;
    }
    proc = trackChild(spawn(spawnBin, spawnArgs, spawnOpts));
    // executeOneShot returns after wiring the child events; the response is
    // delivered by proc.on('close'). Background-task capture must distinguish
    // that intentional deferred response from a handler that forgot to reply.
    res._relayDeferredResponse = true;
  } catch (err) {
    cleanupPromptFile();
    cleanupProviderHome();
    if (err.validation) {
      return rejectBeforeAdmission(400, 'validation', {
        error: err.validation.reason,
        errorCode: err.code || null,
        validation: err.validation,
      });
    }
    return sendOneShotResult(res, { kind, route, exitCode: -1, stdout: '', stderr: err.message, error: 'spawn failed', dropped_out: true, model_invocation: false }, {
      kind, prompt, route, startedAt, cwd: resolvedCwd,
      accountId: dispatchAccount.account?.id || null,
    });
  }
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let clientGone = false;
  let settled = false;
  res._relayCancellationPayload = () => {
    const parsedOutput = parseConfiguredOneShotOutput(entry, stdout);
    const retainedPartial = stopReason === 'token_budget' && !!parsedOutput.parseError
      && !!parsedOutput.partialDiagnostic;
    const cancellationState = resolveCancellationTerminalState({
      stopReason,
      timedOut,
      disconnectClass: disconnectFailureClass({
        client: body?._relayClient, deadlineAt: body?._relayClientDeadlineAt,
      }),
    });
    const progress = supervisor.snapshot();
    return {
      kind,
      route,
      exitCode: -1,
      stdout: parsedOutput.output,
      stderr: cleanOutput([stderr, parsedOutput.diagnostic, parsedOutput.parseError].filter(Boolean).join('\n')),
      usage: parsedOutput.usage,
      failureClass: cancellationState.failureClass,
      result_subtype: parsedOutput.resultSubtype,
      result_schema_disagreement: parsedOutput.resultSchemaDisagreement,
      provider_retries: parsedOutput.retries,
      provider_stop_reason: parsedOutput.providerStopReason,
      provider_terminal_reason: parsedOutput.terminalReason,
      provider_api_error_status: parsedOutput.apiErrorStatus,
      provider_permission_denials: parsedOutput.permissionDenials,
      provider_num_turns: parsedOutput.numTurns,
      provider_duration_ms: parsedOutput.providerDurationMs,
      provider_api_duration_ms: parsedOutput.providerApiDurationMs,
      provider_error_count: parsedOutput.errorCount,
      provider_error_observed: parsedOutput.errorObserved,
      provider_error_invalid: parsedOutput.errorInvalid,
      provider_error_diagnostic_truncated: parsedOutput.errorDiagnosticTruncated,
      provider_error_diagnostic: parsedOutput.diagnostic,
      ...(retainedPartial ? {
        partial_result: true,
        partial_diagnostic: parsedOutput.partialDiagnostic,
        partial_diagnostic_truncated: parsedOutput.partialDiagnosticTruncated === true,
      } : {}),
      ...(stopReason === 'token_budget'
        ? { cleaned_output_unavailable: !parsedOutput.output } : {}),
      transport_output_chars: String(stdout).length,
      transport_output_hash: crypto.createHash('sha256').update(String(stdout)).digest('hex'),
      stop_reason: cancellationState.stopReason,
      supervisor_stop_reason: cancellationState.supervisorStopReason,
      stop_detail: stopReason ? stopDetail : 'the caller disconnected before the provider returned a usable result',
      progress,
      cancelled: cancellationState.cancelled,
      timed_out: cancellationState.timedOut,
      dropped_out: true,
      model_invocation: true,
    };
  };

  // Progress-based supervision instead of a single kill clock. A run that keeps
  // emitting new content is left alone to finish; one that goes silent or
  // starts repeating itself is stopped early with a reason, so tokens are not
  // spent on a wedged or looping stage. See lib/run-supervisor.js.
  const supervisor = new RunSupervisor(resolveSupervisorOptions({
    entry,
    globals: cfg._supervisor || {},
    providerBudget: resolvedProviderBudget,
    hardCapMs: explicitTimeout,
    startedAt,
  }));
  const runId = `run_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  activeRuns.set(runId, { runId, kind, route, startedAt, supervisor, pid: proc.pid });
  let stopReason = null;
  let stopDetail = '';
  let stopBudgetEnforcement = null;
  let sampling = false;
  const usageObserver = createProviderUsageObserver(entry.oneshot_output_parser, supervisor);

  const finishSupervision = () => {
    clearInterval(tick);
    activeRuns.delete(runId);
  };
  const tick = setInterval(() => {
    if (settled) return finishSupervision();
    const applyVerdict = () => {
      const verdict = supervisor.evaluate();
      if (verdict.action !== 'kill') return;
      stopReason = verdict.reason;
      stopDetail = verdict.detail;
      if (verdict.reason === 'token_budget') stopBudgetEnforcement = supervisor.snapshot().providerUsagePhase;
      timedOut = verdict.reason !== 'token_budget';
      killProcessTree(proc);
    };
    // CPU is only sampled once a run has gone quiet, so healthy runs never pay
    // for the probe. It is what distinguishes a model thinking in silence from
    // a process that is genuinely wedged.
    if (!sampling && supervisor.needsCpuSample()) {
      sampling = true;
      sampleTreeCpuMs(proc.pid)
        .then((cpuMs) => { supervisor.recordCpuSample(cpuMs); })
        .catch(() => { supervisor.recordCpuSample(null); })
        .finally(() => { sampling = false; if (!settled) applyVerdict(); });
      return;
    }
    applyVerdict();
  }, 5000);
  if (typeof tick.unref === 'function') tick.unref();


  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      finishSupervision();
      killProcessTree(proc);
      cleanupPromptFile();
    }
  });
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  // recordOutput returns false once the output cap is reached, which stops the
  // buffer growing before the kill lands â€” a runaway CLI cannot OOM the bridge.
  proc.stdout.on('data', (d) => {
    usageObserver.record(d);
    if (supervisor.recordOutput(d)) stdout += d;
    const verdict = supervisor.evaluate();
    if (verdict.action === 'kill' && !stopReason) {
      stopReason = verdict.reason;
      stopDetail = verdict.detail;
      if (verdict.reason === 'token_budget') stopBudgetEnforcement = supervisor.snapshot().providerUsagePhase;
      timedOut = verdict.reason !== 'token_budget';
      killProcessTree(proc);
    }
  });
  proc.stderr.on('data', (d) => { if (supervisor.recordOutput(d)) stderr += d; });
  proc.on('error', (err) => {
    if (settled) return;
    settled = true;
    finishSupervision();
    cleanupPromptFile();
    const isolationCleanup = cleanupProviderHome();
    if (clientGone || res.writableEnded) {
      if (res._relayIsolationReceiptDeferred) persistCancellationReceipt();
      return;
    }
    sendOneShotResult(res, { kind, route, exitCode: -1, stdout, stderr: stderr + '\n' + err.message, error: err.message, failureClass: isolationCleanup.ok ? null : 'isolation_cleanup', dropped_out: true }, {
      kind, prompt, route, startedAt, cwd: resolvedCwd,
      accountId: dispatchAccount.account?.id || null,
    });
  });
  const settleFromClose = (code) => {
    if (settled) return;
    settled = true;
    finishSupervision();
    cleanupPromptFile();
    const isolationCleanup = cleanupProviderHome();
    if (clientGone || res.writableEnded) {
      if (res._relayIsolationReceiptDeferred) persistCancellationReceipt();
      return;
    }
    usageObserver.flush();
    const parsedOutput = parseConfiguredOneShotOutput(entry, stdout);
    if (parsedOutput.usage || parsedOutput.numTurns !== null) {
      supervisor.recordProviderUsage({ ...(parsedOutput.usage || {}), turns: parsedOutput.numTurns }, { phase: 'terminal' });
      const terminalVerdict = supervisor.evaluate();
      if (terminalVerdict.action === 'kill' && !stopReason) {
        stopReason = terminalVerdict.reason;
        stopDetail = terminalVerdict.detail;
        if (terminalVerdict.reason === 'token_budget') stopBudgetEnforcement = 'terminal';
      }
    }
    const supervisedUsage = supervisor.snapshot().providerUsage;
    const authoritativeUsage = parsedOutput.usage || (supervisedUsage ? {
      input_tokens: supervisedUsage.input_tokens ?? 0,
      output_tokens: supervisedUsage.output_tokens ?? 0,
      cache_read_input_tokens: supervisedUsage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: supervisedUsage.cache_creation_input_tokens ?? 0,
      total_tokens: supervisedUsage.total_tokens ?? null,
      token_source: 'provider_reported',
      model_usage: [],
    } : null);
    const cleanedStdout = parsedOutput.output;
    if (Array.isArray(parsedOutput.usage?.model_usage) && parsedOutput.usage.model_usage.length) {
      const dominant = [...parsedOutput.usage.model_usage].sort((left, right) =>
        Number(right.cost_usd || 0) - Number(left.cost_usd || 0)
        || (Number(right.output_tokens || 0) + Number(right.input_tokens || 0)
          + Number(right.cache_read_input_tokens || 0) + Number(right.cache_creation_input_tokens || 0))
          - (Number(left.output_tokens || 0) + Number(left.input_tokens || 0)
            + Number(left.cache_read_input_tokens || 0) + Number(left.cache_creation_input_tokens || 0))
      )[0];
      if (dominant?.model) {
        route.resolved_model_identity = dominant.model;
        route.resolved_model_source = 'provider_reported_model_usage';
      }
    }
    // Treat model prose on stdout as content when the provider exited zero and
    // returned a usable answer. Failure phrases are authoritative on stderr,
    // or in stdout only when the process itself failed / returned no answer.
    // This prevents an audit discussing "rate limit" or HTTP 429 handling from
    // being misclassified as a provider failure.
    const failureBlob = (stderr + ((code !== 0 || !cleanedStdout || parsedOutput.isError || parsedOutput.parseError)
      ? ('\n' + stdout) : '') + ('\n' + (parsedOutput.diagnostic || ''))).toLowerCase();
    const rate_signals = [
      'rate limit', 'rate-limit', 'too many requests', 'quota exceeded', 'usage limit reached',
      'hit your usage limit', 'hit your limit', "you've hit your session limit",
      "you've hit your weekly limit", 'server is temporarily limiting requests',
      'upgrade to pro', '429', 'credit balance is too low', 'usage limit', 'out of credits',
    ];
    const budget_signals = ['exceeded usd budget','exceeded the usd budget','max-budget-usd','budget exceeded','budget cap reached'];
    const authoritativeApiFailure = claudeApiStatusFailureClass(
      parsedOutput.apiErrorStatus,
      cleanOutput([stderr, parsedOutput.diagnostic].filter(Boolean).join('\n')),
    );
    const copilotQuotaEvidence = detectCopilotMonthlyQuota({
      provider: kind,
      stdout: cleanedStdout,
      stderr,
      exitCode: code,
    });
    const runClassification = classifyRunFailure({
      provider: kind,
      prompt,
      stdout: cleanedStdout,
      stderr: cleanOutput([stderr, parsedOutput.diagnostic].filter(Boolean).join('\n')),
      exitCode: code,
      modelFlagSent: !!route.model_flag_sent,
    });
    const cursorActionRequired = runClassification.actionRequired || null;
    const cursorUsageQuotaExhausted = cursorActionRequired?.kind === 'usage_quota_exhausted';
    const rate_limited = parsedOutput.resultSubtype !== 'error_max_budget_usd'
      && !cursorUsageQuotaExhausted
      && (authoritativeApiFailure === 'rate_limit' || !!copilotQuotaEvidence
        || rate_signals.some(s => failureBlob.includes(s)));
    const budget_exceeded = parsedOutput.resultSubtype === 'error_max_budget_usd'
      || authoritativeApiFailure === 'budget'
      || cursorUsageQuotaExhausted
      || budget_signals.some(s => failureBlob.includes(s));
    // Some CLIs report unrelated MCP authentication warnings on stderr even
    // after the selected provider completed successfully. Only classify the
    // provider route as unauthenticated when the command failed or produced no
    // usable answer.
    const auth_failed = authoritativeApiFailure === 'auth'
      || ((code !== 0 || !cleanedStdout || parsedOutput.isError)
        && runClassification.kind === 'auth_failed');
    const permission_denied = authoritativeApiFailure === 'permission'
      || runClassification.kind === 'headless_command_permission_auto_denied';
    // Provider CLIs can enforce their own request deadline before RelayBridge's
    // progress supervisor fires. Promote only authoritative failed/no-answer
    // diagnostics; healthy model prose that discusses timeouts must remain a
    // successful response.
    const providerInternalTimedOut = (code !== 0 || !cleanedStdout || parsedOutput.isError)
      && hasProviderInternalTimeoutDiagnostic(failureBlob);
    const providerTimedOut = timedOut || authoritativeApiFailure === 'timeout' || providerInternalTimedOut;
    const tokenBudgetExceeded = stopReason === 'token_budget';
    const retainedPartial = tokenBudgetExceeded && !!parsedOutput.parseError
      && !!parsedOutput.partialDiagnostic;
    const finalFailureClass = !isolationCleanup.ok ? 'isolation_cleanup'
      : tokenBudgetExceeded ? 'token_budget'
      : parsedOutput.resultSubtype === 'error_max_budget_usd' ? 'budget'
      : cursorUsageQuotaExhausted ? 'budget'
      : runClassification.kind === 'plan_restriction' ? 'plan_restriction'
      : authoritativeApiFailure || (rate_limited ? 'rate_limit'
        : budget_exceeded ? 'budget'
          : auth_failed ? 'auth'
            : providerTimedOut ? 'timeout'
              : permission_denied ? 'policy'
                : parsedOutput.failureClass || (code !== 0 ? runClassification.kind : null));
    const dropped_out = !isolationCleanup.ok || tokenBudgetExceeded || providerTimedOut || code !== 0 || permission_denied || rate_limited || budget_exceeded
      || auth_failed || parsedOutput.isError || !!parsedOutput.failureClass
      || !!parsedOutput.parseError || !cleanedStdout;
    const sentPayload = sendOneShotResult(res, {
      kind,
      route,
      exitCode: code,
      stdout: cleanedStdout,
      stderr: cleanOutput([stderr, parsedOutput.diagnostic, parsedOutput.parseError].filter(Boolean).join('\n')),
      usage: authoritativeUsage,
      failureClass: finalFailureClass,
      result_subtype: parsedOutput.resultSubtype,
      result_schema_disagreement: parsedOutput.resultSchemaDisagreement,
      provider_retries: parsedOutput.retries,
      provider_stop_reason: parsedOutput.providerStopReason,
      provider_terminal_reason: parsedOutput.terminalReason,
      provider_api_error_status: parsedOutput.apiErrorStatus,
      provider_permission_denials: parsedOutput.permissionDenials,
      provider_num_turns: parsedOutput.numTurns ?? supervisedUsage?.turns ?? null,
      provider_duration_ms: parsedOutput.providerDurationMs,
      provider_api_duration_ms: parsedOutput.providerApiDurationMs,
      provider_error_count: parsedOutput.errorCount,
      provider_error_observed: parsedOutput.errorObserved,
      provider_error_invalid: parsedOutput.errorInvalid,
      provider_error_diagnostic_truncated: parsedOutput.errorDiagnosticTruncated,
      provider_error_diagnostic: parsedOutput.diagnostic,
      ...(retainedPartial ? {
        partial_result: true,
        partial_diagnostic: parsedOutput.partialDiagnostic,
        partial_diagnostic_truncated: parsedOutput.partialDiagnosticTruncated === true,
      } : {}),
      ...(tokenBudgetExceeded ? { cleaned_output_unavailable: !cleanedStdout } : {}),
      quota_evidence: copilotQuotaEvidence,
      provider_action_required: cursorActionRequired,
      transport_output_chars: String(stdout).length,
      transport_output_hash: crypto.createHash('sha256').update(String(stdout)).digest('hex'),
      rate_limited,
      budget_exceeded,
      auth_failed,
      permission_denied,
      policy_reason: permission_denied ? runClassification.kind : null,
      policy_detail: permission_denied ? runClassification.detail : null,
      model: modelChoice.model,
      model_tier: modelChoice.modelTier,
      stop_reason: stopReason || (providerInternalTimedOut ? 'provider_internal_timeout' : null),
      supervisor_stop_reason: stopReason,
      provider_timeout_source: timedOut ? 'relay_supervisor'
        : authoritativeApiFailure === 'timeout' ? 'provider_api_status'
          : providerInternalTimedOut ? 'provider_cli_diagnostic' : null,
      stop_detail: stopDetail || ((permission_denied || code !== 0) ? runClassification.detail : ''),
      provider_budget: supervisor.snapshot().providerBudget,
      provider_budget_enforcement: tokenBudgetExceeded ? stopBudgetEnforcement
        : (supervisor.snapshot().providerUsagePhase === 'unavailable' ? 'unavailable' : supervisor.snapshot().providerUsagePhase),
      progress: supervisor.snapshot(),
      timed_out: providerTimedOut,
      dropped_out,
      model_invocation: true,
    }, {
      kind, prompt, route, startedAt, cwd: resolvedCwd, transportStdout: stdout,
      accountId: dispatchAccount.account?.id || null,
    });
    // GitHub middleware: only successful runs checkpoint — a dropped-out run
    // may have left half-applied edits, which the human should triage first.
    if (sentPayload && !sentPayload.dropped_out) {
      trackRunAfterResponse({ runId, kind, user: runUser, prompt, cwd: resolvedCwd, intent: runIntent });
    }
  };
  proc.on('close', settleFromClose);
  // 'close' waits for every inherited stdio pipe to reach EOF, so a CLI that
  // leaves an MCP server or node shim holding stdout exits without ever firing
  // it: nothing settles, the admission slot stays taken, and the request hangs
  // until the client gives up. 'exit' is the child's own death, so settle from
  // a grace window after it — the same guarantee runProbe arms after a kill
  // ("killing the tree is not a guarantee of an exit event"). A normal run's
  // 'close' lands within microseconds of 'exit' and wins the `settled` race, so
  // this only fires when a survivor is holding the pipe open.
  proc.on('exit', (code) => {
    const graceful = setTimeout(() => settleFromClose(code === null ? -1 : code), ONESHOT_CLOSE_GRACE_MS);
    if (typeof graceful.unref === 'function') graceful.unref();
  });
  // Providers without a placeholder (Claude/Codex/Perplexity wrapper) read
  // stdin. Antigravity consumes {prompt}; Grok consumes {prompt_file}.
  if (promptTransport === 'stdin') {
    try { proc.stdin.write(effectivePrompt); proc.stdin.end(); } catch {}
  } else {
    try { proc.stdin.end(); } catch {}
  }
}

app.post('/api/oneshot', (req, res) => executeOneShot({
  ...req.body,
  _relayClient: req.get('X-RelayBridge-Client') || null,
  _relayClientDeadlineAt: req.get('X-RelayBridge-Client-Deadline-At') || null,
}, res));

// ---- Async task queue (lib/task-queue.js) --------------------------------
// Submission is decoupled from collection so work outlives the surface that
// started it: submit from a chat, collect from Cowork or the CLI later.
const { createTaskQueue } = require('./lib/task-queue');
const taskQueue = createTaskQueue({
  dataDir: path.join(DATA_DIR, 'tasks'),
  executeOneShot, readCollab, writeCollab,
  maxConcurrent: Number(process.env.RELAYBRIDGE_MAX_TASKS) || 3,
  log: (m) => console.log(m),
});

app.post('/api/tasks', async (req, res) => {
  try {
    const input = req.body || {};
    const providerBudget = validateProviderBudget(input.providerBudget);
    const { classifyTask } = await import('./mcp/router.mjs');
    const classifiedTaskTier = typeof input.prompt === 'string'
      ? classifyTask(input.prompt).tier : undefined;
    const taskTier = typeof input.taskTier === 'string' ? input.taskTier : classifiedTaskTier;
    const modelTier = typeof input.modelTier === 'string'
      ? input.modelTier : modelTierForTaskTier(taskTier);
    const budgetTaskTier = typeof input.budgetTaskTier === 'string'
      ? input.budgetTaskTier
      : taskTier;
    res.json(taskQueue.submit({ ...input, providerBudget, budgetTaskTier, taskTier, modelTier }));
  }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.get('/api/tasks', (req, res) => {
  try { res.json({ tasks: taskQueue.list({ collab: req.query.collab, status: req.query.status, limit: req.query.limit }), stats: taskQueue.stats() }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.get('/api/tasks/:id', (req, res) => {
  try {
    const task = taskQueue.get(req.params.id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    res.json(task);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/tasks/:id/cancel', (req, res) => {
  try { res.json(taskQueue.cancel(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Codex -> Claude staged workflows -----------------------------------
// The controller owns phase dispatch; the pipeline owns durable artifacts and
// the single canonical-workspace writer lease.  Provider tasks stay in the
// existing queue so they survive client disconnects and retain normal receipt,
// quota, timeout, and filesystem-policy handling.
const workflowPipeline = createWorkflowPipeline({ dataDir: DATA_DIR });
const workflowController = createWorkflowController({
  pipeline: workflowPipeline,
  taskQueue,
  loadConfig,
  log: (message) => console.log(message),
});

const WORKFLOW_NOT_FOUND_CODES = new Set(['WORKFLOW_NOT_FOUND', 'NOT_FOUND']);
const WORKFLOW_CONFLICT_CODES = new Set([
  'WORKFLOW_EXISTS', 'WORKFLOW_TERMINAL', 'INVALID_TRANSITION',
  'WRITER_CONFLICT', 'WRITER_TASK_RUNNING', 'LEASE_MISMATCH', 'LEASE_MISSING',
  'LEASE_EXPIRED', 'LEASE_NOT_REQUIRED', 'REVISION_NOT_REQUESTED',
  'REVISION_REQUIRED', 'PROVIDER_TASK_ACTIVE', 'PROVIDER_TASK_MISMATCH',
  'PROVIDER_TASK_REUSED', 'PROVIDER_RETRY_MISMATCH', 'PROVIDER_RETRY_EXHAUSTED',
  'PROVIDER_RETRY_NOT_ALLOWED', 'FULL_PERMISSION_REQUIRED',
]);

function sendWorkflowError(res, error) {
  const code = typeof error?.code === 'string' ? error.code : 'WORKFLOW_ERROR';
  const status = WORKFLOW_NOT_FOUND_CODES.has(code) ? 404
    : WORKFLOW_CONFLICT_CODES.has(code) ? 409
      : code === 'PROVIDER_UNAVAILABLE' ? 503
        : code.startsWith('INVALID_') || code === 'PATH_ESCAPE' ? 400 : 500;
  return res.status(status).json({
    ok: false,
    code,
    error: status === 500 ? 'workflow operation failed' : error.message,
    ...(status !== 500 && error?.details ? { details: error.details } : {}),
  });
}

function workflowCreationInput(body) {
  const permissionMode = body.permissionMode == null ? 'safe' : body.permissionMode;
  const acknowledged = body.acknowledgeFilesystemWrites === true;
  if (permissionMode === 'full' && !acknowledged) {
    const error = new Error('permissionMode=full requires acknowledgeFilesystemWrites=true');
    error.code = 'INVALID_ARGUMENT';
    throw error;
  }
  if (permissionMode !== 'full' && acknowledged) {
    const error = new Error('acknowledgeFilesystemWrites is valid only with permissionMode=full');
    error.code = 'INVALID_ARGUMENT';
    throw error;
  }
  return {
    ...body,
    cwd: resolveAllowedCwd(body.cwd),
    permissionMode,
  };
}

app.post('/api/workflows', (req, res) => {
  try {
    const workflow = workflowController.create(workflowCreationInput(req.body || {}));
    res.status(201).json({ workflow, nextActions: workflowController.nextActions(workflow) });
  } catch (error) { sendWorkflowError(res, error); }
});

app.get('/api/workflows', (req, res) => {
  try {
    const limit = req.query.limit == null ? 50 : Number(req.query.limit);
    res.json({ workflows: workflowController.list({ phase: req.query.phase || undefined, limit }) });
  } catch (error) { sendWorkflowError(res, error); }
});

app.get('/api/workflows/:runId', (req, res) => {
  try {
    res.json(workflowController.view(req.params.runId, {
      includeArtifacts: req.query.includeArtifacts !== 'false',
    }));
  } catch (error) { sendWorkflowError(res, error); }
});

app.post('/api/workflows/:runId/reconcile', (req, res) => {
  try {
    res.status(202).json(workflowController.reconcile(req.params.runId, {
      includeArtifacts: req.body?.includeArtifacts !== false,
    }));
  } catch (error) { sendWorkflowError(res, error); }
});

app.post('/api/workflows/:runId/research', (req, res) => {
  try { res.status(202).json(workflowController.submitResearch(req.params.runId, req.body || {})); }
  catch (error) { sendWorkflowError(res, error); }
});

app.post('/api/workflows/:runId/implementation/claim', (req, res) => {
  try { res.json(workflowController.startImplementation(req.params.runId, req.body || {})); }
  catch (error) { sendWorkflowError(res, error); }
});

app.post('/api/workflows/:runId/implementation/complete', (req, res) => {
  try { res.status(202).json(workflowController.completeImplementation(req.params.runId, req.body || {})); }
  catch (error) { sendWorkflowError(res, error); }
});

app.post('/api/workflows/:runId/revision/start', (req, res) => {
  try { res.status(202).json(workflowController.startRevision(req.params.runId, req.body || {})); }
  catch (error) { sendWorkflowError(res, error); }
});

app.post('/api/workflows/:runId/final-review/start', (req, res) => {
  try { res.status(202).json(workflowController.startFinalReview(req.params.runId)); }
  catch (error) { sendWorkflowError(res, error); }
});

app.post('/api/workflows/:runId/provider/retry', (req, res) => {
  try {
    res.status(202).json(workflowController.retryFailedProvider(req.params.runId, {
      actor: req.body?.actor || 'operator',
    }));
  } catch (error) { sendWorkflowError(res, error); }
});

app.post('/api/workflows/:runId/lease/renew', (req, res) => {
  try { res.json(workflowController.renewWriterLease(req.params.runId, req.body || {})); }
  catch (error) { sendWorkflowError(res, error); }
});

app.post('/api/workflows/:runId/cancel', (req, res) => {
  try { res.json(workflowController.cancel(req.params.runId, req.body || {})); }
  catch (error) { sendWorkflowError(res, error); }
});

// ---- Usage ledger + fuel gauge (lib/usage-ledger.js) ---------------------
// Records every run's tokens, duration and shadow cost so the fleet drains
// evenly and "what would this cost on metered pricing" is answerable while on
// subscription plans.
const { createCooldownStore, parseRetryAfter } = require('./lib/provider-cooldown');
const { checkGrounding, verifyReferencedPaths } = require('./lib/workspace-grounding');
const {
  classifyRunFailure,
  classifyProviderHttpFailure,
  detectCopilotMonthlyQuota,
  isHostedApiKeyMissingError,
  HOSTED_API_KEY_MISSING_CODE,
} = require('./lib/provider-failure');
// Issue #17: readiness proves auth, not quota. A seat that returned 429 stays
// "ready" forever unless the 429 is remembered, so remember it durably and
// share it with every client.
const cooldowns = createCooldownStore({
  file: path.join(DATA_DIR, 'cooldowns.json'),
  log: (m) => console.log(m),
});

const {
  createUsageLedger, OPERATOR_QUOTA_PROVENANCE, MAX_OPERATOR_QUOTA_TTL_MS,
} = require('./lib/usage-ledger');
const { parseGrokQuota429 } = require('./lib/vendor-quota');
const {
  disconnectFailureClass,
  resolveCancellationTerminalState,
} = require('./lib/cancellation-state');
const {
  levelCandidates, suggestTierAdjustment, fleetBalance,
  applyCooldownsToDiagnostics, activeVendorQuotaExhaustion,
  applyVendorQuotaExhaustionToDiagnostics,
  levelRouteSelection,
} = require('./lib/load-leveller');

function loadUsageBudgets() {
  try {
    const fp = path.join(ROOT, 'config', 'usage-budgets.json');
    return fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : {};
  } catch { return {}; }
}
const usageBudgetsFile = loadUsageBudgets();
const quotaSeatRegistry = buildQuotaSeatGroups(loadConfig());
function quotaSeatForProvider(provider) {
  return quotaSeatRegistry.providerToQuotaSeat[provider] || provider;
}
function coolingQuotaStates() {
  return cooldowns.cooling().map((state) => {
    const quotaSeat = quotaSeatForProvider(state.seat);
    const accountScoped = state.scope !== 'model';
    return {
      ...state,
      quotaSeat,
      aliases: accountScoped
        ? (quotaSeatRegistry.groups[quotaSeat]?.providers || [state.seat])
        : [state.seat],
    };
  });
}
function filterCandidatesByQuotaCooldown(candidates = [], explicit = null, coolingStates = coolingQuotaStates()) {
  const byAlias = new Map();
  for (const state of coolingStates || []) {
    for (const alias of state.aliases || []) byAlias.set(alias, state);
  }
  const usable = [];
  const skipped = [];
  for (const candidate of candidates) {
    const seat = typeof candidate === 'string' ? candidate : candidate.seat;
    const state = byAlias.get(seat);
    const item = typeof candidate === 'string' ? { seat } : { ...candidate };
    if (state && seat !== explicit) skipped.push({ ...item, cooldown: state });
    else usable.push({ ...item, cooldown: state || null });
  }
  return { usable, skipped, allCooling: usable.length === 0 && skipped.length > 0 };
}
const usageLedger = createUsageLedger({
  dataDir: path.join(DATA_DIR, 'usage'),
  budgets: usageBudgetsFile.budgets || {},
  pricing: usageBudgetsFile.pricing || undefined,
  quotaSeats: quotaSeatRegistry.providerToQuotaSeat,
  log: (m) => console.log(m),
});

// Which account should this dispatch run on, and what env makes the CLI use it?
//
// Returns the implicit single-account shape for every seat the operator has not
// added a second plan to, so this is a no-op for an ordinary install: no env is
// injected and the quotaSeat is exactly the one configured in cli-config.json.
function resolveDispatchAccount(kind, entry, { unavailableAccountIds = new Set() } = {}) {
  try {
    // Dispatch is an authority boundary: a malformed or unreadable registry
    // must not be treated as "no accounts configured", which would silently
    // fall back to the operator's default credentials.
    const registry = providerAccounts.loadRegistry(DATA_DIR, { strict: true });
    const accounts = providerAccounts.accountsFor(kind, entry, registry);
    const hasExplicitAccounts = accounts.some((account) => !account.implicit);
    const providerManaged = Object.prototype.hasOwnProperty.call(registry.providers, kind);
    const enabledLinkedAccounts = accounts.some((candidate) => !candidate.implicit && candidate.enabled);
    const relocationMissing = providerManaged
      && !providerAccounts.credentialEnvFor(entry)
      && enabledLinkedAccounts;
    if (relocationMissing) {
      return {
        account: null, env: {}, quotaSeat: null, exhausted: true,
        hasExplicitAccounts, providerManaged, resolutionError: false,
        reason: 'credential_relocation_unavailable', retryAt: null,
      };
    }
    const isolationUnsupported = providerManaged && enabledLinkedAccounts
      && !providerAccounts.supportsLinkedAccounts(entry);
    if (isolationUnsupported) {
      return {
        account: null, env: {}, quotaSeat: null, exhausted: true,
        hasExplicitAccounts, providerManaged, resolutionError: false,
        reason: 'linked_account_isolation_unsupported', retryAt: null,
      };
    }
    const cooling = new Set(coolingQuotaStates()
      .filter((state) => state.scope !== 'model')
      .map((state) => state.quotaSeat).filter(Boolean));
    let gauges = {};
    try {
      // Keyed by seat; re-key by quotaSeat so a per-account gauge can be found.
      for (const [gaugeSeat, gauge] of Object.entries(usageLedger.gaugeAll(seatCostClasses()) || {})) {
        if (gaugeSeat !== kind && !gaugeSeat.startsWith(`${kind}#`)) continue;
        if (gauge && gauge.quotaSeat) gauges[gauge.quotaSeat] = gauge;
      }
    } catch { gauges = {}; }
    const account = providerAccounts.selectAccount({
      kind, entry, registry, dataDir: DATA_DIR, gauges, coolingQuotaSeats: cooling,
      unavailableAccountIds,
      allowCoolingFallback: true,
    });
    if (!account) {
      const usable = accounts.filter((candidate) => candidate.enabled
        && !unavailableAccountIds.has(candidate.id)
        && providerAccounts.accountIsProvisioned({ entry, account: candidate, dataDir: DATA_DIR, kind })
        && providerAccounts.accountAuthAvailable({ entry, account: candidate, dataDir: DATA_DIR, kind }));
      const vendorBlocks = usable.map((candidate) => ({
        account: candidate,
        block: activeVendorQuotaExhaustion(gauges[candidate.quotaSeat]),
      })).filter((item) => item.block);
      const vendorExhausted = usable.length > 0 && vendorBlocks.length === usable.length;
      return {
        account: null, env: {}, quotaSeat: null, exhausted: true,
        hasExplicitAccounts, providerManaged, resolutionError: false,
        reason: vendorExhausted ? 'vendor_exhausted' : 'auth_unavailable',
        retryAt: vendorExhausted
          ? vendorBlocks.map((item) => item.block.reset?.expiresAt).filter(Boolean).sort()[0] || null
          : null,
      };
    }
    return {
      account,
      env: providerAccounts.envForAccount({ entry, account, dataDir: DATA_DIR, kind }),
      quotaSeat: account.quotaSeat,
      exhausted: false,
      hasExplicitAccounts,
      providerManaged,
      resolutionError: false,
      reason: null,
      retryAt: null,
    };
  } catch (err) {
    // Never run on a different login than the receipt will attribute.
    console.log('[RelayBridge] account resolution failed: ' + err.message);
    return {
      account: null, env: {}, quotaSeat: null, exhausted: true,
      hasExplicitAccounts: false, providerManaged: false, resolutionError: true,
      reason: 'registry_invalid', retryAt: null,
    };
  }
}

function seatCostClasses() {
  const cfg = loadConfig();
  const groups = currentQuotaSeatGroups();
  const out = {};
  for (const [seat, entry] of Object.entries(cfg)) {
    if (seat.startsWith('_')) continue;
    const base = {
      costClass: costClassFor(entry, seat),
      model: entry.model || null,
      quotaSeat: quotaSeatForProvider(seat),
      aliases: groups[quotaSeatForProvider(seat)]?.providers || [seat],
    };
    out[seat] = base;
    // One gauge per linked account. gauge() already filters ledger rows by
    // quotaSeat and looks its budget up by quotaSeat first, so emitting an
    // extra seat config per account is all that separate allowances need —
    // without this, three plans drain one bar and the operator cannot see
    // which of them is nearly empty. Keyed 'seat#account' so it never collides
    // with the seat's own entry, which stays exactly as it was.
    try {
      for (const account of providerAccounts.accountsFor(seat, entry, accountRegistry())) {
        if (account.implicit) continue;
        out[`${seat}#${account.id}`] = {
          ...base,
          quotaSeat: account.quotaSeat,
          aliases: groups[account.quotaSeat]?.providers || [seat],
        };
      }
    } catch { /* a malformed registry must not break fleet accounting */ }
  }
  return out;
}

// Cached per call-site rather than per seat: seatCostClasses() runs on the
// routing path and re-reading the registry once per provider would put 14 file
// reads on it.
let _accountRegistryCache = { at: 0, value: { providers: {} } };
function accountRegistry() {
  const now = Date.now();
  if (now - _accountRegistryCache.at < 2000) return _accountRegistryCache.value;
  _accountRegistryCache = { at: now, value: providerAccounts.loadRegistry(DATA_DIR) };
  return _accountRegistryCache.value;
}

function invalidateAccountRegistry() {
  _accountRegistryCache = { at: 0, value: { providers: {} } };
}

function currentQuotaSeatGroups() {
  const groups = Object.fromEntries(Object.entries(quotaSeatRegistry.groups).map(([quotaSeat, group]) => [
    quotaSeat,
    { ...group, providers: [...group.providers] },
  ]));
  const cfg = loadConfig();
  const registry = accountRegistry();
  for (const [kind, entry] of Object.entries(cfg)) {
    if (kind.startsWith('_') || !entry || typeof entry !== 'object') continue;
    for (const account of providerAccounts.accountsFor(kind, entry, registry)) {
      if (account.implicit) continue;
      const group = groups[account.quotaSeat] || (groups[account.quotaSeat] = {
        quotaSeat: account.quotaSeat,
        providers: [],
        transport: entry.transport || null,
        explicitlyGrouped: true,
        account: { id: account.id, providers: [] },
      });
      if (!group.providers.includes(kind)) group.providers.push(kind);
      group.providers.sort();
      if (group.transport !== (entry.transport || null)) group.transport = null;
      if (!group.account || group.account.id !== account.id) {
        throw new Error(`linked account quota-seat collision at ${account.quotaSeat}`);
      }
      group.account.providers = [...group.providers];
    }
  }
  return groups;
}

function providerGaugeMap(kind, gauges) {
  const byQuotaSeat = {};
  for (const [gaugeSeat, gauge] of Object.entries(gauges || {})) {
    if (gaugeSeat !== kind && !gaugeSeat.startsWith(`${kind}#`)) continue;
    if (gauge?.quotaSeat) byQuotaSeat[gauge.quotaSeat] = gauge;
  }
  return byQuotaSeat;
}

// Project account-level capacity onto provider-level routing without pretending
// that one drained/default account exhausts every linked subscription. The
// router still consumes provider keys; this picks the gauge and cooldown state
// of an actually selectable account for each key.
function accountAwareRoutingInputs(config, diagnostics, gauges, coolingStates) {
  const adjustedDiagnostics = Object.fromEntries(Object.entries(diagnostics || {}).map(([kind, info]) => [
    kind,
    info && typeof info === 'object' ? { ...info } : info,
  ]));
  const routeGauges = {};
  const routeCooling = [];
  const accountSelection = {};
  const coolingKeys = new Set();
  const addCooling = (kind, state) => {
    if (!state) return;
    const key = `${kind}\u0000${state.seat}\u0000${state.scope}`;
    if (coolingKeys.has(key)) return;
    coolingKeys.add(key);
    routeCooling.push({ ...state, aliases: [kind] });
  };
  const projectGauge = (kind, gauge) => gauge ? { ...gauge, aliases: [kind] } : gauge;
  let registry = { providers: {} };
  let registryError = null;
  try {
    registry = providerAccounts.loadRegistry(DATA_DIR, { strict: true });
  } catch (err) {
    registryError = err;
  }

  for (const [kind, entry] of Object.entries(config || {})) {
    if (kind.startsWith('_') || !entry || typeof entry !== 'object') continue;
    const byQuotaSeat = providerGaugeMap(kind, gauges);
    routeGauges[kind] = projectGauge(
      kind, byQuotaSeat[quotaSeatForProvider(kind)] || gauges?.[kind],
    );
    const aliasedStates = (coolingStates || []).filter((state) =>
      (state.aliases || [state.seat]).map(String).includes(kind));
    const providerManaged = !registryError
      && Object.prototype.hasOwnProperty.call(registry.providers, kind);
    if (registryError) {
      const prior = adjustedDiagnostics[kind] && typeof adjustedDiagnostics[kind] === 'object'
        ? adjustedDiagnostics[kind] : {};
      adjustedDiagnostics[kind] = {
        ...prior,
        ready: false,
        accountUnavailable: true,
        accountUnavailableReason: 'registry_invalid',
        detail: 'linked-account registry is invalid; dispatch is disabled until it is repaired',
      };
      accountSelection[kind] = { available: false, reason: 'registry_invalid' };
      continue;
    }
    if (!providerAccounts.credentialEnvFor(entry) && !providerManaged) {
      for (const state of aliasedStates) addCooling(kind, state);
      continue;
    }

    let accounts;
    let linkedAccountsSupported;
    try {
      accounts = providerAccounts.accountsFor(kind, entry, registry);
      linkedAccountsSupported = providerAccounts.supportsLinkedAccounts(entry);
    } catch (err) {
      const prior = adjustedDiagnostics[kind] && typeof adjustedDiagnostics[kind] === 'object'
        ? adjustedDiagnostics[kind] : {};
      adjustedDiagnostics[kind] = {
        ...prior,
        ready: false,
        accountUnavailable: true,
        accountUnavailableReason: 'registry_invalid',
        detail: `linked-account configuration is invalid for ${kind}`,
      };
      accountSelection[kind] = { available: false, reason: 'registry_invalid' };
      continue;
    }
    const enabledLinkedAccounts = accounts.some((account) => !account.implicit && account.enabled);
    if (providerManaged && enabledLinkedAccounts
      && entry.linked_accounts_supported === false && !linkedAccountsSupported) {
      const prior = adjustedDiagnostics[kind] && typeof adjustedDiagnostics[kind] === 'object'
        ? adjustedDiagnostics[kind] : {};
      adjustedDiagnostics[kind] = {
        ...prior,
        ready: false,
        accountUnavailable: true,
        accountUnavailableReason: 'linked_account_isolation_unsupported',
        detail: entry.linked_accounts_unavailable_reason
          || 'linked accounts are disabled because this provider cannot isolate authentication safely',
      };
      accountSelection[kind] = {
        available: false,
        reason: 'linked_account_isolation_unsupported',
      };
      continue;
    }
    const relocationMissing = providerManaged
      && !providerAccounts.credentialEnvFor(entry)
      && enabledLinkedAccounts;
    if (relocationMissing) {
      const prior = adjustedDiagnostics[kind] && typeof adjustedDiagnostics[kind] === 'object'
        ? adjustedDiagnostics[kind] : {};
      adjustedDiagnostics[kind] = {
        ...prior,
        ready: false,
        accountUnavailable: true,
        accountUnavailableReason: 'credential_relocation_unavailable',
        detail: 'managed linked accounts exist but credential_env is missing or invalid',
      };
      accountSelection[kind] = {
        available: false,
        reason: 'credential_relocation_unavailable',
      };
      continue;
    }
    const readiness = adjustedDiagnostics[kind];
    const defaultSignedOut = !!(readiness && readiness.found && readiness.ready === false
      && readiness.authFailed === true && readiness.authAuthoritative === true
      && Array.isArray(entry.login_command));
    const unavailableAccountIds = defaultSignedOut
      ? new Set([providerAccounts.DEFAULT_ACCOUNT_ID]) : new Set();
    const eligible = accounts.filter((account) => account.enabled
      && !unavailableAccountIds.has(account.id)
      && providerAccounts.accountIsProvisioned({ entry, account, dataDir: DATA_DIR, kind })
      && providerAccounts.accountAuthAvailable({ entry, account, dataDir: DATA_DIR, kind }));
    const accountCooldowns = new Map((coolingStates || [])
      .filter((state) => state.scope !== 'model')
      .map((state) => [state.quotaSeat, state]));
    const ownCoolingSeats = new Set(accountCooldowns.keys());
    const vendorBlockFor = (account) => activeVendorQuotaExhaustion(byQuotaSeat[account.quotaSeat]);
    const nonExhausted = eligible.filter((account) => !vendorBlockFor(account));
    const selected = providerAccounts.selectAccount({
      kind,
      entry,
      registry,
      dataDir: DATA_DIR,
      gauges: byQuotaSeat,
      coolingQuotaSeats: ownCoolingSeats,
      unavailableAccountIds,
      // Retain one concrete cooled account in the projection. The cooldown
      // layer below still hides it from normal routing, while an explicitly
      // requested provider can exercise the established one-shot retry path.
      allowCoolingFallback: true,
    });

    if (selected) {
      const selectedCooldown = accountCooldowns.get(selected.quotaSeat) || null;
      routeGauges[kind] = projectGauge(
        kind, byQuotaSeat[selected.quotaSeat] || routeGauges[kind],
      );
      accountSelection[kind] = selectedCooldown ? {
        available: false,
        reason: 'cooling',
        account: selected.implicit ? null : selected.id,
        quotaSeat: selected.quotaSeat,
        retryAt: selectedCooldown.until || null,
      } : {
        available: true,
        account: selected.implicit ? null : selected.id,
        quotaSeat: selected.quotaSeat,
      };
      if (defaultSignedOut && !selected.implicit) {
        adjustedDiagnostics[kind] = {
          ...readiness,
          ready: true,
          linkedAccountReady: true,
          selectedAccount: selected.id,
          detail: `default sign-in unavailable; linked account '${selected.id}' is provisioned`,
        };
      }
      if (selectedCooldown) addCooling(kind, selectedCooldown);
      // Model-scoped cooldowns apply to the provider/model regardless of which
      // account holds the credential directory. Account-scoped cooldowns do not.
      for (const state of aliasedStates.filter((item) => item.scope === 'model')) addCooling(kind, state);
      continue;
    }

    if (!eligible.length) {
      const prior = adjustedDiagnostics[kind] && typeof adjustedDiagnostics[kind] === 'object'
        ? adjustedDiagnostics[kind] : {};
      adjustedDiagnostics[kind] = {
        ...prior,
        ready: false,
        accountUnavailable: true,
        accountUnavailableReason: 'auth_unavailable',
        detail: 'no enabled and provisioned linked account is available',
      };
      accountSelection[kind] = { available: false, reason: 'auth_unavailable' };
      continue;
    }
    if (!nonExhausted.length) {
      // Hard vendor evidence cannot be bypassed, even for an explicitly named
      // provider. Project one exhausted account gauge onto the provider key so
      // the existing typed reset guidance remains intact.
      routeGauges[kind] = projectGauge(
        kind, byQuotaSeat[eligible[0].quotaSeat] || routeGauges[kind],
      );
      accountSelection[kind] = { available: false, reason: 'vendor_exhausted' };
      continue;
    }

    // Every non-exhausted account is cooling. Normal routing blocks the
    // provider, while the established explicit-provider override can still
    // probe one account and clear a recovered cooldown.
    const cooled = nonExhausted[0];
    routeGauges[kind] = projectGauge(
      kind, byQuotaSeat[cooled.quotaSeat] || routeGauges[kind],
    );
    addCooling(kind, accountCooldowns.get(cooled.quotaSeat));
    accountSelection[kind] = {
      available: false,
      reason: 'cooling',
      retryAt: accountCooldowns.get(cooled.quotaSeat)?.until || null,
    };
  }

  return { diagnostics: adjustedDiagnostics, gauges: routeGauges, cooling: routeCooling, accountSelection };
}

function seatCostClassMap() {
  const entries = seatCostClasses();
  return Object.fromEntries(Object.entries(entries).map(([seat, value]) => [seat, value.costClass]));
}

function vendorQuotaFleet(gauges) {
  const out = {};
  for (const [seat, gauge] of Object.entries(gauges)) {
    if (!gauge?.vendorQuota) continue;
    const accountScoped = gauge.vendorQuota.scope === 'account';
    const key = accountScoped ? (gauge.quotaSeat || seat) : seat;
    if (!out[key]) out[key] = {
      ...gauge.vendorQuota,
      quotaSeat: gauge.quotaSeat || seat,
      aliases: accountScoped ? gauge.aliases : [seat],
    };
  }
  return out;
}

function operatorQuotaFleet(gauges) {
  const out = {};
  for (const gauge of Object.values(gauges)) {
    if (!gauge?.operatorQuota || out[gauge.quotaSeat]) continue;
    out[gauge.quotaSeat] = { ...gauge.operatorQuota, aliases: gauge.aliases };
  }
  return out;
}

function recordRunUsage({ kind, route, usage, model, startedAt, ok, failureKind, taskId }) {
  try {
    const classes = seatCostClasses();
    usageLedger.record({
      seat: kind,
      // Per-account attribution: three plans on one provider are three
      // allowances, and pooling them back into one gauge would hide the fact
      // that one of them is nearly drained.
      quotaSeat: route?.quota_seat || null,
      // route.resolved_model is only ever assigned by the two API adapters, so
      // every CLI seat (claude, codex, gemini, copilot, cursor, grok,
      // perplexity) recorded model:null — which prices an Opus run at the
      // $1/$5 _default rate instead of $15/$75 and, because usage-ledger gates
      // its per-model tally on `if (r.model)`, left gauge().models permanently
      // empty. The caller passes what the provider actually reported.
      model: model || route?.resolved_model || route?.resolved_model_identity
        || route?.requested_model || route?.model || null,
      costClass: classes[kind]?.costClass || 'metered',
      inputTokens: usage?.input_tokens ?? usage?.prompt_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? usage?.completion_tokens ?? 0,
      // Claude reports single-digit input_tokens against tens of thousands of
      // cache-read tokens on a resumed session, so input+output alone books a
      // tiny fraction of the real draw for the seat with the largest budget.
      // normalizeClaudeJsonUsage already computes all four counts, an
      // authoritative total and the provider's own cost, and they were dropped
      // here. Forwarded so the ledger can book the real draw and prefer the
      // provider's cost over the list-rate estimate; lib/usage-ledger.js's
      // record() still recomputes totalTokens = input + output and ignores
      // these until it is taught to read them.
      cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
      totalTokens: nonnegativeUsageNumber(usage?.total_tokens),
      providerCostUsd: nonnegativeCostNumber(usage?.cost_usd),
      elapsedMs: startedAt ? Date.now() - startedAt : 0,
      ok, failureKind: failureKind || null, taskId: taskId || null,
    });
  } catch (err) { console.log('[RelayBridge] usage record failed: ' + err.message); }
}

// ---- Multiple accounts per provider ----
//
// Link several subscriptions to one seat: each account gets its own credential
// directory and its own quotaSeat, so the ledger, the cooldown store and the
// load leveller treat them as separate allowances that the router drains in
// turn. Three Claude plans behave as three seats to spend, not one.
app.get('/api/accounts', (req, res) => {
  const cfg = loadConfig();
  let registry;
  try {
    registry = providerAccounts.loadRegistry(DATA_DIR, { strict: true });
  } catch (err) {
    return res.status(500).json({
      error: 'account registry is invalid; dispatch is disabled until it is repaired',
      detail: err.message,
    });
  }
  const cooling = new Set(coolingQuotaStates().map((s) => s.quotaSeat).filter(Boolean));
  let gauges = {};
  try {
    for (const g of Object.values(usageLedger.gaugeAll(seatCostClasses()) || {})) {
      if (g && g.quotaSeat) gauges[g.quotaSeat] = g;
    }
  } catch { gauges = {}; }
  const out = {};
  for (const [kind, entry] of Object.entries(cfg)) {
    if (kind.startsWith('_') || !entry || typeof entry !== 'object') continue;
    const credentialEnv = providerAccounts.credentialEnvFor(entry);
    let supportsMultipleAccounts = false;
    try { supportsMultipleAccounts = providerAccounts.supportsLinkedAccounts(entry); }
    catch { supportsMultipleAccounts = false; }
    const accounts = providerAccounts.accountsFor(kind, entry, registry).map((a) => {
      const runtimeAuthUnavailable = a.implicit
        && lastDiagnostics?.results?.[kind]?.ready === false
        && lastDiagnostics?.results?.[kind]?.authFailed === true
        && lastDiagnostics?.results?.[kind]?.authAuthoritative === true;
      const authUnavailable = runtimeAuthUnavailable || !providerAccounts.accountAuthAvailable({
        entry, account: a, dataDir: DATA_DIR, kind,
      });
      return {
        id: a.id,
        label: a.label,
        quotaSeat: a.quotaSeat,
        enabled: a.enabled,
        implicit: a.implicit,
        provisioned: providerAccounts.accountIsProvisioned({ entry, account: a, dataDir: DATA_DIR, kind }),
        authUnavailable,
        authFailedAt: a.authFailedAt ? new Date(a.authFailedAt).toISOString() : null,
        authRetry: authUnavailable ? {
          method: 'POST',
          path: `/api/accounts/${encodeURIComponent(kind)}/${encodeURIComponent(a.id)}/auth/retry`,
          body: { retry: true },
          note: 'Use only after signing in again. The next live dispatch revalidates the credentials and quarantines them again if authentication still fails.',
        } : null,
        cooling: cooling.has(a.quotaSeat),
        percentRemaining: typeof gauges[a.quotaSeat]?.percentRemaining === 'number'
          && Number.isFinite(gauges[a.quotaSeat].percentRemaining)
          ? gauges[a.quotaSeat].percentRemaining : null,
      };
    });
    // Only report seats that can actually hold more than one account, so the
    // dashboard does not offer to link a second plan to a seat whose CLI has
    // no way to relocate its credentials.
    out[kind] = {
      label: entry.label || kind,
      credentialEnv,
      supportsMultipleAccounts,
      linkedAccountsUnavailableReason: supportsMultipleAccounts
        ? null : (entry.linked_accounts_unavailable_reason || null),
      accounts,
    };
  }
  res.json({ providers: out, dataDir: path.join(DATA_DIR, 'accounts') });
});

app.post('/api/accounts/:kind', (req, res) => {
  const kind = String(req.params.kind);
  const entry = loadConfig()[kind];
  if (!entry || kind.startsWith('_')) return res.status(404).json({ error: `unknown provider '${kind}'` });
  let supportsMultipleAccounts = false;
  try { supportsMultipleAccounts = providerAccounts.supportsLinkedAccounts(entry); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  if (!supportsMultipleAccounts) {
    return res.status(400).json({
      error: entry.linked_accounts_supported === false
        ? `${kind} does not support attribution-safe linked accounts`
        : `${kind} does not declare credential_env, so its credentials cannot be separated per account`,
      hint: entry.linked_accounts_unavailable_reason
        || 'add "credential_env": "<ENV_VAR>" to this provider in cli-config.json',
    });
  }
  try {
    providerAccounts.addAccount(DATA_DIR, kind, { id: req.body?.id, label: req.body?.label });
    invalidateAccountRegistry();
  } catch (err) { return res.status(400).json({ error: err.message }); }
  const dir = providerAccounts.accountDir(DATA_DIR, kind, String(req.body.id));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const login = Array.isArray(entry.login_command) ? entry.login_command : null;
  const credentialEnv = providerAccounts.credentialEnvFor(entry);
  const signInEnvironment = providerAccounts.credentialEnvironmentFor(entry, dir);
  res.json({
    ok: true, kind, id: String(req.body.id), credentialDir: dir,
    // The bridge cannot complete an interactive OAuth flow on the operator's
    // behalf, so hand back the exact command that signs THIS account in.
    signIn: { environment: signInEnvironment, argv: login },
    signInCommand: providerAccounts.formatSignInCommand({
      envName: credentialEnv,
      credentialDir: dir,
      environment: signInEnvironment,
      argv: login,
    }),
    note: 'Run that command in a terminal, complete the sign-in, then this account becomes selectable.',
  });
});

app.post('/api/accounts/:kind/:id/enabled', (req, res) => {
  const kind = String(req.params.kind);
  const entry = loadConfig()[kind];
  if (!entry || kind.startsWith('_')) return res.status(404).json({ error: `unknown provider '${kind}'` });
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 1 || typeof body.enabled !== 'boolean') {
    return res.status(400).json({ error: 'body must contain only enabled as a boolean' });
  }
  try {
    providerAccounts.setAccountEnabled(DATA_DIR, kind, String(req.params.id), body.enabled);
    invalidateAccountRegistry();
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Some CLIs (notably Copilot) expose a version probe but no non-interactive
// authentication-status command. A live auth failure must still quarantine the
// default account, yet a successful re-login cannot be inferred from that
// version-only probe. Give the operator one explicit, typed way to arm a single
// retry. If the credentials are still bad, normal dispatch accounting writes
// the quarantine marker straight back.
app.post('/api/accounts/:kind/:id/auth/retry', (req, res) => {
  const kind = String(req.params.kind);
  const id = String(req.params.id);
  const entry = loadConfig()[kind];
  if (!entry || kind.startsWith('_')) return res.status(404).json({ error: `unknown provider '${kind}'` });
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 1 || body.retry !== true) {
    return res.status(400).json({ error: 'body must contain only retry: true' });
  }
  try {
    const registry = providerAccounts.loadRegistry(DATA_DIR, { strict: true });
    const account = providerAccounts.accountsFor(kind, entry, registry)
      .find((candidate) => candidate.id === id);
    if (!account) return res.status(404).json({ error: `unknown account '${id}' for ${kind}` });
    const cleared = providerAccounts.clearAccountAuthFailure(DATA_DIR, kind, id);
    if (id === providerAccounts.DEFAULT_ACCOUNT_ID) {
      armDefaultAccountRuntimeAuthRetry(kind);
    }
    invalidateAccountRegistry();
    return res.json({
      ok: true,
      kind,
      id,
      authRetryArmed: true,
      priorAuthFailureCleared: !!cleared,
      note: 'The next live dispatch will validate this account and quarantine it again if authentication still fails.',
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.delete('/api/accounts/:kind/:id', (req, res) => {
  const kind = String(req.params.kind);
  const id = String(req.params.id);
  const entry = loadConfig()[kind];
  if (!entry || kind.startsWith('_')) return res.status(404).json({ error: `unknown provider '${kind}'` });
  // Validate and persist the registry change before deleting credentials. A
  // malformed registry or unknown account must leave its recoverable token
  // directory untouched rather than deleting first and failing afterward.
  try {
    providerAccounts.removeAccount(DATA_DIR, kind, id);
    invalidateAccountRegistry();
  } catch (err) {
    return res.status(400).json({ error: err.message, accountRemoved: false, credentialsRemoved: false });
  }
  const implicitDefault = id === providerAccounts.DEFAULT_ACCOUNT_ID;
  const removeManagedCredentials = req.query.keepCredentials !== '1' && !implicitDefault;
  if (removeManagedCredentials) {
    try {
      providerAccounts.forgetAccountCredentials(DATA_DIR, kind, id);
    } catch (err) {
      return res.json({
        ok: false,
        accountRemoved: true,
        credentialsRemoved: false,
        credentialCleanupRequired: true,
        credentialDir: providerAccounts.accountDir(DATA_DIR, kind, id),
        error: `account was removed, but its credential directory could not be deleted: ${err.message}`,
      });
    }
  }
  return res.json({
    ok: true,
    accountRemoved: true,
    credentialsRemoved: removeManagedCredentials,
    ...(implicitDefault ? {
      requiresProviderLogout: true,
      note: 'The default account uses the provider CLI home; run the provider logout command to revoke that session.',
    } : {}),
  });
});

app.get('/api/usage/gauges', (req, res) => {
  try {
    const windowMs = Number(req.query.windowMs) || 86400000;
    const gauges = usageLedger.gaugeAll(seatCostClasses(), windowMs);
    const runtimeVersions = Object.fromEntries(Object.entries(lastDiagnostics?.results || {})
      .map(([kind, result]) => [kind, result.runtimeVersion || '']));
    res.json({
      gauges,
      balance: fleetBalance(gauges),
      quotaSeats: currentQuotaSeatGroups(),
      operatorQuota: operatorQuotaFleet(gauges),
      providerUsageCapabilities: providerUsageCapabilities(loadConfig(), runtimeVersions),
      totals: usageLedger.totals(windowMs),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/usage/operator-quota', (req, res) => {
  res.json({
    observations: usageLedger.operatorQuotaObservations(),
    quotaSeats: currentQuotaSeatGroups(),
    provenanceOptions: OPERATOR_QUOTA_PROVENANCE,
    maxTtlMs: MAX_OPERATOR_QUOTA_TTL_MS,
  });
});
app.put('/api/usage/operator-quota', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'JSON object required' });
  }
  const allowed = new Set(['quotaSeat', 'percentRemaining', 'provenance', 'observedAt', 'expiresAt']);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) {
    return res.status(400).json({ error: `unsupported fields: ${unknown.join(', ')}; credentials and free-form notes are never stored` });
  }
  const quotaSeat = typeof body.quotaSeat === 'string' ? body.quotaSeat.trim() : '';
  if (!currentQuotaSeatGroups()[quotaSeat]) return res.status(400).json({ error: 'quotaSeat must name a configured quota seat' });
  if (!Number.isInteger(body.percentRemaining) || body.percentRemaining < 0 || body.percentRemaining > 100) {
    return res.status(400).json({ error: 'percentRemaining must be an integer from 0 to 100' });
  }
  if (!OPERATOR_QUOTA_PROVENANCE.includes(body.provenance)) {
    return res.status(400).json({ error: `provenance must be one of: ${OPERATOR_QUOTA_PROVENANCE.join(', ')}` });
  }
  const observation = usageLedger.observeOperatorQuota({
    quotaSeat,
    percentRemaining: body.percentRemaining,
    provenance: body.provenance,
    observedAt: body.observedAt,
    expiresAt: body.expiresAt,
    source: 'operator_reported',
  });
  if (!observation) {
    return res.status(400).json({ error: `observedAt/expiresAt are invalid; expiry must be future, after observation, and within ${MAX_OPERATOR_QUOTA_TTL_MS}ms` });
  }
  return res.json({ ok: true, observation });
});
app.delete('/api/usage/operator-quota', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => key !== 'quotaSeat')) {
    return res.status(400).json({ error: 'body must contain only quotaSeat' });
  }
  const quotaSeat = typeof body.quotaSeat === 'string' ? body.quotaSeat.trim() : '';
  if (!currentQuotaSeatGroups()[quotaSeat]) return res.status(400).json({ error: 'quotaSeat must name a configured quota seat' });
  if (!usageLedger.clearOperatorQuota(quotaSeat)) return res.status(500).json({ error: 'operator quota clear could not be persisted' });
  return res.json({ ok: true, quotaSeat, cleared: true });
});
app.get('/api/cooldowns', (req, res) => {
  res.json({ cooldowns: cooldowns.all(), cooling: coolingQuotaStates(), quotaSeats: currentQuotaSeatGroups() });
});

app.get('/api/usage/totals', (req, res) => {
  try { res.json(usageLedger.totals(Number(req.query.windowMs) || 86400000)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/usage/advise', (req, res) => {
  try {
    const filesystemAuthority = planningFilesystemAuthority(req.body || {});
    const { tier = 'standard', candidates = [], highStakes = false, explicitProvider = false } = req.body || {};
    const gauges = usageLedger.gaugeAll(seatCostClasses());
    const cfg = loadConfig();
    const filesystemUsable = [];
    const filesystemSkipped = [];
    for (const raw of candidates) {
      const item = typeof raw === 'string' ? { seat: raw } : { ...raw };
      const eligibility = providerFilesystemEligibility(runtimeFilesystemPolicyEntry(cfg[item.seat] || {}), filesystemAuthority);
      const annotated = { ...item, safeFilesystem: eligibility };
      if (eligibility.eligible) filesystemUsable.push(annotated);
      else filesystemSkipped.push({ ...annotated, blocked: true, reason: eligibility.blockedReason });
    }
    const candidateDiagnostics = Object.fromEntries(filesystemUsable.map((item) => [item.seat, {
      found: true, ready: true,
    }]));
    // Advice is a routing surface too. Project the healthiest selectable linked
    // account onto each provider key before applying quota gates; otherwise a
    // cooling/exhausted default account hides a healthy second subscription.
    const routingInputs = accountAwareRoutingInputs(
      cfg, candidateDiagnostics, gauges, coolingQuotaStates(),
    );
    const accountUnavailableKinds = new Set(Object.entries(routingInputs.accountSelection)
      .filter(([, state]) => state?.available === false
        && (state.reason === 'auth_unavailable' || state.reason === 'registry_invalid'
          || state.reason === 'credential_relocation_unavailable'))
      .map(([kind]) => kind));
    const accountUnavailableSkipped = filesystemUsable
      .filter((item) => accountUnavailableKinds.has(item.seat))
      .map((item) => ({
        ...item,
        blocked: true,
        reason: routingInputs.accountSelection[item.seat].reason,
      }));
    const accountUsable = filesystemUsable.filter((item) => !accountUnavailableKinds.has(item.seat));
    const vendorQuotaInput = applyVendorQuotaExhaustionToDiagnostics(
      routingInputs.diagnostics, routingInputs.gauges,
    );
    const vendorQuotaKinds = new Set(vendorQuotaInput.skipped.map((item) => item.kind));
    const quotaUsable = accountUsable.filter((item) => !vendorQuotaKinds.has(item.seat));
    const vendorQuotaSkipped = vendorQuotaInput.skipped.filter((item) => candidateDiagnostics[item.kind]);
    // Quota state first: a cooling seat cannot do the work at any rank.
    const { usable, skipped, allCooling } = filterCandidatesByQuotaCooldown(
      quotaUsable,
      explicitProvider ? (req.body?.explicitSeat || null) : null,
      routingInputs.cooling,
    );
    const ranked = levelCandidates(usable, routingInputs.gauges);
    const top = ranked[0] ? routingInputs.gauges[ranked[0].seat] : null;
    res.json({
      ranked, skipped, allCooling,
      allAccountsUnavailable: accountUsable.length === 0 && accountUnavailableSkipped.length > 0,
      accountUnavailableSkipped,
      accountSelection: routingInputs.accountSelection,
      allVendorQuotaExhausted: quotaUsable.length === 0 && vendorQuotaSkipped.length > 0,
      vendorQuotaSkipped, filesystemSkipped, filesystemAuthority,
      tierAdjustment: suggestTierAdjustment({ tier, gauge: top, highStakes, explicitProvider }),
      balance: fleetBalance(gauges),
      vendorQuota: vendorQuotaFleet(gauges),
      operatorQuota: operatorQuotaFleet(gauges),
    });
  } catch (err) { res.status(400).json({ error: err.message }); }
});


// ---- GitHub integration (lib/github-tracker.js) --------------------------
// Fire-and-forget middleware on the run-completion path. Activates only for
// runs whose cwd sits inside an enrolled repo (config/github-repos.json);
// strict no-op otherwise. It commits/documents/labels as side effects of a
// run — the provider response is never delayed or failed by tracking.
const githubTracker = require('./lib/github-tracker');
const githubOnboard = require('./lib/github-onboard');
githubTracker.setActivityFile(path.join(DATA_DIR, 'github-activity.jsonl'));

function trackRunAfterResponse(meta) {
  // setImmediate so the one-shot response is already on the wire.
  setImmediate(() => {
    githubTracker.trackRun(meta).catch((err) => {
      githubTracker.logActivity({ action: 'track_run', runId: meta.runId, tracked: false, reason: 'unhandled tracker error', detail: err.message });
    });
  });
}

app.get('/api/github/activity', (req, res) => {
  res.json({ activity: githubTracker.recentActivity(Number(req.query.limit) || 50) });
});

app.get('/api/github/repos', (req, res) => {
  try { res.json(githubTracker.loadRegistry()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/github/versions', async (req, res) => {
  try { res.json({ repo: String(req.query.repo || ''), versions: await githubTracker.listVersions(String(req.query.repo || '')) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/github/versions/show', async (req, res) => {
  try { res.json(await githubTracker.showVersion(String(req.query.repo || ''), String(req.query.tag || ''))); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Rollback convenience: NEW branch from a tag — never a force-reset.
app.post('/api/github/checkout-version', async (req, res) => {
  try { res.json(await githubTracker.checkoutVersion(String(req.body?.repo || ''), String(req.body?.tag || ''))); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Manual tracking trigger for a working directory (dashboard button / MCP).
app.post('/api/github/track', async (req, res) => {
  const { runId, kind, user, prompt, cwd, intent } = req.body || {};
  try {
    res.json(await githubTracker.trackRun({
      runId: runId || `manual_${Date.now().toString(36)}`,
      kind: kind || 'manual', user: user || null,
      prompt: prompt || intent || '', cwd, intent,
    }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Provision the full automation stack into a repo in one action (draft PR).
app.post('/api/github/onboard', async (req, res) => {
  try { res.json(await githubOnboard.onboardRepo({ name: req.body?.name, path: req.body?.path })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/github/upgrade-repos', async (req, res) => {
  try { res.json(await githubOnboard.upgradeRepos()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});


// ---- Agent registry (AI providers with routing tags) -------------------
app.get('/api/agents', (req, res) => {
  const cfg = loadConfig();
  const agents = Object.entries(cfg)
    .filter(([kind, entry]) => isAiProviderEntry(kind, entry))
    .map(([kind, entry]) => agentSummary(kind, entry));
  res.json({ agents, readinessCheckedAt: lastDiagnostics ? new Date(lastDiagnostics.at).toISOString() : null });
});

app.post('/api/agents/:id/tags', (req, res) => {
  const kind = String(req.params.id || '');
  const cfg = loadConfig();
  const entry = cfg[kind];
  if (!entry || typeof entry !== 'object' || (!isAiProviderEntry(kind, entry) && kind !== 'powershell')) {
    return res.status(404).json({ error: 'unknown provider: ' + kind });
  }
  let tags;
  try {
    tags = normalizeProviderTags((req.body || {}).tags);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  try {
    entry.tags = tags;
    saveConfig(cfg);
  } catch (err) {
    return res.status(500).json({ error: 'could not persist tags: ' + err.message });
  }
  res.json({ ok: true, id: kind, tags });
});

// ---- Broadcast: one prompt, many providers ------------------------------
// Fans the same prompt through executeOneShot for every resolved target, so
// admission caps, per-provider limits, receipts, and output cleaning behave
// exactly like /api/oneshot. Members that hit the global concurrency cap are
// queued (bounded retry on admission_limit) instead of failing.
app.post('/api/broadcast', async (req, res) => {
  const {
    prompt, tag, providers, all, dangerous, timeoutMs = TIMEOUT_POLICY.oneShotDefaultMs, cwd,
    providerBudget, effort, maxEffortOverride,
  } = req.body || {};
  const effectiveTimeoutMs = TIMEOUT_POLICY.normalizeOneShotTimeoutMs(timeoutMs);
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'non-empty prompt required' });
  }
  let validatedProviderBudget;
  try {
    validatedProviderBudget = validateProviderBudget(providerBudget);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const { classifyTask } = await import('./mcp/router.mjs');
  const cfg = loadConfig();
  let targets;
  try {
    targets = resolveBroadcastTargets(cfg, { providers, tag, all, dangerous: dangerous === true });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!targets.length) {
    return res.status(400).json({
      error: 'no matching broadcast targets; pass providers, a tag that AI providers carry, or all:true (opt-in autoRoute:false seats must be named explicitly)',
      tag: typeof tag === 'string' ? tag : null,
    });
  }
  const startedAt = Date.now();
  const budgetTaskTier = classifyTask(prompt).tier;
  const deadlineAt = startedAt + effectiveTimeoutMs;
  const queueDeadline = Math.min(deadlineAt, startedAt + TIMEOUT_POLICY.broadcastQueueWaitMs);
  const activeCaptured = new Set();
  let clientGone = false;
  res.once('close', () => {
    if (res.writableEnded) return;
    clientGone = true;
    for (const captured of activeCaptured) captured.cancel();
  });
  let run = writeBroadcastRun({
    mode: 'broadcast',
    status: 'running',
    promptHash: crypto.createHash('sha256').update(prompt).digest('hex'),
    promptChars: prompt.length,
    selection: { tag: typeof tag === 'string' ? tag : null, all: all === true, explicitProviders: Array.isArray(providers) ? providers : [] },
    targets,
    members: [],
    deadlineAt: new Date(deadlineAt).toISOString(),
    timeoutMs: effectiveTimeoutMs,
  });
  const callOnce = async (kind) => {
    if (clientGone || res.destroyed) {
      return { statusCode: 499, body: { error: 'broadcast client disconnected', dropped_out: true, cancelled: true } };
    }
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs < TIMEOUT_POLICY.minimumMs) {
      return { statusCode: 408, body: { error: 'broadcast deadline exceeded', dropped_out: true, timed_out: true } };
    }
    const captured = new CapturedOneShotResponse();
    activeCaptured.add(captured);
    executeOneShot({
      kind, prompt, timeoutMs: remainingMs, cwd, dangerous,
      providerBudget: validatedProviderBudget, budgetTaskTier,
      taskTier: budgetTaskTier, modelTier: modelTierForTaskTier(budgetTaskTier),
      effort, maxEffortOverride,
    }, captured)
      .catch((err) => captured.status(500).json({ error: err.message, dropped_out: true }));
    try { return await captured.done; }
    finally { activeCaptured.delete(captured); }
  };
  const results = await Promise.all(targets.map(async (kind) => {
    const memberStartedAt = Date.now();
    let response = await callOnce(kind);
    while (
      response.statusCode === 429 &&
      response.body?.failureClass === 'admission_limit' &&
      Date.now() < queueDeadline &&
      Date.now() < deadlineAt &&
      !clientGone &&
      !res.destroyed
    ) {
      await new Promise((resolve) => setTimeout(resolve, 400 + Math.floor(Math.random() * 400)));
      response = await callOnce(kind);
    }
    const body = response.body || {};
    const ok = response.statusCode === 200 && body.exitCode === 0 && !body.dropped_out;
    return {
      provider: kind,
      label: cfg[kind]?.label || kind,
      ok,
      output: String(body.stdout || ''),
      error: ok ? null : String(body.error || body.stderr || (body.timed_out ? 'timed out' : '') || `provider dropped out (HTTP ${response.statusCode})`).slice(0, 4000),
      durationMs: Date.now() - memberStartedAt,
      exitCode: body.exitCode ?? null,
      timedOut: !!body.timed_out,
      receiptId: body.receiptId || null,
    };
  }));
  run = writeBroadcastRun({
    ...run,
    status: clientGone ? 'cancelled'
      : results.every((member) => member.ok) ? 'completed'
        : results.some((member) => member.ok) ? 'partial'
          : results.some((member) => member.timedOut) ? 'timed_out' : 'failed',
    members: results.map((member) => ({ kind: member.provider, role: 'broadcast', exitCode: member.exitCode, droppedOut: !member.ok, durationMs: member.durationMs, receiptId: member.receiptId })),
    durationMs: Date.now() - startedAt,
  });
  if (res.writableEnded || res.destroyed) return;
  res.json({
    targets,
    results,
    runId: run.runId,
    status: run.status,
    timeoutMs: effectiveTimeoutMs,
    deadlineAt: new Date(deadlineAt).toISOString(),
  });
});


// Install one CLI by its kind. Providers may use npm, Python/pip, or an exact
// vendor-supplied command (Antigravity). Nothing runs until the user confirms
// the Install dialog in the local UI.
app.post('/api/install', (req, res) => {
  const { kind } = req.body || {};
  if (!kind) return res.status(400).json({ error: 'kind required' });
  const cfg = loadConfig();
  const entry = cfg[kind];
  if (!entry) return res.status(400).json({ error: 'unknown kind: ' + kind });
  let slot;
  let pkg = entry.npm_package || entry.pip_package || null;
  if (Array.isArray(entry.install_command) && entry.install_command.length) {
    slot = resolveSlot(entry.install_command);
  } else if (entry.npm_package) {
    slot = ['npm', 'install', '-g', entry.npm_package];
  } else if (entry.pip_package) {
    let python = process.platform === 'win32' ? resolveExecutable('py.exe') : resolveExecutable('python3');
    if (process.platform === 'win32' && python === 'py.exe') python = resolveExecutable('python.exe');
    slot = [python, '-m', 'pip', 'install', '--user', '--upgrade', entry.pip_package];
  } else {
    return res.status(400).json({ error: 'no installer configured for ' + kind, skipped: true });
  }
  const env = buildEnv();
  const [configuredBinary, ...configuredArgs] = slot;
  const resolvedBinary = resolveExecutable(configuredBinary, env);
  const isWindowsShim = process.platform === 'win32' && !/\.exe$/i.test(resolvedBinary);
  const spawnBinary = isWindowsShim ? (process.env.ComSpec || 'cmd.exe') : resolvedBinary;
  const spawnArgs = isWindowsShim
    ? ['/d', '/s', '/c', [resolvedBinary, ...configuredArgs].map(quoteCmdArg).join(' ')]
    : configuredArgs;
  let installCwd;
  try { installCwd = defaultAllowedCwd(); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  const proc = trackChild(spawn(spawnBinary, spawnArgs, {
    cwd: installCwd,
    env,
    windowsHide: true,
    // npm/pip fan out into their own children; group-kill them when the
    // 5-minute cap fires instead of leaving a half-finished install running.
    detached: process.platform !== 'win32',
  }));
  let stdout = '';
  let stderr = '';
  let settled = false;
  const t = setTimeout(() => killProcessTree(proc), 300000); // 5 min cap
  res.on('close', () => { if (!res.writableEnded) killProcessTree(proc); });
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (d) => { stdout += d; });
  proc.stderr.on('data', (d) => { stderr += d; });
  proc.on('error', (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(t);
    res.json({ kind, package: pkg, installer: entry.install_display, success: false, exitCode: -1, stdout, stderr: stderr + '\n' + err.message });
  });
  proc.on('close', (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(t);
    // An install is the one event that makes a PATH lookup stale on purpose:
    // the seat the caller just installed must not stay "not installed" for the
    // rest of the memo's TTL.
    executableCache.clear();
    res.json({ kind, package: pkg, installer: entry.install_display, success: code === 0, exitCode: code, stdout, stderr });
  });
});


// Open a URL in the user's default browser. Used by the Collab pane's
// "Ask Perplexity (browser)" button â€” lets you use your existing Perplexity
// session/Pro subscription without spending API credits. The browser tab
// shows the answer; you copy it into the Collab's Shared Context box.
// Localhost-only server, only http(s) URLs allowed.
app.post('/api/open-url', (req, res) => {
  const { browser = 'default' } = req.body || {};
  let url;
  try { url = validateBrowserUrl(req.body?.url); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const plat = platform.detectPlatform();
  // Openers to try, in order. A spawn ENOENT is an ASYNC 'error' event, not a
  // throw, so the try/catch below cannot see it — an unhandled 'error' on a
  // ChildProcess takes the whole bridge down. Every candidate gets a handler
  // and we fall through to the next one instead.
  //
  // On WSL a Linux-side xdg-open cannot reach the user's Windows browser even
  // when xdg-utils is installed, so interop openers come first there.
  let openers;
  try { openers = browserOpeners(browser, plat, url); }
  catch (error) { return res.status(400).json({ error: error.message }); }

  let replied = false;
  const reply = (fn) => { if (replied) return; replied = true; fn(); };

  const tryOpener = (i) => {
    if (i >= openers.length) {
      return reply(() => res.status(501).json({
        error: `no ${browser} browser opener available on ${plat.label} (tried: ${openers.map((entry) => entry.bin).join(', ')})`,
        hint: plat.isWSL
          ? 'install wslu for wslview, or open the URL manually'
          : 'install xdg-utils, or open the URL manually',
        url,
      }));
    }
    const { bin, args } = openers[i];
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, detached: true, stdio: 'ignore' });
    } catch (err) {
      return tryOpener(i + 1); // synchronous failure (e.g. EACCES on the path)
    }
    child.on('error', () => { tryOpener(i + 1); });
    child.on('spawn', () => {
      child.unref();
      reply(() => res.json({ ok: true, url, browser, opener: bin }));
    });
  };
  tryOpener(0);
});


// ---- Collab persistence endpoints ----
app.get('/api/collabs', (req, res) => {
  res.json({ collabs: listCollabs() });
});
app.post('/api/collabs', (req, res) => {
  const { name, project, participants } = req.body || {};
  const id = newCollabId();
  const data = writeCollab(id, {
    name: name || '',
    project: project || '',
    participants: Array.isArray(participants) ? participants : [],
    transcript: [],
    sharedContext: '',
    dropped: [],
  });
  res.json(data);
});
app.get('/api/collabs/:id', (req, res) => {
  try {
    const data = readCollab(req.params.id);
    if (!data) return res.status(404).json({ error: 'not found' });
    res.json(data);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
app.put('/api/collabs/:id', (req, res) => {
  try {
    const existing = readCollab(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    const merged = { ...existing, ...(req.body || {}) };
    const data = writeCollab(req.params.id, merged);
    res.json({ ok: true, updatedAt: data.updatedAt });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
app.delete('/api/collabs/:id', (req, res) => {
  try {
    deleteCollab(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
app.get('/api/projects', (req, res) => {
  res.json({ projects: listProjects() });
});
app.get('/api/activity', (req, res) => {
  try { res.json(listAgentActivity(req.query.limit)); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/projects', (req, res) => {
  const name = (req.body && req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  res.json({ projects: addProject(name) });
});

// MCP adapters are separate processes, so they can request a graceful stop,
// wait for the singleton bridge to release its port, and start the new build.
// The capability-token middleware protects this destructive endpoint.
app.post('/api/admin/shutdown', (req, res) => {
  res.json({ ok: true, stopping: true, pid: process.pid, instanceId: INSTANCE_ID });
  setTimeout(shutdown, 100);
});

// Full restart: reply first, then hand off to the detached restart.ps1 helper,
// which waits for this PID to release the port and relaunches server.js. The
// helper only exists for Windows; other platforms report 501 instead of
// killing the process without a relauncher.
app.post('/api/admin/restart', (req, res) => {
  if (process.platform !== 'win32') {
    return res.status(501).json({ ok: false, restarting: false, error: 'restart helper is Windows-only; stop and start the bridge manually', platform: process.platform });
  }
  res.json({ ok: true, restarting: true, pid: process.pid, instanceId: INSTANCE_ID });
  setTimeout(() => {
    try {
      const helper = spawn('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', path.join(ROOT, 'restart.ps1'),
        '-TargetPid', String(process.pid),
        '-Port', String(PORT),
      ], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
      helper.unref();
    } catch (err) {
      console.warn('[RelayBridge] restart helper failed to launch: ' + err.message);
    }
  }, 100);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  // Same DNS-rebinding guard as the HTTP middleware, applied before the URL
  // parse: a rebound page's socket really is loopback and only its Host names
  // the attacker. Parsing an arbitrary Host into the base URL also throws for a
  // malformed value, and a throw in this event handler costs the whole bridge.
  const host = String(req.headers.host || '').toLowerCase();
  if (host && !ALLOWED_HOSTS.has(host)) {
    ws.close(1008, 'unauthorized');
    return;
  }
  const url = new URL(req.url, `http://${host || `${HOST}:${PORT}`}`);
  const origin = req.headers.origin;
  const token = url.searchParams.get('token');
  if ((origin && !ALLOWED_ORIGINS.has(origin)) || !tokenMatches(token)) {
    ws.send(JSON.stringify({ type: 'error', error: 'bridge capability token required' }));
    ws.close(1008, 'unauthorized');
    return;
  }
  const id = url.searchParams.get('session');
  const session = sessions.get(id);
  if (!session) {
    ws.send(JSON.stringify({ type: 'error', error: 'session not found' }));
    ws.close();
    return;
  }
  session.attach(ws);
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.type === 'input') session.write(msg.data || '');
      else if (msg.type === 'resize') session.resize(msg.cols || 120, msg.rows || 30);
    } catch {}
  });
  ws.on('close', () => session.detach(ws));
});

// ---- Remote MCP endpoint (connector transport) --------------------------
// Off unless RELAYBRIDGE_REMOTE_MCP=1. Reuses the stdio adapter's buildServer()
// so both transports always expose the same tools, minus the terminal/exec
// tools which are never remotely reachable. See docs/CONNECTOR.md.
// mcp/server.mjs is ESM. require() of ESM only works on Node >=22.12, and
// package.json allows >=20.3, so the module is loaded with dynamic import and
// the route is mounted once it resolves. Express accepts routes added after
// listen(), so this costs nothing and works on every supported Node.
let remoteMcpStatus = { enabled: false, reason: 'initializing' };
(async () => {
  try {
    const { mountRemoteMcp } = require('./lib/remote-mcp');
    const mcpModule = await import('./mcp/server.mjs');
    remoteMcpStatus = mountRemoteMcp(app, {
      token: CAPABILITY_TOKEN,
      buildServer: () => mcpModule.buildServer(),
      log: (m) => console.log(m),
    });
  } catch (err) {
    remoteMcpStatus = { enabled: false, reason: err.message };
  }
})();
app.get('/api/remote-mcp/status', (req, res) => res.json(remoteMcpStatus));

// Terminal error handler. Without one, Express's finalhandler answers with
// err.stack whenever NODE_ENV is unset — and express.json() runs ahead of the
// /api token gate, so an UNAUTHENTICATED malformed body returned the absolute
// checkout path, the Node version and the whole dependency layout in an HTML
// 400. Log the stack locally, and answer with the message only when the error
// marks itself safe to expose (body-parser's 400s do; a thrown handler bug
// does not). Registered last because Express only reaches an error handler
// that sits after the layer that failed; the remote-MCP route is mounted
// asynchronously after this point and carries its own try/catch. The unused
// 4th parameter is load-bearing: arity is how Express recognizes this as an
// error handler rather than ordinary middleware.
app.use((err, req, res, next) => {
  console.error('[RelayBridge] request failed: ' + (err && err.stack ? err.stack : err));
  if (res.headersSent) return next(err);
  const status = Number(err && (err.status || err.statusCode)) || 500;
  res.status(status >= 400 && status <= 599 ? status : 500)
    .json({ error: err && err.expose && err.message ? err.message : 'request failed' });
});


server.listen(PORT, HOST, () => {
  console.log(`[RelayBridge] listening on http://${HOST}:${PORT}`);
  console.log(`[RelayBridge] open the URL above in Chrome.`);
  console.log(`[RelayBridge] full permissions: ${state.fullPermissions ? 'ON' : 'off'} (toggle in UI)`);
  // Model discovery runs after listen and never blocks it.
  loadCachedRegistry();
  const modelGlobals = loadConfig()._models || {};
  if (modelGlobals.discoverOnBoot !== false) {
    const maxAge = Number(modelGlobals.discoveryMaxAgeMs) > 0 ? Number(modelGlobals.discoveryMaxAgeMs) : 86400000;
    const cachedAge = modelRegistry?.generatedAt ? Date.now() - Date.parse(modelRegistry.generatedAt) : Infinity;
    if (!(cachedAge < maxAge)) {
      discoverModels().catch((err) => console.warn('[RelayBridge] model discovery failed: ' + err.message));
    } else {
      console.log(`[RelayBridge] model registry loaded from cache (${Math.round(cachedAge / 3600000)}h old)`);
    }
  }
  // Optional readiness warm-up, OFF by default.
  //
  // Why it exists: the router penalises a seat it knows is down by -10000, but
  // readinessFor() yields null when nothing has been probed yet, and null is
  // neutral — so on a bridge nobody has opened the dashboard against, a dead
  // seat is fully selectable. That is the normal case for a headless / MCP-only
  // deployment, which is exactly where a silent route to a dead provider is
  // hardest to notice.
  //
  // Why it is not the default: a readiness sweep spawns one process per
  // provider (the same reason /api/auth/status only probes on demand), and
  // those probes occupy one-shot admission slots, so a bridge that warms on
  // boot reports a non-zero activeOneShotCount for its first seconds — the
  // metric operators watch as the canary for slot leaks. Opt in on headless
  // deployments; leave it off where a dashboard will populate readiness anyway.
  if (String(process.env.RELAYBRIDGE_WARM_DIAG || '') === '1') {
    setTimeout(() => {
      const req = http.request({
        host: HOST, port: PORT, path: '/api/diag', method: 'GET',
        headers: { 'X-RelayBridge-Token': CAPABILITY_TOKEN },
      }, (resp) => {
        resp.resume();
        resp.on('end', () => {
          const n = lastDiagnostics?.results
            ? Object.values(lastDiagnostics.results).filter((r) => r && r.ready).length
            : 0;
          if (lastDiagnostics) console.log(`[RelayBridge] readiness warmed — ${n} seat(s) ready`);
        });
      });
      req.on('error', (err) => console.warn('[RelayBridge] readiness warm-up skipped: ' + err.message));
      req.end();
    }, 250).unref();
  }
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[RelayBridge] shutting downâ€¦');
  for (const s of sessions.values()) s.kill();
  for (const proc of activeChildren) killProcessTree(proc);
  for (const client of wss.clients) {
    try { client.close(1001, 'bridge restarting'); } catch {}
  }
  try { wss.close(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Last-resort backstop. This bridge holds every live PTY session, every
// in-flight provider run and the background task queue in one process, so a
// stray throw from an EventEmitter callback — where Express cannot catch it —
// costs far more than the bad request that triggered it. Three such paths were
// found and fixed above (/api/exec, /api/open-url, pipe-mode stdin); this
// catches the fourth nobody has found yet.
//
// Deliberately NOT a silent swallow: it logs the full stack so the defect stays
// visible and reportable, and it does not re-enter shutdown().
process.on('uncaughtException', (err) => {
  console.error('[RelayBridge] uncaught exception — staying up:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[RelayBridge] unhandled rejection — staying up:', reason && reason.stack ? reason.stack : reason);
});
