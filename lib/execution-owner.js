'use strict';

// Private durable authority for new gated Linux execution and writer owners.
// No public proof, PID adoption, legacy conversion, or worker replay.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { openLinuxDurableDirectory } = require('./linux-durable-file');
const { createLinuxPhysicalOwner } = require('./linux-physical-owner');
const { probeLinuxNamespace } = require('./linux-owner-identity');

const VERSION = 3;
const MAX_EVENT_BYTES = 65536;
const MAX_JOURNAL_FILES = 2048;
const MAX_OWNER_EVENTS = 6; // prepared, pin, permit, composite proof, decision, applied
const MAX_WRITER_EVENTS = 8;
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
  shape(binding, Object.prototype.hasOwnProperty.call(binding || {}, 'writer') ? [...BINDING_KEYS, 'writer'] : BINDING_KEYS);
  for (const key of BINDING_KEYS) {
    const valid = ['executionHash', 'cwdIdentityHash', 'cwdPolicyId'].includes(key)
      ? digest(binding[key]) : identifier(binding[key]);
    if (!valid) throw error('OWNER_BINDING_INVALID');
  }
  if (!/^run_[A-Za-z0-9_-]{1,100}$/.test(binding.runId)) throw error('OWNER_BINDING_INVALID');
  if (binding.writer !== undefined) validateWriter(binding.writer, binding);
  return clone(binding);
}
function validateWriter(writer, binding) {
  shape(writer, ['workflowId', 'phase', 'actor', 'mode', 'ownerEpoch', 'leaseTokenSha256', 'leaseAcquiredAt', 'cwd', 'cwdSha256', 'taskId', 'provider']);
  if (!identifier(writer.workflowId) || writer.phase !== 'revising' || writer.mode !== 'provider'
    || typeof writer.actor !== 'string' || !writer.actor.trim() || writer.actor.length > 160
    || !/^lease_[a-f0-9]{48}$/.test(writer.ownerEpoch) || !digest(writer.leaseTokenSha256)
    || !Number.isSafeInteger(writer.leaseAcquiredAt) || writer.leaseAcquiredAt < 0
    || typeof writer.cwd !== 'string' || !path.isAbsolute(writer.cwd) || path.normalize(writer.cwd) !== writer.cwd
    || writer.cwd.includes('\0') || writer.cwd.length > 4096 || writer.cwdSha256 !== hash(writer.cwd)
    || writer.taskId !== binding.taskId || writer.provider !== binding.provider) throw error('OWNER_WRITER_BINDING_INVALID');
  return clone(writer);
}
const maxEvents = record => record?.binding?.writer ? MAX_WRITER_EVENTS : MAX_OWNER_EVENTS;
function validateWriterIntent(input) {
  shape(input, ['recoveryId', 'expectedRevision', 'expectedBindingHash', 'expectedWorkflowRevision', 'reason']);
  if (!identifier(input.recoveryId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
    || !digest(input.expectedBindingHash) || !Number.isSafeInteger(input.expectedWorkflowRevision) || input.expectedWorkflowRevision < 0
    || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500) throw error('OWNER_RECOVERY_INVALID');
  return clone(input);
}
function validateWriterOutcome(value) {
  shape(value, ['outcome', 'artifact']);
  if (!['completed', 'failed', 'cancelled'].includes(value.outcome)) throw error('OWNER_OUTCOME_UNCONFIRMED');
  if (value.outcome === 'completed') {
    shape(value.artifact, ['markdown', 'sha256']);
    if (typeof value.artifact.markdown !== 'string' || !value.artifact.markdown.trim()
      || Buffer.byteLength(value.artifact.markdown) > 48000 || value.artifact.sha256 !== hash(value.artifact.markdown)) throw error('OWNER_ARTIFACT_UNTRUSTED');
  } else if (value.artifact !== null) throw error('OWNER_ARTIFACT_UNTRUSTED');
  return clone(value);
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
  validateCurrentBinding = () => false, validateWriterBinding = () => false,
  readWriterOutcome = () => null, applyWriterRelease = () => { throw error('OWNER_WRITER_APPLIER_UNAVAILABLE'); },
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
  function assertCapacity(additionalEvents = 0) {
    const names = census();
    for (const name of names) {
      if (name !== 'controller.lock' && !confirmedNames.has(name)) throw error('OWNER_JOURNAL_UNTRUSTED');
    }
    // A disappeared canonical row is also drift; append cannot legitimize it.
    if (names.length !== confirmedNames.size + 1) throw error('OWNER_JOURNAL_CHANGED');
    let reserved = additionalEvents;
    for (const record of records.values()) if (!record.applied) reserved += maxEvents(record) - record.revision;
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
      || !Number.isSafeInteger(event.revision) || event.revision < 1 || event.revision > maxEvents(prior || { binding: event.body?.binding })
      || hash(unhashed) !== event.hash) throw error('OWNER_JOURNAL_INVALID');
    if (event.revision !== (prior?.revision || 0) + 1 || event.previousHash !== (prior?.lastHash || null)) {
      throw error('OWNER_JOURNAL_ORDER');
    }
    const state = prior ? clone(prior) : { ownerId: event.ownerId };
    const body = event.body;
    if (event.type === 'prepared') {
      if (prior) throw error('OWNER_JOURNAL_ORDER');
      shape(body, ['binding', 'bindingHash', 'receiptStoreId', 'hostIdentity', 'anchor', 'launchProfile', 'profileHash', 'launchHash', 'sourceCwd', 'ownerIds']);
      const binding = validateBinding(body.binding);
      validateProfile(body.launchProfile, binding);
      const expectedId = 'owner_' + hash([lock.anchor, receiptStoreId, binding.attemptId, binding.runId]).slice(0, 32);
      if (event.ownerId !== expectedId || hash(body.launchProfile) !== body.profileHash || !digest(body.launchHash)
        || hash(binding) !== body.bindingHash || body.hostIdentity !== hostIdentity || body.receiptStoreId !== receiptStoreId
        || canonical(body.anchor) !== canonical(lock.anchor)) throw error('OWNER_AUTHORITY_CHANGED');
      if (typeof body.sourceCwd !== 'string' || !path.isAbsolute(body.sourceCwd) || body.sourceCwd.includes('\0')
        || canonical(body.ownerIds) !== canonical(binding.writer ? [event.ownerId] : [])
        || (binding.writer && body.sourceCwd !== binding.writer.cwd)) throw error('OWNER_AUTHORITY_CHANGED');
      if (binding.writer && [...records.values()].some(row => row.binding.writer?.ownerEpoch === binding.writer.ownerEpoch && row.ownerId !== event.ownerId)) throw error('OWNER_WRITER_EPOCH_BOUND');
      Object.assign(state, body, { binding, held: true, writerHeld: !!binding.writer });
    } else {
      if (!prior) throw error('OWNER_JOURNAL_ORDER');
      if (event.type === 'pin') {
        shape(body, ['pin']);
        if (state.pin || !(prior.lastType === 'prepared' || state.writerFence) || state.permitted || state.proof) throw error('OWNER_JOURNAL_ORDER');
        state.pin = validatePin(body.pin);
      } else if (event.type === 'permit') {
        shape(body, ['bindingHash']);
        if (prior.lastType !== 'pin' || state.writerFence || state.writerDecision || body.bindingHash !== state.bindingHash) throw error('OWNER_JOURNAL_ORDER');
        state.permitted = true;
      } else if (event.type === 'proof') {
        shape(body, ['kind', 'pinHash', 'evidence', 'wrapperExited', 'stdoutEof', 'stderrEof']);
        if (!state.pin || state.proof || (!['pin', 'permit'].includes(prior.lastType) && !state.writerFence) || body.kind !== 'physical_owner_settled_v1'
          || body.pinHash !== hash(state.pin) || !GONE_EVIDENCE.has(body.evidence)
          || body.wrapperExited !== true || body.stdoutEof !== true || body.stderrEof !== true) throw error('OWNER_PROOF_INVALID');
        state.proof = { ...body, proofId: event.hash };
      } else if (event.type === 'decision') {
        shape(body, ['recoveryId', 'intentHash', 'scope', 'proofId', 'bindingHash']);
        if (!state.proof || state.decision || state.applied || (state.binding.writer && !state.writerApplied) || body.scope !== 'task_capacity' || body.proofId !== state.proof.proofId
          || body.bindingHash !== state.bindingHash || !identifier(body.recoveryId) || !digest(body.intentHash)) throw error('OWNER_DECISION_INVALID');
        state.decision = { ...body, decisionId: event.hash, replay: false };
      } else if (event.type === 'applied') {
        shape(body, ['decisionId']);
        if (!state.decision || state.applied || body.decisionId !== state.decision.decisionId) throw error('OWNER_DECISION_INVALID');
        state.applied = true; state.held = false;
      } else if (event.type === 'writer_fence') {
        shape(body, ['intent', 'intentHash', 'outcome']);
        const intent = validateWriterIntent(body.intent);
        if (!state.binding.writer || state.permitted || state.writerFence || state.writerDecision || state.writerApplied
          || !['failed', 'cancelled'].includes(body.outcome) || body.intentHash !== hash({ operation: 'never_permitted_abort', input: intent })
          || intent.expectedRevision !== prior.revision || intent.expectedBindingHash !== state.bindingHash) throw error('OWNER_WRITER_FENCE_INVALID');
        state.writerFence = { ...body, proofId: event.hash };
      } else if (event.type === 'writer_decision') {
        shape(body, ['recoveryId', 'intentHash', 'scope', 'proofId', 'bindingHash', 'ownerIds', 'writer',
          'expectedWorkflowRevision', 'reason', 'operation', 'proofKind', 'outcome', 'artifact']);
        if (!state.binding.writer || state.writerDecision || state.writerApplied || body.scope !== 'writer_lease'
          || !identifier(body.recoveryId) || !digest(body.intentHash) || body.bindingHash !== state.bindingHash
          || canonical(body.writer) !== canonical(state.binding.writer) || canonical(body.ownerIds) !== canonical([event.ownerId])
          || !Number.isSafeInteger(body.expectedWorkflowRevision) || body.expectedWorkflowRevision < 0
          || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500) throw error('OWNER_WRITER_DECISION_INVALID');
        validateWriterOutcome({ outcome: body.outcome, artifact: body.artifact });
        if (body.proofKind === 'process_tree_settled') {
          if (!state.proof || state.writerFence || body.proofId !== state.proof.proofId
            || !['expired_recovery', 'live_finalization'].includes(body.operation)
            || (body.operation === 'expired_recovery' && body.outcome !== 'failed')) throw error('OWNER_WRITER_DECISION_INVALID');
        } else if (body.proofKind === 'never_permitted') {
          if (state.permitted || !state.writerFence || body.proofId !== state.writerFence.proofId
            || body.operation !== 'never_permitted_abort' || body.outcome !== state.writerFence.outcome
            || body.intentHash !== state.writerFence.intentHash || body.recoveryId !== state.writerFence.intent.recoveryId
            || body.expectedWorkflowRevision !== state.writerFence.intent.expectedWorkflowRevision
            || body.reason !== state.writerFence.intent.reason) throw error('OWNER_WRITER_DECISION_INVALID');
        } else throw error('OWNER_WRITER_DECISION_INVALID');
        state.writerDecision = { ...body, ownerId: event.ownerId, decisionId: event.hash, replay: false };
      } else if (event.type === 'writer_applied') {
        shape(body, ['decisionId', 'taskCapacityReleased']);
        if (!state.writerDecision || state.writerApplied || body.decisionId !== state.writerDecision.decisionId
          || body.taskCapacityReleased !== (state.writerDecision.proofKind === 'process_tree_settled')) throw error('OWNER_WRITER_DECISION_INVALID');
        state.writerApplied = true; state.writerHeld = false;
        if (body.taskCapacityReleased) { state.applied = true; state.held = false; }
      } else throw error('OWNER_JOURNAL_INVALID');
    }
    state.revision = event.revision; state.lastHash = event.hash; state.lastType = event.type;
    return state;
  }
  function accept(event) {
    const state = reduceEvent(event, records.get(event.ownerId));
    records.set(event.ownerId, state);
    confirmedNames.add(filename(event.ownerId, event.revision));
    applicationBlocked = [...records.values()].some(record => (record.decision && !record.applied)
      || ((record.writerDecision || record.writerFence) && !record.writerApplied));
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
    assertCapacity(prior ? 0 : maxEvents({ binding: body.binding }));
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
    if (binding.writer) {
      if ([...records.values()].some(row => row.binding.writer?.ownerEpoch === binding.writer.ownerEpoch)) throw error('OWNER_WRITER_EPOCH_BOUND');
      assertWorkspaceAvailable(binding.writer.cwd);
      if (!validateWriterBinding(clone(binding.writer), { ownerId: id, operation: 'prepare', decision: null })) throw error('OWNER_WRITER_BINDING_CHANGED');
      if (launch.profile.kind === 'linux_pid1_owner' && launch.launch.cwd !== binding.writer.cwd) throw error('OWNER_WRITER_BINDING_CHANGED');
    }
    append(id, 'prepared', { binding, bindingHash: hash(binding), receiptStoreId, hostIdentity, anchor: lock.anchor,
      launchProfile: launch.profile, profileHash: launch.profileHash, launchHash: launch.launchHash,
      sourceCwd: binding.writer?.cwd || launch.launch.cwd, ownerIds: binding.writer ? [id] : [] });
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
    assertLaunchable(state);
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
      assertLaunchable(get(id));
      if (!validateCurrentBinding(clone(state.binding))) throw error('OWNER_BINDING_CHANGED');
      const pin = validatePin(runtime.owner.snapshot().pin);
      if (probeNamespace(pin).state !== 'alive') throw error('OWNER_PIN_UNVERIFIED');
      append(id, 'pin', { pin });
      append(id, 'permit', { bindingHash: state.bindingHash });
      guard({ admission: true });
      if (!validateCurrentBinding(clone(state.binding)) || canonical(runtime.owner.snapshot().pin) !== canonical(pin)
        || probeNamespace(pin).state !== 'alive') throw error('OWNER_BINDING_CHANGED');
      assertLaunchable(get(id));
      return await runtime.owner.allowProvider();
    } catch (cause) { runtime.owner.requestStop(); throw cause; }
  }
  function stop(id) {
    // Retained live control may request termination even after journal/helper
    // qualification changes. This grants no proof, release, launch, or PID
    // adoption; all authority-changing paths still require guard().
    if (closed) throw error('OWNER_CONTROLLER_CLOSED');
    if (typeof id !== 'string' || !/^owner_[a-f0-9]{32}$/.test(id)) throw error('OWNER_CONTROL_UNAVAILABLE');
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
    let state = get(id);
    // A fenced gate may settle before its first pin event was persisted. Only
    // its original private physical owner may publish that cached trusted pin.
    if (!state.pin && state.writerFence) {
      const snapshot = runtime.owner.snapshot();
      if (snapshot.wrapperExited !== true || snapshot.stdoutEof !== true || snapshot.stderrEof !== true) throw error('OWNER_PHYSICAL_PENDING');
      append(id, 'pin', { pin: validatePin(snapshot.pin) }); state = get(id);
    }
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
    if (state.binding.writer && !state.writerApplied) throw error('OWNER_WRITER_RELEASE_REQUIRED');
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

  function isLocallyPrepared(id) {
    const state = get(id), runtime = live.get(id);
    return !!runtime && !runtime.started && !runtime.permitAttempted && !state.permitted && !state.writerFence && !state.writerDecision;
  }
  function assertLaunchable(state) {
    if (state.writerFence || state.writerDecision || state.writerApplied) throw error('OWNER_PERMIT_FORBIDDEN');
    if (state.binding.writer && !validateWriterBinding(clone(state.binding.writer), {
      ownerId: state.ownerId, operation: 'launch', decision: null,
    })) throw error('OWNER_WRITER_BINDING_CHANGED');
  }
  function assertWorkspaceAvailable(cwd) {
    guard({ admission: true });
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw error('OWNER_CWD_INVALID');
    for (const state of records.values()) {
      const held = state.binding.writer ? state.writerHeld : state.held;
      if (held && state.sourceCwd === cwd) throw error('OWNER_WORKSPACE_HELD');
    }
    return true;
  }
  function assertMutableLease(ownerEpoch) {
    guard();
    if (!identifier(ownerEpoch)) throw error('OWNER_WRITER_BINDING_INVALID');
    for (const state of records.values()) {
      if (state.binding.writer?.ownerEpoch === ownerEpoch && (state.writerFence || state.writerDecision || state.writerApplied)) {
        throw error('OWNER_WRITER_LEASE_FROZEN');
      }
    }
    return true;
  }
  function writerDecisionFor(state, id) {
    const decision = state.writerDecision;
    if (!decision || decision.decisionId !== id || !state.binding.writer
      || canonical(decision.ownerIds) !== canonical([state.ownerId])) throw error('OWNER_WRITER_DECISION_UNTRUSTED');
    if (decision.proofKind === 'process_tree_settled') requireReleaseProof(state);
    else if (decision.proofKind !== 'never_permitted' || state.permitted || !state.writerFence
      || decision.proofId !== state.writerFence.proofId) throw error('OWNER_WRITER_DECISION_UNTRUSTED');
    return decision;
  }
  function readPreparedWriter(id) {
    const state = get(id);
    if (!state.binding.writer || !isLocallyPrepared(id)) throw error('OWNER_WRITER_NOT_PREPARED');
    return { state: 'prepared', ownerId: id, bindingHash: state.bindingHash, ownerIds: [id], writer: clone(state.binding.writer) };
  }
  function readCommittedWriterRelease(id, decisionId) {
    const state = get(id), decision = writerDecisionFor(state, decisionId);
    return clone(decision);
  }
  function writerIntent(id, input, operation) {
    validateWriterIntent(input);
    const state = get(id), intentHash = hash({ operation, input });
    if (!state.binding.writer) throw error('OWNER_WRITER_UNBOUND');
    if (state.writerDecision) {
      if (state.writerDecision.intentHash !== intentHash || state.writerDecision.recoveryId !== input.recoveryId) throw error('OWNER_RECOVERY_ID_CONFLICT');
      return { state, intentHash, existing: clone(state.writerDecision) };
    }
    const fencedRetry = operation === 'never_permitted_abort' && state.writerFence;
    if (fencedRetry && (state.writerFence.intentHash !== intentHash || canonical(state.writerFence.intent) !== canonical(input))) throw error('OWNER_RECOVERY_ID_CONFLICT');
    if ((!fencedRetry && input.expectedRevision !== state.revision) || input.expectedBindingHash !== state.bindingHash
      || !validateCurrentBinding(clone(state.binding))) throw error('OWNER_BINDING_CHANGED');
    if (!validateWriterBinding(clone(state.binding.writer), { ownerId: id, operation, decision: null,
      expectedWorkflowRevision: input.expectedWorkflowRevision })) throw error('OWNER_WRITER_BINDING_CHANGED');
    return { state, intentHash, existing: null };
  }
  function appendWriterDecision(id, input, operation, proofKind, outcome) {
    const state = get(id), intentHash = hash({ operation, input });
    append(id, 'writer_decision', { recoveryId: input.recoveryId, intentHash, scope: 'writer_lease',
      proofId: proofKind === 'never_permitted' ? state.writerFence.proofId : state.proof.proofId,
      bindingHash: state.bindingHash, ownerIds: [id], writer: state.binding.writer,
      expectedWorkflowRevision: input.expectedWorkflowRevision, reason: input.reason,
      operation, proofKind, outcome: outcome.outcome, artifact: outcome.artifact });
    return clone(get(id).writerDecision);
  }
  function recoverWriter(id, input) {
    const value = writerIntent(id, input, 'expired_recovery');
    if (value.existing) return value.existing;
    if (value.state.writerFence) throw error('OWNER_RECOVERY_ID_CONFLICT');
    requireReleaseProof(value.state);
    return appendWriterDecision(id, input, 'expired_recovery', 'process_tree_settled', { outcome: 'failed', artifact: null });
  }
  function commitWriterFinalization(id, input) {
    const value = writerIntent(id, input, 'live_finalization');
    if (value.existing) return value.existing;
    if (value.state.writerFence) throw error('OWNER_RECOVERY_ID_CONFLICT');
    requireReleaseProof(value.state);
    const pending = pendingWrite?.ownerId === id && pendingWrite.type === 'writer_decision' && pendingWrite.body.intentHash === value.intentHash;
    const outcome = pending ? { outcome: pendingWrite.body.outcome, artifact: pendingWrite.body.artifact }
      : readWriterOutcome({ ownerId: id, binding: clone(value.state.binding) });
    return appendWriterDecision(id, input, 'live_finalization', 'process_tree_settled', validateWriterOutcome(outcome));
  }
  function abortWriterBeforePermit(id, input) {
    let value = writerIntent(id, input, 'never_permitted_abort');
    if (value.existing) return value.existing;
    if (value.state.permitted) throw error('OWNER_ALREADY_PERMITTED');
    if (pendingWrite && !(pendingWrite.ownerId === id && (
      pendingWrite.type === 'writer_fence' && pendingWrite.body.intentHash === value.intentHash
      || pendingWrite.type === 'writer_decision' && pendingWrite.body.intentHash === value.intentHash))) throw error('OWNER_DURABILITY_UNCONFIRMED');
    if (!value.state.writerFence) {
      const pending = pendingWrite?.type === 'writer_fence';
      const outcome = pending ? { outcome: pendingWrite.body.outcome, artifact: null }
        : validateWriterOutcome(readWriterOutcome({ ownerId: id, binding: clone(value.state.binding) }));
      if (!['failed', 'cancelled'].includes(outcome.outcome)) throw error('OWNER_OUTCOME_UNCONFIRMED');
      append(id, 'writer_fence', { intent: clone(input), intentHash: value.intentHash, outcome: outcome.outcome });
    }
    // Every subsequent start/permit path rejects this irreversible fence. The
    // wrapper may still exist, so only writer authority can be released here.
    live.get(id)?.owner.requestStop();
    value = { ...value, state: get(id) };
    return appendWriterDecision(id, input, 'never_permitted_abort', 'never_permitted', { outcome: value.state.writerFence.outcome, artifact: null });
  }
  async function applyWriterDecision(id, decisionId) {
    guard();
    if (busy.has(id)) throw error('OWNER_OPERATION_BUSY');
    const state = get(id), decision = writerDecisionFor(state, decisionId);
    if (state.writerApplied) return clone(decision);
    const validate = () => validateCurrentBinding(clone(state.binding)) && validateWriterBinding(clone(state.binding.writer), {
      ownerId: id, operation: 'apply', decision: clone(decision), expectedWorkflowRevision: decision.expectedWorkflowRevision,
    });
    if (!validate()) throw error('OWNER_WRITER_BINDING_CHANGED');
    if (!pendingWrite) assertCapacity();
    else if (pendingWrite.ownerId !== id || pendingWrite.type !== 'writer_applied') throw error('OWNER_DURABILITY_UNCONFIRMED');
    busy.add(id); applicationBlocked = true;
    try {
      if (await applyWriterRelease(clone(state.binding), clone(decision)) !== true) throw error('OWNER_WRITER_RELEASE_UNCONFIRMED');
      if (!validate()) throw error('OWNER_WRITER_BINDING_CHANGED');
      const releasesTask = decision.proofKind === 'process_tree_settled';
      if (releasesTask) {
        requireReleaseProof(state);
        if (await applyTaskRelease(clone(state.binding), clone(decision)) !== true) throw error('OWNER_RELEASE_UNCONFIRMED');
      }
      guard();
      if (!validate()) throw error('OWNER_WRITER_BINDING_CHANGED');
      writerDecisionFor(get(id), decisionId);
      append(id, 'writer_applied', { decisionId, taskCapacityReleased: releasesTask });
      return clone(get(id).writerDecision);
    } finally { busy.delete(id); }
  }
  function privateSnapshots() {
    guard();
    const rows = [...records.values()].map(state => ({ ownerId: state.ownerId, revision: state.revision,
      binding: clone(state.binding), bindingHash: state.bindingHash, sourceCwd: state.sourceCwd,
      held: state.held, writerHeld: state.writerHeld, permitted: state.permitted === true,
      permitForbidden: !!state.writerFence, physicallyConfirmed: !!state.proof,
      locallyPrepared: isLocallyPrepared(state.ownerId), taskDecisionId: state.decision?.decisionId || null,
      writerDecisionId: state.writerDecision?.decisionId || null,
      taskApplied: state.applied === true, applied: state.applied === true, writerApplied: state.writerApplied === true,
      proof: state.proof ? clone(state.proof) : null, decision: state.decision ? clone(state.decision) : null,
      writerDecision: state.writerDecision ? { decisionId: state.writerDecision.decisionId, operation: state.writerDecision.operation,
        proofKind: state.writerDecision.proofKind, outcome: state.writerDecision.outcome, expectedWorkflowRevision: state.writerDecision.expectedWorkflowRevision } : null }));
    if (rows.length > 2048 || Buffer.byteLength(canonical(rows)) > 2 * 1024 * 1024) throw error('OWNER_SNAPSHOT_LIMIT');
    return rows;
  }
  function taskReference(state) {
    return { taskId: state.binding.taskId, reservationId: state.binding.reservationId,
      ownerId: state.ownerId, bindingHash: state.bindingHash, cwd: state.sourceCwd, held: state.held,
      decisionId: state.held ? null : state.decision?.decisionId || state.writerDecision?.decisionId || null };
  }
  function listTaskReservations() {
    guard();
    return [...records.values()].filter(state => /^t_[A-Za-z0-9_]{1,120}$/.test(state.binding.taskId)
      && /^qr_[a-f0-9]{32}$/.test(state.binding.reservationId)).map(taskReference);
  }
  function readPreparedTaskOwner(id) {
    const state = get(id);
    if (!isLocallyPrepared(id)) throw error('OWNER_TASK_NOT_PREPARED');
    return { locallyPrepared: true, started: false, reference: taskReference(state) };
  }
  function readCommittedTaskRelease(id, decisionId) {
    const state = get(id);
    if (state.decision?.decisionId === decisionId) requireReleaseProof(state);
    else if (state.writerDecision?.decisionId === decisionId) {
      if (writerDecisionFor(state, decisionId).proofKind !== 'process_tree_settled') throw error('OWNER_TASK_PROOF_UNAVAILABLE');
    } else throw error('OWNER_DECISION_UNTRUSTED');
    return { version: 1, taskId: state.binding.taskId, reservationId: state.binding.reservationId,
      ownerId: id, bindingHash: state.bindingHash, decisionId, scope: 'task_capacity' };
  }
  function physicalSnapshot(id) {
    get(id);
    const runtime = live.get(id);
    if (!runtime) throw error('OWNER_CONTROL_UNAVAILABLE');
    return clone(runtime.owner.snapshot());
  }
  function completion(id) {
    get(id);
    const runtime = live.get(id);
    if (!runtime || !runtime.owner.completion) throw error('OWNER_CONTROL_UNAVAILABLE');
    return runtime.owner.completion;
  }
  function physicalDone(id) {
    get(id);
    const runtime = live.get(id);
    if (!runtime) throw error('OWNER_CONTROL_UNAVAILABLE');
    return runtime.owner.physicalDone;
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
    assertHeld: () => { guard(); return true; }, assertWorkspaceAvailable, assertMutableLease,
    isLocallyPrepared, privateSnapshots, physicalDone, physicalSnapshot, completion, listTaskReservations, readPreparedTaskOwner, readCommittedTaskRelease,
    readPreparedWriter, readCommittedWriterRelease, recoverWriter, commitWriterFinalization, abortWriterBeforePermit, applyWriterDecision,
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
  VERSION, MAX_JOURNAL_FILES, MAX_OWNER_EVENTS, MAX_WRITER_EVENTS, PUBLICATION_HEADROOM, validateBinding, validateProfile, validateWriter };
