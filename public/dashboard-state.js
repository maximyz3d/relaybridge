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
  function qualitativeQuotaLabel(quota) { return quota?.kind === 'quota_exhausted' ? 'Quota exhausted; allowance unknown' : null; }

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

  const workflowActions = {
    submit_pipeline_research: { path:'research', label:'Submit research and run planner', evidence:true },
    claim_pipeline_implementation: { path:'implementation/claim', label:'Claim implementation lease', claim:true },
    complete_pipeline_implementation: { path:'implementation/complete', label:'Complete implementation and run review', evidence:true, token:true },
    reconcile_pipeline: { path:'reconcile', label:'Reconcile finished advisor task' },
    claim_pipeline_revision: { path:'revision/claim', label:'Claim external revision lease', claim:true, full:true },
    complete_pipeline_revision: { path:'revision/complete', label:'Store completed revision evidence', evidence:true, token:true },
    renew_pipeline_writer_lease: { path:'lease/renew', label:'Renew writer lease for 4 hours', token:true, renew:true },
    start_pipeline_final_review: { path:'final-review/start', label:'Run final review' },
  };
  function workflowDetailModel(snapshot = {}) {
    const workflow = snapshot.workflow || {}, lease = workflow.writerLease;
    const policy = workflow.phasePolicy;
    const astraPolicy = workflow.profile === 'codex-astra-ultra' && policy?.version === 1
      && ['planning', 'review', 'finalReview'].every(phase => policy[phase]?.provider === 'codex'
        && policy[phase].model === 'gpt-6-astra' && policy[phase].effort === 'ultra' && policy[phase].maxEffortOverride === true)
      && ['implementation', 'revision'].every(phase => policy[phase]?.provider === 'codex' && policy[phase].mode === 'external');
    return { runId:text(workflow.runId), phase:text(workflow.phase) || 'unknown',
      astraPolicy,
      profile:text(workflow.profile) || 'legacy', cwd:text(workflow.cwd), permissionMode:text(workflow.permissionMode),
      objective:text(snapshot.artifactContents?.objective),
      plan:text(snapshot.artifactContents?.plan), acceptance:text(snapshot.artifactContents?.acceptance),
      review:text(snapshot.artifactContents?.['final-review']) || text(snapshot.artifactContents?.review),
      writer:lease ? `${text(lease.actor) || 'unknown actor'} · ${text(lease.mode) || 'unknown ownership'}` : 'No recorded writer',
      expiresAt:count(lease?.expiresAt),
      notice:!astraPolicy ? 'This panel acts only on workflows with a verified Astra/ultra external-writer policy. Other workflows remain inspectable through their existing clients.'
        : workflow.phase === 'complete' ? 'Workflow review stages complete. Merge and deployment are separate.'
        : workflow.phase === 'revision_ready' ? 'Corrective evidence saved. A fresh final review is required.'
          : 'Planning, implementation evidence and review verdicts are separate stages.',
      blocked:Array.isArray(snapshot.blockedActions) ? snapshot.blockedActions.map(item => text(item.code)).filter(Boolean) : [],
      unsupportedActions:(Array.isArray(snapshot.nextActions) ? snapshot.nextActions : []).filter(name => typeof name === 'string' && !Object.hasOwn(workflowActions, name)),
      actions:(astraPolicy && Array.isArray(snapshot.nextActions) ? [...new Set(snapshot.nextActions)] : [])
        .filter(name => Object.hasOwn(workflowActions, name)).map(name => ({ name, ...workflowActions[name],
          blocked:workflowActions[name].full && workflow.permissionMode !== 'full'
            ? 'This workflow was created without filesystem-write acknowledgement.' : null })),
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
  return { queueStatsModel, queueReasonModel, executionStateModel, taskRowModel, taskDetailModel, workflowDetailModel, qualitativeQuotaLabel, createRequestGate };
});
