import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { ChatStore } from '../src/chat-store.js';
import { Vault, LlmClient, DomainError, disposeSearch, hashContent, measureRun, measure } from '@relay/core';
import { Db } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { GitSync } from '../src/sync.js';
import { VaultMutationService } from '../src/vault-mutations.js';
import { NoteService } from '../src/notes.js';
import { NoteIndex } from '../src/note-index.js';
import { ChatMemoryService } from '../src/chat-memory.js';
import { Scheduler, AutomationSettingsService } from '../src/scheduler.js';
import { SummaryJobs } from '../src/summary-jobs.js';
import { RequestLedger } from '../src/request-ledger.js';
import type { ProviderRegistry } from '../src/providers.js';
import { createServer } from '../src/index.js';

async function fixture(t:{after(fn:()=>Promise<void>):void}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-stage-')),cfg=loadConfig();
  cfg.vault.root=path.join(root,'vault');cfg.vault.privateFolders=['Private'];cfg.sync={...cfg.sync,mode:'none',remote:'',pullInterval:0};
  await fs.mkdir(cfg.vault.root);const db=await Db.open(path.join(root,'relay.sqlite')),vault=new Vault(cfg.vault),sync=new GitSync(cfg),mutations=new VaultMutationService(vault,db,sync);
  vault.setReadGuard(work=>sync.exclusive(work));vault.setWriteBackend(mutations);
  const memory=new ChatMemoryService(db.chats,vault),index=new NoteIndex(vault,db);
  const cleanups:(()=>Promise<unknown>)[]=[];
  t.after(async()=>{for(const cleanup of cleanups)await cleanup();sync.stop();disposeSearch(vault);db.close();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith('relay-stage-'));await fs.rm(root,{recursive:true,force:true});});
  return {root,cfg,db,vault,sync,mutations,memory,index,cleanups};
}

test('context reads never invoke a model and a late summary cannot resurrect a cleared conversation',async t=>{
  const f=await fixture(t),chat=f.db.chats.create(1,'summary-race-stage','UTC');
  for(let i=0;i<20;i++)f.db.chats.add(1,chat.id,i%2?'assistant':'user','old '+i);
  assert.equal((await f.memory.readContext(1,chat.id)).history.length,10);
  let started!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>started=r),waiting=new Promise<void>(r=>release=r);
  const llm=new LlmClient({baseUrl:'https://fixture.test',apiKey:'',model:'fixture'},async()=>{started();await waiting;return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'{"summary":"old private facts"}'},finish_reason:'stop'}]}));});
  const work=f.memory.context(1,chat.id,llm,new AbortController().signal,false,1);await entered;
  assert.equal((await f.memory.readContext(1,chat.id)).history.length,10);
  f.db.chats.clear(1,chat.id);f.db.chats.add(1,chat.id,'user','new generation');release();await work;
  assert.equal(f.db.chats.memory(1,chat.id).summary,'');assert.equal((await f.memory.readContext(1,chat.id)).history[0].content,'new generation');
});

