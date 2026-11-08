'use strict';

// In-process apply_patch for the API agent. It edits only existing regular
// files named exactly in the run's allowed write list; it never creates,
// deletes or renames a user file and never runs a process.
//
// Every edit is journaled before its first effect:
//   prepared   -> exact pre/post image and pinned target identity
//   temp_bound -> identity of the private temp this writer created
//   committed  -> the temp was renamed over the target and verified
// A failure after `prepared` is never cleaned up or retried in process: the
// run stops with patch_outcome_uncertain, the evidence stays, and only
// recovery under a retained hold may settle it. Recovery removes a temp only
// when its recorded identity proves this writer created it.
//
// This is an in-process tool contract, not an OS sandbox: the same OS user
// can still change a file between any check and the rename, and the rename is
// not an atomic compare-and-swap.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isSecretPath } = require('./github-tracker');
const { openLinuxWorkspaceDirectory } = require('./linux-durable-file');
const { digest: digestOf } = require('./api-agent-wire');

const C = fs.constants;
const READ_FLAGS = C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK;
const TEMP_FLAGS = C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW;
const PATCH_MAX_BYTES = 1024 * 1024;
const MAX_EDITS = 32;
const MIN_SECRET_LENGTH = 8;
const STATES = new Set(['prepared', 'temp_bound', 'committed']);
const SHA = /^[a-f0-9]{64}$/;
const RECORD_KEYS = ['v', 'opId', 'runId', 'turn', 'index', 'callId', 'argsDigest', 'rel', 'pinned', 'chainIds', 'preSha256',
  'postSha256', 'postBytesB64', 'tempName', 'tempIdentity', 'attemptNonce', 'state', 'at'];
const OPTIONAL_RECORD_KEYS = new Set(['recoveryNonce', 'committedAt', 'recovered']);

const WRITE_BOUNDARY = Object.freeze({ kind: 'in_process_tool_contract', osSandbox: false, atomicCompareAndSwap: false,
  scope: 'exact_allowed_existing_files', createOrDelete: false, shell: false });
const READ_ONLY_BOUNDARY = Object.freeze({ kind: 'read_only_tools', osSandbox: false, atomicCompareAndSwap: false,
  scope: 'none', createOrDelete: false, shell: false });

const PATCH_DEFINITION = Object.freeze({ name: 'apply_patch', idempotent: false, journaled: true,
  description: 'Replace exact text in one existing file that this run may edit. Read the file first and pass the sha256 that '
    + 'read_file returned as expectedSha256. Edits apply in order; each oldText must occur exactly once in the text at that point. '
    + 'Files cannot be created, deleted or renamed.',
  inputSchema: Object.freeze({ type: 'object', additionalProperties: false, required: ['path', 'expectedSha256', 'edits'], properties: {
    path: { type: 'string', description: 'Relative path, exactly as listed in the allowed write paths.' },
    expectedSha256: { type: 'string', description: 'Lowercase hex sha256 of the whole current file, from read_file.' },
    edits: { type: 'array', description: `1-${MAX_EDITS} replacements applied in order.`, items: {
      type: 'object', additionalProperties: false, required: ['oldText', 'newText'], properties: {
        oldText: { type: 'string', description: 'Exact existing text; must occur exactly once.' },
        newText: { type: 'string', description: 'Replacement text.' } } } } } }) });

const DISPLACED = new Set(['target_displaced', 'path_changed', 'cwd_identity_changed']);
const toolError = (code, message) => Object.assign(new Error(message || code), { code, toolError: true });
const fatal = (code, message, extra = {}) => Object.assign(new Error(message || code), { code, ...extra });
const uncertain = (reason, cause) => fatal('patch_outcome_uncertain', `The patch outcome is uncertain (${reason}).`,
  { reason, ...(cause?.code ? { causeCode: cause.code } : {}) });
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const idOf = (st) => ({ dev: String(st.dev), ino: String(st.ino) });
const sameId = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino;
const UID = () => BigInt(process.getuid());
// Permission bits a published file carries. Setuid and setgid targets are
// refused before any effect and never reapplied to a temp.
const PUBLISH_MODE_BITS = 0o1777;
// The journaled mode and owner of the target; a published or recovered post
// image must carry exactly these.
const metaMatches = (st, pinned) => !!st && Number(st.mode & 0o7777n) === pinned.mode && String(st.uid) === pinned.uid;

