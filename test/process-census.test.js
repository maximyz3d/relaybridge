'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { projectCensus, validateChildProcessPolicy, fanoutWarnings, createCensusCpuTracker, sampleProcessCensus } = require('../lib/process-census');
const { cancelActiveRun } = require('../lib/active-run-cancel');
const { nativeTransportState } = require('../lib/cli-deadline');
const rows = [
  { pid: 1, ppid: 0, birth: '10', command: 'provider\0secret-prompt', cpuMs: 10 },
  { pid: 2, ppid: 1, birth: '11', command: 'python\0-m\0pytest\0tests/a.py\0secret-token', cpuMs: 20 },
  { pid: 3, ppid: 1, birth: '12', command: 'python\0-m\0pytest\0tests/a.py', cpuMs: 30 },
  { pid: 4, ppid: 0, birth: '13', command: 'pytest', cpuMs: 100 },
];
test('census identifies overlapping tests, scopes descendants and redacts all argv', () => {
  const census = projectCensus(1, { rows });
  assert.equal(census.descendantCount, 2); assert.equal(census.activeTestCount, 2); assert.equal(census.cpuMs, 60);
  assert.doesNotMatch(JSON.stringify(census), /secret|tests\/a.py/);
  assert.deepEqual(fanoutWarnings(census, validateChildProcessPolicy({ maxChildren: 1, maxConcurrentTests: 1 })), ['child_fanout', 'scope_expansion']);
  assert.equal(census.terminationEvidence, false);
  const limited = projectCensus(1, { rows, partial: true }); assert.equal(limited.coverage, 'partial');
  assert.equal(projectCensus(999, { rows }).cpuMs, null);
  assert.throws(() => validateChildProcessPolicy({ maxChildren: 0 }), /1..256/);
  assert.throws(() => validateChildProcessPolicy({ maxChildren: 1, allowedCommands: ['*'] }), /sampled/);
});
test('birth-scoped CPU progress survives exited children and PID reuse', () => {
  const tracker = createCensusCpuTracker();
  assert.equal(tracker(projectCensus(1, { rows })), 60);
  assert.equal(tracker(projectCensus(1, { rows: [{ ...rows[0], cpuMs: 15 }] })), 65);
  assert.equal(tracker(projectCensus(1, { rows: [{ ...rows[0], cpuMs: 15 }, { ...rows[1], birth: 'new', cpuMs: 2 }] })), 67);
  assert.equal(tracker(projectCensus(1, { rows, partial: true })), null);
});
test('live census describes this fixture without exposing its command', { skip: !['linux', 'win32'].includes(process.platform) }, async () => {
  const census = await sampleProcessCensus(process.pid);
  assert.notEqual(census.coverage, 'unavailable'); assert.equal(census.processes[0].pid, process.pid);
  assert.equal(census.terminationEvidence, false);
});
test('exact active cancellation cannot target a replacement, release capacity or repeat signals', () => {
  const input = { requestId: 'r', invocationId: 'i', attemptId: 'i:attempt:1' };
  const route = { request_id: 'r', invocation_id: 'i', attempt_id: 'i:attempt:1' };
  let stops = 0; const control = { route, stop: reason => { assert.equal(reason, 'operator_cancelled'); stops++; return true; } };
  const args = { runId: 'run_fixture', input, activeRuns: new Map([['run_fixture', { route }]]), controls: new Map([['run_fixture', control]]), append: () => {} };
  assert.throws(() => cancelActiveRun({ ...args, input: { ...input, attemptId: 'wrong' } }), /identity_changed/);
  assert.throws(() => cancelActiveRun({ ...args, input: { ...input, pid: 123 } }), /invalid_run/);
  assert.equal(stops, 0);
  assert.equal(cancelActiveRun(args).terminationVerified, false);
  assert.equal(cancelActiveRun(args).alreadyRequested, true); assert.equal(stops, 1);
  assert.equal(args.activeRuns.size, 1);
});
test('native finite wait checkpoints before its boundary without a reasoning timeout', () => {
  const deadline = { finite: true, nativeLimitMs: 86430000 };
  assert.equal(nativeTransportState(deadline, 0, 31 * 60000).stopNeeded, false);
  assert.equal(nativeTransportState(deadline, 0, 86430000 - 60000).checkpointNeeded, true);
  assert.equal(nativeTransportState(deadline, 0, 86430000 - 25000).stopNeeded, true);
  assert.equal(nativeTransportState(null, 0), null);
});
