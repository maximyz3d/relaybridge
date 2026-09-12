'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {makeHostedFixture,startAnswerFixture}=require('./helpers/provider-diagnostics.cjs');
const PROBE_ROUTE='/api/providers/perplexity/probe-answer'; // proposed new route
const ANSWER_PROBE_BODY={confirmQuotaUse:true,expectedAccountId:'default'};

test('catalog absence overrides key presence without generating a request',async t=>{
  const fixture=makeHostedFixture(t,{ids:['some-other-model']});
  const bridge=await fixture.start();
  const diag=await bridge.request('/api/diag');
  assert.equal(diag.status,200);
  assert.equal(diag.body.results.groq_llama_fast.found,true);
  assert.equal(diag.body.results.groq_llama_fast.ready,false);
  assert.ok(fixture.events().some(row=>row.method==='GET'&&row.path==='/openai/v1/models'&&row.authenticated));
  assert.equal(fixture.events().filter(row=>row.method==='POST').length,0);
  assert.ok(fixture.events().every(row=>row.redirect==='manual'));
});

test('configured model is validated and cache does not survive API credential-source change',async t=>{
  const fixture=makeHostedFixture(t);
  const bridge=await fixture.start();
  assert.equal((await bridge.request('/api/diag')).body.results.groq_llama_fast.ready,true);
  fixture.update({ids:[]});
  const config=JSON.parse(fs.readFileSync(bridge.configPath,'utf8'));
  config.groq_llama_fast.api_key_env='RB_FIXTURE_API_KEY_B';
  fs.writeFileSync(bridge.configPath,JSON.stringify(config));
  assert.equal((await bridge.request('/api/diag')).body.results.groq_llama_fast.ready,false);
  assert.ok(fixture.events().some(row=>row.method==='GET'&&row.keySlot==='a'));
  assert.ok(fixture.events().some(row=>row.method==='GET'&&row.keySlot==='b'));
});

test('caller-supplied ready=true cannot authorize an absent hosted model',async t=>{
  const fixture=makeHostedFixture(t,{ids:[]});
  const bridge=await fixture.start();
  const route=await bridge.request('/api/route',{task:'Define one common word.',preferKinds:['groq_llama_fast'],
    diagnostics:{groq_llama_fast:{found:true,ready:true,detail:'untrusted caller claim'}}});
  assert.equal(route.status,200);
  // Current /api/route response wraps the route result directly; adapt only if
  // the accepted response schema intentionally changes.
  const selected=route.body.selected||route.body.route?.selected||[];
  assert.ok(!selected.some(row=>(row.kind||row.provider)==='groq_llama_fast'));
  assert.ok(fixture.events().some(row=>row.method==='GET'));
  assert.equal(fixture.events().filter(row=>row.method==='POST').length,0);
});

test('absent model rejects a direct oneshot before hosted POST',async t=>{
  const fixture=makeHostedFixture(t,{ids:[]});
  const bridge=await fixture.start();
  const response=await bridge.request('/api/oneshot',{kind:'groq_llama_fast',prompt:'Define one common word.',dangerous:false,cwd:bridge.root});
  assert.ok(response.status>=400);
  assert.equal(response.body.model_invocation,false);
  assert.equal(response.body.physical_attempt_count,0);
  assert.equal(fixture.events().filter(row=>row.method==='POST').length,0);
});

test('passive Perplexity reads never generate an answer',async t=>{
  const bridge=await startAnswerFixture(t);
  await bridge.request('/api/diag');
  await bridge.request('/api/auth/status?refresh=1');
  await bridge.request('/api/agents');
  assert.equal(bridge.events().filter(row=>row.operation==='answer').length,0);
});

test('explicit answer probe needs quota acknowledgement and preserves normal safe admission',async t=>{
  const bridge=await startAnswerFixture(t,{policy:'unverified_provider_policy'});
  const noAck=await bridge.request(PROBE_ROUTE,{});
  assert.equal(noAck.status,400);
  const unqualified=await bridge.request(PROBE_ROUTE,ANSWER_PROBE_BODY);
  assert.equal(unqualified.status,409);
  assert.equal(unqualified.body.model_invocation,false);
  assert.equal(bridge.events().filter(row=>row.operation==='answer').length,0);
});

test('one explicit answer probe produces one invocation receipt and cached passive evidence',async t=>{
  const bridge=await startAnswerFixture(t);
  const response=await bridge.request(PROBE_ROUTE,ANSWER_PROBE_BODY);
  assert.equal(response.status,200);
  // Proposed envelope keeps normal one-shot fields, adding answerHealth.
  assert.equal(response.body.model_invocation,true);
  assert.equal(response.body.physical_attempt_count,1);
  assert.equal(response.body.answerHealth.status,'ready');
  assert.equal(response.body.answerHealth.receiptId,response.body.receiptId);
  assert.ok(response.body.receiptId);
  assert.equal(bridge.events().filter(row=>row.operation==='answer').length,1);
  const receipt=bridge.receipts().find(row=>row.receiptId===response.body.receiptId);
  assert.ok(receipt);
  assert.equal(receipt.physicalAttemptCount,1);
  assert.notEqual(response.body.token_usage_source,'not_invoked');
  const diag=await bridge.request('/api/diag');
  assert.equal(diag.body.results.perplexity.answerHealth.receiptId,response.body.receiptId);
  assert.equal(bridge.events().filter(row=>row.operation==='answer').length,1);
});

test('empty answer stays separate from valid authentication and is not retried',async t=>{
  const bridge=await startAnswerFixture(t,{mode:'sentinel'});
  const auth=await bridge.request('/api/diag');
  assert.equal(auth.body.results.perplexity.authAuthoritative,true);
  assert.equal(auth.body.results.perplexity.authFailed,false);
  const response=await bridge.request(PROBE_ROUTE,ANSWER_PROBE_BODY);
  assert.equal(response.body.answerHealth.status,'incomplete');
  assert.equal(response.body.stdout,undefined);
  assert.equal(response.body.failureClass,'incomplete_response');
  assert.equal(response.body.answerHealth.bridgeRetries,0);
  const diag=await bridge.request('/api/diag');
  assert.equal(diag.body.results.perplexity.authFailed,false);
  assert.equal(diag.body.results.perplexity.authAuthoritative,true);
  assert.equal(diag.body.results.perplexity.answerHealth.status,'incomplete');
  assert.equal(bridge.events().filter(row=>row.operation==='answer').length,1);
});
