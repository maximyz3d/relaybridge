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
const { resolveModelArgs, applyModelArgs, modelConfigStaleness, modelTierForTaskTier } = require('./lib/model-tiers');
const { buildRegistry, parseModelList, pinIsRetired } = require('./lib/model-registry');
const { buildTaskPlan, EFFORT_ORDER, costClassFor } = require('./lib/task-plan');
const { buildQuotaSeatGroups } = require('./lib/quota-seat');
const { providerUsageCapability, providerUsageCapabilities } = require('./lib/provider-usage-capability');
const { receiptStoreIdentity } = require('./lib/receipt-store-identity.cjs');
const {
  resolveFilesystemPolicy, providerFilesystemEligibility,
  createIsolatedProviderHome, cleanupIsolatedProviderHome,
} = require('./lib/provider-filesystem-policy');
const { WebSocketServer } = require('ws');
const { spawn, spawnSync } = require('child_process');
const TIMEOUT_POLICY = require('./timeout-policy.cjs');
const ROOT = __dirname;
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

function hardenTokenFileAcl(filePath) {
  if (process.platform !== 'win32') return { platform: process.platform, applicable: false, hardened: null, detail: 'POSIX mode bits already restrict this file' };
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
  ? ALLOWED_ROOTS_VALUE.split(';')
  : [process.env.USERPROFILE || ROOT, ROOT])
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
  const preferred = path.resolve(process.env.USERPROFILE || ROOT);
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
  const userProfile = path.resolve(process.env.USERPROFILE || ROOT);
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
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      fullPermissions: envFirst('RELAYBRIDGE_ALLOW_STICKY_DANGEROUS', 'PS_BRIDGE_ALLOW_STICKY_DANGEROUS') === '1' && saved.fullPermissions === true,
    };
  } catch {
    return { fullPermissions: false };
  }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
let state = loadState();

// ---- Persistent collabs (group chats) + projects -----------------------
const DATA_DIR = path.resolve(envFirst('RELAYBRIDGE_DATA_DIR', 'PS_BRIDGE_DATA_DIR') || path.join(ROOT, 'data'));
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
      ? 'provider_reported' : 'chars_div_4';
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
    requestId: route?.request_id || null,
    modelUsage: Array.isArray(usage?.model_usage) ? usage.model_usage : [],
    vendorQuota: payload.vendor_quota || null,
    quotaEvidence: payload.quota_evidence || null,
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
    durationMs: Date.now() - startedAt,
    failureClass: payload.cancelled ? 'cancelled'
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
  const classified = classifyRunFailure({
    provider: meta?.kind,
    prompt: meta?.prompt,
    stdout: payload.stdout,
    transportStdout: meta?.transportStdout,
    stderr: payload.stderr,
    exitCode: payload.exitCode,
    elapsedMs: meta?.startedAt ? Date.now() - meta.startedAt : 0,
    stopReason: payload.stop_reason,
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
      const failureKind = payload.rate_limited ? 'rate_limited'
        : payload.auth_failed ? 'auth_failed'
        : payload.failureClass || (classified.kind !== 'ok' ? classified.kind : null);
      if (failureKind === 'rate_limited') {
        const vendorQuota = parseGrokQuota429({
          provider: meta.kind,
          rateLimited: payload.rate_limited,
          failureClass: payload.failureClass,
          text: `${payload.stdout || ''}\n${payload.stderr || ''}`,
          model: payload.route?.resolved_model_identity || payload.model || null,
        });
        if (vendorQuota) payload.vendor_quota = usageLedger.observeVendorQuota(vendorQuota);
      }
      recordRunUsage({
        kind: meta.kind, route: payload.route || meta.route, usage: payload.usage,
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
        const quotaSeat = quotaSeatForProvider(meta.kind);
        if (ok) {
          cooldowns.noteSuccess(quotaSeat);
          if (quotaSeat !== meta.kind) cooldowns.noteSuccess(meta.kind);
        }
        else if (failureKind) {
          // An explicitly model-scoped vendor observation must not cool every
          // model on the account. Generic 429/overload evidence has no narrower
          // scope, so it conservatively applies to the shared quota seat.
          const cooldownSeat = payload.vendor_quota?.scope === 'model' ? meta.kind : quotaSeat;
          cooldowns.noteFailure(cooldownSeat, failureKind, {
            retryAfterSec: parseRetryAfter(`${payload.stdout || ''}\n${payload.stderr || ''}`, payload.retry_after),
            scope: payload.vendor_quota?.scope === 'model' ? 'model' : 'account',
          });
        }
      } catch { /* cooldown bookkeeping must never break a response */ }
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
      path.join(process.env.USERPROFILE || '', '.local', 'bin'),
      path.join(process.env.USERPROFILE || '', '.cursor', 'bin'),
      path.join(process.env.APPDATA || '', 'npm'),
      path.join(process.env.LOCALAPPDATA || '', 'npm'),
      path.join(process.env.LOCALAPPDATA || '', 'RelayBridge', 'tools', 'perplexity-web-mcp', '.venv', 'Scripts'),
    ].filter((p) => p && fs.existsSync(p));
    const preferred = new Set(candidates.map((p) => p.toLowerCase()));
    const remaining = cur.split(';').filter((p) => p && !preferred.has(p.toLowerCase()));
    env[pathKey] = [...candidates, ...remaining].join(';');
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

function resolveExecutable(command, env = buildEnv()) {
  if (!command || process.platform !== 'win32') return command;
  if (path.isAbsolute(command)) return command;
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'Path';
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

function validateProviderBudgetRequest(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('providerBudget must be an object');
  const allowed = new Set(['maxOutputTokens', 'maxTotalTokens', 'maxCacheReadTokens', 'maxCacheCreationTokens', 'maxTurns']);
  for (const [key, candidate] of Object.entries(value)) {
    if (!allowed.has(key)) throw new Error(`unknown providerBudget field: ${key}`);
    if (candidate !== null && (!Number.isSafeInteger(candidate) || candidate <= 0)) {
      throw new Error(`providerBudget.${key} must be a positive safe integer or null`);
    }
  }
  // Keep the validated request sparse. resolveSupervisorOptions performs the
  // precedence merge; eagerly filling defaults here would erase provider-
  // specific limits whenever a caller overrides only one dimension.
  return { ...value };
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

function claudeApiStatusFailureClass(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status === 402) return 'budget';
  return status === null ? null : 'provider_error';
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
        : claudeApiStatusFailureClass(apiErrorStatus)
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
      parseError: null,
    };
  } catch (error) {
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
      parseError: `claude_json parse failed: ${error.message}`,
    };
  }
}

