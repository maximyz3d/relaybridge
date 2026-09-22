'use strict';

// Native CLI protocols only. Authentication remains inside the vendor CLI.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { validQuotaSeat } = require('./quota-seat');
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const number = (n) => typeof n === 'number' && Number.isFinite(n);
// Strict evidence range: usedPercent/utilization*100 outside 0..100 is rejected, never clamped.
const percent = (n) => number(n) && n >= 0 && n <= 100 ? 100 - n : null;
const flag = (n) => typeof n === 'boolean' ? n : null;
const id = (n) => typeof n === 'string' && !['__proto__', 'constructor', 'prototype'].includes(n) && /^[A-Za-z0-9_.:-]{1,160}$/.test(n) ? n : null;

// A window field present in the payload but out of range or with an unusable reset is invalid
// evidence, not absence: it must not be silently dropped and must not let a sibling good window
// make the bucket look fully fresh. A field absent from the payload is simply not claimed (null).
function windowOf(name, used, reset, duration, at) {
  const remaining = percent(used);
  const resetValid = Number.isSafeInteger(reset) && reset * 1000 > at && reset * 1000 <= at + 366 * 86400000;
  if (remaining === null || !resetValid) return { id: name, invalid: true };
  return { id: name, percentRemaining: remaining, resetsAt: reset * 1000,
    windowDurationMs: number(duration) && duration > 0 && duration <= 366 * 1440 ? duration * 60000 : null };
}
function envelope(provider, source, context, buckets, extra = {}) {
  const at = context.observedAt ?? Date.now();
  if (!validQuotaSeat(context.quotaSeat) || !Number.isSafeInteger(at) || at < 0 || !buckets.length) return null;
  const value = { version: 1, provider, source, quotaSeat: context.quotaSeat, observedAt: at,
    accountFingerprint: context.accountFingerprint || null, buckets, ...extra };
  return { ...value, evidenceHash: hash({ ...value, observedAt: undefined }) };
}

function parseCodexRateLimits(payload, context = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const at = context.observedAt ?? Date.now();
  const defaultBucket = id(payload.rateLimits?.limitId) || 'codex';
  const source = payload.rateLimitsByLimitId && typeof payload.rateLimitsByLimitId === 'object'
    ? payload.rateLimitsByLimitId : payload.rateLimits ? { [defaultBucket]: payload.rateLimits } : {};
  const buckets = [];
  for (const [key, value] of Object.entries(source).slice(0, 32)) {
    if (!id(key) || !value || typeof value !== 'object') continue;
    const windows = ['primary', 'secondary'].map((name) => {
      const w = value[name];
      return w && windowOf(name, w.usedPercent, w.resetsAt, w.windowDurationMins, at);
    }).filter(Boolean);
    const individual = value.individualLimit;
    // A missing/null individualLimit is legitimate absence. Anything else supplied —
    // including a malformed non-object scalar — is invalid evidence, not absence:
    // property access on a primitive is safe (yields undefined, which fails validation
    // below), and must not be silently dropped while a sibling window looks fresh.
    if (individual != null) {
      const remaining = number(individual.remainingPercent) && individual.remainingPercent >= 0
        && individual.remainingPercent <= 100 ? individual.remainingPercent : null;
      // Spend limits may have no reset (missing/null is allowed); a supplied but
      // unusable reset is invalid evidence, not absence, same as primary/secondary.
      const resetPresent = individual.resetsAt !== undefined && individual.resetsAt !== null;
      const resetValid = !resetPresent || (Number.isSafeInteger(individual.resetsAt)
        && individual.resetsAt * 1000 > at && individual.resetsAt * 1000 <= at + 366 * 86400000);
      windows.push(remaining === null || !resetValid ? { id: 'individual', invalid: true }
        : { id: 'individual', percentRemaining: remaining, resetsAt: resetPresent ? individual.resetsAt * 1000 : null, windowDurationMs: null });
    }
    buckets.push({ id: key, model: id(value.normalModelSlug), windows,
      spendControlReached: flag(value.spendControlReached),
      reachedType: ['rate_limit_reached', 'workspace_owner_credits_depleted', 'workspace_member_credits_depleted',
        'workspace_owner_usage_limit_reached', 'workspace_member_usage_limit_reached'].includes(value.rateLimitReachedType)
        ? value.rateLimitReachedType : null });
  }
  return envelope('codex', 'codex_app_server_v1', { ...context, observedAt: at,
    accountFingerprint: typeof payload.accountId === 'string' ? hash(payload.accountId) : context.accountFingerprint }, buckets,
  { defaultBucket, fullSnapshot: true, ordinaryUsageAllowed: flag(payload.ordinaryUsageAllowed) });
}

