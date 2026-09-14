'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createProjectWorkspace,parseDecision}=require('../lib/project-workspace');
function fixture(t){const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'rb-project-unit-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));const tasks=new Map(),submissions=[],workflowRecords=new Map();let protectedUsage=false;
 const queue={get:id=>tasks.get(id),getResult:id=>({resultPersisted:true,metadata:{complete:true,requestId:'queued:'+id},result:tasks.get(id)?.result}),submitDurable(id,intent){const saved=JSON.parse(fs.readFileSync(path.join(dataDir,'project-workspace','workspace.json')));assert.ok([...saved.threads,...saved.tasks].some(o=>o.job?.id===id),'intent persisted before dispatch');if(!tasks.has(id)){submissions.push({id,intent});tasks.set(id,{id,body:structuredClone(intent),status:'queued',execution:{state:'reserved'}});}return tasks.get(id);}};
 const workflows={create(input){assert.equal(input.permissionMode,'safe');workflowRecords.set(input.runId,{...input,phase:'scoping'});},view(id){if(!workflowRecords.has(id))throw Object.assign(new Error('missing'),{code:'WORKFLOW_NOT_FOUND'});return{workflow:workflowRecords.get(id),nextActions:[]};},submitResearch(id){workflowRecords.get(id).phase='planning';},reconcile(){}};
 const options={dataDir,queue,workflows,quota:{verdict:()=>({admit:!protectedUsage,percentRemaining:protectedUsage?4:80}),getSettings:()=>({usageProtection:true,reservePercent:5})},validateCwd:cwd=>{if(!cwd.startsWith(dataDir))throw new Error('outside workspace');return{resolved:cwd,cwdIdentityHash:'fixed',cwdPolicyId:'policy'};},resolveIntent:body=>({...body,expectedQuotaSeat:body.kind,execution:{model:body.modelTier+'-model',resolvedModelTier:body.modelTier,appliedEffort:body.effort}})};
 const workspace=createProjectWorkspace(options);const created=workspace.createProject({actionId:'project_0001',name:'Project A',cwd:dataDir});
 const complete=(id,result,status='done')=>Object.assign(tasks.get(id),{status,result:typeof result==='string'?result:JSON.stringify(result),execution:{state:'settled'},receiptId:'receipt-'+id});
 return{workspace,created,dataDir,tasks,queue,submissions,workflows,workflowRecords,options,complete,protect:()=>{protectedUsage=true;}};}