function opIdFor({ runId, turn, index, callId, argsDigest }) {
  return sha256(JSON.stringify(['rb-patch-v1', runId, turn, index, callId, argsDigest]));
}
const tempNameFor = (opId) => `.rb-patch-${opId.slice(0, 16)}.tmp`;

function validatePatchInput(input) {
  if (!plain(input) || Object.keys(input).sort().join('|') !== 'edits|expectedSha256|path') {
    throw toolError('invalid_argument', 'apply_patch takes exactly path, expectedSha256 and edits.');
  }
  if (typeof input.path !== 'string' || !input.path) throw toolError('invalid_argument', 'path must be a non-empty string.');
  if (typeof input.expectedSha256 !== 'string' || !SHA.test(input.expectedSha256)) {
    throw toolError('invalid_argument', 'expectedSha256 must be the lowercase hex sha256 from read_file.');
  }
  if (!Array.isArray(input.edits) || input.edits.length < 1 || input.edits.length > MAX_EDITS) {
    throw toolError('invalid_argument', `edits must list 1-${MAX_EDITS} replacements.`);
  }
  const edits = input.edits.map((edit, i) => {
    if (!plain(edit) || Object.keys(edit).sort().join('|') !== 'newText|oldText'
      || typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') {
      throw toolError('invalid_argument', `edits[${i}] must have exactly oldText and newText strings.`);
    }
    if (!edit.oldText) throw toolError('invalid_argument', `edits[${i}].oldText must not be empty.`);
    if (edit.oldText.includes('\0') || edit.newText.includes('\0')) throw toolError('invalid_argument', `edits[${i}] contains NUL.`);
    return { oldText: edit.oldText, newText: edit.newText };
  });
  return { path: input.path, expectedSha256: input.expectedSha256, edits };
}

function applyEdits(text, edits) {
  let out = text;
  edits.forEach((edit, i) => {
    const at = out.indexOf(edit.oldText);
    if (at === -1) throw toolError('edit_not_found', `edits[${i}].oldText does not occur in the file.`);
    if (out.indexOf(edit.oldText, at + 1) !== -1) throw toolError('edit_not_unique', `edits[${i}].oldText occurs more than once.`);
    out = out.slice(0, at) + edit.newText + out.slice(at + edit.oldText.length);
  });
  return out;
}

// A stored record is acted on only in its exact shape, with every derived
// field recomputed from the bound inputs.
function validRecord(record, { runId, allowed }) {
  if (!plain(record) || record.v !== 1 || !STATES.has(record.state)) return false;
  const keys = Object.keys(record);
  if (RECORD_KEYS.some((k) => !Object.hasOwn(record, k)) || keys.some((k) => !RECORD_KEYS.includes(k) && !OPTIONAL_RECORD_KEYS.has(k))) return false;
  if (record.runId !== runId || !Number.isSafeInteger(record.turn) || record.turn < 1 || !Number.isSafeInteger(record.index) || record.index < 0
    || typeof record.callId !== 'string' || !SHA.test(record.argsDigest) || record.opId !== opIdFor(record)
    || record.tempName !== tempNameFor(record.opId) || !allowed.includes(record.rel)
    || !SHA.test(record.preSha256) || !SHA.test(record.postSha256) || typeof record.postBytesB64 !== 'string'
    || !/^[a-f0-9]{32}$/.test(record.attemptNonce || '')
    || (record.recoveryNonce !== undefined && !/^[a-f0-9]{32}$/.test(record.recoveryNonce))) return false;
  const pinned = record.pinned;
  if (!plain(pinned) || typeof pinned.dev !== 'string' || typeof pinned.ino !== 'string' || !Number.isSafeInteger(pinned.mode)
    || pinned.mode < 0 || (pinned.mode & ~PUBLISH_MODE_BITS) !== 0 || typeof pinned.uid !== 'string') return false;
  if (!Array.isArray(record.chainIds) || !record.chainIds.length || record.chainIds.length !== record.rel.split('/').length
    || record.chainIds.some((id) => !plain(id) || typeof id.dev !== 'string' || typeof id.ino !== 'string')) return false;
  if (record.state === 'prepared' ? record.tempIdentity !== null
    : !plain(record.tempIdentity) || typeof record.tempIdentity.dev !== 'string' || typeof record.tempIdentity.ino !== 'string') return false;
  const post = Buffer.from(record.postBytesB64, 'base64');
  return post.toString('base64') === record.postBytesB64 && post.length <= PATCH_MAX_BYTES && sha256(post) === record.postSha256;
}

