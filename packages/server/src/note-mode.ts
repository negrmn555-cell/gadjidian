import { randomUUID } from 'node:crypto';
import { DomainError, objectInput, sanitizeFileName, searchNotes, hashContent, readTaskDocument, type Vault, type Category } from '@relay/core';
import type { VaultMutationService } from './vault-mutations.js';
import { NoteService } from './notes.js';

const folders={study:'Study',work:'Work',personal:'Personal'};
const stop=new Set(['что','как','для','или','это','его','она','они','мне','меня','надо','нужно','есть','будет','быть','этот','этого','the','and','with','note']);
function keywords(text:string):string[]{return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)??[]).filter(x=>!stop.has(x)))].slice(0,12);}
function category(text:string,value:unknown):Category {
  if(value!==undefined && !['study','work','personal'].includes(String(value))) throw new DomainError('INVALID_CATEGORY','Некорректная категория заметки.');
  return value as Category ?? (/учеб|учёб|экзамен|лекци|семинар|университет/i.test(text)?'study':/работ|клиент|проект|коллег|совещан/i.test(text)?'work':'personal');
}
function body(value:unknown):string {
  if(typeof value!=='string'||!value.trim()||value.length>100_000) throw new DomainError('INVALID_NOTE','Укажите текст заметки до 100 000 символов.');
  return value;
}
export class NoteModeService {
  constructor(private readonly vault:Vault,private readonly mutations:VaultMutationService){}
  writer(operationId:string,signal?:AbortSignal): (name:string,args:Record<string,unknown>)=>Promise<{text:string;path?:string}> {
    let index=0;
    return (name,args)=>{
      if(index>=8)throw new DomainError('WRITE_LIMIT','За запрос можно изменить не более восьми заметок.');
      return this.write(name,args,operationId+'_'+index++,signal);
    };
  }
  async write(name:string,args:Record<string,unknown>,operationId:string,signal?:AbortSignal):Promise<{text:string;path?:string}>{
    if(signal?.aborted)throw new DomainError('CANCELLED','Запрос отменён.');
    if(name==='update_note'){
      const result=await new NoteService(this.vault,this.mutations).update(String(args.path??''),{content:body(args.content)},String(args.expectedHash??''),operationId,signal,true);
      return {text:'Изменено: [['+result.note.path.replace(/\.md$/,'')+']]',path:result.note.path};
    }
    if(name==='update_note'){
      const result=await new NoteService(this.vault,this.mutations).update(String(args.path??''),{content:body(args.content)},String(args.expectedHash??''),operationId,signal);
      return {text:'Изменено: [['+result.note.path.replace(/\.md$/,'')+']]',path:result.note.path};
    }
    if(name==='append_note') return this.append(String(args.path??''),body(args.text),operationId,signal);
    const kind=name==='create_note'?args.kind:name;
    if(!['quick','idea','person'].includes(String(kind))) throw new DomainError('MODE_ACTION_NOT_ALLOWED','В режиме заметки можно записать заметку, идею или человека.');
    let content=body(args.content); let title=typeof args.title==='string'?args.title.trim():content.split('\n')[0].slice(0,80);
    if(kind==='person') {
      const parts=content.split(/\s*\|\s*|\r?\n/);
      if(name==='person') {title=parts.shift()?.trim()??'';content=parts.join('\n').trim();}
      if(!title || !content) return {text:'Укажите имя и сведения: /person Имя | информация о человеке.'};
      const matches=[];
      for(const meta of await this.vault.listNotes('People')){
        try{const card=await new NoteService(this.vault,this.mutations).get(meta.path);if(card.kind==='person'&&(card.title.toLowerCase()===title.toLowerCase()||card.aliases.some(a=>a.toLowerCase()===title.toLowerCase())||card.path===title))matches.push(card);}catch{}
      }
      if(matches.length>1) return {text:'Найдено несколько карточек. Укажите полный путь вместо имени:\n'+matches.map(p=>'- '+p.path).join('\n')};
      if(matches.length===1) return this.append(matches[0].path,content,operationId,signal);
    }
    if(!title||title.length>200) throw new DomainError('INVALID_NOTE','Укажите короткое название заметки.');
    const tags=keywords(title+' '+content),cat=category(title+' '+content,args.category);
    const related=await this.related(tags);
    const folder=kind==='person'?'People':'Areas/'+folders[cat]+'/'+(kind==='idea'?'Ideas':'Notes');
    const notePath=folder+'/'+sanitizeFileName(title)+(kind==='person'?'':'-'+operationId.slice(-12))+'.md';
    const front={relay_schema:1,id:'note_'+randomUUID(),type:kind,category:cat,keywords:tags,tags:[cat,kind],created_at:new Date().toISOString()};
    const markdown='---\n'+Object.entries(front).map(([k,v])=>k+': '+JSON.stringify(v)).join('\n')+'\n---\n\n# '+title+'\n\n'+content+(related.length?'\n\n## Связанные заметки\n'+related.map(p=>'- [['+p.replace(/\.md$/,'')+']]').join('\n'):'')+'\n';
    const receipt=await this.mutations.mutate({operationId,request:{kind:'note-create',title,content,noteKind:kind,category:cat},prepare:async()=>{if(signal?.aborted)throw new DomainError('CANCELLED','Запрос отменён.');return {path:notePath,content:markdown,baseHash:null};}});
    return {text:'Сохранено: [['+receipt.path.replace(/\.md$/,'')+']]',path:receipt.path};
  }
  private async related(words:string[]):Promise<string[]>{
    if(!words.length)return [];
    const hits=await searchNotes(this.vault,words.slice(0,5).join(' '),{limit:5});
    return hits.filter(h=>h.score>0).map(h=>h.path);
  }
  private async append(path:string,text:string,operationId:string,signal?:AbortSignal):Promise<{text:string;path?:string}>{
    const receipt=await this.mutations.mutate({operationId,request:{kind:'note-append',path,text},prepare:async()=>{
      const note=await this.vault.readNote(path);
      if(readTaskDocument(note.content,note.path) || /^Areas\/[^/]+\/Tasks\//i.test(note.path)) throw new DomainError('MODE_ACTION_NOT_ALLOWED','Задачу нельзя изменять через режим заметки.');
      const words=keywords(text),links=(await this.related(words)).filter(p=>p!==path&&!note.content.includes('[['+p.replace(/\.md$/,'')+']]'));
      if(signal?.aborted)throw new DomainError('CANCELLED','Запрос отменён.');
      return {path:note.path,baseHash:hashContent(note.content),content:note.content.trimEnd()+'\n\n'+text+'\n'+(words.length?'\nКлючевые слова: '+words.join(', ')+'\n':'')+(links.length?'\nСвязи: '+links.map(p=>'[['+p.replace(/\.md$/,'')+']]').join(', ')+'\n':'')};
    }});
    return {text:'Дополнено: [['+receipt.path.replace(/\.md$/,'')+']]',path:receipt.path};
  }
}
