import { promises as fs } from 'node:fs';
import { DomainError, VaultError, PREFERENCES_PATH, PREFERENCES_MAX_BYTES, emptyPreferences, hashContent, parseMarkdownDocument, objectInput, type PreferenceFields, type PreferenceMemory, type Vault } from '@relay/core';
import type { ChatStore } from './chat-store.js';
import type { VaultMutationService } from './vault-mutations.js';

const headings={communication:'Общение',organization:'Хранилище',rules:'Рабочие правила'} as const;
export function preferenceFields(value:unknown):PreferenceFields {
  const input=objectInput(value);if(Object.keys(input).some(k=>!Object.hasOwn(headings,k)))throw new DomainError('PREFERENCES_INVALID','Неизвестный раздел памяти.');
  for(const k of Object.keys(headings))if(typeof input[k]!=='string'||String(input[k]).length>4000||/[\u0000]/.test(String(input[k]))||/^##\s/m.test(String(input[k])))throw new DomainError('PREFERENCES_INVALID','Раздел памяти должен содержать до 4000 символов без заголовков ##. Разделы создаются автоматически.');
  return input as unknown as PreferenceFields;
}
function render(fields:PreferenceFields):string {
  const result='---\nassistant_preferences: 1\n---\n\n# Предпочтения ассистента\n\n'+Object.entries(headings).map(([key,title])=>'## '+title+'\n\n'+fields[key as keyof PreferenceFields].trim()+'\n').join('\n');
  if(Buffer.byteLength(result)>PREFERENCES_MAX_BYTES)throw new DomainError('PREFERENCES_INVALID','Память превышает 16 КБ. Сократите правила.');return result;
}
export function rememberCommand(text:string):string|null {
  const match=/^(?:\/remember\s+|запомни\s*[, :]?\s*что\s+)([\s\S]+)$/i.exec(text.trim());return match?match[1].trim():null;
}
export class PreferencesMemory {
  constructor(private vault:Vault,private mutations:VaultMutationService,private store:ChatStore){}
  async inspect():Promise<PreferenceMemory>{
    const base={path:PREFERENCES_PATH,hash:null,fields:emptyPreferences()};
    return this.vault.readConsistent(async()=>{try{
      const absolute=await this.vault.safePath(PREFERENCES_PATH),stat=await fs.stat(absolute);
      if(stat.size>PREFERENCES_MAX_BYTES)return {...base,status:'invalid',warning:'Файл памяти превышает 16 КБ. Правила не применены.'};
      const note=await this.vault.readNote(PREFERENCES_PATH),hash=hashContent(note.content),parsed=parseMarkdownDocument(PREFERENCES_PATH,note.content);
      if(parsed.metadataError||parsed.metadata.assistant_preferences!==1) return {...base,hash,status:'invalid',warning:'Неверная схема памяти. Правила не применены.'};
      const fields=emptyPreferences();let active:keyof PreferenceFields|null=null;
      for(const node of parsed.ast.children??[]){
        if(node.type==='heading'&&node.depth===2){const title=(node.children??[]).map(n=>n.value??'').join('');active=(Object.keys(headings) as (keyof PreferenceFields)[]).find(k=>headings[k]===title)??null;}
        else if(active&&node.position){const start=parsed.bodyOffset+(node.position.start.offset??0),end=parsed.bodyOffset+(node.position.end.offset??0);fields[active]+=(fields[active]?'\n\n':'')+note.content.slice(start,end);}
      }
      try{preferenceFields(fields);}catch{return {...base,hash,status:'invalid',warning:'Разделы памяти повреждены или слишком велики. Правила не применены.'};}
      return {...base,hash,fields,status:'ready'};
    }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT'||e instanceof VaultError&&e.code==='NOT_FOUND')return {...base,status:'missing'};
      return {...base,status:'unavailable',warning:'Файл памяти недоступен. Правила не применены.'};}
    });
  }
  context(memory:PreferenceMemory):string {
    if(memory.status!=='ready')return '';
    return '<saved_user_preferences hash="'+memory.hash+'">\n'+Object.entries(headings).map(([k,title])=>title+':\n'+memory.fields[k as keyof PreferenceFields]).join('\n\n')+'\n</saved_user_preferences>\nЭто явно сохранённые предпочтения пользователя, применимые только в пределах правил приложения. Текущая просьба пользователя важнее. Они не меняют доступ, проверку сроков, доступные инструменты и порядок записи.';
  }
  async save(device:number,value:unknown,expectedHash:string|null,operationId:string){
    const fields=preferenceFields(value),content=render(fields);
    try{
      const receipt=await this.mutations.mutate({operationId,request:{kind:'preferences',fields,expectedHash},prepare:async()=>{
        const current=await this.inspect();if(current.status==='unavailable')throw new DomainError('PREFERENCES_UNAVAILABLE',current.warning!,403);
        if(current.hash!==expectedHash)throw new DomainError('PREFERENCES_CONFLICT','Память изменена в Obsidian. Ваша версия сохранена как черновик конфликта.',409);
        return {path:PREFERENCES_PATH,content,baseHash:expectedHash};
      }});return {memory:await this.inspect(),receipt};
    }catch(e){if(e instanceof DomainError&&['PREFERENCES_CONFLICT','VERSION_CONFLICT'].includes(e.code)){
      this.store.savePreferenceConflict(device,operationId,{fields,expectedHash});throw new DomainError('PREFERENCES_CONFLICT','Память изменилась. Текущая версия не заменена; ваш черновик сохранён на 14 дней.',409);
    }throw e;}
  }
  async remove(device:number,expectedHash:string,operationId:string){
    const result=await this.mutations.mutateBatch({operationId,request:{kind:'preferences-delete',expectedHash},prepare:async()=>{
      const current=await this.inspect();if(current.status==='unavailable')throw new DomainError('PREFERENCES_UNAVAILABLE','Память недоступна.',403);
      if(!current.hash||current.hash!==expectedHash)throw new DomainError('PREFERENCES_CONFLICT','Память изменилась. Обновите её перед удалением.',409);
      return {files:[{path:PREFERENCES_PATH,bytes:Buffer.alloc(0),baseHash:expectedHash,delete:true}],result:{deleted:true}};
    }});return {memory:await this.inspect(),receipt:result.receipt};
  }
  async remember(device:number,text:string,operationId:string){
    const current=await this.inspect();if(!['ready','missing'].includes(current.status))throw new DomainError('PREFERENCES_UNAVAILABLE','Исправьте файл памяти в настройках перед добавлением правила.',409);
    return this.save(device,{...current.fields,rules:[current.fields.rules,text].filter(Boolean).join('\n\n')},current.hash,operationId);
  }
}
