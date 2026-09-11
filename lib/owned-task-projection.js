'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { openLinuxDurableDirectory } = require('./linux-durable-file');
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const failure = code => Object.assign(new Error(code), { code });
function createOwnedTaskProjection(directory) {
  if (process.platform !== 'linux') throw failure('OWNED_TASK_PLATFORM_UNSUPPORTED');
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const anchor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const stat = fs.fstatSync(anchor);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) { fs.closeSync(anchor); throw failure('OWNED_TASK_PROJECTION_UNTRUSTED'); }
  const at = '/proc/self/fd/' + anchor;
  let durable;
  try { durable = openLinuxDurableDirectory({ directory, maxBytes: 4096 }); }
  catch (error) { fs.closeSync(anchor); throw error; }
  function check(row) {
    const keys = ['version', 'taskId', 'reservationId', 'ownerId', 'bindingHash', 'decisionId', 'scope'];
    if (!row || Object.keys(row).sort().join('|') !== keys.sort().join('|') || row.version !== 1
      || !/^t_[A-Za-z0-9_]{1,120}$/.test(row.taskId) || !/^qr_[a-f0-9]{32}$/.test(row.reservationId)
      || !/^owner_[a-f0-9]{32}$/.test(row.ownerId) || !/^[a-f0-9]{64}$/.test(row.bindingHash)
      || !/^[a-f0-9]{64}$/.test(row.decisionId) || row.scope !== 'task_capacity') throw failure('OWNED_TASK_PROJECTION_INVALID');
    return row;
  }
  function read(taskId) {
    if (!/^t_[A-Za-z0-9_]{1,120}$/.test(taskId)) throw failure('OWNED_TASK_PROJECTION_INVALID');
    let fd;
    try { fd = fs.openSync(at + '/' + taskId + '.json', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o7777) !== 0o600 || before.nlink !== 1 || before.size > 4096) throw failure('OWNED_TASK_PROJECTION_UNTRUSTED');
      const buffer = Buffer.alloc(before.size); let offset = 0, calls = 0;
      while (offset < buffer.length) { if (++calls > 4096) throw failure('OWNED_TASK_PROJECTION_UNTRUSTED'); const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset); if (count <= 0) throw failure('OWNED_TASK_PROJECTION_UNTRUSTED'); offset += count; }
      const bytes = buffer.toString('utf8'), row = check(JSON.parse(bytes)), after = fs.fstatSync(fd);
      if (canonical(row) + '\n' !== bytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw failure('OWNED_TASK_PROJECTION_UNTRUSTED');
      fs.fsyncSync(fd); fs.fsyncSync(anchor); return row;
    } finally { fs.closeSync(fd); }
  }
  return {
    read,
    apply(row) {
      check(row);
      const existing = read(row.taskId);
      if (existing) { if (canonical(existing) !== canonical(row)) throw failure('OWNED_TASK_DECISION_CONFLICT'); return true; }
      const written = durable.createExclusive(row.taskId + '.json', canonical(row) + '\n');
      if (written.durability !== 'confirmed' || written.cleanupPending) throw failure('OWNED_TASK_PROJECTION_UNCONFIRMED');
      return true;
    },
    close() { try { durable.close(); } finally { fs.closeSync(anchor); } },
  };
}
module.exports = { createOwnedTaskProjection, canonical };
