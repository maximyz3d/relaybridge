'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'cli-config.json');
const TIMEOUT_POLICY = require('../timeout-policy.cjs');

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
}

test('one-shot timeout policy is centralized: 10 min default, ceiling equals the supervisor hard cap', () => {
  assert.equal(TIMEOUT_POLICY.oneShotDefaultMs, 600000);
  // The explicit-timeout ceiling matches _supervisor.hardCapMs (45 min) so the
  // MCP transport bound (max + grace) covers everything supervision permits —
  // otherwise the client aborts the HTTP request under a still-healthy run.
  assert.equal(TIMEOUT_POLICY.oneShotMaxMs, 2700000);
  assert.equal(TIMEOUT_POLICY.broadcastQueueWaitMs, 2700000);
  assert.equal(TIMEOUT_POLICY.normalizeOneShotTimeoutMs(600001), 600001);
  assert.equal(TIMEOUT_POLICY.normalizeOneShotTimeoutMs(3000000), 2700000);
  assert.equal(TIMEOUT_POLICY.transportTimeoutMs(2700000), 2715000);
  const supervisorCfg = readConfig()._supervisor;
  assert.equal(TIMEOUT_POLICY.oneShotMaxMs, supervisorCfg.hardCapMs, 'transport ceiling must cover the supervisor hard cap');
  const routing = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'routing-policy.json'), 'utf8'));
  assert.deepEqual(
    Object.fromEntries(Object.entries(routing.tiers).map(([tier, policy]) => [tier, policy.defaultTimeoutMs])),
    { utility: 600000, standard: 600000, complex: 900000, critical: 1200000 },
  );
});

test('transactional installer does not mistake a stale native exit code for MCP registration failure', () => {
  const install = fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');
  const registrationBlock = install.match(/if \(\$RegisterMcp\) \{([\s\S]*?)\n  \}/);
  assert.ok(registrationBlock, 'RegisterMcp cutover block is present');
  assert.match(registrationBlock[1], /try \{ & \(Join-Path \$InstallDir 'install-mcp\.ps1'\) \}/);
  assert.doesNotMatch(registrationBlock[1], /LASTEXITCODE/);
});

