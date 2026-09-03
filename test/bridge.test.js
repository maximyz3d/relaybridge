'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'cli-config.json');
const TEST_BUILD_ID = 'relaybridge-source-test';
const TIMEOUT_POLICY = require('../timeout-policy.cjs');

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
}

test('one-shot timeout policy is centralized: 20 min default, ceiling equals the supervisor hard cap', () => {
  assert.equal(TIMEOUT_POLICY.oneShotDefaultMs, 1200000);
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
  assert.equal(supervisorCfg.idleMs, 1200000, 'buffered providers get the full default window before idle-stall');
  assert.ok(supervisorCfg.idleMs >= TIMEOUT_POLICY.oneShotDefaultMs);
  const routing = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'routing-policy.json'), 'utf8'));
  assert.deepEqual(
    Object.fromEntries(Object.entries(routing.tiers).map(([tier, policy]) => [tier, policy.defaultTimeoutMs])),
    { utility: 1200000, standard: 1200000, complex: 1200000, critical: 1200000 },
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
  assert.deepEqual(config._config_merge.managed_supervisor_budget_fields, {
    maxTurns: { retired_values: [24] },
  });
  assert.equal(config._supervisor.providerBudget.maxTurns, null,
    'progress and token ceilings, not a fixed provider turn count, supervise normal runs');
  assert.deepEqual(config._config_merge.managed_provider_args, {
    claude: {
      slots: ['safe', 'dangerous', 'oneshot_safe', 'oneshot_dangerous'],
      args: [{ flag: '--effort', value_count: 1 }],
    },
    claude_fable: {
      slots: ['safe', 'oneshot_safe'],
      args: [{ flag: '--effort', value_count: 1 }],
    },
  });
  assert.equal(config.claude.safe[config.claude.safe.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(config.claude.oneshot_safe[config.claude.oneshot_safe.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(config.claude.oneshot_safe_filesystem_policy, 'read_only_enforced');
  for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--autocompact']) {
    assert.ok(config.claude.oneshot_safe.includes(flag), `claude safe one-shot includes ${flag}`);
  }
  assert.equal(config.claude.oneshot_safe[config.claude.oneshot_safe.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.equal(config.claude.oneshot_safe[config.claude.oneshot_safe.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.equal(config.claude.oneshot_safe[config.claude.oneshot_safe.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(config.claude.oneshot_safe.includes('--include-partial-messages'));
  assert.equal(config.claude.oneshot_output_parser, 'claude_json');
  assert.deepEqual(config.claude.probe, ['claude', 'auth', 'status']);
  assert.ok(config.claude.strip_env.includes('ANTHROPIC_API_KEY'));
  assert.ok(config.claude.strip_env.includes('CLAUDE_CODE_OAUTH_TOKEN'));
  assert.equal(config.claude.safe[config.claude.safe.indexOf('--model') + 1], 'sonnet');
  assert.equal(config.claude.quota_seat, 'subscription:anthropic:default');
  assert.equal(config.claude_fable.safe[config.claude_fable.safe.indexOf('--model') + 1], 'fable');
  assert.equal(config.claude_fable.safe[config.claude_fable.safe.indexOf('--effort') + 1], 'high');
  assert.equal(config.claude_fable.oneshot_safe[config.claude_fable.oneshot_safe.indexOf('--effort') + 1], 'high');
  assert.equal(config.claude_fable.oneshot_safe_filesystem_policy, 'read_only_enforced');
  assert.deepEqual(config.claude_fable.oneshot_dangerous, [], 'Fable is never a writer');
  for (const kind of ['claude', 'claude_fable']) {
    for (const slot of ['safe', 'dangerous', 'oneshot_safe', 'oneshot_dangerous']) {
      assert.notEqual(config[kind][slot][config[kind][slot].indexOf('--effort') + 1], 'max',
        `${kind}.${slot} must not infer maximum effort`);
    }
  }
  assert.equal(config.claude_fable.oneshot_safe[config.claude_fable.oneshot_safe.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(config.claude_fable.oneshot_safe.includes('--include-partial-messages'));
  assert.equal(config.claude_fable.oneshot_output_parser, 'claude_json');
  assert.equal(config.claude_fable.model, 'fable');
  assert.equal(config.claude_fable.quota_seat, config.claude.quota_seat);
  assert.deepEqual(config.claude_fable.probe, ['claude', 'auth', 'status']);
  assert.ok(config.claude_fable.strip_env.includes('ANTHROPIC_API_KEY'));
  assert.ok(config.claude_fable.strip_env.includes('CLAUDE_CODE_OAUTH_TOKEN'));
  assert.equal(config.codex.safe[config.codex.safe.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(config.codex.oneshot_safe[config.codex.oneshot_safe.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(config.codex.oneshot_safe_filesystem_policy, 'read_only_enforced');
  assert.ok(config.codex.oneshot_safe.includes('--ignore-user-config'));
  assert.ok(config.codex.oneshot_safe.includes('--ignore-rules'));
  assert.ok(config.codex.oneshot_safe.includes('--ephemeral'));
  assert.deepEqual(config.codex.probe, ['codex', 'login', 'status']);
  assert.ok(config.codex.strip_env.includes('CODEX_ACCESS_TOKEN'));
  assert.equal(config.copilot.npm_package, '@github/copilot');
  const supportedCopilotInstallers = [
    ['npm', 'install', '-g', '@github/copilot'],
    ['powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'winget install GitHub.Copilot'],
  ];
  assert.ok(supportedCopilotInstallers.some((candidate) =>
    JSON.stringify(candidate) === JSON.stringify(config.copilot.install_command)),
  'Copilot installer must remain one of the documented safe operator choices');
  assert.deepEqual(config.copilot.probe, ['copilot', '--version']);
  assert.ok(config.copilot.oneshot_safe.includes('--prompt'));
  assert.ok(config.copilot.oneshot_safe.includes('{prompt}'));
  assert.ok(config.copilot.strip_env.includes('COPILOT_GITHUB_TOKEN'));
  assert.ok(config.copilot.strip_env.includes('GITHUB_COPILOT_API_TOKEN'));
  for (const name of [
    'GITHUB_COPILOT_GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST',
    'COPILOT_PROVIDER_BASE_URL', 'COPILOT_PROVIDER_TYPE',
    'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN', 'COPILOT_PROVIDER_WIRE_API',
    'COPILOT_PROVIDER_TRANSPORT', 'COPILOT_PROVIDER_AZURE_API_VERSION', 'COPILOT_PROVIDER_MODEL_ID',
    'COPILOT_PROVIDER_WIRE_MODEL', 'COPILOT_PROVIDER_MODEL_LIMITS_ID',
    'COPILOT_PROVIDER_MAX_PROMPT_TOKENS', 'COPILOT_PROVIDER_MAX_OUTPUT_TOKENS',
    'COPILOT_PROVIDER_HEADERS', 'COPILOT_MODEL', 'COPILOT_OFFLINE', 'COPILOT_ENABLE_ALT_PROVIDERS',
  ]) assert.ok(config.copilot.strip_env.includes(name), `${name} must not override the selected Copilot account`);
  assert.equal(config.gemini.safe[0], 'agy.exe');
  assert.match(config.gemini.label, /Antigravity/);
  assert.deepEqual(config.gemini.probe, ['agy.exe', 'models']);
  assert.equal(config.gemini.usage_capability.tokens, 'unavailable');
  assert.equal(config.gemini.usage_capability.turns, 'unavailable');
  assert.equal(config.gemini.usage_capability.verified_runtime_version, '1.1.19');
  assert.match(config.gemini.usage_capability.evidence, /no token-usage, turn-usage/);
  assert.ok(config.gemini.safe.includes('--sandbox'));
  assert.equal(config.gemini.oneshot_safe.at(-2), '--print');
  assert.equal(config.gemini.oneshot_safe.at(-1), '{prompt}');
  assert.deepEqual(config.gemini.login_command, ['agy'], 'Antigravity signs in through its own interactive TUI');
  assert.equal(config.gemini.oneshot_safe[config.gemini.oneshot_safe.indexOf('--add-dir') + 1], '{cwd}');
  assert.equal(config.gemini.oneshot_safe[config.gemini.oneshot_safe.indexOf('--effort') + 1], 'high');
  assert.equal(config.gemini.oneshot_safe[config.gemini.oneshot_safe.indexOf('--print-timeout') + 1], '15m');
  assert.equal(config.gemini.oneshot_dangerous[config.gemini.oneshot_dangerous.indexOf('--print-timeout') + 1], '15m');
  assert.deepEqual(config.gemini.model_tiers.light, {
    args: ['--model', 'gemini-3.5-flash-low'], model: 'gemini-3.5-flash-low',
    suppress_args: [{ flag: '--effort', value_count: 1 }], note: 'current low-effort Flash id reported by agy models',
  });
  assert.deepEqual(config.gemini.model_tiers.standard, {
    args: ['--model', 'gemini-3.6-flash-medium'], model: 'gemini-3.6-flash-medium',
    suppress_args: [{ flag: '--effort', value_count: 1 }], note: 'current medium-effort Flash id reported by agy models',
  });
  assert.deepEqual(config.gemini.model_tiers.heavy, {
    args: ['--model', 'gemini-3.1-pro-high'], model: 'gemini-3.1-pro-high',
    suppress_args: [{ flag: '--effort', value_count: 1 }], note: 'current high-effort Pro id reported by agy models',
  });
  assert.equal(config.gemini.oneshot_safe[config.gemini.oneshot_safe.indexOf('--mode') + 1], 'plan');
  assert.equal(config.gemini.oneshot_safe_prompt_policy, 'antigravity_headless_builtin_read_only_tools');
  assert.match(config.gemini.oneshot_safe_prompt_prefix, /do not invoke terminal or command tools/i);
  assert.doesNotMatch(config.gemini.oneshot_safe_prompt_prefix, /dangerously-skip-permissions/i);
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
  assert.equal(config.ollama.oneshot_safe_filesystem_policy, 'read_only_enforced');
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
  assert.match(html, /failureClass === 'incomplete_response'/);
  assert.match(html, /vendor observed/);
  assert.match(html, /g\.vendorQuota\.actual/);
  assert.match(html, /g\.vendorQuota\.reset\.expiresAt/);
  assert.match(html, /operator-quota-percent/);
  assert.match(html, /operator_observed/);
  assert.match(html, /g\.operatorQuota\.provenance/);
  assert.match(html, /\/api\/usage\/operator-quota/);
  assert.match(html, /Credentials, dashboard content, and free-form notes are never accepted or stored/);
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
  const realProviderHome = path.join(tempRoot, 'real-provider-home');
  fs.mkdirSync(promptTemp);
  fs.mkdirSync(realProviderHome);
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
    isolated_echo: {
      label: 'Isolated Echo',
      oneshot_safe_filesystem_policy: 'isolated_home',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--write-home-artifact'],
      oneshot_dangerous: [...baseSlot, '--write-home-artifact'],
    },
    isolated_race: {
      label: 'Isolated Disconnect Race',
      oneshot_safe_filesystem_policy: 'isolated_home',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--spawn-delayed-home-artifact', '--delay', '10000'],
      oneshot_dangerous: [...baseSlot, '--spawn-delayed-home-artifact', '--delay', '10000'],
    },
    unverified_echo: {
      label: 'Unverified Echo',
      oneshot_safe_filesystem_policy: 'unverified_provider_policy',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--write-home-artifact'],
      oneshot_dangerous: [...baseSlot, '--write-home-artifact'],
    },
    claude: {
      label: 'Unverified Claude Routing Fixture',
      oneshot_safe_filesystem_policy: 'unverified_provider_policy',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: baseSlot,
      oneshot_dangerous: baseSlot,
      diagnostic_binary: process.execPath,
      probe: [process.execPath, helper, '--version'],
    },
    gemini_auto_compat: {
      label: 'Gemini Auto Compatibility Fixture',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--model', 'concrete', '--effort', 'high'],
      oneshot_dangerous: [...baseSlot, '--model', 'concrete', '--effort', 'high'],
      model_tiers: {
        heavy: {
          args: ['--model', 'auto'],
          model: 'auto',
          suppress_args: [{ flag: '--effort', value_count: 1 }],
        },
      },
    },
    provider_internal_timeout: {
      label: 'Provider Internal Timeout Fixture',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--stderr', 'Error: timeout waiting for response', '--exit', '1'],
      oneshot_dangerous: [...baseSlot, '--stderr', 'Error: timeout waiting for response', '--exit', '1'],
    },
    headless_permission_denial: {
      label: 'Antigravity Headless Permission Fixture',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--stderr', 'jetski: no output produced — a tool required the command permission that headless mode cannot prompt for, so it was auto-denied.', '--empty'],
      oneshot_dangerous: [...baseSlot, '--stderr', 'MUST_NOT_USE_DANGEROUS_SLOT', '--exit', '9'],
      oneshot_safe_prompt_policy: 'antigravity_headless_builtin_read_only_tools',
      oneshot_safe_prompt_prefix: 'Use built-in workspace file-reading tools only. Never run terminal commands.',
      prompt_max_chars: 80,
    },
    headless_readonly_success: {
      label: 'Antigravity Command-Free Review Fixture',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: baseSlot,
      oneshot_dangerous: [...baseSlot, '--stderr', 'MUST_NOT_USE_DANGEROUS_SLOT', '--exit', '9'],
      oneshot_safe_prompt_policy: 'antigravity_headless_builtin_read_only_tools',
      oneshot_safe_prompt_prefix: 'Use built-in workspace file-reading tools only. Never run terminal commands.',
    },
    narration_only: {
      label: 'Narration-Only Grok Fixture',
      usage_capability: {
        tokens: 'unavailable', turns: 'unavailable', verified_runtime_version: '1.1.19',
        evidence: 'fixture CLI exposes no authoritative usage',
      },
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--output', 'I will inspect the repository and trace the pipeline.\nNext I will review the tests and report any defects.'],
      oneshot_dangerous: [...baseSlot, '--output', 'I will inspect the repository and trace the pipeline.\nNext I will review the tests and report any defects.'],
    },
    perplexity: {
      label: 'Perplexity No-Answer Sentinel Fixture',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--perplexity-fixture'],
      oneshot_dangerous: [...baseSlot, '--perplexity-fixture'],
      costClass: 'subscription',
    },
    grok: {
      label: 'Grok Quota Fixture',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--stderr', "API error (status 429 Too Many Requests): subscription:free-usage-exhausted: You've used all the included free usage for model grok-4.6 for now. Usage resets over a rolling 24-hour window — tokens (actual/limit): 552,305/500,000. Upgrade to a Grok subscription. model_id=grok-4.6", '--exit', '1'],
      oneshot_dangerous: [...baseSlot, '--stderr', "API error (status 429 Too Many Requests): subscription:free-usage-exhausted: You've used all the included free usage for model grok-4.6 for now. Usage resets over a rolling 24-hour window — tokens (actual/limit): 552,305/500,000. Upgrade to a Grok subscription. model_id=grok-4.6", '--exit', '1'],
      model: 'grok-4.6',
      costClass: 'subscription',
    },
    copilot: {
      label: 'Copilot Monthly Quota Fixture',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--stderr', "You have exceeded your monthly quota (Request ID: 393F:279076:21CF7B:277870:6A7E5965)\n\nChanges    +0 -0\nAI Credits 0 (3s)\nResume     copilot --resume=fixture", '--exit', '1'],
      oneshot_dangerous: [...baseSlot, '--stderr', "You have exceeded your monthly quota (Request ID: 393F:279076:21CF7B:277870:6A7E5965)\n\nChanges    +0 -0\nAI Credits 0 (3s)\nResume     copilot --resume=fixture", '--exit', '1'],
      costClass: 'subscription',
    },
    cursor: {
      label: 'Cursor ActionRequired Fixture',
      transport: 'subscription:cursor',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--cursor-action-required'],
      oneshot_dangerous: [...baseSlot, '--cursor-action-required'],
      model_arg_index: 2,
      model_tiers: {
        standard: { args: ['--model', 'fixture-named-model'], model: 'fixture-named-model' },
      },
      costClass: 'subscription',
    },
    usage_json: {
      label: 'Structured Claude Usage',
      transport: 'subscription:anthropic',
      quota_seat: 'subscription:anthropic:default',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--claude-json', '--effort', 'high'],
      oneshot_dangerous: [...baseSlot, '--claude-json', '--effort', 'high'],
      oneshot_output_parser: 'claude_json',
    },
    codex_effort: {
      label: 'Codex Reasoning Effort Fixture',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: baseSlot,
      oneshot_dangerous: baseSlot,
      effort_flags: {
        minimal: ['--config', 'model_reasoning_effort=minimal'],
        low: ['--config', 'model_reasoning_effort=low'],
        medium: ['--config', 'model_reasoning_effort=medium'],
        high: ['--config', 'model_reasoning_effort=high'],
        max: ['--config', 'model_reasoning_effort=xhigh'],
      },
    },
    queued_controls: {
      label: 'Queued Claude Control Forwarding',
      transport: 'subscription:anthropic',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--claude-json', '--model', 'standard-fixture', '--effort', 'high'],
      oneshot_dangerous: [...baseSlot, '--claude-json', '--model', 'standard-fixture', '--effort', 'high'],
      oneshot_output_parser: 'claude_json',
      model_tiers: {
        heavy: { args: ['--model', 'heavy-fixture'], model: 'heavy-fixture' },
      },
    },
    usage_json_multiturn: {
      label: 'Incremental Multi-Turn Claude Usage',
      transport: 'subscription:anthropic',
      quota_seat: 'subscription:anthropic:default',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--claude-json-multiturn'],
      oneshot_dangerous: [...baseSlot, '--claude-json-multiturn'],
      oneshot_output_parser: 'claude_json',
    },
    usage_json_multiturn_bounded: {
      label: 'Bounded Incremental Claude Diagnostic',
      transport: 'subscription:anthropic',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--claude-json-multiturn-bounded'],
      oneshot_dangerous: [...baseSlot, '--claude-json-multiturn-bounded'],
      oneshot_output_parser: 'claude_json',
    },
    usage_json_longrun: {
      label: 'Healthy Long Agentic Claude Run',
      transport: 'subscription:anthropic',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--claude-json-longrun'],
      oneshot_dangerous: [...baseSlot, '--claude-json-longrun'],
      oneshot_output_parser: 'claude_json',
    },
    usage_json_malformed_models: {
      label: 'Structured Claude Usage With Malformed Model Rows',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--claude-json-malformed-model-usage'],
      oneshot_dangerous: [...baseSlot, '--claude-json-malformed-model-usage'],
      oneshot_output_parser: 'claude_json',
    },
    usage_json_malformed_top: {
      label: 'Structured Claude Usage With Malformed Top-Level Counts',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--claude-json-malformed-top-usage'],
      oneshot_dangerous: [...baseSlot, '--claude-json-malformed-top-usage'],
      oneshot_output_parser: 'claude_json',
    },
    usage_json_partial_cost: {
      label: 'Structured Claude Usage With Partial Model Cost',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--claude-json-partial-cost'],
      oneshot_dangerous: [...baseSlot, '--claude-json-partial-cost'],
      oneshot_output_parser: 'claude_json',
    },
    usage_json_error: {
      label: 'Structured Claude Error Result',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--claude-json-error-result'],
      oneshot_dangerous: [...baseSlot, '--claude-json-error-result'],
      oneshot_output_parser: 'claude_json',
    },
    usage_json_success_error_disagreement: {
      label: 'Structured Claude Success Subtype With Error Flag',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--claude-json-success-error-disagreement'],
      oneshot_dangerous: [...baseSlot, '--claude-json-success-error-disagreement'],
      oneshot_output_parser: 'claude_json',
    },
    usage_json_error_success_flag_disagreement: {
      label: 'Structured Claude Error Subtype With Success Flag',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--claude-json-error-success-flag-disagreement'],
      oneshot_dangerous: [...baseSlot, '--claude-json-error-success-flag-disagreement'],
      oneshot_output_parser: 'claude_json',
    },
    usage_json_invalid_result: {
      label: 'Malformed Structured Claude Result',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--claude-json-invalid-result'],
      oneshot_dangerous: [...baseSlot, '--claude-json-invalid-result'],
      oneshot_output_parser: 'claude_json',
    },
    usage_json_retries: {
      label: 'Structured Claude Retry Result',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--claude-json-retries'],
      oneshot_dangerous: [...baseSlot, '--claude-json-retries'],
      oneshot_output_parser: 'claude_json',
    },
    usage_json_budget_error: {
      label: 'Structured Claude Budget Error',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--claude-json-budget-error'],
      oneshot_dangerous: [...baseSlot, '--claude-json-budget-error'],
      oneshot_output_parser: 'claude_json',
    },
    usage_json_rate_error: {
      label: 'Structured Claude Execution Error',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--claude-json-rate-error'],
      oneshot_dangerous: [...baseSlot, '--claude-json-rate-error'],
      oneshot_output_parser: 'claude_json',
    },
    usage_json_max_tokens: {
      label: 'Structured Claude Truncation',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--claude-json-max-tokens'],
      oneshot_dangerous: [...baseSlot, '--claude-json-max-tokens'],
      oneshot_output_parser: 'claude_json',
    },
    usage_json_auth_error: {
      label: 'Structured Claude Authentication Error',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--claude-json-auth-error'],
      oneshot_dangerous: [...baseSlot, '--claude-json-auth-error'],
      oneshot_output_parser: 'claude_json',
    },
    usage_json_api_timeout: {
      label: 'Structured Claude API Timeout',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--claude-json-api-timeout'],
      oneshot_dangerous: [...baseSlot, '--claude-json-api-timeout'],
      oneshot_output_parser: 'claude_json',
    },
    usage_json_tool_deferred: {
      label: 'Structured Claude Deferred Tool Result',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--claude-json-tool-deferred'],
      oneshot_dangerous: [...baseSlot, '--claude-json-tool-deferred'],
      oneshot_output_parser: 'claude_json',
    },
    usage_json_terminal_from_prompt: {
      label: 'Structured Claude New Terminal Reason',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--claude-json-terminal-from-prompt'],
      oneshot_dangerous: [...baseSlot, '--claude-json-terminal-from-prompt'],
      oneshot_output_parser: 'claude_json',
    },
    retry_hang: {
      label: 'Structured Retry Then Hang',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--claude-json-retry-hang'],
      oneshot_dangerous: [...baseSlot, '--claude-json-retry-hang'],
      oneshot_output_parser: 'claude_json',
    },
    retry_timeout: {
      label: 'Structured Retry Then Timeout',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--claude-json-retry-hang'],
      oneshot_dangerous: [...baseSlot, '--claude-json-retry-hang'],
      oneshot_output_parser: 'claude_json',
      supervisor: { idleMs: 1000, hardCapMs: 1000, graceExtensions: 0 },
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
    race_complete: {
      label: 'Completion Cancellation Race',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--delay', '200', '--output', 'RACE_COMPLETED'],
      oneshot_dangerous: [...baseSlot, '--delay', '200', '--output', 'RACE_COMPLETED'],
    },
    correlation_slow: {
      label: 'Concurrent Correlation Slow Fixture',
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: [...baseSlot, '--delay', '1000'],
      oneshot_dangerous: [...baseSlot, '--delay', '1000'],
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
      NODE_ENV: 'test',
      RELAYBRIDGE_TEST_BUILD_ID: TEST_BUILD_ID,
      PORT: String(port),
      PTY_MODE: 'none',
      PS_BRIDGE_CONFIG_FILE: configPath,
      PS_BRIDGE_TOKEN_FILE: tokenPath,
      PS_BRIDGE_DATA_DIR: path.join(tempRoot, 'data'),
      // TMPDIR as well as TEMP/TMP: on POSIX os.tmpdir() reads TMPDIR FIRST, so
      // with TMPDIR exported (always on macOS, common in CI) the server wrote
      // its prompt files and isolated provider homes to the system temp dir and
      // promptTemp stayed empty — the cleanup assertions below then passed
      // without testing anything, and would keep passing if every prompt leaked.
      TMPDIR: promptTemp,
      TEMP: promptTemp,
      TMP: promptTemp,
      HOME: realProviderHome,
      USERPROFILE: realProviderHome,
      RELAYBRIDGE_ALLOWED_ROOTS: tempRoot,
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
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
  assert.match(dashboardHtml, /const ONE_SHOT_DEFAULT_TIMEOUT_MS = 1200000;/);
  assert.doesNotMatch(dashboardHtml, /__ONE_SHOT_DEFAULT_TIMEOUT_MS__/);
  assert.match(dashboardHtml, /provider budgets are unenforceable and character estimates are disabled/);
  const runningHealth = await (await fetch(baseUrl + '/api/health')).json();
  assert.equal(runningHealth.fullPermissions, false);
  assert.equal(runningHealth.buildId, TEST_BUILD_ID);
  assert.equal(runningHealth.stickyDangerousEnabled, false);
  assert.equal(runningHealth.startFullPermissionsEnabled, false);
  assert.equal(typeof runningHealth.runtime.platform, 'string');
  assert.equal(runningHealth.runtime.wslNative.ok, true);
  assert.equal(runningHealth.runtime.nativeProviderBinariesOnly, true);
  assert.deepEqual(runningHealth.oneShotTimeoutPolicy, { minimumMs: 1000, defaultMs: 1200000, maxMs: 2700000 });
  assert.ok(Object.prototype.hasOwnProperty.call(runningHealth, 'tokenAcl'));
  if (process.platform === 'win32') {
    assert.equal(runningHealth.tokenAcl.applicable, true);
    assert.equal(runningHealth.tokenAcl.hardened, true, runningHealth.tokenAcl.detail);
  }
  const unauthenticated = await fetch(baseUrl + '/api/diag');
  assert.equal(unauthenticated.status, 401);
  const usageDiagnostics = await (await fetch(baseUrl + '/api/diag', { headers: auth })).json();
  assert.equal(usageDiagnostics.results.narration_only.usageCapability.budgetEnforcement, 'unenforceable');
  assert.equal(usageDiagnostics.results.narration_only.usageCapability.characterEstimateFallback, false);
  const usageAgents = await (await fetch(baseUrl + '/api/agents', { headers: auth })).json();
  assert.equal(usageAgents.agents.find((agent) => agent.id === 'narration_only')
    .usageCapability.budgetEnforcement, 'unenforceable');
  assert.equal(usageDiagnostics.results.claude.ready, true, 'provider authentication/readiness remains distinct');
  assert.equal(usageDiagnostics.results.claude.safeReady, false);
  assert.equal(usageDiagnostics.results.claude.safeFilesystem.policy, 'unverified_provider_policy');
  const claudeAgent = usageAgents.agents.find((agent) => agent.id === 'claude');
  assert.equal(claudeAgent.readiness.ready, true);
  assert.equal(claudeAgent.safeOneShot.ready, false);
  assert.match(claudeAgent.safeOneShot.blockedReason, /filesystem policy is unverified/);

  const safeFilesystemRoute = await (await fetch(baseUrl + '/api/route', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ task: 'review this code change', preferKinds: ['claude'] }),
  })).json();
  assert.equal(safeFilesystemRoute.selected.some((pick) => pick.kind === 'claude'), false);
  const blockedClaudeCandidate = safeFilesystemRoute.candidates.find((pick) => pick.kind === 'claude');
  assert.equal(blockedClaudeCandidate.readiness.ready, false);
  assert.equal(blockedClaudeCandidate.readiness.safeFilesystem.policy, 'unverified_provider_policy');
  assert.match(blockedClaudeCandidate.policyReasons.join(' '), /not ready/);
  assert.ok(safeFilesystemRoute.fleetState.filesystemSkipped.some((item) => item.kind === 'claude'));

  const explicitSafePlan = await (await fetch(baseUrl + '/api/plan', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ task: 'review this code change', kind: 'claude' }),
  })).json();
  assert.equal(explicitSafePlan.primary.kind, 'claude');
  assert.equal(explicitSafePlan.primary.ready, false);
  assert.equal(explicitSafePlan.primary.blocked, true);
  assert.equal(explicitSafePlan.primary.filesystem.policy, 'unverified_provider_policy');
  assert.match(explicitSafePlan.guidance.join(' '), /blocked before invocation/);

  const unauthorizedWriterPlan = await fetch(baseUrl + '/api/plan', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ task: 'review and edit this code', kind: 'claude', dangerous: true }),
  });
  assert.equal(unauthorizedWriterPlan.status, 400);
  assert.match((await unauthorizedWriterPlan.json()).error, /acknowledgeFilesystemWrites=true/);
  const authorizedWriterPlan = await (await fetch(baseUrl + '/api/plan', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({
      task: 'review and edit this code', kind: 'claude', dangerous: true,
      acknowledgeFilesystemWrites: true,
    }),
  })).json();
  assert.equal(authorizedWriterPlan.primary.ready, true);
  assert.equal(authorizedWriterPlan.primary.filesystem.policy, 'writer_authorized');
  assert.equal(authorizedWriterPlan.fleetState.filesystemAuthority.dangerous, true);

  const safeFilesystemAdvise = await (await fetch(baseUrl + '/api/usage/advise', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ candidates: [{ seat: 'claude' }, { seat: 'grok' }] }),
  })).json();
  assert.equal(safeFilesystemAdvise.ranked.some((item) => item.seat === 'claude'), false);
  assert.equal(safeFilesystemAdvise.filesystemSkipped[0].seat, 'claude');
  assert.equal(safeFilesystemAdvise.filesystemSkipped[0].blocked, true);

  const datasheetTask = 'Read-only manufacturer-datasheet audit of BNO085 and KX134 exact pins, packages, required support circuits, interrupt/reset/boot topology, and power-domain isolation requirements; no file edits';
  const datasheetRouteResponse = await fetch(baseUrl + '/api/route', {
    method: 'POST', headers: jsonAuth, body: JSON.stringify({ task: datasheetTask }),
  });
  assert.equal(datasheetRouteResponse.status, 200);
  const datasheetRoute = await datasheetRouteResponse.json();
  assert.equal(datasheetRoute.primaryTag, 'research');
  assert.ok(datasheetRoute.classification.tags.includes('research'));
  assert.ok(datasheetRoute.selected.every((candidate) => candidate.capabilities.includes('research')));

  const datasheetCli = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'relaybridge.js'), 'plan', datasheetTask, '--json'], {
    cwd: ROOT,
    env: {
      ...process.env,
      RELAYBRIDGE_URL: baseUrl,
      RELAYBRIDGE_TOKEN: fs.readFileSync(tokenPath, 'utf8').trim(),
    },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(datasheetCli.status, 0, datasheetCli.stderr);
  const datasheetPlan = JSON.parse(datasheetCli.stdout);
  assert.equal(datasheetPlan.taskTags.includes('research'), true);
  assert.notEqual(datasheetPlan.primary?.costClass, 'local');
  const hostileOrigin = await fetch(baseUrl + '/api/capability', {
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(hostileOrigin.status, 403);
  const proxiedCapability = await fetch(baseUrl + '/api/capability', {
    headers: { 'X-Forwarded-For': '203.0.113.9' },
  });
  assert.equal(proxiedCapability.status, 403);
  const proxiedExec = await fetch(baseUrl + '/api/exec', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' },
    body: JSON.stringify({ command: 'Write-Output MUST_NOT_RUN' }),
  });
  assert.equal(proxiedExec.status, 403);
  // The 403 above never reaches the spawn, which is how a ReferenceError in the
  // close handler ("built is not defined") shipped under a green suite and
  // killed the process on the first real call. Exercise the success path, and
  // assert the bridge is still alive afterwards.
  // AbortSignal.timeout matters here: when this route kills the process, the
  // socket dies mid-request and an untimed fetch hangs the whole run instead of
  // failing. A hung suite is an ambiguous CI signal; this makes the defect
  // report as a fast, attributable failure on this assertion.
  let realExec;
  try {
    realExec = await fetch(baseUrl + '/api/exec', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: process.platform === 'win32' ? 'Write-Output EXEC_OK' : 'echo EXEC_OK',
        shell: process.platform === 'win32' ? 'powershell' : 'bash',
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    assert.fail(`/api/exec did not answer (${err.code || err.name}: ${err.message}) — `
      + 'the bridge most likely died handling it; check for an uncaught throw in the child close handler');
  }
  assert.equal(realExec.status, 200);
  const execBody = await realExec.json();
  assert.equal(execBody.exitCode, 0);
  assert.match(execBody.stdout, /EXEC_OK/);
  // The requested shell must be honoured, not silently replaced by powershell.
  assert.equal(execBody.shell, process.platform === 'win32' ? 'powershell' : 'bash');
  const stillAlive = await fetch(baseUrl + '/api/health');
  assert.equal(stillAlive.status, 200);

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

  // Raw callers own the response matching through their unique requestId.
  // The slower request starts first but completes last, so selecting the
  // newest receipt would misattribute the fast caller even though the store
  // itself preserved two distinct request -> invocation -> receipt tuples.
  const slowRequestId = 'test:correlation:slow-0001';
  const fastRequestId = 'test:correlation:fast-0001';
  const slowPrompt = 'concurrent correlation slow';
  const fastPrompt = 'concurrent correlation fast';
  const slowCorrelationRequest = fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({
      kind: 'correlation_slow', prompt: slowPrompt, dangerous: false,
      requestId: slowRequestId,
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const fastCorrelationRequest = fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({
      kind: 'echo', prompt: fastPrompt, dangerous: false,
      requestId: fastRequestId,
    }),
  });
  const [slowCorrelationResponse, fastCorrelationResponse] = await Promise.all([
    slowCorrelationRequest,
    fastCorrelationRequest,
  ]);
  assert.equal(slowCorrelationResponse.status, 200);
  assert.equal(fastCorrelationResponse.status, 200);
  const slowCorrelation = await slowCorrelationResponse.json();
  const fastCorrelation = await fastCorrelationResponse.json();
  assert.equal(slowCorrelation.requestId, slowRequestId);
  assert.equal(slowCorrelation.invocationId, slowRequestId);
  assert.equal(fastCorrelation.requestId, fastRequestId);
  assert.equal(fastCorrelation.invocationId, fastRequestId);
  assert.notEqual(slowCorrelation.receiptId, fastCorrelation.receiptId);

  const correlationRows = fs.readFileSync(
    path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'),
    'utf8',
  ).trim().split(/\r?\n/).map(JSON.parse).filter((row) =>
    [slowRequestId, fastRequestId].includes(row.requestId));
  assert.deepEqual(correlationRows.map((row) => row.requestId), [fastRequestId, slowRequestId]);
  for (const [requestId, promptText, responseBody] of [
    [slowRequestId, slowPrompt, slowCorrelation],
    [fastRequestId, fastPrompt, fastCorrelation],
  ]) {
    const receipt = correlationRows.find((row) => row.receiptId === responseBody.receiptId);
    assert.ok(receipt, `direct response receipt must retrieve ${requestId}`);
    assert.equal(receipt.requestId, requestId);
    assert.equal(receipt.invocationId, requestId);
    assert.equal(receipt.attemptId, `${requestId}:attempt:1`);
    assert.equal(receipt.inputHash, crypto.createHash('sha256').update(promptText).digest('hex'));
  }
  assert.equal(
    correlationRows.at(-1).requestId,
    slowRequestId,
    'the newest receipt belongs only to the slow request and is not provenance for the fast caller',
  );

  const isolatedResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'isolated_echo', prompt: 'safe isolated state', dangerous: false }),
  });
  assert.equal(isolatedResponse.status, 200);
  const isolated = await isolatedResponse.json();
  assert.equal(isolated.route.filesystem_policy, 'isolated_home');
  assert.equal(isolated.route.read_only_enforced, false);
  assert.equal(isolated.route.isolated_home_cleanup, 'complete');
  assert.equal(fs.existsSync(path.join(realProviderHome, 'provider-artifact.txt')), false);
  assert.deepEqual(fs.readdirSync(promptTemp), []);

  const abortController = new AbortController();
  const racedRequest = fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth, signal: abortController.signal,
    body: JSON.stringify({ kind: 'isolated_race', prompt: 'disconnect cleanup race', dangerous: false }),
  }).catch(() => null);
  const raceStartDeadline = Date.now() + 5000;
  while (Date.now() < raceStartDeadline
    && !fs.readdirSync(promptTemp).some((name) => name.startsWith('RelayBridge-provider-home-'))) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(fs.readdirSync(promptTemp).some((name) => name.startsWith('RelayBridge-provider-home-')));
  abortController.abort();
  await racedRequest;
  const raceCleanupDeadline = Date.now() + 5000;
  while (Date.now() < raceCleanupDeadline && fs.readdirSync(promptTemp).length) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(fs.readdirSync(promptTemp), [], 'process tree exits before exact isolated-home cleanup');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.deepEqual(fs.readdirSync(promptTemp), [], 'a killed descendant cannot recreate state after cleanup');
  const raceReceipt = fs.readFileSync(
    path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8',
  ).trim().split(/\r?\n/).map(JSON.parse).find((row) => row.provider === 'isolated_race');
  assert.equal(raceReceipt.route.isolated_home_cleanup, 'complete');

  const unverifiedResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'unverified_echo', prompt: 'must not invoke', dangerous: false }),
  });
  assert.equal(unverifiedResponse.status, 409);
  const unverified = await unverifiedResponse.json();
  assert.equal(unverified.failureClass, 'safe_filesystem_unverified');
  assert.equal(unverified.model_invocation, false);
  assert.equal(unverified.token_usage_source, 'not_invoked');
  assert.equal(unverified.route.filesystem_policy, 'unverified_provider_policy');
  assert.equal(fs.existsSync(path.join(realProviderHome, 'provider-artifact.txt')), false);
  const unverifiedReceipt = fs.readFileSync(
    path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8',
  ).trim().split(/\r?\n/).map(JSON.parse).find((row) => row.receiptId === unverified.receiptId);
  assert.equal(unverifiedReceipt.route.filesystem_policy, 'unverified_provider_policy');
  assert.equal(unverifiedReceipt.modelInvocation, false);

  const writerResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'isolated_echo', prompt: 'human authorized writer', dangerous: true }),
  });
  assert.equal(writerResponse.status, 200);
  const writer = await writerResponse.json();
  assert.equal(writer.route.filesystem_policy, 'writer_authorized');
  assert.equal(writer.route.isolated_home, false);
  assert.equal(fs.readFileSync(path.join(realProviderHome, 'provider-artifact.txt'), 'utf8'), 'provider state');

  const narrationResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ kind: 'narration_only', prompt: 'Audit this repository and return concrete findings.', dangerous: false }),
  });
  assert.equal(narrationResponse.status, 200);
  const narrationResult = await narrationResponse.json();
  assert.equal(narrationResult.exitCode, 0, 'the provider transport itself exited cleanly');
  assert.equal(narrationResult.dropped_out, true);
  assert.equal(narrationResult.failureClass, 'incomplete_response');
  assert.equal(narrationResult.stop_reason, 'provider_incomplete_response');
  assert.match(narrationResult.stop_detail, /switch providers/);
  assert.match(narrationResult.stdout, /^I will inspect/);
  const narrationReceipt = fs.readFileSync(
    path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8',
  ).trim().split(/\r?\n/).map(JSON.parse).find((row) => row.receiptId === narrationResult.receiptId);
  assert.equal(narrationReceipt.status, 'dropped');
  assert.equal(narrationReceipt.failureClass, 'incomplete_response');
  assert.equal(narrationReceipt.outputChars, narrationResult.stdout.length, 'receipt retains evidence of the original output');

  const perplexityResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'perplexity', prompt: 'Return categorized research evidence.', dangerous: false }),
  });
  assert.equal(perplexityResponse.status, 200);
  const perplexityResult = await perplexityResponse.json();
  assert.equal(perplexityResult.exitCode, 0, 'the provider transport exited cleanly');
  assert.equal(perplexityResult.stdout, '', 'partial fragments must not escape as successful stdout');
  assert.equal(perplexityResult.dropped_out, true);
  assert.equal(perplexityResult.partial_result, true);
  assert.equal(perplexityResult.failureClass, 'incomplete_response');
  assert.equal(perplexityResult.failure_sentinel, 'No answer received');
  assert.equal(perplexityResult.failure_sentinel_source, 'perplexity_cli_stdout_first_line');
  assert.equal(perplexityResult.partial_diagnostic, 'https://docs.example.test/one\npartial extracted text');
  assert.equal(perplexityResult.stop_reason, 'provider_incomplete_response');
  assert.equal(perplexityResult.provider_retries.count, 0, 'the same seat is not retried');
  const perplexityReceipt = fs.readFileSync(
    path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8',
  ).trim().split(/\r?\n/).map(JSON.parse).find((row) => row.receiptId === perplexityResult.receiptId);
  assert.equal(perplexityReceipt.status, 'dropped');
  assert.equal(perplexityReceipt.failureClass, 'incomplete_response');
  assert.equal(perplexityReceipt.partialResult, true);
  assert.equal(perplexityReceipt.failureSentinel, 'No answer received');
  assert.equal(perplexityReceipt.failureSentinelSource, 'perplexity_cli_stdout_first_line');
  assert.equal(perplexityReceipt.outputChars, 0, 'receipt records normalized stdout separately');
  assert.equal(perplexityReceipt.partialDiagnosticChars, perplexityResult.partial_diagnostic.length);
  assert.match(perplexityReceipt.partialDiagnosticHash, /^[0-9a-f]{64}$/);
  assert.equal(perplexityReceipt.transportOutputChars, 'No answer received\nhttps://docs.example.test/one\npartial extracted text'.length);
  assert.match(perplexityReceipt.transportOutputHash, /^[0-9a-f]{64}$/);

  const quotedPerplexityResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'perplexity', prompt: 'PERPLEXITY_QUOTED_DOCUMENT', dangerous: false }),
  });
  const quotedPerplexity = await quotedPerplexityResponse.json();
  assert.equal(quotedPerplexity.exitCode, 0);
  assert.equal(quotedPerplexity.dropped_out, false, 'quoted user content is not a sentinel');
  assert.equal(quotedPerplexity.failureClass, null);
  assert.match(quotedPerplexity.stdout, /^> No answer received/);
  assert.equal(quotedPerplexity.partial_result, undefined);

  const safeReviewPrompt = 'Review the repository without modifying it.';
  const safeReviewResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'headless_readonly_success', prompt: safeReviewPrompt, dangerous: false }),
  });
  const safeReview = await safeReviewResponse.json();
  assert.equal(safeReview.exitCode, 0);
  assert.equal(safeReview.dropped_out, false);
  assert.equal(safeReview.route.dangerous, false);
  assert.equal(safeReview.route.prompt_policy, 'antigravity_headless_builtin_read_only_tools');
  assert.equal(safeReview.route.prompt_policy_chars, 'Use built-in workspace file-reading tools only. Never run terminal commands.'.length);
  assert.equal(safeReview.route.transport_prompt_chars, safeReview.stdout.length);
  assert.match(safeReview.stdout, /^Use built-in workspace file-reading tools only/);
  assert.match(safeReview.stdout, /User request:\s*Review the repository without modifying it\./);
  assert.doesNotMatch(safeReview.stdout, /dangerously-skip-permissions/i);

  const boundaryPrompt = 'x'.repeat(79) + 'Z';
  const boundaryResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'headless_readonly_success', prompt: boundaryPrompt, dangerous: false }),
  });
  const boundary = await boundaryResponse.json();
  assert.equal(boundary.route.prompt_truncated, false, 'policy text must not consume the user prompt allowance');
  assert.ok(boundary.stdout.endsWith(boundaryPrompt), 'the last user character survives at prompt_max_chars');
  assert.equal(boundary.route.transport_prompt_chars, boundary.stdout.length);

  const denialResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'headless_permission_denial', prompt: safeReviewPrompt, dangerous: false }),
  });
  const denial = await denialResponse.json();
  assert.equal(denial.exitCode, 0, 'matches receipt rcpt_mt6ucssr_287ca02b');
  assert.equal(denial.stdout, '');
  assert.equal(denial.failureClass, 'policy');
  assert.equal(denial.permission_denied, true);
  assert.equal(denial.policy_reason, 'headless_command_permission_auto_denied');
  assert.equal(denial.dropped_out, true);
  assert.equal(denial.route.dangerous, false);
  assert.match(denial.stop_detail, /headless mode cannot prompt/i);
  assert.doesNotMatch(denial.stderr, /MUST_NOT_USE_DANGEROUS_SLOT/);
  const denialReceipt = fs.readFileSync(
    path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8',
  ).trim().split(/\r?\n/).map(JSON.parse).find((row) => row.receiptId === denial.receiptId);
  assert.equal(denialReceipt.failureClass, 'policy');
  assert.equal(denialReceipt.policyReason, 'headless_command_permission_auto_denied');
  assert.match(denialReceipt.policyDetailHash, /^[0-9a-f]{64}$/);
  assert.equal(denialReceipt.route.prompt_policy, 'antigravity_headless_builtin_read_only_tools');

  const grokQuotaResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ kind: 'grok', prompt: 'Return a bounded quota fixture.', dangerous: false }),
  });
  assert.equal(grokQuotaResponse.status, 200);
  const grokQuotaResult = await grokQuotaResponse.json();
  assert.equal(grokQuotaResult.failureClass, 'rate_limit');
  assert.equal(grokQuotaResult.rate_limited, true);
  assert.equal(grokQuotaResult.dropped_out, true);
  assert.equal(grokQuotaResult.provider_retries.count, 0, 'RelayBridge does not retry the exhausted seat');
  assert.equal(grokQuotaResult.vendor_quota.provider, 'grok');
  assert.equal(grokQuotaResult.vendor_quota.model, 'grok-4.6');
  assert.equal(grokQuotaResult.vendor_quota.actual, 552305);
  assert.equal(grokQuotaResult.vendor_quota.limit, 500000);
  assert.equal(grokQuotaResult.vendor_quota.reset.kind, 'conservative_expiry');

  const gaugeResponse = await fetch(baseUrl + '/api/usage/gauges', { headers: auth });
  assert.equal(gaugeResponse.status, 200);
  const gaugeResult = await gaugeResponse.json();
  assert.equal(gaugeResult.providerUsageCapabilities.narration_only.budgetEnforcement, 'unenforceable');
  assert.equal(gaugeResult.providerUsageCapabilities.narration_only.tokenBudgetEnforceable, false);
  assert.equal(gaugeResult.gauges.grok.basis, 'vendor_observed');
  assert.equal(gaugeResult.gauges.grok.percentRemaining, 0);
  assert.equal(gaugeResult.gauges.grok.vendorQuota.evidenceHash, grokQuotaResult.vendor_quota.evidenceHash);

  const routeResponse = await fetch(baseUrl + '/api/route', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({
      task: 'Review a complex architecture',
      dangerous: true,
      acknowledgeFilesystemWrites: true,
      preferKinds: ['grok'],
      diagnostics: {
        grok: { found: true, ready: true },
        echo: { found: true, ready: true },
      },
    }),
  });
  assert.equal(routeResponse.status, 200);
  const routeResult = await routeResponse.json();
  assert.ok(!routeResult.fleetState.cooldownSkipped.includes('grok'),
    'explicit preference may bypass the heuristic cooldown');
  assert.ok(!routeResult.selected.some((item) => item.kind === 'grok'),
    'authoritative unexpired vendor exhaustion cannot be bypassed by preference');
  const grokQuotaSkip = routeResult.fleetState.vendorQuotaSkipped.find((item) => item.kind === 'grok');
  assert.equal(grokQuotaSkip.reason, 'vendor_quota_exhausted');
  assert.equal(grokQuotaSkip.authoritative, true);
  assert.equal(grokQuotaSkip.retry.action, 'use_alternate_quota_seat_until_reset');
  assert.equal(grokQuotaSkip.retry.allowedAfter, grokQuotaResult.vendor_quota.reset.expiresAt);
  assert.equal(routeResult.candidates.find((item) => item.kind === 'grok').readiness.ready, false);
  assert.equal(routeResult.fleetState.vendorQuota.grok.actual, 552305);

  const grokPlanResponse = await fetch(baseUrl + '/api/plan', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({
      task: 'Review a complex architecture', kind: 'grok',
      dangerous: true, acknowledgeFilesystemWrites: true,
    }),
  });
  assert.equal(grokPlanResponse.status, 200);
  const grokPlan = await grokPlanResponse.json();
  assert.equal(grokPlan.primary.kind, 'grok');
  assert.equal(grokPlan.primary.blocked, true);
  assert.equal(grokPlan.primary.ready, false);
  assert.equal(grokPlan.primary.reason, 'vendor_quota_exhausted');
  assert.equal(grokPlan.primary.vendorQuotaBlock.retry.allowedAfter, grokQuotaResult.vendor_quota.reset.expiresAt);
  assert.ok(grokPlan.guidance.some((line) => /do not retry before/i.test(line)));

  const grokQuotaReceipt = fs.readFileSync(
    path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8',
  ).trim().split(/\r?\n/).map(JSON.parse).find((row) => row.receiptId === grokQuotaResult.receiptId);
  assert.equal(grokQuotaReceipt.vendorQuota.actual, 552305);
  assert.equal(grokQuotaReceipt.vendorQuota.source, 'grok_429_subscription_free_usage_exhausted');
  assert.equal(grokQuotaReceipt.providerRetryCount, 0);
  const quotaRows = fs.readFileSync(path.join(tempRoot, 'data', 'usage', 'vendor-quota.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(quotaRows.length, 1);
  assert.equal(quotaRows[0].model, 'grok-4.6');

  const copilotQuotaResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'copilot', prompt: 'Return a bounded review.', dangerous: false }),
  });
  assert.equal(copilotQuotaResponse.status, 200);
  const copilotQuotaResult = await copilotQuotaResponse.json();
  assert.equal(copilotQuotaResult.failureClass, 'rate_limit');
  assert.equal(copilotQuotaResult.rate_limited, true);
  assert.equal(copilotQuotaResult.budget_exceeded, false);
  assert.equal(copilotQuotaResult.dropped_out, true);
  assert.equal(copilotQuotaResult.provider_retries.count, 0, 'monthly exhaustion is never retried on the same seat');
  assert.match(copilotQuotaResult.stderr, /^You have exceeded your monthly quota/);
  assert.equal(copilotQuotaResult.quota_evidence.provider, 'copilot');
  assert.equal(copilotQuotaResult.quota_evidence.kind, 'monthly_quota_exhausted');
  assert.equal(copilotQuotaResult.quota_evidence.diagnostic, 'You have exceeded your monthly quota');
  assert.match(copilotQuotaResult.quota_evidence.stderrHash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(copilotQuotaResult.quota_evidence), /393F|resume=fixture/i);

  const cooldownResponse = await fetch(baseUrl + '/api/cooldowns', { headers: auth });
  assert.equal(cooldownResponse.status, 200);
  const cooldownResult = await cooldownResponse.json();
  const copilotCooldown = cooldownResult.cooling.find((item) => item.seat === 'copilot');
  assert.ok(copilotCooldown);
  assert.equal(copilotCooldown.reason, 'rate_limited');

  const copilotRouteResponse = await fetch(baseUrl + '/api/route', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({
      task: 'Review a complex architecture',
      diagnostics: {
        copilot: { found: true, ready: true },
        echo: { found: true, ready: true },
      },
    }),
  });
  assert.equal(copilotRouteResponse.status, 200);
  const copilotRouteResult = await copilotRouteResponse.json();
  assert.ok(copilotRouteResult.fleetState.cooldownSkipped.includes('copilot'));

  const copilotQuotaReceipt = fs.readFileSync(
    path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8',
  ).trim().split(/\r?\n/).map(JSON.parse).find((row) => row.receiptId === copilotQuotaResult.receiptId);
  assert.equal(copilotQuotaReceipt.failureClass, 'rate_limit');
  assert.equal(copilotQuotaReceipt.providerRetryCount, 0);
  assert.equal(copilotQuotaReceipt.quotaEvidence.kind, 'monthly_quota_exhausted');
  assert.equal(copilotQuotaReceipt.quotaEvidence.diagnostic, 'You have exceeded your monthly quota');
  assert.doesNotMatch(JSON.stringify(copilotQuotaReceipt.quotaEvidence), /393F|resume=fixture/i);

  const cursorNamedResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'cursor', prompt: 'CURSOR_NAMED_MODELS', dangerous: false }),
  });
  assert.equal(cursorNamedResponse.status, 200);
  const cursorNamed = await cursorNamedResponse.json();
  assert.equal(cursorNamed.exitCode, 1);
  assert.equal(cursorNamed.stdout, '');
  assert.equal(cursorNamed.failureClass, 'plan_restriction');
  assert.equal(cursorNamed.dropped_out, true);
  assert.equal(cursorNamed.route.model_flag_sent, '--model');
  assert.equal(cursorNamed.route.requested_model, 'fixture-named-model');
  assert.equal(cursorNamed.provider_action_required.kind, 'named_models_unavailable');
  assert.equal(cursorNamed.provider_action_required.modelFlagSent, true);
  assert.match(cursorNamed.stop_detail, /remove the model flag/i);

  const cursorUsageResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'cursor', prompt: 'CURSOR_USAGE_LIMIT', dangerous: false }),
  });
  assert.equal(cursorUsageResponse.status, 200);
  const cursorUsage = await cursorUsageResponse.json();
  assert.equal(cursorUsage.exitCode, 1);
  assert.equal(cursorUsage.failureClass, 'budget');
  assert.equal(cursorUsage.budget_exceeded, true);
  assert.equal(cursorUsage.rate_limited, false);
  assert.equal(cursorUsage.dropped_out, true);
  assert.equal(cursorUsage.provider_action_required.kind, 'usage_quota_exhausted');
  assert.equal(cursorUsage.provider_action_required.scope, 'seat');

  const cursorCooldownResponse = await fetch(baseUrl + '/api/cooldowns', { headers: auth });
  const cursorCooldowns = await cursorCooldownResponse.json();
  const cursorCooldown = cursorCooldowns.cooling.find((item) => item.seat === 'cursor');
  assert.ok(cursorCooldown);
  assert.equal(cursorCooldown.reason, 'quota_exhausted');

  const cursorUnknownResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'cursor', prompt: 'CURSOR_UNRELATED_ACTION', dangerous: false }),
  });
  const cursorUnknown = await cursorUnknownResponse.json();
  assert.equal(cursorUnknown.exitCode, 1);
  assert.equal(cursorUnknown.stdout, '');
  assert.equal(cursorUnknown.failureClass, 'provider_error', 'zero-output nonzero Cursor exits are never unclassified');
  assert.equal(cursorUnknown.dropped_out, true);
  assert.equal(cursorUnknown.provider_action_required, null);

  const cursorReceipts = fs.readFileSync(
    path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8',
  ).trim().split(/\r?\n/).map(JSON.parse).filter((row) => row.provider === 'cursor');
  const cursorNamedReceipt = cursorReceipts.find((row) => row.receiptId === cursorNamed.receiptId);
  const cursorUsageReceipt = cursorReceipts.find((row) => row.receiptId === cursorUsage.receiptId);
  assert.equal(cursorNamedReceipt.failureClass, 'plan_restriction');
  assert.equal(cursorNamedReceipt.providerActionRequired.kind, 'named_models_unavailable');
  assert.equal(cursorNamedReceipt.route.model_flag_sent, '--model');
  assert.equal(cursorUsageReceipt.failureClass, 'budget');
  assert.equal(cursorUsageReceipt.providerActionRequired.kind, 'usage_quota_exhausted');
  assert.equal(cursorUsageReceipt.outputChars, 0);
  assert.equal(cursorUsageReceipt.modelInvocation, true);

  const geminiAutoResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({
      kind: 'gemini_auto_compat',
      prompt: 'AUTO_COMPAT_OK',
      taskTier: 'complex',
      dangerous: false,
    }),
  });
  assert.equal(geminiAutoResponse.status, 200);
  const geminiAutoResult = await geminiAutoResponse.json();
  assert.equal(geminiAutoResult.stdout, 'AUTO_COMPAT_OK');
  assert.equal(geminiAutoResult.route.requested_model, 'auto');
  assert.equal(geminiAutoResult.route.requested_effort, null);
  assert.equal(geminiAutoResult.route.effort_method, 'model_choice');
  assert.deepEqual(geminiAutoResult.route.suppressed_cli_flags, ['--effort']);

  const usageResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ kind: 'usage_json', prompt: 'structured token accounting', dangerous: false }),
  });
  assert.equal(usageResponse.status, 200);
  const usageResult = await usageResponse.json();
  assert.equal(usageResult.stdout, 'STRUCTURED_OK');
  assert.equal(usageResult.route.resolved_model_identity, 'claude-fable-5');
  assert.equal(usageResult.route.resolved_model_source, 'provider_reported_model_usage');
  assert.equal(usageResult.usage.input_tokens, 530);
  assert.equal(usageResult.usage.output_tokens, 900);
  assert.equal(usageResult.usage.cache_read_input_tokens, 20937);
  assert.equal(usageResult.usage.cache_creation_input_tokens, 13086);
  assert.equal(usageResult.usage.total_tokens, 35453);
  assert.equal(usageResult.usage.thinking_tokens, 873);
  assert.equal(usageResult.usage.cost_usd, 0.32762);
  assert.equal(usageResult.usage.model_usage.length, 2);
  const usageLedger = fs.readFileSync(path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const usageReceipt = usageLedger.find((row) => row.receiptId === usageResult.receiptId);
  assert.equal(usageReceipt.actualTotalTokens, 35453);
  assert.equal(usageReceipt.tokenUsageSource, 'provider_reported');
  assert.equal(usageReceipt.provider_reported_cost_usd, 0.32762);

  // Issue #82: the shipped providerBudget stopped a healthy agentic run at 24
  // turns. Turns count tool calls, not spend, so a complete 36-turn result must
  // now come back whole under the shipped default, and only an explicit ceiling
  // may stop it.
  const longRunResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ kind: 'usage_json_longrun', prompt: 'a long healthy agentic run', dangerous: false }),
  });
  assert.equal(longRunResponse.status, 200);
  const longRunResult = await longRunResponse.json();
  assert.equal(longRunResult.stdout, 'LONGRUN_OK', 'a finished run past 24 turns must return its answer');
  assert.equal(longRunResult.stop_reason, null);
  assert.equal(longRunResult.failureClass, null);
  assert.equal(longRunResult.dropped_out, false);
  assert.equal(longRunResult.timed_out, false);
  assert.ok(!longRunResult.partial_result);
  assert.equal(longRunResult.provider_num_turns, 36);
  assert.equal(longRunResult.usage.total_tokens, 39960);

  const longRunCappedResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({
      kind: 'usage_json_longrun', prompt: 'an explicitly capped agentic run', dangerous: false,
      providerBudget: { maxTurns: 24 },
    }),
  });
  assert.equal(longRunCappedResponse.status, 200);
  const longRunCappedResult = await longRunCappedResponse.json();
  assert.equal(longRunCappedResult.stop_reason, 'token_budget',
    'an operator who asks for a turn ceiling still gets one');
  assert.equal(longRunCappedResult.failureClass, 'token_budget');
  assert.equal(longRunCappedResult.dropped_out, true);
  assert.equal(longRunCappedResult.provider_budget_enforcement, 'incremental');
  assert.notEqual(longRunCappedResult.stdout, 'LONGRUN_OK');

  const multiTurnBudgetResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({
      kind: 'usage_json_multiturn', prompt: 'enforce multi-turn provider usage', dangerous: false,
      providerBudget: {
        maxOutputTokens: null, maxTotalTokens: null, maxCacheReadTokens: null,
        maxCacheCreationTokens: null, maxTurns: 2,
      },
    }),
  });
  assert.equal(multiTurnBudgetResponse.status, 200);
  const multiTurnBudgetResult = await multiTurnBudgetResponse.json();
  assert.equal(multiTurnBudgetResult.stop_reason, 'token_budget');
  assert.equal(multiTurnBudgetResult.failureClass, 'token_budget');
  assert.equal(multiTurnBudgetResult.timed_out, false);
  assert.equal(multiTurnBudgetResult.dropped_out, true);
  assert.equal(multiTurnBudgetResult.provider_num_turns, 3);
  assert.equal(multiTurnBudgetResult.usage.total_tokens, 1995);
  assert.equal(multiTurnBudgetResult.provider_budget_enforcement, 'incremental');
  assert.equal(multiTurnBudgetResult.stdout, '');
  assert.equal(multiTurnBudgetResult.partial_result, true);
  assert.equal(multiTurnBudgetResult.partial_diagnostic, 'turn 2\n\nturn 3');
  assert.equal(multiTurnBudgetResult.partial_diagnostic_truncated, false);
  assert.equal(multiTurnBudgetResult.cleaned_output_unavailable, true);
  assert.doesNotMatch(multiTurnBudgetResult.partial_diagnostic,
    /THINKING_MUST_NOT_ESCAPE|TOOL_INPUT_MUST_NOT_ESCAPE|DUPLICATE_ID_MUST_NOT_ESCAPE/);

  const boundedBudgetResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({
      kind: 'usage_json_multiturn_bounded', prompt: 'bound recovered provider text', dangerous: false,
      providerBudget: {
        maxOutputTokens: null, maxTotalTokens: null, maxCacheReadTokens: null,
        maxCacheCreationTokens: null, maxTurns: 1,
      },
    }),
  });
  assert.equal(boundedBudgetResponse.status, 200);
  const boundedBudgetResult = await boundedBudgetResponse.json();
  assert.equal(boundedBudgetResult.stop_reason, 'token_budget');
  assert.equal(boundedBudgetResult.supervisor_stop_reason, 'token_budget');
  assert.equal(boundedBudgetResult.failureClass, 'token_budget');
  assert.equal(boundedBudgetResult.dropped_out, true);
  assert.equal(boundedBudgetResult.stdout, '');
  assert.equal(boundedBudgetResult.partial_result, true);
  assert.equal(boundedBudgetResult.partial_diagnostic.length, 12000);
  assert.equal(boundedBudgetResult.partial_diagnostic_truncated, true);
  assert.match(boundedBudgetResult.partial_diagnostic, /TAIL_KEPT\n\nfinal bounded turn$/);
  assert.doesNotMatch(boundedBudgetResult.partial_diagnostic,
    /HEAD_SHOULD_TRUNCATE|BOUNDED_THINKING_MUST_NOT_ESCAPE|BOUNDED_TOOL_INPUT_MUST_NOT_ESCAPE/);
  assert.equal(boundedBudgetResult.cleaned_output_unavailable, true);

  const budgetReceipts = fs.readFileSync(
    path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8',
  ).trim().split(/\r?\n/).map(JSON.parse);
  const multiTurnReceipt = budgetReceipts.find((row) => row.receiptId === multiTurnBudgetResult.receiptId);
  const boundedReceipt = budgetReceipts.find((row) => row.receiptId === boundedBudgetResult.receiptId);
  assert.equal(multiTurnReceipt.partialResult, true);
  assert.equal(multiTurnReceipt.partialDiagnosticChars, multiTurnBudgetResult.partial_diagnostic.length);
  assert.equal(multiTurnReceipt.partialDiagnosticTruncated, false);
  assert.equal(multiTurnReceipt.cleanedOutputUnavailable, true);
  assert.equal(boundedReceipt.partialResult, true);
  assert.equal(boundedReceipt.partialDiagnosticChars, 12000);
  assert.equal(boundedReceipt.partialDiagnosticTruncated, true);
  assert.equal(boundedReceipt.partialDiagnosticHash,
    crypto.createHash('sha256').update(boundedBudgetResult.partial_diagnostic).digest('hex'));
  assert.equal(boundedReceipt.stopReason, 'token_budget');

  const groupedUsage = await (await fetch(baseUrl + '/api/usage/gauges', { headers: auth })).json();
  const usageGauge = groupedUsage.gauges.usage_json;
  const multiTurnGauge = groupedUsage.gauges.usage_json_multiturn;
  assert.equal(usageGauge.quotaSeat, 'subscription:anthropic:default');
  assert.equal(multiTurnGauge.quotaSeat, usageGauge.quotaSeat);
  assert.equal(multiTurnGauge.used.totalTokens, usageGauge.used.totalTokens);
  assert.equal(multiTurnGauge.percentRemaining, usageGauge.percentRemaining);
  assert.deepEqual(usageGauge.aliases, ['usage_json', 'usage_json_multiturn']);
  assert.deepEqual(groupedUsage.quotaSeats['subscription:anthropic:default'].providers,
    ['usage_json', 'usage_json_multiturn']);
  assert.ok(![groupedUsage.balance.mostDrained, groupedUsage.balance.freshest]
    .includes('usage_json_multiturn'), 'an alias must not be advertised as a separate quota tank');

  const groupedPlan = await (await fetch(baseUrl + '/api/plan', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ task: 'review this architecture', kind: 'usage_json' }),
  })).json();
  assert.deepEqual(groupedPlan.fleetState.quotaSeats['subscription:anthropic:default'].providers,
    ['usage_json', 'usage_json_multiturn']);
  assert.notDeepEqual(
    [groupedPlan.fleetState.balance.mostDrained, groupedPlan.fleetState.balance.freshest],
    ['usage_json', 'usage_json_multiturn'],
  );

  const rejectedOperatorQuota = await fetch(baseUrl + '/api/usage/operator-quota', {
    method: 'PUT', headers: jsonAuth,
    body: JSON.stringify({
      quotaSeat: 'subscription:anthropic:default', percentRemaining: 4,
      provenance: 'human_account_owner', expiresAt: new Date(Date.now() + 3600000).toISOString(),
      credential: 'must never be accepted',
    }),
  });
  assert.equal(rejectedOperatorQuota.status, 400);
  assert.match((await rejectedOperatorQuota.json()).error, /credentials.*never stored/);

  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  const operatorQuotaResponse = await fetch(baseUrl + '/api/usage/operator-quota', {
    method: 'PUT', headers: jsonAuth,
    body: JSON.stringify({
      quotaSeat: 'subscription:anthropic:default', percentRemaining: 4,
      provenance: 'human_account_owner', observedAt: new Date().toISOString(), expiresAt,
    }),
  });
  assert.equal(operatorQuotaResponse.status, 200);
  const operatorQuotaResult = await operatorQuotaResponse.json();
  assert.equal(operatorQuotaResult.observation.source, 'operator_reported');
  assert.equal(operatorQuotaResult.observation.percentRemaining, 4);
  assert.equal(operatorQuotaResult.observation.expiresAt, expiresAt);

  const operatorQuotaStatus = await (await fetch(baseUrl + '/api/usage/operator-quota', { headers: auth })).json();
  assert.equal(operatorQuotaStatus.observations['subscription:anthropic:default'].provenance, 'human_account_owner');
  assert.deepEqual(operatorQuotaStatus.quotaSeats['subscription:anthropic:default'].providers,
    ['usage_json', 'usage_json_multiturn']);
  const observedUsage = await (await fetch(baseUrl + '/api/usage/gauges', { headers: auth })).json();
  for (const provider of ['usage_json', 'usage_json_multiturn']) {
    assert.equal(observedUsage.gauges[provider].basis, 'operator_observed');
    assert.equal(observedUsage.gauges[provider].percentRemaining, 4);
    assert.equal(observedUsage.gauges[provider].configuredEstimate.basis, 'configured');
  }
  assert.equal(observedUsage.operatorQuota['subscription:anthropic:default'].percentRemaining, 4);

  const observedPlan = await (await fetch(baseUrl + '/api/plan', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ task: 'review this architecture', kind: 'usage_json' }),
  })).json();
  assert.equal(observedPlan.fleetState.operatorQuota['subscription:anthropic:default'].percentRemaining, 4);
  assert.equal(observedPlan.fleetState.balance.quotaSeats
    .find((seat) => seat.quotaSeat === 'subscription:anthropic:default').percentRemaining, 4);

  const observedRoute = await (await fetch(baseUrl + '/api/route', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({
      task: 'review this architecture',
      diagnostics: {
        usage_json: { found: true, ready: true },
        narration_only: { found: true, ready: true },
      },
      preferKinds: ['usage_json', 'narration_only'],
    }),
  })).json();
  assert.equal(observedRoute.fleetState.operatorQuota['subscription:anthropic:default'].percentRemaining, 4);
  assert.equal(observedRoute.fleetState.balance.quotaSeats
    .find((seat) => seat.quotaSeat === 'subscription:anthropic:default').percentRemaining, 4);

  const operatorAdvise = await (await fetch(baseUrl + '/api/usage/advise', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({
      tier: 'complex',
      candidates: [
        { seat: 'usage_json', rank: 0, costClass: 'subscription' },
        { seat: 'narration_only', rank: 1, costClass: 'subscription' },
      ],
    }),
  })).json();
  assert.equal(operatorAdvise.operatorQuota['subscription:anthropic:default'].percentRemaining, 4);
  assert.ok(operatorAdvise.ranked.find((item) => item.seat === 'usage_json').stress >= 0.9,
    'routing advice must use the operator observation instead of the 96% configured estimate');

  const clearOperatorQuota = await fetch(baseUrl + '/api/usage/operator-quota', {
    method: 'DELETE', headers: jsonAuth,
    body: JSON.stringify({ quotaSeat: 'subscription:anthropic:default' }),
  });
  assert.equal(clearOperatorQuota.status, 200);
  const clearedUsage = await (await fetch(baseUrl + '/api/usage/gauges', { headers: auth })).json();
  assert.equal(clearedUsage.gauges.usage_json.basis, 'configured');
  assert.deepEqual(clearedUsage.operatorQuota, {});

  const xhighPlanResponse = await fetch(baseUrl + '/api/plan', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ task: 'review a difficult architecture', kind: 'codex_effort', effort: 'xhigh' }),
  });
  assert.equal(xhighPlanResponse.status, 200);
  const xhighPlan = await xhighPlanResponse.json();
  assert.equal(xhighPlan.effort, 'xhigh');
  assert.equal(xhighPlan.primary.effort, 'xhigh');
  assert.equal(xhighPlan.primary.appliedEffort, 'xhigh');
  assert.equal(xhighPlan.primary.effortSupported, true);

  const maxEffortRejected = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'usage_json', prompt: 'do not infer max', effort: 'max', dangerous: false }),
  });
  assert.equal(maxEffortRejected.status, 400);
  assert.match((await maxEffortRejected.json()).error, /maxEffortOverride=true/);

  const maxEffortExplicit = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({
      kind: 'usage_json', prompt: 'EXPLICIT_MAX_OK', effort: 'max',
      maxEffortOverride: true, dangerous: false,
    }),
  });
  assert.equal(maxEffortExplicit.status, 200);
  const maxEffortExplicitResult = await maxEffortExplicit.json();
  assert.equal(maxEffortExplicitResult.stdout, 'STRUCTURED_OK');
  assert.equal(maxEffortExplicitResult.route.requested_effort, 'max');
  assert.equal(maxEffortExplicitResult.route.effort_explicit, true);
  assert.equal(maxEffortExplicitResult.route.max_effort_override, true);

  const codexMinimalResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({
      kind: 'codex_effort', prompt: 'CODEX_MINIMAL_OK', effort: 'minimal', dangerous: false,
    }),
  });
  assert.equal(codexMinimalResponse.status, 200);
  const codexMinimal = await codexMinimalResponse.json();
  assert.equal(codexMinimal.stdout, 'CODEX_MINIMAL_OK');
  assert.equal(codexMinimal.route.requested_effort, 'minimal');
  assert.equal(codexMinimal.route.applied_effort, 'minimal');
  assert.equal(codexMinimal.route.effort_method, 'effort_flags');
  assert.equal(codexMinimal.route.effort_control, '--config model_reasoning_effort');

  const codexXhighRejected = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'codex_effort', prompt: 'do not infer xhigh', effort: 'xhigh', dangerous: false }),
  });
  assert.equal(codexXhighRejected.status, 400);
  assert.match((await codexXhighRejected.json()).error, /maxEffortOverride=true/);

  const codexXhighResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({
      kind: 'codex_effort', prompt: 'CODEX_XHIGH_OK', effort: 'xhigh',
      maxEffortOverride: true, dangerous: false,
    }),
  });
  assert.equal(codexXhighResponse.status, 200);
  const codexXhigh = await codexXhighResponse.json();
  assert.equal(codexXhigh.stdout, 'CODEX_XHIGH_OK');
  assert.equal(codexXhigh.route.requested_effort, 'xhigh');
  assert.equal(codexXhigh.route.applied_effort, 'xhigh');
  assert.equal(codexXhigh.route.effort_method, 'effort_flags');
  assert.equal(codexXhigh.route.max_effort_override, true);

  const codexMaxResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({
      kind: 'codex_effort', prompt: 'CODEX_MAX_FALLBACK_OK', effort: 'max',
      maxEffortOverride: true, dangerous: false,
    }),
  });
  assert.equal(codexMaxResponse.status, 200);
  const codexMax = await codexMaxResponse.json();
  assert.equal(codexMax.stdout, 'CODEX_MAX_FALLBACK_OK');
  assert.equal(codexMax.route.requested_effort, 'max');
  assert.equal(codexMax.route.applied_effort, 'xhigh', 'Codex max resolves through its configured highest valid value');
  assert.equal(codexMax.route.effort_method, 'effort_flags');

  const unsupportedEffortResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'echo', prompt: 'UNSUPPORTED_EFFORT', effort: 'minimal', dangerous: false }),
  });
  assert.equal(unsupportedEffortResponse.status, 400);
  const unsupportedEffort = await unsupportedEffortResponse.json();
  assert.match(unsupportedEffort.error, /cannot express requested effort=minimal/);
  assert.equal(unsupportedEffort.model_invocation, false);
  assert.equal(unsupportedEffort.route.effort_method, 'unsupported');

  const malformedModelsResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ kind: 'usage_json_malformed_models', prompt: 'fallback to valid top-level usage', dangerous: false }),
  });
  assert.equal(malformedModelsResponse.status, 200);
  const malformedModelsResult = await malformedModelsResponse.json();
  assert.equal(malformedModelsResult.stdout, 'TOP_LEVEL_USAGE_OK');
  assert.deepEqual(malformedModelsResult.usage.model_usage, []);
  assert.equal(malformedModelsResult.usage.input_tokens, 7);
  assert.equal(malformedModelsResult.usage.output_tokens, 3);
  assert.equal(malformedModelsResult.usage.cache_read_input_tokens, 11);
  assert.equal(malformedModelsResult.usage.cache_creation_input_tokens, 2);
  assert.equal(malformedModelsResult.usage.total_tokens, 23);
  assert.equal(malformedModelsResult.usage.cost_usd, null);

  const malformedTopResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ kind: 'usage_json_malformed_top', prompt: 'reject partial malformed top-level usage', dangerous: false }),
  });
  assert.equal(malformedTopResponse.status, 200);
  const malformedTopResult = await malformedTopResponse.json();
  assert.equal(malformedTopResult.stdout, 'MALFORMED_TOP_USAGE_ANSWER');
  assert.equal(malformedTopResult.usage, null);
  const refreshedUsageLedger = fs.readFileSync(path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const malformedTopReceipt = refreshedUsageLedger.find((row) => row.receiptId === malformedTopResult.receiptId);
  assert.equal(malformedTopReceipt.actualTotalTokens, null);
  assert.equal(malformedTopReceipt.tokenUsageSource, 'chars_div_4');

  const partialCostResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ kind: 'usage_json_partial_cost', prompt: 'reject partial provider cost census', dangerous: false }),
  });
  assert.equal(partialCostResponse.status, 200);
  const partialCostResult = await partialCostResponse.json();
  assert.equal(partialCostResult.usage.total_tokens, 6);
  assert.equal(partialCostResult.usage.cost_usd, null);
  assert.equal(partialCostResult.usage.thinking_tokens, null);
  assert.equal(partialCostResult.route.resolved_model_identity, 'b');
  const usageRows = fs.readFileSync(path.join(
    tempRoot, 'data', 'usage', `usage-${new Date().toISOString().slice(0, 10)}.jsonl`,
  ), 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const partialCostLedgerRow = usageRows.find((row) => row.seat === 'usage_json_partial_cost');
  assert.equal(partialCostLedgerRow.costSource, 'estimated',
    'a null provider cost must not be coerced into an authoritative free call');
  assert.ok(partialCostLedgerRow.costUsd > 0);

  const errorResultResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ kind: 'usage_json_error', prompt: 'classify structured error result', dangerous: false }),
  });
  assert.equal(errorResultResponse.status, 200);
  const errorResult = await errorResultResponse.json();
  assert.equal(errorResult.exitCode, 0);
  assert.equal(errorResult.rate_limited, true);
  assert.equal(errorResult.dropped_out, true);
  const errorLedger = fs.readFileSync(path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const errorReceipt = errorLedger.find((row) => row.receiptId === errorResult.receiptId);
  assert.equal(errorReceipt.failureClass, 'rate_limit');

  const successErrorDisagreementResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({
      kind: 'usage_json_success_error_disagreement',
      prompt: 'retain metrics when success subtype carries an error flag',
      dangerous: false,
    }),
  });
  assert.equal(successErrorDisagreementResponse.status, 200);
  const successErrorDisagreement = await successErrorDisagreementResponse.json();
  assert.equal(successErrorDisagreement.exitCode, 0);
  assert.equal(successErrorDisagreement.stdout, '');
  assert.doesNotMatch(successErrorDisagreement.stderr, /subtype and is_error disagree/);
  assert.match(successErrorDisagreement.stderr, /weekly limit/);
  assert.equal(successErrorDisagreement.result_subtype, 'success');
  assert.equal(successErrorDisagreement.result_schema_disagreement, true);
  assert.equal(successErrorDisagreement.failureClass, 'rate_limit');
  assert.equal(successErrorDisagreement.rate_limited, true);
  assert.equal(successErrorDisagreement.dropped_out, true);
  assert.equal(successErrorDisagreement.usage.total_tokens, 36);
  assert.equal(successErrorDisagreement.provider_error_count, 1);
  assert.equal(successErrorDisagreement.provider_retries.count, 1);
  assert.deepEqual(successErrorDisagreement.provider_retries.by_status, { 429: 1 });
  const successErrorDisagreementReceipt = fs.readFileSync(
    path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'),
    'utf8',
  ).trim().split(/\r?\n/).map((line) => JSON.parse(line))
    .find((row) => row.receiptId === successErrorDisagreement.receiptId);
  assert.equal(successErrorDisagreementReceipt.resultSchemaDisagreement, true);
  assert.equal(successErrorDisagreementReceipt.actualTotalTokens, 36);
  assert.equal(successErrorDisagreementReceipt.tokenUsageSource, 'provider_reported');
  assert.equal(successErrorDisagreementReceipt.providerRetryCount, 1);
  assert.equal(successErrorDisagreementReceipt.providerApiErrorStatus, 429);

  const errorSuccessFlagDisagreementResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({
      kind: 'usage_json_error_success_flag_disagreement',
      prompt: 'retain metrics when an error subtype carries a false error flag',
      dangerous: false,
    }),
  });
  assert.equal(errorSuccessFlagDisagreementResponse.status, 200);
  const errorSuccessFlagDisagreement = await errorSuccessFlagDisagreementResponse.json();
  assert.equal(errorSuccessFlagDisagreement.exitCode, 0);
  assert.equal(errorSuccessFlagDisagreement.stdout, '');
  assert.doesNotMatch(errorSuccessFlagDisagreement.stderr, /subtype and is_error disagree/);
  assert.match(errorSuccessFlagDisagreement.stderr, /temporarily limiting requests/);
  assert.equal(errorSuccessFlagDisagreement.result_subtype, 'error_during_execution');
  assert.equal(errorSuccessFlagDisagreement.result_schema_disagreement, true);
  assert.equal(errorSuccessFlagDisagreement.failureClass, 'rate_limit');
  assert.equal(errorSuccessFlagDisagreement.rate_limited, true);
  assert.equal(errorSuccessFlagDisagreement.dropped_out, true);
  assert.equal(errorSuccessFlagDisagreement.usage.total_tokens, 43);
  assert.equal(errorSuccessFlagDisagreement.provider_error_count, 1);
  assert.equal(errorSuccessFlagDisagreement.provider_retries.count, 0);
  const errorSuccessFlagDisagreementReceipt = fs.readFileSync(
    path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'),
    'utf8',
  ).trim().split(/\r?\n/).map((line) => JSON.parse(line))
    .find((row) => row.receiptId === errorSuccessFlagDisagreement.receiptId);
  assert.equal(errorSuccessFlagDisagreementReceipt.resultSchemaDisagreement, true);
  assert.equal(errorSuccessFlagDisagreementReceipt.actualTotalTokens, 43);
  assert.equal(errorSuccessFlagDisagreementReceipt.tokenUsageSource, 'provider_reported');
  assert.equal(errorSuccessFlagDisagreementReceipt.providerErrorCount, 1);
  assert.equal(errorSuccessFlagDisagreementReceipt.providerApiErrorStatus, 429);

  const invalidResultResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'usage_json_invalid_result', prompt: 'reject non-result JSON', dangerous: false }),
  });
  const invalidResult = await invalidResultResponse.json();
  assert.equal(invalidResult.stdout, '');
  assert.equal(invalidResult.dropped_out, true);
  assert.equal(invalidResult.failureClass, 'provider_error');
  assert.equal(invalidResult.partial_result, undefined);
  assert.equal(invalidResult.partial_diagnostic, undefined);
  assert.match(invalidResult.stderr, /document type is not result/);

  const retriesResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'usage_json_retries', prompt: 'count every provider retry', dangerous: false }),
  });
  assert.equal(retriesResponse.status, 200);
  const retriesResult = await retriesResponse.json();
  assert.equal(retriesResult.stdout, 'RETRY_OK');
  assert.equal(retriesResult.dropped_out, false);
  assert.equal(retriesResult.provider_retries.count, 2);
  assert.equal(retriesResult.provider_retries.total_delay_ms, 300);
  assert.equal(retriesResult.provider_retries.observed_events, 5);
  assert.equal(retriesResult.provider_retries.invalid_events, 2);
  assert.equal(retriesResult.provider_retries.duplicate_events, 1);
  assert.deepEqual(retriesResult.provider_retries.by_error, { overloaded: 1, rate_limit: 1 });
  assert.deepEqual(retriesResult.provider_retries.by_status, { 429: 1, 529: 1 });
  assert.equal(retriesResult.provider_retries.events.length, 2);
  assert.match(retriesResult.provider_retries.events[0].event_id_hash, /^[0-9a-f]{64}$/);
  assert.equal(retriesResult.provider_stop_reason, 'end_turn');
  assert.equal(retriesResult.provider_num_turns, 3);
  assert.equal(retriesResult.provider_duration_ms, 987);
  assert.equal(retriesResult.provider_api_duration_ms, 654);
  assert.equal(retriesResult.provider_terminal_reason, 'completed');
  assert.equal(retriesResult.provider_api_error_status, null);
  assert.equal(retriesResult.provider_permission_denials.count, 1);
  assert.equal(retriesResult.provider_permission_denials.observed, 1);
  assert.deepEqual(retriesResult.provider_permission_denials.byTool, { WebFetch: 1 });
  assert.equal(Object.prototype.hasOwnProperty.call(retriesResult.provider_permission_denials.retained[0], 'tool_input'), false);
  const retriesLedger = fs.readFileSync(path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const retriesReceipt = retriesLedger.find((row) => row.receiptId === retriesResult.receiptId);
  assert.equal(retriesReceipt.providerRetryCount, 2);
  assert.equal(retriesReceipt.providerRetryDelayMs, 300);
  assert.deepEqual(retriesReceipt.providerRetryByError, retriesResult.provider_retries.by_error);
  assert.equal(retriesReceipt.providerRetryInvalidEvents, 2);
  assert.equal(retriesReceipt.providerRetryDuplicateEvents, 1);
  assert.equal(retriesReceipt.providerTerminalReason, 'completed');
  assert.equal(retriesReceipt.providerPermissionDenialCount, 1);
  assert.deepEqual(retriesReceipt.providerPermissionDenialsByTool, { WebFetch: 1 });

  const budgetErrorResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'usage_json_budget_error', prompt: 'classify official budget error arm', dangerous: false }),
  });
  const budgetError = await budgetErrorResponse.json();
  assert.equal(budgetError.exitCode, 0);
  assert.equal(budgetError.stdout, '');
  assert.match(budgetError.stderr, /maximum budget exceeded/);
  assert.equal(budgetError.result_subtype, 'error_max_budget_usd');
  assert.equal(budgetError.failureClass, 'budget');
  assert.equal(budgetError.budget_exceeded, true);
  assert.equal(budgetError.rate_limited, false);
  assert.equal(budgetError.dropped_out, true);
  assert.equal(budgetError.usage.total_tokens, 13);
  assert.equal(budgetError.provider_error_count, 1);
  assert.equal(budgetError.provider_error_observed, 1);
  assert.equal(budgetError.provider_error_invalid, 0);
  assert.equal(budgetError.provider_error_diagnostic_truncated, false);
  const budgetReceipt = fs.readFileSync(path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map((line) => JSON.parse(line))
    .find((row) => row.receiptId === budgetError.receiptId);
  assert.equal(budgetReceipt.failureClass, 'budget');
  assert.equal(budgetReceipt.resultSubtype, 'error_max_budget_usd');
  assert.equal(budgetReceipt.providerErrorCount, 1);
  assert.match(budgetReceipt.providerErrorHash, /^[0-9a-f]{64}$/);

  const rateErrorResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'usage_json_rate_error', prompt: 'rate signal outranks generic execution subtype', dangerous: false }),
  });
  const rateError = await rateErrorResponse.json();
  assert.equal(rateError.failureClass, 'rate_limit');
  assert.equal(rateError.rate_limited, true);
  const rateErrorReceipt = fs.readFileSync(path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map((line) => JSON.parse(line))
    .find((row) => row.receiptId === rateError.receiptId);
  assert.equal(rateErrorReceipt.failureClass, 'rate_limit');

  const maxTokensResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'usage_json_max_tokens', prompt: 'do not count truncated output as success', dangerous: false }),
  });
  const maxTokens = await maxTokensResponse.json();
  assert.equal(maxTokens.stdout, 'TRUNCATED_ANSWER');
  assert.equal(maxTokens.provider_stop_reason, 'max_tokens');
  assert.equal(maxTokens.failureClass, 'max_tokens');
  assert.equal(maxTokens.dropped_out, true);

  const authErrorResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'usage_json_auth_error', prompt: 'classify official login failure', dangerous: false }),
  });
  const authError = await authErrorResponse.json();
  assert.equal(authError.auth_failed, true);
  assert.equal(authError.failureClass, 'auth');
  assert.equal(authError.dropped_out, true);
  assert.match(authError.stderr, /Please run \/login/);

  const apiTimeoutResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'usage_json_api_timeout', prompt: 'classify API 504 without prose guessing', dangerous: false }),
  });
  const apiTimeout = await apiTimeoutResponse.json();
  assert.equal(apiTimeout.timed_out, true);
  assert.equal(apiTimeout.failureClass, 'timeout');
  assert.equal(apiTimeout.provider_api_error_status, 504);
  assert.equal(apiTimeout.dropped_out, true);

  const deferredResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'usage_json_tool_deferred', prompt: 'do not count deferred work as complete', dangerous: false }),
  });
  const deferred = await deferredResponse.json();
  assert.equal(deferred.stdout, 'TOOL_DEFERRED');
  assert.equal(deferred.provider_stop_reason, 'tool_deferred');
  assert.equal(deferred.provider_terminal_reason, 'tool_deferred');
  assert.equal(deferred.failureClass, 'tool_deferred');
  assert.equal(deferred.dropped_out, true);

  const expandedTerminalReasons = new Map([
    ['malformed_tool_use_exhausted', 'malformed_tool_use_exhausted'],
    ['budget_exhausted', 'budget'],
    ['structured_output_retry_exhausted', 'structured_output_retry_exhausted'],
    ['api_error', 'rate_limit'],
    ['background_requested', 'background_requested'],
    ['turn_setup_failed', 'turn_setup_failed'],
    ['tool_deferred_unavailable', 'tool_deferred_unavailable'],
  ]);
  for (const [terminalReason, failureClass] of expandedTerminalReasons) {
    const response = await fetch(baseUrl + '/api/oneshot', {
      method: 'POST', headers: jsonAuth,
      body: JSON.stringify({
        kind: 'usage_json_terminal_from_prompt', prompt: terminalReason, dangerous: false,
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.doesNotMatch(result.stderr, /terminal_reason is unsupported/);
    assert.equal(result.provider_terminal_reason, terminalReason);
    assert.equal(result.failureClass, failureClass);
    assert.equal(result.dropped_out, true);
    assert.equal(result.usage.total_tokens, 4);
  }

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

  const providerTimeoutResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ kind: 'provider_internal_timeout', prompt: 'provider deadline fixture', dangerous: false }),
  });
  assert.equal(providerTimeoutResponse.status, 200);
  const providerTimeoutResult = await providerTimeoutResponse.json();
  assert.equal(providerTimeoutResult.dropped_out, true);
  assert.equal(providerTimeoutResult.timed_out, true);
  assert.equal(providerTimeoutResult.failureClass, 'timeout');
  assert.equal(providerTimeoutResult.stop_reason, 'provider_internal_timeout');
  assert.equal(providerTimeoutResult.supervisor_stop_reason, null);
  assert.equal(providerTimeoutResult.provider_timeout_source, 'provider_cli_diagnostic');
  assert.equal(providerTimeoutResult.usage, null);
  const providerTimeoutLedger = fs.readFileSync(
    path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8',
  ).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const providerTimeoutReceipt = providerTimeoutLedger.find((row) => row.receiptId === providerTimeoutResult.receiptId);
  assert.equal(providerTimeoutReceipt.status, 'timed_out');
  assert.equal(providerTimeoutReceipt.failureClass, 'timeout');
  assert.equal(providerTimeoutReceipt.stopReason, 'provider_internal_timeout');
  assert.equal(providerTimeoutReceipt.supervisorStopReason, null);
  assert.equal(providerTimeoutReceipt.providerTimeoutSource, 'provider_cli_diagnostic');

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

  // Regression: executeOneShot's CLI path returns after registering child
  // callbacks, before proc.on('close') sends the response. Background tasks
  // must wait for that deferred response instead of failing immediately.
  const taskSubmitResponse = await fetch(baseUrl + '/api/tasks', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ kind: 'cwd_echo', prompt: 'deferred CLI task', cwd: tempRoot }),
  });
  assert.equal(taskSubmitResponse.status, 200);
  const submittedTask = await taskSubmitResponse.json();
  let completedTask = null;
  for (let attempt = 0; attempt < 80; attempt++) {
    const taskResponse = await fetch(`${baseUrl}/api/tasks/${submittedTask.id}`, { headers: auth });
    completedTask = await taskResponse.json();
    if (['done', 'failed', 'cancelled', 'interrupted'].includes(completedTask.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(completedTask.status, 'done', completedTask.error || 'CLI background task did not complete');
  assert.equal(completedTask.result, tempRoot);
  assert.equal(completedTask.route.requested_effort, null);
  assert.equal(completedTask.route.target_effort, 'low');
  assert.equal(completedTask.route.applied_effort, null);
  assert.equal(completedTask.route.effort_method, 'account_default');
  assert.match(completedTask.route.effort_fallback_reason, /cannot express requested effort=low/);

  // Regression: the durable queue used to whitelist only prompt/cwd/user.
  // A caller explicitly requested Claude heavy/max plus a low test budget,
  // but the queued execution silently fell back to Sonnet/default ceilings.
  const controlledTaskResponse = await fetch(baseUrl + '/api/tasks', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({
      kind: 'queued_controls', prompt: 'cross-module architecture debugging',
      taskTier: 'complex', modelTier: 'heavy', effort: 'max', maxEffortOverride: true,
      providerBudget: { maxTotalTokens: 10 },
    }),
  });
  assert.equal(controlledTaskResponse.status, 200);
  const controlledTask = await controlledTaskResponse.json();
  let completedControlledTask = null;
  for (let attempt = 0; attempt < 80; attempt++) {
    const taskResponse = await fetch(`${baseUrl}/api/tasks/${controlledTask.id}`, { headers: auth });
    completedControlledTask = await taskResponse.json();
    if (['done', 'failed', 'cancelled', 'interrupted'].includes(completedControlledTask.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(completedControlledTask.status, 'failed');
  assert.match(completedControlledTask.error, /total_tokens/);
  assert.equal(completedControlledTask.route.requested_model, 'heavy-fixture');
  assert.equal(completedControlledTask.route.requested_effort, 'max');
  assert.equal(completedControlledTask.route.max_effort_override, true);

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
    body: JSON.stringify({
      kind: 'slow', prompt: 'first slow request', dangerous: false,
      requestId: 'test:client-cancel:one',
    }),
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
  const cancellationLedger = fs.readFileSync(path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const cancelledReceipts = cancellationLedger.filter((row) =>
    row.requestId === 'test:client-cancel:one' && row.status === 'cancelled');
  assert.equal(cancelledReceipts.length, 1, 'client disconnect writes exactly one terminal receipt');
  const cancelledReceipt = cancelledReceipts[0];
  assert.ok(cancelledReceipt, 'client disconnect must persist a terminal provider receipt');
  assert.equal(cancelledReceipt.failureClass, 'client_cancelled');
  assert.equal(cancelledReceipt.stopReason, 'client_cancelled');
  assert.equal(cancelledReceipt.modelInvocation, true);
  assert.equal(cancelledReceipt.tokenUsageSource, 'unknown');
  assert.equal(cancelledReceipt.invocationId, 'test:client-cancel:one');
  assert.equal(cancelledReceipt.attemptId, 'test:client-cancel:one:attempt:1');
  assert.equal(cancelledReceipt.physicalAttemptCount, 1);
  assert.equal(cancelledReceipt.providerRetryCount, 0);
  assert.equal(cancelledReceipt.cleanedOutputUnavailable, true);
  assert.ok(cancelledReceipt.progressAtCancellation);

  const deadlineController = new AbortController();
  const deadlineRequest = fetch(baseUrl + '/api/oneshot', {
    method: 'POST',
    headers: {
      ...jsonAuth,
      'X-RelayBridge-Client': 'mcp',
      'X-RelayBridge-Client-Deadline-At': String(Date.now() - 1000),
      'X-RelayBridge-Expected-Build-Id': runningHealth.buildId,
      'X-RelayBridge-Expected-Receipt-Store-Id': runningHealth.receiptStoreId,
    },
    body: JSON.stringify({
      kind: 'slow', prompt: 'MCP deadline cancellation', dangerous: false,
      requestId: 'test:mcp-deadline:one',
    }),
    signal: deadlineController.signal,
  });
  const deadlineAdmissionWait = Date.now() + 5000;
  let deadlineAdmitted = false;
  while (Date.now() < deadlineAdmissionWait && !deadlineAdmitted) {
    const health = await (await fetch(baseUrl + '/api/health')).json();
    deadlineAdmitted = health.activeOneShotCount === 1;
    if (!deadlineAdmitted) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(deadlineAdmitted, true, 'deadline fixture must reach provider admission before disconnect');
  deadlineController.abort();
  await deadlineRequest.catch(() => {});
  let deadlineReceipt = null;
  const deadlineReceiptWait = Date.now() + 5000;
  while (Date.now() < deadlineReceiptWait && !deadlineReceipt) {
    const rows = fs.readFileSync(path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map(JSON.parse);
    deadlineReceipt = rows.find((row) => row.requestId === 'test:mcp-deadline:one') || null;
    if (!deadlineReceipt) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(deadlineReceipt);
  assert.equal(deadlineReceipt.failureClass, 'mcp_deadline_cancelled');
  assert.equal(deadlineReceipt.stopReason, 'mcp_deadline_cancelled');
  assert.equal(deadlineReceipt.modelInvocation, true);
  assert.equal(deadlineReceipt.tokenUsageSource, 'unknown');
  assert.equal(deadlineReceipt.physicalAttemptCount, 1);
  const deadlineCleanupWait = Date.now() + 5000;
  while (Date.now() < deadlineCleanupWait) {
    const health = await (await fetch(baseUrl + '/api/health')).json();
    if (health.activeOneShotCount === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const raceController = new AbortController();
  const raceRequest = fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({
      kind: 'race_complete', prompt: 'completion cancellation race', dangerous: false,
      requestId: 'test:completion-race:one',
    }),
    signal: raceController.signal,
  });
  setTimeout(() => raceController.abort(), 200);
  await raceRequest.catch(() => null);
  const raceReceiptWait = Date.now() + 5000;
  let raceReceipts = [];
  while (Date.now() < raceReceiptWait) {
    raceReceipts = fs.readFileSync(path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map(JSON.parse)
      .filter((row) => row.requestId === 'test:completion-race:one');
    if (raceReceipts.length) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(raceReceipts.length, 1, 'completion/cancellation race persists one terminal attempt');
  assert.ok(['completed', 'cancelled'].includes(raceReceipts[0].status));
  assert.equal(raceReceipts[0].physicalAttemptCount, 1);
  assert.equal(raceReceipts[0].providerRetryCount, 0);
  const raceCleanupWait = Date.now() + 5000;
  let raceActiveCount = -1;
  while (Date.now() < raceCleanupWait) {
    raceActiveCount = (await (await fetch(baseUrl + '/api/health')).json()).activeOneShotCount;
    if (raceActiveCount === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(raceActiveCount, 0, 'completion/cancellation race leaves no provider survivor');

  const retryHangController = new AbortController();
  const retryHang = fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ kind: 'retry_hang', prompt: 'preserve retry metrics on cancellation', dangerous: false }),
    signal: retryHangController.signal,
  });
  // Windows process startup can exceed 250 ms after the expanded structured
  // result fixture census. Give the helper enough time to emit the retry event
  // before cancelling; the assertion below still proves cancellation preserves
  // that already-observed event rather than manufacturing one.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  retryHangController.abort();
  await retryHang.catch(() => {});
  const retryHangDeadline = Date.now() + 5000;
  let retryHangReceipt = null;
  while (Date.now() < retryHangDeadline) {
    const rows = fs.readFileSync(path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map((line) => JSON.parse(line));
    retryHangReceipt = rows.find((row) => row.provider === 'retry_hang' && row.status === 'cancelled') || null;
    if (retryHangReceipt) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(retryHangReceipt, 'structured cancellation receipt must be durable');
  assert.equal(retryHangReceipt.providerRetryCount, 1);
  assert.equal(retryHangReceipt.providerRetryDelayMs, 250);
  assert.equal(retryHangReceipt.estimatedOutputTokens, 0, 'wire JSON is not model response text');
  assert.equal(retryHangReceipt.tokenUsageSource, 'unknown');
  assert.equal(retryHangReceipt.tokenEstimateScope, null);
  assert.ok(retryHangReceipt.transportOutputChars > 0);
  assert.match(retryHangReceipt.transportOutputHash, /^[0-9a-f]{64}$/);

  const retryTimeoutResponse = await fetch(baseUrl + '/api/oneshot', {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({
      kind: 'retry_timeout', prompt: 'preserve retry metrics on timeout',
      timeoutMs: 1000, dangerous: false,
    }),
  });
  const retryTimeout = await retryTimeoutResponse.json();
  assert.equal(retryTimeout.timed_out, true);
  assert.equal(retryTimeout.failureClass, 'timeout');
  assert.equal(retryTimeout.provider_timeout_source, 'relay_supervisor');
  assert.equal(retryTimeout.provider_retries.count, 1);
  assert.equal(retryTimeout.provider_retries.total_delay_ms, 250);
  assert.equal(retryTimeout.stdout, '');
  const retryTimeoutReceipt = fs.readFileSync(path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map((line) => JSON.parse(line))
    .find((row) => row.receiptId === retryTimeout.receiptId);
  assert.equal(retryTimeoutReceipt.status, 'timed_out');
  assert.equal(retryTimeoutReceipt.failureClass, 'timeout');
  assert.equal(retryTimeoutReceipt.providerTimeoutSource, 'relay_supervisor');
  assert.equal(retryTimeoutReceipt.providerRetryCount, 1);
  assert.equal(retryTimeoutReceipt.estimatedOutputTokens, 0);

  const diag = await (await fetch(baseUrl + '/api/diag', { headers: auth })).json();
  assert.equal(diag.results.echo.found, true);
  assert.equal(diag.results.echo.ready, true);
  assert.match(diag.results.echo.detail, /prompt-file-cli 1\.0\.0/);
  const activity = await (await fetch(baseUrl + '/api/activity?limit=5', { headers: auth })).json();
  assert.ok(Array.isArray(activity.runs));
  assert.ok(Array.isArray(activity.receipts));
});

test('linked provider accounts fail closed, isolate cooldowns, and refresh mutations', { timeout: 30000 }, async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-bridge-account-pool-test-'));
  const dataDir = path.join(tempRoot, 'data');
  const configPath = path.join(tempRoot, 'config.json');
  const tokenPath = path.join(tempRoot, 'capability.token');
  const helper = path.join(ROOT, 'test', 'prompt-file-cli.js');
  const pooledMarker = path.join(tempRoot, 'pooled-invocations.txt');
  const toggleMarker = path.join(tempRoot, 'toggle-invocations.txt');
  const authMarker = path.join(tempRoot, 'auth-invocations.txt');
  const staleAuthMarker = path.join(tempRoot, 'stale-auth-invocations.txt');
  const defaultAuthMarker = path.join(tempRoot, 'default-auth-invocations.txt');
  const nonAuthMarker = path.join(tempRoot, 'non-auth-invocations.txt');
  const auxiliarySignInMarker = path.join(tempRoot, 'auxiliary-sign-in-invocations.txt');
  const configDriftMarker = path.join(tempRoot, 'config-drift-invocations.txt');
  const pristineDefaultMarker = path.join(tempRoot, 'pristine-default-invocations.txt');
  const pooledBaseSeat = 'subscription:test:pooled';
  const pooledWorkSeat = `${pooledBaseSeat}#work`;
  const toggleBaseSeat = 'subscription:test:toggle';
  const toggleWorkSeat = `${toggleBaseSeat}#work`;
  const sharedBaseSeat = 'subscription:test:shared';
  const sharedWorkSeat = `${sharedBaseSeat}#work`;
  const copilotOverrideNames = [
    'COPILOT_GITHUB_TOKEN', 'GITHUB_COPILOT_API_TOKEN', 'GITHUB_COPILOT_GITHUB_TOKEN',
    'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST',
    'COPILOT_PROVIDER_BASE_URL', 'COPILOT_PROVIDER_TYPE',
    'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN', 'COPILOT_PROVIDER_WIRE_API',
    'COPILOT_PROVIDER_TRANSPORT', 'COPILOT_PROVIDER_AZURE_API_VERSION', 'COPILOT_PROVIDER_MODEL_ID',
    'COPILOT_PROVIDER_WIRE_MODEL', 'COPILOT_PROVIDER_MODEL_LIMITS_ID',
    'COPILOT_PROVIDER_MAX_PROMPT_TOKENS', 'COPILOT_PROVIDER_MAX_OUTPUT_TOKENS',
    'COPILOT_PROVIDER_HEADERS', 'COPILOT_MODEL', 'COPILOT_OFFLINE', 'COPILOT_ENABLE_ALT_PROVIDERS',
  ];
  const provider = (label, quotaSeat, slotExtra) => ({
    label,
    quota_seat: quotaSeat,
    credential_env: 'TEST_ACCOUNT_HOME',
    credential_markers: ['.credentials.json'],
    safe: [process.execPath, helper, '--version'],
    dangerous: [process.execPath, helper, '--version'],
    oneshot_safe: [process.execPath, helper, '--prompt-file', '{prompt_file}', ...slotExtra],
    oneshot_dangerous: [process.execPath, helper, '--prompt-file', '{prompt_file}', ...slotExtra],
    diagnostic_binary: process.execPath,
    probe: [process.execPath, helper, '--version'],
  });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    pooled_rate: provider('Pooled rate-limit fixture', pooledBaseSeat, [
      '--invocation-marker', pooledMarker,
      '--stderr', 'HTTP 429 rate limit exceeded', '--exit', '29',
    ]),
    toggle_pool: provider('Mutation cache fixture', toggleBaseSeat, [
      '--invocation-marker', toggleMarker, '--print-env', 'TEST_ACCOUNT_HOME',
    ]),
    same_base: provider('Provider-key quota-seat fixture', 'same_base', [
      '--print-env', 'TEST_ACCOUNT_HOME',
    ]),
    auth_pool: {
      ...provider('Account-scoped auth fixture', 'subscription:test:auth', [
        '--invocation-marker', authMarker, '--print-env', 'TEST_ACCOUNT_HOME',
      ]),
      login_command: ['fake-provider', 'login'],
      probe: [process.execPath, '-e', "process.stderr.write('not logged in'); process.exit(1)"],
      probe_auth_authoritative: true,
      probe_redact: true,
    },
    shared_a: provider('Shared alias A', sharedBaseSeat, ['--print-env', 'TEST_ACCOUNT_HOME']),
    shared_b: provider('Shared alias B', sharedBaseSeat, ['--print-env', 'TEST_ACCOUNT_HOME']),
    stale_pool: provider('Stale linked-auth fixture', 'subscription:test:stale', [
      '--invocation-marker', staleAuthMarker,
      '--auth-fail-env-suffix', 'TEST_ACCOUNT_HOME', `${path.sep}aaa-stale`,
      '--print-env', 'TEST_ACCOUNT_HOME',
    ]),
    default_stale_pool: {
      ...provider('Expired default-auth fixture', 'subscription:test:default-stale', [
        '--invocation-marker', defaultAuthMarker,
        '--auth-fail-env-absent', 'TEST_ACCOUNT_HOME',
        '--print-env', 'TEST_ACCOUNT_HOME',
      ]),
      probe_auth_authoritative: false,
    },
    non_auth_pool: provider('Non-auth ENOENT fixture', 'subscription:test:non-auth', [
      '--invocation-marker', nonAuthMarker,
      '--stderr', 'ENOENT: provider internal helper path is missing', '--exit', '2',
    ]),
    auxiliary_signin_pool: provider('Auxiliary sign-in warning fixture', 'subscription:test:aux-signin', [
      '--invocation-marker', auxiliarySignInMarker,
      '--stderr', 'MCP server docs: authentication required; MCP OAuth token expired; Sign in to enable search', '--exit', '2',
    ]),
    config_drift_pool: provider('Credential relocation drift fixture', 'subscription:test:config-drift', [
      '--invocation-marker', configDriftMarker, '--print-env', 'TEST_ACCOUNT_HOME',
    ]),
    codex: provider('Available default Codex fixture', 'subscription:test:planning-codex', []),
    copilot: {
      label: 'Uninstalled preferred Copilot fixture',
      tags: ['coding'],
      safe: ['relaybridge-uninstalled-copilot'],
      dangerous: ['relaybridge-uninstalled-copilot'],
      oneshot_safe: ['relaybridge-uninstalled-copilot'],
      oneshot_dangerous: ['relaybridge-uninstalled-copilot'],
      probe: ['relaybridge-uninstalled-copilot', '--version'],
      version_probe: ['relaybridge-uninstalled-copilot', '--version'],
    },
    copilot_home_pool: {
      ...provider('Copilot credential-home fixture', 'subscription:test:copilot-home', [
        '--assert-later-arg', '--no-auto-login',
        '--print-env-json', ['COPILOT_HOME', 'GH_CONFIG_DIR', ...copilotOverrideNames].join(','),
      ]),
      credential_env: 'COPILOT_HOME',
      credential_aux_env: ['GH_CONFIG_DIR'],
      credential_markers: ['config.json'],
      linked_account_args: ['--no-auto-login'],
      strip_env: copilotOverrideNames,
    },
    linked_403_pool: {
      ...provider('Linked non-auth 403 fixture', 'subscription:test:linked-403', [
        '--claude-json-permission-403',
      ]),
      oneshot_output_parser: 'claude_json',
    },
    default_403_pool: {
      ...provider('Default non-auth 403 fixture', 'subscription:test:default-403', [
        '--claude-json-permission-403',
      ]),
      oneshot_output_parser: 'claude_json',
    },
    unsupported_pool: {
      ...provider('Unsupported linked-auth fixture', 'subscription:test:unsupported', []),
      linked_accounts_supported: false,
      linked_accounts_unavailable_reason: 'fixture cannot isolate its OS credential store',
    },
    pristine_default_pool: {
      ...provider('Pristine default auth fixture', 'subscription:test:pristine-default', [
        '--invocation-marker', pristineDefaultMarker,
        '--auth-fail-env-absent', 'TEST_ACCOUNT_HOME',
        '--print-env', 'TEST_ACCOUNT_HOME',
      ]),
      login_command: ['fake-provider', 'login'],
      probe_auth_authoritative: false,
    },
  }), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({
    providers: {
      pooled_rate: {
        accounts: [
          { id: 'default', label: 'existing sign-in', enabled: true },
          { id: 'work', label: 'work plan', enabled: true },
        ],
      },
      toggle_pool: {
        accounts: [
          { id: 'default', label: 'existing sign-in', enabled: false },
          { id: 'work', label: 'work plan', enabled: false },
        ],
      },
      same_base: {
        accounts: [
          { id: 'default', label: 'existing sign-in', enabled: true },
          { id: 'work', label: 'work plan', enabled: true },
        ],
      },
      auth_pool: {
        accounts: [
          { id: 'default', label: 'existing sign-in', enabled: true },
          { id: 'work', label: 'work plan', enabled: true },
        ],
      },
      shared_a: {
        accounts: [
          { id: 'default', label: 'existing sign-in', enabled: true },
          { id: 'work', label: 'work plan', enabled: true },
        ],
      },
      shared_b: {
        accounts: [{ id: 'default', label: 'existing sign-in', enabled: true }],
      },
      stale_pool: {
        accounts: [
          { id: 'default', label: 'existing sign-in', enabled: false },
          { id: 'aaa-stale', label: 'stale token', enabled: true },
          { id: 'zzz-healthy', label: 'healthy token', enabled: true },
        ],
      },
      default_stale_pool: {
        accounts: [
          { id: 'default', label: 'expired existing sign-in', enabled: true },
          { id: 'work', label: 'healthy linked plan', enabled: true },
        ],
      },
      non_auth_pool: {
        accounts: [
          { id: 'default', label: 'existing sign-in', enabled: false },
          { id: 'work', label: 'linked plan', enabled: true },
        ],
      },
      auxiliary_signin_pool: {
        accounts: [
          { id: 'default', label: 'existing sign-in', enabled: false },
          { id: 'work', label: 'linked plan', enabled: true },
        ],
      },
      config_drift_pool: {
        accounts: [
          { id: 'default', label: 'enabled default', enabled: true },
          { id: 'work', label: 'managed linked plan', enabled: true },
        ],
      },
      copilot_home_pool: {
        accounts: [
          { id: 'default', label: 'existing sign-in', enabled: false },
          { id: 'work', label: 'Copilot work plan', enabled: true },
        ],
      },
      linked_403_pool: {
        accounts: [
          { id: 'default', label: 'existing sign-in', enabled: false },
          { id: 'work', label: 'linked plan', enabled: true },
        ],
      },
      default_403_pool: {
        accounts: [
          { id: 'default', label: 'existing sign-in', enabled: true },
        ],
      },
      unsupported_pool: {
        accounts: [
          { id: 'default', label: 'existing sign-in', enabled: true },
          { id: 'work', label: 'unsafe linked plan', enabled: true },
        ],
      },
    },
  }, null, 2), 'utf8');
  for (const kind of [
    'pooled_rate', 'toggle_pool', 'same_base', 'auth_pool', 'shared_a',
    'default_stale_pool', 'non_auth_pool', 'auxiliary_signin_pool', 'config_drift_pool',
    'linked_403_pool', 'unsupported_pool',
  ]) {
    const accountDir = path.join(dataDir, 'accounts', kind, 'work');
    fs.mkdirSync(accountDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(accountDir, '.credentials.json'), '{}', { mode: 0o600 });
  }
  for (const id of ['aaa-stale', 'zzz-healthy']) {
    const accountDir = path.join(dataDir, 'accounts', 'stale_pool', id);
    fs.mkdirSync(accountDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(accountDir, '.credentials.json'), '{}', { mode: 0o600 });
  }
  const copilotWorkDir = path.join(dataDir, 'accounts', 'copilot_home_pool', 'work');
  fs.mkdirSync(copilotWorkDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(copilotWorkDir, 'config.json'), '{}', { mode: 0o600 });
  const initialCooldownAt = Date.now();
  fs.writeFileSync(path.join(dataDir, 'cooldowns.json'), JSON.stringify({
    [pooledBaseSeat]: {
      offences: 1,
      lastOffenceAt: initialCooldownAt,
      until: initialCooldownAt + 3600000,
      reason: 'rate_limited',
      source: 'backoff',
      scope: 'account',
    },
    toggle_pool: {
      offences: 1,
      lastOffenceAt: initialCooldownAt,
      until: initialCooldownAt + 3600000,
      reason: 'rate_limited',
      source: 'backoff',
      scope: 'model',
    },
    same_base: {
      offences: 1,
      lastOffenceAt: initialCooldownAt,
      until: initialCooldownAt + 3600000,
      reason: 'rate_limited',
      source: 'backoff',
      scope: 'account',
    },
  }, null, 2), 'utf8');

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      RELAYBRIDGE_TEST_BUILD_ID: TEST_BUILD_ID,
      PORT: String(port),
      PTY_MODE: 'none',
      RELAYBRIDGE_CONFIG_FILE: configPath,
      RELAYBRIDGE_TOKEN_FILE: tokenPath,
      RELAYBRIDGE_DATA_DIR: dataDir,
      RELAYBRIDGE_ALLOWED_ROOTS: tempRoot,
      ...Object.fromEntries(copilotOverrideNames.map((name) => [name, 'must-not-override-the-selected-account'])),
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
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  try {
    await waitForHealth(baseUrl, proc);
  } catch (err) {
    throw new Error(err.message + '\n' + serverOutput);
  }
  const headers = await capabilityHeaders(baseUrl, true);

  const unsupportedStatus = await (await fetch(`${baseUrl}/api/accounts`, { headers })).json();
  assert.equal(unsupportedStatus.providers.unsupported_pool.supportsMultipleAccounts, false);
  assert.match(unsupportedStatus.providers.unsupported_pool.linkedAccountsUnavailableReason,
    /cannot isolate its OS credential store/);
  const unsupportedAdd = await fetch(`${baseUrl}/api/accounts/unsupported_pool`, {
    method: 'POST', headers, body: JSON.stringify({ id: 'spare' }),
  });
  assert.equal(unsupportedAdd.status, 400,
    'the REST surface must not create accounts the dispatch path cannot isolate');
  const unsupportedDispatch = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'unsupported_pool', prompt: 'must fail before execution', dangerous: false }),
  });
  assert.equal(unsupportedDispatch.status, 409);
  assert.equal((await unsupportedDispatch.json()).failureClass, 'account_configuration_invalid');

  const firstDefaultResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'codex', prompt: 'establish one live default result', dangerous: false }),
  });
  assert.equal(firstDefaultResponse.status, 200);
  assert.equal((await firstDefaultResponse.json()).exitCode, 0);
  const completeRoute = await (await fetch(`${baseUrl}/api/route`, {
    method: 'POST', headers,
    body: JSON.stringify({
      task: 'implement a complex repository change',
      preferKinds: ['copilot', 'codex'],
    }),
  })).json();
  assert.equal(completeRoute.selected.some((item) => item.kind === 'copilot'), false,
    'a partial live-auth snapshot must still path-check missing provider keys');
  assert.equal(completeRoute.selected.some((item) => item.kind === 'codex'), true);
  const completePlan = await (await fetch(`${baseUrl}/api/plan`, {
    method: 'POST', headers,
    body: JSON.stringify({ task: 'implement a complex repository change' }),
  })).json();
  assert.notEqual(completePlan.primary.kind, 'copilot',
    'planning must not select an uninstalled provider omitted from a partial runtime snapshot');

  const copilotRelocationResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'copilot_home_pool', prompt: 'use the relocated Copilot profile', dangerous: false }),
  });
  assert.equal(copilotRelocationResponse.status, 200);
  const copilotRelocation = await copilotRelocationResponse.json();
  assert.equal(copilotRelocation.route.account, 'work');
  assert.deepEqual(JSON.parse(copilotRelocation.stdout), {
    COPILOT_HOME: copilotWorkDir,
    GH_CONFIG_DIR: copilotWorkDir,
    ...Object.fromEntries(copilotOverrideNames.map((name) => [name, null])),
  }, 'the child must receive the selected profile and no inherited token override');

  for (const kind of ['linked_403_pool', 'default_403_pool']) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const nonAuth403Response = await fetch(`${baseUrl}/api/oneshot`, {
        method: 'POST', headers,
        body: JSON.stringify({ kind, prompt: `non-auth 403 attempt ${attempt}`, dangerous: false }),
      });
      assert.equal(nonAuth403Response.status, 200);
      const nonAuth403 = await nonAuth403Response.json();
      assert.equal(nonAuth403.failureClass, 'permission');
      assert.equal(nonAuth403.auth_failed, false);
      assert.equal(nonAuth403.route.account, kind === 'linked_403_pool' ? 'work' : null);
    }
  }
  let nonAuth403Status = await (await fetch(`${baseUrl}/api/accounts`, { headers })).json();
  assert.equal(nonAuth403Status.providers.linked_403_pool.accounts
    .find((account) => account.id === 'work').authUnavailable, false);
  assert.equal(nonAuth403Status.providers.default_403_pool.accounts
    .find((account) => account.id === 'default').authUnavailable, false,
  'a non-auth 403 must not durably quarantine linked or default credentials');

  let sharedUsage = await (await fetch(`${baseUrl}/api/usage/gauges`, { headers })).json();
  assert.deepEqual(sharedUsage.quotaSeats[sharedWorkSeat].providers, ['shared_a']);
  assert.deepEqual(sharedUsage.gauges['shared_a#work'].aliases, ['shared_a'],
    'an account linked under one alias must not affect another shared-base provider');
  const linkSharedAlias = await fetch(`${baseUrl}/api/accounts/shared_b`, {
    method: 'POST', headers, body: JSON.stringify({ id: 'work', label: 'work plan' }),
  });
  assert.equal(linkSharedAlias.status, 200);
  const linkInstructions = await linkSharedAlias.json();
  assert.deepEqual(linkInstructions.signIn.environment, {
    TEST_ACCOUNT_HOME: path.join(dataDir, 'accounts', 'shared_b', 'work'),
  });
  assert.ok(Array.isArray(linkInstructions.signIn.argv) || linkInstructions.signIn.argv === null);
  sharedUsage = await (await fetch(`${baseUrl}/api/usage/gauges`, { headers })).json();
  assert.deepEqual(sharedUsage.quotaSeats[sharedWorkSeat].providers, ['shared_a', 'shared_b']);
  assert.deepEqual(sharedUsage.gauges['shared_a#work'].aliases, ['shared_a', 'shared_b']);
  assert.deepEqual(sharedUsage.gauges['shared_b#work'].aliases, ['shared_a', 'shared_b']);

  const staleAuthResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'stale_pool', prompt: 'quarantine stale account', dangerous: false }),
  });
  const staleAuth = await staleAuthResponse.json();
  assert.equal(staleAuth.auth_failed, true);
  assert.equal(staleAuth.route.account, 'aaa-stale');
  const healthyAuthResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'stale_pool', prompt: 'fail over to healthy account', dangerous: false }),
  });
  const healthyAuth = await healthyAuthResponse.json();
  assert.equal(healthyAuth.exitCode, 0);
  assert.equal(healthyAuth.route.account, 'zzz-healthy');
  let accountStatus = await (await fetch(`${baseUrl}/api/accounts`, { headers })).json();
  assert.equal(accountStatus.providers.stale_pool.accounts
    .find((account) => account.id === 'aaa-stale').authUnavailable, true);

  const staleCredential = path.join(dataDir, 'accounts', 'stale_pool', 'aaa-stale', '.credentials.json');
  fs.writeFileSync(staleCredential, '{"refreshed":true}', 'utf8');
  const refreshedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const refreshedSlot = [
    process.execPath, helper, '--prompt-file', '{prompt_file}',
    '--invocation-marker', staleAuthMarker, '--print-env', 'TEST_ACCOUNT_HOME',
  ];
  refreshedConfig.stale_pool.oneshot_safe = refreshedSlot;
  refreshedConfig.stale_pool.oneshot_dangerous = refreshedSlot;
  fs.writeFileSync(configPath, JSON.stringify(refreshedConfig), 'utf8');
  const disableHealthy = await fetch(`${baseUrl}/api/accounts/stale_pool/zzz-healthy/enabled`, {
    method: 'POST', headers, body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disableHealthy.status, 200);
  const recoveredAuthResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'stale_pool', prompt: 'use refreshed credentials', dangerous: false }),
  });
  const recoveredAuth = await recoveredAuthResponse.json();
  assert.equal(recoveredAuth.exitCode, 0);
  assert.equal(recoveredAuth.route.account, 'aaa-stale');
  accountStatus = await (await fetch(`${baseUrl}/api/accounts`, { headers })).json();
  assert.equal(accountStatus.providers.stale_pool.accounts
    .find((account) => account.id === 'aaa-stale').authUnavailable, false);

  const expiredDefaultResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'default_stale_pool', prompt: 'discover expired default without a probe', dangerous: false }),
  });
  const expiredDefault = await expiredDefaultResponse.json();
  assert.equal(expiredDefault.auth_failed, true);
  assert.equal(expiredDefault.route.account, null);
  const noProbeFailoverResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'default_stale_pool', prompt: 'fail over after live default auth failure', dangerous: false }),
  });
  const noProbeFailover = await noProbeFailoverResponse.json();
  assert.equal(noProbeFailover.exitCode, 0);
  assert.equal(noProbeFailover.route.account, 'work');
  accountStatus = await (await fetch(`${baseUrl}/api/accounts`, { headers })).json();
  assert.equal(accountStatus.providers.default_stale_pool.accounts
    .find((account) => account.id === 'default').authUnavailable, true);

  const malformedAuthRetry = await fetch(`${baseUrl}/api/accounts/default_stale_pool/default/auth/retry`, {
    method: 'POST', headers, body: JSON.stringify({ retry: 'true' }),
  });
  assert.equal(malformedAuthRetry.status, 400,
    'operator auth recovery must require the exact typed acknowledgement');
  accountStatus = await (await fetch(`${baseUrl}/api/accounts`, { headers })).json();
  const quarantinedDefault = accountStatus.providers.default_stale_pool.accounts
    .find((account) => account.id === 'default');
  assert.equal(quarantinedDefault.authUnavailable, true);
  assert.deepEqual(quarantinedDefault.authRetry.body, { retry: true });

  const reloggedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const reloggedDefaultSlot = [
    process.execPath, helper, '--prompt-file', '{prompt_file}',
    '--invocation-marker', defaultAuthMarker, '--print-env', 'TEST_ACCOUNT_HOME',
  ];
  reloggedConfig.default_stale_pool.oneshot_safe = reloggedDefaultSlot;
  reloggedConfig.default_stale_pool.oneshot_dangerous = reloggedDefaultSlot;
  fs.writeFileSync(configPath, JSON.stringify(reloggedConfig), 'utf8');
  const authRetry = await fetch(`${baseUrl}/api/accounts/default_stale_pool/default/auth/retry`, {
    method: 'POST', headers, body: JSON.stringify({ retry: true }),
  });
  assert.equal(authRetry.status, 200);
  assert.equal((await authRetry.json()).priorAuthFailureCleared, true);
  const recoveredDefaultResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'default_stale_pool', prompt: 'validate explicit default auth retry', dangerous: false }),
  });
  const recoveredDefault = await recoveredDefaultResponse.json();
  assert.equal(recoveredDefault.exitCode, 0);
  assert.equal(recoveredDefault.route.account, null,
    'the explicit retry makes the implicit default eligible for one live validation');

  const expiredAgainConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const expiredDefaultSlot = [
    process.execPath, helper, '--prompt-file', '{prompt_file}',
    '--invocation-marker', defaultAuthMarker,
    '--auth-fail-env-absent', 'TEST_ACCOUNT_HOME',
    '--print-env', 'TEST_ACCOUNT_HOME',
  ];
  expiredAgainConfig.default_stale_pool.oneshot_safe = expiredDefaultSlot;
  expiredAgainConfig.default_stale_pool.oneshot_dangerous = expiredDefaultSlot;
  fs.writeFileSync(configPath, JSON.stringify(expiredAgainConfig), 'utf8');
  const expiredAfterRetryResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'default_stale_pool', prompt: 'credentials expire again after retry', dangerous: false }),
  });
  assert.equal((await expiredAfterRetryResponse.json()).auth_failed, true);
  const failoverAfterRetryResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'default_stale_pool', prompt: 'use work after retried default expires', dangerous: false }),
  });
  assert.equal((await failoverAfterRetryResponse.json()).route.account, 'work');

  const authRefresh = await fetch(`${baseUrl}/api/auth/status?refresh=1`, { headers });
  assert.equal(authRefresh.status, 200);
  accountStatus = await (await fetch(`${baseUrl}/api/accounts`, { headers })).json();
  assert.equal(accountStatus.providers.default_stale_pool.accounts
    .find((account) => account.id === 'default').authUnavailable, true,
  'a version-only probe must not clear authoritative live auth failure evidence');
  const versionOnlyFailoverResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'default_stale_pool', prompt: 'version-only probe cannot re-enable default', dangerous: false }),
  });
  assert.equal((await versionOnlyFailoverResponse.json()).route.account, 'work');

  const authoritativeProbeConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  authoritativeProbeConfig.default_stale_pool.probe_auth_authoritative = true;
  fs.writeFileSync(configPath, JSON.stringify(authoritativeProbeConfig), 'utf8');
  const authoritativeAuthRefresh = await fetch(`${baseUrl}/api/auth/status?refresh=1`, { headers });
  assert.equal(authoritativeAuthRefresh.status, 200);
  accountStatus = await (await fetch(`${baseUrl}/api/accounts`, { headers })).json();
  assert.equal(accountStatus.providers.default_stale_pool.accounts
    .find((account) => account.id === 'default').authUnavailable, false,
  'an explicitly authentication-authoritative successful probe clears the quarantine');
  const expiredAfterProbeResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'default_stale_pool', prompt: 'token expired after successful probe', dangerous: false }),
  });
  assert.equal((await expiredAfterProbeResponse.json()).auth_failed, true);
  const postProbeFailoverResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'default_stale_pool', prompt: 'fail over after post-probe expiry', dangerous: false }),
  });
  assert.equal((await postProbeFailoverResponse.json()).route.account, 'work');

  const pristineFailureResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'pristine_default_pool', prompt: 'discover pristine default auth failure', dangerous: false }),
  });
  const pristineFailure = await pristineFailureResponse.json();
  assert.equal(pristineFailure.auth_failed, true);
  accountStatus = await (await fetch(`${baseUrl}/api/accounts`, { headers })).json();
  assert.equal(accountStatus.providers.pristine_default_pool.accounts.length, 1);
  assert.equal(accountStatus.providers.pristine_default_pool.accounts[0].id, 'default');
  assert.equal(accountStatus.providers.pristine_default_pool.accounts[0].authUnavailable, true,
    'the first live failure materializes durable default-account authority');
  const pristineReloggedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const pristineHealthySlot = [
    process.execPath, helper, '--prompt-file', '{prompt_file}',
    '--invocation-marker', pristineDefaultMarker, '--print-env', 'TEST_ACCOUNT_HOME',
  ];
  pristineReloggedConfig.pristine_default_pool.oneshot_safe = pristineHealthySlot;
  pristineReloggedConfig.pristine_default_pool.oneshot_dangerous = pristineHealthySlot;
  fs.writeFileSync(configPath, JSON.stringify(pristineReloggedConfig), 'utf8');
  const pristineRetryResponse = await fetch(`${baseUrl}/api/accounts/pristine_default_pool/default/auth/retry`, {
    method: 'POST', headers, body: JSON.stringify({ retry: true }),
  });
  assert.equal(pristineRetryResponse.status, 200);
  const pristineRecoveredResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'pristine_default_pool', prompt: 'immediate retry after sign-in', dangerous: false }),
  });
  const pristineRecovered = await pristineRecoveredResponse.json();
  assert.equal(pristineRecovered.exitCode, 0);
  assert.equal(pristineRecovered.route.account, null,
    'operator retry clears live runtime quarantine without requiring a diagnostic refresh');

  for (const prompt of ['non-auth failure one', 'non-auth failure two']) {
    const nonAuthResponse = await fetch(`${baseUrl}/api/oneshot`, {
      method: 'POST', headers,
      body: JSON.stringify({ kind: 'non_auth_pool', prompt, dangerous: false }),
    });
    const nonAuth = await nonAuthResponse.json();
    assert.equal(nonAuth.route.account, 'work');
    assert.equal(nonAuth.auth_failed, false,
      'a provider/internal ENOENT is not evidence that linked credentials expired');
  }
  accountStatus = await (await fetch(`${baseUrl}/api/accounts`, { headers })).json();
  assert.equal(accountStatus.providers.non_auth_pool.accounts
    .find((account) => account.id === 'work').authUnavailable, false);

  for (const prompt of ['auxiliary warning one', 'auxiliary warning two']) {
    const auxiliaryWarningResponse = await fetch(`${baseUrl}/api/oneshot`, {
      method: 'POST', headers,
      body: JSON.stringify({ kind: 'auxiliary_signin_pool', prompt, dangerous: false }),
    });
    const auxiliaryWarning = await auxiliaryWarningResponse.json();
    assert.equal(auxiliaryWarning.route.account, 'work');
    assert.equal(auxiliaryWarning.auth_failed, false,
      'an auxiliary service sign-in warning is not provider credential evidence');
  }
  assert.equal(fs.readFileSync(auxiliarySignInMarker, 'utf8').trim().split(/\r?\n/).length, 2,
    'the unchanged linked credentials remain selectable after the warning');
  accountStatus = await (await fetch(`${baseUrl}/api/accounts`, { headers })).json();
  assert.equal(accountStatus.providers.auxiliary_signin_pool.accounts
    .find((account) => account.id === 'work').authUnavailable, false);

  const driftedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  delete driftedConfig.config_drift_pool.credential_env;
  fs.writeFileSync(configPath, JSON.stringify(driftedConfig), 'utf8');
  const driftRoute = await (await fetch(`${baseUrl}/api/route`, {
    method: 'POST', headers,
    body: JSON.stringify({
      task: 'inspect managed account configuration drift',
      diagnostics: { config_drift_pool: { found: true, ready: true } },
      preferKinds: ['config_drift_pool'],
    }),
  })).json();
  assert.equal(driftRoute.fleetState.accountSelection.config_drift_pool.available, false);
  assert.equal(driftRoute.fleetState.accountSelection.config_drift_pool.reason,
    'credential_relocation_unavailable');
  const driftAdvice = await (await fetch(`${baseUrl}/api/usage/advise`, {
    method: 'POST', headers,
    body: JSON.stringify({
      candidates: [{ seat: 'config_drift_pool', rank: 0, costClass: 'subscription' }],
    }),
  })).json();
  assert.equal(driftAdvice.ranked.length, 0);
  assert.equal(driftAdvice.allAccountsUnavailable, true);
  assert.equal(driftAdvice.accountUnavailableSkipped[0].reason,
    'credential_relocation_unavailable');
  const driftDispatchResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'config_drift_pool', prompt: 'must not use implicit default', dangerous: false }),
  });
  assert.equal(driftDispatchResponse.status, 500);
  const driftDispatch = await driftDispatchResponse.json();
  assert.equal(driftDispatch.failureClass, 'account_configuration_invalid');
  assert.equal(driftDispatch.model_invocation, false);
  assert.equal(fs.existsSync(configDriftMarker), false,
    'losing credential_env must not bypass a disabled managed default');

  const diagnostics = await (await fetch(`${baseUrl}/api/diag`, { headers })).json();
  assert.equal(diagnostics.results.auth_pool.authFailed, true);
  const authResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'auth_pool', prompt: 'use linked auth, never signed-out default', dangerous: false }),
  });
  assert.equal(authResponse.status, 200);
  const authResult = await authResponse.json();
  assert.equal(authResult.route.account, 'work');
  assert.equal(authResult.stdout, path.join(dataDir, 'accounts', 'auth_pool', 'work'));
  assert.equal(fs.readFileSync(authMarker, 'utf8').trim(), 'use linked auth, never signed-out default');

  const alternateRoute = await (await fetch(`${baseUrl}/api/route`, {
    method: 'POST', headers,
    body: JSON.stringify({
      task: 'inspect account-aware routing',
      diagnostics: { pooled_rate: { found: true, ready: true } },
    }),
  })).json();
  assert.equal(alternateRoute.fleetState.accountSelection.pooled_rate.available, true);
  assert.equal(alternateRoute.fleetState.accountSelection.pooled_rate.account, 'work');
  assert.equal(alternateRoute.fleetState.cooldownSkipped.includes('pooled_rate'), false,
    'a default-account cooldown must not hide a healthy linked account');

  const alternateAdvice = await (await fetch(`${baseUrl}/api/usage/advise`, {
    method: 'POST', headers,
    body: JSON.stringify({
      candidates: [{ seat: 'pooled_rate', rank: 0, costClass: 'subscription' }],
    }),
  })).json();
  assert.equal(alternateAdvice.ranked.some((item) => item.seat === 'pooled_rate'), true,
    'usage advice must not let a cooled default account hide a healthy linked account');
  assert.equal(alternateAdvice.accountSelection.pooled_rate.account, 'work');
  assert.equal(alternateAdvice.allCooling, false);

  const unavailableResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({
      kind: 'toggle_pool', prompt: 'must not reach default credentials', dangerous: false,
      requestId: 'test:account-unavailable:one',
    }),
  });
  assert.equal(unavailableResponse.status, 409);
  const unavailable = await unavailableResponse.json();
  assert.equal(unavailable.failureClass, 'account_unavailable');
  assert.equal(unavailable.model_invocation, false);
  assert.equal(fs.existsSync(toggleMarker), false, 'an unavailable pool must not spawn the provider');
  const rejectedReceipt = fs.readFileSync(
    path.join(dataDir, 'receipts', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8',
  ).trim().split(/\r?\n/).map(JSON.parse)
    .find((row) => row.receiptId === unavailable.receiptId);
  assert.equal(rejectedReceipt.physicalAttemptCount, 0);
  assert.equal(rejectedReceipt.modelInvocation, false);

  const stringFalseEnable = await fetch(`${baseUrl}/api/accounts/toggle_pool/work/enabled`, {
    method: 'POST', headers, body: JSON.stringify({ enabled: 'false' }),
  });
  assert.equal(stringFalseEnable.status, 400,
    'the string "false" must never be coerced into enabling an account');
  const extraEnableField = await fetch(`${baseUrl}/api/accounts/toggle_pool/work/enabled`, {
    method: 'POST', headers, body: JSON.stringify({ enabled: true, account: 'default' }),
  });
  assert.equal(extraEnableField.status, 400,
    'account authority mutations reject undeclared fields');
  accountStatus = await (await fetch(`${baseUrl}/api/accounts`, { headers })).json();
  assert.equal(accountStatus.providers.toggle_pool.accounts
    .find((account) => account.id === 'work').enabled, false);

  const enableResponse = await fetch(`${baseUrl}/api/accounts/toggle_pool/work/enabled`, {
    method: 'POST', headers, body: JSON.stringify({ enabled: true }),
  });
  assert.equal(enableResponse.status, 200);
  const enabledResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'toggle_pool', prompt: 'use the newly enabled account', dangerous: false }),
  });
  assert.equal(enabledResponse.status, 200,
    'account mutations must invalidate the dispatch cache immediately');
  const enabled = await enabledResponse.json();
  assert.equal(enabled.exitCode, 0);
  assert.equal(enabled.route.account, 'work');
  assert.equal(enabled.route.quota_seat, toggleWorkSeat);
  assert.equal(enabled.stdout, path.join(dataDir, 'accounts', 'toggle_pool', 'work'));
  assert.equal(fs.readFileSync(toggleMarker, 'utf8').trim(), 'use the newly enabled account');

  const sameBaseResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'same_base', prompt: 'do not clear the default account cooldown', dangerous: false }),
  });
  const sameBaseResult = await sameBaseResponse.json();
  assert.equal(sameBaseResult.route.account, 'work');
  assert.equal(sameBaseResult.route.quota_seat, 'same_base#work');

  const rateResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'pooled_rate', prompt: 'use the account whose quota remains', dangerous: false }),
  });
  assert.equal(rateResponse.status, 200);
  const rateResult = await rateResponse.json();
  assert.equal(rateResult.rate_limited, true);
  assert.equal(rateResult.route.account, 'work');
  assert.equal(rateResult.route.quota_seat, pooledWorkSeat);
  assert.equal(fs.readFileSync(pooledMarker, 'utf8').trim(), 'use the account whose quota remains');

  const cooldowns = await (await fetch(`${baseUrl}/api/cooldowns`, { headers })).json();
  assert.equal(cooldowns.cooldowns.toggle_pool.cooling, false,
    'a successful linked-account run must clear an earlier model-scoped provider cooldown');
  assert.equal(cooldowns.cooldowns.same_base.cooling, true,
    'success on work must not clear an account-scoped cooldown keyed like the provider');
  assert.equal(cooldowns.cooldowns[pooledBaseSeat].offences, 1,
    'a linked-account failure must not increment the base account cooldown');
  assert.equal(cooldowns.cooldowns[pooledWorkSeat].cooling, true);
  assert.equal(cooldowns.cooldowns[pooledWorkSeat].reason, 'rate_limited');
  assert.equal(cooldowns.quotaSeats[pooledWorkSeat].account.id, 'work');

  const allCoolingRoute = await (await fetch(`${baseUrl}/api/route`, {
    method: 'POST', headers,
    body: JSON.stringify({
      task: 'normal routing must avoid an entirely cooling pool',
      diagnostics: { pooled_rate: { found: true, ready: true } },
    }),
  })).json();
  assert.equal(allCoolingRoute.fleetState.accountSelection.pooled_rate.reason, 'cooling');
  assert.equal(allCoolingRoute.fleetState.cooldownSkipped.includes('pooled_rate'), true);
  const explicitCoolingRoute = await (await fetch(`${baseUrl}/api/route`, {
    method: 'POST', headers,
    body: JSON.stringify({
      task: 'explicitly probe a cooling pool', preferKinds: ['pooled_rate'],
      diagnostics: { pooled_rate: { found: true, ready: true } },
    }),
  })).json();
  assert.equal(explicitCoolingRoute.fleetState.cooldownSkipped.includes('pooled_rate'), false);

  const route = await (await fetch(`${baseUrl}/api/route`, {
    method: 'POST', headers,
    body: JSON.stringify({
      task: 'route with linked accounts', preferKinds: ['toggle_pool'],
      diagnostics: { toggle_pool: { found: true, ready: true } },
    }),
  })).json();
  assert.equal(route.fleetState.quotaSeats[toggleWorkSeat].account.id, 'work');

  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  const quotaResponse = await fetch(`${baseUrl}/api/usage/operator-quota`, {
    method: 'PUT', headers,
    body: JSON.stringify({
      quotaSeat: pooledWorkSeat,
      percentRemaining: 37,
      provenance: 'human_account_owner',
      expiresAt,
    }),
  });
  assert.equal(quotaResponse.status, 200,
    'operator quota evidence must accept a generated linked-account quota seat');
  const quotaStatus = await (await fetch(`${baseUrl}/api/usage/operator-quota`, { headers })).json();
  assert.equal(quotaStatus.observations[pooledWorkSeat].percentRemaining, 37);
  const clearResponse = await fetch(`${baseUrl}/api/usage/operator-quota`, {
    method: 'DELETE', headers, body: JSON.stringify({ quotaSeat: pooledWorkSeat }),
  });
  assert.equal(clearResponse.status, 200);

  const traversalTarget = path.join(dataDir, 'usage', 'victim');
  fs.mkdirSync(traversalTarget, { recursive: true });
  fs.writeFileSync(path.join(traversalTarget, 'keep.txt'), 'keep', 'utf8');
  const traversalResponse = await fetch(`${baseUrl}/api/accounts/%2E%2E%2Fusage/victim`, {
    method: 'DELETE', headers,
  });
  assert.equal(traversalResponse.status, 404);
  assert.equal(fs.readFileSync(path.join(traversalTarget, 'keep.txt'), 'utf8'), 'keep');

  const deleteWork = await fetch(`${baseUrl}/api/accounts/toggle_pool/work`, {
    method: 'DELETE', headers,
  });
  assert.equal(deleteWork.status, 200);
  assert.equal((await deleteWork.json()).credentialsRemoved, true);
  const deleteDefault = await fetch(`${baseUrl}/api/accounts/toggle_pool/default`, {
    method: 'DELETE', headers,
  });
  const defaultDeletion = await deleteDefault.json();
  assert.equal(defaultDeletion.credentialsRemoved, false);
  assert.equal(defaultDeletion.requiresProviderLogout, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'))
    .providers.toggle_pool.accounts, []);
  const markerBeforeTombstone = fs.readFileSync(toggleMarker, 'utf8');
  const tombstoneResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'toggle_pool', prompt: 'must not resurrect default', dangerous: false }),
  });
  assert.equal(tombstoneResponse.status, 409);
  assert.equal((await tombstoneResponse.json()).failureClass, 'account_unavailable');
  assert.equal(fs.readFileSync(toggleMarker, 'utf8'), markerBeforeTombstone);

  const registryPath = path.join(dataDir, 'accounts.json');
  const registryBeforeLoss = fs.readFileSync(registryPath, 'utf8');
  assert.equal(fs.readFileSync(path.join(dataDir, 'accounts.initialized'), 'utf8'), '1\n');
  fs.rmSync(registryPath);
  const missingRegistryResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'toggle_pool', prompt: 'must fail closed after registry loss', dangerous: false }),
  });
  assert.equal(missingRegistryResponse.status, 500);
  const missingRegistry = await missingRegistryResponse.json();
  assert.equal(missingRegistry.failureClass, 'account_registry_invalid');
  assert.equal(missingRegistry.model_invocation, false);
  assert.equal(fs.readFileSync(toggleMarker, 'utf8'), markerBeforeTombstone,
    'deleting a managed registry must never dispatch through default credentials');
  fs.writeFileSync(registryPath, registryBeforeLoss, 'utf8');

  const markerBeforeCorruption = fs.readFileSync(toggleMarker, 'utf8');
  const corruptRegistryBytes = '{ not valid json';
  fs.writeFileSync(registryPath, corruptRegistryBytes, 'utf8');
  const pooledCredentials = path.join(dataDir, 'accounts', 'pooled_rate', 'work', '.credentials.json');
  const corruptDeleteResponse = await fetch(`${baseUrl}/api/accounts/pooled_rate/work`, {
    method: 'DELETE', headers,
  });
  assert.equal(corruptDeleteResponse.status, 400);
  assert.equal(fs.readFileSync(pooledCredentials, 'utf8'), '{}');
  assert.equal(fs.readFileSync(registryPath, 'utf8'), corruptRegistryBytes);
  const corruptAddResponse = await fetch(`${baseUrl}/api/accounts/pooled_rate`, {
    method: 'POST', headers, body: JSON.stringify({ id: 'spare' }),
  });
  assert.equal(corruptAddResponse.status, 400);
  assert.equal(fs.readFileSync(registryPath, 'utf8'), corruptRegistryBytes);
  assert.equal((await fetch(`${baseUrl}/api/accounts`, { headers })).status, 500);
  const corruptRegistryResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'toggle_pool', prompt: 'must fail closed on corrupt account authority', dangerous: false }),
  });
  assert.equal(corruptRegistryResponse.status, 500);
  const corruptRegistry = await corruptRegistryResponse.json();
  assert.equal(corruptRegistry.failureClass, 'account_registry_invalid');
  assert.equal(corruptRegistry.model_invocation, false);
  assert.equal(fs.readFileSync(toggleMarker, 'utf8'), markerBeforeCorruption,
    'a corrupt account registry must never fall back to default credentials');
});

