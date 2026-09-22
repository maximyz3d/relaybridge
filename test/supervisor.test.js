'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { RunSupervisor, resolveSupervisorOptions, DEFAULTS } = require('../lib/run-supervisor');

const T0 = 1000000;

function make(overrides = {}) {
  return new RunSupervisor({ startedAt: T0, ...overrides });
}

// ---- no run is stopped by elapsed time, token count or output bytes -------

test('a run that keeps producing new content is never stopped mid-task, even past every former cap', () => {
  const s = make({ idleMs: 60000, hardCapMs: 3600000, checkInIntervalMs: 300000 });
  let now = T0;
  // Twenty minutes of steady, varied output, spanning several check-in
  // boundaries -- well past every retired clock-based cap.
  for (let i = 0; i < 240; i++) {
    now += 5000;
    s.recordOutput(`step ${i}: editing module number ${i} and running its checks\n`, now);
    const verdict = s.evaluate(now);
    assert.equal(verdict.action, 'continue', `killed at minute ${(now - T0) / 60000}: ${verdict.reason}`);
  }
  assert.equal(s.phase(now), 'streaming');
  assert.equal(s.stopped, null);
});

test('output past spillAfterBytes keeps recording and never kills; caller spills to disk instead', () => {
  const s = make({ spillAfterBytes: 100, checkInIntervalMs: 999999999 });
  let now = T0;
  let lastAccepted = true;
  for (let i = 0; i < 20; i++) {
    now += 10;
    lastAccepted = s.recordOutput(`unique padding line number ${i} ` + 'x'.repeat(20) + '\n', now);
  }
  assert.equal(lastAccepted, false, 'caller is told to start spilling once past the threshold');
  assert.equal(s.spilling, true);
  assert.equal(s.evaluate(now).action, 'continue');
  s.recordOutputSpillPath('/tmp/run-1/output.spill');
  assert.equal(s.snapshot(now).outputSpillPath, '/tmp/run-1/output.spill');
  assert.equal(s.snapshot(now).spilling, true);
});

test('the old maxOutputBytes key is accepted as an alias for spillAfterBytes', () => {
  const s = make({ maxOutputBytes: 50 });
  assert.equal(s.opts.spillAfterBytes, 50);
});

// ---- ignoredCaps: configured budgets/hardCap/timeout are recorded, never enforced ----

test('configured providerBudget, hardCapMs and timeoutMs are exposed via ignoredCaps and never enforced', () => {
  const s = make({
    hardCapMs: 5000,
    timeoutMs: 3000,
    checkInIntervalMs: 60000,
    providerBudget: { maxTotalTokens: 10, maxOutputTokens: 5, maxCacheReadTokens: null, maxCacheCreationTokens: null, maxTurns: null },
  });
  assert.equal(s.ignoredCaps.hardCapMs, 5000);
  assert.equal(s.ignoredCaps.timeoutMs, 3000);
  assert.equal(s.ignoredCaps.providerBudget.maxTotalTokens, 10);
  s.recordProviderUsage({ total_tokens: 999999 }, { phase: 'incremental' });
  s.recordOutput('healthy progress line one\n', T0 + 1000);
  const verdict = s.evaluate(T0 + 3600000); // far past both hardCapMs and timeoutMs
  assert.equal(verdict.action, 'continue');
  const snap = s.snapshot(T0 + 3600000);
  assert.deepEqual(snap.ignoredCaps.providerBudget.maxTotalTokens, 10);
  assert.equal(snap.ignoredCaps.hardCapMs, 5000);
});

test('unconfigured hardCapMs/timeoutMs/providerBudget report as null in ignoredCaps', () => {
  const s = make();
  assert.equal(s.ignoredCaps.hardCapMs, null);
  assert.equal(s.ignoredCaps.timeoutMs, null);
  for (const field of Object.keys(DEFAULTS.providerBudget)) assert.equal(s.ignoredCaps.providerBudget[field], null);
});