test('provider config uses the installed subscription CLIs and safe headless modes', () => {
  const config = readConfig();
  assert.equal(config.claude.safe[config.claude.safe.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(config.claude.oneshot_safe[config.claude.oneshot_safe.indexOf('--permission-mode') + 1], 'plan');
  assert.deepEqual(config.claude.probe, ['claude', 'auth', 'status']);
  assert.ok(config.claude.strip_env.includes('ANTHROPIC_API_KEY'));
  assert.equal(config.claude.safe[config.claude.safe.indexOf('--model') + 1], 'opus');
  assert.equal(config.claude_fable.safe[config.claude_fable.safe.indexOf('--model') + 1], 'fable');
  assert.equal(config.claude_fable.safe[config.claude_fable.safe.indexOf('--effort') + 1], 'max');
  assert.equal(config.claude_fable.oneshot_safe[config.claude_fable.oneshot_safe.indexOf('--effort') + 1], 'max');
  assert.equal(config.claude_fable.model, 'claude-fable-5');
  assert.deepEqual(config.claude_fable.probe, ['claude', 'auth', 'status']);
  assert.ok(config.claude_fable.strip_env.includes('ANTHROPIC_API_KEY'));
  assert.equal(config.codex.safe[config.codex.safe.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(config.codex.oneshot_safe[config.codex.oneshot_safe.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(config.codex.oneshot_safe.includes('--ephemeral'));
  assert.deepEqual(config.codex.probe, ['codex', 'login', 'status']);
  assert.equal(config.copilot.npm_package, '@github/copilot');
  assert.deepEqual(config.copilot.install_command, ['npm', 'install', '-g', '@github/copilot']);
  assert.deepEqual(config.copilot.probe, ['copilot', '--version']);
  assert.ok(config.copilot.oneshot_safe.includes('--prompt'));
  assert.ok(config.copilot.oneshot_safe.includes('{prompt}'));
  assert.ok(config.copilot.strip_env.includes('COPILOT_GITHUB_TOKEN'));
  assert.equal(config.gemini.safe[0], 'agy.exe');
  assert.match(config.gemini.label, /Antigravity/);
  assert.deepEqual(config.gemini.probe, ['agy.exe', 'models']);
  assert.ok(config.gemini.safe.includes('--sandbox'));
  assert.equal(config.gemini.oneshot_safe.at(-2), '--print');
  assert.equal(config.gemini.oneshot_safe.at(-1), '{prompt}');
  assert.equal(config.gemini.oneshot_safe[config.gemini.oneshot_safe.indexOf('--add-dir') + 1], '{cwd}');
  assert.equal(config.gemini.oneshot_safe[config.gemini.oneshot_safe.indexOf('--effort') + 1], 'high');
  assert.equal(config.gemini.oneshot_safe[config.gemini.oneshot_safe.indexOf('--mode') + 1], 'plan');
  assert.ok(config.gemini.dangerous.includes('--dangerously-skip-permissions'));
  assert.equal(config.gemini.npm_package, undefined);

  assert.equal(config.grok.npm_package, '@xai-official/grok');
  assert.equal(config.grok.model, 'grok-4.6');
  assert.ok(config.grok.dangerous.includes('--always-approve'));
  assert.ok(config.grok.oneshot_safe.includes('{prompt_file}'));
  assert.equal(config.grok.oneshot_safe[config.grok.oneshot_safe.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(config.grok.oneshot_safe[config.grok.oneshot_safe.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(config.grok.oneshot_safe[config.grok.oneshot_safe.indexOf('--max-turns') + 1], '32');
  assert.equal(config.grok.oneshot_dangerous[config.grok.oneshot_dangerous.indexOf('--max-turns') + 1], '32');
  assert.ok(config.grok.oneshot_safe.includes('--no-leader'));
  assert.ok(config.grok.oneshot_dangerous.includes('--no-leader'));
  assert.ok(config.grok.oneshot_safe.includes('--no-plan'));
  assert.ok(config.grok.oneshot_dangerous.includes('--no-plan'));
  assert.deepEqual(config.grok.oneshot_env, {
    GROK_CLAUDE_MCPS_ENABLED: 'false',
    GROK_CURSOR_MCPS_ENABLED: 'false',
  });

  assert.equal(config.perplexity.diagnostic_binary, 'pwm');
  assert.deepEqual(config.perplexity.probe.slice(-2), ['tools/pplx.js', '--check']);
  assert.deepEqual(config.perplexity.safe, config.perplexity.dangerous);
  assert.ok(config.perplexity.strip_env.includes('PERPLEXITY_API_KEY'));
  assert.ok(config.perplexity.strip_env.includes('PPLX_API_KEY'));
  assert.ok(config.perplexity.strip_env.includes('PPLX_ALLOW_PAID_API_FALLBACK'));
  assert.deepEqual(config.ollama.oneshot_safe.slice(0, 2), ['ollama.exe', 'run']);
  assert.deepEqual(config.ollama_coder.oneshot_safe.slice(0, 2), ['ollama.exe', 'run']);
  assert.equal(config.ollama.oneshot_adapter, 'ollama_api');
  assert.equal(config.ollama_coder.oneshot_adapter, 'ollama_api');
  assert.equal(config.ollama_fast.model, 'qwen2.5:1.5b');
  assert.equal(config.ollama_fast.oneshot_adapter, 'ollama_api');
  assert.equal(config.ollama_llama.model, 'llama3.2:3b');
  assert.equal(config.ollama_llama.oneshot_adapter, 'ollama_api');
  assert.equal(config.groq_llama_fast.oneshot_adapter, 'openai_chat_api');
  assert.equal(config.groq_llama_fast.api_key_env, 'GROQ_API_KEY');
  assert.equal(config.groq_llama_fast.allow_paid_fallback, false);
  assert.equal(config.groq_llama_fast.autoRoute, false);
});

test('cursor provider pins safe modes, probe, and guided install metadata', () => {
  const config = readConfig();
  assert.equal(config.cursor.safe[0], 'agent');
  assert.equal(config.cursor.safe[config.cursor.safe.indexOf('--mode') + 1], 'plan');
  assert.ok(config.cursor.dangerous.includes('--force'));
  assert.ok(config.cursor.oneshot_safe.includes('-p'));
  assert.equal(config.cursor.oneshot_safe[config.cursor.oneshot_safe.indexOf('--mode') + 1], 'ask');
  assert.ok(config.cursor.oneshot_safe.includes('--trust'));
  assert.ok(!config.cursor.oneshot_safe.includes('--force'));
  assert.equal(config.cursor.oneshot_safe.at(-1), '{prompt}');
  assert.ok(config.cursor.oneshot_dangerous.includes('--force'));
  assert.deepEqual(config.cursor.probe, ['agent', 'status']);
  assert.ok(config.cursor.probe_reject.includes('not logged in'));
  assert.equal(config.cursor.probe_expect, 'Logged in as');
  assert.equal(config.cursor.probe_redact, true);
  assert.ok(config.cursor.strip_env.includes('CURSOR_API_KEY'));
  assert.match(config.cursor.install_display, /cursor\.com\/install\?win32=true/);
  assert.equal(config.cursor.model, undefined);
  const routing = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'routing-policy.json'), 'utf8'));
  for (const family of ['coding', 'code_review', 'general']) {
    assert.ok(routing.taskPriorities[family].includes('cursor'), family + ' priorities include cursor');
    assert.ok(
      routing.taskPriorities[family].indexOf('cursor') > routing.taskPriorities[family].indexOf('codex'),
      'cursor ranks after codex in ' + family,
    );
  }
  const evidence = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'provider-evidence.json'), 'utf8'));
  assert.equal(evidence.providers.cursor.qualification, 'available');
  assert.deepEqual(evidence.providers.cursor.evidence, []);
  assert.ok(evidence.sources.some((source) => source.id === 'cursor_cli_docs'));
});

test('provider tags are declared, lowercase, unique, and match the shared vocabulary shape', () => {
  const config = readConfig();
  const TAG_RE = /^[a-z][a-z0-9-]{0,23}$/;
  for (const [kind, entry] of Object.entries(config)) {
    if (kind.startsWith('_')) continue;
    assert.ok(Array.isArray(entry.tags), kind + ' declares a tags array');
    for (const tag of entry.tags) assert.match(tag, TAG_RE, `${kind} tag ${JSON.stringify(tag)}`);
    assert.equal(new Set(entry.tags).size, entry.tags.length, kind + ' tags are unique');
  }
  assert.deepEqual(config.powershell.tags, []);
  assert.ok(config.claude.tags.includes('coding') && config.claude.tags.includes('audit'));
  assert.ok(config.claude_fable.tags.includes('reasoning'));
  assert.ok(config.codex.tags.includes('delegation'));
  assert.ok(config.cursor.tags.includes('delegation'));
  assert.ok(config.perplexity.tags.includes('search') && config.perplexity.tags.includes('research'));
  for (const kind of ['ollama', 'ollama_fast', 'ollama_llama', 'ollama_coder']) {
    assert.ok(config[kind].tags.includes('local'), kind + ' is tagged local');
  }
  assert.deepEqual(config.groq_llama_fast.tags, ['hosted', 'utility']);
});

test('server, MCP adapter, Perplexity wrapper, and inline browser script parse', () => {
  for (const file of [
    'server.js',
    path.join('tools', 'pplx.js'),
    path.join('tools', 'mcp-smoke.mjs'),
    path.join('mcp', 'server.mjs'),
    path.join('mcp', 'bridge-client.mjs'),
    path.join('mcp', 'router.mjs'),
    path.join('mcp', 'receipts.mjs'),
    'timeout-policy.cjs',
  ]) {
    const result = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net/);
  assert.match(html, /\/vendor\/xterm\/lib\/xterm\.js/);
  assert.match(html, /summary\.textContent/);
  const match = html.match(/<script>\s*(const API =[\s\S]*?)<\/script>/);
  assert.ok(match, 'inline application script was not found');
  assert.doesNotThrow(() => new Function(match[1]));
  const startScript = fs.readFileSync(path.join(ROOT, 'start.ps1'), 'utf8');
  assert.doesNotMatch(startScript, /^\s*(?:&\s*)?npm\s+(?:ci|install)/im, 'normal start must not mutate dependencies');
  assert.match(startScript, /expectedBuildId/);
  assert.match(startScript, /api\/health/);
});

test('MCP bridge startup rejects a healthy same-version listener with a different build identity', async (t) => {
  const port = await reservePort();
  const listener = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ version: '2.0.1', buildId: '2.0.1+stale-build', capabilityAuth: true }));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => listener.close(resolve)));

  const moduleUrl = pathToFileURL(path.join(ROOT, 'mcp', 'bridge-client.mjs')).href;
  const childScript = `
    import { startBridge } from ${JSON.stringify(moduleUrl)};
    try {
      await startBridge();
      console.error('unexpected startup acceptance');
      process.exit(2);
    } catch (error) {
      console.error(error.message);
      process.exit(/MCP expects 2\\.0\\.1/.test(error.message) ? 0 : 3);
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', childScript], {
    cwd: ROOT,
    env: { ...process.env, RELAYBRIDGE_URL: `http://127.0.0.1:${port}` },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(exitCode, 0, output);
  assert.match(output, /stale-build/);
});

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

