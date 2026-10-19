export const APP_VERSION = '0.2.0';
/** Browser-safe contracts. Never import filesystem or server modules here. */
export * from './preferences.js';
export type Id = string;
export type ChatMode = 'task' | 'note';
export interface TaskDraftState { id: string; version: number; createdAt: number; task: Partial<TaskCreateInput>; tasks?:Partial<TaskCreateInput>[]; question: string; referenceInstant?:string }
export interface ChatSession { id: string; title: string; mode: ChatMode; timezone: string; version: number; createdAt: number; updatedAt: number; expiresAt: number; messageCount: number; pendingTask: TaskDraftState | null; providerId?:string|null }
export interface ChatPage { items: ChatSession[] }
export interface Attachment { id: string; chatId: string; name: string; mediaType: string; size: number; createdAt: number; expiresAt: number; kind: 'text' | 'image'; textLength: number; processing?:'queued'|'running'|'ready'|'failed';processingError?:string|null; extraction?: {status:'complete'|'partial';pages:number;warnings:string[];visualPages?:number[];analyzedPages?:number[]} }
export interface ChatSendInput { chatId: string; requestId: string; expectedVersion: number; text: string; attachmentIds: string[]; draftId?: string; draftVersion?: number }
export type NoteKind = 'quick' | 'idea' | 'person';
export interface NoteCreateInput { title: string; body: string; kind: NoteKind; category: Category; tags: string[]; keywords: string[]; aliases: string[]; person: { phone: string; email: string; role: string } }
export interface NoteRecord extends NoteCreateInput { id: string | null; path: string; content: string; contentHash: string; updatedAt: number }
export interface NotePage { items: Omit<NoteRecord, 'content' | 'body'>[]; invalidRecords: {path: string; error: string}[] }
export interface NoteGraph {
  nodes: { path: string; title: string; kind: string; id: string | null }[];
  edges: { source: string; target: string }[];
  revision: string | null;
  syncMode: string;
  warnings: string[];
}
export interface NoteEditInput { fields?: NoteCreateInput; content?: string }
export interface NoteWriteResult { note: NoteRecord; receipt: MutationReceipt }
export interface PageInterpretation {text:string;providerId:string;providerVersion:number;model:string;route:'native_pdf'|'page_images';settingsHash:string;warnings:string[]}
export interface ExtractionPage { number: number; method: 'text' | 'ocr'; text: string; confidence: number | null; warnings: string[];classification?:'text'|'scan'|'visual';interpretation?:PageInterpretation }
export interface ExtractionReport { version: string; fileHash?:string;settingsHash?:string; status: 'complete' | 'partial'; pages: ExtractionPage[]; warnings: string[]; images: {name: string; mediaType: string; base64: string}[] }
export interface ImportResult { assetId: string; notePath: string; originalPath: string; manifestPath: string; status: 'complete' | 'partial'; warnings: string[]; receipt: MutationReceipt }
export interface MemorySource { noteId: string | null; path: string; contentHash: string; state: 'current' | 'changed' | 'missing' | 'renamed'; checkedAt: number }
export interface ChatMemory { summary: string; throughMessageId: number; coverage: {id: number; hash: string}[]; expiresAt: number; sources: MemorySource[]; refresh?:{state:'queued'|'idle'|'failed'} }
export type Category = 'study' | 'work' | 'personal';
export type Priority = 'highest' | 'high' | 'medium' | 'low';
export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type Deadline =
  | { kind: 'by_date'; date: string; timezone: string }
  | { kind: 'by_time' | 'at_time'; at: string; timezone: string };

export interface TaskCreateInput {
  title: string;
  description: string;
  category: Category;
  priority: Priority;
  deadline: Deadline;
  keywords: string[];
  tags: string[];
  relatedNoteIds: Id[];
}

export interface Task extends TaskCreateInput {
  id: Id;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  path: string;
  contentHash: string;
}

