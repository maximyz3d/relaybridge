// RelayBridge - local PowerShell + multi-AI-CLI bridge
// Runs on 127.0.0.1 only. Spawns real PTYs (node-pty) when available,
// falls back to child_process pipes otherwise.

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { spawn, spawnSync } = require('child_process');
const BRIDGE_VERSION = require('./package.json').version;

// ---- config ----
const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = '127.0.0.1';
const ROOT = __dirname;
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
// deliberately best-effort — a failure is reported loudly and never causes the
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
  const match = /(S-1-5-21-[0-9-]+)/.exec(String(result.stdout || ''));
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
    console.warn(`[RelayBridge] WARNING: the capability token file is not ACL-protected — ${TOKEN_ACL.detail}`);
    console.warn(`[RelayBridge]          ${TOKEN_FILE}`);
    console.warn('[RelayBridge]          Any account that can read it holds full bridge control. The token was NOT rotated or deleted.');
  }
  return token;
}

const CAPABILITY_TOKEN = loadOrCreateCapabilityToken();
const ALLOWED_ROOTS_VALUE = envFirst('RELAYBRIDGE_ALLOWED_ROOTS', 'PS_BRIDGE_ALLOWED_ROOTS');
const ALLOWED_ROOTS = (ALLOWED_ROOTS_VALUE
  ? ALLOWED_ROOTS_VALUE.split(';')
  : [process.env.USERPROFILE || ROOT, ROOT])
  .filter(Boolean)
  .map((value) => path.resolve(value));

function isInsideAllowedRoot(candidate) {
  const normalized = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  return ALLOWED_ROOTS.some((root) => {
    const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root;
    return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + path.sep);
  });
}

