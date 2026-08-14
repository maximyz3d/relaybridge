'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
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
  assert.ok(!/Set-Content .* -Value \$block\b(?![\s\S]*existing)/.test(installer),
    'the installer must not clobber a file that already has user content');
});
