import { createHash } from 'node:crypto';
import { DomainError, createTaskDocument, updateTaskDocument, readTaskDocument, hashContent, searchNotes, sourceVersion, vaultLinks, validateTaskCreate, validateTaskPatch, getSearchIndex, type TaskCreateInput, type LegacyTask, type Task, type TaskPage, type TaskWriteResult, type Vault } from '@relay/core';
import type { VaultMutationService } from './vault-mutations.js';
import {noteKeywords} from './notes.js';

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
      let created=createTaskDocument(task,id,this.now());
      if(m[2]!==' ')created=updateTaskDocument(created,target,{status:'done'},this.now());
      lines[source.line]=m[1]+'['+m[2]+'] '+m[3]+' <!-- relay-task:'+id+' --> [['+target.replace(/\.md$/,'')+'|Задача]]';
      return {files:[{path:target,bytes:Buffer.from(created),baseHash:null},{path:source.path,bytes:Buffer.from(lines.join(content.includes('\r\n')?'\r\n':'\n')),baseHash:source.contentHash}],result:{id}};
    }});
    return {task:await this.get(id),receipt:result.receipt};
  }

  async create(value: unknown, operationId: string, signal?:AbortSignal): Promise<TaskWriteResult> {
    const input = validateTaskCreate(value);
    const id = 'task_' + createHash('sha256').update(operationId).digest('hex').slice(0, 32);
    const receipt = await this.mutations.mutate({
      operationId, request: { kind: 'task-create', input },
      prepare: async () => { if(signal?.aborted)throw new DomainError('CANCELLED','Запрос отменён.');const enriched=await this.enrich(input);if(signal?.aborted)throw new DomainError('CANCELLED','Запрос отменён.');return ({
        path: 'Areas/' + folders[input.category] + '/Tasks/' + id + '.md',
        content: createTaskDocument(enriched, id, this.now()), baseHash: null,
      });},
    });
    return { task: await this.get(id), receipt };
  }
  async createMany(values:unknown[],operationId:string,signal?:AbortSignal):Promise<TaskWriteResult[]>{
    if(!values.length||values.length>10)throw new DomainError('TASK_LIMIT','За один запрос можно добавить от одной до десяти задач.');
    const inputs=values.map(validateTaskCreate),ids=inputs.map((_,i)=>'task_'+createHash('sha256').update(operationId+':'+i).digest('hex').slice(0,32));
    const result=await this.mutations.mutateBatch({operationId,request:{kind:'task-create-many',inputs},prepare:async()=>{if(signal?.aborted)throw new DomainError('CANCELLED','Запрос отменён.');const enriched=await Promise.all(inputs.map(input=>this.enrich(input)));if(signal?.aborted)throw new DomainError('CANCELLED','Запрос отменён.');return {files:enriched.map((input,i)=>({path:'Areas/'+folders[input.category]+'/Tasks/'+ids[i]+'.md',baseHash:null,bytes:Buffer.from(createTaskDocument(input,ids[i],this.now()))})),result:{ids}};}});
    return Promise.all(ids.map(async id=>({task:await this.get(id),receipt:result.receipt})));
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
        return { path: task.path, content: updateTaskDocument(note.content, task.path, patch, this.now()), baseHash: expectedHash };
      },
    });
    return { task: await this.get(id), receipt };
  }
}
