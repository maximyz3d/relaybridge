'use strict';

const fs = require('node:fs');

function parseProcStat(text) {
  if (typeof text !== 'string' || text.length > 8192) throw new Error('invalid process identity');
  const split = text.lastIndexOf(') ');
  const prefix = text.slice(0, text.indexOf(' ('));
  if (split < 0 || !/^[1-9][0-9]*$/.test(prefix)) throw new Error('invalid process identity');
  const fields = text.slice(split + 2).trim().split(/\s+/);
  if (fields.length < 20 || !/^[A-Za-z]$/.test(fields[0])
    || !/^[0-9]{1,20}$/.test(fields[19])
    || !/^[0-9]{1,20}$/.test(fields[11]) || !/^[0-9]{1,20}$/.test(fields[12])) throw new Error('invalid process identity');
  const pid = Number(prefix);
  if (!Number.isSafeInteger(pid)) throw new Error('invalid process identity');
  return { pid, state: fields[0], starttime: fields[19], cpuTicks: BigInt(fields[11]) + BigInt(fields[12]) };
}

function bootId(fsApi = fs) {
  const id = fsApi.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('invalid boot identity');
  return id;
}

function pinLinuxNamespace(pid, { fsApi = fs } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid owner PID');
  const file = `/proc/${pid}/stat`;
  const before = parseProcStat(fsApi.readFileSync(file, 'utf8'));
  const nsIno = String(fsApi.statSync(`/proc/${pid}/ns/pid`, { bigint: true }).ino);
  const status = fsApi.readFileSync(`/proc/${pid}/status`, 'utf8');
  const nsPids = typeof status === 'string' && status.length <= 65536
    ? /^NSpid:\s*([0-9]+(?:[ \t]+[0-9]+)*)[ \t]*$/m.exec(status)?.[1].trim().split(/[ \t]+/).map(Number) : null;
  const after = parseProcStat(fsApi.readFileSync(file, 'utf8'));
  if (before.pid !== pid || after.pid !== pid || before.starttime !== after.starttime || !/^[1-9][0-9]*$/.test(nsIno)
    || !nsPids || nsPids.length < 2 || nsPids.some((value) => !Number.isSafeInteger(value) || value <= 0)
    || nsPids[0] !== pid || nsPids.at(-1) !== 1
    || nsIno === String(fsApi.statSync('/proc/self/ns/pid', { bigint: true }).ino)) throw new Error('namespace birth identity unproven');
  return { hostPid: pid, starttime: before.starttime, nsIno, namespacePid: 1, bootId: bootId(fsApi) };
}

// This probe NEVER sends a signal. A birth check followed by numeric-PID kill
// has a reuse race; death proof and termination authority are different things.
function probeLinuxNamespace(pin, { fsApi = fs } = {}) {
  if (!pin || pin.namespacePid !== 1 || !Number.isSafeInteger(pin.hostPid) || pin.hostPid <= 0 || !/^[0-9]{1,20}$/.test(pin.starttime || '')
    || !/^[1-9][0-9]*$/.test(pin.nsIno || '') || !/^[a-f0-9-]{36}$/.test(pin.bootId || '')) return { state: 'unverified' };
  try {
    if (bootId(fsApi) !== pin.bootId) return { state: 'gone', evidence: 'boot_changed' };
    let current;
    try { current = parseProcStat(fsApi.readFileSync(`/proc/${pin.hostPid}/stat`, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { state: 'gone', evidence: 'pid_absent' }; throw error; }
    if (current.pid !== pin.hostPid) return { state: 'unverified' };
    if (current.starttime !== pin.starttime) return { state: 'gone', evidence: 'birth_changed' };
    const nsIno = String(fsApi.statSync(`/proc/${pin.hostPid}/ns/pid`, { bigint: true }).ino);
    if (nsIno !== pin.nsIno) return { state: 'gone', evidence: 'namespace_changed' };
    return { state: 'alive' };
  } catch { return { state: 'unverified' }; }
}

module.exports = { parseProcStat, pinLinuxNamespace, probeLinuxNamespace };
