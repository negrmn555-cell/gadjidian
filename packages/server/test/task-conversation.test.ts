import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { Vault, LlmClient, hashContent, type ChatMessage, type Deadline, type TaskCreateInput } from '@relay/core';
import { Db } from '../src/db.js';
import { ChatStore } from '../src/chat-store.js';
import { loadConfig } from '../src/config.js';
import { GitSync } from '../src/sync.js';
import { VaultMutationService, fingerprint } from '../src/vault-mutations.js';
import { RequestLedger } from '../src/request-ledger.js';
import { TaskService } from '../src/tasks.js';
import { NoteModeService } from '../src/note-mode.js';
import { ChatModeService, type ModeRunInput } from '../src/chat-modes.js';
import { createServer } from '../src/index.js';
import { localDeadline, seriesDeadlines, seriesOccurrence, shiftDeadline } from '../src/task-schedule.js';

const title='Сдать ДЗ в поступашки';
const request='Расставь дедлайн по сдаче ДЗ в поступашки начиная с субботы 24 октября 23:59. Будет 6 дедлайнов каждую субботу';
const modelTask={title,description:'Учебное ДЗ',category:'study',priority:'medium',keywords:['ДЗ','поступашки'],tags:[],relatedNoteIds:[],deadline:{kind:'by_time',date:'2026-10-24',time:'23:59'}};
const create=(task=modelTask,evidence='24 октября 23:59')=>({intent:'create',tasks:[{task,deadlineEvidence:evidence}]});
const series={intent:'series',task:modelTask,schedule:{frequency:'weekly',interval:1},count:6,includeStart:true,deadlineEvidence:'24 октября 23:59',recurrenceEvidence:'6 дедлайнов каждую субботу'};
const anchor:Deadline={kind:'by_time',at:'2026-10-24T20:59:00.000Z',timezone:'Europe/Moscow'};
const stored:TaskCreateInput={...modelTask,category:'study',priority:'medium',deadline:anchor};
const dates=(items:{deadline:Deadline}[])=>items.map(t=>localDeadline(t.deadline).date).sort();

async function fixture(t:{after:(fn:()=>Promise<void>)=>void}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-task-dialog-')),cfg=loadConfig();
  cfg.dataDir=root;cfg.dbPath=path.join(root,'relay.sqlite');cfg.vault.root=path.join(root,'vault');cfg.staticDir=path.join(root,'no-static');cfg.scenariosFile=path.join(root,'no-scenarios');cfg.requireStandalone=false;
  cfg.llm.apiKey='';cfg.providers={...cfg.providers,masterKey:Buffer.alloc(32,9).toString('base64'),keyFile:path.join(root,'key'),allowedOrigins:[]};cfg.sync={...cfg.sync,mode:'none',remote:'',pullInterval:0};if(cfg.diagnostics)cfg.diagnostics.enabled=false;
  await fs.mkdir(cfg.vault.root);
  const db=await Db.open(cfg.dbPath),vault=new Vault(cfg.vault),sync=new GitSync(cfg);await sync.start(false);
  const mutations=new VaultMutationService(vault,db,sync),tasks=new TaskService(vault,mutations);vault.setWriteBackend(mutations);
  const modes=new ChatModeService(db.chats,tasks,new NoteModeService(vault,mutations),vault);
  let chat=db.chats.create(1,'task-conversation','Europe/Moscow');chat=db.chats.changeMode(1,chat.id,'task',chat.version);
  const cleanup:(()=>Promise<unknown>)[]=[];
  t.after(async()=>{for(const fn of cleanup)await fn();sync.stop();db.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith('relay-task-dialog-'));await fs.rm(root,{recursive:true,force:true});});
  let count=0;
  const calls:ChatMessage[][]=[];
  const run=async(text:string,output:unknown,overrides:Partial<ModeRunInput>={})=>{
    const llm=new LlmClient({baseUrl:'https://fixture.test',model:'fixture',apiKey:''},async(_url,init)=>{
      calls.push(JSON.parse(String(init?.body)).messages);
      const content=typeof output==='function'?output():output;
      return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:typeof content==='string'?content:JSON.stringify(content)},finish_reason:'stop'}]}));
    });
    return modes.run({device:1,chat:db.chats.get(1,chat.id),text,history:[],operationId:'dialog_'+(++count)+'_operation',referenceInstant:'2026-10-22T12:00:00Z',signal:new AbortController().signal,onEvent(){},llm,toolsEnabled:false,structuredOutput:true,...overrides});
  };
  return {root,cfg,db,vault,tasks,mutations,sync,chat,run,calls,cleanup};
}

