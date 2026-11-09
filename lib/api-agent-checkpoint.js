'use strict';

// Durable checkpoint journal for API agent runs.
//
// Layout: DATA_DIR/api-agent/<runId>/ holding manifest.json, one atomic record
// per model turn (turn-NNNNNN.json), per tool call (tool-NNNNNN-NNN.json) and
// per patch operation (patch-NNNNNN-NNN.json), and an O_EXCL lease. A run that
// may write the workspace (its manifest carries `execution`) also records each
// owning attempt (attempt-<nonce>.json) and, once that attempt is proven
// stopped, its evidence (stopped-<nonce>.json). The stored conversation is never redacted or
// truncated; only caller-visible text is. Records are read through a verified
// descriptor without a size cap. Torn *.tmp files are ignored.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ERROR_CLASSES } = require('./api-agent-wire');

const C = fs.constants;
const READ_FLAGS = C.O_RDONLY | (C.O_NOFOLLOW || 0) | (C.O_NONBLOCK || 0);
const RUN_ID = /^aar_[a-z0-9]{8,40}_[a-f0-9]{8,32}$/;
const TURN_FILE = /^turn-(\d{6,})\.json$/;
const TOOL_FILE = /^tool-(\d{6,})-(\d{3,})\.json$/;
const PATCH_FILE = /^patch-(\d{6,})-(\d{3,})\.json$/;
const ATTEMPT_FILE = /^attempt-([a-f0-9]{32})\.json$/;
const STOPPED_FILE = /^stopped-([a-f0-9]{32})\.json$/;
const NONCE = /^[a-f0-9]{32}$/;
const LEASE_PURPOSES = new Set(['execution', 'recovery', 'reconcile']);
const ATTEMPT_PURPOSES = new Set(['execution', 'recovery']);
const BOOT_ID = /^[0-9a-f-]{36}$/;
const PID_NAMESPACE = /^pid:\[\d+\]$/;
const IDENTITY_KEYS = ['bootId', 'hostname', 'pid', 'pidNamespace', 'procStartTime'];
const EVIDENCE_KEYS = ['checkpointRunId', 'executionBindingHash', 'nonce', 'observedAt', 'observer', 'owner', 'proof', 'purpose', 'v'];
const ATTEMPT_KEYS = ['at', 'checkpointRunId', 'executionBindingHash', 'nonce', 'owner', 'purpose', 'v'];
const POSIX = process.platform !== 'win32';
const TERMINAL_STATUSES = new Set(['terminal']);
const PROOFS = new Set(['owner_dead', 'lifecycle_settled', 'not_dispatched']);

const fail = (code, message) => { throw Object.assign(new Error(message || code), { code }); };
const bindingDigest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Identity of a writer run's execution binding; null for a read-only run.
const executionBindingHash = (manifest) => manifest && manifest.execution && typeof manifest.execution === 'object'
  ? bindingDigest(manifest.execution) : null;

const exactKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.join(',');
const boundedTime = (value) => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
// A full process identity: pid and start time inside one host, boot and PID
// namespace. Every field is required; a partial identity proves nothing.
const identityValid = (value) => exactKeys(value, IDENTITY_KEYS) && Number.isSafeInteger(value.pid) && value.pid > 0
  && typeof value.procStartTime === 'string' && /^\d{1,20}$/.test(value.procStartTime)
  && typeof value.hostname === 'string' && value.hostname.length >= 1 && value.hostname.length <= 255
  && typeof value.bootId === 'string' && BOOT_ID.test(value.bootId)
  && typeof value.pidNamespace === 'string' && PID_NAMESPACE.test(value.pidNamespace);
const sameIdentity = (a, b) => IDENTITY_KEYS.every((key) => a[key] === b[key]);
const identityOf = (lease) => ({ pid: lease.pid, procStartTime: lease.procStartTime ?? null, hostname: lease.hostname ?? null,
  bootId: lease.bootId ?? null, pidNamespace: lease.pidNamespace ?? null });

