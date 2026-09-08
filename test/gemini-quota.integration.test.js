'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const {startTestBridge,completeJsonLines}=require('./helpers/temporary-bridge');

test('Gemini CLI quota result persists account authority and blocks the next explicit call before invocation', async t => {
  let marker;
  const bridge=await startTestBridge(t,root=>{
    marker=path.join(root,'calls.jsonl'); const script=path.join(root,'quota.cjs');
    fs.writeFileSync(script,`const fs=require('node:fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
      fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({invoked:true})+'\\n');
      process.stderr.write('Individual quota reached... Resets in 8h14m55s\\n');process.exitCode=1;});`);
    const seat={label:'Fixture Gemini',transport:'subscription:google',quota_seat:'subscription:google:fixture',
      oneshot_safe:[process.execPath,script],oneshot_safe_filesystem_policy:'read_only_enforced'};
    return {_models:{discoverOnBoot:false},gemini:seat,gemini_fast:{...seat,label:'Same-account fixture'},
      unrelated:{...seat,label:'Other-account fixture',quota_seat:'subscription:google:other'}};
  },{env:{RELAYBRIDGE_WARM_DIAG:'0',RELAYBRIDGE_REMOTE_MCP:'0'}});
  const body={kind:'gemini',dangerous:false,prompt:'Reply to the fixture request.',cwd:bridge.root,requestId:'gemini:quota:fixture'};
  const first=await bridge.request('/api/oneshot',body);
  assert.equal(first.status,200,JSON.stringify(first.body));
  const value=first.body;
  assert.equal(value.failureClass,'rate_limit',JSON.stringify(value)); assert.equal(value.rate_limited,true);
  assert.equal(value.auth_failed,false); assert.equal(value.budget_exceeded,false); assert.equal(value.provider_api_error_status,null);
  assert.equal(value.vendor_quota.kind,'quota_exhausted'); assert.equal(value.vendor_quota.reset.durationMs,29695000);
  assert.equal(value.vendor_quota.actual,null); assert.equal(value.vendor_quota.limit,null); assert.equal(value.vendor_quota.remaining,null);
  assert.equal(value.retry_at,Date.parse(value.vendor_quota.reset.expiresAt));
  assert.ok(value.retry_after>=29690&&value.retry_after<=29695);
  assert.ok(value.cooldown.until < value.retry_at); assert.equal(value.cooldown.source,'retry-after-capped');
  const rows=completeJsonLines(path.join(bridge.root,'data','receipts',new Date().toISOString().slice(0,10)+'.jsonl'));
  const receipt=rows.find(row=>row.receiptId===value.receiptId); assert.ok(receipt);
  assert.equal(receipt.vendorQuota.kind,'quota_exhausted'); assert.equal(receipt.vendorQuota.remaining,null);
  assert.equal(receipt.quotaEvidence.source,'antigravity_individual_quota'); assert.equal(receipt.retryAt,value.retry_at);
  const observations=completeJsonLines(path.join(bridge.root,'data','usage','vendor-quota.jsonl'));
  assert.equal(observations.length,1); assert.equal(observations[0].quotaSeat,'subscription:google:fixture');
  for(const kind of ['gemini','gemini_fast']) {
    const second=await bridge.request('/api/oneshot',{...body,kind,requestId:'gemini:blocked:'+kind});
    assert.equal(second.body.model_invocation,false,JSON.stringify(second.body));
    assert.equal(second.body.failureClass,'vendor_quota_exhausted');
  }
  assert.equal(completeJsonLines(marker).length,1,'no same-account replay through explicit routing');
  const usage=(await bridge.request('/api/usage/gauges')).body;
  for(const kind of ['gemini','gemini_fast']) {
    assert.equal(usage.gauges[kind].capacity,null); assert.equal(usage.gauges[kind].percentRemaining,null);
  }
  assert.equal(usage.gauges.unrelated.vendorQuota,null);
});

test('a later in-flight weak observation cannot shorten response or receipt retry guidance', {timeout:20000}, async t => {
  let marker,longGate,shortGate;
  const bridge=await startTestBridge(t,root=>{
    marker=path.join(root,'calls.jsonl'); longGate=path.join(root,'long-ready'); shortGate=path.join(root,'short-ready');
    const script=path.join(root,'concurrent-quota.cjs');
    fs.writeFileSync(script,`const fs=require('node:fs');let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{
      const short=prompt.includes('short-fixture');fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({short})+'\\n');
      const timer=setInterval(()=>{if(!fs.existsSync(short?${JSON.stringify(shortGate)}:${JSON.stringify(longGate)}))return;
        clearInterval(timer);process.stderr.write(short?'Individual quota reached\\n':'Individual quota reached; resets in 8h14m55s\\n');process.exitCode=1;},20);});`);
    return {_models:{discoverOnBoot:false},gemini:{label:'Concurrent fixture',transport:'subscription:google',quota_seat:'subscription:google:fixture',
      oneshot_safe:[process.execPath,script],oneshot_safe_filesystem_policy:'read_only_enforced'}};
  },{env:{RELAYBRIDGE_WARM_DIAG:'0',RELAYBRIDGE_REMOTE_MCP:'0',RELAYBRIDGE_MAX_ACTIVE_PER_PROVIDER:'2'}});
  const request=prompt=>bridge.request('/api/oneshot',{kind:'gemini',dangerous:false,cwd:bridge.root,prompt},{signal:AbortSignal.timeout(15000)});
  const long=request('long-fixture'),short=request('short-fixture');
  const {waitFor}=require('./helpers/temporary-bridge');
  await waitFor(()=>completeJsonLines(marker).length===2);
  fs.writeFileSync(longGate,'ready'); const first=(await long).body;
  assert.equal(first.vendor_quota.reset.durationMs,29695000);
  fs.writeFileSync(shortGate,'ready'); const second=(await short).body;
  assert.equal(second.vendor_quota.reset.durationMs,300000,'current-call evidence remains its own observation');
  assert.equal(second.retry_at,first.retry_at,'effective timing uses the longest active reset');
  const receipt=completeJsonLines(path.join(bridge.root,'data','receipts',new Date().toISOString().slice(0,10)+'.jsonl'))
    .find(row=>row.receiptId===second.receiptId);
  assert.equal(receipt.retryAt,first.retry_at);
  const gauge=(await bridge.request('/api/usage/gauges')).body.gauges.gemini;
  assert.equal(Date.parse(gauge.vendorQuota.reset.expiresAt),second.retry_at);
});
