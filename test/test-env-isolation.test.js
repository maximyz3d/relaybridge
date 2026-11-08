'use strict';

// Guards the test-only environment isolation: no fixture bridge or MCP child
// may inherit a live RelayBridge store, token, URL or provider secret.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { isolatedEnv, scrubInheritedEnv, isInheritedSecret, configCredentialNames } = require('./helpers/isolated-env');
const { startTestBridge } = require('./helpers/temporary-bridge');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = __dirname;
const HELPER = path.join(TEST_DIR, 'helpers', 'isolated-env.js');

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(c?js|mjs)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}
const testSources = () => walk(TEST_DIR).filter((file) => file !== __filename)
  .map((file) => ({ file, rel: path.relative(ROOT, file), src: fs.readFileSync(file, 'utf8') }));

// Blank comments and string/template bodies, keeping offsets and newlines, so
// child scripts embedded as strings are not mistaken for test-process calls.
function codeOnly(src) {
  const out = src.split('');
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; blank(i, end); i = end; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; blank(i, end); i = end; continue; }
    if (c === '"' || c === "'") { let j = i + 1; while (j < src.length && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; } blank(i + 1, j); i = j + 1; continue; }
    if (c === '`') { let j = i + 1; while (j < src.length && src[j] !== '`') { if (src[j] === '\\') j++; j++; } blank(i + 1, j); i = j + 1; continue; }
    i++;
  }
  return out.join('');
}
function closeParen(code, open) {
  let depth = 0;
  for (let j = open; j < code.length; j++) { if (code[j] === '(') depth++; else if (code[j] === ')' && !--depth) return j; }
  return code.length;
}
// These guards are regex heuristics over comment/string-blanked source, not a
// JavaScript analysis. They cannot see aliased destructuring (`const { spawn: s }`),
// a promisified function stored in a variable before it is called, or an options
// object built elsewhere; such call sites need an `env-isolation:` annotation.
const CP_NS = '(?:cp|childProcess|child_process|require\\s*\\([^)]*\\))';
const CALL_RE = new RegExp(`(?<![\\w$])(?:(${CP_NS})\\s*\\.\\s*)?(spawn|spawnSync|execFile|execFileSync|fork|exec|execSync)\\s*\\(`, 'g');
const PROMISIFIED_RE = new RegExp(`(?<![\\w$])(?:util\\s*\\.\\s*)?promisify\\s*\\(\\s*(?:${CP_NS}\\s*\\.\\s*)?(?:execFile|exec)\\s*\\)\\s*\\(`, 'g');
const TRANSPORT_RE = /(?<![\w$])new\s+StdioClientTransport\s*\(/g;

function childProcessCalls(src) {
  const code = codeOnly(src), lines = src.split('\n'), found = [];
  // A bare identifier argument (`new StdioClientTransport(state.params)`) is judged by whether
  // the file builds a launch-parameter object that pairs `command:` with `env:`.
  const paramsObjectHasEnv = /command\s*:[^}]*[{,]\s*env\s*[:,}]|env\s*:[^}]*,\s*command\s*:/s.test(code);
  const record = (index, open) => {
    const close = closeParen(code, open), line = code.slice(0, index).split('\n').length, args = code.slice(open, close + 1);
    const byReference = /^\(\s*[\w$.]+\s*\)$/.test(args) && /StdioClientTransport/.test(code.slice(index, open));
    found.push({ line, hasEnv: /[{,]\s*env\s*[:,}]/.test(args) || (byReference && paramsObjectHasEnv),
      annotated: /env-isolation:/.test((lines[line - 2] || '') + lines[line - 1]), text: lines[line - 1].trim() });
  };
  let m;
  while ((m = CALL_RE.exec(code))) {
    const before = code.slice(Math.max(0, m.index - 12), m.index);
    if (/\.\s*$/.test(before) && !m[1]) continue; // another object's method, e.g. regex.exec
    if (/function\s*\*?\s*$/.test(before)) continue; // declaration
    const open = m.index + m[0].length - 1;
    if (/^\s*\{/.test(code.slice(closeParen(code, open) + 1, closeParen(code, open) + 40))) continue; // method shorthand `spawn() {`
    record(m.index, open);
  }
  for (const re of [PROMISIFIED_RE, TRANSPORT_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(code))) record(m.index, m.index + m[0].length - 1);
  }
  return found.sort((x, y) => x.line - y.line);
}
const childProcessOffenders = (src) => childProcessCalls(src).filter((call) => !call.hasEnv && !call.annotated);

