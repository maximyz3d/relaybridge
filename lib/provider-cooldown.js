'use strict';

// Persistent provider cooldown (issue #17).
//
// The defect: a readiness probe proves AUTHENTICATION, not usable quota. After
// a subscription 429 the seat still reports ready, so routing keeps sending it
// work — burning calls that cannot succeed — unless every caller happens to
// remember an out-of-band "don't use claude_fable right now" rule.
//
// This makes that state first-class:
//   * durable on disk, so it survives a bridge restart
//   * shared by every client, so Claude Code, Cowork and the dashboard all
//     schedule against the same picture
//   * exposed through the API, so a caller can see WHY a ready seat was skipped
//
// Design notes:
//
// * `Retry-After` is authoritative when the provider sends one. Guessing
//   longer wastes capacity; guessing shorter earns another 429.
// * Repeat offences back off exponentially, because a seat that 429s twice in
//   a row is telling you the window is longer than you assumed.
// * A cooldown NEVER hides a seat that the user asked for by name. It reports
//   the state and lets the caller decide — silently refusing an explicit
//   request is worse than a failed call.
// * Cooling is not "unhealthy". The seat is authenticated and working; it just
//   has no quota right now. Conflating the two would send someone chasing a
//   login problem that does not exist.

const fs = require('fs');
const path = require('path');

// Backoff ladder for repeat offences within the same window, in ms.
const BACKOFF = [5 * 60000, 15 * 60000, 60 * 60000, 4 * 60 * 60000];
// After this long without a 429, the offence count resets — a seat that was
// rate limited this morning should not be punished tonight.
const OFFENCE_RESET_MS = 6 * 60 * 60000;
// Transient overload is not a quota wall; recover fast.
const OVERLOAD_MS = 60000;

