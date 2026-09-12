'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const ROOT=require('node:path').resolve(__dirname, '..');
const source=fs.readFileSync(ROOT+'/server.js','utf8');
const {queueTerminalInput}=require(ROOT+'/lib/terminal-input');
const token='1'.repeat(64), tokenMatches=value=>{const a=Buffer.from(String(value||'')),b=Buffer.from(token);return a.length===b.length&&crypto.timingSafeEqual(a,b);};
function capture(start,end,context){return vm.runInNewContext(source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start))),context);}
function response(){return {code:200,status(n){this.code=n;return this;},json(value){this.body=value;return this;},setHeader(){},on(){}};}
test('actual REST API gate rejects missing/wrong token before session input and accepts exact token',()=>{
 let gate; capture("app.use('/api', (req, res, next) => {",'const ZERO_PROVIDER_RETRIES', {app:{use(_p,fn){gate=fn;}},tokenMatches,Date,recordTelemetry(){},telemetrySeq:0});
 let inputRoute;capture("app.post('/api/sessions/:id/input'", "app.get('/api/sessions/:id/buffer'", {app:{post(_p,fn){inputRoute=fn;}},sessions:new Map([['1',{write(data,mode){writes.push([data,mode]);return {ok:true};}}]])});
 const writes=[];
 for(const supplied of [undefined,'',token.slice(1),'2'.repeat(64)]){const req={path:'/sessions/1/input',headers:{'x-relaybridge-token':supplied},get(){return '';},params:{id:'1'},body:{data:'MUST_NOT_WRITE\r'}};const res=response();gate(req,res,()=>inputRoute(req,res));assert.equal(res.code,401);}
 assert.equal(writes.length,0);
 const data="printf '%s' '\u001b[A'; $(whoami)\r\n\u0003\u0004\u001b[200~paste\u001b[201~";
 const req={path:'/sessions/1/input',headers:{'x-relaybridge-token':token},get(){return '';},params:{id:'1'},body:{data}};const res=response();gate(req,res,()=>inputRoute(req,res));assert.equal(res.code,200);assert.deepEqual(writes,[[data,'keystrokes']]);
 assert.ok(source.indexOf("app.use('/api',")<source.indexOf("app.post('/api/sessions/:id/input'"));
});
test('actual WS connection rejects bad host/origin/token before attaching or accepting input',()=>{
 let connection; const writes=[], attached=[];
 capture("wss.on('connection',",'// ---- Remote MCP endpoint', {wss:{on(_ev,fn){connection=fn;}},admissionClosed:false,ALLOWED_HOSTS:new Set(['127.0.0.1:8787','localhost:8787']),ALLOWED_ORIGINS:new Set(['http://127.0.0.1:8787','http://localhost:8787']),tokenMatches,URL,HOST:'127.0.0.1',PORT:8787,sessions:new Map([['1',{attach(ws){attached.push(ws);},detach(){},write(data,mode){writes.push([data,mode]);return {ok:true};},_sendTo(){},resize(){}}]])});
 function sock(){return {handlers:{},send(){},close(code){this.closed=code;},on(ev,fn){this.handlers[ev]=fn;}};}
 const cases=[{host:'attacker.example',origin:undefined,credential:token},{host:'localhost:8787',origin:'https://attacker.example',credential:token},{host:'localhost:8787',origin:undefined,credential:''},{host:'localhost:8787',origin:'http://localhost:8787',credential:'2'.repeat(64)}];
 for(const row of cases){const ws=sock();connection(ws,{url:'/ws?session=1&token='+row.credential,headers:{host:row.host,origin:row.origin}});assert.equal(ws.closed,1008);assert.equal(ws.handlers.message,undefined);}
 assert.equal(attached.length,0);assert.equal(writes.length,0);
 const ws=sock();connection(ws,{url:'/ws?session=1&token='+token,headers:{host:'localhost:8787',origin:'http://localhost:8787'}});const data="echo $HOME; $(id)\r\u001b[A\u0003";ws.handlers.message(Buffer.from(JSON.stringify({type:'input',data})));assert.equal(attached.length,1);assert.deepEqual(writes,[[data,'keystrokes']]);
});
test('PTY sink preserves exact strings including shell syntax and control keystrokes',()=>{
 const seen=[];const inputs=["a; b && c | d > e\r",'$(id) `id` $HOME %PATH%', '\u001b[A\u001b[B\u0003\u0004\r\n', '🥑 café\t'];
 for(const data of inputs){assert.equal(queueTerminalInput({write(value){seen.push(value);}},'pty',data).ok,true);}
 assert.deepEqual(seen,inputs);
});