export type TaskPatch = Partial<TaskCreateInput & { status: TaskStatus }>;
export interface InvalidTaskRecord { path: string; error: string }
export interface TaskPage { items: Task[]; invalidRecords: InvalidTaskRecord[] }
export interface LegacyTask { path: string; line: number; contentHash: string; title: string; completed: boolean }
export function taskCalendarDate(task: Pick<Task, 'deadline'>, timezone: string): string {
  if (task.deadline.kind === 'by_date') return task.deadline.date;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year:'numeric',month:'2-digit',day:'2-digit' }).formatToParts(new Date(task.deadline.at)).map(p=>[p.type,p.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export function calendarMonthDays(month: string): string[] {
  validateLocalDate(month+'-01');
  const start = new Date(month+'-01T12:00:00Z');
  start.setUTCDate(start.getUTCDate()-((start.getUTCDay()+6)%7));
  return Array.from({length:42},(_,i)=>new Date(start.getTime()+i*86_400_000).toISOString().slice(0,10));
}
export interface MutationReceipt {
  operationId: Id;
  path: string;
  contentHash: string;
  state: 'saved_local' | 'committed' | 'synced';
  commitSha: string | null;
}
export interface TaskWriteResult { task: Task; receipt: MutationReceipt }

export const categoryLabels: Record<Category, string> = { study: 'Учёба', work: 'Работа', personal: 'Личное' };
export const priorityLabels: Record<Priority, string> = { highest: 'Наивысший', high: 'Высокий', medium: 'Средний', low: 'Низкий' };
export const statusLabels: Record<TaskStatus, string> = { todo: 'К выполнению', in_progress: 'В работе', done: 'Готово', cancelled: 'Отменено' };
export const priorityOrder: Record<Priority, number> = { highest: 0, high: 1, medium: 2, low: 3 };

export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) {
    super(message);
    this.name = 'DomainError';
  }
}

export function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('VALIDATION_ERROR', 'Ожидается объект.');
  return value as Record<string, unknown>;
}

function member<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new DomainError('VALIDATION_ERROR', 'Некорректное поле: ' + field);
  return value as T;
}

export function validateLocalDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new DomainError('INVALID_DATE', 'Укажите дату в формате ГГГГ-ММ-ДД.');
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value < '1900-01-01') {
    throw new DomainError('INVALID_DATE', 'Такой календарной даты не существует.');
  }
  return value;
}

export function validateTimezone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100) throw new DomainError('INVALID_TIMEZONE', 'Укажите часовой пояс.');
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); }
  catch { throw new DomainError('INVALID_TIMEZONE', 'Неизвестный часовой пояс.'); }
  return value;
}

export function validateDeadline(value: unknown): Deadline {
  if (!value) throw new DomainError('DEADLINE_REQUIRED', 'Для задачи обязательно нужен срок.');
  const input = objectInput(value);
  const timezone = validateTimezone(input.timezone);
  if (input.kind === 'by_date') {
    if (input.at !== undefined) throw new DomainError('INVALID_DEADLINE', 'У срока до даты не должно быть поля at.');
    return { kind: 'by_date', date: validateLocalDate(input.date), timezone };
  }
  const kind = member(input.kind, ['by_time', 'at_time'] as const, 'deadline.kind');
  if (input.date !== undefined || typeof input.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(input.at)) {
    throw new DomainError('INVALID_DEADLINE', 'Укажите полный момент времени с часовым поясом.');
  }
  validateLocalDate(input.at.slice(0, 10));
  const instant = new Date(input.at);
  if (!Number.isFinite(instant.getTime())) throw new DomainError('INVALID_DEADLINE', 'Некорректный момент времени.');
  return { kind, at: instant.toISOString(), timezone };
}

function text(value: unknown, field: string, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new DomainError('VALIDATION_ERROR', 'Некорректное поле: ' + field);
  return required ? value.trim() : value;
}

function strings(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50 || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 200)) {
    throw new DomainError('VALIDATION_ERROR', 'Некорректный список: ' + field);
  }
  return [...new Set((value as string[]).map(v => v.trim()))];
}

export function validateTaskCreate(value: unknown): TaskCreateInput {
  const input = objectInput(value);
  return {
    title: text(input.title, 'title', 200, true),
    description: text(input.description ?? '', 'description', 100_000),
    category: member(input.category, ['study', 'work', 'personal'] as const, 'category'),
    priority: member(input.priority, ['highest', 'high', 'medium', 'low'] as const, 'priority'),
    deadline: validateDeadline(input.deadline),
    keywords: strings(input.keywords, 'keywords'),
    tags: strings(input.tags, 'tags'),
    relatedNoteIds: strings(input.relatedNoteIds, 'relatedNoteIds'),
  };
}

export function validateTaskStatus(value: unknown): TaskStatus {
  return member(value, ['todo', 'in_progress', 'done', 'cancelled'] as const, 'status');
}

