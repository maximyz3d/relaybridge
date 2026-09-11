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
const { sanitizeText, taskFailureDetails } = require('./incident-log');
const { deliveryRecord, sanitizeResult, resultProjection, acknowledgeResult } = require('./result-delivery');

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
 * @param {function} [opts.onFailure]      (task) => void | Promise; diagnostic only
 * @param {function} [opts.log]
 */
function createTaskQueue(opts) {
  const dir = opts.dataDir;
  const log = opts.log || (() => {});
  const maxConcurrent = Math.max(1, Number(opts.maxConcurrent) || 3);
  const admissionWaitMs = Number(opts.admissionWaitMs) > 0 ? Number(opts.admissionWaitMs) : ADMISSION_WAIT_MS;
  fs.mkdirSync(dir, { recursive: true });

  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const later = opts.setTimeout || setTimeout;
  const clearLater = opts.clearTimeout || clearTimeout;
  const backlog = new Map();   // all queued work, including deferred/blocked work
  const inFlight = new Set();
  const uncertain = new Set(); // reservations; absence of activity is not termination
  let active = 0;
  let stopped = false;
  let reconciledStartup = false;
  let wakeTimer = null;


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
    if (task.status === 'queued') backlog.set(task.id, structuredClone(task));
    else backlog.delete(task.id);
    return task;
  }

  function read(id) {
    const fp = taskPath(id);
    if (!fs.existsSync(fp)) return null;
    try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
  }

  // Diagnostics must never change execution or turn a durable failure into a
  // success. Give the sink a copy, contain both sync and async failures, and do
  // not log its exception text (which may itself contain provider secrets).
  function reportFailure(task) {
    if (!['failed', 'interrupted'].includes(task.status) || typeof opts.onFailure !== 'function') return;
    const sinkFailed = () => {
      try { log(`[RelayBridge] tasks: diagnostic sink failed for ${task.id}`); } catch { /* diagnostic only */ }
    };
    try {
      Promise.resolve(opts.onFailure(JSON.parse(JSON.stringify(task)))).catch(sinkFailed);
    } catch { sinkFailed(); }
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
          resultChars: t.result ? t.result.length : 0, error: t.error ? sanitizeText(t.error) : null,
          failureClass: t.failureClass || null,
          explanation: ['failed', 'interrupted'].includes(t.status) ? taskFailureDetails(t).summary : null,
          nextAction: ['failed', 'interrupted'].includes(t.status) ? taskFailureDetails(t).nextAction : null,
          correlation: t.correlation || null, requirementIds: t.requirementIds || [],
          nextAttemptAt: t.nextAttemptAt ?? null, dependsOn: t.dependsOn || [],
          execution: t.execution || null,
          queueReason: t.status === 'queued' ? (dependencyState(t)
            || (t.nextAttemptAt > now() ? 'deferred' : 'ready')) : null,
        });
      } catch { /* skip unreadable task */ }
    }
    tasks.sort((a, b) => b.createdAt - a.createdAt);
    return tasks;
  }

  // Recovery is opt-in at both submission and the trusted queue owner. An
  // operator-supplied task flag alone cannot authorize execution after restart.
  function recoveryProof(task) {
    if (typeof opts.authorizeRecovery !== 'function') return null;
    try {
      const proof = opts.authorizeRecovery(JSON.parse(JSON.stringify(task)));
      if (proof?.authorized === true && proof.ownerFenced === true
        && typeof proof.actor === 'string' && proof.actor.trim()
        && typeof proof.evidenceId === 'string' && proof.evidenceId.trim()) {
        return { actor: sanitizeText(proof.actor, 120), evidenceId: sanitizeText(proof.evidenceId, 200), at: now() };
      }
    } catch { /* missing, partial or failed proof never authorizes recovery */ }
    return null;
  }

  function reconcileOnStartup() {
    if (reconciledStartup) return [];
    reconciledStartup = true;
    const reconciled = [];
    for (const name of fs.readdirSync(dir).filter((n) => /^t_[A-Za-z0-9_]+\.json$/.test(n))) {
      let task;
      try { task = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); }
      catch { continue; }
      if (!task || typeof task !== 'object' || Array.isArray(task)
        || name !== `${task.id}.json`) continue;
      const waiting = task.status === 'queued';
      const interrupted = task.status === 'running' || waiting;
      const mayBeLive = task.execution?.state === 'in_flight' || task.execution?.state === 'uncertain'
        || task.status === 'running'
        || (task.status === 'interrupted' && !['fenced', 'never_started', 'not_invoked', 'settled'].includes(task.execution?.state))
        || (task.status === 'cancelled' && task.startedAt != null && !['fenced', 'not_invoked', 'settled'].includes(task.execution?.state));
      if (!interrupted && !mayBeLive) continue;
      const proof = recoveryProof(task);
      const eligible = waiting && task.schemaVersion === 2 && task.recovery?.mode === 'never-started'
        && task.recovery.actor && task.recovery.evidenceId && task.body?.dangerous === false
        && task.startedAt == null && ['never_started', 'not_invoked'].includes(task.execution?.state)
        && Array.isArray(task.dependsOn) && task.dependsOn.length <= 64
        && task.dependsOn.every((id) => typeof id === 'string' && /^t_[A-Za-z0-9_]+$/.test(id) && id !== task.id)
        && new Set(task.dependsOn).size === task.dependsOn.length
        && Number.isSafeInteger(task.createdAt) && task.createdAt >= 0
        && Number.isSafeInteger(task.nextAttemptAt) && task.nextAttemptAt >= 0
        && typeof task.body.prompt === 'string' && task.body.prompt.trim() && task.body.kind === task.kind;
      if (eligible && proof) {
        write({ ...task, recovery: { ...task.recovery, lastRecovery: proof } });
        continue;
      }
      if (mayBeLive && !proof) uncertain.add(task.id);
      if (interrupted) {
        task = write({ ...task, status: 'interrupted', failureClass: 'interrupted',
          execution: { ...task.execution, state: proof ? 'fenced' : mayBeLive ? 'uncertain' : 'never_started',
            ...(proof ? { proof } : {}) },
          error: 'the bridge restarted; inspect execution evidence before deciding whether to resubmit',
          finishedAt: now() });
        reportFailure(task);
        appendToCollab(task);
        reconciled.push(task.id);
      } else if (proof) {
        write({ ...task, execution: { ...task.execution, state: 'fenced', proof } });
      }
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
        ts: now(), taskId: task.id, role: 'assistant', speaker: task.kind,
        text: task.status === 'done' ? clamp(task.result || '', 20000)
          : sanitizeText(taskFailureDetails(task).summary + ' ' + (taskFailureDetails(task).nextAction || '')),
        failureClass: task.failureClass || null,
        correlation: task.correlation || null,
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
    res.end = () => res.json(null);
    // A handler that throws before responding must still release the slot, and
    // must present itself as abandoned rather than answered (see finish()).
    res.__abort = () => { res.destroyed = true; finish({ ended: false }); };
    return res;
  }

  function dependencyState(task) {
    for (const id of task.dependsOn || []) {
      const dependency = read(id);
      if (!dependency) return 'dependency_missing';
      if (TERMINAL.has(dependency.status) && dependency.status !== 'done') return 'dependency_failed';
      if (dependency.status !== 'done') return 'dependency';
    }
    return null;
  }

  function scheduleWake() {
    if (wakeTimer !== null) clearLater(wakeTimer);
    wakeTimer = null;
    if (stopped) return;
    const due = [];
    for (const task of backlog.values()) {
      if (!dependencyState(task) && task.nextAttemptAt > now()) due.push(task.nextAttemptAt);
      // A due retry may be waiting behind an occupied slot. Its absolute
      // deadline still needs a timer even when no execution callback arrives.
      if (task.admissionDeadlineAt > now()) due.push(task.admissionDeadlineAt);
    }
    if (due.length) {
      wakeTimer = later(() => { wakeTimer = null; pump(); }, Math.min(2147483647, Math.max(1, Math.min(...due) - now())));
      wakeTimer?.unref?.();
    }
  }

  function pump() {
    if (stopped) return;
    // Stable age order protects a due retry from an endless stream of new work.
    for (const task of [...backlog.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      if (inFlight.has(task.id)) continue;
      if (task.admissionDeadlineAt != null && now() >= task.admissionDeadlineAt) {
        const failed = write({ ...task, status: 'failed', failureClass: 'admission_limit',
          receiptId: task.admission?.receiptId || null,
          error: 'provider admission wait deadline expired', finishedAt: now() });
        reportFailure(failed);
        appendToCollab(failed);
        continue;
      }
      const blocked = dependencyState(task);
      if (blocked === 'dependency_failed') {
        const failed = write({ ...task, status: 'failed', failureClass: blocked,
          error: 'a required task did not complete successfully', finishedAt: now() });
        reportFailure(failed);
        appendToCollab(failed);
        continue;
      }
      if (blocked || task.nextAttemptAt > now() || active + uncertain.size >= maxConcurrent) continue;
      inFlight.add(task.id);
      active += 1;
      runTask(task).catch(() => { uncertain.add(task.id); }).finally(() => {
        inFlight.delete(task.id);
        active -= 1;
        if (!stopped) setImmediate(pump);
      });
    }
    scheduleWake();
  }

  function shutdown() {
    stopped = true;
    if (wakeTimer !== null) clearLater(wakeTimer);
    wakeTimer = null;
    // Preserve durable waits and live reservations. Shutdown does not kill a provider.
    return stats();
  }

  function confirmStopped(id) {
    const task = read(id);
    if (!task) throw new Error('task not found');
    if (inFlight.has(id)) throw new Error('execution callback is still in flight');
    if (!TERMINAL.has(task.status)) throw new Error('only a terminal uncertain task can be fenced');
    const proof = recoveryProof(task);
    if (!proof) throw new Error('authoritative execution fencing evidence is required');
    const confirmed = write({ ...task, execution: { ...task.execution, state: 'fenced', proof } });
    uncertain.delete(id);
    if (!stopped) setImmediate(pump);
    return confirmed;
  }

  async function runTask(task) {
    task.status = 'running';
    task.startedAt = now();
    task.execution = { state: 'in_flight', dispatchedAt: now() };
    write(task);

    const settle = (patch) => {
      const current = read(task.id) || task;
      // A cancel that landed while the run was in flight wins: don't resurrect it.
      if (TERMINAL.has(current.status)) {
        // Preserve cancellation intent while recording a late executor response.
        return patch.execution ? write({ ...current, execution: patch.execution }) : current;
      }
      const finished = { ...current, ...patch, finishedAt: now() };
      write(finished);
      reportFailure(finished);
      appendToCollab(finished);
      return finished;
    };

    // A denied admission is not a task failure: it is precisely the condition a
    // queue exists to wait out. server.js answers it with 429 + failureClass
    // 'admission_limit' BEFORE anything runs — no provider was invoked and no
    // quota was spent, so the same body can be presented again later.
    // Classifying it terminally (statusCode >= 400 -> 'failed') made the queue
    // unusable for more than one task per provider: MAX_ACTIVE_PER_PROVIDER
    // formerly defaulted to 1, so five background 'claude' tasks left one 'done' and
    // four permanently 'failed' with "provider concurrency limit reached;
    // retry with backoff" — and each instant rejection freed the slot that
    // pulled the next task into the same rejection. /api/broadcast already
    // retries this exact rejection on a bounded loop.
    // Returns true when the task went back on the queue instead of settling.
    const requeueForAdmission = (payload) => {
      const current = read(task.id) || task;
      if (TERMINAL.has(current.status)) {
        write({ ...current, execution: { state: 'not_invoked', receiptId: payload.receiptId || null } });
        return true;
      }
      const waitingSince = current.admissionWaitingSince ?? now();
      if (now() >= (current.admissionDeadlineAt ?? waitingSince + admissionWaitMs)) return false;   // waited long enough; report the rejection
      const waits = (Number(current.admissionWaits) || 0) + 1;
      const backoff = Math.min(ADMISSION_BACKOFF_MAX_MS,
        Math.round(ADMISSION_BACKOFF_MIN_MS * Math.pow(1.7, Math.min(waits - 1, 20))));
      write({
        ...current, status: 'queued', startedAt: null,
        admissionWaits: waits, admissionWaitingSince: waitingSince,
        admissionDeadlineAt: current.admissionDeadlineAt ?? waitingSince + admissionWaitMs,
        nextAttemptAt: Math.min(current.admissionDeadlineAt ?? waitingSince + admissionWaitMs, now() + backoff),
        execution: { state: 'not_invoked', receiptId: payload.receiptId || null },
        admission: { classification: 'admission_limit', receiptId: payload.receiptId || null },
      });
      if (waits === 1) log(`[RelayBridge] tasks: ${current.id} is waiting for a ${current.kind} seat (provider concurrency limit)`);
      return true;
    };

    try {
      await new Promise((resolve) => {
        const res = captureResponse((payload, statusCode) => {
          if (statusCode === 429 && payload?.failureClass === 'admission_limit'
            && payload?.model_invocation === false && payload?.modelInvocation !== true
            && !(Number(payload?.physicalAttemptCount) > 0) && requeueForAdmission(payload)) {
            resolve();
            return;
          }
          const text = payload?.stdout ?? payload?.text ?? '';
          // HTTP 200 only means the handler answered. Provider execution may
          // still have failed, or returned a partial checkpoint with no verdict.
          const nonzeroExit = payload?.exitCode != null && Number(payload.exitCode) !== 0;
          const noOutput = !String(text).trim();
          const failed = statusCode >= 400 || nonzeroExit || noOutput
            || payload?.auth_failed || payload?.dropped_out || payload?.budget_exceeded
            || payload?.timed_out || payload?.rate_limited || payload?.permission_denied
            || payload?.partial_result || payload?.failureClass || payload?.error || payload?.ok === false;
          const failureClass = payload?.failureClass || (failed ? (
            payload?.budget_exceeded ? 'budget' : payload?.timed_out ? 'timeout'
              : payload?.auth_failed ? 'auth' : payload?.rate_limited ? 'rate_limit'
                : payload?.permission_denied ? 'permission_denied'
                  : nonzeroExit ? 'provider_exit' : statusCode >= 400 ? 'http_error'
                    : payload?.partial_result || noOutput ? 'no_verdict' : 'provider_failure'
          ) : null);
          const delivered = task.delivery ? sanitizeResult(payload, failed, task) : null;
          settle({
            status: failed ? 'failed' : 'done',
            execution: { state: payload?.model_invocation === false ? 'not_invoked' : 'settled',
              settledAt: now(), receiptId: payload?.receiptId || null },
            result: delivered ? delivered.text : clamp(text, MAX_RESULT_CHARS),
            ...(delivered ? { resultEnvelope: delivered.metadata } : {}),
            stderr: clamp(payload?.stderr || '', 20000),
            exitCode: payload?.exitCode ?? null,
            route: payload?.route || null,
            usage: payload?.usage || null,
            receiptId: payload?.receiptId || null,
            correlation: { ...task.correlation,
              requestId: payload?.requestId || payload?.route?.request_id || task.correlation?.requestId || null,
              invocationId: payload?.invocationId || payload?.route?.invocation_id || task.correlation?.invocationId || null,
              attemptId: payload?.attemptId || payload?.route?.attempt_id || task.correlation?.attemptId || null },
            failureClass,
            stopReason: payload?.stop_reason || null,
            stopDetail: clamp(payload?.stop_detail || '', 20000),
            partialCheckpoint: sanitizeText(payload?.partial_checkpoint || '', 12000),
            gracefulFinalization: payload?.graceful_finalization || null,
            writerDiffSummary: payload?.writer_diff_summary || null,
            continuity: payload?.continuity || null,
            providerMetadata: Object.fromEntries(['provider_run_id', 'token_usage_source', 'physical_attempt_count',
              'provider_terminal_reason', 'provider_stop_reason', 'supervisor_stop_reason', 'stop_detail',
              'provider_retries', 'vendor_quota', 'quota_evidence', 'provider_budget', 'provider_budget_enforcement',
              'provider_api_error_status', 'provider_num_turns', 'graceful_finalization', 'partial_checkpoint',
              'partial_checkpoint_hash', 'partial_checkpoint_bytes', 'partial_checkpoint_original_bytes',
              'partial_checkpoint_truncated', 'partial_checkpoint_event_type', 'partial_checkpoint_message_id_hash',
              'partial_checkpoint_unavailable_reason', 'partial_checkpoint_selection_reason', 'writer_diff_summary',
              'transport_lifecycle', 'result_subtype', 'continuity', 'grounding',
              'model_invocation', 'provider_diagnostic_chars', 'provider_diagnostic_hash', 'provider_terminal_compatibility',
              'provider_permission_denials', 'provider_duration_ms', 'provider_api_duration_ms', 'provider_error_count',
              'provider_error_observed', 'provider_error_invalid', 'provider_error_diagnostic_truncated',
              'transport_output_chars', 'transport_output_hash', 'transport_diagnostic_code', 'provider_action_required',
              'provider_timeout_source', 'result_schema_disagreement', 'output_detector', 'failure_sentinel',
              'partial_diagnostic', 'partial_diagnostic_truncated', 'failure_sentinel_source',
              'progress_at_cancellation', 'cleaned_output_unavailable', 'cleaned_output_unavailable_reason',
              'cooldown', 'retry_at', 'retry_after', 'receiptPersisted', 'receiptPersistenceError']
              .filter((key) => payload?.[key] !== undefined).map((key) => [key, payload[key]])),
            retryAfterSec: Number.isFinite(Number(payload?.retry_after))
              ? Math.max(0, Number(payload.retry_after)) : null,
            retryAt: Number.isSafeInteger(Number(payload?.retry_at))
              ? Math.max(0, Number(payload.retry_at)) : null,
            error: failed ? (payload?.error || payload?.stop_detail
              || (nonzeroExit ? `provider exited with code ${payload.exitCode}` : `provider returned no successful result (${failureClass})`)) : null,
            flags: {
              cancelled: !!payload?.cancelled,
              rate_limited: !!payload?.rate_limited,
              budget_exceeded: !!payload?.budget_exceeded,
              auth_failed: !!payload?.auth_failed,
              timed_out: !!payload?.timed_out,
              dropped_out: !!payload?.dropped_out,
              permission_denied: !!payload?.permission_denied,
              partial_result: !!payload?.partial_result,
            },
          });
          resolve();
        });
        Promise.resolve().then(() => opts.executeOneShot(task.body, res))
          .then(() => {
            // HTTP adapters await their response, while CLI providers return
            // after registering child-process callbacks and answer later.
            // Only the latter explicitly marks the response as deferred; an
            // unmarked handler that returns silently is still a real bug.
            if (!res.writableEnded && !res._relayDeferredResponse) {
              res.__abort();
              uncertain.add(task.id);
              settle({ status: 'failed', failureClass: 'empty_output', execution: { state: 'uncertain' },
                error: 'provider handler returned without a response' });
              resolve();
            }
          })
          .catch((err) => {
            if (res.__finished) { resolve(); return; }
            res.__abort();
            uncertain.add(task.id);
            settle({ status: 'failed', execution: { state: 'uncertain' }, error: err.message });
            resolve();
          });
      });
    } catch (err) {
      uncertain.add(task.id);
      settle({ status: 'failed', execution: { state: 'uncertain' }, error: err.message });
    }
    return read(task.id);
  }

  function submitInternal(input, reservedId = null, delivery = null) {
    if (stopped) throw new Error('task queue is shut down');
    const prompt = clamp(input?.prompt, MAX_PROMPT_CHARS);
    if (!prompt.trim()) throw new Error('prompt is required');
    if (!input?.kind) throw new Error('kind (provider id) is required');

    const id = reservedId == null ? newTaskId() : String(reservedId);
    const reservedPath = taskPath(id);
    if (fs.existsSync(reservedPath)) throw new Error('task id already exists');
    const dependsOn = input.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.length > 64 || new Set(dependsOn).size !== dependsOn.length) {
      throw new Error('dependsOn must contain at most 64 distinct task ids');
    }
    for (const dependency of dependsOn) {
      if (dependency === id || !read(dependency)) throw new Error('dependencies must reference existing tasks');
    }
    const nextAttemptAt = input.notBefore ?? now();
    if (!Number.isSafeInteger(nextAttemptAt) || nextAttemptAt < 0) throw new Error('notBefore must be an epoch millisecond timestamp');
    let recovery = null;
    if (input.recovery != null) {
      if (input.recovery.mode !== 'never-started' || input.dangerous
        || typeof input.recovery.actor !== 'string' || !input.recovery.actor.trim()
        || typeof input.recovery.evidenceId !== 'string' || !input.recovery.evidenceId.trim()) {
        throw new Error('recovery requires never-started read-only work and explicit actor/evidenceId');
      }
      recovery = { mode: 'never-started', actor: sanitizeText(input.recovery.actor, 120),
        evidenceId: sanitizeText(input.recovery.evidenceId, 200) };
    }
    const task = write({
      ...(delivery ? { delivery } : {}),
      correlation: Object.fromEntries(['requestId', 'runId', 'invocationId', 'attemptId', 'contractId', 'delegationId'].map((key) =>
        [key, sanitizeText(input.correlation?.[key] ?? (key === 'requestId' ? input.requestId : ''), 200) || null])),
      requirementIds: Array.isArray(input.requirementIds) ? [...new Set(input.requirementIds.map((id) => sanitizeText(id, 120)).filter(Boolean))].slice(0, 64) : [],
      schemaVersion: 2, dependsOn: [...dependsOn], nextAttemptAt, recovery,
      execution: { state: 'never_started' },
      id,
      status: 'queued',
      kind: String(input.kind),
      user: input.user ? String(input.user).slice(0, 64) : null,
      collab: input.collab ? String(input.collab).slice(0, 64) : null,
      title: clamp(input.title || prompt.split('\n')[0], 120),
      source: input.source ? String(input.source).slice(0, 32) : 'api',
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
      // Preserved so the run is reproducible and so executeOneShot sees the
      // same shape it would from a direct POST.
      body: {
        kind: String(input.kind),
        requestId: input.requestId,
        expectedCwdIdentityHash: input.expectedCwdIdentityHash,
        expectedCwdPolicyId: input.expectedCwdPolicyId,
        expectedPromptHash: input.expectedPromptHash,
        outerReceiptId: input.outerReceiptId,
        _relayClient: input._relayClient,
        prompt,
        cwd: input.cwd || undefined,
        dangerous: !!input.dangerous,
        // Preserve the direct one-shot execution contract exactly. Validation
        // remains owned by executeOneShot (and the HTTP/MCP admission layer),
        // so an invalid explicit value must fail closed rather than disappear
        // while queued and silently fall back to a default.
        providerBudget: input.providerBudget,
        timeoutMs: input.timeoutMs,
        continuityId: input.continuityId,
        continuityEpoch: input.continuityEpoch,
        expectedQuotaSeat: input.expectedQuotaSeat,
        expectedAccountId: input.expectedAccountId,
        requireFreshUsage: input.requireFreshUsage,
        budgetTaskTier: input.budgetTaskTier,
        taskTier: input.taskTier,
      modelTier: input.modelTier,
      model: input.model,
      execution: input.execution,
        effort: input.effort,
        maxEffortOverride: input.maxEffortOverride,
        groundingOverride: input.groundingOverride,
        requiresWorkspaceAccess: input.requiresWorkspaceAccess,
        inlineEvidence: input.inlineEvidence,
        user: input.user || undefined,
        intent: input.intent || undefined,
      },
    });

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

  function submitDurable(id, input) {
    if (typeof id !== 'string' || !/^t_[A-Za-z0-9_]{1,120}$/.test(id)) {
      throw Object.assign(new Error('queued delivery requires a bounded caller-known taskId'), { code: 'INVALID_DELIVERY' });
    }
    if (typeof input?.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > MAX_PROMPT_CHARS) {
      throw Object.assign(new Error('queued delivery requires a complete prompt within 100000 characters'), { code: 'INVALID_DELIVERY' });
    }
    const requestId = input.requestId === undefined ? `queued:${id}` : input.requestId;
    if (requestId !== `queued:${id}`
      || (input.correlation?.requestId != null && input.correlation.requestId !== requestId)
      || (input.correlation?.invocationId != null && input.correlation.invocationId !== requestId)
      || (input.correlation?.attemptId != null && input.correlation.attemptId !== `${requestId}:attempt:1`)) {
      throw Object.assign(new Error('queued delivery requires canonical request and attempt identities'), { code: 'INVALID_DELIVERY' });
    }
    const intent = { ...input, requestId };
    const delivery = deliveryRecord(intent, opts.receiptStoreId);
    const existing = read(id);
    if (existing) {
      resultProjection(existing, opts.receiptStoreId, id);
      if (existing.delivery?.intentHash !== delivery.intentHash || existing.delivery.receiptStoreId !== delivery.receiptStoreId) {
        throw Object.assign(new Error('taskId already identifies different submitted intent'), { code: 'TASK_INTENT_CONFLICT' });
      }
      return existing; // Never replay, even if the existing task was cancelled.
    }
    if (uncertain.size >= maxConcurrent) {
      throw Object.assign(new Error('unverified execution reservations block new queued delivery'), { code: 'QUEUE_EXECUTION_UNCERTAIN' });
    }
    return submitInternal(intent, id, delivery);
  }

  function getResult(id) { return resultProjection(read(id), opts.receiptStoreId, id); }
  function acknowledge(id, input) {
    const task = read(id);
    resultProjection(task, opts.receiptStoreId, id);
    const next = acknowledgeResult(task, input, opts.receiptStoreId, now());
    if (next !== task) write(next);
    return resultProjection(next, opts.receiptStoreId);
  }

  function cancel(id) {
    const task = read(id);
    if (!task) throw new Error('task not found');
    if (TERMINAL.has(task.status)) return task;
    // Queued tasks are cancelled cleanly. A running task's child process is
    // owned by the supervisor, so this marks intent and stops the result being
    // recorded — it does not claim to have killed the process.

    const cancelled = write({
      ...task,
      status: 'cancelled',
      finishedAt: now(),
      error: task.status === 'running'
        ? 'cancelled while running; the provider process may still be finishing'
        : 'cancelled before it started',
    });
    // The collab thread must be told here, not by settle(): settle() refuses to
    // touch an already-terminal task (so a late provider answer cannot
    // resurrect a cancelled one), which meant a cancelled collab-linked task
    // appended nothing at all and the conversation read as if the question had
    // never been asked.
    if (typeof opts.stopExecution === 'function') opts.stopExecution(task);
    appendToCollab(cancelled);
    scheduleWake();
    if (!stopped) setImmediate(pump);
    return cancelled;
  }

  function stats() {
    let ready = 0, deferred = 0, blocked = 0;
    for (const task of backlog.values()) {
      if (dependencyState(task)) blocked++;
      else if (task.nextAttemptAt > now()) deferred++;
      else ready++;
    }
    return { active, queued: ready + deferred + blocked, maxConcurrent, ready, deferred, blocked,
      uncertain: uncertain.size };

  }

  reconcileOnStartup();
  if (backlog.size) setImmediate(pump);

  return { submit, submitReserved, submitDurable, getResult, acknowledgeResult: acknowledge,
    get: read, list, cancel, stats, shutdown,
    unsettledInWorkspace(cwd) {
      return fs.readdirSync(dir).filter((name) => /^t_[A-Za-z0-9_]+\.json$/.test(name)).some((name) => {
        const task = read(name.slice(0, -5));
        if (!task) return false;
        // Queued work that has not been dispatched yet was still accepted for this
        // workspace: an external yield must not let unrelated new work race ahead
        // of it. A cancelled task has a terminal status (not 'queued') and stops
        // blocking immediately, even if it was never started.
        if (task.status !== 'queued' && !['in_flight', 'uncertain'].includes(task.execution?.state)) return false;
        if (!task.body?.cwd) return true; // Legacy unknown workspace cannot authorize a new owner.
        try { return fs.realpathSync(task.body.cwd) === cwd; } catch { return true; }
      });
    }, confirmStopped, reconcileOnStartup, newTaskId, _pump: pump };
}

module.exports = { createTaskQueue, newTaskId, MAX_RESULT_CHARS };