test('calendar series preserves local time, weekdays, inclusion, until and calendar anchors',()=>{
  assert.deepEqual(dates(seriesDeadlines(anchor,{frequency:'weekly',interval:1},{count:6})),['2026-10-24','2026-10-31','2026-11-07','2026-11-14','2026-11-21','2026-11-28']);
  assert(seriesDeadlines(anchor,{frequency:'weekly',interval:1},{count:6}).every(d=>localDeadline(d.deadline).time==='23:59'));
  assert.deepEqual(dates(seriesDeadlines(anchor,{frequency:'weekly',interval:1},{until:'2026-11-07',startIndex:1})),['2026-10-31','2026-11-07']);
  const date=(date:string):Deadline=>({kind:'by_date',date,timezone:'Europe/Moscow'});
  assert.deepEqual(dates(seriesDeadlines(date('2027-01-31'),{frequency:'monthly',interval:1},{count:4})),['2027-01-31','2027-02-28','2027-03-31','2027-04-30']);
  assert.equal(localDeadline(seriesOccurrence(date('2024-02-29'),{frequency:'yearly',interval:1},4)).date,'2028-02-29');
  assert.deepEqual(dates(seriesDeadlines(date('2026-10-23'),{frequency:'weekly',interval:1,weekdays:[1,2,3,4,5]},{count:4})),['2026-10-23','2026-10-26','2026-10-27','2026-10-28']);
  assert.deepEqual(dates(seriesDeadlines(date('2026-10-26'),{frequency:'weekly',interval:2,weekdays:[1,5]},{count:4})),['2026-10-26','2026-10-30','2026-11-09','2026-11-13']);
  for(const options of [{count:0},{count:101},{count:6,until:'2026-11-28'},{until:'2026-10-23'},{}])assert.throws(()=>seriesDeadlines(anchor,{frequency:'weekly',interval:1},options));
  assert.throws(()=>seriesDeadlines(date('2026-01-01'),{frequency:'daily',interval:1},{until:'2026-12-31'}),/100/);
  const ny:Deadline={kind:'by_time',at:'2026-03-07T14:00:00Z',timezone:'America/New_York'};
  const shifted=shiftDeadline(ny,'day',1);assert.equal(localDeadline(shifted).time,'09:00');assert.equal('at'in shifted?shifted.at:null,'2026-03-08T13:00:00.000Z');
  const beforeGap:Deadline={kind:'by_time',at:'2026-03-28T01:30:00.000Z',timezone:'Europe/Berlin'};
  assert.equal(seriesDeadlines(beforeGap,{frequency:'daily',interval:1},{until:'2026-03-28'}).length,1);
  assert.throws(()=>seriesDeadlines(beforeGap,{frequency:'daily',interval:1},{until:'2026-03-29'}),/нет/);
});

