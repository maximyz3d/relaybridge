'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),path=require('node:path');
const {createRequire}=require('node:module');const {pathToFileURL}=require('node:url');
const ROOT=path.resolve(__dirname,'..');const req=createRequire(ROOT+'/package.json');
const {startTestBridge}=req('./test/helpers/temporary-bridge');
test('issue80 exact MCP Ollama plan-to-ask budget contract',{timeout:30000},async t=>{
 const calls=[];
 const upstream=http.createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');if(req.method==='GET'){res.end('{"models":[{"name":"fixture"}]}');return;}let raw='';for await(const chunk of req)raw+=chunk;calls.push(JSON.parse(raw));res.end('{"response":"Completed supplied-literal analysis.","model":"fixture","done":true,"prompt_eval_count":12,"eval_count":4}');});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{upstream.closeAllConnections();upstream.close(r);}));
 const bridge=await startTestBridge(t,()=>({ollama_coder:{label:'Local fixture',model:'fixture',models_static:['fixture'],oneshot_adapter:'ollama_api',safe:[process.execPath],oneshot_safe:[process.execPath],oneshot_safe_filesystem_policy:'read_only_enforced',oneshot_capabilities:{safe:['model_invocation','prompt_only']}}}),{env:{RELAYBRIDGE_OLLAMA_URL:`http://127.0.0.1:${upstream.address().port}`}});
 const [{Client},{StdioClientTransport}]=await Promise.all([import(pathToFileURL(req.resolve('@modelcontextprotocol/client'))),import(pathToFileURL(req.resolve('@modelcontextprotocol/client/stdio')))]);
 const transport=new StdioClientTransport({command:process.execPath,args:[ROOT+'/mcp/server.mjs'],cwd:ROOT,env:{...process.env,NODE_ENV:'test',RELAYBRIDGE_TEST_BUILD_ID:'security-integration-fixture',RELAYBRIDGE_URL:bridge.base,RELAYBRIDGE_TOKEN_FILE:path.join(bridge.root,'token'),RELAYBRIDGE_DATA_DIR:path.join(bridge.root,'data'),RELAYBRIDGE_CONFIG_FILE:bridge.configPath},stderr:'pipe'});
 const client=new Client({name:'issue80-acceptance',version:'1'});t.after(async()=>{await client.close();await transport.close();});await client.connect(transport);
 const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});return r.structuredContent||r;};
 const prompt='Explain the supplied JavaScript expression 1 + 2.';
 for(const providerBudget of [null,{maxOutputTokens:null},{maxOutputTokens:64}]){
  const plan=await call('plan_task',{kind:'ollama_coder',task:prompt,cwd:bridge.root,providerBudget});
  assert.ok(plan.primary?.execution,JSON.stringify(plan));
  const before=calls.length;
  const result=await call('ask_provider',{kind:'ollama_coder',prompt,cwd:bridge.root,providerBudget,execution:plan.primary.execution,useCache:false});
  assert.equal(result.modelInvocation,true,JSON.stringify(result));assert.equal(result.stdout,'Completed supplied-literal analysis.');assert.equal(calls.length,before+1);
  assert.match(result.receiptId,/^rcpt_/);
 }
 const before=calls.length;
 const bad=await call('ask_provider',{kind:'ollama_coder',prompt,cwd:bridge.root,providerBudget:{maxOutputTokens:0},useCache:false});
 assert.equal(bad.isError,true,JSON.stringify(bad));assert.equal(calls.length,before);
 assert.match(JSON.stringify(bad),/maxOutputTokens/);
});
