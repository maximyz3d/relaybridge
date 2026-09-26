'use strict';

// Deliberately narrow recovery for the historical Claude context-refill defect.
// Callers supply identity, never the provider evidence used to authorize it.
const fs = require('node:fs');
const path = require('node:path');
const { BACKOFF } = require('./provider-cooldown');
const { validQuotaSeat } = require('./quota-seat');
const RECEIPT = /^rcpt_[a-z0-9_]{1,100}$/;

function validCorrectionRequest(body) {
  const keys = ['quotaSeat', 'sourceReceiptId', 'sourceObservationId', 'until', 'lastOffenceAt', 'offences'];
  return !!body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).length === keys.length && keys.every((k) => Object.hasOwn(body, k))
    && validQuotaSeat(body.quotaSeat) && RECEIPT.test(body.sourceReceiptId)
    && typeof body.sourceObservationId === 'string' && /^[a-f0-9]{24}$/.test(body.sourceObservationId)
    && ['until', 'lastOffenceAt', 'offences'].every((k) => Number.isSafeInteger(body[k]) && body[k] > 0);
}

function readCorrectionReceipts(directory) {
  const names = fs.readdirSync(directory).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
  // Incomplete/oversized scans are unknown authority, never a partial approval.
  if (names.length > 90) throw new Error('receipt scan file bound exceeded');
  let total = 0, lines = 0;
  const rows = [];
  for (const name of names) {
    const file = path.join(directory, name), st = fs.lstatSync(file);
    if (!st.isFile() || st.size > 64 * 1024 * 1024 || (total += st.size) > 256 * 1024 * 1024) throw new Error('receipt scan byte bound exceeded');
    const text = fs.readFileSync(file, 'utf8');
    if (text && !text.endsWith('\n')) throw new Error('incomplete receipt journal');
    for (const line of text.split('\n')) {
      if (!line) continue;
      if (++lines > 500000) throw new Error('receipt scan line bound exceeded');
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid receipt journal');
      rows.push(row);
    }
  }
  return rows;
}

function authorizeContextCorrection({ rows, receiptStoreId, seat, current, now = Date.now() }) {
  const refuse = (code) => ({ ok: false, code });
  const matches = rows.filter((r) => r.receiptId === current.sourceReceiptId);
  if (matches.length !== 1) return refuse('receipt_missing_or_ambiguous');
  const r = matches[0], at = Date.parse(r.timestamp);
  if (r.event !== 'bridge_provider_call' || r.receiptStoreId !== receiptStoreId || !receiptStoreId
    || r.modelInvocation !== true || !['claude', 'claude_fable'].includes(r.provider)
    || r.providerTerminalReason !== 'rapid_refill_breaker' || r.failureClass !== 'rate_limit'
    || r.status !== 'dropped' || r.outputChars !== 0 || !Number.isFinite(at)
    || at < current.lastOffenceAt || at > current.lastOffenceAt + 60000) return refuse('receipt_not_known_defect');
  const c = r.cooldown;
  if (!c || c.seat !== seat || c.sourceReceiptId !== r.receiptId
    || c.reason !== 'rate_limited' || c.source !== 'backoff' || c.scope !== 'account'
    || c.until !== current.until || c.offences !== current.offences
    || current.source !== 'backoff' || current.reason !== 'rate_limited' || current.scope !== 'account'
    || current.until - BACKOFF[Math.min(current.offences - 1, BACKOFF.length - 1)] !== current.lastOffenceAt) return refuse('observation_provenance_mismatch');
  // Missing fields, even apparently innocuous ones, cannot prove absence of
  // genuine status/diagnostic/retry authority on historical receipt versions.
  if (!['providerApiErrorStatus', 'quotaEvidence', 'vendorQuota', 'providerActionRequired', 'supervisorStopReason', 'providerErrorHash']
    .every((k) => Object.hasOwn(r, k) && r[k] === null)
    || !['providerRetryCount', 'providerRetryObservedEvents', 'providerRetryInvalidEvents', 'providerRetryDuplicateEvents',
      'providerErrorCount', 'providerErrorObserved', 'providerErrorInvalid'].every((k) => r[k] === 0)
    || r.providerRetryEventsTruncated !== false || r.providerErrorDiagnosticTruncated !== false
    || !Array.isArray(r.providerRetryEvents) || r.providerRetryEvents.length
    || !['providerRetryByStatus', 'providerRetryByError'].every((k) => r[k] && typeof r[k] === 'object'
      && !Array.isArray(r[k]) && Object.keys(r[k]).length === 0)) return refuse('quota_or_incomplete_evidence');
  const others = rows.filter((x) => x.event === 'bridge_provider_call' && x.cooldown?.seat === seat && x.receiptId !== r.receiptId);
  if (others.some((x) => x.receiptStoreId !== receiptStoreId || !Number.isFinite(Date.parse(x.timestamp))
    || !Number.isSafeInteger(x.cooldown.until) || x.cooldown.until > now
    || Date.parse(x.timestamp) >= at)) return refuse('other_cooldown_not_cleared');
  const predecessor = others.filter((x) => x.cooldown.offences === current.offences - 1
    && Date.parse(x.timestamp) <= current.lastOffenceAt).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
  if (current.offences > 1 && (!predecessor || predecessor.cooldown.sourceReceiptId !== predecessor.receiptId
    || current.lastOffenceAt - Date.parse(predecessor.timestamp) > 6 * 60 * 60000)) return refuse('predecessor_evidence_missing');
  return { ok: true, proof: { kind: 'claude_context_refill_no_quota_v1', receiptStoreId,
    sourceReceiptId: r.receiptId, predecessorReceiptId: predecessor?.receiptId || null, checkedAt: now } };
}

module.exports = { validCorrectionRequest, readCorrectionReceipts, authorizeContextCorrection };
