(function(root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.WorkspaceState = factory(); })(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const labels = { idle:'Ready', queued:'Queued', running:'Working', consulting:'Consulting advisor', completed:'Completed', done:'Completed',
    planning:'Planning', scoping:'Preparing workflow', research_ready:'Preparing plan', plan_ready:'Ready for writer', awaiting_writer:'Ready for writer',
    implementing:'Implementing', implementation_ready:'Awaiting review', reviewing:'In review', review_ready:'Review ready', revising:'Revising', revision_ready:'Ready for final review',
    final_reviewing:'Final review', needs_attention:'Needs attention', waiting_for_quota:'Preserving usage reserve', failed:'Failed', cancelled:'Cancelled', interrupted:'Interrupted', uncertain:'Execution unverified' };
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
  return {status,taskGroups,currentWork,formatUsage,mergeSelection,duration};
});