async function capabilityHeaders(baseUrl, contentType = false) {
  const response = await fetch(baseUrl + '/api/capability');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.match(data.token, /^[A-Fa-f0-9]{64}$/);
  return {
    ...(contentType ? { 'Content-Type': 'application/json' } : {}),
    'X-PS-Bridge-Token': data.token,
  };
}

test('prompt-file transport preserves long special-character prompts and cleans up', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-bridge-test-'));
  const promptTemp = path.join(tempRoot, 'prompt-temp');
  fs.mkdirSync(promptTemp);
  const helper = path.join(ROOT, 'test', 'prompt-file-cli.js');
  const configPath = path.join(tempRoot, 'config.json');
  const tokenPath = path.join(tempRoot, 'capability.token');
  const baseSlot = [process.execPath, helper, '--prompt-file', '{prompt_file}'];
  fs.writeFileSync(configPath, JSON.stringify({
    echo: {
      label: 'Echo',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: baseSlot,
      oneshot_dangerous: baseSlot,
      diagnostic_binary: process.execPath,
      probe: [process.execPath, helper, '--version'],
    },
    fail: {
      label: 'Fail',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--exit', '7'],
      oneshot_dangerous: [...baseSlot, '--exit', '7'],
    },
    rate_fail: {
      label: 'Rate Limited Failure',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--stderr', 'HTTP 429 rate limit exceeded', '--exit', '29'],
      oneshot_dangerous: [...baseSlot, '--stderr', 'HTTP 429 rate limit exceeded', '--exit', '29'],
    },
    slow: {
      label: 'Slow',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--delay', '10000'],
      oneshot_dangerous: [...baseSlot, '--delay', '10000'],
      diagnostic_binary: process.execPath,
      probe: [process.execPath, helper, '--version'],
    },
    env_echo: {
      label: 'Environment Echo',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--print-env', 'BRIDGE_TEST_OVERRIDE'],
      oneshot_dangerous: [...baseSlot, '--print-env', 'BRIDGE_TEST_OVERRIDE'],
      oneshot_env: { BRIDGE_TEST_OVERRIDE: 'isolated-value' },
    },
    cwd_echo: {
      label: 'Working Directory Echo',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--output', '{cwd}'],
      oneshot_dangerous: [...baseSlot, '--output', '{cwd}'],
    },
    bad_env: {
      label: 'Invalid Environment',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: baseSlot,
      oneshot_dangerous: baseSlot,
      oneshot_env: ['not', 'an', 'object'],
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
      PS_BRIDGE_CONFIG_FILE: configPath,
      PS_BRIDGE_TOKEN_FILE: tokenPath,
      PS_BRIDGE_DATA_DIR: path.join(tempRoot, 'data'),
      TEMP: promptTemp,
      TMP: promptTemp,
    },
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

  try {
    await waitForHealth(baseUrl, proc);
  } catch (err) {
    throw new Error(err.message + '\n' + serverOutput);
  }

  const auth = await capabilityHeaders(baseUrl);
  const jsonAuth = await capabilityHeaders(baseUrl, true);
  const dashboard = await fetch(baseUrl + '/');
  assert.equal(dashboard.headers.get('x-frame-options'), 'DENY');
  assert.match(dashboard.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.match(dashboard.headers.get('content-security-policy') || '', /script-src-attr 'none'/);
  const dashboardHtml = await dashboard.text();
  assert.match(dashboardHtml, /<script nonce="[A-Za-z0-9+/=]+">\s*const API/);
  assert.match(dashboardHtml, /const ONE_SHOT_DEFAULT_TIMEOUT_MS = 600000;/);
  assert.doesNotMatch(dashboardHtml, /__ONE_SHOT_DEFAULT_TIMEOUT_MS__/);
  const runningHealth = await (await fetch(baseUrl + '/api/health')).json();
  assert.equal(runningHealth.fullPermissions, false);
  assert.equal(runningHealth.buildId, '2.0.1');
  assert.equal(runningHealth.stickyDangerousEnabled, false);
  assert.deepEqual(runningHealth.oneShotTimeoutPolicy, { minimumMs: 1000, defaultMs: 600000, maxMs: 2700000 });
  assert.ok(Object.prototype.hasOwnProperty.call(runningHealth, 'tokenAcl'));
  if (process.platform === 'win32') {
    assert.equal(runningHealth.tokenAcl.applicable, true);
    assert.equal(runningHealth.tokenAcl.hardened, true, runningHealth.tokenAcl.detail);
  }
  const unauthenticated = await fetch(baseUrl + '/api/diag');
  assert.equal(unauthenticated.status, 401);
  const hostileOrigin = await fetch(baseUrl + '/api/capability', {
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(hostileOrigin.status, 403);
  const traversal = await fetch(baseUrl + '/api/collabs/..%2F..%2Fpackage', { headers: auth });
  assert.notEqual(traversal.status, 200);

  const prompt = ('quotes " and apostrophe \' plus %PATH% & | < > ^ ! ( ) and Unicode Ω🚀\n').repeat(180);
  assert.ok(prompt.length > 8191);
  const response = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ kind: 'echo', prompt, timeoutMs: 600001, dangerous: false }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, prompt.trim());
  assert.equal(result.route.prompt_transport, 'file');
  assert.equal(result.route.prompt_truncated, false);
  assert.equal(result.route.requested_timeout_ms, 600001);
  assert.equal(result.route.effective_timeout_ms, 600001);
  assert.equal(result.route.timeout_clamped, false);
  assert.deepEqual(fs.readdirSync(promptTemp), []);

  const cappedTimeoutResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ kind: 'echo', prompt: 'timeout cap', timeoutMs: 1500000, dangerous: false }),
  });
  assert.equal(cappedTimeoutResponse.status, 200);
  const cappedTimeoutResult = await cappedTimeoutResponse.json();
  assert.equal(cappedTimeoutResult.route.requested_timeout_ms, 1500000);
  // 1.5M ms sits under the raised ceiling (2.7M), so it passes through unclamped.
  assert.equal(cappedTimeoutResult.route.effective_timeout_ms, 1500000);
  assert.equal(cappedTimeoutResult.route.timeout_clamped, false);

  // Above the ceiling the policy clamps; an OMITTED timeout arms no clock at
  // all (effective is null) — supervision governs instead.
  const overCapResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ kind: 'echo', prompt: 'over the cap', timeoutMs: 9000000, dangerous: false }),
  });
  assert.equal(overCapResponse.status, 200);
  const overCapResult = await overCapResponse.json();
  assert.equal(overCapResult.route.effective_timeout_ms, 2700000);
  assert.equal(overCapResult.route.timeout_clamped, true);

  const noTimeoutResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ kind: 'echo', prompt: 'supervision governs', dangerous: false }),
  });
  assert.equal(noTimeoutResponse.status, 200);
  const noTimeoutResult = await noTimeoutResponse.json();
  assert.equal(noTimeoutResult.route.requested_timeout_ms, null);
  assert.equal(noTimeoutResult.route.effective_timeout_ms, null);
  assert.equal(noTimeoutResult.route.timeout_clamped, false);
  assert.equal(noTimeoutResult.stop_reason, null);

  const envResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ kind: 'env_echo', prompt: 'environment isolation', dangerous: false }),
  });
  assert.equal(envResponse.status, 200);
  const envResult = await envResponse.json();
  assert.equal(envResult.stdout, 'isolated-value');
  assert.deepEqual(envResult.route.environment_overrides, ['BRIDGE_TEST_OVERRIDE']);
  assert.equal(Object.prototype.hasOwnProperty.call(envResult.route, 'BRIDGE_TEST_OVERRIDE'), false);

  const cwdResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ kind: 'cwd_echo', prompt: 'workspace binding', cwd: tempRoot, dangerous: false }),
  });
  assert.equal(cwdResponse.status, 200);
  assert.equal((await cwdResponse.json()).stdout, tempRoot);

  const healthyRateDiscussion = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({
      kind: 'echo',
      prompt: 'Healthy audit prose: rate limit handling should preserve HTTP 429 details.',
      dangerous: false,
    }),
  });
  assert.equal(healthyRateDiscussion.status, 200);
  const healthyRateResult = await healthyRateDiscussion.json();
  assert.equal(healthyRateResult.exitCode, 0);
  assert.equal(healthyRateResult.rate_limited, false);
  assert.equal(healthyRateResult.dropped_out, false);

  const badEnvResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ kind: 'bad_env', prompt: 'must fail before spawn', dangerous: false }),
  });
  assert.equal(badEnvResponse.status, 500);
  assert.match((await badEnvResponse.json()).error, /invalid oneshot environment/);

  const failedResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ kind: 'fail', prompt: 'failure cleanup', dangerous: false }),
  });
  const failed = await failedResponse.json();
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.dropped_out, true);
  assert.deepEqual(fs.readdirSync(promptTemp), []);

  const rateFailureResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ kind: 'rate_fail', prompt: 'genuine provider failure', dangerous: false }),
  });
  const rateFailure = await rateFailureResponse.json();
  assert.equal(rateFailure.exitCode, 29);
  assert.equal(rateFailure.rate_limited, true);
  assert.equal(rateFailure.dropped_out, true);

  const blankResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ kind: 'echo', prompt: '   ' }),
  });
  assert.equal(blankResponse.status, 400);

  const firstController = new AbortController();
  const firstSlow = fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ kind: 'slow', prompt: 'first slow request', dangerous: false }),
    signal: firstController.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const duplicateSlow = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ kind: 'slow', prompt: 'duplicate slow request', dangerous: false }),
  });
  assert.equal(duplicateSlow.status, 429);
  const admission = await duplicateSlow.json();
  assert.equal(admission.failureClass, 'admission_limit');
  assert.equal(admission.retryable, true);
  firstController.abort();
  await firstSlow.catch(() => {});
  const admissionDeadline = Date.now() + 5000;
  let activeOneShotCount = -1;
  while (Date.now() < admissionDeadline) {
    activeOneShotCount = (await (await fetch(baseUrl + '/api/health')).json()).activeOneShotCount;
    if (activeOneShotCount === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(activeOneShotCount, 0);

  const diag = await (await fetch(baseUrl + '/api/diag', { headers: auth })).json();
  assert.equal(diag.results.echo.found, true);
  assert.equal(diag.results.echo.ready, true);
  assert.match(diag.results.echo.detail, /prompt-file-cli 1\.0\.0/);
  const activity = await (await fetch(baseUrl + '/api/activity?limit=5', { headers: auth })).json();
  assert.ok(Array.isArray(activity.runs));
  assert.ok(Array.isArray(activity.receipts));
});

