'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../cli-config.json');

function value(args, flag) {
  assert.equal(args.filter((arg) => arg === flag).length, 1, `${flag} must occur once`);
  return args[args.indexOf(flag) + 1];
}

for (const kind of ['claude', 'claude_fable']) {
  test(`${kind} headless reads avoid Plan Mode without granting writer tools`, () => {
    const entry = config[kind];
    const args = entry.oneshot_safe;
    assert.equal(value(args, '--permission-mode'), 'dontAsk');
    assert.deepEqual(value(args, '--tools').split(','), ['Read', 'Glob', 'Grep']);
    assert.deepEqual(value(args, '--allowedTools').split(','), ['Read', 'Glob', 'Grep']);
    for (const flag of ['-p', '--safe-mode', '--restricted', '--strict-mcp-config', '--no-session-persistence']) {
      assert.ok(args.includes(flag), `${kind} retains ${flag}`);
    }
    assert.deepEqual(JSON.parse(value(args, '--mcp-config')), { mcpServers: {} });
    assert.equal(value(args, '--input-format'), 'stream-json');
    assert.equal(value(args, '--output-format'), 'stream-json');
    assert.equal(value(args, '--autocompact'), '150k');
    for (const forbidden of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions',
      '--add-dir', '--continue', '--resume', '--settings', '--append-system-prompt', '--system-prompt']) {
      assert.equal(args.includes(forbidden), false, `${kind} must not add ${forbidden}`);
    }
    assert.equal(entry.oneshot_safe_filesystem_policy, 'read_only_enforced');
    assert.equal(value(entry.safe, '--permission-mode'), 'plan', 'interactive profile is not changed');
    assert.ok(entry.strip_env.includes('ANTHROPIC_API_KEY'));
    assert.ok(entry.strip_env.includes('CLAUDE_CODE_OAUTH_TOKEN'));
  });
}

test('headless change preserves model, effort, shared seat and separate writer profiles', () => {
  assert.equal(value(config.claude.oneshot_safe, '--model'), 'sonnet');
  assert.equal(value(config.claude.oneshot_safe, '--effort'), 'medium');
  assert.equal(value(config.claude_fable.oneshot_safe, '--model'), 'fable');
  assert.equal(value(config.claude_fable.oneshot_safe, '--effort'), 'high');
  assert.equal(config.claude.quota_seat, config.claude_fable.quota_seat);
  assert.deepEqual(config.claude_fable.dangerous, []);
  assert.deepEqual(config.claude_fable.oneshot_dangerous, []);
  for (const slot of ['dangerous', 'oneshot_dangerous']) {
    assert.equal(config.claude[slot].includes('dontAsk'), false);
    assert.ok(value(config.claude[slot], '--tools').split(',').includes('Write'));
  }
});