// journal: { runId, attemptNonce, writePatch(record), assertLease() }
// assertHeld(): throws unless this run still holds the workspace writer slot.
function createPatchWriter({ cwd, allowedWritePaths, deniedPaths = [], journal, assertHeld, revalidateCwd = null,
  hooks = {}, fsApi = fs, allowedTypes } = {}) {
  if (!Array.isArray(allowedWritePaths) || !allowedWritePaths.length || allowedWritePaths.some((p) => typeof p !== 'string' || !p)) {
    throw new TypeError('patch writer requires an exact allowed write list');
  }
  if (!journal || typeof journal.writePatch !== 'function' || typeof journal.runId !== 'string') throw new TypeError('patch writer requires a journal');
  if (typeof assertHeld !== 'function') throw new TypeError('patch writer requires a hold check');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new TypeError('patch writer requires an absolute workspace root');
  const allowed = Object.freeze([...allowedWritePaths]);
  const root = fsApi.realpathSync(cwd);
  const denied = deniedPaths.filter((p) => typeof p === 'string' && p).map((p) => path.resolve(p));
  const deniedIds = [];
  for (const p of denied) { try { deniedIds.push(idOf(fsApi.lstatSync(p, { bigint: true }))); } catch {} }
  const at = (name, info) => { if (typeof hooks.at === 'function') hooks.at(name, info); };
  let workspace = null;

  const held = () => {
    try { assertHeld(); if (typeof journal.assertLease === 'function') journal.assertLease(); }
    catch (error) { throw fatal('writer_hold_lost', 'The workspace writer hold was lost.', { causeCode: error.code || null }); }
  };
  function openRoot() {
    if (typeof revalidateCwd === 'function') revalidateCwd();
    if (!workspace) workspace = openLinuxWorkspaceDirectory({ directory: root, fsApi, ...(allowedTypes ? { allowedTypes } : {}) });
    workspace.assertNamed();
    return workspace;
  }

  function components(rel) {
    if (!allowed.includes(rel)) throw toolError('path_not_allowed', 'This path is not in the run\'s exact allowed write list.');
    const parts = rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i] || parts[i] === '.' || parts[i] === '..') throw toolError('invalid_path', 'Path is not canonical.');
      if (parts[i].startsWith('.')) throw toolError('path_denied', 'Hidden paths are refused.');
      if (isSecretPath(parts.slice(0, i + 1).join('/')) || isSecretPath(parts[i])) throw toolError('path_denied', 'Secret paths are refused.');
    }
    const abs = path.join(root, ...parts);
    if (denied.some((d) => abs === d || abs.startsWith(d + path.sep) || d.startsWith(abs + path.sep))) throw toolError('path_denied', 'Path is reserved by RelayBridge.');
    return parts;
  }

  function openParent(parts) {
    const ws = openRoot();
    try { return ws.openDirectory(parts.slice(0, -1)); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw toolError('not_found', 'A path component does not exist or is not a directory.');
      if (error.code === 'api_write_unavailable') throw toolError('api_write_unavailable', 'This path is on a filesystem that is not qualified for in-process writes.');
      throw toolError('path_changed', 'A path component changed while it was opened.');
    }
  }

  // Lstat of a name in a pinned directory; null when it does not exist.
  function lstatAt(dir, name) {
    try { return fsApi.lstatSync(`${dir.anchor}/${name}`, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  function eligible(st) {
    if (!st) return 'not_found';
    if (st.isSymbolicLink()) return 'path_denied';
    if (!st.isFile()) return 'not_a_file';
    if (st.nlink !== 1n) return 'path_denied';
    if (st.uid !== UID()) return 'path_denied';
    if (st.mode & 0o6000n) return 'path_denied';
    if (deniedIds.some((id) => sameId(id, idOf(st)))) return 'path_denied';
    if (st.size > BigInt(PATCH_MAX_BYTES)) return 'file_too_large';
    return null;
  }

  // Reads the whole leaf through one O_NOFOLLOW descriptor that must be the
  // expected inode. Returns null when the name is no longer that inode.
  function readPinned(dir, name, expectId) {
    let fd;
    try { fd = fsApi.openSync(`${dir.anchor}/${name}`, READ_FLAGS); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ELOOP') return null; throw error; }
    try {
      const st = fsApi.fstatSync(fd, { bigint: true });
      if (!st.isFile() || st.nlink !== 1n || !sameId(idOf(st), expectId) || st.size > BigInt(PATCH_MAX_BYTES)) return null;
      const size = Number(st.size);
      const bytes = Buffer.alloc(size);
      let off = 0;
      while (off < size) {
        const n = fsApi.readSync(fd, bytes, off, size - off, off);
        if (n <= 0) return null;
        off += n;
      }
      if (fsApi.readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0) return null;
      const after = fsApi.fstatSync(fd, { bigint: true });
      if (after.size !== st.size || after.mtimeNs !== st.mtimeNs || after.ctimeNs !== st.ctimeNs) return null;
      return { bytes, st };
    } finally { fsApi.closeSync(fd); }
  }

  function fsyncPinned(dir, name, expectId) {
    const fd = fsApi.openSync(`${dir.anchor}/${name}`, READ_FLAGS);
    try {
      if (!sameId(idOf(fsApi.fstatSync(fd, { bigint: true })), expectId)) throw fatal('path_changed', 'target changed');
      fsApi.fsyncSync(fd);
    } finally { fsApi.closeSync(fd); }
  }

  // The named chain from the root, the leaf identity, journaled mode and owner
  // and the post-image bytes, checked after the publication barriers and
  // immediately before `committed` is persisted. Throws path_changed or
  // cwd_identity_changed for a displaced ancestor; false for any other
  // mismatch. Detection only: the same OS user can still race this check.
  function postImageOk(dir, leaf, record) {
    dir.assertChain();
    const st = lstatAt(dir, leaf);
    if (eligible(st) || !sameId(idOf(st), record.tempIdentity) || !metaMatches(st, record.pinned)) return false;
    const now = readPinned(dir, leaf, record.tempIdentity);
    return !!now && sha256(now.bytes) === record.postSha256 && metaMatches(now.st, record.pinned);
  }

  function write(record) {
    try { journal.writePatch(record); } catch (error) { throw uncertain('journal_write_failed', error); }
    return record;
  }

  // Effects after `prepared`. Every failure is uncertain: nothing is cleaned
  // up here, and the recorded temp identity lets recovery prove ownership.
  function publish(dir, leaf, record, extra = {}) {
    let current = record, fd;
    const post = Buffer.from(record.postBytesB64, 'base64');
    try {
      fd = fsApi.openSync(`${dir.anchor}/${record.tempName}`, TEMP_FLAGS, record.pinned.mode & PUBLISH_MODE_BITS);
      at('patch-temp-created', { record: current });
      fsApi.fchmodSync(fd, record.pinned.mode & PUBLISH_MODE_BITS);
      const st = fsApi.fstatSync(fd, { bigint: true });
      if (!st.isFile() || st.nlink !== 1n || !metaMatches(st, record.pinned)) throw fatal('temp_invalid', 'temp does not carry the journaled mode and owner');
      current = write({ ...current, ...extra, state: 'temp_bound', tempIdentity: idOf(st), at: new Date().toISOString() });
      at('patch-temp-bound', { record: current });
      let off = 0;
      while (off < post.length) off += fsApi.writeSync(fd, post, off, post.length - off, off);
      fsApi.fsyncSync(fd);
      fsApi.closeSync(fd); fd = undefined;
      at('patch-temp-written', { record: current });
      held();
      dir.assertChain();
      const target = lstatAt(dir, leaf);
      if (eligible(target) || !sameId(idOf(target), current.pinned) || !metaMatches(target, current.pinned)) throw fatal('target_displaced', 'target changed before publication');
      const pre = readPinned(dir, leaf, current.pinned);
      if (!pre || sha256(pre.bytes) !== current.preSha256) throw fatal('target_displaced', 'target content changed before publication');
      at('patch-before-publish', { record: current });
      fsApi.renameSync(`${dir.anchor}/${current.tempName}`, `${dir.anchor}/${leaf}`);
      at('patch-renamed', { record: current });
      dir.fsync();
      at('patch-published', { record: current });
      if (!postImageOk(dir, leaf, current)) throw fatal('publication_unverified', 'published file differs');
    } catch (error) {
      if (fd !== undefined) try { fsApi.closeSync(fd); } catch {}
      if (error.code === 'patch_outcome_uncertain') throw error;
      throw uncertain(error.code === 'writer_hold_lost' ? 'writer_hold_lost'
        : DISPLACED.has(error.code) ? 'target_displaced' : error.code === 'publication_unverified' ? 'publication_unverified' : 'publication_failed', error);
    }
    current = write({ ...current, state: 'committed', committedAt: new Date().toISOString() });
    at('patch-committed', { record: current });
    return current;
  }


  // call: { turn, index, callId, argsDigest }. Throws toolError for an
  // effect-free refusal, writer_hold_lost before any effect, or
  // patch_outcome_uncertain once an effect may exist.
  function apply(call, input, { secrets = [] } = {}) {
    held();
    const patch = validatePatchInput(input);
    const parts = components(patch.path);
    const leaf = parts[parts.length - 1];
    const dir = openParent(parts);
    try {
      const st = lstatAt(dir, leaf);
      const refusal = eligible(st);
      if (refusal) throw toolError(refusal, refusal === 'not_found' ? 'Only existing files can be edited.' : 'This file cannot be edited.');
      const pinned = idOf(st);
      const snapshot = readPinned(dir, leaf, pinned);
      if (!snapshot) throw toolError('path_changed', 'File changed while it was read.');
      if (snapshot.bytes.includes(0)) throw toolError('not_text', 'Binary files cannot be edited.');
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes); }
      catch { throw toolError('not_text', 'File is not valid UTF-8.'); }
      const preSha256 = sha256(snapshot.bytes);
      if (preSha256 !== patch.expectedSha256) throw toolError('patch_conflict', 'The file changed since it was read; read it again.');
      const keys = (Array.isArray(secrets) ? secrets : []).filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH);
      if (keys.some((k) => text.includes(k) || patch.edits.some((e) => e.newText.includes(k) || e.oldText.includes(k)))) {
        throw toolError('credential_present', 'The file or the edit contains a configured credential.');
      }
      const post = Buffer.from(applyEdits(text, patch.edits), 'utf8');
      if (post.equals(snapshot.bytes)) throw toolError('invalid_argument', 'The edits do not change the file.');
      if (post.length > PATCH_MAX_BYTES) throw toolError('file_too_large', `The edited file would exceed ${PATCH_MAX_BYTES} bytes.`);
      held();
      try { dir.assertChain(); } catch (error) {
        if (error.code === 'cwd_identity_changed') throw error;
        throw toolError('path_changed', 'A path component changed while the edit was prepared.');
      }
      const base = { runId: journal.runId, turn: call.turn, index: call.index, callId: call.callId, argsDigest: call.argsDigest };
      const opId = opIdFor(base);
      if (lstatAt(dir, tempNameFor(opId))) throw toolError('path_changed', 'A conflicting temporary file exists.');
      const record = write({ v: 1, opId, ...base, rel: patch.path,
        pinned: { ...pinned, mode: Number(st.mode & 0o7777n), uid: String(st.uid) },
        chainIds: dir.chain.slice(0, parts.length), preSha256, postSha256: sha256(post), postBytesB64: post.toString('base64'),
        tempName: tempNameFor(opId), tempIdentity: null, attemptNonce: journal.attemptNonce, state: 'prepared', at: new Date().toISOString() });
      try { at('patch-prepared', { record }); } catch (error) { throw uncertain('interrupted', error); }
      return patchResult(publish(dir, leaf, record));
    } finally { dir.close(); }
  }

  // Settles one stored record after its writer is proven stopped. Returns
  // { state: 'committed', record } or { state: 'uncertain', reason }. Never
  // removes an artifact whose identity this writer did not record.
  function recover(record, { recoveryNonce }) {
    held();
    if (!validRecord(record, { runId: journal.runId, allowed })) return { state: 'uncertain', reason: 'record_invalid' };
    if (record.state === 'committed') return { state: 'committed', record };
    let parts;
    try { parts = components(record.rel); } catch { return { state: 'uncertain', reason: 'path_refused' }; }
    const leaf = parts[parts.length - 1];
    let dir;
    try { dir = openParent(parts); } catch (error) {
      if (error.code === 'cwd_identity_changed') throw error;
      return { state: 'uncertain', reason: error.code === 'api_write_unavailable' ? 'api_write_unavailable' : 'path_changed' };
    }
    try {
      if (dir.chain.length < parts.length || record.chainIds.some((id, i) => !sameId(id, dir.chain[i]))) return { state: 'uncertain', reason: 'path_changed' };
      const target = lstatAt(dir, leaf), temp = lstatAt(dir, record.tempName);
      const targetOk = target && !eligible(target);
      const atPre = () => {
        if (!targetOk || !sameId(idOf(target), record.pinned) || Number(target.mode & 0o7777n) !== record.pinned.mode
          || String(target.uid) !== record.pinned.uid) return false;
        const pre = readPinned(dir, leaf, record.pinned);
        return !!pre && sha256(pre.bytes) === record.preSha256;
      };
      const rollForward = () => {
        const done = publish(dir, leaf, record, { recoveryNonce, recovered: true });
        return { state: 'committed', record: done };
      };
      if (record.state === 'prepared') {
        // Created but never bound: its identity is unproven, so it is kept.
        if (temp) return { state: 'uncertain', reason: 'unproven_temp' };
        return atPre() ? rollForward() : { state: 'uncertain', reason: 'target_displaced' };
      }
      // temp_bound
      if (temp) {
        if (!temp.isFile() || temp.isSymbolicLink() || temp.nlink !== 1n || temp.uid !== UID() || !sameId(idOf(temp), record.tempIdentity)) {
          return { state: 'uncertain', reason: 'unproven_temp' };
        }
        if (!atPre()) return { state: 'uncertain', reason: 'target_displaced' };
        held();
        const again = lstatAt(dir, record.tempName);
        if (!again || !sameId(idOf(again), record.tempIdentity)) return { state: 'uncertain', reason: 'unproven_temp' };
        fsApi.unlinkSync(`${dir.anchor}/${record.tempName}`);
        dir.fsync();
        return rollForward();
      }
      if (targetOk && sameId(idOf(target), record.tempIdentity)) {
        // The rename landed: the target is the very inode this writer bound.
        // A matching hash alone is not ownership: mode, owner and the named
        // chain are revalidated before and after the barriers.
        if (!metaMatches(target, record.pinned)) return { state: 'uncertain', reason: 'target_displaced' };
        const now = readPinned(dir, leaf, record.tempIdentity);
        if (!now || sha256(now.bytes) !== record.postSha256 || !metaMatches(now.st, record.pinned)) return { state: 'uncertain', reason: 'target_displaced' };
        try { fsyncPinned(dir, leaf, record.tempIdentity); dir.fsync(); }
        catch { return { state: 'uncertain', reason: 'durability_unconfirmed' }; }
        at('patch-recovery-synced', { record });
        try { if (!postImageOk(dir, leaf, record)) return { state: 'uncertain', reason: 'target_displaced' }; }
        catch (error) {
          if (DISPLACED.has(error.code)) return { state: 'uncertain', reason: 'target_displaced' };
          throw error;
        }
        const done = write({ ...record, recoveryNonce, recovered: true, state: 'committed', committedAt: new Date().toISOString() });
        at('patch-committed', { record: done });
        return { state: 'committed', record: done };
      }
      return atPre() ? rollForward() : { state: 'uncertain', reason: 'target_displaced' };
    } catch (error) {
      if (error.code === 'writer_hold_lost' || error.code === 'cwd_identity_changed') throw error;
      return { state: 'uncertain', reason: error.reason || 'recovery_failed' };
    } finally { dir.close(); }
  }

  function close() { if (workspace) { try { workspace.close(); } catch {} workspace = null; } }

  return Object.freeze({ allowed, apply, recover, close });
}

