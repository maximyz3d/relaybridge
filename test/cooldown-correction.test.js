'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createCooldownStore, BACKOFF } = require('../lib/provider-cooldown');
const { authorizeContextCorrection, validCorrectionRequest, readCorrectionReceipts } = require('../lib/cooldown-correction');
const { startTestBridge, completeJsonLines } = require('./helpers/temporary-bridge');
const seat = 'subscription:anthropic:default';
function receipt(current, store = 'store') {
  return { receiptId: current.sourceReceiptId, receiptStoreId: store, timestamp: new Date(current.lastOffenceAt + 1).toISOString(),
    event: 'bridge_provider_call', modelInvocation: true, provider: 'claude_fable', failureClass: 'rate_limit', status: 'dropped', outputChars: 0,
    providerTerminalReason: 'rapid_refill_breaker', providerApiErrorStatus: null, quotaEvidence: null, vendorQuota: null,
    providerActionRequired: null, supervisorStopReason: null, providerErrorHash: null,
    providerRetryCount: 0, providerRetryObservedEvents: 0, providerRetryInvalidEvents: 0, providerRetryDuplicateEvents: 0,
    providerErrorCount: 0, providerErrorObserved: 0, providerErrorInvalid: 0, providerRetryEventsTruncated: false,
    providerErrorDiagnosticTruncated: false, providerRetryEvents: [], providerRetryByStatus: {}, providerRetryByError: {},
    cooldown: { seat, sourceReceiptId: current.sourceReceiptId, reason: 'rate_limited', source: 'backoff', scope: 'account',
      until: current.until, offences: current.offences } };
}
function local(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-correct-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'cooldowns.json'); let time = Date.now();
  const store = createCooldownStore({ file, now: () => time });
  const observation = store.noteFailure(seat, 'rate_limited');
  const attached = store.attachReceipt(observation, 'rcpt_false');
  const expected = store.status(seat);
  return { dir, file, store, expected, observation, attached, advance: () => { time += 10; } };
}
test('exact correction atomically persists audit and survives reopen; single-field mismatches never mutate', (t) => {
  const { file, store, expected } = local(t);
  const before = fs.readFileSync(file, 'utf8');
  for (const key of ['sourceReceiptId', 'sourceObservationId', 'until', 'lastOffenceAt', 'offences']) {
    const wrong = { ...expected, [key]: typeof expected[key] === 'number' ? expected[key] + 1 : 'wrong' };
    assert.equal(store.correctObservation(seat, wrong, () => ({ ok: true })).code, 'observation_changed');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  const current = JSON.parse(before)[seat];
  const result = store.correctObservation(seat, expected, (row) => authorizeContextCorrection({ rows: [receipt(current)], receiptStoreId: 'store', seat, current: row }));
  assert.equal(result.ok, true);
  assert.equal(result.after.offences, 0);
  const reopened = createCooldownStore({ file });
  assert.equal(reopened.status(seat).cooling, false);
  assert.equal(reopened._state()[seat].correction.receiptId, result.correction.receiptId);
  assert.deepEqual(reopened._state()[seat].correction.before, current);
});
test('newer shorter failure is protected even when observation and receipt stay identical', (t) => {
  const { file, store, expected, advance } = local(t);
  advance();
  const second = createCooldownStore({ file });
  second.noteFailure(seat, 'overloaded');
  assert.equal(second.status(seat).sourceReceiptId, expected.sourceReceiptId);
  assert.equal(store.correctObservation(seat, expected, () => ({ ok: true })).code, 'observation_changed');
  assert.equal(store.status(seat).cooling, true);
});
test('known-defect authority rejects real quota, incomplete evidence, duplicates, and live predecessors', () => {
  const now = Date.now(), current = { sourceReceiptId: 'rcpt_false', lastOffenceAt: now - 10,
    until: now - 10 + BACKOFF[1], offences: 2, source: 'backoff', reason: 'rate_limited', scope: 'account' };
  const r = receipt(current), previous = { ...r, receiptId: 'rcpt_previous', timestamp: new Date(now - 1000).toISOString(),
    cooldown: { ...r.cooldown, offences: 1, sourceReceiptId: 'rcpt_previous', until: now - 500 } };
  const check = (rows) => authorizeContextCorrection({ rows, receiptStoreId: 'store', seat, current, now });
  assert.equal(check([previous, r]).ok, true);
  assert.equal(check([r]).ok, false);
  assert.equal(check([previous, r, r]).ok, false);
  for (const patch of [{ providerApiErrorStatus: 429 }, { providerRetryByStatus: { 429: 1 } },
    { providerRetryCount: 1 }, { providerRetryEventsTruncated: true }, { providerErrorCount: 1 },
    { quotaEvidence: {} }, { receiptStoreId: 'wrong' }, { providerErrorHash: undefined }]) {
    assert.equal(check([previous, { ...r, ...patch }]).ok, false, JSON.stringify(patch));
  }
  assert.equal(check([{ ...previous, cooldown: { ...previous.cooldown, until: now + 1 } }, r]).ok, false);
});
test('corrupt authority and incomplete journals fail closed; healthy lock does not quarantine unrelated seats', (t) => {
  const { dir, file, store, expected } = local(t);
  fs.mkdirSync(file + '.lock');
  assert.equal(store.status(seat).cooling, true);
  assert.equal(store.status('subscription:anthropic:other').cooling, false);
  fs.rmdirSync(file + '.lock');
  fs.writeFileSync(file, '{');
  assert.equal(store.correctObservation(seat, expected, () => ({ ok: true })).code, 'authority_unavailable');
  fs.writeFileSync(path.join(dir, '2026-09-26.jsonl'), '{"receiptId":"rcpt_false"}');
  assert.throws(() => readCorrectionReceipts(dir), /incomplete/);
});
// Runs only in the fixture's independent Node children. Observers call each real
// operation once. Recording adds timing overhead; it cannot establish the old cause.
function writerMain() {
  const fs = require('node:fs'), path = require('node:path');
  const [modulePath, file, seat, callsText, faultText] = process.argv.slice(1);
  const root = path.dirname(file), descriptors = new Map(), errors = new Map();
  const stamp = () => ({ monotonicNs: process.hrtime.bigint().toString(), wall: new Date().toISOString() });
  const evidence = { controlledFault: faultText === 'true', pid: process.pid, start: stamp(), results: [] };
  const errorRecord = (error) => ({ code: error.code || null, errno: error.errno ?? null,
    syscall: error.syscall || null, errorPath: error.path || null, errorDestination: error.dest || null,
    message: error.message, injected: error.injected === true });
  const fixturePath = (arg) => {
    const value = typeof arg === 'number' ? descriptors.get(arg) : typeof arg === 'string' ? path.resolve(arg) : null;
    return value && (value === root || value.startsWith(root + path.sep)) ? value : null;
  };
  // Deliberate control injection is separate from passthrough observation below.
  if (evidence.controlledFault) {
    const rename = fs.renameSync;
    fs.renameSync = function(from, to) {
      if (to === file) throw Object.assign(new Error('controlled rename fault, not historical cause'),
        { code: 'EIO', syscall: 'rename', path: from, dest: to, injected: true });
      return Reflect.apply(rename, this, arguments);
    };
  }
  for (const op of ['mkdirSync', 'openSync', 'writeFileSync', 'fsyncSync', 'renameSync',
    'rmdirSync', 'readFileSync', 'statSync', 'closeSync']) {
    const real = fs[op];
    fs[op] = function(...args) {
      const source = fixturePath(args[0]), destination = op === 'renameSync' ? fixturePath(args[1]) : null;
      try {
        const result = Reflect.apply(real, this, args);
        if (op === 'openSync' && source) descriptors.set(result, source);
        if (op === 'closeSync') descriptors.delete(args[0]);
        return result;
      } catch (error) {
        if (source || destination) {
          const key = JSON.stringify([op, error.code || null, source, destination]);
          const previous = errors.get(key);
          if (previous) previous.count += 1;
          else errors.set(key, { count: 1, first: { op, path: source, destination, ...errorRecord(error), ...stamp() } });
        }
        throw error;
      }
    };
  }
  try {
    const store = require(modulePath).createCooldownStore({ file });
    for (let i = 0; i < Number(callsText); i++) {
      try { evidence.results.push({ call: i, result: store.noteFailure(seat, 'overloaded') }); }
      catch (error) { evidence.results.push({ call: i, threw: errorRecord(error) }); throw error; }
    }
  } catch (error) { evidence.thrown = errorRecord(error); process.exitCode = 1; }
  finally {
    evidence.end = stamp(); evidence.filesystemErrors = [...errors.values()];
    process.stdout.write(JSON.stringify(evidence) + '\n');
  }
}
async function runWriters(file, { children, calls, fault = false }) {
  const source = `(${writerMain.toString()})()`;
  // Start all children before awaiting any close; never serialize the real writers.
  return Promise.all(Array.from({ length: children }, () => new Promise((resolve) => {
    const argv = ['-e', source, require.resolve('../lib/provider-cooldown'), file, seat, String(calls), String(fault)];
    let child, stdout = '', stderr = '', spawnError = null;
    try { child = spawn(process.execPath, argv, { stdio: 'pipe' }); }
    catch (error) { resolve({ code: null, signal: null, spawnError: error.message, stdout, stderr }); return; }
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', (error) => { spawnError = error.message; });
    child.on('close', (code, signal) => {
      let evidence = null, parseError = null;
      try { evidence = JSON.parse(stdout); } catch (error) { parseError = error.message; }
      resolve({ pid: child.pid, code, signal, spawnError, stdout, stderr, evidence, parseError });
    });
  })));
}
function snapshot(file) {
  const capture = (fn) => {
    try { return { value: fn() }; }
    catch (error) { return { error: { code: error.code || null, message: error.message, path: error.path || null } }; }
  };
  const bytes = (name) => capture(() => {
    if (!fs.lstatSync(name).isFile()) throw Object.assign(new Error('not a regular fixture file'), { code: 'FIXTURE_NOT_REGULAR', path: name });
    return fs.readFileSync(name).toString('base64');
  });
  const unavailable = capture(() => fs.readdirSync(file + '.unavailable'));
  return { monotonicNs: process.hrtime.bigint().toString(), wall: new Date().toISOString(),
    status: capture(() => createCooldownStore({ file }).status(seat)), authorityBase64: bytes(file),
    lock: capture(() => ({ directory: fs.lstatSync(file + '.lock').isDirectory(), entries: fs.readdirSync(file + '.lock') })),
    unavailable, intents: (unavailable.value || []).map(name => ({ name, bytesBase64: bytes(path.join(file + '.unavailable', name)) })),
    directory: capture(() => fs.readdirSync(path.dirname(file))) };
}
function retain(t, evidence) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-cooldown-evidence-'));
  const file = path.join(dir, 'evidence.json');
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  t.diagnostic(`cooldown fixture evidence retained: ${file}`);
  return file;
}
// Persistent wave child. It makes one real noteFailure per parent request and never starts a
// call on its own. Raw stdout JSON from the terminal handler is the durable record; IPC only
// carries readiness, requests and results. No timers; the child exits when its IPC channel closes.
function waveMain() {
  const fs = require('node:fs'), path = require('node:path');
  const [modulePath, file, seat, indexText] = process.argv.slice(1);
  const index = Number(indexText), root = path.dirname(file), descriptors = new Map(), errors = new Map();
  const stamp = () => ({ monotonicNs: process.hrtime.bigint().toString(), wall: new Date().toISOString() });
  const evidence = { child: index, pid: process.pid, start: stamp(), calls: [], sendErrors: [], shutdown: null };
  const errorRecord = (error) => ({ code: error.code || null, errno: error.errno ?? null,
    syscall: error.syscall || null, errorPath: error.path || null, errorDestination: error.dest || null,
    message: error.message });
  const fixturePath = (arg) => {
    const value = typeof arg === 'number' ? descriptors.get(arg) : typeof arg === 'string' ? path.resolve(arg) : null;
    return value && (value === root || value.startsWith(root + path.sep)) ? value : null;
  };
  for (const op of ['mkdirSync', 'openSync', 'writeFileSync', 'fsyncSync', 'renameSync',
    'rmdirSync', 'readFileSync', 'statSync', 'closeSync']) {
    const real = fs[op];
    fs[op] = function(...args) {
      const source = fixturePath(args[0]), destination = op === 'renameSync' ? fixturePath(args[1]) : null;
      try {
        const result = Reflect.apply(real, this, args);
        if (op === 'openSync' && source) descriptors.set(result, source);
        if (op === 'closeSync') descriptors.delete(args[0]);
        return result;
      } catch (error) {
        if (source || destination) {
          const key = JSON.stringify([op, error.code || null, source, destination]);
          const previous = errors.get(key);
          if (previous) previous.count += 1;
          else errors.set(key, { count: 1, first: { op, path: source, destination, ...errorRecord(error), ...stamp() } });
        }
        throw error;
      }
    };
  }
  let store = null, terminal = false;
  const send = (message) => {
    const failed = (error) => {
      evidence.sendErrors.push({ type: message.type, wave: message.wave ?? null, ...errorRecord(error), ...stamp() });
      evidence.thrown ||= errorRecord(error); process.exitCode = 1; disconnect();
    };
    try { process.send(message, (error) => { if (error) failed(error); }); } catch (error) { failed(error); }
  };
  const finish = (reason) => {
    if (terminal) return;
    terminal = true;
    if (evidence.shutdown === null) evidence.shutdown = reason;
    evidence.end = stamp(); evidence.filesystemErrors = [...errors.values()];
    process.stdout.write(JSON.stringify(evidence) + '\n');
  };
  const disconnect = () => { try { process.disconnect(); } catch (error) { evidence.sendErrors.push({ type: 'disconnect', ...errorRecord(error), ...stamp() }); } };
  process.on('disconnect', () => finish('ipc-disconnect'));
  process.on('exit', () => finish('exit-without-disconnect'));
  process.on('uncaughtException', (error) => { evidence.thrown = errorRecord(error); process.exitCode = 1; disconnect(); });
  process.on('message', (message) => {
    if (message && message.type === 'wave' && Number.isInteger(message.wave)) {
      const call = { child: index, wave: message.wave, pid: process.pid, start: stamp() };
      try { call.result = store.noteFailure(seat, 'overloaded'); }
      catch (error) { call.threw = errorRecord(error); evidence.thrown = call.threw; process.exitCode = 1; }
      call.end = stamp(); evidence.calls.push(call);
      send({ type: 'result', child: index, pid: process.pid, wave: message.wave, call });
    } else if (message && message.type === 'finish') {
      evidence.shutdown = 'finish-requested'; disconnect();
    } else (evidence.unexpectedMessages ||= []).push(message);
  });
  try {
    store = require(modulePath).createCooldownStore({ file });
    send({ type: 'ready', child: index, pid: process.pid });
  } catch (error) { evidence.thrown = errorRecord(error); process.exitCode = 1; disconnect(); }
}
// Parent coordination only: every child is an independent process making real durable writes, and
// each wave sends all requests back to back. The barrier advances only after every dispatched child
// has returned that wave's result. No timer: a silent child with an open channel leaves the barrier
// unadvanced for external supervision. Nothing is retried and no outcome is ever invented; calls
// that never started are reported as undispatched waves, calls that never returned as missing.
function runWaves(file, { children: count, waves }) {
  const source = `(${waveMain.toString()})()`;
  const stamp = () => ({ monotonicNs: process.hrtime.bigint().toString(), wall: new Date().toISOString() });
  const events = [], failures = [], dispatches = [], calls = [];
  let aborted = false, current = -1, launched = false, done = false;
  const record = (type, detail = {}) => events.push({ type, ...detail, ...stamp() });
  const errorText = (error) => ({ code: error.code || null, message: error.message });
  return new Promise((resolve) => {
    const kids = [];
    const settleIfDone = () => {
      if (done || !launched || !kids.every(kid => kid.settled)) return;
      done = true;
      resolve({ aborted, failures, events, dispatches, calls,
        undispatchedWaves: Array.from({ length: Math.max(0, waves - dispatches.length) }, (_, i) => dispatches.length + i),
        kids: kids.map(kid => ({ child: kid.index, pid: kid.pid ?? null, ready: kid.ready, finishSent: kid.finishSent,
          disconnected: kid.disconnected, spawnError: kid.spawnError, sendErrors: kid.sendErrors, close: kid.close,
          stdout: kid.stdout, stderr: kid.stderr, evidence: kid.evidence, parseError: kid.parseError })) });
    };
    const finishAll = () => {
      for (const kid of kids) {
        if (kid.settled || kid.finishSent) continue;
        kid.finishSent = true;
        if (!kid.child || !kid.child.connected) continue;
        const failed = (error) => {
          kid.sendErrors.push({ type: 'finish', ...errorText(error), ...stamp() });
          fail('ipc_send_failed', { child: kid.index, type: 'finish', ...errorText(error) });
          try { kid.child.disconnect(); } catch (disconnectError) { record('disconnect_failed', { child: kid.index, ...errorText(disconnectError) }); }
        };
        try { kid.child.send({ type: 'finish' }, (error) => { if (error) failed(error); }); } catch (error) { failed(error); }
      }
    };
    const fail = (reason, detail = {}) => {
      failures.push({ reason, ...detail, ...stamp() });
      aborted = true; finishAll();
    };
    const settle = (kid) => { kid.settled = true; settleIfDone(); };
    const dispatch = (wave) => {
      const entry = { wave, dispatchStart: stamp(), sent: [], sendFailed: [], notReached: [], completed: null };
      dispatches.push(entry); current = wave;
      for (const kid of kids) {
        if (aborted) { entry.notReached.push(kid.index); continue; }
        const failed = (error) => {
          if (kid.owed === wave) kid.owed = null;
          entry.sent = entry.sent.filter(index => index !== kid.index);
          entry.sendFailed.push(kid.index);
          kid.sendErrors.push({ type: 'wave', wave, ...errorText(error), ...stamp() });
          fail('ipc_send_failed', { child: kid.index, type: 'wave', wave, ...errorText(error) });
        };
        kid.owed = wave;
        try { kid.child.send({ type: 'wave', wave }, (error) => { if (error) failed(error); }); entry.sent.push(kid.index); }
        catch (error) { failed(error); }
      }
      entry.dispatchEnd = stamp();
    };
    const advance = () => {
      if (aborted) { settleIfDone(); return; }
      if (!kids.every(kid => kid.ready) || kids.some(kid => kid.owed !== null)) return;
      if (current >= 0 && dispatches[current].completed === null) dispatches[current].completed = stamp();
      if (current + 1 < waves) dispatch(current + 1); else finishAll();
    };
    for (let index = 0; index < count && !aborted; index++) {
      const kid = { index, child: null, pid: null, ready: false, owed: null, finishSent: false, disconnected: false,
        settled: false, stdout: '', stderr: '', spawnError: null, sendErrors: [], close: null, evidence: null, parseError: null };
      kids.push(kid);
      try { kid.child = spawn(process.execPath, ['-e', source, require.resolve('../lib/provider-cooldown'), file, seat, String(index)],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); }
      catch (error) { kid.spawnError = error.message; kid.settled = true; fail('spawn_failed', { child: index, ...errorText(error) }); continue; }
      const child = kid.child; kid.pid = child.pid;
      child.stdout.on('data', (data) => { kid.stdout += data; });
      child.stderr.on('data', (data) => { kid.stderr += data; });
      child.on('error', (error) => {
        kid.spawnError = error.message; record('child_error', { child: index, ...errorText(error) });
        fail('child_error', { child: index, ...errorText(error) });
        if (!child.pid) settle(kid);
      });
      child.on('disconnect', () => {
        kid.disconnected = true; record('child_disconnect', { child: index, owed: kid.owed });
        if (kid.finishSent) return;
        if (kid.owed !== null) fail('missing_by_disconnect', { child: index, wave: kid.owed });
        else fail(kid.ready ? 'disconnected_before_shutdown_request' : 'disconnected_before_ready', { child: index });
      });
      child.on('message', (message) => {
        const bad = (why) => fail('protocol_violation', { child: index, why, message });
        if (!message || typeof message !== 'object' || message.child !== index || message.pid !== kid.pid) return bad('identity or shape');
        if (message.type === 'ready') {
          if (kid.ready || current >= 0) return bad('duplicate or late ready');
          kid.ready = true; record('ready', { child: index });
          return advance();
        }
        if (message.type === 'result') {
          if (!kid.ready || kid.owed === null || message.wave !== kid.owed) return bad('unexpected, duplicate or out-of-order result');
          const call = message.call;
          if (!call || typeof call !== 'object' || call.child !== index || call.wave !== message.wave || call.pid !== kid.pid
            || !call.start || !call.end || !('result' in call || 'threw' in call)) return bad('malformed result');
          kid.owed = null; calls.push({ ...call, received: stamp() });
          if (call.threw) fail('call_threw', { child: index, wave: call.wave, threw: call.threw });
          else if (call.result === null || !Number.isInteger(call.result?.offences)) {
            fail('refused_or_invalid_observation', { child: index, wave: call.wave, result: call.result });
          }
          return advance();
        }
        return bad('unknown message type');
      });
      // Wait for close, not exit, whenever a pid exists so stdout is complete.
      child.on('close', (code, signal) => {
        kid.close = { code, signal, ...stamp() };
        try { kid.evidence = JSON.parse(kid.stdout); } catch (error) { kid.parseError = error.message; }
        if (kid.owed !== null) { fail('missing_by_close', { child: index, wave: kid.owed }); kid.owed = null; }
        else if (!kid.finishSent) fail('closed_before_shutdown_request', { child: index, ready: kid.ready });
        settle(kid);
      });
    }
    launched = true;
    advance(); settleIfDone();
  });
}
// Wave-bounded witness: four persistent independent processes make eight waves of four concurrent
// real noteFailure calls, so 32 writes plus the seeded offence must reach exactly 33. It does NOT
// demonstrate back-to-back saturation: the earlier run of four children making eight immediate
// calls each (run.7ez98p4r) ended in fail-closed refusals (9 admitted, 23 null, two durable
// unavailable intents), which is retained failed evidence, not a flake. The wave barrier says
// nothing about universal storage latency, and the historical Windows errno remains unknown.
test('wave-bounded persistent process writers retain every offence (not a back-to-back saturation test)', async (t) => {
  const { file, observation, attached } = local(t);
  const evidence = { file, observation, attached };
  try {
    evidence.run = await runWaves(file, { children: 4, waves: 8 });
    evidence.final = snapshot(file);
    const { run, final } = evidence;
    assert.notEqual(observation, null); assert.equal(attached, true);
    assert.deepEqual(run.failures, [], 'protocol or writer failures; see retained evidence');
    assert.equal(run.calls.length, 32);
    const slots = [0, 1, 2, 3].flatMap(child => [0, 1, 2, 3, 4, 5, 6, 7].map(wave => `${child}:${wave}`)).sort();
    assert.deepEqual(run.calls.map(call => `${call.child}:${call.wave}`).sort(), slots);
    assert.ok(run.calls.every(call => call.result !== null && call.result !== undefined));
    assert.deepEqual(run.calls.map(call => call.result.offences).sort((a, b) => a - b),
      Array.from({ length: 32 }, (_, i) => i + 2));
    assert.equal(final.authorityBase64.error, undefined);
    assert.equal(JSON.parse(Buffer.from(final.authorityBase64.value, 'base64').toString('utf8'))[seat].offences, 33);
    assert.equal(final.status.error, undefined);
    assert.notEqual(final.status.value.authority, 'unknown');
    assert.equal(final.status.value.offences, 33);
    for (const probe of [final.lock, final.unavailable]) {
      assert.equal(probe.value, undefined); assert.equal(probe.error?.code, 'ENOENT');
    }
    assert.equal(run.kids.length, 4);
    for (const kid of run.kids) {
      assert.equal(kid.close?.code, 0, kid.stderr); assert.equal(kid.close.signal, null);
      assert.equal(kid.spawnError, null); assert.equal(kid.parseError, null);
      assert.equal(kid.evidence.calls.length, 8);
      assert.equal(kid.evidence.unexpectedMessages, undefined);
    }
  } catch (error) {
    try { retain(t, evidence); }
    catch (retentionError) { t.diagnostic(`cooldown evidence retention failed: ${retentionError.message}`); }
    throw error;
  }
});
test('noteFailure refuses and logs no success when persistence fails', (t) => {
  const { file } = local(t), logs = [], before = fs.readFileSync(file, 'utf8');
  const store = createCooldownStore({ file, log: message => logs.push(message) });
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === file) throw new Error('fixture disk failure'); return rename(from, to); };
  try {
    assert.equal(store.noteFailure(seat, 'overloaded'), null);
    assert.equal(logs.some(message => message.includes('cooling for')), false);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(store.status(seat).authority, 'unknown');
    assert.equal(store.attachReceipt(null, 'rcpt_x'), false);
  } finally { fs.renameSync = rename; }
});
test('child failure evidence survives a controlled persistence fault, not the historical cause', async (t) => {
  const { file, observation, attached } = local(t), before = fs.readFileSync(file, 'utf8');
  const children = await runWriters(file, { children: 1, calls: 2, fault: true });
  const evidence = { label: 'controlled fault injection, not the historical cause', file, observation, attached,
    children, final: snapshot(file) };
  const retained = retain(t, evidence);
  // Keep a failed control's evidence too; remove this artifact only after its assertions pass.
  const saved = JSON.parse(fs.readFileSync(retained, 'utf8'));
  assert.equal(saved.children[0].code, 0); assert.equal(saved.children[0].signal, null);
  assert.equal(saved.children[0].parseError, null);
  assert.deepEqual(saved.children[0].evidence.results.map(row => row.result), [null, null]);
  assert.ok(saved.children[0].evidence.filesystemErrors.some(row => row.first.op === 'renameSync'
    && row.first.code === 'EIO' && row.first.destination === file && row.first.injected === true));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(createCooldownStore({ file }).status(seat).offences, 1);
  t.after(() => fs.rmSync(path.dirname(retained), { recursive: true, force: true }));
});
test('failed correction persistence cannot clear authority or claim an audit', (t) => {
  const { file, store, expected } = local(t), before = fs.readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === file) throw new Error('fixture disk failure'); return rename(from, to); };
  try {
    assert.equal(store.correctObservation(seat, expected, () => ({ ok: true, proof: {} })).code, 'persistence_failed');
    assert.equal(store.status(seat).authority, 'unknown');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally { fs.renameSync = rename; }
});
test('contended genuine failure creates durable unknown authority before correction can clear it', (t) => {
  const { file, store, expected } = local(t);
  const code = `const {createCooldownStore}=require(process.argv[1]);
    const result=createCooldownStore({file:process.argv[2]}).noteFailure(${JSON.stringify(seat)},'rate_limited',{retryAfterSec:3600});
    if(result!==null)throw new Error('contention must return null');`;
  const result = store.correctObservation(seat, expected, () => {
    const child = spawnSync(process.execPath, ['-e', code, require.resolve('../lib/provider-cooldown'), file]);
    assert.equal(child.status, 0, child.stderr.toString());
    return { ok: true, proof: {} };
  });
  assert.equal(result.code, 'persistence_failed');
  const reopened = createCooldownStore({ file });
  assert.equal(reopened.status(seat).authority, 'unknown');
  assert.equal(reopened.noteSuccess(seat), null);
  assert.equal(reopened.attachReceipt({ seat }, 'rcpt_unattached'), false);
  assert.equal(reopened.status(seat).authority, 'unknown');
  const pending = fs.readdirSync(file + '.unavailable');
  const intent = JSON.parse(fs.readFileSync(path.join(file + '.unavailable', pending[0]), 'utf8')).intent;
  assert.equal(intent.kind, 'rate_limited'); assert.equal(intent.retryAfterSec, 3600);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[seat].until, expected.until);
});
test('clock rollback cannot hide a newer on-disk observation from exact correction CAS', (t) => {
  const { file, store, expected } = local(t);
  const second = createCooldownStore({ file, now: () => expected.lastOffenceAt - 1 });
  const observation = second.noteFailure(seat, 'rate_limited', { retryAfterSec: 3600 });
  second.attachReceipt(observation, 'rcpt_real429');
  assert.equal(store.correctObservation(seat, expected, () => ({ ok: true })).code, 'observation_changed');
  assert.equal(store.status(seat).sourceReceiptId, 'rcpt_real429');
});
test('authenticated correction route rejects unsupported requests and mirrors durable exact correction', async (t) => {
  const fixture = await startTestBridge(t, () => ({ claude: { label: 'fixture', transport: 'subscription:anthropic',
    quota_seat: seat, oneshot_safe: [process.execPath, '-e', 'console.log("ok")'], oneshot_safe_filesystem_policy: 'read_only_enforced' } }));
  const call = await fixture.request('/api/oneshot', { kind: 'claude', prompt: 'fixture', dangerous: false });
  assert.equal(call.status, 200);
  const journal = path.join(fixture.root, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl');
  const real = completeJsonLines(journal).find((r) => r.receiptId === call.body.receiptId);
  const file = path.join(fixture.root, 'data', 'cooldowns.json'), now = Date.now();
  const current = { sourceReceiptId: 'rcpt_false', sourceObservationId: 'a'.repeat(24), lastOffenceAt: now,
    until: now + BACKOFF[0], offences: 1, source: 'backoff', reason: 'rate_limited', scope: 'account' };
  fs.writeFileSync(file, JSON.stringify({ [seat]: current }));
  fs.appendFileSync(journal, JSON.stringify(receipt(current, real.receiptStoreId)) + '\n');
  const body = { quotaSeat: seat, sourceReceiptId: current.sourceReceiptId, sourceObservationId: current.sourceObservationId,
    lastOffenceAt: current.lastOffenceAt, until: current.until, offences: current.offences };
  assert.equal(validCorrectionRequest(body), true);
  const url = '/api/cooldowns/corrections';
  assert.equal((await fixture.request(url, body, { headers: { 'Content-Type': 'application/json' } })).status, 401);
  assert.equal((await fixture.request(url, { ...body, force: true })).status, 400);
  assert.equal((await fixture.request(url, { ...body, until: body.until + 1 })).status, 409);
  const result = await fixture.request(url, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.auditPersisted, true);
  assert.equal(result.body.journalMirrored, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[seat].until, 0);
  assert.ok(completeJsonLines(journal).find((r) => r.event === 'cooldown_correction' && r.receiptId === result.body.correction.receiptId));
  assert.equal((await fixture.request(url, body)).status, 409);
});
