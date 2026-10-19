import type { ExtractionReport } from '@relay/core/contracts';
import type { PreferenceMemory, PreferenceFields, ToolProgress, MutationReceipt } from '@relay/core/contracts';
import type { Task, LegacyTask, TaskCreateInput, TaskPatch, TaskPage, TaskWriteResult, ProviderPage, ProviderPublic, ProviderWrite, ProviderSlot, ProviderTestResult, ChatSession, ChatPage, ChatMode, ChatSendInput, Attachment, NotePage, NoteRecord, NoteCreateInput, NoteEditInput, NoteWriteResult, ImportResult, ChatMemory } from '@relay/core/contracts';
import type { AutomationSettings,ScheduledJob,OrganizationPreview,AppNotification } from '@relay/core/contracts';

export interface DocumentStatus {id:string;attachmentId:string;pages:number[];processed:number[];state:string;error:string|null}
export interface McpKey {id:string;name:string;createdAt:number;expiresAt:number;lastSeen:number|null}
export interface DiagnosticsStatus {enabled:boolean;configured:boolean;mode:'metadata_only';retentionDays:number;pending:number;sent:number;dropped:number;failures:number;lastSuccess:number|null;sampleCount:number;p50Ms:number|null;p95Ms:number|null;firstTextP95Ms:number|null;errors:number;rssBytes:number;eventLoopP95Ms:number;index:{revision:number;pendingChanges:number}}
export interface Device {
  id: number;
  name: string;
  kind: 'app' | 'quick';
  createdAt: number;
  lastSeen: number | null;
  folder: string | null;
}

export interface Action {
  kind: string;
  path: string;
  label: string;
}

export interface Message {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  meta?: { tools?:ToolProgress[];receipts?:MutationReceipt[];outcome?:string;warnings?:string[];sources?: string[]; actions?: Action[]; error?: boolean; path?: string; attachments?: Attachment[]; mode?: ChatMode } | null;
  pending?: boolean;
  status?: string;
}

export interface Command {
  name: string;
  label: string;
  group: string;
  hint?: string;
}

const TOKEN_KEY = 'relay.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string | null): void {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown, raw?: { data: Blob; type: string }): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (raw) {
    headers['content-type'] = raw.type;
    payload = raw.data;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const err = (data as { error?: string })?.error ?? `HTTP ${res.status}`;
    if (res.status === 401 && token && !path.startsWith('/api/pair')) setToken(null);
    throw new ApiError(err, res.status);
  }
  return data as T;
}

