'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNativeProviderOutput:parse, MAX_JSON_CHARS } = require('../lib/provider-output');

test('native signed-out documents remain classified diagnostics, including Gemini stderr', () => {
  const grok = JSON.stringify({ type:'error', message:'Not signed in. To authenticate without a browser, run:\n  grok login --device-code' });
  const gemini = JSON.stringify({ session_id:'fixture', error:{ type:'Error', message:"The auth type 'oauth-personal' is enforced, but no authentication is configured.", code:41 } });
  for (const result of [parse('grok_json',grok,{exitCode:1}),parse('gemini_cli_json','',{stderr:gemini,exitCode:41})]) {
    assert.equal(result.failureClass,'auth'); assert.equal(result.output,''); assert.equal(result.usage,null);
  }
  const quoted = parse('gemini_cli_json', JSON.stringify({ response:'The log example says: not signed in; code 41.' }), {exitCode:0});
  assert.equal(quoted.isError,false); assert.equal(quoted.terminalReason,null);
  for (const options of [{exitCode:0},{exitCode:41,ignoreTerminalResult:true},{exitCode:null,ignoreTerminalResult:true}]) {
    const interrupted = parse('gemini_cli_json','',{stderr:gemini,...options});
    assert.notEqual(interrupted.failureClass,'auth'); assert.equal(interrupted.diagnosticIsProviderError,false);
  }
  assert.equal(parse('grok_json',grok,{exitCode:1,ignoreTerminalResult:true}).diagnosticIsProviderError,false);
});

test('Grok requires a complete candidate result envelope and end_turn, not a last JSON fragment', () => {
  // Source-backed candidate success shape, not a captured authenticated run.
  const result = { text:'A complete supplied-fixture explanation.', stopReason:'end_turn', sessionId:'fixture-session', requestId:'fixture-request' };
  assert.equal(parse('grok_json',JSON.stringify(result),{exitCode:0}).output,result.text);
  for (const patch of [{stopReason:'max_turns'},{stopReason:undefined},{requestId:undefined},{text:''},{is_error:true}]) {
    const parsed = parse('grok_json',JSON.stringify({...result,...patch}),{exitCode:0});
    assert.equal(parsed.isError,true); assert.equal(parsed.output,'');
  }
  for (const raw of ['', '{} trailing', 'prefix\n'+JSON.stringify(result), JSON.stringify(result)+'\n{}', 'x'.repeat(MAX_JSON_CHARS+1)]) {
    assert.equal(parse('grok_json',raw,{exitCode:0}).failureClass,'incomplete_response');
  }
  assert.equal(parse('grok_json',JSON.stringify(result),{exitCode:0,ignoreTerminalResult:true}).output,'');
});

test('Gemini errors and warning stops override exit-zero text without inventing terminal or usage evidence', () => {
  const response = 'Review the supplied evidence before approving.';
  const valid = parse('gemini_cli_json',JSON.stringify({response,stats:{models:{requested:{tokens:{input:0,total:0}}}}}),{exitCode:0});
  assert.equal(valid.output,response); assert.equal(valid.usage,null); assert.equal(valid.numTurns,null);
  assert.equal(valid.providerStopReason,null); assert.equal(valid.terminalReason,null); assert.equal(valid.resultSubtype,null);
  for (const patch of [{error:{type:'INVALID_STREAM',message:'Stream ended early'}},{error:null},{warnings:['Agent execution stopped.']},{warnings:[{}]}]) {
    const parsed = parse('gemini_cli_json',JSON.stringify({response,...patch}),{exitCode:0});
    assert.equal(parsed.isError,true); assert.equal(parsed.output,'');
  }
  assert.equal(parse('gemini_cli_json','',{stderr:JSON.stringify({response}),exitCode:0}).output,'');
  assert.equal(parse('gemini_cli_json',JSON.stringify({response}),{exitCode:1}).output,'');
});

test('native error diagnostics are bounded and redact recognizable secrets before retention', () => {
  const secret = 'sk-'+'x'.repeat(40);
  const parsed = parse('grok_json',JSON.stringify({type:'error',message:'API key: '+secret+'\n'+'detail '.repeat(1000)}),{exitCode:1});
  assert.equal(parsed.diagnostic.includes(secret),false); assert.ok(parsed.diagnostic.length<=4000);
  assert.equal(parsed.errorDiagnosticTruncated,true); assert.equal(parsed.output,'');
});

