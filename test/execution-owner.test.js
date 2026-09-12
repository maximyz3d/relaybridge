'use strict';
const nativeTest=require('node:test'),assert=require('node:assert/strict');
const test=process.platform==='linux'?nativeTest:nativeTest.skip;
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const {createOwnerJournal,controllerLock,hash}=require('../lib/execution-owner');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const pin={hostPid:12345,starttime:'100',nsIno:'99999',namespacePid:1,bootId:'11111111-1111-1111-1111-111111111111'};
const binding={requestId:'request_one',invocationId:'invoke_one',attemptId:'attempt_one',runId:'run_one',taskId:'task_one',provider:'fixture',accountId:'default',executionHash:hash('execution'),cwdIdentityHash:hash('cwd'),cwdPolicyId:hash('policy'),reservationId:'reservation_one'};
function fixture(t,extra={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rb-owner-journal-'));fs.chmodSync(dir,0o700);const owners=[];let alive=true,valid=true,applied=0;const decisions=new Set();
  const options={directory:dir,receiptStoreId:hash('store'),hostIdentity:hash('host'),qualifyHost:()=>true,
    validateCurrentBinding:b=>valid&&b.reservationId===binding.reservationId,
    resolveTrustedLaunch:b=>({profile:{version:1,kind:'linux_pid1_owner',policyId:b.cwdPolicyId,cwdIdentityHash:b.cwdIdentityHash,executionHash:b.executionHash,writeRoots:[]},launch:{file:process.execPath,args:[],cwd:dir,env:{PATH:'/usr/bin:/bin'}}}),
    probeNamespace:p=>{assert.deepEqual(p,pin);return alive?{state:'alive'}:{state:'gone',evidence:'pid_absent'};},
    createPhysicalOwner:()=>{let resolve,done=false;const owner={started:false,allowed:0,stopped:0,ready:Promise.resolve(),physicalDone:new Promise(r=>resolve=r),
      async start(){this.started=true;return null;},snapshot:()=>({pin:{...pin},wrapperExited:done,stdoutEof:done,stderrEof:done}),async allowProvider(){this.allowed++;return true;},requestStop(){this.stopped++;return true;},finish(){alive=false;done=true;resolve({evidence:'process_tree_settled'});}};owners.push(owner);return owner;},
    applyTaskRelease:async(b,decision)=>{assert.equal(b.reservationId,binding.reservationId);if(!decisions.has(decision.decisionId)){decisions.add(decision.decisionId);applied++;}return true;},...extra};
  const handles=[];const open=()=>{const store=createOwnerJournal(options);handles.push(store);return store;};
  t.after(()=>{for(const h of handles)try{h.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,options,open,owners,setAlive:v=>alive=v,setValid:v=>valid=v,applied:()=>applied};
}
async function gated(f){const store=f.open(),record=store.prepare(binding);await store.start(record.ownerId);await store.permit(record.ownerId);return {store,id:record.ownerId};}
function input(store,id){const s=store.inspect(id);return {recoveryId:'recover_one',expectedRevision:s.revision,expectedBindingHash:s.bindingHash,scope:'task_capacity',reason:'Explicit recovery of the exact held task'};}

test('actual flock controller excludes another process and child does not inherit lock',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rb-real-flock-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const first=controllerLock(dir);const contender=()=>spawnSync('/usr/bin/flock',['-n','-E','73',path.join(dir,'controller.lock'),'/bin/true'],{encoding:'utf8'});
 assert.equal(contender().status,73);
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});t.after(()=>child.kill());await wait(30);
 first.close();assert.equal(contender().status,0,'ordinary child must not retain controller fd');
 const second=controllerLock(dir);second.close();
});

