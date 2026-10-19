import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { DomainError, type ProviderCapabilities } from '@relay/core';
import { loadConfig } from '../src/config.js';
import { Db } from '../src/db.js';
import { ProviderRegistry } from '../src/providers.js';
import { Scheduler, AutomationSettingsService } from '../src/scheduler.js';
import { DocumentJobs } from '../src/document-jobs.js';
import { ExtractionJobs } from '../src/extraction-jobs.js';
import { decodeUpload } from '../src/attachments.js';
import { renderDocument } from '../src/document-render.js';
import { attachmentContext, attachmentTool } from '../src/agent-context.js';

async function diagramPdf(count=2){const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);for(let i=1;i<=count;i++){const p=pdf.addPage([450,300]);p.drawText('Page '+i+' - A flows to B',{x:30,y:260,font,size:18});if(i>1){p.drawRectangle({x:40,y:100,width:90,height:70,color:rgb(.8,.9,1)});p.drawRectangle({x:290,y:100,width:90,height:70,color:rgb(.8,1,.9)});p.drawText('A',{x:75,y:125,font});p.drawText('B',{x:325,y:125,font});p.drawLine({start:{x:130,y:135},end:{x:290,y:135},thickness:2});}}return Buffer.from(await pdf.save());}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
async function bounded<T>(promise:Promise<T>,ms=10000){let timer:NodeJS.Timeout;return Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Fixture timeout')),ms);})]).finally(()=>clearTimeout(timer));}
async function fixture(t:{after(fn:()=>Promise<void>):void},nativePdf=true){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-document-')),requests:any[]=[],entered=deferred(),release=deferred();let block=false,failLast=false;
  const upstream=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{void(async()=>{const body=JSON.parse(raw);requests.push(body);entered.resolve();if(block)await release.promise;if(res.destroyed)return;const content=body.messages.at(-1).content,caption=content[0].text,match=/номера выбранных страниц: (\[[\d,]+\])/.exec(caption),numbers=JSON.parse(match![1]) as number[];
    if(failLast&&numbers.includes(4)){res.writeHead(503);res.end('{}');return;}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify({pages:numbers.map(number=>({number,text:'Страница '+number+': связь A → B. Это интерпретация схемы.',warnings:[]}))})},finish_reason:'stop'}]}));})().catch(()=>res.destroy());});});
  await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+(upstream.address() as {port:number}).port;
  const cfg=loadConfig();cfg.dataDir=root;cfg.dbPath=path.join(root,'main.sqlite');cfg.vault.root=path.join(root,'vault');cfg.providers.keyFile=path.join(root,'provider.key');cfg.providers.allowedOrigins=[origin];cfg.llm.apiKey='';cfg.sync={...cfg.sync,mode:'none',pullInterval:0};
  const db=await Db.open(cfg.dbPath),registry=await ProviderRegistry.open(db,cfg);
  const caps:ProviderCapabilities={toolCalls:false,vision:!nativePdf,structuredOutput:false,nativePdf,pdfMaxPages:3,pdfMaxBytes:5*1024*1024};
  const profile=registry.create('chat',{name:'Document fixture',adapter:'openai_compatible',baseUrl:origin+'/v1',modelId:'fixture-model',canonicalModelId:null,enabled:true,capabilities:caps,secretUpdate:{action:'remove'}});
  const chat=db.chats.create(1,'document-pipeline-entry','UTC'),documents=new DocumentJobs(db.chats,registry),extractions=new ExtractionJobs(db.chats),scheduler=new Scheduler(db,new AutomationSettingsService(db),{document:lease=>documents.run(lease),extract:lease=>extractions.run(lease)});
  t.after(async()=>{block=false;release.resolve();documents.stop();extractions.stop();await scheduler.stop();db.close();upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith('relay-document-'));await fs.rm(root,{recursive:true,force:true});});
  async function file(count=2){const bytes=await diagramPdf(count),decoded=await decodeUpload('Diagram.pdf',bytes,true);return db.chats.putAttachment(1,chat.id,'Diagram.pdf','application/pdf','text',bytes,decoded.text,decoded.report);}
  return {root,cfg,db,registry,profile,caps,chat,documents,extractions,scheduler,requests,file,entered,release,setBlock:(v:boolean)=>block=v,setFailure:(v:boolean)=>failLast=v};
}