export function validateTaskPatch(value: unknown): TaskPatch {
  const input = objectInput(value);
  const fields = ['title', 'description', 'category', 'priority', 'deadline', 'keywords', 'tags', 'relatedNoteIds', 'status'];
  if (Object.keys(input).some(k => !fields.includes(k))) throw new DomainError('VALIDATION_ERROR', 'Недопустимое поле задачи.');
  const result: TaskPatch = {};
  if ('title' in input) result.title = text(input.title, 'title', 200, true);
  if ('description' in input) result.description = text(input.description, 'description', 100_000);
  if ('category' in input) result.category = member(input.category, ['study', 'work', 'personal'] as const, 'category');
  if ('priority' in input) result.priority = member(input.priority, ['highest', 'high', 'medium', 'low'] as const, 'priority');
  if ('deadline' in input) result.deadline = validateDeadline(input.deadline);
  if ('keywords' in input) result.keywords = strings(input.keywords, 'keywords');
  if ('tags' in input) result.tags = strings(input.tags, 'tags');
  if ('relatedNoteIds' in input) result.relatedNoteIds = strings(input.relatedNoteIds, 'relatedNoteIds');
  if ('status' in input) result.status = validateTaskStatus(input.status);
  return result;
}

/** Reject DST gaps and folds rather than silently changing the requested time. */
export function localDateTimeToInstant(date: string, time: string, timezone: string): string {
  validateLocalDate(date);
  validateTimezone(timezone);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new DomainError('INVALID_TIME', 'Укажите время ЧЧ:ММ.');
  const wanted = date + 'T' + time;
  const naive = Date.parse(wanted + ':00Z');
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const local = (ms: number) => {
    const p = Object.fromEntries(fmt.formatToParts(ms).map(v => [v.type, v.value]));
    return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute;
  };
  const offsets = new Set<number>();
  for (let h = -36; h <= 36; h += 6) {
    const sample = naive + h * 3_600_000;
    offsets.add(Date.parse(local(sample) + ':00Z') - sample);
  }
  const candidates = [...offsets].map(offset => naive - offset).filter(ms => local(ms) === wanted);
  if (candidates.length !== 1) throw new DomainError('AMBIGUOUS_LOCAL_TIME', candidates.length ? 'Это время встречается дважды при переводе часов. Выберите другой момент.' : 'Такого местного времени нет из-за перевода часов.');
  return new Date(candidates[0]).toISOString();
}

export function taskDeadlineSortKey(task: Pick<Task, 'deadline'>): string {
  if(task.deadline.kind!=='by_date')return new Date(task.deadline.at).toISOString();
  const {date,timezone}=task.deadline,midnight=Date.parse(date+'T00:00:00Z'),fmt=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});
  const local=(ms:number)=>{const p=Object.fromEntries(fmt.formatToParts(ms).map(p=>[p.type,p.value]));return p.year+'-'+p.month+'-'+p.day;};
  let low=midnight-36*3600000,high=midnight+60*3600000;while(high-low>1){const middle=Math.floor((low+high)/2);if(local(middle)<=date)low=middle;else high=middle;}return new Date(high-1).toISOString();
}

export function isTaskOverdue(task: Pick<Task, 'deadline' | 'status'>, now = new Date()): boolean {
  if (task.status === 'done' || task.status === 'cancelled') return false;
  if (task.deadline.kind !== 'by_date') return now.getTime() >= Date.parse(task.deadline.at);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: task.deadline.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const p = Object.fromEntries(parts.map(v => [v.type, v.value]));
  return p.year + '-' + p.month + '-' + p.day > task.deadline.date;
}

export type ProviderSlot = 'chat' | 'organizer';
export interface ProviderCapabilities { toolCalls: boolean; vision: boolean; structuredOutput: boolean;nativePdf?:boolean;pdfMaxBytes?:number;pdfMaxPages?:number }
export interface ProviderPublic {
  id: string; slot: ProviderSlot; name: string; adapter: 'openai_compatible'|'anthropic'|'gemini'; baseUrl: string;
  modelId: string; canonicalModelId: string | null; enabled: boolean; version: number;
  hasSecret: boolean; capabilities: ProviderCapabilities;
  lastTest: ProviderTestResult | null;
}
export interface ProviderWrite {
  name: string; adapter: 'openai_compatible'|'anthropic'|'gemini'; baseUrl: string; modelId: string;
  canonicalModelId: string | null; enabled: boolean; capabilities: ProviderCapabilities;
  secretUpdate: { action: 'keep' } | { action: 'replace'; apiKey: string } | { action: 'remove' };
  expectedVersion?: number;
}
export interface ProviderTestResult {
  providerId: string; version: number; availability: 'available' | 'failed'; checkedAt: string;
  verifiedCapabilities: { text: boolean; toolCalls: boolean | null; structuredOutput: boolean | null; vision: boolean|null };
  message: string;
}
export interface ProviderPage {
  items: ProviderPublic[]; defaultChatProviderId: string | null;
  limits: { chat: 5; organizer: 1 };
  organizerSafety: { status: 'missing' | 'unverified' | 'different' | 'same_model'; message: string };
}