test('six weekly deadlines are persisted with series metadata and an explicit verified result',async t=>{
  const f=await fixture(t),result=await f.run(request,series),items=(await f.tasks.list()).items;
  assert.equal(result.actions.length,6);assert.equal(items.length,6);assert.match(result.text,/Создано задач в серии: 6/);
  for(const date of ['24.10.2026','31.10.2026','07.11.2026','14.11.2026','21.11.2026','28.11.2026'])assert(result.text.includes(date));
  assert.equal(result.text.match(/23:59/g)?.length,6);assert.match(result.text,/Сохранено локально/);
  assert.equal(new Set(items.map(t=>t.series!.id)).size,1);assert.deepEqual(items.map(t=>t.series!.index).sort(),[0,1,2,3,4,5]);
  assert.match((await f.vault.readNote(items[0].path)).content,/task_series:/);
  assert.equal(f.db.chats.get(1,f.chat.id).pendingTask,null);
  const reopened=new ChatStore(path.join(f.root,'relay.chats.sqlite'));try{assert.equal(reopened.get(1,f.chat.id).taskContext?.recentTaskIds.length,6);}finally{reopened.close();}
  const repeated=await f.run(request,series);assert.equal(repeated.actions.length,0);assert.match(repeated.text,/Создано задач в серии: 0\. Уже существуют: 6/);assert.equal((await f.tasks.list()).items.length,6);
});

test('a single saved task gains six additional Saturdays and becomes a durable series',async t=>{
  const f=await fixture(t);await f.run('Дедлайн поступашки 24 октября 23:59',create());
  const original=(await f.tasks.list()).items[0];
  const result=await f.run('Расставь такие же на каждую субботу следующих 6 недель. Нужно ещё 6 дедлайнов',{intent:'extend',target:{kind:'last'},schedule:{frequency:'weekly',interval:1},count:6,recurrenceEvidence:'Нужно ещё 6 дедлайнов'});
  const items=(await f.tasks.list()).items;
  assert.equal(items.length,7);assert.equal(result.actions.filter(a=>a.kind==='created').length,6);assert.match(result.text,/Создано дополнительных задач: 6/);
  assert.deepEqual(dates(items),['2026-10-24','2026-10-31','2026-11-07','2026-11-14','2026-11-21','2026-11-28','2026-12-05']);
  assert(items.every(t=>localDeadline(t.deadline).time==='23:59'));assert.equal((await f.tasks.get(original.id)).series?.index,0);
  assert.equal(new Set(items.map(t=>t.series!.id)).size,1);
  const more=await f.run('Ещё 2',{intent:'extend',target:{kind:'series'},count:2,recurrenceEvidence:'Ещё 2'});
  assert.match(more.text,/12.12.2026/);assert.match(more.text,/19.12.2026/);assert.equal((await f.tasks.list()).items.length,9);
});

test('draft retains known deadlines, original user evidence and the full pending operation',async t=>{
  const f=await fixture(t),first='Отчёт 24 октября 23:59 и встреча без срока';
  const partial={intent:'create',tasks:[{task:modelTask,deadlineEvidence:'24 октября 23:59'},{task:{...modelTask,title:'Встреча',deadline:null},deadlineEvidence:null}]};
  const question=await f.run(first,partial);assert.equal(question.actions.length,0);assert.equal((await f.tasks.list()).items.length,0);
  const pending=f.db.chats.get(1,f.chat.id).pendingTask!;assert(pending.tasks![0].deadline);assert.equal(pending.operation?.intent,'create');assert.equal(pending.userSources?.[0].text,first);
  const ready=await f.run('Встреча тоже 24 октября 23:59',{...partial,tasks:[partial.tasks[0],{task:{...modelTask,title:'Встреча'},deadlineEvidence:'24 октября 23:59'}]});
  assert.equal(ready.actions.length,2);assert.equal((await f.tasks.list()).items.length,2);
  const f2=f.db.chats.create(1,'isolated-dialog','Europe/Moscow');assert.equal(f2.taskContext,undefined);
  const unknown=await f.run('Перенеси её на неделю',{intent:'shift',target:{kind:'last'},unit:'week',amount:1,evidence:'на неделю'},{chat:f.db.chats.changeMode(1,f2.id,'task',f2.version)});
  assert.equal(unknown.actions.length,0);assert.match(unknown.text,/Какую задачу/);
});

