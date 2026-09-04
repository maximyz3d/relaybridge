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
// How long a task may keep waiting for a provider seat before it gives up and
// reports the rejection it kept getting. Bounded so a permanently wedged
// provider cannot keep a task alive (and its prompt unanswered) forever.
const ADMISSION_WAIT_MS = 3600000;
const ADMISSION_BACKOFF_MIN_MS = 1000;
const ADMISSION_BACKOFF_MAX_MS = 30000;

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
 * @param {number}   [opts.admissionWaitMs] how long a task waits for a provider seat
 * @param {function} [opts.log]
 */
function createTaskQueue(opts) {
  const dir = opts.dataDir;
  const log = opts.log || (() => {});
  const maxConcurrent = Math.max(1, Number(opts.maxConcurrent) || 3);
  const admissionWaitMs = Number(opts.admissionWaitMs) > 0 ? Number(opts.admissionWaitMs) : ADMISSION_WAIT_MS;
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

  // The id embeds its own creation time (newTaskId: 't_' + Date.now() in base
  // 36), so the file NAME already sorts newest-first without opening anything.
  // A name that predates that scheme sorts last rather than jumping the queue.
  function idTimestamp(name) {
    const stamp = /^t_([0-9a-z]+)_/.exec(name)?.[1];
    const ms = stamp ? parseInt(stamp, 36) : NaN;
    return Number.isFinite(ms) ? ms : 0;
  }

  function list({ collab, status, limit = 50 } = {}) {
    const bounded = Math.max(1, Math.min(Number(limit) || 50, 200));
    // Parse newest-first and stop at `limit`. This used to JSON.parse every
    // file in the directory — each one carrying a result of up to
    // MAX_RESULT_CHARS — before slicing, so a bridge with a few hundred
    // accumulated tasks blocked the event loop for ~80 ms on every poll of the
    // Tasks panel, on the same thread that streams PTY output and proxies
    // provider runs. Nothing prunes this directory, so the cost only grows.
    const files = fs.readdirSync(dir)
      .filter((n) => /^t_[A-Za-z0-9_]+\.json$/.test(n))
      .sort((a, b) => idTimestamp(b) - idTimestamp(a));
    const tasks = [];
    for (const name of files) {
      if (tasks.length >= bounded) break;
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
          failureClass: t.failureClass || null,
        });
      } catch { /* skip unreadable task */ }
    }
    tasks.sort((a, b) => b.createdAt - a.createdAt);
    return tasks;
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
  // 'close' IS emitted, but only from finish()/__abort(): a background task has
  // no client that can disconnect mid-run, which is exactly the point of
  // running it in the background.
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
    const finish = ({ ended = true } = {}) => {
      if (res.__finished) return;
      res.__finished = true;
      // `ended` is false only for __abort(). A real response that is destroyed
      // before it answers never sets writableEnded, and server.js keys its
      // abandoned-run cleanup on exactly that:
      //   res.on('close', () => { if (!res.writableEnded) { clientGone = true;
      //     finishSupervision(); killProcessTree(proc); cleanupPromptFile(); } })
      // Marking the shim as ended made an aborted task look like a completed
      // response, so the kill never fired: the provider tree kept running to
      // the supervisor's hard cap while acquireOneShot's release (which
      // listens to plain 'finish'/'close') had already handed the admission
      // slot — and the queue slot — to the next task.
      if (ended) res.writableEnded = true;
      // Deferred so the caller's own `return res` completes first, matching
      // the ordering a real response gives listeners.
      setImmediate(() => { res.emit('finish'); res.emit('close'); });
    };
    res.json = (payload) => {
      // Tests __finished as well as writableEnded: an aborted response leaves
      // writableEnded false on purpose (above), and a payload arriving after
      // the abort must still not re-settle the task.
      if (res.__finished || res.writableEnded) return res;   // a late second write must not re-settle
      res.writableEnded = true;
      res.headersSent = true;
      onPayload(payload, statusCode);
      finish();
      return res;
    };
    res.send = (payload) => res.json(payload);
    res.sendStatus = (code) => { res.status(code); return res.json({ status: code }); };
    res.end = () => { finish(); return res; };
    // A handler that throws before responding must still release the slot, and
    // must present itself as abandoned rather than answered (see finish()).
    res.__abort = () => { res.destroyed = true; finish({ ended: false }); };
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

    // A denied admission is not a task failure: it is precisely the condition a
    // queue exists to wait out. server.js answers it with 429 + failureClass
    // 'admission_limit' BEFORE anything runs — no provider was invoked and no
    // quota was spent, so the same body can be presented again later.
    // Classifying it terminally (statusCode >= 400 -> 'failed') made the queue
    // unusable for more than one task per provider: MAX_ACTIVE_PER_PROVIDER
    // defaults to 1, so five background 'claude' tasks left one 'done' and
    // four permanently 'failed' with "provider concurrency limit reached;
    // retry with backoff" — and each instant rejection freed the slot that
    // pulled the next task into the same rejection. /api/broadcast already
    // retries this exact rejection on a bounded loop.
    // Returns true when the task went back on the queue instead of settling.
    const requeueForAdmission = () => {
      const current = read(task.id) || task;
      if (TERMINAL.has(current.status)) return true;   // cancelled meanwhile: leave it terminal
      const waitingSince = Number(current.admissionWaitingSince) || Date.now();
      if (Date.now() - waitingSince >= admissionWaitMs) return false;   // waited long enough; report the rejection
      const waits = (Number(current.admissionWaits) || 0) + 1;
      write({
        ...current,
        status: 'queued',
        startedAt: null,
        admissionWaits: waits,
        admissionWaitingSince: waitingSince,
      });
      if (waits === 1) log(`[RelayBridge] tasks: ${current.id} is waiting for a ${current.kind} seat (provider concurrency limit)`);
      // Exponential with a ceiling. Every attempt costs a pre-admission
      // receipt in server.js, so a task waiting out a long run must not poll
      // for a seat once a second for the whole hour.
      const backoff = Math.min(ADMISSION_BACKOFF_MAX_MS,
        Math.round(ADMISSION_BACKOFF_MIN_MS * Math.pow(1.7, waits - 1)));
      const timer = setTimeout(() => { pending.push(current.id); pump(); }, backoff);
      if (typeof timer.unref === 'function') timer.unref();
      return true;
    };

    try {
      await new Promise((resolve) => {
        const res = captureResponse((payload, statusCode) => {
          if (statusCode === 429 && payload?.failureClass === 'admission_limit' && requeueForAdmission()) {
            resolve();
            return;
          }
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
            failureClass: payload?.failureClass || null,
            retryAfterSec: Number.isFinite(Number(payload?.retry_after))
              ? Math.max(0, Number(payload.retry_after)) : null,
            retryAt: Number.isSafeInteger(Number(payload?.retry_at))
              ? Math.max(0, Number(payload.retry_at)) : null,
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

  function submitInternal(input, reservedId = null) {
    const prompt = clamp(input?.prompt, MAX_PROMPT_CHARS);
    if (!prompt.trim()) throw new Error('prompt is required');
    if (!input?.kind) throw new Error('kind (provider id) is required');

    const id = reservedId == null ? newTaskId() : String(reservedId);
    const reservedPath = taskPath(id);
    if (fs.existsSync(reservedPath)) throw new Error('task id already exists');
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
        // Preserve the direct one-shot execution contract exactly. Validation
        // remains owned by executeOneShot (and the HTTP/MCP admission layer),
        // so an invalid explicit value must fail closed rather than disappear
        // while queued and silently fall back to a default.
        providerBudget: input.providerBudget,
        budgetTaskTier: input.budgetTaskTier,
        taskTier: input.taskTier,
        modelTier: input.modelTier,
        effort: input.effort,
        maxEffortOverride: input.maxEffortOverride,
        groundingOverride: input.groundingOverride,
        user: input.user || undefined,
        intent: input.intent || undefined,
      },
    });

    pending.push(id);
    setImmediate(pump);
    return task;
  }

  function submit(input) {
    return submitInternal(input);
  }

  // Workflow orchestration binds this ID to its writer lease before the task
  // becomes runnable. That ordering closes the crash window where a dangerous
  // provider task existed durably but the workflow did not yet know its ID.
  function submitReserved(id, input) {
    return submitInternal(input, id);
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
    const cancelled = write({
      ...task,
      status: 'cancelled',
      finishedAt: Date.now(),
      error: task.status === 'running'
        ? 'cancelled while running; the provider process may still be finishing'
        : 'cancelled before it started',
    });
    // The collab thread must be told here, not by settle(): settle() refuses to
    // touch an already-terminal task (so a late provider answer cannot
    // resurrect a cancelled one), which meant a cancelled collab-linked task
    // appended nothing at all and the conversation read as if the question had
    // never been asked.
    appendToCollab(cancelled);
    return cancelled;
  }

  function stats() {
    return { active, queued: pending.length, maxConcurrent };
  }

  reconcileOnStartup();

  return { submit, submitReserved, get: read, list, cancel, stats, reconcileOnStartup, newTaskId, _pump: pump };
}

module.exports = { createTaskQueue, newTaskId, MAX_RESULT_CHARS };
