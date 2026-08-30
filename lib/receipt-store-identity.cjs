'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ID_FILE_NAME = '.receipt-store-id';
const HASH_RE = /^[0-9a-f]{64}$/;
const HASH_DOMAIN = 'relaybridge-receipt-store-v1\0';

// `process.platform === 'win32'` was the wrong predicate for case folding: what
// folds case is the FILESYSTEM, not the OS. path.resolve and realpath both hand
// back whatever spelling the caller typed -- on DrvFs realpathSync.native
// ('/mnt/c/Users') returns '/mnt/c/Users' and ('/mnt/c/users') returns
// '/mnt/c/users', both resolving to the same directory -- so hashing the
// verbatim string gave ONE physical store two identities. A bridge launched from
// one spelling and an MCP server launched from the other then read the same seed
// file, computed different ids, and failed every action with
// bridge_identity_mismatch (409). Probe the store directory instead: the seed
// file is guaranteed to exist by the time the id is computed, so an upper-cased
// lookup of it resolves only where the mount folds case. The inode comparison
// keeps a genuine file that merely happens to be spelled that way (possible on a
// case-sensitive mount) from being mistaken for a fold, which would wrongly
// merge two distinct directories into one identity.
function storeFoldsCase(dataDir) {
  if (process.platform === 'win32') return true;
  try {
    const lower = fs.statSync(path.join(dataDir, ID_FILE_NAME));
    const upper = fs.statSync(path.join(dataDir, ID_FILE_NAME.toUpperCase()));
    if (!lower.ino || !upper.ino) return true;
    return lower.dev === upper.dev && lower.ino === upper.ino;
  } catch {
    // Unreadable, or the upper-cased name does not resolve: treat the store as
    // case-sensitive, which is the pre-existing behaviour.
    return false;
  }
}

function canonicalStorePath(dataDir, foldCase) {
  const resolved = path.resolve(dataDir);
  let canonical = resolved;
  try { canonical = fs.realpathSync.native(resolved); } catch {}
  const normalized = path.normalize(canonical).replace(/\\/g, '/');
  return foldCase ? normalized.toLowerCase() : normalized;
}

function readStoredSeed(filePath) {
  const value = fs.readFileSync(filePath, 'utf8').trim().toLowerCase();
  return HASH_RE.test(value) ? value : null;
}

function createStoredSeed(filePath) {
  const seed = crypto.createHash('sha256').update(crypto.randomBytes(64)).digest('hex');
  const tempPath = path.join(
    path.dirname(filePath),
    `.${ID_FILE_NAME}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let handle = null;
  try {
    // Fully materialize a same-directory file before atomically linking the
    // public marker name. A second process can therefore never observe the
    // zero-byte window between exclusive creation and the first write.
    handle = fs.openSync(tempPath, 'wx');
    fs.writeFileSync(handle, `${seed}\n`, 'utf8');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    try { fs.linkSync(tempPath, filePath); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return readStoredSeed(filePath);
  } catch (error) {
    if (handle !== null) try { fs.closeSync(handle); } catch {}
    throw error;
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

// The persisted seed is random and the externally visible identity hashes that
// seed together with the canonical store location. This keeps local filesystem
// paths out of health responses and receipts while still detecting a copied
// marker in a different directory. Aliases that resolve to the same directory
// retain the same identity.
function receiptStoreIdentity(dataDir) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const filePath = path.join(dataDir, ID_FILE_NAME);
    let seed = null;
    try { seed = readStoredSeed(filePath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!seed) seed = createStoredSeed(filePath);
    if (!seed || !HASH_RE.test(seed)) {
      return { id: null, ready: false, errorCode: 'invalid_identity_seed' };
    }
    const id = crypto.createHash('sha256')
      .update(HASH_DOMAIN)
      .update(seed)
      .update('\0')
      .update(canonicalStorePath(dataDir, storeFoldsCase(dataDir)))
      .digest('hex');
    return { id, ready: true, errorCode: null };
  } catch {
    // Do not expose filesystem paths or host error messages through health or
    // preflight responses. A missing identity disables actions fail-closed.
    return { id: null, ready: false, errorCode: 'identity_unavailable' };
  }
}

module.exports = { ID_FILE_NAME, receiptStoreIdentity };
