'use strict';

// Async task queue: submit work from one surface, collect the result from
// another.
//
// /api/oneshot holds the HTTP connection until the CLI finishes, which is fine
// for a 20-second question and useless for "kick this off and come back after
// lunch" — the browser tab, the chat session, or the tunnel can all die in the
// meantime and the work is lost. Tasks decouple submission from collection:
// POST returns an id immediately, the run continues in the background, and the
// result is durable on disk for any surface to fetch later.
//
// Execution is NOT reimplemented here. submitTask hands the same body to the
// caller-supplied executeOneShot along with a capture object that quacks like
// an Express response, so run supervision, receipts, provider routing, and the
// GitHub tracker all behave exactly as they do for a synchronous call.
//
// Durability rules that matter:
//   - Every state change is written to disk before it is announced.
//   - A task marked `running` when the process dies is reconciled to
//     `interrupted` at startup — never left claiming to run, which would make
//     a poller wait forever for a result that can no longer arrive.
//   - Results are capped so a runaway CLI cannot fill the disk.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const MAX_RESULT_CHARS = 200000;   // ~200KB per task; runs beyond this truncate
const MAX_PROMPT_CHARS = 100000;
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'interrupted']);

function newTaskId() {
  return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function clamp(value, max) {
  const s = String(value ?? '');
  return s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} chars]` : s;
}

/**
 * @param {object} opts
 * @param {string}   opts.dataDir          where task JSON lives
 * @param {function} opts.executeOneShot   (body, res) => Promise, from server.js
 * @param {function} [opts.readCollab]     (id) => collab | null
 * @param {function} [opts.writeCollab]    (id, data) => collab
 * @param {number}   [opts.maxConcurrent]  parallel background runs
 * @param {function} [opts.log]
 */
function createTaskQueue(opts) {
  const dir = opts.dataDir;
  const log = opts.log || (() => {});
  const maxConcurrent = Math.max(1, Number(opts.maxConcurrent) || 3);
  fs.mkdirSync(dir, { recursive: true });

  const pending = [];          // task ids waiting for a slot
  let active = 0;

  const taskPath = (id) => {
    if (!/^t_[A-Za-z0-9_]+$/.test(String(id))) throw new Error('invalid task id');
    return path.join(dir, `${id}.json`);
  };

  function write(task) {
    const fp = taskPath(task.id);
    const tmp = `${fp}.tmp`;
    // Write-then-rename so a crash mid-write cannot leave a half-parsed task.
    fs.writeFileSync(tmp, JSON.stringify(task, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
    return task;
  }

  function read(id) {
    const fp = taskPath(id);
    if (!fs.existsSync(fp)) return null;
    try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
  }

  function list({ collab, status, limit = 50 } = {}) {
    const bounded = Math.max(1, Math.min(Number(limit) || 50, 200));
    const files = fs.readdirSync(dir).filter((n) => /^t_[A-Za-z0-9_]+\.json$/.test(n));
    const tasks = [];
    for (const name of files) {
      try {
        const t = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (collab && t.collab !== collab) continue;
        if (status && t.status !== status) continue;
        // Summary view: the full result is fetched per task, so a list of 200
        // tasks doesn't drag megabytes of CLI output through the response.
        tasks.push({
          id: t.id, status: t.status, kind: t.kind, user: t.user, collab: t.collab || null,
          title: t.title, createdAt: t.createdAt, startedAt: t.startedAt || null,
          finishedAt: t.finishedAt || null, exitCode: t.exitCode ?? null,
          resultChars: t.result ? t.result.length : 0, error: t.error || null,
        });
      } catch { /* skip unreadable task */ }
    }
    tasks.sort((a, b) => b.createdAt - a.createdAt);
    return tasks.slice(0, bounded);
  }

  // A task left `running` or `queued` by a dead process can never finish: its
  // executor is gone. Mark it so pollers get a terminal answer instead of
  // waiting on a result that will never come.
  function reconcileOnStartup() {
    const reconciled = [];
    for (const name of fs.readdirSync(dir).filter((n) => /^t_[A-Za-z0-9_]+\.json$/.test(n))) {
      try {
        const fp = path.join(dir, name);
        const t = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (t.status === 'running' || t.status === 'queued') {
          t.status = 'interrupted';
          t.error = 'the bridge restarted while this task was in flight; resubmit it';
          t.finishedAt = Date.now();
          write(t);
          reconciled.push(t.id);
        }
      } catch { /* skip */ }
    }
    if (reconciled.length) log(`[RelayBridge] tasks: reconciled ${reconciled.length} interrupted task(s)`);
    return reconciled;
  }

  function appendToCollab(task) {
    if (!task.collab || !opts.readCollab || !opts.writeCollab) return;
    try {
      const collab = opts.readCollab(task.collab);
      if (!collab) return;
      const transcript = Array.isArray(collab.transcript) ? collab.transcript : [];
      transcript.push({
        ts: Date.now(), taskId: task.id, role: 'assistant', speaker: task.kind,
        text: clamp(task.result || task.error || '', 20000),
        status: task.status,
      });
      opts.writeCollab(task.collab, { ...collab, transcript });
    } catch (err) {
      log(`[RelayBridge] tasks: could not append to collab ${task.collab}: ${err.message}`);
    }
  }

  // Quacks like an Express response so executeOneShot needs no changes.
  //
  // It must satisfy the WHOLE interface the real handler uses, not just the
  // parts that are obvious. executeOneShot registers disconnect listeners with
  // res.on/res.once — a shim without those throws "res.once is not a function"
  // and every task fails instantly. Extending EventEmitter covers the listener
  // surface for free and means a future res.on(...) call cannot break tasks.
  //
  // Nothing ever emits 'close' or 'aborted' here: a background task has no
  // client to disconnect, which is exactly the point of running it in the
  // background.
  function captureResponse(onPayload) {
    const res = new EventEmitter();
    let statusCode = 200;
    res.writableEnded = false;
    res.destroyed = false;
    res.statusCode = 200;
    res.headersSent = false;
    res.status = (code) => { statusCode = code; res.statusCode = code; return res; };
    res.set = () => res;
    res.setHeader = () => res;
    res.type = () => res;
    // Emitting 'finish' is NOT cosmetic. acquireOneShot() releases the
    // concurrency slot on res.once('finish') / res.once('close'), which a real
    // Express response emits when the socket completes. A shim that never
    // emitted them leaked one admission slot per task — four background tasks
    // wedged the whole bridge at "provider concurrency limit reached" with
    // zero runs actually active, and no restart cleared it because the count
    // is rebuilt by the same leak.
    const finish = () => {
      if (res.__finished) return;
      res.__finished = true;
      res.writableEnded = true;
      // Deferred so the caller's own `return res` completes first, matching
      // the ordering a real response gives listeners.
      setImmediate(() => { res.emit('finish'); res.emit('close'); });
    };
    res.json = (payload) => {
      if (res.writableEnded) return res;   // a late second write must not re-settle
      res.writableEnded = true;
      res.headersSent = true;
      onPayload(payload, statusCode);
      finish();
      return res;
    };
    res.send = (payload) => res.json(payload);
    res.sendStatus = (code) => { res.status(code); return res.json({ status: code }); };
    res.end = () => { finish(); return res; };
    // A handler that throws before responding must still release the slot.
    res.__abort = () => { res.destroyed = true; finish(); };
    return res;
  }

  function pump() {
    while (active < maxConcurrent && pending.length) {
      const id = pending.shift();
      const task = read(id);
      if (!task || task.status !== 'queued') continue;
      active += 1;
      runTask(task).finally(() => {
        active -= 1;
        // Drain on the next tick so a synchronous failure can't recurse deeply.
        setImmediate(pump);
      });
    }
  }

  async function runTask(task) {
    task.status = 'running';
    task.startedAt = Date.now();
    write(task);

    const settle = (patch) => {
      const current = read(task.id) || task;
      // A cancel that landed while the run was in flight wins: don't resurrect it.
      if (TERMINAL.has(current.status)) return current;
      const finished = { ...current, ...patch, finishedAt: Date.now() };
      write(finished);
      appendToCollab(finished);
      return finished;
    };

    try {
      await new Promise((resolve) => {
        const res = captureResponse((payload, statusCode) => {
          const text = payload?.stdout ?? payload?.text ?? '';
          const failed = statusCode >= 400 || payload?.auth_failed || payload?.dropped_out;
          settle({
            status: failed ? 'failed' : 'done',
            result: clamp(text, MAX_RESULT_CHARS),
            stderr: clamp(payload?.stderr || '', 20000),
            exitCode: payload?.exitCode ?? null,
            route: payload?.route || null,
            usage: payload?.usage || null,
            receiptId: payload?.receiptId || null,
            error: failed ? (payload?.error || payload?.stop_detail || `exit ${payload?.exitCode}`) : null,
            flags: {
              rate_limited: !!payload?.rate_limited,
              budget_exceeded: !!payload?.budget_exceeded,
              auth_failed: !!payload?.auth_failed,
              timed_out: !!payload?.timed_out,
              dropped_out: !!payload?.dropped_out,
            },
          });
          resolve();
        });
        Promise.resolve(opts.executeOneShot(task.body, res))
          .then(() => {
            // HTTP adapters await their response, while CLI providers return
            // after registering child-process callbacks and answer later.
            // Only the latter explicitly marks the response as deferred; an
            // unmarked handler that returns silently is still a real bug.
            if (!res.writableEnded && !res._relayDeferredResponse) {
              res.__abort();
              settle({ status: 'failed', error: 'provider handler returned without a response' });
              resolve();
            }
          })
          .catch((err) => {
            res.__abort();
            settle({ status: 'failed', error: err.message });
            resolve();
          });
      });
    } catch (err) {
      settle({ status: 'failed', error: err.message });
    }
    return read(task.id);
  }

  function submit(input) {
    const prompt = clamp(input?.prompt, MAX_PROMPT_CHARS);
    if (!prompt.trim()) throw new Error('prompt is required');
    if (!input?.kind) throw new Error('kind (provider id) is required');

    const id = newTaskId();
    const task = write({
      id,
      status: 'queued',
      kind: String(input.kind),
      user: input.user ? String(input.user).slice(0, 64) : null,
      collab: input.collab ? String(input.collab).slice(0, 64) : null,
      title: clamp(input.title || prompt.split('\n')[0], 120),
      source: input.source ? String(input.source).slice(0, 32) : 'api',
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
      // Preserved so the run is reproducible and so executeOneShot sees the
      // same shape it would from a direct POST.
      body: {
        kind: String(input.kind),
        prompt,
        cwd: input.cwd || undefined,
        dangerous: !!input.dangerous,
        user: input.user || undefined,
        intent: input.intent || undefined,
      },
    });

    pending.push(id);
    setImmediate(pump);
    return task;
  }

  function cancel(id) {
    const task = read(id);
    if (!task) throw new Error('task not found');
    if (TERMINAL.has(task.status)) return task;
    // Queued tasks are cancelled cleanly. A running task's child process is
    // owned by the supervisor, so this marks intent and stops the result being
    // recorded — it does not claim to have killed the process.
    const idx = pending.indexOf(id);
    if (idx >= 0) pending.splice(idx, 1);
    return write({
      ...task,
      status: 'cancelled',
      finishedAt: Date.now(),
      error: task.status === 'running'
        ? 'cancelled while running; the provider process may still be finishing'
        : 'cancelled before it started',
    });
  }

  function stats() {
    return { active, queued: pending.length, maxConcurrent };
  }

  reconcileOnStartup();

  return { submit, get: read, list, cancel, stats, reconcileOnStartup, newTaskId, _pump: pump };
}

module.exports = { createTaskQueue, newTaskId, MAX_RESULT_CHARS };
