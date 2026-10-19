import { isPreferencesPath } from '@relay/core';
import { randomUUID } from 'node:crypto';
import { Document, parseDocument, isMap } from 'yaml';
import { DomainError, objectInput, hashContent, readTaskDocument, sanitizeFileName, searchNotes, parseFrontmatter, getSearchIndex, type Vault, type NoteCreateInput, type NoteRecord, type NotePage, type NoteEditInput, type NoteWriteResult } from '@relay/core';
import type { VaultMutationService } from './vault-mutations.js';

const folders = { study: 'Study', work: 'Work', personal: 'Personal' };
export function noteKeywords(text: string): string[] {
  const stop = new Set(['для','как','что','это','или','при','the','and','with']);
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(w => !stop.has(w)))].slice(0, 16);
}
function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some(v => typeof v !== 'string' || v.length > 120 || /[\r\n\0]/.test(v))) throw new DomainError('INVALID_NOTE', 'Некорректное поле '+field+'.');
  return [...new Set(value.map(v => v.trim()).filter(Boolean))];
}
export function validateNote(value: unknown): NoteCreateInput {
  const v = objectInput(value), p = objectInput(v.person);
  if (typeof v.title !== 'string' || !v.title.trim() || v.title.length > 200 || /[\r\n\0]/.test(v.title) || typeof v.body !== 'string' || !v.body.trim() || v.body.length > 1_000_000 || v.body.includes('\0')) throw new DomainError('INVALID_NOTE', 'Укажите заголовок и текст заметки (до 1 млн символов).');
  if (!['quick','idea','person'].includes(String(v.kind)) || !['study','work','personal'].includes(String(v.category))) throw new DomainError('INVALID_NOTE', 'Проверьте тип и категорию заметки.');
  for (const k of ['phone','email','role']) if (typeof p[k] !== 'string' || String(p[k]).length > 300 || /[\r\n\0]/.test(String(p[k]))) throw new DomainError('INVALID_NOTE', 'Некорректные сведения о человеке.');
  return { title: v.title.trim(), body: v.body, kind: v.kind as NoteCreateInput['kind'], category: v.category as NoteCreateInput['category'], tags: strings(v.tags,'tags'), keywords: strings(v.keywords,'keywords'), aliases: strings(v.aliases,'aliases'), person: {phone:p.phone as string,email:p.email as string,role:p.role as string} };
}
function split(content: string) {
  const parsed = parseFrontmatter(content);
  return { ...parsed, body: parsed.body.replace(/^\s*\n/, '') };
}
function assertOrdinary(path: string, content: string): void {
  if (!path.toLowerCase().endsWith('.md') || /^Areas\/[^/]+\/Tasks\//i.test(path) || readTaskDocument(content,path)) throw new DomainError('NOTE_NOT_EDITABLE', 'Управляемые задачи изменяются в области задач.');
}
export function readNoteRecord(path: string, content: string, updatedAt: number): NoteRecord {
  assertOrdinary(path,content);
  const {metadata:m,body}=split(content);
  const list=(v:unknown)=>Array.isArray(v)?v.filter(x=>typeof x==='string') as string[]:typeof v==='string'?[v]:[];
  const kind:NoteRecord['kind']=['quick','idea','person'].includes(String(m.type))?m.type as NoteRecord['kind']:/^People\//i.test(path)?'person':'quick';
  return {id:typeof m.id==='string'?m.id:null,path,content,contentHash:hashContent(content),updatedAt,title:typeof m.title==='string'?m.title:(/^#\s+(.+)$/m.exec(body)?.[1]??path.split('/').at(-1)!.replace(/\.md$/i,'')),body,kind,category:['study','work','personal'].includes(String(m.category))?m.category as NoteRecord['category']:'personal',tags:list(m.tags),keywords:list(m.keywords),aliases:list(m.aliases),person:{phone:typeof m.phone==='string'?m.phone:'',email:typeof m.email==='string'?m.email:'',role:typeof m.role==='string'?m.role:''}};
}
export class NoteService {
  constructor(readonly vault: Vault, private readonly mutations: VaultMutationService) {}
  async list(query=''): Promise<NotePage> {
    const items:NotePage['items']=[],invalidRecords:NotePage['invalidRecords']=[];
    const documents = await getSearchIndex(this.vault).documents();
    const matches = query ? new Set((await searchNotes(this.vault, query, { limit: 100 })).map(h => h.path)) : null;
    for (const { meta, parsed } of documents.sort((a,b)=>b.meta.mtime-a.meta.mtime)) {
      if (/^Areas\/[^/]+\/Tasks\//i.test(meta.path)) continue;
      try { if(matches && !matches.has(meta.path))continue; const n=readNoteRecord(meta.path,parsed.content,meta.mtime); const {content:_c,body:_b,...brief}=n; items.push(brief); }
      catch(e) { if(e instanceof DomainError && e.code==='NOTE_NOT_EDITABLE')continue; invalidRecords.push({path:meta.path,error:e instanceof DomainError?e.message:'Не удалось прочитать заметку.'}); }
    }
    return {items,invalidRecords};
  }
  async get(path:string):Promise<NoteRecord> { const n=await this.vault.readNote(path); return readNoteRecord(n.path,n.content,n.mtime); }
  async create(value:unknown,operationId:string):Promise<NoteWriteResult> {
    const fields=validateNote(value), id='note_'+randomUUID();
    const receipt=await this.mutations.mutate({operationId,request:{kind:'manual-note-create',fields},prepare:async()=>{
      const folder=fields.kind==='person'?'People':'Areas/'+folders[fields.category]+'/'+(fields.kind==='idea'?'Ideas':'Notes');
      const path=folder+'/'+sanitizeFileName(fields.title)+'-'+hashContent(operationId).slice(0,12)+'.md';
      const related=(await searchNotes(this.vault,(fields.keywords.length?fields.keywords:noteKeywords(fields.title+' '+fields.body)).slice(0,5).join(' '),{limit:5})).filter(n=>n.score>0);
      const body=fields.body+(related.length?'\n\n## Связанные заметки\n'+related.map(n=>'- [['+n.path.replace(/\.md$/i,'')+']]').join('\n'):'');
      return {path,baseHash:null,content:this.render('',{...fields,body},id)};
    }});
    return {note:await this.get(receipt.path),receipt};
  }
  async update(path:string,value:NoteEditInput,expectedHash:string,operationId:string,signal?:AbortSignal,preserveUnknown=false):Promise<NoteWriteResult> {
    if(isPreferencesPath(path))throw new DomainError('PREFERENCES_PROTECTED','Изменяйте правила через раздел памяти.',403);
    if (!/^[a-f0-9]{64}$/.test(expectedHash))throw new DomainError('INVALID_HASH','Для сохранения нужна версия заметки.');
    if (!!value.fields === (typeof value.content==='string'))throw new DomainError('INVALID_NOTE','Передайте поля или полный исходник заметки.');
    const fields=value.fields?validateNote(value.fields):null;
    if(typeof value.content==='string' && (!value.content.trim() || value.content.length>1_100_000 || value.content.includes('\0')))throw new DomainError('INVALID_NOTE','Некорректный текст заметки.');
    const receipt=await this.mutations.mutate({operationId,request:{kind:'note-edit',path,expectedHash,value},prepare:async()=>{
      const old=await this.get(path);
      if(old.contentHash!==expectedHash)throw new DomainError('VERSION_CONFLICT','Заметка изменилась в Obsidian. Ваш черновик сохранён в редакторе; загрузите актуальную версию и сравните.',409);
      let content=fields?this.render(old.content,fields,old.id??'note_'+randomUUID()):value.content!;
      assertOrdinary(old.path,content); const next=split(content);
      if(preserveUnknown){
        const previous=split(old.content),allowed=new Set(['title','type','category','tags','keywords','aliases','phone','email','role','updated_at']);
        for(const [key,val] of Object.entries(previous.metadata))if(!allowed.has(key)){
          if(JSON.stringify(val)!==JSON.stringify(next.metadata[key]))throw new DomainError('NOTE_METADATA_LOSS','ИИ попытался изменить или удалить служебные/неизвестные YAML-поля. Используйте ручной редактор.');
        }
        for(const key of allowed){if(next.doc.has(key))previous.doc.set(key,next.metadata[key]);else previous.doc.delete(key);}
        content='---\n'+previous.doc.toString()+'---\n\n'+next.body;
      }
      if(old.id && next.metadata.id!==old.id)throw new DomainError('NOTE_ID_IMMUTABLE','ID существующей заметки нельзя изменять.');
      if(!old.id){next.doc.set('id','note_'+randomUUID());content='---\n'+next.doc.toString()+'---\n\n'+next.body;}
      if(signal?.aborted)throw new DomainError('CANCELLED','Запрос отменён.');
      return {path:old.path,baseHash:expectedHash,content};
    }});
    return {note:await this.get(receipt.path),receipt};
  }
  private render(old:string,f:NoteCreateInput,id:string):string {
    const {doc}=split(old); doc.set('id',id);doc.set('relay_schema',1);
    for (const [k,v] of Object.entries({title:f.title,type:f.kind,category:f.category,tags:f.tags,keywords:f.keywords.length?f.keywords:noteKeywords(f.title+' '+f.body),aliases:f.aliases,updated_at:new Date().toISOString()}))doc.set(k,v);
    if(!doc.has('created_at'))doc.set('created_at',new Date().toISOString());
    if(f.kind==='person')for(const [k,v] of Object.entries(f.person))doc.set(k,v);
    return '---\n'+doc.toString()+'---\n\n'+f.body.trimEnd()+'\n';
  }
}
