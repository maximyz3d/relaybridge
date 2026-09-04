'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('fs');
const os = require('node:os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const primer = fs.readFileSync(path.join(ROOT, 'skills', 'relaybridge', 'PRIMER.md'), 'utf8');
const installer = fs.readFileSync(path.join(ROOT, 'install-skill.ps1'), 'utf8');

test('the primer stays short enough to load every session', () => {
  // Always-loaded context costs tokens on every turn. If this grows, move the
  // detail into SKILL.md rather than raising the limit.
  const words = primer.split(/\s+/).filter(Boolean).length;
  assert.ok(words < 700, `primer is ${words} words; keep it under 700 and push detail into SKILL.md`);
});

test('the primer carries the rules that must never be forgotten', () => {
  assert.match(primer, /127\.0\.0\.1:8787/, 'agents need the endpoint');
  assert.match(primer, /X-RelayBridge-Token/, 'agents need the auth header');
  assert.match(primer, /Never send `timeoutMs`/, 'sending timeoutMs reinstates the guillotine');
  assert.match(primer, /loop_detected/, 'resubmitting a looping prompt wastes tokens');
  assert.match(primer, /409 auth_required/, 'agents must know what a signed-out provider looks like');
  assert.match(primer, /human gate/, 'high-stakes work must not be auto-executed');
});

test('the primer routes cheap work away from frontier models', () => {
  for (const kind of ['powershell', 'ollama_fast', 'ollama_coder', 'copilot', 'claude', 'codex']) {
    assert.ok(primer.includes(kind), `primer should name ${kind} in the routing ladder`);
  }
  assert.match(primer, /api\/route/, 'agents should ask the bridge rather than guess');
});

test('the primer points at the full reference instead of inlining it', () => {
  assert.match(primer, /SKILL\.md/);
  assert.match(primer, /reference\.md/);
});

test('the primer lists the MCP tools so registered agents prefer them', () => {
  for (const tool of ['bridge_status', 'route_preview', 'list_models', 'list_active_runs', 'bridge_activity']) {
    assert.ok(primer.includes(tool), `primer should name the ${tool} MCP tool`);
  }
});

test('the installer writes into every agent memory file, not just the skill folder', () => {
  // A skill is read on demand; memory files load every session. Both are needed.
  for (const target of ['.claude\\CLAUDE.md', '.codex\\AGENTS.md', '.gemini\\GEMINI.md', '.cursor\\rules\\relaybridge.mdc']) {
    assert.ok(installer.includes(target), `installer should write ${target}`);
  }
});

test('the installer is idempotent and preserves user-authored instructions', () => {
  assert.match(installer, /BEGIN relaybridge-primer/, 'blocks need markers to be replaceable');
  assert.match(installer, /regex\]::Replace/, 'a second run must refresh in place, never duplicate');
  assert.match(installer, /\[IO\.File\]::ReadAllText\(\$File, \[Text\.UTF8Encoding\]::new\(\$false\)\)/,
    'memory files must use an explicit UTF-8 read that also preserves empty files as empty strings');
  assert.ok(!/Set-Content .* -Value \$block\b(?![\s\S]*existing)/.test(installer),
    'the installer must not clobber a file that already has user content');
});

test('the skill installer resolves its bundled source independently of caller cwd', {
  skip: process.platform !== 'win32',
}, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-skill-cwd-'));
  try {
    const callerCwd = path.join(tempRoot, 'unrelated-cwd');
    const profile = path.join(tempRoot, 'profile');
    fs.mkdirSync(callerCwd, { recursive: true });
    fs.mkdirSync(profile, { recursive: true });
    const result = childProcess.spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(ROOT, 'install-skill.ps1'),
    ], {
      cwd: callerCwd,
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: profile },
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    for (const installed of [
      path.join(profile, '.claude', 'skills', 'relaybridge', 'SKILL.md'),
      path.join(profile, '.codex', 'relaybridge', 'SKILL.md'),
      path.join(profile, '.codex', 'AGENTS.md'),
    ]) {
      assert.ok(fs.existsSync(installed), `expected installed RelayBridge file ${installed}`);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('the client restart script force-stops survivors rather than trusting a window close', () => {
  // Electron apps leave tray/GPU/renderer helpers running after the window
  // closes, and those survivors hold the OLD mcp config in memory. Closing
  // alone therefore does not reload anything.
  const script = fs.readFileSync(path.join(ROOT, 'restart-ai-clients.ps1'), 'utf8');
  assert.match(script, /CloseMainWindow/, 'ask nicely first so unsaved-work prompts appear');
  assert.match(script, /Stop-Process -Id \$p\.Id -Force/, 'then force whatever survived');
  assert.match(script, /\$exe = /, 'the exe path must be captured before killing, or relaunch is impossible');
});

test('the restart script never force-kills by wildcard', () => {
  // This script force-terminates; matching "Code*" or "Claude*" could take out
  // unrelated processes.
  const script = fs.readFileSync(path.join(ROOT, 'restart-ai-clients.ps1'), 'utf8');
  assert.ok(!/Get-Process -Name .*\*/.test(script), 'exact process names only');
  for (const name of ['Claude', 'Cursor', 'Antigravity']) {
    assert.ok(script.includes(`'${name}'`), `${name} should be listed explicitly`);
  }
});

test('the restart script excludes the native Claude Code CLI from Desktop restarts', () => {
  const script = fs.readFileSync(path.join(ROOT, 'restart-ai-clients.ps1'), 'utf8');
  assert.match(script, /ExcludePathPattern/);
  assert.match(script, /ExcludePathPattern = .*\.local.*bin.*claude/);
  assert.match(script, /Get-ClientProcesses/, 'every process refresh must retain the exclusion');
});

test('the restart script leaves the bridge and browsers alone', () => {
  const script = fs.readFileSync(path.join(ROOT, 'restart-ai-clients.ps1'), 'utf8');
  for (const forbidden of ["'node'", "'chrome'", "'powershell'", "'msedge'"]) {
    assert.ok(!script.includes(forbidden), `must not target ${forbidden} — that would kill the bridge or the UI`);
  }
});