export const api = {
  completedEvents: () => req<{retentionDays:number;eligible:number;base:string;providerConfigured:boolean;lastJob:import('@relay/core/contracts').ScheduledJob|null}>('GET','/api/completed-events'),
  processCompleted: () => req<import('@relay/core/contracts').ScheduledJob>('POST','/api/completed-events',{}),
  noteGraph: () => req<import('@relay/core/contracts').NoteGraph>('GET','/api/notes/graph'),
  graphDocument: (path:string) => req<{path:string;title:string;body:string}>('GET','/api/notes/graph/document?path='+encodeURIComponent(path)),
  diagnostics:()=>req<DiagnosticsStatus>('GET','/api/diagnostics'),
  mcpKeys:()=>req<{enabled:boolean;url:string;keys:McpKey[]}>('GET','/api/mcp/keys'),
  createMcpKey:(name:string,days:number)=>req<{key:McpKey;token:string;url:string}>('POST','/api/mcp/keys',{name,days}),
  revokeMcpKey:(id:string)=>req('DELETE','/api/mcp/keys/'+encodeURIComponent(id)),
  conflicts:()=>req<{paths:string[];mergePaths:string[]}>('GET','/api/sync/conflicts'),
  conflict:(path:string)=>req<{path:string;content:string|null;contentHash:string|null;base:string|null;ours:string|null;theirs:string|null}>('GET','/api/sync/conflicts/document?path='+encodeURIComponent(path)),
  resolveConflict:(path:string,expectedContentHash:string|null,content:string|null,operationId:string)=>req('POST','/api/sync/conflicts/resolve',{path,expectedContentHash,content,operationId}),
  completeMerge:(expectedPaths:string[])=>req<SyncStatus>('POST','/api/sync/conflicts/complete',{expectedPaths}),
  automation:()=>req<{settings:AutomationSettings;jobs:ScheduledJob[];checkpoint:{head:string|null;policyVersion:number;completedAt:number|null}}>('GET','/api/automation'),
  saveAutomation:(settings:AutomationSettings)=>req<AutomationSettings>('PUT','/api/automation',settings),
  organizePreview:(runId:string)=>req<OrganizationPreview>('POST','/api/organizer/preview',{runId}),
  organizeApply:(planId:string,operationId:string)=>req<{changedFiles:number;remaining:number}>('POST','/api/organizer/apply',{planId,operationId}),
  reconcileOrganizer:()=>req('POST','/api/organizer/reconcile',{}),
  backfillIds:(operationId:string)=>req<{result:{count:number;remaining:number}}>('POST','/api/index/backfill',{operationId}),
  retryJob:(id:string)=>req<ScheduledJob>('POST','/api/jobs/'+encodeURIComponent(id)+'/retry',{}),
  notifications:()=>req<{items:AppNotification[]}>('GET','/api/notifications'),
  readNotification:(id:string)=>req('POST','/api/notifications/'+encodeURIComponent(id)+'/read',{}),
  pushStatus:()=>req<{publicKey:string;subscribed:boolean;deliveries:{state:string;count:number}[]}>('GET','/api/notifications/push'),
  subscribePush:(subscription:PushSubscriptionJSON)=>req('POST','/api/notifications/push',subscription),
  unsubscribePush:()=>req('DELETE','/api/notifications/push',{}),
  notes:(q='')=>req<NotePage>('GET','/api/notes?q='+encodeURIComponent(q)),
  resolveNote:(target:string,from='')=>req<{paths:string[];anchor:string|null}>('GET','/api/notes/resolve?target='+encodeURIComponent(target)+'&from='+encodeURIComponent(from)),
  note:(path:string)=>req<NoteRecord>('GET','/api/notes/document?path='+encodeURIComponent(path)),
  createNote:(note:NoteCreateInput,operationId:string)=>req<NoteWriteResult>('POST','/api/notes',{note,operationId}),
  editNote:(path:string,edit:NoteEditInput,expectedContentHash:string,operationId:string)=>req<NoteWriteResult>('PATCH','/api/notes/document',{path,edit,expectedContentHash,operationId}),
  importFile:(chatId:string,fileId:string,note:{title:string;category:string},operationId:string)=>req<ImportResult>('POST','/api/attachments/'+encodeURIComponent(fileId)+'/import',{chatId,note,operationId}),
  preferences:()=>req<PreferenceMemory>('GET','/api/preferences'),
  savePreferences:(fields:PreferenceFields,expectedHash:string|null,operationId:string)=>req<{memory:PreferenceMemory;receipt:MutationReceipt}>('PUT','/api/preferences',{fields,expectedHash,operationId}),
  deletePreferences:(expectedHash:string,operationId:string)=>req<{memory:PreferenceMemory;receipt:MutationReceipt}>('DELETE','/api/preferences',{expectedHash,operationId}),
  preferenceConflicts:()=>req<{items:{operationId:string;draft:{fields:PreferenceFields};expiresAt:number}[]}>('GET','/api/preferences/conflicts'),
  removePreferenceConflict:(id:string)=>req('DELETE','/api/preferences/conflicts/'+encodeURIComponent(id)),
  memory:(chatId:string)=>req<ChatMemory>('GET','/api/chats/'+encodeURIComponent(chatId)+'/memory'),
  summarize:(chatId:string)=>req<ChatMemory>('POST','/api/chats/'+encodeURIComponent(chatId)+'/memory',{}),
  downloadOriginal:async(assetId:string)=>{
    const token=getToken(),res=await fetch('/api/assets/'+encodeURIComponent(assetId)+'/original',{headers:token?{authorization:'Bearer '+token}:{}});
    if(!res.ok)throw new ApiError('Не удалось получить оригинал.',res.status);
    const blob=await res.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');
    const header=res.headers.get('content-disposition'),name=header?.match(/filename\*=UTF-8''(.+)/)?.[1];a.href=url;a.download=name?decodeURIComponent(name):'original';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30_000);
  },
  chats:()=>req<ChatPage>('GET','/api/chats'),
  newChat:(entryId:string,timezone:string)=>req<ChatSession>('POST','/api/chats',{entryId,timezone}),
  getChat:(id:string)=>req<ChatSession>('GET','/api/chats/'+encodeURIComponent(id)),
  renameChat:(chat:ChatSession,title:string)=>req<ChatSession>('PATCH','/api/chats/'+encodeURIComponent(chat.id),{title,expectedVersion:chat.version}),
  removeChat:(chat:ChatSession)=>req('DELETE','/api/chats/'+encodeURIComponent(chat.id),{expectedVersion:chat.version}),
  chatRuns:(id:string)=>req<{items:{requestId:string;state:string;artifacts:string[]}[]}>('GET','/api/chats/'+encodeURIComponent(id)+'/runs'),
  bindChat:(chat:ChatSession,providerId:string|null)=>req<ChatSession>('PUT','/api/chats/'+encodeURIComponent(chat.id)+'/provider',{providerId,expectedVersion:chat.version}),
  chatMode:(chat:ChatSession,mode:ChatMode)=>req<ChatSession>('PATCH','/api/chats/'+encodeURIComponent(chat.id),{mode,expectedVersion:chat.version}),
  cancelDraft:(chat:ChatSession)=>req<ChatSession>('DELETE','/api/chats/'+encodeURIComponent(chat.id)+'/draft',{draftId:chat.pendingTask?.id,draftVersion:chat.pendingTask?.version}),
  upload:(chatId:string,file:File)=>req<Attachment>('POST','/api/attachments/queued?chatId='+encodeURIComponent(chatId)+'&name='+encodeURIComponent(file.name),undefined,{data:file,type:'application/octet-stream'}),
  attachment:(chatId:string,id:string)=>req<Attachment>('GET','/api/attachments/'+encodeURIComponent(id)+'?chatId='+encodeURIComponent(chatId)),
  extraction:(chatId:string,id:string)=>req<{report:ExtractionReport|null}>('GET','/api/attachments/'+encodeURIComponent(id)+'/extraction?chatId='+encodeURIComponent(chatId)),
  analyzeDocument:(chatId:string,id:string,pages:number[],question:string,requestId:string)=>req<DocumentStatus>('POST','/api/attachments/'+encodeURIComponent(id)+'/analyze',{chatId,pages,question,requestId}),
  documentStatus:(chatId:string,id:string,requestId:string)=>req<DocumentStatus>('GET','/api/attachments/'+encodeURIComponent(id)+'/analysis/'+encodeURIComponent(requestId)+'?chatId='+encodeURIComponent(chatId)),
  cancelDocument:(chatId:string,id:string,requestId:string)=>req<DocumentStatus>('POST','/api/attachments/'+encodeURIComponent(id)+'/analysis/'+encodeURIComponent(requestId)+'/cancel',{chatId}),
  cancelExtraction:(chatId:string,id:string)=>req('POST','/api/attachments/'+encodeURIComponent(id)+'/cancel',{chatId}),
  retryAttachment:(chatId:string,id:string)=>req('POST','/api/attachments/'+encodeURIComponent(id)+'/retry',{chatId}),
  providers: () => req<ProviderPage>('GET', '/api/providers'),
  createProvider: (slot: ProviderSlot, provider: ProviderWrite) => req<ProviderPublic>('POST', '/api/providers', { slot, provider }),
  updateProvider: (id: string, provider: ProviderWrite) => req<ProviderPublic>('PATCH', '/api/providers/' + encodeURIComponent(id), provider),
  removeProvider: (id: string, expectedVersion: number) => req<void>('DELETE', '/api/providers/' + encodeURIComponent(id), { expectedVersion }),
  selectProvider: (provider: Pick<ProviderPublic, 'id' | 'version'> | null) => req<ProviderPage>('PUT', '/api/providers/default', { providerId: provider?.id ?? null, expectedVersion: provider?.version }),
  testProvider: (id: string) => req<ProviderTestResult>('POST', '/api/providers/' + encodeURIComponent(id) + '/test', {}),
  health: () => req<{ ok: boolean; version: string; sync: SyncStatus; requireStandalone: boolean }>('GET', '/api/health'),
  pair: (code: string, name: string) => req<{ token: string; device: Device }>('POST', '/api/pair', { code, name }),
  me: () =>
    req<{ device: Device; vault: { inbox: string; daily: string; privateFolders: string[] }; model: string; sync: SyncStatus; requireStandalone: boolean }>(
      'GET',
      '/api/me',
    ),
  commands: () => req<{ commands: Command[] }>('GET', '/api/commands'),
  messages: (chat = 'main', before?: number) =>
    req<{ messages: Message[] }>('GET', `/api/messages?chat=${encodeURIComponent(chat)}${before ? `&before=${before}` : ''}`),
  clearMessages: async(chat = 'main') => {const r=await req<{ ok: true }>('DELETE', `/api/messages?chat=${encodeURIComponent(chat)}`);window.dispatchEvent(new CustomEvent('relay-clear-draft',{detail:{chat}}));return r;},
  chat: (input:ChatSendInput) => req<ChatResult>('POST', '/api/chat', input),
  runStatus:(chatId:string,requestId:string)=>req<{state:string;artifacts:string[];result:ChatResult|null;expired:boolean;snapshot:{sequence:number;text:string;status?:string;state:string;tools?:ToolProgress[]}|null}>('GET','/api/chats/'+encodeURIComponent(chatId)+'/runs/'+encodeURIComponent(requestId)),
  cancelRun:(chatId:string,requestId:string)=>req('POST','/api/chats/'+encodeURIComponent(chatId)+'/runs/'+encodeURIComponent(requestId)+'/cancel',{}),
  devices: () => req<{ devices: Device[] }>('GET', '/api/devices'),
  revoke: (id: number) => req<{ ok: true }>('DELETE', `/api/devices/${id}`),
  quickKey: (folder?: string) => req<{ token: string; device: Device }>('POST', '/api/devices/quick', { folder }),
  newCode: () => req<{ code: string; expiresAt: number }>('POST', '/api/pairing/new'),
  syncPull: () => req<SyncStatus>('POST', '/api/sync/pull'),
  tasks: () => req<TaskPage>('GET', '/api/tasks'),
  task: (id:string)=>req<Task>('GET','/api/tasks/'+encodeURIComponent(id)),
  legacyTasks:()=>req<{items:LegacyTask[]}>('GET','/api/tasks/legacy'),
  convertLegacy:(source:LegacyTask,task:TaskCreateInput,operationId:string)=>req<TaskWriteResult>('POST','/api/tasks/legacy/convert',{source,task,operationId}),
  createTask: (task: TaskCreateInput, operationId: string) => req<TaskWriteResult>('POST', '/api/tasks', { task, operationId }),
  updateTask: (id: string, patch: TaskPatch, expectedContentHash: string, operationId: string) =>
    req<TaskWriteResult>('PATCH', '/api/tasks/' + encodeURIComponent(id), { patch, expectedContentHash, operationId }),
};

