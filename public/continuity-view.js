(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RelayBridgeContinuityView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function createSettingsState() {
    let revision = 0, savedRevision = 0, saving = null;
    return {
      edit() { revision++; },
      get dirty() { return revision !== savedRevision; },
      get saving() { return saving !== null; },
      get canHydrate() { return saving === null && revision === savedRevision; },
      beginSave() { if (saving !== null) return null; saving = { revision }; return saving; },
      finishSave(ticket, success) {
        if (ticket !== saving || !ticket) return false;
        if (success) savedRevision = ticket.revision;
        saving = null; return true;
      },
    };
  }
  function progressCounts(counts = {}) {
    return [['assistantUpdates', 'update'], ['toolsStarted', 'tool started', 'tools started'],
      ['toolsCompleted', 'tool completed', 'tools completed'], ['toolsFailed', 'tool failed', 'tools failed'], ['retries', 'retry', 'retries']]
      .map(([key, singular, plural]) => { const n = Number.isSafeInteger(counts[key]) && counts[key] >= 0 ? counts[key] : 0;
        return n ? `${n} ${n === 1 ? singular : plural || singular + 's'}` : null; }).filter(Boolean).join(' · ') || 'No structured progress observed yet';
  }
  function assessmentLabel(assessor = {}) {
    if (assessor.enabled === false || assessor.state === 'assessor_disabled') return 'Progress assessment off';
    if (assessor.stale) return 'Earlier assessment is stale; newer work observed';
    const states = { not_due: 'Observing progress', deferred_progress: 'Recent progress; assessment deferred',
      queued: 'Progress assessment in progress', waiting_for_assessor: 'Waiting for the current assessment to finish',
      unavailable_capacity: 'Assessment waiting for capacity', unavailable_headroom: 'Assessment needs fresh available allowance',
      unavailable_evidence_bound: 'Progress evidence exceeds the assessment limit', exhausted_until_progress: 'Assessment allowance used; waiting for new progress',
      unknown: 'Assessment inconclusive; work continues', obsolete: 'Previous assessment retired', assessed: 'Progress assessed' };
    if (assessor.state === 'assessed' && assessor.verdict) return ({ productive: 'Assessment: making progress',
      stuck: 'Assessment: possible stall', off_scope: 'Assessment: may be outside the task', unknown: 'Assessment inconclusive; work continues' })[assessor.verdict.verdict] || states.assessed;
    return states[assessor.state] || 'Observing progress';
  }
  return { createSettingsState, progressCounts, assessmentLabel };
});
