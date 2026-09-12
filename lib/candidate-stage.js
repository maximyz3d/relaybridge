'use strict';
// Candidate-only staging. No promotion, legacy adoption, provider invocation,
// filesystem sandbox, or automatic execution authority.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openLinuxDurableDirectory } = require('./linux-durable-file');
const canonical = x => x === null || typeof x !== 'object' ? JSON.stringify(x)
  : Array.isArray(x) ? '[' + x.map(canonical).join(',') + ']'
  : '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}';
const hash = x => crypto.createHash('sha256').update(typeof x === 'string' || Buffer.isBuffer(x) ? x : canonical(x)).digest('hex');
const clone = x => JSON.parse(canonical(x));
const fail = code => { throw Object.assign(new Error(code), { code }); };
const LIMITS = Object.freeze({ maxEntries: 2048, maxBytes: 128 * 1024 * 1024, maxFileBytes: 16 * 1024 * 1024,
  maxManifestBytes: 256 * 1024, maxDepth: 32, maxElapsedMs: 15000, maxReadCalls: 16384 });
const CONTROL = new Set(['.git', '.bridge-token', '.state.json', '.mcp-start.lock', '.relaybridge', '.claude', '.codex', '.cursor', '.grok', '.agy']);
function closed(x, keys) { if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).sort().join('|') !== [...keys].sort().join('|')) fail('STAGE_SCHEMA_INVALID'); }
function relativeFile(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024 || value.normalize('NFC') !== value
    || /[\\\x00-\x1f\x7f:*?\[\]{}]/.test(value) || path.posix.isAbsolute(value)) fail('STAGE_PATH_INVALID');
  const parts = value.split('/');
  for (const part of parts) if (!part || part === '.' || part === '..' || part.trim() !== part || part.endsWith('.')
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || CONTROL.has(part.toLowerCase())) fail('STAGE_PATH_INVALID');
  return value;
}
function normalizeAllowedWritePaths(input) {
  if (!Array.isArray(input) || input.length > 128) fail('STAGE_ALLOWLIST_INVALID');
  const seen = new Set(), paths = input.map(relativeFile).sort();
  for (const item of paths) { const key = item.toLowerCase(); if (seen.has(key)) fail('STAGE_PATH_ALIAS'); seen.add(key); }
  for (const item of paths) for (const other of paths) if (other.toLowerCase().startsWith(item.toLowerCase() + '/')) fail('STAGE_FILE_DIRECTORY_ALIAS');
  return Object.freeze(paths);
}
function limitsFor(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !(k in LIMITS))) fail('STAGE_LIMIT_INVALID');
  const result = { ...LIMITS, ...input };
  for (const [key, value] of Object.entries(result)) if (!Number.isSafeInteger(value) || value < 1 || value > LIMITS[key]) fail('STAGE_LIMIT_INVALID');
  return result;
}
function fingerprint(s) { return ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(k => String(s[k])).join(':'); }
function identity(s) { return { dev: String(s.dev), ino: String(s.ino) }; }
function sameInode(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function pinDirectory(directory, io, { privateMode = false } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory === '/' || path.normalize(directory) !== directory
    || directory.endsWith('/') || directory.includes('\0') || io.realpathSync(directory) !== directory) fail('STAGE_ROOT_ALIAS');
  const fd = io.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let owned = true;
  try {
    const stat = io.fstatSync(fd, { bigint: true });
    if (!stat.isDirectory() || stat.uid !== BigInt(process.getuid()) || (privateMode && (stat.mode & 0o7777n) !== 0o700n)) fail('STAGE_ROOT_UNTRUSTED');
    const at = '/proc/self/fd/' + fd;
    function assertNamed() { const current = owned ? io.fstatSync(fd, { bigint: true }) : null; if (!owned || !sameInode(current, stat) || current.uid !== stat.uid
      || (privateMode && (current.mode & 0o7777n) !== 0o700n) || !sameInode(io.lstatSync(directory, { bigint: true }), stat) || io.realpathSync(directory) !== directory) fail('STAGE_ROOT_CHANGED'); }
    return { fd, at, path: directory, identity: identity(stat), assertNamed,
      close() { if (owned) { owned = false; io.closeSync(fd); } } };
  } catch (e) { if (owned) { owned = false; try { io.closeSync(fd); } catch {} } throw e; }
}
function under(root, candidate) { return candidate === root || candidate.startsWith(root + path.sep); }

