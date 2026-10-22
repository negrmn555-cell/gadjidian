import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { zipSync, strToU8 } from 'fflate';
import { Vault, LlmClient, parseModeJson, DomainError, type ChatSession, type AgentResult } from '@relay/core';
import { Db } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { GitSync } from '../src/sync.js';
import { VaultMutationService } from '../src/vault-mutations.js';
import { TaskService } from '../src/tasks.js';
import { NoteModeService } from '../src/note-mode.js';
import { ChatModeService } from '../src/chat-modes.js';
import { ChatStore, CHAT_RETENTION_MS } from '../src/chat-store.js';
import { decodeUpload, upload } from '../src/attachments.js';
import { createServer } from '../src/index.js';

async function fixture(t:{after:(fn:()=>Promise<void>)=>void}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-chats-'));
  const cfg=loadConfig();cfg.dataDir=root;cfg.dbPath=path.join(root,'relay.sqlite');cfg.vault.root=path.join(root,'vault');cfg.vault.privateFolders=['Private'];cfg.providers.keyFile=path.join(root,'secrets','key');cfg.providers.allowedOrigins=[];cfg.llm.apiKey='';cfg.sync={...cfg.sync,mode:'none',pullInterval:0};cfg.staticDir=path.join(root,'no-static');cfg.scenariosFile=path.join(root,'missing');
  await fs.mkdir(cfg.vault.root);const db=await Db.open(cfg.dbPath),vault=new Vault(cfg.vault),sync=new GitSync(cfg);await sync.start(false);
  const mutations=new VaultMutationService(vault,db,sync);vault.setWriteBackend(mutations);const tasks=new TaskService(vault,mutations),notes=new NoteModeService(vault,mutations),modes=new ChatModeService(db.chats,tasks,notes,vault);
  t.after(async()=>{sync.stop();db.close();if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('relay-chats-'))throw new Error('Unsafe cleanup');await fs.rm(root,{recursive:true,force:true});});
  return {root,cfg,db,vault,tasks,notes,modes};
}
const draft=(deadline:unknown=null,evidence:unknown=null,state='needs_input')=>({state,question:state==='ready'?'':'Когда выполнить?',deadlineEvidence:evidence,task:{title:'Подготовить доклад',description:'История',category:'study',priority:'high',keywords:['доклад','история'],tags:[],relatedNoteIds:[],deadline}});
function llm(output:unknown){return new LlmClient({baseUrl:'https://example.test/v1',model:'test',apiKey:''},async()=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:typeof output==='string'?output:JSON.stringify(output)},finish_reason:'stop'}]})));}
for(const engine of ['legacy','mastra'] as const)test(engine+': task mode keeps strict deadline validation and never exposes raw JSON deltas',async t=>{
  const f=await fixture(t);let chat=f.db.chats.create(1,'runtime-task-parity','UTC');chat=f.db.chats.changeMode(1,chat.id,'task',1);const events:import('@relay/core').AgentEvent[]=[];
  const request={device:1,chat,text:'Подготовить доклад',operationId:'runtime_task_parity',history:[],llm:llm(draft()),signal:new AbortController().signal,onEvent:(e:import('@relay/core').AgentEvent)=>events.push(e),toolsEnabled:true,structuredOutput:true,engine};
  const result=await f.modes.run(request);assert.equal(result.actions.length,0);assert.equal((await f.tasks.list()).items.length,0);assert.equal(events.some(e=>e.type==='delta'),false);assert(f.db.chats.get(1,chat.id).pendingTask);
  const direct=await f.modes.run({...request,chat:f.db.chats.get(1,chat.id),text:'/quick запись'});assert.equal(direct.actions.length,0);assert.match(direct.text,/недоступны/);
  const fileDeadline=await f.modes.run({...request,chat:f.db.chats.get(1,chat.id),userText:'Подготовить доклад',text:'Подготовить доклад\nФайл: До 5 октября 2026',llm:llm(draft({kind:'by_date',date:'2026-10-05'},'До 5 октября 2026','ready'))});assert.equal(fileDeadline.actions.length,0);assert.equal((await f.tasks.list()).items.length,0);
});
async function run(f:Awaited<ReturnType<typeof fixture>>,chat:ChatSession,text:string,output:unknown,history:{role:'user'|'assistant';content:string}[]=[]):Promise<AgentResult>{return f.modes.run({device:1,chat,text,operationId:'mode_'+text.length+'_'+chat.id.replaceAll('-','_'),history,llm:llm(output),signal:new AbortController().signal,onEvent:()=>{},toolsEnabled:true,structuredOutput:true});}