test('DEFAULTS.providerBudget ships with no enforced ceiling on any field, including maxTurns', () => {
  for (const field of Object.keys(DEFAULTS.providerBudget)) {
    assert.equal(DEFAULTS.providerBudget[field], null, `${field} must not carry a default ceiling`);
  }
  assert.equal(DEFAULTS.hardCapMs, null, 'no default hard cap is enforced');
});

test('a hard cap configured well below the idle window is preserved as-is, not clamped', () => {
  // There is nothing left to trap a run under any more, so the old
  // idle-window correction no longer applies -- the informational value is
  // simply recorded verbatim.
  const s = make({ idleMs: 300000, hardCapMs: 1000 });
  assert.equal(s.opts.hardCapMs, 1000);
  assert.equal(s.ignoredCaps.hardCapMs, 1000);
});

// ---- check-in cadence -------------------------------------------------

test('check-ins fire at the fixed interval and also early on a large token jump', () => {
  const s = make({ checkInIntervalMs: 60000, checkInTokens: 500000 });
  s.recordOutput('start\n', T0 + 1000);
  // Not yet due: neither interval nor token growth threshold reached.
  s.evaluate(T0 + 1000);
  assert.equal(s.checkins.length, 0);
  // A big token jump forces an early check-in even though the interval has
  // not elapsed.
  s.recordProviderUsage({ total_tokens: 600000 }, { phase: 'incremental' });
  s.evaluate(T0 + 5000);
  assert.equal(s.checkins.length, 1);
});

// ---- rule (a): wedged ---------------------------------------------------

test('wedged fires after wedgedCheckins consecutive check-ins with no bytes, CPU, progress or tokens', () => {
  const s = make({ checkInIntervalMs: 60000, wedgedCheckins: 3 });
  let now = T0;
  let verdict;
  for (let i = 0; i < 3; i++) {
    now += 60000;
    s.recordCpuSample(0, now); // confirmed idle each check-in window
    verdict = s.evaluate(now);
    if (i < 2) assert.equal(verdict.action, 'continue', `stopped early at check-in ${i + 1}`);
  }
  assert.equal(verdict.action, 'kill');
  assert.equal(verdict.reason, 'wedged');
  assert.ok(Array.isArray(verdict.evidence) && verdict.evidence.length > 0, 'kill carries check-in evidence');
});

test('CPU activity while silent prevents the wedged streak from accumulating', () => {
  const s = make({ checkInIntervalMs: 60000, wedgedCheckins: 2, cpuActiveMs: 500 });
  let now = T0;
  let cpu = 0;
  for (let i = 0; i < 4; i++) {
    now += 60000;
    cpu += 1000; // well above cpuActiveMs each interval: genuine work while silent
    s.recordCpuSample(cpu, now);
    assert.equal(s.evaluate(now).action, 'continue', `wrongly stopped at check-in ${i + 1}`);
  }
});

// S4 (Refs #133): unverifiable CPU silence is never sufficient evidence for a
// wedged kill. It still checks in and raises an incident marker
// (unsampledStall) once the wider unsampledWedgedCheckins threshold is
// reached, but evaluate() must keep returning 'continue' throughout -- a
// silent run with unsampled CPU is never killed via the wedged path.
test('when CPU cannot be sampled at all, silence never kills as wedged -- it raises an incident marker instead', () => {
  // loopCheckins/noNewContentMs stay at their generous defaults so the only
  // corroborated rule in reach across these 4 check-ins is the unsampled
  // wedged path itself -- isolating that it alone never kills.
  const s = make({ checkInIntervalMs: 60000, wedgedCheckins: 2, unsampledWedgedCheckins: 4 });
  let now = T0;
  let verdict;
  for (let i = 0; i < 4; i++) {
    now += 60000;
    s.recordCpuSample(null, now); // unverifiable
    verdict = s.evaluate(now);
    assert.equal(verdict.action, 'continue', `unsampled CPU silence must never kill (check-in ${i + 1})`);
    assert.notEqual(verdict.reason, 'wedged');
  }
  const snapshot = s.snapshot(now);
  assert.ok(snapshot.unsampledStall, 'incident marker set after unsampledWedgedCheckins');
  assert.equal(snapshot.unsampledStall.reason, 'unsampled_wedged');
  assert.equal(snapshot.stall, null, 'stallAction default never sets the notify-kill stall field');
});

