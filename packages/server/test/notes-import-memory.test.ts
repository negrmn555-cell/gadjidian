import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createCanvas } from '@napi-rs/canvas';
import { zipSync, strToU8 } from 'fflate';
import { Vault, LlmClient, Agent, hashContent, sourceVersion, DomainError, type NoteCreateInput, type ExtractionReport } from '@relay/core';
import { Db } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { GitSync } from '../src/sync.js';
import { VaultMutationService, hashBytes } from '../src/vault-mutations.js';
import { NoteService } from '../src/notes.js';
import { NoteModeService } from '../src/note-mode.js';
import { ImportService } from '../src/imports.js';
import { ChatMemoryService } from '../src/chat-memory.js';
import { ChatStore, CHAT_RETENTION_MS } from '../src/chat-store.js';
import { decodeUpload, upload } from '../src/attachments.js';
import { createServer } from '../src/index.js';
import { assertImageDimensions } from '../src/image-limits.js';
const exec=promisify(execFile);
const fields:NoteCreateInput={title:'Анна',body:'# Анна\n\nТелефон уточнить.',kind:'person',category:'work',tags:['контакты'],keywords:['анна','клиент'],aliases:['Аня'],person:{phone:'123',email:'anna@example.test',role:'Клиент'}};
async function fixture(t:{after:(f:()=>Promise<void>)=>void},git=false){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-stage4-')),cfg=loadConfig();cfg.dataDir=root;cfg.dbPath=path.join(root,'relay.sqlite');cfg.providers.keyFile=path.join(root,'secret','key');cfg.vault.root=path.join(root,'vault');cfg.vault.privateFolders=['Private'];cfg.sync={...cfg.sync,mode:git?'git':'none',remote:'',pullInterval:0};cfg.staticDir=path.join(root,'missing');cfg.scenariosFile=path.join(root,'no.json');cfg.requireStandalone=false;cfg.llm.apiKey='';
  await fs.mkdir(cfg.vault.root);const db=await Db.open(cfg.dbPath),vault=new Vault(cfg.vault),sync=new GitSync(cfg),mutations=new VaultMutationService(vault,db,sync);await sync.start(false);vault.setWriteBackend(mutations);
  const beforeCleanup:(()=>Promise<unknown>)[]=[];
  t.after(async()=>{for(const close of beforeCleanup)await close();sync.stop();db.close();if(path.dirname(path.resolve(root))!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('relay-stage4-'))throw new Error('Unsafe cleanup');await fs.rm(root,{recursive:true,force:true});});
  return {root,cfg,db,vault,sync,mutations,beforeCleanup,notes:new NoteService(vault,mutations),imports:new ImportService(vault,db.chats,mutations),memory:new ChatMemoryService(db.chats,vault)};
}
const llm=(answer:string)=>new LlmClient({baseUrl:'https://unused.test',apiKey:'',model:'fixture'},async()=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:answer},finish_reason:'stop'}]})));

