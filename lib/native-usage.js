'use strict';

// Native CLI protocols only. Authentication remains inside the vendor CLI.
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { validQuotaSeat } = require('./quota-seat');
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const number = (n) => typeof n === 'number' && Number.isFinite(n);
const percent = (n) => number(n) && n >= 0 && n <= 100000 ? Math.max(0, 100 - n) : null;
const flag = (n) => typeof n === 'boolean' ? n : null;
const id = (n) => typeof n === 'string' && !['__proto__', 'constructor', 'prototype'].includes(n) && /^[A-Za-z0-9_.:-]{1,160}$/.test(n) ? n : null;

function windowOf(name, used, reset, duration, at) {
  const remaining = percent(used);
  if (remaining === null || !Number.isSafeInteger(reset) || reset * 1000 <= at
    || reset * 1000 > at + 366 * 86400000) return null;
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
    if (number(individual?.remainingPercent) && individual.remainingPercent >= 0 && individual.remainingPercent <= 100) {
      // Spend limits may have no reset. They remain separately identified.
      windows.push({ id: 'individual', percentRemaining: individual.remainingPercent,
        resetsAt: Number.isSafeInteger(individual.resetsAt) ? individual.resetsAt * 1000 : null, windowDurationMs: null });
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

module.exports = { parseCodexRateLimits, parseClaudeStreamRateLimit, parseClaudeStatuslineUsage, readCodexRateLimits };
