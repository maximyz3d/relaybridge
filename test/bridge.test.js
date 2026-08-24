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
  assert.deepEqual(config._config_merge.managed_provider_args, {
    claude: {
      slots: ['safe', 'dangerous', 'oneshot_safe', 'oneshot_dangerous'],
      args: [{ flag: '--effort', value_count: 1 }],
    },
    claude_fable: {
      slots: ['safe', 'dangerous', 'oneshot_safe', 'oneshot_dangerous'],
      args: [{ flag: '--effort', value_count: 1 }],
    },
  });
  assert.equal(config.claude.safe[config.claude.safe.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(config.claude.oneshot_safe[config.claude.oneshot_safe.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(config.claude.oneshot_safe[config.claude.oneshot_safe.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(config.claude.oneshot_safe.includes('--include-partial-messages'));
  assert.equal(config.claude.oneshot_output_parser, 'claude_json');
  assert.deepEqual(config.claude.probe, ['claude', 'auth', 'status']);
  assert.ok(config.claude.strip_env.includes('ANTHROPIC_API_KEY'));
  assert.equal(config.claude.safe[config.claude.safe.indexOf('--model') + 1], 'opus');
  assert.equal(config.claude.quota_seat, 'subscription:anthropic:default');
  assert.equal(config.claude_fable.safe[config.claude_fable.safe.indexOf('--model') + 1], 'fable');
  assert.equal(config.claude_fable.safe[config.claude_fable.safe.indexOf('--effort') + 1], 'high');
  assert.equal(config.claude_fable.oneshot_safe[config.claude_fable.oneshot_safe.indexOf('--effort') + 1], 'high');
  for (const kind of ['claude', 'claude_fable']) {
    for (const slot of ['safe', 'dangerous', 'oneshot_safe', 'oneshot_dangerous']) {
      assert.notEqual(config[kind][slot][config[kind][slot].indexOf('--effort') + 1], 'max',
        `${kind}.${slot} must not infer maximum effort`);
    }
  }
  assert.equal(config.claude_fable.oneshot_safe[config.claude_fable.oneshot_safe.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(config.claude_fable.oneshot_safe.includes('--include-partial-messages'));
  assert.equal(config.claude_fable.oneshot_output_parser, 'claude_json');
  assert.equal(config.claude_fable.model, 'claude-fable-5');
  assert.equal(config.claude_fable.quota_seat, config.claude.quota_seat);
  assert.deepEqual(config.claude_fable.probe, ['claude', 'auth', 'status']);
  assert.ok(config.claude_fable.strip_env.includes('ANTHROPIC_API_KEY'));
  assert.equal(config.codex.safe[config.codex.safe.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(config.codex.oneshot_safe[config.codex.oneshot_safe.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(config.codex.oneshot_safe.includes('--ephemeral'));
  assert.deepEqual(config.codex.probe, ['codex', 'login', 'status']);
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
      diagnostics: {
        grok: { found: true, ready: true },
        echo: { found: true, ready: true },
      },
    }),
  });
  assert.equal(routeResponse.status, 200);
  const routeResult = await routeResponse.json();
  assert.ok(routeResult.fleetState.cooldownSkipped.includes('grok'));
  assert.equal(routeResult.fleetState.vendorQuota.grok.actual, 552305);

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
  const cancellationLedger = fs.readFileSync(path.join(tempRoot, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const cancelledReceipts = cancellationLedger.filter((row) => row.provider === 'slow' && row.status === 'cancelled');
  assert.equal(cancelledReceipts.length, 1, 'client disconnect writes exactly one terminal receipt');
  const cancelledReceipt = cancelledReceipts[0];
  assert.ok(cancelledReceipt, 'client disconnect must persist a terminal provider receipt');
  assert.equal(cancelledReceipt.failureClass, 'cancelled');
  assert.equal(cancelledReceipt.modelInvocation, true);
  assert.equal(cancelledReceipt.tokenUsageSource, 'chars_div_4');

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
  assert.equal(retryHangReceipt.tokenEstimateScope, 'request_chars_only');
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
  assert.equal(result.usage.total_tokens, 15);
  assert.equal(result.dropped_out, false);
  assert.equal(requestPayload.stream, false);
  assert.equal(requestPayload.think, false);
  assert.equal(requestPayload.options.num_predict, 64);

  const terminalBudgetResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({
      kind: 'local', prompt: 'terminal budget', dangerous: false,
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
    body: JSON.stringify({ kind: 'local', prompt: 'upstream-500', dangerous: false }),
  });
  const ambiguousFailure = await ambiguousFailureResponse.json();
  assert.equal(ambiguousFailure.exitCode, 500);
  assert.equal(ambiguousFailure.model_invocation, null);
  const timeoutFailureResponse = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'local', prompt: 'upstream-504', dangerous: false }),
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