// ---- rule (b): loop_confirmed -------------------------------------------

test('loop_confirmed fires after loopCheckins consecutive repeating/no-new-content check-ins with no progress', () => {
  // The line's very first occurrence is genuine new content (progress), so
  // it takes one extra cycle beyond loopCheckins before the repeat-with-no-
  // progress streak can reach the threshold.
  const s = make({ checkInIntervalMs: 60000, loopCheckins: 2, loopRepeatThreshold: 3 });
  let now = T0;
  let verdict;
  for (let cycle = 0; cycle < 3; cycle++) {
    for (let i = 0; i < 4; i++) {
      now += 1000;
      s.recordOutput('Retrying the same tool call after the previous attempt failed\n', now);
    }
    now = T0 + (cycle + 1) * 60000;
    verdict = s.evaluate(now);
    if (cycle < 2) assert.equal(verdict.action, 'continue', `stopped early at cycle ${cycle}`);
  }
  assert.equal(verdict.action, 'kill');
  assert.equal(verdict.reason, 'loop_confirmed');
});

test('output that keeps growing without ever saying anything new is caught by no_new_content, not by progress', () => {
  const known = ['alpha line of content here', 'beta line of content here', 'gamma line of content here'];
  const s = make({ checkInIntervalMs: 60000, loopCheckins: 2, noNewContentMs: 30000, loopRepeatThreshold: 500 });
  let now = T0;
  let verdict;
  for (let cycle = 0; cycle < 3; cycle++) {
    for (let i = 0; i < 3; i++) {
      now += 1000;
      s.recordOutput(known[i % known.length] + '\n', now);
    }
    now = T0 + (cycle + 1) * 60000;
    verdict = s.evaluate(now);
    if (cycle < 2) assert.equal(verdict.action, 'continue', `stopped early at cycle ${cycle}`);
  }
  assert.equal(verdict.action, 'kill');
  assert.equal(verdict.reason, 'loop_confirmed');
});

test('progress lines that differ only by a counter are not mistaken for a loop', () => {
  const s = make({ checkInIntervalMs: 60000, loopRepeatThreshold: 8 });
  let now = T0;
  for (let i = 0; i < 60; i++) {
    now += 500;
    s.recordOutput(`processed ${i} of 60 files in the workspace\n`, now);
  }
  now = T0 + 60000;
  assert.equal(s.evaluate(now).action, 'continue');
});

// ---- loop-detection primitives (unchanged by the check-in redesign) -------

test('a repeating line is tracked by maxRepeat even though output keeps flowing', () => {
  const s = make();
  let now = T0;
  for (let i = 0; i < 8; i++) {
    now += 1000;
    s.recordOutput('Retrying tool call because the previous attempt failed\n', now);
  }
  assert.equal(s.maxRepeat().count, 8);
});

test('spinner and ANSI noise does not count as repeated content', () => {
  const s = make();
  let now = T0;
  for (const frame of ['|', '/', '-', '\\', '|', '/', '-', '\\']) {
    now += 500;
    s.recordOutput(`\u001b[2K\r${frame}\n`, now);
  }
  assert.equal(s.maxRepeat().count, 0);
});

test('lines split across chunk boundaries are reassembled before repeat analysis', () => {
  const s = make();
  let now = T0;
  for (let i = 0; i < 3; i++) {
    now += 100;
    s.recordOutput('the identical repeated ', now);
    s.recordOutput('sentence appears again\n', now);
  }
  assert.equal(s.maxRepeat().count, 3);
});

