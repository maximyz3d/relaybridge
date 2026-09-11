'use strict';

// Internal prototype for NEW gated Linux task-capacity owners. No public proof,
// PID adoption, legacy conversion, writer-lease release, or worker replay.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { openLinuxDurableDirectory } = require('./linux-durable-file');
const { createLinuxPhysicalOwner } = require('./linux-physical-owner');
const { probeLinuxNamespace } = require('./linux-owner-identity');

const VERSION = 2;
const MAX_EVENT_BYTES = 65536;
const MAX_JOURNAL_FILES = 2048;
const MAX_OWNER_EVENTS = 6; // prepared, pin, permit, composite proof, decision, applied
const PUBLICATION_HEADROOM = 1; // synchronous publisher; admission halts on ambiguity
const EVENT_NAME = /^owner_[a-f0-9]{32}\.\d{4}\.json$/;
const TEMP_NAME = /^\.rb-[a-f0-9]{32}\.tmp$/;
const GONE_EVIDENCE = new Set(['pid_absent', 'birth_changed', 'namespace_changed', 'boot_changed']);
const BINDING_KEYS = ['requestId', 'invocationId', 'attemptId', 'runId', 'taskId', 'provider',
  'accountId', 'executionHash', 'cwdIdentityHash', 'cwdPolicyId', 'reservationId'];

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const clone = value => JSON.parse(canonical(value));
const error = code => Object.assign(new Error(code), { code });
function shape(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw error('OWNER_SCHEMA_INVALID');
}
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,159}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const inodeKey = stat => String(stat.dev) + ':' + String(stat.ino);
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
function stableStat(stat) {
  return ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key])).join(':');
}
function privateRegular(stat) {
  return stat.isFile() && stat.uid === BigInt(process.getuid()) && (stat.mode & 0o7777n) === 0o600n;
}
function validatePin(pin) {
  shape(pin, ['hostPid', 'starttime', 'nsIno', 'namespacePid', 'bootId']);
  if (!Number.isSafeInteger(pin.hostPid) || pin.hostPid <= 0 || pin.namespacePid !== 1
    || !/^\d{1,20}$/.test(pin.starttime) || !/^[1-9]\d{0,19}$/.test(pin.nsIno)
    || !/^[a-f0-9-]{36}$/.test(pin.bootId)) throw error('OWNER_PIN_INVALID');
  return clone(pin);
}
function validateBinding(binding) {
  shape(binding, BINDING_KEYS);
  for (const key of BINDING_KEYS) {
    const valid = ['executionHash', 'cwdIdentityHash', 'cwdPolicyId'].includes(key)
      ? digest(binding[key]) : identifier(binding[key]);
    if (!valid) throw error('OWNER_BINDING_INVALID');
  }
  if (!/^run_[A-Za-z0-9_-]{1,100}$/.test(binding.runId)) throw error('OWNER_BINDING_INVALID');
  return clone(binding);
}
function validateProfile(profile, binding) {
  shape(profile, ['version', 'kind', 'policyId', 'cwdIdentityHash', 'executionHash', 'writeRoots']);
  if (profile.version !== 1 || !['linux_pid1_owner', 'linux_pid1_staged_write'].includes(profile.kind)
    || profile.policyId !== binding.cwdPolicyId || profile.cwdIdentityHash !== binding.cwdIdentityHash
    || profile.executionHash !== binding.executionHash || !Array.isArray(profile.writeRoots)
    || profile.writeRoots.length > 64) throw error('OWNER_LAUNCH_PROFILE_INVALID');
  const seen = new Set();
  for (const root of profile.writeRoots) {
    shape(root, ['path', 'dev', 'ino']);
    if (typeof root.path !== 'string' || !path.isAbsolute(root.path) || path.normalize(root.path) !== root.path
      || root.path.includes('\0') || root.path.length > 4096 || !/^\d{1,20}$/.test(root.dev)
      || !/^\d{1,20}$/.test(root.ino) || seen.has(root.path)) throw error('OWNER_LAUNCH_PROFILE_INVALID');
    seen.add(root.path);
  }
  if (profile.kind === 'linux_pid1_owner' && profile.writeRoots.length) throw error('OWNER_LAUNCH_PROFILE_INVALID');
  return clone(profile);
}
function defaultPhysicalOwner(options) {
  if (options.launchProfile.kind !== 'linux_pid1_owner' || options.launchProfile.writeRoots.length) {
    throw error('OWNER_LAUNCH_PROFILE_UNQUALIFIED');
  }
  return createLinuxPhysicalOwner({ runId: options.runId });
}