test('Copilot live signed-out evidence quarantines only the failing linked profile', { timeout: 15000 }, async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-bridge-copilot-auth-test-'));
  const dataDir = path.join(tempRoot, 'data');
  const configPath = path.join(tempRoot, 'config.json');
  const tokenPath = path.join(tempRoot, 'capability.token');
  const helper = path.join(ROOT, 'test', 'prompt-file-cli.js');
  const slot = [
    process.execPath, helper, '--prompt-file', '{prompt_file}',
    '--copilot-auth-fail-env-suffix', 'COPILOT_HOME', `${path.sep}aaa-stale`,
    '--print-env', 'COPILOT_HOME',
  ];
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    copilot: {
      label: 'Copilot live-auth fixture',
      credential_env: 'COPILOT_HOME',
      credential_aux_env: ['GH_CONFIG_DIR'],
      credential_markers: ['config.json'],
      linked_account_args: ['--no-auto-login'],
      login_command: ['copilot', 'login'],
      safe: [process.execPath, helper, '--version'],
      dangerous: [process.execPath, helper, '--version'],
      oneshot_safe: slot,
      oneshot_dangerous: slot,
      diagnostic_binary: process.execPath,
      probe: [process.execPath, helper, '--version'],
      probe_auth_authoritative: false,
    },
  }), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({
    providers: {
      copilot: {
        accounts: [
          { id: 'default', label: 'existing sign-in', enabled: false },
          { id: 'aaa-stale', label: 'stale Copilot login', enabled: true },
          { id: 'zzz-healthy', label: 'healthy Copilot login', enabled: true },
        ],
      },
    },
  }), 'utf8');
  for (const id of ['aaa-stale', 'zzz-healthy']) {
    const accountDir = path.join(dataDir, 'accounts', 'copilot', id);
    fs.mkdirSync(accountDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(accountDir, 'config.json'), '{}', { mode: 0o600 });
  }

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const bridge = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      RELAYBRIDGE_TEST_BUILD_ID: TEST_BUILD_ID,
      PORT: String(port),
      PTY_MODE: 'none',
      RELAYBRIDGE_CONFIG_FILE: configPath,
      RELAYBRIDGE_TOKEN_FILE: tokenPath,
      RELAYBRIDGE_DATA_DIR: dataDir,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (bridge.exitCode === null) bridge.kill('SIGTERM');
    await new Promise((resolve) => bridge.exitCode !== null ? resolve() : bridge.once('exit', resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  await waitForHealth(baseUrl, bridge);
  const headers = await capabilityHeaders(baseUrl, true);
  const failed = await (await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'copilot', prompt: 'detect the stale login', dangerous: false }),
  })).json();
  assert.equal(failed.route.account, 'aaa-stale');
  assert.equal(failed.auth_failed, true);
  const healthy = await (await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'copilot', prompt: 'use the healthy login', dangerous: false }),
  })).json();
  assert.equal(healthy.exitCode, 0);
  assert.equal(healthy.route.account, 'zzz-healthy');
  const accountStatus = await (await fetch(`${baseUrl}/api/accounts`, { headers })).json();
  assert.equal(accountStatus.providers.copilot.accounts
    .find((account) => account.id === 'aaa-stale').authUnavailable, true);
  assert.equal(accountStatus.providers.copilot.accounts
    .find((account) => account.id === 'zzz-healthy').authUnavailable, false);
});

