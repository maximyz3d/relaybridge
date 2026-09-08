'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  extractClaudeAssistantCheckpoint,
  redactCheckpointSecrets,
  truncateUtf8Tail,
  MAX_REDACTION_SOURCE_BYTES,
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

  const fallback = extractClaudeAssistantCheckpoint([
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'safe older turn' }] } },
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'new path' }] } },
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'conflicting path' }] } },
  ]);
  assert.equal(fallback.text, 'safe older turn');
  assert.equal(fallback.selectionReason, 'latest_assistant_conflicted_using_previous');
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
    'AWS_SECRET_ACCESS_KEY=aws-secret-value',
    'AKIAIOSFODNN7EXAMPLE',
    'xoxb-12345678901234567890',
  ].join('\n');
  const cleaned = redactCheckpointSecrets(raw);
  assert.doesNotMatch(cleaned, /thisisaverylongsecret|bridge-secret-value|hunter2|abcdefghijklmnopqrstuvwxyz|aws-secret-value|AKIA|xoxb/);
  assert.match(cleaned, /\[REDACTED/);
});

test('complete-source redaction is bounded and precedes checkpoint tail truncation', () => {
  const checkpoint = extractClaudeAssistantCheckpoint([{
    type: 'assistant',
    message: { id: 'large', content: [{ type: 'text', text: `${'x'.repeat(2_000_000)}\napi_key=tail-secret` }] },
  }], 1024);
  assert.ok(checkpoint.bytes <= 1024);
  assert.equal(checkpoint.truncated, true);
  assert.ok(checkpoint.originalBytes > 2_000_000);
  assert.doesNotMatch(checkpoint.text, /tail-secret/);
});

test('private-key redaction preserves safe prose before any tail truncation', () => {
  const syntheticKeyBody = 'SYNTHETICKEYMATERIAL'.repeat(4000);
  const checkpoint = extractClaudeAssistantCheckpoint([{
    type: 'assistant',
    message: { id: 'bounded-key', content: [{ type: 'text', text: [
      'safe prefix',
      '-----BEGIN TEST PRIVATE KEY-----',
      syntheticKeyBody,
      '-----END TEST PRIVATE KEY-----',
      'safe suffix',
    ].join('\n') }] },
  }], 1024);

  assert.equal(checkpoint.truncated, false, 'redaction made the complete sanitized text fit; no tail was discarded');
  assert.equal(checkpoint.text, 'safe prefix\n[REDACTED_PRIVATE_KEY]\nsafe suffix');
  assert.doesNotMatch(checkpoint.text, /SYNTHETICKEYMATERIAL|BEGIN TEST PRIVATE KEY|END TEST PRIVATE KEY/);
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

test('credentials crossing the former 48KB redaction boundary never expose a suffix', () => {
  for (const text of [
    `password="${'SYNTHETIC_SECRET_'.repeat(5000)}"\nsafe suffix`,
    `Authorization: Bearer ${'SYNTHETIC_SECRET_'.repeat(5000)}\nsafe suffix`,
    `{"api_key":"${'SYNTHETIC_SECRET_'.repeat(5000)}"}\nsafe suffix`,
    `password="${'SYNTHETIC_SECRET_'.repeat(5000)}`,
  ]) {
    const checkpoint = extractClaudeAssistantCheckpoint([{ type: 'assistant',
      message: { id: 'boundary', content: [{ type: 'text', text }] } }], 1024);
    assert.doesNotMatch(checkpoint.text, /SYNTHETIC_SECRET/);
    assert.match(checkpoint.text, /REDACTED/);
    assert.ok(checkpoint.bytes <= 1024);
  }
});

test('oversized redaction input fails closed with explicit provenance', () => {
  const text = 'SYNTHETIC_SECRET_'.repeat(150000);
  const event = { type: 'assistant', message: { id: 'too-large', content: [{ type: 'text', text }] } };
  const checkpoint = extractClaudeAssistantCheckpoint([event]);
  assert.equal(checkpoint.text, '');
  assert.equal(checkpoint.unavailableReason, 'redaction_input_limit');
  assert.equal(checkpoint.originalBytes, Buffer.byteLength(text));
  assert.equal(checkpoint.truncated, true);
  const fallback = extractClaudeAssistantCheckpoint([{ type: 'assistant', message: {
    id: 'earlier', content: [{ type: 'text', text: 'safe older checkpoint' }] } }, event]);
  assert.equal(fallback.text, 'safe older checkpoint');
  assert.equal(fallback.selectionReason, 'latest_assistant_unavailable_using_previous');
});

test('a recovered same-ID block clears obsolete redaction-limit provenance', () => {
  const event = (text) => ({ type: 'assistant', message: {
    id: 'recovered', content: [{ type: 'text', text }],
  } });
  const events = [event('x'.repeat(MAX_REDACTION_SOURCE_BYTES + 1)), event('valid')];
  const recovered = extractClaudeAssistantCheckpoint(events);
  assert.equal(recovered.text, 'valid');
  assert.equal(recovered.originalBytes, 5);
  assert.equal(recovered.truncated, false);
  assert.equal(recovered.unavailableReason, null);
  const conflicted = extractClaudeAssistantCheckpoint([...events, event('different')]);
  assert.equal(conflicted.text, '');
  assert.equal(conflicted.unavailableReason, 'no_complete_assistant_text');
  assert.equal(conflicted.originalBytes, 0);
  assert.equal(conflicted.truncated, false);
});