test('saved run and summary intent commit together; restart dispatch coalesces and retains the recent tail',async t=>{
  const f=await fixture(t),chat=f.db.chats.create(1,'summary-outbox-stage','UTC');
  for(let i=0;i<45;i++)f.db.chats.add(1,chat.id,i%2?'assistant':'user','message '+i);
  const ledger=new RequestLedger(f.db);ledger.reserve(1,chat.id,'summary-request-1','hash');
  f.db.chats.beginRun(1,chat.id,'summary-request-1','hash');f.db.chats.finishRun(1,chat.id,'summary-request-1',{text:'saved',outcome:'success'},{providerId:null,providerVersion:null});
  ledger.recover();assert.equal(ledger.inspect(1,chat.id,'summary-request-1')!.outcome,'success');assert.equal(ledger.inspect(1,chat.id,'summary-request-1')!.state,'completed');
  f.db.chats.requestSummary(1,chat.id);assert.equal(f.db.chats.summaryRequests().length,1);
  const registry={list:()=>({items:[]})} as unknown as ProviderRegistry,jobs=new SummaryJobs(f.db.chats,f.memory,registry,()=>true);
  const scheduler:Scheduler=new Scheduler(f.db,new AutomationSettingsService(f.db),{summarize:lease=>jobs.run(lease,scheduler)});f.cleanups.push(()=>scheduler.stop());
  jobs.recover(scheduler);for(let i=0;i<4;i++)await scheduler.tick();
  assert.equal(f.db.chats.memory(1,chat.id).coverage.length,35);assert.equal((await f.memory.readContext(1,chat.id)).history.length,10);assert.equal(f.db.chats.summaryRequests().length,0);
  f.db.chats.requestSummary(1,chat.id);f.db.chats.clear(1,chat.id);assert.equal(f.db.chats.summaryRequests().length,0);
});

test('summarization has a separate scheduler lane and is not cancelled by organizer settings',async t=>{
  const f=await fixture(t),settings=new AutomationSettingsService(f.db);let release!:()=>void,started!:()=>void,done!:()=>void;
  const waiting=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r),summarized=new Promise<void>(r=>done=r);
  const scheduler=new Scheduler(f.db,settings,{extract:async()=>{started();await waiting;},summarize:async lease=>{lease.assert();done();}});f.cleanups.push(()=>scheduler.stop());
  scheduler.enqueue('extract','long-extraction-stage',Date.now(),0);const first=scheduler.tick();await entered;
  scheduler.enqueue('summarize','short-summary-stage',Date.now(),0);settings.save({...settings.get()});const second=scheduler.tick();
  await summarized;release();await Promise.all([first,second]);assert.equal(scheduler.find('short-summary-stage')!.state,'succeeded');
});

test('task projection reuses indexed documents and applies individual changes without a full reread',async t=>{
  const f=await fixture(t);for(let i=0;i<15;i++)await f.vault.writeNote(`Notes/${i}.md`,`# Note ${i}`);
  await f.index.refresh();let reads=0;const read=f.vault.readNote.bind(f.vault);f.vault.readNote=async p=>{reads++;return read(p);};
  await f.index.tasks();await f.index.tasks();assert.equal(reads,0);
  await f.vault.writeNote('Notes/2.md','# Changed',{overwrite:true,expectedHash:hashContent('# Note 2')});await f.index.tasks();assert(reads<5);
  assert.equal((f.db.sql.prepare('SELECT COUNT(*) AS n FROM note_index').get() as {n:number}).n,15);
});

test('freshness checks precede validation and cannot overwrite a remote change',async t=>{
  const f=await fixture(t),notes=new NoteService(f.vault,f.mutations);await f.vault.writeNote('Note.md','# Original');const before=await f.vault.readNote('Note.md');
  f.sync.ensureFreshForWrite=async()=>{await fs.writeFile(f.vault.resolve('Note.md'),'# Remote change');f.vault.notifyChanged(['Note.md']);};
  await assert.rejects(notes.update('Note.md',{content:'# My stale edit'},hashContent(before.content),'freshness-stale-edit'),e=>e instanceof DomainError&&e.code==='VERSION_CONFLICT');
  assert.equal((await f.vault.readNote('Note.md')).content,'# Remote change');
});

test('operation outcome is separate from completion and metrics contain no prompt bodies',async t=>{
  const f=await fixture(t),ledger=new RequestLedger(f.db);ledger.reserve(1,'chat','outcome-request','hash');ledger.finish(1,'chat','outcome-request',['Saved.md'],'partial','CANCELLED');
  assert.equal(ledger.inspect(1,'chat','outcome-request')!.outcome,'partial');assert.equal(ledger.inspect(1,'chat','outcome-request')!.state,'completed');
  let report:unknown;
  const llm=new LlmClient({baseUrl:'https://fixture.test',model:'fixture',apiKey:'SYNTHETIC_SECRET'},async()=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'SYNTHETIC_PRIVATE_RESPONSE'},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:3}})));
  await measureRun(async()=>{await measure('context',async()=>{});await llm.chat([{role:'user',content:'SYNTHETIC_PRIVATE_PROMPT'}]);return {outcome:'success'};},r=>{report=r;});
  assert(!JSON.stringify(report).includes('SYNTHETIC'));assert.equal((report as {providerCalls:number}).providerCalls,1);
});