function newRunId() {
  return `aar_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
}

// Start time in clock ticks since boot, from /proc/<pid>/stat field 22.
// Returns null when the platform cannot prove a process identity.
function procStartTime(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] || null;
  } catch { return null; }
}

// Boot and PID-namespace identity of this process. A pid and start time mean
// the same process only inside one boot and one PID namespace; anything that
// cannot be read is null, which makes every other owner unknown, never dead.
function readProcessIdentity() {
  if (process.platform !== 'linux') return { bootId: null, pidNamespace: null };
  let bootId = null, pidNamespace = null;
  try { bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch {}
  try { pidNamespace = fs.readlinkSync('/proc/self/ns/pid'); } catch {}
  return { bootId: BOOT_ID.test(bootId || '') ? bootId : null,
    pidNamespace: PID_NAMESPACE.test(pidNamespace || '') ? pidNamespace : null };
}

// Call only after the lease's boot and namespace have matched this process.
// A pid is dead when its /proc entry is missing or its start time differs;
// without a readable /proc for this process, absence proves nothing.
function processState(pid, startTime) {
  if (process.platform !== 'linux') return 'unknown';
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof startTime !== 'string') return 'unknown';
  if (procStartTime(process.pid) === null) return 'unknown';
  if (!fs.existsSync(`/proc/${pid}`)) return 'dead';
  const current = procStartTime(pid);
  if (current === null) return fs.existsSync(`/proc/${pid}`) ? 'unknown' : 'dead';
  return current === startTime ? 'live' : 'dead';
}

function assertPrivateDir(dir) {
  let st;
  try { st = fs.lstatSync(dir); } catch { fail('checkpoint_store_invalid', 'Checkpoint directory is missing.'); }
  if (st.isSymbolicLink() || !st.isDirectory()) fail('checkpoint_store_invalid', 'Checkpoint directory must be a real directory.');
  if (POSIX && (st.uid !== process.getuid() || (st.mode & 0o777) !== 0o700)) fail('checkpoint_store_invalid', 'Checkpoint directory must be owned by this user with mode 0700.');
  return st;
}

function ensurePrivateDir(dir) {
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return assertPrivateDir(dir);
}

function fsyncDir(dir) {
  if (!POSIX) return;
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function atomicWriteRecord(dir, name, value) {
  const file = path.join(dir, name);
  const tmp = path.join(dir, `${name}.${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  fsyncDir(dir);
}

function readRecord(dir, name) {
  let fd;
  try { fd = fs.openSync(path.join(dir, name), READ_FLAGS); }
  catch (error) { if (error.code === 'ENOENT') return null; fail('checkpoint_store_invalid', 'Checkpoint record could not be opened safely.'); }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) fail('checkpoint_store_invalid', 'Checkpoint record must be a regular unlinked file.');
    if (POSIX && (st.uid !== process.getuid() || (st.mode & 0o777) !== 0o600)) fail('checkpoint_store_invalid', 'Checkpoint record must be private.');
    const chunks = [];
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { fail('checkpoint_store_invalid', 'Checkpoint record is not valid JSON.'); }
  } finally { fs.closeSync(fd); }
}

// Record names widen past their pad width instead of wrapping; there is no
// turn or tool-call cap. Only the canonical spelling of a safe integer is a
// record name, so two names can never claim the same index.
const pad = (n, width) => String(n).padStart(width, '0');
const validTurn = (n) => Number.isSafeInteger(n) && n >= 1;
const validToolIndex = (n) => Number.isSafeInteger(n) && n >= 0;
function turnName(index) {
  if (!validTurn(index)) fail('checkpoint_store_invalid', 'Turn index is not a positive safe integer.');
  return `turn-${pad(index, 6)}.json`;
}
function toolName(turn, index) {
  if (!validTurn(turn) || !validToolIndex(index)) fail('checkpoint_store_invalid', 'Tool record index is not a safe integer.');
  return `tool-${pad(turn, 6)}-${pad(index, 3)}.json`;
}
function patchName(turn, index) {
  if (!validTurn(turn) || !validToolIndex(index)) fail('checkpoint_store_invalid', 'Patch record index is not a safe integer.');
  return `patch-${pad(turn, 6)}-${pad(index, 3)}.json`;
}
// { kind: 'turn', turn } | { kind: 'tool', turn, index } | null when the name
// is not a canonical record name.
function parseRecordName(name) {
  let m;
  if ((m = TURN_FILE.exec(name))) {
    const turn = Number(m[1]);
    return validTurn(turn) && name === turnName(turn) ? { kind: 'turn', turn } : null;
  }
  if ((m = TOOL_FILE.exec(name))) {
    const turn = Number(m[1]), index = Number(m[2]);
    return validTurn(turn) && validToolIndex(index) && name === toolName(turn, index) ? { kind: 'tool', turn, index } : null;
  }
  if ((m = PATCH_FILE.exec(name))) {
    const turn = Number(m[1]), index = Number(m[2]);
    return validTurn(turn) && validToolIndex(index) && name === patchName(turn, index) ? { kind: 'patch', turn, index } : null;
  }
  return null;
}