function parseClaudeStreamRateLimit(event, context = {}) {
  if (event?.type !== 'rate_limit_event') return null;
  const info = event.rate_limit_info;
  const at = context.observedAt ?? Date.now();
  const windows = Object.entries({ five_hour: 300, seven_day: 10080 }).map(([name, duration]) => {
    const w = info?.unifiedWindows?.[name];
    return w && windowOf(name, number(w.utilization) ? w.utilization * 100 : null, w.resetsAt, duration, at);
  }).filter(Boolean);
  const duration = { five_hour: 300, seven_day: 10080 }[info?.rateLimitType];
  if (duration && !windows.some((w) => w.id === info.rateLimitType)) {
    const w = windowOf(info.rateLimitType, number(info.utilization) ? info.utilization * 100 : null, info.resetsAt, duration, at);
    if (w) windows.push(w);
  }
  if (!windows.length && info?.status !== 'rejected') return null;
  return envelope('claude', 'claude_stream_v1', { ...context, observedAt: at },
    [{ id: 'account', model: null, windows, spendControlReached: null }],
    { defaultBucket: 'account', ordinaryUsageAllowed: info.status === 'rejected' ? false : info.status === 'allowed' ? true : null });
}

function parseClaudeStatuslineUsage(payload, context = {}) {
  const at = context.observedAt ?? Date.now();
  const windows = Object.entries({ five_hour: 300, seven_day: 10080 }).map(([name, duration]) => {
    const w = payload?.rate_limits?.[name];
    return w && windowOf(name, w.used_percentage, w.resets_at, duration, at);
  }).filter(Boolean);
  return envelope('claude', 'claude_statusline_v1', { ...context, observedAt: at },
    windows.length ? [{ id: 'account', model: null, windows, spendControlReached: null }] : [],
    { defaultBucket: 'account', ordinaryUsageAllowed: null });
}

