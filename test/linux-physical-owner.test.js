'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLinuxPhysicalOwner } = require('../lib/linux-physical-owner');
const { probeLinuxNamespace } = require('../lib/linux-owner-identity');
const { waitFor } = require('./helpers/temporary-bridge');
const ROOT = path.resolve(__dirname, '..');
const AVAILABLE = process.platform === 'linux' && fs.existsSync('/usr/bin/bwrap');

function fixture(t, options = {}) {
  const owner = createLinuxPhysicalOwner({ runId: `run_adapter_${Math.random().toString(36).slice(2)}`, ...options });
  // The production bridge's listener owns liveness; isolated tests stand in
  // for it while the owner's background reconciliation timers remain unref'ed.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(async () => { owner.requestStop(); await owner.completion; clearInterval(keepAlive); });
  return owner;
}
async function launch(owner, program, env = process.env, file = process.execPath) {
  const proc = await owner.start({ file, args: ['-e', program], cwd: ROOT, env });
  const stdout = [], stderr = [];
  if (proc) {
    proc.stdout.on('data', (data) => stdout.push(data)); proc.stderr.on('data', (data) => stderr.push(data));
  }
  return { proc, stdout: () => Buffer.concat(stdout), stderr: () => Buffer.concat(stderr) };
}

test('Linux adapter pins before release and preserves binary streams plus provider Node options', { skip: !AVAILABLE, timeout: 10000 }, async (t) => {
  const owner = fixture(t);
  const child = await launch(owner, "process.stderr.write(Buffer.from([255,0,10]));if(process.env.NODE_OPTIONS!=='--no-warnings'||Object.keys(process.env).some(k=>k.startsWith('RELAYBRIDGE_OWNER_')))process.exit(99);process.stdin.pipe(process.stdout);",
    { ...process.env, NODE_OPTIONS: '--no-warnings' });
  await owner.ready;
  assert.equal(owner.snapshot().physicalAttemptCount, 1);
  assert.equal(owner.snapshot().providerState, 'not_released');
  assert.equal(owner.snapshot().pin.namespacePid, 1);
  assert.equal(await owner.allowProvider(), true); assert.equal(await owner.allowProvider(), false);
  const input = Buffer.from([0, 1, 127, 128, 195, 255]); child.proc.stdin.end(input);
  const done = await owner.physicalDone;
  assert.equal(await owner.completion, done);
  assert.equal(done.evidence, 'process_tree_settled');
  assert.equal(done.snapshot.rootExit.code, 0); assert.equal(done.snapshot.modelInvocation, true);
  assert.equal(done.snapshot.wrapperExited && done.snapshot.stdoutEof && done.snapshot.stderrEof, true);
  assert.deepEqual(child.stdout(), input); assert.deepEqual(child.stderr(), Buffer.from([255, 0, 10]));
});

test('stop before start creates no owner or provider, and repeat start cannot create another', { skip: !AVAILABLE, timeout: 10000 }, async (t) => {
  let spawns = 0;
  const owner = fixture(t, { spawnProcess() { spawns++; assert.fail('late spawn'); } });
  assert.equal(owner.requestStop(), true); assert.equal(owner.requestStop(), false);
  assert.equal((await launch(owner, "process.exit(0)")).proc, null);
  await assert.rejects(owner.ready, /BEFORE_SPAWN/);
  const done = await owner.physicalDone;
  assert.equal(done.evidence, 'not_dispatched'); assert.equal(done.snapshot.physicalAttemptCount, 0);
  assert.equal(done.snapshot.modelInvocation, false); assert.equal(spawns, 0);
  await assert.rejects(launch(owner, ''), /already started/);
});

test('stop after pin but before proceed settles the owner with zero provider invocation', { skip: !AVAILABLE, timeout: 10000 }, async (t) => {
  const owner = fixture(t), child = await launch(owner, "process.stdout.write('UNEXPECTED');");
  await owner.ready; owner.requestStop(); child.proc.stdin.end();
  assert.equal(await owner.allowProvider(), false);
  const done = await owner.physicalDone;
  assert.equal(done.evidence, 'process_tree_settled'); assert.equal(done.snapshot.physicalAttemptCount, 1);
  assert.equal(done.snapshot.modelInvocation, false); assert.equal(child.stdout().length, 0);
});