function ollamaManifestIdentity(entry) {
  if (entry?.transport !== 'local:ollama' || !entry.model || !process.env.USERPROFILE) return null;
  const match = /^([A-Za-z0-9._-]+)(?::([A-Za-z0-9._-]+))?$/.exec(String(entry.model));
  if (!match) return null;
  const manifestPath = path.join(
    process.env.USERPROFILE,
    '.ollama', 'models', 'manifests', 'registry.ollama.ai', 'library',
    match[1], match[2] || 'latest',
  );
  try {
    const bytes = fs.readFileSync(manifestPath);
    return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  } catch {
    return null;
  }
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
  throw new Error(`hosted provider key is not set; define ${names[0] || 'the configured API key environment variable'}`);
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

async function runOpenAIChatOneShot({ entry, prompt, timeoutMs, res, route, startedAt, providerBudget }) {
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
      if (!clientGone && !res.writableEnded) {
        sendOneShotResult(res, {
          kind: route.provider,
          route,
          exitCode: response.status,
          stdout: '',
          stderr: detail,
          rate_limited: response.status === 429,
          budget_exceeded: /budget|credit|quota/i.test(detail),
          auth_failed: response.status === 401 || response.status === 403,
          timed_out: isUpstreamTimeoutStatus(response.status),
          dropped_out: true,
          model_invocation: rejectedHttpModelInvocation(response.status),
        }, { kind: route.provider, prompt, route, startedAt });
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
      }, { kind: route.provider, prompt, route, startedAt });
    }
  } catch (error) {
    if (!clientGone && !res.writableEnded) {
      sendOneShotResult(res, {
        kind: route.provider,
        route,
        exitCode: -1,
        stdout: '',
        stderr: cleanOutput(error?.message || String(error)),
        auth_failed: /key is not set|401|403/i.test(error?.message || ''),
        timed_out: timedOut,
        dropped_out: true,
        model_invocation: requestStarted ? null : false,
      }, { kind: route.provider, prompt, route, startedAt });
    }
  } finally {
    clearTimeout(timer);
  }
}

async function runOllamaApiOneShot({ entry, prompt, timeoutMs, res, route, startedAt, providerBudget }) {
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
        }, { kind: route.provider, prompt, route, startedAt });
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
      }, { kind: route.provider, prompt, route, startedAt });
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
      }, { kind: route.provider, prompt, route, startedAt });
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
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.unref();
    } else {
      proc.kill('SIGTERM');
    }
  } catch {
    try { proc.kill(); } catch {}
  }
}

// ---- session management ----
const sessions = new Map(); // id -> Session

// Live provider runs, keyed by runId, so a human (or the dashboard) can vet
// whether a quiet run is working or wedged instead of guessing.
const activeRuns = new Map();


// What each provider can actually run, discovered at boot. Configured pins rot,
// and a retired pin fails every call to that provider, so the bridge asks each
// CLI for its own list and reports pins that no longer appear in it.
let modelRegistry = null;
let discoveryInFlight = null;
const MODEL_REGISTRY_FILE = path.join(DATA_DIR, 'model-registry.json');

