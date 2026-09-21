'use strict';
(() => {
  const $ = (id) => document.getElementById(id), S = window.WorkspaceState;
  const readLocal = (key, fallback=null) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const writeLocal = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* server state remains authoritative */ } };
  const removeLocal = (key) => { try { localStorage.removeItem(key); } catch {} };
  let selection=readLocal('rb:workspace:selection',{}), state=null, token=null, loading=false, reload=false, epoch=0, offline=false;
  let pending=readLocal('rb:workspace:pending'), posting=false, messageThread=null, renderedMessages=new Set(), navSignature='', tasksSignature='', callsSignature='', detailSeq=0;
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
      // A duplicate attachment conflict is also definitive: nothing further was stored.
      if([400,403,404,413].includes(error.status)||route==='attach-call'&&error.status===409){pending=null;removeLocal('rb:workspace:pending');}
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
  // Attached existing calls. Bridge-resolved status and caller-pasted text are
  // rendered in separate, labelled blocks, always as text content.
  function renderAttachedCalls(){const calls=state.attachedCalls||[],signature=S.attachedCallsSignature(calls);$('attach-call-open').disabled=!state.project||!!state.storageError;if(signature===callsSignature)return;callsSignature=signature;const list=$('attached-call-list');list.replaceChildren();
    for(const call of calls){const summary=S.attachedCallSummary(call),b=el('button','task-card');b.dataset.attachmentId=call.id;b.append(el('span','task-icon',summary.state==='completed'?'✓':['id_mismatch','unavailable','failed','partial','uncertain','result_unavailable'].includes(summary.state)?'!':'○'));
      const content=el('div');content.append(el('strong','',summary.title),el('small','',summary.line+(summary.callerTexts?` · ${summary.callerTexts} pasted text${summary.callerTexts===1?'':'s'} (unverified)`:'')));b.append(content);b.onclick=()=>showAttachedCall(call.id);list.append(b);}
    if(!calls.length)list.append(el('p','panel-empty','Attach an existing request, task, run or receipt to follow it here. Attaching never starts work.'));}
  function detailRow(box,label,value){if(value==null||value==='')return;const p=el('p','task-detail-meta');p.style.margin='4px 0';p.append(el('strong','',`${label}: `),document.createTextNode(String(value)));box.append(p);}
  async function showAttachedCall(id){const seq=++detailSeq,projectId=selection.projectId;let call;
    try{call=await api(`/api/project-workspace/attached-calls/${encodeURIComponent(id)}?${new URLSearchParams({projectId})}`);}catch(error){banner(error.message);return;}
    if(seq!==detailSeq||projectId!==selection.projectId)return;const v=call.verified,box=$('task-detail');
    $('task-detail-title').textContent=call.label||S.refList(call.refs)[0]||'Attached call';box.replaceChildren();
    const bridge=el('section');bridge.append(el('p','eyebrow','BRIDGE RECORD · RESOLVED BY RELAYBRIDGE'),el('p','task-detail-meta',`${S.status(v.displayState)} · ${({task:'task record',active_run:'live run',receipt:'receipt journal'})[v.source]||'no bridge record found'} · checked ${new Date(call.observedAt).toLocaleTimeString()}`));
    for(const [field,value] of Object.entries(call.refs))detailRow(bridge,`${S.refList({[field]:value})[0].split(' ')[0]} you attached`,`${value} (${({confirmed:'confirmed by bridge',mismatch:'bridge disagrees',not_found:'not found'})[v.refStatus[field]]||'not checked'})`);
    for(const m of v.mismatches){const row=el('div','field-row');row.style.border='1px solid var(--danger)';row.style.borderRadius='8px';row.style.padding='8px';row.style.margin='8px 0';
      const left=el('div'),right=el('div');left.append(el('small','muted',`${m.field} you entered`),el('div','task-details',m.supplied??'(not entered)'));right.append(el('small','muted',`${m.field} in ${m.sources.join(', ')}`),el('div','task-details',m.bridge));row.append(left,right);bridge.append(row);}
    if(v.mismatches.length)bridge.append(el('p','form-error','These IDs disagree. RelayBridge does not choose between them.'));
    for(const reason of [...v.unavailableReasons,...v.observations])bridge.append(el('p','field-help',S.reasonText(reason)));
    if(v.task){detailRow(bridge,'Task status',`${v.task.status} · ${v.task.executionState||'execution state unknown'}`);detailRow(bridge,'Model',[v.task.kind,v.task.model,v.task.effort].filter(Boolean).join(' · '));detailRow(bridge,'Failure',v.task.failureClass);detailRow(bridge,'Exit code',v.task.exitCode);}
    if(v.live){detailRow(bridge,'Live run',`${v.live.runId} · ${v.live.phase||'working'} · ${S.duration(v.live.ageMs)||'0s'} elapsed · ${v.live.bytes??0} bytes${v.live.truncated?' · output truncated':''}`);detailRow(bridge,'Model',[v.live.kind,v.live.model,v.live.effort].filter(Boolean).join(' · '));}
    if(v.receipt)detailRow(bridge,'Receipt',[v.receipt.receiptId,v.receipt.event,v.receipt.status,v.receipt.provider,v.receipt.model,v.receipt.partialResult?'partial result':null,v.receipt.failureClass].filter(Boolean).join(' · '));
    if(v.result){detailRow(bridge,'Result',v.result.retainedByBridge?`retained · ${v.result.bytes} bytes · ${v.result.partial?'partial':v.result.complete?'complete':'completeness unknown'}${v.result.truncated?' · stored truncated':''}`:v.result.state==='not_retained_by_bridge'?'the bridge does not retain direct call text; only receipt hashes exist':`not available${v.result.unavailableReason?' · '+S.reasonText(v.result.unavailableReason):''}`);
      detailRow(bridge,'Result hash',v.result.sha256||v.result.outputHash);}
    if(v.receiptScan?.limited)bridge.append(el('p','field-help',S.reasonText('receipt_scan_limited')));
    if(v.resultText!=null)bridge.append(el('p','eyebrow','RESULT RETAINED BY BRIDGE'),el('div','task-details',v.resultText));
    if(v.partialCheckpoint)bridge.append(el('p','eyebrow','PARTIAL CHECKPOINT RETAINED BY BRIDGE'),el('div','task-details',v.partialCheckpoint));
    box.append(bridge);
    for(const a of call.callerArtifacts){const block=el('section');block.style.border='2px dashed var(--muted)';block.style.borderRadius='10px';block.style.padding='12px';block.style.marginTop='16px';
      block.append(el('p','eyebrow',`UNVERIFIED — PASTED BY YOU · ${a.role.toUpperCase()}`),el('p','field-help','You supplied this text. It does not change the bridge record above.'));
      detailRow(block,'Source',a.source);detailRow(block,'Size',`${a.bytes} bytes`);detailRow(block,'Stored hash',a.storedHash);detailRow(block,'Stored text',a.storedTextCheck==='matches_stored_hash'?'unchanged since attach':'changed since attach');
      detailRow(block,'Hash you entered',a.callerClaimedHash?`${a.callerClaimedHash} (${a.callerHashCheck==='matches'?'matches stored text':'does not match stored text'})`:null);detailRow(block,'Bridge comparison',S.hashCheckText(a.bridgeHashCheck));
      for(const m of a.idMismatches){const row=el('div','field-row');row.style.border='1px solid var(--danger)';row.style.borderRadius='8px';row.style.padding='8px';const left=el('div'),right=el('div');left.append(el('small','muted',`${m.field} recorded with this text`),el('div','task-details',m.claimed));right.append(el('small','muted',`${m.field} in bridge record`),el('div','task-details',m.bridge));row.append(left,right);block.append(row);}
      if(a.callerDeclaredTruncated)block.append(el('p','form-error','You marked this text as truncated at its source.'));
      block.append(el('div','task-details',a.text));box.append(block);}
    $('task-detail-dialog').open||$('task-detail-dialog').showModal();}
  function buildAttachUi(){const section=el('section'),heading=el('div','queue-heading'),open=el('button','text-button','Attach call');open.id='attach-call-open';heading.append(el('h3','','Attached calls'),open);const list=el('div','task-list');list.id='attached-call-list';list.style.marginTop='8px';section.append(heading,list);$('task-list').after(section);
    const dialog=el('dialog'),form=el('form');dialog.id='attach-call-dialog';form.id='attach-call-form';const head=el('div','dialog-heading'),titles=el('div'),close=el('button','icon-button','×');close.type='button';close.setAttribute('aria-label','Close attach dialog');close.onclick=()=>dialog.close();titles.append(el('p','eyebrow','FOLLOW EXISTING WORK'),el('h2','','Attach a call'));head.append(titles,close);form.append(head,el('p','field-help','Attach references to a call that already happened or is running. Attaching never starts, resumes or retries work.'));
    const input=(id,label,tag='input')=>{const node=el(tag);node.id=id;const l=el('label','',label);l.htmlFor=id;form.append(l,node);return node;};
    input('attach-label','Label (optional)').maxLength=200;
    for(const [key,label,placeholder] of [['requestId','Request ID','queued:t_… or your request ID'],['taskId','Task ID','t_…'],['runId','Run ID','run_…'],['receiptId','Receipt ID','rcpt_…']]){const node=input(`attach-${key}`,label);node.maxLength=160;node.placeholder=placeholder;node.autocomplete='off';node.spellcheck=false;}
    for(const role of ['request','result']){const box=el('details');box.append(el('summary','text-button',`Paste the ${role} text (optional)`));form.append(box);const add=(id,label,tag='input')=>{const node=el(tag);node.id=id;const l=el('label','',label);l.htmlFor=id;box.append(l,node);return node;};
      box.append(el('p','field-help','You supplied this text — it is stored as unverified caller content, shown in full, and never changes the bridge status. Do not paste credentials.'));
      const text=add(`attach-${role}-text`,`${role==='request'?'Request':'Result'} text`,'textarea');text.rows=5;add(`attach-${role}-source`,'Where this text came from (optional)').maxLength=200;const hash=add(`attach-${role}-sha256`,'SHA-256 you recorded (optional)');hash.maxLength=64;hash.spellcheck=false;
      add(`attach-${role}-claimed-request`,'Request ID recorded with this text (optional)').maxLength=160;add(`attach-${role}-claimed-receipt`,'Receipt ID recorded with this text (optional)').maxLength=160;
      const check=el('label','checkbox-label'),box2=el('input');box2.type='checkbox';box2.id=`attach-${role}-truncated`;check.append(box2,document.createTextNode(' This text was already truncated at its source'));box.append(check);}
    const error=el('p','form-error');error.setAttribute('role','alert');const actions=el('div','dialog-actions'),cancel=el('button','secondary-button','Cancel'),submit=el('button','primary-button','Attach');cancel.type='button';cancel.onclick=()=>dialog.close();submit.type='submit';actions.append(cancel,submit);form.append(error,actions);dialog.append(form);document.body.append(dialog);
    open.onclick=()=>{if(!state?.project)return openProject();dialog.showModal();$('attach-requestId').focus();};
    const value=(id)=>$(id).value;
    form.onsubmit=e=>{e.preventDefault();submitForm(form,async()=>{const artifact=(role)=>({text:value(`attach-${role}-text`),source:value(`attach-${role}-source`),sha256:value(`attach-${role}-sha256`),truncated:$(`attach-${role}-truncated`).checked,claimedIds:{requestId:value(`attach-${role}-claimed-request`),receiptId:value(`attach-${role}-claimed-receipt`)}});
      const body=S.attachPayload({projectId:selection.projectId,label:value('attach-label'),requestId:value('attach-requestId'),taskId:value('attach-taskId'),runId:value('attach-runId'),receiptId:value('attach-receiptId'),request:artifact('request'),result:artifact('result')});
      await mutate('attach-call',body);await load();});};}
  function renderWork(){const current=S.currentWork(state),box=$('current-work');box.replaceChildren();
    if(current){box.append(el('span','status-orbit','◌'),el('h3','',current.title),el('p','',current.model||current.provider||'Your project team'),el('span','status-pill',S.status(current.state)));
      if(current.threadId){const conversation=el('button','text-button',current.conversationTitle);conversation.setAttribute('aria-label',`Open conversation: ${current.conversationTitle}`);conversation.onclick=()=>select(selection.projectId,current.threadId);box.append(conversation);}
      if(current.progress){const duration=S.duration(current.progress.ageMs);box.append(el('p','',`${duration?duration+' elapsed · ':''}${current.progress.phase||'Working'}`),el('p','',S.formatUsage(current.progress.nativeUsage)));}}
    else box.append(el('span','status-orbit','○'),el('h3','','Room for your next idea'),el('p','','No work is running in this project.'));
    $('task-total').textContent=state.tasks.filter(t=>t.state!=='completed').length;
    const signature=JSON.stringify(state.tasks.map(t=>[t.id,t.state,t.title,t.model,t.error]));if(signature!==tasksSignature){tasksSignature=signature;$('task-list').replaceChildren();
      const groups=S.taskGroups(state.tasks);for(const t of [...groups.active,...groups.blocked,...groups.queued,...groups.completed]){const b=el('button','task-card');b.append(el('span','task-icon',t.state==='completed'?'✓':t.state==='needs_attention'?'!':'○'));const content=el('div');content.append(el('strong','',t.title),el('small','',`${S.status(t.state)} · ${t.provider}`));b.append(content);b.onclick=()=>showTask(state.tasks.find(x=>x.id===t.id));$('task-list').append(b);}
      if(!state.tasks.length)$('task-list').append(el('p','panel-empty','A plan becomes a task list here.\nStart a conversation or add a task.'));}
    renderAttachedCalls();
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
  $('retry-button').onclick=async()=>{if(pending){try{const route=pending.route,result=await mutate(pending.route,pending.body);if(result.projectId&&route!=='attach-call')select(result.projectId,result.threadId);else load();}catch{}}else load();};
  $('export-handoff').onclick=()=>{if(!state?.thread)return;const content=[`# ${state.project.name} — ${state.thread.title}`,`Workspace: ${state.project.cwd}`,`State: ${S.status(state.thread.state)}`,`Coordinator: Codex standard / medium`,`Active coordinator/advisor task: ${state.thread.queueTaskId||'None'} (${state.thread.role||'coordinator'}; model ${state.thread.model||'not currently running'})`,`Coding permission: ${state.project.allowWrites?'reviewed workflow only; an exclusive writer lease is still required':'read only'}`,`Pending messages: ${state.thread.pendingCount||0}`, ...state.thread.messages.map(m=>`## ${m.role}${m.taskId?' · '+m.taskId:''}\n${m.text}`),'## Project tasks',...state.tasks.map(t=>`- ${t.title}: ${S.status(t.state)} (${t.queueTaskId||t.workflowId||t.id})\n  ${t.prompt}`)].join('\n\n');const url=URL.createObjectURL(new Blob([content],{type:'text/markdown'})),a=el('a');a.href=url;a.download=`relaybridge-handoff-${state.thread.id}.md`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeRail();$('work-panel').classList.remove('panel-open');syncPanelState();}if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();$('new-chat').click();}});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});window.addEventListener('online',load);
  function syncPanelState(){const panel=$('work-panel');$('work-toggle').setAttribute('aria-expanded',matchMedia('(max-width:1100px)').matches?panel.classList.contains('panel-open'):!panel.classList.contains('panel-hidden'));}
  window.addEventListener('resize',syncPanelState);syncPanelState();
  buildAttachUi();$('composer-input').value=readLocal(draftKey(),'');load();setInterval(()=>{if(!document.hidden)load();},3000);
})();
