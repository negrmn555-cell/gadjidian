import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DomainError, validateTimezone, type ChatSession, type ChatMode, type TaskDraftState, type Attachment, type ExtractionReport, type ChatMemory } from '@relay/core';
import type { StoredMessage } from './db.js';
import { RunEvents } from './run-events.js';

export const CHAT_RETENTION_MS = 14 * 86_400_000;
export interface StoredAttachment extends Attachment { bytes: Buffer; text: string; report:ExtractionReport|null }
export interface SummaryRequest { device: number; chat: string; generation: number; target: number; providerId: string | null; providerVersion: number | null; force: boolean; expiresAt: number; revision:number }
/** All conversation state and uploaded bytes live in this short-lived database. */
export class ChatStore {
  private readonly db: DatabaseSync;
  readonly events: RunEvents;
  constructor(file: string, private readonly now = () => Date.now()) {
    this.db = new DatabaseSync(file);
    this.events = new RunEvents(this.db, this.now);
    this.db.exec('CREATE TABLE IF NOT EXISTS extraction_cache(device_id INTEGER NOT NULL,chat TEXT NOT NULL,cache_key TEXT NOT NULL,value_json TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(device_id,chat,cache_key));CREATE TABLE IF NOT EXISTS document_runs(device_id INTEGER NOT NULL,chat TEXT NOT NULL,id TEXT NOT NULL,value_json TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(device_id,chat,id))');
    this.db.exec('CREATE TABLE IF NOT EXISTS preference_conflicts(device_id INTEGER NOT NULL,operation_id TEXT NOT NULL,value_json TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(device_id,operation_id))');
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
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
    if(!(this.db.prepare('PRAGMA table_info(chats)').all() as {name:string}[]).some(c=>c.name==='memory_generation'))this.db.exec('ALTER TABLE chats ADD COLUMN memory_generation INTEGER NOT NULL DEFAULT 0');
    this.db.exec('CREATE TABLE IF NOT EXISTS chat_memory_versions(device_id INTEGER NOT NULL,chat TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(device_id,chat))');
    this.db.exec(`CREATE TABLE IF NOT EXISTS summary_requests(device_id INTEGER NOT NULL,chat TEXT NOT NULL,generation INTEGER NOT NULL,target INTEGER NOT NULL,provider_id TEXT,provider_version INTEGER,force INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL,PRIMARY KEY(device_id,chat)); PRAGMA user_version=4;`);
    if(!(this.db.prepare('PRAGMA table_info(summary_requests)').all() as {name:string}[]).some(c=>c.name==='request_version'))this.db.exec('ALTER TABLE summary_requests ADD COLUMN request_version INTEGER NOT NULL DEFAULT 1');
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
  finishRun(device:number,id:string,request:string,result:unknown,summary?:{providerId:string|null;providerVersion:number|null}): void {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('UPDATE chat_runs SET result=? WHERE device_id=? AND chat=? AND request_id=?').run(JSON.stringify(result),device,id,request); if(summary)this.requestSummary(device,id,summary.providerId,summary.providerVersion); this.db.exec('COMMIT'); }
    catch(e){this.db.exec('ROLLBACK');throw e;}
  }
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
    return {id:String(r.id),chatId:chat,name:String(r.name),mediaType:String(r.media_type),kind:r.kind as 'text'|'image',bytes:Buffer.from(r.bytes as Uint8Array),text:String(r.text),textLength:String(r.text).length,size:(r.bytes as Uint8Array).length,createdAt:Number(r.created_at),expiresAt:Number(r.expires_at),report,processing:r.processing as Attachment['processing'],processingError:r.processing_error as string|null,...(report?{extraction:{status:report.status,pages:report.pages.length,visualPages:report.pages.filter(p=>p.classification==='visual'||p.classification==='scan').map(p=>p.number),analyzedPages:report.pages.filter(p=>p.interpretation).map(p=>p.number),warnings:[...report.warnings,...report.pages.flatMap(p=>p.warnings)]}}:{})};
  }
  extractionState(device:number,chat:string,id:string,state:NonNullable<Attachment['processing']>,error:string|null=null):void{this.attachment(device,chat,id);this.db.prepare('UPDATE attachments SET processing=?,processing_error=? WHERE id=? AND device_id=? AND chat=?').run(state,error,id,device,chat);}
  extracted(device:number,chat:string,id:string,text:string,report:ExtractionReport):void {
    const old=this.attachment(device,chat,id),total=this.db.prepare("SELECT COALESCE(SUM(length(bytes)+length(CAST(text AS BLOB))+length(CAST(COALESCE(report_json,'') AS BLOB))),0) AS size FROM attachments WHERE device_id=? AND id<>? AND expires_at>?").get(device,id,this.now()) as {size:number};
    if(total.size+old.bytes.length+Buffer.byteLength(text)+Buffer.byteLength(JSON.stringify(report))>50*1024*1024)throw new DomainError('UPLOAD_QUOTA','Лимит временного распознанного текста превышен.',413);
    this.db.prepare("UPDATE attachments SET text=?,report_json=?,processing='ready',processing_error=NULL WHERE id=? AND device_id=? AND chat=? AND expires_at>?").run(text,JSON.stringify(report),id,device,chat,this.now());
  }
  clear(device:number,chat:string):void {
    this.db.exec('BEGIN IMMEDIATE');
    try { for(const table of ['messages','attachments','chat_runs','chat_memory','chat_memory_versions','summary_requests','run_snapshots','run_events','extraction_cache','document_runs']) this.db.prepare(`DELETE FROM ${table} WHERE device_id=? AND chat=?`).run(device,chat); this.db.prepare("UPDATE chats SET pending=NULL,title='Новый чат',version=version+1,memory_generation=memory_generation+1 WHERE device_id=? AND id=?").run(device,chat); this.db.exec('COMMIT'); }
    catch(e){this.db.exec('ROLLBACK');throw e;} this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  prune():void {
    this.db.prepare('DELETE FROM preference_conflicts WHERE expires_at<=?').run(this.now());
    this.events.prune();
    for(const table of ['extraction_cache','document_runs'])this.db.prepare('DELETE FROM '+table+' WHERE expires_at<=?').run(this.now());
    const cutoff=this.now()-CHAT_RETENTION_MS;
    this.db.prepare('DELETE FROM messages WHERE created_at<=? OR EXISTS(SELECT 1 FROM chats c WHERE c.device_id=messages.device_id AND c.id=messages.chat AND c.expires_at<=?)').run(cutoff,this.now());
    this.db.prepare('DELETE FROM attachments WHERE expires_at<=?').run(this.now());
    this.db.prepare('DELETE FROM chat_runs WHERE created_at<=? OR EXISTS(SELECT 1 FROM chats c WHERE c.device_id=chat_runs.device_id AND c.id=chat_runs.chat AND c.expires_at<=?)').run(cutoff,this.now());
    this.db.prepare('DELETE FROM chats WHERE expires_at<=?').run(this.now());
    this.db.prepare('DELETE FROM chat_memory WHERE expires_at<=?').run(this.now());
    this.db.exec('DELETE FROM chat_memory_versions WHERE NOT EXISTS(SELECT 1 FROM chat_memory m WHERE m.device_id=chat_memory_versions.device_id AND m.chat=chat_memory_versions.chat)');
    this.db.prepare('DELETE FROM summary_requests WHERE expires_at<=? OR NOT EXISTS(SELECT 1 FROM chats c WHERE c.device_id=summary_requests.device_id AND c.id=summary_requests.chat AND c.memory_generation=summary_requests.generation)').run(this.now());
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  close():void{this.events.close();this.db.close();}
  cachedExtraction(device:number,chat:string,key:string):unknown|null{const row=this.db.prepare('SELECT value_json FROM extraction_cache WHERE device_id=? AND chat=? AND cache_key=? AND expires_at>?').get(device,chat,key,this.now()) as {value_json:string}|undefined;return row?JSON.parse(row.value_json):null;}
  cacheExtraction(device:number,chat:string,key:string,value:unknown,expiresAt:number):void{this.get(device,chat);const json=JSON.stringify(value);if(Buffer.byteLength(json)>2*1024*1024)return;this.db.prepare('DELETE FROM extraction_cache WHERE expires_at<=?').run(this.now());const total=this.db.prepare('SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))),0) AS size FROM extraction_cache WHERE device_id=?').get(device) as {size:number};if(total.size+Buffer.byteLength(json)>10*1024*1024)return;this.db.prepare('INSERT OR REPLACE INTO extraction_cache VALUES(?,?,?,?,?)').run(device,chat,key,json,Math.min(expiresAt,this.get(device,chat).expiresAt));}
  saveDocumentRun(device:number,chat:string,id:string,value:unknown,expiresAt:number):void{this.get(device,chat);this.db.prepare('INSERT OR REPLACE INTO document_runs VALUES(?,?,?,?,?)').run(device,chat,id,JSON.stringify(value),Math.min(expiresAt,this.get(device,chat).expiresAt));}
  documentRun(device:number,chat:string,id:string):unknown|null{this.get(device,chat);const row=this.db.prepare('SELECT value_json FROM document_runs WHERE device_id=? AND chat=? AND id=? AND expires_at>?').get(device,chat,id,this.now()) as {value_json:string}|undefined;return row?JSON.parse(row.value_json):null;}
  documentRequests():{device:number;chat:string;id:string;value:unknown}[]{return (this.db.prepare('SELECT device_id,chat,id,value_json FROM document_runs WHERE expires_at>?').all(this.now()) as {device_id:number;chat:string;id:string;value_json:string}[]).map(r=>({device:r.device_id,chat:r.chat,id:r.id,value:JSON.parse(r.value_json)}));}
  savePreferenceConflict(device:number,operationId:string,value:unknown):void { this.db.prepare('INSERT OR REPLACE INTO preference_conflicts VALUES(?,?,?,?)').run(device,operationId,JSON.stringify(value),this.now()+CHAT_RETENTION_MS); }
  preferenceConflicts(device:number):{operationId:string;draft:unknown;expiresAt:number}[]{return (this.db.prepare('SELECT operation_id,value_json,expires_at FROM preference_conflicts WHERE device_id=? AND expires_at>? ORDER BY expires_at DESC LIMIT 10').all(device,this.now()) as {operation_id:string;value_json:string;expires_at:number}[]).map(r=>({operationId:r.operation_id,draft:JSON.parse(r.value_json),expiresAt:r.expires_at}));}
  removePreferenceConflict(device:number,id:string):void{this.db.prepare('DELETE FROM preference_conflicts WHERE device_id=? AND operation_id=?').run(device,id);}
  memory(device:number,chat:string):ChatMemory {
    const session=this.get(device,chat),r=this.db.prepare('SELECT value_json FROM chat_memory WHERE device_id=? AND chat=? AND expires_at>?').get(device,chat,this.now()) as {value_json:string}|undefined;
    return r?JSON.parse(r.value_json):{summary:'',throughMessageId:0,coverage:[],sources:[],expiresAt:session.expiresAt};
  }
  memoryGeneration(device:number,chat:string):number { this.get(device,chat);return (this.db.prepare('SELECT memory_generation AS n FROM chats WHERE device_id=? AND id=?').get(device,chat) as {n:number}).n; }
  memoryRevision(device:number,chat:string):number { return (this.db.prepare('SELECT revision AS n FROM chat_memory_versions WHERE device_id=? AND chat=?').get(device,chat) as {n:number}|undefined)?.n??0; }
  saveMemory(device:number,chat:string,memory:ChatMemory,expectedRevision?:number):boolean {
    const c=this.get(device,chat);if(memory.expiresAt>c.expiresAt || memory.expiresAt<=this.now())throw new DomainError('MEMORY_EXPIRED','Срок памяти истёк.');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      if(expectedRevision!==undefined&&this.memoryRevision(device,chat)!==expectedRevision){this.db.exec('COMMIT');return false;}
      this.db.prepare('INSERT INTO chat_memory(device_id,chat,value_json,expires_at) VALUES(?,?,?,?) ON CONFLICT(device_id,chat) DO UPDATE SET value_json=excluded.value_json,expires_at=excluded.expires_at').run(device,chat,JSON.stringify(memory),memory.expiresAt);
      this.db.prepare('INSERT INTO chat_memory_versions VALUES(?,?,1) ON CONFLICT(device_id,chat) DO UPDATE SET revision=chat_memory_versions.revision+1').run(device,chat);
      this.db.exec('COMMIT');return true;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  requestSummary(device:number,chat:string,providerId:string|null=null,providerVersion:number|null=null,force=false):SummaryRequest {
    const c=this.get(device,chat),generation=this.memoryGeneration(device,chat),target=this.list(device,chat,1).at(-1)?.id??0;
    this.db.prepare(`INSERT INTO summary_requests(device_id,chat,generation,target,provider_id,provider_version,force,expires_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(device_id,chat) DO UPDATE SET generation=excluded.generation,target=excluded.target,provider_id=excluded.provider_id,provider_version=excluded.provider_version,force=MAX(summary_requests.force,excluded.force),expires_at=excluded.expires_at,request_version=summary_requests.request_version+1`).run(device,chat,generation,target,providerId,providerVersion,force?1:0,c.expiresAt);
    return this.summaryRequests().find(r=>r.device===device&&r.chat===chat)!;
  }
  summaryRequests():SummaryRequest[] {return (this.db.prepare('SELECT r.* FROM summary_requests r JOIN chats c ON c.device_id=r.device_id AND c.id=r.chat AND c.memory_generation=r.generation WHERE r.expires_at>?').all(this.now()) as {device_id:number;chat:string;generation:number;target:number;provider_id:string|null;provider_version:number|null;force:number;expires_at:number;request_version:number}[]).map(r=>({device:r.device_id,chat:r.chat,generation:r.generation,target:r.target,providerId:r.provider_id,providerVersion:r.provider_version,force:!!r.force,expiresAt:r.expires_at,revision:r.request_version}));}
  completeSummary(request:SummaryRequest):void {this.db.prepare('DELETE FROM summary_requests WHERE device_id=? AND chat=? AND generation=? AND target=? AND request_version=?').run(request.device,request.chat,request.generation,request.target,request.revision);}
  since(device:number,chat:string,afterId:number,limit=200):StoredMessage[] {
    this.get(device,chat);return (this.db.prepare('SELECT * FROM messages WHERE device_id=? AND chat=? AND id>? AND created_at>? ORDER BY id LIMIT ?').all(device,chat,afterId,this.now()-CHAT_RETENTION_MS,limit) as Record<string,unknown>[]).map(r=>({id:Number(r.id),deviceId:device,chat,role:r.role as StoredMessage['role'],content:String(r.content),meta:r.meta as string|null,createdAt:Number(r.created_at)}));
  }
}
