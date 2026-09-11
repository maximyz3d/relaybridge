'use strict';
const nativeTest = require('node:test');
const test = process.platform === 'linux' ? nativeTest : nativeTest.skip;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createOwnerJournal, hash, canonical, MAX_JOURNAL_FILES, MAX_OWNER_EVENTS, PUBLICATION_HEADROOM } = require('../lib/execution-owner');
const BASE = { requestId: 'request_one', invocationId: 'invoke_one', attemptId: 'attempt_one', runId: 'run_one', taskId: 'task_one',
  provider: 'fixture', accountId: 'default', executionHash: hash('execution'), cwdIdentityHash: hash('cwd'), cwdPolicyId: hash('policy'), reservationId: 'reservation_one' };
const PIN = { hostPid: 12345, starttime: '100', nsIno: '99999', namespacePid: 1, bootId: '11111111-1111-1111-1111-111111111111' };
function fixture(t, extra = {}) {
  const directory = extra.directory || fs.mkdtempSync(path.join(os.tmpdir(), 'rb-owner-regression-'));
  fs.chmodSync(directory, 0o700);
  const owners = [], handles = [], effects = new Set();
  let valid = true, releaseCalls = 0;
  const options = {
    directory, receiptStoreId: hash('store'), hostIdentity: hash('host'), qualifyHost: () => true,
    validateCurrentBinding: () => valid,
    resolveTrustedLaunch: binding => ({ profile: { version: 1, kind: 'linux_pid1_owner', policyId: binding.cwdPolicyId,
      cwdIdentityHash: binding.cwdIdentityHash, executionHash: binding.executionHash, writeRoots: [] },
    launch: { file: process.execPath, args: [], cwd: directory, env: { PATH: '/usr/bin:/bin' } } }),
    probeNamespace: pin => {
      const owner = owners.find(item => canonical(item.pin) === canonical(pin));
      return owner?.alive ? { state: 'alive' } : { state: 'gone', evidence: 'pid_absent' };
    },
    createPhysicalOwner: () => {
      let resolve;
      const owner = { pin: { ...PIN, hostPid: PIN.hostPid + owners.length, nsIno: String(Number(PIN.nsIno) + owners.length) },
        alive: true, allowed: 0, stopped: 0, started: false, flags: { wrapperExited: false, stdoutEof: false, stderrEof: false },
        ready: Promise.resolve(), physicalDone: new Promise(done => { resolve = done; }),
        start: async () => { owner.started = true; return null; },
        snapshot: () => ({ pin: { ...owner.pin }, ...owner.flags }),
        allowProvider: async () => { owner.allowed++; return true; },
        requestStop: () => { owner.stopped++; return true; },
        finish: ({ resolvePromise = true, ...flags } = {}) => {
          owner.alive = false; owner.flags = { wrapperExited: true, stdoutEof: true, stderrEof: true, ...flags };
          if (resolvePromise) resolve({ evidence: 'process_tree_settled' });
        },
      };
      owners.push(owner); return owner;
    },
    applyTaskRelease: async (_binding, decision) => { releaseCalls++; effects.add(decision.decisionId); return true; },
    ...extra,
  };
  function open() { const value = createOwnerJournal(options); handles.push(value); return value; }
  function dispose() { for (const handle of handles) try { handle.close(); } catch {} if (!extra.directory) fs.rmSync(directory, { recursive: true, force: true }); }
  if (t) t.after(dispose);
  return { directory, options, owners, open, dispose, setValid: value => { valid = value; }, releases: () => releaseCalls, effects: () => effects.size };
}
const intent = (store, id) => ({ recoveryId: 'recovery_one', expectedRevision: store.inspect(id).revision,
  expectedBindingHash: store.inspect(id).bindingHash, scope: 'task_capacity', reason: 'Release this exact settled task capacity only' });