test('readiness and version probes share one diagnostic wall-clock envelope', { timeout: 10000 }, async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-bridge-parallel-diag-test-'));
  const configPath = path.join(tempRoot, 'config.json');
  const tokenPath = path.join(tempRoot, 'capability.token');
  fs.writeFileSync(configPath, JSON.stringify({
    staged_probe: {
      label: 'Parallel diagnostic fixture',
      safe: [process.execPath, '-e', ''],
      dangerous: [process.execPath, '-e', ''],
      oneshot_safe: [process.execPath, '-e', ''],
      oneshot_dangerous: [process.execPath, '-e', ''],
      diagnostic_binary: process.execPath,
      probe: [process.execPath, '-e', "setTimeout(() => process.stdout.write('authenticated'), 1500)"],
      probe_timeout_ms: 3000,
      version_probe: [process.execPath, '-e', "setTimeout(() => process.stdout.write('fixture-v1'), 1000)"],
    },
  }), 'utf8');

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const bridge = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      RELAYBRIDGE_TEST_BUILD_ID: TEST_BUILD_ID,
      PORT: String(port),
      PTY_MODE: 'none',
      RELAYBRIDGE_CONFIG_FILE: configPath,
      RELAYBRIDGE_TOKEN_FILE: tokenPath,
      RELAYBRIDGE_DATA_DIR: path.join(tempRoot, 'data'),
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (bridge.exitCode === null) bridge.kill('SIGTERM');
    await new Promise((resolve) => bridge.exitCode !== null ? resolve() : bridge.once('exit', resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  await waitForHealth(baseUrl, bridge);
  const headers = await capabilityHeaders(baseUrl);
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/diag`, { headers });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(response.status, 200);
  const diagnostics = await response.json();
  assert.equal(diagnostics.results.staged_probe.ready, true);
  assert.equal(diagnostics.results.staged_probe.runtimeVersion, 'fixture-v1');
  assert.ok(elapsedMs < 2300,
    `independent 1.5s and 1s probes ran sequentially (${elapsedMs}ms)`);
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
    // A real ollama daemon also serves GET /api/tags, which readiness probing
    // uses to tell "daemon up" from "daemon down" without shelling out to the
    // CLI. It carries no request body, so parsing one here threw.
    if (req.method === 'GET' && req.url.startsWith('/api/tags')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'fake-local:1b' }] }));
      return;
    }
    requestPayload = JSON.parse(body);
    if (requestPayload.prompt === 'upstream-500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream internal failure' }));
      return;
    }
    if (requestPayload.prompt === 'upstream-504') {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream timed out' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: { malformed: true },
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
    ollama_fast: {
      label: 'Fake local model',
      transport: 'local:ollama',
      oneshot_adapter: 'ollama_api',
      model: 'fake-local:1b',
      strip_thinking: true,
      max_output_tokens: 64,
      safe: ['ollama-cli-deliberately-absent', '--version'],
      dangerous: ['ollama-cli-deliberately-absent', '--version'],
      oneshot_safe: ['ollama-cli-deliberately-absent', '--version'],
      oneshot_dangerous: ['ollama-cli-deliberately-absent', '--version'],
      diagnostic_binary: 'ollama-cli-deliberately-absent',
    },
  }), 'utf8');

  const bridgePort = await reservePort();
  const baseUrl = `http://127.0.0.1:${bridgePort}`;
  const bridge = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      RELAYBRIDGE_TEST_BUILD_ID: TEST_BUILD_ID,
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
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  await waitForHealth(baseUrl, bridge);
  const headers = await capabilityHeaders(baseUrl, true);
  const coldPlanResponse = await fetch(`${baseUrl}/api/plan`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'ollama_fast', task: 'Summarize one short paragraph.' }),
  });
  assert.equal(coldPlanResponse.status, 200);
  const coldPlan = await coldPlanResponse.json();
  assert.equal(coldPlan.primary.kind, 'ollama_fast');
  assert.equal(coldPlan.primary.ready, true,
    'cold planning must probe the HTTP transport instead of requiring an Ollama CLI on PATH');
  const authStatus = await (await fetch(`${baseUrl}/api/auth/status?refresh=1`, { headers })).json();
  assert.equal(authStatus.signedOut.some((item) => item.kind === 'ollama_fast'), false,
    'auth refresh must not poison cached Ollama readiness with a missing CLI result');
  const cachedPlan = await (await fetch(`${baseUrl}/api/plan`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'ollama_fast', task: 'Summarize one short paragraph.' }),
  })).json();
  assert.equal(cachedPlan.primary.ready, true);

  const response = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'ollama_fast', prompt: 'test prompt', dangerous: false }),
  });
  const result = await response.json();
  assert.equal(result.stdout, 'FINAL_ONLY');
  assert.equal(result.route.prompt_transport, 'local_http');
  assert.equal(result.route.resolved_model, 'fake-local:1b');
  assert.equal(result.usage.input_tokens, 12);
  assert.equal(result.usage.output_tokens, 3);
  assert.equal(result.usage.total_tokens, 15);
  assert.equal(result.dropped_out, false);
  assert.equal(requestPayload.stream, false);
  assert.equal(requestPayload.think, false);
  assert.equal(requestPayload.options.num_predict, 64);

  const terminalBudgetResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({
      kind: 'ollama_fast', prompt: 'terminal budget', dangerous: false,
      providerBudget: { maxTotalTokens: 10 },
    }),
  });
  const terminalBudget = await terminalBudgetResponse.json();
  assert.equal(terminalBudget.failureClass, 'token_budget');
  assert.equal(terminalBudget.stop_reason, 'token_budget');
  assert.equal(terminalBudget.provider_budget_enforcement, 'terminal');
  assert.equal(terminalBudget.timed_out, false);
  assert.equal(terminalBudget.dropped_out, true);

  const ambiguousFailureResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'ollama_fast', prompt: 'upstream-500', dangerous: false }),
  });
  const ambiguousFailure = await ambiguousFailureResponse.json();
  assert.equal(ambiguousFailure.exitCode, 500);
  assert.equal(ambiguousFailure.model_invocation, null);
  const timeoutFailureResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'ollama_fast', prompt: 'upstream-504', dangerous: false }),
  });
  const timeoutFailure = await timeoutFailureResponse.json();
  assert.equal(timeoutFailure.timed_out, true);
  assert.equal(timeoutFailure.model_invocation, null);
  const receiptRows = fs.readFileSync(path.join(tempRoot, 'data', 'receipts', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8')
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const ambiguousReceipt = receiptRows.find((row) => row.receiptId === ambiguousFailure.receiptId);
  const timeoutReceipt = receiptRows.find((row) => row.receiptId === timeoutFailure.receiptId);
  assert.equal(ambiguousReceipt.tokenUsageSource, 'unknown');
  assert.equal(timeoutReceipt.status, 'timed_out');
  assert.equal(timeoutReceipt.failureClass, 'timeout');
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
      NODE_ENV: 'test',
      RELAYBRIDGE_TEST_BUILD_ID: TEST_BUILD_ID,
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
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
  assert.equal(result.model_invocation, false);
  assert.match(result.stderr, /blocked by geo\/supply-chain policy/);
  const receiptFile = path.join(tempRoot, 'data', 'receipts', `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const receipt = fs.readFileSync(receiptFile, 'utf8').trim().split(/\r?\n/)
    .map((line) => JSON.parse(line)).find((row) => row.receiptId === result.receiptId);
  assert.equal(receipt.modelInvocation, false);
  assert.equal(receipt.tokenUsageSource, 'not_invoked');
  assert.equal(receipt.actualTotalTokens, null);
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
    effort_flags: {
      minimal: ['--reasoning-effort', 'minimal'],
      low: ['--reasoning-effort', 'low'],
      medium: ['--reasoning-effort', 'medium'],
      high: ['--reasoning-effort', 'high'],
    },
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
      NODE_ENV: 'test',
      RELAYBRIDGE_TEST_BUILD_ID: TEST_BUILD_ID,
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
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

  const malformedBudgetRes = await broadcast({ prompt: 'test budget', providers: ['alpha_one'], providerBudget: { maxTurns: -5 } });
  assert.equal(malformedBudgetRes.status, 400);
  const malformedBudgetJson = await malformedBudgetRes.json();
  assert.match(malformedBudgetJson.error, /providerBudget\.maxTurns must be a positive safe integer or null/);
  const healthAfterMalformed = await (await fetch(baseUrl + '/api/health')).json();
  assert.equal(healthAfterMalformed.activeTaskCount, 0);
  assert.equal(healthAfterMalformed.activeOneShotCount, 0);


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
