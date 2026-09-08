'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RunSupervisor } = require('../lib/run-supervisor');
const { createAttemptLifecycle, normalizeTransportLifecycle } = require('../lib/attempt-lifecycle');

function fixture(options = {}) {
  let clock = 0, releases = 0, stops = 0, boundaries = 0;
  const registry = new Map();
  const supervisor = new RunSupervisor({ startedAt: 0, idleMs: 1000, hardCapMs: 5000, ...options.supervisor });
  const life = createAttemptLifecycle({ runId: 'run_fixture', kind: 'fixture', route: {}, supervisor,
    registry, now: () => clock, releaseAdmission: () => { releases++; }, tickMs: 0,
    onSemanticStop: (stop) => { boundaries++; options.onSemanticStop?.(stop); } });
  const bind = (type = 'http') => life.bindTransport({ type, pid: type === 'cli' ? 123 : null,
    requestStop: () => { stops++; } });
  return { life, registry, supervisor, bind, advance: (ms) => { clock += ms; },
    counts: () => ({ releases, stops, boundaries }) };
}

test('disconnect before bind seals stop, invokes late transport once and never dispatches', async () => {
  const f = fixture();
  assert.equal(f.life.clientDetached(), true);
  assert.equal(f.registry.size, 1);
  f.bind();
  assert.equal(f.life.markDispatched(), false);
  f.life.clientDetached();
  assert.deepEqual(f.counts(), { releases: 0, stops: 1, boundaries: 1 });
  await f.life.settlePhysical({ evidence: 'not_dispatched' });
  assert.equal(f.registry.size, 0); assert.equal(f.counts().releases, 1);
});

test('stopping and cleanup retain active membership and admission until physical settlement', async () => {
  const f = fixture(); f.bind(); f.life.markDispatched();
  assert.equal(f.life.snapshot().transport.pid, null); assert.equal(f.supervisor.snapshot().cpuUnavailable, true);
  f.life.observeOutput('First streamed content.'); f.life.clientDetached();
  let releaseCleanup;
  const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
  const first = f.life.settlePhysical({ evidence: 'http_transport_settled', cleanup: () => cleanupGate });
  assert.equal(f.life.settlePhysical({ evidence: 'http_transport_settled' }), first);
  await Promise.resolve();
  assert.equal(f.registry.size, 1); assert.equal(f.counts().releases, 0);
  assert.equal(f.life.snapshot().phase, 'cleanup');
  assert.equal(f.life.observeOutput('Late output'), false);
  releaseCleanup({ ok: true });
  const result = await first;
  assert.equal(await f.life.physicalDone, result);
  assert.equal(f.registry.size, 0); assert.equal(f.counts().releases, 1);
  assert.equal(result.snapshot.transport.remoteTermination, 'unverified');
});

test('budget stop is sticky across disconnect, late usage and CPU observations', async () => {
  const f = fixture({ supervisor: { providerBudget: { maxTotalTokens: 10 } } }); f.bind('cli'); f.life.markDispatched();
  f.life.observeUsage({ total_tokens: 11 }, 'terminal');
  f.life.clientDetached();
  assert.equal(f.life.snapshot().stop.reason, 'token_budget');
  assert.equal(f.life.observeUsage({ total_tokens: 9000 }), false);
  assert.equal(f.life.observeCpu(9000), false);
  assert.equal(f.supervisor.snapshot().providerUsage.total_tokens, 11);
  assert.deepEqual(f.counts(), { releases: 0, stops: 1, boundaries: 1 });
  f.life.sealOutcome({ failureClass: 'token_budget' });
  await f.life.settlePhysical({ evidence: 'process_tree_settled' });
});

test('sealed successful outcome does not become cancelled after response close', async () => {
  const f = fixture(); f.bind(); f.life.markDispatched();
  assert.equal(f.life.sealOutcome({ ok: true }), true);
  assert.equal(f.life.clientDetached(), false); assert.equal(f.counts().stops, 0);
  assert.equal(f.life.sealOutcome({ ok: false }), false);
  assert.equal(f.registry.size, 1, 'terminal JSON is not local transport closure');
  let observed;
  await f.life.settlePhysical({ evidence: 'http_transport_settled', persist: (value) => { observed = value; } });
  assert.equal(observed.outcome.ok, true); assert.equal(observed.snapshot.stop, null);
});

test('cleanup/persistence errors preserve diagnostics but release physical admission once', async () => {
  const f = fixture(); f.bind('cli'); f.life.markDispatched();
  let cleanupCalls = 0, persistCalls = 0;
  const settled = f.life.settlePhysical({ evidence: 'process_tree_settled', cleanup: () => {
    cleanupCalls++; f.life.settlePhysical({ evidence: 'process_tree_settled' });
    throw new Error('private cleanup detail');
  }, persist: () => { persistCalls++; throw new Error('private persistence detail'); } });
  const result = await settled;
  assert.equal(cleanupCalls, 1); assert.equal(persistCalls, 1); assert.equal(f.counts().releases, 1);
  assert.equal(result.snapshot.cleanupStatus, 'failed_preserved'); assert.equal(result.snapshot.callbackErrors.length, 2);
  assert.equal(JSON.stringify(result.snapshot).includes('private'), false);
});