async function gated(f, store = f.open(), binding = BASE) {
  const id = store.prepare(binding).ownerId; await store.start(id); await store.permit(id);
  return { store, id, owner: f.owners.at(-1) };
}
async function settled(f, store) {
  const result = await gated(f, store); result.owner.finish(); await result.store.confirmPhysical(result.id); return result;
}
const journalNames = directory => fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort();
const tempNames = directory => fs.readdirSync(directory).filter(name => /^\.rb-/.test(name));
function faultingTempIO() {
  const io = Object.create(fs); const control = { failCleanup: true, afterUnlink: null };
  io.unlinkSync = location => {
    if (/\.rb-[a-f0-9]{32}\.tmp$/.test(location)) {
      if (control.failCleanup) throw Object.assign(new Error('interrupted cleanup'), { code: 'EIO' });
      const result = fs.unlinkSync(location); control.afterUnlink?.(); return result;
    }
    return fs.unlinkSync(location);
  };
  return { io, control };
}

// Actual process death releases the real flock. The only worker is an inert
// in-memory fake physical owner; no native provider or project is invoked.
async function crashChild(directory, position) {
  let armed = false, decisionPublished = false;
  const io = Object.create(fs);
  io.linkSync = (from, to) => {
    if (armed && to.endsWith('.0005.json') && position === 'before-publish') process.kill(process.pid, 'SIGKILL');
    const result = fs.linkSync(from, to);
    if (armed && to.endsWith('.0005.json')) decisionPublished = true;
    return result;
  };
  io.fsyncSync = fd => {
    if (decisionPublished && fs.fstatSync(fd).isDirectory() && position === 'after-publish') process.kill(process.pid, 'SIGKILL');
    return fs.fsyncSync(fd);
  };
  const f = fixture(null, { directory, fsApi: io });
  const { store, id } = await settled(f);
  const request = intent(store, id);
  fs.writeSync(1, JSON.stringify({ id, request }) + '\n');
  armed = true; store.recover(id, request); throw new Error('expected crash did not happen');
}
if (process.argv[2] === '--crash-child') {
  crashChild(process.argv[3], process.argv[4]).catch(cause => { fs.writeSync(2, cause.stack + '\n'); process.exitCode = 1; });
} else {
  test('namespace gone cannot replace unresolved physicalDone, wrapper exit or either EOF', async t => {
    for (const missing of ['physicalDone', 'wrapperExited', 'stdoutEof', 'stderrEof']) {
      const f = fixture(t), { store, id, owner } = await gated(f);
      owner.finish(missing === 'physicalDone' ? { resolvePromise: false } : { [missing]: false });
      await Promise.resolve();
      assert.throws(() => store.recover(id, intent(store, id)), { code: 'OWNER_PHYSICAL_PENDING' }, missing);
      if (missing !== 'physicalDone') await assert.rejects(store.confirmPhysical(id), { code: 'OWNER_PHYSICAL_PENDING' }, missing);
      await assert.rejects(store.applyRelease(id, 'caller-forged-decision'), { code: 'OWNER_DECISION_UNTRUSTED' });
      assert.equal(store.heldCount(), 1); assert.equal(store.inspect(id).proof, undefined); assert.equal(f.releases(), 0);
    }
  });

  test('applyRelease rechecks live composite state independently after a valid decision', async t => {
    for (const missing of ['wrapperExited', 'stdoutEof', 'stderrEof']) {
      const f = fixture(t), { store, id, owner } = await settled(f), decision = store.recover(id, intent(store, id));
      owner.flags[missing] = false;
      await assert.rejects(store.applyRelease(id, decision.decisionId), { code: 'OWNER_PHYSICAL_PENDING' });
      assert.equal(store.heldCount(), 1); assert.equal(f.releases(), 0);
      owner.flags[missing] = true; await store.applyRelease(id, decision.decisionId); assert.equal(f.effects(), 1);
    }
  });

  test('restored pin-only owner stays held; old namespace-only proof cannot restore authority', async t => {
    const f = fixture(t), { store, id, owner } = await gated(f); owner.finish(); store.close();
    const restored = f.open(); assert.throws(() => restored.recover(id, intent(restored, id)), { code: 'OWNER_PROOF_UNAVAILABLE' });
    assert.equal(restored.heldCount(), 1); assert.equal(f.releases(), 0);
    const other = fixture(t), ready = await settled(other); ready.store.close();
    const name = journalNames(other.directory).at(-1), location = path.join(other.directory, name), row = JSON.parse(fs.readFileSync(location));
    row.body = { pinHash: row.body.pinHash, evidence: row.body.evidence }; delete row.hash; row.hash = hash(row);
    fs.writeFileSync(location, canonical(row) + '\n');
    assert.throws(() => other.open(), { code: 'OWNER_SCHEMA_INVALID' }); assert.equal(other.releases(), 0);
  });

  test('recover mutates only decision and exact live retry survives either publication barrier failure', async t => {
    for (const position of ['before-publish', 'after-publish']) {
      const io = Object.create(fs); let armed = false, published = false;
      io.linkSync = (from, to) => {
        if (armed && to.endsWith('.0005.json') && position === 'before-publish') throw Object.assign(new Error('before publication'), { code: 'EIO' });
        const result = fs.linkSync(from, to); if (armed && to.endsWith('.0005.json')) published = true; return result;
      };
      io.fsyncSync = fd => { if (armed && published && fs.fstatSync(fd).isDirectory() && position === 'after-publish') throw Object.assign(new Error('after publication'), { code: 'EIO' }); return fs.fsyncSync(fd); };
      const f = fixture(t, { fsApi: io }), { store, id } = await settled(f), request = intent(store, id), proofRevision = request.expectedRevision;
      armed = true; assert.throws(() => store.recover(id, request), { code: 'OWNER_DURABILITY_UNCONFIRMED' });
      assert.equal(store.inspect(id).revision, proofRevision); assert.equal(store.admissionBlocked(), true); assert.equal(f.releases(), 0);
      assert.throws(() => store.recover(id, { ...request, reason: 'different intent' }), /OWNER_/);
      armed = false; const decision = store.recover(id, request);
      assert.equal(store.inspect(id).revision, proofRevision + 1); assert.deepEqual(store.recover(id, request), decision);
      await store.applyRelease(id, decision.decisionId); await store.applyRelease(id, decision.decisionId); assert.equal(f.effects(), 1); assert.equal(f.releases(), 1);
    }
  });

  test('actual SIGKILL before/after decision publication preserves original recovery request', async t => {
    for (const position of ['before-publish', 'after-publish']) {
      const f = fixture(t), crash = spawnSync(process.execPath, [__filename, '--crash-child', f.directory, position], { encoding: 'utf8', timeout: 10000, maxBuffer: 2048 });
      assert.equal(crash.signal, 'SIGKILL', crash.stderr); const { id, request } = JSON.parse(crash.stdout.trim());
      const restored = f.open(), decision = restored.recover(id, request);
      assert.equal(request.expectedRevision, 4); assert.equal(restored.inspect(id).revision, 5);
      await restored.applyRelease(id, decision.decisionId); await restored.applyRelease(id, decision.decisionId);
      assert.equal(f.effects(), 1); assert.equal(f.releases(), 1); assert.equal(f.owners.length, 0, 'restart must not recreate a physical owner');
      assert.throws(() => restored.recover(id, { ...request, recoveryId: 'other' }), { code: 'OWNER_RECOVERY_ID_CONFLICT' });
    }
  });

  test('legitimate temp hardlink repairs only after complete validation and strict barriers', t => {
    const { io, control } = faultingTempIO(), f = fixture(t, { fsApi: io }), store = f.open();
    assert.throws(() => store.prepare(BASE), { code: 'OWNER_DURABILITY_UNCONFIRMED' }); assert.equal(f.owners.length, 0);
    assert.equal(tempNames(f.directory).length, 1); const canonicalFile = path.join(f.directory, journalNames(f.directory)[0]); assert.equal(fs.statSync(canonicalFile).nlink, 2);
    store.close(); control.failCleanup = false; const restored = f.open();
    assert.equal(tempNames(f.directory).length, 0); assert.equal(fs.statSync(canonicalFile).nlink, 1); assert.equal(restored.heldCount(), 1); assert.equal(f.owners.length, 0);
    const id = JSON.parse(fs.readFileSync(canonicalFile)).ownerId;
    assert.throws(() => restored.recover(id, intent(restored, id)), { code: 'OWNER_PROOF_UNAVAILABLE' });
  });

  test('external hardlink and second canonical alias are not legitimate cleanup authority', t => {
    for (const kind of ['external', 'canonical-alias']) {
      const { io, control } = faultingTempIO(), f = fixture(t, { fsApi: io }), store = f.open();
      assert.throws(() => store.prepare(BASE)); store.close(); control.failCleanup = false;
      const source = path.join(f.directory, journalNames(f.directory)[0]);
      const target = kind === 'external' ? f.directory + '-outside-link' : path.join(f.directory, 'owner_' + 'f'.repeat(32) + '.0001.json');
      t.after(() => fs.rmSync(target, { force: true })); fs.linkSync(source, target);
      assert.throws(() => f.open(), { code: 'OWNER_JOURNAL_UNTRUSTED' }); assert.equal(tempNames(f.directory).length, 1); assert.equal(f.owners.length, 0);
    }
  });

  test('malformed canonical content never authorizes deleting its matching temp', t => {
    const { io, control } = faultingTempIO(), f = fixture(t, { fsApi: io }), store = f.open(); assert.throws(() => store.prepare(BASE)); store.close(); control.failCleanup = false;
    const location = path.join(f.directory, journalNames(f.directory)[0]); fs.writeFileSync(location, fs.readFileSync(location, 'utf8').replace('request_one', 'request_bad'));
    assert.throws(() => f.open(), { code: 'OWNER_JOURNAL_INVALID' }); assert.equal(tempNames(f.directory).length, 1);
  });

  test('changed temp identity during validation is rejected without deleting replacement', t => {
    const { io, control } = faultingTempIO(); let swap = false, replacement = null;
    io.fsyncSync = fd => {
      if (swap && fs.fstatSync(fd).isFile() && fs.readlinkSync('/proc/self/fd/' + fd).endsWith('.json')) {
        swap = false; const directory = path.dirname(fs.readlinkSync('/proc/self/fd/' + fd)); replacement = path.join(directory, tempNames(directory)[0]);
        fs.unlinkSync(replacement); fs.writeFileSync(replacement, 'replacement temp', { mode: 0o600 });
      }
      return fs.fsyncSync(fd);
    };
    const f = fixture(t, { fsApi: io }), store = f.open(); assert.throws(() => store.prepare(BASE)); store.close(); control.failCleanup = false; swap = true;
    assert.throws(() => f.open(), { code: 'OWNER_JOURNAL_CHANGED' }); assert.equal(fs.readFileSync(replacement, 'utf8'), 'replacement temp');
  });

  test('repair unlink, directory-fsync and close failures never grant authority; retry confirms later', t => {
    for (const fault of ['unlink', 'directory-sync', 'close']) {
      const { io, control } = faultingTempIO(); let repairing = false, unlinked = false;
      control.afterUnlink = () => { unlinked = true; };
      io.fsyncSync = fd => { if (repairing && unlinked && fault === 'directory-sync' && fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('repair fsync failed'), { code: 'EIO' }); return fs.fsyncSync(fd); };
      io.closeSync = fd => {
        const shouldFail = repairing && fault === 'close' && fs.readlinkSync('/proc/self/fd/' + fd).endsWith('.json');
        fs.closeSync(fd); if (shouldFail) throw Object.assign(new Error('strict close failed after close'), { code: 'EIO' });
      };
      const f = fixture(t, { fsApi: io }), store = f.open(); assert.throws(() => store.prepare(BASE)); store.close();
      control.failCleanup = fault === 'unlink'; repairing = true;
      assert.throws(() => f.open(), { code: 'OWNER_DURABILITY_UNCONFIRMED' }, fault); assert.equal(f.owners.length, 0); assert.equal(f.releases(), 0);
      control.failCleanup = false; repairing = false; const restored = f.open(); assert.equal(restored.heldCount(), 1); assert.equal(tempNames(f.directory).length, 0);
    }
  });

  test('orphan temp or arbitrary unexpected entry blocks admission without filename-only cleanup', t => {
    for (const name of ['.rb-' + 'a'.repeat(32) + '.tmp', 'unexpected.json']) {
      const f = fixture(t), store = f.open(), location = path.join(f.directory, name); fs.writeFileSync(location, 'unowned bytes', { mode: 0o600 });
      assert.throws(() => store.prepare(BASE), { code: 'OWNER_JOURNAL_UNTRUSTED' }); assert.equal(f.owners.length, 0); assert.equal(fs.readFileSync(location, 'utf8'), 'unowned bytes');
      store.close(); assert.throws(() => f.open(), { code: 'OWNER_JOURNAL_UNTRUSTED' }); assert.equal(fs.existsSync(location), true);
    }
  });

  test('space is reserved before admission so every admitted owner can finish and reopen', async t => {
    const f = fixture(t, { maxJournalFiles: 20 }), store = f.open(), admitted = [];
    for (let index = 0; index < 3; index++) {
      const binding = { ...BASE, runId: 'run_' + index, attemptId: 'attempt_' + index, taskId: 'task_' + index };
      admitted.push({ id: store.prepare(binding).ownerId, owner: f.owners.at(-1) });
    }
    assert.deepEqual(store.capacity(), { namedFiles: 4, reservedEvents: 15, temporaryHeadroom: 1, maxFiles: 20 });
    assert.throws(() => store.prepare({ ...BASE, runId: 'run_overflow', attemptId: 'attempt_overflow' }), { code: 'OWNER_JOURNAL_CAPACITY' }); assert.equal(f.owners.length, 3);
    for (const { id, owner } of admitted) {
      await store.start(id); await store.permit(id); owner.finish(); await store.confirmPhysical(id);
      const decision = store.recover(id, intent(store, id)); await store.applyRelease(id, decision.decisionId);
    }
    assert.equal(store.heldCount(), 0); assert.equal(fs.readdirSync(f.directory).length, 19); store.close();
    const restored = f.open(); assert.equal(restored.heldCount(), 0); assert.equal(restored.capacity().reservedEvents, 0); assert.equal(f.owners.length, 3);
  });

  test('original 342-owner overflow reproduction is stopped before the un-restorable owner', { timeout: 30000 }, async t => {
    const f = fixture(t), store = f.open();
    const limit = Math.floor((MAX_JOURNAL_FILES - 1 - PUBLICATION_HEADROOM) / MAX_OWNER_EVENTS);
    assert.equal(limit, 341);
    for (let index = 0; index < limit; index++) {
      const binding = { ...BASE, runId: 'run_' + index, attemptId: 'attempt_' + index, taskId: 'task_' + index };
      const { id, owner } = await gated(f, store, binding); owner.finish(); await store.confirmPhysical(id);
      const decision = store.recover(id, intent(store, id)); await store.applyRelease(id, decision.decisionId);
    }
    assert.throws(() => store.prepare({ ...BASE, runId: 'run_342', attemptId: 'attempt_342' }), { code: 'OWNER_JOURNAL_CAPACITY' });
    assert.equal(f.owners.length, 341); assert.equal(fs.readdirSync(f.directory).length, 2047); assert.equal(store.heldCount(), 0);
    store.close(); const restored = f.open(); assert.equal(restored.heldCount(), 0); assert.equal(restored.capacity().namedFiles, 2047);
  });
}
