'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createReceiptLookup}=require('../lib/receipt-lookup');
// Synthetic receipt journals only; no bridge data directory is read.
function journal(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rb-receipt-lookup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const write=(name,rows,tail='')=>fs.writeFileSync(path.join(dir,name),rows.map(r=>JSON.stringify(r)+'\n').join('')+tail);return{dir,write};}
function countRead(t){let bytes=0;const original=fs.readSync;fs.readSync=(...args)=>{const n=original(...args);bytes+=n;return n;};t.after(()=>{fs.readSync=original;});return()=>{const value=bytes;bytes=0;return value;};}
test('lookup returns whitelisted metadata only for exact reference fields',t=>{const j=journal(t),lookup=createReceiptLookup();
 j.write('2026-09-12.jsonl',[{receiptId:'rcpt_fx_one',event:'bridge_provider_call',status:'completed',timestamp:'2026-09-12T01:00:00Z',requestId:'fx-request-01',outputHash:'a'.repeat(64),prompt:'synthetic prompt body',stdout:'synthetic output',route:{requested_model:'fixture-standard',api_key:'synthetic'}},
  {receiptId:'rcpt_fx_outer',outerReceiptId:'rcpt_fx_one',requestId:'fx-unrelated-01',timestamp:'2026-09-12T02:00:00Z'}]);
 fs.appendFileSync(path.join(j.dir,'2026-09-12.jsonl'),'{not json "rcpt_fx_one"\n');
 const {receipts,scan}=lookup.find(j.dir,{receiptIds:['rcpt_fx_one']});
 assert.deepEqual(receipts,[{receiptId:'rcpt_fx_one',event:'bridge_provider_call',status:'completed',timestamp:'2026-09-12T01:00:00Z',requestId:'fx-request-01',outputHash:'a'.repeat(64),route:{requested_model:'fixture-standard'}}]);
 assert.deepEqual(scan,{configured:true,filesAvailable:1,filesScanned:1,filesSkipped:0,olderFilesNotScanned:0,limited:false,error:null});
 assert.deepEqual(lookup.find(j.dir,{requestIds:['rcpt_fx_one']}).receipts,[],'a value in a different field is not a match');
});
test('lookup reads appended complete lines incrementally and rescans only for new references',t=>{const j=journal(t),lookup=createReceiptLookup(),read=countRead(t),file=path.join(j.dir,'2026-09-13.jsonl');
 const first={receiptId:'rcpt_fx_a',requestId:'fx-request-a1',timestamp:'2026-09-13T01:00:00Z'},second={receiptId:'rcpt_fx_b',requestId:'fx-request-b1',timestamp:'2026-09-13T02:00:00Z'};
 const partial=JSON.stringify(second);j.write('2026-09-13.jsonl',[first],partial.slice(0,20));
 assert.equal(lookup.find(j.dir,{requestIds:['fx-request-a1']}).receipts.length,1);assert.ok(read()>0);
 assert.equal(lookup.find(j.dir,{requestIds:['fx-request-a1']}).receipts.length,1);assert.equal(read(),20,'only the unfinished tail is re-read');
 fs.appendFileSync(file,partial.slice(20)+'\n');
 assert.deepEqual(lookup.find(j.dir,{requestIds:['fx-request-b1']}).receipts.map(r=>r.receiptId),['rcpt_fx_b'],'completed line is found');
 read();assert.deepEqual(lookup.find(j.dir,{requestIds:['fx-request-a1','fx-request-b1']}).receipts.map(r=>r.receiptId),['rcpt_fx_b','rcpt_fx_a']);assert.equal(read(),0,'cached tokens need no reads');
 const replacement=path.join(j.dir,'replacement');fs.writeFileSync(replacement,JSON.stringify({receiptId:'rcpt_fx_c',requestId:'fx-request-a1'})+'\n');fs.renameSync(replacement,file);
 assert.deepEqual(lookup.find(j.dir,{requestIds:['fx-request-a1']}).receipts.map(r=>r.receiptId),['rcpt_fx_c'],'a replaced journal is rescanned');
});
test('lookup bounds files, bytes and matches and reports every limit',t=>{const j=journal(t);
 for(const day of ['10','11','12'])j.write(`2026-09-${day}.jsonl`,[{receiptId:`rcpt_fx_${day}`,requestId:'fx-shared-0001',timestamp:`2026-09-${day}T00:00:00Z`}]);
 j.write('notes.jsonl',[{receiptId:'rcpt_fx_notes',requestId:'fx-shared-0001'}]);j.write('2026-09-13.jsonl.bak',[{requestId:'fx-shared-0001'}]);
 let found=createReceiptLookup({maxFiles:2}).find(j.dir,{requestIds:['fx-shared-0001']});
 assert.deepEqual(found.receipts.map(r=>r.receiptId),['rcpt_fx_12','rcpt_fx_11']);assert.equal(found.scan.olderFilesNotScanned,1);assert.equal(found.scan.limited,true);
 found=createReceiptLookup({maxMatches:1}).find(j.dir,{requestIds:['fx-shared-0001']});assert.deepEqual(found.receipts.map(r=>r.receiptId),['rcpt_fx_12']);assert.equal(found.scan.limited,true);
 found=createReceiptLookup({maxFileBytes:10}).find(j.dir,{requestIds:['fx-shared-0001']});assert.equal(found.receipts.length,0);assert.equal(found.scan.filesSkipped,3);assert.equal(found.scan.limited,true);
 found=createReceiptLookup({maxTotalBytes:120}).find(j.dir,{requestIds:['fx-shared-0001']});assert.ok(found.scan.filesScanned<3);assert.equal(found.scan.limited,true);
 const outside=journal(t);outside.write('2026-09-14.jsonl',[{receiptId:'rcpt_fx_link',requestId:'fx-shared-0001'}]);
 try{fs.symlinkSync(path.join(outside.dir,'2026-09-14.jsonl'),path.join(j.dir,'2026-09-14.jsonl'));
  found=createReceiptLookup().find(j.dir,{requestIds:['fx-shared-0001']});assert.ok(!found.receipts.some(r=>r.receiptId==='rcpt_fx_link'),'symlinked journals are not followed');assert.equal(found.scan.filesSkipped,1);
 }catch(error){if(error.code!=='EPERM')throw error;}
 assert.deepEqual(createReceiptLookup().find(path.join(j.dir,'missing'),{requestIds:['fx-shared-0001']}).scan.limited,false);
 assert.deepEqual(createReceiptLookup().find(null,{requestIds:['fx-shared-0001']}),{receipts:[],scan:{configured:false,filesAvailable:0,filesScanned:0,filesSkipped:0,olderFilesNotScanned:0,limited:false,error:null}});
 assert.equal(createReceiptLookup().find(j.dir,{}).scan.filesScanned,0,'no references means no reads');
});