test('transport settlement evidence and run identities fail closed', async () => {
  const f = fixture(); f.bind(); f.life.markDispatched();
  assert.throws(() => f.life.settlePhysical({ evidence: 'not_dispatched' }), /matching transport/);
  assert.throws(() => f.life.settlePhysical({ evidence: 'process_tree_settled' }), /matching transport/);
  assert.throws(() => f.life.settlePhysical({ evidence: 'spawn_failed' }), /matching transport/);
  assert.throws(() => f.life.identifyProcess(123), /identity handoff/);
  assert.throws(() => createAttemptLifecycle({ runId: 'run_fixture', registry: f.registry,
    supervisor: f.supervisor, releaseAdmission() {} }), /already registered/);
  await f.life.settlePhysical({ evidence: 'http_transport_settled' });
});

test('CLI can register before spawn and bind its resulting PID without replacing identity', async () => {
  const f = fixture();
  f.life.bindTransport({ type: 'cli', requestStop() {} });
  assert.equal(f.life.markDispatched(), true);
  f.life.identifyProcess(321); f.life.identifyProcess(321);
  assert.equal(f.registry.get('run_fixture').pid, 321);
  assert.throws(() => f.life.identifyProcess(322), /identity handoff/);
  await f.life.settlePhysical({ evidence: 'process_tree_settled' });
  assert.throws(() => f.life.identifyProcess(321), /identity handoff/);
});

test('timer verdict stops once and late timer callback cannot resurrect settlement', async () => {
  let tick, clears = 0, stops = 0, releases = 0, now = 0;
  const registry = new Map();
  const life = createAttemptLifecycle({ runId: 'timed', kind: 'fixture', route: {}, registry,
    supervisor: new RunSupervisor({ startedAt: 0, idleMs: 1000, hardCapMs: 1500 }),
    now: () => now, releaseAdmission: () => { releases++; },
    schedule: (fn) => { tick = fn; return 1; }, clearSchedule: () => { clears++; } });
  life.bindTransport({ type: 'http', requestStop: () => { stops++; } }); life.markDispatched();
  now = 1500; tick(); tick(); assert.equal(stops, 1); assert.equal(life.snapshot().stop.reason, 'hard_cap');
  await life.settlePhysical({ evidence: 'http_transport_settled' });
  tick(); assert.equal(clears, 1); assert.equal(releases, 1); assert.equal(registry.size, 0);
});

test('sealed outcome retains a separate bounded drain stop without rewriting semantic success', async () => {
  const f = fixture(); f.bind(); f.life.markDispatched(); f.life.sealOutcome({ ok: true });
  f.advance(5000); f.life.evaluate(); f.life.evaluate();
  assert.equal(f.counts().stops, 1); assert.equal(f.life.snapshot().stop, null);
  assert.equal(f.life.snapshot().drainStop.reason, 'physical_drain_timeout');
  assert.equal(f.registry.size, 1); assert.equal(f.counts().releases, 0);
  let terminal;
  await f.life.settlePhysical({ evidence: 'http_transport_settled', persist: ({ outcome }) => { terminal = outcome; } });
  assert.equal(terminal.ok, true);
});

test('accepted triggering text and usage are committed before semantic-stop notification', async () => {
  let output = '', frozen;
  const f = fixture({ supervisor: { loopRepeatThreshold: 2 }, onSemanticStop: () => { frozen = output; } });
  f.bind(); f.life.markDispatched();
  const text = 'Repeated substantial output line.\n';
  f.life.observeOutput(text, (chunk) => { output += chunk; });
  f.life.observeOutput(text, (chunk) => { output += chunk; });
  assert.equal(frozen, text + text);
  await f.life.settlePhysical({ evidence: 'http_transport_settled' });
  let terminal = null, sealed;
  const usage = fixture({ supervisor: { providerBudget: { maxTotalTokens: 10 } }, onSemanticStop: () => { sealed = terminal; } });
  usage.bind(); usage.life.markDispatched();
  usage.life.observeUsage({ total_tokens: 11 }, 'terminal', (value) => { terminal = value; });
  assert.equal(sealed.total_tokens, 11);
  await usage.life.settlePhysical({ evidence: 'http_transport_settled' });
});

test('no-process settlement cannot release a known child even if dispatch was not marked', async () => {
  const f = fixture(); f.bind('cli');
  for (const evidence of ['spawn_failed', 'not_dispatched']) assert.throws(() => f.life.settlePhysical({ evidence }), /matching transport/);
  await f.life.settlePhysical({ evidence: 'process_tree_settled' });
});

