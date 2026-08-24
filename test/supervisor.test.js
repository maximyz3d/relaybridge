'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { RunSupervisor, resolveSupervisorOptions, DEFAULTS } = require('../lib/run-supervisor');

const T0 = 1000000;

function make(overrides = {}) {
  return new RunSupervisor({ startedAt: T0, ...overrides });
}

test('a run that keeps producing new content is never stopped mid-task', () => {
  const s = make({ idleMs: 60000, hardCapMs: 3600000 });
  let now = T0;
  // Twenty minutes of steady, varied output â€” well past the old 3 min cap.
  for (let i = 0; i < 240; i++) {
    now += 5000;
    s.recordOutput(`step ${i}: editing module number ${i} and running its checks\n`, now);
    const verdict = s.evaluate(now);
    assert.equal(verdict.action, 'continue', `killed at minute ${(now - T0) / 60000}: ${verdict.reason}`);
  }
  assert.equal(s.phase(now), 'streaming');
});

test('silence past the idle window with no CPU advance is called a stall', () => {
  const s = make({ idleMs: 60000 });
  s.recordOutput('starting work\n', T0 + 1000);
  assert.equal(s.evaluate(T0 + 30000).action, 'continue');
  const verdict = s.evaluate(T0 + 90000);
  assert.equal(verdict.action, 'kill');
  assert.equal(verdict.reason, 'idle_stall');
  assert.match(verdict.detail, /no output for \d+s/);
});

test('buffered providers survive the retired six-minute idle cutoff by default', () => {
  const s = make();
  const verdict = s.evaluate(T0 + 361000);
  assert.equal(verdict.action, 'continue');
  assert.equal(verdict.reason, 'starting');
  assert.equal(s.snapshot(T0 + 361000).idleBudgetMs, DEFAULTS.idleMs - 361000);
});

test('CPU advance while silent buys grace, so a quietly thinking CLI survives', () => {
  const s = make({ idleMs: 60000, cpuActiveMs: 500, graceExtensions: 3 });
  s.recordOutput('thinking\n', T0 + 1000);
  s.recordCpuSample(1000, T0 + 30000);
  // 40s of CPU burned while producing nothing: that is work, not a wedge.
  s.recordCpuSample(41000, T0 + 55000);
  assert.equal(s.evaluate(T0 + 80000).action, 'continue');
  assert.equal(s.extensionsUsed, 1);
});

test('grace is bounded so a busy-spinning process cannot extend forever', () => {
  const s = make({ idleMs: 60000, cpuActiveMs: 500, graceExtensions: 2 });
  s.recordOutput('go\n', T0 + 1000);
  let cpu = 0;
  let now = T0 + 30000;
  for (let i = 0; i < 3; i++) {
    cpu += 30000;
    now += 30000;
    s.recordCpuSample(cpu, now);
  }
  // The first sample only establishes a baseline, so three samples grant two.
  assert.equal(s.extensionsUsed, 2);
  const verdict = s.evaluate(now + 70000);
  assert.equal(verdict.action, 'kill');
  assert.equal(verdict.reason, 'idle_stall');
  assert.match(verdict.detail, /grace extensions/);
});

test('a repeating line is caught as a loop even though output keeps flowing', () => {
  const s = make({ loopRepeatThreshold: 8, idleMs: 600000 });
  let now = T0;
  for (let i = 0; i < 8; i++) {
    now += 1000;
    s.recordOutput('Retrying tool call because the previous attempt failed\n', now);
  }
  const verdict = s.evaluate(now);
  assert.equal(verdict.action, 'kill');
  assert.equal(verdict.reason, 'loop_detected');
  assert.match(verdict.detail, /repeated 8 times/);
});

test('progress lines that differ only by a counter are not mistaken for a loop', () => {
  const s = make({ loopRepeatThreshold: 8, idleMs: 600000 });
  let now = T0;
  for (let i = 0; i < 60; i++) {
    now += 1000;
    s.recordOutput(`processed ${i} of 60 files in the workspace\n`, now);
  }
  assert.equal(s.evaluate(now).action, 'continue');
});

