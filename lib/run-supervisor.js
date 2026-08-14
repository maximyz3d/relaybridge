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
  // No new output for this long makes a run *suspect* — not yet dead. Print
  // mode CLIs (claude -p, codex, cursor agent -p) buffer their whole answer
  // and emit nothing until the end, so this has to be generous.
  idleMs: 360000,
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
  // Lines shorter than this are ignored by loop detection — spinners, blank
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
};

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
  }

  // Records a chunk of stdout/stderr. Returns whether the chunk should still
  // be accumulated by the caller — false once the output cap is hit, so the
  // bridge stops growing the buffer even before the kill lands.
  recordOutput(chunk, now = Date.now()) {
    const text = String(chunk == null ? '' : chunk);
    if (!text) return !this.truncated;
    this.bytes += Buffer.byteLength(text, 'utf8');
    this.lastOutputAt = now;
    if (this.bytes > this.opts.maxOutputBytes) this.truncated = true;

    // Reassemble across chunk boundaries so a line split mid-write is not
    // counted as two distinct lines by the repeat detector.
    const combined = this.partial + text;
    const segments = combined.split('\n');
    this.partial = segments.pop() ?? '';
    // A very long unterminated line (JSON blob, base64) must not grow forever.
    if (this.partial.length > 65536) {
      segments.push(this.partial);
      this.partial = '';
    }

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
      this.lastOutputAt = now;
      this.extensionsUsed += 1;
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

    if (this.truncated) {
      return this.#stop('output_cap',
        `output exceeded ${Math.round(this.opts.maxOutputBytes / 1048576)} MB (${this.bytes} bytes) — treating as runaway output`);
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

    if (this.bytes > 0 && now - this.lastNewContentAt >= this.opts.noNewContentMs) {
      return this.#stop('loop_detected',
        `${Math.round((now - this.lastNewContentAt) / 1000)}s of output with nothing new in it — repeating known content`);
    }

    if (idle >= this.opts.idleMs) {
      // Silent, but CPU may prove it is working. If we cannot tell, the
      // configured policy decides; default is to stop rather than pay.
      if (this.cpuUnavailable && this.opts.onUnverifiableIdle === 'continue') {
        return { action: 'continue', reason: 'unverified_idle', detail: 'idle but CPU could not be sampled; policy is to wait' };
      }
      if (this.extensionsUsed >= this.opts.graceExtensions && this.opts.graceExtensions > 0) {
        return this.#stop('idle_stall',
          `silent for ${Math.round(idle / 1000)}s after ${this.extensionsUsed} grace extensions — no longer making progress`);
      }
      return this.#stop('idle_stall',
        `no output for ${Math.round(idle / 1000)}s with no CPU activity — the stage looks wedged`);
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
function resolveSupervisorOptions({ entry = {}, globals = {}, hardCapMs = null, startedAt } = {}) {
  const merged = { ...DEFAULTS, ...globals, ...(entry.supervisor || {}) };
  if (Number.isFinite(Number(hardCapMs)) && Number(hardCapMs) > 0) {
    merged.hardCapMs = Number(hardCapMs);
  }
  if (startedAt != null) merged.startedAt = startedAt;
  return merged;
}

module.exports = { RunSupervisor, resolveSupervisorOptions, normalizeLine, DEFAULTS };
