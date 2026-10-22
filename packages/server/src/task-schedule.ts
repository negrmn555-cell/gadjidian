import { DomainError, localDateTimeToInstant, validateLocalDate, validateTaskRecurrence, type Deadline, type TaskRecurrence } from '@relay/core';

export const MAX_TASK_BATCH = 100;

export function localDeadline(deadline: Deadline): {date:string; time?:string} {
  if (deadline.kind === 'by_date') return {date:deadline.date};
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:deadline.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(deadline.at)).map(p=>[p.type,p.value]));
  return {date:`${parts.year}-${parts.month}-${parts.day}`, time:`${parts.hour}:${parts.minute}`};
}

export function addCalendar(date:string, unit:'day'|'week'|'month'|'year', amount:number):string {
  validateLocalDate(date);
  if (!Number.isSafeInteger(amount) || Math.abs(amount)>100_000) throw new DomainError('INVALID_SERIES','Слишком большой календарный интервал.');
  const base = new Date(date+'T12:00:00Z');
  if (unit==='day' || unit==='week') base.setUTCDate(base.getUTCDate()+amount*(unit==='week'?7:1));
  else {
    const day=base.getUTCDate();
    base.setUTCDate(1);
    base.setUTCMonth(base.getUTCMonth()+amount*(unit==='year'?12:1));
    const last=new Date(Date.UTC(base.getUTCFullYear(),base.getUTCMonth()+1,0)).getUTCDate();
    base.setUTCDate(Math.min(day,last));
  }
  if (!Number.isFinite(base.getTime()) || base.getUTCFullYear()>9999) throw new DomainError('INVALID_SERIES','Дата серии вне поддерживаемого диапазона.');
  return validateLocalDate(base.toISOString().slice(0,10));
}

function onDate(anchor:Deadline,date:string):Deadline {
  const {time}=localDeadline(anchor);
  return anchor.kind==='by_date' ? {...anchor,date} : {...anchor,at:localDateTimeToInstant(date,time!,anchor.timezone)};
}

export function shiftDeadline(deadline:Deadline,unit:'day'|'week'|'month'|'year',amount:number):Deadline {
  return onDate(deadline,addCalendar(localDeadline(deadline).date,unit,amount));
}

function occurrenceDate(anchor:Deadline,rule:TaskRecurrence,index:number):string {
  const recurrence=validateTaskRecurrence(rule),{date}=localDeadline(anchor);
  if (!Number.isSafeInteger(index) || index<0 || index>100_000) throw new DomainError('INVALID_SERIES','Некорректный номер повторения.');
  if (recurrence.frequency==='weekly' && recurrence.weekdays) {
    const weekday=(new Date(date+'T12:00:00Z').getUTCDay()+6)%7+1;
    const monday=addCalendar(date,'day',1-weekday),first=recurrence.weekdays.filter(d=>d>=weekday);
    if (index<first.length) return addCalendar(monday,'day',first[index]-1);
    const rest=index-first.length,week=Math.floor(rest/recurrence.weekdays.length)+1,day=recurrence.weekdays[rest%recurrence.weekdays.length];
    return addCalendar(monday,'day',week*recurrence.interval*7+day-1);
  }
  const unit={daily:'day',weekly:'week',monthly:'month',yearly:'year'} as const;
  return addCalendar(date,unit[recurrence.frequency],index*recurrence.interval);
}

export function seriesOccurrence(anchor:Deadline,rule:TaskRecurrence,index:number):Deadline {
  return onDate(anchor,occurrenceDate(anchor,rule,index));
}

export function seriesDeadlines(anchor:Deadline,rule:TaskRecurrence,options:{count?:number|null;until?:string|null;startIndex?:number}):{deadline:Deadline;index:number}[] {
  const {count,until}=options,start=options.startIndex??0;
  if ((count!=null)===(until!=null)) throw new DomainError('SERIES_BOUND_REQUIRED','Укажите количество повторений или конечную дату серии.');
  if (count!=null && (!Number.isSafeInteger(count)||count<1||count>MAX_TASK_BATCH)) throw new DomainError('TASK_LIMIT',`За один запрос можно создать от 1 до ${MAX_TASK_BATCH} задач.`);
  if (until) validateLocalDate(until);
  const output:{deadline:Deadline;index:number}[]=[];
  for(let offset=0;offset<=(count??MAX_TASK_BATCH);offset++) {
    if(count!=null && offset===count)break;
    const index=start+offset,date=occurrenceDate(anchor,rule,index);
    if(until && date>until)break;
    if(output.length===MAX_TASK_BATCH)throw new DomainError('TASK_LIMIT',`Серия содержит больше ${MAX_TASK_BATCH} задач. Укажите более короткий период.`);
    output.push({deadline:onDate(anchor,date),index});
    if(until&&date===until)break;
  }
  if(!output.length)throw new DomainError('INVALID_SERIES','Конечная дата раньше первого нового срока серии.');
  return output;
}