// Cumulative CPU milliseconds for a process tree. This separates "the model is
// thinking and has not printed yet" from "the stage is wedged": print-mode CLIs
// buffer their whole answer, so silence alone proves nothing. Best effort â€”
// resolves null when it cannot be read.
function sampleTreeCpuMs(rootPid) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !rootPid) return resolve(null);
    const script = [
      "$ErrorActionPreference='SilentlyContinue';",
      `$root=${Number(rootPid)};`,
      '$all=Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,KernelModeTime,UserModeTime;',
      'if(-not $all){exit 0};',
      '$byId=@{};foreach($p in $all){$byId[[int]$p.ProcessId]=$p};',
      '$kids=@{};foreach($p in $all){$k=[int]$p.ParentProcessId;if(-not $kids.ContainsKey($k)){$kids[$k]=@()};$kids[$k]+=[int]$p.ProcessId};',
      '$stack=New-Object System.Collections.Stack;$stack.Push($root);$seen=@{};$total=0.0;',
      'while($stack.Count -gt 0){$cur=[int]$stack.Pop();if($seen.ContainsKey($cur)){continue};$seen[$cur]=$true;',
      '$proc=$byId[$cur];if($proc){$total+=([double]$proc.KernelModeTime+[double]$proc.UserModeTime)/10000.0};',
      'if($kids.ContainsKey($cur)){foreach($c in $kids[$cur]){$stack.Push($c)}}};',
      '[math]::Round($total)',
    ].join('');
    let done = false;
    let out = '';
    let child;
    const finish = (value) => { if (done) return; done = true; try { child?.kill(); } catch {} resolve(value); };
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    } catch { return resolve(null); }
    const guard = setTimeout(() => finish(null), 8000);
    if (typeof guard.unref === 'function') guard.unref();
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(guard); finish(null); });
    child.on('close', () => {
      clearTimeout(guard);
      const parsed = Number(String(out).trim());
      finish(Number.isFinite(parsed) ? parsed : null);
    });
  });
}

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
    this.cwd = cwd || process.env.USERPROFILE || ROOT;
    this.buffer = []; // ring buffer of recent output
    this.bufferMax = 2000; // lines
    this.clients = new Set(); // WebSocket clients
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
    });
    this._mode = 'pipe';
    this.proc.stdout.on('data', (d) => this._onData(d.toString('utf8')));
    this.proc.stderr.on('data', (d) => this._onData(d.toString('utf8')));
    this.proc.on('close', (code) => this._onExit(code));
    this.proc.on('error', (err) => {
      this._onData(`\r\n[RelayBridge] spawn error: ${err.message}\r\n`);
      this._onExit(-1);
    });
  }

  _onData(text) {
    this.buffer.push(text);
    if (this.buffer.length > this.bufferMax) {
      this.buffer.splice(0, this.buffer.length - this.bufferMax);
    }
    for (const ws of this.clients) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data: text }));
    }
  }

  _onExit(code) {
    this.exited = true;
    this.exitCode = code;
    const msg = `\r\n[RelayBridge] process exited with code ${code}\r\n`;
    this.buffer.push(msg);
    for (const ws of this.clients) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'data', data: msg }));
        ws.send(JSON.stringify({ type: 'exit', code }));
      }
    }
  }

  write(input) {
    if (this.exited) return false;
    if (this._mode === 'pty') {
      this.proc.write(input);
    } else {
      this.proc.stdin.write(input);
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
  const entry = cfg[kind];
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
      proc = trackChild(spawn(spawnBinary, spawnArgs, { cwd: ROOT, env, windowsHide: true }));
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
      resolve({ exitCode, stdout, stderr: error ? stderr + '\n' + error.message : stderr, timedOut, aborted: !!signal?.aborted });
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
  const { task, effort, kind } = req.body || {};
  if (!task || typeof task !== 'string' || !task.trim()) {
    return res.status(400).json({ error: 'task (non-empty string) required' });
  }
  if (effort && !EFFORT_ORDER.includes(String(effort).toLowerCase())) {
    return res.status(400).json({ error: `effort must be one of: ${EFFORT_ORDER.join(', ')}` });
  }
  let filesystemAuthority;
  try { filesystemAuthority = planningFilesystemAuthority(req.body || {}); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    const router = await import('./mcp/router.mjs');
    const cfg = loadConfig();
    let diagnostics = lastDiagnostics?.results || null;
    if (!diagnostics) {
      const env = buildEnv();
      diagnostics = {};
      for (const k of Object.keys(cfg).filter((x) => !x.startsWith('_'))) {
        let found = false;
        try {
          const probeBin = (cfg[k].version_probe || cfg[k].probe || cfg[k].safe || [])[0];
          found = !!(probeBin && resolveExecutable(probeBin, env));
        } catch { found = false; }
        diagnostics[k] = { found, ready: found, detail: 'path-only check' };
      }
    }
    const fleetInput = applyCooldownsToDiagnostics(diagnostics, coolingQuotaStates(), kind ? [kind] : []);
    const filesystemInput = applyFilesystemEligibilityToDiagnostics(fleetInput.diagnostics, cfg, filesystemAuthority);
    diagnostics = filesystemInput.diagnostics;
    let route = router.routeTask({ task, diagnostics, dangerous: filesystemAuthority.dangerous });
    const gauges = usageLedger.gaugeAll(seatCostClasses());
    route = levelRouteSelection(route, gauges, seatCostClassMap());
    route.fleetState = {
      cooldownSkipped: fleetInput.skipped,
      balance: fleetBalance(gauges),
      vendorQuota: vendorQuotaFleet(gauges),
      operatorQuota: operatorQuotaFleet(gauges),
      quotaSeats: quotaSeatRegistry.groups,
      filesystemSkipped: filesystemInput.skipped,
      filesystemAuthority,
    };
    const plan = buildTaskPlan({
      route,
      config: cfg,
      registry: modelRegistry,
      resolveModelArgs,
      requestedEffort: effort || null,
      requestedKind: kind || null,
    });
    res.json({ ok: true, task: task.slice(0, 400), ...plan, fleetState: route.fleetState });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Delegation: classify a task, rank providers by tier, and pick the model
// weight class inside each. Advisory â€” it returns a plan, it does not dispatch.
app.post('/api/route', async (req, res) => {
  const { task, diagnostics: supplied, preferKinds, excludeKinds } = req.body || {};
  if (!task || typeof task !== 'string' || !task.trim()) {
    return res.status(400).json({ error: 'task (non-empty string) required' });
  }
  let filesystemAuthority;
  try { filesystemAuthority = planningFilesystemAuthority(req.body || {}); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    const router = await import('./mcp/router.mjs');
    const cfg = loadConfig();
    let diagnostics = supplied && typeof supplied === 'object' ? supplied : (lastDiagnostics?.results || null);
    if (!diagnostics) {
      const env = buildEnv();
      diagnostics = {};
      for (const kind of Object.keys(cfg).filter((k) => !k.startsWith('_'))) {
        const entry = cfg[kind];
        let found = false;
        try {
          const probeBin = (entry.version_probe || entry.probe || entry.safe || [])[0];
          found = !!(probeBin && resolveExecutable(probeBin, env));
        } catch { found = false; }
        diagnostics[kind] = { found, ready: found, detail: 'path-only check; run /api/diag for auth status' };
      }
    }
    const explicitKinds = Array.isArray(preferKinds) ? preferKinds : [];
    const fleetInput = applyCooldownsToDiagnostics(diagnostics, coolingQuotaStates(), explicitKinds);
    const filesystemInput = applyFilesystemEligibilityToDiagnostics(fleetInput.diagnostics, cfg, filesystemAuthority);
    diagnostics = filesystemInput.diagnostics;
    let route = router.routeTask({
      task, diagnostics,
      dangerous: filesystemAuthority.dangerous,
      preferredProviders: explicitKinds.length ? explicitKinds : undefined,
      excludedProviders: Array.isArray(excludeKinds) ? excludeKinds : undefined,
    });
    const gauges = usageLedger.gaugeAll(seatCostClasses());
    route = levelRouteSelection(route, gauges, seatCostClassMap());
    route.fleetState = {
      cooldownSkipped: fleetInput.skipped,
      balance: fleetBalance(gauges),
      vendorQuota: vendorQuotaFleet(gauges),
      operatorQuota: operatorQuotaFleet(gauges),
      quotaSeats: quotaSeatRegistry.groups,
      filesystemSkipped: filesystemInput.skipped,
      filesystemAuthority,
    };
    const taskTier = route.classification?.tier;
    const selected = (route.selected || []).map((pick) => {
      const resolved = resolveModelArgs({ entry: cfg[pick.kind] || {}, taskTier });
      const retired = resolved.model ? pinIsRetired(modelRegistry, pick.kind, resolved.model) : false;
      return {
        ...pick,
        modelTier: resolved.modelTier,
        model: retired ? null : resolved.model,
        modelArgs: retired ? [] : resolved.args,
        modelSource: retired ? 'account_default_retired_pin' : resolved.source,
        modelNote: retired ? `configured model "${resolved.model}" is no longer offered by this account` : resolved.note,
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
    if (!info || !info.found || info.ready) continue;
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
        if (!entry || !Array.isArray(entry.probe) || !entry.probe.length) return [kind, null];
        let found = false;
        try {
          const probeBin = (entry.version_probe || entry.probe || entry.safe || [])[0];
          found = !!(probeBin && resolveExecutable(probeBin, env));
        } catch { found = false; }
        if (!found) return [kind, { found: false, ready: false, detail: 'not installed' }];
        const result = await runProbe(entry.probe, Number(entry.probe_timeout_ms || 30000), entry.strip_env || []);
        return [kind, { found: true, ready: result.exitCode === 0, detail: result.exitCode === 0 ? 'authenticated' : (result.stderr || '').split('\n')[0].slice(0, 160) }];
      }));
      diagnostics = { at: Date.now(), results: Object.fromEntries(pairs.filter(([, v]) => v)) };
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
    const binary = entry.diagnostic_binary ||
      (entry.safe && entry.safe[0]) || (entry.dangerous && entry.dangerous[0]);
    if (!binary) return [kind, { binary: null, found: false, ready: false, paths: [], label: entry.label }];
    const resolved = resolveExecutable(binary, env);
    const found = resolved !== binary || path.isAbsolute(resolved) && fs.existsSync(resolved);
    let ready = found;
    let detail = '';
    let probeExitCode = null;
    if (found && Array.isArray(entry.probe) && entry.probe.length) {
      const probe = await runProbe(entry.probe, Number(entry.probe_timeout_ms || 30000), entry.strip_env || [], controller.signal);
      probeExitCode = probe.exitCode;
      ready = !probe.timedOut && probe.exitCode === 0;
      const probeText = cleanOutput([probe.stdout, probe.stderr].filter(Boolean).join('\n'));
      if (entry.probe_expect && !probeText.toLowerCase().includes(String(entry.probe_expect).toLowerCase())) ready = false;
      const probeReject = Array.isArray(entry.probe_reject) ? entry.probe_reject : [];
      if (probeReject.some((value) => probeText.toLowerCase().includes(String(value).toLowerCase()))) ready = false;
      detail = ready && entry.probe_success_detail
        ? String(entry.probe_success_detail).slice(0, 300)
        : (entry.probe_redact ? (ready ? 'readiness check passed' : 'readiness check failed') : probeText.split('\n')[0].slice(0, 300));
      if (probe.timedOut) detail = 'readiness check timed out';
      if (probe.aborted) detail = 'readiness check cancelled';
    }
    let runtimeVersion = '';
    if (!controller.signal.aborted && found && Array.isArray(entry.version_probe) && entry.version_probe.length) {
      const versionProbe = await runProbe(entry.version_probe, 15000, entry.strip_env || [], controller.signal);
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
      runtimeVersion,
      usageCapability: providerUsageCapability(entry, { runtimeVersion }),
    }];
  }));
  const rawResults = Object.fromEntries(pairs);
  const results = applyFilesystemEligibilityToDiagnostics(rawResults, cfg).diagnostics;
  if (!controller.signal.aborted) lastDiagnostics = { at: Date.now(), results };
  if (!clientGone && !res.writableEnded) res.json({ results });
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
app.post('/api/exec', (req, res) => {
  if (!isDirectLoopbackRequest(req)) {
    return res.status(403).json({ error: 'command execution is loopback-only' });
  }
  const { command, shell = 'powershell', timeoutMs = 60000, cwd } = req.body || {};
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: 'command (string) required' });
  }
  const exe = shell === 'pwsh' ? 'pwsh.exe' : 'powershell.exe';
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command];
  let execCwd;
  try { execCwd = resolveAllowedCwd(cwd); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  const proc = trackChild(spawn(exe, args, {
    cwd: execCwd,
    env: buildEnv(),
    windowsHide: true,
  }));
  let stdout = '';
  let stderr = '';
  const t = setTimeout(() => {
    killProcessTree(proc);
  }, timeoutMs);
  res.on('close', () => { if (!res.writableEnded) killProcessTree(proc); });
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (d) => { stdout += d; });
  proc.stderr.on('data', (d) => { stderr += d; });
  proc.on('close', (code) => {
    clearTimeout(t);
    res.json({ stdout, stderr, exitCode: code });
  });
  proc.on('error', (err) => {
    clearTimeout(t);
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
    requestedProviderBudget = validateProviderBudgetRequest(body?.providerBudget);
  } catch (err) {
    return rejectBeforeAdmission(400, 'validation', { error: err.message });
  }
  const requestedEffort = typeof body?.effort === 'string' ? body.effort.trim().toLowerCase() : null;
  if (requestedEffort && !['low', 'medium', 'high', 'max'].includes(requestedEffort)) {
    return rejectBeforeAdmission(400, 'validation', { error: 'effort must be low, medium, high, or max' });
  }
  if (requestedEffort === 'max' && body?.maxEffortOverride !== true) {
    return rejectBeforeAdmission(400, 'validation', {
      error: 'effort=max requires maxEffortOverride=true; RelayBridge never infers maximum effort',
    });
  }
  if (body?.maxEffortOverride === true && requestedEffort !== 'max') {
    return rejectBeforeAdmission(400, 'validation', { error: 'maxEffortOverride is valid only with effort=max' });
  }
  // Pre-flight auth gate. If the last readiness sweep saw this CLI installed but
  // signed out, the call would fail with an opaque provider error and the prompt
  // would be wasted. Report it as an actionable auth_required instead, so the
  // caller can open a sign-in terminal and retry. Only a *positive* signed-out
  // observation blocks: an unprobed provider is attempted as before.
  const readiness = lastDiagnostics?.results?.[kind];
  if (readiness && readiness.found && readiness.ready === false && Array.isArray(entry.login_command)) {
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
  if (requestedEffort) {
    const effortFlagIndex = slot.findIndex((arg) => arg === '--effort' || arg === '--reasoning-effort');
    if (effortFlagIndex < 0 || effortFlagIndex + 1 >= slot.length) {
      return rejectBeforeAdmission(400, 'validation', { error: `${kind} does not expose an explicit effort control` });
    }
    slot = [...slot];
    slot[effortFlagIndex + 1] = requestedEffort;
  }
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
  const childEnv = buildEnv({ ...oneShotEnv, ...(isolatedProviderHome?.env || {}) }, entry.strip_env || []);
  const resolvedBin = resolveExecutable(bin, childEnv);
  const flagValue = (name) => {
    const index = args.indexOf(name);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
  };
  // Return non-secret route metadata with every one-shot response.  This lets
  // committee callers prove which model/effort was requested instead of
  // guessing from a generic "Claude" label.
  const route = {
    provider: kind,
    transport: entry.transport || 'cli',
    configured_binary: bin,
    resolved_binary: resolvedBin,
    requested_model: flagValue('--model') || entry.model || null,
    resolved_model_identity: entry.model
      ? `${entry.model}${ollamaManifestIdentity(entry) ? `@${ollamaManifestIdentity(entry)}` : ''}`
      : null,
    requested_effort: flagValue('--effort') || flagValue('--reasoning-effort'),
    effort_explicit: !!requestedEffort,
    max_effort_override: requestedEffort === 'max' && body?.maxEffortOverride === true,
    effort_method: (flagValue('--effort') || flagValue('--reasoning-effort'))
      ? 'flag'
      : (modelChoice.model ? 'model_choice' : 'account_default'),
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
          kind, route, exitCode: -1, stdout: '', stderr: '', cancelled: true,
          timed_out: false, dropped_out: true, model_invocation: true,
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
    entry, globals: cfg._supervisor || {}, providerBudget: requestedProviderBudget,
  }).providerBudget;
  if (entry.oneshot_adapter === 'ollama_api') {
    cleanupPromptFile();
    return runOllamaApiOneShot({ entry, prompt, timeoutMs: adapterTimeoutMs, res, route, startedAt, providerBudget: resolvedProviderBudget });
  }
  if (entry.oneshot_adapter === 'openai_chat_api') {
    cleanupPromptFile();
    return runOpenAIChatOneShot({ entry, prompt, timeoutMs: adapterTimeoutMs, res, route, startedAt, providerBudget: resolvedProviderBudget });
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
    return sendOneShotResult(res, { kind, route, exitCode: -1, stdout: '', stderr: err.message, error: 'spawn failed', dropped_out: true, model_invocation: false }, { kind, prompt, route, startedAt, cwd: resolvedCwd });
  }
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let clientGone = false;
  let settled = false;
  res._relayCancellationPayload = () => {
    const parsedOutput = parseConfiguredOneShotOutput(entry, stdout);
    return {
      kind,
      route,
      exitCode: -1,
      stdout: parsedOutput.output,
      stderr: cleanOutput([stderr, parsedOutput.diagnostic, parsedOutput.parseError].filter(Boolean).join('\n')),
      usage: parsedOutput.usage,
      failureClass: parsedOutput.failureClass,
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
      transport_output_chars: String(stdout).length,
      transport_output_hash: crypto.createHash('sha256').update(String(stdout)).digest('hex'),
      cancelled: !timedOut,
      timed_out: timedOut,
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
    sendOneShotResult(res, { kind, route, exitCode: -1, stdout, stderr: stderr + '\n' + err.message, error: err.message, failureClass: isolationCleanup.ok ? null : 'isolation_cleanup', dropped_out: true }, { kind, prompt, route, startedAt, cwd: resolvedCwd });
  });
  proc.on('close', (code) => {
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
    // Word boundaries avoid false positives such as "deSIGN INtent" in a
    // perfectly valid model response.
    const auth_signals = [
      /\benoent\b/,
      /\bnot authenticated\b/,
      /\bnot logged in\b/,
      /\bplease log in\b/,
      /\bplease run \/login\b/,
      /\bsign in\b/,
      /\blogin required\b/,
      /\bauthentication required\b/,
      /\binvalid api key\b/,
      /\bauthentication[_ ]error\b/,
      /\boauth\b.{0,40}\b(?:revoked|expired)\b/,
    ];
    const authoritativeApiFailure = claudeApiStatusFailureClass(parsedOutput.apiErrorStatus);
    const copilotQuotaEvidence = detectCopilotMonthlyQuota({
      provider: kind,
      stdout: cleanedStdout,
      stderr,
      exitCode: code,
    });
    const rate_limited = parsedOutput.resultSubtype !== 'error_max_budget_usd'
      && (authoritativeApiFailure === 'rate_limit' || !!copilotQuotaEvidence
        || rate_signals.some(s => failureBlob.includes(s)));
    const budget_exceeded = parsedOutput.resultSubtype === 'error_max_budget_usd'
      || authoritativeApiFailure === 'budget'
      || budget_signals.some(s => failureBlob.includes(s));
    // Some CLIs report unrelated MCP authentication warnings on stderr even
    // after the selected provider completed successfully. Only classify the
    // provider route as unauthenticated when the command failed or produced no
    // usable answer.
    const auth_failed = authoritativeApiFailure === 'auth'
      || (auth_signals.some((pattern) => pattern.test(failureBlob))
        && (code !== 0 || !cleanedStdout || parsedOutput.isError));
    const permissionClassification = classifyRunFailure({
      provider: kind,
      prompt,
      stdout: cleanedStdout,
      stderr: cleanOutput([stderr, parsedOutput.diagnostic].filter(Boolean).join('\n')),
      exitCode: code,
    });
    const permission_denied = permissionClassification.kind === 'headless_command_permission_auto_denied';
    // Provider CLIs can enforce their own request deadline before RelayBridge's
    // progress supervisor fires. Promote only authoritative failed/no-answer
    // diagnostics; healthy model prose that discusses timeouts must remain a
    // successful response.
    const providerInternalTimedOut = (code !== 0 || !cleanedStdout || parsedOutput.isError)
      && hasProviderInternalTimeoutDiagnostic(failureBlob);
    const providerTimedOut = timedOut || authoritativeApiFailure === 'timeout' || providerInternalTimedOut;
    const tokenBudgetExceeded = stopReason === 'token_budget';
    const finalFailureClass = !isolationCleanup.ok ? 'isolation_cleanup'
      : tokenBudgetExceeded ? 'token_budget'
      : parsedOutput.resultSubtype === 'error_max_budget_usd' ? 'budget'
      : authoritativeApiFailure || (rate_limited ? 'rate_limit'
      : budget_exceeded ? 'budget'
        : auth_failed ? 'auth'
          : providerTimedOut ? 'timeout'
            : permission_denied ? 'policy'
              : parsedOutput.failureClass);
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
      quota_evidence: copilotQuotaEvidence,
      transport_output_chars: String(stdout).length,
      transport_output_hash: crypto.createHash('sha256').update(String(stdout)).digest('hex'),
      rate_limited,
      budget_exceeded,
      auth_failed,
      permission_denied,
      policy_reason: permission_denied ? permissionClassification.kind : null,
      policy_detail: permission_denied ? permissionClassification.detail : null,
      model: modelChoice.model,
      model_tier: modelChoice.modelTier,
      stop_reason: stopReason || (providerInternalTimedOut ? 'provider_internal_timeout' : null),
      supervisor_stop_reason: stopReason,
      provider_timeout_source: timedOut ? 'relay_supervisor'
        : authoritativeApiFailure === 'timeout' ? 'provider_api_status'
          : providerInternalTimedOut ? 'provider_cli_diagnostic' : null,
      stop_detail: stopDetail || (permission_denied ? permissionClassification.detail : ''),
      provider_budget: supervisor.snapshot().providerBudget,
      provider_budget_enforcement: tokenBudgetExceeded ? stopBudgetEnforcement
        : (supervisor.snapshot().providerUsagePhase === 'unavailable' ? 'unavailable' : supervisor.snapshot().providerUsagePhase),
      progress: supervisor.snapshot(),
      timed_out: providerTimedOut,
      dropped_out,
      model_invocation: true,
    }, { kind, prompt, route, startedAt, cwd: resolvedCwd, transportStdout: stdout });
    // GitHub middleware: only successful runs checkpoint — a dropped-out run
    // may have left half-applied edits, which the human should triage first.
    if (sentPayload && !sentPayload.dropped_out) {
      trackRunAfterResponse({ runId, kind, user: runUser, prompt, cwd: resolvedCwd, intent: runIntent });
    }
  });
  // Providers without a placeholder (Claude/Codex/Perplexity wrapper) read
  // stdin. Antigravity consumes {prompt}; Grok consumes {prompt_file}.
  if (promptTransport === 'stdin') {
    try { proc.stdin.write(effectivePrompt); proc.stdin.end(); } catch {}
  } else {
    try { proc.stdin.end(); } catch {}
  }
}