test('output that grows without ever saying anything new is treated as churn', () => {
  const s = make({ noNewContentMs: 60000, loopRepeatThreshold: 500, idleMs: 600000 });
  let now = T0;
  const known = ['alpha line of content here', 'beta line of content here', 'gamma line of content here'];
  for (let i = 0; i < 90; i++) {
    now += 1000;
    s.recordOutput(known[i % known.length] + '\n', now);
  }
  const verdict = s.evaluate(now);
  assert.equal(verdict.action, 'kill');
  assert.equal(verdict.reason, 'loop_detected');
  assert.match(verdict.detail, /nothing new/);
});

test('spinner and ANSI noise does not count as repeated content', () => {
  const s = make({ loopRepeatThreshold: 4, idleMs: 600000 });
  let now = T0;
  for (const frame of ['|', '/', '-', '\\', '|', '/', '-', '\\']) {
    now += 500;
    s.recordOutput(`\u001b[2K\r${frame}\n`, now);
  }
  assert.equal(s.evaluate(now).action, 'continue');
});

test('lines split across chunk boundaries are reassembled before analysis', () => {
  const s = make({ loopRepeatThreshold: 3, idleMs: 600000 });
  let now = T0;
  for (let i = 0; i < 3; i++) {
    now += 100;
    s.recordOutput('the identical repeated ', now);
    s.recordOutput('sentence appears again\n', now);
  }
  const verdict = s.evaluate(now);
  assert.equal(verdict.action, 'kill');
  assert.equal(verdict.reason, 'loop_detected');
});

test('runaway output is capped so the bridge cannot be grown out of memory', () => {
  const s = make({ maxOutputBytes: 4096, idleMs: 600000, loopRepeatThreshold: 10000 });
  let now = T0;
  let accepted = true;
  for (let i = 0; i < 200; i++) {
    now += 10;
    accepted = s.recordOutput(`unique padding line number ${i} ` + 'x'.repeat(60) + '\n', now);
  }
  assert.equal(accepted, false, 'caller should be told to stop accumulating');
  const verdict = s.evaluate(now);
  assert.equal(verdict.action, 'kill');
  assert.equal(verdict.reason, 'output_cap');
});

test('the hard cap stops even a perfectly healthy run', () => {
  const s = make({ idleMs: 60000, hardCapMs: 120000 });
  let now = T0;
  for (let i = 0; i < 12; i++) {
    now += 10000;
    s.recordOutput(`still working on distinct item ${i} right now\n`, now);
  }
  const verdict = s.evaluate(now + 1000);
  assert.equal(verdict.action, 'kill');
  assert.equal(verdict.reason, 'hard_cap');
});

test('a verdict is sticky so a killed run keeps its original reason', () => {
  const s = make({ idleMs: 60000, hardCapMs: 90000 });
  s.recordOutput('one line of output\n', T0 + 1000);
  const first = s.evaluate(T0 + 70000);
  assert.equal(first.reason, 'idle_stall');
  const second = s.evaluate(T0 + 5000000);
  assert.equal(second.reason, 'idle_stall', 'hard cap must not overwrite the real cause');
});

test('CPU sampling is only requested once a run has gone quiet', () => {
  const s = make({ idleMs: 60000 });
  s.recordOutput('busy\n', T0 + 1000);
  assert.equal(s.needsCpuSample(T0 + 5000), false, 'no spawn cost while output is flowing');
  assert.equal(s.needsCpuSample(T0 + 40000), true);
  s.recordCpuSample(500, T0 + 40000);
  assert.equal(s.needsCpuSample(T0 + 45000), false, 'sampling is rate limited');
});