// Every source and copy destination traversal uses a held directory descriptor.
// A second metadata traversal checks ALL observations after the content reads.
// This detects observed drift, not an atomic snapshot across concurrent writers.
function scan(root, { io = fs, limits = LIMITS, copyRoot = null, skipRootGit = false } = {}) {
  const start = process.hrtime.bigint(), rows = [], observations = new Map(), directories = new Map();
  const aliases = new Set(), inodes = new Set([root.identity.dev + ':' + root.identity.ino]);
  let bytes = 0, calls = 0, entries = 0, excludedGit = false;
  function bound() { if (++calls > limits.maxReadCalls || Number(process.hrtime.bigint() - start) / 1e6 > limits.maxElapsedMs) fail('STAGE_SCAN_LIMIT'); }
  function names(at) {
    const handle = io.opendirSync(at), list = [];
    try { for (;;) { bound(); const entry = handle.readSync(); if (!entry) break; if (list.length >= limits.maxEntries) fail('STAGE_SCAN_LIMIT'); list.push(entry.name); } }
    finally { handle.closeSync(); }
    return list.sort();
  }
  function destinationChild(parentFd, name) {
    const named = '/proc/self/fd/' + parentFd + '/' + name;
    io.mkdirSync(named, { mode: 0o700 });
    const listed = io.lstatSync(named, { bigint: true });
    if (!listed.isDirectory() || listed.uid !== BigInt(process.getuid())) fail('STAGE_COPY_TARGET_CHANGED');
    const fd = io.openSync(named, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      if (fingerprint(io.fstatSync(fd, { bigint: true })) !== fingerprint(listed)) fail('STAGE_COPY_TARGET_CHANGED');
      return { fd, assertNamed() {
        const current = io.fstatSync(fd, { bigint: true }), namedStat = io.lstatSync(named, { bigint: true });
        if (!current.isDirectory() || !namedStat.isDirectory() || !sameInode(current, listed)
          || !sameInode(namedStat, listed)) fail('STAGE_COPY_TARGET_CHANGED');
      } };
    } catch (error) { io.closeSync(fd); throw error; }
  }
  function walk(fd, relative, depth, destinationFd) {
    bound(); if (depth > limits.maxDepth) fail('STAGE_SCAN_LIMIT');
    const at = '/proc/self/fd/' + fd, before = io.fstatSync(fd, { bigint: true }), census = names(at);
    directories.set(relative, { identity: fingerprint(before), census });
    observations.set(relative, fingerprint(before));
    for (const name of census) {
      bound(); const rel = relative ? relative + '/' + name : name;
      const listed = io.lstatSync(at + '/' + name, { bigint: true });
      if (!relative && name === '.git' && skipRootGit) {
        if (!(listed.isFile() || listed.isDirectory()) || (listed.isFile() && listed.nlink !== 1n)) fail('STAGE_GIT_METADATA_UNTRUSTED');
        excludedGit = true; continue;
      }
      relativeFile(rel);
      if (++entries > limits.maxEntries) fail('STAGE_SCAN_LIMIT');
      const inodeKey = String(listed.dev) + ':' + String(listed.ino); if (inodes.has(inodeKey)) fail('STAGE_INODE_ALIAS'); inodes.add(inodeKey);
      const alias = rel.toLowerCase(); if (aliases.has(alias)) fail('STAGE_PATH_ALIAS'); aliases.add(alias);
      if ((listed.mode & 0o7000n) !== 0n) fail('STAGE_UNSUPPORTED_MODE');
      let opened = null;
      try {
        if (listed.isDirectory()) {
          opened = io.openSync(at + '/' + name, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
          if (fingerprint(io.fstatSync(opened, { bigint: true })) !== fingerprint(listed)) fail('STAGE_CHANGED_DURING_SCAN');
          rows.push({ path: rel, kind: 'directory', mode: Number(listed.mode & 0o777n) });
          const destination = destinationFd === null ? null : destinationChild(destinationFd, name);
          try {
            walk(opened, rel, depth + 1, destination?.fd ?? null);
            if (destination) {
              destination.assertNamed();
              io.fchmodSync(destination.fd, Number(listed.mode & 0o777n));
              io.fsyncSync(destination.fd);
              destination.assertNamed();
            }
          } finally { if (destination) io.closeSync(destination.fd); }
        } else if (listed.isFile()) {
          if (listed.nlink !== 1n || listed.size > BigInt(limits.maxFileBytes)) fail(listed.nlink !== 1n ? 'STAGE_LINK_UNSUPPORTED' : 'STAGE_SCAN_LIMIT');
          bytes += Number(listed.size); if (bytes > limits.maxBytes) fail('STAGE_SCAN_LIMIT');
          opened = io.openSync(at + '/' + name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
          if (fingerprint(io.fstatSync(opened, { bigint: true })) !== fingerprint(listed)) fail('STAGE_CHANGED_DURING_SCAN');
          const digest = crypto.createHash('sha256'), buffer = Buffer.alloc(65536); let offset = 0, out = null;
          try {
            if (destinationFd !== null) out = io.openSync('/proc/self/fd/' + destinationFd + '/' + name,
              fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
            while (offset < Number(listed.size)) {
              bound(); const read = io.readSync(opened, buffer, 0, Math.min(buffer.length, Number(listed.size) - offset), offset);
              if (!Number.isSafeInteger(read) || read <= 0) fail('STAGE_READ_INCOMPLETE');
              digest.update(buffer.subarray(0, read));
              if (out !== null) { let written = 0; while (written < read) { bound(); const n = io.writeSync(out, buffer, written, read - written, offset + written); if (!Number.isSafeInteger(n) || n <= 0 || n > read - written) fail('STAGE_WRITE_INCOMPLETE'); written += n; } }
              offset += read;
            }
            if (out !== null) { io.fchmodSync(out, Number(listed.mode & 0o777n)); io.fsyncSync(out); const closing = out; out = null; io.closeSync(closing); }
          } finally { if (out !== null) io.closeSync(out); }
          rows.push({ path: rel, kind: 'file', mode: Number(listed.mode & 0o777n), size: Number(listed.size), sha256: digest.digest('hex') });
        } else fail(listed.isSymbolicLink() ? 'STAGE_LINK_UNSUPPORTED' : 'STAGE_SPECIAL_UNSUPPORTED');
        if (fingerprint(io.fstatSync(opened, { bigint: true })) !== fingerprint(listed)
          || fingerprint(io.lstatSync(at + '/' + name, { bigint: true })) !== fingerprint(listed)) fail('STAGE_CHANGED_DURING_SCAN');
        observations.set(rel, fingerprint(listed));
      } finally { if (opened !== null) io.closeSync(opened); }
    }
    if (canonical(census) !== canonical(names(at)) || fingerprint(io.fstatSync(fd, { bigint: true })) !== fingerprint(before)) fail('STAGE_CHANGED_DURING_SCAN');
  }
  function verifyObservations(fd, relative, depth) {
    bound(); if (depth > limits.maxDepth) fail('STAGE_SCAN_LIMIT');
    const at = '/proc/self/fd/' + fd, expected = directories.get(relative);
    if (!expected || fingerprint(io.fstatSync(fd, { bigint: true })) !== expected.identity
      || canonical(names(at)) !== canonical(expected.census)) fail('STAGE_CHANGED_DURING_SCAN');
    for (const name of expected.census) {
      bound(); if (!relative && name === '.git' && skipRootGit) continue;
      const rel = relative ? relative + '/' + name : name;
      const listed = io.lstatSync(at + '/' + name, { bigint: true });
      if (fingerprint(listed) !== observations.get(rel)) fail('STAGE_CHANGED_DURING_SCAN');
      if (listed.isDirectory()) {
        const child = io.openSync(at + '/' + name, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        try { verifyObservations(child, rel, depth + 1); }
        finally { io.closeSync(child); }
      }
      if (fingerprint(io.lstatSync(at + '/' + name, { bigint: true })) !== observations.get(rel)) fail('STAGE_CHANGED_DURING_SCAN');
    }
    if (fingerprint(io.fstatSync(fd, { bigint: true })) !== expected.identity
      || canonical(names(at)) !== canonical(expected.census)) fail('STAGE_CHANGED_DURING_SCAN');
  }
  root.assertNamed();
  const rootStat = io.fstatSync(root.fd, { bigint: true });
  walk(root.fd, '', 0, copyRoot?.fd ?? null);
  if (directories.get('').identity !== fingerprint(rootStat)) fail('STAGE_CHANGED_DURING_SCAN');
  verifyObservations(root.fd, '', 0);
  root.assertNamed();
  if (copyRoot) { io.fsyncSync(copyRoot.fd); copyRoot.assertNamed(); }
  rows.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const observed = [...observations].sort(([a], [b]) => a.localeCompare(b, 'en'));
  const value = { version: 1, complete: true, atomicSnapshot: false, evidenceScope: 'bounded_filesystem_observation',
    root: { mode: Number(rootStat.mode & 0o7777n), uid: String(rootStat.uid), gid: String(rootStat.gid) },
    entries: rows, bytes, excludedGit };
  if (Buffer.byteLength(canonical(value)) > limits.maxManifestBytes) fail('STAGE_MANIFEST_LIMIT');
  return { ...value, hash: hash(value), observationHash: hash(observed) };
}
function compare(before, after, allowed) {
  const first = new Map(before.entries.map(x => [x.path, x])), second = new Map(after.entries.map(x => [x.path, x]));
  const changed = [...new Set([...first.keys(), ...second.keys()])].sort().filter(p => canonical(first.get(p) || null) !== canonical(second.get(p) || null));
  const permittedCreates = new Set(changed.filter(p => !first.has(p) && second.get(p)?.kind === 'file' && allowed.includes(p)));
  return changed.map(p => {
    const a = first.get(p), b = second.get(p), operation = !a ? 'created' : !b ? 'deleted' : 'modified';
    const fileChange = (!a || a.kind === 'file') && (!b || b.kind === 'file');
    const structuralParent = !a && b?.kind === 'directory' && [...permittedCreates].some(child => child.startsWith(p + '/'));
    return { path: p, operation, kind: b?.kind || a.kind, allowed: (fileChange && allowed.includes(p)) || structuralParent,
      before: a || null, after: b || null };
  });
}

// An exclusive publication can be visible even though its barrier failed.
// Accept only the exact canonical bytes computed by this handle, after fresh
// anchored reads and successful file/directory barriers. No authority is
// reconstructed from arbitrary files or supplied provider data.
function confirmEvidence(directory, name, expected, { io, limits, guard }) {
  if (!['owner.json', 'baseline.json', 'result.json'].includes(name)) fail('STAGE_EVIDENCE_NAME_INVALID');
  const named = directory.at + '/' + name;
  let fd = null;
  const trustedFile = stat => stat.isFile() && stat.uid === BigInt(process.getuid())
    && (stat.mode & 0o7777n) === 0o600n && stat.nlink >= 1n
    && stat.size >= 1n && stat.size <= BigInt(limits.maxManifestBytes);
  try {
    guard();
    fd = io.openSync(named, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = io.fstatSync(fd, { bigint: true });
    if (!trustedFile(before)) fail('STAGE_EVIDENCE_UNTRUSTED');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0, calls = 0;
    while (offset < bytes.length) {
      if (++calls > limits.maxReadCalls) fail('STAGE_SCAN_LIMIT');
      const count = io.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) fail('STAGE_EVIDENCE_INCOMPLETE');
      offset += count;
    }
    if (!bytes.equals(expected)) fail('STAGE_EVIDENCE_CONFLICT');
    if (fingerprint(io.fstatSync(fd, { bigint: true })) !== fingerprint(before)
      || fingerprint(io.lstatSync(named, { bigint: true })) !== fingerprint(before)) fail('STAGE_EVIDENCE_CHANGED');

    // The durability substrate publishes with link(temp, target). An interrupted
    // cleanup can leave its exact private temp alias. Remove only proven aliases
    // of this exact target; any unexplained hardlink remains untrusted.
    if (before.nlink > 1n) {
      const handle = io.opendirSync(directory.at), aliases = [];
      try {
        for (;;) {
          if (++calls > limits.maxReadCalls) fail('STAGE_SCAN_LIMIT');
          const entry = handle.readSync(); if (!entry) break;
          if (calls > limits.maxEntries) fail('STAGE_SCAN_LIMIT');
          if (!/^\.rb-[a-f0-9]{32}\.tmp$/.test(entry.name)) continue;
          const alias = directory.at + '/' + entry.name, stat = io.lstatSync(alias, { bigint: true });
          if (sameInode(stat, before)) {
            if (!trustedFile(stat)) fail('STAGE_EVIDENCE_UNTRUSTED');
            aliases.push(alias);
          }
        }
      } finally { handle.closeSync(); }
      if (BigInt(aliases.length) + 1n !== before.nlink) fail('STAGE_EVIDENCE_UNTRUSTED');
      for (const alias of aliases) {
        if (!sameInode(io.lstatSync(alias, { bigint: true }), before)) fail('STAGE_EVIDENCE_CHANGED');
        io.unlinkSync(alias);
      }
      io.fsyncSync(directory.fd);
    }
    const confirmed = io.fstatSync(fd, { bigint: true });
    if (!trustedFile(confirmed) || confirmed.nlink !== 1n || !sameInode(confirmed, before)
      || confirmed.size !== before.size || confirmed.mtimeNs !== before.mtimeNs
      || fingerprint(io.lstatSync(named, { bigint: true })) !== fingerprint(confirmed)) fail('STAGE_EVIDENCE_CHANGED');
    io.fsyncSync(fd);
    io.fsyncSync(directory.fd);
    const closing = fd; fd = null; io.closeSync(closing);
    guard();
  } catch (error) {
    if (fd !== null) { const closing = fd; fd = null; try { io.closeSync(closing); } catch {} }
    if (error.code?.startsWith('STAGE_')) throw error;
    fail('STAGE_DURABILITY_UNCONFIRMED');
  }
}

function createCandidateStage({ sourceRoot, stagingParent, allowedWritePaths, binding,
  validateBinding = () => false, readRunAuthority = () => null, limits: inputLimits = {}, fsApi: io = fs } = {}) {
  if (process.platform !== 'linux') fail('STAGE_PLATFORM_UNSUPPORTED');
  const allowed = normalizeAllowedWritePaths(allowedWritePaths), limits = limitsFor(inputLimits);
  closed(binding, ['runId', 'attemptId', 'cwdIdentityHash', 'policyId']);
  if (typeof binding.runId !== 'string' || !/^run_[A-Za-z0-9_.-]{1,120}$/.test(binding.runId)
    || typeof binding.attemptId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,199}$/.test(binding.attemptId)
    || typeof binding.cwdIdentityHash !== 'string' || !/^[a-f0-9]{64}$/.test(binding.cwdIdentityHash)
    || typeof binding.policyId !== 'string' || !/^[a-f0-9]{64}$/.test(binding.policyId)) fail('STAGE_BINDING_INVALID');
  const exactBinding = clone(binding), bindingHash = hash(binding), policyHash = hash({ version: 1, allowedWritePaths: allowed });
  if (!validateBinding(clone(exactBinding))) fail('STAGE_BINDING_CHANGED');
  let source = null, parent = null, container = null, stage = null, evidence = null, durable = null;
  let baseline = null, result = null, closedHandle = false;
  const artifactId = 'candidate_' + crypto.randomBytes(16).toString('hex');
  try {
    source = pinDirectory(sourceRoot, io); parent = pinDirectory(stagingParent, io, { privateMode: true });
    if (under(sourceRoot, stagingParent) || under(stagingParent, sourceRoot)) fail('STAGE_ROOT_OVERLAP');
    const directory = io.mkdtempSync(parent.at + '/stage-'); io.chmodSync(directory, 0o700);
    const absolute = io.realpathSync(directory);
    container = pinDirectory(absolute, io, { privateMode: true });
    io.mkdirSync(directory + '/workspace', { mode: 0o700 }); io.mkdirSync(directory + '/evidence', { mode: 0o700 });
    io.fsyncSync(container.fd); io.fsyncSync(parent.fd);
    stage = pinDirectory(absolute + '/workspace', io, { privateMode: true });
    evidence = pinDirectory(absolute + '/evidence', io, { privateMode: true });
    // The substrate opens its own descriptor. Require that descriptor to refer
    // to our pinned evidence directory, even if its named path races at open.
    const evidenceIo = Object.create(io);
    evidenceIo.openSync = (file, flags, ...args) => {
      const fd = io.openSync(file, flags, ...args);
      if (flags & fs.constants.O_DIRECTORY) {
        const stat = io.fstatSync(fd, { bigint: true });
        if (String(stat.dev) !== evidence.identity.dev || String(stat.ino) !== evidence.identity.ino) {
          io.closeSync(fd); fail('STAGE_ROOT_CHANGED');
        }
      }
      return fd;
    };
    durable = openLinuxDurableDirectory({ directory: evidence.path, fsApi: evidenceIo, maxBytes: limits.maxManifestBytes });
    const guardEvidence = () => { parent.assertNamed(); container.assertNamed(); source.assertNamed(); stage.assertNamed(); evidence.assertNamed(); };
    function persist(name, value) {
      guardEvidence(); const bytes = canonical(value) + '\n'; if (Buffer.byteLength(bytes) > limits.maxManifestBytes) fail('STAGE_MANIFEST_LIMIT');
      try {
        const written = durable.createExclusive(name, bytes);
        if (written.durability !== 'confirmed' || written.cleanupPending) fail('STAGE_DURABILITY_UNCONFIRMED');
      } catch (error) {
        if (error.details?.publication !== 'conflict') throw error;
        confirmEvidence(evidence, name, Buffer.from(bytes), { io, limits, guard: guardEvidence });
      }
      guardEvidence();
    }
    persist('owner.json', { version: 1, artifactId, binding: exactBinding, bindingHash, policyHash,
      sourceIdentity: source.identity, stageIdentity: stage.identity, applied: false });
    baseline = scan(source, { io, limits, copyRoot: stage, skipRootGit: true });
    const sourceCheck = scan(source, { io, limits, skipRootGit: true }), copied = scan(stage, { io, limits });
    if (sourceCheck.hash !== baseline.hash || sourceCheck.observationHash !== baseline.observationHash) fail('STAGE_SOURCE_CHANGED');
    if (canonical(copied.entries) !== canonical(baseline.entries)) fail('STAGE_COPY_MISMATCH');
    for (const allowedPath of allowed) if (baseline.entries.some(x => x.path === allowedPath && x.kind !== 'file')) fail('STAGE_ALLOWED_TARGET_NOT_FILE');
    if (!validateBinding(clone(exactBinding))) fail('STAGE_BINDING_CHANGED');
    persist('baseline.json', { ...baseline, bindingHash, policyHash });
    function authority() {
      if (closedHandle) fail('STAGE_CLOSED'); guardEvidence();
      if (!validateBinding(clone(exactBinding))) fail('STAGE_BINDING_CHANGED');
      return readRunAuthority(clone(exactBinding));
    }
    function summarize(row) { return { artifactId, version: 1, state: row.state, applied: false,
      evidenceScope: 'final_filesystem_delta', atomicSnapshot: false, policyHash, baselineHash: baseline.hash,
      outputHash: row.outputHash || null, complete: row.complete, reason: row.reason || null,
      changedCount: row.changes?.length || 0, forbiddenCount: row.changes?.filter(x => !x.allowed).length || 0 }; }
    function finalize(...callerArguments) {
      if (callerArguments.length) fail('STAGE_CALLER_PROOF_FORBIDDEN');
      const run = authority();
      if (result) return summarize(result);
      if (!run || run.physicalSettled !== true) return { artifactId, state: 'awaiting_physical_settlement', applied: false, complete: false };
      let next;
      try {
        closed(run, ['physicalSettled', 'outcome']);
        if (!['completed', 'failed', 'cancelled', 'timed_out', 'unknown'].includes(run.outcome)) fail('STAGE_AUTHORITY_INVALID');
        const output = scan(stage, { io, limits }), currentSource = scan(source, { io, limits, skipRootGit: true });
        const changes = compare(baseline, output, allowed), drift = currentSource.hash !== baseline.hash || currentSource.observationHash !== baseline.observationHash;
        const reason = run.outcome !== 'completed' ? 'STAGE_RUN_NOT_COMPLETED' : drift ? 'STAGE_SOURCE_CHANGED' : changes.some(x => !x.allowed) ? 'STAGE_WRITESET_VIOLATION' : null;
        next = { version: 1, state: reason ? 'quarantined' : 'candidate_ready', applied: false, complete: true,
          reason, outputHash: output.hash, output, changes, sourceUnchanged: !drift, bindingHash, policyHash };
      } catch (e) { next = { version: 1, state: 'quarantined', applied: false, complete: false,
        reason: /^[A-Z][A-Z0-9_]{1,63}$/.test(e.code || '') ? e.code : 'STAGE_SCAN_UNCONFIRMED', bindingHash, policyHash }; }
      // Publication must succeed before returning candidate-ready. A failed
      // barrier never turns readable candidate bytes into approved authority.
      persist('result.json', next); result = next; return summarize(result);
    }
    return Object.freeze({ finalize,
      inspectPrivate() { authority(); return clone({ artifactId, workspace: stage.path, evidence: evidence.path,
        bindingHash, policyHash, baseline, result, applied: false }); },
      close() {
        if (closedHandle) return;
        closedHandle = true;
        let failure = null;
        for (const h of [durable, evidence, stage, container, source, parent]) {
          try { h.close(); } catch (error) { failure ||= error; }
        }
        if (failure) throw failure;
      },
    });
  } catch (e) {
    for (const h of [durable, evidence, stage, container, source, parent]) if (h) try { h.close(); } catch {}
    // Retain partial stage only; never clean by an untrusted/replaced pathname.
    throw Object.assign(new Error(/^[A-Z][A-Z0-9_]{1,63}$/.test(e.code || '') ? e.code : 'STAGE_PREFLIGHT_UNCONFIRMED'),
      { code: /^[A-Z][A-Z0-9_]{1,63}$/.test(e.code || '') ? e.code : 'STAGE_PREFLIGHT_UNCONFIRMED', artifactId, applied: false });
  }
}
module.exports = { createCandidateStage, normalizeAllowedWritePaths, scan, pinDirectory, compare, hash, LIMITS };