export function validateProviderWrite(value: unknown, updating = false): ProviderWrite {
  const input = objectInput(value);
  const adapter=member(input.adapter,['openai_compatible','anthropic','gemini'] as const,'adapter');
  const name = text(input.name, 'name', 80, true);
  const modelId = text(input.modelId, 'modelId', 160, true);
  const baseUrl = text(input.baseUrl, 'baseUrl', 1000, true);
  let endpoint: URL;
  try { endpoint = new URL(baseUrl); } catch { throw new DomainError('INVALID_ENDPOINT', 'Укажите полный адрес API.'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new DomainError('INVALID_ENDPOINT', 'Адрес API не должен содержать логин, пароль, query или fragment.');
  }
  const caps = objectInput(input.capabilities);
  if(caps.nativePdf!==undefined&&typeof caps.nativePdf!=='boolean')throw new DomainError('VALIDATION_ERROR','Проверьте поддержку PDF.');
  for(const [key,max] of [['pdfMaxBytes',5*1024*1024],['pdfMaxPages',100]] as const)if(caps[key]!==undefined&&(!Number.isSafeInteger(caps[key])||Number(caps[key])<1||Number(caps[key])>max))throw new DomainError('VALIDATION_ERROR','Некорректный лимит PDF.');
  if (typeof input.enabled !== 'boolean' || ['toolCalls', 'vision', 'structuredOutput'].some(k => typeof caps[k] !== 'boolean')) {
    throw new DomainError('VALIDATION_ERROR', 'Проверьте включение профиля и возможности модели.');
  }
  const secret = objectInput(input.secretUpdate);
  if (!['keep', 'replace', 'remove'].includes(String(secret.action))) throw new DomainError('VALIDATION_ERROR', 'Некорректное изменение ключа.');
  const secretUpdate: ProviderWrite['secretUpdate'] = secret.action === 'replace'
    ? { action: 'replace', apiKey: text(secret.apiKey, 'apiKey', 4096, true) }
    : { action: secret.action as 'keep' | 'remove' };
  if (secretUpdate.action === 'replace' && /[\r\n\0]/.test(secretUpdate.apiKey)) throw new DomainError('VALIDATION_ERROR', 'Некорректный API-ключ.');
  if (updating && (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1)) {
    throw new DomainError('VALIDATION_ERROR', 'Для изменения нужна версия профиля.');
  }
  const canonical = input.canonicalModelId == null || input.canonicalModelId === '' ? null : text(input.canonicalModelId, 'canonicalModelId', 200, true).toLowerCase();
  return { name, modelId, baseUrl: endpoint.href.replace(/\/+$/, ''), adapter, canonicalModelId: canonical,
    enabled: input.enabled, capabilities: { toolCalls: caps.toolCalls as boolean, vision: caps.vision as boolean, structuredOutput: caps.structuredOutput as boolean,...(caps.nativePdf!==undefined?{nativePdf:caps.nativePdf as boolean}:{}),...(caps.pdfMaxBytes!==undefined?{pdfMaxBytes:Number(caps.pdfMaxBytes)}:{}),...(caps.pdfMaxPages!==undefined?{pdfMaxPages:Number(caps.pdfMaxPages)}:{}) },
    secretUpdate, expectedVersion: updating ? Number(input.expectedVersion) : undefined };
}

export interface AutomationSettings {
  version:number; changedAt:number;
  organizer:{enabled:boolean;timezone:string;weekdays:number[];localTime:string;excludedFolders:string[];maxNotesPerBatch:number;maxChangedFilesPerRun:number;maxTokensPerRun:number;policyVersion:number};
  digest:{enabled:boolean;timezone:string;weekday:number;localTime:string;maxItems:number;includeOverdue:boolean};
}
export type JobState='queued'|'running'|'succeeded'|'failed'|'cancelled'|'unknown';
export interface ScheduledJob {id:string;kind:'organize'|'weekly_digest'|'extract'|'summarize'|'document'|'archive_completed';dedupeKey:string;scheduledFor:number;settingsVersion:number;state:JobState;attempt:number;leaseUntil:number|null;fencingToken:number;lastError:string|null;result:unknown}
export interface OrganizationPatch {path:string;baseHash:string;targetPath?:string;addTags:string[];keywords?:string[];relatedPaths:string[];rationale:string}
export interface OrganizationPlan {id:string;inputHead:string|null;policyVersion:number;settingsVersion:number;provider?:{id:string;version:number};patches:OrganizationPatch[];deferredPaths:string[];affectedPaths:string[];inputHashes:Record<string,string>;createdAt:number}
export interface OrganizationPreview {plan:OrganizationPlan;files:{path:string;before:string;after:string;moveFrom?:string}[];remaining:number;warnings:string[]}
export interface AppNotification {id:string;title:string;body:string;createdAt:number;read:boolean}
export const defaultAutomationSettings=():AutomationSettings=>({version:1,changedAt:0,organizer:{enabled:false,timezone:'Europe/Moscow',weekdays:[3,7],localTime:'23:59',excludedFolders:[],maxNotesPerBatch:16,maxChangedFilesPerRun:128,maxTokensPerRun:24000,policyVersion:1},digest:{enabled:false,timezone:'Europe/Moscow',weekday:7,localTime:'23:50',maxItems:5,includeOverdue:true}});
export function validateAutomationSettings(value:unknown,current:AutomationSettings,now:number):AutomationSettings {
  const b=objectInput(value);if(b.version!==current.version)throw new DomainError('SETTINGS_CONFLICT','Настройки изменились. Обновите страницу.',409);
  const o=objectInput(b.organizer),d=objectInput(b.digest);
  const flag=(v:unknown)=>{if(typeof v!=='boolean')throw new DomainError('VALIDATION_ERROR','Ожидается включено/выключено.');return v;};
  const count=(v:unknown,min:number,max:number)=>{if(!Number.isSafeInteger(v)||Number(v)<min||Number(v)>max)throw new DomainError('VALIDATION_ERROR','Значение вне допустимого диапазона.');return Number(v);};
  const time=(v:unknown)=>{if(typeof v!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(v))throw new DomainError('INVALID_TIME','Укажите время ЧЧ:ММ.');return v;};
  if(!Array.isArray(o.weekdays)||!o.weekdays.length||o.weekdays.length>7)throw new DomainError('VALIDATION_ERROR','Выберите дни недели.');
  const folders=strings(o.excludedFolders,'excludedFolders');
  if(folders.some(f=>/^[\/\\]|\.{2}|[:\0]/.test(f)))throw new DomainError('INVALID_PATH','Исключения — относительные папки vault.');
  const organizer={enabled:flag(o.enabled),timezone:validateTimezone(o.timezone),weekdays:[...new Set(o.weekdays.map(v=>count(v,1,7)))].sort(),localTime:time(o.localTime),excludedFolders:folders,maxNotesPerBatch:count(o.maxNotesPerBatch,1,32),maxChangedFilesPerRun:count(o.maxChangedFilesPerRun,1,256),maxTokensPerRun:count(o.maxTokensPerRun,1000,200000),policyVersion:current.organizer.policyVersion};
  const policyChanged=JSON.stringify(folders)!==JSON.stringify(current.organizer.excludedFolders);
  if(policyChanged)organizer.policyVersion++;
  const digest={enabled:flag(d.enabled),timezone:validateTimezone(d.timezone),weekday:count(d.weekday,1,7),localTime:time(d.localTime),maxItems:count(d.maxItems,1,10),includeOverdue:flag(d.includeOverdue)};
  if(digest.enabled&&organizer.enabled&&organizer.weekdays.includes(digest.weekday)&&(digest.timezone!==organizer.timezone||digest.localTime>=organizer.localTime))throw new DomainError('DIGEST_ORDER','Уведомление должно приходить перед сортировкой в том же часовом поясе.');
  return {version:current.version+1,changedAt:now,organizer,digest};
}
export { emptyRunStream, reduceRunEvent, finishTools, type RunStreamState, type ToolProgress } from './run-stream.js';