test('series clarification keeps the original relative date even without the old history window',async t=>{
  const f=await fixture(t),text='ДЗ завтра 23:59 каждую неделю';
  const output={...series,count:undefined,task:{...modelTask,deadline:{kind:'by_time',date:'2026-10-23',time:'23:59'}},deadlineEvidence:'завтра 23:59',recurrenceEvidence:'каждую неделю'};
  const first=await f.run(text,output);assert.match(first.text,/Сколько повторений/);assert.equal((await f.tasks.list()).items.length,0);
  const ready=await f.run('Всего 3',{...output,count:3},{referenceInstant:'2026-10-24T12:00:00Z'});
  assert.equal(ready.actions.length,3);assert.equal(dates((await f.tasks.list()).items)[0],'2026-10-23');
});

test('last, numbered results, batch edits, status transitions and active queries use saved IDs',async t=>{
  const f=await fixture(t);await f.run(request,series);
  const initial=f.db.chats.get(1,f.chat.id).taskContext!.recentTaskIds;
  const second=await f.tasks.get(initial[1]);
  const batch=await f.run('Первую заверши, вторую назови Проверить ДЗ',{intent:'update_many',updates:[{target:{kind:'recent',index:1},patch:{status:'done'}},{target:{kind:'recent',index:2},patch:{title:'Проверить ДЗ',priority:'high'}}]});
  assert.equal(batch.actions.length,2);assert.equal((await f.tasks.get(initial[0])).status,'done');assert((await f.tasks.get(initial[0])).completedAt);
  const edited=await f.tasks.get(second.id);assert.match(edited.title,/Проверить ДЗ/);assert.equal(edited.description,second.description);assert.deepEqual(edited.deadline,second.deadline);assert.equal(edited.category,'study');
  await f.run('Верни последнюю в работу',{intent:'update',target:{kind:'last'},patch:{status:'in_progress'}});
  const listed=await f.run('Покажи незавершённые в октябре',{intent:'list',filter:{active:true,from:'2026-10-01',to:'2026-10-31'}});
  assert.match(listed.text,/Найдено задач: 1/);assert.match(listed.text,/В работе/);assert.equal(listed.actions.length,0);
  await f.run('Отмени все оставшиеся в серии',{intent:'update',target:{kind:'series',taskId:initial[0],scope:'pending'},patch:{status:'cancelled'}});
  assert.equal((await f.tasks.get(initial[0])).status,'done');assert.equal((await f.tasks.list()).items.filter(t=>t.status==='cancelled').length,5);
  await f.run('Верни первую задачу',{intent:'update',target:{kind:'id',id:initial[0]},patch:{status:'todo'}},{userText:initial[0]});
  assert.equal((await f.tasks.get(initial[0])).completedAt,null);
});

test('whole-series shift keeps its rule coherent for later continuation; individual move is an exception',async t=>{
  const f=await fixture(t);await f.run(request,series);
  const moved=await f.run('Всю серию на неделю позже',{intent:'shift',target:{kind:'series'},unit:'week',amount:1,evidence:'на неделю позже'});
  assert.equal(moved.actions.length,6);assert.equal(dates((await f.tasks.list()).items)[0],'2026-10-31');
  const extended=await f.run('Добавь ещё 1',{intent:'extend',target:{kind:'series'},count:1,recurrenceEvidence:'ещё 1'});
  assert.match(extended.text,/12.12.2026/);
  const last=f.db.chats.get(1,f.chat.id).taskContext!.recentTaskIds[0];
  await f.run('Её на 15 декабря 18:00',{intent:'update',target:{kind:'last'},patch:{deadline:{kind:'by_time',date:'2026-12-15',time:'18:00'}},deadlineEvidence:'15 декабря 18:00'});
  assert.deepEqual(localDeadline((await f.tasks.get(last)).deadline),{date:'2026-12-15',time:'18:00'});
  const next=await f.run('Ещё 1',{intent:'extend',target:{kind:'series'},count:1,recurrenceEvidence:'Ещё 1'});
  assert.match(next.text,/19.12.2026 в 23:59/);
});

