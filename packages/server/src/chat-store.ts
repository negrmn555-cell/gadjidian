import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DomainError, validateTimezone, type ChatSession, type ChatMode, type TaskDraftState, type Attachment, type ExtractionReport, type ChatMemory } from '@relay/core';
import type { StoredMessage } from './db.js';

export const CHAT_RETENTION_MS = 14 * 86_400_000;
export interface StoredAttachment extends Attachment { bytes: Buffer; text: string; report:ExtractionReport|null }
/** All conversation state and uploaded bytes live in this short-lived database. */
export class ChatStore {
  private readonly db: DatabaseSync;
  constructor(file: string, private readonly now = () => Date.now()) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id INTEGER NOT NULL, chat TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, meta TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(device_id,chat,id);
      CREATE INDEX IF NOT EXISTS idx_messages_expiry ON messages(created_at);
      CREATE TABLE IF NOT EXISTS chats (id TEXT NOT NULL, device_id INTEGER NOT NULL, entry_id TEXT, title TEXT NOT NULL, mode TEXT NOT NULL, timezone TEXT NOT NULL, version INTEGER NOT NULL, pending TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(device_id,id), UNIQUE(device_id,entry_id));
      CREATE TABLE IF NOT EXISTS chat_runs (device_id INTEGER NOT NULL, chat TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(device_id,chat,request_id));
      CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, device_id INTEGER NOT NULL, chat TEXT NOT NULL, name TEXT NOT NULL, media_type TEXT NOT NULL, kind TEXT NOT NULL, bytes BLOB NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_memory (device_id INTEGER NOT NULL, chat TEXT NOT NULL, value_json TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(device_id,chat));`);
    if (!(this.db.prepare('PRAGMA table_info(attachments)').all() as {name:string}[]).some(c=>c.name==='report_json'))this.db.exec('ALTER TABLE attachments ADD COLUMN report_json TEXT');
    if(!(this.db.prepare('PRAGMA table_info(attachments)').all() as {name:string}[]).some(c=>c.name==='processing'))this.db.exec("ALTER TABLE attachments ADD COLUMN processing TEXT NOT NULL DEFAULT 'ready'; ALTER TABLE attachments ADD COLUMN processing_error TEXT");
    this.db.exec('PRAGMA user_version=3;');
    if(!(this.db.prepare('PRAGMA table_info(chats)').all() as {name:string}[]).some(c=>c.name==='provider_id'))this.db.exec('ALTER TABLE chats ADD COLUMN provider_id TEXT');
    this.prune(); this.importSessions();
  }
  private importSessions(): void {
    const groups = this.db.prepare('SELECT device_id,chat,MIN(created_at) AS created,MAX(created_at) AS updated FROM messages WHERE created_at > ? GROUP BY device_id,chat').all(this.now()-CHAT_RETENTION_MS) as Record<string, unknown>[];
    const insert = this.db.prepare("INSERT OR IGNORE INTO chats(id,device_id,entry_id,title,mode,timezone,version,pending,created_at,updated_at,expires_at) VALUES(?,?,NULL,?,'note','Europe/Moscow',1,NULL,?,?,?)");
    for (const g of groups) {
      const first = this.db.prepare("SELECT content FROM messages WHERE device_id=? AND chat=? AND role='user' ORDER BY id LIMIT 1").get(g.device_id as number,g.chat as string) as {content:string}|undefined;
      insert.run(g.chat as string,g.device_id as number,(first?.content ?? 'Предыдущий чат').slice(0,80),g.created as number,g.updated as number,Number(g.created)+CHAT_RETENTION_MS);
    }
  }
  create(device: number, entryId: string, timezone: unknown): ChatSession {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(entryId)) throw new DomainError('INVALID_ENTRY','Некорректный идентификатор входа.');
    validateTimezone(timezone);
    const existing = this.db.prepare('SELECT id FROM chats WHERE device_id=? AND entry_id=?').get(device,entryId) as {id:string}|undefined;
    if (existing) return this.get(device,existing.id);
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM chats WHERE device_id=? AND expires_at>?').get(device,this.now()) as {n:number};
    if (count.n >= 500) throw new DomainError('CHAT_LIMIT','Слишком много чатов за 14 дней.',429);
    const id = 'chat_'+randomUUID(); const now=this.now();
    this.db.prepare("INSERT INTO chats(id,device_id,entry_id,title,mode,timezone,version,pending,created_at,updated_at,expires_at) VALUES(?,?,?,'Новый чат','note',?,1,NULL,?,?,?)").run(id,device,entryId,timezone as string,now,now,now+CHAT_RETENTION_MS);
    return this.get(device,id);
  }
  get(device: number, id: string): ChatSession {
    const r = this.db.prepare('SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.device_id=c.device_id AND m.chat=c.id AND m.created_at>?) AS count FROM chats c WHERE device_id=? AND id=? AND expires_at>?').get(this.now()-CHAT_RETENTION_MS,device,id,this.now()) as Record<string,unknown>|undefined;
    if (!r) throw new DomainError('CHAT_NOT_FOUND','Чат не найден или срок хранения истёк. Откройте новый чат.',404);
    let pending = r.pending ? JSON.parse(String(r.pending)) as TaskDraftState : null;
    if (pending && pending.createdAt <= this.now()-CHAT_RETENTION_MS) pending=null;
    return {id:String(r.id),title:String(r.title),mode:r.mode as ChatMode,timezone:String(r.timezone),version:Number(r.version),createdAt:Number(r.created_at),updatedAt:Number(r.updated_at),expiresAt:Number(r.expires_at),messageCount:Number(r.count),pendingTask:pending,providerId:r.provider_id as string|null};
  }
  sessions(device: number): ChatSession[] {
    return (this.db.prepare('SELECT id FROM chats WHERE device_id=? AND expires_at>? ORDER BY updated_at DESC,id LIMIT 500').all(device,this.now()) as {id:string}[]).map(r=>this.get(device,r.id));
  }
  changeMode(device:number,id:string,mode:unknown,expected:unknown): ChatSession {
    const chat=this.get(device,id);
    if (mode!=='task' && mode!=='note') throw new DomainError('INVALID_MODE','Выберите режим Задача или Заметка.');
    if (chat.version!==expected) throw new DomainError('CHAT_VERSION_CONFLICT','Чат изменился. Обновите его.',409);
    this.db.prepare('UPDATE chats SET mode=?,version=version+1 WHERE device_id=? AND id=?').run(mode,device,id);
    return this.get(device,id);
  }
  rename(device:number,id:string,title:unknown,expected:unknown):ChatSession{const chat=this.get(device,id);if(chat.version!==expected)throw new DomainError('CHAT_VERSION_CONFLICT','Чат изменился.',409);if(typeof title!=='string'||!title.trim()||title.trim().length>80)throw new DomainError('VALIDATION_ERROR','Название должно содержать от 1 до 80 символов.');this.db.prepare('UPDATE chats SET title=?,version=version+1 WHERE device_id=? AND id=?').run(title.trim(),device,id);return this.get(device,id);}
  remove(device:number,id:string,expected:unknown):void{if(this.get(device,id).version!==expected)throw new DomainError('CHAT_VERSION_CONFLICT','Чат изменился.',409);this.clear(device,id);this.db.prepare('DELETE FROM chats WHERE device_id=? AND id=?').run(device,id);}
  setDraft(device:number,id:string,draft:TaskDraftState|null): void { this.get(device,id); this.db.prepare('UPDATE chats SET pending=? WHERE device_id=? AND id=?').run(draft?JSON.stringify(draft):null,device,id); }
  bindProvider(device:number,id:string,provider:string|null,expected:number):ChatSession{if(this.get(device,id).version!==expected)throw new DomainError('CHAT_VERSION_CONFLICT','Чат изменился.',409);this.db.prepare('UPDATE chats SET provider_id=?,version=version+1 WHERE device_id=? AND id=?').run(provider,device,id);return this.get(device,id);}
  usesProvider(id:string):boolean{return !!this.db.prepare('SELECT 1 FROM chats WHERE provider_id=? AND expires_at>?').get(id,this.now());}
  pendingExtractions():{device:number;chat:string;id:string;expiresAt:number}[]{return (this.db.prepare("SELECT device_id,chat,id,expires_at FROM attachments WHERE processing IN ('queued','running') AND expires_at>?").all(this.now()) as {device_id:number;chat:string;id:string;expires_at:number}[]).map(r=>({device:r.device_id,chat:r.chat,id:r.id,expiresAt:r.expires_at}));}
  beginRun(device:number,id:string,request:string,hash:string): {result:unknown}|null {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(request)) throw new DomainError('INVALID_REQUEST_ID','Некорректный requestId.');
    const row=this.db.prepare('SELECT input_hash,result FROM chat_runs WHERE device_id=? AND chat=? AND request_id=?').get(device,id,request) as {input_hash:string;result:string|null}|undefined;
    if (row) {
      if (row.input_hash!==hash) throw new DomainError('IDEMPOTENCY_KEY_REUSED','requestId уже использован для другого сообщения.',409);
      if (!row.result) throw new DomainError('RUN_UNRESOLVED','Запрос ещё выполняется или был прерван. Проверьте историю и результаты перед повторной отправкой.',409);
      return {result:JSON.parse(row.result)};
    }
    this.db.prepare('INSERT INTO chat_runs VALUES(?,?,?,?,NULL,?)').run(device,id,request,hash,this.now()); return null;
  }
  finishRun(device:number,id:string,request:string,result:unknown): void { this.db.prepare('UPDATE chat_runs SET result=? WHERE device_id=? AND chat=? AND request_id=?').run(JSON.stringify(result),device,id,request); }
  run(device:number,chat:string,request:string):{result:unknown|null;hash:string}|null {const r=this.db.prepare('SELECT input_hash,result FROM chat_runs WHERE device_id=? AND chat=? AND request_id=? AND created_at>?').get(device,chat,request,this.now()-CHAT_RETENTION_MS) as {input_hash:string;result:string|null}|undefined;return r?{result:r.result?JSON.parse(r.result):null,hash:r.input_hash}:null;}
  importLegacy(rows: StoredMessage[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insert=this.db.prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?,?)');
      for (const r of rows) if (r.createdAt>this.now()-CHAT_RETENTION_MS) insert.run(r.id,r.deviceId,r.chat,r.role,r.content,r.meta,r.createdAt);
      this.db.exec('COMMIT'); this.importSessions();
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  add(deviceId:number,chat:string,role:'user'|'assistant',content:string,meta?:unknown):number {
    const id=Number(this.db.prepare('INSERT INTO messages(device_id,chat,role,content,meta,created_at) VALUES(?,?,?,?,?,?)').run(deviceId,chat,role,content,meta===undefined?null:JSON.stringify(meta),this.now()).lastInsertRowid);
    if(role==='user') this.db.prepare("UPDATE chats SET title=CASE WHEN title='Новый чат' THEN ? ELSE title END,updated_at=? WHERE device_id=? AND id=?").run(content.slice(0,80)||'Вложения',this.now(),deviceId,chat);
    else this.db.prepare('UPDATE chats SET updated_at=? WHERE device_id=? AND id=?').run(this.now(),deviceId,chat);
    return id;
  }
  list(deviceId:number,chat:string,limit=50,beforeId?:number):StoredMessage[] {
    const rows=this.db.prepare('SELECT * FROM messages WHERE device_id=? AND chat=? AND created_at>? AND id<? ORDER BY id DESC LIMIT ?').all(deviceId,chat,this.now()-CHAT_RETENTION_MS,beforeId??Number.MAX_SAFE_INTEGER,Math.max(1,Math.min(200,Math.trunc(limit)||50))) as Record<string,unknown>[];
    return rows.reverse().map(r=>({id:Number(r.id),deviceId:Number(r.device_id),chat:String(r.chat),role:r.role as StoredMessage['role'],content:String(r.content),meta:r.meta as string|null,createdAt:Number(r.created_at)}));
  }
  putAttachment(device:number,chat:string,name:string,mediaType:string,kind:'text'|'image',bytes:Buffer,text:string,report?:ExtractionReport):Attachment {
    this.get(device,chat);
    const total=this.db.prepare("SELECT COALESCE(SUM(length(bytes)+length(CAST(text AS BLOB))+length(CAST(COALESCE(report_json,'') AS BLOB))),0) AS size FROM attachments WHERE device_id=? AND expires_at>?").get(device,this.now()) as {size:number};
    if(total.size+bytes.length+Buffer.byteLength(text)+Buffer.byteLength(report?JSON.stringify(report):'')>50*1024*1024) throw new DomainError('UPLOAD_QUOTA','Лимит временных файлов и распознанного текста — 50 МБ на устройство.',413);
    const now=this.now(),id='file_'+randomUUID(); const expiry=Math.min(now+CHAT_RETENTION_MS,this.get(device,chat).expiresAt);
    this.db.prepare('INSERT INTO attachments(id,device_id,chat,name,media_type,kind,bytes,text,created_at,expires_at,report_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,device,chat,name,mediaType,kind,bytes,text,now,expiry,report?JSON.stringify(report):null);
    const {bytes:_bytes,text:_text,report:_report,...publicFile}=this.attachment(device,chat,id); return publicFile;
  }
  attachment(device:number,chat:string,id:string):StoredAttachment {
    this.get(device,chat);
    const r=this.db.prepare('SELECT * FROM attachments WHERE id=? AND device_id=? AND chat=? AND expires_at>?').get(id,device,chat,this.now()) as Record<string,unknown>|undefined;
    if(!r) throw new DomainError('ATTACHMENT_NOT_FOUND','Файл недоступен в этом чате или срок хранения истёк.',404);
    const report=r.report_json?JSON.parse(String(r.report_json)) as ExtractionReport:null;
    return {id:String(r.id),chatId:chat,name:String(r.name),mediaType:String(r.media_type),kind:r.kind as 'text'|'image',bytes:Buffer.from(r.bytes as Uint8Array),text:String(r.text),textLength:String(r.text).length,size:(r.bytes as Uint8Array).length,createdAt:Number(r.created_at),expiresAt:Number(r.expires_at),report,processing:r.processing as Attachment['processing'],processingError:r.processing_error as string|null,...(report?{extraction:{status:report.status,pages:report.pages.length,warnings:[...report.warnings,...report.pages.flatMap(p=>p.warnings)]}}:{})};
  }
  extractionState(device:number,chat:string,id:string,state:NonNullable<Attachment['processing']>,error:string|null=null):void{this.attachment(device,chat,id);this.db.prepare('UPDATE attachments SET processing=?,processing_error=? WHERE id=? AND device_id=? AND chat=?').run(state,error,id,device,chat);}
  extracted(device:number,chat:string,id:string,text:string,report:ExtractionReport):void {
    const old=this.attachment(device,chat,id),total=this.db.prepare("SELECT COALESCE(SUM(length(bytes)+length(CAST(text AS BLOB))+length(CAST(COALESCE(report_json,'') AS BLOB))),0) AS size FROM attachments WHERE device_id=? AND id<>? AND expires_at>?").get(device,id,this.now()) as {size:number};
    if(total.size+old.bytes.length+Buffer.byteLength(text)+Buffer.byteLength(JSON.stringify(report))>50*1024*1024)throw new DomainError('UPLOAD_QUOTA','Лимит временного распознанного текста превышен.',413);
    this.db.prepare("UPDATE attachments SET text=?,report_json=?,processing='ready',processing_error=NULL WHERE id=? AND device_id=? AND chat=? AND expires_at>?").run(text,JSON.stringify(report),id,device,chat,this.now());
  }
  clear(device:number,chat:string):void {
    this.db.exec('BEGIN IMMEDIATE');
    try { for(const table of ['messages','attachments','chat_runs','chat_memory']) this.db.prepare(`DELETE FROM ${table} WHERE device_id=? AND chat=?`).run(device,chat); this.db.prepare("UPDATE chats SET pending=NULL,title='Новый чат',version=version+1 WHERE device_id=? AND id=?").run(device,chat); this.db.exec('COMMIT'); }
    catch(e){this.db.exec('ROLLBACK');throw e;} this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  prune():void {
    const cutoff=this.now()-CHAT_RETENTION_MS;
    this.db.prepare('DELETE FROM messages WHERE created_at<=? OR EXISTS(SELECT 1 FROM chats c WHERE c.device_id=messages.device_id AND c.id=messages.chat AND c.expires_at<=?)').run(cutoff,this.now());
    this.db.prepare('DELETE FROM attachments WHERE expires_at<=?').run(this.now());
    this.db.prepare('DELETE FROM chat_runs WHERE created_at<=? OR EXISTS(SELECT 1 FROM chats c WHERE c.device_id=chat_runs.device_id AND c.id=chat_runs.chat AND c.expires_at<=?)').run(cutoff,this.now());
    this.db.prepare('DELETE FROM chats WHERE expires_at<=?').run(this.now());
    this.db.prepare('DELETE FROM chat_memory WHERE expires_at<=?').run(this.now());
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  close():void{this.db.close();}
  memory(device:number,chat:string):ChatMemory {
    const session=this.get(device,chat),r=this.db.prepare('SELECT value_json FROM chat_memory WHERE device_id=? AND chat=? AND expires_at>?').get(device,chat,this.now()) as {value_json:string}|undefined;
    return r?JSON.parse(r.value_json):{summary:'',throughMessageId:0,coverage:[],sources:[],expiresAt:session.expiresAt};
  }
  saveMemory(device:number,chat:string,memory:ChatMemory):void {
    const c=this.get(device,chat);if(memory.expiresAt>c.expiresAt || memory.expiresAt<=this.now())throw new DomainError('MEMORY_EXPIRED','Срок памяти истёк.');
    this.db.prepare('INSERT INTO chat_memory VALUES(?,?,?,?) ON CONFLICT(device_id,chat) DO UPDATE SET value_json=excluded.value_json,expires_at=excluded.expires_at').run(device,chat,JSON.stringify(memory),memory.expiresAt);
  }
  since(device:number,chat:string,afterId:number,limit=200):StoredMessage[] {
    this.get(device,chat);return (this.db.prepare('SELECT * FROM messages WHERE device_id=? AND chat=? AND id>? AND created_at>? ORDER BY id LIMIT ?').all(device,chat,afterId,this.now()-CHAT_RETENTION_MS,limit) as Record<string,unknown>[]).map(r=>({id:Number(r.id),deviceId:device,chat,role:r.role as StoredMessage['role'],content:String(r.content),meta:r.meta as string|null,createdAt:Number(r.created_at)}));
  }
}
