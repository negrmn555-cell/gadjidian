import { createHash, randomUUID } from 'node:crypto';
import { DomainError, objectInput, validateLocalDate, validateTaskCreate, validateTaskPatch, validateTaskRecurrence, localDateTimeToInstant, categoryLabels, priorityLabels, statusLabels, isTaskOverdue, type AgentResult, type ChatMessage, type Deadline, type Task, type TaskCreateInput, type TaskPatch, type TaskSeries, type TaskWriteResult } from '@relay/core';
import type { ChatStore } from './chat-store.js';
import type { TaskService } from './tasks.js';
import type { ModeRunInput } from './chat-modes.js';
import { parseTaskCommand, taskPrompt, type ModelTask, type TaskCommand, type TaskTarget } from './task-intents.js';
import { localDeadline, seriesDeadlines, seriesOccurrence, shiftDeadline, MAX_TASK_BATCH } from './task-schedule.js';

class Clarification extends Error {}
const baseTitle=(title:string)=>title.replace(/ #[A-Z0-9]{4,8}$/,'').trim();
const normalized=(title:string)=>baseTitle(title).toLocaleLowerCase().replace(/\s+/g,' ');
const seriesId=(operationId:string)=>'series_'+createHash('sha256').update(operationId).digest('hex').slice(0,32);
const sameDeadline=(a:Deadline,b:Deadline)=>a.kind===b.kind&&a.timezone===b.timezone&&(a.kind==='by_date'&&b.kind==='by_date'?a.date===b.date:a.kind!=='by_date'&&b.kind!=='by_date'&&a.at===b.at);

function userMessages(input:ModeRunInput):{content:string;createdAt?:number}[] {
  const pending=input.chat.pendingTask;
  const history=pending?input.history.filter(h=>h.role==='user'&&(!pending.userSources||pending.userSources.some(s=>s.text===h.content)||h.createdAt!==undefined&&h.createdAt>=pending.createdAt)):[];
  return [...(pending?.userSources??[]).map(s=>({content:s.text,createdAt:Date.parse(s.referenceInstant)})),...history,{content:input.userText??input.text,createdAt:input.referenceInstant?Date.parse(input.referenceInstant):Date.now()}];
}

function requireEvidence(value:unknown,input:ModeRunInput):string {
  if(typeof value!=='string'||!value.trim()||!userMessages(input).some(h=>h.content.includes(value)))throw new Clarification('Уточните срок или правило повторения в сообщении.');
  return value;
}

function modelDeadline(value:unknown,evidence:unknown,input:ModeRunInput,checkMessageTime=false):Deadline {
  const quote=requireEvidence(evidence,input);
  if(!/(\d|сегодня|завтра|послезавтра|понедельник|вторник|сред[ауе]|четверг|пятниц|суббот|воскресень|недел|месяц|январ|феврал|март|апрел|ма[йяе]|июн|июл|август|сентябр|октябр|ноябр|декабр)/i.test(quote))throw new Clarification('Укажите срок явно.');
  const d=objectInput(value),relative=/(послезавтра|завтра|сегодня|через\s+(\d{1,3})\s+дн)/i.exec(quote);
  if(relative){
    const source=userMessages(input).filter(h=>h.content.includes(quote)).at(-1)!;
    const instant=source.createdAt?new Date(source.createdAt):new Date(input.chat.pendingTask?.referenceInstant??input.referenceInstant??new Date().toISOString());
    const date=new Intl.DateTimeFormat('sv-SE',{timeZone:input.chat.timezone,dateStyle:'short'}).format(instant);
    const offset=relative[1].toLowerCase()==='сегодня'?0:relative[1].toLowerCase()==='завтра'?1:relative[1].toLowerCase()==='послезавтра'?2:Number(relative[2]);
    const expected=new Date(Date.parse(date+'T12:00:00Z')+offset*86400000).toISOString().slice(0,10);
    if(d.date!==expected)throw new Clarification('Относительная дата не соответствует времени реплики. Укажите дату явно.');
  }
  const quotedTimes=[...new Set(quote.match(/\b\d{1,2}:\d{2}\b/g)??[])];
  const messageTimes=checkMessageTime?[...new Set(userMessages(input).flatMap(h=>h.content.match(/\b\d{1,2}:\d{2}\b/g)??[]))]:[];
  const explicitTimes=quotedTimes.length?quotedTimes:messageTimes;
  if(d.kind==='by_date' && explicitTimes.length===1)throw new Clarification('Вы указали точное время '+explicitTimes[0]+'. Уточните срок вместе с этим временем.');
  if(d.kind!=='by_date' && explicitTimes.length===1 && String(d.time).padStart(5,'0')!==explicitTimes[0].padStart(5,'0'))throw new Clarification('Время срока не совпадает с указанным '+explicitTimes[0]+'. Уточните время.');
  const deadline=d.kind==='by_date'?{kind:d.kind,date:d.date,timezone:input.chat.timezone}:{kind:d.kind,at:localDateTimeToInstant(String(d.date??''),String(d.time??''),input.chat.timezone),timezone:input.chat.timezone};
  return validateTaskCreate({title:'Срок',category:'personal',priority:'medium',deadline}).deadline;
}

function taskFields(task:ModelTask):Omit<TaskCreateInput,'deadline'> {
  const {deadline:_deadline,...fields}=validateTaskCreate({...task,deadline:{kind:'by_date',date:'2000-01-01',timezone:'UTC'}});
  return fields;
}

export function formatTaskDeadline(deadline:Deadline):string {
  const local=localDeadline(deadline),[year,month,day]=local.date.split('-');
  return `${day}.${month}.${year}${local.time?' в '+local.time:''} (${deadline.timezone})`;
}
const taskLine=(task:Task)=>`**${task.title}** — ${formatTaskDeadline(task.deadline)} · ${statusLabels[task.status]}`;
function savedText(saved:TaskWriteResult[]):string {
  return !saved.length?'':'\n\n'+(saved.every(s=>s.receipt.state==='synced')?'Сохранено и отправлено в Git.':saved.every(s=>s.receipt.state!=='saved_local')?'Сохранено в Git.':'Сохранено локально.');
}

export class TaskModeService {
  constructor(private readonly store:ChatStore,private readonly tasks:TaskService) {}
  private guard(input:ModeRunInput):void {
    if(input.signal.aborted)throw new DomainError('CANCELLED','Запрос отменён.');
    const current=this.store.get(input.device,input.chat.id);
    if(current.mode!=='task'||current.version!==input.chat.version)throw new DomainError('CHAT_VERSION_CONFLICT','Режим или настройки чата изменились. Повторите запрос.',409);
  }
  private remember(input:ModeRunInput,tasks:Task[]):void {
    const ids=[...new Set(tasks.map(t=>t.series?.id).filter((id):id is string=>!!id))];
    this.store.setTaskContext(input.device,input.chat.id,{recentTaskIds:tasks.slice(0,MAX_TASK_BATCH).map(t=>t.id),...(ids.length===1?{seriesId:ids[0]}:{})});
  }
  private draft(input:ModeRunInput,command:TaskCommand,question:string,partials:Partial<TaskCreateInput>[]):AgentResult {
    const old=input.chat.pendingTask;this.guard(input);
    const sources=userMessages(input).map(h=>({text:h.content.slice(0,10_000),referenceInstant:h.createdAt?new Date(h.createdAt).toISOString():old?.referenceInstant??input.referenceInstant??new Date().toISOString()}));
    const userSources=[...new Map(sources.map(s=>[s.text+'\0'+s.referenceInstant,s])).values()].slice(-24);
    this.store.setDraft(input.device,input.chat.id,{id:old?.id??'draft_'+randomUUID(),version:(old?.version??0)+1,createdAt:old?.createdAt??Date.now(),task:partials[0]??old?.task??{},tasks:partials.length?partials:old?.tasks,question,referenceInstant:old?.referenceInstant??input.referenceInstant??new Date().toISOString(),operation:command,userSources});
    return {text:question,sources:[],actions:[]};
  }
  private resolve(target:TaskTarget,all:Task[],input:ModeRunInput,allowMultiple=false):Task[] {
    const context=input.chat.taskContext;
    const recent=(context?.recentTaskIds??[]).map(id=>all.find(t=>t.id===id)).filter((t):t is Task=>!!t);
    let selected:Task[]=[];
    if(target.kind==='last'||target.kind==='recent') {
      const ids=context?.recentTaskIds??[];
      if(!ids.length)throw new Clarification('Какую задачу вы имеете в виду? Укажите название или дату.');
      const wanted=target.kind==='last'?[ids.at(-1)!]:target.index?[ids[target.index-1]]:ids;
      if(wanted.some(id=>!id||!all.some(t=>t.id===id)))throw new Clarification('Одна из задач последнего результата больше недоступна. Укажите актуальную задачу по названию или дате.');
      selected=wanted.map(id=>all.find(t=>t.id===id)!);
    } else if(target.kind==='id'||target.kind==='ids') {
      const ids=target.kind==='id'?[target.id]:target.ids;
      if(new Set(ids).size!==ids.length||ids.some(id=>!all.some(t=>t.id===id)))throw new Clarification('Не нашёл указанную задачу. Уточните название или дату.');
      selected=ids.map(id=>all.find(t=>t.id===id)!);
      for(const task of selected){
        const namesakes=all.filter(t=>normalized(t.title)===normalized(task.title)),userText=input.userText??input.text;
        if(namesakes.length>1&&!userText.includes(task.id)&&!userText.includes(task.title)&&!(baseTitle(task.title)!==task.title&&userText.includes(task.title.slice(baseTitle(task.title).length).trim())))throw new Clarification('Есть несколько задач с таким названием. Уточните дату или код:\n'+namesakes.slice(0,10).map(taskLine).join('\n'));
      }
    } else if(target.kind==='series') {
      const seed=target.taskId?all.find(t=>t.id===target.taskId):recent.find(t=>t.series?.id===context?.seriesId);
      const id=seed?.series?.id??(!target.taskId?context?.seriesId:undefined);
      if(!id)throw new Clarification('Какую серию нужно изменить? Укажите название или код одной из её задач.');
      const today=new Intl.DateTimeFormat('sv-SE',{timeZone:input.chat.timezone,dateStyle:'short'}).format(new Date(input.referenceInstant??new Date().toISOString()));
      selected=all.filter(t=>t.series?.id===id&&(target.scope==='all'||!['done','cancelled'].includes(t.status))&&(target.scope!=='future'||localDeadline(t.deadline).date>=today)).sort((a,b)=>a.series!.index-b.series!.index);
    } else if(target.kind==='filter') {
      if(Object.keys(target).length===1)throw new Clarification('Какие задачи выбрать? Укажите период, категорию или статус.');
      if(target.from)validateLocalDate(target.from);if(target.to)validateLocalDate(target.to);
      if(target.from&&target.to&&target.from>target.to)throw new Clarification('Начало периода позже его конца. Уточните даты.');
      selected=all.filter(t=>(!target.title||normalized(t.title)===normalized(target.title))&&(!target.status||t.status===target.status)&&(!target.active||!['done','cancelled'].includes(t.status))&&(!target.category||t.category===target.category)&&(!target.from||localDeadline(t.deadline).date>=target.from)&&(!target.to||localDeadline(t.deadline).date<=target.to)&&(!target.overdue||isTaskOverdue(t,new Date(input.referenceInstant??new Date().toISOString()))));
    } else {
      if(!target.title&&!target.date&&!target.status)throw new Clarification('Укажите название, дату или статус задачи.');
      if(target.date)validateLocalDate(target.date);
      selected=all.filter(t=>(!target.title||normalized(t.title)===normalized(target.title)||t.title.toLocaleLowerCase()===target.title.toLocaleLowerCase())&&(!target.date||localDeadline(t.deadline).date===target.date)&&(!target.status||t.status===target.status));
    }
    if(!selected.length)throw new Clarification('Не нашёл подходящих задач. Уточните название, дату или статус.');
    if(!allowMultiple&&selected.length!==1)throw new Clarification('Подходит несколько задач. Уточните дату или код:\n'+selected.slice(0,10).map(taskLine).join('\n'));
    return selected;
  }
  private async create(input:ModeRunInput,values:TaskCreateInput[],all:Task[],label:string,options:{allowDuplicates?:boolean;seriesSource?:{id:string;expectedHash:string;series:TaskSeries}}={}):Promise<AgentResult> {
    const existing:Task[]=[],fresh:TaskCreateInput[]=[],order:({existing:Task}|{index:number})[]=[];
    const links=options.seriesSource?[options.seriesSource]:[];
    for(const value of values){
      const match=!options.allowDuplicates?all.find(t=>normalized(t.title)===normalized(value.title)&&t.category===value.category&&sameDeadline(t.deadline,value.deadline)):undefined;
      if(match){existing.push(match);order.push({existing:match});if(value.series&&!match.series)links.push({id:match.id,expectedHash:match.contentHash,series:value.series});}
      else {if(!options.allowDuplicates&&fresh.some(t=>normalized(t.title)===normalized(value.title)&&t.category===value.category&&sameDeadline(t.deadline,value.deadline)))throw new Clarification('В запросе повторяется одна задача с одинаковым сроком. Уточните список.');order.push({index:fresh.length});fresh.push(value);}
    }
    this.guard(input);
    const saved=fresh.length?await this.tasks.createMany(fresh,input.operationId,input.signal,()=>this.guard(input),links):[];
    const linked=!fresh.length&&links.length?await this.tasks.updateMany(links.map(link=>({...link,patch:{}})),input.operationId,input.signal,()=>this.guard(input)):[];
    const result=await Promise.all(order.map(async item=>'existing'in item?(links.some(link=>link.id===item.existing.id)?await this.tasks.get(item.existing.id):item.existing):saved[item.index].task));
    this.store.setDraft(input.device,input.chat.id,null);this.remember(input,result);
    const text=`${label}: ${saved.length}.${existing.length?' Уже существуют: '+existing.length+'.':''}\n\n`+result.map((t,i)=>`${i+1}. ${taskLine(t)}`).join('\n')+(result.length===1?'\n\n'+categoryLabels[result[0].category]+' · '+priorityLabels[result[0].priority]:'')+savedText(saved);
    const actions:AgentResult['actions']=saved.map(s=>({kind:'created',path:s.task.path,label:s.task.title}));
    const receipts=saved.map(s=>s.receipt);
    for(const link of links){const source=await this.tasks.get(link.id);actions.push({kind:'updated',path:source.path,label:'Задача включена в серию'});const receipt=linked.find(s=>s.task.id===link.id)?.receipt??saved[0]?.receipt;if(receipt)receipts.push({...receipt,path:source.path,contentHash:source.contentHash});}
    return {text:text+(linked.length?savedText(linked):''),sources:[],actions,receipts};
  }
  private async execute(command:TaskCommand,input:ModeRunInput,all:Task[]):Promise<AgentResult> {
    if(command.intent==='clarify')return {text:command.question,sources:[],actions:[]};
    if(command.intent==='cancel_draft'){
      this.guard(input);this.store.setDraft(input.device,input.chat.id,null);
      return {text:input.chat.pendingTask?'Черновик отменён.':'Незавершённых черновиков нет.',sources:[],actions:[]};
    }
    if(command.intent==='create') {
      const ready:TaskCreateInput[]=[],partials:Partial<TaskCreateInput>[]=[],missing:string[]=[];
      for(const item of command.tasks){
        const fields=taskFields(item.task);partials.push(fields);
        if(!item.task.deadline||!item.deadlineEvidence){missing.push(fields.title);continue;}
        try{const deadline=modelDeadline(item.task.deadline,item.deadlineEvidence,input,command.tasks.length===1);ready.push(validateTaskCreate({...fields,deadline}));partials[partials.length-1]={...fields,deadline};}
        catch(e){if(e instanceof Clarification||e instanceof DomainError){missing.push(fields.title+': '+e.message);}else throw e;}
      }
      if(missing.length)return this.draft(input,command,command.question||'Уточните срок: '+missing.join('; '),partials);
      return this.create(input,ready,all,'Создано задач');
    }
    if(command.intent==='series') {
      const fields=taskFields(command.task);let anchor:Deadline;
      try{
        requireEvidence(command.recurrenceEvidence,input);
        if(!command.task.deadline)throw new Clarification('С какой даты и к какому времени начать серию?');
        anchor=modelDeadline(command.task.deadline,command.deadlineEvidence,input,true);
        if(command.count==null&&command.until==null)throw new Clarification('Сколько повторений создать или до какой даты продолжать серию?');
      }catch(e){if(e instanceof Clarification||e instanceof DomainError)return this.draft(input,command,'Уточните серию: '+e.message,[fields]);throw e;}
      const recurrence=validateTaskRecurrence(command.schedule),occurrences=seriesDeadlines(anchor,recurrence,{count:command.count,until:command.until,startIndex:command.includeStart?0:1});
      const previous=all.find(t=>normalized(t.title)===normalized(fields.title)&&t.series&&sameDeadline(t.series.anchor,anchor)&&JSON.stringify(t.series.recurrence)===JSON.stringify(recurrence));
      const id=previous?.series?.id??seriesId(input.operationId);
      return this.create(input,occurrences.map(({deadline,index})=>({...fields,deadline,series:{id,index,anchor,recurrence}})),all,'Создано задач в серии');
    }
    if(command.intent==='extend') {
      requireEvidence(command.recurrenceEvidence,input);
      const selected=this.resolve(command.target,all,input,true),ids=new Set(selected.map(t=>t.series?.id));
      if(ids.size!==1||(!selected[0].series&&selected.length!==1))throw new Clarification('Выберите одну серию или одну задачу, которую нужно повторить.');
      const members=selected[0].series?all.filter(t=>t.series?.id===selected[0].series!.id).sort((a,b)=>a.series!.index-b.series!.index):selected;
      const template=members.at(-1)!,metadata=template.series;
      if(metadata&&members.some(t=>JSON.stringify(t.series!.anchor)!==JSON.stringify(metadata.anchor)||JSON.stringify(t.series!.recurrence)!==JSON.stringify(metadata.recurrence)))throw new Clarification('Правила задач этой серии различаются. Уточните новое правило повторения.');
      if(command.count==null&&command.until==null)return this.draft(input,command,'Сколько дополнительных задач создать или до какой даты продолжить серию?',[]);
      if(!metadata&&!command.schedule)return this.draft(input,command,'Как часто повторять задачу: каждый день, неделю, месяц или год?',[]);
      if(metadata&&command.schedule&&JSON.stringify(validateTaskRecurrence(command.schedule))!==JSON.stringify(metadata.recurrence))throw new Clarification('Для продолжения действует прежнее правило серии. Чтобы задать другое, укажите начало новой серии.');
      const recurrence=validateTaskRecurrence(metadata?.recurrence??command.schedule),anchor=metadata?.anchor??template.deadline,id=metadata?.id??seriesId(input.operationId);
      if(!metadata&&!sameDeadline(seriesOccurrence(anchor,recurrence,0),anchor))throw new Clarification('Начальная задача не попадает в выбранные дни недели. Укажите начало новой серии.');
      const occurrences=seriesDeadlines(anchor,recurrence,{count:command.count,until:command.until,startIndex:metadata?Math.max(...members.map(t=>t.series!.index))+1:1});
      const {id:_id,status:_status,createdAt:_created,updatedAt:_updated,completedAt:_completed,path:_path,contentHash:_hash,series:_series,...fields}=template;
      return this.create(input,occurrences.map(({deadline,index})=>({...fields,title:baseTitle(fields.title),deadline,series:{id,index,anchor,recurrence}})),all,'Создано дополнительных задач',{seriesSource:metadata?undefined:{id:template.id,expectedHash:template.contentHash,series:{id,index:0,anchor,recurrence}}});
    }
    if(command.intent==='list') {
      const filter=command.filter;
      if(filter?.from)validateLocalDate(filter.from);if(filter?.to)validateLocalDate(filter.to);
      if(filter?.from&&filter.to&&filter.from>filter.to)throw new Clarification('Начало периода позже его конца. Уточните даты.');
      const selected=(command.target?this.resolve(command.target,all,input,true):all).filter(t=>(!filter?.title||normalized(t.title)===normalized(filter.title))&&(!filter?.status||t.status===filter.status)&&(!filter?.active||!['done','cancelled'].includes(t.status))&&(!filter?.category||t.category===filter.category)&&(!filter?.from||localDeadline(t.deadline).date>=filter.from)&&(!filter?.to||localDeadline(t.deadline).date<=filter.to)&&(!filter?.overdue||isTaskOverdue(t,new Date(input.referenceInstant??new Date().toISOString())))).sort((a,b)=>localDeadline(a.deadline).date.localeCompare(localDeadline(b.deadline).date)||('at'in a.deadline?a.deadline.at:'').localeCompare('at'in b.deadline?b.deadline.at:''));
      if(selected.length)this.remember(input,selected);
      return {text:selected.length?'Найдено задач: '+selected.length+'.\n\n'+selected.slice(0,100).map((t,i)=>`${i+1}. ${taskLine(t)}`).join('\n')+(selected.length>100?'\n\nПоказаны первые 100. Уточните период или категорию.':''):'Подходящих задач нет.',sources:selected.slice(0,100).map(t=>t.path),actions:[]};
    }
    if(command.intent==='update_many'){
      const updates=command.updates.flatMap(item=>{
        const selected=this.resolve(item.target,all,input,item.target.kind==='ids'||item.target.kind==='series'||item.target.kind==='filter'||item.target.kind==='recent'&&!item.target.index);
        const patch:Record<string,unknown>={...item.patch};
        if(!Object.keys(patch).length)throw new Clarification('Что изменить в выбранных задачах?');
        if(patch.deadline)patch.deadline=modelDeadline(patch.deadline,item.deadlineEvidence,input);
        const checked=validateTaskPatch(patch);
        return selected.map(task=>({id:task.id,expectedHash:task.contentHash,patch:checked}));
      });
      if(new Set(updates.map(t=>t.id)).size!==updates.length)throw new Clarification('Одна задача выбрана для нескольких изменений. Объедините изменения этой задачи.');
      return this.update(input,updates);
    }
    const multiple=command.target.kind==='ids'||command.target.kind==='series'||command.target.kind==='filter'||command.target.kind==='recent'&&!command.target.index;
    const selected=this.resolve(command.target,all,input,multiple);
    if(command.intent==='duplicate') {
      const patch=command.patch??{};
      if(patch.status)throw new Clarification('Новая копия создаётся со статусом «К выполнению».');
      if(patch.deadline&&command.deadline)throw new Clarification('Укажите один новый срок для копии.');
      const deadline=command.deadline??patch.deadline,newDeadline=deadline?modelDeadline(deadline,command.deadlineEvidence,input):undefined;
      return this.create(input,selected.map(t=>validateTaskCreate({...t,...patch,title:patch.title??baseTitle(t.title),series:undefined,deadline:newDeadline??t.deadline})),all,'Создано копий',{allowDuplicates:true});
    }
    if(selected.length>MAX_TASK_BATCH)throw new Clarification('За один запрос можно изменить до 100 задач. Уточните период или выберите часть серии.');
    const updates:{id:string;patch:TaskPatch;expectedHash:string;series?:TaskSeries}[]=[];
    if(command.intent==='update') {
      const patch:Record<string,unknown>={...command.patch};
      if(!Object.keys(patch).length)throw new Clarification('Что изменить в выбранной задаче?');
      if(patch.deadline)patch.deadline=modelDeadline(patch.deadline,command.deadlineEvidence,input);
      const checked=validateTaskPatch(patch);
      for(const task of selected)updates.push({id:task.id,expectedHash:task.contentHash,patch:checked});
    } else {
      requireEvidence(command.evidence,input);
      if(!command.amount)throw new Clarification('На сколько дней, недель, месяцев или лет перенести сроки?');
      const entireSeries=new Set(selected.filter(t=>t.series&&all.filter(other=>other.series?.id===t.series!.id).every(other=>selected.some(s=>s.id===other.id))).map(t=>t.series!.id));
      for(const task of selected){
        if(task.series&&entireSeries.has(task.series.id)&&task.series.recurrence.weekdays&&!(command.unit==='week'||command.unit==='day'&&command.amount%7===0))throw new Clarification('Для переноса серии с несколькими днями недели укажите новое расписание либо сдвиг на целое число недель.');
        const series=task.series&&entireSeries.has(task.series.id)?{...task.series,anchor:shiftDeadline(task.series.anchor,command.unit,command.amount)}:undefined;
        updates.push({id:task.id,expectedHash:task.contentHash,patch:{deadline:series?seriesOccurrence(series.anchor,series.recurrence,series.index):shiftDeadline(task.deadline,command.unit,command.amount)},...(series?{series}:{})});
      }
    }
    return this.update(input,updates);
  }
  private async update(input:ModeRunInput,updates:{id:string;patch:TaskPatch;expectedHash:string;series?:TaskSeries}[]):Promise<AgentResult>{
    this.guard(input);
    const saved=await this.tasks.updateMany(updates,input.operationId,input.signal,()=>this.guard(input));
    this.store.setDraft(input.device,input.chat.id,null);this.remember(input,saved.map(s=>s.task));
    return {text:'Обновлено задач: '+saved.length+'.\n\n'+saved.map((s,i)=>`${i+1}. ${taskLine(s.task)}`).join('\n')+savedText(saved),sources:[],actions:saved.map(s=>({kind:'updated',path:s.task.path,label:s.task.title})),receipts:saved.map(s=>s.receipt)};
  }
  async run(input:ModeRunInput):Promise<AgentResult> {
    this.guard(input);
    if(/^\/(?!cancel\b)/.test(input.text))return {text:'В режиме задач команды заметок недоступны. Переключитесь на «Заметка».',sources:[],actions:[]};
    if(input.text==='/cancel')return this.execute({intent:'cancel_draft'},input,[]);
    const current=this.store.get(input.device,input.chat.id);input={...input,chat:{...input.chat,taskContext:current.taskContext}};
    input.onEvent({type:'status',text:'Проверяю задачи, контекст и сроки…'});
    const all=(await this.tasks.list()).items,recent=new Set(input.chat.taskContext?.recentTaskIds??[]),text=(input.userText??input.text).toLocaleLowerCase();
    // Existing chats created before task_context migration retain their saved task references.
    if(!input.chat.taskContext){
      for(const message of this.store.list(input.device,input.chat.id,200).reverse()){
        if(message.role!=='assistant'||!message.meta)continue;
        try{const meta=JSON.parse(message.meta) as {actions?:{path:string}[]};const tasks=(meta.actions??[]).map(a=>all.find(t=>t.path===a.path)).filter((t):t is Task=>!!t);if(tasks.length){this.remember(input,tasks);input={...input,chat:{...input.chat,taskContext:this.store.get(input.device,input.chat.id).taskContext}};for(const t of tasks)recent.add(t.id);break;}}catch{}
      }
    }
    const ranked=[...all].sort((a,b)=>Number(recent.has(b.id))-Number(recent.has(a.id))||Number(text.includes(normalized(b.title)))-Number(text.includes(normalized(a.title)))||b.updatedAt.localeCompare(a.updatedAt));
    const catalog=ranked.slice(0,100).map(t=>({id:t.id,title:t.title,status:t.status,deadline:t.deadline,localDeadline:localDeadline(t.deadline),category:t.category,priority:t.priority,series:t.series}));
    const reference=input.referenceInstant??new Date().toISOString();
    const messages:ChatMessage[]=[{role:'system',content:taskPrompt+'\nТекущее местное время: '+new Intl.DateTimeFormat('sv-SE',{timeZone:input.chat.timezone,dateStyle:'short',timeStyle:'short'}).format(new Date(reference))+'. Часовой пояс: '+input.chat.timezone+'\nКонтекст последнего результата: '+JSON.stringify(input.chat.taskContext??null)+'\nКаталог (показано '+catalog.length+' из '+all.length+'): '+JSON.stringify(catalog)+'\nАктивный черновик: '+JSON.stringify(input.chat.pendingTask)+'\nВремя пользовательских реплик: '+JSON.stringify(input.history.filter(h=>h.role==='user').map(h=>({text:h.content,at:h.createdAt?new Date(h.createdAt).toISOString():reference})))},...(input.preferencesContext?[{role:'user' as const,content:input.preferencesContext}]:[]),...input.history.slice(-24),{role:'user',content:input.text,parts:input.parts}];
    let command:TaskCommand|undefined,usage:AgentResult['usage'];
    for(let attempt=0;attempt<2;attempt++){
      const result=await input.llm.chat(messages,undefined,input.signal,input.structuredOutput?{responseFormat:{type:'json_object'}}:undefined);
      if(result.usage)usage={promptTokens:(usage?.promptTokens??0)+result.usage.promptTokens,completionTokens:(usage?.completionTokens??0)+result.usage.completionTokens};
      try{
        if(result.finishReason==='length'||result.message.tool_calls?.length)throw new DomainError('MODEL_OUTPUT_INVALID','Незавершённый ответ.');
        command=parseTaskCommand(result.message.content);break;
      }catch(e){
        if(!(e instanceof DomainError))throw e;
        if(attempt===0){input.onEvent({type:'status',text:'Проверяю формат ответа…'});messages.push({role:'assistant',content:(result.message.content??'').slice(0,20_000)},{role:'user',content:'Предыдущий ответ не соответствует схеме. Верни полный JSON одной из перечисленных операций. Все элементы create.tasks имеют обёртку {task,deadlineEvidence}. Не меняй смысл запроса. Если данных не хватает, верни clarify.'});}
      }
    }
    if(!command)return {text:'Не удалось обработать ответ ИИ. Ничего не записано. Повторите запрос; описание задачи и контекст сохранены в этом чате.',sources:[],actions:[],usage,outcome:'failed',error:{code:'TASK_MODEL_OUTPUT_INVALID',retryable:true}};
    try{return {...await this.execute(command,input,all),usage};}
    catch(e){if(e instanceof Clarification||e instanceof DomainError&&['INVALID_DATE','INVALID_TIME','INVALID_DEADLINE','INVALID_SERIES','SERIES_BOUND_REQUIRED','TASK_LIMIT','DEADLINE_REQUIRED','INVALID_TIMEZONE','AMBIGUOUS_LOCAL_TIME'].includes(e.code))return {...this.draft(input,command,'Уточните запрос: '+e.message,[]),usage};throw e;}
  }
}