const ENV_MODULE = String.raw`\.\.\/(?:server(?:\.js)?|lib\/(?:github-onboard|github-tracker|remote-mcp|platform|concurrency-policy|linux-physical-owner|build-identity)(?:\.c?js)?|bin\/relaybridge(?:\.js)?|mcp\/[^'"]+)`;
// require('../x'), import('../x'), createRequire(...)('../x'), and dynamic import of any path under mcp/.
const LIVE_LOAD_RE = new RegExp(String.raw`(?:\brequire|\bimport|\))\s*\(\s*['"](?:${ENV_MODULE}|[^'"]*mcp\/[^'"]*)['"]\s*\)`, 'g');
// Static imports are hoisted above every statement, including scrubInheritedEnv().
const STATIC_IMPORT_RE = new RegExp(String.raw`^[ \t]*import\s+(?:[^;'"(]*?\s+from\s+|)['"](?:${ENV_MODULE})['"]`, 'gm');
const liveIndexes = (src, code, re) => {
  re.lastIndex = 0;
  const hits = [];
  let m;
  while ((m = re.exec(src))) if (code[m.index] === src[m.index]) hits.push(m.index); // not inside a comment or string
  return hits;
};
function envImportOffenders(src) {
  const code = codeOnly(src);
  const statics = liveIndexes(src, code, STATIC_IMPORT_RE);
  if (statics.length) return ['static import is hoisted above scrubInheritedEnv(); use dynamic import() after the scrub'];
  const loads = liveIndexes(src, code, LIVE_LOAD_RE);
  if (!loads.length) return [];
  const scrubs = liveIndexes(src, code, /scrubInheritedEnv\s*\(\s*\)/g);
  return scrubs.length && scrubs[0] < loads[0] ? [] : ['environment-reading module is loaded before scrubInheritedEnv()'];
}

