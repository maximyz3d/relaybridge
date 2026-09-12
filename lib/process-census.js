'use strict';
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { validationError } = require('./validation-contract');
const exec = promisify(execFile);
// Process-local key permits correlation within this controller without making
// low-entropy command arguments recoverable from a public dictionary hash.
const observationKey = crypto.randomBytes(32);
const hash = value => crypto.createHmac('sha256', observationKey).update(String(value)).digest('hex');
const MAX_ROWS = 4096, MAX_RETAINED = 96;
let clockTicks;

function validateChildProcessPolicy(value) {
  if (value === undefined || value === null) return null;
  const invalid = () => { throw validationError('invalid_child_process_policy', 'childProcessPolicy',
    'Use maxChildren (1..256), maxConcurrentTests (0..256), and action warn or stop. Limits are sampled observations, not command prevention.'); };
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['maxChildren', 'maxConcurrentTests', 'action'].includes(key))) invalid();
  for (const key of ['maxChildren', 'maxConcurrentTests']) if (value[key] !== undefined
    && (!Number.isInteger(value[key]) || value[key] < (key === 'maxChildren' ? 1 : 0) || value[key] > 256)) invalid();
  if (value.action !== undefined && !['warn', 'stop'].includes(value.action)) invalid();
  if (value.maxChildren === undefined && value.maxConcurrentTests === undefined) invalid();
  return { ...value, action: value.action || 'warn' };
}
function commandClass(command) {
  const text = String(command).replace(/\0/g, ' ');
  // Inspect executable position, not words inside a shell command or prompt.
  if (/^(?:"[^"\n]*[\\/])?(?:[^\s"\n]*[\\/])?pytest(?:\.exe)?(?:"|\s|$)/i.test(text)
    || /^(?:"[^"\n]*[\\/])?(?:[^\s"\n]*[\\/])?python[\d.]*(?:\.exe)?"?\s+-m\s+pytest\b/i.test(text)) return 'python_tests';
  if (/^(?:"[^"\n]*[\\/])?(?:[^\s"\n]*[\\/])?node(?:\.exe)?"?\s+--test(?:\s|$)/i.test(text)) return 'node_tests';
  return 'process';
}
async function boundedRead(file, limit = 4096) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, Math.min(bytesRead, limit)).toString('utf8'), truncated: bytesRead > limit };
  } finally { await handle.close(); }
}
async function linuxRows() {
  clockTicks ||= exec('getconf', ['CLK_TCK'], { timeout: 2000, maxBuffer: 1024 }).then(result => Number(result.stdout)).catch(() => null);
  const ticks = await clockTicks;
  const names = (await fs.readdir('/proc')).filter(name => /^\d+$/.test(name));
  let partial = names.length > MAX_ROWS;
  const rows = [], deadline = Date.now() + 3000;
  for (let offset = 0; offset < Math.min(names.length, MAX_ROWS); offset += 32) {
    if (Date.now() > deadline) { partial = true; break; }
    const batch = await Promise.all(names.slice(offset, Math.min(offset + 32, MAX_ROWS)).map(async pid => {
      try {
        const stat = await boundedRead(`/proc/${pid}/stat`, 8192);
        const fields = stat.text.slice(stat.text.lastIndexOf(')') + 2).trim().split(/\s+/);
        if (stat.truncated || fields.length < 20) { partial = true; return null; }
        let command;
        try { command = await boundedRead(`/proc/${pid}/cmdline`); }
        catch { command = { text: '', truncated: true }; }
        return { pid: Number(pid), ppid: Number(fields[1]), birth: fields[19],
          cpuMs: Number.isFinite(ticks) && ticks > 0 ? (Number(fields[11]) + Number(fields[12])) * 1000 / ticks : null,
          command: command.text, commandTruncated: command.truncated };
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') partial = true; return null; }
    }));
    rows.push(...batch.filter(Boolean));
  }
  return { rows, partial };
}
async function windowsRows() {
  const script = "$ErrorActionPreference='Stop';$rows=@(Get-CimInstance Win32_Process -OperationTimeoutSec 5 | Select-Object -First 4097);$out=@($rows | ForEach-Object {$c=[string]$_.CommandLine;[pscustomobject]@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;birth=[string]$_.CreationDate;cpuMs=([double]$_.KernelModeTime+[double]$_.UserModeTime)/10000;command=$c.Substring(0,[Math]::Min(4096,$c.Length));commandTruncated=($c.Length -gt 4096 -or -not $c)}});ConvertTo-Json -InputObject $out -Compress";
  const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  const rows = JSON.parse(result.stdout);
  if (!Array.isArray(rows)) throw new Error('invalid census');
  return { rows: rows.slice(0, MAX_ROWS), partial: rows.length > MAX_ROWS };
}

function projectCensus(rootPid, { rows, partial = false }, sampledAt = Date.now()) {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  if (!byPid.has(rootPid)) return { sampledAt, coverage: 'unavailable', descendantCount: null, activeTestCount: null,
    cpuMs: null, processes: [], truncated: false, sampleOnly: true, terminationEvidence: false };
  const children = new Map();
  for (const row of rows) { if (!children.has(row.ppid)) children.set(row.ppid, []); children.get(row.ppid).push(row.pid); }
  const seen = new Set(), stack = [rootPid], members = [];
  while (stack.length && seen.size < MAX_ROWS) {
    const pid = stack.pop(); if (seen.has(pid)) continue; seen.add(pid);
    const row = byPid.get(pid); if (!row) { partial = true; continue; }
    members.push({ pid, parentPid: row.ppid, birthHash: hash(`${pid}:${row.birth}`),
      commandHash: row.command ? hash(row.command) : null, commandHashComplete: !row.commandTruncated,
      commandSummary: commandClass(row.command), cpuMs: Number.isFinite(row.cpuMs) ? row.cpuMs : null });
    stack.push(...(children.get(pid) || []));
  }
  const cpuMs = members.every(row => row.cpuMs !== null) ? members.reduce((sum, row) => sum + row.cpuMs, 0) : null;
  return { sampledAt, coverage: partial || stack.length ? 'partial' : 'complete', descendantCount: Math.max(0, members.length - 1),
    activeTestCount: members.filter(row => row.pid !== rootPid && row.commandSummary.endsWith('_tests')).length,
    cpuMs, processes: members.slice(0, MAX_RETAINED), truncated: members.length > MAX_RETAINED,
    terminationEvidence: false, sampleOnly: true };
}
async function sampleProcessCensus(rootPid) {
  try {
    const data = process.platform === 'linux' ? await linuxRows() : process.platform === 'win32' ? await windowsRows() : null;
    return projectCensus(rootPid, data || { rows: [] });
  } catch { return projectCensus(rootPid, { rows: [] }); }
}
function fanoutWarnings(census, policy) {
  if (!policy || census?.descendantCount === null || !census) return [];
  const warnings = [];
  if (policy.maxChildren !== undefined && census.descendantCount > policy.maxChildren) warnings.push('child_fanout');
  if (policy.maxConcurrentTests !== undefined && census.activeTestCount > policy.maxConcurrentTests) warnings.push('scope_expansion');
  return warnings;
}
function createCensusCpuTracker() {
  const prior = new Map(); let total = 0, exhausted = false;
  return census => {
    if (exhausted || census.coverage !== 'complete' || census.truncated) return null;
    for (const row of census.processes) {
      if (!Number.isFinite(row.cpuMs)) return null;
      if (!prior.has(row.birthHash) && prior.size >= MAX_ROWS) { exhausted = true; return null; }
      total += Math.max(0, row.cpuMs - (prior.get(row.birthHash) || 0));
      prior.set(row.birthHash, row.cpuMs);
    }
    return total;
  };
}
module.exports = { sampleProcessCensus, projectCensus, validateChildProcessPolicy, fanoutWarnings, createCensusCpuTracker };
