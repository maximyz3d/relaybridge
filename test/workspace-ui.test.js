'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const S=require('../public/workspace-state');
test('workspace groups actual states and keeps pending writers out of active work',()=>{const groups=S.taskGroups([{id:'a',state:'running'},{id:'b',state:'awaiting_writer'},{id:'c',state:'needs_attention'},{id:'d',state:'completed'}]);assert.deepEqual(groups.active.map(t=>t.id),['a']);assert.deepEqual(groups.queued.map(t=>t.id),['b']);assert.deepEqual(groups.blocked.map(t=>t.id),['c']);assert.equal(S.status('awaiting_writer'),'Ready for writer');});
test('unknown or stale usage never becomes a percentage',()=>{for(const usage of [null,{}, {freshness:'stale',percentRemaining:50},{freshness:'fresh',percentRemaining:null}])assert.equal(S.formatUsage(usage),'Usage not reported');assert.equal(S.formatUsage({freshness:'fresh',percentRemaining:42}),'42% remaining');});
test('state merge preserves selection and unsent draft',()=>{const prior={projectId:'p',threadId:'t',draft:'Unsent work',scroll:150};assert.deepEqual(S.mergeSelection(prior,{projects:[{id:'p'}],threads:[{id:'t'}],project:{id:'p'},thread:{id:'t'}}),prior);});
test('project activity survives conversation selection and prioritizes running work',()=>{
 const running={id:'other',title:'Earlier conversation',state:'consulting',role:'advisor',queueTaskId:'active',model:'heavy',progress:{ageMs:1234}};
 const queued={id:'selected',title:'Current conversation',state:'queued',queueTaskId:'waiting'};
 for(const thread of [{id:'idle',state:'idle'},queued]){
  const work=S.currentWork({thread,activity:[queued,running],tasks:[]});
  assert.equal(work.threadId,'other');assert.equal(work.conversationTitle,running.title);assert.equal(work.queueTaskId,'active');assert.deepEqual(work.progress,running.progress);
 }
 assert.equal(S.currentWork({thread:queued,activity:[queued],tasks:[{id:'worker',state:'running'}]}).id,'worker');
});
test('workspace shell has accessible controls and external scripts without unsafe rendering',()=>{const html=fs.readFileSync(path.join(__dirname,'../public/control-center.html'),'utf8');const js=fs.readFileSync(path.join(__dirname,'../public/workspace.js'),'utf8');assert.match(html,/<nav aria-label="Projects">/);assert.match(html,/role="log"/);assert.match(html,/aria-label="Send message"/);assert.match(html,/href="\/terminal"/);assert.doesNotMatch(html,/<script(?![^>]*\bsrc=)[^>]*>/);assert.doesNotMatch(html,/\son\w+=/);assert.doesNotMatch(js,/\.innerHTML\s*=/);assert.match(js,/rb:workspace:pending/);});
test('attached call helpers keep caller text verbatim, bounded and separate from bridge state',()=>{
 for(const [state,label] of [['id_mismatch','IDs disagree'],['partial','Partial result'],['unavailable','Not found by bridge'],['result_unavailable','Result not retained']])assert.equal(S.status(state),label);
 assert.throws(()=>S.attachPayload({projectId:'p_fx',requestId:'  '}),/at least one/);
 const text='  Synthetic pasted result\n<b>not markup</b>  ';
 assert.deepEqual(S.attachPayload({projectId:'p_fx',label:' ',taskId:' t_fx_ui ',runId:'',result:{text,sha256:'',source:' notes ',truncated:false,claimedIds:{requestId:'',receiptId:'rcpt_fx_ui'}},request:{text:'   '}}),
  {projectId:'p_fx',taskId:'t_fx_ui',artifacts:[{role:'result',text,source:'notes',claimedIds:{receiptId:'rcpt_fx_ui'}}]});
 assert.throws(()=>S.attachPayload({projectId:'p_fx',taskId:'t_fx_ui',result:{text:'é'.repeat(100001)}}),/200002 bytes/);
 const summary=S.attachedCallSummary({id:'pc_fx',refs:{requestId:'fx-request-01'},verified:{source:'receipt',displayState:'id_mismatch'},callerArtifacts:[{role:'result',origin:'caller_supplied'}]});
 assert.deepEqual(summary,{title:'Request fx-request-01',state:'id_mismatch',line:'IDs disagree · bridge receipt',callerTexts:1});
 assert.equal(S.attachedCallSummary({id:'pc_fx',refs:{},callerArtifacts:[{text:'completed'}]}).state,'unavailable');assert.equal(S.hashCheckText('bogus'),'Not compared');
});
test('attach route source never schedules a coordinator tick',()=>{const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 const start=server.indexOf("app.post('/api/project-workspace/attach-call'"),end=server.indexOf('app.get(',start);assert.ok(start>0&&end>start);
 const handler=server.slice(start,end);assert.match(handler,/projectWorkspace\.attachCall/);assert.doesNotMatch(handler,/tick|submitDurable|setImmediate/);
 assert.doesNotMatch(server.slice(server.indexOf('app.get(\'/api/project-workspace/attached-calls/:id\''),end+400),/tick\(/);});
// Minimal DOM double: enough surface for workspace.js, and innerHTML is a hard failure.
function fakeDom(){const byId=new Map(),created=[],root={children:[]};
 class Node{constructor(tag){this.tagName=String(tag).toUpperCase();this.children=[];this.parent=null;this.dataset={};this.style={};this.attributes={};this.className='';this.text='';this.value='';this.checked=false;this.disabled=false;this.hidden=false;
  const classes=new Set();this.classList={add:c=>classes.add(c),remove:c=>classes.delete(c),toggle:c=>classes.has(c)?classes.delete(c):classes.add(c),contains:c=>classes.has(c)};created.push(this);}
  set id(value){this._id=value;byId.set(value,this);} get id(){return this._id;}
  set innerHTML(_){throw new Error('innerHTML is not allowed');} set outerHTML(_){throw new Error('outerHTML is not allowed');}
  set textContent(value){this.children=[];this.text=String(value);} get textContent(){return this.text+this.children.map(c=>c.textContent).join('');}
  append(...nodes){for(const node of nodes){const child=typeof node==='string'?Object.assign(new Node('#text'),{text:node}):node;child.parent=this;this.children.push(child);}}
  replaceChildren(...nodes){this.children=[];this.text='';this.append(...nodes);}
  after(node){const siblings=(this.parent||root).children;siblings.splice(siblings.indexOf(this)+1,0,node);node.parent=this.parent;}
  setAttribute(k,v){this.attributes[k]=String(v);} focus(){} addEventListener(){} reset(){} showModal(){this.open=true;} close(){this.open=false;}
  closest(tag){let node=this;while(node&&node.tagName!==tag.toUpperCase())node=node.parent;return node;}
  all(){return [this,...this.children.flatMap(c=>c.all())];}
  querySelector(selector){return this.all().slice(1).find(n=>selector==='[type=submit]'?n.type==='submit':selector.startsWith('.')&&n.className.split(' ').includes(selector.slice(1)))||null;}}
 const document={createElement:tag=>new Node(tag),createTextNode:text=>Object.assign(new Node('#text'),{text}),body:new Node('body'),documentElement:{dataset:{}},hidden:false,activeElement:null,addEventListener(){},querySelectorAll:()=>[],
  getElementById(id){if(!byId.has(id)){const node=new Node('div');node.id=id;node.parent=null;root.children.push(node);}return byId.get(id);}};
 return{document,created,byId};}
test('workspace renders attached call detail and caller text as full plain text and posts attach without other routes',async()=>{
 const dom=fakeDom(),posts=[],large='Synthetic line of pasted caller output.\n'.repeat(160),hostile='<img src=x onerror=alert(1)><script>alert(1)</script>';assert.ok(Buffer.byteLength(large)>4096);
 const call={id:'pc_'+'a'.repeat(24),projectId:'p_'+'b'.repeat(24),label:'Synthetic direct call',refs:{requestId:'fx-request-ui1'},attachedAt:1,observedAt:Date.now(),
  verified:{source:'receipt',state:'completed',displayState:'id_mismatch',correlation:'id_mismatch',refStatus:{requestId:'confirmed'},mismatches:[{field:'taskId',supplied:null,bridge:'t_fx_bridge',sources:['receipt rcpt_fx_ui']}],identity:{},unavailableReasons:[],observations:[],task:null,
   result:{state:'not_retained_by_bridge',retainedByBridge:false,outputHash:'c'.repeat(64)},receipt:{receiptId:'rcpt_fx_ui',event:'bridge_provider_call',status:'completed'},live:null,receiptScan:{limited:false},resultText:null,partialCheckpoint:null,receipts:[]},
  callerArtifacts:[{role:'result',origin:'caller_supplied',source:hostile,bytes:Buffer.byteLength(large+hostile),storedHash:'d'.repeat(64),callerClaimedHash:null,callerHashCheck:'not_supplied',callerDeclaredTruncated:false,claimedIds:{receiptId:'rcpt_fx_other'},
   correlation:'id_mismatch',idMismatches:[{field:'receiptId',claimed:'rcpt_fx_other',bridge:'rcpt_fx_ui'}],bridgeHashCheck:'differs_from_receipt_output',text:large+hostile,storedTextCheck:'matches_stored_hash'}]};
 const summary={...call,callerArtifacts:call.callerArtifacts.map(({text,storedTextCheck,...a})=>a)},project={id:call.projectId,name:'Synthetic project',cwd:'/fixture'};
 const state={projects:[project],project,threads:[{id:'th_fx',title:'Synthetic'}],thread:{id:'th_fx',title:'Synthetic',state:'idle',messages:[]},activity:[],tasks:[],attachedCalls:[summary],settings:{}};
 const fetch=async(url,options={})=>{const body=url==='/api/capability'?{token:'fixture'}:url.startsWith('/api/project-workspace/state')?state:url.startsWith('/api/project-workspace/attached-calls/')?call:null;
  if(options.method==='POST'){posts.push({url,body:JSON.parse(options.body)});return{ok:true,status:201,json:async()=>({attachmentId:call.id,projectId:project.id})};}
  return body?{ok:true,status:200,json:async()=>body}:{ok:false,status:404,json:async()=>({error:'not found'})};};
 const store=new Map(),context={document:dom.document,fetch,console,URLSearchParams,URL,AbortSignal,TextEncoder,crypto:require('node:crypto'),WorkspaceState:S,matchMedia:()=>({matches:false}),requestAnimationFrame:f=>f(),setInterval:()=>0,setTimeout,addEventListener(){},
  localStorage:{getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)}};context.window=context;
 const vm=require('node:vm'),flush=async()=>{for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/workspace.js'),'utf8'),vm.createContext(context));await flush();
 const card=dom.byId.get('attached-call-list').children[0];assert.match(card.textContent,/Synthetic direct call.*IDs disagree · bridge receipt · 1 pasted text \(unverified\)/s);
 card.onclick();await flush();const detail=dom.byId.get('task-detail'),text=detail.textContent;assert.equal(dom.byId.get('task-detail-dialog').open,true);
 assert.ok(text.includes(large+hostile),'the full caller text renders');assert.match(text,/UNVERIFIED — PASTED BY YOU · RESULT/);assert.match(text,/You supplied this text/);
 assert.match(text,/BRIDGE RECORD/);assert.ok(text.indexOf('BRIDGE RECORD')<text.indexOf('UNVERIFIED'));assert.match(text,/t_fx_bridge/);assert.match(text,/rcpt_fx_other.*rcpt_fx_ui/s);assert.doesNotMatch(text,/truncated at its source/);
 assert.ok(!dom.created.some(n=>['IMG','SCRIPT'].includes(n.tagName)),'caller markup never becomes elements');
 for(const [id,value] of [['attach-taskId',' t_fx_ui '],['attach-result-text',large],['attach-result-source','Synthetic notes']])dom.byId.get(id).value=value;
 dom.byId.get('attach-call-form').onsubmit({preventDefault(){}});await flush();
 assert.deepEqual(posts.map(p=>p.url),['/api/project-workspace/attach-call']);const body=posts[0].body;
 assert.match(body.actionId,/^[A-Za-z0-9_]{36}$/);assert.deepEqual({...body,actionId:undefined},{actionId:undefined,projectId:project.id,taskId:'t_fx_ui',artifacts:[{role:'result',text:large,source:'Synthetic notes'}]});
 assert.equal(store.get('rb:workspace:pending'),undefined,'accepted attach clears the pending submission');
});
