'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

test('MCP preserves bounded checkpoint reserve metadata and omits secret path hashes', async () => {
  const { sanitizeProviderResponse } = await import('../mcp/server.mjs');
  const checkpoint = 'final checkpoint';
  const sanitized = sanitizeProviderResponse({
    partial_result: true,
    partial_checkpoint: checkpoint,
    partial_checkpoint_original_bytes: Buffer.byteLength(checkpoint),
    partial_checkpoint_hash: crypto.createHash('sha256').update(checkpoint).digest('hex'),
    partial_checkpoint_event_type: 'assistant',
    graceful_finalization: {
      supported: true,
      requested: true,
      sent: true,
      method: 'claude_stream_json_user_message',
      reserve: {
        budgetField: 'maxTotalTokens', usageField: 'total_tokens',
        observed: 900, threshold: 900, limit: 1000, reserve: 100,
      },
    },
    writer_diff_summary: {
      available: true,
      changedFileCount: 1,
      files: [{ path: '.env', pathHash: 'a'.repeat(64), sensitivePath: true }],
      fingerprintsTruncated: true,
    },
  });

  assert.equal(sanitized.partialCheckpoint, checkpoint);
  assert.equal(sanitized.partialCheckpointBytes, Buffer.byteLength(checkpoint));
  assert.equal(sanitized.gracefulFinalization.reserve.budgetField, 'maxTotalTokens');
  assert.equal(sanitized.gracefulFinalization.reserve.threshold, 900);
  assert.equal(sanitized.writerDiffSummary.files[0].path, '[redacted-sensitive-path]');
  assert.equal(sanitized.writerDiffSummary.files[0].pathHash, null);
  assert.equal(sanitized.writerDiffSummary.fingerprintsTruncated, true);
});

test('MCP gates checkpoint metadata when the response is not explicitly partial', async () => {
  const { sanitizeProviderResponse } = await import('../mcp/server.mjs');
  const sanitized = sanitizeProviderResponse({
    partial_result: false,
    partial_checkpoint: 'must not survive',
    partial_checkpoint_hash: 'b'.repeat(64),
    partial_checkpoint_event_type: 'assistant',
  });
  assert.equal(sanitized.partialCheckpoint, '');
  assert.equal(sanitized.partialCheckpointBytes, 0);
  assert.equal(sanitized.partialCheckpointSha256, null);
  assert.equal(sanitized.partialCheckpointEventType, null);
});