function createCooldownStore(opts = {}) {
  const file = opts.file;
  const log = opts.log || (() => {});
  const now = opts.now || (() => Date.now());
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let state = {};
  try {
    if (fs.existsSync(file)) state = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (err) {
    // A corrupt cooldown file must not stop the bridge booting: the worst case
    // of losing it is one wasted call, versus a bridge that will not start.
    log(`[RelayBridge] cooldown state unreadable, starting fresh: ${err.message}`);
    state = {};
  }

  function persist() {
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, file); // atomic: a crash mid-write cannot corrupt it
    } catch (err) {
      log(`[RelayBridge] cooldown persist failed: ${err.message}`);
    }
  }

  function entry(seat) {
    return state[seat] || (state[seat] = { offences: 0, lastOffenceAt: 0, until: 0, reason: null, source: null });
  }

  /**
   * Record a failure. Only quota/overload classes cool a seat: an auth failure
   * or a bad prompt says nothing about capacity, and cooling for those would
   * remove a working seat for no reason.
   *
   * @param {string} seat
   * @param {string} kind        classification from lib/provider-failure.js
   * @param {object} [opts]
   * @param {number} [opts.retryAfterSec]  provider's Retry-After, if sent
   */
  function noteFailure(seat, kind, { retryAfterSec = null, scope = 'account' } = {}) {
    if (kind !== 'rate_limited' && kind !== 'overloaded') return null;
    const t = now();
    const e = entry(seat);

    if (t - e.lastOffenceAt > OFFENCE_RESET_MS) e.offences = 0;

    let ms;
    let source;
    if (Number.isFinite(Number(retryAfterSec)) && Number(retryAfterSec) > 0) {
      // The provider told us exactly when to come back. Believe it.
      ms = Number(retryAfterSec) * 1000;
      source = 'retry-after';
    } else if (kind === 'overloaded') {
      ms = OVERLOAD_MS;
      source = 'overload-default';
    } else {
      ms = BACKOFF[Math.min(e.offences, BACKOFF.length - 1)];
      source = 'backoff';
    }

    e.offences += 1;
    e.lastOffenceAt = t;
    // Never shorten an existing cooldown: two 429s in flight must not let the
    // second one undo the first one's longer window.
    const proposedUntil = t + ms;
    if (proposedUntil >= e.until) {
      e.until = proposedUntil;
      e.reason = kind;
      e.source = source;
      e.scope = scope === 'model' ? 'model' : 'account';
    }
    persist();
    log(`[RelayBridge] ${seat} cooling for ${Math.ceil((e.until - t) / 1000)}s (${e.reason}, ${e.source})`);
    return { seat, until: e.until, reason: e.reason, source: e.source, offences: e.offences };
  }

  // A successful run proves quota is back. Clear the cooldown but KEEP the
  // offence count until it ages out, so a seat that is flapping still backs
  // off progressively rather than resetting to five minutes each time.
  function noteSuccess(seat) {
    const e = state[seat];
    if (!e || !e.until) return null;
    e.until = 0;
    e.reason = null;
    e.source = null;
    persist();
    return { seat, cleared: true };
  }

  function status(seat) {
    const e = state[seat];
    const t = now();
    if (!e || !e.until || e.until <= t) {
      return { seat, cooling: false, until: null, remainingMs: 0, reason: null, offences: e?.offences || 0 };
    }
    return {
      seat, cooling: true, until: e.until, remainingMs: e.until - t,
      remainingSec: Math.ceil((e.until - t) / 1000),
      reason: e.reason, source: e.source, offences: e.offences,
      scope: e.scope === 'model' ? 'model' : 'account',
    };
  }

  function all() {
    const out = {};
    for (const seat of Object.keys(state)) out[seat] = status(seat);
    return out;
  }

  function cooling() {
    return Object.values(all()).filter((s) => s.cooling);
  }

  /**
   * Filter a candidate list for routing.
   *
   * Returns BOTH the usable seats and the skipped ones with reasons, because a
   * caller that ends up with nothing needs to know it was quota — not a
   * missing binary or a bad config. `explicit` is never filtered out: an
   * explicitly requested seat is reported as cooling and left in.
   */
  function filterCandidates(candidates = [], { explicit = null } = {}) {
    const usable = [];
    const skipped = [];
    for (const c of candidates) {
      const seat = typeof c === 'string' ? c : c.seat;
      const s = status(seat);
      if (s.cooling && seat !== explicit) skipped.push({ ...(typeof c === 'string' ? { seat } : c), cooldown: s });
      else usable.push(typeof c === 'string' ? { seat, cooldown: s.cooling ? s : null } : { ...c, cooldown: s.cooling ? s : null });
    }
    return { usable, skipped, allCooling: usable.length === 0 && skipped.length > 0 };
  }

  return { noteFailure, noteSuccess, status, all, cooling, filterCandidates, _state: () => state };
}

// Parse Retry-After from provider output. Accepts the HTTP header form
// (seconds, or an HTTP date) and the common "try again in 42s" prose that CLIs
// print instead of returning a header.
function parseRetryAfter(text, headerValue = null) {
  if (headerValue !== null && headerValue !== undefined) {
    const n = Number(headerValue);
    if (Number.isFinite(n) && n > 0) return n;
    const when = Date.parse(String(headerValue));
    if (Number.isFinite(when)) {
      const secs = Math.ceil((when - Date.now()) / 1000);
      if (secs > 0) return secs;
    }
  }
  const s = String(text || '');
  let m = s.match(/retry[- ]after[:\s]+(\d+)/i);
  if (m) return Number(m[1]);
  m = s.match(/try again in\s+(\d+)\s*(seconds?|secs?|s)\b/i);
  if (m) return Number(m[1]);
  m = s.match(/try again in\s+(\d+)\s*(minutes?|mins?|m)\b/i);
  if (m) return Number(m[1]) * 60;
  m = s.match(/resets? (?:in|at)\s+(\d+)\s*(minutes?|mins?)\b/i);
  if (m) return Number(m[1]) * 60;
  return null;
}

module.exports = { createCooldownStore, parseRetryAfter, BACKOFF, OVERLOAD_MS, OFFENCE_RESET_MS };