function createCheckpointStore({ dataDir, hostname = os.hostname(), pid = process.pid,
  processIdentity = readProcessIdentity, hooks = {} } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new TypeError('checkpoint store requires an absolute dataDir');
  const root = path.join(dataDir, 'api-agent');
  const selfStart = procStartTime(pid);
  const identity = typeof processIdentity === 'function' ? processIdentity() : processIdentity;
  const bootId = typeof identity?.bootId === 'string' && identity.bootId ? identity.bootId : null;
  const pidNamespace = typeof identity?.pidNamespace === 'string' && identity.pidNamespace ? identity.pidNamespace : null;

  function ensureRoot() {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    return ensurePrivateDir(root);
  }

  function runDir(runId) {
    if (typeof runId !== 'string' || !RUN_ID.test(runId)) fail('checkpoint_run_invalid', 'Invalid checkpoint run identity.');
    return path.join(root, runId);
  }

  // Random per-DATA_DIR salt. The HMAC is a change detector only; it proves
  // neither organization nor funding source.
  function salt() {
    ensureRoot();
    const file = path.join(root, 'fingerprint.salt');
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, crypto.randomBytes(32).toString('hex')); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fsyncDir(root);
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    let fd;
    try { fd = fs.openSync(file, READ_FLAGS); } catch { fail('checkpoint_store_invalid', 'Fingerprint salt could not be opened safely.'); }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || (POSIX && (st.uid !== process.getuid() || (st.mode & 0o777) !== 0o600))) fail('checkpoint_store_invalid', 'Fingerprint salt must be private.');
      const value = fs.readFileSync(fd, 'utf8');
      if (!/^[a-f0-9]{64}$/.test(value)) fail('checkpoint_store_invalid', 'Fingerprint salt is malformed.');
      return value;
    } finally { fs.closeSync(fd); }
  }

  function fingerprint(credential) {
    if (typeof credential !== 'string' || !credential) fail('api_credential_unbound', 'No credential value is available.');
    return 'hmac-sha256:' + crypto.createHmac('sha256', Buffer.from(salt(), 'hex')).update(credential).digest('hex');
  }

  // ---- lease -------------------------------------------------------------

  function writeLease(dir, purpose = 'execution') {
    if (!LEASE_PURPOSES.has(purpose)) fail('checkpoint_store_invalid', 'Unknown lease purpose.');
    const lease = { pid, procStartTime: selfStart, hostname, bootId, pidNamespace, purpose,
      nonce: crypto.randomBytes(16).toString('hex'), at: new Date().toISOString() };
    const file = path.join(dir, 'lease.json');
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return null; throw error; }
    try { fs.writeFileSync(fd, JSON.stringify(lease)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fsyncDir(dir);
    return lease;
  }

  function readLease(dir) {
    try { return readRecord(dir, 'lease.json'); }
    catch { return { unreadable: true }; }
  }

  function ownerState(lease) {
    if (!lease) return 'none';
    if (lease.unreadable || typeof lease.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(lease.nonce)) return 'unknown';
    // A pid can be judged only on the same host, boot and PID namespace. A
    // legacy lease without these fields, or an unreadable local identity, is
    // unknown: it is never reclaimed automatically.
    if (lease.hostname !== hostname || bootId === null || pidNamespace === null
      || lease.bootId !== bootId || lease.pidNamespace !== pidNamespace) return 'unknown';
    if (lease.pid === pid && lease.procStartTime === selfStart && selfStart !== null) return 'live';
    return processState(lease.pid, lease.procStartTime);
  }

  // ---- stopped evidence ------------------------------------------------------
  // Proof that one owning attempt of a writer run can make no further effect:
  // its exact owner died on this host, boot and PID namespace, it settled its
  // own lifecycle, or (not_dispatched, written only by create) its attempt
  // failed before any handle existed. A missing lease alone is never such proof. The file is
  // created once (O_EXCL) and never overwritten; an existing one is validated
  // against an exact schema and, when reused, against the expected owner.

  function evidenceValid(value, { runId, nonce, bindingHash, expect }) {
    return exactKeys(value, EVIDENCE_KEYS) && value.v === 1 && value.checkpointRunId === runId && value.nonce === nonce
      && value.executionBindingHash === bindingHash && PROOFS.has(value.proof)
      && identityValid(value.owner) && identityValid(value.observer) && boundedTime(value.observedAt)
      && typeof value.purpose === 'string' && LEASE_PURPOSES.has(value.purpose)
      && (!expect || (sameIdentity(value.owner, expect.owner) && value.purpose === expect.purpose));
  }

  // expect: { owner, purpose } of the lease or attempt the evidence must name.
  function readStopped(dir, runId, nonce, bindingHash, expect) {
    if (!NONCE.test(nonce || '') || !bindingHash) return null;
    let value;
    try { value = readRecord(dir, `stopped-${nonce}.json`); } catch { return null; }
    return evidenceValid(value, { runId, nonce, bindingHash, expect }) ? value : null;
  }

  // Repeats the file and directory barriers over an existing evidence record,
  // so evidence left by an attempt whose own barriers failed is durable before
  // anything relies on it. Throws on any failure.
  function syncStopped(dir, name) {
    const fd = fs.openSync(path.join(dir, name), READ_FLAGS);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1) fail('checkpoint_store_invalid', 'Stopped evidence must be a regular unlinked file.');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fsyncDir(dir);
  }

  // Returns true once valid, durable evidence for this exact lease exists;
  // false (and writes nothing further) on any failure, so the caller keeps
  // the lease.
  function writeStopped(dir, runId, lease, bindingHash, proof) {
    try {
      if (!bindingHash || !NONCE.test(lease?.nonce || '') || !LEASE_PURPOSES.has(lease.purpose)) return false;
      const owner = identityOf(lease);
      const observer = { pid, procStartTime: selfStart, hostname, bootId, pidNamespace };
      if (!identityValid(owner) || !identityValid(observer)) return false;
      const expect = { owner, purpose: lease.purpose };
      const name = `stopped-${lease.nonce}.json`;
      const reuse = () => {
        if (!readStopped(dir, runId, lease.nonce, bindingHash, expect)) return false;
        syncStopped(dir, name);
        return !!readStopped(dir, runId, lease.nonce, bindingHash, expect);
      };
      if (readStopped(dir, runId, lease.nonce, bindingHash, expect)) return reuse();
      const value = { v: 1, checkpointRunId: runId, executionBindingHash: bindingHash, nonce: lease.nonce, owner,
        purpose: lease.purpose, proof, observedAt: new Date().toISOString(), observer };
      let fd;
      try { fd = fs.openSync(path.join(dir, name), 'wx', 0o600); }
      catch (error) { return error.code === 'EEXIST' && reuse(); }
      try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (typeof hooks.afterStoppedEvidence === 'function') hooks.afterStoppedEvidence(dir, value);
      fsyncDir(dir);
      return !!readStopped(dir, runId, lease.nonce, bindingHash, expect);
    } catch { return false; }
  }

  function manifestBindingHash(dir) {
    const manifest = readRecord(dir, 'manifest.json');
    return manifest ? executionBindingHash(manifest) : null;
  }

  // Reclaim a lease whose owner is proven dead. The O_EXCL reclaim marker for
  // that exact nonce admits one reclaimer at a time; the lease is re-read under
  // the marker and removed only if it still carries that nonce, so a racing
  // peer cannot remove the winner's fresh lease. For a writer run the
  // owner_dead evidence is made durable before the lease goes; if it cannot
  // be, the lease stays. The marker is always removed.
  function reclaimDeadLease(dir, lease) {
    const marker = path.join(dir, `reclaim-${lease.nonce}`);
    let fd;
    try { fd = fs.openSync(marker, 'wx', 0o600); } catch { return false; }
    fs.closeSync(fd);
    try {
      if (typeof hooks.afterReclaimMarker === 'function') hooks.afterReclaimMarker(dir);
      const current = readLease(dir);
      if (!current || current.nonce !== lease.nonce) return false;
      let bindingHash;
      try { bindingHash = manifestBindingHash(dir); } catch { return false; }
      if (bindingHash && !writeStopped(dir, path.basename(dir), current, bindingHash, 'owner_dead')) return false;
      fs.unlinkSync(path.join(dir, 'lease.json'));
      return true;
    } finally {
      try { fs.unlinkSync(marker); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fsyncDir(dir);
    }
  }

  function takeLease(dir, purpose) {
    let lease = writeLease(dir, purpose);
    if (!lease) {
      const existing = readLease(dir);
      if (ownerState(existing) !== 'dead') fail('owner_live_or_unknown', 'Another live or unverifiable owner holds this checkpoint.');
      if (!reclaimDeadLease(dir, existing)) fail('owner_live_or_unknown', 'A concurrent owner reclaimed this checkpoint.');
      lease = writeLease(dir, purpose);
      if (!lease) fail('owner_live_or_unknown', 'A concurrent owner acquired this checkpoint.');
    }
    return lease;
  }

  // Durable record that this lease may act on a writer run's workspace. It is
  // written before the handle is returned, so every attempt that could have
  // produced an effect is known to recovery.
  function recordAttempt(dir, runId, lease) {
    const bindingHash = manifestBindingHash(dir);
    if (!bindingHash) return null;
    const owner = identityOf(lease);
    if (!identityValid(owner) || !ATTEMPT_PURPOSES.has(lease.purpose)) fail('owner_identity_unavailable', 'This process has no full identity to record.');
    atomicWriteRecord(dir, `attempt-${lease.nonce}.json`, { v: 1, checkpointRunId: runId, nonce: lease.nonce,
      purpose: lease.purpose, executionBindingHash: bindingHash, owner, at: new Date().toISOString() });
    return bindingHash;
  }

  // A lease whose attempt could not be completed is given up only after its
  // stopped evidence is durable: a half-persisted attempt record must never
  // outlive the only authority that could prove it stopped. If the evidence
  // cannot be made durable the lease is kept. Only create passes
  // not_dispatched: its lease never reached a handle, so nothing was sent.
  function abandonLease(dir, runId, lease, proof = 'lifecycle_settled') {
    let bindingHash;
    try { bindingHash = manifestBindingHash(dir); } catch { return; }
    if (bindingHash && !writeStopped(dir, runId, lease, bindingHash, proof)) return;
    releaseLease(dir, lease);
  }

  function acquire(runId, { purpose = 'execution' } = {}) {
    ensureRoot();
    const dir = runDir(runId);
    assertPrivateDir(dir);
    const lease = takeLease(dir, purpose);
    try { if (purpose !== 'reconcile') recordAttempt(dir, runId, lease); }
    catch (error) { abandonLease(dir, runId, lease); throw error; }
    return handle(runId, dir, lease);
  }

  function releaseLease(dir, lease) {
    try {
      const current = readLease(dir);
      if (current && current.nonce === lease.nonce) { fs.unlinkSync(path.join(dir, 'lease.json')); fsyncDir(dir); }
    } catch {}
  }

  function attemptValid(record, { runId, nonce, bindingHash }) {
    return exactKeys(record, ATTEMPT_KEYS) && record.v === 1 && record.checkpointRunId === runId && record.nonce === nonce
      && record.executionBindingHash === bindingHash && ATTEMPT_PURPOSES.has(record.purpose)
      && identityValid(record.owner) && boundedTime(record.at);
  }

  // Every owning attempt of a writer run, each with its stopped evidence or
  // null. Evidence counts only when it names the attempt's own recorded
  // owner and purpose. A non-canonical attempt name or a malformed attempt
  // record throws checkpoint_store_invalid: an unreadable attempt is never
  // silently left out of the set.
  function attempts(dir, runId, bindingHash) {
    const list = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('attempt-') || name.endsWith('.tmp')) continue;
      const m = ATTEMPT_FILE.exec(name);
      if (!m) fail('checkpoint_store_invalid', 'Attempt record name is not canonical.');
      const record = readRecord(dir, name);
      if (!attemptValid(record, { runId, nonce: m[1], bindingHash })) fail('checkpoint_store_invalid', 'Attempt record is malformed.');
      list.push({ nonce: m[1], evidence: readStopped(dir, runId, m[1], bindingHash, { owner: record.owner, purpose: record.purpose }) });
    }
    return list;
  }

  // An empty attempt set proves nothing by itself; neither does the absence
  // of turn, tool or patch records. It passes only with positive proof that
  // the run was never dispatched:
  // - the manifest is bound to this execution and still has the shape create
  //   left it in (active, no outcome) or the one reconcile gives it from there
  //   (resumable, outcome exactly { class: 'interrupted', at });
  // - no turn, tool or patch record (torn or not) and no attempt record exists;
  // - every stopped record is canonical and valid for this run and binding,
  //   and at least one is not_dispatched evidence its owner wrote about itself.
  // Any contradiction or malformed evidence refuses.
  function provenNeverDispatched(dir, runId, bindingHash) {
    let manifest;
    try { manifest = readRecord(dir, 'manifest.json'); } catch { return false; }
    if (!manifest || manifest.runId !== runId || !bindingHash || executionBindingHash(manifest) !== bindingHash) return false;
    const pristine = manifest.status === 'active' && manifest.outcome === null;
    const interrupted = manifest.status === 'resumable' && exactKeys(manifest.outcome, ['at', 'class'])
      && manifest.outcome.class === 'interrupted' && boundedTime(manifest.outcome.at);
    if (!pristine && !interrupted) return false;
    let proven = false;
    for (const name of fs.readdirSync(dir)) {
      if (/^(turn|tool|patch)-/.test(name)) return false;
      if (ATTEMPT_FILE.test(name)) return false;
      if (!name.startsWith('stopped-')) continue;
      const m = STOPPED_FILE.exec(name);
      if (!m) return false;
      let value;
      try { value = readRecord(dir, name); } catch { return false; }
      if (!evidenceValid(value, { runId, nonce: m[1], bindingHash })) return false;
      if (value.proof === 'not_dispatched' && value.purpose === 'execution' && sameIdentity(value.owner, value.observer)) proven = true;
    }
    return proven;
  }

  // The nonces of every attempt that could have touched the workspace, when
  // all of them are proven stopped and nothing holds the lease; else null.
  // A malformed attempt set is null, never stopped.
  function stoppedAttempts(runId, bindingHash) {
    const dir = runDir(runId);
    assertPrivateDir(dir);
    if (readLease(dir)) return null;
    let list;
    try { list = attempts(dir, runId, bindingHash); } catch (error) { if (error.code === 'checkpoint_store_invalid') return null; throw error; }
    if (!list.length) return provenNeverDispatched(dir, runId, bindingHash) ? Object.freeze([]) : null;
    return list.every((a) => a.evidence !== null) ? Object.freeze(list.map((a) => a.nonce)) : null;
  }

  // Predicate (a): every attempt that could have touched the workspace is
  // proven stopped and nothing holds the lease.
  function effectsOwnerStopped(runId, bindingHash) {
    return stoppedAttempts(runId, bindingHash) !== null;
  }

  // Exclusive recovery of a writer run's effects. A live or unverifiable
  // owner refuses; a dead one is reclaimed with owner_dead evidence. Every
  // recorded attempt must then carry valid stopped evidence, and the stored
  // execution binding must equal the caller's exactly.
  function acquireEffectsRecovery(runId, { executionBindingHash: expected } = {}) {
    ensureRoot();
    const dir = runDir(runId);
    assertPrivateDir(dir);
    const manifest = readRecord(dir, 'manifest.json');
    const bindingHash = executionBindingHash(manifest);
    if (!bindingHash || typeof expected !== 'string' || bindingHash !== expected) {
      fail('checkpoint_binding_stale', 'The stored execution binding does not match this recovery.');
    }
    const lease = takeLease(dir, 'recovery');
    try {
      const list = attempts(dir, runId, bindingHash);
      if (!list.length && !provenNeverDispatched(dir, runId, bindingHash)) fail('owner_not_proven_stopped', 'No owning attempt is recorded and the run is not proven never dispatched.');
      if (list.some((a) => a.evidence === null)) fail('owner_not_proven_stopped', 'An owning attempt is not proven stopped.');
      recordAttempt(dir, runId, lease);
      return handle(runId, dir, lease, { stoppedNonces: Object.freeze(list.map((a) => a.nonce)), executionBindingHash: bindingHash });
    } catch (error) { abandonLease(dir, runId, lease); throw error; }
  }

  function create(runId, manifest) {
    ensureRoot();
    const dir = runDir(runId);
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) {
      if (error.code === 'EEXIST') fail('checkpoint_run_exists', 'Checkpoint run already exists.');
      throw error;
    }
    assertPrivateDir(dir);
    const lease = writeLease(dir);
    if (!lease) fail('owner_live_or_unknown', 'Checkpoint lease could not be created.');
    const h = handle(runId, dir, lease);
    h.writeManifest({ version: 1, runId, createdAt: new Date().toISOString(), status: 'active', outcome: null, ...manifest });
    try { recordAttempt(dir, runId, lease); } catch (error) { abandonLease(dir, runId, lease, 'not_dispatched'); throw error; }
    return h;
  }

  function load(runId) {
    ensureRoot();
    const dir = runDir(runId);
    assertPrivateDir(dir);
    const manifest = readRecord(dir, 'manifest.json');
    if (!manifest || manifest.runId !== runId) fail('checkpoint_missing', 'Checkpoint manifest is missing.');
    const turns = new Map(), tools = new Map(), patches = new Map();
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.tmp') || !/^(turn|tool|patch)-/.test(name)) continue;
      const parsed = parseRecordName(name);
      if (!parsed) fail('checkpoint_store_invalid', 'Checkpoint record name is not canonical.');
      const record = readRecord(dir, name);
      if (parsed.kind === 'turn') {
        if (record?.index !== parsed.turn) fail('checkpoint_store_invalid', 'Turn record index mismatch.');
        turns.set(record.index, record);
      } else {
        if (record?.turn !== parsed.turn || record?.index !== parsed.index) fail('checkpoint_store_invalid', `${parsed.kind === 'tool' ? 'Tool' : 'Patch'} record index mismatch.`);
        (parsed.kind === 'tool' ? tools : patches).set(`${record.turn}:${record.index}`, record);
      }
    }
    const ordered = [...turns.keys()].sort((a, b) => a - b);
    if (ordered.some((n, i) => n !== i + 1)) fail('checkpoint_store_invalid', 'Turn records are not contiguous.');
    return { manifest, turns: ordered.map((n) => turns.get(n)), tools, patches };
  }

  function handle(runId, dir, lease, extra = {}) {
    let released = false;
    const guard = () => {
      if (released) fail('checkpoint_lease_released', 'Checkpoint lease was released.');
      const current = readLease(dir);
      if (!current || current.nonce !== lease.nonce) fail('checkpoint_lease_lost', 'Checkpoint lease is no longer held.');
    };
    return Object.freeze({
      ...extra, runId, dir, attemptNonce: lease.nonce, purpose: lease.purpose,
      assertLease: guard,
      writeManifest(value) { guard(); atomicWriteRecord(dir, 'manifest.json', value); },
      writeTurn(record) { guard(); atomicWriteRecord(dir, turnName(record.index), record); },
      writeTool(record) { guard(); atomicWriteRecord(dir, toolName(record.turn, record.index), record); },
      // A patch record is never written over a tool record or vice versa.
      writePatch(record) {
        guard();
        if (!record || record.runId !== runId || (record.attemptNonce !== lease.nonce && record.recoveryNonce !== lease.nonce)) {
          fail('checkpoint_store_invalid', 'Patch record is not bound to this lease.');
        }
        atomicWriteRecord(dir, patchName(record.turn, record.index), record);
      },
      load() { return load(runId); },
      // stopped: the caller's attempt can make no further effect. For a writer
      // run its lifecycle_settled evidence is made durable first; if that
      // fails the lease is kept and the attempt stays unproven.
      release({ stopped = false } = {}) {
        if (released) return true;
        const current = readLease(dir);
        if (!current || current.nonce !== lease.nonce) { released = true; return false; }
        if (stopped) {
          let bindingHash;
          try { bindingHash = manifestBindingHash(dir); } catch { return false; }
          if (bindingHash && !writeStopped(dir, runId, lease, bindingHash, 'lifecycle_settled')) return false;
        }
        released = true;
        fs.unlinkSync(path.join(dir, 'lease.json')); fsyncDir(dir);
        return true;
      },
    });
  }

  function listRuns() {
    try { ensureRoot(); } catch { return []; }
    return fs.readdirSync(root).filter((name) => RUN_ID.test(name));
  }

  // Startup reconciliation: only checkpoints whose owner is proven dead (or
  // that hold no lease) are touched. Live or unverifiable owners are left
  // alone. An interrupted model turn becomes terminal outcome_uncertain; a
  // stored non-resumable provider error becomes terminal with its class.
  function reconcile() {
    const results = [];
    for (const runId of listRuns()) {
      const dir = path.join(root, runId);
      try {
        assertPrivateDir(dir);
        const state = ownerState(readLease(dir));
        if (state === 'live' || state === 'unknown') { results.push({ runId, action: 'owner_live_or_unknown' }); continue; }
        const h = acquire(runId, { purpose: 'reconcile' });
        try {
          const { manifest, turns, tools, patches } = h.load();
          if (manifest.status === 'active') {
            const next = finalizeInterrupted(h, manifest, turns, { tools, patches });
            results.push({ runId, action: next.outcome.class, status: next.status });
          } else results.push({ runId, action: 'unchanged' });
        } finally { h.release(); }
      } catch (error) { results.push({ runId, action: 'skipped', code: error.code || 'error' }); }
    }
    return results;
  }

  return Object.freeze({ root, newRunId, create, acquire, acquireEffectsRecovery, effectsOwnerStopped, stoppedAttempts, load, fingerprint,
    reconcile, listRuns });
}

