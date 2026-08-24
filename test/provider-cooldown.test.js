'use strict';

// Issue #17: a readiness probe proves authentication, not usable quota. After a
// 429 the seat still reported ready and kept getting work. These tests pin the
// behaviour that stops that.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCooldownStore, parseRetryAfter, BACKOFF, OVERLOAD_MS } = require('../lib/provider-cooldown');

function store(nowRef) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbcool-'));
  const file = path.join(dir, 'cooldowns.json');
  return { s: createCooldownStore({ file, now: () => nowRef.t }), file, dir };
}

test('a 429 cools the seat so routing stops sending it work', () => {
  const nowRef = { t: 1_000_000 };
  const { s, dir } = store(nowRef);
  assert.equal(s.status('claude_fable').cooling, false);

  s.noteFailure('claude_fable', 'rate_limited');
  const st = s.status('claude_fable');
  assert.equal(st.cooling, true);
  assert.equal(st.reason, 'rate_limited');
  assert.equal(st.remainingMs, BACKOFF[0]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('only quota-class failures cool a seat — auth or a bad prompt must not', () => {
  const nowRef = { t: 1_000_000 };
  const { s, dir } = store(nowRef);
  for (const kind of ['auth_failed', 'not_installed', 'provider_error', 'provider_internal_timeout', 'ok']) {
    assert.equal(s.noteFailure('claude', kind), null, `${kind} must not cool the seat`);
    assert.equal(s.status('claude').cooling, false, `${kind} must not cool the seat`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('authoritative usage-quota exhaustion cools a seat but generic budget failures do not', () => {
  const nowRef = { t: 1_000_000 };
  const { s, dir } = store(nowRef);
  assert.ok(s.noteFailure('cursor', 'quota_exhausted'));
  assert.equal(s.status('cursor').reason, 'quota_exhausted');
  assert.equal(s.noteFailure('claude', 'budget'), null, 'a per-run USD budget must not cool a subscription seat');
  assert.equal(s.status('claude').cooling, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Retry-After from the provider wins over our guess', () => {
  const nowRef = { t: 1_000_000 };
  const { s, dir } = store(nowRef);
  s.noteFailure('codex', 'rate_limited', { retryAfterSec: 42 });
  const st = s.status('codex');
  assert.equal(st.remainingMs, 42000, 'must honour the provider, not the backoff ladder');
  assert.equal(st.source, 'retry-after');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('repeat offences back off exponentially', () => {
  const nowRef = { t: 1_000_000 };
  const { s, dir } = store(nowRef);
  const seen = [];
  for (let i = 0; i < 4; i++) {
    s.noteFailure('claude', 'rate_limited');
    seen.push(s.status('claude').remainingMs);
    nowRef.t = s.status('claude').until + 1000; // wait it out, then fail again
  }
  assert.deepEqual(seen, BACKOFF, 'each repeat within the window must wait longer');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the offence count resets after a quiet period', () => {
  const nowRef = { t: 1_000_000 };
  const { s, dir } = store(nowRef);
  s.noteFailure('claude', 'rate_limited');
  assert.equal(s.status('claude').offences, 1);

  nowRef.t += 7 * 60 * 60000; // 7 hours later
  s.noteFailure('claude', 'rate_limited');
  assert.equal(s.status('claude').remainingMs, BACKOFF[0],
    'a morning rate limit must not punish an evening call');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a second 429 cannot shorten an existing longer cooldown', () => {
  const nowRef = { t: 1_000_000 };
  const { s, dir } = store(nowRef);
  s.noteFailure('claude', 'rate_limited', { retryAfterSec: 3600 }); // 1h
  s.noteFailure('claude', 'rate_limited', { retryAfterSec: 10 });   // race
  assert.ok(s.status('claude').remainingMs > 3_000_000, 'the longer window must stand');
  assert.equal(s.status('claude').source, 'retry-after', 'metadata must still describe the active longer window');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a shorter failure cannot relabel the active longer cooldown', () => {
  const nowRef = { t: 1_000_000 };
  const { s, dir } = store(nowRef);
  s.noteFailure('claude', 'rate_limited', { retryAfterSec: 3600 });
  s.noteFailure('claude', 'overloaded');
  const status = s.status('claude');
  assert.equal(status.reason, 'rate_limited');
  assert.equal(status.source, 'retry-after');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('transient overload recovers fast — it is not a quota wall', () => {
  const nowRef = { t: 1_000_000 };
  const { s, dir } = store(nowRef);
  s.noteFailure('grok', 'overloaded');
  assert.equal(s.status('grok').remainingMs, OVERLOAD_MS);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cooldown expires on its own', () => {
  const nowRef = { t: 1_000_000 };
  const { s, dir } = store(nowRef);
  s.noteFailure('claude', 'rate_limited');
  nowRef.t += BACKOFF[0] + 1;
  assert.equal(s.status('claude').cooling, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a success clears the cooldown but keeps the offence count for backoff', () => {
  const nowRef = { t: 1_000_000 };
  const { s, dir } = store(nowRef);
  s.noteFailure('claude', 'rate_limited');
  s.noteSuccess('claude');
  assert.equal(s.status('claude').cooling, false, 'quota is demonstrably back');
  assert.equal(s.status('claude').offences, 1, 'a flapping seat must still escalate');

  s.noteFailure('claude', 'rate_limited');
  assert.equal(s.status('claude').remainingMs, BACKOFF[1], 'second offence waits longer');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('state survives a bridge restart — that is the whole point', () => {
  const nowRef = { t: 1_000_000 };
  const { s, file, dir } = store(nowRef);
  s.noteFailure('claude_fable', 'rate_limited', { retryAfterSec: 900 });

  const reopened = createCooldownStore({ file, now: () => nowRef.t });
  const st = reopened.status('claude_fable');
  assert.equal(st.cooling, true, 'a restart must not forget the 429');
  assert.equal(st.remainingSec, 900);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt cooldown file does not stop the bridge starting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbcool-'));
  const file = path.join(dir, 'cooldowns.json');
  fs.writeFileSync(file, '{ this is not json');
  const logs = [];
  const s = createCooldownStore({ file, log: (m) => logs.push(m) });
  assert.equal(s.status('claude').cooling, false);
  assert.ok(logs.some((l) => /unreadable/.test(l)), 'the reset must be announced, not silent');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- routing ---------------------------------------------------------------

test('cooling seats are filtered out of routing, with a reason', () => {
  const nowRef = { t: 1_000_000 };
  const { s, dir } = store(nowRef);
  s.noteFailure('claude', 'rate_limited');
  const { usable, skipped } = s.filterCandidates([
    { seat: 'claude', rank: 0 }, { seat: 'codex', rank: 1 },
  ]);
  assert.deepEqual(usable.map((u) => u.seat), ['codex']);
  assert.equal(skipped[0].seat, 'claude');
  assert.equal(skipped[0].cooldown.reason, 'rate_limited',
    'a caller must be able to tell quota from a missing binary');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an explicitly requested seat is never silently withheld', () => {
  const nowRef = { t: 1_000_000 };
  const { s, dir } = store(nowRef);
  s.noteFailure('claude', 'rate_limited');
  const { usable, skipped } = s.filterCandidates([{ seat: 'claude', rank: 0 }], { explicit: 'claude' });
  assert.equal(usable.length, 1, 'the user asked for this seat by name');
  assert.equal(skipped.length, 0);
  assert.equal(usable[0].cooldown.cooling, true, 'but the state is still reported');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('when every candidate is cooling the caller is told so explicitly', () => {
  const nowRef = { t: 1_000_000 };
  const { s, dir } = store(nowRef);
  s.noteFailure('claude', 'rate_limited');
  s.noteFailure('codex', 'rate_limited');
  const r = s.filterCandidates([{ seat: 'claude' }, { seat: 'codex' }]);
  assert.equal(r.usable.length, 0);
  assert.equal(r.allCooling, true, 'this must not look like "no capable provider"');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- Retry-After parsing ---------------------------------------------------

test('Retry-After is read from a header or from CLI prose', () => {
  assert.equal(parseRetryAfter('', 120), 120);
  assert.equal(parseRetryAfter('Error 429: retry-after: 30'), 30);
  assert.equal(parseRetryAfter('rate limited, try again in 45 seconds'), 45);
  assert.equal(parseRetryAfter('please try again in 5 minutes'), 300);
  assert.equal(parseRetryAfter('your limit resets in 20 minutes'), 1200);
  assert.equal(parseRetryAfter('some unrelated error'), null);
});

test('an HTTP-date Retry-After is converted to seconds', () => {
  const when = new Date(Date.now() + 300000).toUTCString();
  const secs = parseRetryAfter('', when);
  assert.ok(secs > 250 && secs <= 300, `expected ~300s, got ${secs}`);
});

test('a Retry-After already in the past is ignored rather than trusted', () => {
  assert.equal(parseRetryAfter('', new Date(Date.now() - 60000).toUTCString()), null);
  assert.equal(parseRetryAfter('', -5), null);
});
