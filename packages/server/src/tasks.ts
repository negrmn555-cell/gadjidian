import { createHash } from 'node:crypto';
import { DomainError, createTaskDocument, updateTaskDocument, setTaskSeriesDocument, validateTaskSeries, readTaskDocument, hashContent, searchNotes, sourceVersion, vaultLinks, validateTaskCreate, validateTaskPatch, getSearchIndex, sanitizeFileName, type TaskCreateInput, type TaskSeries, type LegacyTask, type Task, type TaskPage, type TaskWriteResult, type Vault } from '@relay/core';
import type { VaultMutationService } from './vault-mutations.js';
import {noteKeywords} from './notes.js';
import { allocateRecordTitle, codedTitle, recordCode, recordFileName } from './record-codes.js';
import { MAX_TASK_BATCH } from './task-schedule.js';

const folders = { study: 'Study', work: 'Work', personal: 'Personal' };

export class TaskService {
  constructor(private readonly vault: Vault, private readonly mutations: VaultMutationService, private readonly now = () => new Date().toISOString(), private readonly projection?:{tasks():Promise<TaskPage>}) {}
  private async enrich(input:TaskCreateInput):Promise<TaskCreateInput>{const keywords=input.keywords.length?input.keywords:noteKeywords(input.title+' '+input.description),hits=keywords.length?await searchNotes(this.vault,keywords.slice(0,5).join(' '),{limit:5}):[],links=vaultLinks(input.description);const missing=hits.filter(n=>n.score>0&&!links.some(l=>l.target.replace(/\.md$/i,'')===n.path.replace(/\.md$/i,'')));const ids:string[]=[];for(const n of hits)try{const id=sourceVersion(n.path,(await this.vault.readNote(n.path)).content).noteId;if(id)ids.push(id);}catch{}return {...input,keywords,relatedNoteIds:[...new Set([...input.relatedNoteIds,...ids])],description:input.description+(missing.length?'\n\n## Связанные заметки\n'+missing.map(n=>'- [['+n.path.replace(/\.md$/i,'')+']]').join('\n'):'')};}

  async list(): Promise<TaskPage> {
    if(this.projection)return this.projection.tasks();
    const result: TaskPage = { items: [], invalidRecords: [] };
    const groups = new Map<string, Task[]>();
    for (const {meta,parsed} of await getSearchIndex(this.vault).documents()) {
      try {
        const task = readTaskDocument(parsed.content, meta.path);
        if (!task) continue;
        groups.set(task.id, [...(groups.get(task.id) ?? []), task]);
      } catch (e) { result.invalidRecords.push({ path: meta.path, error: (e as Error).message }); }
    }
    for (const tasks of groups.values()) {
      if (tasks.length === 1) result.items.push(tasks[0]);
      else result.invalidRecords.push(...tasks.map(task => ({ path: task.path, error: 'Повторяющийся идентификатор задачи.' })));
    }
    return result;
  }

  async get(id: string): Promise<Task> {
    const page = await this.list();
    const task = page.items.find(task => task.id === id);
    if (!task) throw new DomainError('NOT_FOUND', 'Задача отсутствует или её идентификатор неоднозначен.', 404);
    return task;
  }