test('chat returns before a blocked summary; clearing history fences the in-flight background result',async t=>{
  const f=await fixture(t);let summaryStarted!:()=>void,release!:()=>void,summaryCalls=0;
  const entered=new Promise<void>(r=>summaryStarted=r),blocked=new Promise<void>(r=>release=r);
  const upstream=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{void(async()=>{
    const body=JSON.parse(raw),summary=body.messages[0].content.includes('Составь краткое резюме');
    if(summary){summaryCalls++;summaryStarted();await blocked;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:summary?'{"summary":"old hidden history"}':'Ответ готов'},finish_reason:'stop'}]}));
  })();});});
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(upstream.address() as {port:number}).port;
  f.cfg.dataDir=f.root;f.cfg.dbPath=path.join(f.root,'relay.sqlite');f.cfg.providers.keyFile=path.join(f.root,'provider.key');f.cfg.providers.allowedOrigins=[origin];f.cfg.llm.apiKey='';f.cfg.llm.baseUrl=origin+'/v1';f.cfg.llm.model='fixture';f.cfg.staticDir=path.join(f.root,'no-static');f.cfg.scenariosFile=path.join(f.root,'no-scenarios.json');
  const paired=f.db.createDevice('stage fixture','app'),chat=f.db.chats.create(paired.device.id,'nonblocking-summary-entry','UTC');
  for(let i=0;i<14;i++)f.db.chats.add(paired.device.id,chat.id,i%2?'assistant':'user','previous '+i);
  const app=await createServer(f.cfg),headers={authorization:'Bearer '+paired.token};
  try{
    const response=await app.inject({method:'POST',url:'/api/chat',headers,payload:{chatId:chat.id,expectedVersion:chat.version,requestId:'nonblocking-summary-request',text:'Ответь',attachmentIds:[]}});
    assert.equal(response.json().text,'Ответ готов');assert.equal(response.json().outcome,'success');
    await Promise.race([entered,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Summary did not start')),2000).unref())]);
    const memory=await app.inject({method:'GET',url:'/api/chats/'+chat.id+'/memory',headers});assert.equal(memory.json().refresh.state,'queued');
    await app.inject({method:'DELETE',url:'/api/messages?chat='+chat.id,headers});release();
    await new Promise(r=>setTimeout(r,30));
    const cleared=await app.inject({method:'GET',url:'/api/chats/'+chat.id+'/memory',headers});assert.equal(cleared.json().summary,'');assert.equal(summaryCalls,1);
  }finally{release();await app.close();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
});

test('memory revisions retain compatibility with the previous four-column memory writer',async t=>{
  const f=await fixture(t),file=path.join(f.root,'rollback.chats.sqlite'),store=new ChatStore(file);
  const chat=store.create(1,'rollback-memory-entry','UTC'),memory=store.memory(1,chat.id);store.saveMemory(1,chat.id,memory);assert.equal(store.memoryRevision(1,chat.id),1);store.close();
  const raw=new DatabaseSync(file);
  try{raw.prepare('INSERT OR REPLACE INTO chat_memory VALUES(?,?,?,?)').run(1,chat.id,JSON.stringify({...memory,summary:'written by previous version'}),memory.expiresAt);assert.equal((raw.prepare('SELECT value_json FROM chat_memory').get() as {value_json:string}).value_json.includes('previous version'),true);}finally{raw.close();}
});