test('project action replay preserves identity and rejects conflicting intent',t=>{const f=fixture(t);const input={actionId:'message_0001',threadId:f.created.threadId,text:'Plan this project'};const first=f.workspace.sendMessage(input);assert.deepEqual(f.workspace.sendMessage(input),{...first,idempotent:true});assert.throws(()=>f.workspace.sendMessage({...input,text:'Different'}),/different request/);f.workspace.tick();f.workspace.tick();assert.equal(f.submissions.length,1);assert.equal(f.workspace.view().thread.messages.length,1);assert.equal(f.submissions[0].intent.kind,'codex');assert.equal(f.submissions[0].intent.modelTier,'standard');assert.equal(f.submissions[0].intent.effort,'medium');});
test('strong advisor result returns to Codex before allocation and downstream execution',t=>{const f=fixture(t);f.workspace.sendMessage({actionId:'message_0001',threadId:f.created.threadId,text:'Design a change'});f.workspace.tick();f.complete(f.submissions[0].id,{action:'consult',question:'Which approach preserves existing data?'});f.workspace.tick();assert.equal(f.submissions.length,2);assert.equal(f.submissions[1].intent.kind,'claude');assert.equal(f.submissions[1].intent.modelTier,'heavy');assert.equal(f.submissions[1].intent.effort,'high');assert.equal(f.workspace.view().tasks.length,0);f.complete(f.submissions[1].id,'Use an additive migration. Test old records.');f.workspace.tick();assert.equal(f.submissions.length,3);assert.equal(f.submissions[2].intent.kind,'codex');assert.match(f.submissions[2].intent.prompt,/Use an additive migration/);assert.ok(f.submissions[2].intent.prompt.includes(f.submissions[1].id));assert.equal(f.workspace.view().tasks.length,0);f.complete(f.submissions[2].id,{action:'allocate',text:'Start by reviewing old records.',tasks:[{title:'Review migration',prompt:'Inspect the old record contract.',kind:'read_only',provider:'codex',tier:'light'}]});f.workspace.tick();assert.equal(f.submissions.length,4);assert.equal(f.submissions[3].intent.modelTier,'light');assert.equal(f.submissions[3].intent.dangerous,false);f.complete(f.submissions[3].id,'Old records remain readable.');f.workspace.tick();assert.equal(f.workspace.view().tasks[0].state,'completed');assert.equal(f.workspace.view().thread.messages.at(-1).role,'worker');});
test('coding allocations create one workflow and never dispatch a writer',t=>{const f=fixture(t);const input={actionId:'task_00001',threadId:f.created.threadId,title:'Implement change',prompt:'Add the requested feature with checks.',kind:'coding'};f.workspace.createTask(input);f.workspace.tick();f.workspace.tick();assert.equal(f.workflowRecords.size,1);assert.equal(f.submissions.length,0);const w=[...f.workflowRecords.values()][0];w.phase='plan_ready';assert.equal(f.workspace.view().tasks[0].state,'awaiting_writer');f.workspace.createTask(input);assert.equal(f.workspace.view().tasks.length,1);});
test('malformed and permission-widening decisions cannot allocate work',t=>{const f=fixture(t);f.workspace.sendMessage({actionId:'message_0001',threadId:f.created.threadId,text:'Inspect'});f.workspace.tick();f.complete(f.submissions[0].id,{action:'allocate',text:'go',tasks:[{title:'Unsafe',prompt:'Write files',kind:'read_only',dangerous:true}]});f.workspace.tick();f.workspace.tick();assert.equal(f.submissions.length,1);assert.equal(f.workspace.view().thread.state,'needs_attention');assert.equal(f.workspace.view().tasks.length,0);});
test('decision contract rejects malformed, oversized and excessive work',()=>{for(const value of ['not json',JSON.stringify({action:'write',text:'go'}),JSON.stringify({action:'reply',text:'x'.repeat(12001)}),JSON.stringify({action:'allocate',text:'go',tasks:Array(5).fill({title:'x',prompt:'x',kind:'coding'})}),JSON.stringify({action:'allocate',text:'go',tasks:[{title:'x',prompt:'x',kind:'coding',provider:'unknown'}]})])assert.throws(()=>parseDecision(value));assert.equal(parseDecision('```json\n{"action":"reply","text":"Hi"}\n```').text,'Hi');});
test('reserve refusal preserves the user message and dispatches no provider',t=>{const f=fixture(t);f.protect();f.workspace.sendMessage({actionId:'message_0001',threadId:f.created.threadId,text:'Keep this request'});f.workspace.tick();f.workspace.tick();assert.equal(f.submissions.length,0);assert.equal(f.workspace.view().thread.state,'waiting_for_quota');assert.equal(f.workspace.view().thread.messages[0].text,'Keep this request');});
test('recovery after persistence-before-submit uses the exact prior intent once',t=>{const f=fixture(t);f.workspace.sendMessage({actionId:'message_0001',threadId:f.created.threadId,text:'Recover this work'});let crashImage;f.queue.submitDurable=(id,intent)=>{crashImage=fs.readFileSync(path.join(f.dataDir,'project-workspace','workspace.json'));throw new Error('simulated process death before queue write');};f.workspace.tick();fs.writeFileSync(path.join(f.dataDir,'project-workspace','workspace.json'),crashImage);let calls=0;const queue={get:id=>f.tasks.get(id),submitDurable(id,intent){calls++;f.tasks.set(id,{id,body:intent,status:'queued',execution:{state:'reserved'}});}};const recovered=createProjectWorkspace({...f.options,queue});recovered.tick();recovered.tick();assert.equal(calls,1);const expected=JSON.parse(crashImage).threads[0].job;assert.deepEqual(f.tasks.get(expected.id).body,expected.intent);});
test('separate projects cannot read each other’s conversation through selection',t=>{const f=fixture(t);f.workspace.sendMessage({actionId:'message_0001',threadId:f.created.threadId,text:'Private to project A'});const second=f.workspace.createProject({actionId:'project_0002',name:'Project B',cwd:f.dataDir});assert.equal(f.workspace.view({projectId:second.projectId}).thread.messages.length,0);assert.throws(()=>f.workspace.view({projectId:second.projectId,threadId:f.created.threadId}),/not found in this project/);assert.throws(()=>f.workspace.createProject({actionId:'project_0003',name:'Invalid',cwd:'/outside'}),/outside/);});
test('corrupt storage is preserved and cannot silently reset project history',t=>{const f=fixture(t),file=path.join(f.dataDir,'project-workspace','workspace.json');fs.writeFileSync(file,'{broken');const recovered=createProjectWorkspace(f.options);assert.ok(recovered.view().storageError);assert.throws(()=>recovered.createProject({actionId:'project_0002',name:'Would erase history',cwd:f.dataDir}));assert.equal(fs.readFileSync(file,'utf8'),'{broken');});
test('read paths never submit or settle tasks',t=>{const f=fixture(t);f.workspace.sendMessage({actionId:'message_0001',threadId:f.created.threadId,text:'Wait for tick'});for(let i=0;i<3;i++)f.workspace.view();assert.equal(f.submissions.length,0);});
test('project activity includes other conversations with exact progress and remains project scoped',t=>{
 const f=fixture(t),idle=f.workspace.createThread({actionId:'thread_00002',projectId:f.created.projectId,title:'Idle conversation'});
 f.workspace.sendMessage({actionId:'message_0001',threadId:f.created.threadId,text:'Keep working'});f.workspace.tick();
 const id=f.submissions[0].id;f.tasks.get(id).status='running';
 const progress={route:{request_id:'queued:'+id},ageMs:1234,phase:'provider_running'};
 const workspace=createProjectWorkspace({...f.options,activeRuns:()=>[progress]});
 const view=workspace.view({projectId:f.created.projectId,threadId:idle.threadId});
 assert.equal(view.thread.state,'idle');assert.equal(view.activity.length,1);assert.equal(view.activity[0].id,f.created.threadId);
 assert.equal(view.activity[0].queueTaskId,id);assert.equal(view.activity[0].state,'running');assert.deepEqual(view.activity[0].progress,progress);
 assert.equal(view.activity[0].messages,undefined);assert.equal(view.activity[0].job,undefined);
 const other=workspace.createProject({actionId:'project_0002',name:'Other project',cwd:f.dataDir});assert.deepEqual(workspace.view({projectId:other.projectId}).activity,[]);
 assert.equal(f.submissions.length,1);
});
test('task projection preserves refusals and never treats unverified queue completion as completed work',t=>{
 const f=fixture(t);f.workspace.createTask({actionId:'task_00001',threadId:f.created.threadId,title:'Inspect',prompt:'Inspect files',kind:'read_only'});f.workspace.tick();
 f.complete(f.submissions[0].id,'A result');assert.notEqual(f.workspace.view().tasks[0].state,'completed');
 f.queue.getResult=()=>({resultPersisted:false});f.workspace.tick();
 const task=f.workspace.view().tasks[0];assert.equal(task.state,'needs_attention');assert.equal(task.executionStatus,'done');
 const coding=f.workspace.createTask({actionId:'task_00002',threadId:f.created.threadId,title:'Code',prompt:'Make the change',kind:'coding'});f.workspace.tick();
 const file=path.join(f.dataDir,'project-workspace','workspace.json'),saved=JSON.parse(fs.readFileSync(file));
 saved.tasks.find(t=>t.id===coding.taskId).state='needs_attention';fs.writeFileSync(file,JSON.stringify(saved));
 const blocked=f.workspace.getTask(coding.taskId);assert.equal(blocked.state,'needs_attention');assert.equal(blocked.workflowPhase,'planning');
});
test('completed coding workflow status agrees in task cards project counts and coordinator context',t=>{
 const f=fixture(t);f.workspace.createTask({actionId:'task_00001',threadId:f.created.threadId,title:'Completed code',prompt:'Implement',kind:'coding'});f.workspace.tick();
 assert.equal(f.workspace.view().projects[0].taskCount,1);[...f.workflowRecords.values()][0].phase='complete';
 const view=f.workspace.view();assert.equal(view.tasks[0].state,'completed');assert.equal(view.projects[0].taskCount,0);
 f.workspace.sendMessage({actionId:'message_0001',threadId:f.created.threadId,text:'What is next?'});f.workspace.tick();
 assert.match(f.submissions[0].intent.prompt,/"title":"Completed code","kind":"coding","state":"completed"/);
});
test('unavailable or partial delivery never becomes advisor evidence or completed work',t=>{const f=fixture(t);f.workspace.sendMessage({actionId:'message_0001',threadId:f.created.threadId,text:'Consult'});f.workspace.tick();f.complete(f.submissions[0].id,{action:'consult',question:'Review this'});f.workspace.tick();f.complete(f.submissions[1].id,'');f.queue.getResult=()=>({resultPersisted:false,metadata:null,result:null});f.workspace.tick();assert.equal(f.submissions.length,2);assert.equal(f.workspace.view().thread.state,'needs_attention');assert.equal(f.workspace.view().tasks.length,0);});
test('explicit resume recovers absent saved task identity rather than generating another',t=>{const f=fixture(t),submit=f.queue.submitDurable;f.queue.submitDurable=()=>{throw new Error('temporarily unavailable');};f.workspace.sendMessage({actionId:'message_0001',threadId:f.created.threadId,text:'Preserve the intent'});f.workspace.tick();const blocked=f.workspace.view().thread;assert.equal(blocked.canResume,true);assert.ok(blocked.queueTaskId);f.queue.submitDurable=submit;const restarted=createProjectWorkspace(f.options);restarted.resume({actionId:'resume_00001',threadId:f.created.threadId});restarted.tick();assert.equal(f.submissions.length,1);assert.equal(f.submissions[0].id,blocked.queueTaskId);});
test('second consultation never consumes stale first-advisor evidence after quota pause',t=>{const f=fixture(t);let blocked=false;f.options.quota.verdict=()=>({admit:!blocked});f.workspace.sendMessage({actionId:'message_0001',threadId:f.created.threadId,text:'Plan'});f.workspace.tick();f.complete(f.submissions[0].id,{action:'consult',question:'FIRST QUESTION'});f.workspace.tick();f.complete(f.submissions[1].id,'FIRST ANSWER');f.workspace.tick();f.complete(f.submissions[2].id,{action:'consult',question:'SECOND QUESTION'});blocked=true;f.workspace.tick();assert.equal(f.workspace.view().thread.state,'waiting_for_quota');blocked=false;f.workspace.resume({actionId:'resume_00001',threadId:f.created.threadId});f.workspace.tick();assert.equal(f.submissions[3].intent.kind,'claude');assert.match(f.submissions[3].intent.prompt,/SECOND QUESTION/);assert.doesNotMatch(f.submissions[3].intent.prompt,/FIRST ANSWER/);});
// Attached existing calls. Every ID and text below is synthetic fixture data.
const crypto=require('node:crypto'),{isDeepStrictEqual}=require('node:util');const sha=text=>crypto.createHash('sha256').update(text,'utf8').digest('hex');
function attachFixture(t,{runs=[],receipts=[],receiptsDir}={}){const f=fixture(t),dir=receiptsDir===undefined?path.join(f.dataDir,'receipts'):receiptsDir;
 if(dir&&receipts.length){fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'2026-09-13.jsonl'),receipts.map(r=>JSON.stringify(r)).join('\n')+'\n');}
 const results=new Map();f.queue.getResult=id=>{const r=results.get(id);if(r instanceof Error)throw r;return r||{taskId:id,resultState:'unavailable',resultPersisted:false,result:null,metadata:null,unavailableReason:'result_not_persisted'};};
 const workspace=createProjectWorkspace({...f.options,receiptsDir:dir,activeRuns:()=>runs});
 const settle=(id,{status='done',result='Synthetic fixture result',partial=false,persisted=true,...extra}={})=>{f.tasks.set(id,{id,status,body:{requestId:'queued:'+id,prompt:'Synthetic fixture prompt for '+id,kind:'codex'},execution:{state:'settled'},result,receiptId:'rcpt_fx_'+id.slice(2),route:{run_id:'run_fx_'+id.slice(2)},...extra});
  if(persisted)results.set(id,{taskId:id,resultState:'persisted',resultPersisted:true,result,metadata:{sha256:sha(result),bytes:Buffer.byteLength(result),complete:!partial,partial,requestId:'queued:'+id,providerReceiptId:'rcpt_fx_'+id.slice(2),providerRunId:'run_fx_'+id.slice(2)}});};
 let n=0;const attach=(input)=>workspace.attachCall({actionId:`attach_${String(++n).padStart(4,'0')}`,projectId:f.created.projectId,...input});
 return{...f,workspace,results,settle,attach,runs,receiptsDir:dir};}
