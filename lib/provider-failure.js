'use strict';

const crypto = require('crypto');

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

// Antigravity print mode cannot display an interactive permission card. When
// a model selects a terminal command that is still in Ask, jetski denies it
// and exits without an answer. Keep this signature deliberately conjunctive:
// ordinary prose discussing headless mode or permissions must not become a
// provider failure.
const HEADLESS_COMMAND_PERMISSION_DENIAL = [
  /jetski:\s*no output produced/i,
  /tool required the command permission/i,
  /headless mode cannot prompt/i,
  /(?:was|so it was) auto-denied/i,
];

const PERPLEXITY_NO_ANSWER_SENTINEL = 'No answer received';

/**
 * Perplexity's wrapper can exit zero after printing a failed-answer sentinel,
 * optionally followed by URLs or other extraction fragments. Match only the
 * exact first transport line for the Perplexity provider. Quoted documents,
 * prose that mentions the phrase later, and prefixed/suffixed lookalikes remain
 * ordinary answers.
 */
function detectPerplexityNoAnswerSentinel(run = {}) {
  if (String(run.provider || '').toLowerCase() !== 'perplexity' || run.exitCode !== 0) return null;
  const stdout = String(run.transportStdout ?? run.stdout ?? '').replace(/^\uFEFF/, '');
  const lineEnd = stdout.search(/\r?\n/);
  const firstLine = lineEnd < 0 ? stdout : stdout.slice(0, lineEnd);
  if (firstLine !== PERPLEXITY_NO_ANSWER_SENTINEL) return null;
  const partialDiagnostic = lineEnd < 0 ? '' : stdout.slice(lineEnd).replace(/^\r?\n/, '');
  return {
    sentinel: PERPLEXITY_NO_ANSWER_SENTINEL,
    source: 'perplexity_cli_stdout_first_line',
    partialDiagnostic,
  };
}

function isHeadlessCommandPermissionDenial(run = {}) {
  if (run.exitCode === 0 && String(run.stdout || '').trim()) return false;
  const text = `${run.stdout || ''}\n${run.stderr || ''}`;
  return HEADLESS_COMMAND_PERMISSION_DENIAL.every((pattern) => pattern.test(text));
}

function matches(patterns, text) {
  return patterns.some((re) => re.test(text));
}

const COPILOT_MONTHLY_QUOTA_LINE = /^\s*You have exceeded your monthly quota(?:\s+\(Request ID:\s*[A-F0-9:]{3,160}\))?\s*$/im;

/**
 * Recognize only the failed GitHub Copilot CLI diagnostic observed in #52.
 * Provider identity, a non-zero exit, no answer, and an anchored stderr line
 * are all required so quoted prose or a successful answer cannot exhaust a
 * seat. The normalized evidence deliberately excludes the request id.
 */
function detectCopilotMonthlyQuota(run = {}) {
  if (String(run.provider || '').toLowerCase() !== 'copilot') return null;
  if (run.exitCode === 0 || String(run.stdout || '').trim()) return null;
  const stderr = String(run.stderr || '');
  if (!COPILOT_MONTHLY_QUOTA_LINE.test(stderr)) return null;
  const observed = run.observedAt ? new Date(run.observedAt) : new Date();
  if (!Number.isFinite(observed.getTime())) return null;
  return {
    provider: 'copilot',
    scope: 'seat',
    kind: 'monthly_quota_exhausted',
    source: 'copilot_cli_stderr',
    diagnostic: 'You have exceeded your monthly quota',
    observedAt: observed.toISOString(),
    stderrChars: stderr.length,
    stderrHash: crypto.createHash('sha256').update(stderr).digest('hex'),
  };
}

const PLAN_REQUEST = [
  /^\s*(?:please\s+)?plan\b/i,
  /^\s*(?:please\s+)?(?:give|provide|create|write|draft|make|develop|outline|propose|produce)\s+(?:me\s+)?(?:an?\s+)?(?:(?:detailed|full|implementation|technical)\s+)*(?:plan|roadmap|outline|strategy|approach|steps)\b/i,
  /\b(?:what|how)\s+(?:would|will|should)\s+(?:you|we)\s+(?:plan|approach|do)\b/i,
];
const EXECUTION_AFTER_PLAN = /\b(?:and|then|also)\s+(?:implement|execute|apply|edit|fix|build|change|run|test|ship|commit|push)\b/i;
const FUTURE_NARRATION = /^(?:(?:first|next|then|now|after that|finally)[,:]?\s+)?(?:i(?:\s+(?:will|am going to|plan to|intend to|need to|should|can)|['’]ll|['’]m\s+going to)|let me(?:\s+now)?)\s+(?:inspect|review|check|examine|analy[sz]e|investigate|search|look|read|gather|identify|trace|explore|probe|open|scan|audit|start|begin|continue|proceed|verify|test|run|delegate|ask|query|implement|fix|update|modify|create|write|build|add|remove|change|report)\b/i;
const RESULT_MARKER = /\b(?:found|confirmed|verified|completed|implemented|fixed|changed|updated|created|results?|answer|here\s+(?:is|are))\b/i;

