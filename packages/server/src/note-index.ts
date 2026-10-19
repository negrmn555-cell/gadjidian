import { randomUUID } from 'node:crypto';
import { parseFrontmatter, parseMarkdownDocument, getSearchIndex, DomainError, hashContent, resolveVaultLink, readTaskDocument, type ParsedDocument, type Vault, type TaskPage } from '@relay/core';
import type { Db } from './db.js';
import type { VaultMutationService } from './vault-mutations.js';
export interface IndexedNote { path:string; id:string|null; hash:string; semanticHash:string; title:string; kind:string; tags:string[]; keywords:string[]; aliases:string[]; content:string; updatedAt:string|null; metadata:Record<string,unknown> }
function snapshot(parsed:ParsedDocument):IndexedNote {
  if(parsed.metadataError)throw new Error('INVALID_YAML');
  const meta=parsed.metadata,semantic={...meta};for(const key of ['id','relay_id','updated_at','created_at'])delete semantic[key];
  return {path:parsed.path,id:parsed.noteId,hash:parsed.contentHash,semanticHash:hashContent(JSON.stringify(semantic)+'\n'+parsed.body),title:parsed.title,kind:parsed.kind,tags:parsed.tags,keywords:parsed.keywords,aliases:parsed.aliases,content:parsed.content,metadata:meta,updatedAt:typeof meta.updated_at==='string'?meta.updated_at:null};
}
export function noteSnapshot(content:string,p:string):IndexedNote {return snapshot(parseMarkdownDocument(p,content));}
export class NoteIndex {
  private view?:{key:string;notes:IndexedNote[];invalid:{path:string;error:string}[]};
  private taskErrors=new Map<string,string>();
  constructor(private vault:Vault,private db:Db){}
  async refresh(force=true):Promise<{notes:IndexedNote[];invalid:{path:string;error:string}[]}> {
    return this.vault.readConsistent(async()=>{
      const search=getSearchIndex(this.vault),documents=await search.documents(force),notes:IndexedNote[]=[],invalid:{path:string;error:string}[]=[];
      const key=JSON.stringify([search.revision,this.vault.config.privateFolders,this.vault.config.ignoreFolders]);
      if(this.view?.key===key)return this.view;
      const previous=new Map(this.view?.notes.map(n=>[n.path,n])??[]);
      const old=this.db.sql.prepare('SELECT path,content_hash FROM note_index').all() as {path:string;content_hash:string}[];
      const hashes=new Map(old.map(r=>[r.path,r.content_hash]));
      for(const {parsed} of documents)try{const old=previous.get(parsed.path);notes.push(old?.hash===parsed.contentHash?old:snapshot(parsed));}catch{invalid.push({path:parsed.path,error:'Некорректные метаданные или недоступный файл.'});}
      const live=new Set(notes.map(n=>n.path)),removed=old.filter(r=>!live.has(r.path)),changed=notes.filter(n=>hashes.get(n.path)!==n.hash);
      if(removed.length||changed.length)this.db.providerTransaction(()=>{
        for(const {path} of removed){this.db.sql.prepare('DELETE FROM note_index WHERE path=?').run(path);this.db.sql.prepare('DELETE FROM note_links WHERE from_path=?').run(path);this.db.sql.prepare('DELETE FROM task_projection WHERE path=?').run(path);this.taskErrors.delete(path);}
        for(const n of changed){
          const {content:_content,...value}=n;
          this.db.sql.prepare('INSERT INTO note_index(path,note_id,content_hash,semantic_hash,value_json) VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET note_id=excluded.note_id,content_hash=excluded.content_hash,semantic_hash=excluded.semantic_hash,value_json=excluded.value_json').run(n.path,n.id,n.hash,n.semanticHash,JSON.stringify(value));
          this.db.sql.prepare('DELETE FROM task_projection WHERE path=?').run(n.path);
          this.taskErrors.delete(n.path);
          if(n.kind==='task')try{const task=readTaskDocument(n.content,n.path);if(task)this.db.sql.prepare('INSERT INTO task_projection(task_id,path,value_json) VALUES(?,?,?)').run(task.id,n.path,JSON.stringify(task));}catch{this.taskErrors.set(n.path,'Некорректные поля управляемой задачи.');}
        }
        const pathSetChanged=removed.length>0||changed.some(n=>!hashes.has(n.path));
        const linksFor=pathSetChanged?documents:documents.filter(d=>changed.some(n=>n.path===d.meta.path));
        const paths=notes.map(n=>n.path);
        for(const {parsed} of linksFor){this.db.sql.prepare('DELETE FROM note_links WHERE from_path=?').run(parsed.path);if(parsed.metadataError)continue;for(const link of parsed.links){const r=resolveVaultLink(link,parsed.path,paths);this.db.sql.prepare('INSERT INTO note_links(from_path,target_path,ambiguous) VALUES(?,?,?)').run(parsed.path,r.path,r.ambiguous?1:0);}}
      });
      if(!this.view)for(const n of notes)if(n.kind==='task'&&!this.taskErrors.has(n.path))try{readTaskDocument(n.content,n.path);}catch{this.taskErrors.set(n.path,'Некорректные поля управляемой задачи.');}
      for(const [path,error] of this.taskErrors)if(live.has(path))invalid.push({path,error});
      const ids=new Map<string,string[]>();for(const n of notes)if(n.id)ids.set(n.id,[...(ids.get(n.id)??[]),n.path]);for(const paths of ids.values())if(paths.length>1)for(const path of paths)invalid.push({path,error:'Повторяющийся идентификатор заметки.'});
      this.view={key,notes,invalid};return this.view;
    });
  }
  async tasks():Promise<TaskPage> {
    const {invalid}=await this.refresh(false),records=this.db.sql.prepare('SELECT task_id,value_json FROM task_projection').all() as {task_id:string;value_json:string}[];
    const counts=new Map<string,number>();records.forEach(r=>counts.set(r.task_id,(counts.get(r.task_id)??0)+1));
    return {items:records.filter(r=>counts.get(r.task_id)===1).map(r=>JSON.parse(r.value_json)),invalidRecords:[...invalid,...records.filter(r=>counts.get(r.task_id)!==1).map(r=>({path:JSON.parse(r.value_json).path,error:'Повторяющийся ID задачи.'}))]};
  }
  async backfill(mutations:VaultMutationService,operationId:string,limit=64) {
    return mutations.mutateBatch({operationId,request:{kind:'note-id-backfill',limit},prepare:async()=>{
      const {notes,invalid}=await this.refresh(),candidates=notes.filter(n=>!n.id&&n.kind!=='task').slice(0,limit);
      if(!candidates.length)throw new DomainError('NO_BACKFILL_REQUIRED','Все доступные заметки уже имеют ID.',409);
      const files=candidates.map(n=>{const {doc,body}=parseFrontmatter(n.content);doc.set('id','note_'+randomUUID());return {path:n.path,baseHash:n.hash,bytes:Buffer.from('---\n'+doc.toString()+'---\n'+body)};});
      return {files,result:{count:files.length,remaining:notes.filter(n=>!n.id&&n.kind!=='task').length-files.length,invalid}};
    }});
  }
}
