'use strict';

// Durable local spend ledger for owner-authorized credit permits (schema v2).
// One file per permit authorizationId under <dataDir>/credit-ledger, plus an
// append-only receipts.jsonl. Everything is synchronous, so a reservation is
// atomic inside one process; a `wx` lockfile makes it atomic across processes.
// A lock that cannot be taken is never stolen: the call fails closed with
// credit_ledger_locked and the owner removes a stale lock by hand.
//
// Budget rule (one rule, no double counting): `budgetCents` already EXCLUDES
// the owner's reserve (the permit requires budget + reserve <= provider-side
// basis), so spendable == budgetCents. A reservation is refused when
// spent + held + estimate > budgetCents. `reserveCents` is recorded for
// receipts only and is never spendable here.
//
// Unsettled reservations persist and keep counting: a crash between reserve
// and settle is a pessimistic hold, never a refund.
//
// The ledger is the bridge's own count from owner-declared prices. It does not
// see spend by other clients or the provider's real balance.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DIR = 'credit-ledger';
const RECEIPTS = 'receipts.jsonl';
const ID = /^p[ap]_[A-Za-z0-9_-]{1,96}$/;
const REQUEST_KEY = /^[A-Za-z0-9_:.-]{1,200}$/;
const LOCK_WAIT_MS = 250;
const EXHAUST_CAUSES = Object.freeze(['funding_exhausted', 'account_credit_low', 'spend_limit', 'funding_ambiguous', 'local_budget_exhausted', 'operator']);
const DISPOSITIONS = Object.freeze(['settled', 'provider_error', 'outcome_uncertain', 'not_sent']);
const RATE_KEYS = Object.freeze(['inputCentsPerMTok', 'outputCentsPerMTok', 'cacheWriteCentsPerMTok', 'cacheReadCentsPerMTok']);

const err = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const nonNeg = (v) => Number.isSafeInteger(v) && v >= 0;
const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };

function validRates(r) { return !!r && typeof r === 'object' && RATE_KEYS.every(k => nonNeg(r[k])); }
function validUsage(u) {
  return !!u && typeof u === 'object' && nonNeg(u.input_tokens) && nonNeg(u.output_tokens)
    && ['cache_creation_input_tokens', 'cache_read_input_tokens'].every(k => u[k] == null || nonNeg(u[k]));
}
const ceilDiv = (n, d) => (n + d - 1n) / d;
// Cents, rounded up, from integer cents-per-MTok rates. Provider usage keys.
// Cache-read tokens are charged at the cache-read rate in addition to
// input_tokens at the input rate, which can only over-state OpenAI cost
// (whose input_tokens already include the cached ones): pessimistic by design.
function chargeCents(usage, rates) {
  if (!validUsage(usage) || !validRates(rates)) return null;
  const total = BigInt(usage.input_tokens) * BigInt(rates.inputCentsPerMTok) + BigInt(usage.output_tokens) * BigInt(rates.outputCentsPerMTok)
    + BigInt(usage.cache_creation_input_tokens ?? 0) * BigInt(rates.cacheWriteCentsPerMTok)
    + BigInt(usage.cache_read_input_tokens ?? 0) * BigInt(rates.cacheReadCentsPerMTok);
  const cents = Number(ceilDiv(total, 1000000n));
  return Number.isSafeInteger(cents) ? cents : null;
}
// Pre-turn worst case: every request byte billed at the dearer of the input
// and cache-write rates, plus the full per-request output allowance.
function estimateCents({ requestBytes, maxOutputTokens, rates }) {
  if (!nonNeg(requestBytes) || !nonNeg(maxOutputTokens) || !validRates(rates)) return null;
  const total = BigInt(requestBytes) * BigInt(Math.max(rates.inputCentsPerMTok, rates.cacheWriteCentsPerMTok))
    + BigInt(maxOutputTokens) * BigInt(rates.outputCentsPerMTok);
  const cents = Number(ceilDiv(total, 1000000n));
  return Number.isSafeInteger(cents) ? Math.max(1, cents) : null;
}