// The tool result for a committed patch, identical whether it was produced by
// the original call or by recovery.
const patchResult = (record) => ({ path: record.rel, sha256: record.postSha256, previousSha256: record.preSha256,
  bytes: Buffer.from(record.postBytesB64, 'base64').length, applied: true });

const keyOrder = (a, b) => { const [at, ai] = a.split(':').map(Number), [bt, bi] = b.split(':').map(Number); return at - bt || ai - bi; };

// Recovery of a stopped writer run's patch effects. The provider is never
// called. Every attempt that owned the run must be proven stopped and the
// stored execution binding must match; the workspace hold must still be held.
// Committed operations whose tool record stayed in intent become done with
// the journaled result; an intent with no patch record never had an effect
// and becomes done with patch_not_applied. Anything else unproven stays
// uncertain, with its evidence and the hold kept.
function recoverPatchEffects({ store, runId, executionBindingHash, cwd, allowedWritePaths, deniedPaths = [], assertHeld,
  revalidateCwd = null, hooks = {}, fsApi = fs, allowedTypes } = {}) {
  if (!store || typeof store.acquireEffectsRecovery !== 'function') throw new TypeError('patch recovery requires a checkpoint store');
  if (typeof assertHeld !== 'function') throw new TypeError('patch recovery requires a hold check');
  assertHeld();
  const h = store.acquireEffectsRecovery(runId, { executionBindingHash });
  let writer = null, outcome = null;
  try {
    const { manifest, tools, patches } = h.load();
    const stopped = new Set(h.stoppedNonces || []);
    writer = createPatchWriter({ cwd, allowedWritePaths, deniedPaths, assertHeld, revalidateCwd, hooks, fsApi, allowedTypes,
      journal: { runId, attemptNonce: h.attemptNonce, writePatch: h.writePatch, assertLease: h.assertLease } });
    const uncertainOps = [], summaries = [];
    for (const key of [...patches.keys()].sort(keyOrder)) {
      let record = patches.get(key);
      const tool = tools.get(key);
      // Every record, committed ones included, is checked in its exact shape
      // and against the stopped attempt set before anything relies on it.
      if (!validRecord(record, { runId, allowed: writer.allowed })) { uncertainOps.push({ key, reason: 'record_invalid' }); continue; }
      if (!tool || tool.name !== 'apply_patch' || tool.callId !== record?.callId || tool.argsDigest !== record?.argsDigest) {
        uncertainOps.push({ key, reason: 'record_mismatch' }); continue;
      }
      if (!stopped.has(record.attemptNonce) || (record.recoveryNonce !== undefined && !stopped.has(record.recoveryNonce))) {
        uncertainOps.push({ key, reason: 'owner_not_proven_stopped' }); continue;
      }
      const settled = writer.recover(record, { recoveryNonce: h.attemptNonce });
      if (settled.state !== 'committed') { uncertainOps.push({ key, reason: settled.reason }); summaries.push(patchSummary(record)); continue; }
      record = settled.record;
      summaries.push(patchSummary(record));
      if (tool.state !== 'done') {
        const result = { output: JSON.stringify(patchResult(record)), isError: false };
        h.writeTool({ ...tool, state: 'done', result, resultDigest: digestOf(result.output), doneAt: new Date().toISOString(), recovered: true });
      }
    }
    for (const [key, tool] of [...tools].sort(([a], [b]) => keyOrder(a, b))) {
      if (tool.name !== 'apply_patch' || tool.state === 'done' || patches.has(key)) continue;
      const result = { output: JSON.stringify({ error: 'patch_not_applied', message: 'The edit was never prepared; the file was not changed.' }), isError: true };
      h.writeTool({ ...tool, state: 'done', result, resultDigest: digestOf(result.output), doneAt: new Date().toISOString(), recovered: true });
    }
    const at = new Date().toISOString();
    const prior = manifest.outcome?.class === 'effects_reconciled' || manifest.outcome?.class === 'patch_outcome_uncertain'
      ? manifest.outcome.priorOutcome ?? null : manifest.outcome ?? null;
    outcome = uncertainOps.length
      ? { class: 'patch_outcome_uncertain', effectsPending: uncertainOps.map((u) => u.key), reasons: uncertainOps, priorOutcome: prior, at }
      : { class: 'effects_reconciled', priorOutcome: prior, at };
    h.writeManifest({ ...manifest, status: 'terminal', outcome, updatedAt: at });
    return { settled: !uncertainOps.length, outcome, patches: summaries, uncertain: uncertainOps };
  } finally {
    if (writer) writer.close();
    h.release({ stopped: true });
  }
}

const patchSummary = (record) => ({ turn: record.turn, index: record.index, path: record.rel, state: record.state,
  preSha256: record.preSha256, postSha256: record.postSha256, recovered: record.recovered === true });

module.exports = { PATCH_DEFINITION, WRITE_BOUNDARY, READ_ONLY_BOUNDARY, PATCH_MAX_BYTES, MAX_EDITS, createPatchWriter,
  recoverPatchEffects, validatePatchInput, applyEdits, opIdFor, tempNameFor, validRecord, patchSummary, patchResult };
