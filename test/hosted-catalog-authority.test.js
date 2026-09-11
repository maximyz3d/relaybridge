'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {ROOT,makeHostedFixture}=require('./helpers/provider-diagnostics.cjs');
const {createHostedModelCatalog,catalogUrl}=require(path.join(ROOT,'lib/hosted-model-catalog'));
const {createReadOperationPool}=require(path.join(ROOT,'lib/operation-admission'));
const base={chatUrl:'https://catalog.fixture.invalid/v1/chat/completions',key:{name:'FIXTURE_KEY',value:'fabricated-secret-a'},model:'model-a'};
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {resolve,promise};};

test('secret/model/generation cache identity and secret-free output',async t=>{
  const prior=global.fetch;t.after(()=>global.fetch=prior);let reads=0;
  global.fetch=async(_url,options)=>{reads++;assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');
    return Response.json({data:[{id:'model-a'},{id:'model-b'}]});};
  let now=1000;const cache=createHostedModelCatalog({now:()=>now,ttlMs:10});
  assert.equal((await cache.check(base)).status,'available');
  await cache.check(base);assert.equal(reads,1);
  await cache.check({...base,key:{...base.key,value:'fabricated-secret-b'}});assert.equal(reads,2);
  await cache.check({...base,model:'model-b'});assert.equal(reads,3);
  await cache.check({...base,generation:'new'});assert.equal(reads,4);
  now=1011;const result=await cache.check(base);assert.equal(reads,5);
  assert.ok(!JSON.stringify(result).includes('fabricated-secret'));
});

test('catalog endpoint refuses cross-origin and userinfo before fetch',()=>{
  assert.throws(()=>catalogUrl(base.chatUrl,'https://attacker.fixture.invalid/models'),/catalog_endpoint_invalid/);
  assert.throws(()=>catalogUrl(base.chatUrl,'https://u:p@catalog.fixture.invalid/models'),/catalog_endpoint_invalid/);
});

test('already-stale identity must not send authenticated metadata',async t=>{
  const prior=global.fetch;t.after(()=>global.fetch=prior);let reads=0;
  global.fetch=async()=>{reads++;return Response.json({data:[{id:'model-a'}]});};
  const value=await createHostedModelCatalog().check({...base,currentIdentity:()=>false});
  assert.equal(value.diagnosticCode,'catalog_identity_changed');
  assert.equal(reads,0,'obsolete authority must be checked before sending the bearer key');
});

test('a stale passed entry cannot be relabeled with a new current config generation',async()=>{
  const source=fs.readFileSync(path.join(ROOT,'server.js'),'utf8');
  const body=source.slice(source.indexOf('async function probeHostedReadiness('),source.indexOf('\nasync function coldPlanningDiagnostics('));
  const old={model:'old-model',api_base_url:'https://catalog.fixture.invalid/old/chat/completions'};
  const fresh={...old,model:'new-model',api_base_url:'https://catalog.fixture.invalid/new/chat/completions'};
  let consideredCurrent;
  const context={loadConfig:()=>({fixture:fresh}),diagnosticGeneration:cfg=>JSON.stringify(cfg),
    hostedChatUrl:entry=>new URL(entry.api_base_url),hostedApiKey:()=>({name:'KEY',value:'fabricated'}),
    admissionClosed:false,providerUsageCapability:()=>null,
    hostedCatalog:{check:async args=>{consideredCurrent=args.currentIdentity();return {status:consideredCurrent?'available':'unknown',model:args.model};}}};
  vm.runInNewContext(body,context);
  const result=await context.probeHostedReadiness('fixture',old);
  assert.equal(result.ready,false,'the old entry must not borrow fresh config generation authority');
});

test('one subscriber abort preserves shared reader and second caller result',async t=>{
  const prior=global.fetch;t.after(()=>global.fetch=prior);
  const started=deferred(),finish=deferred();let reads=0;
  global.fetch=async(_url,options)=>{reads++;started.resolve();await finish.promise;
    assert.equal(options.signal.aborted,false);return Response.json({data:[{id:'model-a'}]});};
  const pool=createReadOperationPool({maxActive:1});const cache=createHostedModelCatalog({pool});
  const controller=new AbortController();const first=cache.check({...base,signal:controller.signal});
  const second=cache.check(base);await started.promise;controller.abort();
  assert.equal((await first).status,'unknown');assert.equal(pool.snapshot().active,1);
  finish.resolve();assert.equal((await second).status,'available');assert.equal(reads,1);
  assert.equal(pool.snapshot().active,0);
});

test('config update cannot leave fresh /diag contradicted by obsolete model registry',async t=>{
  const fixture=makeHostedFixture(t);
  const bridge=await fixture.start();
  assert.equal((await bridge.request('/api/models?refresh=1')).status,200);
  fixture.update({ids:['new-fixture-model']});
  const cfg=JSON.parse(fs.readFileSync(bridge.configPath,'utf8'));
  cfg.groq_llama_fast.model='new-fixture-model';fs.writeFileSync(bridge.configPath,JSON.stringify(cfg));
  const diag=await bridge.request('/api/diag');
  assert.equal(diag.body.results.groq_llama_fast.ready,true);
  const result=await bridge.request('/api/oneshot',{kind:'groq_llama_fast',prompt:'Define one common word.',dangerous:false,cwd:bridge.root});
  assert.notEqual(result.body.errorCode,'model_unavailable','obsolete persisted census must not override fresh catalog evidence');
});

test('planning validates the actually requested hosted tier model',async t=>{
  const fixture=makeHostedFixture(t,{ids:['llama-3.1-8b-instant','absent-tier-model']});
  const bridge=await fixture.start({model_tiers:{standard:{model:'absent-tier-model',args:['--model','absent-tier-model']}}});
  assert.equal((await bridge.request('/api/models?refresh=1')).status,200);
  fixture.update({ids:['llama-3.1-8b-instant']});
  const cfg=JSON.parse(fs.readFileSync(bridge.configPath,'utf8'));
  cfg.groq_llama_fast.label='changed to invalidate authenticated catalog cache';
  fs.writeFileSync(bridge.configPath,JSON.stringify(cfg));
  const result=await bridge.request('/api/plan',{kind:'groq_llama_fast',task:'Define one common word.',modelTier:'standard',cwd:bridge.root});
  assert.ok(result.status>=400 || result.body.primary?.ready===false || result.body.primary?.eligible===false,
    'plan must not mark an absent resolved model ready because the different entry.model is available');
  assert.equal(fixture.events().filter(row=>row.method==='POST').length,0);
});
