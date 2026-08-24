import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import receiptStoreIdentityModule from '../lib/receipt-store-identity.cjs';

const { receiptStoreIdentity } = receiptStoreIdentityModule;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
function envFirst(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && String(value).trim() !== '') return value;
  }
  return '';
}

const DATA_DIR = path.resolve(envFirst('RELAYBRIDGE_DATA_DIR', 'PS_BRIDGE_DATA_DIR') || path.join(ROOT, 'data'));
const RECEIPTS_DIR = path.join(DATA_DIR, 'receipts');
const RUNS_DIR = path.join(DATA_DIR, 'runs');
const CACHE_DIR = path.join(DATA_DIR, 'cache');

for (const dir of [RECEIPTS_DIR, RUNS_DIR, CACHE_DIR]) fs.mkdirSync(dir, { recursive: true });
const RECEIPT_STORE_IDENTITY = receiptStoreIdentity(DATA_DIR);

function dateToken(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function writeJsonAtomic(filePath, record) {
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  let handle = null;
  try {
    handle = fs.openSync(tempPath, 'wx');
    fs.writeFileSync(handle, JSON.stringify(record, null, 2), 'utf8');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(tempPath, filePath);
  } finally {
    if (handle !== null) try { fs.closeSync(handle); } catch {}
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
  }
}

export function stableHash(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function appendReceipt(event) {
  const receipt = {
    receiptId: event.receiptId || `rcpt_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
    timestamp: event.timestamp || new Date().toISOString(),
    ...event,
    receiptStoreId: RECEIPT_STORE_IDENTITY.id,
  };
  const filePath = path.join(RECEIPTS_DIR, `${dateToken(new Date(receipt.timestamp))}.jsonl`);
  const handle = fs.openSync(filePath, 'a');
  try {
    fs.writeFileSync(handle, `${JSON.stringify(receipt)}\n`, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  return receipt;
}

function receiptFiles() {
  return fs.readdirSync(RECEIPTS_DIR)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
    .reverse();
}

// A requested limit of 0 means "none". `Number(0) || fallback` would silently
// return the fallback page instead, so every caller shares this helper.
function boundLimit(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(Math.floor(parsed), max));
}

// Receipt files are append-only, so a (file, lineIndex) pair keeps pointing at
// the same record even while new receipts arrive. Offsets do not: a concurrent
// append shifts every newest-first offset by one and silently repeats a row.
function receiptFileLines(file) {
  return fs.readFileSync(path.join(RECEIPTS_DIR, file), 'utf8').split(/\r?\n/);
}

export function encodeReceiptCursor(position) {
  return Buffer.from(JSON.stringify({ f: position.file, l: position.line }), 'utf8').toString('base64url');
}

export function decodeReceiptCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(String(parsed.f))) return null;
    const line = Number(parsed.l);
    if (!Number.isInteger(line) || line < 0) return null;
    return { file: String(parsed.f), line };
  } catch {
    return null;
  }
}

export function listReceipts(limit = 50, offset = 0) {
  const bounded = boundLimit(limit, 50, 500);
  if (!bounded) return [];
  const skipped = Math.max(0, Number(offset) || 0);
  const target = skipped + bounded;
  const files = receiptFiles();
  const receipts = [];
  for (const file of files) {
    const lines = receiptFileLines(file).filter(Boolean).reverse();
    for (const line of lines) {
      try { receipts.push(JSON.parse(line)); } catch {}
      if (receipts.length >= target) return receipts.slice(skipped, target);
    }
  }
  return receipts.slice(skipped, target);
}

// Walk newest-first from an exclusive cursor position and return one extra
// record so the next cursor is an exact position, never a recomputed offset.
export function listReceiptCursorPage(limit = 50, cursor = null) {
  const bounded = boundLimit(limit, 50, 500);
  const files = receiptFiles();
  let startFileIndex = 0;
  let startLine = null;
  if (cursor) {
    const position = decodeReceiptCursor(cursor);
    if (!position) throw new Error('receipt cursor is not a valid RelayBridge cursor');
    startFileIndex = files.indexOf(position.file);
    if (startFileIndex < 0) {
      return { receipts: [], nextCursor: null, cursorResolved: false, retentionGap: true, limit: bounded };
    }
    startLine = position.line;
  }
  const collected = [];
  for (let index = startFileIndex; index < files.length && collected.length <= bounded; index += 1) {
    const lines = receiptFileLines(files[index]);
    const from = index === startFileIndex && startLine !== null
      ? Math.min(startLine, lines.length - 1)
      : lines.length - 1;
    for (let line = from; line >= 0 && collected.length <= bounded; line -= 1) {
      if (!lines[line] || !lines[line].trim()) continue;
      try { collected.push({ receipt: JSON.parse(lines[line]), file: files[index], line }); }
      catch {}
    }
  }
  const page = collected.slice(0, bounded);
  const overflow = collected[bounded] || null;
  return {
    receipts: page.map((item) => item.receipt),
    nextCursor: overflow ? encodeReceiptCursor(overflow) : null,
    cursorResolved: true,
    retentionGap: false,
    limit: bounded,
  };
}

const MAX_RECEIPT_SCAN_LINES = 500000;

export function readReceipt(receiptId) {
  const wanted = String(receiptId || '');
  if (!/^rcpt_[A-Za-z0-9_-]+$/.test(wanted)) return null;
  let scanned = 0;
  for (const file of receiptFiles()) {
    const lines = receiptFileLines(file);
    for (let line = lines.length - 1; line >= 0; line -= 1) {
      if ((scanned += 1) > MAX_RECEIPT_SCAN_LINES) return null;
      if (!lines[line] || !lines[line].includes(wanted)) continue;
      try {
        const parsed = JSON.parse(lines[line]);
        if (parsed.receiptId === wanted) {
          return { ...parsed, _cursor: encodeReceiptCursor({ file, line }) };
        }
      } catch {}
    }
  }
  return null;
}

export function findReceiptByRequestId(requestId, {
  event = null, provider = null, maxScanLines = 5000,
} = {}) {
  const wanted = String(requestId || '');
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(wanted)) return null;
  const boundedScan = Number.isInteger(maxScanLines) && maxScanLines > 0
    ? Math.min(MAX_RECEIPT_SCAN_LINES, maxScanLines) : 5000;
  let scanned = 0;
  for (const file of receiptFiles()) {
    const lines = receiptFileLines(file);
    for (let line = lines.length - 1; line >= 0; line -= 1) {
      if ((scanned += 1) > boundedScan) return null;
      if (!lines[line] || !lines[line].includes(wanted)) continue;
      try {
        const receipt = JSON.parse(lines[line]);
        if (receipt.requestId !== wanted) continue;
        if (event && receipt.event !== event) continue;
        if (provider && receipt.provider !== provider) continue;
        return receipt;
      } catch {}
    }
  }
  return null;
}

export function countReceipts() {
  let count = 0;
  for (const file of receiptFiles()) {
    count += fs.readFileSync(path.join(RECEIPTS_DIR, file), 'utf8').split(/\r?\n/).filter(Boolean).length;
  }
  return count;
}

export function listReceiptPage(limit = 50, offset = 0) {
  const total = countReceipts();
  const boundedOffset = Math.max(0, Number(offset) || 0);
  const receipts = listReceipts(limit, boundedOffset);
  const nextOffset = boundedOffset + receipts.length < total ? boundedOffset + receipts.length : null;
  // Offsets stay for existing clients, but newest-first offsets shift whenever a
  // receipt is appended, so the stable cursor is returned alongside them. A
  // cursor points at the next record to return, so resolving a one-record page
  // starting at the last returned receipt yields the correct continuation.
  const lastCursor = receipts.at(-1)?.receiptId ? readReceipt(receipts.at(-1).receiptId)?._cursor : null;
  let nextCursor = null;
  if (lastCursor) {
    try { nextCursor = listReceiptCursorPage(1, lastCursor).nextCursor; }
    catch { nextCursor = null; }
  }
  return {
    receipts,
    total,
    offset: boundedOffset,
    nextOffset,
    nextCursor,
    cursorNote: 'offset pagination can repeat or skip rows while receipts are being appended; pass nextCursor to list_receipts for a stable page boundary',
  };
}

export function writeRun(run) {
  const runId = run.runId || `run_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  const record = {
    runId,
    createdAt: run.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...run,
    runId,
  };
  writeJsonAtomic(path.join(RUNS_DIR, `${runId}.json`), record);
  return record;
}

export function readRun(runId) {
  if (!/^run_[A-Za-z0-9_-]+$/.test(String(runId || ''))) return null;
  const filePath = path.join(RUNS_DIR, `${runId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function allRunSummaries() {
  const staleBefore = Date.now() - 15 * 60 * 1000;
  return fs.readdirSync(RUNS_DIR)
    .filter((name) => /^run_[A-Za-z0-9_-]+\.json$/.test(name))
    .map((name) => {
      try {
        let run = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, name), 'utf8'));
        if (run.status === 'running' && Date.parse(run.updatedAt || run.createdAt || 0) < staleBefore) {
          run = writeRun({
            ...run,
            status: 'interrupted',
            interruptedAt: new Date().toISOString(),
            interruptionReason: 'stale running lease reconciled after 15 minutes',
          });
        }
        return {
          runId: run.runId,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          mode: run.mode,
          status: run.status,
          taskHash: run.taskHash,
          providers: (run.members || []).map((member) => member.kind),
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function listRuns(limit = 25, offset = 0) {
  const bounded = boundLimit(limit, 25, 200);
  if (!bounded) return [];
  const boundedOffset = Math.max(0, Number(offset) || 0);
  return allRunSummaries().slice(boundedOffset, boundedOffset + bounded);
}

export function listRunPage(limit = 25, offset = 0) {
  const all = allRunSummaries();
  const bounded = boundLimit(limit, 25, 200);
  const boundedOffset = Math.max(0, Number(offset) || 0);
  const runs = all.slice(boundedOffset, boundedOffset + bounded);
  const nextOffset = boundedOffset + runs.length < all.length ? boundedOffset + runs.length : null;
  return { runs, total: all.length, offset: boundedOffset, nextOffset };
}

function cachePath(key) {
  return path.join(CACHE_DIR, `${stableHash(key)}.json`);
}

export function readCache(key, ttlMs) {
  const filePath = cachePath(key);
  if (!fs.existsSync(filePath)) return null;
  try {
    const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!record.createdAt || Date.now() - Date.parse(record.createdAt) > ttlMs) return null;
    return record;
  } catch {
    return null;
  }
}

export function writeCache(key, value) {
  const record = {
    keyHash: stableHash(key),
    createdAt: new Date().toISOString(),
    value,
  };
  writeJsonAtomic(cachePath(key), record);
  return record;
}

export function clearExpiredCache(ttlMs = 86400000) {
  let removed = 0;
  for (const name of fs.readdirSync(CACHE_DIR)) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(CACHE_DIR, name);
    try {
      const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!record.createdAt || Date.now() - Date.parse(record.createdAt) > ttlMs) {
        fs.unlinkSync(filePath);
        removed++;
      }
    } catch {
      fs.unlinkSync(filePath);
      removed++;
    }
  }
  return removed;
}
