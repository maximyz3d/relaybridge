'use strict';

// Workspace tools for the API agent. Nothing here spawns a process or opens a
// shell. Every path is walked component by component with lstat, files are
// read only through a verified descriptor, and ancestor identity is re-checked
// after open so a swapped directory or symlink is refused. The only write is
// apply_patch, registered only for a run that carries an exact allowed write
// list and a journal (see api-agent-patch.js).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isSecretPath } = require('./github-tracker');
const { PATCH_DEFINITION, createPatchWriter } = require('./api-agent-patch');
const { digest } = require('./api-agent-wire');

const C = fs.constants;
const OPEN_FLAGS = C.O_RDONLY | (C.O_NOFOLLOW || 0) | (C.O_NONBLOCK || 0);
const READ_DEFAULT_BYTES = 64 * 1024;
const READ_MAX_BYTES = 256 * 1024;
const SEARCH_QUERY_MAX_BYTES = 256;
const SEARCH_FILE_MAX_BYTES = 4 * 1024 * 1024;
const SEARCH_MAX_MATCHES = 200;
const SEARCH_LINE_PREVIEW = 300;
const REDACTED = '[REDACTED_CREDENTIAL]';
// A credential shorter than this cannot be matched without false positives;
// the run and the dispatcher refuse it rather than run unprotected.
const MIN_CREDENTIAL_LENGTH = 8;
const SCAN_CHUNK_BYTES = READ_MAX_BYTES;

const toolError = (code, message) => Object.assign(new Error(message || code), { code, toolError: true });
const sameId = (a, b) => a.dev === b.dev && a.ino === b.ino;

const TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({ name: 'read_file', idempotent: true,
    description: 'Read a page of a UTF-8 text file inside the workspace. Paths are relative to the workspace root. '
      + 'sha256 is the hash of the whole file, whichever page is read.',
    inputSchema: Object.freeze({ type: 'object', additionalProperties: false, required: ['path', 'offset', 'length'], properties: {
      path: { type: 'string', description: 'Relative file path.' },
      offset: { type: ['integer', 'null'], description: 'Byte offset to start from; null for 0.' },
      length: { type: ['integer', 'null'], description: `Bytes to read; null for ${READ_DEFAULT_BYTES}, at most ${READ_MAX_BYTES} per page.` } } }) }),
  Object.freeze({ name: 'list_dir', idempotent: true,
    description: 'List entries of a directory inside the workspace. Hidden and secret entries are omitted.',
    inputSchema: Object.freeze({ type: 'object', additionalProperties: false, required: ['path'], properties: {
      path: { type: ['string', 'null'], description: 'Relative directory path; null or "." for the workspace root.' } } }) }),
  Object.freeze({ name: 'search', idempotent: true,
    description: 'Search workspace files for a literal (non-regex) substring. Returns matching lines.',
    inputSchema: Object.freeze({ type: 'object', additionalProperties: false, required: ['query', 'path'], properties: {
      query: { type: 'string', description: `Literal text, at most ${SEARCH_QUERY_MAX_BYTES} bytes.` },
      path: { type: ['string', 'null'], description: 'Relative directory or file to search; null for the workspace root.' } } }) }),
]);

function redactSecrets(text, secrets) {
  let out = String(text);
  for (const secret of secrets || []) {
    if (typeof secret === 'string' && secret.length >= MIN_CREDENTIAL_LENGTH) out = out.split(secret).join(REDACTED);
  }
  return out;
}

const secretPatterns = (secrets) => (Array.isArray(secrets) ? secrets : [])
  .filter((secret) => typeof secret === 'string' && secret.length >= MIN_CREDENTIAL_LENGTH)
  .map((secret) => Buffer.from(secret, 'utf8'));