test('fresh entries create distinct chats while effect replay is idempotent, mode survives restart',async t=>{
  const f=await fixture(t);const a=f.db.chats.create(1,'entry-chat-1','Europe/Moscow');assert.equal(f.db.chats.create(1,'entry-chat-1','Europe/Moscow').id,a.id);
  const b=f.db.chats.create(1,'entry-chat-2','Europe/Moscow');assert.notEqual(a.id,b.id);
  f.db.chats.changeMode(1,a.id,'task',1);assert.equal(f.db.chats.get(1,b.id).mode,'note');
  const separate=await Db.open(f.cfg.dbPath);try{assert.equal(separate.chats.get(1,a.id).mode,'task');assert.equal(separate.chats.sessions(1).length,2);}finally{separate.close();}
  assert.throws(()=>f.db.chats.get(2,a.id),/Чат не найден/);assert.throws(()=>f.db.chats.changeMode(1,a.id,'note',1),/изменился/);
});
test('chat and attachment access expire at the exact cutoff even before physical cleanup',async t=>{
  const f=await fixture(t);let now=Date.now();const store=new ChatStore(path.join(f.root,'clock.sqlite'),()=>now);
  try{const c=store.create(1,'clock-entry','UTC');store.add(1,c.id,'user','text');const file=store.putAttachment(1,c.id,'a.txt','text/plain','text',Buffer.from('data'),'data');
    store.setDraft(1,c.id,{id:'draft-clock',version:1,createdAt:now,task:{title:'Task'},question:'Срок?'});
    now+=CHAT_RETENTION_MS-1;assert.equal(store.get(1,c.id).messageCount,1);assert.equal(store.attachment(1,c.id,file.id).text,'data');
    now++;assert.deepEqual(store.sessions(1),[]);assert.throws(()=>store.get(1,c.id),/истёк/);assert.throws(()=>store.attachment(1,c.id,file.id),/истёк/);store.prune();assert.deepEqual(store.list(1,c.id),[]);
  }finally{store.close();}
});
test('pending drafts are isolated, paused in note mode and request replay cannot change payload',async t=>{
  const f=await fixture(t),a=f.db.chats.create(1,'draft-entry-1','UTC'),b=f.db.chats.create(1,'draft-entry-2','UTC');
  f.db.chats.setDraft(1,a.id,{id:'a',version:1,createdAt:Date.now(),task:{title:'Call'},question:'Когда?'});
  assert.equal(f.db.chats.get(1,b.id).pendingTask,null);assert.equal(f.db.chats.changeMode(1,a.id,'task',1).pendingTask?.id,'a');
  assert.equal(f.db.chats.beginRun(1,a.id,'request-123','hash'),null);assert.throws(()=>f.db.chats.beginRun(1,a.id,'request-123','hash'),/прерван/);
  f.db.chats.finishRun(1,a.id,'request-123',{ok:true});assert.deepEqual(f.db.chats.beginRun(1,a.id,'request-123','hash'),{result:{ok:true}});assert.throws(()=>f.db.chats.beginRun(1,a.id,'request-123','different'),/другого сообщения/);
});
test('task mode asks for a deadline then writes a managed task using the same draft',async t=>{
  const f=await fixture(t);let c=f.db.chats.create(1,'task-entry-1','Europe/Moscow');c=f.db.chats.changeMode(1,c.id,'task',1);
  await f.vault.writeNote('Resources/История.md','История и доклад');
  assert.equal((await run(f,c,'Подготовить доклад',draft())).actions.length,0);assert.equal((await f.tasks.list()).items.length,0);
  c=f.db.chats.get(1,c.id);assert.equal(c.pendingTask?.task.title,'Подготовить доклад');
  const r=await run(f,c,'До 5 октября 2026',draft({kind:'by_date',date:'2026-10-05'},'До 5 октября 2026','ready'),[{role:'user',content:'Подготовить доклад'}]);
  assert.equal(r.actions.length,1);const task=(await f.tasks.list()).items[0];assert.equal(task.category,'study');assert.equal(task.priority,'high');assert.equal(task.deadline.kind,'by_date');assert.match(task.description,/\[\[Resources\/История\]\]/);assert.equal(f.db.chats.get(1,c.id).pendingTask,null);
});
test('invented deadlines, impossible dates and DST folds produce clarification without writes',async t=>{
  const f=await fixture(t);let c=f.db.chats.create(1,'bad-deadline-entry','Europe/Berlin');c=f.db.chats.changeMode(1,c.id,'task',1);
  await run(f,c,'Подготовить доклад',draft({kind:'by_date',date:'2026-10-05'},'завтра','ready'));assert.equal((await f.tasks.list()).items.length,0);
  c=f.db.chats.get(1,c.id);const invalid=await run(f,c,'До 31 февраля',draft({kind:'by_date',date:'2026-02-31'},'До 31 февраля','ready'));assert.match(invalid.text,/не существует/);
  c=f.db.chats.get(1,c.id);const fold=await run(f,c,'25 октября 2026 в 02:30',draft({kind:'at_time',date:'2026-10-25',time:'02:30'},'25 октября 2026 в 02:30','ready'));assert.match(fold.text,/Уточните/);assert.equal((await f.tasks.list()).items.length,0);
});
test('strict task JSON rejects prose, duplicate fields and unknown task operations',async t=>{
  for(const bad of ['```json\n{}\n```','{"state":"ready","state":"needs_input"}','{} trailing'])assert.throws(()=>parseModeJson(bad),/некорректный/);
  const f=await fixture(t);let c=f.db.chats.create(1,'strict-mode-entry','UTC');c=f.db.chats.changeMode(1,c.id,'task',1);
  const result=await run(f,c,'Task', {...draft(),writeNow:true});assert.equal(result.outcome,'failed');assert.equal(result.error?.code,'TASK_MODEL_OUTPUT_INVALID');assert.match(result.text,/Ничего не записано/);assert.doesNotMatch(result.text,/Ожидается объект/);assert.equal((await f.vault.listNotes()).length,0);
});
test('commands cannot bypass modes or write managed tasks through note append',async t=>{
  const f=await fixture(t);let c=f.db.chats.create(1,'mode-command-entry','UTC');
  const blocked=await run(f,c,'/task без срока','unused');assert.equal(blocked.actions.length,0);assert.match(blocked.text,/режиме заметки/);
  c=f.db.chats.changeMode(1,c.id,'task',1);assert.equal((await run(f,c,'/quick wrong','unused')).actions.length,0);
  const created=await f.tasks.create({title:'Real task',category:'work',priority:'medium',deadline:{kind:'by_date',date:'2026-10-05',timezone:'UTC'}},'protected-task-operation');
  await assert.rejects(f.notes.write('append_note',{path:created.task.path,text:'Change it'},'forbidden-note-operation'),/нельзя изменять/);
  await assert.rejects(f.notes.write('create_note',{kind:'task',title:'Bad',content:'text'},'forbidden-kind-operation'),/режиме заметки/);
});
test('note enrichment creates hierarchy and links, person matching updates existing card and asks for namesakes',async t=>{
  const f=await fixture(t);await f.vault.writeNote('Resources/История.md','История древнего мира и доклад');
  const note=await f.notes.write('quick',{title:'Учебный доклад',content:'Лекция история древнего мира'},'enriched-note-operation');assert.match(note.path??'',/^Areas\/Study\/Notes/);const content=(await f.vault.readNote(note.path!)).content;assert.match(content,/keywords:/);assert.match(content,/\[\[Resources\/История\]\]/);
  const p=await f.notes.write('person',{content:'Анна | Коллега по проекту'},'person-new-operation');const p2=await f.notes.write('person',{content:'Анна | Встреча в пятницу'},'person-edit-operation');assert.equal(p.path,p2.path);assert.match((await f.vault.readNote(p.path!)).content,/Встреча в пятницу/);
  await f.vault.writeNote('People/Other/Анна.md','Ещё одна Анна');const ask=await f.notes.write('person',{content:'Анна | Другие сведения'},'person-ambiguous-operation');assert.equal(ask.path,undefined);assert.match(ask.text,/несколько карточек/);
});
test('a model failure after writing reports the saved note rather than hiding the partial result',async t=>{
  const f=await fixture(t),chat=f.db.chats.create(1,'partial-note-entry','UTC');let calls=0;
  const client=new LlmClient({baseUrl:'https://example.test/v1',model:'test',apiKey:''},async()=>{if(calls++)throw new Error('upstream failed');return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'note-call',type:'function',function:{name:'create_note',arguments:JSON.stringify({kind:'idea',title:'Записанная идея',content:'Идея для проекта'})}}]},finish_reason:'tool_calls'}]}));});
  const result=await f.modes.run({device:1,chat,text:'Запиши идею',operationId:'partial-note-operation',history:[],llm:client,signal:new AbortController().signal,onEvent:()=>{},toolsEnabled:true,structuredOutput:false});
  assert.equal(result.actions.length,1);assert.match(result.text,/Уже сохранённые изменения/);assert.equal((await f.vault.listNotes()).length,1);
});
test('uploads decode UTF-8 and DOCX, reject spoofed/binary/oversized files and enforce chat/device scope',async t=>{
  const f=await fixture(t),c=f.db.chats.create(1,'upload-entry-1','UTC'),other=f.db.chats.create(1,'upload-entry-2','UTC');
  const file=await upload(f.db.chats,1,c.id,'../../test.txt',Buffer.from('Учебный материал'));assert.equal(file.name,'test.txt');assert.equal(file.textLength,16);
  assert.throws(()=>f.db.chats.attachment(1,other.id,file.id),/Файл недоступен/);assert.throws(()=>f.db.chats.attachment(2,c.id,file.id),/Чат не найден/);
  await assert.rejects(decodeUpload('a.png',Buffer.from('not png')),/не соответствует/);await assert.rejects(decodeUpload('a.txt',Buffer.from([0xff])),/UTF-8/);await assert.rejects(decodeUpload('a.txt',Buffer.alloc(6*1024*1024)),/5 МБ/);
  const docx=Buffer.from(zipSync({'word/document.xml':strToU8('<w:document><w:p><w:r><w:t>First &amp; second</w:t></w:r></w:p><w:p><w:r><w:t>Next</w:t></w:r></w:p></w:document>')}));assert.equal((await decodeUpload('a.docx',docx)).text,'First & second\nNext');
  const bomb=Buffer.from(zipSync({'word/document.xml':strToU8('x'.repeat(2_000_001))}));await assert.rejects(decodeUpload('big.docx',bomb),/распаковки/);
});
function pdfFixture(text:boolean):Buffer{
  const stream=text?'BT /F1 14 Tf 40 100 Td (Hello PDF) Tj ET':'';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let raw='%PDF-1.4\n';const offsets=[0];objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(raw));raw+=(i+1)+' 0 obj\n'+object+'\nendobj\n';});const xref=Buffer.byteLength(raw);raw+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';return Buffer.from(raw);
}
test('PDF worker extracts a text layer and rejects scan-only documents instead of claiming OCR',async()=>{
  assert.match((await decodeUpload('text.pdf',pdfFixture(true))).text,/Hello PDF/);
  await assert.rejects(decodeUpload('scan.pdf',pdfFixture(false)),/нет текстового слоя/);
});
test('a previous task deadline is not reused for a fresh task and cancelled work cannot create files',async t=>{
  const f=await fixture(t);let c=f.db.chats.create(1,'new-deadline-entry','UTC');c=f.db.chats.changeMode(1,c.id,'task',1);
  await run(f,c,'Новая задача без срока',draft({kind:'by_date',date:'2026-10-05'},'До 5 октября 2026','ready'),[{role:'user',content:'Старая задача. До 5 октября 2026'}]);assert.equal((await f.tasks.list()).items.length,0);
  const ac=new AbortController();ac.abort();await assert.rejects(f.tasks.create({title:'Cancelled',category:'work',priority:'medium',deadline:{kind:'by_date',date:'2026-10-05',timezone:'UTC'}},'cancelled-task-op',ac.signal),/отменён/);assert.equal((await f.tasks.list()).items.length,0);
});
test('chat API authenticates uploads, validates draft revision and replays task writes exactly once',async t=>{
  const f=await fixture(t);const a=f.db.createDevice('A','app'),b=f.db.createDevice('B','app'),quick=f.db.createDevice('Q','quick');
  const outputs=[draft(),draft({kind:'by_date',date:'2026-10-05'},'До 5 октября 2026','ready')];let count=0;
  const upstream=http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify(outputs[count++])},finish_reason:'stop'}]}));});});
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+(upstream.address() as {port:number}).port;f.cfg.providers.allowedOrigins=[origin];
  const app=await createServer(f.cfg),headers={authorization:'Bearer '+a.token};
  try{
    assert.equal((await app.inject({method:'POST',url:'/api/chats',payload:{entryId:'api-new-entry',timezone:'UTC'}})).statusCode,401);
    assert.equal((await app.inject({method:'GET',url:'/api/chats',headers:{authorization:'Bearer '+quick.token}})).statusCode,401);
    const c=(await app.inject({method:'POST',url:'/api/chats',headers,payload:{entryId:'api-new-entry',timezone:'Europe/Moscow'}})).json();
    const capture=(await app.inject({method:'POST',url:'/api/chat',headers,payload:{chatId:c.id,expectedVersion:1,requestId:'api-direct-capture',text:'/quick Текст без настроенного ИИ',attachmentIds:[]}})).json();assert.equal(capture.actions.length,1);
    assert.equal((await app.inject({method:'GET',url:'/api/chats/'+c.id,headers:{authorization:'Bearer '+b.token}})).statusCode,404);
    const mode=(await app.inject({method:'PATCH',url:'/api/chats/'+c.id,headers,payload:{mode:'task',expectedVersion:1}})).json();
    await app.inject({method:'POST',url:'/api/providers',headers,payload:{slot:'chat',provider:{name:'Local test',adapter:'openai_compatible',baseUrl:origin+'/v1',modelId:'fixture',canonicalModelId:null,enabled:true,capabilities:{toolCalls:false,vision:false,structuredOutput:true},secretUpdate:{action:'remove'}}}});
    const first=(await app.inject({method:'POST',url:'/api/chat',headers,payload:{chatId:c.id,requestId:'api-task-request-1',expectedVersion:mode.version,text:'Подготовить доклад',attachmentIds:[]}})).json();assert.ok(first.chat.pendingTask);assert.equal((await f.tasks.list()).items.length,0);
    const bad=await app.inject({method:'POST',url:'/api/chat',headers,payload:{chatId:c.id,requestId:'api-task-request-bad',expectedVersion:mode.version,text:'До 5 октября 2026',attachmentIds:[],draftId:'wrong',draftVersion:1}});assert.equal(bad.statusCode,409);
    const payload={chatId:c.id,requestId:'api-task-request-2',expectedVersion:mode.version,text:'До 5 октября 2026',attachmentIds:[],draftId:first.chat.pendingTask.id,draftVersion:first.chat.pendingTask.version};
    const result=await app.inject({method:'POST',url:'/api/chat',headers,payload});assert.equal(result.json().actions.length,1);
    const replay=await app.inject({method:'POST',url:'/api/chat',headers,payload});assert.equal(replay.json().messageId,result.json().messageId);assert.equal(count,2);assert.equal((await f.tasks.list()).items.length,1);
    assert.equal((await app.inject({method:'POST',url:'/api/attachments?chatId='+c.id+'&name=a.txt',headers:{...headers,'content-type':'application/octet-stream'},payload:Buffer.from('hello')})).statusCode,201);
  }finally{await app.close();await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
});