test('unverifiable idle follows the configured policy', () => {
  const kill = make({ idleMs: 60000, onUnverifiableIdle: 'kill' });
  kill.recordOutput('x'.repeat(40) + '\n', T0 + 1000);
  kill.recordCpuSample(null, T0 + 40000);
  assert.equal(kill.evaluate(T0 + 90000).action, 'continue', 'still inside the widened unverified-idle window');
  assert.equal(kill.evaluate(T0 + 260000).action, 'kill', 'past the widened window it stops');

  const wait = make({ idleMs: 60000, onUnverifiableIdle: 'continue' });
  wait.recordOutput('y'.repeat(40) + '\n', T0 + 1000);
  wait.recordCpuSample(null, T0 + 40000);
  assert.equal(wait.evaluate(T0 + 90000).action, 'continue');
});

test('snapshot reports which limit will fire first', () => {
  const s = make({ idleMs: 60000, hardCapMs: 600000 });
  s.recordOutput('working on it\n', T0 + 1000);
  const snap = s.snapshot(T0 + 31000);
  assert.equal(snap.phase, 'quiet');
  assert.equal(snap.idleBudgetMs, 30000);
  assert.equal(snap.hardCapRemainingMs, 569000);
  assert.equal(snap.bytes, 14);
  assert.equal(snap.stopped, null);
});

test('a request timeout is honored as the hard cap, not as a kill clock', () => {
  const opts = resolveSupervisorOptions({
    entry: { supervisor: { idleMs: 90000 } },
    globals: { idleMs: 120000, hardCapMs: 1800000 },
    hardCapMs: 600000,
  });
  assert.equal(opts.hardCapMs, 600000, 'explicit request cap wins');
  assert.equal(opts.idleMs, 90000, 'provider override beats globals');
});

test('a hard cap below the idle window is corrected instead of trapping the run', () => {
  const s = make({ idleMs: 300000, hardCapMs: 1000 });
  assert.equal(s.opts.hardCapMs, 300000);
});

test('defaults leave real headroom for long agentic tasks', () => {
  assert.ok(DEFAULTS.hardCapMs >= 1800000, 'ceiling should allow a long task');
  assert.ok(DEFAULTS.idleMs >= 180000, 'buffered print-mode CLIs need a wide idle window');
});

test('provider-reported multi-turn usage stops at a distinct token budget without estimates', () => {
  const s = make({ providerBudget: {
    maxOutputTokens: 1000, maxTotalTokens: 5000, maxCacheReadTokens: null,
    maxCacheCreationTokens: null, maxTurns: 2,
  } });
  s.recordProviderUsage({ output_tokens: 200, total_tokens: 2100, turns: 1 }, { phase: 'incremental' });
  assert.equal(s.evaluate(T0 + 1000).action, 'continue');
  s.recordProviderUsage({ output_tokens: 450, total_tokens: 4300, turns: 2 }, { phase: 'incremental' });
  assert.equal(s.evaluate(T0 + 2000).action, 'continue');
  s.recordProviderUsage({ output_tokens: 700, total_tokens: 6200, turns: 3 }, { phase: 'incremental' });
  const verdict = s.evaluate(T0 + 3000);
  assert.equal(verdict.reason, 'token_budget');
  assert.match(verdict.detail, /provider-reported/);
  assert.equal(s.snapshot(T0 + 3000).providerUsagePhase, 'incremental');
});

test('missing or malformed provider usage never falls back to output-size enforcement', () => {
  const s = make({ providerBudget: {
    maxOutputTokens: 1, maxTotalTokens: 1, maxCacheReadTokens: 1,
    maxCacheCreationTokens: 1, maxTurns: 1,
  }, maxOutputBytes: 1000000 });
  s.recordOutput('a long but unique answer is only a transport estimate\n', T0 + 1000);
  assert.equal(s.recordProviderUsage({ output_tokens: -1 }), false);
  assert.equal(s.evaluate(T0 + 2000).action, 'continue');
  assert.equal(s.snapshot(T0 + 2000).providerUsagePhase, 'unavailable');
});

test('per-run provider budget overrides provider and global defaults', () => {
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