test('local Ollama adapter uses loopback HTTP, returns final-only text, and records usage', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-bridge-ollama-test-'));
  const configPath = path.join(tempRoot, 'config.json');
  const tokenPath = path.join(tempRoot, 'capability.token');
  const apiPort = await reservePort();
  let requestPayload = null;
  const ollama = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requestPayload = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: 'fake-local:1b',
      response: '<think>private trace</think>\nFINAL_ONLY',
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 12,
      eval_count: 3,
      total_duration: 99,
      load_duration: 4,
    }));
  });
  await new Promise((resolve, reject) => {
    ollama.once('error', reject);
    ollama.listen(apiPort, '127.0.0.1', resolve);
  });

  fs.writeFileSync(configPath, JSON.stringify({
    local: {
      label: 'Fake local model',
      transport: 'local:ollama',
      oneshot_adapter: 'ollama_api',
      model: 'fake-local:1b',
      strip_thinking: true,
      max_output_tokens: 64,
      safe: [process.execPath, '--version'],
      dangerous: [process.execPath, '--version'],
      oneshot_safe: [process.execPath, '--version'],
      oneshot_dangerous: [process.execPath, '--version'],
      diagnostic_binary: process.execPath,
    },
  }), 'utf8');

  const bridgePort = await reservePort();
  const baseUrl = `http://127.0.0.1:${bridgePort}`;
  const bridge = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(bridgePort),
      PTY_MODE: 'none',
      PS_BRIDGE_CONFIG_FILE: configPath,
      PS_BRIDGE_TOKEN_FILE: tokenPath,
      PS_BRIDGE_DATA_DIR: path.join(tempRoot, 'data'),
      PS_BRIDGE_OLLAMA_URL: `http://127.0.0.1:${apiPort}`,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (bridge.exitCode === null) bridge.kill('SIGTERM');
    await new Promise((resolve) => bridge.exitCode !== null ? resolve() : bridge.once('exit', resolve));
    await new Promise((resolve) => ollama.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, bridge);
  const headers = await capabilityHeaders(baseUrl, true);
  const response = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'local', prompt: 'test prompt', dangerous: false }),
  });
  const result = await response.json();
  assert.equal(result.stdout, 'FINAL_ONLY');
  assert.equal(result.route.prompt_transport, 'local_http');
  assert.equal(result.route.resolved_model, 'fake-local:1b');
  assert.equal(result.usage.input_tokens, 12);
  assert.equal(result.usage.output_tokens, 3);
  assert.equal(result.dropped_out, false);
  assert.equal(requestPayload.stream, false);
  assert.equal(requestPayload.think, false);
  assert.equal(requestPayload.options.num_predict, 64);
});

