'use strict';

const { PROVIDER_BUDGET_USAGE_FIELDS: BUDGET_FIELDS } = require('./provider-budget');
const { ProgressObserver } = require('./progress-observer');

// Liveness supervision for provider runs.
//
// A single wall-clock timeout is the wrong instrument for agentic CLIs. A
// three-minute cap kills a model halfway through a legitimate long task, and
// raising it to thirty minutes just means a CLI wedged in a repeat loop burns
// tokens for thirty minutes instead. Elapsed time cannot tell those apart
// because it is not the variable that matters.
//
// This module never stops a run because of elapsed time or token count.
// Progress check-ins (fixed time or token-growth boundaries) replace caps: a
// run is killed only on corroborated evidence, accumulated across several
// consecutive check-ins, that it is wedged, looping, or burning tokens
// without progress. Provider-reported budgets, an explicit hard cap and a
// caller timeout are still accepted and recorded, but are informational only
// (see `ignoredCaps`) — they never trigger a stop.
//
// Pure logic on purpose: no timers, no process handles, no I/O. The caller
// feeds it observations and a clock, which makes every decision path unit
// testable without spawning anything.

const DEFAULTS = {
  // No new output for this long makes a run *suspect* — not yet dead. Print
  // mode CLIs (claude -p, codex, cursor agent -p) buffer their whole answer
  // and emit nothing until the end, so this has to be generous. Feeds the
  // `silent` check-in detector only; it never kills by itself.
  idleMs: 1200000,
  // No longer enforced. Kept as a well-formed numeric field so downstream
  // consumers (drain-timeout math, --print-timeout rendering) still have a
  // large, safe number to read; never compared against elapsed age to kill.
  hardCapMs: null,
  // Extra idle windows granted when CPU sampling proves the tree is working
  // while silent. Bounded so a busy-spinning process cannot extend forever.
  graceExtensions: 3,
  // Identical normalized lines within the window before calling it a loop.
  loopRepeatThreshold: 12,
  // How many recent lines to keep for repeat analysis.
  loopWindowLines: 400,
  // Lines shorter than this are ignored by loop detection — spinners, blank
  // separators and "..." repeat legitimately in healthy output.
  loopMinChars: 12,
  // Output is growing but no line we have not already seen. That is churn,
  // the expensive failure mode: tokens spent producing nothing new. Feeds
  // the `no_new_content` check-in detector.
  noNewContentMs: 240000,
  // Past this many bytes, the caller (server.js) spills overflow to a file on
  // disk and keeps only a tail in memory. Not a kill trigger. `maxOutputBytes`
  // is accepted as a legacy alias.
  spillAfterBytes: 12582912,
  // CPU milliseconds across an idle window that count as genuine work.
  cpuActiveMs: 750,
  // Retained for backward-compatible config parsing only. No longer changes
  // behavior: an unsampled idle window is never itself a kill.
  onUnverifiableIdle: 'kill',
  // Provider-reported token/turn ceilings. No default ceiling — nulled out so
  // nothing is enforced unless a caller explicitly supplies one, and even an
  // explicit one is informational only (see `ignoredCaps`); it is never
  // compared against usage to kill a run.
  providerBudget: {
    maxOutputTokens: null,
    maxTotalTokens: null,
    maxCacheReadTokens: null,
    maxCacheCreationTokens: null,
    maxTurns: null,
  },
  // Reserve a small, bounded margin for providers that can accept a mid-run
  // "finalize now" message. No longer triggered automatically by budget
  // proximity (there is no budget kill to race against); `acknowledgeFinalization`
  // remains callable directly by other code paths that want a graceful stop.
  providerBudgetFinalizationReserve: {
    maxOutputTokens: 5000,
    maxTotalTokens: 100000,
    maxCacheReadTokens: 100000,
    maxCacheCreationTokens: 25000,
  },
  // Fixed check-in cadence. A check-in also fires early when provider-reported
  // total tokens have grown by at least checkInTokens since the last one.
  checkInIntervalMs: 300000,
  checkInTokens: 2000000,
  // Consecutive check-ins with no new bytes, no CPU activity, no progress and
  // no token growth before calling a run wedged. Widened when CPU cannot be
  // sampled at all, since silence is then unverifiable.
  wedgedCheckins: 4,
  unsampledWedgedCheckins: 6,
  // Consecutive check-ins where a loop/churn detector fired with no progress.
  loopCheckins: 3,
  // Consecutive check-ins with no progress while tokens grew by burnTokens
  // total across the streak.
  burnCheckins: 2,
  burnTokens: 1000000,
  // 'checkpoint_and_kill' (default) or 'notify'. With 'notify' a triggered
  // rule never kills; it records `stall` once and the run continues.
  stallAction: 'checkpoint_and_kill',
};