// The provider error durably recorded on the last turn, if that turn was a
// received error. Its stored `resumable` flag decides; a record written
// before the flag existed falls back to the class table.
function lastProviderError(turns) {
  const last = turns.length ? turns[turns.length - 1] : null;
  const error = last?.state === 'received' ? last.response?.error : null;
  if (!error || typeof error.class !== 'string') return null;
  const resumable = typeof error.resumable === 'boolean' ? error.resumable : ERROR_CLASSES[error.class]?.resumable === true;
  return { error, resumable, outcome: { class: error.class, status: error.status ?? null, providerCode: error.providerCode ?? null,
    reserveReleaseEvidence: error.reserveReleaseEvidence === true } };
}

// Patch operations whose effect is not proven committed: an uncommitted patch
// record, or an apply_patch call left in intent.
function pendingPatchEffects({ tools = new Map(), patches = new Map() } = {}) {
  const keys = new Set();
  for (const [key, record] of patches) if (record?.state !== 'committed') keys.add(key);
  for (const [key, record] of tools) if (record?.name === 'apply_patch' && record.state !== 'done') keys.add(key);
  return [...keys].sort();
}

// An unsettled patch effect makes the run terminal with
// patch_outcome_uncertain; only recovery under a retained hold may settle it.
// Any model turn left in intent/uncertain makes the run terminal with
// outcome_uncertain. A received non-resumable provider error makes it
// terminal with that error's class and evidence; a resumable one leaves it
// resumable with that class. Otherwise the run becomes resumable "interrupted".
function finalizeInterrupted(h, manifest, turns, records = {}) {
  const at = new Date().toISOString();
  const effects = pendingPatchEffects(records);
  if (effects.length) {
    const next = { ...manifest, status: 'terminal', outcome: { class: 'patch_outcome_uncertain', effectsPending: effects, at }, updatedAt: at };
    h.writeManifest(next);
    return next;
  }
  const pending = turns.filter((t) => t.state === 'intent' || t.state === 'uncertain');
  for (const t of pending.filter((x) => x.state === 'intent')) h.writeTurn({ ...t, state: 'uncertain', uncertainAt: at });
  const stored = pending.length ? null : lastProviderError(turns);
  const next = pending.length
    ? { ...manifest, status: 'terminal', outcome: { class: 'outcome_uncertain', uncertainTurn: pending[0].index, at }, updatedAt: at }
    : stored
      ? { ...manifest, status: stored.resumable ? 'resumable' : 'terminal', outcome: { ...stored.outcome, at }, updatedAt: at }
      : { ...manifest, status: 'resumable', outcome: { class: 'interrupted', at }, updatedAt: at };
  h.writeManifest(next);
  return next;
}

module.exports = { createCheckpointStore, finalizeInterrupted, pendingPatchEffects, lastProviderError, turnName, toolName, patchName,
  parseRecordName, newRunId, executionBindingHash, procStartTime, processState, readProcessIdentity, TERMINAL_STATUSES, RUN_ID };