  async legacy(): Promise<LegacyTask[]> {
    const out:LegacyTask[]=[];
    for(const meta of await this.vault.listNotes()) {
      if(meta.path.startsWith('Archive/Completed/'))continue;
      const content=(await this.vault.readNote(meta.path)).content;
      try { if(readTaskDocument(content,meta.path))continue; } catch { continue; }
      let fence=false;
      content.split(/\r?\n/).forEach((line,index)=>{
        if(/^\s*(```|~~~)/.test(line)){fence=!fence;return;}
        const m=!fence && /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line);
        if(m&&!line.includes('<!-- relay-task:'))out.push({path:meta.path,line:index,contentHash:hashContent(content),title:m[2].slice(0,200),completed:m[1]!==' '});
      });
    }
    return out;
  }

  async convertLegacy(source:LegacyTask,value:unknown,operationId:string):Promise<TaskWriteResult> {
    if(typeof source.path!=='string'||typeof source.title!=='string'||!Number.isSafeInteger(source.line)||source.line<0||typeof source.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(source.contentHash))throw new DomainError('INVALID_LEGACY','Некорректная старая задача.');
    const task=validateTaskCreate(value),id='task_'+createHash('sha256').update(operationId).digest('hex').slice(0,32);
    const target='Areas/'+folders[task.category]+'/Tasks/'+id+'.md';
    const result=await this.mutations.mutateBatch({operationId,request:{kind:'legacy-task',source,task},prepare:async()=>{
      const content=(await this.vault.readNote(source.path)).content;
      if(hashContent(content)!==source.contentHash)throw new DomainError('VERSION_CONFLICT','Исходная заметка изменилась. Обновите список.',409);
      if(readTaskDocument(content,source.path)||!Number.isSafeInteger(source.line))throw new DomainError('INVALID_LEGACY','Некорректная старая задача.');
      const lines=content.split(/\r?\n/),m=/^(\s*[-*]\s+)\[([ xX])\]\s+(.+)$/.exec(lines[source.line]??'');
      if(lines.slice(0,source.line).filter(l=>/^\s*(```|~~~)/.test(l)).length%2)throw new DomainError('INVALID_LEGACY','Блок кода не является задачей.');
      if(!m||m[3].slice(0,200)!==source.title||lines[source.line].includes('<!-- relay-task:'))throw new DomainError('VERSION_CONFLICT','Старая задача изменилась.',409);
      let created=createTaskDocument({...task,title:await allocateRecordTitle(this.vault,task.title)},id,this.now());
      if(m[2]!==' ')created=updateTaskDocument(created,target,{status:'done'},this.now());
      lines[source.line]=m[1]+'['+m[2]+'] '+m[3]+' <!-- relay-task:'+id+' --> [['+target.replace(/\.md$/,'')+'|Задача]]';
      return {files:[{path:target,bytes:Buffer.from(created),baseHash:null},{path:source.path,bytes:Buffer.from(lines.join(content.includes('\r\n')?'\r\n':'\n')),baseHash:source.contentHash}],result:{id}};
    }});
    return {task:await this.get(id),receipt:result.receipt};
  }

  async create(value: unknown, operationId: string, signal?:AbortSignal, guard?:()=>void): Promise<TaskWriteResult> {
    const input = validateTaskCreate(value);
    const id = 'task_' + createHash('sha256').update(operationId).digest('hex').slice(0, 32);
    const receipt = await this.mutations.mutate({
      operationId, request: { kind: 'task-create', input },
      prepare: async () => { guard?.();if(signal?.aborted)throw new DomainError('CANCELLED','Запрос отменён.');const enriched=await this.enrich(input);const title=await allocateRecordTitle(this.vault,enriched.title);guard?.();if(signal?.aborted)throw new DomainError('CANCELLED','Запрос отменён.');return ({
        path: 'Areas/' + folders[input.category] + '/Tasks/' + recordFileName(title) + '.md',
        content: createTaskDocument({...enriched,title}, id, this.now()), baseHash: null,
      });},
    });
    return { task: await this.get(id), receipt };
  }
  async createMany(values:unknown[],operationId:string,signal?:AbortSignal,guard?:()=>void,seriesSources?:{id:string;expectedHash:string;series:TaskSeries}[]):Promise<TaskWriteResult[]>{
    if(!values.length||values.length>MAX_TASK_BATCH)throw new DomainError('TASK_LIMIT',`За один запрос можно добавить от 1 до ${MAX_TASK_BATCH} задач.`);
    const inputs=values.map(validateTaskCreate),ids=inputs.map((_,i)=>'task_'+createHash('sha256').update(operationId+':'+i).digest('hex').slice(0,32));
    const check=()=>{if(signal?.aborted)throw new DomainError('CANCELLED','Запрос отменён.');guard?.();};
    if(seriesSources&&(seriesSources.length>MAX_TASK_BATCH||new Set(seriesSources.map(s=>s.id)).size!==seriesSources.length))throw new DomainError('INVALID_SERIES','Некорректный список задач серии.');
    for(const source of seriesSources??[])validateTaskSeries(source.series);
    const result=await this.mutations.mutateBatch({operationId,request:{kind:'task-create-many',inputs,...(seriesSources?.length?{seriesSources}:{})},guard:check,prepare:async()=>{
      check();const reserved=new Set<string>();const enriched=[];
      for(const input of inputs){check();const next=await this.enrich(input);enriched.push({...next,title:await allocateRecordTitle(this.vault,next.title,reserved)});}
      const files:{path:string;baseHash:string|null;bytes:Buffer}[]=enriched.map((input,i)=>({path:'Areas/'+folders[input.category]+'/Tasks/'+recordFileName(input.title)+'.md',baseHash:null,bytes:Buffer.from(createTaskDocument(input,ids[i],this.now()))}));
      for(const link of seriesSources??[]){const source=await this.get(link.id);if(source.contentHash!==link.expectedHash)throw new DomainError('VERSION_CONFLICT','Исходная задача изменилась. Повторите запрос.',409);const note=await this.vault.readNote(source.path);files.push({path:source.path,baseHash:source.contentHash,bytes:Buffer.from(setTaskSeriesDocument(note.content,source.path,link.series,this.now()))});}
      check();return {files,result:{ids}};
    }});
    return Promise.all(ids.map(async id=>{const task=await this.get(id);return {task,receipt:{...result.receipt,path:task.path,contentHash:task.contentHash}};}));
  }

  async updateMany(values:{id:string;patch:unknown;expectedHash:string;series?:TaskSeries}[],operationId:string,signal?:AbortSignal,guard?:()=>void):Promise<TaskWriteResult[]> {
    if(!values.length||values.length>MAX_TASK_BATCH||new Set(values.map(v=>v.id)).size!==values.length)throw new DomainError('TASK_LIMIT','Выберите от 1 до 100 разных задач.');
    const inputs=values.map(v=>{if(!/^[a-f0-9]{64}$/.test(v.expectedHash))throw new DomainError('VERSION_REQUIRED','Нужна версия задачи.');return {...v,patch:validateTaskPatch(v.patch),...(v.series?{series:validateTaskSeries(v.series)}:{})};});
    const check=()=>{if(signal?.aborted)throw new DomainError('CANCELLED','Запрос отменён.');guard?.();};
    const result=await this.mutations.mutateBatch({operationId,request:{kind:'task-update-many',inputs},guard:check,prepare:async()=>{
      check();const files=[];
      for(const input of inputs){
        const task=await this.get(input.id);
        if(task.contentHash!==input.expectedHash)throw new DomainError('VERSION_CONFLICT','Одна из задач изменилась. Обновите список и повторите запрос.',409);
        const note=await this.vault.readNote(task.path),code=recordCode(task.title),patch=code&&input.patch.title?{...input.patch,title:codedTitle(input.patch.title,code)}:input.patch;
        let content=updateTaskDocument(note.content,task.path,patch,this.now());
        if(input.series)content=setTaskSeriesDocument(content,task.path,input.series,this.now());
        files.push({path:task.path,baseHash:input.expectedHash,bytes:Buffer.from(content)});
      }
      check();return {files,result:{ids:inputs.map(i=>i.id)}};
    }});
    return Promise.all(inputs.map(async input=>{const task=await this.get(input.id);return {task,receipt:{...result.receipt,path:task.path,contentHash:task.contentHash}};}));
  }

  async update(id: string, value: unknown, expectedHash: string, operationId: string): Promise<TaskWriteResult> {
    const patch = validateTaskPatch(value);
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new DomainError('VERSION_REQUIRED', 'Нужна версия задачи.');
    const receipt = await this.mutations.mutate({
      operationId, request: { kind: 'task-update', id, patch, expectedHash },
      prepare: async () => {
        const task = await this.get(id);
        if (task.contentHash !== expectedHash) throw new DomainError('VERSION_CONFLICT', 'Задача изменилась. Обновите список.', 409);
        const note = await this.vault.readNote(task.path);
        const code=recordCode(task.title);
        const next=code && patch.title ? {...patch,title:codedTitle(patch.title,code)} : patch;
        return { path: task.path, content: updateTaskDocument(note.content, task.path, next, this.now()), baseHash: expectedHash };
      },
    });
    return { task: await this.get(id), receipt };
  }
}