function isPlanningRequest(prompt) {
  const text = String(prompt || '').trim();
  return !EXECUTION_AFTER_PLAN.test(text) && matches(PLAN_REQUEST, text);
}

/**
 * Detect a provider that exits successfully after narrating only what it will
 * do next. This deliberately requires multiple short, future-tense process
 * lines. One-line recommendations, requested plans, code, tables, and
 * structured data all fail open as legitimate answers.
 */
function isNarrationOnlyResponse({ prompt = '', stdout = '' } = {}) {
  const text = String(stdout || '').trim();
  if (!text || text.length > 2400 || isPlanningRequest(prompt)) return false;
  if (/```|~~~/.test(text) || /^\s*[\[{]/.test(text) || /^\s*\|.*\|\s*$/m.test(text)) return false;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2 || lines.length > 12) return false;
  return lines.every((line) => {
    const prose = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '').trim();
    return prose.length <= 400 && !/:\s*\S/.test(prose)
      && !RESULT_MARKER.test(prose) && FUTURE_NARRATION.test(prose);
  });
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

  // Agy 1.1.18+ correctly exits non-zero for most dropped streams, but the
  // observed jetski permission denial can still exit zero with no stdout.
  // Recognize that exact empty-answer diagnostic before the general clean-exit
  // rule. isHeadlessCommandPermissionDenial rejects successful quoted prose.
  if (isHeadlessCommandPermissionDenial(run)) {
    return {
      kind: 'headless_command_permission_auto_denied',
      retryable: false,
      failUp: true,
      detail: 'Antigravity selected a terminal command whose permission was not pre-approved; headless mode cannot prompt, so it auto-denied the command. Use the command-free read-only review policy or explicitly configure a narrow Antigravity permission rule; never retry the identical policy drop.',
    };
  }

  const perplexitySentinel = detectPerplexityNoAnswerSentinel(run);
  if (perplexitySentinel) {
    return {
      kind: 'incomplete_response', retryable: false, failUp: true,
      detail: 'Perplexity reported that no answer was received; preserve any trailing extraction fragments only as partial diagnostics and switch providers',
      partialResult: true,
      failureSentinel: perplexitySentinel.sentinel,
      failureSentinelSource: perplexitySentinel.source,
      partialDiagnostic: perplexitySentinel.partialDiagnostic,
    };
  }

  // A clean transport exit can still be incomplete when the provider emits
  // only future-tense process narration and never supplies the requested
  // result. This is fail-up evidence, but never a same-seat retry: repeating
  // the identical call tends to repeat the same failure mode and waste quota.
  if (exitCode === 0 && isNarrationOnlyResponse(run)) {
    return { kind: 'incomplete_response', retryable: false, failUp: true,
      detail: 'the provider stopped after narrating future work without returning a task result; narrow the task or switch providers' };
  }
  // Other clean exits are answers. Checking this BEFORE error patterns is
  // essential: an answer that discusses timeouts must not be discarded.
  if (exitCode === 0) return { kind: 'ok', retryable: false, failUp: false, detail: '' };

  if (matches(NOT_INSTALLED, text)) {
    return { kind: 'not_installed', retryable: false, failUp: true,
      detail: 'the provider binary is missing on this machine' };
  }

  if (detectCopilotMonthlyQuota(run)) {
    return { kind: 'rate_limited', retryable: false, failUp: true,
      detail: 'Copilot monthly quota is exhausted — use a different seat; do not retry this seat' };
  }
  if (matches(RATE_LIMITED, text)) {
    return { kind: 'rate_limited', retryable: false, failUp: true,
      detail: 'quota or rate limit hit — a different seat will succeed where a retry will not' };
  }
  // Some providers report exhausted quota as HTTP 403. Specific quota text
  // wins over the generic status code so the seat enters cooldown instead of
  // being misreported as signed out.
  if (matches(AUTH_FAILED, text)) {
    return { kind: 'auth_failed', retryable: false, failUp: true,
      detail: 'the seat is signed out — sign in, or route to another seat' };
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
  detectCopilotMonthlyQuota,
  detectPerplexityNoAnswerSentinel,
  isHeadlessCommandPermissionDenial,
  isNarrationOnlyResponse,
  isPlanningRequest,
  seatToleratesLongRuns,
  INTERNAL_TIMEOUT,
  HEADLESS_COMMAND_PERMISSION_DENIAL,
  PERPLEXITY_NO_ANSWER_SENTINEL,
};
