import { createHash } from 'node:crypto';
import webpush from 'web-push';
import { DomainError, objectInput, priorityOrder, taskCalendarDate, taskDeadlineSortKey, type AppNotification } from '@relay/core';
import type { Db } from './db.js';
import type { ServerConfig } from './config.js';
import { ProviderSecrets } from './provider-secrets.js';
import { guardedTransport } from './provider-transport.js';
import { localDate, type AutomationSettingsService, type JobLease } from './scheduler.js';
import type { TaskService } from './tasks.js';
import type { GitSync } from './sync.js';
const keyHash=(s:string)=>createHash('sha256').update(s).digest('hex');
export function pushSubscription(value:unknown):webpush.PushSubscription {
  const b=objectInput(value),keys=objectInput(b.keys);if(typeof b.endpoint!=='string'||b.endpoint.length>4096)throw new DomainError('PUSH_SUBSCRIPTION','Некорректная подписка.');
  let u:URL;try{u=new URL(b.endpoint);}catch{throw new DomainError('PUSH_ENDPOINT','Некорректный адрес подписки.');}const host=u.hostname.toLowerCase();
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||!(['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'].includes(host)||host.endsWith('.notify.windows.com')))throw new DomainError('PUSH_ENDPOINT','Неизвестный сервер браузерных уведомлений.');
  const key=(v:unknown,length:number)=>{if(typeof v!=='string'||!/^[A-Za-z0-9_-]+={0,2}$/.test(v)||Buffer.from(v,'base64url').length!==length)throw new DomainError('PUSH_SUBSCRIPTION','Некорректный ключ подписки.');return v;};
  return {endpoint:u.href,keys:{p256dh:key(keys.p256dh,65),auth:key(keys.auth,16)}};
}
export class NotificationService {
  private constructor(private db:Db,private cfg:ServerConfig,private secrets:ProviderSecrets,private settings:AutomationSettingsService,private tasks:TaskService,private sync:GitSync,private keys:webpush.VapidKeys,private transport:typeof fetch,private now:()=>number){}
  static async open(db:Db,cfg:ServerConfig,settings:AutomationSettingsService,tasks:TaskService,sync:GitSync,transport=guardedTransport([],20000),now=()=>Date.now()):Promise<NotificationService> {
    const saved=db.getSetting('push.vapid'),secrets=await ProviderSecrets.open(cfg,!saved&&!db.providerRows().some(r=>r.secret));
    const keys=saved?JSON.parse(secrets.decrypt(saved,'push-vapid',1)) as webpush.VapidKeys:webpush.generateVAPIDKeys();
    if(!saved)db.setSetting('push.vapid',secrets.encrypt(JSON.stringify(keys),'push-vapid',1));
    return new NotificationService(db,cfg,secrets,settings,tasks,sync,keys,transport,now);
  }
  publicKey():string{return this.keys.publicKey;}
  status(device:number):{publicKey:string;subscribed:boolean;deliveries:{state:string;count:number}[]} {
    return {publicKey:this.publicKey(),subscribed:!!this.db.sql.prepare('SELECT 1 FROM push_subscriptions WHERE device_id=?').get(device),deliveries:this.db.sql.prepare('SELECT d.state,COUNT(*) AS count FROM push_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id WHERE s.device_id=? GROUP BY d.state').all(device) as unknown as {state:string;count:number}[]};
  }
  subscribe(device:number,value:unknown):void {
    const subscription=pushSubscription(value),id=keyHash(subscription.endpoint);
    const owner=this.db.sql.prepare('SELECT device_id FROM push_subscriptions WHERE id=?').get(id) as {device_id:number}|undefined;
    if(owner&&owner.device_id!==device)throw new DomainError('PUSH_OWNER','Эта подписка принадлежит другому устройству.',409);
    const count=this.db.sql.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE device_id=?').get(device) as {n:number};if(!owner&&count.n>=5)throw new DomainError('PUSH_LIMIT','Лимит подписок устройства.',409);
    this.db.sql.prepare('INSERT OR REPLACE INTO push_subscriptions VALUES(?,?,?,?)').run(id,device,this.secrets.encrypt(JSON.stringify(subscription),'push-'+id,1),this.now());
  }
  unsubscribe(device:number):void {this.db.sql.prepare('DELETE FROM push_subscriptions WHERE device_id=?').run(device);}
  list(device:number):AppNotification[]{return (this.db.sql.prepare('SELECT n.*,EXISTS(SELECT 1 FROM notification_reads r WHERE r.notification_id=n.id AND r.device_id=?) AS is_read FROM notifications n WHERE created_at>? ORDER BY created_at DESC LIMIT 50').all(device,this.now()-30*86400000) as Record<string,unknown>[]).map(r=>({id:String(r.id),title:String(r.title),body:String(r.body),createdAt:Number(r.created_at),read:!!r.is_read}));}
  read(device:number,id:string):void {if(!this.db.sql.prepare('SELECT 1 FROM notifications WHERE id=?').get(id))throw new DomainError('NOT_FOUND','Уведомление не найдено.',404);this.db.sql.prepare('INSERT OR IGNORE INTO notification_reads VALUES(?,?)').run(id,device);}
  async digest(lease:JobLease):Promise<unknown> {
    lease.assert();const s=this.settings.get(),rule=s.digest,now=this.now(),occurrence=String(lease.payload.localDate??localDate(now,rule.timezone));
    const scheduled=Number(lease.payload.scheduledAt??lease.job.scheduledFor);
    if(now-scheduled>30*60000||localDate(now,rule.timezone)!==occurrence)return {status:'skipped_missed_window'};
    if(s.organizer.enabled&&s.organizer.weekdays.includes(rule.weekday)){
      const {scheduleInstant}=await import('./scheduler.js');if(now>=scheduleInstant(occurrence,s.organizer.localTime,s.organizer.timezone))return {status:'skipped_missed_window'};
    }
    await this.sync.pull();lease.assert();
    const date=localDate(now,rule.timezone),end=new Date(date+'T12:00:00Z'),weekday=(end.getUTCDay()+6)%7;end.setUTCDate(end.getUTCDate()-weekday+7);const exclusive=end.toISOString().slice(0,10);end.setUTCDate(end.getUTCDate()-7);const start=end.toISOString().slice(0,10);
    const created=await this.sync.exclusive(async()=>{const page=await this.tasks.list();lease.assert();
    const tasks=page.items.filter(t=>t.status!=='done'&&t.status!=='cancelled').filter(t=>{const d=taskCalendarDate(t,rule.timezone);return d<exclusive&&(rule.includeOverdue||d>=start);}).sort((a,b)=>priorityOrder[a.priority]-priorityOrder[b.priority]||taskDeadlineSortKey(a).localeCompare(taskDeadlineSortKey(b))||a.id.localeCompare(b.id));
    if(!tasks.length)return {status:'skipped_empty',invalidCount:page.invalidRecords.length};
    const chosen=tasks.slice(0,rule.maxItems),body=chosen.map(t=>'☐ '+t.title.slice(0,100)+' · '+taskCalendarDate(t,rule.timezone)).join('\n')+(tasks.length>chosen.length?'\nЕщё '+(tasks.length-chosen.length):'');
    lease.assert();const id='notification_'+keyHash(lease.job.dedupeKey);
    this.db.sql.prepare('INSERT OR IGNORE INTO notifications(id,dedupe_key,title,body,result_json,created_at) VALUES(?,?,?,?,?,?)').run(id,lease.job.dedupeKey,'Ещё не завершены к концу недели',body,JSON.stringify({taskIds:chosen.map(t=>t.id),periodStart:start,periodEndExclusive:exclusive,generatedAt:now}),now);
    return {status:'created',notificationId:id,itemCount:chosen.length};});
    if(typeof created.notificationId==='string')await this.deliver(created.notificationId,lease.assert);return created;
  }
  async deliver(id:string,guard:()=>void=()=>{}):Promise<void> {
    const item=this.db.sql.prepare('SELECT title,body FROM notifications WHERE id=?').get(id) as {title:string;body:string}|undefined;if(!item)return;
    const subscriptions=this.db.sql.prepare('SELECT s.id,s.encrypted_json FROM push_subscriptions s JOIN devices d ON d.id=s.device_id WHERE d.revoked_at IS NULL').all() as {id:string;encrypted_json:string}[];
    for(const row of subscriptions){guard();const prior=this.db.sql.prepare('SELECT state FROM push_deliveries WHERE notification_id=? AND subscription_id=?').get(id,row.id);if(prior)continue;
      const subscription=pushSubscription(JSON.parse(this.secrets.decrypt(row.encrypted_json,'push-'+row.id,1)));
      const details=webpush.generateRequestDetails(subscription,JSON.stringify({id,title:item.title,body:item.body,url:'/'}),{TTL:1800,vapidDetails:{subject:process.env.WEB_PUSH_SUBJECT||'mailto:relay@localhost',publicKey:this.keys.publicKey,privateKey:this.keys.privateKey}});
      guard();this.db.sql.prepare("INSERT INTO push_deliveries VALUES(?,?,'dispatching',NULL)").run(id,row.id);
      try{const response=await this.transport(details.endpoint,{method:details.method,headers:details.headers as Record<string,string>,body:details.body as NonNullable<Parameters<typeof fetch>[1]>['body']});await response.body?.cancel();
        const state=response.ok?'accepted':response.status===404||response.status===410?'expired':'rejected';this.db.sql.prepare('UPDATE push_deliveries SET state=?,error_code=? WHERE notification_id=? AND subscription_id=?').run(state,response.ok?null:'HTTP_'+response.status,id,row.id);
        if(state==='expired')this.db.sql.prepare('DELETE FROM push_subscriptions WHERE id=?').run(row.id);
      }catch{this.db.sql.prepare("UPDATE push_deliveries SET state='unknown',error_code='NETWORK' WHERE notification_id=? AND subscription_id=?").run(id,row.id);}
    }
  }
  prune(recover=true):void {
    if(recover)this.db.sql.exec("UPDATE push_deliveries SET state='unknown' WHERE state='dispatching'");
    this.db.sql.prepare('DELETE FROM notifications WHERE created_at<=?').run(this.now()-30*86400000);
    this.db.sql.exec('DELETE FROM notification_reads WHERE notification_id NOT IN(SELECT id FROM notifications); DELETE FROM push_deliveries WHERE notification_id NOT IN(SELECT id FROM notifications); DELETE FROM push_subscriptions WHERE device_id NOT IN(SELECT id FROM devices WHERE revoked_at IS NULL);');
  }
}
