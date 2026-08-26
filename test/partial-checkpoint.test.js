'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  extractClaudeAssistantCheckpoint,
  redactCheckpointSecrets,
  truncateUtf8Tail,
} = require('../lib/partial-checkpoint');

test('latest complete Claude assistant text becomes a bounded sanitized checkpoint', () => {
  const events = [
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'early checkpoint' }] } },
    { type: 'assistant', message: { id: 'm2', content: [
      { type: 'thinking', thinking: 'THINKING_MUST_NOT_ESCAPE' },
      { type: 'tool_use', name: 'Bash', input: { command: 'TOOL_ARG_MUST_NOT_ESCAPE' } },
      { type: 'text', text: 'latest Authorization: Bearer super-secret\nresult ready' },
    ] } },
  ];
  const checkpoint = extractClaudeAssistantCheckpoint(events, 4096);
  assert.equal(checkpoint.eventType, 'assistant');
  assert.equal(checkpoint.text, 'latest Authorization: Bearer [REDACTED]\nresult ready');
  assert.equal(checkpoint.bytes, Buffer.byteLength(checkpoint.text));
  assert.equal(checkpoint.sha256, crypto.createHash('sha256').update(checkpoint.text).digest('hex'));
  assert.equal(checkpoint.truncated, false);
  assert.equal(checkpoint.unavailableReason, null);
  assert.doesNotMatch(checkpoint.text, /THINKING_MUST_NOT_ESCAPE|TOOL_ARG_MUST_NOT_ESCAPE|super-secret/);
});

test('duplicate partial assistant messages must extend monotonically or fail closed', () => {
  const monotonic = extractClaudeAssistantCheckpoint([
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'first' }] } },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'first complete' }] } },
  ]);
  assert.equal(monotonic.text, 'first complete');

  const conflicted = extractClaudeAssistantCheckpoint([
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'one path' }] } },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'different path' }] } },
  ]);
  assert.equal(conflicted.text, '');
  assert.equal(conflicted.unavailableReason, 'no_complete_assistant_text');
});

test('checkpoint truncation is byte bounded and retains valid UTF-8 tail', () => {
  const bounded = truncateUtf8Tail(`HEAD_${'😀'.repeat(20)}_TAIL`, 25);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.bytes <= 25);
  assert.equal(bounded.originalBytes, Buffer.byteLength(`HEAD_${'😀'.repeat(20)}_TAIL`));
  assert.match(bounded.text, /_TAIL$/);
  assert.doesNotMatch(bounded.text, /�/);
});

test('credential-shaped assistant prose is redacted without exposing values', () => {
  const raw = [
    'api_key=sk-ant-thisisaverylongsecret',
    'X-RelayBridge-Token: bridge-secret-value',
    'password="hunter2"',
    'github_pat_abcdefghijklmnopqrstuvwxyz123456',
  ].join('\n');
  const cleaned = redactCheckpointSecrets(raw);
  assert.doesNotMatch(cleaned, /thisisaverylongsecret|bridge-secret-value|hunter2|abcdefghijklmnopqrstuvwxyz/);
  assert.match(cleaned, /\[REDACTED/);
});

test('no assistant text yields explicit unavailable metadata', () => {
  const checkpoint = extractClaudeAssistantCheckpoint([
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', input: { secret: 'nope' } }] } },
    { type: 'system', subtype: 'api_retry' },
  ]);
  assert.deepEqual(
    { text: checkpoint.text, eventType: checkpoint.eventType, bytes: checkpoint.bytes, reason: checkpoint.unavailableReason },
    { text: '', eventType: null, bytes: 0, reason: 'no_complete_assistant_text' },
  );
});