test('scheduler failure rolls back admission and reentrant timer cleanup settles only once', async () => {
  const registry = new Map(); let releases = 0;
  const common = { runId: 'timer-failure', registry, supervisor: new RunSupervisor(), releaseAdmission: () => { releases++; } };
  assert.throws(() => createAttemptLifecycle({ ...common, schedule() { throw new Error('timer failed'); } }), /timer failed/);
  assert.equal(registry.size, 0); assert.equal(releases, 1);
  let life, persisted = 0;
  life = createAttemptLifecycle({ ...common, schedule: () => 1,
    clearSchedule() { life.settlePhysical({ evidence: 'not_dispatched', persist() { persisted++; } }); throw new Error('clear failed'); } });
  const result = await life.settlePhysical({ evidence: 'not_dispatched', persist() { persisted++; } });
  assert.equal(persisted, 1); assert.equal(releases, 2); assert.equal(registry.size, 0);
  assert.equal(result.snapshot.callbackErrors.length, 1);
});

test('quarantine preserves admission and resources until independently verified settlement', async () => {
  const f = fixture(); f.bind('cli'); f.life.markDispatched();
  f.life.sealOutcome({ ok: true });
  let physicalFinished = false, cleaned = 0, persisted = 0, terminal;
  f.life.physicalDone.then(() => { physicalFinished = true; });
  const diagnostic = f.life.quarantinePhysical({ error: new Error('private path and provider content') });
  assert.equal(f.life.quarantinePhysical(), diagnostic);
  assert.equal(f.life.clientDetached(), false);
  f.advance(10000); assert.equal(f.life.evaluate(), false);
  await Promise.resolve();
  assert.equal(physicalFinished, false); assert.equal(f.registry.size, 1);
  assert.deepEqual(f.counts(), { releases: 0, stops: 0, boundaries: 0 });
  assert.equal(f.life.snapshot().phase, 'quarantined');
  assert.equal(f.life.snapshot().physicalEvidence, null);
  assert.equal(f.life.snapshot().finalized, false);
  assert.equal(f.life.snapshot().cleanupStatus, 'quarantined_unverified');
  assert.equal(JSON.stringify(f.life.snapshot()).includes('private'), false);
  for (const evidence of ['spawn_failed', 'not_dispatched', 'process_tree_unverified']) {
    assert.throws(() => f.life.settlePhysical({ evidence }), /matching transport/);
  }
  const first = f.life.settlePhysical({ evidence: 'process_tree_settled', cleanup() {
    cleaned++; assert.equal(f.life.settlePhysical({ evidence: 'process_tree_settled' }), first);
    assert.equal(f.life.quarantinePhysical(), first); return { ok: true };
  }, persist({ outcome }) { persisted++; terminal = outcome; } });
  assert.equal(f.life.settlePhysical({ evidence: 'process_tree_settled' }), first);
  await first;
  assert.equal(physicalFinished, true); assert.equal(cleaned, 1); assert.equal(persisted, 1);
  assert.equal(terminal.ok, true); assert.equal(f.counts().releases, 1); assert.equal(f.registry.size, 0);
  assert.equal(f.life.snapshot().phase, 'settled');
});

test('startup quarantine cannot be revived by late identity, output, usage, CPU or timers', async () => {
  let tick, clearCalls = 0, life;
  const registry = new Map();
  life = createAttemptLifecycle({ runId: 'run_startup_quarantine', registry, supervisor: new RunSupervisor(),
    releaseAdmission() { assert.fail('unknown owner released admission'); }, schedule(fn) { tick = fn; return 1; },
    clearSchedule() { clearCalls++; assert.equal(life.snapshot().phase, 'quarantined'); tick(); } });
  life.bindTransport({ type: 'cli', requestStop() { assert.fail('late stop attempted'); } });
  life.quarantinePhysical();
  assert.equal(life.markDispatched(), false);
  assert.throws(() => life.identifyProcess(321), /identity handoff/);
  assert.equal(life.observeOutput('late'), false);
  assert.equal(life.observeUsage({ total_tokens: 900 }), false);
  assert.equal(life.observeCpu(1000), false);
  assert.equal(life.requestStop({ reason: 'client_cancelled' }), false);
  tick(); assert.equal(clearCalls, 1); assert.equal(registry.size, 1);
  assert.equal(life.sealOutcome({ status: 'unsettled' }), true);
  assert.equal(life.snapshot().phase, 'quarantined');
  const normalized = normalizeTransportLifecycle({ ...life.snapshot(),
    quarantine: { ...life.snapshot().quarantine, detail: 'private prose', diagnosticHash: 'bad' } });
  assert.equal(normalized.phase, 'quarantined'); assert.equal(normalized.physicalEvidence, null);
  assert.deepEqual(Object.keys(normalized.quarantine).sort(), ['at', 'code']);
  assert.equal(JSON.stringify(normalized).includes('private'), false);
});

test('quarantine preserves the first stop reason and rejects non-CLI transports', async () => {
  const f = fixture(); f.bind('cli'); f.life.markDispatched();
  f.life.requestStop({ reason: 'token_budget', source: 'supervisor' }); f.life.quarantinePhysical();
  f.life.clientDetached(); assert.equal(f.life.snapshot().stop.reason, 'token_budget');
  assert.deepEqual(f.counts(), { releases: 0, stops: 1, boundaries: 1 });
  await f.life.settlePhysical({ evidence: 'process_tree_settled' });
  const http = fixture(); http.bind(); assert.throws(() => http.life.quarantinePhysical(), /CLI transport/);
  await http.life.settlePhysical({ evidence: 'not_dispatched' });
});