// ---- rule (c): burn_without_progress ------------------------------------

test('burn_without_progress fires after burnCheckins consecutive no-progress check-ins burn burnTokens total', () => {
  const s = make({ checkInIntervalMs: 60000, burnCheckins: 2, burnTokens: 1000000 });
  let now = T0;
  now += 60000;
  s.recordProviderUsage({ total_tokens: 600000 }, { phase: 'incremental' });
  assert.equal(s.evaluate(now).action, 'continue');
  now += 60000;
  s.recordProviderUsage({ total_tokens: 1300000 }, { phase: 'incremental' });
  const verdict = s.evaluate(now);
  assert.equal(verdict.action, 'kill');
  assert.equal(verdict.reason, 'burn_without_progress');
  assert.match(verdict.detail, /1300000 tokens|tokens/);
});

// G5 (Refs #133): markExited() / evaluate(now, { latch: false }) is the
// post-exit record-only path. The same burn streak that kills mid-stream
// must be reduced to a recorded, non-kill observation once the provider has
// already exited -- but the pre-exit behavior (still latches) is unchanged.
test('a burn streak crossing after markExited() records evidence but never latches stopped', () => {
  const s = make({ checkInIntervalMs: 60000, burnCheckins: 2, burnTokens: 1000000 });
  let now = T0;
  now += 60000;
  s.recordProviderUsage({ total_tokens: 600000 }, { phase: 'incremental' });
  assert.equal(s.evaluate(now).action, 'continue');
  now += 60000;
  s.recordProviderUsage({ total_tokens: 1300000 }, { phase: 'incremental' });
  const verdict = s.markExited(now);
  assert.equal(verdict.action, 'continue');
  assert.notEqual(verdict.action, 'kill');
  assert.equal(s.snapshot(now).stopped, null);
  assert.notEqual(s.phase(now), 'burn_without_progress');
  // The crossing is still recorded as a non-kill observation, not silently
  // dropped.
  assert.equal(s.snapshot(now).postExitSignal.reason, 'burn_without_progress');
});

test('the same burn streak crossing still latches stopped before exit (evaluate() default latch:true)', () => {
  const s = make({ checkInIntervalMs: 60000, burnCheckins: 2, burnTokens: 1000000 });
  let now = T0;
  now += 60000;
  s.recordProviderUsage({ total_tokens: 600000 }, { phase: 'incremental' });
  assert.equal(s.evaluate(now).action, 'continue');
  now += 60000;
  s.recordProviderUsage({ total_tokens: 1300000 }, { phase: 'incremental' });
  const verdict = s.evaluate(now);
  assert.equal(verdict.action, 'kill');
  assert.equal(verdict.reason, 'burn_without_progress');
  assert.equal(s.snapshot(now).stopped.reason, 'burn_without_progress');
});

test('burn without progress never fires when the total stays under burnTokens', () => {
  const s = make({ checkInIntervalMs: 60000, burnCheckins: 2, burnTokens: 1000000 });
  let now = T0;
  for (let i = 0; i < 4; i++) {
    now += 60000;
    s.recordProviderUsage({ total_tokens: (i + 1) * 100000 }, { phase: 'incremental' });
    assert.equal(s.evaluate(now).action, 'continue');
  }
});

// ---- progress resets every streak ---------------------------------------

test('new content or a productive assessment resets the wedged/loop/burn streaks', () => {
  const s = make({ checkInIntervalMs: 60000, wedgedCheckins: 2 });
  let now = T0;
  now += 60000;
  s.recordCpuSample(0, now);
  assert.equal(s.evaluate(now).action, 'continue');
  assert.equal(s.wedgedStreak, 1);
  now += 60000;
  s.recordOutput('fresh, real progress just happened\n', now);
  assert.equal(s.evaluate(now).action, 'continue');
  assert.equal(s.wedgedStreak, 0, 'progress must reset the streak, not just avoid killing');
  // Two more silent, CPU-idle check-ins from here must NOT kill on the first
  // of them -- the streak restarted from zero.
  now += 60000;
  s.recordCpuSample(0, now);
  assert.equal(s.evaluate(now).action, 'continue');
  now += 60000;
  s.recordCpuSample(0, now);
  assert.equal(s.evaluate(now).action, 'kill');
});