test('hosted OpenAI-compatible adapter blocks China-hosted endpoints before network access', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-bridge-hosted-block-test-'));
  const configPath = path.join(tempRoot, 'config.json');
  const tokenPath = path.join(tempRoot, 'capability.token');
  fs.writeFileSync(configPath, JSON.stringify({
    blocked: {
      label: 'Blocked hosted model',
      transport: 'hosted:openai-compatible',
      oneshot_adapter: 'openai_chat_api',
      api_base_url: 'https://api.deepseek.com/chat/completions',
      api_key_env: 'TEST_BLOCKED_HOSTED_KEY',
      model: 'deepseek-chat',
      safe: ['hosted-openai-compatible'],
      dangerous: ['hosted-openai-compatible'],
      oneshot_safe: ['hosted-openai-compatible'],
      oneshot_dangerous: ['hosted-openai-compatible'],
    },
  }), 'utf8');

  const bridgePort = await reservePort();
  const baseUrl = `http://127.0.0.1:${bridgePort}`;
  const bridge = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(bridgePort),
      PTY_MODE: 'none',
      PS_BRIDGE_CONFIG_FILE: configPath,
      PS_BRIDGE_TOKEN_FILE: tokenPath,
      PS_BRIDGE_DATA_DIR: path.join(tempRoot, 'data'),
      TEST_BLOCKED_HOSTED_KEY: 'sk-test-not-real',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (bridge.exitCode === null) bridge.kill('SIGTERM');
    await new Promise((resolve) => bridge.exitCode !== null ? resolve() : bridge.once('exit', resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, bridge);
  const headers = await capabilityHeaders(baseUrl, true);
  const response = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'blocked', prompt: 'test prompt', dangerous: false }),
  });
  const result = await response.json();
  assert.equal(result.exitCode, -1);
  assert.equal(result.dropped_out, true);
  assert.match(result.stderr, /blocked by geo\/supply-chain policy/);
});