export interface SyncStatus {
  mode: 'none' | 'git';
  lastPull: number | null;
  lastPush: number | null;
  lastError: string | null;
  pending: boolean;
}

export interface ChatResult {
  tools?:ToolProgress[];receipts?:MutationReceipt[];outcome?:string;warnings?:string[];
  text: string;
  sources: string[];
  actions: Action[];
  userMessageId: number;
  messageId: number;
  chat:ChatSession;
}

/** WebSocket chat client with automatic reconnect. */
export class ChatSocket {
  private ws: WebSocket | null = null;
  private timer: number | null = null;
  private closed = false;
  onEvent: (e: Record<string, unknown>) => void = () => {};
  onState: (s: 'connecting' | 'open' | 'closed') => void = () => {};

  connect(): void {
    void this.open();
  }
  private async open():Promise<void> {
    this.closed = false;
    const token = getToken();
    if (!token) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.onState('connecting');
    let ticket:string;
    try{ticket=(await req<{ticket:string}>('POST','/api/ws-ticket',{})).ticket;}catch{this.onState('closed');if(!this.closed)this.timer=window.setTimeout(()=>this.connect(),3000);return;}
    if(this.closed)return;
    const ws = new WebSocket(`${proto}://${location.host}/api/ws?ticket=${encodeURIComponent(ticket)}`);
    this.ws = ws;
    ws.onopen = () => this.onState('open');
    ws.onmessage = (ev) => {
      try {
        this.onEvent(JSON.parse(ev.data));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      this.onState('closed');
      this.ws = null;
      if (!this.closed) this.timer = window.setTimeout(() => this.connect(), 2000);
    };
    ws.onerror = () => ws.close();
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(obj: unknown): boolean {
    if (!this.isOpen) return false;
    this.ws!.send(JSON.stringify(obj));
    return true;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }
}

export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true || document.referrer.startsWith('android-app://');
}
