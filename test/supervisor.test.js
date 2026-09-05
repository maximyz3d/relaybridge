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

test('provider token reserve requests finalization once without weakening the hard ceiling', () => {
  const s = make({
    providerBudget: {
      maxOutputTokens: null, maxTotalTokens: 10000, maxCacheReadTokens: null,
      maxCacheCreationTokens: null, maxTurns: null,
    },
    providerBudgetFinalizationReserve: {
      maxOutputTokens: 0, maxTotalTokens: 2000,
      maxCacheReadTokens: 0, maxCacheCreationTokens: 0,
    },
  });
  s.recordProviderUsage({ total_tokens: 8999 }, { phase: 'incremental' });
  assert.equal(s.evaluate(T0 + 1000).action, 'continue');
  s.recordProviderUsage({ total_tokens: 9000 }, { phase: 'incremental' });
  const reserve = s.evaluate(T0 + 2000);
  assert.equal(reserve.action, 'finalize');
  assert.equal(reserve.reason, 'token_budget_reserve');
  assert.equal(reserve.reserve.reserve, 1000, 'reserve is capped at 10% of a small caller budget');
  assert.equal(s.evaluate(T0 + 3000).action, 'continue', 'finalization is requested only once');
  s.recordProviderUsage({ total_tokens: 10001 }, { phase: 'incremental' });
  const killed = s.evaluate(T0 + 4000);
  assert.equal(killed.action, 'kill');
  assert.equal(killed.reason, 'token_budget');
  assert.equal(s.snapshot(T0 + 4000).finalizationRequested.threshold, 9000);
});

test('hard stop guards take precedence over a finalization reserve on the same tick', async (t) => {
  const reserveOptions = {
    providerBudget: {
      maxOutputTokens: null, maxTotalTokens: 10000, maxCacheReadTokens: null,
      maxCacheCreationTokens: null, maxTurns: null,
    },
    providerBudgetFinalizationReserve: {
      maxOutputTokens: 0, maxTotalTokens: 2000,
      maxCacheReadTokens: 0, maxCacheCreationTokens: 0,
    },
  };
  const atReserve = (supervisor) => {
    supervisor.recordProviderUsage({ total_tokens: 9000 }, { phase: 'incremental' });
    return supervisor;
  };

  await t.test('output cap', () => {
    const s = atReserve(make({ ...reserveOptions, maxOutputBytes: 32 }));
    s.recordOutput('unique output beyond the configured byte ceiling', T0 + 1000);
    assert.equal(s.evaluate(T0 + 1000).reason, 'output_cap');
  });

  await t.test('hard cap', () => {
    const s = atReserve(make({ ...reserveOptions, idleMs: 1000, hardCapMs: 1000 }));
    assert.equal(s.evaluate(T0 + 1000).reason, 'hard_cap');
  });

  await t.test('repeat loop', () => {
    const s = atReserve(make({ ...reserveOptions, loopRepeatThreshold: 2 }));
    s.recordOutput('same synthetic repeated line\nsame synthetic repeated line\n', T0 + 1000);
    assert.equal(s.evaluate(T0 + 1000).reason, 'loop_detected');
  });

  await t.test('idle stall', () => {
    const s = atReserve(make({ ...reserveOptions, idleMs: 1000 }));
    assert.equal(s.evaluate(T0 + 1000).reason, 'idle_stall');
  });
});

