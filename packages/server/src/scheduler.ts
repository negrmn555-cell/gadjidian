import { randomUUID } from 'node:crypto';
import { DomainError, defaultAutomationSettings, validateAutomationSettings, withoutMeasurements, type AutomationSettings, type ScheduledJob } from '@relay/core';
import type { Db } from './db.js';
export function localDate(ms:number,timezone:string):string {
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(ms).map(p=>[p.type,p.value]));return p.year+'-'+p.month+'-'+p.day;
}
export function scheduleInstant(date:string,time:string,timezone:string):number {
  const naive=Date.parse(date+'T'+time+':00Z'),fmt=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const local=(ms:number)=>{const p=Object.fromEntries(fmt.formatToParts(ms).map(p=>[p.type,p.value]));return p.year+'-'+p.month+'-'+p.day+'T'+p.hour+':'+p.minute;};
  const offsets=new Set<number>();for(let h=-36;h<=36;h+=6){const ms=naive+h*3600000;offsets.add(Date.parse(local(ms)+':00Z')-ms);}
  // First fold occurrence; gaps move to the first existing minute after the requested wall time.
  for(let minute=0;minute<=1440;minute++){const wall=naive+minute*60000,wanted=new Date(wall).toISOString().slice(0,16);const candidates=[...offsets].map(o=>wall-o).filter(ms=>local(ms)===wanted);if(candidates.length)return Math.min(...candidates);}
  throw new DomainError('SCHEDULE_TIME','Не удалось определить момент расписания.');
}
export class AutomationSettingsService {
  constructor(private db:Db,private now=()=>Date.now()){}
  get():AutomationSettings {return JSON.parse(this.db.getSetting('automation.settings')??JSON.stringify(defaultAutomationSettings()));}
  save(value:unknown):AutomationSettings {
    return this.db.providerTransaction(()=>{const next=validateAutomationSettings(value,this.get(),this.now());this.db.setSetting('automation.settings',JSON.stringify(next));this.db.sql.prepare("UPDATE jobs SET state='cancelled',last_error='SETTINGS_CHANGED' WHERE state='queued' AND kind IN ('organize','weekly_digest')").run();return next;});
  }
}
interface JobRow {id:string;kind:ScheduledJob['kind'];dedupe_key:string;scheduled_for:number;settings_version:number;state:ScheduledJob['state'];attempt:number;lease_until:number|null;lease_owner:string|null;fencing_token:number;last_error:string|null;payload_json:string;result_json:string|null}
export interface JobLease {job:ScheduledJob;payload:Record<string,unknown>;assert:()=>void;heartbeat:()=>void}
export class Scheduler {
  private owner=randomUUID();private timer:NodeJS.Timeout|null=null;private active=new Map<string,Promise<void>>();private stopped=false;private wakeTimer:NodeJS.Timeout|null=null;
  constructor(private db:Db,readonly settings:AutomationSettingsService,private handlers:Partial<Record<ScheduledJob['kind'],(lease:JobLease)=>Promise<unknown>>>,private now=()=>Date.now()){}
  private dto(r:JobRow):ScheduledJob{return {id:r.id,kind:r.kind,dedupeKey:r.dedupe_key,scheduledFor:r.scheduled_for,settingsVersion:r.settings_version,state:r.state,attempt:r.attempt,leaseUntil:r.lease_until,fencingToken:r.fencing_token,lastError:r.last_error,result:r.result_json?JSON.parse(r.result_json):null};}
  list():ScheduledJob[]{return (this.db.sql.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 60').all() as unknown as JobRow[]).map(r=>this.dto(r));}
  find(key:string):ScheduledJob|null{const row=this.db.sql.prepare('SELECT * FROM jobs WHERE dedupe_key=?').get(key) as unknown as JobRow|undefined;return row?this.dto(row):null;}
  recover():void{this.db.sql.exec("UPDATE jobs SET state=CASE WHEN kind IN ('weekly_digest','document') THEN 'unknown' ELSE 'queued' END,lease_owner=NULL,lease_until=NULL,last_error='SERVER_RESTART' WHERE state='running'");}
  enqueue(kind:ScheduledJob['kind'],key:string,when:number,version:number,payload:Record<string,unknown>={}):ScheduledJob {
    this.db.sql.prepare("INSERT OR IGNORE INTO jobs(id,kind,dedupe_key,scheduled_for,settings_version,state,payload_json,created_at) VALUES(?,?,?,?,?,'queued',?,?)").run('job_'+randomUUID(),kind,key,when,version,JSON.stringify(payload),this.now());
    const r=this.db.sql.prepare('SELECT * FROM jobs WHERE dedupe_key=?').get(key) as unknown as JobRow;
    // Only cancelled, never dispatched occurrences can follow a new schedule version.
    if(r.state==='cancelled'&&r.attempt===0&&version!==r.settings_version){this.db.sql.prepare("UPDATE jobs SET state='queued',scheduled_for=?,settings_version=?,payload_json=?,last_error=NULL WHERE id=?").run(when,version,JSON.stringify(payload),r.id);return this.dto({...r,state:'queued',scheduled_for:when,settings_version:version});}
    return this.dto(r);
  }
  private populate():void {
    const s=this.settings.get(),now=this.now();
    if(this.handlers.archive_completed)this.enqueue('archive_completed','archive-completed:'+Math.floor(now/3600000),now,s.version);
    for(const [kind,rule] of [['organize',s.organizer],['weekly_digest',s.digest]] as const) {
      if(!rule.enabled)continue;
      const date=localDate(now,rule.timezone),base=Date.parse(date+'T12:00:00Z');
      const due:{date:string;at:number}[]=[];
      for(let day=-7;day<=8;day++){const dt=new Date(base+day*86400000),iso=dt.toISOString().slice(0,10),weekday=(dt.getUTCDay()+6)%7+1;
        if(('weekdays' in rule?!rule.weekdays.includes(weekday):rule.weekday!==weekday))continue;
        const at=scheduleInstant(iso,rule.localTime,rule.timezone);if(at<s.changedAt)continue;due.push({date:iso,at});}
      const past=due.filter(x=>x.at<=now).sort((a,b)=>b.at-a.at)[0];
      if(past)this.db.sql.prepare("UPDATE jobs SET state='cancelled',last_error='COALESCED_CATCHUP' WHERE kind=? AND state='queued' AND attempt=0 AND scheduled_for<?").run(kind,past.at);
      for(const occurrence of due.filter(x=>x.at>now||x===past))this.enqueue(kind,kind+':'+occurrence.date+':default',occurrence.at,s.version,{localDate:occurrence.date,timezone:rule.timezone,scheduledAt:occurrence.at});
    }
  }
  tick():Promise<void> {
    return withoutMeasurements(()=>this.tickInternal());
  }
  private tickInternal():Promise<void> {
    for(const lane of ['summary','main'])if(!this.active.has(lane)){const work=this.work(lane).finally(()=>{this.active.delete(lane);if(!this.stopped&&this.db.sql.prepare("SELECT 1 FROM jobs WHERE state='queued' AND scheduled_for<=? AND (kind='summarize')=? LIMIT 1").get(this.now(),lane==='summary'?1:0))this.wake();});this.active.set(lane,work);}
    return Promise.all([...this.active.values()]).then(()=>{});
  }
  wake():void {if(!this.timer||this.stopped||this.wakeTimer)return;this.wakeTimer=setTimeout(()=>{this.wakeTimer=null;void this.tick().catch(()=>{});},0);this.wakeTimer.unref();}
  private async work(lane:string):Promise<void> {
    if(this.stopped)return;this.populate();
    // A dead digest with an unknown outbound result cannot safely be sent again.
    this.db.sql.prepare("UPDATE jobs SET state=CASE WHEN kind IN ('weekly_digest','document') THEN 'unknown' ELSE 'queued' END,lease_owner=NULL,lease_until=NULL,last_error='LEASE_EXPIRED' WHERE state='running' AND lease_until<=?").run(this.now());
    const row=this.db.sql.prepare("SELECT * FROM jobs WHERE state='queued' AND scheduled_for<=? AND (kind='summarize')=? ORDER BY scheduled_for,id LIMIT 1").get(this.now(),lane==='summary'?1:0) as unknown as JobRow|undefined;
    if(!row)return;
    const changed=this.db.sql.prepare("UPDATE jobs SET state='running',attempt=attempt+1,lease_owner=?,lease_until=?,fencing_token=fencing_token+1 WHERE id=? AND state='queued'").run(this.owner,this.now()+60000,row.id);
    if(!changed.changes)return;const token=row.fencing_token+1;
    const operational=row.kind==='extract'||row.kind==='summarize'||row.kind==='document'||row.kind==='archive_completed';
    const assert=()=>{const r=this.db.sql.prepare('SELECT state,lease_owner,lease_until,fencing_token FROM jobs WHERE id=?').get(row.id) as unknown as JobRow;const s=this.settings.get();const enabled=operational||(row.kind==='organize'?s.organizer.enabled:s.digest.enabled);
      if(!r||r.state!=='running'||r.lease_owner!==this.owner||r.fencing_token!==token||Number(r.lease_until)<=this.now())throw new DomainError('LEASE_LOST','Исполнитель задания потерял право записи.',409);
      if(!operational&&(!enabled||s.version!==row.settings_version))throw new DomainError('JOB_CANCELLED','Расписание изменено или отключено.',409);};
    const heartbeat=()=>{assert();this.db.sql.prepare('UPDATE jobs SET lease_until=? WHERE id=? AND lease_owner=? AND fencing_token=?').run(this.now()+60000,row.id,this.owner,token);};
    const interval=setInterval(()=>{try{heartbeat();}catch{}},15000);interval.unref();
    try {
      assert();
      const handler=this.handlers[row.kind];if(!handler)throw new DomainError('JOB_UNSUPPORTED','Обработчик задания не настроен.');
      const result=await handler({job:this.dto({...row,attempt:row.attempt+1,fencing_token:token,state:'running'}),payload:JSON.parse(row.payload_json),assert,heartbeat});assert();
      this.db.sql.prepare("UPDATE jobs SET state='succeeded',result_json=?,lease_owner=NULL,lease_until=NULL,last_error=NULL WHERE id=? AND lease_owner=? AND fencing_token=?").run(JSON.stringify(result??null),row.id,this.owner,token);
    }catch(e){const error=e instanceof DomainError?e.code:'JOB_FAILED';const retry=row.kind!=='document'&&['PROVIDER_TIMEOUT','PROVIDER_BUSY','ENDPOINT_UNAVAILABLE','PUBLISH_PENDING'].includes(error)&&row.attempt<4;
      const state=error==='JOB_CANCELLED'?'cancelled':error==='SEND_UNKNOWN'?'unknown':retry?'queued':'failed';
      this.db.sql.prepare('UPDATE jobs SET state=?,last_error=?,scheduled_for=?,lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=? AND fencing_token=?').run(state,error,this.now()+Math.min(300000,10000*2**row.attempt),row.id,this.owner,token);
    }finally{clearInterval(interval);}
  }
  start():void {this.timer=setInterval(()=>void this.tick().catch(()=>{}),15000);this.timer.unref();void this.tick().catch(()=>{});}
  async stop():Promise<void>{this.stopped=true;if(this.timer)clearInterval(this.timer);if(this.wakeTimer)clearTimeout(this.wakeTimer);await Promise.all([...this.active.values()]);}
  cancel(id:string):void{this.db.sql.prepare("UPDATE jobs SET state='cancelled',lease_owner=NULL,lease_until=NULL,fencing_token=fencing_token+1,last_error='JOB_CANCELLED' WHERE id=? AND state IN ('queued','running')").run(id);}
  retry(id:string):ScheduledJob {
    const r=this.db.sql.prepare('SELECT * FROM jobs WHERE id=?').get(id) as unknown as JobRow|undefined;
    if(!r)throw new DomainError('NOT_FOUND','Задание не найдено.',404);
    if(r.state!=='failed')throw new DomainError('JOB_STATE','Повтор разрешён только для завершившегося ошибкой задания.',409);
    this.db.sql.prepare("UPDATE jobs SET state='queued',scheduled_for=?,settings_version=? WHERE id=?").run(this.now(),this.settings.get().version,id);return {...this.dto(r),state:'queued'};
  }
}