app.post('/api/oneshot', (req, res) => executeOneShot(req.body, res));

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

app.post('/api/tasks', (req, res) => {
  try { res.json(taskQueue.submit(req.body || {})); }
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

// ---- Usage ledger + fuel gauge (lib/usage-ledger.js) ---------------------
// Records every run's tokens, duration and shadow cost so the fleet drains
// evenly and "what would this cost on metered pricing" is answerable while on
// subscription plans.
const { createCooldownStore, parseRetryAfter } = require('./lib/provider-cooldown');
const { checkGrounding, verifyReferencedPaths } = require('./lib/workspace-grounding');
const { classifyRunFailure, detectCopilotMonthlyQuota } = require('./lib/provider-failure');
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
  levelCandidates, suggestTierAdjustment, fleetBalance,
  applyCooldownsToDiagnostics, levelRouteSelection,
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
function filterCandidatesByQuotaCooldown(candidates = [], explicit = null) {
  const byAlias = new Map();
  for (const state of coolingQuotaStates()) {
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

function seatCostClasses() {
  const cfg = loadConfig();
  const out = {};
  for (const [seat, entry] of Object.entries(cfg)) {
    if (seat.startsWith('_')) continue;
    out[seat] = {
      costClass: costClassFor(entry, seat),
      model: entry.model || null,
      quotaSeat: quotaSeatForProvider(seat),
      aliases: quotaSeatRegistry.groups[quotaSeatForProvider(seat)]?.providers || [seat],
    };
  }
  return out;
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

function recordRunUsage({ kind, route, usage, startedAt, ok, failureKind, taskId }) {
  try {
    const classes = seatCostClasses();
    usageLedger.record({
      seat: kind,
      model: route?.resolved_model || route?.model || null,
      costClass: classes[kind]?.costClass || 'metered',
      inputTokens: usage?.input_tokens ?? usage?.prompt_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? usage?.completion_tokens ?? 0,
      elapsedMs: startedAt ? Date.now() - startedAt : 0,
      ok, failureKind: failureKind || null, taskId: taskId || null,
    });
  } catch (err) { console.log('[RelayBridge] usage record failed: ' + err.message); }
}

app.get('/api/usage/gauges', (req, res) => {
  try {
    const windowMs = Number(req.query.windowMs) || 86400000;
    const gauges = usageLedger.gaugeAll(seatCostClasses(), windowMs);
    const runtimeVersions = Object.fromEntries(Object.entries(lastDiagnostics?.results || {})
      .map(([kind, result]) => [kind, result.runtimeVersion || '']));
    res.json({
      gauges,
      balance: fleetBalance(gauges),
      quotaSeats: quotaSeatRegistry.groups,
      operatorQuota: operatorQuotaFleet(gauges),
      providerUsageCapabilities: providerUsageCapabilities(loadConfig(), runtimeVersions),
      totals: usageLedger.totals(windowMs),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/usage/operator-quota', (req, res) => {
  res.json({
    observations: usageLedger.operatorQuotaObservations(),
    quotaSeats: quotaSeatRegistry.groups,
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
  if (!quotaSeatRegistry.groups[quotaSeat]) return res.status(400).json({ error: 'quotaSeat must name a configured quota seat' });
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
  if (!quotaSeatRegistry.groups[quotaSeat]) return res.status(400).json({ error: 'quotaSeat must name a configured quota seat' });
  if (!usageLedger.clearOperatorQuota(quotaSeat)) return res.status(500).json({ error: 'operator quota clear could not be persisted' });
  return res.json({ ok: true, quotaSeat, cleared: true });
});
app.get('/api/cooldowns', (req, res) => {
  res.json({ cooldowns: cooldowns.all(), cooling: coolingQuotaStates(), quotaSeats: quotaSeatRegistry.groups });
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
    // Quota state first: a cooling seat cannot do the work at any rank.
    const { usable, skipped, allCooling } = filterCandidatesByQuotaCooldown(
      filesystemUsable, explicitProvider ? (req.body?.explicitSeat || null) : null);
    const ranked = levelCandidates(usable, gauges);
    const top = ranked[0] ? gauges[ranked[0].seat] : null;
    res.json({
      ranked, skipped, allCooling, filesystemSkipped, filesystemAuthority,
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
      providerBudget, effort, maxEffortOverride,
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
    res.json({ kind, package: pkg, installer: entry.install_display, success: code === 0, exitCode: code, stdout, stderr });
  });
});


// Open a URL in the user's default browser. Used by the Collab pane's
// "Ask Perplexity (browser)" button â€” lets you use your existing Perplexity
// session/Pro subscription without spending API credits. The browser tab
// shows the answer; you copy it into the Collab's Shared Context box.
// Localhost-only server, only http(s) URLs allowed.
app.post('/api/open-url', (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url required' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'only http(s) urls allowed' });
  const isWindows = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  try {
    if (isWindows) {
      // 'start "" "url"' â€” the "" is an empty title arg required by start when the url is quoted
      spawn('explorer.exe', [url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    } else if (isMac) {
      spawn('open', [url], { detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true }).unref();
    }
    res.json({ ok: true, url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  const url = new URL(req.url, `http://${req.headers.host}`);
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
