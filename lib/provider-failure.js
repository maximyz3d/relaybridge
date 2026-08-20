'use strict';

// Classify WHY a provider run ended, so the bridge can tell three very
// different things apart:
//
//   1. the provider answered (even if the answer was "no")
//   2. the provider's OWN client gave up — an internal timeout, a dropped
//      connection, a rate limit — nothing to do with the task
//   3. the bridge's supervisor stopped it
//
// This distinction matters because case 2 was previously indistinguishable
// from case 1 with a non-zero exit: a run recorded as "provider_error" and
// counted as a completed attempt. In practice a seat that dies at ~3 minutes
// on its own internal deadline has told you nothing about the task, and the
// right response is to route the SAME prompt to a different seat rather than
// resubmit it to the one that just proved it cannot hold the connection.
//
// The trigger case: Gemini's CLI dropped at 183.9s with "timeout waiting for
// response" while the bridge supervisor still had 18 minutes of idle budget.
// The bridge was healthy; the provider's own client was not.

// Patterns are matched against combined stdout+stderr, lowercased. Kept
// deliberately specific: a false positive here would retry a real refusal.
const INTERNAL_TIMEOUT = [
  /timeout waiting for response/i,
  /deadline exceeded/i,
  /context deadline exceeded/i,
  /etimedout/i,
  /request timed? ?out/i,
  /operation timed out/i,
  /socket hang ?up/i,
  /econnreset/i,
  /stream (?:was )?(?:closed|reset) (?:unexpectedly|before)/i,
  /connection (?:closed|aborted) (?:unexpectedly|by peer)/i,
  /upstream (?:connect error|request timeout)/i,
  /504 gateway/i,
  /gateway time-?out/i,
];

const RATE_LIMITED = [
  /rate.?limit/i, /\b429\b/, /too many requests/i,
  /quota (?:exceeded|exhausted)/i, /resource[_ ]exhausted/i,
];

const AUTH_FAILED = [
  /\b401\b/, /\b403\b/, /unauthor(?:ized|ised)/i, /not (?:logged|signed) in/i,
  /authentication (?:failed|required)/i, /invalid (?:api )?(?:key|credential|token)/i,
  /please run .*(?:login|auth)/i,
];

const OVERLOADED = [
  /\b529\b/, /\b503\b/, /overloaded/i, /server is busy/i,
  /service unavailable/i, /capacity/i,
];

const NOT_INSTALLED = [
  /\benoent\b/i, /is not recognized as (?:an internal|the name)/i,
  /command not found/i, /cannot find (?:the )?(?:path|module)/i,
];

function matches(patterns, text) {
  return patterns.some((re) => re.test(text));
}

/**
 * @param {object} run
 * @param {string} [run.stdout]
 * @param {string} [run.stderr]
 * @param {number} [run.exitCode]
 * @param {number} [run.elapsedMs]
 * @param {string} [run.stopReason]  supervisor verdict, if it stopped the run
 * @returns {{kind:string, retryable:boolean, failUp:boolean, detail:string}}
 */
function classifyRunFailure(run = {}) {
  const text = `${run.stdout || ''}\n${run.stderr || ''}`;
  const exitCode = run.exitCode;
  const elapsed = Number(run.elapsedMs) || 0;

  // The supervisor's own verdict wins: it knows why it intervened, and that is
  // not a provider fault to be retried elsewhere.
  if (run.stopReason) {
    return {
      kind: `supervisor_${run.stopReason}`,
      retryable: false,
      failUp: false,
      detail: 'the bridge stopped this run; the provider did not fail',
    };
  }

  // A clean exit is an answer, full stop. Checking this BEFORE the patterns is
  // essential: an answer that merely discusses timeouts ("set a request timed
  // out handler") would otherwise be discarded and pointlessly re-routed.
  if (exitCode === 0) return { kind: 'ok', retryable: false, failUp: false, detail: '' };

  if (matches(AUTH_FAILED, text)) {
    return { kind: 'auth_failed', retryable: false, failUp: true,
      detail: 'the seat is signed out — sign in, or route to another seat' };
  }
  if (matches(NOT_INSTALLED, text)) {
    return { kind: 'not_installed', retryable: false, failUp: true,
      detail: 'the provider binary is missing on this machine' };
  }
  if (matches(RATE_LIMITED, text)) {
    return { kind: 'rate_limited', retryable: false, failUp: true,
      detail: 'quota or rate limit hit — a different seat will succeed where a retry will not' };
  }
  if (matches(OVERLOADED, text)) {
    return { kind: 'overloaded', retryable: true, failUp: true,
      detail: 'the provider is overloaded — retry later or use another seat' };
  }
  if (matches(INTERNAL_TIMEOUT, text)) {
    return {
      kind: 'provider_internal_timeout',
      // NOT retryable on the same seat: it just demonstrated it cannot hold a
      // connection this long, and the same prompt will hit the same deadline.
      retryable: false,
      failUp: true,
      detail: elapsed
        ? `the provider's own client gave up after ${Math.round(elapsed / 1000)}s — this is its internal deadline, not the task; route to a seat that tolerates long runs`
        : "the provider's own client timed out — route to a seat that tolerates long runs",
    };
  }

  return {
    kind: 'provider_error',
    retryable: false,
    failUp: true,
    detail: `the provider exited ${exitCode} without a recognized failure signature`,
  };
}

// Seats whose own client imposes a short deadline should not be handed long
// work in the first place. This is advisory metadata for the router: an
// observed internal timeout is evidence about the SEAT, not the task.
function seatToleratesLongRuns(seatConfig = {}) {
  const known = Number(seatConfig.internalTimeoutMs);
  if (!Number.isFinite(known) || known <= 0) return true; // unknown: assume yes
  return known >= 900000; // needs to hold a connection for 15+ minutes
}

module.exports = {
  classifyRunFailure,
  seatToleratesLongRuns,
  INTERNAL_TIMEOUT,
};
