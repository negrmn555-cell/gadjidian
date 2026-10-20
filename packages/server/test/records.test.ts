import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse } from 'yaml';
import { Vault, LlmClient, parseFrontmatter } from '@relay/core';
import { Db } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { GitSync } from '../src/sync.js';
import { VaultMutationService } from '../src/vault-mutations.js';
import { TaskService } from '../src/tasks.js';
import { NoteService } from '../src/notes.js';
import { NoteIndex } from '../src/note-index.js';
import { recordCode } from '../src/record-codes.js';
import { notesGraph } from '../src/notes-graph.js';
import { CompletedEvents, EVENTS_BASE, COMPLETED_ARCHIVE } from '../src/completed-events.js';
import { AutomationSettingsService, type JobLease } from '../src/scheduler.js';
import type { ProviderRegistry } from '../src/providers.js';

const input = { title:'Подготовить конспект', description:'Конспект подготовлен по двум главам.', category:'study', priority:'medium', deadline:{kind:'by_date',date:'2026-10-01',timezone:'Europe/Moscow'} };
const lease = { assert(){}, heartbeat(){}, payload:{} } as JobLease;
async function fixture(t:{after:(f:()=>Promise<void>)=>void},git=false) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-records-')),cfg=loadConfig();
  cfg.dataDir=root;cfg.dbPath=path.join(root,'relay.sqlite');cfg.vault.root=path.join(root,'vault');cfg.vault.privateFolders=['Private'];cfg.sync={...cfg.sync,mode:git?'git':'none',remote:'',pullInterval:0};
  await fs.mkdir(cfg.vault.root);const db=await Db.open(cfg.dbPath),vault=new Vault(cfg.vault),sync=new GitSync(cfg),mutations=new VaultMutationService(vault,db,sync);await sync.start(false);vault.setWriteBackend(mutations);
  let now='2026-10-01T12:00:00.000Z';const tasks=new TaskService(vault,mutations,()=>now,new NoteIndex(vault,db)),notes=new NoteService(vault,mutations),settings=new AutomationSettingsService(db);
  t.after(async()=>{sync.stop();db.close();if(path.dirname(path.resolve(root))!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('relay-records-'))throw Error('Unsafe cleanup');await fs.rm(root,{recursive:true,force:true});});
  const sorter=(respond:(body:any)=>Promise<string>,at='2026-10-15T12:00:00.000Z')=>{
    const client=new LlmClient({baseUrl:'https://unused.test',apiKey:'',model:'fixture'},async(_url,init)=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:await respond(JSON.parse(String(init?.body)))},finish_reason:'stop'}]})));
    const providers={bindOrganizer:()=>({client,profile:{id:'fixture-sorter',version:1,capabilities:{structuredOutput:true}},release(){}})} as unknown as ProviderRegistry;
    return new CompletedEvents(vault,tasks,providers,mutations,sync,settings,()=>Date.parse(at));
  };
  const complete=async(id:string,hash:string,op:string)=>tasks.update(id,{status:'done'},hash,op);
  return {root,vault,db,tasks,notes,sync,sorter,complete,setNow:(value:string)=>{now=value;}};
}
const summarize=async(body:any)=>JSON.stringify({summaries:JSON.parse(body.messages[1].content).map((task:any)=>({id:task.id,summary:'Конспект подготовлен по двум главам.'}))});