test('duplicate inherits the deadline, resets status and leaves series membership behind',async t=>{
  const f=await fixture(t);await f.run(request,series);
  await f.run('Последнюю заверши',{intent:'update',target:{kind:'last'},patch:{status:'done'}});
  const result=await f.run('Скопируй её',{intent:'duplicate',target:{kind:'last'}});
  assert.equal(result.actions.length,1);
  const copy=await f.tasks.get(f.db.chats.get(1,f.chat.id).taskContext!.recentTaskIds[0]);
  assert.equal(copy.status,'todo');assert.equal(copy.series,undefined);assert.equal(localDeadline(copy.deadline).date,'2026-11-28');
});

test('ambiguous matches and missing references ask a concrete question without changing tasks',async t=>{
  const f=await fixture(t);await f.run(request,series);
  const before=(await f.tasks.list()).items.map(t=>t.contentHash).sort();
  const answer=await f.run('Заверши ДЗ',{intent:'update',target:{kind:'match',title},patch:{status:'done'}});
  assert.equal(answer.actions.length,0);assert.match(answer.text,/несколько задач/);assert.match(answer.text,/24.10.2026/);
  assert.deepEqual((await f.tasks.list()).items.map(t=>t.contentHash).sort(),before);
  const missing=await f.run('Заверши задачу',{intent:'update',target:{kind:'id',id:'missing'},patch:{status:'done'}});assert.match(missing.text,/Не нашёл/);
});

test('invalid model output gets one repair attempt and a readable failure with zero writes',async t=>{
  const f=await fixture(t);let attempts=0;
  const result=await f.run('ДЗ 24 октября 23:59',()=>++attempts===1?'{"intent":"create","tasks":[null]}':create());
  assert.equal(attempts,2);assert.equal(result.actions.length,1);
  const before=(await f.tasks.list()).items.length,calls=f.calls.length;
  const failed=await f.run('Ещё задачи','{"intent":"nonsense"}');
  assert.equal(f.calls.length-calls,2);assert.equal(failed.outcome,'failed');assert.equal(failed.error?.code,'TASK_MODEL_OUTPUT_INVALID');assert.match(failed.text,/Ничего не записано/);assert.doesNotMatch(failed.text,/Ожидается объект|VALIDATION_ERROR/);assert.equal((await f.tasks.list()).items.length,before);
});

test('DST gaps and batch version conflicts never leave a partly edited task set',async t=>{
  const f=await fixture(t);
  const berlin=f.db.chats.create(1,'berlin-task-dialog','Europe/Berlin'),chat=f.db.chats.changeMode(1,berlin.id,'task',berlin.version);
  const bad=await f.run('Каждый день с 28 марта 2026 02:30 всего 3',{...series,task:{...modelTask,deadline:{kind:'by_time',date:'2026-03-28',time:'02:30'}},schedule:{frequency:'daily',interval:1},count:3,deadlineEvidence:'28 марта 2026 02:30',recurrenceEvidence:'Каждый день'},{chat});
  assert.equal(bad.actions.length,0);assert.equal((await f.tasks.list()).items.length,0);assert.match(bad.text,/нет/);
  const saved=await f.tasks.createMany([stored,{...stored,title:'Вторая'}],'atomic-batch-create');
  await f.tasks.update(saved[1].task.id,{priority:'low'},saved[1].task.contentHash,'atomic-external-edit');
  await assert.rejects(f.tasks.updateMany(saved.map(s=>({id:s.task.id,expectedHash:s.task.contentHash,patch:{status:'done'}})),'atomic-batch-update'),/изменилась/);
  assert.equal((await f.tasks.get(saved[0].task.id)).status,'todo');assert.equal((await f.tasks.get(saved[1].task.id)).status,'todo');
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(f.run('ДЗ 24 октября 23:59',create(),{signal:cancelled.signal}),/отменён/);
});