// An inherited duplicate lets flock acquire the parent's retained open-file
// description. Normal children do not inherit this private descriptor.
function controllerLock(directory, { fsApi = fs, flockPath = '/usr/bin/flock' } = {}) {
  if (process.platform !== 'linux') throw error('OWNER_PLATFORM_UNQUALIFIED');
  const anchorFd = fsApi.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let lockFd = null, closed = false;
  try {
    const rootStat = fsApi.fstatSync(anchorFd, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.uid !== BigInt(process.getuid()) || (rootStat.mode & 0o7777n) !== 0o700n) {
      throw error('OWNER_ANCHOR_UNTRUSTED');
    }
    const anchor = { dev: String(rootStat.dev), ino: String(rootStat.ino) };
    const at = '/proc/self/fd/' + anchorFd;
    lockFd = fsApi.openSync(at + '/controller.lock', fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    const lockStat = fsApi.fstatSync(lockFd, { bigint: true });
    if (!privateRegular(lockStat) || lockStat.nlink !== 1n) throw error('OWNER_LOCK_UNTRUSTED');
    fsApi.fsyncSync(lockFd);
    fsApi.fsyncSync(anchorFd);
    const acquired = spawnSync(flockPath, ['-n', '-x', '-E', '73', '3'], {
      stdio: ['ignore', 'pipe', 'pipe', lockFd], timeout: 2000, maxBuffer: 1024, env: { PATH: '/usr/bin:/bin' },
    });
    if (acquired.error || acquired.signal || acquired.status !== 0) {
      throw error(acquired.status === 73 ? 'OWNER_CONTROLLER_BUSY' : 'OWNER_LOCK_UNCONFIRMED');
    }
    function assertHeld() {
      if (closed) throw error('OWNER_CONTROLLER_CLOSED');
      const currentRoot = fsApi.fstatSync(anchorFd, { bigint: true });
      const current = fsApi.fstatSync(lockFd, { bigint: true });
      const named = fsApi.lstatSync(at + '/controller.lock', { bigint: true });
      if (!sameInode(currentRoot, rootStat) || !sameInode(fsApi.lstatSync(directory, { bigint: true }), rootStat)
        || (currentRoot.mode & 0o7777n) !== 0o700n
        || !privateRegular(current) || !privateRegular(named) || !sameInode(current, lockStat)
        || !sameInode(named, current) || current.nlink !== 1n) throw error('OWNER_LOCK_IDENTITY_CHANGED');
    }
    return {
      anchor, at, anchorFd, assertHeld,
      close() {
        if (closed) return;
        closed = true;
        const fd = lockFd; lockFd = null;
        try { fsApi.closeSync(fd); } finally { fsApi.closeSync(anchorFd); }
      },
    };
  } catch (cause) {
    if (lockFd !== null) try { fsApi.closeSync(lockFd); } catch {}
    try { fsApi.closeSync(anchorFd); } catch {}
    throw cause;
  }
}

function createOwnerJournal({ directory, receiptStoreId, hostIdentity, qualifyHost,
  resolveTrustedLaunch = () => { throw error('OWNER_LAUNCH_PROFILE_UNAVAILABLE'); },
  createPhysicalOwner = defaultPhysicalOwner, probeNamespace = probeLinuxNamespace,
  validateCurrentBinding = () => false,
  applyTaskRelease = () => { throw error('OWNER_APPLIER_UNAVAILABLE'); },
  maxJournalFiles = MAX_JOURNAL_FILES, fsApi = fs } = {}) {
  // This is deployment-owned qualification, never an HTTP body boolean.
  if (typeof qualifyHost !== 'function' || qualifyHost() !== true || !digest(hostIdentity) || !digest(receiptStoreId)) {
    throw error('OWNER_HOST_UNQUALIFIED');
  }
  if (!Number.isSafeInteger(maxJournalFiles) || maxJournalFiles < MAX_OWNER_EVENTS + 2 || maxJournalFiles > MAX_JOURNAL_FILES) {
    throw error('OWNER_JOURNAL_LIMIT_INVALID');
  }
  const lock = controllerLock(directory, { fsApi });
  let durable;
  try {
    const guarded = Object.create(fsApi);
    guarded.openSync = (file, flags, ...rest) => {
      const fd = fsApi.openSync(file, flags, ...rest);
      if (flags & fs.constants.O_DIRECTORY) {
        const stat = fsApi.fstatSync(fd, { bigint: true });
        if (String(stat.dev) !== lock.anchor.dev || String(stat.ino) !== lock.anchor.ino) {
          fsApi.closeSync(fd);
          throw error('OWNER_ANCHOR_CHANGED');
        }
      }
      return fd;
    };
    durable = openLinuxDurableDirectory({ directory, fsApi: guarded, maxBytes: MAX_EVENT_BYTES });
  } catch (cause) { lock.close(); throw cause; }

  const records = new Map(), live = new Map(), busy = new Set(), confirmedNames = new Set();
  let closed = false, applicationBlocked = false, pendingWrite = null;
  const filename = (id, revision) => `${id}.${String(revision).padStart(4, '0')}.json`;

  function guard({ admission = false } = {}) {
    if (closed) throw error('OWNER_CONTROLLER_CLOSED');
    lock.assertHeld();
    if (qualifyHost() !== true) throw error('OWNER_HOST_UNQUALIFIED');
    if (admission) {
      if (pendingWrite) throw error('OWNER_DURABILITY_UNCONFIRMED');
      if (applicationBlocked) throw error('OWNER_RELEASE_APPLICATION_PENDING');
      assertCapacity();
    }
  }
  function census() {
    lock.assertHeld();
    const directoryHandle = fsApi.opendirSync(lock.at), names = [];
    try {
      for (;;) {
        const entry = directoryHandle.readSync();
        if (!entry) break;
        if (names.length >= maxJournalFiles) throw error('OWNER_JOURNAL_LIMIT');
        names.push(entry.name);
      }
    } finally { directoryHandle.closeSync(); }
    return names.sort();
  }
  function assertCapacity(additionalOwners = 0) {
    const names = census();
    for (const name of names) {
      if (name !== 'controller.lock' && !confirmedNames.has(name)) throw error('OWNER_JOURNAL_UNTRUSTED');
    }
    // A disappeared canonical row is also drift; append cannot legitimize it.
    if (names.length !== confirmedNames.size + 1) throw error('OWNER_JOURNAL_CHANGED');
    let reserved = additionalOwners * MAX_OWNER_EVENTS;
    for (const record of records.values()) if (!record.applied) reserved += MAX_OWNER_EVENTS - record.revision;
    if (names.length + reserved + PUBLICATION_HEADROOM > maxJournalFiles) throw error('OWNER_JOURNAL_CAPACITY');
    return { namedFiles: names.length, reservedEvents: reserved, temporaryHeadroom: PUBLICATION_HEADROOM, maxFiles: maxJournalFiles };
  }
  function trustedLaunch(binding) {
    const value = resolveTrustedLaunch(clone(binding));
    shape(value, ['profile', 'launch']);
    const profile = validateProfile(value.profile, binding), launch = value.launch;
    shape(launch, ['file', 'args', 'cwd', 'env']);
    if (typeof launch.file !== 'string' || !path.isAbsolute(launch.file) || launch.file.includes('\0')
      || typeof launch.cwd !== 'string' || !path.isAbsolute(launch.cwd) || launch.cwd.includes('\0')
      || !Array.isArray(launch.args) || launch.args.length > 512
      || launch.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
      || !launch.env || typeof launch.env !== 'object' || Array.isArray(launch.env)
      || Object.entries(launch.env).some(([key, value]) => !key || /[=\0]/.test(key) || typeof value !== 'string' || value.includes('\0'))
      || Buffer.byteLength(canonical(launch)) > MAX_EVENT_BYTES) throw error('OWNER_LAUNCH_INVALID');
    return { profile, launch: clone(launch), profileHash: hash(profile), launchHash: hash(launch) };
  }

  // Pure validation: needed before legitimate-temp cleanup; unconfirmed bytes
  // must never enter records or supply release authority.
  function reduceEvent(event, prior) {
    shape(event, ['version', 'ownerId', 'revision', 'previousHash', 'type', 'body', 'hash']);
    const unhashed = { ...event }; delete unhashed.hash;
    if (event.version !== VERSION || !/^owner_[a-f0-9]{32}$/.test(event.ownerId)
      || !Number.isSafeInteger(event.revision) || event.revision < 1 || event.revision > MAX_OWNER_EVENTS
      || hash(unhashed) !== event.hash) throw error('OWNER_JOURNAL_INVALID');
    if (event.revision !== (prior?.revision || 0) + 1 || event.previousHash !== (prior?.lastHash || null)) {
      throw error('OWNER_JOURNAL_ORDER');
    }
    const state = prior ? clone(prior) : { ownerId: event.ownerId };
    const body = event.body;
    if (event.type === 'prepared') {
      if (prior) throw error('OWNER_JOURNAL_ORDER');
      shape(body, ['binding', 'bindingHash', 'receiptStoreId', 'hostIdentity', 'anchor', 'launchProfile', 'profileHash', 'launchHash']);
      const binding = validateBinding(body.binding);
      validateProfile(body.launchProfile, binding);
      const expectedId = 'owner_' + hash([lock.anchor, receiptStoreId, binding.attemptId, binding.runId]).slice(0, 32);
      if (event.ownerId !== expectedId || hash(body.launchProfile) !== body.profileHash || !digest(body.launchHash)
        || hash(binding) !== body.bindingHash || body.hostIdentity !== hostIdentity || body.receiptStoreId !== receiptStoreId
        || canonical(body.anchor) !== canonical(lock.anchor)) throw error('OWNER_AUTHORITY_CHANGED');
      Object.assign(state, body, { binding, held: true });
    } else {
      if (!prior) throw error('OWNER_JOURNAL_ORDER');
      if (event.type === 'pin') {
        shape(body, ['pin']);
        if (prior.lastType !== 'prepared') throw error('OWNER_JOURNAL_ORDER');
        state.pin = validatePin(body.pin);
      } else if (event.type === 'permit') {
        shape(body, ['bindingHash']);
        if (prior.lastType !== 'pin' || body.bindingHash !== state.bindingHash) throw error('OWNER_JOURNAL_ORDER');
        state.permitted = true;
      } else if (event.type === 'proof') {
        shape(body, ['kind', 'pinHash', 'evidence', 'wrapperExited', 'stdoutEof', 'stderrEof']);
        if (!['pin', 'permit'].includes(prior.lastType) || body.kind !== 'physical_owner_settled_v1'
          || body.pinHash !== hash(state.pin) || !GONE_EVIDENCE.has(body.evidence)
          || body.wrapperExited !== true || body.stdoutEof !== true || body.stderrEof !== true) throw error('OWNER_PROOF_INVALID');
        state.proof = { ...body, proofId: event.hash };
      } else if (event.type === 'decision') {
        shape(body, ['recoveryId', 'intentHash', 'scope', 'proofId', 'bindingHash']);
        if (prior.lastType !== 'proof' || body.scope !== 'task_capacity' || body.proofId !== state.proof.proofId
          || body.bindingHash !== state.bindingHash || !identifier(body.recoveryId) || !digest(body.intentHash)) throw error('OWNER_DECISION_INVALID');
        state.decision = { ...body, decisionId: event.hash, replay: false };
      } else if (event.type === 'applied') {
        shape(body, ['decisionId']);
        if (prior.lastType !== 'decision' || body.decisionId !== state.decision.decisionId) throw error('OWNER_DECISION_INVALID');
        state.applied = true; state.held = false;
      } else throw error('OWNER_JOURNAL_INVALID');
    }
    state.revision = event.revision; state.lastHash = event.hash; state.lastType = event.type;
    return state;
  }
  function accept(event) {
    const state = reduceEvent(event, records.get(event.ownerId));
    records.set(event.ownerId, state);
    confirmedNames.add(filename(event.ownerId, event.revision));
    applicationBlocked = [...records.values()].some(record => record.decision && !record.applied);
    return state;
  }

  // Account for EVERY inode link before touching any temp. Only an exact local
  // publication pair/group can be repaired; an outside link or canonical alias
  // remains an untrusted journal. Orphan temps are never deleted by pattern.
  function readConfirmed(name, expectedEvent = null) {
    let fd = null;
    try {
      const location = lock.at + '/' + name;
      fd = fsApi.openSync(location, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const before = fsApi.fstatSync(fd, { bigint: true });
      if (!privateRegular(before) || before.size < 1n || before.size > BigInt(MAX_EVENT_BYTES)) throw error('OWNER_JOURNAL_UNTRUSTED');
      const names = before.nlink > 1n ? census() : [name], matches = [];
      for (const candidate of names) {
        const stat = fsApi.lstatSync(lock.at + '/' + candidate, { bigint: true });
        if (!sameInode(stat, before)) continue;
        if (!privateRegular(stat) || (candidate !== name && !TEMP_NAME.test(candidate))) throw error('OWNER_JOURNAL_UNTRUSTED');
        if (candidate !== name) matches.push(candidate);
      }
      if (before.nlink !== BigInt(matches.length + 1)) throw error('OWNER_JOURNAL_UNTRUSTED');
      const bytes = Buffer.alloc(Number(before.size)); let offset = 0, calls = 0;
      while (offset < bytes.length) {
        if (++calls > 1024) throw error('OWNER_JOURNAL_LIMIT');
        const count = fsApi.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) throw error('OWNER_JOURNAL_TRUNCATED');
        offset += count;
      }
      if (stableStat(fsApi.fstatSync(fd, { bigint: true })) !== stableStat(before)
        || stableStat(fsApi.lstatSync(location, { bigint: true })) !== stableStat(before)) throw error('OWNER_JOURNAL_CHANGED');
      const row = JSON.parse(bytes.toString('utf8'));
      if (canonical(row) + '\n' !== bytes.toString('utf8')) throw error('OWNER_JOURNAL_NONCANONICAL');
      if (filename(row.ownerId, row.revision) !== name) throw error('OWNER_JOURNAL_INVALID');
      reduceEvent(row, records.get(row.ownerId)); // validates hash, host, anchor, schema, predecessor
      if (expectedEvent && canonical(row) !== canonical(expectedEvent)) throw error('OWNER_JOURNAL_CONFLICT');
      fsApi.fsyncSync(fd);
      for (let index = 0; index < matches.length; index++) {
        const temp = lock.at + '/' + matches[index];
        const named = fsApi.lstatSync(location, { bigint: true });
        const linked = fsApi.lstatSync(temp, { bigint: true });
        const expectedLinks = BigInt(matches.length + 1 - index);
        if (!privateRegular(named) || !privateRegular(linked) || !sameInode(named, before) || !sameInode(linked, before)
          || named.nlink !== expectedLinks || linked.nlink !== expectedLinks) throw error('OWNER_JOURNAL_CHANGED');
        fsApi.unlinkSync(temp);
      }
      fsApi.fsyncSync(lock.anchorFd);
      const after = fsApi.fstatSync(fd, { bigint: true });
      const named = fsApi.lstatSync(location, { bigint: true });
      if (!privateRegular(after) || !sameInode(after, before) || !sameInode(named, before)
        || after.nlink !== 1n || named.nlink !== 1n || after.size !== before.size || after.mtimeNs !== before.mtimeNs) {
        throw error('OWNER_JOURNAL_CHANGED');
      }
      const closing = fd; fd = null; fsApi.closeSync(closing);
      return row;
    } catch (cause) {
      if (fd !== null) try { fsApi.closeSync(fd); } catch {}
      throw error(cause.code?.startsWith('OWNER_') ? cause.code : 'OWNER_DURABILITY_UNCONFIRMED');
    }
  }


  // SIGKILL before link(temp, canonical) can leave a single-link unpublished
  // next-event temp. Discard only fully validated known-owner successor bytes;
  // never publish/adopt them. Unknown/orphan-prepared bytes remain refused.
  function discardUnpublishedTemp(name) {
    let fd = null;
    try {
      const location = lock.at + '/' + name;
      fd = fsApi.openSync(location, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const before = fsApi.fstatSync(fd, { bigint: true });
      if (!TEMP_NAME.test(name) || !privateRegular(before) || before.nlink !== 1n
        || before.size < 1n || before.size > BigInt(MAX_EVENT_BYTES)) throw error('OWNER_JOURNAL_UNTRUSTED');
      const bytes = Buffer.alloc(Number(before.size)); let offset = 0, calls = 0;
      while (offset < bytes.length) {
        if (++calls > 1024) throw error('OWNER_JOURNAL_LIMIT');
        const count = fsApi.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) throw error('OWNER_JOURNAL_TRUNCATED');
        offset += count;
      }
      let row;
      try { row = JSON.parse(bytes.toString('utf8')); } catch { throw error('OWNER_JOURNAL_UNTRUSTED'); }
      if (canonical(row) + '\n' !== bytes.toString('utf8')) throw error('OWNER_JOURNAL_UNTRUSTED');
      const prior = records.get(row.ownerId);
      if (!prior || row.type === 'prepared') throw error('OWNER_JOURNAL_UNTRUSTED');
      reduceEvent(row, prior);
      if (!validateCurrentBinding(clone(prior.binding))) throw error('OWNER_BINDING_CHANGED');
      const canonicalLocation = lock.at + '/' + filename(row.ownerId, row.revision);
      try { fsApi.lstatSync(canonicalLocation); throw error('OWNER_JOURNAL_CONFLICT'); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      fsApi.fsyncSync(fd);
      if (stableStat(fsApi.fstatSync(fd, { bigint: true })) !== stableStat(before)
        || stableStat(fsApi.lstatSync(location, { bigint: true })) !== stableStat(before)) throw error('OWNER_JOURNAL_CHANGED');
      fsApi.unlinkSync(location);
      fsApi.fsyncSync(lock.anchorFd);
      const closing = fd; fd = null; fsApi.closeSync(closing);
    } catch (cause) {
      if (fd !== null) try { fsApi.closeSync(fd); } catch {}
      throw error(cause.code?.startsWith('OWNER_') ? cause.code : 'OWNER_DURABILITY_UNCONFIRMED');
    }
  }

  function append(id, type, body) {
    guard();
    const prior = records.get(id);
    const event = { version: VERSION, ownerId: id, revision: (prior?.revision || 0) + 1,
      previousHash: prior?.lastHash || null, type, body: clone(body) };
    event.hash = hash(event);
    reduceEvent(event, prior); // validate before publishing anything
    const name = filename(id, event.revision);
    if (pendingWrite && canonical(pendingWrite) !== canonical(event)) throw error('OWNER_DURABILITY_UNCONFIRMED');
    if (pendingWrite) {
      let exists;
      try { fsApi.lstatSync(lock.at + '/' + name); exists = true; }
      catch (cause) { if (cause.code !== 'ENOENT') throw error('OWNER_DURABILITY_UNCONFIRMED'); exists = false; }
      if (exists) {
        const confirmed = readConfirmed(name, event);
        const state = accept(confirmed); pendingWrite = null;
        assertCapacity();
        return state;
      }
    }
    assertCapacity(prior ? 0 : 1);
    pendingWrite = event;
    try {
      const result = durable.createExclusive(name, canonical(event) + '\n');
      if (result.durability !== 'confirmed' || result.cleanupPending) throw error('OWNER_DURABILITY_UNCONFIRMED');
      const state = accept(event); pendingWrite = null;
      return state;
    } catch (cause) {
      // Preserve exact intent in memory. No different publication/admission is
      // permitted until exact retry or strict restore resolves the ambiguity.
      throw error(cause.code?.startsWith('OWNER_') ? cause.code : 'OWNER_DURABILITY_UNCONFIRMED');
    }
  }
  function get(id) {
    guard();
    const state = records.get(id);
    if (!state) throw error('OWNER_UNBOUND');
    return state;
  }
  function freshNamespaceProof(state) {
    if (!state.pin) throw error('OWNER_PROOF_UNAVAILABLE');
    const proof = probeNamespace(clone(state.pin));
    if (proof.state === 'alive') throw error('OWNER_STILL_ACTIVE');
    if (proof.state !== 'gone' || !GONE_EVIDENCE.has(proof.evidence)) throw error('OWNER_PROOF_UNAVAILABLE');
    return proof;
  }
  function verifyLocalSettlement(state, runtime) {
    const snapshot = runtime.owner.snapshot();
    if (!state.pin || canonical(snapshot.pin) !== canonical(state.pin)) throw error('OWNER_PIN_MISMATCH');
    if (!runtime.physicalResolved || snapshot.wrapperExited !== true || snapshot.stdoutEof !== true || snapshot.stderrEof !== true) {
      throw error('OWNER_PHYSICAL_PENDING');
    }
  }
  function requireReleaseProof(state) {
    // Namespace death is necessary but never sufficient. The v2 composite
    // event is the only durable proof accepted after restart.
    freshNamespaceProof(state);
    const runtime = live.get(state.ownerId);
    if (runtime) verifyLocalSettlement(state, runtime);
    if (!state.proof || state.proof.kind !== 'physical_owner_settled_v1'
      || state.proof.wrapperExited !== true || state.proof.stdoutEof !== true || state.proof.stderrEof !== true
      || state.proof.pinHash !== hash(state.pin)) throw error('OWNER_PROOF_UNAVAILABLE');
  }
  const inspect = id => clone(get(id));

  function prepare(input) {
    guard({ admission: true });
    const binding = validateBinding(input);
    if (!validateCurrentBinding(clone(binding))) throw error('OWNER_BINDING_CHANGED');
    const launch = trustedLaunch(binding);
    const id = 'owner_' + hash([lock.anchor, receiptStoreId, binding.attemptId, binding.runId]).slice(0, 32);
    if (records.has(id)) throw error('OWNER_EXISTS');
    append(id, 'prepared', { binding, bindingHash: hash(binding), receiptStoreId, hostIdentity, anchor: lock.anchor,
      launchProfile: launch.profile, profileHash: launch.profileHash, launchHash: launch.launchHash });
    const owner = createPhysicalOwner({ runId: binding.runId, launchProfile: clone(launch.profile) });
    const runtime = { owner, started: false, permitAttempted: false, physicalResolved: false };
    live.set(id, runtime);
    Promise.resolve(owner.physicalDone).then(() => { runtime.physicalResolved = true; }, () => {});
    return inspect(id);
  }
  async function start(id, ...callerArguments) {
    guard({ admission: true });
    if (callerArguments.length) throw error('OWNER_CALLER_LAUNCH_FORBIDDEN');
    const state = get(id), runtime = live.get(id);
    if (!runtime || runtime.started) throw error('OWNER_START_UNAVAILABLE');
    if (!validateCurrentBinding(clone(state.binding))) throw error('OWNER_BINDING_CHANGED');
    const launch = trustedLaunch(state.binding);
    if (launch.profileHash !== state.profileHash || launch.launchHash !== state.launchHash) throw error('OWNER_LAUNCH_CHANGED');
    runtime.started = true;
    return runtime.owner.start(launch.launch);
  }
  async function permit(id) {
    guard({ admission: true });
    const state = get(id), runtime = live.get(id);
    if (!runtime?.started || runtime.permitAttempted) throw error('OWNER_PERMIT_UNAVAILABLE');
    runtime.permitAttempted = true;
    try {
      await runtime.owner.ready;
      guard({ admission: true });
      if (!validateCurrentBinding(clone(state.binding))) throw error('OWNER_BINDING_CHANGED');
      const pin = validatePin(runtime.owner.snapshot().pin);
      if (probeNamespace(pin).state !== 'alive') throw error('OWNER_PIN_UNVERIFIED');
      append(id, 'pin', { pin });
      append(id, 'permit', { bindingHash: state.bindingHash });
      guard({ admission: true });
      if (!validateCurrentBinding(clone(state.binding)) || canonical(runtime.owner.snapshot().pin) !== canonical(pin)
        || probeNamespace(pin).state !== 'alive') throw error('OWNER_BINDING_CHANGED');
      return await runtime.owner.allowProvider();
    } catch (cause) { runtime.owner.requestStop(); throw cause; }
  }
  function stop(id) {
    get(id);
    const runtime = live.get(id);
    if (!runtime) throw error('OWNER_CONTROL_UNAVAILABLE');
    return runtime.owner.requestStop();
  }
  async function confirmPhysical(id) {
    get(id);
    const runtime = live.get(id);
    if (!runtime) throw error('OWNER_CONTROL_UNAVAILABLE');
    await runtime.owner.physicalDone;
    runtime.physicalResolved = true;
    const state = get(id);
    verifyLocalSettlement(state, runtime);
    const proof = freshNamespaceProof(state);
    if (!state.proof) append(id, 'proof', { kind: 'physical_owner_settled_v1', pinHash: hash(state.pin),
      evidence: proof.evidence, wrapperExited: true, stdoutEof: true, stderrEof: true });
    return inspect(id);
  }
  function recover(id, input) {
    guard();
    shape(input, ['recoveryId', 'expectedRevision', 'expectedBindingHash', 'scope', 'reason']);
    if (!identifier(input.recoveryId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
      || !digest(input.expectedBindingHash) || input.scope !== 'task_capacity' || typeof input.reason !== 'string'
      || !input.reason.trim() || input.reason.length > 500) throw error('OWNER_RECOVERY_INVALID');
    const state = get(id), intentHash = hash(input);
    if (state.decision) {
      if (state.decision.recoveryId !== input.recoveryId || state.decision.intentHash !== intentHash) throw error('OWNER_RECOVERY_ID_CONFLICT');
      return clone(state.decision); // inert retry; applyRelease separately checks authority
    }
    if (input.expectedRevision !== state.revision || input.expectedBindingHash !== state.bindingHash
      || !validateCurrentBinding(clone(state.binding))) throw error('OWNER_BINDING_CHANGED');
    requireReleaseProof(state);
    // No intermediate proof event here: exact recovery CAS survives every
    // before/after-publication crash position with its original intent.
    append(id, 'decision', { recoveryId: input.recoveryId, intentHash, scope: 'task_capacity',
      proofId: state.proof.proofId, bindingHash: state.bindingHash });
    return clone(get(id).decision);
  }
  async function applyRelease(id, decisionId) {
    guard();
    if (busy.has(id)) throw error('OWNER_OPERATION_BUSY');
    const state = get(id);
    if (!state.decision || state.decision.decisionId !== decisionId || state.decision.proofId !== state.proof?.proofId) {
      throw error('OWNER_DECISION_UNTRUSTED');
    }
    if (state.applied) return clone(state.decision); // inert, no side effect to re-authorize
    if (!validateCurrentBinding(clone(state.binding))) throw error('OWNER_BINDING_CHANGED');
    requireReleaseProof(state);
    // Capacity is reserved before invoking the idempotent external projection.
    if (!pendingWrite) assertCapacity();
    else if (pendingWrite.ownerId !== id || pendingWrite.type !== 'applied') throw error('OWNER_DURABILITY_UNCONFIRMED');
    busy.add(id); applicationBlocked = true;
    try {
      if (await applyTaskRelease(clone(state.binding), clone(state.decision)) !== true) throw error('OWNER_RELEASE_UNCONFIRMED');
      // Revalidate after the await too. Callback's exact decision-keyed CAS
      // must make a retry safe if it succeeded before a barrier/binding error.
      guard();
      if (!validateCurrentBinding(clone(state.binding))) throw error('OWNER_BINDING_CHANGED');
      requireReleaseProof(state);
      append(id, 'applied', { decisionId });
      return clone(get(id).decision);
    } finally { busy.delete(id); }
  }

  // Restore never creates a live gate or synthesizes physical proof. Canonical
  // reads may repair exact interrupted publication links after pure validation.
  try {
    const names = census();
    for (const name of names) {
      if (name === 'controller.lock' || TEMP_NAME.test(name)) continue;
      if (!EVENT_NAME.test(name)) throw error('OWNER_JOURNAL_UNTRUSTED');
      accept(readConfirmed(name));
    }
    for (const name of census()) if (TEMP_NAME.test(name)) discardUnpublishedTemp(name);
    assertCapacity(); // refuses unknown temps/files and reserves finish space
  } catch (cause) {
    try { durable.close(); } finally { lock.close(); }
    throw cause;
  }

  return Object.freeze({ prepare, start, permit, stop, confirmPhysical, recover, applyRelease, inspect,
    heldCount: () => [...records.values()].filter(record => record.held).length,
    admissionBlocked: () => applicationBlocked || pendingWrite !== null,
    capacity: () => { guard(); return assertCapacity(); },
    close() {
      if (closed) return;
      closed = true;
      for (const value of live.values()) value.owner.requestStop();
      try { durable.close(); } finally { lock.close(); }
    },
  });
}

module.exports = { createOwnerJournal, controllerLock, canonical, hash,
  VERSION, MAX_JOURNAL_FILES, MAX_OWNER_EVENTS, PUBLICATION_HEADROOM, validateBinding, validateProfile };
