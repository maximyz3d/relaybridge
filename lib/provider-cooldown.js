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
//   longer wastes capacity; guessing shorter earns another 429. It is only
//   trusted up to MAX_COOLDOWN_MS, because the bridge scrapes it out of run
//   output rather than reading a header it can trust.
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
// Ceiling for any single cooldown, including a provider-supplied Retry-After.
// That value is SCRAPED out of run output (see parseRetryAfter), not read from
// a trusted header, so a run that printed a log excerpt or documentation
// containing "retry-after: 604800" while failing on a rate-limit signature
// parked the seat for a week — durably, on disk, with no endpoint to clear it.
// The ladder's top rung is the longest window this module would ever choose for
// itself, so it is also the longest one it accepts from anyone else: a
// genuinely longer provider window then costs at most one probe run every four
// hours, which is far cheaper than deprioritising a healthy seat for days on
// the strength of a number found in prose.
const MAX_COOLDOWN_MS = BACKOFF[BACKOFF.length - 1];
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
  // What the file looked like the last time we read or wrote it, so a re-read
  // only happens when somebody else has changed it.
  let seen = { mtimeMs: -1, size: -1 };
  markSeen();

  function markSeen(stat = null) {
    try {
      const st = stat || fs.statSync(file);
      seen = { mtimeMs: st.mtimeMs, size: st.size };
    } catch { seen = { mtimeMs: -1, size: -1 }; }
  }

  // Adopt changes another writer made to the file. The store used to read it
  // exactly once, at construction, and then rewrite the WHOLE map from that
  // snapshot, so two bridges sharing a data dir (RELAYBRIDGE_DATA_DIR pointed
  // at one directory) each erased the other's cooldowns, and an operator
  // hand-editing cooldowns.json — currently the only way to clear a stuck seat,
  // there being no DELETE endpoint — had the edit silently reverted by the next
  // persist().
  //
  // Merge rule: last writer wins per seat, judged by the offence clock every
  // entry already carries. A tie goes to the file, because the only way our
  // copy and the file can agree on lastOffenceAt while differing elsewhere is
  // that someone changed it after we wrote it — typically a cleared cooldown,
  // and a demonstrated success outranks our stale backoff.
  function syncFromDisk() {
    let stat;
    try { stat = fs.statSync(file); } catch { return; } // nothing written yet
    if (stat.mtimeMs === seen.mtimeMs && stat.size === seen.size) return;
    let disk = null;
    try {
      disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      log(`[RelayBridge] cooldown state unreadable, keeping the in-memory copy: ${err.message}`);
    }
    // Record what we read even when it was unusable, so a corrupt file is not
    // re-parsed and re-logged on every status() call.
    markSeen(stat);
    if (!disk || typeof disk !== 'object' || Array.isArray(disk)) return;
    for (const [seat, e] of Object.entries(disk)) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
      // A hand-edited entry with a non-numeric clock must not become a cooldown
      // nobody can reason about or wait out.
      const until = Number(e.until);
      const lastOffenceAt = Number(e.lastOffenceAt);
      const offences = Number(e.offences);
      if (!Number.isFinite(until) || !Number.isFinite(lastOffenceAt) || !Number.isFinite(offences)) continue;
      const mine = state[seat];
      if (mine && Number(mine.lastOffenceAt || 0) > lastOffenceAt) continue;
      state[seat] = { ...e, until, lastOffenceAt, offences };
    }
  }

  function persist() {
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, file); // atomic: a crash mid-write cannot corrupt it
      markSeen();
    } catch (err) {
      log(`[RelayBridge] cooldown persist failed: ${err.message}`);
    }
  }

  function entry(seat) {
    return state[seat] || (state[seat] = { offences: 0, lastOffenceAt: 0, until: 0, reason: null, source: null });
  }

  /**
   * Record a failure. Only rate, exhausted-quota, and overload classes cool a
   * seat: an auth failure or a bad prompt says nothing about capacity, and
   * cooling for those would remove a working seat for no reason.
   *
   * @param {string} seat
   * @param {string} kind        classification from lib/provider-failure.js
   * @param {object} [opts]
   * @param {number} [opts.retryAfterSec]  provider's Retry-After, if sent
   */
  function noteFailure(seat, kind, { retryAfterSec = null, scope = 'account' } = {}) {
    if (kind !== 'rate_limited' && kind !== 'quota_exhausted' && kind !== 'overloaded') return null;
    syncFromDisk();
    const t = now();
    const e = entry(seat);

    if (t - e.lastOffenceAt > OFFENCE_RESET_MS) e.offences = 0;

    let ms;
    let source;
    if (Number.isFinite(Number(retryAfterSec)) && Number(retryAfterSec) > 0) {
      // The provider told us exactly when to come back. Believe it, up to the
      // ceiling, and say so when the ceiling is what is actually in force.
      const asked = Number(retryAfterSec) * 1000;
      ms = Math.min(asked, MAX_COOLDOWN_MS);
      source = ms < asked ? 'retry-after-capped' : 'retry-after';
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
    syncFromDisk();
    const e = state[seat];
    if (!e || !e.until) return null;
    e.until = 0;
    e.reason = null;
    e.source = null;
    persist();
    return { seat, cleared: true };
  }

  function status(seat) {
    syncFromDisk();
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
    syncFromDisk();
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

module.exports = {
  createCooldownStore, parseRetryAfter, BACKOFF, OVERLOAD_MS, OFFENCE_RESET_MS,
  MAX_COOLDOWN_MS,
};