function resolveAllowedCwd(value, fallback = process.env.USERPROFILE || ROOT) {
  const resolved = path.resolve(value || fallback);
  if (!isInsideAllowedRoot(resolved)) throw new Error(`cwd is outside RELAYBRIDGE_ALLOWED_ROOTS: ${resolved}`);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`cwd is not a directory: ${resolved}`);
  return resolved;
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
    console.log('[RelayBridge] node-pty loaded — using real PTY mode');
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
  const receipt = {
    receiptId: `rcpt_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
    timestamp: new Date().toISOString(),
    event: 'bridge_provider_call',
    status: payload.exitCode === 0 && !payload.dropped_out ? 'completed' : (payload.timed_out ? 'timed_out' : 'dropped'),
    provider: kind,
    inputHash: crypto.createHash('sha256').update(String(prompt || '')).digest('hex'),
    inputChars: String(prompt || '').length,
    outputHash: crypto.createHash('sha256').update(String(payload.stdout || '')).digest('hex'),
    outputChars: String(payload.stdout || '').length,
    durationMs: Date.now() - startedAt,
    failureClass: payload.rate_limited ? 'rate_limit'
      : payload.budget_exceeded ? 'budget'
        : payload.auth_failed ? 'auth'
          : payload.permission_denied ? 'policy'
            : payload.timed_out ? 'timeout'
              : payload.exitCode === 0 && !payload.dropped_out ? null : 'provider_error',
    route,
  };
  const filePath = path.join(RECEIPTS_DIR, `${receipt.timestamp.slice(0, 10)}.jsonl`);
  const handle = fs.openSync(filePath, 'a');
  try {
    fs.writeFileSync(handle, `${JSON.stringify(receipt)}\n`, 'utf8');
    fs.fsyncSync(handle);
  } finally { fs.closeSync(handle); }
  return receipt;
}

function sendOneShotResult(res, payload, meta) {
  if (res.writableEnded || res.destroyed) return;
  try {
    const receipt = appendBridgeProviderReceipt({ ...meta, payload });
    res.json({ ...payload, receiptId: receipt.receiptId, receiptPersisted: true });
  } catch (error) {
    res.json({ ...payload, receiptId: `rcpt_unpersisted_${Date.now().toString(36)}`, receiptPersisted: false, receiptPersistenceError: error.message });
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

async function runOpenAIChatOneShot({ entry, prompt, timeoutMs, res, route, startedAt }) {
  const bounded = capPrompt(prompt, Number(entry.prompt_max_chars || 12000));
  route.prompt_transport = 'hosted_openai_compatible';
  route.prompt_truncated = bounded.truncated;
  route.allow_paid_fallback = entry.allow_paid_fallback === true;
  route.hosting_region = entry.hosting_region || null;
  route.requires_explicit_preference = entry.autoRoute === false || null;

  const controller = new AbortController();
  let timedOut = false;
  let clientGone = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('hosted provider request timed out'));
  }, Math.max(1000, Math.min(Number(timeoutMs) || 180000, 300000)));
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
          timed_out: false,
          dropped_out: true,
        }, { kind: route.provider, prompt, route, startedAt });
      }
      return;
    }
    const stdout = cleanOutput(payload.choices?.[0]?.message?.content || payload.output_text || '');
    route.resolved_model = payload.model || entry.model;
    const usage = payload.usage ? {
      input_tokens: Number.isFinite(Number(payload.usage.prompt_tokens)) ? Number(payload.usage.prompt_tokens) : null,
      output_tokens: Number.isFinite(Number(payload.usage.completion_tokens)) ? Number(payload.usage.completion_tokens) : null,
      total_tokens: Number.isFinite(Number(payload.usage.total_tokens)) ? Number(payload.usage.total_tokens) : null,
    } : null;
    if (!clientGone && !res.writableEnded) {
      sendOneShotResult(res, {
        kind: route.provider,
        route,
        exitCode: 0,
        stdout,
        stderr: '',
        usage,
        rate_limited: false,
        budget_exceeded: false,
        auth_failed: false,
        permission_denied: false,
        timed_out: false,
        dropped_out: !stdout,
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
      }, { kind: route.provider, prompt, route, startedAt });
    }
  } finally {
    clearTimeout(timer);
  }
}

async function runOllamaApiOneShot({ entry, prompt, timeoutMs, res, route, startedAt }) {
  const bounded = capPrompt(prompt, Number(entry.prompt_max_chars || 24000));
  route.prompt_transport = 'local_http';
  route.prompt_truncated = bounded.truncated;
  const controller = new AbortController();
  let timedOut = false;
  let clientGone = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('local Ollama request timed out'));
  }, Math.max(1000, Math.min(Number(timeoutMs) || 180000, 300000)));
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      controller.abort(new Error('bridge client disconnected'));
    }
  });

  try {
    const response = await fetch(localOllamaUrl(), {
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
          timed_out: false,
          dropped_out: true,
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
    route.resolved_model = payload.model || entry.model;
    const usage = {
      input_tokens: Number.isFinite(Number(payload.prompt_eval_count)) ? Number(payload.prompt_eval_count) : null,
      output_tokens: Number.isFinite(Number(payload.eval_count)) ? Number(payload.eval_count) : null,
      total_duration_ns: Number.isFinite(Number(payload.total_duration)) ? Number(payload.total_duration) : null,
      load_duration_ns: Number.isFinite(Number(payload.load_duration)) ? Number(payload.load_duration) : null,
      done_reason: payload.done_reason || null,
    };
    if (!clientGone && !res.writableEnded) {
      sendOneShotResult(res, {
        kind: route.provider,
        route,
        exitCode: 0,
        stdout,
        stderr: '',
        usage,
        rate_limited: false,
        budget_exceeded: false,
        auth_failed: false,
        permission_denied: false,
        timed_out: false,
        dropped_out: !stdout,
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
        // shims directly — pty.spawn('claude', ...) fails because the shim isn't
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
    // resolve those — you get ENOENT. Setting shell:true lets cmd.exe
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-RelayBridge-Token, X-PS-Bridge-Token');
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
    .replace('<script>', `<script nonce="${nonce}">`);
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
    version: BRIDGE_VERSION,
    capabilityAuth: true,
    tokenAcl: TOKEN_ACL,
    stickyDangerousEnabled: envFirst('RELAYBRIDGE_ALLOW_STICKY_DANGEROUS', 'PS_BRIDGE_ALLOW_STICKY_DANGEROUS') === '1',
    pid: process.pid,
    instanceId: INSTANCE_ID,
    startedAt: STARTED_AT,
  });
});

// Same-origin browser clients use this bootstrap endpoint once, then attach
// the token as a non-simple request header. Cross-origin pages are rejected by
// the origin middleware before they can read the token or submit a preflight.
app.get('/api/capability', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ token: CAPABILITY_TOKEN, header: 'X-RelayBridge-Token', legacyHeader: 'X-PS-Bridge-Token' });
});

app.use('/api', (req, res, next) => {
  const providedToken = req.headers['x-relaybridge-token'] || req.headers['x-ps-bridge-token'];
  if (!tokenMatches(providedToken)) {
    return res.status(401).json({ error: 'valid X-RelayBridge-Token required' });
  }
  next();
});

app.get('/api/config', (req, res) => {
  res.json(loadConfig());
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

function agentSummary(kind, entry) {
  const diag = lastDiagnostics?.results?.[kind] || null;
  return {
    id: kind,
    label: entry.label || kind,
    model: entry.model || null,
    tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => PROVIDER_TAG_RE.test(String(tag))) : [],
    autoRoute: entry.autoRoute !== false,
    readiness: diag ? {
      found: diag.found ?? null,
      ready: diag.ready ?? null,
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
function resolveBroadcastTargets(cfg, { providers, tag, all } = {}) {
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
  return matched.filter(([, entry]) => entry.autoRoute !== false).map(([kind]) => kind);
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
      const probeText = cleanOutput(probe.stdout || probe.stderr);
      if (entry.probe_expect && !probeText.toLowerCase().includes(String(entry.probe_expect).toLowerCase())) ready = false;
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
    }];
  }));
  const results = Object.fromEntries(pairs);
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
    const { kind, label, cwd, dangerous } = req.body || {};
    if (!kind) return res.status(400).json({ error: 'kind required' });
    const s = createSessionFromKind(kind, { label, cwd, dangerous });
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

// One-shot exec — for Cowork to run a PowerShell command and get output back.
app.post('/api/exec', (req, res) => {
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


// One-shot AI invocation — used by Collab Mode. Spawns the configured CLI in
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
  const { kind, prompt, timeoutMs = 180000, cwd, dangerous } = body || {};
  if (!kind || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'kind + non-empty prompt required' });
  }
  const cfg = loadConfig();
  const entry = cfg[kind];
  if (!entry) return res.status(400).json({ error: 'unknown kind: ' + kind });
  let oneShotEnv;
  try {
    oneShotEnv = normalizeEnvOverrides(entry.oneshot_env);
  } catch (err) {
    return res.status(500).json({ error: `invalid oneshot environment for ${kind}: ${err.message}` });
  }
  // Collab Mode is a discussion, not an agentic task — it passes dangerous:false
  // so CLIs run non-agentically (no auto tool/command execution). When the
  // caller doesn't specify, fall back to the global Full Permissions toggle.
  const useDanger = (typeof dangerous === 'boolean') ? dangerous : state.fullPermissions;
  const slotRaw = useDanger ? entry.oneshot_dangerous : entry.oneshot_safe;
  if (!slotRaw || !slotRaw.length) return res.status(400).json({ error: 'no oneshot config for ' + kind });
  const slot = resolveSlot(slotRaw);
  const hasInlinePrompt = slot.some((a) => typeof a === 'string' && a.includes('{prompt}'));
  const hasPromptFile = slot.some((a) => typeof a === 'string' && a.includes('{prompt_file}'));
  if (hasInlinePrompt && hasPromptFile) {
    return res.status(400).json({ error: 'oneshot config cannot mix {prompt} and {prompt_file}' });
  }
  let resolvedCwd;
  try {
    resolvedCwd = resolveAllowedCwd(cwd);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!acquireOneShot(kind, res)) {
    return res.status(429).json({
      error: 'provider concurrency limit reached; retry with backoff',
      kind,
      retryable: true,
      failureClass: 'admission_limit',
      activeOneShotCount,
      maxActiveOneShots: MAX_ACTIVE_ONESHOTS,
    });
  }
  let promptFileDir = null;
  let promptFile = '';
  let promptForArgs = prompt;
  let promptTruncated = false;
  if (hasInlinePrompt) {
    const capped = capPrompt(prompt, Number(entry.prompt_max_chars || 6000));
    promptForArgs = capped.text;
    promptTruncated = capped.truncated;
  }
  if (hasPromptFile) {
    try {
      promptFileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'RelayBridge-prompt-'));
      promptFile = path.join(promptFileDir, 'prompt.txt');
      fs.writeFileSync(promptFile, prompt, 'utf8');
    } catch (err) {
      return res.status(500).json({ error: 'could not create temporary prompt file: ' + err.message });
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
  const childEnv = buildEnv(oneShotEnv, entry.strip_env || []);
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
    dangerous: useDanger,
    prompt_transport: promptTransport,
    prompt_truncated: promptTruncated,
    environment_overrides: Object.keys(oneShotEnv).sort(),
  };
  if (entry.oneshot_adapter === 'ollama_api') {
    cleanupPromptFile();
    return runOllamaApiOneShot({ entry, prompt, timeoutMs, res, route, startedAt });
  }
  if (entry.oneshot_adapter === 'openai_chat_api') {
    cleanupPromptFile();
    return runOpenAIChatOneShot({ entry, prompt, timeoutMs, res, route, startedAt });
  }
  const isWindows = process.platform === 'win32';
  let proc;
  try {
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
  } catch (err) {
    cleanupPromptFile();
    return sendOneShotResult(res, { kind, route, exitCode: -1, stdout: '', stderr: err.message, error: 'spawn failed', dropped_out: true }, { kind, prompt, route, startedAt });
  }
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let clientGone = false;
  let settled = false;
  const t = setTimeout(() => {
    timedOut = true;
    killProcessTree(proc);
  }, timeoutMs);
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      killProcessTree(proc);
      cleanupPromptFile();
    }
  });
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (d) => { stdout += d; });
  proc.stderr.on('data', (d) => { stderr += d; });
  proc.on('error', (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(t);
    cleanupPromptFile();
    if (clientGone || res.writableEnded) return;
    sendOneShotResult(res, { kind, route, exitCode: -1, stdout, stderr: stderr + '\n' + err.message, error: err.message, dropped_out: true }, { kind, prompt, route, startedAt });
  });
  proc.on('close', (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(t);
    cleanupPromptFile();
    if (clientGone || res.writableEnded) return;
    const blob = (stdout + '\n' + stderr).toLowerCase();
    const rate_signals = ['rate limit','rate-limit','too many requests','quota exceeded','usage limit reached','hit your usage limit','hit your limit','upgrade to pro','429','credit balance is too low','usage limit','out of credits'];
    const budget_signals = ['exceeded usd budget','exceeded the usd budget','max-budget-usd','budget exceeded','budget cap reached'];
    // Word boundaries avoid false positives such as "deSIGN INtent" in a
    // perfectly valid model response.
    const auth_signals = [
      /\benoent\b/,
      /\bnot authenticated\b/,
      /\bplease log in\b/,
      /\bsign in\b/,
      /\blogin required\b/,
      /\bauthentication required\b/,
    ];
    const rate_limited = rate_signals.some(s => blob.includes(s));
    const budget_exceeded = budget_signals.some(s => blob.includes(s));
    const cleanedStdout = cleanOutput(stdout);
    // Some CLIs report unrelated MCP authentication warnings on stderr even
    // after the selected provider completed successfully. Only classify the
    // provider route as unauthenticated when the command failed or produced no
    // usable answer.
    const auth_failed = auth_signals.some((pattern) => pattern.test(blob))
      && (code !== 0 || !cleanedStdout);
    const permission_signals = ['headless mode cannot prompt', 'auto-denied', 'no output produced'];
    const permission_denied = permission_signals.some((signal) => blob.includes(signal));
    const dropped_out = timedOut || code !== 0 || permission_denied || rate_limited || budget_exceeded || auth_failed || !cleanedStdout;
    sendOneShotResult(res, {
      kind,
      route,
      exitCode: code,
      stdout: cleanedStdout,
      stderr: cleanOutput(stderr),
      rate_limited,
      budget_exceeded,
      auth_failed,
      permission_denied,
      timed_out: timedOut,
      dropped_out,
    }, { kind, prompt, route, startedAt });
  });
  // Providers without a placeholder (Claude/Codex/Perplexity wrapper) read
  // stdin. Antigravity consumes {prompt}; Grok consumes {prompt_file}.
  if (promptTransport === 'stdin') {
    try { proc.stdin.write(prompt); proc.stdin.end(); } catch {}
  } else {
    try { proc.stdin.end(); } catch {}
  }
}

app.post('/api/oneshot', (req, res) => executeOneShot(req.body, res));


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
const BROADCAST_QUEUE_WAIT_MS = 300000;
app.post('/api/broadcast', async (req, res) => {
  const { prompt, tag, providers, all, dangerous, timeoutMs = 180000, cwd } = req.body || {};
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'non-empty prompt required' });
  }
  const cfg = loadConfig();
  let targets;
  try {
    targets = resolveBroadcastTargets(cfg, { providers, tag, all });
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
  const queueDeadline = startedAt + BROADCAST_QUEUE_WAIT_MS;
  let run = writeBroadcastRun({
    mode: 'broadcast',
    status: 'running',
    promptHash: crypto.createHash('sha256').update(prompt).digest('hex'),
    promptChars: prompt.length,
    selection: { tag: typeof tag === 'string' ? tag : null, all: all === true, explicitProviders: Array.isArray(providers) ? providers : [] },
    targets,
    members: [],
  });
  const callOnce = async (kind) => {
    const captured = new CapturedOneShotResponse();
    executeOneShot({ kind, prompt, timeoutMs, cwd, dangerous }, captured)
      .catch((err) => captured.status(500).json({ error: err.message, dropped_out: true }));
    return captured.done;
  };
  const results = await Promise.all(targets.map(async (kind) => {
    const memberStartedAt = Date.now();
    let response = await callOnce(kind);
    while (
      response.statusCode === 429 &&
      response.body?.failureClass === 'admission_limit' &&
      Date.now() < queueDeadline &&
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
    status: results.every((member) => member.ok) ? 'completed' : results.some((member) => member.ok) ? 'partial' : 'failed',
    members: results.map((member) => ({ kind: member.provider, role: 'broadcast', exitCode: member.exitCode, droppedOut: !member.ok, durationMs: member.durationMs, receiptId: member.receiptId })),
    durationMs: Date.now() - startedAt,
  });
  if (res.writableEnded || res.destroyed) return;
  res.json({ targets, results, runId: run.runId, status: run.status });
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
  const proc = trackChild(spawn(spawnBinary, spawnArgs, {
    cwd: process.env.USERPROFILE || ROOT,
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
// "Ask Perplexity (browser)" button — lets you use your existing Perplexity
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
      // 'start "" "url"' — the "" is an empty title arg required by start when the url is quoted
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

server.listen(PORT, HOST, () => {
  console.log(`[RelayBridge] listening on http://${HOST}:${PORT}`);
  console.log(`[RelayBridge] open the URL above in Chrome.`);
  console.log(`[RelayBridge] full permissions: ${state.fullPermissions ? 'ON' : 'off'} (toggle in UI)`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[RelayBridge] shutting down…');
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