const CREDENTIAL = Symbol('credential_present');
const statKey = (st) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`;

function identityOf(file) {
  const st = fs.lstatSync(file);
  return { dev: st.dev, ino: st.ino };
}

const WRITER_DEFINITIONS = Object.freeze([...TOOL_DEFINITIONS, PATCH_DEFINITION]);
const toolsetOf = (definitions) => definitions.map((d) => ({ name: d.name, idempotent: d.idempotent === true,
  journaled: d.journaled === true, inputSchema: d.inputSchema }));
// Identity of the registered tool set, bound into the checkpoint so a
// read-only checkpoint can never be resumed or linked as a writer.
const TOOLSET_HASHES = Object.freeze({ readOnly: digest(toolsetOf(TOOL_DEFINITIONS)), writer: digest(toolsetOf(WRITER_DEFINITIONS)) });
const toolsetHashFor = (writer) => writer ? TOOLSET_HASHES.writer : TOOLSET_HASHES.readOnly;

function createReadOnlyTools(options = {}) {
  return createWorkspaceTools({ ...options, writer: null });
}

// writer: null for read-only tools, or { allowedWritePaths, assertHeld,
// journal: { runId, attemptNonce, writePatch, assertLease } }.
function createWorkspaceTools({ cwd, deniedPaths = [], revalidateCwd = null, hooks = {}, writer = null } = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new TypeError('tools require an absolute workspace root');
  const root = fs.realpathSync(cwd);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory()) throw new TypeError('workspace root must be a directory');
  const rootId = { dev: rootStat.dev, ino: rootStat.ino };
  const denied = deniedPaths.filter((p) => typeof p === 'string' && p).map((p) => path.resolve(p));
  const deniedIds = [];
  for (const p of denied) { try { deniedIds.push(identityOf(p)); } catch {} }

  function checkRoot() {
    if (typeof revalidateCwd === 'function') revalidateCwd();
    let st;
    try { st = fs.lstatSync(root); } catch { st = null; }
    // Fatal to the run, never reported to the model as an ordinary tool error.
    if (!st || st.isSymbolicLink() || !st.isDirectory() || !sameId(st, rootId)) {
      throw Object.assign(new Error('Workspace root identity changed.'), { code: 'cwd_identity_changed' });
    }
  }

  function isDeniedPath(abs, st) {
    if (denied.some((d) => abs === d || abs.startsWith(d + path.sep))) return true;
    return deniedIds.some((id) => sameId(id, st));
  }

  function components(rel, { allowRoot }) {
    if (rel === null || rel === undefined) rel = '.';
    if (typeof rel !== 'string') throw toolError('invalid_path', 'Path must be a string.');
    if (rel.includes('\0')) throw toolError('invalid_path', 'Path contains NUL.');
    if (rel.includes('\\')) throw toolError('invalid_path', 'Use forward slashes.');
    if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw toolError('path_outside_workspace', 'Absolute paths are refused.');
    const parts = rel.split('/').filter((p) => p !== '' && p !== '.');
    if (parts.includes('..')) throw toolError('path_outside_workspace', 'Parent traversal is refused.');
    if (!parts.length && !allowRoot) throw toolError('invalid_path', 'A file path is required.');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith('.')) throw toolError('path_denied', 'Hidden paths are refused.');
      if (isSecretPath(parts.slice(0, i + 1).join('/')) || isSecretPath(parts[i])) throw toolError('path_denied', 'Secret paths are refused.');
    }
    return parts;
  }

  // Walk every component with lstat. Returns the chain of identities so the
  // caller can re-check them after opening.
  function walk(rel, { expect, allowRoot = true }) {
    checkRoot();
    const parts = components(rel, { allowRoot });
    const chain = [{ abs: root, id: rootId }];
    let abs = root, st = rootStat;
    for (let i = 0; i < parts.length; i++) {
      abs = path.join(abs, parts[i]);
      try { st = fs.lstatSync(abs); } catch { throw toolError('not_found', 'Path does not exist.'); }
      if (st.isSymbolicLink()) throw toolError('path_denied', 'Symbolic links are refused.');
      if (isDeniedPath(abs, st)) throw toolError('path_denied', 'Path is reserved by RelayBridge.');
      const last = i === parts.length - 1;
      if (!last && !st.isDirectory()) throw toolError('not_found', 'A path component is not a directory.');
      if (st.isFile() && st.nlink !== 1) throw toolError('path_denied', 'Hard-linked files are refused.');
      if (!st.isFile() && !st.isDirectory()) throw toolError('path_denied', 'Only regular files and directories are readable.');
      chain.push({ abs, id: { dev: st.dev, ino: st.ino } });
    }
    if (expect === 'file' && !st.isFile()) throw toolError('not_a_file', 'Path is not a regular file.');
    if (expect === 'dir' && !st.isDirectory()) throw toolError('not_a_directory', 'Path is not a directory.');
    return { abs, st, chain, rel: parts.join('/') || '.' };
  }

  function recheckChain(links) {
    for (const link of links) {
      let st;
      try { st = fs.lstatSync(link.abs); } catch { throw toolError('path_changed', 'An ancestor directory changed during the read.'); }
      if (st.isSymbolicLink() || !st.isDirectory() || !sameId(st, link.id)) throw toolError('path_changed', 'An ancestor directory changed during the read.');
    }
  }

  function withVerifiedFd(target, fn) {
    if (typeof hooks.afterValidate === 'function') hooks.afterValidate(target.abs);
    let fd;
    try { fd = fs.openSync(target.abs, OPEN_FLAGS); } catch { throw toolError('path_changed', 'File could not be opened without following links.'); }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || !sameId(st, target.st) || st.nlink !== 1) throw toolError('path_changed', 'File identity changed between check and open.');
      recheckChain(target.chain.slice(0, -1));
      return fn(fd, st);
    } finally { fs.closeSync(fd); }
  }

  // One pass over the whole file through the verified descriptor. Each chunk is
  // searched together with the previous (longest key - 1) bytes, so a key that
  // straddles a chunk or page edge is still found. Returns the bytes of
  // [start, end) from that same pass (or every byte when keep is true), so what
  // is shown is exactly what was checked. Any read error, short read, growth or
  // change of size, mtime or inode fails closed.
  function scanSnapshot(target, fd, st, patterns, { start = 0, end = st.size, keep = false } = {}) {
    const before = fs.fstatSync(fd, { bigint: true });
    const total = Number(before.size);
    if (total !== st.size) throw toolError('path_changed', 'File changed during the credential check.');
    const overlap = patterns.reduce((max, p) => Math.max(max, p.length - 1), 0);
    const kept = Buffer.alloc(keep ? total : Math.max(0, Math.min(end, total) - Math.min(start, total)));
    const hash = crypto.createHash('sha256');
    const chunk = Buffer.alloc(Math.max(1, Math.min(SCAN_CHUNK_BYTES, total || 1)));
    let carry = Buffer.alloc(0), position = 0, found = false;
    try {
      while (position < total) {
        const want = Math.min(chunk.length, total - position);
        const n = fs.readSync(fd, chunk, 0, want, position);
        if (n !== want) throw toolError('read_incomplete', 'File could not be read completely for the credential check.');
        const bytes = chunk.subarray(0, n);
        hash.update(bytes);
        if (keep) bytes.copy(kept, position);
        else {
          const from = Math.max(start, position), to = Math.min(end, position + n);
          if (from < to) bytes.copy(kept, from - start, from - position, to - position);
        }
        if (patterns.length && !found) {
          const window = carry.length ? Buffer.concat([carry, bytes]) : bytes;
          found = patterns.some((pattern) => window.indexOf(pattern) !== -1);
          carry = overlap ? Buffer.from(window.subarray(Math.max(0, window.length - overlap))) : carry;
        }
        position += n;
        if (typeof hooks.afterScanChunk === 'function') hooks.afterScanChunk(target.abs, position);
      }
      if (fs.readSync(fd, Buffer.alloc(1), 0, 1, total) !== 0) throw toolError('path_changed', 'File grew during the credential check.');
    } catch (error) {
      if (error.toolError) throw error;
      throw toolError('read_incomplete', 'File could not be read completely for the credential check.');
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (statKey(after) !== statKey(before)) throw toolError('path_changed', 'File changed during the credential check.');
    return { found, bytes: kept, sha256: hash.digest('hex') };
  }

  function readFile({ path: rel, offset = null, length = null }, { secrets = [] } = {}) {
    const start = offset ?? 0, size = length ?? READ_DEFAULT_BYTES;
    if (!Number.isSafeInteger(start) || start < 0) throw toolError('invalid_argument', 'offset must be a non-negative integer.');
    if (!Number.isSafeInteger(size) || size < 1 || size > READ_MAX_BYTES) throw toolError('invalid_argument', `length must be 1..${READ_MAX_BYTES}.`);
    const target = walk(rel, { expect: 'file', allowRoot: false });
    const patterns = secretPatterns(secrets);
    return withVerifiedFd(target, (fd, st) => {
      const snapshot = scanSnapshot(target, fd, st, patterns, { start, end: start + size });
      if (snapshot.found) throw toolError('credential_present', 'File contains a configured credential and is not shown.');
      const bytes = snapshot.bytes;
      if (bytes.includes(0)) return { path: target.rel, offset: start, totalBytes: st.size, sha256: snapshot.sha256, binary: true, content: '' };
      return { path: target.rel, offset: start, length: bytes.length, totalBytes: st.size, sha256: snapshot.sha256,
        eof: start + bytes.length >= st.size, content: bytes.toString('utf8') };
    });
  }

  function visibleEntries(target) {
    let entries;
    try { entries = fs.readdirSync(target.abs, { withFileTypes: true }); }
    catch { throw toolError('path_changed', 'Directory could not be listed.'); }
    recheckChain(target.chain);
    let st;
    try { st = fs.lstatSync(target.abs); } catch { throw toolError('path_changed', 'Directory changed during listing.'); }
    if (st.isSymbolicLink() || !sameId(st, target.st)) throw toolError('path_changed', 'Directory changed during listing.');
    const rows = [];
    let omitted = 0;
    for (const e of entries) {
      const rel = target.rel === '.' ? e.name : `${target.rel}/${e.name}`;
      const abs = path.join(target.abs, e.name);
      let est = null;
      try { est = fs.lstatSync(abs); } catch {}
      if (!est || e.name.startsWith('.') || isSecretPath(rel) || isSecretPath(e.name) || est.isSymbolicLink()
        || (!est.isFile() && !est.isDirectory()) || (est.isFile() && est.nlink !== 1) || isDeniedPath(abs, est)) { omitted++; continue; }
      rows.push({ name: e.name, rel, type: est.isDirectory() ? 'dir' : 'file', size: est.isFile() ? est.size : null });
    }
    rows.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return { rows, omitted };
  }

  function listDir({ path: rel = null }) {
    const target = walk(rel, { expect: 'dir' });
    const { rows, omitted } = visibleEntries(target);
    return { path: target.rel, entries: rows.map(({ name, type, size }) => ({ name, type, size })), omitted };
  }

  function search({ query, path: rel = null }, { secrets = [] } = {}) {
    if (typeof query !== 'string' || !query || Buffer.byteLength(query, 'utf8') > SEARCH_QUERY_MAX_BYTES) {
      throw toolError('invalid_argument', `query must be 1..${SEARCH_QUERY_MAX_BYTES} bytes of literal text.`);
    }
    const start = walk(rel, { expect: null });
    const patterns = secretPatterns(secrets);
    const matches = [];
    let filesScanned = 0, skipped = 0, truncated = false;
    const scanFile = (target) => {
      if (target.st.size > SEARCH_FILE_MAX_BYTES) { skipped++; return; }
      let text;
      try {
        // The whole buffer is checked before any line split or preview cut, so
        // neither a cut line nor a prefix query can expose part of a key.
        text = withVerifiedFd(target, (fd, st) => {
          const { found, bytes } = scanSnapshot(target, fd, st, patterns, { keep: true });
          if (found) return CREDENTIAL;
          return bytes.includes(0) ? null : bytes.toString('utf8');
        });
      } catch (error) { if (!error.toolError) throw error; skipped++; return; }
      if (text === CREDENTIAL) { skipped++; return; }
      filesScanned++;
      if (text === null || !text.includes(query)) return;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes(query)) continue;
        if (matches.length >= SEARCH_MAX_MATCHES) { truncated = true; return; }
        matches.push({ path: target.rel, line: i + 1, text: lines[i].slice(0, SEARCH_LINE_PREVIEW) });
      }
    };
    const visit = (target) => {
      if (truncated) return;
      if (target.st.isFile()) return scanFile(target);
      const { rows } = visibleEntries(target);
      for (const row of rows) {
        if (truncated) return;
        let child;
        try { child = walk(row.rel, { expect: null }); } catch (error) { if (!error.toolError) throw error; skipped++; continue; }
        visit(child);
      }
    };
    visit(start);
    return { query, path: start.rel, matches, filesScanned, skipped, truncated };
  }

  const patcher = writer ? createPatchWriter({ cwd: root, allowedWritePaths: writer.allowedWritePaths, deniedPaths,
    journal: writer.journal, assertHeld: writer.assertHeld, revalidateCwd: checkRoot, hooks: writer.hooks || hooks,
    ...(writer.fsApi ? { fsApi: writer.fsApi } : {}), ...(writer.allowedTypes ? { allowedTypes: writer.allowedTypes } : {}) }) : null;
  const definitions = patcher ? WRITER_DEFINITIONS : TOOL_DEFINITIONS;

  // call: { turn, index, callId, argsDigest } — required for apply_patch,
  // whose operation identity it is.
  function applyPatch(input, { secrets, call }) {
    if (!call || !Number.isSafeInteger(call.turn) || call.turn < 1 || !Number.isSafeInteger(call.index) || call.index < 0
      || typeof call.callId !== 'string' || !/^[a-f0-9]{64}$/.test(call.argsDigest || '') || call.argsDigest !== digest(input)) {
      throw Object.assign(new Error('apply_patch requires its exact journaled call identity.'), { code: 'patch_call_unbound' });
    }
    try { return patcher.apply(call, input, { secrets }); }
    catch (error) {
      if (error.code === 'path_not_allowed') error.message += ` Allowed: ${patcher.allowed.join(', ')}`;
      throw error;
    }
  }

  const handlers = { read_file: readFile, list_dir: listDir, search, ...(patcher ? { apply_patch: applyPatch } : {}) };

  // Returns { output, isError }; never throws for a model-supplied mistake.
  // A lost hold, a moved workspace or an uncertain patch outcome throws: those
  // stop the run instead of being reported to the model.
  function execute(name, input, { secrets = [], call = null } = {}) {
    let result;
    try {
      if (!Object.hasOwn(handlers, name)) throw toolError('unknown_tool', 'Unknown tool.');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw toolError('invalid_argument', 'Tool input must be an object.');
      const def = definitions.find((d) => d.name === name);
      if (Object.keys(input).some((k) => !Object.hasOwn(def.inputSchema.properties, k))) throw toolError('invalid_argument', 'Unknown tool argument.');
      result = { output: JSON.stringify(handlers[name](input, { secrets, call })), isError: false };
    } catch (error) {
      if (!error.toolError) throw error;
      result = { output: JSON.stringify({ error: error.code, message: error.message }), isError: true };
    }
    return { output: redactSecrets(result.output, secrets), isError: result.isError };
  }

  function close() { if (patcher) patcher.close(); }

  return Object.freeze({ root, definitions, execute, close, toolsetHash: toolsetHashFor(!!patcher),
    writer: patcher ? Object.freeze({ allowedWritePaths: patcher.allowed }) : null });
}

module.exports = { TOOL_DEFINITIONS, WRITER_DEFINITIONS, createReadOnlyTools, createWorkspaceTools, toolsetHashFor, TOOLSET_HASHES,
  redactSecrets, REDACTED, SEARCH_QUERY_MAX_BYTES, READ_MAX_BYTES, MIN_CREDENTIAL_LENGTH };