test('terminal usage never requests a pointless finalization turn', () => {
  const s = make({ providerBudget: {
    maxOutputTokens: null, maxTotalTokens: 10000, maxCacheReadTokens: null,
    maxCacheCreationTokens: null, maxTurns: null,
  } });
  s.recordProviderUsage({ total_tokens: 9500 }, { phase: 'terminal' });
  assert.equal(s.evaluate(T0 + 1000).action, 'continue');
  assert.equal(s.snapshot(T0 + 1000).finalizationRequested, null);
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

// ---- issue #82: a turn count is not a budget ------------------------------
// The shipped providerBudget.maxTurns of 24 stopped healthy agentic runs. An
// agentic CLI spends one turn per tool call, so num_turns tracks how many
// files a model read, not what the run cost. Turns therefore ship disabled,
// while every token ceiling and every liveness check stays exactly as it was.

test('the shipped default no longer imposes a turn ceiling on normal runs', () => {
  assert.equal(DEFAULTS.providerBudget.maxTurns, null,
    'a fixed turn cap killed complete, successful terminal results');
  for (const field of ['maxOutputTokens', 'maxTotalTokens', 'maxCacheReadTokens', 'maxCacheCreationTokens']) {
    assert.ok(Number.isSafeInteger(DEFAULTS.providerBudget[field]) && DEFAULTS.providerBudget[field] > 0,
      `${field} must still bound cost`);
  }
});

test('a healthy run reporting far more than 24 turns runs to completion by default', () => {
  const s = make();
  let now = T0;
  // One turn per tool call: 36 file reads is an ordinary review, not a runaway.
  for (let turn = 1; turn <= 36; turn++) {
    now += 5000;
    s.recordOutput(`turn ${turn}: read module ${turn} and summarised its exports\n`, now);
    assert.equal(s.recordProviderUsage({
      output_tokens: turn * 400,
      total_tokens: turn * 9000,
      cache_read_input_tokens: turn * 20000,
      cache_creation_input_tokens: turn * 2000,
      turns: turn,
    }, { phase: 'incremental' }), true);
    const verdict = s.evaluate(now);
    assert.equal(verdict.action, 'continue', `stopped at turn ${turn}: ${verdict.reason} ${verdict.detail}`);
  }
  s.recordProviderUsage({
    output_tokens: 14400, total_tokens: 324000,
    cache_read_input_tokens: 720000, cache_creation_input_tokens: 72000, turns: 36,
  }, { phase: 'terminal' });
  assert.equal(s.evaluate(now).action, 'continue', 'the terminal report of a finished run must survive');
  assert.equal(s.snapshot(now).providerBudget.maxTurns, null);
});

test('disabling turns does not disable the token ceilings that bound real cost', () => {
  const cacheStop = make();
  cacheStop.recordProviderUsage({
    turns: 400, cache_read_input_tokens: DEFAULTS.providerBudget.maxCacheReadTokens + 1,
  }, { phase: 'incremental' });
  const cacheVerdict = cacheStop.evaluate(T0 + 1000);
  assert.equal(cacheVerdict.reason, 'token_budget');
  assert.match(cacheVerdict.detail, /cache_read_input_tokens/,
    'the dimension that actually measures spend must be the one named');

  for (const [budgetField, usageField] of Object.entries({
    maxOutputTokens: 'output_tokens',
    maxTotalTokens: 'total_tokens',
    maxCacheCreationTokens: 'cache_creation_input_tokens',
  })) {
    const s = make();
    s.recordProviderUsage({ [usageField]: DEFAULTS.providerBudget[budgetField] + 1 }, { phase: 'incremental' });
    assert.equal(s.evaluate(T0 + 1000).reason, 'token_budget', budgetField);
  }
});

test('an explicit turn ceiling is still enforced, from any of the three layers', () => {
  const layers = [
    { label: 'globals', options: { globals: { providerBudget: { maxTurns: 24 } } } },
    { label: 'provider entry', options: { entry: { supervisor: { providerBudget: { maxTurns: 24 } } } } },
    { label: 'request', options: { providerBudget: { maxTurns: 24 } } },
  ];
  for (const layer of layers) {
    const opts = resolveSupervisorOptions({ globals: { providerBudget: { maxTurns: null } }, ...layer.options });
    assert.equal(opts.providerBudget.maxTurns, 24, layer.label);
    const s = new RunSupervisor({ startedAt: T0, ...opts });
    s.recordProviderUsage({ turns: 24 }, { phase: 'incremental' });
    assert.equal(s.evaluate(T0 + 1000).action, 'continue', `${layer.label}: the limit itself is allowed`);
    s.recordProviderUsage({ turns: 25 }, { phase: 'incremental' });
    const verdict = s.evaluate(T0 + 2000);
    assert.equal(verdict.reason, 'token_budget', layer.label);
    assert.match(verdict.detail, /provider-reported turns 25 exceeded maxTurns 24/);
  }
});

test('a global turn ceiling can still be lifted per provider or per request', () => {
  const globals = { providerBudget: { maxTurns: 24 } };
  assert.equal(resolveSupervisorOptions({
    globals, entry: { supervisor: { providerBudget: { maxTurns: null } } },
  }).providerBudget.maxTurns, null, 'a provider entry may opt out');
  assert.equal(resolveSupervisorOptions({
    globals, providerBudget: { maxTurns: null },
  }).providerBudget.maxTurns, null, 'one request may opt out');
  assert.equal(resolveSupervisorOptions({ globals }).providerBudget.maxTurns, 24,
    'and an operator ceiling still applies when nobody overrides it');
});
