'use strict';

// Read-only, bounded lookup of bridge receipt metadata for explicitly attached
// call references. Only the configured receipts directory and its dated JSONL
// journals are read; no result bodies exist here and none are fabricated.
const fs = require('node:fs');
const path = require('node:path');

const FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const REFS = ['requestIds', 'receiptIds', 'runIds', 'taskIds'];
const ROW_FIELD = { requestIds: 'requestId', receiptIds: 'receiptId', runIds: 'runId', taskIds: 'taskId' };
const STRING_FIELDS = ['receiptId', 'timestamp', 'event', 'status', 'provider', 'inputHash', 'outputHash', 'requestId',
  'invocationId', 'attemptId', 'runId', 'outerReceiptId', 'taskId', 'resultHash', 'failureClass', 'stopReason',
  'supervisorStopReason', 'providerTerminalReason', 'providerStopReason', 'providerReceiptId', 'providerRunId',
  'deliveryEvidence', 'tokenUsageSource'];
const NUMBER_FIELDS = ['inputChars', 'outputChars', 'durationMs', 'resultBytes', 'providerPermissionDenialCount',
  'physicalAttemptCount', 'partialCheckpointBytes', 'httpStatus'];
const BOOLEAN_FIELDS = ['partialResult', 'partialCheckpointTruncated', 'complete', 'partial', 'resultPersisted',
  'resultDelivered', 'providerCompleted', 'modelInvocation'];
const ROUTE_FIELDS = ['requested_model', 'applied_effort', 'resolved_model_tier', 'request_id', 'run_id'];

function pick(row) {
  const out = {};
  for (const key of STRING_FIELDS) if (typeof row[key] === 'string') out[key] = row[key].slice(0, 300);
  for (const key of NUMBER_FIELDS) if (Number.isFinite(row[key])) out[key] = row[key];
  for (const key of BOOLEAN_FIELDS) if (typeof row[key] === 'boolean') out[key] = row[key];
  if (row.route && typeof row.route === 'object') {
    const route = {};
    for (const key of ROUTE_FIELDS) if (typeof row.route[key] === 'string') route[key] = row.route[key].slice(0, 200);
    if (Object.keys(route).length) out.route = route;
  }
  return out;
}

function createReceiptLookup({ maxFiles = 45, maxFileBytes = 64 * 1024 * 1024, maxTotalBytes = 256 * 1024 * 1024,
  maxMatches = 200, cacheFiles = 90, cacheTokens = 2000 } = {}) {
  // Journals are append-only. Each file keeps, per quoted reference token, the
  // matching rows found before its last complete line; later scans read only
  // appended bytes, or the already-covered prefix for newly attached tokens.
  const cache = new Map();
  function readRange(file, start, end) {
    const buffer = Buffer.alloc(end - start);
    const handle = fs.openSync(file, 'r');
    let read = 0;
    try {
      while (read < buffer.length) {
        const n = fs.readSync(handle, buffer, read, buffer.length - read, start + read);
        if (!n) break;
        read += n;
      }
    } finally { fs.closeSync(handle); }
    return buffer.subarray(0, read);
  }
  function collect(view, base, limit, tokens, entry) {
    for (const token of tokens) {
      const rows = entry.byToken.get(token) || [];
      const needle = Buffer.from(token);
      let at = view.indexOf(needle, 0);
      while (at !== -1 && at < limit) {
        const start = view.lastIndexOf(10, at) + 1, end = view.indexOf(10, at);
        try {
          const row = JSON.parse(view.subarray(start, end).toString('utf8'));
          if (row && typeof row === 'object' && !Array.isArray(row)) rows.push({ ...pick(row), _offset: base + start });
        } catch { /* malformed journal lines are not evidence */ }
        at = view.indexOf(needle, end + 1);
      }
      entry.byToken.set(token, rows);
    }
  }
  function scanFile(file, tokens, stat, budget) {
    let entry = cache.get(file);
    if (!entry || entry.ino !== stat.ino || entry.dev !== stat.dev || stat.size < entry.offset || entry.byToken.size > cacheTokens) {
      entry = { ino: stat.ino, dev: stat.dev, offset: 0, byToken: new Map() };
    }
    const missing = tokens.filter((token) => !entry.byToken.has(token));
    const pending = (missing.length ? entry.offset : 0) + stat.size - entry.offset;
    if (pending > budget) return null;
    let bytesRead = 0;
    if (missing.length && entry.offset > 0) {
      const prefix = readRange(file, 0, entry.offset);
      bytesRead += prefix.length;
      collect(prefix, 0, prefix.length, missing, entry);
    } else for (const token of missing) entry.byToken.set(token, []);
    if (stat.size > entry.offset) {
      const appended = readRange(file, entry.offset, stat.size);
      bytesRead += appended.length;
      const complete = appended.lastIndexOf(10) + 1; // An in-progress final line is retried later.
      collect(appended, entry.offset, complete, [...entry.byToken.keys()], entry);
      entry.offset += complete;
    }
    cache.delete(file); cache.set(file, entry);
    while (cache.size > cacheFiles) cache.delete(cache.keys().next().value);
    return { rows: tokens.flatMap((token) => entry.byToken.get(token)), bytesRead };
  }
  function find(receiptsDir, refs = {}) {
    const wanted = Object.fromEntries(REFS.map((name) => [name, [...new Set((refs[name] || [])
      .filter((value) => typeof value === 'string' && value.length > 0 && value.length <= 200))]]));
    const scan = { configured: typeof receiptsDir === 'string' && receiptsDir.length > 0, filesAvailable: 0, filesScanned: 0,
      filesSkipped: 0, olderFilesNotScanned: 0, limited: false, error: null };
    const tokens = [...new Set(REFS.flatMap((name) => wanted[name]).map((value) => JSON.stringify(value)))];
    if (!scan.configured || !tokens.length) return { receipts: [], scan };
    let names;
    try { names = fs.readdirSync(receiptsDir).filter((name) => FILE.test(name)).sort().reverse(); }
    catch (error) {
      if (error.code === 'ENOENT') return { receipts: [], scan };
      return { receipts: [], scan: { ...scan, limited: true, error: 'receipts_unreadable' } };
    }
    scan.filesAvailable = names.length;
    scan.olderFilesNotScanned = Math.max(0, names.length - maxFiles);
    if (scan.olderFilesNotScanned) scan.limited = true;
    const receipts = [], seen = new Set();
    let total = 0;
    for (const name of names.slice(0, maxFiles)) {
      const file = path.join(receiptsDir, name);
      let result = null;
      try {
        const stat = fs.lstatSync(file);
        if (stat.isFile() && stat.size <= maxFileBytes) result = scanFile(file, tokens, stat, maxTotalBytes - total);
      } catch { result = null; }
      if (!result) { scan.filesSkipped++; scan.limited = true; continue; }
      total += result.bytesRead; scan.filesScanned++;
      for (const { _offset, ...row } of result.rows) {
        if (seen.has(`${name}:${_offset}`) || !REFS.some((ref) => wanted[ref].includes(row[ROW_FIELD[ref]]))) continue;
        seen.add(`${name}:${_offset}`); receipts.push(row);
      }
    }
    receipts.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
    if (receipts.length > maxMatches) scan.limited = true;
    return { receipts: receipts.slice(0, maxMatches), scan };
  }
  return { find };
}

module.exports = { createReceiptLookup };
