'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

test('MCP preserves safe descendant observations and finite native limits', async () => {
  const { sanitizeProviderResponse } = await import('../mcp/server.mjs');
  const { projectCensus } = require('../lib/process-census');
  const census = projectCensus(7, { rows: [{ pid: 7, ppid: 1, birth: 'fixture', cpuMs: 10, command: 'private command' }] }, 1000);
  census.processes[0].rawCommand = 'SECRET';
  const result = sanitizeProviderResponse({ kind: 'fixture', failureClass: 'child_fanout', process_census: census,
    process_warnings: ['child_fanout', 'private command'], native_transport: { finite: true, renewable: false,
      remainingMs: 20000, checkpointNeeded: true, stopNeeded: true } });
  assert.equal(result.failureClass, 'child_fanout');
  assert.equal(result.processCensus.terminationEvidence, false);
  assert.equal(result.processCensus.processes[0].rawCommand, undefined);
  assert.deepEqual(result.processWarnings, ['child_fanout']);
  assert.equal(result.nativeTransport.remainingMs, 20000);
  assert.equal(sanitizeProviderResponse({ process_census: { ...census, terminationEvidence: true } }).processCensus, null);
});

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

test('writer hashes must be scalar strings and incomplete counts stay unknown', async () => {
  const { sanitizeProviderResponse } = await import('../mcp/server.mjs');
  const summary = sanitizeProviderResponse({ writer_diff_summary: {
    available: true, beforeHead: ['a'.repeat(40)], afterHead: ['b'.repeat(40)],
    statusHash: ['c'.repeat(64)], changedFileCount: null, changedFileCountLowerBound: 2,
    unverifiedFileCount: 30, changeCountComplete: false,
    files: [{ path: 'file.txt', pathHash: ['d'.repeat(64)] }],
  } }).writerDiffSummary;
  assert.equal(summary.beforeHead, null);
  assert.equal(summary.afterHead, null);
  assert.equal(summary.statusHash, null);
  assert.equal(summary.files[0].pathHash, null);
  assert.equal(summary.changedFileCount, null);
  assert.equal(summary.changedFileCountLowerBound, 2);
  assert.equal(summary.unverifiedFileCount, 30);
  assert.equal(summary.changeCountComplete, false);
});