// Versioned observation of the default CLI metadata layout, not an auth probe.
// Identity is independent of cache validity; neither proves an authenticated session.
const CLAUDE_CACHE_TTL_MS = 180000;
const CLAUDE_ALTERNATE_AUTH_ENV = Object.freeze([...require('../cli-config.json').claude_fable.strip_env]);
function claudeReset(iso, at) {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(iso);
  if (!m) return null;
  const offset = m[8] === 'Z' ? 0 : (m[8][0] === '-' ? -1 : 1) * (Number(m[8].slice(1, 3)) * 60 + Number(m[8].slice(4)));
  if (m[8] !== 'Z' && (Number(m[8].slice(1, 3)) > 23 || Number(m[8].slice(4)) > 59)) return null;
  const ms = Date.parse(iso), local = new Date(ms + offset * 60000);
  if (!Number.isSafeInteger(ms) || ms <= at || ms > at + 366 * 86400000
    || [local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(), local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds()]
      .some((v, i) => v !== Number(m[i + 1]))) return null;
  const ns = BigInt(ms) * 1000000n + BigInt((m[7] || '').padEnd(9, '0').slice(3));
  return { ms, ns: String(ns), boundaryMs: Number((ns + 999999999n) / 1000000000n) * 1000 };
}
function parseClaudeNativeCache(payload, context = {}) {
  const cache = payload?.cachedUsageUtilization, uuid = payload?.oauthAccount?.accountUuid;
  const at = cache?.fetchedAtMs, now = context.now ?? Date.now();
  if (typeof uuid !== 'string' || cache?.accountUuid !== uuid || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(uuid)
    || !Number.isSafeInteger(at) || at < 0 || at > now || now - at > CLAUDE_CACHE_TTL_MS) return null;
  const windows = [];
  for (const [name, duration] of Object.entries({ five_hour: 300, seven_day: 10080 })) {
    const w = cache.utilization?.[name], remaining = percent(w?.utilization), reset = claudeReset(w?.resets_at, at);
    // Claude omits the reset of an unused five-hour window. Preserve that
    // absence instead of inventing a deadline; the observation still expires
    // with the normal short native-cache TTL.
    if (name === 'five_hour' && w?.utilization === 0 && w.resets_at === null) {
      windows.push({ id: name, percentRemaining: 100, resetsAt: null,
        nativeUsedPercent: 0, nativeNoActiveWindow: true, windowDurationMs: duration * 60000 });
      continue;
    }
    if (remaining === null || reset === null) return null;
    windows.push({ id: name, percentRemaining: remaining, resetsAt: reset.ms,
      nativeResetIso: w.resets_at, nativeResetMs: reset.ms, nativeResetNs: reset.ns, nativeUsedPercent: w.utilization,
      resetBoundaryMs: reset.boundaryMs, windowDurationMs: duration * 60000 });
  }
  return envelope('claude', 'claude_native_cache_v1', { ...context, observedAt: at,
    accountFingerprint: hash(['claude_oauth_account_v1', uuid]) },
  [{ id: 'account', model: null, windows, spendControlReached: null }],
  { defaultBucket: 'account', ordinaryUsageAllowed: null, nativeFetchedAt: at });
}
// Every running Claude Code process rewrites ~/.claude.json by atomic tmp+rename, so a single
// lstat->open->fstat->read->fstat/lstat consistency window can race a legitimate writer. That
// race is retried a bounded number of times before giving up; it never relaxes any of the
// existing safety checks (size cap, O_NOFOLLOW, dev/ino/size/mtime/ctime equality).
const STAT_RACE = Symbol('claude_native_usage_stat_race');
function sleepSync(ms) {
  // Best-effort synchronous backoff. If SharedArrayBuffer/Atomics are unavailable in this
  // runtime, the retry proceeds immediately rather than failing the read.
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}
function readClaudeNativeUsage({ env = process.env, defaultHome = os.homedir(), quotaSeat, now = Date.now(), fsImpl = fs,
  projectCwd = null, statRetries = 3, statRetryDelayMs = 50, sleepImpl = sleepSync } = {}) {
  const unavailable = { identity: null, observation: null, projectTrustAccepted: false, reason: 'native_profile_unavailable' };
  const home = env.HOME || env.USERPROFILE;
  // No guessed CLAUDE_CONFIG_DIR layout, alternate home, ambient fallback or mkdir.
  if (!home || !path.isAbsolute(home) || path.resolve(home) !== path.resolve(defaultHome)
    || Object.hasOwn(env, 'CLAUDE_CONFIG_DIR')
    || CLAUDE_ALTERNATE_AUTH_ENV.some((key) => env[key] != null && env[key] !== '')) return unavailable;
  const file = path.join(defaultHome, '.claude.json');
  const attempt = () => {
    let fd;
    try {
      const initial = fsImpl.lstatSync(file, { bigint: true });
      if (!initial.isFile() || initial.size > 1024n * 1024n) return unavailable;
      fd = fsImpl.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      const before = fsImpl.fstatSync(fd, { bigint: true });
      const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((k) => a[k] === b[k]);
      if (!before.isFile() || !same(initial, before)) return STAT_RACE;
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      let bytes = 0, got;
      while (bytes < buffer.length && (got = fsImpl.readSync(fd, buffer, bytes, buffer.length - bytes, null))) bytes += got;
      if (bytes > 1024 * 1024) return unavailable;
      if (BigInt(bytes) !== before.size
        || !same(before, fsImpl.fstatSync(fd, { bigint: true }))
        || !same(before, fsImpl.lstatSync(file, { bigint: true }))) return STAT_RACE;
      const payload = JSON.parse(buffer.toString('utf8', 0, bytes));
      const uuid = payload?.oauthAccount?.accountUuid;
      if (typeof uuid !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(uuid)) return unavailable;
      const identity = { accountFingerprint: hash(['claude_oauth_account_v1', uuid]), profileHash: hash(['claude_default_profile_v1', file]) };
      const observation = parseClaudeNativeCache(payload, { quotaSeat, now });
      const cacheFetchedAt = payload?.cachedUsageUtilization?.accountUuid === uuid
        && Number.isSafeInteger(payload.cachedUsageUtilization.fetchedAtMs)
        && payload.cachedUsageUtilization.fetchedAtMs >= 0
        && payload.cachedUsageUtilization.fetchedAtMs <= now
        ? payload.cachedUsageUtilization.fetchedAtMs : null;
      const projectTrustAccepted = typeof projectCwd === 'string' && path.isAbsolute(projectCwd)
        && payload?.projects?.[path.resolve(projectCwd)]?.hasTrustDialogAccepted === true;
      return { identity, observation, cacheFetchedAt, projectTrustAccepted,
        reason: observation ? null : 'native_cache_unavailable' };
    } catch { return unavailable; }
    finally { if (fd !== undefined) try { fsImpl.closeSync(fd); } catch {} }
  };
  const attempts = Number.isInteger(statRetries) && statRetries > 0 ? statRetries : 3;
  let result = STAT_RACE;
  for (let i = 0; i < attempts && result === STAT_RACE; i++) {
    result = attempt();
    if (result === STAT_RACE && i < attempts - 1) sleepImpl(statRetryDelayMs);
  }
  return result === STAT_RACE ? unavailable : result;
}

