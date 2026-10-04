import { randomUUID } from 'node:crypto';
import { parseDocument, Document } from 'yaml';
import { DomainError, hashContent, sourceVersion, vaultLinks, resolveVaultLink, readTaskDocument, type Vault, type TaskPage } from '@relay/core';
import type { Db } from './db.js';
import type { VaultMutationService } from './vault-mutations.js';
export interface IndexedNote { path:string; id:string|null; hash:string; semanticHash:string; title:string; kind:string; tags:string[]; keywords:string[]; aliases:string[]; content:string; updatedAt:string|null; metadata:Record<string,unknown> }
export function noteSnapshot(content:string,p:string):IndexedNote {
  const match=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  const doc=match?parseDocument(match[1],{uniqueKeys:true}):new Document();
  if(doc.errors.length)throw new Error('INVALID_YAML');
  const meta=(doc.toJS({maxAliasCount:32})??{}) as Record<string,unknown>;
  if(typeof meta!=='object'||Array.isArray(meta))throw new Error('INVALID_YAML');
  const semantic={...meta};for(const key of ['id','relay_id','updated_at','created_at'])delete semantic[key];
  const arr=(value:unknown)=>Array.isArray(value)?value.filter((s):s is string=>typeof s==='string'):[];
  return {path:p,id:sourceVersion(p,content).noteId,hash:hashContent(content),semanticHash:hashContent(JSON.stringify(semantic)+'\n'+content.slice(match?.[0].length??0)),title:typeof meta.title==='string'?meta.title:p.split('/').pop()!.replace(/\.md$/,''),kind:String(meta.type??'quick'),tags:arr(meta.tags),keywords:arr(meta.keywords),aliases:arr(meta.aliases),content,metadata:meta,updatedAt:typeof meta.updated_at==='string'?meta.updated_at:null};
}
export class NoteIndex {
  constructor(private vault:Vault,private db:Db){}
  async refresh():Promise<{notes:IndexedNote[];invalid:{path:string;error:string}[]}> {
    const notes:IndexedNote[]=[],invalid:{path:string;error:string}[]=[];
    for(const p of await this.vault.listNotes())try{
      const content=(await this.vault.readNote(p.path)).content,hash=hashContent(content);
      const old=this.db.sql.prepare('SELECT value_json FROM note_index WHERE path=? AND content_hash=?').get(p.path,hash) as {value_json:string}|undefined;
      const note=old?{...JSON.parse(old.value_json),content} as IndexedNote:noteSnapshot(content,p.path);
      notes.push(note);
    }catch{invalid.push({path:p.path,error:'Некорректные метаданные или недоступный файл.'});}
    this.db.providerTransaction(()=>{
      this.db.sql.exec('DELETE FROM note_index; DELETE FROM note_links; DELETE FROM task_projection;');
      const insert=this.db.sql.prepare('INSERT INTO note_index(path,note_id,content_hash,semantic_hash,value_json) VALUES(?,?,?,?,?)');
      const paths=notes.map(n=>n.path);
      for(const n of notes){const {content:_content,...value}=n;insert.run(n.path,n.id,n.hash,n.semanticHash,JSON.stringify(value));
        for(const link of vaultLinks(n.content)){const r=resolveVaultLink(link,n.path,paths);this.db.sql.prepare('INSERT INTO note_links(from_path,target_path,ambiguous) VALUES(?,?,?)').run(n.path,r.path,r.ambiguous?1:0);}
        try{const task=readTaskDocument(n.content,n.path);if(task)this.db.sql.prepare('INSERT INTO task_projection(task_id,path,value_json) VALUES(?,?,?)').run(task.id,n.path,JSON.stringify(task));}catch{invalid.push({path:n.path,error:'Некорректные поля управляемой задачи.'});}
      }
    });
    return {notes,invalid};
  }
  async tasks():Promise<TaskPage> {
    const {invalid}=await this.refresh();const records=this.db.sql.prepare('SELECT task_id,value_json FROM task_projection').all() as {task_id:string;value_json:string}[];
    const counts=new Map<string,number>();records.forEach(r=>counts.set(r.task_id,(counts.get(r.task_id)??0)+1));
    return {items:records.filter(r=>counts.get(r.task_id)===1).map(r=>JSON.parse(r.value_json)),invalidRecords:[...invalid,...records.filter(r=>counts.get(r.task_id)!==1).map(r=>({path:JSON.parse(r.value_json).path,error:'Повторяющийся ID задачи.'}))]};
  }
  async backfill(mutations:VaultMutationService,operationId:string,limit=64) {
    return mutations.mutateBatch({operationId,request:{kind:'note-id-backfill',limit},prepare:async()=>{
      const {notes,invalid}=await this.refresh();const candidates=notes.filter(n=>!n.id&&n.kind!=='task').slice(0,limit);
      if(!candidates.length)throw new DomainError('NO_BACKFILL_REQUIRED','Все доступные заметки уже имеют ID.',409);
      const files=candidates.map(n=>{const m=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(n.content),doc=m?parseDocument(m[1]):new Document();doc.set('id','note_'+randomUUID());return {path:n.path,baseHash:n.hash,bytes:Buffer.from('---\n'+doc.toString()+'---\n'+n.content.slice(m?.[0].length??0))};});
      return {files,result:{count:files.length,remaining:notes.filter(n=>!n.id&&n.kind!=='task').length-files.length,invalid}};
    }});
  }
}