test('context migration reads old saved actions and clearing a chat clears references without deleting tasks',async t=>{
  const f=await fixture(t),saved=await f.tasks.create(stored,'before-context-migration');
  f.db.chats.add(1,f.chat.id,'assistant','Задача добавлена',{actions:[{path:saved.task.path,kind:'created'}]});
  const answer=await f.run('Её заверши',{intent:'update',target:{kind:'last'},patch:{status:'done'}});
  assert.equal(answer.actions.length,1);assert.equal((await f.tasks.get(saved.task.id)).status,'done');
  f.db.chats.clear(1,f.chat.id);assert.equal(f.db.chats.get(1,f.chat.id).taskContext,undefined);assert.equal((await f.tasks.list()).items.length,1);
});

test('HTTP task dialogue passes previous messages after a save and replays extension without duplicates',async t=>{
  const f=await fixture(t),requests:{messages:ChatMessage[]}[]=[];
  let output:unknown=create();
  const api=http.createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify(output)},finish_reason:'stop'}]}));
  });
  await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(api.address() as {port:number}).port;
  f.cfg.providers.allowedOrigins=[origin];f.cfg.llm.baseUrl=origin+'/v1';f.cfg.llm.model='fixture';
  const app=await createServer(f.cfg);f.cleanup.push(async()=>{await app.close();await new Promise<void>(resolve=>api.close(()=>resolve()));});
  const paired=f.db.createDevice('task-dialog','app'),headers={authorization:'Bearer '+paired.token};
  let chat=f.db.chats.create(paired.device.id,'http-task-dialog','Europe/Moscow');chat=f.db.chats.changeMode(paired.device.id,chat.id,'task',chat.version);
  const first={chatId:chat.id,requestId:'http-task-dialog-first',expectedVersion:chat.version,text:'ДЗ 24 октября 23:59',attachmentIds:[]};
  const saved=await app.inject({method:'POST',url:'/api/chat',headers,payload:first});assert.equal(saved.statusCode,200);assert.equal(saved.json().actions.length,1);assert.equal(saved.json().chat.pendingTask,null);
  output={intent:'extend',target:{kind:'last'},schedule:{frequency:'weekly',interval:1},count:6,recurrenceEvidence:'ещё 6 каждую субботу'};
  const second={...first,requestId:'http-task-dialog-second',text:'Такие же ещё 6 каждую субботу'};
  const extended=await app.inject({method:'POST',url:'/api/chat',headers,payload:second});assert.equal(extended.statusCode,200);assert.match(extended.json().text,/Создано дополнительных задач: 6/);
  assert(requests[1].messages.some(m=>m.role==='user'&&m.content===first.text));assert(requests[1].messages.some(m=>m.role==='assistant'&&m.content?.includes('Создано задач: 1')));
  assert(requests[1].messages[0].content?.includes(saved.json().chat.taskContext.recentTaskIds[0]));
  const replay=await app.inject({method:'POST',url:'/api/chat',headers,payload:second});assert.equal(replay.statusCode,200);assert.equal(requests.length,2);assert.deepEqual(replay.json().actions,extended.json().actions);assert.equal((await f.tasks.list()).items.length,7);
});