const storeFile=f=>path.join(f.dataDir,'project-workspace','workspace.json');
test('attaching an existing call is idempotent, project scoped and never dispatches or adds messages',t=>{
 const f=attachFixture(t);f.settle('t_fx_done');f.workspace.sendMessage({actionId:'message_0001',threadId:f.created.threadId,text:'Pending coordinator work'});
 const input={actionId:'attach_0001',projectId:f.created.projectId,taskId:'t_fx_done',label:'Synthetic queued call'};
 const first=f.workspace.attachCall(input);assert.match(first.attachmentId,/^pc_[a-f0-9]{24}$/);assert.deepEqual(f.workspace.attachCall(input),{...first,idempotent:true});
 assert.throws(()=>f.workspace.attachCall({...input,label:'Changed'}),e=>e.status===409);
 assert.throws(()=>f.workspace.attachCall({...input,actionId:'attach_0002'}),e=>e.status===409&&/already attached/.test(e.message));
 const other=f.workspace.createProject({actionId:'project_0002',name:'Project B',cwd:f.dataDir});
 const second=f.workspace.attachCall({...input,actionId:'attach_0003',projectId:other.projectId});assert.notEqual(second.attachmentId,first.attachmentId);
 const a=f.workspace.view({projectId:f.created.projectId}),b=f.workspace.view({projectId:other.projectId});
 assert.deepEqual(a.attachedCalls.map(c=>c.id),[first.attachmentId]);assert.deepEqual(b.attachedCalls.map(c=>c.id),[second.attachmentId]);
 assert.equal(f.workspace.getAttachedCall({projectId:f.created.projectId,attachmentId:first.attachmentId}).verified.state,'completed');
 assert.throws(()=>f.workspace.getAttachedCall({projectId:other.projectId,attachmentId:first.attachmentId}),e=>e.status===404);
 assert.equal(a.thread.messages.length,1);assert.equal(b.thread.messages.length,0);assert.equal(a.tasks.length,0);
 assert.equal(f.submissions.length,0,'attach and reads do not dispatch pending work');
 f.workspace.tick();assert.equal(f.submissions.length,1,'the pending message was dispatchable, so zero above is meaningful');
});
test('attach validation rejects malformed IDs, oversized, binary and credential text before storage',t=>{
 const f=attachFixture(t),before=fs.readFileSync(storeFile(f),'utf8'),art=(text,extra={})=>({taskId:'t_fx_any',artifacts:[{role:'result',text,...extra}]});
 const rejects=[[{},400,/at least one/],[{taskId:'not-a-task'},400,/ZodError|Invalid/],[{taskId:'t_fx_any',extra:true},400,/ZodError|Unrecognized/],
  [art('x'.repeat(200001)),413,/200001 bytes/],[art('é'.repeat(100001)),413,/bytes/],[art('binary'+String.fromCharCode(1)+'data'),400,/binary or control/],[art('lone \uD800 surrogate'),400,/binary or control/],
  [art('Synthetic note with sk-'+'fixtureFIXTUREfixture0000 inside'),400,/credential or token/],[art('x',{origin:'bridge_verified'}),400,/Unrecognized|ZodError/],
  [{taskId:'t_fx_any',artifacts:[{role:'result',text:'a'},{role:'result',text:'b'}]},400,/at most one/],[art('x',{sha256:'abc'}),400,/ZodError|Invalid/]];
 for(const [input,status,pattern] of rejects)assert.throws(()=>f.attach(input),e=>(e.status||400)===status&&(pattern.test(e.message)||pattern.test(e.name)),JSON.stringify(input).slice(0,80));
 assert.throws(()=>f.workspace.attachCall({actionId:'attach_9999',projectId:'p_'+'0'.repeat(24),taskId:'t_fx_any'}),e=>e.status===404);
 assert.equal(fs.readFileSync(storeFile(f),'utf8'),before,'nothing was stored');
 const large='Synthetic large artifact line.\n'.repeat(7000).slice(0,200000);assert.equal(Buffer.byteLength(large),200000);
 const {attachmentId}=f.attach(art(large));const detail=f.workspace.getAttachedCall({projectId:f.created.projectId,attachmentId});
 assert.equal(detail.callerArtifacts[0].text,large);assert.equal(detail.callerArtifacts[0].callerDeclaredTruncated,false);assert.equal(f.submissions.length,0);
});
test('attached calls resolve task, live run, receipt and unavailable sources in priority order',t=>{
 const receipts=[{receiptId:'rcpt_fx_direct',event:'bridge_provider_call',status:'completed',timestamp:'2026-09-13T10:00:00Z',provider:'fixture',requestId:'fx-direct-0001',runId:'run_fx_direct',inputHash:sha('Synthetic direct prompt'),outputHash:sha('Synthetic direct output\n'),outputChars:24,prompt:'must not be surfaced',route:{requested_model:'fixture-standard',applied_effort:'medium',secret:'x'}},
  {receiptId:'rcpt_fx_partial',event:'bridge_provider_call',status:'timed_out',timestamp:'2026-09-13T10:01:00Z',requestId:'fx-partial-0001',runId:'run_fx_partial',partialResult:true,failureClass:'provider_timeout'}];
 const runs=[{runId:'run_fx_live',kind:'fixture',route:{request_id:'fx-live-0001',requested_model:'fixture-heavy',applied_effort:'high'},phase:'provider_running',ageMs:4200,bytes:512,lines:3},
  {runId:'run_fx_running',kind:'codex',route:{request_id:'queued:t_fx_running'},phase:'provider_running',ageMs:10,bytes:1}];
 const f=attachFixture(t,{runs,receipts});
 f.settle('t_fx_done');f.settle('t_fx_partial',{status:'failed',partial:true,partialCheckpoint:'Synthetic checkpoint'});f.settle('t_fx_lost',{persisted:false});
 f.tasks.set('t_fx_queued',{id:'t_fx_queued',status:'queued',body:{requestId:'queued:t_fx_queued',prompt:'p'},execution:{state:'reserved'}});
 f.tasks.set('t_fx_running',{id:'t_fx_running',status:'running',body:{requestId:'queued:t_fx_running',prompt:'p'},execution:{state:'dispatched'}});
 f.tasks.set('t_fx_stale',{id:'t_fx_stale',status:'running',body:{requestId:'queued:t_fx_stale',prompt:'p'},execution:{state:'dispatched'}});
 f.tasks.set('t_fx_nocontract',{id:'t_fx_nocontract',status:'done',body:{requestId:'queued:t_fx_nocontract',prompt:'p'},execution:{state:'settled'}});
 f.results.set('t_fx_nocontract',Object.assign(new Error('no delivery'),{code:'DELIVERY_UNAVAILABLE'}));
 const cases=[[{taskId:'t_fx_done'},'task','completed'],[{requestId:'queued:t_fx_queued'},'task','queued'],[{taskId:'t_fx_running'},'task','running'],[{taskId:'t_fx_partial'},'task','partial'],
  [{taskId:'t_fx_lost'},'task','result_unavailable'],[{taskId:'t_fx_nocontract'},'task','result_unavailable'],[{taskId:'t_fx_stale'},'task','running'],[{requestId:'fx-live-0001'},'active_run','running'],
  [{requestId:'fx-direct-0001'},'receipt','completed'],[{runId:'run_fx_partial'},'receipt','partial'],[{taskId:'t_fx_missing'},null,'unavailable'],[{requestId:'fx-unknown-0001'},null,'unavailable']];
 const ids=cases.map(([refs])=>f.attach(refs).attachmentId),view=f.workspace.view().attachedCalls;
 cases.forEach(([refs,source,state],i)=>{const call=view.find(c=>c.id===ids[i]);assert.equal(call.verified.source,source,JSON.stringify(refs));assert.equal(call.verified.state,state,JSON.stringify(refs));assert.deepEqual(call.callerArtifacts,[]);assert.equal(call.verified.mismatches.length,0,JSON.stringify(refs));});
 const byRefs=refs=>view.find(c=>c.id===ids[cases.findIndex(c=>isDeepStrictEqual(c[0],refs))]);
 assert.equal(byRefs({taskId:'t_fx_running'}).verified.live.runId,'run_fx_running');
 assert.deepEqual(byRefs({taskId:'t_fx_stale'}).verified.observations,['queue_reports_running_without_live_progress']);
 assert.equal(byRefs({taskId:'t_fx_nocontract'}).verified.result.unavailableReason,'no_result_delivery_contract');
 const live=byRefs({requestId:'fx-live-0001'}).verified.live;assert.deepEqual([live.runId,live.model,live.effort,live.bytes],['run_fx_live','fixture-heavy','high',512]);
 const direct=byRefs({requestId:'fx-direct-0001'}).verified;assert.equal(direct.result.state,'not_retained_by_bridge');assert.equal(direct.receipt.model,'fixture-standard');
 assert.doesNotMatch(JSON.stringify(direct),/must not be surfaced|"secret"/);
 assert.deepEqual(byRefs({taskId:'t_fx_missing'}).verified.unavailableReasons,['task_not_found','no_matching_receipt_in_scanned_window']);
 assert.deepEqual(byRefs({requestId:'fx-unknown-0001'}).verified.unavailableReasons,['no_active_run','no_matching_receipt_in_scanned_window']);
 const partial=f.workspace.getAttachedCall({projectId:f.created.projectId,attachmentId:ids[3]}).verified;assert.equal(partial.partialCheckpoint,'Synthetic checkpoint');assert.equal(partial.resultText,'Synthetic fixture result');
 const unconfigured=createProjectWorkspace({...f.options,activeRuns:()=>[]});assert.deepEqual(unconfigured.view().attachedCalls.at(-1).verified.unavailableReasons,['no_active_run','receipts_not_configured']);
 assert.equal(f.submissions.length,0);
});
test('disagreeing IDs surface both values without reconciling bridge identity or state',t=>{
 const receipts=[{receiptId:'rcpt_fx_foreign',event:'bridge_provider_call',status:'completed',timestamp:'2026-09-13T11:00:00Z',requestId:'fx-foreign-0001',runId:'run_fx_foreign',outputHash:sha('other')}];
 const f=attachFixture(t,{receipts});f.settle('t_fx_done');
 const wrongRequest=f.attach({taskId:'t_fx_done',requestId:'fx-wrong-request-01'}).attachmentId,wrongReceipt=f.attach({taskId:'t_fx_done',receiptId:'rcpt_fx_foreign'}).attachmentId;
 const consistent=f.attach({taskId:'t_fx_done',requestId:'queued:t_fx_done',runId:'run_fx_fx_done'}).attachmentId;
 const view=Object.fromEntries(f.workspace.view().attachedCalls.map(c=>[c.id,c.verified]));
 assert.equal(view[wrongRequest].displayState,'id_mismatch');assert.equal(view[wrongRequest].state,'completed');assert.equal(view[wrongRequest].refStatus.taskId,'confirmed');
 assert.deepEqual(view[wrongRequest].mismatches,[{field:'requestId',supplied:'fx-wrong-request-01',bridge:'queued:t_fx_done',sources:['task']}]);
 const fields=view[wrongReceipt].mismatches.map(m=>[m.field,m.supplied,m.bridge]).sort();
 // Calls may span several receipts, so the named receipt is confirmed; its foreign request identity is the disagreement.
 assert.deepEqual(fields,[['requestId',null,'fx-foreign-0001'],['requestId',null,'queued:t_fx_done']]);assert.equal(view[wrongReceipt].refStatus.receiptId,'confirmed');assert.equal(view[wrongReceipt].displayState,'id_mismatch');
 assert.equal(view[consistent].correlation,'consistent');assert.equal(view[consistent].displayState,'completed');
 const stored=JSON.parse(fs.readFileSync(storeFile(f),'utf8')).attachedCalls.find(c=>c.id===wrongRequest);assert.deepEqual(stored.refs,{requestId:'fx-wrong-request-01',taskId:'t_fx_done'});
});
test('caller artifacts keep origin, hashes and claimed IDs separate from bridge verification',t=>{
 const f=attachFixture(t,{receipts:[{receiptId:'rcpt_fx_direct',event:'bridge_provider_call',status:'completed',timestamp:'2026-09-13T10:00:00Z',requestId:'fx-direct-0001',inputHash:sha('Synthetic effective prompt'),outputHash:sha('Synthetic direct output\n')}]});
 f.tasks.set('t_fx_queued',{id:'t_fx_queued',status:'queued',body:{requestId:'queued:t_fx_queued',prompt:'Synthetic queued prompt'},execution:{state:'reserved'}});f.settle('t_fx_done');
 const hostile='{"status":"completed","taskId":"t_fx_other"} <img src=x onerror=alert(1)> <script>alert(1)</script>';
 const queued=f.attach({taskId:'t_fx_queued',artifacts:[{role:'result',text:hostile,sha256:sha(hostile).toUpperCase(),source:'Synthetic caller notes',claimedIds:{taskId:'t_fx_other'}},{role:'request',text:'Synthetic queued prompt',sha256:'0'.repeat(64)}]}).attachmentId;
 const done=f.attach({taskId:'t_fx_done',artifacts:[{role:'result',text:'Synthetic fixture result',claimedIds:{receiptId:'rcpt_fx_fx_done'}}]}).attachmentId;
 const drifted=f.attach({requestId:'queued:t_fx_done',artifacts:[{role:'result',text:'A different pasted result',truncated:true}]}).attachmentId;
 const direct=f.attach({requestId:'fx-direct-0001',artifacts:[{role:'result',text:'Synthetic direct output\n'},{role:'request',text:'Synthetic caller prompt'}]}).attachmentId;
 const view=Object.fromEntries(f.workspace.view().attachedCalls.map(c=>[c.id,c]));
 const q=view[queued];assert.equal(q.verified.state,'queued');assert.equal(q.verified.identity.taskId,'t_fx_queued');assert.equal(q.verified.result.retainedByBridge,false);
 const [result,request]=q.callerArtifacts;assert.equal(result.origin,'caller_supplied');assert.equal(result.text,undefined,'summaries omit text');
 assert.equal(result.callerHashCheck,'matches');assert.equal(result.storedHash,sha(hostile));assert.equal(result.correlation,'id_mismatch');
 assert.deepEqual(result.idMismatches,[{field:'taskId',claimed:'t_fx_other',bridge:'t_fx_queued'}]);assert.equal(result.bridgeHashCheck,'not_comparable');
 assert.equal(request.callerHashCheck,'mismatch');assert.equal(request.bridgeHashCheck,'matches_bridge_request');
 assert.equal(view[done].callerArtifacts[0].bridgeHashCheck,'matches_bridge_result');assert.equal(view[done].callerArtifacts[0].correlation,'matches');
 assert.equal(view[drifted].callerArtifacts[0].bridgeHashCheck,'differs_from_bridge_result');assert.equal(view[drifted].callerArtifacts[0].callerDeclaredTruncated,true);assert.equal(view[drifted].verified.state,'completed');
 assert.deepEqual(view[direct].callerArtifacts.map(a=>a.bridgeHashCheck),['matches_receipt_output','differs_from_receipt_input']);assert.equal(view[direct].verified.source,'receipt');
 const detail=f.workspace.getAttachedCall({projectId:f.created.projectId,attachmentId:queued});assert.equal(detail.callerArtifacts[0].text,hostile);assert.equal(detail.callerArtifacts[0].storedTextCheck,'matches_stored_hash');
 assert.equal(detail.verified.resultText,null);assert.equal(detail.verified.state,'queued');
 const stored=JSON.parse(fs.readFileSync(storeFile(f),'utf8')).attachedCalls;assert.ok(stored.every(c=>c.artifacts.every(a=>a.origin==='caller_supplied'&&a.storedHash===sha(a.text))));
 f.workspace.sendMessage({actionId:'message_0001',threadId:f.created.threadId,text:'What next?'});f.workspace.tick();assert.doesNotMatch(f.submissions[0].intent.prompt,/onerror|Synthetic caller notes/);
});
test('existing project storage without attached calls stays readable and malformed attachments are refused',t=>{
 const f=attachFixture(t),file=storeFile(f),legacy=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(legacy.attachedCalls,undefined);
 const view=f.workspace.view();assert.equal(view.storageError,undefined);assert.deepEqual(view.attachedCalls,[]);
 f.attach({taskId:'t_fx_any'});const saved=JSON.parse(fs.readFileSync(file,'utf8'));assert.deepEqual(saved.projects,legacy.projects);assert.deepEqual(saved.threads,legacy.threads);assert.equal(saved.attachedCalls.length,1);
 fs.writeFileSync(file,JSON.stringify({...saved,attachedCalls:[{...saved.attachedCalls[0],projectId:'p_'+'f'.repeat(24)}]}));assert.ok(f.workspace.view().storageError);
 fs.writeFileSync(file,JSON.stringify({...saved,attachedCalls:'not a list'}));assert.throws(()=>f.attach({taskId:'t_fx_other'}),e=>e.status===503);
});
test('attached call count is bounded per project',t=>{const f=attachFixture(t,{receiptsDir:null});for(let i=0;i<50;i++)f.attach({taskId:`t_fx_${i}`});assert.throws(()=>f.attach({taskId:'t_fx_50'}),e=>e.status===413);
 const other=f.workspace.createProject({actionId:'project_0002',name:'Project B',cwd:f.dataDir});assert.ok(f.workspace.attachCall({actionId:'attach_other1',projectId:other.projectId,taskId:'t_fx_50'}).attachmentId);});
