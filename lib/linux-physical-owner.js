'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { createOwnerControl } = require('./owner-control');
const { pinLinuxNamespace, probeLinuxNamespace } = require('./linux-owner-identity');

// Process lifetime only: this PID namespace intentionally preserves the native
// provider's filesystem, network, credentials and backend. Host qualification
// and durable quarantine reconciliation belong to the integrating caller.
function createLinuxPhysicalOwner({ runId, bwrapPath = '/usr/bin/bwrap', nodePath = process.execPath,
  gatePath = path.resolve(__dirname, '../tools/pid1-gate.js'), settleTimeoutMs = 5000,
  pollMs = 25, spawnProcess = spawn, pinNamespace = pinLinuxNamespace, probeNamespace = probeLinuxNamespace } = {}) {
  if (process.platform !== 'linux') throw new Error('Linux physical owner unavailable');
  if (!/^run_[A-Za-z0-9_-]{1,100}$/.test(runId || '')
    || ![bwrapPath, nodePath, gatePath].every((value) => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'))
    || !Number.isFinite(settleTimeoutMs) || settleTimeoutMs < 50 || settleTimeoutMs > 60000
    || !Number.isFinite(pollMs) || pollMs < 5 || pollMs > 1000) throw new TypeError('invalid Linux physical owner options');
  let started = false, proc = null, control = null, pin = null, stopRequested = false, allowRequested = false;
  let physicalSpawned = false, wrapperExited = false, stdoutEof = false, stderrEof = false;
  let wrapperExit = null, rootExit = null, providerState = 'not_released', providerPid = null;
  let state = 'prepared', code = null, drainDeadline = null, timer = null, settled = null, firstResult = null;
  let infoBytes = 0, infoChunks = [], infoSeen = false, infoEnded = false;
  let resolveReady, rejectReady, resolvePhysical, resolveCompletion, resolvePin, rejectPin;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }); ready.catch(() => {});
  const pinned = new Promise((resolve, reject) => { resolvePin = resolve; rejectPin = reject; }); pinned.catch(() => {});
  const physicalDone = new Promise((resolve) => { resolvePhysical = resolve; });
  // completion can return an unsettled diagnostic; physicalDone cannot.
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });

  function snapshot() {
    return { runId, state, code, physicalAttemptCount: physicalSpawned ? 1 : 0,
      ownerPid: proc?.pid || null, pin: pin ? { ...pin } : null, stopRequested,
      providerState, providerPid, modelInvocation: providerState === 'spawned' ? true
        : ['not_released', 'failed_preexec'].includes(providerState) ? false : null,
      wrapperExited, stdoutEof, stderrEof, wrapperExit, rootExit, drainDeadline };
  }
  function disposeControl() { if (control) void control.dispose().catch(() => {}); }
  function beginDrain(failureCode) {
    if (settled) return;
    if (failureCode && !code) code = failureCode;
    if (drainDeadline === null) drainDeadline = Date.now() + settleTimeoutMs;
    if (state !== 'quarantined') state = 'draining';
    scheduleCheck();
  }
  function finish(evidence, deathProof = null) {
    if (settled) return;
    state = 'settled'; clearTimeout(timer); timer = null;
    settled = { evidence, deathProof, snapshot: snapshot() };
    resolvePhysical(settled);
    if (!firstResult) { firstResult = settled; resolveCompletion(settled); }
    disposeControl();
  }
  function check() {
    timer = null;
    if (settled || drainDeadline === null) return;
    let proof = { state: 'unverified' };
    try { if (pin) proof = probeNamespace(pin); } catch {}
    if (wrapperExited && stdoutEof && stderrEof && proof.state === 'gone') {
      finish('process_tree_settled', proof.evidence); return;
    }
    if (Date.now() >= drainDeadline && state !== 'quarantined') {
      state = 'quarantined';
      if (!code) code = 'OWNER_TERMINATION_UNVERIFIED';
      firstResult = { evidence: null, snapshot: snapshot() }; resolveCompletion(firstResult);
      // Do not clean resources, release admission, or resolve physicalDone.
      disposeControl();
    }
    if (state !== 'quarantined' || pin) scheduleCheck();
  }
  function scheduleCheck() {
    if (timer !== null || settled || drainDeadline === null) return;
    timer = setTimeout(check, state === 'quarantined' ? 1000 : pollMs); timer.unref?.();
  }
  function failStartup(failureCode) {
    if (settled) return;
    if (!code) code = failureCode;
    rejectReady(new Error(failureCode)); rejectPin(new Error(failureCode));
    beginDrain(failureCode); disposeControl();
  }
  function requestStop() {
    if (stopRequested || settled) return false;
    stopRequested = true;
    if (!started) return true;
    beginDrain();
    // Before authentication, disconnect is the gate's explicit stop signal.
    // Never signal a numeric PID found by a later probe.
    if (control) control.send({ type: 'stop' }).catch(disposeControl);
    return true;
  }
  function validExit(message) {
    return (Number.isInteger(message.code) && message.code >= 0 && message.code <= 255 && message.signal === null)
      || (message.code === null && typeof message.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(message.signal));
  }
  async function start({ file, args = [], cwd, env = process.env } = {}) {
    if (started) throw new Error('physical owner already started');
    if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')
      || !Array.isArray(args) || !args.every((arg) => typeof arg === 'string' && !arg.includes('\0'))
      || typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')) throw new TypeError('invalid provider launch');
    started = true;
    if (stopRequested) { rejectReady(new Error('OWNER_STOPPED_BEFORE_SPAWN')); finish('not_dispatched'); return null; }
    try {
      control = await createOwnerControl({ runId,
        async onHello(message) {
          await pinned;
          return !stopRequested && message.pid1 === true && message.namespacePid === 1
            && probeNamespace(pin).state === 'alive';
        },
        onMessage(message) {
          switch (message.type) {
            case 'proceed_ack':
              if (providerState !== 'release_requested') throw new Error('unexpected proceed ack');
              providerState = 'released'; break;
            case 'provider_spawned':
              if (providerState !== 'released' || !Number.isSafeInteger(message.pid) || message.pid <= 1) throw new Error('unexpected provider spawn');
              providerState = 'spawned'; providerPid = message.pid; break;
            case 'provider_spawn_failed':
              if (providerState !== 'released') throw new Error('unexpected provider spawn failure');
              providerState = 'failed_preexec'; beginDrain('PROVIDER_SPAWN_FAILED'); break;
            case 'root_exit':
              if (providerState !== 'spawned' || rootExit || !validExit(message)) throw new Error('invalid provider exit');
              rootExit = { code: message.code, signal: message.signal }; beginDrain(); break;
            case 'stop_ack':
              if (!stopRequested) throw new Error('unexpected stop ack');
              break;
            default: throw new Error('invalid owner message');
          }
        },
        onClose() {
          rejectReady(new Error('OWNER_CONTROL_CLOSED'));
          beginDrain(rootExit || stopRequested ? null : 'OWNER_CONTROL_CLOSED');
        },
      });
      control.ready.then(() => { if (!stopRequested) resolveReady(); else rejectReady(new Error('OWNER_STOPPED')); })
        .catch(() => failStartup('OWNER_HANDSHAKE_FAILED'));
      if (stopRequested) { disposeControl(); rejectReady(new Error('OWNER_STOPPED_BEFORE_SPAWN')); finish('not_dispatched'); return null; }
      // Provider Node loader options must not instrument the gate itself.
      const ownerEnv = { ...env, RELAYBRIDGE_OWNER_SOCKET: control.address, RELAYBRIDGE_OWNER_NONCE: control.nonce,
        RELAYBRIDGE_OWNER_RUN_ID: runId, RELAYBRIDGE_OWNER_PROVIDER_NODE_OPTIONS: env.NODE_OPTIONS ?? '' };
      delete ownerEnv.NODE_OPTIONS;
      proc = spawnProcess(bwrapPath, ['--unshare-pid', '--as-pid-1', '--die-with-parent', '--dev-bind', '/', '/',
        '--proc', '/proc', '--info-fd', '3', '--chdir', cwd, '--', nodePath, gatePath, '--', file, ...args],
      { cwd, env: ownerEnv, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
      physicalSpawned = Number.isSafeInteger(proc.pid) && proc.pid > 0;
      if (physicalSpawned) state = 'starting';
      proc.once('error', () => {
        rejectReady(new Error('OWNER_SPAWN_FAILED')); rejectPin(new Error('OWNER_SPAWN_FAILED'));
        if (!physicalSpawned && !proc.pid) { code = 'OWNER_SPAWN_FAILED'; finish('spawn_failed'); }
        else failStartup('OWNER_TRANSPORT_ERROR');
      });
      proc.once('exit', (exitCode, signal) => {
        wrapperExited = true; wrapperExit = { code: exitCode, signal }; beginDrain();
      });
      proc.stdout.once('end', () => { stdoutEof = true; scheduleCheck(); });
      proc.stderr.once('end', () => { stderrEof = true; scheduleCheck(); });
      for (const stream of [proc.stdin, proc.stdout, proc.stderr, proc.stdio[3]]) {
        stream.on('error', () => failStartup('OWNER_PIPE_ERROR'));
      }
      proc.stdio[3].on('data', (chunk) => {
        if (infoEnded || settled) return;
        infoBytes += chunk.length;
        if (infoBytes > 8192) { infoEnded = true; failStartup('OWNER_INFO_LIMIT'); return; }
        if (infoSeen) {
          if (!chunk.every((byte) => [9, 10, 13, 32].includes(byte))) failStartup('OWNER_INFO_REPLAY');
          return;
        }
        infoChunks.push(chunk);
        let record;
        try { record = JSON.parse(Buffer.concat(infoChunks, infoBytes).toString('utf8')); } catch { return; }
        infoSeen = true;
        try { pin = pinNamespace(record['child-pid']); resolvePin(pin); }
        catch { failStartup('OWNER_PIN_UNAVAILABLE'); }
      });
      proc.stdio[3].once('end', () => {
        infoEnded = true;
        if (!pin && !settled) failStartup('OWNER_PIN_UNAVAILABLE');
      });
      return proc;
    } catch (error) {
      rejectReady(error); rejectPin(error); code = 'OWNER_SPAWN_FAILED';
      if (!physicalSpawned && !proc?.pid) finish('spawn_failed'); else failStartup('OWNER_STARTUP_FAILED');
      return proc;
    }
  }
  async function allowProvider() {
    if (allowRequested) return false;
    allowRequested = true;
    await ready;
    if (stopRequested || settled || drainDeadline !== null) return false;
    providerState = 'release_requested';
    try { await control.send({ type: 'proceed' }); return true; }
    catch { failStartup('OWNER_PROCEED_FAILED'); return false; }
  }
  return { start, ready, allowProvider, requestStop, snapshot, physicalDone, completion };
}

module.exports = { createLinuxPhysicalOwner };
