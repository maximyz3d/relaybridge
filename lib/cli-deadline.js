'use strict';

const { RunSupervisor, resolveSupervisorOptions } = require('./run-supervisor');
const { validationError } = require('./validation-contract');
const TIMEOUT_POLICY = require('../timeout-policy.cjs');
const PRINT_TIMEOUT_TOKEN = '{supervisor_print_timeout}';
const PRINT_MARGIN_MS = 30000;

// One shared preview/dispatch resolver. A runtime timeout is not a model or
// effort change: the execution tuple remains server-reconstructed and intact.
function resolveAttemptTiming({ entry = {}, globals = {}, providerBudget, taskTier, timeoutMs, startedAt } = {}) {
  const explicit = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? TIMEOUT_POLICY.normalizeOneShotTimeoutMs(timeoutMs) : null;
  const resolved = resolveSupervisorOptions({ entry, globals, providerBudget, taskTier, hardCapMs: explicit, startedAt });
  const normalized = new RunSupervisor(resolved).opts;
  return { ...normalized, hardCapMs: Number(normalized.hardCapMs), idleMs: Number(normalized.idleMs) };
}

function renderCliDeadline({ entry = {}, slot, supervisorOptions } = {}) {
  const invalid = (reason) => { throw validationError('invalid_print_timeout', 'provider.printTimeout', reason); };
  if (!Array.isArray(slot)) invalid('Provider argument template must be an array.');
  const flags = [];
  let delimiter = slot.indexOf('--');
  if (delimiter < 0) delimiter = slot.length;
  for (let index = 0; index < delimiter; index++) {
    const value = slot[index];
    if (value === '--print-timeout') { flags.push({ index, width: 2, value: slot[index + 1] }); index++; }
    else if (typeof value === 'string' && value.startsWith('--print-timeout=')) flags.push({ index, width: 1, value: value.slice(16) });
  }
  const configured = entry.print_timeout_policy !== undefined;
  if (!configured && !flags.length) return { slot: [...slot], deadline: null };
  if (entry.print_timeout_policy !== 'supervisor_margin_v1') invalid('Print-timeout flags require the supported supervisor_margin_v1 policy.');
  if (flags.length !== 1 || flags[0].value !== PRINT_TIMEOUT_TOKEN || flags[0].index + flags[0].width > delimiter) {
    invalid('Configure exactly one --print-timeout with the server-owned supervisor timeout placeholder before the argument delimiter.');
  }
  // Gemini's native wait cannot be renewed after spawn. Expose its separate
  // 24-hour transport ceiling for adaptive work; deliberate deadlines retain
  // their exact existing margin.
  const adaptive = supervisorOptions?.hardDeadline === false;
  const cap = adaptive ? 86400000 : Number(supervisorOptions?.hardCapMs);
  const printMs = Math.ceil((cap + PRINT_MARGIN_MS) / 1000) * 1000;
  // Go duration flags use signed int64 nanoseconds. Keep the rendered seconds
  // in range, with positive bounded margin; no unsupported unlimited sentinel.
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isSafeInteger(printMs) || printMs > 9_223_372_036_000) invalid('Resolved supervisor deadline is outside supported print-duration bounds.');
  const duration = `${printMs / 1000}s`;
  const rendered = [...slot], flag = flags[0];
  rendered.splice(flag.index, flag.width, ...(flag.width === 1 ? [`--print-timeout=${duration}`] : ['--print-timeout', duration]));
  return { slot: rendered, deadline: { source: adaptive ? 'adaptive_transport_ceiling' : 'supervisor_margin_v1', hardCapMs: cap,
    finite: true, renewable: false, nativeLimitMs: printMs, supervisorHardDeadline: !adaptive,
    limitation: 'native_cli_wait_cannot_be_renewed',
    printTimeoutMs: printMs, printTimeout: duration, marginMs: printMs - cap } };
}

function nativeTransportState(deadline, dispatchedAt, now = Date.now()) {
  if (!deadline?.finite || !Number.isSafeInteger(deadline.nativeLimitMs) || !Number.isFinite(dispatchedAt)) return null;
  const remainingMs = Math.max(0, dispatchedAt + deadline.nativeLimitMs - now);
  return { remainingMs, finite: true, renewable: false,
    checkpointNeeded: remainingMs <= Math.min(120000, deadline.nativeLimitMs / 10),
    stopNeeded: remainingMs <= Math.min(30000, deadline.nativeLimitMs / 40) };
}
module.exports = { resolveAttemptTiming, renderCliDeadline, nativeTransportState, PRINT_TIMEOUT_TOKEN, PRINT_MARGIN_MS };