test('PDF routes classify vector diagrams without mistaking extracted text for understanding',async t=>{
  const f=await fixture(t),file=await f.file(),stored=f.db.chats.attachment(1,f.chat.id,file.id);assert.equal(stored.report!.pages[0].classification,'text');assert.equal(stored.report!.pages[1].classification,'visual');assert.equal(stored.report!.status,'partial');assert.equal(stored.report!.pages[1].interpretation,undefined);
  const original=await PDFDocument.load(stored.bytes),subset=await renderDocument(stored.bytes,[2],'pdf',new AbortController().signal);assert.equal((await PDFDocument.load(Buffer.from(subset.pdf!,'base64'))).getPageCount(),1);assert.equal(original.getPageCount(),2);
  await assert.rejects(renderDocument(stored.bytes,[99],'images',new AbortController().signal),/подготовить PDF/);
});
for(const nativePdf of [true,false])test((nativePdf?'native PDF':'page image')+' background path preserves page provenance and reuses model cache',async t=>{
  const f=await fixture(t,nativePdf),file=await f.file();
  const request={requestId:'document-first-request',pages:[2],question:'SECRET_QUESTION_FIXTURE: объясни связь'};
  f.documents.enqueue(f.scheduler,1,f.chat.id,file.id,request);await f.scheduler.tick();assert.equal(f.documents.status(f.scheduler,1,f.chat.id,request.requestId).state,'complete');assert.equal(f.requests.length,1);
  const parts=f.requests[0].messages.at(-1).content;if(nativePdf){assert.equal(parts[1].type,'file');assert.match(parts[1].file.file_data,/^data:application\/pdf;base64,/);assert.equal((await PDFDocument.load(Buffer.from(parts[1].file.file_data.split(',')[1],'base64'))).getPageCount(),1);}else{assert.equal(parts[2].type,'image_url');assert.match(parts[2].image_url.url,/^data:image\/jpeg;base64,/);}
  const updated=f.db.chats.attachment(1,f.chat.id,file.id);assert.equal(updated.report!.pages[1].interpretation!.route,nativePdf?'native_pdf':'page_images');assert.equal(updated.report!.pages[1].method,'text');assert.match(updated.text,/A flows to B/);assert(!updated.text.includes('интерпретация схемы'));
  f.documents.enqueue(f.scheduler,1,f.chat.id,file.id,{...request,requestId:'document-cache-request'});await f.scheduler.tick();assert.equal(f.requests.length,1);
  assert.match(attachmentContext([updated],'связь'),/страница 2; интерпретация модели/);assert.match(await attachmentTool(f.db.chats,1,f.chat.id,[file.id]).execute({fileId:file.id,page:2}),/Интерпретация схемы/);
  const jobs=JSON.stringify(f.db.sql.prepare('SELECT payload_json,result_json FROM jobs').all());assert(!jobs.includes('SECRET_QUESTION_FIXTURE'));assert(!jobs.includes('интерпретация схемы'));
  assert.throws(()=>f.documents.status(f.scheduler,2,f.chat.id,request.requestId));
});
test('completed page batches survive a later failure and retries process only missing pages',async t=>{
  const f=await fixture(t),file=await f.file(4);f.setFailure(true);const request={pages:[1,2,3,4],question:'Объясни схему',requestId:'document-partial-request'};
  f.documents.enqueue(f.scheduler,1,f.chat.id,file.id,request);await f.scheduler.tick();const partial=f.documents.status(f.scheduler,1,f.chat.id,request.requestId);assert.equal(partial.state,'partial');assert.deepEqual(partial.processed,[1,2,3]);assert.equal(f.requests.length,2);
  f.setFailure(false);f.documents.enqueue(f.scheduler,1,f.chat.id,file.id,{...request,requestId:'document-missing-request'});await f.scheduler.tick();assert.equal(f.requests.length,3);assert.equal(f.documents.status(f.scheduler,1,f.chat.id,'document-missing-request').processed.length,4);
});
test('cancellation and clearing history fence an in-flight model and do not resurrect reports',async t=>{
  const f=await fixture(t),file=await f.file();f.setBlock(true);const request={pages:[2],requestId:'document-cancel-request'};f.documents.enqueue(f.scheduler,1,f.chat.id,file.id,request);const work=f.scheduler.tick();await bounded(f.entered.promise);f.documents.cancel(f.scheduler,1,f.chat.id,request.requestId);await bounded(work);assert.equal(f.documents.status(f.scheduler,1,f.chat.id,request.requestId).state,'cancelled');assert.equal(f.db.chats.attachment(1,f.chat.id,file.id).report!.pages[1].interpretation,undefined);
  f.db.chats.clear(1,f.chat.id);assert.equal(f.db.chats.documentRun(1,f.chat.id,request.requestId),null);assert.throws(()=>f.documents.enqueue(f.scheduler,1,f.chat.id,file.id,request),/нельзя использовать снова/);
});
test('profile revision and unsupported capabilities prevent dispatch; restart does not automatically repeat document calls',async t=>{
  const f=await fixture(t),file=await f.file(),request={pages:[2],requestId:'document-profile-request'};f.documents.enqueue(f.scheduler,1,f.chat.id,file.id,request);
  f.registry.update(f.profile.id,{...f.profile,capabilities:{...f.caps,nativePdf:false,vision:false},expectedVersion:f.profile.version,secretUpdate:{action:'remove'}});await f.scheduler.tick();assert.equal(f.requests.length,0);assert.equal(f.documents.status(f.scheduler,1,f.chat.id,request.requestId).state,'failed');
  assert.throws(()=>f.documents.enqueue(f.scheduler,1,f.chat.id,file.id,{...request,requestId:'document-no-capability'}),(e:unknown)=>e instanceof DomainError&&e.code==='DOCUMENT_CAPABILITY');
  f.db.sql.prepare("UPDATE jobs SET state='running',lease_owner='dead',lease_until=0 WHERE kind='document'").run();f.scheduler.recover();assert.equal(f.scheduler.list().find(j=>j.kind==='document')!.state,'unknown');
});

