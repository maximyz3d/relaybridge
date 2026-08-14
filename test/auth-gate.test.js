'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'cli-config.json'), 'utf8'));
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

test('every subscription CLI declares an interactive login command', () => {
  // These authenticate through a browser or device flow; without a login_command
  // the UI can only tell the user to fix it themselves in a terminal.
  for (const kind of ['claude', 'claude_fable', 'codex', 'cursor', 'copilot', 'gemini', 'grok']) {
    assert.ok(Array.isArray(config[kind].login_command) && config[kind].login_command.length,
      `${kind} needs a login_command`);
  }
});

test('login commands never carry dangerous or permission-bypass flags', () => {
  // Signing in must not also grant filesystem authority.
  const banned = /--dangerously|--yolo|--force|skip-permissions|dontAsk/i;
  for (const [kind, entry] of Object.entries(config)) {
    if (kind.startsWith('_') || !entry || !Array.isArray(entry.login_command)) continue;
    for (const arg of entry.login_command) {
      assert.ok(!banned.test(String(arg)), `${kind} login_command must not include ${arg}`);
    }
  }
});

test('a signed-out provider is reported as auth_required rather than being called', () => {
  // The pre-flight gate must return 409 with an actionable payload, so no
  // prompt (and no quota) is spent on a call that cannot succeed.
  assert.match(serverSource, /auth_required: true/, 'executeOneShot must signal auth_required');
  assert.match(serverSource, /res\.status\(409\)/, 'the gate must use 409, not a generic failure');
  assert.match(serverSource, /readiness\.found && readiness\.ready === false/,
    'only a positive signed-out observation may block a call');
});

test('an unprobed provider is still attempted', () => {
  // "No readiness data" must not be treated as "signed out", or a provider that
  // was never probed would be permanently unreachable.
  const gate = serverSource.slice(serverSource.indexOf('const readiness = lastDiagnostics'));
  assert.match(gate.slice(0, 400), /if \(readiness &&/, 'the gate must require a readiness record');
});

test('sign-in sessions run the login command and are never dangerous', () => {
  assert.match(serverSource, /opts\.mode === 'login'/, 'sessions need a login mode');
  const start = serverSource.indexOf("opts.mode === 'login'");
  const loginBlock = serverSource.slice(start, serverSource.indexOf('return loginSession;', start));
  assert.ok(loginBlock.length > 0 && !/useDanger/.test(loginBlock),
    'the login path must not consult the dangerous toggle');
  assert.match(loginBlock, /login_command/, 'the login path must run the configured login command');
});

test('auth status endpoint exists and does not probe on every poll', () => {
  assert.match(serverSource, /app\.get\('\/api\/auth\/status'/);
  assert.match(serverSource, /req\.query\.refresh === '1' \|\| !diagnostics/,
    'a readiness sweep spawns a process per provider and must be opt-in');
});

test('probe timeouts always resolve so readiness cannot wedge', () => {
  // Killing the tree is not a guarantee of an exit event; a pending probe would
  // hang readiness checks and model discovery forever.
  assert.match(serverSource, /probe timed out and did not exit/);
});