function normalizeProviderBudget(value, fallback = DEFAULTS.providerBudget) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const key of Object.keys(BUDGET_FIELDS)) {
    const candidate = Object.prototype.hasOwnProperty.call(source, key) ? source[key] : fallback?.[key];
    if (candidate === null || candidate === undefined) normalized[key] = null;
    else {
      const numeric = Number(candidate);
      normalized[key] = Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
    }
  }
  return normalized;
}

function normalizeFinalizationReserve(value, fallback = DEFAULTS.providerBudgetFinalizationReserve) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const key of Object.keys(DEFAULTS.providerBudgetFinalizationReserve)) {
    const candidate = Object.prototype.hasOwnProperty.call(source, key) ? source[key] : fallback?.[key];
    const numeric = Number(candidate);
    normalized[key] = Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
  }
  return normalized;
}

const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const SPINNER_PATTERN = /[⠀-⣿■-◿|/\\-]+/g;

// Normalizes a line for repeat comparison. Deliberately does NOT strip digits:
// "processed 41 files" and "processed 42 files" are progress, and collapsing
// them to the same key would flag a healthy run as looping.
function normalizeLine(line) {
  return String(line)
    .replace(ANSI_PATTERN, '')
    .replace(/\r/g, '')
    .replace(SPINNER_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function totalProviderTokens(usage) {
  if (!usage) return 0;
  if (Number.isFinite(Number(usage.total_tokens))) return Number(usage.total_tokens);
  return Object.values(usage).reduce((sum, v) => sum + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
}

class RunSupervisor {
  constructor(options = {}) {
    const opts = { ...DEFAULTS, ...options };
    opts.providerBudget = normalizeProviderBudget(options.providerBudget, DEFAULTS.providerBudget);
    opts.providerBudgetFinalizationReserve = normalizeFinalizationReserve(
      options.providerBudgetFinalizationReserve,
      DEFAULTS.providerBudgetFinalizationReserve,
    );
    // Legacy alias: a caller still configuring maxOutputBytes gets it treated
    // as spillAfterBytes rather than silently ignored.
    if (options.spillAfterBytes == null && options.maxOutputBytes != null) {
      opts.spillAfterBytes = options.maxOutputBytes;
    }
    for (const key of ['idleMs', 'noNewContentMs', 'spillAfterBytes', 'checkInIntervalMs', 'checkInTokens',
      'wedgedCheckins', 'unsampledWedgedCheckins', 'loopCheckins', 'burnCheckins', 'burnTokens']) {
      const value = Number(opts[key]);
      if (!Number.isFinite(value) || value <= 0) opts[key] = DEFAULTS[key];
    }
    // hardCapMs is informational only now. Keep it a large, well-formed
    // number so downstream consumers (drain-timeout math, --print-timeout
    // rendering) never divide-by/compare-against something malformed.
    const explicitHardCap = Number(options.hardCapMs);
    opts.hardCapMs = Number.isFinite(explicitHardCap) && explicitHardCap > 0 ? explicitHardCap : Number.MAX_SAFE_INTEGER;
    opts.timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs) : null;
    if (opts.stallAction !== 'notify') opts.stallAction = 'checkpoint_and_kill';
    this.opts = opts;
    this.startedAt = Number.isFinite(options.startedAt) ? options.startedAt : Date.now();
    this.lastOutputAt = this.startedAt;
    this.lastNewContentAt = this.startedAt;
    this.bytes = 0;
    this.lines = 0;
    this.spilling = false;
    this.outputSpillPath = null;
    this.extensionsUsed = 0;
    this.lastCpuMs = null;
    this.lastCpuSampleAt = null;
    this.cpuUnavailable = false;
    this.cpuActiveSinceLastCheckIn = null;
    this.recentLines = [];
    this.seenHashes = new Set();
    this.repeatPeak = 0;
    this.repeatPeakLine = '';
    this.partial = '';
    this.stopped = null;
    this.stall = null;
    this.providerUsage = null;
    this.providerUsagePhase = 'unavailable';
    this.finalizationRequested = null;
    this.progress = new ProgressObserver({ parser: options.progressParser, startedAt: this.startedAt,
      runId: options.runId, attemptId: options.attemptId });
    this.nextAssessmentAt = this.startedAt + this.opts.idleMs;
    this.assessor = { state: 'not_due', count: 0, taskId: null, lastRequestedAt: null };
    this.assessmentEnabled = opts.adaptive === true;
    this.assessmentGeneration = 0;
    this.assessmentProgressAt = this.startedAt;
    // Check-in bookkeeping.
    this.checkins = [];
    this.lastCheckInAt = this.startedAt;
    this.lastCheckInBytes = 0;
    this.lastCheckInTokens = 0;
    this.wedgedStreak = 0;
    this.loopStreak = 0;
    this.burnStreak = 0;
    this.burnStreakTokens = 0;
    this.ignoredCaps = {
      providerBudget: { ...opts.providerBudget },
      hardCapMs: Number.isFinite(explicitHardCap) && explicitHardCap > 0 ? explicitHardCap : null,
      timeoutMs: opts.timeoutMs,
    };
  }

  setAssessmentEnabled(enabled) {
    enabled = enabled === true && this.opts.adaptive === true;
    if (enabled !== this.assessmentEnabled) {
      this.assessmentEnabled = enabled;
      this.assessmentGeneration++;
      this.progress.assessment = null;
      if (enabled) this.assessor.state = this.assessor.taskId ? 'waiting_for_assessor' : 'not_due';
    }
    if (!enabled) this.assessor.state = 'assessor_disabled';
  }

  // Still directly callable by other code paths that want a graceful
  // "finalize now" advisory. No longer auto-triggered by budget proximity.
  acknowledgeFinalization(reserve) {
    if (this.opts.finalizationSupported !== true || this.finalizationRequested || !reserve) return false;
    this.finalizationRequested = { ...reserve };
    return true;
  }

  // Manually invokable graceful-stop request, independent of check-in kill
  // rules. Callers that need to stop a run for a reason outside supervision
  // (quota reservation, permission denial, etc.) still use this.
  requestGracefulFinalization(reserve = {}) {
    this.finalizationRequested = { ...reserve };
    return this.finalizationRequested;
  }

  recordProviderUsage(usage, { phase = 'incremental' } = {}) {
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false;
    const normalized = {};
    for (const field of Object.values(BUDGET_FIELDS)) {
      const candidate = usage[field];
      if (candidate == null) continue;
      const numeric = Number(candidate);
      if (!Number.isSafeInteger(numeric) || numeric < 0) return false;
      normalized[field] = numeric;
    }
    if (!Object.keys(normalized).length) return false;
    this.providerUsage = { ...(this.providerUsage || {}), ...normalized };
    this.providerUsagePhase = phase === 'terminal' ? 'terminal' : 'incremental';
    return true;
  }

  // Records a chunk of stdout/stderr. Byte counting never refuses further
  // input: once bytes exceed spillAfterBytes, `spilling` flips true so the
  // caller (server.js) knows to start appending overflow to a spill file
  // instead of growing the in-memory buffer further. This never kills.
  recordOutput(chunk, now = Date.now(), channel = 'stdout') {
    const text = String(chunk == null ? '' : chunk);
    if (!text) return !this.spilling;
    this.progress.record(text, now, channel);
    this.bytes += Buffer.byteLength(text, 'utf8');
    this.lastOutputAt = now;
    if (this.bytes > this.opts.spillAfterBytes) this.spilling = true;

    // Reassemble across chunk boundaries so a line split mid-write is not
    // counted as two distinct lines by the repeat detector.
    const previousPartialLength = this.partial.length;
    const combined = this.partial + text;
    const segments = combined.split('\n');
    this.partial = segments.pop() ?? '';
    // A very long unterminated line (JSON blob, base64) must not grow forever.
    if (this.partial.length > 65536) {
      segments.push(this.partial);
      this.partial = '';
    }

    if (this.partial.length > previousPartialLength) this.lastNewContentAt = now;
    for (const segment of segments) {
      const normalized = normalizeLine(segment);
      this.lines += 1;
      if (!normalized) continue;
      if (normalized.length >= this.opts.loopMinChars) {
        this.recentLines.push(normalized);
        if (this.recentLines.length > this.opts.loopWindowLines) this.recentLines.shift();
      }
      if (!this.seenHashes.has(normalized)) {
        if (this.seenHashes.size < 20000) this.seenHashes.add(normalized);
        this.lastNewContentAt = now;
      }
    }
    return !this.spilling;
  }

  recordOutputSpillPath(spillPath) {
    this.outputSpillPath = spillPath || null;
  }

  // CPU sampling costs a process spawn on Windows, so the caller only pays for
  // it when the answer can change a decision: the run has gone quiet.
  needsCpuSample(now = Date.now()) {
    if (this.stopped) return false;
    if (now - this.lastOutputAt < this.opts.idleMs * 0.5) return false;
    if (this.lastCpuSampleAt && now - this.lastCpuSampleAt < 20000) return false;
    return true;
  }

  // cpuMs is cumulative CPU time for the whole process tree, or null when it
  // could not be read (non-Windows, permission error, probe timeout).
  recordCpuSample(cpuMs, now = Date.now()) {
    if (cpuMs == null || !Number.isFinite(Number(cpuMs))) {
      this.cpuUnavailable = true;
      this.lastCpuSampleAt = now;
      return;
    }
    const value = Number(cpuMs);
    this.cpuUnavailable = false;
    if (this.lastCpuMs != null && value - this.lastCpuMs >= this.opts.cpuActiveMs) {
      this.cpuActiveSinceLastCheckIn = true;
      this.extensionsUsed += 1;
      if (this.opts.graceExtensions <= 0 || this.extensionsUsed <= this.opts.graceExtensions) this.lastOutputAt = now;
    } else if (this.cpuActiveSinceLastCheckIn == null) {
      this.cpuActiveSinceLastCheckIn = false;
    }
    this.lastCpuMs = value;
    this.lastCpuSampleAt = now;
  }

  maxRepeat() {
    if (!this.recentLines.length) return { count: 0, line: '' };
    const counts = new Map();
    let best = 0;
    let bestLine = '';
    for (const line of this.recentLines) {
      const next = (counts.get(line) || 0) + 1;
      counts.set(line, next);
      if (next > best) { best = next; bestLine = line; }
    }
    if (best > this.repeatPeak) { this.repeatPeak = best; this.repeatPeakLine = bestLine; }
    return { count: best, line: bestLine };
  }

  #checkInDue(now) {
    if (now - this.lastCheckInAt >= this.opts.checkInIntervalMs) return true;
    const tokens = totalProviderTokens(this.providerUsage);
    return tokens - this.lastCheckInTokens >= this.opts.checkInTokens;
  }

  // Runs at a check-in boundary. Computes this interval's detectors, appends
  // a bounded fingerprint to history, updates the three streak counters, and
  // returns a kill/notify verdict when a streak threshold was reached.
  #checkIn(now) {
    const repeat = this.maxRepeat();
    const tokens = totalProviderTokens(this.providerUsage);
    const newBytes = this.bytes - this.lastCheckInBytes;
    const tokenGrowth = tokens - this.lastCheckInTokens;
    const progressed = this.lastNewContentAt > this.lastCheckInAt || this.progress.lastProgressAt > this.lastCheckInAt;

    const detectors = [];
    if (repeat.count >= this.opts.loopRepeatThreshold) detectors.push('repeating');
    if (now - this.lastNewContentAt >= this.opts.noNewContentMs) detectors.push('no_new_content');
    if (now - this.lastOutputAt >= this.opts.idleMs) detectors.push('silent');
    if (this.cpuActiveSinceLastCheckIn === false) detectors.push('cpu_idle');
    if (!progressed) detectors.push('no_progress');

    // A current-generation productive assessment verdict resets every streak.
    const productiveAssessment = this.progress.assessment
      && this.progress.assessment.verdict === 'productive'
      && this.progress.assessment.materialGeneration === this.progress.materialGeneration;

    if (progressed || productiveAssessment) {
      this.wedgedStreak = 0;
      this.loopStreak = 0;
      this.burnStreak = 0;
      this.burnStreakTokens = 0;
    } else {
      const cpuConfirmedIdle = this.cpuActiveSinceLastCheckIn === false;
      const cpuUnsampled = this.cpuActiveSinceLastCheckIn == null || this.cpuUnavailable;
      const noNewBytes = newBytes <= 0;
      const noTokenGrowth = tokenGrowth <= 0;
      if (noNewBytes && noTokenGrowth && (cpuConfirmedIdle || cpuUnsampled)) {
        this.wedgedStreak += 1;
      } else {
        this.wedgedStreak = 0;
      }
      if (detectors.includes('repeating') || detectors.includes('no_new_content')) {
        this.loopStreak += 1;
      } else {
        this.loopStreak = 0;
      }
      this.burnStreak += 1;
      this.burnStreakTokens += Math.max(0, tokenGrowth);
    }

    const concern = detectors.length > 0;
    const fingerprint = {
      at: now,
      bytes: this.bytes,
      lastNewContentAt: this.lastNewContentAt,
      progress: { lastProgressAt: this.progress.lastProgressAt, lastToolActivityAt: this.progress.lastToolActivityAt },
      cpuActiveSinceLast: this.cpuActiveSinceLast === undefined ? null : this.cpuActiveSinceLastCheckIn,
      totalTokens: tokens,
      repeatCount: repeat.count,
      assessment: this.progress.assessment ? this.progress.assessment.verdict : null,
      verdict: concern ? 'concern' : 'clean',
      detectors,
    };
    this.checkins.push(fingerprint);
    if (this.checkins.length > 20) this.checkins.shift();

    if (concern && this.assessmentEnabled) this.nextAssessmentAt = now;

    this.lastCheckInAt = now;
    this.lastCheckInBytes = this.bytes;
    this.lastCheckInTokens = tokens;
    this.cpuActiveSinceLastCheckIn = null;

    const requiredWedged = this.cpuUnavailable ? this.opts.unsampledWedgedCheckins : this.opts.wedgedCheckins;
    if (this.wedgedStreak >= requiredWedged) {
      return this.#stopOrNotify('wedged',
        `${this.wedgedStreak} consecutive check-ins with no new bytes, no CPU activity, no progress and no token growth`,
        now);
    }
    if (this.loopStreak >= this.opts.loopCheckins) {
      return this.#stopOrNotify('loop_confirmed',
        `${this.loopStreak} consecutive check-ins showed repeating/no-new-content output with no progress`,
        now);
    }
    if (this.burnStreak >= this.opts.burnCheckins && this.burnStreakTokens >= this.opts.burnTokens) {
      return this.#stopOrNotify('burn_without_progress',
        `${this.burnStreak} consecutive check-ins with no progress burned ${this.burnStreakTokens} tokens`,
        now);
    }
    return null;
  }

  // Inspection does not consume finalization. The live-input adapter must
  // acknowledge delivery intent; usage observers and status reads cannot eat it.
  evaluate(now = Date.now()) {
    if (this.stopped) return this.stopped;

    // Rule (d): assessor_stuck is checked at any time, not gated to a
    // check-in boundary.
    if (this.opts.adaptive === true && this.assessmentEnabled
        && this.progress.corroboratedStall(now, this.opts.noNewContentMs)) {
      const verdict = this.#stopOrNotify('assessor_stuck',
        'Current progress assessment and sustained repeated failures or repetition support stopping.', now);
      if (verdict) return verdict;
    }

    if (this.#checkInDue(now)) {
      const verdict = this.#checkIn(now);
      if (verdict) return verdict;
    }

    return { action: 'continue',
      reason: this.opts.adaptive === true && now >= this.nextAssessmentAt ? 'assessment_due' : this.phase(now),
      detail: '' };
  }

  #stopOrNotify(reason, detail, now) {
    const evidence = this.checkins.slice(-5);
    if (this.opts.stallAction === 'notify') {
      if (!this.stall) this.stall = { reason, detail, at: now };
      return { action: 'continue', reason: 'stall_notified', detail };
    }
    this.stopped = { action: 'kill', reason, detail, evidence };
    return this.stopped;
  }

  // Coarse state for humans watching the dashboard.
  phase(now = Date.now()) {
    if (this.stopped) return this.stopped.reason;
    const idle = now - this.lastOutputAt;
    if (this.bytes === 0) return idle >= this.opts.idleMs * 0.5 ? 'quiet_start' : 'starting';
    if (idle < 15000) return 'streaming';
    const repeat = this.repeatPeak;
    if (repeat >= Math.max(3, Math.floor(this.opts.loopRepeatThreshold / 2))) return 'suspect_loop';
    if (idle >= this.opts.idleMs * 0.5) return 'quiet';
    return 'working';
  }

  // Snapshot for /api/runs/active so a human can vet a run instead of guessing.
  snapshot(now = Date.now()) {
    const idle = now - this.lastOutputAt;
    return {
      phase: this.phase(now),
      ageMs: now - this.startedAt,
      idleMs: idle,
      bytes: this.bytes,
      lines: this.lines,
      repeatPeak: this.repeatPeak,
      staleContentMs: this.bytes > 0 ? now - this.lastNewContentAt : 0,
      extensionsUsed: this.extensionsUsed,
      cpuMs: this.lastCpuMs,
      cpuUnavailable: this.cpuUnavailable,
      spilling: this.spilling,
      outputSpillPath: this.outputSpillPath,
      providerBudget: { ...this.opts.providerBudget },
      providerUsage: this.providerUsage ? { ...this.providerUsage } : null,
      providerUsagePhase: this.providerUsagePhase,
      finalizationRequested: this.finalizationRequested ? { ...this.finalizationRequested } : null,
      adaptive: this.opts.adaptive === true,
      progress: this.progress.snapshot(now),
      assessor: { ...this.assessor, enabled: this.assessmentEnabled, verdict: this.progress.assessment,
        stale: !!this.progress.assessment && (!this.assessmentEnabled
          || this.progress.assessment.materialGeneration !== this.progress.materialGeneration) },
      nextAssessmentAt: this.opts.adaptive === true ? this.nextAssessmentAt : null,
      checkins: this.checkins.map((c) => ({ ...c, progress: { ...c.progress } })),
      stall: this.stall ? { ...this.stall } : null,
      ignoredCaps: { providerBudget: { ...this.ignoredCaps.providerBudget },
        hardCapMs: this.ignoredCaps.hardCapMs, timeoutMs: this.ignoredCaps.timeoutMs },
      stopped: this.stopped ? { reason: this.stopped.reason, detail: this.stopped.detail } : null,
    };
  }
}