test('a current-generation productive assessment verdict resets streaks even without new bytes', () => {
  const s = make({ checkInIntervalMs: 60000, wedgedCheckins: 2, adaptive: true });
  let now = T0;
  now += 60000;
  s.recordCpuSample(0, now);
  assert.equal(s.evaluate(now).action, 'continue');
  assert.equal(s.wedgedStreak, 1);
  s.progress.assessment = { verdict: 'productive', materialGeneration: s.progress.materialGeneration };
  now += 60000;
  s.recordCpuSample(0, now);
  assert.equal(s.evaluate(now).action, 'continue');
  assert.equal(s.wedgedStreak, 0);
});

// ---- stallAction: notify vs checkpoint_and_kill --------------------------

test('stallAction "notify" never kills; it records a stall once and continues', () => {
  const s = make({ checkInIntervalMs: 60000, wedgedCheckins: 2, stallAction: 'notify' });
  let now = T0;
  now += 60000;
  s.recordCpuSample(0, now);
  assert.equal(s.evaluate(now).action, 'continue');
  now += 60000;
  s.recordCpuSample(0, now);
  const verdict = s.evaluate(now);
  assert.equal(verdict.action, 'continue');
  assert.equal(verdict.reason, 'stall_notified');
  assert.equal(s.stopped, null);
  assert.equal(s.stall.reason, 'wedged');
  const firstStallAt = s.stall.at;
  // A further triggering check-in must not overwrite the first recorded stall.
  now += 60000;
  s.recordCpuSample(0, now);
  s.evaluate(now);
  assert.equal(s.stall.at, firstStallAt);
  assert.equal(s.snapshot(now).stall.reason, 'wedged');
});

test('stallAction defaults to checkpoint_and_kill and rejects unknown values', () => {
  const s = make();
  assert.equal(s.opts.stallAction, 'checkpoint_and_kill');
  const bogus = make({ stallAction: 'ignore_everything' });
  assert.equal(bogus.opts.stallAction, 'checkpoint_and_kill');
});

// ---- rule (d): assessor_stuck, checked at any time -----------------------

test('assessor disabled/unavailable does not block deterministic check-in rules (a)-(c)', () => {
  const s = make({ adaptive: false, checkInIntervalMs: 60000, wedgedCheckins: 2 });
  assert.equal(s.opts.adaptive, false);
  assert.equal(s.assessmentEnabled, false);
  let now = T0;
  now += 60000;
  s.recordCpuSample(0, now);
  assert.equal(s.evaluate(now).action, 'continue');
  now += 60000;
  s.recordCpuSample(0, now);
  const verdict = s.evaluate(now);
  assert.equal(verdict.action, 'kill');
  assert.equal(verdict.reason, 'wedged', 'rule (a) fires the same whether adaptive is on or off');
});

test('healthy varied output survives 120 simulated minutes with the assessor disabled', () => {
  const s = make({ adaptive: false, checkInIntervalMs: 300000 });
  let now = T0;
  for (let minute = 1; minute <= 120; minute++) {
    now = T0 + minute * 60000;
    s.recordOutput(`distinct work item completed at minute ${minute}\n`, now);
    const verdict = s.evaluate(now);
    assert.equal(verdict.action, 'continue', `unexpectedly stopped at minute ${minute}: ${verdict.reason}`);
  }
  assert.equal(s.stopped, null);
  assert.equal(s.progress.assessment, null, 'no assessment was ever accepted, matching a disabled assessor');
});