test('existing ordinary occurrences are linked into one series with correct per-file receipts',async t=>{
  const f=await fixture(t),values=seriesDeadlines(anchor,{frequency:'weekly',interval:1},{count:6}).map(({deadline})=>({...stored,deadline}));
  await f.tasks.createMany(values,'plain-existing-series');
  const result=await f.run(request,series),items=(await f.tasks.list()).items;
  assert.equal(result.actions.filter(a=>a.kind==='created').length,0);assert.equal(result.actions.filter(a=>a.kind==='updated').length,6);assert.equal(items.length,6);
  assert.equal(new Set(items.map(t=>t.series?.id)).size,1);assert(items.every(t=>t.series));assert.equal(new Set(result.receipts?.map(r=>r.path)).size,6);
  for(const receipt of result.receipts??[])assert.equal(receipt.contentHash,items.find(t=>t.path===receipt.path)!.contentHash);
  const more=await f.run('Ещё 1',{intent:'extend',target:{kind:'series'},count:1,recurrenceEvidence:'Ещё 1'});assert.match(more.text,/05.12.2026 в 23:59/);
});

test('explicit time cannot be silently dropped and unrelated old deadlines cannot enter a new draft',async t=>{
  const f=await fixture(t);
  const missingTime=await f.run('ДЗ 24 октября 23:59',create({...modelTask,deadline:{kind:'by_date',date:'2026-10-24'} as typeof modelTask.deadline},'24 октября'));
  assert.equal(missingTime.actions.length,0);assert.match(missingTime.text,/23:59/);assert.equal((await f.tasks.list()).items.length,0);
  await f.run('/cancel',null);
  await f.run('Подготовить доклад',{intent:'create',tasks:[{task:{...modelTask,title:'Доклад',deadline:null},deadlineEvidence:null}]});
  const borrowed=await f.run('Да, доклад',{intent:'create',tasks:[{task:{...modelTask,title:'Доклад',deadline:{kind:'by_date',date:'2026-10-05'}},deadlineEvidence:'до 5 октября'}]},{history:[{role:'user',content:'Старая задача до 5 октября',createdAt:Date.parse('2026-10-01T00:00:00Z')}]});
  assert.equal(borrowed.actions.length,0);assert.equal((await f.tasks.list()).items.length,0);
});

test('mode changes during extraction and an invalid later patch block the entire operation',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.run('ДЗ 24 октября 23:59',()=>{const chat=f.db.chats.get(1,f.chat.id);f.db.chats.changeMode(1,chat.id,'note',chat.version);return create();}),/изменились/);
  assert.equal((await f.tasks.list()).items.length,0);
  const current=f.db.chats.get(1,f.chat.id);f.db.chats.changeMode(1,current.id,'task',current.version);
  await f.run(request,series);
  const bad=await f.run('Первую заверши, вторую до 31 февраля',{intent:'update_many',updates:[{target:{kind:'recent',index:1},patch:{status:'done'}},{target:{kind:'recent',index:2},patch:{deadline:{kind:'by_date',date:'2026-02-31'}},deadlineEvidence:'31 февраля'}]});
  assert.equal(bad.actions.length,0);assert((await f.tasks.list()).items.every(t=>t.status==='todo'));
});

test('explicit group filters change all selected tasks and partial results only claim confirmed files',async t=>{
  const f=await fixture(t);await f.run(request,series);
  const result=await f.run('Все учебные задачи октября перенеси на неделю',{intent:'shift',target:{kind:'filter',category:'study',from:'2026-10-01',to:'2026-10-31'},unit:'week',amount:1,evidence:'на неделю'});
  assert.equal(result.actions.length,2);
  const task=(await f.tasks.list()).items[0],content=(await f.vault.readNote(task.path)).content;
  const requestId='partial-task-fixture',operationId='chatop_'+fingerprint({deviceId:1,chat:f.chat.id,requestId}).slice(0,64);
  const missing='Areas/Study/Tasks/Missing.md';
  f.db.prepareBatch({operationId,requestHash:'fixture',files:[{path:task.path,baseHash:null,contentHash:hashContent(content),base64:Buffer.from(content).toString('base64')},{path:missing,baseHash:null,contentHash:hashContent('not written'),base64:null}],result:{},state:'prepared',commitSha:null,errorCode:null});
  assert.deepEqual(await new RequestLedger(f.db).confirmedTaskArtifacts(1,f.chat.id,requestId,f.vault),[task.path]);
});