// Per-provider overrides sit on the config entry; global defaults live under
// the "_supervisor" key in cli-config.json. An explicit request timeoutMs is
// recorded (via ignoredCaps) but never enforced as a deadline.
function resolveSupervisorOptions({ entry = {}, globals = {}, providerBudget, taskTier = null, hardCapMs = null, startedAt } = {}) {
  const merged = { ...DEFAULTS, ...globals, ...(entry.supervisor || {}) };
  merged.adaptive = globals.adaptive !== false && entry.supervisor?.adaptive !== false;
  // hardDeadline is informational only now (RunSupervisor.evaluate() never
  // reads it to kill). Kept faithful to the pre-uncap layering so other
  // owners' consumers (task-plan.js effectiveTimeoutMs, attempt-lifecycle.js
  // drain-timeout math) see the same shape as before.
  const configuredCap = entry.supervisor?.hardCapMs ?? globals.hardCapMs;
  merged.hardDeadline = !merged.adaptive || globals.hardDeadline === true || entry.supervisor?.hardDeadline === true
    || Object.hasOwn(entry.supervisor || {}, 'hardCapMs') || configuredCap != null && configuredCap !== DEFAULTS.hardCapMs
    || hardCapMs != null;
  const providerDefaults = normalizeProviderBudget(entry.supervisor?.providerBudget,
    normalizeProviderBudget(globals.providerBudget, DEFAULTS.providerBudget));
  const tierDefaults = taskTier && entry.supervisor?.providerBudgetByTaskTier
    ? entry.supervisor.providerBudgetByTaskTier[taskTier]
    : undefined;
  merged.providerBudget = normalizeProviderBudget(
    providerBudget,
    normalizeProviderBudget(tierDefaults, providerDefaults),
  );
  merged.providerBudgetFinalizationReserve = normalizeFinalizationReserve(
    entry.supervisor?.providerBudgetFinalizationReserve,
    normalizeFinalizationReserve(
      globals.providerBudgetFinalizationReserve,
      DEFAULTS.providerBudgetFinalizationReserve,
    ),
  );
  // Informational only: an explicit caller/timeout ceiling is recorded via
  // ignoredCaps (see RunSupervisor constructor) but is never enforced.
  if (Number.isFinite(Number(hardCapMs)) && Number(hardCapMs) > 0) {
    merged.hardCapMs = Number(hardCapMs);
  }
  if (startedAt != null) merged.startedAt = startedAt;
  return merged;
}

module.exports = {
  RunSupervisor,
  resolveSupervisorOptions,
  normalizeLine,
  normalizeProviderBudget,
  normalizeFinalizationReserve,
  DEFAULTS,
};
