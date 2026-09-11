'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RunSupervisor } = require('../lib/run-supervisor');
const { resolveAttemptTiming, renderCliDeadline, PRINT_TIMEOUT_TOKEN } = require('../lib/cli-deadline');
const config = require('../cli-config.json');
const { buildTaskPlan } = require('../lib/task-plan');
const { resolveProviderControls } = require('../lib/execution-contract');

test('Gemini safe/writer print wait is derived from the effective cap plus bounded margin', () => {
  for (const options of [{}, { timeoutMs: 1000 }, { globals: { idleMs: 5000, hardCapMs: 3000 } },
    { entry: { supervisor: { hardCapMs: 3600000 } } }, { timeoutMs: 1999.9 }]) {
    const supervisorOptions = resolveAttemptTiming(options);
    assert.equal(supervisorOptions.hardCapMs, Number(new RunSupervisor(supervisorOptions).opts.hardCapMs));
    let prior;
    for (const slot of [config.gemini.oneshot_safe, config.gemini.oneshot_dangerous]) {
      const value = renderCliDeadline({ entry: config.gemini, slot, supervisorOptions });
      assert.ok(value.deadline.marginMs >= 30000 && value.deadline.marginMs < 31000);
      assert.equal(value.deadline.hardCapMs, supervisorOptions.hardDeadline === false ? 86400000 : supervisorOptions.hardCapMs);
      assert.ok(value.slot.includes(value.deadline.printTimeout)); assert.equal(value.slot.includes(PRINT_TIMEOUT_TOKEN), false);
      if (prior) assert.deepEqual(value.deadline, prior); prior = value.deadline;
    }
  }
  const normal = renderCliDeadline({ entry: config.gemini, slot: config.gemini.oneshot_safe, supervisorOptions: resolveAttemptTiming() });
  assert.equal(normal.deadline.printTimeout, '86430s'); // Adaptive transport ceiling plus bounded drain margin
  const late = new RunSupervisor({ ...resolveAttemptTiming(), startedAt: 0 });
  late.recordOutput('continued semantic progress', 16 * 60000);
  assert.notEqual(late.evaluate(16 * 60000).action, 'kill');
});

test('progress completes beyond the former 15min boundary; silence alone does not stop adaptive work', () => {
  const options = resolveAttemptTiming({ startedAt: 0 });
  const active = new RunSupervisor(options);
  for (let at = 30000; at <= 16 * 60000; at += 30000) {
    assert.equal(active.recordOutput(`Completed distinct work item ${at}\n`, at), true);
    assert.notEqual(active.evaluate(at).action, 'kill');
  }
  assert.equal(active.recordOutput('Final complete answer.\n', 16 * 60000 + 1), true);
  assert.notEqual(active.evaluate(16 * 60000 + 1).action, 'kill');
  const silent = new RunSupervisor(options);
  silent.recordCpuSample(0, 0);
  silent.recordCpuSample(0, options.idleMs);
  const verdict = silent.evaluate(options.idleMs);
  assert.equal(verdict.action, 'continue');
  const legacy = new RunSupervisor(resolveAttemptTiming({ startedAt: 0, globals: { adaptive: false } }));
  assert.equal(legacy.evaluate(options.idleMs).action, 'kill');
  const rendered = renderCliDeadline({ entry: config.gemini, slot: config.gemini.oneshot_safe, supervisorOptions: options });
  assert.ok(options.idleMs < rendered.deadline.printTimeoutMs);
});

test('malformed/duplicate/literal/unlimited print flags and overflow fail before invocation', () => {
  const entry = { print_timeout_policy: 'supervisor_margin_v1' };
  const supervisorOptions = resolveAttemptTiming();
  for (const slot of [[], ['agy', '--print-timeout'], ['agy', '--print-timeout', '--'],
    ['agy', '--print-timeout', '15m'], ['agy', '--print-timeout', 'unlimited'],
    ['agy', '--print-timeout', PRINT_TIMEOUT_TOKEN, '--print-timeout=' + PRINT_TIMEOUT_TOKEN],
    ['agy', '--', '--print-timeout', PRINT_TIMEOUT_TOKEN]]) {
    assert.throws(() => renderCliDeadline({ entry, slot, supervisorOptions }), { code: 'invalid_print_timeout' });
  }
  const slot = ['agy', '--print-timeout=' + PRINT_TIMEOUT_TOKEN];
  assert.equal(renderCliDeadline({ entry, slot, supervisorOptions }).slot[1], '--print-timeout=86430s');
  assert.throws(() => renderCliDeadline({ entry: {}, slot, supervisorOptions }), { code: 'invalid_print_timeout' });
  for (const hardCapMs of [Infinity, NaN, -1, 0, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => renderCliDeadline({ entry, slot, supervisorOptions: { hardCapMs } }), { code: 'invalid_print_timeout' });
  }
  assert.deepEqual(renderCliDeadline({ entry: {}, slot: ['node', '--', '--print-timeout', 'literal'], supervisorOptions }).slot,
    ['node', '--', '--print-timeout', 'literal']);
});

test('planned deadline args match execution while runtime timeout leaves exact model/effort tuple intact', () => {
  const route = { classification: { tier: 'standard', tags: ['coding'] }, selected: [{ kind: 'gemini', ready: true }] };
  for (const dangerous of [false, true]) {
    const plan = buildTaskPlan({ route, config, requestedKind: 'gemini', requestedTimeoutMs: 4000, dangerous }).primary;
    assert.equal(plan.validation, null); assert.equal(plan.effectiveTimeoutMs, 4000);
    const controls = resolveProviderControls({ kind: 'gemini', entry: config.gemini,
      slot: dangerous ? config.gemini.oneshot_dangerous : config.gemini.oneshot_safe, execution: plan.execution, dangerous });
    const render = renderCliDeadline({ entry: config.gemini, slot: controls.slot, supervisorOptions: resolveAttemptTiming({ timeoutMs: 4000 }) });
    assert.deepEqual(plan.args, render.slot.slice(1)); assert.deepEqual(plan.cliDeadline, render.deadline);
    const changed = buildTaskPlan({ route, config, requestedKind: 'gemini', requestedTimeoutMs: 9000, dangerous }).primary;
    assert.deepEqual(changed.execution, plan.execution); assert.notEqual(changed.cliDeadline.printTimeout, plan.cliDeadline.printTimeout);
  }
});

test('linked-account flags cannot overwrite the supervisor deadline; policy drift invalidates intent', () => {
  const slot = config.gemini.oneshot_safe;
  for (const linked_account_args of [['--print-timeout', '1s'], ['--print-timeout=1s'], ['--extra', PRINT_TIMEOUT_TOKEN]]) {
    assert.throws(() => resolveProviderControls({ kind: 'gemini', slot,
      entry: { ...config.gemini, linked_account_args } }), { code: 'invalid_account_controls' });
  }
  const initial = resolveProviderControls({ kind: 'gemini', entry: config.gemini, slot });
  assert.throws(() => resolveProviderControls({ kind: 'gemini', slot, execution: initial.execution,
    entry: { ...config.gemini, print_timeout_policy: null } }), { code: 'execution_config_changed' });
});
