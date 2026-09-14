(function(root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.WorkspaceState = factory(); })(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const labels = { idle:'Ready', queued:'Queued', running:'Working', consulting:'Consulting advisor', completed:'Completed', done:'Completed',
    planning:'Planning', scoping:'Preparing workflow', research_ready:'Preparing plan', plan_ready:'Ready for writer', awaiting_writer:'Ready for writer',
    implementing:'Implementing', implementation_ready:'Awaiting review', reviewing:'In review', review_ready:'Review ready', revising:'Revising', revision_ready:'Ready for final review',
    final_reviewing:'Final review', needs_attention:'Needs attention', waiting_for_quota:'Preserving usage reserve', failed:'Failed', cancelled:'Cancelled', interrupted:'Interrupted', uncertain:'Execution unverified',
    partial:'Partial result', unavailable:'Not found by bridge', id_mismatch:'IDs disagree', result_unavailable:'Result not retained' };
  const active = new Set(['running','consulting','planning','implementing','reviewing','revising','final_reviewing']);
  const blocked = new Set(['needs_attention','waiting_for_quota','failed','interrupted','uncertain','cancelled']);
  function status(value) { return labels[value] || 'Pending'; }
  function taskGroups(tasks = []) { return { active:tasks.filter(t=>active.has(t.state)), queued:tasks.filter(t=>!active.has(t.state)&&!blocked.has(t.state)&&!['completed','done'].includes(t.state)), blocked:tasks.filter(t=>blocked.has(t.state)), completed:tasks.filter(t=>['completed','done'].includes(t.state)) }; }
  function currentWork(state) {
    const conversations=(state.activity || (state.thread?.queueTaskId?[state.thread]:[])).map(t=>({...t,threadId:t.id,conversationTitle:t.title,title:t.role==='advisor'?'Getting a second perspective':'Codex is shaping the next step'}));
    const groups=taskGroups([...conversations,...(state.tasks||[])]);
    return groups.active[0]||groups.blocked[0]||groups.queued[0]||null;
  }
  function formatUsage(usage) { return usage?.freshness==='fresh'&&typeof usage.percentRemaining==='number'&&Number.isFinite(usage.percentRemaining)?`${Math.round(usage.percentRemaining)}% remaining`:'Usage not reported'; }
  function mergeSelection(previous, incoming) { const projectId=incoming.projects?.some(p=>p.id===previous.projectId)?previous.projectId:incoming.project?.id||null; const threadId=incoming.threads?.some(t=>t.id===previous.threadId)?previous.threadId:incoming.thread?.id||null; return {...previous,projectId,threadId}; }
  function duration(ms) { if(!Number.isFinite(ms))return null; const s=Math.max(0,Math.floor(ms/1000)); return s<60?`${s}s`:s<3600?`${Math.floor(s/60)}m`:`${Math.floor(s/3600)}h ${Math.floor(s%3600/60)}m`; }
  // Attached existing calls: every string here describes bridge-resolved
  // metadata or caller-pasted text; neither is ever interpreted as markup.
  const reasons = { task_not_found:'No task with that ID is held by this bridge.', task_read_error:'The task record could not be read.',
    no_active_run:'No matching run is live now.', receipts_not_configured:'Receipt journals are not configured.',
    no_matching_receipt_in_scanned_window:'No matching receipt in the scanned receipt journals.',
    receipt_scan_limited:'Receipt scan was limited; older or oversized journals were not read.', resolution_error:'The bridge could not resolve this call.',
    queue_reports_running_without_live_progress:'The queue reports running, but no live progress is visible.',
    no_result_delivery_contract:'This task has no retained result delivery record.' };
  const hashChecks = { matches_bridge_result:'Matches the bridge-retained result hash', differs_from_bridge_result:'Differs from the bridge-retained result hash',
    matches_receipt_output:'Matches the receipt output hash', differs_from_receipt_output:'Differs from the receipt output hash',
    matches_bridge_request:'Matches the bridge-retained prompt hash', differs_from_bridge_request:'Differs from the bridge-retained prompt hash',
    matches_receipt_input:'Matches the receipt input hash (provider-effective prompt)', differs_from_receipt_input:'Differs from the receipt input hash (which covers the provider-effective prompt, not always the pasted request)',
    not_comparable:'No bridge hash to compare with' };
  const REF_LABELS = { requestId:'Request', taskId:'Task', runId:'Run', receiptId:'Receipt' };
  const MAX_ARTIFACT_BYTES = 200000;
  function reasonText(code) { return reasons[code] || code; }
  function hashCheckText(code) { return hashChecks[code] || 'Not compared'; }
  function refList(refs = {}) { return Object.keys(REF_LABELS).filter(k=>refs[k]).map(k=>`${REF_LABELS[k]} ${refs[k]}`); }
  function attachedCallSummary(call) {
    const v = call.verified || {}, source = { task:'bridge task record', active_run:'live bridge run', receipt:'bridge receipt' }[v.source] || 'no bridge record';
    return { title: call.label || refList(call.refs)[0] || call.id, state: v.displayState || 'unavailable', line: `${status(v.displayState || 'unavailable')} · ${source}`,
      callerTexts: (call.callerArtifacts || []).length };
  }
  function attachedCallsSignature(calls = []) { return JSON.stringify(calls.map(c=>[c.id,c.label,c.verified?.displayState,c.verified?.source,c.verified?.live?.bytes,(c.callerArtifacts||[]).length])); }
  function byteLength(text) { return typeof TextEncoder === 'function' ? new TextEncoder().encode(text).length : unescape(encodeURIComponent(text)).length; }
  function attachPayload(fields) {
    const body = { projectId: fields.projectId }, trim = (v) => String(v || '').trim();
    if (trim(fields.label)) body.label = trim(fields.label);
    for (const key of Object.keys(REF_LABELS)) if (trim(fields[key])) body[key] = trim(fields[key]);
    if (!Object.keys(REF_LABELS).some(k=>body[k])) throw new Error('Enter at least one request, task, run or receipt ID.');
    const artifacts = [];
    for (const role of ['request','result']) {
      const item = fields[role] || {}, text = String(item.text || '');
      if (!text.trim()) continue;
      const bytes = byteLength(text);
      if (bytes > MAX_ARTIFACT_BYTES) throw new Error(`The pasted ${role} text is ${bytes} bytes; the limit is ${MAX_ARTIFACT_BYTES} bytes.`);
      const artifact = { role, text };
      if (trim(item.sha256)) artifact.sha256 = trim(item.sha256);
      if (trim(item.source)) artifact.source = trim(item.source);
      if (item.truncated) artifact.truncated = true;
      // IDs the pasted text itself records; compared with, never merged into, bridge identity.
      const claimedIds = {}; for (const key of Object.keys(REF_LABELS)) if (trim(item.claimedIds?.[key])) claimedIds[key] = trim(item.claimedIds[key]);
      if (Object.keys(claimedIds).length) artifact.claimedIds = claimedIds;
      artifacts.push(artifact);
    }
    if (artifacts.length) body.artifacts = artifacts;
    return body;
  }
  return {status,taskGroups,currentWork,formatUsage,mergeSelection,duration,reasonText,hashCheckText,refList,attachedCallSummary,attachedCallsSignature,attachPayload,MAX_ARTIFACT_BYTES};
});
