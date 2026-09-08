'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { parseGeminiQuotaExhaustion: parse, normalizeQualitativeQuotaExhaustion: normalize } = require('../lib/vendor-quota');
const { createUsageLedger } = require('../lib/usage-ledger');
const { classifyRunFailure } = require('../lib/provider-failure');
const { activeVendorQuotaExhaustion, applyVendorQuotaExhaustionToDiagnostics, suggestTierAdjustment } = require('../lib/load-leveller');
const accounts = require('../lib/provider-accounts');
const at = '2026-09-08T12:00:00.000Z', diagnostic = 'Individual quota reached; resets in 8h14m55s';
const run = { provider:'gemini', stdout:'', stderr:diagnostic, exitCode:1, observedAt:at };
function directory(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rb-gemini-quota-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); return dir; }

test('exact Gemini exhaustion retains reported compound reset without fabricated quota numbers', () => {
  for (const stderr of [diagnostic, 'Individual quota reached... Resets in 8h14m55s', 'Individual quota reached\nResets in 8h 14m 55s', '\x1b[31m'+diagnostic+'\x1b[0m\r\n']) {
    const value = parse({...run,stderr}); assert.ok(value,stderr);
    assert.equal(value.reset.durationMs,29695000); assert.equal(value.reset.expiresAt,'2026-09-08T20:14:55.000Z');
    for (const field of ['actual','limit','remaining','percentRemaining','overLimit','unit']) assert.equal(value[field],null);
    assert.equal(value.scope,'account'); assert.equal(value.reset.kind,'provider_reset');
  }
  assert.equal(parse({...run,stdout:diagnostic,stderr:''}).diagnosticSource,'stdout');
  assert.equal(classifyRunFailure(run).kind,'rate_limited'); assert.equal(classifyRunFailure(run).retryable,false);
});

test('quoted success, other providers, local stops and mixed answers do not create quota authority', () => {
  for (const patch of [{provider:'codex'},{exitCode:0},{exitCode:null},{exitCode:'1'}, {stopReason:'token_budget'},
    {supervisorStopReason:'client_cancelled'}, {stdout:'A substantive answer'}, {stderr:'Example: '+diagnostic},
    {stderr:'```\n'+diagnostic+'\n```'}, {stderr:diagnostic+'\nHere is my review.'}]) assert.equal(parse({...run,...patch}),null,JSON.stringify(patch));
  assert.equal(classifyRunFailure({...run,stopReason:'token_budget'}).kind,'supervisor_token_budget');
  for (const reset of ['', '1h1h', '999h', '1h60m', '1m60s', '-2h', '1.5h', '0s', '1e9h']) {
    const value=parse({...run,stderr:'Individual quota reached'+(reset ? '; resets in '+reset : '')});
    assert.equal(value.reset.kind,'conservative_expiry'); assert.equal(value.reset.durationMs,300000);
  }
});

test('qualitative normalization rejects contradictory fields and hostile shapes without coercion', () => {
  const good=parse(run), hostile=JSON.parse('{"toString":null,"valueOf":null}');
  for (const patch of [{actual:0},{remaining:0},{unit:'tokens'},{scope:'model'}, {provider:'grok'}, {model:hostile},
    {observedAt:hostile},{evidenceHash:hostile},{reset:{...good.reset,expiresAt:hostile}}, {reset:{...good.reset,durationMs:'29695000'}},
    {reset:{...good.reset,durationMs:1}}, {unknown:'private'}, {quotaSeat:hostile}, {recordedAt:hostile}]) assert.equal(normalize({...good,...patch}),null);
  assert.deepEqual(normalize(good),good);
});