// S6 (Refs #133): a failing progress assessor -- one that throws, refuses
// (malformed/stale verdict rejected by acceptAssessment), or never has
// capacity to respond -- must never itself kill or block the watched run.
// With adaptive enabled but no assessment ever accepted, assessor_stuck can
// never fire, and the deterministic rules (a)-(c) still run the show.
test('a failing progress assessor never kills or blocks; deterministic rules still fire', () => {
  const s = make({ adaptive: true, checkInIntervalMs: 60000, wedgedCheckins: 2, noNewContentMs: 1000 });
  s.setAssessmentEnabled(true);
  assert.equal(s.assessmentEnabled, true);

  // The assessor "refuses": it submits a stale/malformed verdict that
  // acceptAssessment must reject rather than apply.
  const snap = s.progress.snapshot(T0);
  const refused = s.progress.acceptAssessment(
    { runId: 'wrong-run', attemptId: null, evidenceHash: snap.hash, materialGeneration: snap.materialGeneration,
      verdict: 'stuck', evidenceIds: [] },
    snap, T0);
  assert.equal(refused, false, 'a malformed/stale assessor verdict is rejected, not applied');
  assert.equal(s.progress.assessment, null);

  // The assessor also simply throws/never responds for the rest of the run --
  // acceptAssessment is never called again. evaluate() must never return
  // assessor_stuck, and the deterministic wedged rule still corroborates and
  // kills on its own evidence.
  let now = T0, verdict;
  for (let i = 0; i < 2; i++) {
    now += 60000;
    s.recordCpuSample(0, now); // confirmed idle
    verdict = s.evaluate(now);
    assert.notEqual(verdict.reason, 'assessor_stuck', 'a silent/failing assessor never produces assessor_stuck');
  }
  assert.equal(verdict.action, 'kill');
  assert.equal(verdict.reason, 'wedged', 'deterministic rule (a) still fires despite the failed assessor');
});

// ---- CPU sampling scheduling (unchanged) ---------------------------------

test('CPU sampling is only requested once a run has gone quiet', () => {
  const s = make({ idleMs: 60000 });
  s.recordOutput('busy\n', T0 + 1000);
  assert.equal(s.needsCpuSample(T0 + 5000), false, 'no spawn cost while output is flowing');
  assert.equal(s.needsCpuSample(T0 + 40000), true);
  s.recordCpuSample(500, T0 + 40000);
  assert.equal(s.needsCpuSample(T0 + 45000), false, 'sampling is rate limited');
});

// ---- a kill verdict is sticky ---------------------------------------------

test('a kill verdict is sticky so a stopped run keeps its original reason', () => {
  const s = make({ checkInIntervalMs: 60000, wedgedCheckins: 2 });
  let now = T0;
  now += 60000;
  s.recordCpuSample(0, now);
  s.evaluate(now);
  now += 60000;
  s.recordCpuSample(0, now);
  const first = s.evaluate(now);
  assert.equal(first.reason, 'wedged');
  now += 5000000;
  const second = s.evaluate(now);
  assert.equal(second.reason, 'wedged');
  assert.equal(second, s.stopped);
});

// ---- snapshot -------------------------------------------------------------

test('snapshot exposes checkins, stall, ignoredCaps, outputSpillPath and spilling', () => {
  const s = make({ idleMs: 60000, checkInIntervalMs: 60000 });
  s.recordOutput('working on it\n', T0 + 1000);
  const snap = s.snapshot(T0 + 31000);
  assert.equal(snap.phase, 'quiet');
  assert.equal(snap.bytes, Buffer.byteLength('working on it\n'));
  assert.equal(snap.stopped, null);
  assert.deepEqual(snap.checkins, []);
  assert.equal(snap.stall, null);
  assert.equal(snap.outputSpillPath, null);
  assert.equal(snap.spilling, false);
  assert.ok('providerBudget' in snap.ignoredCaps && 'hardCapMs' in snap.ignoredCaps && 'timeoutMs' in snap.ignoredCaps);
});

