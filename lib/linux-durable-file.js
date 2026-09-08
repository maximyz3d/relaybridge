'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 256 * 1024;
const MAX_WRITE_CALLS = 1024;
const errno = (error) => /^[A-Z0-9_]{1,64}$/.test(error?.code || '') ? error.code : 'IO_ERROR';

class DurableFileError extends Error {
  constructor(details) {
    super(`durable file operation failed at ${details.stage}`);
    this.name = 'DurableFileError';
    this.code = 'DURABLE_FILE_FAILED';
    this.details = Object.freeze({ ...details });
  }
}

function leafName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)
    || name.includes('..')) throw new TypeError('invalid durable file name');
  return name;
}

// Unwired Linux-only substrate. The caller qualifies the local filesystem,
// trusted ancestry and durable anchor, and owns the higher-level writer lock.
// This is neither compare-and-swap nor containment against the same OS user.
function openLinuxDurableDirectory({ directory, fsApi = fs, maxBytes = MAX_BYTES } = {}) {
  if (process.platform !== 'linux') throw new Error('Linux durable storage unavailable');
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')
    || path.normalize(directory) !== directory || directory.endsWith('/')
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) {
    throw new TypeError('invalid durable directory options');
  }

  function openPinned(location) {
    let directoryFd = null, stage = 'directory_open';
    try {
      directoryFd = fsApi.openSync(location, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      stage = 'directory_validate';
      const stat = fsApi.fstatSync(directoryFd);
      if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) {
        throw Object.assign(new Error('directory must be private and owned'), { code: 'UNTRUSTED_DIRECTORY' });
      }
      stage = 'directory_sync';
      fsApi.fsyncSync(directoryFd);
    } catch (error) {
      let cleanupError = null;
      if (directoryFd !== null) {
        try { fsApi.closeSync(directoryFd); } catch (closeError) { cleanupError = errno(closeError); }
      }
      throw new DurableFileError({ stage, publication: 'not_attempted', durability: 'unconfirmed',
        errno: errno(error), cleanupPending: cleanupError !== null, cleanupError });
    }

    // Resolve every leaf relative to the held directory, not a pathname that a
    // later rename could redirect. Never expose this descriptor to callers.
    const anchor = `/proc/self/fd/${directoryFd}`;
    let closed = false;
    function assertOpen() { if (closed) throw new Error('durable directory is closed'); }
    function close() {
      if (closed) return false;
      closed = true;
      // On Linux even a failed close can have released the descriptor. Retrying
      // it risks closing a reused descriptor belonging to unrelated work.
      fsApi.closeSync(directoryFd);
      return true;
    }

    function initializeChild(name) {
      assertOpen(); leafName(name);
      const target = `${anchor}/${name}`;
      // mkdir is the child's canonical publication attempt. An exception does
      // not identify whether the filesystem call had an effect; errno alone
      // is not a no-effect receipt (including for injected filesystem APIs).
      let stage = 'directory_create', publication = 'unknown', child = null, created = false;
      try {
        try { fsApi.mkdirSync(target, { mode: 0o700 }); created = true; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        publication = 'published';
        if (created) {
          stage = 'child_directory_mode';
          // A restrictive umask may prevent even opening the new directory.
          // Correct only our confirmed creation, within the caller's trusted,
          // exclusively owned ancestry. Never repair an EEXIST path.
          const stat = fsApi.lstatSync(target);
          if (!stat.isDirectory() || stat.uid !== process.getuid()) {
            throw Object.assign(new Error('new child identity unproven'), { code: 'UNTRUSTED_DIRECTORY' });
          }
          fsApi.chmodSync(target, 0o700);
        }
        stage = 'child_directory_sync';
        child = openPinned(target); // Validates and syncs the child before parent.
        stage = 'parent_directory_sync';
        fsApi.fsyncSync(directoryFd);
        return child;
      } catch (error) {
        let cleanupError = null;
        if (child) { try { child.close(); } catch (closeError) { cleanupError = errno(closeError); } }
        // Do not remove a visible directory after an unconfirmed barrier. An
        // existing child can be retried by revalidating and syncing both ends.
        throw new DurableFileError({ stage: error instanceof DurableFileError ? `child_${error.details.stage}` : stage,
          publication, durability: 'unconfirmed',
          errno: error instanceof DurableFileError ? error.details.errno : errno(error),
          cleanupPending: cleanupError !== null || error.details?.cleanupPending === true,
          cleanupError: cleanupError || error.details?.cleanupError || null });
      }
    }

    function publish(name, input, exclusive) {
      assertOpen(); leafName(name);
      if (!(typeof input === 'string' || Buffer.isBuffer(input)) || input.length > maxBytes) {
        throw new TypeError('durable file bytes exceed the allowed bound or type');
      }
      const bytes = Buffer.from(input);
      if (bytes.length > maxBytes) throw new TypeError('durable file bytes exceed the allowed bound');
      const target = `${anchor}/${name}`;
      const temp = `${anchor}/.rb-${crypto.randomBytes(16).toString('hex')}.tmp`;
      let fd = null, tempCreated = false, stage = 'target_validate';
      let publication = 'not_attempted', durability = 'unconfirmed', failure = null;
      const cleanupErrors = [];
      try {
        if (!exclusive) {
          const stat = fsApi.lstatSync(target);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600) {
            throw Object.assign(new Error('replacement target must be a private regular file'), { code: 'UNTRUSTED_TARGET' });
          }
        }
        stage = 'temp_create';
        fd = fsApi.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        tempCreated = true;
        stage = 'temp_mode';
        // umask can remove owner permissions too. Correct only this operation's
        // newly created descriptor, never an existing path or another file.
        fsApi.fchmodSync(fd, 0o600);
        const tempStat = fsApi.fstatSync(fd);
        if (!tempStat.isFile() || tempStat.uid !== process.getuid() || (tempStat.mode & 0o7777) !== 0o600) {
          throw Object.assign(new Error('temporary file identity unproven'), { code: 'UNTRUSTED_TEMP' });
        }
        stage = 'file_write';
        let offset = 0, calls = 0;
        while (offset < bytes.length) {
          if (++calls > MAX_WRITE_CALLS) throw Object.assign(new Error('write call bound exceeded'), { code: 'WRITE_LIMIT' });
          const count = fsApi.writeSync(fd, bytes, offset, bytes.length - offset, offset);
          if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) {
            throw Object.assign(new Error('write made invalid progress'), { code: 'WRITE_NO_PROGRESS' });
          }
          offset += count;
        }
        stage = 'file_sync';
        fsApi.fsyncSync(fd);
        stage = 'file_close';
        const closingFd = fd; fd = null;
        fsApi.closeSync(closingFd);
        stage = exclusive ? 'publish_exclusive' : 'publish_replace';
        publication = 'unknown';
        try {
          if (exclusive) fsApi.linkSync(temp, target);
          else fsApi.renameSync(temp, target);
        } catch (error) {
          if (exclusive && error.code === 'EEXIST') publication = 'conflict';
          throw error;
        }
        publication = 'published';
        stage = 'directory_sync';
        fsApi.fsyncSync(directoryFd);
        durability = 'confirmed';
      } catch (error) { failure = error; }
      finally {
        if (fd !== null) {
          const closingFd = fd; fd = null;
          try { fsApi.closeSync(closingFd); } catch (error) { cleanupErrors.push(errno(error)); }
        }
        // Only remove this operation's successfully created temp; never the
        // canonical target, including after an ambiguous publication failure.
        if (tempCreated) {
          try { fsApi.unlinkSync(temp); }
          catch (error) { if (error.code !== 'ENOENT') cleanupErrors.push(errno(error)); }
        }
      }
      const result = { publication, durability, cleanupPending: cleanupErrors.length > 0,
        cleanupError: cleanupErrors[0] || null };
      if (failure) throw new DurableFileError({ ...result, stage, errno: errno(failure) });
      return Object.freeze(result);
    }

    return Object.freeze({ initializeChild, close,
      createExclusive: (name, bytes) => publish(name, bytes, true),
      replaceAtomic: (name, bytes) => publish(name, bytes, false) });
  }

  return openPinned(directory);
}

module.exports = { openLinuxDurableDirectory, DurableFileError, MAX_BYTES, MAX_WRITE_CALLS };
