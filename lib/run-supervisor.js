'use strict';

// Liveness supervision for provider runs.
//
// A single wall-clock timeout is the wrong instrument for agentic CLIs. A
// three-minute cap kills a model halfway through a legitimate long task, and
// raising it to thirty minutes just means a CLI wedged in a repeat loop burns
// tokens for thirty minutes instead. Elapsed time cannot tell those apart
// because it is not the variable that matters.
//
// This module asks the two questions the bridge actually cares about:
//
//   Is it making progress?  -> leave it alone, let it finish
//   Is it stuck or looping? -> kill it now and record why
//
// Progress is read from real signals (new output bytes, new *unique* content,
// and optionally CPU advance of the process tree) rather than from the clock.
// A run that keeps producing new content is never cut off mid-task; a run that
// goes silent or starts repeating itself is stopped long before the ceiling.
//
// Pure logic on purpose: no timers, no process handles, no I/O. The caller
// feeds it observations and a clock, which makes every decision path unit
// testable without spawning anything.

const DEFAULTS = {
  // No new output for this long makes a run *suspect* â€” not yet dead. Print
  // mode CLIs (claude -p, codex, cursor agent -p) buffer their whole answer
  // and emit nothing until the end, so this has to be generous.
  idleMs: 1200000,
  // Absolute ceiling. Nothing runs past this regardless of how healthy it
  // looks; it is the backstop against a run that produces output forever.
  hardCapMs: 2700000,
  // Extra idle windows granted when CPU sampling proves the tree is working
  // while silent. Bounded so a busy-spinning process cannot extend forever.
  graceExtensions: 3,
  // Identical normalized lines within the window before calling it a loop.
  loopRepeatThreshold: 12,
  // How many recent lines to keep for repeat analysis.
  loopWindowLines: 400,
  // Lines shorter than this are ignored by loop detection â€” spinners, blank
  // separators and "..." repeat legitimately in healthy output.
  loopMinChars: 12,
  // Output is growing but no line we have not already seen. That is churn,
  // the expensive failure mode: tokens spent producing nothing new.
  noNewContentMs: 240000,
  // Guards bridge memory. The one-shot path accumulates output in a string,
  // so a runaway CLI would otherwise grow the heap without limit.
  maxOutputBytes: 12582912,
  // CPU milliseconds across an idle window that count as genuine work.
  cpuActiveMs: 750,
  // When a run is idle and CPU could not be sampled, we cannot distinguish
  // "thinking quietly" from "wedged". Default to stopping, because the whole
  // point is not paying for a stuck stage.
  onUnverifiableIdle: 'kill',
  // Provider-reported token/turn ceilings. These are independent from output
  // byte estimates: only authoritative usage emitted by the provider may trip
  // them. A null value disables one dimension.
  providerBudget: {
    maxOutputTokens: 100000,
    maxTotalTokens: 3000000,
    maxCacheReadTokens: 2500000,
    maxCacheCreationTokens: 500000,
    // Turns ship disabled. A turn count is not a cost: an agentic CLI spends
    // one turn per tool call, so a healthy Claude run reads a dozen files and
    // reports num_turns well past any small number while staying far below
    // every token ceiling above. A fixed default turn cap therefore killed
    // complete, successful terminal results and produced no saving that the
    // token ceilings were not already making. Cost is still bounded by
    // tokens, and liveness by progress, idle, loop, output and hard-cap
    // checks. An operator, a provider entry, or one request may still set an
    // explicit positive maxTurns, and it is enforced exactly as before.
    maxTurns: null,
  },
  // Reserve a small, bounded margin for providers that can accept a mid-run
  // "finalize now" message. This never raises a hard budget: the ordinary
  // providerBudget check still kills at the same ceiling. The effective
  // reserve is additionally capped at 10% of a caller's selected limit so a
  // small per-run budget cannot be consumed entirely by finalization.
  providerBudgetFinalizationReserve: {
    maxOutputTokens: 5000,
    maxTotalTokens: 100000,
    maxCacheReadTokens: 100000,
    maxCacheCreationTokens: 25000,
  },
};

const BUDGET_FIELDS = Object.freeze({
  maxOutputTokens: 'output_tokens',
  maxTotalTokens: 'total_tokens',
  maxCacheReadTokens: 'cache_read_input_tokens',
  maxCacheCreationTokens: 'cache_creation_input_tokens',
  maxTurns: 'turns',
});