test('snapshot.checkins carries the bounded fingerprint history, most recent last, capped at 20', () => {
  const s = make({ checkInIntervalMs: 1000 });
  let now = T0;
  for (let i = 0; i < 25; i++) {
    now += 1000;
    s.recordOutput(`unique item ${i}\n`, now);
    s.evaluate(now);
  }
  const snap = s.snapshot(now);
  assert.equal(snap.checkins.length, 20);
  const last = snap.checkins.at(-1);
  assert.ok('at' in last && 'bytes' in last && 'lastNewContentAt' in last && 'progress' in last
    && 'cpuActiveSinceLast' in last && 'totalTokens' in last && 'repeatCount' in last
    && 'verdict' in last && Array.isArray(last.detectors));
});

// ---- resolveSupervisorOptions ---------------------------------------------

test('an explicit request timeout is recorded as the informational hard cap, not a kill clock', () => {
  const opts = resolveSupervisorOptions({
    entry: { supervisor: { idleMs: 90000 } },
    globals: { idleMs: 120000, hardCapMs: 1800000 },
    hardCapMs: 600000,
  });
  assert.equal(opts.hardCapMs, 600000, 'explicit request cap wins as the recorded value');
  assert.equal(opts.idleMs, 90000, 'provider override beats globals');
  const s = new RunSupervisor({ startedAt: T0, ...opts });
  assert.equal(s.ignoredCaps.hardCapMs, 600000);
});

test('per-run provider budget overrides provider and global defaults (resolution only, never enforced)', () => {
  const opts = resolveSupervisorOptions({
    globals: { providerBudget: { maxTurns: 20 } },
    entry: { supervisor: { providerBudget: { maxTurns: 10 } } },
    providerBudget: { maxTurns: 3, maxOutputTokens: null },
  });
  assert.equal(opts.providerBudget.maxTurns, 3);
  assert.equal(opts.providerBudget.maxOutputTokens, null);
});

test('a sparse per-run override retains provider-specific ceilings', () => {
  const opts = resolveSupervisorOptions({
    globals: { providerBudget: { maxOutputTokens: 9000, maxTurns: 20 } },
    entry: { supervisor: { providerBudget: { maxOutputTokens: 4000, maxTurns: 10 } } },
    providerBudget: { maxTurns: 3 },
  });
  assert.equal(opts.providerBudget.maxTurns, 3);
  assert.equal(opts.providerBudget.maxOutputTokens, 4000);
});

// ---- provider usage tracking never triggers a kill/finalize --------------

test('provider-reported usage, including past any configured budget, is tracked but never stops or auto-finalizes a run', () => {
  const s = make({ providerBudget: {
    maxOutputTokens: 1000, maxTotalTokens: 5000, maxCacheReadTokens: null,
    maxCacheCreationTokens: null, maxTurns: 2,
  } });
  s.recordProviderUsage({ output_tokens: 200, total_tokens: 2100, turns: 1 }, { phase: 'incremental' });
  assert.equal(s.evaluate(T0 + 1000).action, 'continue');
  s.recordProviderUsage({ output_tokens: 700, total_tokens: 6200, turns: 3 }, { phase: 'incremental' });
  const verdict = s.evaluate(T0 + 2000);
  assert.equal(verdict.action, 'continue');
  assert.equal(s.snapshot(T0 + 2000).providerUsagePhase, 'incremental');
  assert.equal(s.snapshot(T0 + 2000).finalizationRequested, null);
});