test('record codes are unique across tasks and notes, stable on edit, and retry creates once',async t=>{
  const f=await fixture(t),results=await Promise.all(Array.from({length:8},(_,i)=>f.tasks.create(input,'unique-record-'+i)));
  const n=await f.notes.create({title:input.title,body:'Текст заметки',kind:'quick',category:'study',tags:[],keywords:[],aliases:[],person:{phone:'',email:'',role:''}},'unique-note');
  const codes=[...results.map(r=>recordCode(r.task.title)),recordCode(n.note.title)];assert.equal(codes.every(Boolean),true);assert.equal(new Set(codes).size,9);
  for(const r of results){assert.equal(r.task.path.includes('#'),false);assert.match(r.task.title,/ #\w{4,8}$/);}
  assert.equal((await f.tasks.create(input,'unique-record-0')).task.path,results[0].task.path);
  const edited=await f.tasks.update(results[0].task.id,{title:'Новое название'},results[0].task.contentHash,'edit-coded');assert.equal(recordCode(edited.task.title),codes[0]);
  assert.equal((await f.tasks.list()).items.length,8);
  const long=await Promise.all([f.tasks.create({...input,title:'Длинное название '.repeat(10)},'long-record-a'),f.tasks.create({...input,title:'Длинное название '.repeat(10)},'long-record-b')]);assert.notEqual(long[0].task.path,long[1].task.path);for(const r of long)assert.ok(r.task.path.endsWith(' - '+recordCode(r.task.title)+'.md'));
});

test('graph resolves Markdown, wiki and related-ID links while excluding private files',async t=>{
  const f=await fixture(t);
  await f.vault.writeNote('Notes/A.md','---\nid: a\ntitle: Альфа\ntags: [study]\n---\n[[B]]\n[C](C.md)\n#проект/граф `#not-a-tag`\n```md\n#also-not-a-tag\n```');
  await f.vault.writeNote('Notes/B.md','---\nid: b\nrelated_note_ids: [c]\n---\nБета');
  await f.vault.writeNote('Notes/C.md','---\nid: c\n---\nГамма');
  await fs.mkdir(path.join(f.vault.root,'Private'));await fs.writeFile(path.join(f.vault.root,'Private/secret.md'),'Secret');
  const graph=await notesGraph(f.vault,'sha123','git');assert.equal(graph.nodes.length,3);assert.equal(graph.edges.length,3);assert.equal(graph.revision,'sha123');assert.equal(graph.nodes.some(n=>n.path.startsWith('Private/')),false);
  assert.deepEqual(graph.nodes.find(node=>node.path==='Notes/A.md')?.tags,['study','проект/граф']);
});

test('14-day boundary archives only after valid AI summary, repairs backlinks and creates a real Base',async t=>{
  const f=await fixture(t,true),created=await f.tasks.create(input,'archive-boundary');const done=await f.complete(created.task.id,created.task.contentHash,'complete-boundary');
  await f.vault.writeNote('Notes/References.md','[['+done.task.path.replace(/\.md$/,'')+'|Конспект]]');
  assert.equal((await f.sorter(summarize,'2026-10-15T11:59:59.999Z').eligible()).length,0);
  assert.equal((await f.sorter(summarize).eligible()).length,1);
  const before=await f.sync.head();
  const result=await f.sorter(summarize).run(lease) as {archived:number;receipt:{state:string;commitSha:string}};assert.equal(result.archived,1);assert.equal(result.receipt.state,'committed');assert.notEqual(await f.sync.head(),before);assert.equal(result.receipt.commitSha,await f.sync.head());
  assert.equal(await f.vault.exists(done.task.path),false);assert.equal((await f.tasks.list()).items.length,0);
  const archive=COMPLETED_ARCHIVE+done.task.id+'.md',original=await f.vault.readNote(archive);assert.equal(parseFrontmatter(original.content).metadata.type,'archived_task');assert.match(original.content,/Конспект подготовлен по двум главам/);
  assert.ok((await f.vault.readNote('Notes/References.md')).content.includes(archive.replace(/\.md$/,'')));
  const event=await f.vault.readNote('Past events/'+done.task.id+'.md');assert.equal(parseFrontmatter(event.content).metadata.summary,'Конспект подготовлен по двум главам.');
  const base=parse(await fs.readFile(path.join(f.vault.root,EVENTS_BASE),'utf8'));assert.equal(base.views[0].type,'table');assert.deepEqual(base.filters.and,['type == "past_event"']);
  assert.equal((await f.sorter(summarize).run(lease) as {archived:number}).archived,0);assert.equal((await f.notes.list()).items.some(n=>n.path===archive),false);
});

test('invalid AI output, failed provider and lost lease retain originals without a Base',async t=>{
  const f=await fixture(t),created=await f.tasks.create(input,'archive-failure');const done=await f.complete(created.task.id,created.task.contentHash,'complete-failure');
  await assert.rejects(f.sorter(async()=>'{"summaries":[]}').run(lease));
  await assert.rejects(f.sorter(async()=>{throw Error('Provider unavailable');}).run(lease));
  let calls=0;await assert.rejects(f.sorter(summarize).run({...lease,assert(){if(++calls>1)throw Error('Lease lost');}}));
  assert.equal((await f.tasks.get(done.task.id)).status,'done');assert.equal(await f.vault.exists(done.task.path),true);await assert.rejects(fs.access(path.join(f.vault.root,EVENTS_BASE)));
});

test('concurrent task edit rejects stale AI summary and preserves the latest task',async t=>{
  const f=await fixture(t),created=await f.tasks.create(input,'archive-race');const done=await f.complete(created.task.id,created.task.contentHash,'complete-race');
  await assert.rejects(f.sorter(async body=>{await f.tasks.update(done.task.id,{description:'Исправленный результат'},done.task.contentHash,'edit-during-summary');return summarize(body);}).run(lease),/измен/);
  assert.equal((await f.tasks.get(done.task.id)).description,'Исправленный результат');await assert.rejects(fs.access(path.join(f.vault.root,EVENTS_BASE)));
});