function normalizeProviderBudget(value, fallback = DEFAULTS.providerBudget) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const key of Object.keys(BUDGET_FIELDS)) {
    const candidate = Object.prototype.hasOwnProperty.call(source, key) ? source[key] : fallback?.[key];
    if (candidate === null) normalized[key] = null;
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
const SPINNER_PATTERN = /[\u2800-\u28ff\u25a0-\u25ff|/\\-]+/g;

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

class RunSupervisor {
  constructor(options = {}) {
    const opts = { ...DEFAULTS, ...options };
    opts.providerBudget = normalizeProviderBudget(options.providerBudget, DEFAULTS.providerBudget);
    opts.providerBudgetFinalizationReserve = normalizeFinalizationReserve(
      options.providerBudgetFinalizationReserve,
      DEFAULTS.providerBudgetFinalizationReserve,
    );
    for (const key of ['idleMs', 'hardCapMs', 'noNewContentMs', 'maxOutputBytes']) {
      const value = Number(opts[key]);
      if (!Number.isFinite(value) || value <= 0) opts[key] = DEFAULTS[key];
    }
    // A hard cap below the idle window would make the idle logic unreachable.
    if (opts.hardCapMs < opts.idleMs) opts.hardCapMs = opts.idleMs;
    this.opts = opts;
    this.startedAt = Number.isFinite(options.startedAt) ? options.startedAt : Date.now();
    this.lastOutputAt = this.startedAt;
    this.lastNewContentAt = this.startedAt;
    this.bytes = 0;
    this.lines = 0;
    this.truncated = false;
    this.extensionsUsed = 0;
    this.lastCpuMs = null;
    this.lastCpuSampleAt = null;
    this.cpuUnavailable = false;
    this.recentLines = [];
    this.seenHashes = new Set();
    this.repeatPeak = 0;
    this.repeatPeakLine = '';
    this.partial = '';
    this.stopped = null;
    this.providerUsage = null;
    this.providerUsagePhase = 'unavailable';
    this.finalizationRequested = null;
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

  // Records a chunk of stdout/stderr. Returns whether the chunk should still
  // be accumulated by the caller â€” false once the output cap is hit, so the
  // bridge stops growing the buffer even before the kill lands.
  recordOutput(chunk, now = Date.now()) {
    const text = String(chunk == null ? '' : chunk);
    if (!text) return !this.truncated;
    this.bytes += Buffer.byteLength(text, 'utf8');
    this.lastOutputAt = now;
    if (this.bytes > this.opts.maxOutputBytes) this.truncated = true;

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
      if (!normalized || normalized.length < this.opts.loopMinChars) continue;
      this.recentLines.push(normalized);
      if (this.recentLines.length > this.opts.loopWindowLines) this.recentLines.shift();
      if (!this.seenHashes.has(normalized)) {
        // Cap the seen-set so a long healthy run cannot grow it unbounded.
        if (this.seenHashes.size < 20000) this.seenHashes.add(normalized);
        this.lastNewContentAt = now;
      }
    }
    return !this.truncated;
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
      // Real work happened while silent. Treat it as progress: this is the
      // signal that separates "model is thinking" from "process is wedged".
      this.extensionsUsed += 1;
      if (this.opts.graceExtensions <= 0 || this.extensionsUsed <= this.opts.graceExtensions) this.lastOutputAt = now;
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

  // The decision. Returns { action: 'continue' | 'kill', reason, detail }.
  evaluate(now = Date.now()) {
    if (this.stopped) return this.stopped;
    const age = now - this.startedAt;
    const idle = now - this.lastOutputAt;

    if (this.providerUsage) {
      for (const [budgetField, usageField] of Object.entries(BUDGET_FIELDS)) {
        const limit = this.opts.providerBudget[budgetField];
        const observed = this.providerUsage[usageField];
        if (limit != null && observed != null && observed > limit) {
          return this.#stop('token_budget',
            `provider-reported ${usageField} ${observed} exceeded ${budgetField} ${limit} (${this.providerUsagePhase})`);
        }
      }
      if (!this.finalizationRequested && this.providerUsagePhase === 'incremental') {
        for (const [budgetField, configuredReserve] of Object.entries(this.opts.providerBudgetFinalizationReserve)) {
          const usageField = BUDGET_FIELDS[budgetField];
          const limit = this.opts.providerBudget[budgetField];
          const observed = this.providerUsage[usageField];
          if (limit == null || observed == null || configuredReserve <= 0) continue;
          const reserve = Math.min(configuredReserve, Math.max(1, Math.floor(limit / 10)));
          const threshold = limit - reserve;
          if (observed >= threshold) {
            this.finalizationRequested = { budgetField, usageField, observed, limit, reserve, threshold };
            return {
              action: 'finalize',
              reason: 'token_budget_reserve',
              detail: `provider-reported ${usageField} ${observed} reached finalization reserve ${threshold}/${limit}`,
              reserve: { ...this.finalizationRequested },
            };
          }
        }
      }
    }

    if (this.truncated) {
      return this.#stop('output_cap',
        `output exceeded ${Math.round(this.opts.maxOutputBytes / 1048576)} MB (${this.bytes} bytes) â€” treating as runaway output`);
    }

    if (age >= this.opts.hardCapMs) {
      return this.#stop('hard_cap',
        `hit the ${Math.round(this.opts.hardCapMs / 60000)} min absolute ceiling after ${this.lines} lines of output`);
    }

    // Loop checks run before the idle check: a looping run is *producing*
    // output, so idle logic would never catch it, and it is the case that
    // actually wastes tokens.
    const repeat = this.maxRepeat();
    if (repeat.count >= this.opts.loopRepeatThreshold) {
      return this.#stop('loop_detected',
        `the same line repeated ${repeat.count} times: "${repeat.line.slice(0, 120)}"`);
    }

    const outputIsFlowing = idle < Math.min(this.opts.idleMs, 60000);
    if (this.bytes > 0 && outputIsFlowing && now - this.lastNewContentAt >= this.opts.noNewContentMs) {
      return this.#stop('loop_detected',
        `${Math.round((now - this.lastNewContentAt) / 1000)}s of output with nothing new in it â€” repeating known content`);
    }

    if (idle >= this.opts.idleMs) {
      if (this.cpuUnavailable && idle < this.opts.idleMs * (Number(this.opts.unverifiedIdleMultiplier) || 3)) {
        return { action: "continue", reason: "unverified_idle", detail: "silent but CPU could not be sampled; widening the window before stopping" };
      }
      // Silent, but CPU may prove it is working. If we cannot tell, the
      // configured policy decides; default is to stop rather than pay.
      if (this.cpuUnavailable && this.opts.onUnverifiableIdle === 'continue') {
        return { action: 'continue', reason: 'unverified_idle', detail: 'idle but CPU could not be sampled; policy is to wait' };
      }
      if (this.extensionsUsed >= this.opts.graceExtensions && this.opts.graceExtensions > 0) {
        return this.#stop('idle_stall',
          `silent for ${Math.round(idle / 1000)}s after ${this.extensionsUsed} grace extensions â€” no longer making progress`);
      }
      return this.#stop('idle_stall',
        `no output for ${Math.round(idle / 1000)}s with no CPU activity â€” the stage looks wedged`);
    }

    return { action: 'continue', reason: this.phase(now), detail: '' };
  }

  #stop(reason, detail) {
    this.stopped = { action: 'kill', reason, detail };
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
      truncated: this.truncated,
      providerBudget: { ...this.opts.providerBudget },
      providerUsage: this.providerUsage ? { ...this.providerUsage } : null,
      providerUsagePhase: this.providerUsagePhase,
      finalizationRequested: this.finalizationRequested ? { ...this.finalizationRequested } : null,
      // What the user most wants to know: how long before this gets stopped,
      // and which limit will stop it first.
      idleBudgetMs: Math.max(0, this.opts.idleMs - idle),
      hardCapRemainingMs: Math.max(0, this.opts.hardCapMs - (now - this.startedAt)),
      stopped: this.stopped ? { reason: this.stopped.reason, detail: this.stopped.detail } : null,
    };
  }
}

// Per-provider overrides sit on the config entry; global defaults live under
// the "_supervisor" key in cli-config.json. An explicit request timeoutMs is
// honored as the hard cap so existing callers keep control.
function resolveSupervisorOptions({ entry = {}, globals = {}, providerBudget, hardCapMs = null, startedAt } = {}) {
  const merged = { ...DEFAULTS, ...globals, ...(entry.supervisor || {}) };
  merged.providerBudget = normalizeProviderBudget(
    providerBudget,
    normalizeProviderBudget(entry.supervisor?.providerBudget,
      normalizeProviderBudget(globals.providerBudget, DEFAULTS.providerBudget)),
  );
  merged.providerBudgetFinalizationReserve = normalizeFinalizationReserve(
    entry.supervisor?.providerBudgetFinalizationReserve,
    normalizeFinalizationReserve(
      globals.providerBudgetFinalizationReserve,
      DEFAULTS.providerBudgetFinalizationReserve,
    ),
  );
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
