'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create, definitions, terminalDocument } = require('../public/native-conversations');

function fixture(saved) {
  const elements = new Map(), created = [], posts = [], sockets = [], terminals = [], store = new Map();
  if (saved) store.set('rb:native:selection', JSON.stringify(saved));
  class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.hidden = false; this.dataset = {}; this.attributes = {}; this._text = ''; this.className = ''; this.disabled = false;
      const classes = new Set(); this.classList = {add:k=>classes.add(k),remove:k=>classes.delete(k),contains:k=>classes.has(k)}; created.push(this); }
    set textContent(text) { this._text=String(text);this.children=[]; } get textContent() { return this._text+this.children.map(c=>c.textContent).join(''); }
    set innerHTML(_) { throw Error('unsafe HTML'); }
    append(...nodes) { this.children.push(...nodes); } replaceChildren(...nodes) { this._text='';this.children=nodes; }
    setAttribute(k,v) { this.attributes[k]=String(v); } getBoundingClientRect() { return {width:900,height:500}; }
  }
  const document = {body:new Node('body'),createElement:tag=>new Node(tag),getElementById(id){if(!elements.has(id))elements.set(id,new Node('div'));return elements.get(id);}};
  class Terminal {
    constructor(options) { this.options=options;this.output=[];this.cols=80;this.rows=24;terminals.push(this); }
    open() {} loadAddon() {} onData(fn) { this.input=fn;return {dispose(){}}; } onResize(fn) { this.resize=fn;return {dispose(){}}; }
    dispose() { this.disposed=true; } write(text) { this.output.push(text); }
  }
  class Socket {
    constructor(url) { this.url=url;this.readyState=0;this.sent=[];sockets.push(this); }
    open() { this.readyState=1;this.onopen?.(); } send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState=3;this.onclose?.(); }
  }
  const state = {config:{claude_duet_copy:{workspaceConversation:{title:'Duet — Claude copy',cwd:'/workspace',collabId:'c_fixture',description:'Independent copy'}}},sessions:[],history:[{who:'user',text:'<script>untrusted</script>',timestamp:'2026-09-23T14:00:00Z'}],fail:false};
  const env = {document,Terminal,WebSocket:Socket,FitAddon:{FitAddon:class {fit(){}}},URL,AbortSignal,Event:class{constructor(type){this.type=type;}},
    location:{href:'http://127.0.0.1:8787/control-center.html'},dispatchEvent(){},addEventListener(){},requestAnimationFrame:fn=>fn(),
    ResizeObserver:class{observe(){} disconnect(){}},localStorage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},
    async fetch(path,options={}) {
      if (state.fail) throw Error('offline');
      let body;
      if(path==='/api/capability')body={token:'fixture-token'};
      else { assert.equal(options.headers['X-RelayBridge-Token'],'fixture-token');
        if(options.method==='POST') { const data=JSON.parse(options.body);posts.push({path,data});if(state.postGate)await state.postGate;body={id:'new',kind:data.kind,startedAt:22,exited:false};state.sessions.push(body); }
        else if(path==='/api/config')body=state.config;
        else if(path==='/api/sessions'){if(state.sessionGate)await state.sessionGate;body=state.sessions;}
        else if(path==='/api/collabs/c_fixture'){if(state.historyGate)await state.historyGate;body={transcript:state.history};}
        else throw Error('unexpected route '+path);
      }
      return {ok:true,json:async()=>body};
    }};
  const controller=create(env,'fixture-nonce');
  return {controller,env,state,elements,created,posts,sockets,terminals,store,$:id=>document.getElementById(id)};
}
const live = (id='3',startedAt=1) => ({id,kind:'claude_duet_copy',startedAt,exited:false});