test('manual notes/persons create once, replace old facts, retain IDs, and direct person aliases find manual cards',async t=>{
  const f=await fixture(t),a=await f.notes.create(fields,'manual-note-create');assert.equal((await f.notes.create(fields,'manual-note-create')).note.id,a.note.id);
  const updated=await f.notes.update(a.note.path,{fields:{...fields,body:'# Анна\n\nНовый факт вместо старого.',person:{...fields.person,phone:'456'}}},a.note.contentHash,'manual-note-update');
  assert.equal(updated.note.id,a.note.id);assert.equal(updated.note.path,a.note.path);assert.equal(updated.note.person.phone,'456');assert.doesNotMatch(updated.note.body,/уточнить/);
  await new NoteModeService(f.vault,f.mutations).write('person',{content:'Аня | Совещание перенесли.'},'person-alias-append');assert.equal((await f.notes.list()).items.length,1);assert.match((await f.notes.get(a.note.path)).body,/Совещание/);
  await assert.rejects(f.notes.create({...fields,title:'Other'},'manual-note-create'),/другого запроса/);
});
test('structured edits preserve old YAML unknown fields and comments; raw editor preserves explicit complete content',async t=>{
  const f=await fixture(t);const content='---\nid: note_legacy\ntype: person\nphone: old\ncustom: "keep" # do not lose\naliases: [Аня]\n---\n\n# Анна\n\nOld fact.\n';await f.vault.writeNote('People/Анна.md',content);
  const old=await f.notes.get('People/Анна.md'),r=await f.notes.update(old.path,{fields:{...fields,body:'New fact.'}},old.contentHash,'legacy-person-edit');assert.match(r.note.content,/custom: "keep" # do not lose/);assert.equal(r.note.id,'note_legacy');
  const raw=r.note.content.replace('New fact.','Replaced fully.');const edited=await f.notes.update(old.path,{content:raw},r.note.contentHash,'raw-person-edit');assert.equal(edited.note.content,raw);
  await assert.rejects(f.notes.update(old.path,{content:raw.replace('note_legacy','other')},edited.note.contentHash,'immutable-note-id'),/ID/);
});
test('stale/deleted notes and malformed YAML do not overwrite; tasks/private paths are unavailable to the editor',async t=>{
  const f=await fixture(t),r=await f.notes.create(fields,'conflict-create');await fs.writeFile(f.vault.resolve(r.note.path),r.note.content+'External edit.');await assert.rejects(f.notes.update(r.note.path,{fields},r.note.contentHash,'stale-note-edit'),/изменилась/);assert.match((await f.notes.get(r.note.path)).body,/External edit/);
  await fs.unlink(f.vault.resolve(r.note.path));await assert.rejects(f.notes.update(r.note.path,{fields},r.note.contentHash,'deleted-note-edit'));assert.equal(await f.vault.exists(r.note.path),false);
  await fs.mkdir(path.join(f.vault.root,'People'),{recursive:true});await fs.writeFile(path.join(f.vault.root,'People/bad.md'),'---\na: 1\na: 2\n---\nText');assert.equal((await f.notes.list()).invalidRecords.length,1);
  await assert.rejects(f.notes.get('Private/a.md'));await f.vault.writeNote('Areas/Work/Tasks/old.md','Legacy task');await assert.rejects(f.notes.get('Areas/Work/Tasks/old.md'),/задачи/);
});
test('AI editing preserves unknown YAML comments and refuses dropping metadata',async t=>{
  const f=await fixture(t),original='---\nid: note_ai_guard\ntype: person\ncustom: keep # retained comment\nphone: old\n---\n\nOld fact.';await f.vault.writeNote('People/Guard.md',original);const n=await f.notes.get('People/Guard.md'),writer=new NoteModeService(f.vault,f.mutations);
  await assert.rejects(writer.write('update_note',{path:n.path,expectedHash:n.contentHash,content:original.replace('custom: keep # retained comment\n','')},'ai-drop-yaml-key'),/YAML/);
  await writer.write('update_note',{path:n.path,expectedHash:n.contentHash,content:original.replace(' # retained comment','').replace('Old fact.','New fact.')},'ai-keep-yaml-key');assert.match((await f.notes.get(n.path)).content,/custom: keep # retained comment/);
});
test('AI person correction requires full read and an exact hash, and reports the source revision',async t=>{
  const f=await fixture(t),r=await f.notes.create(fields,'ai-person-create');let call=0;
  const client=new LlmClient({baseUrl:'https://unused.test',apiKey:'',model:'fixture'},async()=>{
    const msgs=[{role:'assistant',content:null,tool_calls:[{id:'read',type:'function',function:{name:'read_note',arguments:JSON.stringify({path:r.note.path})}}]},{role:'assistant',content:null,tool_calls:[{id:'edit',type:'function',function:{name:'update_note',arguments:JSON.stringify({path:r.note.path,expectedHash:r.note.contentHash,content:r.note.content.replace('phone: "123"','phone: "999"').replace('phone: 123','phone: 999')})}}]},{role:'assistant',content:'Телефон исправлен.'}];return new Response(JSON.stringify({choices:[{message:msgs[Math.min(call++,2)],finish_reason:'stop'}]}));
  });
  const a=new Agent({vault:f.vault,llm:client,mode:'note',noteWriter:new NoteModeService(f.vault,f.mutations).writer('ai-update-request')});const result=await a.run({text:'Исправь телефон Анны на 999'});assert.equal(result.actions[0].kind,'updated');assert.equal(result.sourceVersions?.[0].contentHash,r.note.contentHash);assert.equal((await f.notes.get(r.note.path)).person.phone,'999');
  const bypass=new LlmClient({baseUrl:'https://unused.test',apiKey:'',model:'fixture'},async()=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'edit',type:'function',function:{name:'update_note',arguments:JSON.stringify({path:r.note.path,expectedHash:r.note.contentHash,content:r.note.content})}}]},finish_reason:'stop'}]})));
  await assert.rejects(new Agent({vault:f.vault,llm:bypass,mode:'note',noteWriter:new NoteModeService(f.vault,f.mutations).writer('ai-bypass-update')}).run({text:'Обнови'}),/прочитать/);
});
test('full import preserves all long text, original/manifest and Git commit; repeat content deduplicates after chat clear',async t=>{
  const f=await fixture(t,true),chat=f.db.chats.create(1,'import-chat-entry','UTC'),bytes=Buffer.from('Начало\n'+('Большой документ.\n'.repeat(8000))+'КОНЕЦ');const a=await upload(f.db.chats,1,chat.id,'long.txt',bytes);
  const note={title:'Документ',category:'study'},r=await f.imports.import(1,chat.id,a.id,note,'import-full-request');assert.equal(r.status,'complete');assert.equal(r.receipt.state,'committed');assert.equal((await f.imports.original(r.assetId)).bytes.equals(bytes),true);assert.match((await f.notes.get(r.notePath)).body,/КОНЕЦ/);
  const manifest=JSON.parse(await fs.readFile(f.vault.resolve(r.manifestPath),'utf8'));assert.equal(manifest.originalHash,hashBytes(bytes));assert.equal(manifest.pages[0].characters,bytes.toString().length);
  const committed=(await exec('git',['show','--format=','--name-only','HEAD'],{cwd:f.vault.root})).stdout;for(const p of [r.originalPath,r.notePath,r.manifestPath])assert.ok(committed.includes(p));
  assert.equal((await f.imports.import(1,chat.id,a.id,note,'import-full-request')).assetId,r.assetId);await assert.rejects(f.imports.import(1,chat.id,a.id,{...note,title:'Other'},'import-full-request'),/другого импорта/);
  f.db.chats.clear(1,chat.id);assert.equal((await f.imports.original(r.assetId)).bytes.equals(bytes),true);assert.equal((await f.imports.import(1,chat.id,a.id,note,'import-full-request')).notePath,r.notePath);
  const b=await upload(f.db.chats,1,chat.id,'other-name.txt',bytes);assert.equal((await f.imports.import(1,chat.id,b.id,note,'import-full-duplicate')).assetId,r.assetId);assert.equal((await f.notes.list()).items.length,1);
});
test('batch recovery resumes after partial promotion and avoids overwriting a later edit after commit',async t=>{
  const f=await fixture(t,true),files=[{path:'_attachments/fixture/original.bin',bytes:Buffer.from('original')},{path:'Areas/Study/Notes/import.md',bytes:Buffer.from('Complete imported text')},{path:'_attachments/fixture/manifest.json',bytes:Buffer.from('{"complete":true}') }];
  f.db.prepareBatch({operationId:'recover-batch-request',requestHash:'hash',files:files.map(x=>({path:x.path,baseHash:null,contentHash:hashBytes(x.bytes),base64:x.bytes.toString('base64')})),result:{done:true},state:'prepared',commitSha:null,errorCode:null});await fs.mkdir(path.dirname(f.vault.resolve(files[0].path)),{recursive:true});await fs.writeFile(f.vault.resolve(files[0].path),files[0].bytes);
  await f.mutations.recoverIncomplete();assert.equal(f.db.getBatch('recover-batch-request')?.state,'committed');for(const file of files)assert.equal((await fs.readFile(f.vault.resolve(file.path))).equals(file.bytes),true);
  const b=f.db.getBatch('recover-batch-request')!;f.db.updateBatch(b.operationId,'prepared');await fs.writeFile(f.vault.resolve(files[1].path),'External after commit');await f.mutations.recoverIncomplete();assert.equal(await fs.readFile(f.vault.resolve(files[1].path),'utf8'),'External after commit');assert.equal((await exec('git',['rev-list','--count','HEAD'],{cwd:f.vault.root})).stdout.trim(),'1');
});
test('batch target conflicts are found before any target is written and unrelated staged files are excluded',async t=>{
  const f=await fixture(t,true);await fs.writeFile(path.join(f.vault.root,'foreign.md'),'Unrelated');await exec('git',['add','foreign.md'],{cwd:f.vault.root});
  await f.mutations.mutateBatch({operationId:'batch-safe-commit',request:{a:1},prepare:async()=>({result:null,files:[{path:'Notes/own.md',bytes:Buffer.from('Own'),baseHash:null}]})});assert.doesNotMatch((await exec('git',['show','--format=','--name-only','HEAD'],{cwd:f.vault.root})).stdout,/foreign/);
  await fs.writeFile(path.join(f.vault.root,'Notes/conflict.md'),'External');await assert.rejects(f.mutations.mutateBatch({operationId:'batch-preflight-conflict',request:{a:2},prepare:async()=>({result:null,files:[{path:'Notes/never.md',bytes:Buffer.from('Must not write'),baseHash:null},{path:'Notes/conflict.md',bytes:Buffer.from('Overwrite'),baseHash:null}]})}),/изменился/);assert.equal(await f.vault.exists('Notes/never.md'),false);
});
function imageText(){const c=createCanvas(1400,440),x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,1400,440);x.fillStyle='black';x.font='52px Arial';x.fillText('Тест заметки 2026',70,130);x.fillText('Meeting on Monday at 10:00',70,240);return c;}
function mixedPdf(image:Buffer):Buffer {
  const stream=Buffer.from('BT /F1 20 Tf 60 700 Td (Native page 2026) Tj ET'),scan=Buffer.from('q 504 0 0 158 40 500 cm /Im0 Do Q');
  const objects=[Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),Buffer.from('<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>'),Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>'),Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 8 0 R >> >> /Contents 7 0 R >>'),Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),Buffer.concat([Buffer.from('<< /Length '+stream.length+' >>\nstream\n'),stream,Buffer.from('\nendstream')]),Buffer.concat([Buffer.from('<< /Length '+scan.length+' >>\nstream\n'),scan,Buffer.from('\nendstream')]),Buffer.concat([Buffer.from('<< /Type /XObject /Subtype /Image /Width 1400 /Height 440 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length '+image.length+' >>\nstream\n'),image,Buffer.from('\nendstream')])];
  const chunks=[Buffer.from('%PDF-1.4\n')],offsets=[0];for(const [i,obj] of objects.entries()){offsets.push(chunks.reduce((n,b)=>n+b.length,0));chunks.push(Buffer.from((i+1)+' 0 obj\n'),obj,Buffer.from('\nendobj\n'));}const xref=chunks.reduce((n,b)=>n+b.length,0);chunks.push(Buffer.from('xref\n0 '+(objects.length+1)+'\n0000000000 65535 f \n'+offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size '+(objects.length+1)+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF'));return Buffer.concat(chunks);
}
test('local Russian/English image OCR and mixed PDF process text and scan pages independently',async()=>{
  const c=imageText(),photo=await decodeUpload('text.png',c.toBuffer('image/png'),true);assert.match(photo.text,/Тест заметки 2026/);assert.match(photo.text,/Meeting on Monday/);assert.equal(photo.report?.pages[0].method,'ocr');
  const pdf=await decodeUpload('mixed.pdf',mixedPdf(c.toBuffer('image/jpeg')),true);assert.equal(pdf.report?.pages.length,2);assert.equal(pdf.report?.pages[0].method,'text');assert.equal(pdf.report?.pages[1].method,'ocr');assert.match(pdf.text,/Native page 2026/);assert.match(pdf.text,/Meeting on Monday/);
});
test('image dimension limits reject excessive surfaces before native decoding',()=>{
  const b=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.writeUInt32BE(50000,16);b.writeUInt32BE(50000,20);assert.throws(()=>assertImageDimensions(b),/16 млн/);assert.doesNotThrow(()=>assertImageDimensions(imageText().toBuffer('image/png')));
});
test('full DOCX import includes tables, header, footnotes and images, and marks unsupported objects partial',async()=>{
  const img=imageText().toBuffer('image/png'),zip=zipSync({'word/document.xml':strToU8('<w:document><w:p><w:t>Main</w:t></w:p><w:tbl><w:tr><w:tc><w:p><w:t>Cell1</w:t></w:p></w:tc><w:tc><w:p><w:t>Cell2</w:t></w:p></w:tc></w:tr></w:tbl></w:document>'),'word/header1.xml':strToU8('<w:p><w:t>Header</w:t></w:p>'),'word/footnotes.xml':strToU8('<w:p><w:t>Footnote</w:t></w:p>'),'word/media/image1.png':img,'word/embeddings/object.bin':new Uint8Array([1])});
  const r=await decodeUpload('full.docx',Buffer.from(zip),true);for(const text of ['Main','Cell1','Cell2','Header','Footnote'])assert.ok(r.text.includes(text));assert.equal(r.report?.images.length,1);assert.equal(r.report?.status,'partial');assert.match(r.report?.warnings.join(' '),/object.bin/);
});
test('chat memory covers exact message IDs, keeps newest turns separate, and is isolated by chat/device',async t=>{
  const f=await fixture(t),c=f.db.chats.create(1,'memory-chat-entry','UTC'),other=f.db.chats.create(1,'other-chat-entry','UTC');const ids=[];for(let i=0;i<45;i++){ids.push(f.db.chats.add(1,c.id,i%2?'assistant':'user','Turn '+i));f.db.chats.add(1,other.id,'user','other '+i);}
  const r=await f.memory.context(1,c.id,llm('{"summary":"Обсудили планы."}'),new AbortController().signal);assert.equal(r.memory.coverage.length,35);assert.deepEqual(r.memory.coverage.map(x=>x.id),ids.slice(0,35));assert.equal(r.history.length,10);assert.equal(r.history[0].content,'Turn 35');assert.equal(f.db.chats.memory(1,other.id).summary,'');assert.throws(()=>f.db.chats.memory(2,c.id));
  const forged=await f.memory.context(1,c.id,llm('{"summary":"Fake","throughMessageId":99999}'),new AbortController().signal,true);assert.ok(forged.memory.throughMessageId<99999);assert.match(forged.memory.summary,/Turn 44/);
});
test('source changes/delete/rename invalidate summaries and exclude stale facts from model history',async t=>{
  const f=await fixture(t),c=f.db.chats.create(1,'source-chat-entry','UTC'),n=await f.notes.create(fields,'source-note-create'),ref=sourceVersion(n.note.path,n.note.content);
  f.db.chats.add(1,c.id,'user','Телефон Анны?');f.db.chats.add(1,c.id,'assistant','OLD_PHONE_123',{sourceVersions:[ref]});await f.memory.record(1,c.id,{text:'',sources:[ref.path],sourceVersions:[ref],actions:[]});await f.memory.context(1,c.id,null,new AbortController().signal,true);
  await fs.writeFile(f.vault.resolve(n.note.path),n.note.content+'\nNew phone: 456');const changed=await f.memory.context(1,c.id,null,new AbortController().signal);assert.equal(changed.memory.summary,'');assert.equal(changed.memory.sources[0].state,'changed');assert.doesNotMatch(JSON.stringify(changed.history),/OLD_PHONE_123/);
  await fs.writeFile(f.vault.resolve(n.note.path),n.note.content);const newPath='People/Renamed.md';await fs.rename(f.vault.resolve(n.note.path),f.vault.resolve(newPath));assert.equal((await f.memory.inspect(1,c.id)).sources[0].path,newPath);await fs.unlink(f.vault.resolve(newPath));assert.equal((await f.memory.inspect(1,c.id)).sources[0].state,'missing');
});
test('source edit during summary generation prevents committing stale coverage',async t=>{
  const f=await fixture(t),c=f.db.chats.create(1,'summary-race-entry','UTC'),n=await f.notes.create(fields,'summary-race-note');await f.memory.record(1,c.id,{text:'',sources:[],sourceVersions:[sourceVersion(n.note.path,n.note.content)],actions:[]});f.db.chats.add(1,c.id,'user','Discuss');
  const client=new LlmClient({baseUrl:'https://unused.test',apiKey:'',model:'fixture'},async()=>{await fs.writeFile(f.vault.resolve(n.note.path),n.note.content+'Changed');return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'{"summary":"Stale"}'},finish_reason:'stop'}]}));});
  const r=await f.memory.context(1,c.id,client,new AbortController().signal,true);assert.equal(r.memory.summary,'');assert.deepEqual(r.memory.coverage,[]);
});
test('memory expiry/clear uses the original chat TTL; permanent original remains outside short-lived database',async t=>{
  const f=await fixture(t);let now=Date.now();const s=new ChatStore(path.join(f.root,'clock.sqlite'),()=>now),m=new ChatMemoryService(s,f.vault);try{const c=s.create(1,'clock-memory-entry','UTC');s.add(1,c.id,'user','Temporary');await m.context(1,c.id,null,new AbortController().signal,true);now+=CHAT_RETENTION_MS-1;assert.equal(s.memory(1,c.id).summary.includes('Temporary'),true);now++;assert.throws(()=>s.memory(1,c.id));s.prune();}finally{s.close();}
  const c=f.db.chats.create(1,'clear-memory-entry','UTC');f.db.chats.add(1,c.id,'user','Temporary');await f.memory.context(1,c.id,null,new AbortController().signal,true);f.db.chats.clear(1,c.id);assert.equal(f.db.chats.memory(1,c.id).summary,'');
});
test('deleting a covered message invalidates summary, without trusting a surviving high checkpoint',async t=>{
  const f=await fixture(t),c=f.db.chats.create(1,'coverage-delete-entry','UTC'),id=f.db.chats.add(1,c.id,'user','Sensitive temporary fact');f.db.chats.add(1,c.id,'assistant','Acknowledged');await f.memory.context(1,c.id,null,new AbortController().signal,true);
  const sql=new DatabaseSync(path.join(f.root,'relay.chats.sqlite'));try{sql.prepare('DELETE FROM messages WHERE id=?').run(id);}finally{sql.close();}
  const m=await f.memory.inspect(1,c.id);assert.equal(m.summary,'');assert.deepEqual(m.coverage,[]);
});
test('authenticated notes/import/memory APIs work together and original download survives history deletion',async t=>{
  const f=await fixture(t),paired=f.db.createDevice('stage4','app'),quick=f.db.createDevice('quick','quick');const app=await createServer(f.cfg);f.beforeCleanup.push(()=>app.close());const h={authorization:'Bearer '+paired.token},c=(await app.inject({method:'POST',url:'/api/chats',headers:h,payload:{entryId:'api-stage4-entry',timezone:'UTC'}})).json();
  assert.equal((await app.inject({method:'GET',url:'/api/notes',headers:{authorization:'Bearer '+quick.token}})).statusCode,401);
  const note=(await app.inject({method:'POST',url:'/api/notes',headers:h,payload:{operationId:'api-note-create',note:fields}})).json();assert.equal(note.note.title,'Анна');
  const saved=await app.inject({method:'PATCH',url:'/api/notes/document',headers:h,payload:{operationId:'api-note-update',path:note.note.path,expectedContentHash:note.note.contentHash,edit:{fields:{...fields,body:'Edited'}}}});assert.equal(saved.statusCode,200);
  const bytes=Buffer.from('Import this text.');const uploadRes=await app.inject({method:'POST',url:'/api/attachments?chatId='+c.id+'&name=test.txt',headers:{...h,'content-type':'application/octet-stream'},payload:bytes});assert.equal(uploadRes.statusCode,201);const file=uploadRes.json();
  const imported=await app.inject({method:'POST',url:'/api/attachments/'+file.id+'/import',headers:h,payload:{chatId:c.id,note:{title:'Imported',category:'personal'},operationId:'api-import-request'}});assert.equal(imported.statusCode,200);const asset=imported.json();
  await app.inject({method:'POST',url:'/api/chat',headers:h,payload:{chatId:c.id,expectedVersion:c.version,requestId:'api-summary-message',text:'/quick Remember this',attachmentIds:[]}});
  const queued=await app.inject({method:'POST',url:'/api/chats/'+c.id+'/memory',headers:h});assert.equal(queued.json().refresh.state,'queued');
  let memory=await app.inject({method:'GET',url:'/api/chats/'+c.id+'/memory',headers:h});
  for(let i=0;i<100&&memory.json().refresh.state==='queued';i++){await new Promise(r=>setTimeout(r,10));memory=await app.inject({method:'GET',url:'/api/chats/'+c.id+'/memory',headers:h});}
  assert.equal(memory.statusCode,200);assert.ok(memory.json().summary.includes('Remember this'));
  await app.inject({method:'DELETE',url:'/api/messages?chat='+c.id,headers:h});const original=await app.inject({method:'GET',url:'/api/assets/'+asset.assetId+'/original',headers:h});assert.equal(original.statusCode,200);assert.equal(original.rawPayload.equals(bytes),true);assert.equal((await app.inject({method:'GET',url:'/api/assets/'+asset.assetId+'/original'})).statusCode,401);
});