function createCreditLedger({ dataDir, now = Date.now } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('credit ledger requires a data directory');
  const dir = path.join(path.resolve(dataDir), DIR);
  const receiptsFile = path.join(dir, RECEIPTS);
  const stamp = () => new Date(now()).toISOString();

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}
  }
  const fileFor = (id) => {
    if (typeof id !== 'string' || !ID.test(id)) throw err('credit_ledger_invalid');
    return path.join(dir, `${id}.json`);
  };
  function withLock(id, fn) {
    fileFor(id); // validate the id before any filesystem effect
    ensureDir();
    const lock = path.join(dir, `${id}.lock`);
    const deadline = Date.now() + LOCK_WAIT_MS;
    let fd = null;
    for (;;) {
      try { fd = fs.openSync(lock, 'wx', 0o600); break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw err('credit_ledger_locked');
        if (Date.now() >= deadline) throw err('credit_ledger_locked');
        sleep(5);
      }
    }
    try { fs.writeSync(fd, String(process.pid)); } catch {}
    try { return fn(); }
    finally { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(lock); } catch {} }
  }
  function load(id) {
    let text;
    try { text = fs.readFileSync(fileFor(id), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw err('credit_ledger_invalid'); }
    let s;
    try { s = JSON.parse(text); } catch { throw err('credit_ledger_invalid'); }
    if (!s || s.schemaVersion !== 1 || s.authorizationId !== id || !nonNeg(s.spentCents) || !s.holds || !s.done) throw err('credit_ledger_invalid');
    return s;
  }
  function save(s) {
    const file = fileFor(s.authorizationId), tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeSync(fd, JSON.stringify(s, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    try { const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch {}
  }
  const held = (s) => Object.values(s.holds).reduce((a, h) => a + h.reservedCents, 0);
  const view = (s) => Object.freeze({ authorizationId: s.authorizationId, budgetCents: s.budgetCents, reserveCents: s.reserveCents,
    spentCents: s.spentCents, heldCents: held(s), remainingCents: Math.max(0, s.budgetCents - s.spentCents - held(s)),
    exhausted: s.exhausted, exhaustedCause: s.exhaustedCause ?? null });

  function reserve(a = {}) {
    const { authorizationId, authorizationHash, policy, provider, organization, scopeRef, evidence, budgetCents, reserveCents,
      requestKey, model, estimateCents: estimate } = a;
    if (typeof authorizationId !== 'string' || !ID.test(authorizationId) || typeof authorizationHash !== 'string' || !/^[a-f0-9]{64}$/.test(authorizationHash)
      || typeof requestKey !== 'string' || !REQUEST_KEY.test(requestKey) || !Number.isSafeInteger(budgetCents) || budgetCents <= 0
      || !nonNeg(reserveCents) || !Number.isSafeInteger(estimate) || estimate <= 0 || typeof model !== 'string' || !model) throw err('credit_ledger_invalid');
    return withLock(authorizationId, () => {
      let s = load(authorizationId);
      if (!s) {
        s = { schemaVersion: 1, authorizationId, authorizationHash, policy: policy ?? null, provider: provider ?? null, organization: organization ?? null,
          scopeRef: scopeRef ?? null, evidence: evidence ?? null, budgetCents, reserveCents, spentCents: 0, exhausted: false, exhaustedCause: null,
          createdAt: stamp(), holds: {}, done: {} };
      } else if (s.authorizationHash !== authorizationHash || s.budgetCents !== budgetCents || s.reserveCents !== reserveCents) {
        throw err('funding_decision_changed', { reason: 'ledger_permit_changed' });
      }
      if (s.holds[requestKey] || s.done[requestKey]) throw err('credit_ledger_duplicate');
      if (s.exhausted) throw err('funding_exhausted', { reason: 'ledger_exhausted' });
      if (s.spentCents + held(s) + estimate > s.budgetCents) throw err('funding_exhausted', { reason: 'local_budget_exhausted' });
      s.holds[requestKey] = { reservedCents: estimate, model, at: stamp() };
      save(s);
      return Object.freeze({ requestKey, reservedCents: estimate, ...view(s) });
    });
  }

  function settle({ authorizationId, requestKey, disposition, usage = null, pricing = null, providerErrorClass = null } = {}) {
    if (!DISPOSITIONS.includes(disposition)) throw err('credit_ledger_invalid');
    fileFor(authorizationId);
    return withLock(authorizationId, () => {
      const s = load(authorizationId);
      const hold = s?.holds?.[requestKey];
      if (!hold) throw err(s?.done?.[requestKey] ? 'credit_ledger_duplicate' : 'credit_ledger_invalid');
      let charged = 0, recorded = disposition, overrun = false;
      if (disposition === 'settled') {
        const c = chargeCents(usage, pricing);
        if (c === null) { charged = hold.reservedCents; recorded = 'usage_missing_charged_reservation'; } else charged = c;
      } else if (disposition === 'outcome_uncertain') charged = hold.reservedCents;
      if (charged > hold.reservedCents) overrun = true;
      delete s.holds[requestKey];
      s.done[requestKey] = { reservedCents: hold.reservedCents, chargedCents: charged, disposition: recorded, model: hold.model, at: stamp(),
        ...(overrun ? { overrun: true } : {}), ...(providerErrorClass ? { providerErrorClass } : {}),
        usage: recorded === 'settled' ? usage : null };
      s.spentCents += charged;
      if (s.spentCents >= s.budgetCents && !s.exhausted) { s.exhausted = true; s.exhaustedCause = 'local_budget_exhausted'; }
      save(s);
      const after = view(s);
      const receipt = { at: stamp(), provider: s.provider, organization: s.organization, scope: s.scopeRef, policy: s.policy,
        authorizationId, authorizationHash: s.authorizationHash, evidence: s.evidence, requestKey, model: hold.model,
        reservedCents: hold.reservedCents, usage: recorded === 'settled' ? usage : null, chargedCents: charged, disposition: recorded,
        ...(overrun ? { overrun: true } : {}), providerErrorClass: providerErrorClass ?? null,
        spentCentsAfter: after.spentCents, remainingCentsAfter: after.remainingCents, exhausted: after.exhausted };
      ensureDir();
      const fd = fs.openSync(receiptsFile, 'a', 0o600);
      try { fs.writeSync(fd, JSON.stringify(receipt) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return Object.freeze({ chargedCents: charged, disposition: recorded, overrun, ...after });
    });
  }

  function markExhausted({ authorizationId, cause } = {}) {
    if (!EXHAUST_CAUSES.includes(cause)) throw err('credit_ledger_invalid');
    fileFor(authorizationId);
    return withLock(authorizationId, () => {
      const s = load(authorizationId);
      if (!s) throw err('credit_ledger_invalid');
      if (!s.exhausted) { s.exhausted = true; s.exhaustedCause = cause; s.exhaustedAt = stamp(); save(s); }
      return view(s);
    });
  }

  // Read-only; the lock is not taken, files are replaced atomically.
  function summary({ authorizationId } = {}) {
    const s = load(authorizationId);
    if (!s) return null;
    const turns = [...Object.entries(s.done).map(([requestKey, d]) => ({ requestKey, reservedCents: d.reservedCents, chargedCents: d.chargedCents,
      disposition: d.disposition, usage: d.usage ?? null })),
    ...Object.entries(s.holds).map(([requestKey, h]) => ({ requestKey, reservedCents: h.reservedCents, chargedCents: null, disposition: 'held', usage: null }))];
    return Object.freeze({ ...view(s), turns });
  }

  return Object.freeze({ reserve, settle, markExhausted, summary });
}

module.exports = { createCreditLedger, chargeCents, estimateCents, RATE_KEYS, EXHAUST_CAUSES, CREDIT_LEDGER_DIR: DIR };