test('a missing wrapper executable is a genuine no-PID spawn failure', { skip: !AVAILABLE, timeout: 10000 }, async (t) => {
  const owner = fixture(t, { bwrapPath: '/nonexistent/rb-bwrap-fixture' });
  await launch(owner, ''); await assert.rejects(owner.ready);
  const done = await owner.physicalDone;
  assert.equal(done.evidence, 'spawn_failed'); assert.equal(done.snapshot.physicalAttemptCount, 0);
  assert.equal(done.snapshot.ownerPid, null); assert.equal(done.snapshot.modelInvocation, false);
});

test('post-owner-spawn pin failure quarantines rather than inventing spawn_failed proof', { skip: !AVAILABLE, timeout: 10000 }, async (t) => {
  const owner = fixture(t, { settleTimeoutMs: 150, pinNamespace() { throw new Error('injected private path'); } });
  const child = await launch(owner, "process.stdout.write('UNEXPECTED');");
  let physicalResolved = false; owner.physicalDone.then(() => { physicalResolved = true; });
  await assert.rejects(owner.ready); child.proc.stdin.end();
  const result = await owner.completion;
  assert.equal(result.evidence, null); assert.equal(result.snapshot.state, 'quarantined');
  assert.equal(result.snapshot.physicalAttemptCount, 1); assert.equal(result.snapshot.modelInvocation, false);
  assert.equal(result.snapshot.pin, null); assert.equal(physicalResolved, false);
  assert.equal(child.stdout().length, 0); assert.equal(JSON.stringify(result).includes('private'), false);
});

test('wrapper exit and pipe EOF do not settle without namespace death; late proof reconciles once', { skip: !AVAILABLE, timeout: 10000 }, async (t) => {
  let hideDeath = true;
  const owner = fixture(t, { settleTimeoutMs: 150, probeNamespace(pin) {
    const proof = probeLinuxNamespace(pin);
    return hideDeath && proof.state === 'gone' ? { state: 'unverified' } : proof;
  } });
  const child = await launch(owner, "process.stdout.write('done');");
  await owner.allowProvider(); child.proc.stdin.end();
  const diagnostic = await owner.completion;
  assert.equal(diagnostic.snapshot.state, 'quarantined');
  assert.equal(diagnostic.snapshot.wrapperExited && diagnostic.snapshot.stdoutEof && diagnostic.snapshot.stderrEof, true);
  assert.equal(diagnostic.evidence, null);
  hideDeath = false;
  const done = await owner.physicalDone;
  assert.equal(done.evidence, 'process_tree_settled'); assert.equal(done.snapshot.state, 'settled');
  assert.equal(await owner.completion, diagnostic, 'already-delivered uncertainty is not silently rewritten');
});

test('a provider executable failure remains distinct from its successfully spawned owner', { skip: !AVAILABLE, timeout: 10000 }, async (t) => {
  const owner = fixture(t), child = await launch(owner, '', process.env, '/nonexistent/rb-provider-fixture');
  await owner.allowProvider(); child.proc.stdin.end();
  const done = await owner.physicalDone;
  assert.equal(done.evidence, 'process_tree_settled'); assert.equal(done.snapshot.physicalAttemptCount, 1);
  assert.equal(done.snapshot.providerState, 'failed_preexec'); assert.equal(done.snapshot.modelInvocation, false);
});

test('a stopped active provider uses control-driven namespace termination', { skip: !AVAILABLE, timeout: 10000 }, async (t) => {
  const owner = fixture(t), child = await launch(owner, "process.stdout.write('ready');setInterval(()=>{},1000);");
  await owner.allowProvider(); child.proc.stdin.end();
  await waitFor(() => child.stdout().toString() === 'ready', 3000);
  owner.requestStop();
  const done = await owner.physicalDone;
  assert.equal(done.evidence, 'process_tree_settled'); assert.equal(done.snapshot.modelInvocation, true);
  assert.equal(probeLinuxNamespace(done.snapshot.pin).state, 'gone');
});

test('provider-only failing Node preload cannot execute inside the trusted gate', { skip: !AVAILABLE, timeout: 10000 }, async (t) => {
  const owner = fixture(t), child = await launch(owner, "process.stdout.write('unexpected');",
    { ...process.env, NODE_OPTIONS: '--require=/nonexistent/rb-provider-preload-fixture' });
  await owner.ready;
  assert.equal(owner.snapshot().providerState, 'not_released');
  await owner.allowProvider(); child.proc.stdin.end();
  const done = await owner.physicalDone;
  assert.equal(done.evidence, 'process_tree_settled'); assert.equal(done.snapshot.providerState, 'spawned');
  assert.equal(done.snapshot.rootExit.code, 1); assert.equal(child.stdout().length, 0);
  assert.match(child.stderr().toString(), /rb-provider-preload-fixture/);
});