test('agents listing, tag updates, and broadcast fan-out respect auth, autoRoute, and the global cap', { timeout: 60000 }, async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-bridge-broadcast-test-'));
  const configPath = path.join(tempRoot, 'config.json');
  const tokenPath = path.join(tempRoot, 'capability.token');
  const helper = path.join(ROOT, 'test', 'prompt-file-cli.js');
  const provider = (label, extra = {}, slotExtra = []) => ({
    label,
    safe: [process.execPath, helper, '--version'],
    dangerous: [process.execPath, helper, '--version'],
    oneshot_safe: [process.execPath, helper, '--prompt-file', '{prompt_file}', ...slotExtra],
    oneshot_dangerous: [process.execPath, helper, '--prompt-file', '{prompt_file}', ...slotExtra],
    diagnostic_binary: process.execPath,
    probe: [process.execPath, helper, '--version'],
    ...extra,
  });
  fs.writeFileSync(configPath, JSON.stringify({
    alpha_one: provider('Alpha One', { tags: ['alpha'] }, ['--delay', '250']),
    alpha_two: provider('Alpha Two', { tags: ['alpha', 'beta'] }, ['--delay', '250']),
    beta_only: provider('Beta Only', { tags: ['beta'] }, ['--delay', '250']),
    optin: provider('Opt-in Quota Seat', { tags: ['alpha'], autoRoute: false }, ['--delay', '250']),
    slow_cancel: provider('Slow Cancellation Seat', { tags: ['slow'], autoRoute: false }, ['--delay', '10000']),
    broken: provider('Broken', { tags: ['beta'] }, ['--exit', '5']),
    shell: {
      label: 'Interactive Shell',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
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
      RELAYBRIDGE_CONFIG_FILE: configPath,
      RELAYBRIDGE_TOKEN_FILE: tokenPath,
      RELAYBRIDGE_DATA_DIR: path.join(tempRoot, 'data'),
      RELAYBRIDGE_MAX_ACTIVE_ONESHOTS: '2',
    },
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
  try {
    await waitForHealth(baseUrl, proc);
  } catch (err) {
    throw new Error(err.message + '\n' + serverOutput);
  }
  const jsonAuth = await capabilityHeaders(baseUrl, true);

  // Auth gating: every new endpoint rejects requests without the token.
  for (const [method, route] of [
    ['GET', '/api/agents'],
    ['POST', '/api/agents/alpha_one/tags'],
    ['POST', '/api/broadcast'],
    ['POST', '/api/admin/restart'],
  ]) {
    const response = await fetch(baseUrl + route, { method });
    assert.equal(response.status, 401, method + ' ' + route + ' must require the capability token');
  }

  // Listing excludes interactive-only shells and reports autoRoute + tags.
  const listed = await (await fetch(baseUrl + '/api/agents', { headers: jsonAuth })).json();
  const ids = listed.agents.map((agent) => agent.id).sort();
  assert.deepEqual(ids, ['alpha_one', 'alpha_two', 'beta_only', 'broken', 'optin', 'slow_cancel']);
  const optin = listed.agents.find((agent) => agent.id === 'optin');
  assert.equal(optin.autoRoute, false);
  assert.deepEqual(optin.tags, ['alpha']);
  assert.equal(listed.agents.find((agent) => agent.id === 'alpha_one').readiness, null);

  // Readiness in the listing is reused from the last /api/diag snapshot.
  await (await fetch(baseUrl + '/api/diag', { headers: jsonAuth })).json();
  const relisted = await (await fetch(baseUrl + '/api/agents', { headers: jsonAuth })).json();
  assert.equal(relisted.agents.find((agent) => agent.id === 'alpha_one').readiness.ready, true);

  // Tag updates validate and persist atomically with 2-space formatting.
  const badTags = await fetch(baseUrl + '/api/agents/alpha_one/tags', {
    method: 'POST', headers: jsonAuth, body: JSON.stringify({ tags: ['Bad Tag'] }),
  });
  assert.equal(badTags.status, 400);
  const notArray = await fetch(baseUrl + '/api/agents/alpha_one/tags', {
    method: 'POST', headers: jsonAuth, body: JSON.stringify({ tags: 'alpha' }),
  });
  assert.equal(notArray.status, 400);
  const unknown = await fetch(baseUrl + '/api/agents/nope/tags', {
    method: 'POST', headers: jsonAuth, body: JSON.stringify({ tags: [] }),
  });
  assert.equal(unknown.status, 404);
  const saved = await fetch(baseUrl + '/api/agents/alpha_one/tags', {
    method: 'POST', headers: jsonAuth, body: JSON.stringify({ tags: ['alpha', 'gamma', 'alpha'] }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).tags, ['alpha', 'gamma']);
  const persistedText = fs.readFileSync(configPath, 'utf8');
  assert.match(persistedText, /^\{\n  "/);
  assert.deepEqual(JSON.parse(persistedText).alpha_one.tags, ['alpha', 'gamma']);

  // Target resolution: tag match skips autoRoute:false unless named explicitly.
  const broadcast = (body, { signal } = {}) => fetch(baseUrl + '/api/broadcast', {
    method: 'POST', headers: jsonAuth, body: JSON.stringify(body), signal,
  });
  assert.equal((await broadcast({ prompt: '   ' })).status, 400);
  assert.equal((await broadcast({ prompt: 'x', tag: 'no-such-tag' })).status, 400);
  assert.equal((await broadcast({ prompt: 'x' })).status, 400);
  assert.equal((await broadcast({ prompt: 'x', providers: ['shell'] })).status, 400);

  const tagged = await (await broadcast({ prompt: 'tag fan-out', tag: 'alpha' })).json();
  assert.deepEqual(tagged.targets.sort(), ['alpha_one', 'alpha_two']);
  assert.ok(tagged.results.every((member) => member.ok && member.output === 'tag fan-out'));

  const explicit = await (await broadcast({ prompt: 'explicit opt-in', providers: ['optin', 'beta_only'] })).json();
  assert.deepEqual(explicit.targets, ['optin', 'beta_only']);
  assert.ok(explicit.results.find((member) => member.provider === 'optin').ok);

  const broadcastController = new AbortController();
  const cancelledBroadcast = broadcast({
    prompt: 'cancel this broadcast',
    providers: ['slow_cancel'],
    timeoutMs: 600001,
  }, { signal: broadcastController.signal });
  setTimeout(() => broadcastController.abort(new Error('broadcast cancellation test')), 150);
  await assert.rejects(cancelledBroadcast);
  const cancellationDeadline = Date.now() + 5000;
  let cancellationHealth;
  while (Date.now() < cancellationDeadline) {
    cancellationHealth = await (await fetch(baseUrl + '/api/health')).json();
    if (cancellationHealth.activeTaskCount === 0 && cancellationHealth.activeOneShotCount === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(cancellationHealth.activeTaskCount, 0, 'cancelled broadcast provider must not outlive its caller');
  assert.equal(cancellationHealth.activeOneShotCount, 0, 'cancelled broadcast must release its admission slot');

  // all:true fans out to every AI provider except opt-in seats, queues past the
  // global cap of 2, and reports per-member failures without failing the run.
  const everyone = await (await broadcast({ prompt: 'all hands', all: true })).json();
  assert.deepEqual(everyone.targets.sort(), ['alpha_one', 'alpha_two', 'beta_only', 'broken']);
  assert.equal(everyone.status, 'partial');
  assert.match(everyone.runId, /^run_/);
  const byProvider = Object.fromEntries(everyone.results.map((member) => [member.provider, member]));
  assert.equal(byProvider.alpha_one.ok, true);
  assert.equal(byProvider.alpha_one.output, 'all hands');
  assert.equal(byProvider.broken.ok, false);
  assert.equal(byProvider.broken.exitCode, 5);
  assert.equal(byProvider.broken.output, '');
  assert.match(byProvider.broken.error, /requested failure/);
  assert.ok(everyone.results.every((member) => Number.isFinite(member.durationMs)));

  // The broadcast run is recorded next to committee/oneshot provenance.
  const activity = await (await fetch(baseUrl + '/api/activity?limit=10', { headers: jsonAuth })).json();
  assert.ok(activity.runs.some((run) => run.runId === everyone.runId && run.mode === 'broadcast'));
  assert.ok(activity.receipts.some((receipt) => receipt.provider === 'alpha_one'));

  // Restart is Windows-only; elsewhere it must refuse instead of dying.
  if (process.platform !== 'win32') {
    const restart = await fetch(baseUrl + '/api/admin/restart', { method: 'POST', headers: jsonAuth });
    assert.equal(restart.status, 501);
    assert.equal((await restart.json()).restarting, false);
  }
});
