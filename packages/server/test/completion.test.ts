import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import webpush from 'web-push';
import {randomBytes} from 'node:crypto';
import {Vault,LlmClient,defaultAutomationSettings,hashContent,validateAutomationSettings,type TaskCreateInput} from '@relay/core';
import {Db} from '../src/db.js';
import {loadConfig} from '../src/config.js';
import {GitSync} from '../src/sync.js';
import {VaultMutationService,hashBytes} from '../src/vault-mutations.js';
import {TaskService} from '../src/tasks.js';
import {NoteIndex} from '../src/note-index.js';
import {OrganizerService} from '../src/organizer.js';
import {ProviderRegistry} from '../src/providers.js';
import {AutomationSettingsService,Scheduler,scheduleInstant,type JobLease} from '../src/scheduler.js';
import {NotificationService,pushSubscription} from '../src/notifications.js';
import {WriterLock} from '../src/writer-lock.js';
import {WsTickets} from '../src/ws-tickets.js';
import {RequestLedger} from '../src/request-ledger.js';
import {ExtractionJobs} from '../src/extraction-jobs.js';
import {createServer} from '../src/index.js';
import {ProviderSecrets} from '../src/provider-secrets.js';
import {GitConflicts} from '../src/git-conflicts.js';
import {ChatModeService} from '../src/chat-modes.js';
import {NoteModeService} from '../src/note-mode.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
async function fixture(t:{after:(f:()=>Promise<void>)=>void}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-completion-')),cfg=loadConfig();cfg.dataDir=root;cfg.dbPath=path.join(root,'relay.sqlite');cfg.providers.keyFile=path.join(root,'secrets','key');cfg.vault.root=path.join(root,'vault');cfg.vault.privateFolders=['Private'];cfg.sync={...cfg.sync,mode:'none',remote:'',pullInterval:0};cfg.staticDir=path.join(root,'no');cfg.llm.apiKey='';cfg.providers.allowedOrigins=[];cfg.requireStandalone=false;
  await fs.mkdir(cfg.vault.root);const db=await Db.open(cfg.dbPath),vault=new Vault(cfg.vault),sync=new GitSync(cfg),mutations=new VaultMutationService(vault,db,sync),tasks=new TaskService(vault,mutations),index=new NoteIndex(vault,db),settings=new AutomationSettingsService(db);
  const cleanup:(()=>Promise<unknown>)[]=[];t.after(async()=>{for(const f of cleanup)await f();sync.stop();db.close();assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('relay-completion-'));await fs.rm(root,{recursive:true,force:true});});return {root,cfg,db,vault,sync,mutations,tasks,index,settings,cleanup};
}
const task:TaskCreateInput={title:'Отчёт',description:'Факт',category:'work',priority:'high',deadline:{kind:'by_date',date:'2026-10-04',timezone:'Europe/Moscow'},tags:[],keywords:['отчёт'],relatedNoteIds:[]};
test('schedule chooses first DST fold and the first existing minute of a gap',()=>{
  assert.equal(new Date(scheduleInstant('2026-11-01','01:30','America/New_York')).toISOString(),'2026-11-01T05:30:00.000Z');
  assert.equal(new Date(scheduleInstant('2026-03-08','02:30','America/New_York')).toISOString(),'2026-03-08T07:00:00.000Z');
  assert.throws(()=>validateAutomationSettings({...defaultAutomationSettings(),organizer:{...defaultAutomationSettings().organizer,enabled:true},digest:{...defaultAutomationSettings().digest,enabled:true,localTime:'23:59'}},defaultAutomationSettings(),0),/перед сортировкой/);
});
test('scheduler persists dedupe across settings changes, cancellation, restart and occurrence retry',async t=>{
  const f=await fixture(t);let now=Date.parse('2026-10-04T20:50:00Z'),calls=0;const settings=new AutomationSettingsService(f.db,()=>now),s=defaultAutomationSettings();s.digest.enabled=true;settings.save(s);f.db.setSetting('automation.settings',JSON.stringify({...settings.get(),changedAt:0}));
  const first=new Scheduler(f.db,settings,{weekly_digest:async lease=>{lease.assert();calls++;return {ok:true};}},()=>now);await first.tick();assert.equal(calls,1);
  const saved=settings.get();settings.save({...saved,digest:{...saved.digest,localTime:'23:49'}});await first.tick();assert.equal(calls,1);assert.equal(first.list().filter(j=>j.state==='succeeded').length,1);await first.stop();
  const restarted=new Scheduler(f.db,settings,{weekly_digest:async()=>{calls++;}},()=>now);await restarted.tick();assert.equal(calls,1);await restarted.stop();
});
test('fencing and changed settings block stale handlers before an effect',async t=>{
  const f=await fixture(t);const settings=f.settings;settings.save({...settings.get(),organizer:{...settings.get().organizer,enabled:true}});let release!:()=>void,started!:()=>void,effects=0;const running=new Promise<void>(r=>{started=r;}),block=new Promise<void>(r=>{release=r;});
  const scheduler=new Scheduler(f.db,settings,{organize:async lease=>{started();await block;lease.assert();effects++;}});scheduler.enqueue('organize','manual-fence',Date.now(),settings.get().version);const work=scheduler.tick();await running;settings.save({...settings.get(),organizer:{...settings.get().organizer,enabled:false}});release();await work;assert.equal(effects,0);assert.equal(scheduler.list().find(j=>j.dedupeKey==='manual-fence')!.state,'cancelled');await scheduler.stop();
});
test('writer lock rejects another process owner and releases only its own lock',async t=>{
  const f=await fixture(t),lock=await WriterLock.acquire(f.vault.root);await assert.rejects(WriterLock.acquire(f.vault.root),/другим сервером/);await lock.release();const next=await WriterLock.acquire(f.vault.root);await next.release();
});
test('WebSocket tickets are short-lived and single-use; tombstones retain no request content',async t=>{
  let now=1000;const tickets=new WsTickets(()=>now),a=tickets.issue(2);assert.equal(tickets.consume(a.ticket),2);assert.equal(tickets.consume(a.ticket),null);const b=tickets.issue(2);now=b.expiresAt;assert.equal(tickets.consume(b.ticket),null);
  const f=await fixture(t),ledger=new RequestLedger(f.db);ledger.reserve(1,'chat','request-1','abc');ledger.finish(1,'chat','request-1',['A.md']);assert.deepEqual(ledger.inspect(1,'chat','request-1','abc')!.artifacts,['A.md']);assert.throws(()=>ledger.inspect(1,'chat','request-1','other'),/другого сообщения/);
});
test('legacy conversion preserves text, completion and mandatory deadline, and replays once',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.vault.root,'Old.md'),'# old\n- [x] Исходный факт\n```md\n- [ ] example\n```');const old=(await f.tasks.legacy())[0];assert.equal((await f.tasks.legacy()).length,1);
  await assert.rejects(f.tasks.convertLegacy(old,{...task,deadline:undefined},'legacy-invalid'),/срок/);const a=await f.tasks.convertLegacy(old,task,'legacy-convert');assert.equal(a.task.status,'done');assert.match((await f.vault.readNote('Old.md')).content,/Исходный факт/);assert.equal((await f.tasks.legacy()).length,0);assert.equal((await f.tasks.convertLegacy(old,task,'legacy-convert')).task.id,a.task.id);
});
test('durable batch recovery finishes a move and deletion while preserving a later external edit',async t=>{
  const f=await fixture(t),bytes=Buffer.from('new');await fs.writeFile(path.join(f.vault.root,'Old.md'),'old');
  f.db.prepareBatch({operationId:'recover-move',requestHash:'hash',files:[{path:'New.md',baseHash:null,contentHash:hashBytes(bytes),base64:bytes.toString('base64')},{path:'Old.md',baseHash:hashContent('old'),contentHash:hashBytes(Buffer.alloc(0)),base64:null,delete:true}],result:{},state:'prepared',commitSha:null,errorCode:null});
  await f.mutations.recoverIncomplete();assert.equal(await fs.readFile(path.join(f.vault.root,'New.md'),'utf8'),'new');await assert.rejects(fs.stat(path.join(f.vault.root,'Old.md')));assert.equal(f.db.getBatch('recover-move')!.state,'saved_local');
});
test('organizer moves notes, repairs links, preserves YAML facts and does not reclassify unchanged output',async t=>{
  const f=await fixture(t);await fs.mkdir(path.join(f.vault.root,'Inbox'));await fs.writeFile(path.join(f.vault.root,'Inbox','Plan.md'),'---\ncustom: keep # comment\n---\n# Plan\nFact 123.\n[ref](Ref.md#part)');await fs.writeFile(path.join(f.vault.root,'Inbox','Ref.md'),'# Ref\n![[Inbox/Plan#^block|alias]]');let calls=0;
  const registry={bindOrganizer:()=>({profile:{capabilities:{structuredOutput:true}},release:()=>{},client:new LlmClient({baseUrl:'https://fixture.test',apiKey:'',model:'fixture'},async(_url,init)=>{calls++;const input=JSON.parse(JSON.parse(String(init?.body)).messages[1].content);return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify({patches:input.candidates.map((n:any)=>({path:n.path,baseHash:n.baseHash,...(n.path.endsWith('Plan.md')?{targetPath:'Areas/Work/Notes/Plan.md'}:{}),addTags:['work'],keywords:['plan'],relatedPaths:[],rationale:'organize'})),deferredPaths:[]})},finish_reason:'stop'}]}));})})} as unknown as ProviderRegistry;
  const organizer=new OrganizerService(f.vault,f.db,f.index,registry,f.sync,f.mutations,f.settings),p=await organizer.preview('plan-organize');await organizer.apply(p.plan.id,'apply-organize');
  const content=(await f.vault.readNote('Areas/Work/Notes/Plan.md')).content;assert.match(content,/custom: keep # comment/);assert.match(content,/Fact 123/);assert.match(content,/\.\.\/\.\.\/\.\.\/Inbox\/Ref.md#part/);assert.match((await f.vault.readNote('Inbox/Ref.md')).content,/Areas\/Work\/Notes\/Plan#\^block\|alias/);await organizer.preview('plan-again');assert.equal(calls,1);
});
test('organizer rejects concurrent edits before applying any planned change',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.vault.root,'A.md'),'# A');const registry={bindOrganizer:()=>({profile:{capabilities:{}},release:()=>{},client:new LlmClient({baseUrl:'https://fixture.test',apiKey:'',model:'fixture'},async(_u,init)=>{const n=JSON.parse(JSON.parse(String(init?.body)).messages[1].content).candidates[0];return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify({patches:[{path:n.path,baseHash:n.baseHash,addTags:['tag'],relatedPaths:[],rationale:'tags'}],deferredPaths:[]})},finish_reason:'stop'}]}));})})} as unknown as ProviderRegistry;
  const organizer=new OrganizerService(f.vault,f.db,f.index,registry,f.sync,f.mutations,f.settings),p=await organizer.preview('plan-conflict');await fs.writeFile(path.join(f.vault.root,'A.md'),'external');await assert.rejects(organizer.apply(p.plan.id,'apply-conflict'),/изменилась/);assert.equal((await f.vault.readNote('A.md')).content,'external');
});
test('weekly web digest excludes completed tasks, creates one feed item and never blindly retries unknown push',async t=>{
  const f=await fixture(t),now=Date.parse('2026-10-04T20:50:00Z'),settings=new AutomationSettingsService(f.db,()=>now);settings.save({...settings.get(),digest:{...settings.get().digest,enabled:true}});const saved=await f.tasks.create(task,'digest-task');let sends=0;
  const service=await NotificationService.open(f.db,f.cfg,settings,f.tasks,f.sync,async()=>{sends++;throw new Error('lost response');},()=>now);const device=f.db.createDevice('fixture','app').device;
  const keys=webpush.generateVAPIDKeys();service.subscribe(device.id,{endpoint:'https://fcm.googleapis.com/fcm/send/fixture',keys:{p256dh:keys.publicKey,auth:randomBytes(16).toString('base64url')}});
  const lease={job:{dedupeKey:'digest:2026-10-04',scheduledFor:now},payload:{localDate:'2026-10-04',scheduledAt:now},assert:()=>{},heartbeat:()=>{}} as unknown as JobLease;
  await service.digest(lease);await service.digest(lease);assert.equal(service.list(device.id).length,1);assert.equal(sends,1);assert.equal(service.status(device.id).deliveries[0].state,'unknown');assert.throws(()=>pushSubscription({endpoint:'https://localhost/a',keys:{}}),/сервер/);
  await f.tasks.update(saved.task.id,{status:'done'},saved.task.contentHash,'digest-done');const empty=await service.digest({...lease,job:{...lease.job,dedupeKey:'new-digest'}}) as {status:string};assert.equal(empty.status,'skipped_empty');
});
test('queued extraction persists originals and completes under the scheduler without model access',async t=>{
  const f=await fixture(t),device=f.db.createDevice('fixture','app').device,chat=f.db.chats.create(device.id,'extract-entry','Europe/Moscow'),jobs=new ExtractionJobs(f.db.chats),scheduler=new Scheduler(f.db,f.settings,{extract:lease=>jobs.run(lease)});
  const file=await jobs.enqueue(scheduler,device.id,chat.id,'full.txt',Buffer.from('whole '.repeat(15000)));assert.equal(file.processing,'queued');await scheduler.tick();const result=f.db.chats.attachment(device.id,chat.id,file.id);assert.equal(result.processing,'ready');assert.equal(result.text.length,90000);assert.equal(result.report!.status,'complete');await scheduler.stop();
});
test('HTTP retries after clearing history return durable artifacts instead of rerunning the model',async t=>{
  const f=await fixture(t),paired=f.db.createDevice('fixture','app'),app=await createServer(f.cfg);f.cleanup.push(()=>app.close());const headers={authorization:'Bearer '+paired.token};const chat=f.db.chats.create(paired.device.id,'ledger-entry','Europe/Moscow');
  const body={chatId:chat.id,requestId:'ledger-request',expectedVersion:chat.version,text:'/quick retained result',attachmentIds:[]};const first=await app.inject({method:'POST',url:'/api/chat',headers,payload:body});assert.equal(first.statusCode,200);await app.inject({method:'DELETE',url:'/api/messages?chat='+chat.id,headers});const replay=await app.inject({method:'POST',url:'/api/chat',headers,payload:body});assert.equal(replay.statusCode,410);assert.equal(replay.json().code,'REQUEST_EXPIRED');assert.equal((await f.vault.listNotes()).length,1);
});
test('multiple task creation validates the entire batch before writing and replays without duplicates',async t=>{
  const f=await fixture(t);await assert.rejects(f.tasks.createMany([task,{...task,deadline:null}],'many-invalid'),/срок/);assert.equal((await f.vault.listNotes()).length,0);
  const a=await f.tasks.createMany([task,{...task,title:'Вторая задача'}],'many-valid');assert.equal(a.length,2);assert.deepEqual((await f.tasks.createMany([task,{...task,title:'Вторая задача'}],'many-valid')).map(s=>s.task.id),a.map(s=>s.task.id));assert.equal((await f.tasks.list()).items.length,2);
});
test('AI multiple-task mode asks for missing deadlines then commits all tasks; update uses the existing hash',async t=>{
  const f=await fixture(t),device=f.db.createDevice('fixture','app').device;let chat=f.db.chats.create(device.id,'multiple-entry','Europe/Moscow');chat=f.db.chats.changeMode(device.id,chat.id,'task',chat.version);
  const modes=new ChatModeService(f.db.chats,f.tasks,new NoteModeService(f.vault,f.mutations),f.vault);let output:unknown={intent:'multiple',tasks:[{state:'needs_input',task:{...task,deadline:null}}]};
  const client=new LlmClient({baseUrl:'https://fixture.test',apiKey:'',model:'fixture'},async()=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify(output)},finish_reason:'stop'}]})));
  const input={device:device.id,chat,text:'Добавь отчёт и встречу',history:[],operationId:'multi-draft',signal:new AbortController().signal,onEvent:()=>{},llm:client,toolsEnabled:false,structuredOutput:true};await modes.run(input);assert.equal((await f.tasks.list()).items.length,0);chat=f.db.chats.get(device.id,chat.id);assert(chat.pendingTask?.tasks);
  output={intent:'multiple',tasks:[{state:'ready',deadlineEvidence:'до 4 октября',task:{...task,deadline:{kind:'by_date',date:'2026-10-04'}}},{state:'ready',deadlineEvidence:'до 4 октября',task:{...task,title:'Встреча',deadline:{kind:'by_date',date:'2026-10-04'}}}]};await modes.run({...input,chat,text:'Обе до 4 октября',operationId:'multi-commit'});assert.equal((await f.tasks.list()).items.length,2);assert.equal(f.db.chats.get(device.id,chat.id).pendingTask,null);
  const saved=(await f.tasks.list()).items.find(t=>t.title===task.title)!;output={intent:'update',targetId:saved.id,patch:{status:'done'},deadlineEvidence:null};await modes.run({...input,chat:f.db.chats.get(device.id,chat.id),text:'Отметь Отчёт выполненным',operationId:'multi-update'});assert.equal((await f.tasks.get(saved.id)).status,'done');
});
test('master-key rotation reencrypts provider and VAPID records while preserving recoverable key-ring semantics',async t=>{
  const f=await fixture(t),old=await ProviderSecrets.open(f.cfg),secret=old.encrypt('fixture-only-key','fixture',1);f.db.saveProvider('fixture','chat',1,'{}',secret);f.db.setSetting('push.vapid',old.encrypt('fixture-vapid','push-vapid',1));
  assert.equal((await ProviderSecrets.rotate(f.cfg,f.db)).rotated,2);const current=await ProviderSecrets.open(f.cfg,false),row=f.db.providerRows()[0];assert.equal(current.decrypt(row.secret!,'fixture',1),'fixture-only-key');assert.equal(current.decrypt(f.db.getSetting('push.vapid')!,'push-vapid',1),'fixture-vapid');assert.throws(()=>old.decrypt(row.secret!,'fixture',1),/расшифровать/);assert.deepEqual(JSON.parse(await fs.readFile(f.cfg.providers.keyFile,'utf8')).previous,[]);
});
test('real Git conflict editor refuses a stale hash and completes an explicitly reviewed merge',async t=>{
  const f=await fixture(t);f.cfg.sync.mode='git';f.cfg.sync.branch='main';await f.sync.start(false);const git=(...args:string[])=>execute('git',args,{cwd:f.vault.root,env:{...process.env,GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@localhost',GIT_COMMITTER_NAME:'fixture',GIT_COMMITTER_EMAIL:'fixture@localhost'}});
  await fs.writeFile(path.join(f.vault.root,'Conflict.md'),'base\n');await git('add','Conflict.md');await git('commit','-m','base');await git('checkout','-b','other');await fs.writeFile(path.join(f.vault.root,'Conflict.md'),'other\n');await git('commit','-am','other');await git('checkout','main');await fs.writeFile(path.join(f.vault.root,'Conflict.md'),'main\n');await git('commit','-am','main');await assert.rejects(git('merge','other'));
  const service=new GitConflicts(f.vault,f.db,f.sync),doc=await service.get('Conflict.md');assert.equal(doc.base,'base\n');assert.equal(doc.ours,'main\n');assert.equal(doc.theirs,'other\n');await assert.rejects(service.resolve(doc.path,hashContent('stale'),'joined\n','conflict-stale'),/изменилась/);
  await service.resolve(doc.path,doc.contentHash,'joined\n','conflict-good');await service.resolve(doc.path,doc.contentHash,'joined\n','conflict-good');const listed=await service.list();assert.equal(listed.paths.length,0);await assert.rejects(service.complete([]),/изменился/);await service.complete(listed.mergePaths);await f.sync.assertWritable();assert.equal((await f.vault.readNote('Conflict.md')).content,'joined\n');await assert.rejects(service.complete([]),/слияния/);
});
test('chat provider binding prevents deletion and stale mode updates; queued extraction recovers an orphaned upload',async t=>{
  const f=await fixture(t),device=f.db.createDevice('fixture','app').device,chat=f.db.chats.create(device.id,'binding-entry','Europe/Moscow');const next=f.db.chats.bindProvider(device.id,chat.id,'provider-pinned',chat.version);assert.equal(next.providerId,'provider-pinned');assert(f.db.chats.usesProvider('provider-pinned'));assert.throws(()=>f.db.chats.changeMode(device.id,chat.id,'task',chat.version),/изменился/);
  const upload=f.db.chats.putAttachment(device.id,chat.id,'orphan.txt','text/plain','text',Buffer.from('restore me'),'');f.db.chats.extractionState(device.id,chat.id,upload.id,'queued');const extraction=new ExtractionJobs(f.db.chats),scheduler=new Scheduler(f.db,f.settings,{extract:lease=>extraction.run(lease)});extraction.recover(scheduler);await scheduler.tick();assert.equal(f.db.chats.attachment(device.id,chat.id,upload.id).text,'restore me');await scheduler.stop();
});
test('organizer publishes to a real bare remote and stores the produced commit as its checkpoint',async t=>{
  const f=await fixture(t),remote=path.join(f.root,'remote.git');await execute('git',['init','--bare',remote]);f.cfg.sync={...f.cfg.sync,mode:'git',remote,branch:'main',pushDebounce:3600};await f.sync.start(false);await fs.writeFile(path.join(f.vault.root,'Source.md'),'# Source\nPreserved fact.');await f.sync.snapshot();await f.sync.push();
  const registry={bindOrganizer:()=>({profile:{id:'fixture-organizer',version:1,capabilities:{}},release:()=>{},client:new LlmClient({baseUrl:'https://fixture.test',apiKey:'',model:'fixture'},async(_u,init)=>{const n=JSON.parse(JSON.parse(String(init?.body)).messages[1].content).candidates[0];return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify({patches:[{path:n.path,baseHash:n.baseHash,addTags:['checked'],relatedPaths:[],rationale:'tags'}],deferredPaths:[]})},finish_reason:'stop'}]}));})})} as unknown as ProviderRegistry;
  const organizer=new OrganizerService(f.vault,f.db,f.index,registry,f.sync,f.mutations,f.settings),p=await organizer.preview('remote-plan'),result=await organizer.apply(p.plan.id,'remote-apply') as {resultCommit:string};assert.equal(f.db.getBatch('remote-apply')!.state,'synced');assert.equal(organizer.checkpoint().head,result.resultCommit);assert.equal((await execute('git',['--git-dir',remote,'rev-parse','refs/heads/main'])).stdout.trim(),result.resultCommit);
  const original=p.plan.inputHead!;await execute('git',['reset','--hard',original],{cwd:f.vault.root});await assert.rejects(f.sync.changedPaths(result.resultCommit,original),/История Git/);organizer.reconcile();assert.equal(organizer.checkpoint().head,null);
});
test('relative deadline validation uses the time of the latest clarification and never silently shifts a date',async t=>{
  const f=await fixture(t),device=f.db.createDevice('fixture','app').device;let chat=f.db.chats.create(device.id,'relative-entry','Europe/Moscow');chat=f.db.chats.changeMode(device.id,chat.id,'task',chat.version);const modes=new ChatModeService(f.db.chats,f.tasks,new NoteModeService(f.vault,f.mutations),f.vault);let date='2026-10-06';const client=new LlmClient({baseUrl:'https://fixture.test',apiKey:'',model:'fixture'},async()=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify({state:'ready',question:'',deadlineEvidence:'до завтра',task:{...task,deadline:{kind:'by_date',date}}})},finish_reason:'stop'}]})));
  const input={device:device.id,chat,text:'Отчёт до завтра',history:[],referenceInstant:'2026-10-06T07:00:00Z',operationId:'relative-bad',signal:new AbortController().signal,onEvent:()=>{},llm:client,toolsEnabled:false,structuredOutput:true};await modes.run(input);assert.equal((await f.tasks.list()).items.length,0);date='2026-10-07';await modes.run({...input,chat:f.db.chats.get(device.id,chat.id),operationId:'relative-good'});assert.equal((await f.tasks.list()).items[0].deadline.kind,'by_date');const deadline=(await f.tasks.list()).items[0].deadline;assert.equal(deadline.kind==='by_date'?deadline.date:null,'2026-10-07');
});
test('vault reads wait for an entire batch while nested coordinator operations remain deadlock-free',async t=>{
  const f=await fixture(t);f.vault.setReadGuard(work=>f.sync.exclusive(work));await fs.writeFile(path.join(f.vault.root,'Read.md'),'before');let release!:()=>void,started!:()=>void;const waiting=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{started=r;});
  const writing=f.sync.exclusive(async()=>{await fs.writeFile(path.join(f.vault.root,'Read.md'),'partial');await f.sync.exclusive(async()=>{});started();await waiting;await fs.writeFile(path.join(f.vault.root,'Read.md'),'after');});await ready;const reading=f.vault.readNote('Read.md');release();await writing;assert.equal((await reading).content,'after');
});
test('WebSocket uses single-use tickets with correlated events; chat CRUD keeps saved notes and tombstones',async t=>{
  const f=await fixture(t),paired=f.db.createDevice('fixture','app'),app=await createServer(f.cfg);f.cleanup.push(()=>app.close());await app.ready();const headers={authorization:'Bearer '+paired.token};
  const c=(await app.inject({method:'POST',url:'/api/chats',headers,payload:{entryId:'ws-completion-entry',timezone:'UTC'}})).json();const ticket=(await app.inject({method:'POST',url:'/api/ws-ticket',headers,payload:{}})).json().ticket;
  const events:any[]=[];let resolve!: (v:any)=>void;const result=new Promise<any>(r=>{resolve=r;});const ws=await app.injectWS('/api/ws?ticket='+ticket,{headers:{origin:new URL(f.cfg.publicUrl).origin}},{onInit:socket=>socket.on('message',raw=>{const event=JSON.parse(raw.toString());events.push(event);if(event.type==='result')resolve(event);})});
  ws.send(JSON.stringify({type:'message',chatId:c.id,requestId:'ws-completion-request',expectedVersion:c.version,text:'/quick Fixture websocket note',attachmentIds:[]}));let timer:NodeJS.Timeout;const received=await Promise.race([result,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('WebSocket result timed out')),5000);})]).finally(()=>clearTimeout(timer));assert.equal(received.chatId,c.id);assert.equal(received.requestId,'ws-completion-request');const sequences=events.filter(e=>e.requestId==='ws-completion-request').map(e=>e.sequence);assert(sequences.length>0&&sequences.every((n,i)=>i===0||n>sequences[i-1]));ws.terminate();
  const denied=new Promise<string>(resolve=>{void app.injectWS('/api/ws?ticket='+ticket,{}, {onInit:socket=>socket.once('message',raw=>{resolve(JSON.parse(raw.toString()).text);socket.terminate();})});});assert.equal(await denied,'unauthorized');
  const renamed=(await app.inject({method:'PATCH',url:'/api/chats/'+c.id,headers,payload:{title:'Renamed fixture',expectedVersion:c.version}})).json();assert.equal(renamed.title,'Renamed fixture');assert.equal((await app.inject({method:'DELETE',url:'/api/chats/'+c.id,headers,payload:{expectedVersion:c.version}})).statusCode,409);assert.equal((await app.inject({method:'DELETE',url:'/api/chats/'+c.id,headers,payload:{expectedVersion:renamed.version}})).statusCode,200);assert.equal((await f.vault.listNotes()).length,1);
  assert.equal((await app.inject({method:'POST',url:'/api/chat',headers,payload:{chatId:c.id,requestId:'ws-completion-request',expectedVersion:c.version,text:'/quick Fixture websocket note',attachmentIds:[]}})).statusCode,410);
});