test('only explicitly configured conversations appear, even with no projects or live sessions',async()=>{
  const f=fixture();f.state.config.shell={label:'Shell'};f.state.config.bad={workspaceConversation:{title:'Missing cwd'}};
  await f.controller.refresh();assert.equal(f.$('native-list').children.length,1);
  f.$('native-list').children[0].onclick();assert.equal(f.controller.active,'claude_duet_copy');assert.equal(f.$('project-chat').hidden,true);
  assert.equal(f.$('native-resume').hidden,false);assert.equal(f.posts.length,0);
  assert.equal(definitions({_private:{workspaceConversation:{title:'No',cwd:'/a'}}}).length,0);
});
test('reload retains native mode before discovery and resolves kind, never a recycled numeric ID',async()=>{
  const f=fixture('claude_duet_copy');assert.equal(f.controller.active,'claude_duet_copy');assert.equal(f.$('project-chat').hidden,true);
  f.state.sessions=[{id:'3',kind:'shell',startedAt:1,exited:false},live('7',2)];await f.controller.refresh();
  assert.equal(new URL(f.sockets[0].url).searchParams.get('session'),'7');assert.equal(f.posts.length,0);
  f.state.sessions=[live('7',3)];await f.controller.refresh();assert.equal(f.terminals[0].disposed,true);assert.equal(f.sockets.length,2);
});
test('live input goes only to current authenticated socket and is never replayed on reconnect',async()=>{
  const f=fixture();f.state.sessions=[live()];await f.controller.refresh();f.controller.select('claude_duet_copy');
  const ws=f.sockets[0],term=f.terminals[0];ws.open();term.input('hello\r');
  assert.deepEqual(ws.sent.filter(x=>x.type==='input'),[{type:'input',data:'hello\r'}]);
  assert.equal(new URL(ws.url).searchParams.get('token'),'fixture-token');
  ws.close();term.input('do not send');assert.equal(term.options.disableStdin,true);assert.equal(ws.sent.filter(x=>x.type==='input').length,1);
  await f.controller.refresh();assert.equal(f.sockets.length,1,'refresh does not replay or automatically reconnect');
  await f.controller.resume();assert.equal(f.sockets.length,2);assert.equal(f.posts.length,0);assert.deepEqual(f.sockets[1].sent,[]);
});
test('missing/exited sessions and network errors retain native selection and disable input',async()=>{
  const f=fixture('claude_duet_copy');f.state.sessions=[live()];await f.controller.refresh();f.sockets[0].open();
  f.state.sessions=[];await f.controller.refresh();assert.equal(f.controller.active,'claude_duet_copy');assert.equal(f.terminals[0].disposed,true);
  assert.equal(f.$('native-resume').hidden,false);assert.equal(f.$('project-chat').hidden,true);
  f.state.fail=true;await f.controller.refresh();assert.equal(f.$('native-resume').disabled,true);assert.equal(f.posts.length,0);
});
test('resume checks existing sessions, uses configured cwd and false permissions, and serializes double clicks',async()=>{
  const f=fixture('claude_duet_copy');await f.controller.refresh();let release;f.state.postGate=new Promise(r=>release=r);
  const first=f.controller.resume(),second=f.controller.resume();await new Promise(r=>setImmediate(r));
  assert.equal(f.posts.length,1);assert.deepEqual(f.posts[0],{path:'/api/sessions',data:{kind:'claude_duet_copy',cwd:'/workspace',label:'Duet — Claude copy',dangerous:false}});
  release();await Promise.all([first,second]);await f.controller.resume();assert.equal(f.posts.length,1);
});
test('a lost launch response requires checking sessions instead of automatic retry',async()=>{
  const f=fixture('claude_duet_copy');await f.controller.refresh();const fetch=f.env.fetch;
  f.env.fetch=async(path,opts)=>{if(opts?.method==='POST'){f.state.sessions=[live('accepted')];throw Error('lost response');}return fetch(path,opts);};
  await f.controller.resume();assert.equal(f.$('native-resume').textContent,'Check for session');
  await f.controller.resume();assert.equal(new URL(f.sockets[0].url).searchParams.get('session'),'accepted');assert.equal(f.posts.length,0);
});
test('late history cannot replace a different selection and hostile history is plain text',async()=>{
  const f=fixture('claude_duet_copy');await f.controller.refresh();let release;f.state.historyGate=new Promise(r=>release=r);
  const request=f.controller.history();f.controller.deactivate();release();await request;
  assert.equal(f.$('native-panel').hidden,true);assert.equal(f.$('native-history').textContent.includes('untrusted'),false);
  delete f.state.historyGate;f.controller.select('claude_duet_copy');await f.controller.history();
  assert.match(f.$('native-history').textContent,/<script>untrusted<\/script>/);assert.ok(!f.created.some(n=>n.tagName==='script'));
});
test('switching project while resume discovery is pending cannot launch a session',async()=>{
  const f=fixture('claude_duet_copy');await f.controller.refresh();let release;f.state.sessionGate=new Promise(r=>release=r);
  const request=f.controller.resume();f.controller.deactivate();release();await request;
  assert.equal(f.posts.length,0);assert.equal(f.$('project-chat').hidden,false);assert.equal(f.controller.active,null);
});
test('removed config cannot resurrect a cached native session or launch arbitrary providers',async()=>{
  const f=fixture('claude_duet_copy');f.state.sessions=[live()];await f.controller.refresh();f.state.config={};await f.controller.refresh();
  assert.equal(f.$('native-resume').disabled,true);assert.equal(f.$('native-list').children.length,0);await f.controller.resume();assert.equal(f.posts.length,0);
});
test('a resize fitted before the socket opens is still delivered once it connects',async()=>{
  const f=fixture();f.env.FitAddon.FitAddon=class {fit(){const term=f.terminals.at(-1);if(term.cols!==100){term.cols=100;term.rows=35;term.resize?.({cols:100,rows:35});}}};
  f.state.sessions=[live()];await f.controller.refresh();f.controller.select('claude_duet_copy');
  const ws=f.sockets[0];
  // requestAnimationFrame runs fit() synchronously in this fixture while the socket
  // is still connecting (readyState 0), so any resize computed there cannot reach the pty.
  assert.equal(ws.sent.length,0,'no resize can be sent before the socket is open');
  ws.open();
  assert.deepEqual(ws.sent,[{type:'resize',cols:100,rows:35}],'onopen explicitly sends current dimensions once');
});
test('xterm document facade attaches nonce without modifying original document',()=>{
  const document={createElement:tag=>({tag,appendChild(child){return child;}}),identity(){return this;}};const original=document.createElement,proxy=terminalDocument(document,'nonce');
  assert.equal(proxy.createElement('style').nonce,'nonce');assert.equal(proxy.createElement('div').nonce,undefined);
  assert.equal(document.createElement,original);assert.equal(proxy.identity(),document);
});
test('a style appended to a facade-created element is nonced even when the style itself was created elsewhere',()=>{
  class Node { constructor(tag){this.tagName=String(tag).toUpperCase();this.children=[];} appendChild(child){if(child.tagName==='STYLE')assert.equal(child.nonce,'facade-nonce','nonce must exist before insertion');this.children.push(child);return child;} }
  const document={createElement:tag=>new Node(tag)};
  const original=document.createElement;
  const proxy=terminalDocument(document,'facade-nonce');
  const screenElement=proxy.createElement('div');
  const externalStyle=document.createElement('style');
  assert.equal(externalStyle.nonce,undefined,'a style made directly on the real document is untouched by the facade');
  screenElement.appendChild(externalStyle);
  assert.equal(externalStyle.nonce,'facade-nonce','the facade node nonces styles at the point of insertion');
  assert.equal(screenElement.children[0],externalStyle);
  assert.equal(document.createElement,original,'the global document is never patched');
  const plainDiv=document.createElement('div');
  assert.equal(typeof plainDiv.appendChild,'function');
  assert.equal(plainDiv.appendChild===Node.prototype.appendChild,true,'Node.prototype is never patched');
});
