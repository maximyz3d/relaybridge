'use strict';
(() => {
  const $ = (id) => document.getElementById(id), S = window.WorkspaceState;
  const readLocal = (key, fallback=null) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const writeLocal = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* server state remains authoritative */ } };
  const removeLocal = (key) => { try { localStorage.removeItem(key); } catch {} };
  let selection=readLocal('rb:workspace:selection',{}), state=null, token=null, loading=false, reload=false, epoch=0, offline=false;
  let pending=readLocal('rb:workspace:pending'), posting=false, messageThread=null, renderedMessages=new Set(), navSignature='', tasksSignature='';
  const theme=readLocal('rb:workspace:theme'); if(theme)document.documentElement.dataset.theme=theme;
  function el(tag, className, value) { const node=document.createElement(tag); if(className)node.className=className; if(value!=null)node.textContent=String(value); return node; }
  function remember() { writeLocal('rb:workspace:selection',selection); }
  function draftKey(id=selection.threadId) { return `rb:workspace:draft:${id||'new'}`; }
  function saveDraft() { if(selection.threadId)writeLocal(draftKey(),$('composer-input').value); }
  function banner(message) { $('error-banner').hidden=!message; $('error-text').textContent=message||''; }
  async function api(route, options={}) {
    if(!token) { const r=await fetch('/api/capability',{cache:'no-store',signal:AbortSignal.timeout(10000)}); if(!r.ok)throw new Error('Could not connect to RelayBridge.'); token=(await r.json()).token; }
    const response=await fetch(route,{...options,headers:{'Content-Type':'application/json','X-RelayBridge-Token':token,'X-RelayBridge-Client':'ui',...options.headers},signal:AbortSignal.timeout(15000),cache:'no-store'});
    let data; try {data=await response.json();} catch {throw new Error('The bridge returned an unreadable response. Your submission identity is saved.');}
    if(!response.ok){if(response.status===401)token=null; const error=new Error(data.error||'The request could not be completed.');error.status=response.status;throw error;}
    return data;
  }
  function select(projectId,threadId) { saveDraft(); selection={projectId,threadId};epoch++;remember(); $('composer-input').value=readLocal(draftKey(), '');messageThread=null;renderedMessages=new Set();closeRail();load(); }
  async function mutate(route, body) {
    if(posting)throw new Error('A submission is already in progress.');
    if(pending && (pending.route!==route||JSON.stringify(pending.body)!==JSON.stringify(body)))throw new Error('Recover the previous submission with Retry before sending another.');
    if(!pending){pending={route,body,actionId:crypto.randomUUID().replaceAll('-','_')};writeLocal('rb:workspace:pending',pending);}
    posting=true;updateComposer();
    try {const result=await api(`/api/project-workspace/${route}`,{method:'POST',body:JSON.stringify({...body,actionId:pending.actionId})});
      const sent=pending;pending=null;removeLocal('rb:workspace:pending');banner(null);
      if(route==='messages'){removeLocal(draftKey(sent.body.threadId));if(selection.threadId===sent.body.threadId&&$('composer-input').value.trim()===sent.body.text)$('composer-input').value='';}
      return result;
    } catch(error) {
      // Explicit validation rejection proves this call was not accepted. Network,
      // server, and conflict ambiguity retain the exact action for recovery.
      if([400,403,404,413].includes(error.status)){pending=null;removeLocal('rb:workspace:pending');}
      banner(error.message+(pending?' Retry recovers the same submission.':''));throw error;
    } finally {posting=false;updateComposer();}
  }
  function updateComposer(){const ready=!!state?.thread&&!offline&&!state.storageError; $('composer-input').disabled=!ready||posting;
    $('send-button').disabled=!ready||posting||!!pending||!$('composer-input').value.trim();
    $('new-chat').disabled=!state?.project||posting; $('add-task').disabled=$('add-task-text').disabled=!ready||posting;
    $('composer-input').placeholder=state?.project?'Tell Codex what you\'d like to work on…':'Create a project to start working with Codex…';}
  function renderNav(){const signature=JSON.stringify([state.projects,state.threads,selection]);if(signature===navSignature)return;navSignature=signature;
    const activeFocus=document.activeElement?.dataset.focusKey;
    $('project-list').replaceChildren();
    for(const p of state.projects){const b=el('button',`nav-item${p.id===selection.projectId?' active':''}`);b.dataset.focusKey=p.id;b.setAttribute('aria-current',p.id===selection.projectId?'page':'false');b.append(el('span','', '▧'),el('span','',p.name),el('span','nav-count',p.taskCount||''));b.onclick=()=>select(p.id,null);$('project-list').append(b);}
    if(!state.projects.length)$('project-list').append(el('p','muted small','A project keeps your work together.'));
    $('thread-list').replaceChildren();for(const t of state.threads){const b=el('button',`nav-item${t.id===selection.threadId?' active':''}`);b.dataset.focusKey=t.id;b.append(el('span','muted','◯'),el('span','',t.title));b.onclick=()=>select(selection.projectId,t.id);$('thread-list').append(b);}
    if(activeFocus){const n=[...document.querySelectorAll('[data-focus-key]')].find(n=>n.dataset.focusKey===activeFocus);n?.focus({preventScroll:true});}
  }
  function renderMessage(message){const node=el('article',`message ${message.role}`),head=el('div','message-head');
    const labels={user:'You',assistant:'Codex',advisor:message.provider==='codex'?'Codex · Senior advisor':'Claude · Senior advisor',worker:`${message.provider==='claude'?'Claude':'Codex'} · Task result`,system:'Project activity'};
    head.append(el('span','',message.role==='user'?'○':message.role==='system'?'↳':'✳'),el('span','',labels[message.role]||'Team'));
    const time=el('time','',new Date(message.at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}));time.dateTime=new Date(message.at).toISOString();head.append(time);node.append(head);
    const body=el('div','message-body',message.text);
    if(['advisor','worker'].includes(message.role)){const details=el('details');details.append(el('summary','',message.role==='advisor'?'Read the advisor’s findings':'Read task result'),body);node.append(details);}else node.append(body);
    return node;
  }
  function renderChat(){const thread=state.thread,scroll=$('chat-scroll');const nearBottom=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<100;
    const changed=messageThread!==thread?.id;if(changed){messageThread=thread?.id;renderedMessages=new Set();$('messages').replaceChildren();}
    for(const m of thread?.messages||[]){if(!renderedMessages.has(m.id)){$('messages').append(renderMessage(m));renderedMessages.add(m.id);}}
    $('welcome').hidden=!!thread?.messages?.length;$('welcome-create').hidden=!!state.project;
    $('welcome-title').textContent=state.project?`Let's move ${state.project.name} forward.`:'What are we building?';
    $('draft-context').textContent=state.project?`${state.project.name} · ${state.project.cwd}`:'A focused workspace for your next idea';
    $('project-name').textContent=state.project?.name||'Workspace';$('thread-name').textContent=thread?.title||'New conversation';
    const status=$('turn-status');status.replaceChildren();status.hidden=!thread||thread.state==='idle'&&!thread.pendingCount;
    if(!status.hidden){status.append(el('span','status-pill',S.status(thread.state)),el('span','',thread.error||thread.model||`${thread.pendingCount} message${thread.pendingCount===1?'':'s'} in this turn`));
      if(thread.canResume){const b=el('button','text-button','Resume');b.onclick=()=>mutate('resume',{threadId:thread.id}).then(load).catch(()=>{});status.append(b);}}
    if(changed||nearBottom)requestAnimationFrame(()=>{scroll.scrollTop=scroll.scrollHeight;});
  }
  function showTask(task){$('task-detail-title').textContent=task.title;const box=$('task-detail');box.replaceChildren(el('p','task-detail-meta',`${S.status(task.state)} · ${task.provider} · ${task.model||task.tier}`),el('div','task-details',task.prompt));
    if(task.error)box.append(el('p','form-error',task.error));
    if(task.canResume){const retry=el('button','secondary-button','Retry task');retry.onclick=()=>mutate('resume-task',{taskId:task.id}).then(()=>{$('task-detail-dialog').close();load();}).catch(()=>{});box.append(retry);}
    if(task.workflowId){box.append(el('p','field-help',`Workflow ${task.workflowId}. ${task.state==='awaiting_writer'?'Ready for an external coding agent to claim the writer lease.':''}`));
      const a=el('a','task-detail-link','Open workflow tools ↗');a.href='/terminal';box.append(a);}
    if(task.queueTaskId)box.append(el('p','field-help',`Task ${task.queueTaskId}`));
    if(task.result)box.append(el('hr'),el('div','task-details',task.result));$('task-detail-dialog').showModal();}
  function renderWork(){const current=S.currentWork(state),box=$('current-work');box.replaceChildren();
    if(current){box.append(el('span','status-orbit','◌'),el('h3','',current.title),el('p','',current.model||current.provider||'Your project team'),el('span','status-pill',S.status(current.state)));
      if(current.progress){const duration=S.duration(current.progress.ageMs);box.append(el('p','',`${duration?duration+' elapsed · ':''}${current.progress.phase||'Working'}`),el('p','',S.formatUsage(current.progress.nativeUsage)));}}
    else box.append(el('span','status-orbit','○'),el('h3','','Room for your next idea'),el('p','','No work is running in this project.'));
    $('task-total').textContent=state.tasks.filter(t=>t.state!=='completed').length;
    const signature=JSON.stringify(state.tasks.map(t=>[t.id,t.state,t.title,t.model,t.error]));if(signature!==tasksSignature){tasksSignature=signature;$('task-list').replaceChildren();
      const groups=S.taskGroups(state.tasks);for(const t of [...groups.active,...groups.blocked,...groups.queued,...groups.completed]){const b=el('button','task-card');b.append(el('span','task-icon',t.state==='completed'?'✓':t.state==='needs_attention'?'!':'○'));const content=el('div');content.append(el('strong','',t.title),el('small','',`${S.status(t.state)} · ${t.provider}`));b.append(content);b.onclick=()=>showTask(state.tasks.find(x=>x.id===t.id));$('task-list').append(b);}
      if(!state.tasks.length)$('task-list').append(el('p','panel-empty','A plan becomes a task list here.\nStart a conversation or add a task.'));}
    $('advisor-name').textContent=state.project?.advisor==='codex'?'Codex':'Claude';
    $('reserve-note').textContent=state.settings?.usageProtection?`${state.settings.reservePercent}% usage reserve protected.`:'Usage reserve protection is off.';
  }
  async function load(){if(loading){reload=true;return;}loading=true;const requestedEpoch=epoch;const q=new URLSearchParams();if(selection.projectId)q.set('projectId',selection.projectId);if(selection.threadId)q.set('threadId',selection.threadId);
    try{const next=await api(`/api/project-workspace/state?${q}`);if(epoch!==requestedEpoch){reload=true;return;}state=next;offline=false;
      const previousThread=selection.threadId;selection=S.mergeSelection(selection,state);remember();if(previousThread!==selection.threadId)$('composer-input').value=readLocal(draftKey(),'');
      $('connection').textContent='Connected locally';$('connection').classList.add('online');
      banner(state.storageError||(pending?'A submission is waiting to be recovered. Retry uses its saved identity.':null));renderNav();renderChat();renderWork();
    }catch(error){offline=true;$('connection').textContent='Reconnecting';$('connection').classList.remove('online');banner(`${error.message} Your saved conversations are still on the bridge.`);}
    finally{loading=false;updateComposer();if(reload){reload=false;load();}}
  }
  function openProject(){$('project-dialog').showModal();$('project-title').focus();}
  function openTask(){if(!state?.thread)return openProject();$('task-provider').disabled=$('task-kind').value==='coding';$('task-dialog').showModal();$('task-title').focus();}
  function closeRail(){$('sidebar').classList.remove('is-open');$('rail-backdrop').hidden=true;$('menu-toggle').setAttribute('aria-expanded','false');}
  $('menu-toggle').onclick=()=>{$('sidebar').classList.add('is-open');$('rail-backdrop').hidden=false;$('menu-toggle').setAttribute('aria-expanded','true');$('new-chat').focus();};$('rail-backdrop').onclick=closeRail;
  $('work-toggle').onclick=()=>{const panel=$('work-panel');if(matchMedia('(max-width:1100px)').matches){panel.classList.toggle('panel-open');$('work-toggle').setAttribute('aria-expanded',panel.classList.contains('panel-open'));}else{panel.classList.toggle('panel-hidden');$('work-toggle').setAttribute('aria-expanded',!panel.classList.contains('panel-hidden'));}};
  $('theme-toggle').onclick=()=>{const dark=document.documentElement.dataset.theme?document.documentElement.dataset.theme==='dark':matchMedia('(prefers-color-scheme:dark)').matches;const value=dark?'light':'dark';document.documentElement.dataset.theme=value;writeLocal('rb:workspace:theme',value);};
  $('new-project').onclick=$('welcome-create').onclick=openProject;$('add-task').onclick=$('add-task-text').onclick=openTask;
  document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
  $('new-chat').onclick=async()=>{if(!state?.project)return openProject();try{const result=await mutate('threads',{projectId:selection.projectId});select(result.projectId,result.threadId);}catch{}};
  document.querySelectorAll('[data-suggestion]').forEach(b=>b.onclick=()=>{if(!state?.thread)return openProject();$('composer-input').value=b.dataset.suggestion;saveDraft();updateComposer();$('composer-input').focus();});
  $('composer-input').addEventListener('input',()=>{saveDraft();updateComposer();});
  $('composer-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!$('send-button').disabled)$('composer').requestSubmit();}});
  $('composer').onsubmit=async e=>{e.preventDefault();if(!$('composer-input').value.trim()||!state?.thread)return;const body={threadId:selection.threadId,text:$('composer-input').value.trim()};try{await mutate('messages',body);await load();$('composer-input').focus();}catch{}};
  async function submitForm(form, action){const button=form.querySelector('[type=submit]'),error=form.querySelector('.form-error');button.disabled=true;error.textContent='';try{await action();form.closest('dialog').close();form.reset();}catch(e){error.textContent=e.message;}finally{button.disabled=false;}}
  $('project-form').onsubmit=e=>{e.preventDefault();submitForm(e.currentTarget,async()=>{const result=await mutate('projects',{name:$('project-title').value,cwd:$('project-cwd').value,advisor:$('project-advisor').value,allowWrites:$('project-writes').checked});select(result.projectId,result.threadId);});};
  $('task-kind').onchange=()=>{const coding=$('task-kind').value==='coding';$('task-provider').disabled=coding;if(coding)$('task-provider').value='codex';};
  $('task-form').onsubmit=e=>{e.preventDefault();submitForm(e.currentTarget,async()=>{await mutate('tasks',{threadId:selection.threadId,title:$('task-title').value,prompt:$('task-prompt').value,kind:$('task-kind').value,provider:$('task-provider').value,tier:$('task-tier').value});await load();});};
  $('settings-open').onclick=()=>{const s=state?.settings||{};$('usage-protection').checked=s.usageProtection!==false;$('reserve-percent').value=String(s.reservePercent||5);$('auto-handoff').checked=s.autoHandoff!==false;$('dynamic-supervision').checked=s.dynamicSupervision!==false;$('settings-dialog').showModal();};
  $('settings-form').onsubmit=e=>{e.preventDefault();submitForm(e.currentTarget,async()=>{await api('/api/settings/continuity',{method:'PUT',body:JSON.stringify({usageProtection:$('usage-protection').checked,reservePercent:Number($('reserve-percent').value),autoHandoff:$('auto-handoff').checked,dynamicSupervision:$('dynamic-supervision').checked})});await load();});};
  $('retry-button').onclick=async()=>{if(pending){try{const result=await mutate(pending.route,pending.body);if(result.projectId)select(result.projectId,result.threadId);}catch{}}else load();};
  $('export-handoff').onclick=()=>{if(!state?.thread)return;const content=[`# ${state.project.name} — ${state.thread.title}`,`Workspace: ${state.project.cwd}`,`State: ${S.status(state.thread.state)}`,`Coordinator: Codex standard / medium`,...state.thread.messages.map(m=>`## ${m.role}${m.taskId?' · '+m.taskId:''}\n${m.text}`),'## Project tasks',...state.tasks.map(t=>`- ${t.title}: ${S.status(t.state)} (${t.queueTaskId||t.workflowId||t.id})\n  ${t.prompt}`)].join('\n\n');const url=URL.createObjectURL(new Blob([content],{type:'text/markdown'})),a=el('a');a.href=url;a.download=`relaybridge-handoff-${state.thread.id}.md`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeRail();$('work-panel').classList.remove('panel-open');syncPanelState();}if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();$('new-chat').click();}});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});window.addEventListener('online',load);
  function syncPanelState(){const panel=$('work-panel');$('work-toggle').setAttribute('aria-expanded',matchMedia('(max-width:1100px)').matches?panel.classList.contains('panel-open'):!panel.classList.contains('panel-hidden'));}
  window.addEventListener('resize',syncPanelState);syncPanelState();
  $('composer-input').value=readLocal(draftKey(),'');load();setInterval(()=>{if(!document.hidden)load();},3000);
})();