test('helper removes bridge and provider secrets case-insensitively and applies overrides', () => {
  const saved = Object.assign({}, process.env);
  try {
    Object.assign(process.env, { relaybridge_token: 'x', PS_BRIDGE_DATA_DIR: '/x', OPENAI_API_KEY: 'x', RB_KEEP: 'kept' });
    const env = isolatedEnv({ RELAYBRIDGE_DATA_DIR: '/fixture', RB_KEEP: undefined });
    assert.equal(env.RELAYBRIDGE_DATA_DIR, '/fixture');
    assert.equal('RB_KEEP' in env, false);
    for (const key of Object.keys(env)) if (key !== 'RELAYBRIDGE_DATA_DIR') assert.equal(isInheritedSecret(key), false, key);
    process.env.CLAUDE_CODE_MESSAGING_TOKEN = 'fake-messaging-token';
    assert.equal('CLAUDE_CODE_MESSAGING_TOKEN' in isolatedEnv(), false, 'internal Claude messaging credential is stripped');
    assert.equal(isolatedEnv({ CLAUDE_CODE_MESSAGING_TOKEN: 'fake-override' }).CLAUDE_CODE_MESSAGING_TOKEN, 'fake-override', 'explicit fake override survives');
    const removed = scrubInheritedEnv();
    assert.ok(removed.includes('CLAUDE_CODE_MESSAGING_TOKEN'), 'scrub reports the messaging credential');
    assert.ok(removed.includes('OPENAI_API_KEY') && removed.includes('PS_BRIDGE_DATA_DIR'));
    assert.equal(Object.keys(process.env).some(isInheritedSecret), false);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('static (a): no test file spreads or passes the parent environment', () => {
  const offenders = [];
  for (const { file, rel, src } of testSources()) {
    if (file === HELPER) continue;
    src.split('\n').forEach((line, index) => {
      if (/\.\.\.process\.env\b|\benv\s*:\s*process\.env\b/.test(line)) offenders.push(`${rel}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('static (b): every child_process call passes env or carries an env-isolation reason', () => {
  const offenders = [];
  for (const { rel, src } of testSources()) {
    // Fixture executables only ever run as children of an already isolated launch and inherit its environment.
    if (rel === 'test/prompt-file-cli.js') continue;
    for (const call of childProcessCalls(src)) if (!call.hasEnv && !call.annotated) offenders.push(`${rel}:${call.line}: ${call.text.slice(0, 120)}`);
  }
  assert.deepEqual(offenders, []);
});

test('static (c): files importing env-reading modules scrub the inherited environment first', () => {
  const offenders = [];
  for (const { rel, src } of testSources()) {
    if (!/\.test\.(c?js|mjs)$/.test(rel)) continue;
    for (const reason of envImportOffenders(src)) offenders.push(`${rel}: ${reason}`);
  }
  assert.deepEqual(offenders, []);
});

test('guard regressions: previously missed launch forms are flagged only without env', () => {
  const bare = [
    "require('node:child_process').spawnSync(process.execPath, ['-e', s], { timeout: 3 });",
    "const r = await promisify(execFile)(process.execPath, ['-e', s], { timeout: 3 });",
    "const r = await util.promisify(cp.execFile)(process.execPath, ['-e', s]);",
    "const t = new StdioClientTransport({ command: process.execPath, args: [] });",
    "const cp = require('child_process'); cp.execFileSync('git', ['status']);",
  ];
  for (const source of bare) assert.equal(childProcessOffenders(source).length, 1, source);
  const isolated = [
    "require('node:child_process').spawnSync(process.execPath, ['-e', s], { timeout: 3, env: isolatedEnv() });",
    "const r = await promisify(execFile)(process.execPath, ['-e', s], { timeout: 3, env: isolatedEnv() });",
    "const t = new StdioClientTransport({ command: process.execPath, env: isolatedEnv() });",
    "// env-isolation: fixed argv, no secrets\nrequire('node:child_process').spawnSync('true');",
  ];
  for (const source of isolated) assert.deepEqual(childProcessOffenders(source), [], source);
  assert.deepEqual(childProcessOffenders("const p = { command: 'node', env: isolatedEnv() };\nnew StdioClientTransport(p);"), [], 'params object with env');
  assert.equal(childProcessOffenders("const p = { command: 'node' };\nnew StdioClientTransport(p);").length, 1, 'params object without env');
  assert.deepEqual(childProcessOffenders("const s = `require('node:child_process').spawnSync(x)`; /re/.exec('a');"), [], 'string-embedded and non-process calls');
});

test('guard regressions: static ESM imports are hoisted above the scrub, dynamic imports after it are not', () => {
  const scrub = "import { scrubInheritedEnv } from './helpers/isolated-env.js';\n";
  assert.equal(envImportOffenders(scrub + "import { createServer } from '../server.js';\nscrubInheritedEnv();\n").length, 1);
  assert.equal(envImportOffenders(scrub + "import '../mcp/launcher.mjs';\nscrubInheritedEnv();\n").length, 1);
  assert.deepEqual(envImportOffenders(scrub + "scrubInheritedEnv();\nconst m = await import('../mcp/launcher.mjs');\n"), []);
  assert.equal(envImportOffenders(scrub + "const m = await import('../mcp/launcher.mjs');\nscrubInheritedEnv();\n").length, 1);
  assert.equal(envImportOffenders("const require = createRequire(import.meta.url);\nconst s = require('../server.js');\n").length, 1);
  assert.equal(envImportOffenders("const s = createRequire(import.meta.url)('../server.js');\n").length, 1);
  assert.deepEqual(envImportOffenders("// require('../server.js')\nconst x = `import '../server.js'`;\n"), [], 'comment and string occurrences');
  assert.equal(envImportOffenders("// scrubInheritedEnv()\nconst s = require('../server.js');\n").length, 1, 'a commented scrub does not count');
  assert.deepEqual(envImportOffenders("scrubInheritedEnv();\nconst s = require('../server.js');\nrequire.resolve('../server.js');\n"), []);
});

const FAKE_CREDENTIALS = ['GEMINI_API_KEY', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY',
  'PERPLEXITY_API_KEY', 'PPLX_API_KEY', 'CURSOR_API_KEY', 'COPILOT_GITHUB_TOKEN', 'GITHUB_COPILOT_API_TOKEN', 'GITHUB_COPILOT_GITHUB_TOKEN',
  'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN', 'CODEX_ACCESS_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN',
  'CLAUDE_CODE_MESSAGING_TOKEN'];
function withPoisonedEnv(names, fn) {
  const saved = Object.assign({}, process.env);
  try { for (const name of names) process.env[name] = `fake-${name}`; return fn(); }
  finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
}

test('inherited provider, GitHub enterprise and Copilot credentials are stripped; explicit overrides and limits survive', () => {
  withPoisonedEnv([...FAKE_CREDENTIALS, 'COPILOT_PROVIDER_MAX_PROMPT_TOKENS', 'gemini_api_key'], () => {
    const env = isolatedEnv();
    for (const name of FAKE_CREDENTIALS) assert.equal(name in env, false, name);
    assert.equal('gemini_api_key' in env, false, 'lowercase spelling');
    assert.equal(env.COPILOT_PROVIDER_MAX_PROMPT_TOKENS, 'fake-COPILOT_PROVIDER_MAX_PROMPT_TOKENS', 'limits are not secrets');
    const kept = isolatedEnv({ GEMINI_API_KEY: 'fixture', GH_ENTERPRISE_TOKEN: 'fixture-enterprise' });
    assert.equal(kept.GEMINI_API_KEY, 'fixture');
    assert.equal(kept.GH_ENTERPRISE_TOKEN, 'fixture-enterprise');
    assert.equal(isolatedEnv({ Gemini_Api_Key: 'mixed' }).GEMINI_API_KEY, undefined, 'case-insensitive override replaces the inherited spelling');
    const removed = scrubInheritedEnv();
    for (const name of FAKE_CREDENTIALS) assert.ok(removed.includes(name), name);
    assert.equal(Object.keys(process.env).some(isInheritedSecret), false);
  });
});

test('every credential-shaped name in cli-config.json is stripped', () => {
  const names = configCredentialNames();
  for (const expected of ['GEMINI_API_KEY', 'GH_ENTERPRISE_TOKEN', 'GROQ_API_KEY', 'XAI_API_KEY', 'PERPLEXITY_API_KEY']) assert.ok(names.includes(expected), expected);
  assert.equal(names.includes('COPILOT_PROVIDER_MAX_PROMPT_TOKENS'), false);
  withPoisonedEnv(names, () => {
    const env = isolatedEnv();
    for (const name of names) assert.equal(name in env, false, name);
  });
});

test('the five previously unisolated launches pass env, and isolated children see no credentials', async () => {
  const sites = [['native-usage.test.js', 1], ['workflow-pipeline.test.js', 1], ['linux-durable-file.test.js', 3]];
  for (const [file, count] of sites) {
    const src = fs.readFileSync(path.join(TEST_DIR, file), 'utf8');
    const spawned = childProcessCalls(src).filter((call) => /spawnSync|execFile|promisify/.test(call.text));
    assert.ok(spawned.length >= count, file);
    for (const call of spawned) assert.ok(call.hasEnv || call.annotated, `${file}:${call.line}`);
    assert.match(src, /require\('\.\/helpers\/isolated-env'\)/, file);
  }
  const printer = 'process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => /API_KEY|_TOKEN$/i.test(k))))';
  const { promisify } = require('node:util');
  const { execFile, spawnSync } = require('node:child_process');
  await withPoisonedEnv(FAKE_CREDENTIALS, async () => {
    const viaPromise = await promisify(execFile)(process.execPath, ['-e', printer], { env: isolatedEnv() });
    assert.deepEqual(JSON.parse(viaPromise.stdout), []);
    const viaSync = spawnSync(process.execPath, ['-e', printer], { env: isolatedEnv(), encoding: 'utf8' });
    assert.deepEqual(JSON.parse(viaSync.stdout), []);
  });
});

function digest(dir) {
  const entries = [];
  const visit = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name), stat = fs.lstatSync(full);
      if (stat.isDirectory()) { entries.push(`d ${path.relative(dir, full)}`); visit(full); }
      else entries.push(`f ${path.relative(dir, full)} ${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
    }
  };
  visit(dir);
  return entries.join('\n');
}

test('dynamic: a poisoned parent environment reaches neither the fixture bridge nor an MCP-style child', { timeout: 60000 }, async (t) => {
  const sentinel = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-env-sentinel-'));
  fs.mkdirSync(path.join(sentinel, 'data', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(sentinel, 'data', 'tasks', 't_sentinel.json'), '{"id":"t_sentinel","status":"running"}\n');
  fs.writeFileSync(path.join(sentinel, 'cli-config.json'), '{}\n');
  fs.writeFileSync(path.join(sentinel, 'token'), 'sentinel-token\n');
  const before = digest(sentinel);

  let canaryConnections = 0;
  const canary = http.createServer((req, res) => res.end('{}'));
  canary.on('connection', () => { canaryConnections++; });
  await new Promise((resolve) => canary.listen(0, '127.0.0.1', resolve));
  const canaryUrl = `http://127.0.0.1:${canary.address().port}`;

  const saved = Object.assign({}, process.env);
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await new Promise((resolve) => canary.close(resolve));
    fs.rmSync(sentinel, { recursive: true, force: true });
  });
  for (const prefix of ['RELAYBRIDGE_', 'PS_BRIDGE_']) {
    Object.assign(process.env, {
      [prefix + 'DATA_DIR']: path.join(sentinel, 'data'), [prefix + 'CONFIG_FILE']: path.join(sentinel, 'cli-config.json'),
      [prefix + 'TOKEN_FILE']: path.join(sentinel, 'token'), [prefix + 'TOKEN']: 'sentinel-token',
      [prefix + 'ALLOWED_ROOTS']: sentinel, [prefix + 'URL']: canaryUrl,
    });
  }
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'poison-anthropic-canary-0000', OPENAI_API_KEY: 'poison-openai-canary-0000',
    RELAYBRIDGE_ANTHROPIC_CREDIT_API_KEY: 'poison-anthropic-credit-canary-0000', RELAYBRIDGE_OPENAI_CREDIT_API_KEY: 'poison-openai-credit-canary-0000' });

  const bridge = await startTestBridge(t, () => ({}));
  const tasks = await bridge.request('/api/tasks');
  assert.equal(JSON.stringify(tasks.body).includes('t_sentinel'), false, 'fixture bridge must not see the sentinel store');
  assert.ok(fs.existsSync(path.join(bridge.root, 'data')), 'fixture bridge writes its own temporary store');

  const probe = [
    'const env = process.env;',
    'const leaked = Object.keys(env).filter((k) => /^(RELAYBRIDGE_|PS_BRIDGE_)/i.test(k) && k !== "RELAYBRIDGE_URL" || /API_KEY$/i.test(k));',
    'import(process.argv[1]).then(async (client) => {',
    '  const health = await client.health();',
    '  process.stdout.write(JSON.stringify({ leaked, base: String(client.BASE_URL), ok: Boolean(health) }));',
    '}).catch((error) => { process.stderr.write(String(error && error.stack || error)); process.exit(1); });',
  ].join('\n');
  const child = spawn(process.execPath, ['-e', probe, pathToFileURL(path.join(ROOT, 'mcp', 'bridge-client.mjs')).href], {
    cwd: ROOT, env: isolatedEnv({ RELAYBRIDGE_URL: bridge.base }), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 0, stderr);
  const report = JSON.parse(stdout);
  assert.deepEqual(report.leaked, []);
  assert.equal(new URL(report.base).origin, bridge.base);
  assert.equal(report.ok, true);

  assert.equal(canaryConnections, 0, 'no fixture may contact the inherited bridge URL');
  assert.equal(digest(sentinel), before, 'sentinel store names and bytes are unchanged');
});

test('helper guard: an override that would delete a mandatory fixture binding is rejected, optional ones still apply', async (t) => {
  const { fixtureEnv } = require('./helpers/temporary-bridge');
  await withPoisonedEnv(['RELAYBRIDGE_DATA_DIR', 'PS_BRIDGE_DATA_DIR', 'RELAYBRIDGE_CONFIG_FILE', 'PS_BRIDGE_TOKEN_FILE'], async () => {
    for (const key of ['RELAYBRIDGE_DATA_DIR', 'relaybridge_config_file', 'RELAYBRIDGE_TOKEN_FILE', 'RELAYBRIDGE_ALLOWED_ROOTS', 'HOME']) {
      await assert.rejects(startTestBridge(t, () => ({}), { env: { [key]: undefined } }), /mandatory fixture binding/, key);
    }
    assert.throws(() => fixtureEnv('/r', 1, '/r/c.json', '/r/h', { RELAYBRIDGE_DATA_DIR: '' }), /mandatory fixture binding/);
    const env = fixtureEnv('/r', 1, '/r/c.json', '/r/h', { RELAYBRIDGE_REMOTE_MCP: '0', RELAYBRIDGE_WARM_DIAG: undefined });
    assert.equal(env.RELAYBRIDGE_DATA_DIR, path.join('/r', 'data'));
    assert.equal(env.RELAYBRIDGE_CONFIG_FILE, '/r/c.json');
    assert.equal(env.RELAYBRIDGE_TOKEN_FILE, path.join('/r', 'token'));
    assert.equal(env.RELAYBRIDGE_ALLOWED_ROOTS, '/r');
    assert.equal(env.RELAYBRIDGE_REMOTE_MCP, '0');
    assert.equal('PS_BRIDGE_DATA_DIR' in env, false);
    assert.equal(fixtureEnv('/r', 1, '/r/c.json', '/r/h', { RELAYBRIDGE_DATA_DIR: '/other' }).RELAYBRIDGE_DATA_DIR, '/other', 'string overrides still apply');
  });
});

// Heuristic: flags helpers that rebuild an undefined-valued map from inherited bridge variables.
// isolatedEnv()/fixtureEnv() already clear them, so such adapters are obsolete and can undo helper bindings.
function clearingAdapterOffenders(src) {
  const code = codeOnly(src), found = [];
  if (/(?<![\w$])(?:inheritedBridgeKeys|unsetBridgeEnv|inheritedBridgeEnv|unsetEnv)(?![\w$])/.test(code)) found.push('named clearing adapter');
  for (const m of code.matchAll(/Object\s*\.\s*keys\s*\(\s*process\s*\.\s*env\s*\)/g)) {
    const stmt = src.slice(m.index, m.index + 400).split(';')[0];
    if (/RELAYBRIDGE_|PS_BRIDGE_/.test(stmt)) found.push('process.env key filter on bridge prefixes');
    if (/\[\s*\w+\s*,\s*undefined\s*\]/.test(code.slice(m.index, m.index + stmt.length))) found.push('undefined-valued map from process.env');
  }
  return found;
}
test('static (d): no test fixture rebuilds an undefined-valued map from inherited bridge variables', () => {
  for (const { rel, src } of testSources()) assert.deepEqual(clearingAdapterOffenders(src), [], rel);
});
test('guard regressions: clearing adapters are flagged, constructed envs and strings are not', () => {
  assert.ok(clearingAdapterOffenders("const unsetEnv = {};").length);
  assert.ok(clearingAdapterOffenders("const inheritedBridgeEnv=()=>({});").length);
  assert.ok(clearingAdapterOffenders("const u = Object.fromEntries(Object.keys(process.env)\n  .filter(k => /^(RELAYBRIDGE_|PS_BRIDGE_)/.test(k)).map(k => [k, 1]));").length);
  assert.ok(clearingAdapterOffenders("const u = Object.fromEntries(Object.keys(process.env).map(k => [k, undefined]));").length);
  assert.deepEqual(clearingAdapterOffenders("const e = isolatedEnv({ RELAYBRIDGE_WARM_DIAG: '0' });\nconst s = 'unsetEnv inheritedBridgeEnv';"), []);
  assert.deepEqual(clearingAdapterOffenders("const keys = Object.keys(process.env).filter((k) => k.startsWith('NODE_'));"), []);
});

test('dynamic: the real stale-native and continuity fixtures keep temporary bindings under a poisoned parent', { timeout: 240000 }, async (t) => {
  const sentinel = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-env-poison-'));
  const home = path.join(sentinel, 'home'); fs.mkdirSync(path.join(sentinel, 'data'), { recursive: true }); fs.mkdirSync(home);
  fs.writeFileSync(path.join(sentinel, 'data', 'sentinel.json'), '{"id":"sentinel"}\n');
  fs.writeFileSync(path.join(sentinel, 'cli-config.json'), '{}\n');
  fs.writeFileSync(path.join(sentinel, 'token'), 'sentinel-token\n');
  const before = digest(sentinel);
  let canaryConnections = 0;
  const canary = http.createServer((req, res) => res.end('{}'));
  canary.on('connection', () => { canaryConnections++; });
  await new Promise((resolve) => canary.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => canary.close(resolve)); fs.rmSync(sentinel, { recursive: true, force: true }); });
  const poisoned = { PATH: process.env.PATH || '', HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, 'x'),
    XDG_DATA_HOME: path.join(home, 'd'), XDG_STATE_HOME: path.join(home, 's'), XDG_CACHE_HOME: path.join(home, 'c'),
    ANTHROPIC_API_KEY: 'poison-anthropic-canary-0000', CLAUDE_CODE_MESSAGING_TOKEN: 'poison-messaging-canary-0000' };
  for (const prefix of ['RELAYBRIDGE_', 'PS_BRIDGE_']) {
    Object.assign(poisoned, { [prefix + 'DATA_DIR']: path.join(sentinel, 'data'), [prefix + 'CONFIG_FILE']: path.join(sentinel, 'cli-config.json'),
      [prefix + 'TOKEN_FILE']: path.join(sentinel, 'token'), [prefix + 'TOKEN']: 'sentinel-token', [prefix + 'ALLOWED_ROOTS']: sentinel,
      [prefix + 'URL']: `http://127.0.0.1:${canary.address().port}` });
  }
  const { spawnSync } = require('node:child_process');
  const runs = [['native-admission-stale.test.js', 'a prior same-identity observation above reserve admits through a failed probe as stale'],
    ['continuity.integration.test.js', 'stale native Claude admission refreshes through a non-generating PTY probe'],
    ['cooldown-reset-reconciliation.test.js', 'actual reset endpoint checks authority then coalesces probes, clears both holds and replays without quota'],
    ['project-workspace.integration.test.js', 'project chat performs durable Codex → stronger advisor → Codex → worker round trip']];
  for (const [file, name] of runs) {
    // env-isolation: deliberate poisoned parent with fake values and temporary HOME
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern', `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, path.join(TEST_DIR, file)],
      { cwd: ROOT, env: poisoned, encoding: 'utf8', timeout: 110000 });
    assert.equal(result.status, 0, `${file}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /# pass [1-9]/, file);
  }
  assert.equal(canaryConnections, 0, 'no fixture may contact the inherited bridge URL');
  assert.equal(digest(sentinel), before, 'sentinel store names and bytes are unchanged');
});