test('account exhaustion survives restart, applies across models and cannot be shortened by weaker observations', t => {
  const dataDir=directory(t), base=Date.parse(at); let clock=base;
  const options={dataDir,now:()=>clock,budgets:{gemini:{tokensPerDay:1000000}},quotaSeats:{gemini:'subscription:gemini',gemini_fast:'subscription:gemini'}};
  const ledger=createUsageLedger(options), observation=parse(run);
  assert.ok(ledger.observeVendorQuota(observation));
  clock+=1000;
  ledger.observeVendorQuota(parse({...run,stderr:'Individual quota reached',observedAt:new Date(clock)}));
  const restored=createUsageLedger(options);
  for (const kind of ['gemini','gemini_fast']) {
    const gauge=restored.gauge(kind,{costClass:'subscription',model:'different-model'});
    assert.equal(gauge.vendorQuota.reset.expiresAt,observation.reset.expiresAt);
    assert.equal(gauge.basis,'vendor_observed');
    for(const key of ['capacity','remaining','percentRemaining','hoursToEmpty']) assert.equal(gauge[key],null);
    assert.equal(activeVendorQuotaExhaustion(gauge,clock).reason,'vendor_quota_exhausted');
    assert.equal(activeVendorQuotaExhaustion(gauge,clock).kind,undefined,'observation kind cannot overwrite skipped provider identity');
    assert.match(suggestTierAdjustment({tier:'complex',gauge}).reason,/capacity unknown/);
  }
  const gauges=restored.gaugeAll({gemini:{costClass:'subscription'},gemini_fast:{costClass:'subscription'},codex:{costClass:'subscription'}});
  const gated=applyVendorQuotaExhaustionToDiagnostics({gemini:{ready:true,found:true},gemini_fast:{ready:true,found:true},codex:{ready:true,found:true}},gauges,{now:clock});
  assert.deepEqual(gated.skipped.map(item=>item.kind),['gemini','gemini_fast']); assert.equal(gated.diagnostics.codex.ready,true);
  assert.equal(gauges.gemini.configuredEstimate.capacity,1000000);
  assert.equal(restored.gauge('gemini',{costClass:'subscription',quotaSeat:'subscription:other'}).vendorQuota,null);
  clock=Date.parse(observation.reset.expiresAt)+1;
  assert.equal(restored.gauge('gemini',{costClass:'subscription'}).vendorQuota,null);
  assert.equal(restored.gauge('gemini',{costClass:'subscription'}).percentRemaining,null);
});

test('explicit account selection cannot bypass qualitative exhaustion with cooling fallback', t => {
  const dataDir=directory(t), seat='subscription:gemini';
  const observation=parse({...run,observedAt:new Date()});
  const gauge={basis:'vendor_observed',vendorQuota:observation,remaining:null,percentRemaining:null};
  const args={kind:'gemini',entry:{quota_seat:seat},registry:accounts.loadRegistry(dataDir),dataDir,
    gauges:{[seat]:gauge},allowCoolingFallback:true,coolingQuotaSeats:new Set([seat])};
  assert.equal(accounts.selectAccount(args),null);
  assert.equal(accounts.selectAccount({...args,gauges:{}}).id,'default');
});

test('MCP projections preserve unknown counts and effective reset, and UI cannot print fake zero over zero', async () => {
  const {normalizeVendorQuota,normalizeQuotaEvidence,reconcileTransportReceipt}=await import('../mcp/server.mjs');
  const observation=parse(run);
  assert.deepEqual(normalizeVendorQuota(observation),observation); assert.deepEqual(normalizeQuotaEvidence(observation),observation);
  assert.equal(normalizeVendorQuota({...observation,remaining:0}),null);
  const projected=reconcileTransportReceipt({requestId:'fixture:quota',sanitized:{failureClass:'client_cancelled'},transportReceipt:{
    quotaEvidence:observation,vendorQuota:observation,modelInvocation:true,retryAt:Date.parse(observation.reset.expiresAt),retryAfterSec:29695}});
  assert.deepEqual(projected.vendorQuota,observation); assert.equal(projected.rateLimited,true);
  assert.equal(projected.retryAfterSec,29695);
  const label=require('../public/dashboard-state').qualitativeQuotaLabel(observation);
  assert.match(label,/allowance unknown/); assert.doesNotMatch(label,/0\/0|tokens|%/);
});
