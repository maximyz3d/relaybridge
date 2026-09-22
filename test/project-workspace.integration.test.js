'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {startTestBridge,waitFor,completeJsonLines}=require('./helpers/temporary-bridge');
// Clear inherited bridge settings, but never the temporary config/data/token/root paths the helper assigns.
const HELPER_ENV=new Set(['RELAYBRIDGE_CONFIG_FILE','RELAYBRIDGE_TOKEN_FILE','RELAYBRIDGE_DATA_DIR','RELAYBRIDGE_ALLOWED_ROOTS','RELAYBRIDGE_TEST_BUILD_ID']);
const inheritedBridgeEnv=()=>Object.fromEntries(Object.keys(process.env).filter(k=>/^(RELAYBRIDGE_|PS_BRIDGE_)/.test(k)&&!HELPER_ENV.has(k)).map(k=>[k,undefined]));
async function fixture(t, providerOverrides={}){let events;const unset=inheritedBridgeEnv();
 const bridge=await startTestBridge(t,root=>{events=path.join(root,'events.jsonl');const script=path.join(root,'provider.cjs');fs.writeFileSync(script,`const fs=require('node:fs');let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({kind:process.argv[2],args:process.argv.slice(3),prompt})+'\\n');if(prompt.includes('INVALID_DECISION_FIXTURE'))console.log('not a decision');else if(prompt.includes('You are a senior project advisor'))console.log('ADVISOR_EVIDENCE: inspect the existing record contract first.');else if(prompt.includes('Perform this bounded read-only task'))console.log('Read-only inspection complete; no files changed.');else if(prompt.includes('Advisor result (must inform this decision)'))console.log(JSON.stringify({action:'allocate',text:'The advisor recommends inspecting the existing records first.',tasks:[{title:'Inspect records',kind:'read_only',provider:'codex',tier:'light',prompt:'Inspect the record contract read-only.'}]}));else console.log(JSON.stringify({action:'consult',question:'How should we preserve the existing record contract?'}));});`);
 return{_models:{discoverOnBoot:false},...Object.fromEntries(['codex','claude'].map(kind=>[kind,{label:kind,model:'fixture-standard',safe:[process.execPath],probe:[process.execPath,'--version'],version_probe:[process.execPath,'--version'],
 oneshot_safe:[process.execPath,script,kind,'--model','fixture-standard','--effort','medium'],oneshot_output_parser:'text',oneshot_safe_filesystem_policy:'read_only_enforced',oneshot_capabilities:{safe:['model_invocation','workspace_read','tool_use']},
 effort_flags:Object.fromEntries(['low','medium','high'].map(x=>[x,['--effort',x]])),model_tiers:Object.fromEntries(['light','standard','heavy'].map(x=>[x,{model:'fixture-'+x,args:['--model','fixture-'+x]}])),...(providerOverrides[kind]||{})}]))};
 },{env:{...unset,RELAYBRIDGE_WARM_DIAG:'0',RELAYBRIDGE_REMOTE_MCP:'0'}});return{...bridge,events};}