test('native parser wiring preserves failure provenance and never bypasses unverified launch policy', {timeout:30000}, async t => {
  const fs = require('node:fs'), path = require('node:path');
  const {startTestBridge,completeJsonLines} = require('./helpers/temporary-bridge');
  let marker;
  const cases = {
    grok_ok:{parser:'grok_json',code:0,stdout:JSON.stringify({text:'The supplied fixture has a bounded cache and a clear acceptance condition.',stopReason:'end_turn',sessionId:'fixture-session',requestId:'fixture-request'}),stderr:'MCP helper warning: authentication required; rate limit 429'},
    grok_auth:{parser:'grok_json',code:1,stdout:JSON.stringify({type:'error',message:'Not signed in. To authenticate without a browser, run:\n  grok login --device-code'})},
    gemini_ok:{parser:'gemini_cli_json',code:0,stdout:JSON.stringify({response:'A bounded comparison of the supplied alternatives.',stats:{models:{requested:{tokens:{input:0,total:0}}}}}),stderr:'MCP helper warning: authentication required; rate limit 429'},
    gemini_auth:{parser:'gemini_cli_json',code:41,stderr:JSON.stringify({session_id:'fixture',error:{type:'Error',message:"The auth type 'oauth-personal' is enforced, but no authentication is configured.",code:41}})},
    gemini_partial:{parser:'gemini_cli_json',code:0,stdout:JSON.stringify({response:'APPROVE; the quoted task discusses quota exceeded.',error:{type:'INVALID_STREAM',message:'Stream ended early'}})},
    gemini_warning:{parser:'gemini_cli_json',code:0,stdout:JSON.stringify({response:'An incomplete answer.',warnings:['Agent execution blocked: policy example discusses rate limit 429 and budget exceeded.']})},
    gemini_auth_mismatch:{parser:'gemini_cli_json',code:1,stdout:JSON.stringify({error:{type:'Error',message:'Authentication required.',code:41}})},
    gemini_blocked:{parser:'gemini_cli_json',code:0,stdout:JSON.stringify({response:'This must never execute.'}),blocked:true},
  };
  const bridge = await startTestBridge(t,root => {
    marker = path.join(root,'native-invocations.jsonl');
    const script = path.join(root,'native-fixture.js');
    fs.writeFileSync(script,"const fs=require('fs');if(process.argv[2]==='--version'){process.stdout.write('fixture');process.exit(0)};const c=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));fs.appendFileSync(process.argv[3],JSON.stringify({kind:c.kind})+'\\n');process.stdout.write(c.stdout||'');process.stderr.write(c.stderr||'');process.exit(c.code);");
    return Object.fromEntries(Object.entries(cases).map(([kind,c]) => {
      const fixture = path.join(root,kind+'.json'); fs.writeFileSync(fixture,JSON.stringify({...c,kind}));
      return [kind,{label:kind,safe:[process.execPath],probe:[process.execPath,script,'--version'],
        oneshot_safe:[process.execPath,script,fixture,marker],oneshot_output_parser:c.parser,
        oneshot_capabilities:{safe:['model_invocation','prompt_only']},
        oneshot_safe_filesystem_policy:c.blocked?'unverified_provider_policy':'read_only_enforced'}];
    }));
  });
  for (const kind of ['grok_ok','gemini_ok']) {
    const {body} = await bridge.request('/api/oneshot',{kind,prompt:'Explain the supplied conceptual fixture.',dangerous:false,cwd:bridge.root});
    assert.equal(body.exitCode,0,JSON.stringify(body)); assert.equal(body.dropped_out,false);
    assert.equal(body.auth_failed,false); assert.equal(body.rate_limited,false);
    assert.equal(body.route.observed_model,null); assert.equal(body.provider_num_turns,null);
    if(kind==='gemini_ok') assert.equal(body.provider_terminal_reason,null);
  }
  for (const kind of ['grok_auth','gemini_auth']) {
    const {body} = await bridge.request('/api/oneshot',{kind,prompt:'Explain the supplied conceptual fixture.',dangerous:false,cwd:bridge.root});
    assert.equal(body.failureClass,'auth',JSON.stringify(body)); assert.equal(body.auth_failed,true);
    assert.equal(body.dropped_out,true); assert.equal(body.stdout,'');
  }
  const partial = (await bridge.request('/api/oneshot',{kind:'gemini_partial',prompt:'Explain the supplied conceptual fixture.',dangerous:false,cwd:bridge.root})).body;
  assert.equal(partial.failureClass,'incomplete_response',JSON.stringify(partial)); assert.equal(partial.stdout,'');
  assert.equal(partial.rate_limited,false,'quoted task text is not provider quota evidence');
  const warning = (await bridge.request('/api/oneshot',{kind:'gemini_warning',prompt:'Explain the supplied conceptual fixture.',dangerous:false,cwd:bridge.root})).body;
  assert.equal(warning.failureClass,'incomplete_response',JSON.stringify(warning));
  assert.equal(warning.rate_limited,false); assert.equal(warning.budget_exceeded,false); assert.equal(warning.auth_failed,false);
  assert.match(warning.stderr,/policy example/,'warning retained as explanation only');
  const authMismatch = (await bridge.request('/api/oneshot',{kind:'gemini_auth_mismatch',prompt:'Explain the supplied conceptual fixture.',dangerous:false,cwd:bridge.root})).body;
  assert.equal(authMismatch.auth_failed,false,JSON.stringify(authMismatch)); assert.equal(authMismatch.dropped_out,true);
  const before = completeJsonLines(marker).length;
  const blocked = (await bridge.request('/api/oneshot',{kind:'gemini_blocked',prompt:'Explain the supplied conceptual fixture.',dangerous:false,cwd:bridge.root})).body;
  assert.equal(blocked.model_invocation,false,JSON.stringify(blocked));
  assert.equal(completeJsonLines(marker).length,before);
});