test('requestGracefulFinalization is a manual, directly-callable advisory, no longer auto-triggered by budget proximity', () => {
  const s = make({ finalizationSupported: true, providerBudget: { maxTotalTokens: 10000 } });
  s.recordProviderUsage({ total_tokens: 9999 }, { phase: 'incremental' });
  assert.equal(s.evaluate(T0 + 1000).action, 'continue', 'no automatic finalize even one token under the old reserve line');
  assert.equal(s.snapshot(T0 + 1000).finalizationRequested, null);
  const reserve = s.requestGracefulFinalization({ threshold: 9000 });
  assert.deepEqual(reserve, { threshold: 9000 });
  assert.deepEqual(s.finalizationRequested, { threshold: 9000 });
  s.recordProviderUsage({ total_tokens: 50000 }, { phase: 'incremental' });
  assert.equal(s.evaluate(T0 + 2000).action, 'continue', 'a graceful advisory is not itself a kill');
});

test('acknowledgeFinalization remains directly callable and is single-shot', () => {
  const s = make({ finalizationSupported: true });
  assert.equal(s.acknowledgeFinalization({ threshold: 900 }), true);
  assert.equal(s.acknowledgeFinalization({ threshold: 900 }), false, 'already requested');
});

test('acknowledgeFinalization refuses when the provider does not support finalization', () => {
  const s = make();
  assert.equal(s.acknowledgeFinalization({ threshold: 900 }), false);
});

test('missing or malformed provider usage never falls back to output-size enforcement', () => {
  const s = make({ providerBudget: {
    maxOutputTokens: 1, maxTotalTokens: 1, maxCacheReadTokens: 1,
    maxCacheCreationTokens: 1, maxTurns: 1,
  }, spillAfterBytes: 1000000 });
  s.recordOutput('a long but unique answer is only a transport estimate\n', T0 + 1000);
  assert.equal(s.recordProviderUsage({ output_tokens: -1 }), false);
  assert.equal(s.evaluate(T0 + 2000).action, 'continue');
  assert.equal(s.snapshot(T0 + 2000).providerUsagePhase, 'unavailable');
});

// ---- issue #82: a turn count is not a budget, generalized to the full uncap policy ----

test('providerBudget.maxTurns (and every other budget field) resolves and is recorded, but is never enforced by RunSupervisor', () => {
  assert.equal(DEFAULTS.providerBudget.maxTurns, null);
  const opts = resolveSupervisorOptions({ globals: { providerBudget: { maxTurns: 24 } } });
  assert.equal(opts.providerBudget.maxTurns, 24, 'layered resolution still works');
  const s = new RunSupervisor({ startedAt: T0, ...opts });
  assert.equal(s.ignoredCaps.providerBudget.maxTurns, 24);
  s.recordProviderUsage({ turns: 4000 }, { phase: 'incremental' });
  s.recordOutput('turn after turn of real, distinct work\n', T0 + 1000);
  assert.equal(s.evaluate(T0 + 2000).action, 'continue', 'a huge turn count alone never stops a healthy run');
});

test('a healthy run reporting far more than the old 24-turn default runs to completion', () => {
  const s = make();
  let now = T0;
  for (let turn = 1; turn <= 36; turn++) {
    now += 5000;
    s.recordOutput(`turn ${turn}: read module ${turn} and summarised its exports\n`, now);
    assert.equal(s.recordProviderUsage({
      output_tokens: turn * 400, total_tokens: turn * 9000,
      cache_read_input_tokens: turn * 20000, cache_creation_input_tokens: turn * 2000, turns: turn,
    }, { phase: 'incremental' }), true);
    const verdict = s.evaluate(now);
    assert.equal(verdict.action, 'continue', `stopped at turn ${turn}: ${verdict.reason} ${verdict.detail}`);
  }
  s.recordProviderUsage({ output_tokens: 14400, total_tokens: 324000,
    cache_read_input_tokens: 720000, cache_creation_input_tokens: 72000, turns: 36 }, { phase: 'terminal' });
  assert.equal(s.evaluate(now).action, 'continue', 'the terminal report of a finished run must survive');
  assert.equal(s.snapshot(now).providerBudget.maxTurns, null);
});
