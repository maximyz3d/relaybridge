'use strict';

// Public observations are bounded telemetry, never process-death authority.
const count = value => Number.isSafeInteger(value) && value >= 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const WARNINGS = new Set(['child_fanout', 'scope_expansion']);
function normalizeProcessWarnings(value) {
  return Array.isArray(value) ? [...new Set(value.filter(item => WARNINGS.has(item)))] : [];
}
function normalizeNativeTransport(value) {
  if (!value || value.finite !== true || value.renewable !== false || !Number.isFinite(value.remainingMs)
    || value.remainingMs < 0 || typeof value.checkpointNeeded !== 'boolean' || typeof value.stopNeeded !== 'boolean') return null;
  return { finite: true, renewable: false, remainingMs: value.remainingMs,
    checkpointNeeded: value.checkpointNeeded, stopNeeded: value.stopNeeded };
}
function normalizeProcessCensus(value) {
  if (!value || value.sampleOnly !== true || value.terminationEvidence !== false
    || !['complete', 'partial', 'unavailable'].includes(value.coverage)
    || !count(value.sampledAt) || !Array.isArray(value.processes) || value.processes.length > 96
    || typeof value.truncated !== 'boolean') return null;
  for (const name of ['descendantCount', 'activeTestCount']) {
    if (value[name] !== null && (!count(value[name]) || value[name] > 4096)) return null;
  }
  const cpuValid = number => number === null || Number.isFinite(number) && number >= 0;
  if (!cpuValid(value.cpuMs)) return null;
  const processes = [];
  for (const row of value.processes) {
    if (!row || !count(row.pid) || !row.pid || !count(row.parentPid) || !sha(row.birthHash)
      || row.commandHash !== null && !sha(row.commandHash) || typeof row.commandHashComplete !== 'boolean'
      || !['process', 'python_tests', 'node_tests'].includes(row.commandSummary) || !cpuValid(row.cpuMs)) return null;
    processes.push({ pid: row.pid, parentPid: row.parentPid, birthHash: row.birthHash,
      commandHash: row.commandHash, commandHashComplete: row.commandHashComplete,
      commandSummary: row.commandSummary, cpuMs: row.cpuMs });
  }
  return { sampledAt: value.sampledAt, coverage: value.coverage, descendantCount: value.descendantCount,
    activeTestCount: value.activeTestCount, cpuMs: value.cpuMs, processes, truncated: value.truncated,
    sampleOnly: true, terminationEvidence: false };
}
module.exports = { normalizeProcessCensus, normalizeProcessWarnings, normalizeNativeTransport };
