(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RelayBridgeDashboardState = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const text = value => typeof value === 'string' ? value : '';
  const display = value => value === null ? 'unknown' : String(value);

  function queueStatsModel(stats = {}) {
    const values = Object.fromEntries(['active', 'queued', 'ready', 'deferred', 'blocked', 'uncertain', 'maxConcurrent']
      .map(key => [key, count(stats[key])]));
    const { active, uncertain, maxConcurrent } = values;
    const available = [active, uncertain, maxConcurrent].includes(null)
      ? null : Math.max(0, maxConcurrent - active - uncertain);
    return { ...values, available,
      summary: `${display(active)} running · ${display(values.queued)} queued · ${display(uncertain)} held · limit ${display(maxConcurrent)}`,
      detail: `${display(values.ready)} ready · ${display(values.deferred)} deferred · ${display(values.blocked)} waiting on dependencies`,
      notice: uncertain > 0
        ? `${uncertain} execution${uncertain === 1 ? '' : 's'} with unverified termination ${uncertain === 1 ? 'holds' : 'hold'} capacity. ${available === null ? 'Available capacity is unknown.' : `${available} slot${available === 1 ? '' : 's'} available.`} An independent ownership check is required before release.`
        : uncertain === null ? 'Held capacity is unknown; refresh to obtain queue evidence.' : '',
    };
  }

  function queueReasonModel(task = {}) {
    const reason = typeof task.queueReason === 'string' ? task.queueReason : task.queueReason?.kind;
    const labels = { ready: 'Ready to run', deferred: 'Deferred until the scheduled retry',
      dependency: 'Waiting for dependencies', dependency_missing: 'A dependency is missing',
      dependency_failed: 'A dependency did not succeed', admission: 'Waiting for provider admission' };
    if (task.execution?.state === 'uncertain' || task.execution?.state === 'in_flight' && task.status !== 'running') {
      return 'Termination unverified · capacity held';
    }
    return labels[reason] || (task.status === 'queued' ? 'Queued · eligibility pending' : text(reason));
  }

  function executionStateModel(task = {}) {
    const state = task.execution?.state;
    return { state: text(state) || 'unknown', label: ({ never_started: 'Not started', in_flight: 'Execution in flight',
      not_invoked: 'Provider was not invoked', uncertain: 'Termination unverified · capacity held', fenced: 'Stopped with recorded fencing proof',
      settled: 'Execution settled' })[state] || 'Execution ownership unknown' };
  }

  function taskRowModel(task = {}) {
    return { id: text(task.id), title: text(task.title) || text(task.id), kind: text(task.kind),
      status: text(task.status) || 'unknown', reason: queueReasonModel(task),
      createdAt: Number.isFinite(task.createdAt) ? task.createdAt : null,
      nextAttemptAt: Number.isFinite(task.nextAttemptAt) ? task.nextAttemptAt : null,
      canCancel: ['queued', 'running'].includes(task.status),
    };
  }

  function taskDetailModel(task = {}, summary = {}) {
    const merged = { ...summary, ...task };
    const output = text(task.result);
    const retainedChars = count(task.resultChars) ?? count(summary.resultChars) ?? output.length;
    const truncated = task.resultTruncated === true || task.truncated === true || retainedChars > output.length;
    const failed = ['failed', 'interrupted', 'cancelled'].includes(task.status)
      || !!task.failureClass || task.partialResult === true || task.flags?.partial_result === true;
    return { ...taskRowModel(merged), execution: executionStateModel(merged),
      output, error: text(task.error), explanation: text(task.explanation) || text(summary.explanation),
      nextAction: text(task.nextAction) || text(summary.nextAction), failureClass: text(task.failureClass),
      receiptId: text(task.receiptId), correlation: task.correlation || summary.correlation || {},
      dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : [],
      requirementIds: Array.isArray(task.requirementIds) ? task.requirementIds : [],
      exitCode: Number.isInteger(task.exitCode) ? task.exitCode : null,
      outputNotice: truncated ? `Showing ${output.length} retained characters; output was truncated or is incomplete.`
        : `Showing all ${output.length} characters retained by the bridge.`,
      verdictNotice: failed ? 'NO VERDICT — this task did not complete successfully. Retained output is diagnostic evidence.'
        : task.status === 'done' ? 'Task completed. Completion alone does not establish approval, merge or deployment.'
          : 'No completed result yet.',
    };
  }

  // Epochs reject late responses after close/reopen; requests reject older
  // refreshes. These are UI identities only, never execution or lease proof.
  function createRequestGate() {
    let epoch = 0, sequence = 0, open = false;
    return {
      open() { open = true; epoch++; sequence = 0; return epoch; },
      close() { open = false; epoch++; },
      begin() { return { epoch, sequence: ++sequence }; },
      current(ticket) { return open && ticket?.epoch === epoch && ticket?.sequence === sequence; },
      isOpen(expected) { return open && (expected === undefined || expected === epoch); },
    };
  }
  return { queueStatsModel, queueReasonModel, executionStateModel, taskRowModel, taskDetailModel, createRequestGate };
});
