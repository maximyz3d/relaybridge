'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'cli-config.json');

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
}

test('provider config uses the installed subscription CLIs and safe headless modes', () => {
  const config = readConfig();
  assert.equal(config.claude.safe[config.claude.safe.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(config.claude.oneshot_safe[config.claude.oneshot_safe.indexOf('--permission-mode') + 1], 'plan');
  assert.deepEqual(config.claude.probe, ['claude', 'auth', 'status']);
  assert.ok(config.claude.strip_env.includes('ANTHROPIC_API_KEY'));
  assert.equal(config.claude.safe[config.claude.safe.indexOf('--model') + 1], 'opus');
  assert.equal(config.claude_fable.safe[config.claude_fable.safe.indexOf('--model') + 1], 'fable');
  assert.equal(config.claude_fable.model, 'claude-fable-5');
  assert.deepEqual(config.claude_fable.probe, ['claude', 'auth', 'status']);
  assert.ok(config.claude_fable.strip_env.includes('ANTHROPIC_API_KEY'));
  assert.equal(config.codex.safe[config.codex.safe.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(config.codex.oneshot_safe[config.codex.oneshot_safe.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(config.codex.oneshot_safe.includes('--ephemeral'));
  assert.deepEqual(config.codex.probe, ['codex', 'login', 'status']);
  assert.equal(config.copilot.npm_package, '@github/copilot');
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
  assert.equal(config.grok.model, 'grok-4.5');
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

test('server, MCP adapter, Perplexity wrapper, and inline browser script parse', () => {
  for (const file of [
    'server.js',
    path.join('tools', 'pplx.js'),
    path.join('tools', 'mcp-smoke.mjs'),
    path.join('mcp', 'server.mjs'),
    path.join('mcp', 'bridge-client.mjs'),
    path.join('mcp', 'router.mjs'),
    path.join('mcp', 'receipts.mjs'),
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
  const runningHealth = await (await fetch(baseUrl + '/api/health')).json();
  assert.equal(runningHealth.fullPermissions, false);
  assert.equal(runningHealth.stickyDangerousEnabled, false);
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
    body: JSON.stringify({ kind: 'echo', prompt, dangerous: false }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, prompt.trim());
  assert.equal(result.route.prompt_transport, 'file');
  assert.equal(result.route.prompt_truncated, false);
  assert.deepEqual(fs.readdirSync(promptTemp), []);

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
