'use strict';

const { rateLimit } = require('express-rate-limit');

function admissionError(reason = 'operation concurrency limit reached') {
  return Object.assign(new Error(reason), { code: 'operation_admission_limit', retryable: true });
}
function abortError() {
  return Object.assign(new Error('operation caller cancelled'), { name: 'AbortError', code: 'operation_cancelled' });
}
function positiveInteger(value, name, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 10000) {
    throw new TypeError(`invalid ${name}`);
  }
  return value;
}

// Mount AFTER capability/Host/Origin authentication. All local clients share
// one finite resource budget, rather than bypassing it through alternate IPs.
function createRequestLimiter({ family, limit = 120, windowMs = 60000 } = {}) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(family || '')) throw new TypeError('invalid rate-limit family');
  positiveInteger(limit, 'request limit');
  if (!Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > 3600000) throw new TypeError('invalid windowMs');
  return rateLimit({
    windowMs, limit, keyGenerator: () => family, identifier: family,
    standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (req, res) => {
      const reset = req.rateLimit?.resetTime?.getTime?.();
      const retryAfter = Math.max(1, Math.ceil((Number.isFinite(reset) ? reset - Date.now() : windowMs) / 1000));
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({
        ok: false, success: false, failureClass: 'admission_limit',
        error: 'operation request rate limit reached; retry with backoff',
        validation: { code: 'operation_rate_limit', field: 'request', reason: 'operation request rate limit reached' },
        retryable: true, retry_after: retryAfter, model_invocation: false,
        physical_attempt_count: 0, token_usage_source: 'not_invoked',
      });
    },
  });
}

// A child lease is released by its termination handler, NOT HTTP disconnect.
// Callers must keep the lease while cancellation/kill is still in progress.
function createOperationSlots({ limit = 4 } = {}) {
  positiveInteger(limit, 'operation slots');
  let active = 0;
  return {
    acquire() {
      if (active >= limit) throw admissionError();
      active += 1;
      let released = false;
      return () => { if (!released) { released = true; active -= 1; } };
    },
    snapshot: () => ({ active, limit }),
  };
}

// Bounded read-only work pool with singleflight. Each caller can cancel its
// own wait. Shared work is aborted only when its last subscriber leaves, and
// retains its slot until the worker has actually completed cleanup.
function createReadOperationPool({ maxActive = 4, maxQueued = 32, maxSubscribers = 64 } = {}) {
  positiveInteger(maxActive, 'active operations');
  positiveInteger(maxQueued, 'queued operations', true);
  positiveInteger(maxSubscribers, 'operation subscribers');
  const jobs = new Map();
  const queue = [];
  let active = 0;

  function forget(job) { if (jobs.get(job.key) === job) jobs.delete(job.key); }
  function settle(job, rejected, value) {
    job.finished = true;
    for (const subscriber of job.subscribers) {
      subscriber.signal?.removeEventListener('abort', subscriber.cancel);
      if (rejected) subscriber.reject(value); else subscriber.resolve(value);
    }
    job.subscribers.clear();
    forget(job);
    active -= 1;
    drain();
  }
  function drain() {
    while (active < maxActive && queue.length) {
      const job = queue.shift();
      if (!job.subscribers.size) { forget(job); continue; }
      active += 1;
      job.started = true;
      Promise.resolve().then(() => job.work(job.controller.signal))
        .then((value) => settle(job, false, value), (error) => settle(job, true, error));
    }
  }

  function run(key, work, { signal } = {}) {
    if (typeof key !== 'string' || !key || key.length > 256 || typeof work !== 'function') {
      return Promise.reject(new TypeError('invalid read operation'));
    }
    if (signal !== undefined && !(signal instanceof AbortSignal)) return Promise.reject(new TypeError('invalid abort signal'));
    if (signal?.aborted) return Promise.reject(abortError());
    let job = jobs.get(key);
    if (job?.controller.signal.aborted) return Promise.reject(admissionError('shared operation is still draining'));
    if (job && job.subscribers.size >= maxSubscribers) return Promise.reject(admissionError('too many subscribers to shared operation'));
    if (!job) {
      if (active >= maxActive && queue.length >= maxQueued) return Promise.reject(admissionError('operation queue is full'));
      job = { key, work, controller: new AbortController(), subscribers: new Set(), started: false, finished: false };
      jobs.set(key, job);
      queue.push(job);
    }
    return new Promise((resolve, reject) => {
      const subscriber = { resolve, reject, signal, cancel: null };
      subscriber.cancel = () => {
        if (!job.subscribers.delete(subscriber)) return;
        signal?.removeEventListener('abort', subscriber.cancel);
        reject(abortError());
        if (!job.subscribers.size && !job.finished) {
          if (job.started) job.controller.abort(abortError());
          else {
            forget(job);
            const index = queue.indexOf(job);
            if (index !== -1) queue.splice(index, 1);
          }
        }
      };
      job.subscribers.add(subscriber);
      signal?.addEventListener('abort', subscriber.cancel, { once: true });
      if (signal?.aborted) subscriber.cancel();
      drain();
    });
  }
  return { run, snapshot: () => ({ active, queued: queue.length, shared: jobs.size, maxActive, maxQueued }) };
}

module.exports = { createRequestLimiter, createOperationSlots, createReadOperationPool };