test('project chat performs durable Codex → stronger advisor → Codex → worker round trip',{timeout:45000},async t=>{const b=await fixture(t);const created=await b.request('/api/project-workspace/projects',{actionId:'project_0001',name:'Project test',cwd:b.root});assert.equal(created.status,202,JSON.stringify(created.body));const {threadId,projectId}=created.body;
 const input={actionId:'message_0001',threadId,text:'Design the next project step.'};assert.equal((await b.request('/api/project-workspace/messages',input)).status,202);assert.equal((await b.request('/api/project-workspace/messages',input)).status,200);
 const state=await waitFor(async()=>{const v=(await b.request('/api/project-workspace/state')).body;return v.tasks?.[0]?.state==='completed'&&v;},35000);
 assert.equal(state.project.id,projectId);const events=completeJsonLines(b.events);assert.deepEqual(events.map(e=>e.kind),['codex','claude','codex','codex']);assert.ok(events[1].args.includes('fixture-heavy'));assert.ok(events[1].args.includes('high'));assert.match(events[2].prompt,/ADVISOR_EVIDENCE/);assert.match(events[2].prompt,/queued:t_pw_/);assert.equal(state.thread.messages.filter(m=>m.role==='user').length,1);assert.equal(state.tasks.length,1);const delivered=(await b.request('/api/tasks/'+state.tasks[0].queueTaskId+'/result')).body;assert.equal(delivered.resultPersisted,true);assert.equal(delivered.metadata.complete,true);
 const other=(await b.request('/api/project-workspace/projects',{actionId:'project_0002',name:'Second',cwd:b.root})).body;const empty=(await b.request('/api/project-workspace/state?projectId='+other.projectId)).body;assert.equal(empty.thread.messages.length,0);
 assert.equal((await b.request('/api/project-workspace/projects',{actionId:'project_0003',name:'Outside',cwd:path.resolve(b.root,'..')})).status,400);
 const rejected=await b.request('/api/project-workspace/messages',{actionId:'message_0001',threadId,text:'Different request'});assert.equal(rejected.status,409);
 const raw=await fetch(b.base+'/api/project-workspace/state');assert.equal(raw.status,401);
});
test('project advisor pins configured complex budget, which is resolved and exposed but never stops usage (Refs #133)',{timeout:45000},async t=>{const budget={maxOutputTokens:20000,maxTotalTokens:900000,maxCacheReadTokens:700000,maxCacheCreationTokens:150000,maxTurns:null};const b=await fixture(t,{claude:{supervisor:{providerBudgetByTaskTier:{complex:budget}}}});const created=(await b.request('/api/project-workspace/projects',{actionId:'project_0001',name:'Budget project',cwd:b.root})).body;
 await b.request('/api/project-workspace/messages',{actionId:'message_0001',threadId:created.threadId,text:'Design a complex migration.'});
 const state=await waitFor(async()=>{const v=(await b.request('/api/project-workspace/state')).body;return v.tasks?.[0]?.state==='completed'&&v;},35000);
 const advisor=state.thread.messages.find(m=>m.role==='advisor');assert.ok(advisor?.taskId,'advisor task identity is retained');
 const persisted=JSON.parse(fs.readFileSync(path.join(b.root,'data','tasks',advisor.taskId+'.json'),'utf8'));assert.deepEqual(persisted.body.providerBudget,budget);
 const {RunSupervisor}=require('../lib/run-supervisor');const supervisor=new RunSupervisor({providerBudget:persisted.body.providerBudget});
 supervisor.recordProviderUsage({output_tokens:budget.maxOutputTokens+1},{phase:'incremental'});
 const verdict=supervisor.evaluate();assert.equal(verdict.action,'continue','exceeding the resolved output-token ceiling never stops the run any more');
 assert.equal(supervisor.snapshot().ignoredCaps.providerBudget.maxOutputTokens,budget.maxOutputTokens,'the resolved-but-unenforced ceiling is still visible via ignoredCaps');
});
test('workspace routes retain CSP and coding tasks use valid real workflow IDs',{timeout:25000},async t=>{const b=await fixture(t);for(const route of ['/','/control-center.html']){const response=await fetch(b.base+route);assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy'),/script-src-attr 'none'/);assert.equal(response.headers.get('x-frame-options'),'DENY');assert.match(await response.text(),/What are we building/);}
 const legacy=await fetch(b.base+'/terminal');assert.match(await legacy.text(),/<script nonce="[A-Za-z0-9+/=]+">\s*const API/);
 for(const route of ['//control-center.html','/%2fcontrol-center.html','//index.html']){const r=await fetch(b.base+route);assert.equal(r.status,404,route);}
 const created=(await b.request('/api/project-workspace/projects',{actionId:'project_0001',name:'Coding',cwd:b.root})).body;
 await b.request('/api/project-workspace/tasks',{actionId:'coding_00001',threadId:created.threadId,title:'Build change',prompt:'Implement a bounded change after planning.',kind:'coding'});
 const task=await waitFor(async()=>{const v=(await b.request('/api/project-workspace/state')).body.tasks[0];return v?.workflowId&&v;});
 const workflow=(await b.request('/api/workflows/'+task.workflowId)).body;assert.equal(workflow.workflow.runId,task.workflowId);assert.equal(workflow.workflow.permissionMode,'safe');assert.equal(workflow.workflow.writerLease,null);
});
// Existing-call attachment: synthetic IDs and mock providers only. Attaching and reading must never dispatch.
const attachBody=(projectId,extra)=>({actionId:'attach_'+Math.random().toString(36).slice(2,12).padEnd(10,'0'),projectId,...extra});
test('attaching a completed queued task to another project is observational, idempotent and project scoped',{timeout:60000},async t=>{const b=await fixture(t);
 const first=(await b.request('/api/project-workspace/projects',{actionId:'project_0001',name:'Origin project',cwd:b.root})).body;
 const created=await b.request('/api/project-workspace/tasks',{actionId:'readonly_0001',threadId:first.threadId,title:'Inspect records',prompt:'Inspect the record contract read-only.',kind:'read_only'});assert.equal(created.status,202,JSON.stringify({first,created:created.body}));
 const done=await waitFor(async()=>{const v=(await b.request('/api/project-workspace/state?projectId='+first.projectId)).body.tasks?.[0];return v?.state==='completed'&&v.queueTaskId&&v;},35000);
 const delivered=(await b.request('/api/tasks/'+done.queueTaskId+'/result')).body;assert.equal(delivered.resultPersisted,true);
 const second=(await b.request('/api/project-workspace/projects',{actionId:'project_0002',name:'Follow-up project',cwd:b.root})).body;
 const taskFiles=()=>fs.readdirSync(path.join(b.root,'data','tasks')).length;await new Promise(r=>setTimeout(r,1500));
 const before={events:completeJsonLines(b.events).length,tasks:taskFiles()};
 const body=attachBody(second.projectId,{label:'Synthetic queued call',taskId:done.queueTaskId,artifacts:[{role:'result',text:delivered.result,source:'Synthetic copy of the bridge result'}]});
 const attached=await b.request('/api/project-workspace/attach-call',body);assert.equal(attached.status,201,JSON.stringify(attached.body));
 assert.equal((await b.request('/api/project-workspace/attach-call',body)).status,200);
 assert.equal((await b.request('/api/project-workspace/attach-call',{...body,label:'Changed'})).status,409);
 assert.equal((await b.request('/api/project-workspace/attach-call',{...body,actionId:'attach_duplicate1'})).status,409);
 const state=(await b.request('/api/project-workspace/state?projectId='+second.projectId)).body;
 assert.equal(state.thread.messages.length,0);assert.equal(state.tasks.length,0);assert.equal(state.attachedCalls.length,1);
 const summary=state.attachedCalls[0];assert.equal(summary.verified.source,'task');assert.equal(summary.verified.state,'completed');assert.equal(summary.verified.refStatus.taskId,'confirmed');
 assert.equal(summary.verified.result.sha256,delivered.metadata.sha256);assert.equal(summary.callerArtifacts[0].origin,'caller_supplied');assert.equal(summary.callerArtifacts[0].bridgeHashCheck,'matches_bridge_result');assert.equal(summary.callerArtifacts[0].text,undefined);
 const detail=await b.request('/api/project-workspace/attached-calls/'+attached.body.attachmentId+'?projectId='+second.projectId);
 assert.equal(detail.status,200);assert.equal(detail.body.verified.resultText,delivered.result);assert.equal(detail.body.callerArtifacts[0].text,delivered.result);
 assert.equal((await b.request('/api/project-workspace/attached-calls/'+attached.body.attachmentId+'?projectId='+first.projectId)).status,404);
 assert.equal((await b.request('/api/project-workspace/state?projectId='+first.projectId)).body.attachedCalls.length,0);
 const mismatch=await b.request('/api/project-workspace/attach-call',attachBody(second.projectId,{taskId:done.queueTaskId,requestId:'fx-other-request-01'}));assert.equal(mismatch.status,201);
 const unknown=await b.request('/api/project-workspace/attach-call',attachBody(second.projectId,{taskId:'t_fx_missing_task'}));assert.equal(unknown.status,201);
 const calls=Object.fromEntries((await b.request('/api/project-workspace/state?projectId='+second.projectId)).body.attachedCalls.map(c=>[c.id,c]));
 assert.equal(calls[mismatch.body.attachmentId].verified.displayState,'id_mismatch');assert.deepEqual(calls[mismatch.body.attachmentId].verified.mismatches.map(m=>[m.field,m.supplied]),[['requestId','fx-other-request-01']]);
 assert.equal(calls[unknown.body.attachmentId].verified.state,'unavailable');assert.ok(calls[unknown.body.attachmentId].verified.unavailableReasons.includes('task_not_found'));
 for(const invalid of [attachBody(second.projectId,{}),attachBody(second.projectId,{taskId:done.queueTaskId,origin:'bridge'}),attachBody(second.projectId,{taskId:'not-a-task'}),attachBody('p_'+'0'.repeat(24),{taskId:done.queueTaskId}),
  attachBody(second.projectId,{taskId:done.queueTaskId,artifacts:[{role:'result',text:'x'.repeat(200001)}]})]){const r=await b.request('/api/project-workspace/attach-call',invalid);assert.ok([400,404,413].includes(r.status),JSON.stringify(r.body));}
 assert.equal((await fetch(b.base+'/api/project-workspace/attach-call',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status,401);
 await new Promise(r=>setTimeout(r,1500));assert.deepEqual({events:completeJsonLines(b.events).length,tasks:taskFiles()},before,'attach and reads dispatch nothing');
});
test('attached direct call follows a live run to its terminal receipt without retaining or inventing a result',{timeout:60000},async t=>{
 const unset=inheritedBridgeEnv();
 const b=await startTestBridge(t,root=>{const helper=path.join(root,'hold.cjs');fs.writeFileSync(helper,"const fs=require('node:fs');const label=process.argv[2];setInterval(()=>{if(fs.existsSync('release-'+label)){console.log('Synthetic fixture completed '+label);process.exit(0);}},25);");
  return{_models:{discoverOnBoot:false},fixture:{oneshot_safe:[process.execPath,helper,'{prompt}'],oneshot_capabilities:{safe:['model_invocation']}}};},{env:{...unset,RELAYBRIDGE_WARM_DIAG:'0',RELAYBRIDGE_REMOTE_MCP:'0'}});
 const project=(await b.request('/api/project-workspace/projects',{actionId:'project_0001',name:'Direct call project',cwd:b.root})).body;
 let early=null;const pending=b.request('/api/oneshot',{kind:'fixture',prompt:'D',cwd:b.root,dangerous:false,requestId:'fx-direct-0001'});pending.then(v=>{early=v;});
 const run=await waitFor(async()=>(await b.request('/api/runs/active')).body.runs?.find(r=>r.route.request_id==='fx-direct-0001'),15000).catch(error=>{throw new Error(error.message+': '+JSON.stringify(early));});
 const attached=await b.request('/api/project-workspace/attach-call',attachBody(project.projectId,{label:'Synthetic direct call',requestId:'fx-direct-0001'}));assert.equal(attached.status,201,JSON.stringify(attached.body));
 let call=(await b.request('/api/project-workspace/state?projectId='+project.projectId)).body.attachedCalls[0];
 assert.equal(call.verified.source,'active_run');assert.equal(call.verified.state,'running');assert.equal(call.verified.live.runId,run.runId);assert.equal(call.verified.refStatus.requestId,'confirmed');
 fs.writeFileSync(path.join(b.root,'release-D'),'fixture-only');const response=(await pending).body;assert.equal(response.exitCode,0,JSON.stringify(response));
 call=await waitFor(async()=>{const c=(await b.request('/api/project-workspace/state?projectId='+project.projectId)).body.attachedCalls[0];return c.verified.source==='receipt'&&c;},10000);
 assert.equal(call.verified.state,'completed');assert.equal(call.verified.live,null);assert.equal(call.verified.result.retainedByBridge,false);assert.equal(call.verified.result.state,'not_retained_by_bridge');
 const other=(await b.request('/api/project-workspace/projects',{actionId:'project_0002',name:'Pasted result project',cwd:b.root})).body;
 const pasted=await b.request('/api/project-workspace/attach-call',attachBody(other.projectId,{requestId:'fx-direct-0001',receiptId:call.verified.identity.receiptId,artifacts:[{role:'result',text:response.stdout,claimedIds:{requestId:'fx-direct-0001'}},{role:'request',text:'<b>D</b>',claimedIds:{requestId:'fx-direct-0002'}}]}));
 assert.equal(pasted.status,201,JSON.stringify(pasted.body));
 const detail=(await b.request('/api/project-workspace/attached-calls/'+pasted.body.attachmentId+'?projectId='+other.projectId)).body;
 assert.equal(detail.verified.resultText,null);assert.equal(detail.verified.refStatus.receiptId,'confirmed');
 const [result,request]=detail.callerArtifacts;assert.equal(result.bridgeHashCheck,'matches_receipt_output');assert.equal(result.correlation,'matches');assert.equal(result.text,response.stdout);
 assert.equal(request.correlation,'id_mismatch');assert.deepEqual(request.idMismatches,[{field:'requestId',claimed:'fx-direct-0002',bridge:'fx-direct-0001'}]);assert.equal(request.text,'<b>D</b>');assert.equal(detail.verified.identity.requestId,'fx-direct-0001');
 assert.equal((await b.request('/api/project-workspace/state?projectId='+project.projectId)).body.attachedCalls.length,1);
 const receiptsDir=path.join(b.root,'data','receipts');assert.equal(fs.readdirSync(receiptsDir).flatMap(f=>completeJsonLines(path.join(receiptsDir,f))).filter(r=>r.event==='bridge_provider_call').length,1,'only the original direct call reached a provider');
});