test('clearing history while the model is running cancels work without restoring deleted data',async t=>{
  const f=await fixture(t),file=await f.file();f.setBlock(true);const request={pages:[2],requestId:'document-clear-active'};
  f.documents.enqueue(f.scheduler,1,f.chat.id,file.id,request);const work=f.scheduler.tick();await bounded(f.entered.promise);f.db.chats.clear(1,f.chat.id);await bounded(work,5000);
  assert.equal(f.db.chats.documentRun(1,f.chat.id,request.requestId),null);assert.throws(()=>f.db.chats.attachment(1,f.chat.id,file.id));assert.equal(f.db.chats.documentRequests().length,0);
});

test('queued document intent is recovered after a crash before main queue insertion',async t=>{
  const f=await fixture(t),file=await f.file(),request={pages:[2],requestId:'document-orphan-intent'};
  f.documents.enqueue(f.scheduler,1,f.chat.id,file.id,request);f.db.sql.prepare("DELETE FROM jobs WHERE kind='document'").run();
  f.documents.recover(f.scheduler);assert.equal(f.scheduler.list().filter(j=>j.kind==='document').length,1);await f.scheduler.tick();assert.equal(f.requests.length,1);assert.equal(f.documents.status(f.scheduler,1,f.chat.id,request.requestId).state,'complete');
});

test('document queue caps pending work per device without breaking idempotent replay',async t=>{
  const f=await fixture(t),file=await f.file();for(let i=0;i<8;i++)f.documents.enqueue(f.scheduler,1,f.chat.id,file.id,{pages:[2],requestId:'document-queue-'+i});
  assert.equal(f.documents.enqueue(f.scheduler,1,f.chat.id,file.id,{pages:[2],requestId:'document-queue-0'}).state,'queued');
  assert.throws(()=>f.documents.enqueue(f.scheduler,1,f.chat.id,file.id,{pages:[2],requestId:'document-queue-overflow'}),(e:unknown)=>e instanceof DomainError&&e.code==='DOCUMENT_BUSY');
});

test('page interpretations fit the shared attachment budget and remain readable without an OCR text layer',async t=>{
  const f=await fixture(t),file=await f.file();f.documents.enqueue(f.scheduler,1,f.chat.id,file.id,{pages:[2],requestId:'document-context-budget'});await f.scheduler.tick();const stored=f.db.chats.attachment(1,f.chat.id,file.id);
  stored.text='';assert.match(attachmentContext([stored],'связь'),/интерпретация модели/);
  stored.text='Synthetic extracted text '.repeat(5000);stored.report!.pages[1].interpretation!.text='INTERPRETATION '.repeat(1000);
  const files=Array.from({length:5},(_,i)=>({...stored,id:'file_'+i,name:'fixture-'+i+'.pdf'})),context=attachmentContext(files,'Synthetic',24000);assert(context.length<26000,'metadata overhead must not hide unbounded interpretation text');
});
test('local extraction caches by scope, content and settings and never survives chat clear',async t=>{
  const f=await fixture(t),bytes=Buffer.from('Synthetic cached text');const first=await f.extractions.enqueue(f.scheduler,1,f.chat.id,'A.txt',bytes);await f.scheduler.tick();const second=await f.extractions.enqueue(f.scheduler,1,f.chat.id,'B.txt',bytes);await f.scheduler.tick();
  const job=f.scheduler.find('extract:'+second.id)!;assert.equal((job.result as any).cacheHit,true);const stored=f.db.chats.attachment(1,f.chat.id,first.id);assert.match(stored.report!.fileHash!,/^[a-f0-9]{64}$/);
  f.db.chats.clear(1,f.chat.id);assert.equal(f.db.chats.cachedExtraction(1,f.chat.id,'invalid'),null);assert.equal(f.db.chats.pendingExtractions().length,0);
});