test('prepared and pinned permit are durable before exactly one proceed',async t=>{
 const f=fixture(t),store=f.open(),record=store.prepare(binding);assert.equal(f.owners[0].allowed,0);assert.equal(store.inspect(record.ownerId).revision,1);
 await store.start(record.ownerId);assert.equal(f.owners[0].allowed,0);
 await store.permit(record.ownerId);const names=fs.readdirSync(f.dir).filter(x=>x.endsWith('.json'));assert.equal(names.length,3);assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,names.sort().at(-1)))).type,'permit');
 assert.equal(f.owners[0].allowed,1);await assert.rejects(store.permit(record.ownerId),{code:'OWNER_PERMIT_UNAVAILABLE'});assert.equal(f.owners[0].allowed,1);
});

test('real Linux PID1 owner integrates with journal before a disposable local helper runs',{skip:!fs.existsSync('/usr/bin/bwrap'),timeout:10000},async t=>{
 const {createLinuxPhysicalOwner}=require('../lib/linux-physical-owner');
 const {probeLinuxNamespace}=require('../lib/linux-owner-identity');
 const f=fixture(t,{createPhysicalOwner:createLinuxPhysicalOwner,probeNamespace:probeLinuxNamespace});
 const marker=f.dir+'-worker-marker';t.after(()=>fs.rmSync(marker,{force:true}));
 const resolve=f.options.resolveTrustedLaunch;f.options.resolveTrustedLaunch=b=>{const value=resolve(b);value.launch.args=['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'completed local fixture')`];return value;};
 const store=f.open(),record=store.prepare(binding);
 const keepAlive=setInterval(()=>{},1000);t.after(()=>clearInterval(keepAlive));
 const proc=await store.start(record.ownerId);
 if(proc){proc.stdout.resume();proc.stderr.resume();}
 assert.equal(fs.existsSync(marker),false);await store.permit(record.ownerId);proc.stdin.end();await store.confirmPhysical(record.ownerId);
 assert.equal(fs.readFileSync(marker,'utf8'),'completed local fixture');assert.equal(store.heldCount(),1);
 const decision=store.recover(record.ownerId,input(store,record.ownerId));await store.applyRelease(record.ownerId,decision.decisionId);assert.equal(store.heldCount(),0);
});

test('permit-directory fsync failure specifically prevents proceed after a confirmed pin',async t=>{
 let armed=false,syncs=0;const io=Object.create(fs);io.fsyncSync=fd=>{if(armed&&fs.fstatSync(fd).isDirectory()&&++syncs===2)throw Object.assign(new Error('fault'),{code:'EIO'});return fs.fsyncSync(fd);};
 const f=fixture(t,{fsApi:io}),store=f.open(),record=store.prepare(binding);await store.start(record.ownerId);armed=true;
 await assert.rejects(store.permit(record.ownerId),{code:'OWNER_DURABILITY_UNCONFIRMED'});assert.ok(store.inspect(record.ownerId).pin);assert.equal(store.inspect(record.ownerId).permitted,undefined);assert.equal(f.owners[0].allowed,0);assert.equal(f.owners[0].stopped,1);
});

test('restart after prepare without trusted pin cannot recover or restart the owner',async t=>{
 const f=fixture(t),store=f.open(),record=store.prepare(binding);store.close();const restored=f.open();f.setAlive(false);
 assert.throws(()=>restored.recover(record.ownerId,input(restored,record.ownerId)),{code:'OWNER_PROOF_UNAVAILABLE'});await assert.rejects(restored.start(record.ownerId),{code:'OWNER_START_UNAVAILABLE'});assert.equal(restored.heldCount(),1);
});

test('fsync failure after pin publication stops gate and never proceeds',async t=>{
 let fail=false;const io=Object.create(fs);io.fsyncSync=fd=>{if(fail&&fs.fstatSync(fd).isDirectory())throw Object.assign(new Error('fault'),{code:'EIO'});return fs.fsyncSync(fd);};
 const f=fixture(t,{fsApi:io}),store=f.open(),record=store.prepare(binding);await store.start(record.ownerId);fail=true;
 await assert.rejects(store.permit(record.ownerId),{code:'OWNER_DURABILITY_UNCONFIRMED'});assert.equal(f.owners[0].allowed,0);assert.equal(f.owners[0].stopped,1);assert.equal(store.heldCount(),1);
 fail=false;store.close();const restored=f.open();assert.equal(restored.inspect(record.ownerId).held,true);await assert.rejects(restored.start(record.ownerId),{code:'OWNER_START_UNAVAILABLE'});
});

test('caller cannot provide proof, PID or adopt an unbound legacy owner',async t=>{
 const f=fixture(t),{store,id}=await gated(f);const request=input(store,id);
 for(const field of ['ownerFenced','pin','pid','deathProof','force','replay'])assert.throws(()=>store.recover(id,{...request,[field]:true}),{code:'OWNER_SCHEMA_INVALID'});
 assert.throws(()=>store.recover('owner_'+'1'.repeat(32),request),{code:'OWNER_UNBOUND'});
 assert.throws(()=>store.recover(id,request),{code:'OWNER_STILL_ACTIVE'});assert.equal(store.heldCount(),1);
});

test('exact death proof and explicit immutable decision release once without replay',async t=>{
 const f=fixture(t),{store,id}=await gated(f);f.owners[0].finish();await store.confirmPhysical(id);assert.equal(store.heldCount(),1,'physical death alone does not release');
 const request=input(store,id),decision=store.recover(id,request);assert.equal(store.heldCount(),1);assert.equal(store.admissionBlocked(),true);
 assert.deepEqual(store.recover(id,request),decision);assert.throws(()=>store.recover(id,{...request,reason:'different'}),{code:'OWNER_RECOVERY_ID_CONFLICT'});
 await store.applyRelease(id,decision.decisionId);await store.applyRelease(id,decision.decisionId);assert.equal(f.applied(),1);assert.equal(f.owners[0].allowed,1);assert.equal(store.heldCount(),0);assert.equal(decision.replay,false);
 store.close();const restored=f.open();assert.deepEqual(restored.recover(id,request),decision);await restored.applyRelease(id,decision.decisionId);assert.equal(f.applied(),1);assert.equal(f.owners.length,1);
});

test('readable but unconfirmed death barrier retains capacity across restart',async t=>{
 let fail=false;const io=Object.create(fs);io.fsyncSync=fd=>{if(fail&&fs.fstatSync(fd).isDirectory())throw Object.assign(new Error('fault'),{code:'EIO'});return fs.fsyncSync(fd);};
 const f=fixture(t,{fsApi:io}),{store,id}=await gated(f);f.owners[0].finish();fail=true;
 await assert.rejects(store.confirmPhysical(id),{code:'OWNER_DURABILITY_UNCONFIRMED'});assert.equal(store.heldCount(),1);assert.equal(f.applied(),0);store.close();
 assert.throws(()=>f.open());fail=false;const restored=f.open();assert.ok(restored.inspect(id).proof);assert.equal(restored.heldCount(),1);assert.equal(restored.admissionBlocked(),false,'death is not an explicit release decision');
});

test('decision projection crash is rolled forward idempotently without worker dispatch',async t=>{
 let failApply=true;const effects=new Set();let count=0;
 const f=fixture(t,{applyTaskRelease:async(_binding,decision)=>{if(!effects.has(decision.decisionId)){effects.add(decision.decisionId);count++;}if(failApply)throw new Error('crash after task projection');return true;}});
 const {store,id}=await gated(f);f.owners[0].finish();await store.confirmPhysical(id);const decision=store.recover(id,input(store,id));await assert.rejects(store.applyRelease(id,decision.decisionId));assert.equal(store.heldCount(),1);assert.equal(store.admissionBlocked(),true);
 assert.throws(()=>store.prepare({...binding,runId:'run_other',attemptId:'attempt_other'}),{code:'OWNER_RELEASE_APPLICATION_PENDING'});store.close();failApply=false;const restored=f.open();assert.equal(restored.admissionBlocked(),true);await restored.applyRelease(id,decision.decisionId);assert.equal(count,1);assert.equal(restored.heldCount(),0);assert.equal(f.owners[0].allowed,1);
});

test('replacement namespace pin, task identity and controller inode fail closed',async t=>{
 const f=fixture(t),{store,id}=await gated(f);f.setValid(false);assert.throws(()=>store.recover(id,input(store,id)),{code:'OWNER_BINDING_CHANGED'});f.setValid(true);
 f.owners[0].snapshot=()=>({pin:{...pin,starttime:'999'}});f.owners[0].finish();await assert.rejects(store.confirmPhysical(id),{code:'OWNER_PIN_MISMATCH'});assert.equal(store.heldCount(),1);
 fs.renameSync(path.join(f.dir,'controller.lock'),path.join(f.dir,'old.lock'));fs.writeFileSync(path.join(f.dir,'controller.lock'),'');fs.chmodSync(path.join(f.dir,'controller.lock'),0o600);
 assert.throws(()=>store.inspect(id),{code:'OWNER_LOCK_IDENTITY_CHANGED'});
});

test('copied journal, altered hash, missing predecessor and legacy records cannot restore authority',async t=>{
 const f=fixture(t),{store,id}=await gated(f);store.close();const other=fs.mkdtempSync(path.join(os.tmpdir(),'rb-owner-copy-'));fs.chmodSync(other,0o700);t.after(()=>fs.rmSync(other,{recursive:true,force:true}));
 for(const name of fs.readdirSync(f.dir))if(name.endsWith('.json'))fs.copyFileSync(path.join(f.dir,name),path.join(other,name));
 assert.throws(()=>createOwnerJournal({...f.options,directory:other}),{code:'OWNER_AUTHORITY_CHANGED'});
 const first=fs.readdirSync(f.dir).filter(x=>x.endsWith('.json')).sort()[0];const bytes=fs.readFileSync(path.join(f.dir,first),'utf8');
 fs.writeFileSync(path.join(f.dir,first),bytes.replace('request_one','request_bad'));assert.throws(()=>f.open(),{code:'OWNER_JOURNAL_INVALID'});
 fs.writeFileSync(path.join(f.dir,first),bytes);fs.unlinkSync(path.join(f.dir,first));assert.throws(()=>f.open(),{code:'OWNER_JOURNAL_ORDER'});
 fs.writeFileSync(path.join(f.dir,'legacy-task.json'),'{}');assert.throws(()=>f.open(),{code:'OWNER_JOURNAL_UNTRUSTED'});
});


test('closed trusted launch seam forbids caller argv, binds command and rejects unqualified staging',async t=>{
 const f=fixture(t),resolve=f.options.resolveTrustedLaunch;let changed=false;
 f.options.resolveTrustedLaunch=b=>{const value=resolve(b);if(changed)value.launch.args=['changed'];return value;};
 const store=f.open(),record=store.prepare(binding);
 await assert.rejects(store.start(record.ownerId,{bwrapArgs:['--dev-bind','/','/']}),{code:'OWNER_CALLER_LAUNCH_FORBIDDEN'});
 changed=true;await assert.rejects(store.start(record.ownerId),{code:'OWNER_LAUNCH_CHANGED'});assert.equal(f.owners[0].started,false);
 changed=false;await store.start(record.ownerId);assert.equal(f.owners[0].started,true);
 const second=fixture(t);const secondResolve=second.options.resolveTrustedLaunch;second.options.resolveTrustedLaunch=b=>{const value=secondResolve(b);value.profile.bwrapArgs=[];return value;};
 assert.throws(()=>second.open().prepare(binding),{code:'OWNER_SCHEMA_INVALID'});
 const third=fixture(t);delete third.options.createPhysicalOwner;const thirdResolve=third.options.resolveTrustedLaunch;third.options.resolveTrustedLaunch=b=>{const value=thirdResolve(b);value.profile.kind='linux_pid1_staged_write';return value;};
 assert.throws(()=>third.open().prepare(binding),{code:'OWNER_LAUNCH_PROFILE_UNQUALIFIED'});
});