// At most one bounded, non-generating RPC conversation per supplied profile.
// A successful read does not create a thread or a turn. No credentials/logs are returned.
function readCodexRateLimits({ command = 'codex', args = [], env = process.env, cwd,
  timeoutMs = 8000, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let proc, timer, forceTimer, buffer = '', bytes = 0, answer, failed = false, closed = false;
    const fail = () => {
      failed = true; try { proc?.kill(); } catch {}
      if (!forceTimer) { forceTimer = setTimeout(() => { try { proc?.kill('SIGKILL'); } catch {} }, 1000); forceTimer.unref?.(); }
    };
    try { proc = spawnImpl(command, [...args, 'app-server', '--listen', 'stdio://'],
      { env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { reject(new Error('native quota probe unavailable')); return; }
    timer = setTimeout(fail, timeoutMs); timer.unref?.();
    const send = (data) => { try { proc.stdin.write(JSON.stringify(data) + '\n'); } catch { fail(); } };
    proc.stdin.on('error', fail);
    proc.stderr.on('data', () => {});
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk); if (bytes > 262144) { fail(); return; }
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let value; try { value = JSON.parse(line); } catch { fail(); return; }
        if (!value || typeof value !== 'object' || Array.isArray(value)) { fail(); return; }
        if (value.id === 1) {
          if (value.error) { fail(); return; }
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } });
        } else if (value.id === 2) {
          if (value.error || !value.result) { fail(); return; }
          answer = value.result; proc.stdin.end();
        }
      }
    });
    proc.once('error', fail);
    proc.once('close', () => {
      if (closed) return; closed = true; clearTimeout(timer); clearTimeout(forceTimer);
      if (!failed && answer) resolve(answer); else reject(new Error('native quota probe unavailable'));
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'relaybridge_usage', version: '1.0.0' } } });
  });
}

module.exports = { parseCodexRateLimits, parseClaudeStreamRateLimit, parseClaudeStatuslineUsage, readCodexRateLimits,
  parseClaudeNativeCache, readClaudeNativeUsage, CLAUDE_CACHE_TTL_MS };
