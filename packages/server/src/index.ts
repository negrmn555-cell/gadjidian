import { APP_VERSION } from '@relay/core';
import { DocumentJobs } from './document-jobs.js';
import { PreferencesMemory, rememberCommand } from './preferences-memory.js';
import { Diagnostics } from './diagnostics.js';
import { registerMcp } from './mcp-server.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { LlmClient, Vault, DomainError, objectInput, appendToDaily, getSearchIndex, disposeSearch, measureRun, measure, recordDuration, recordFirstText } from '@relay/core';
import type { AgentEvent, AgentResult } from '@relay/core';
import { loadConfig, loadScenarios, type ServerConfig } from './config.js';
import { Db } from './db.js';
import { GitSync } from './sync.js';
import { makeAdminAuth, makeAuth } from './auth.js';
import { VaultMutationService } from './vault-mutations.js';
import { TaskService } from './tasks.js';
import { ProviderRegistry } from './providers.js';
import { NoteModeService } from './note-mode.js';
import { ChatModeService } from './chat-modes.js';
import { attachmentContext, attachmentTool } from './agent-context.js';
import { MAX_UPLOAD, upload } from './attachments.js';
import { NoteService } from './notes.js';
import { notesGraph } from './notes-graph.js';
import { isPreferencesPath, parseMarkdownDocument } from '@relay/core';
import { ImportService } from './imports.js';
import { ChatMemoryService } from './chat-memory.js';
import { VaultError, sourceVersion } from '@relay/core';
import { fingerprint } from './vault-mutations.js';
import type { ChatSendInput, ChatSession, ChatMessage, Attachment } from '@relay/core';
import { WriterLock } from './writer-lock.js';
import { WsTickets } from './ws-tickets.js';
import { NoteIndex } from './note-index.js';
import { Scheduler, AutomationSettingsService } from './scheduler.js';
import { OrganizerService } from './organizer.js';
import { CompletedEvents, EVENTS_BASE, RETENTION_DAYS } from './completed-events.js';
import { NotificationService } from './notifications.js';
import { RequestLedger } from './request-ledger.js';
import { ExtractionJobs } from './extraction-jobs.js';
import { GitConflicts } from './git-conflicts.js';
import { SummaryJobs } from './summary-jobs.js';
import { IndexCoordinator } from './index-coordinator.js';
import {resolveVaultLink, vaultLinks} from '@relay/core';
import {validateAutomationSettings} from '@relay/core';

const VERSION = APP_VERSION;

export async function createServer(cfg: ServerConfig = loadConfig()) {
  const owner=await WriterLock.acquire(cfg.vault.root);
  try{const app=await createUnlockedServer(cfg);app.addHook('onClose',async()=>owner.release());return app;}
  catch(e){await owner.release();throw e;}
}
async function createUnlockedServer(cfg:ServerConfig) {
  await fs.mkdir(cfg.dataDir, { recursive: true });
  await fs.mkdir(cfg.vault.root, { recursive: true });

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      serializers: { req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url.replace(/([?&](?:token|ticket|name)=)[^&]*/gi, '$1[redacted]') }) },
    },
    bodyLimit: 25 * 1024 * 1024,
  });
  const log = (msg: string) => app.log.info(msg);

  const db = await Db.open(cfg.dbPath);
  let providers: ProviderRegistry;
  try { providers = await ProviderRegistry.open(db, cfg); } catch (e) { db.close(); throw e; }
  const vault = new Vault(cfg.vault);
  const llm = new LlmClient(cfg.llm, async () => { throw new DomainError('PROVIDER_NOT_CONFIGURED', 'Добавьте и выберите ИИ в настройках.', 409); });
  const scenarios = await loadScenarios(cfg.scenariosFile);
  const sync = new GitSync(cfg, log);
  vault.setReadGuard(work=>sync.exclusive(work));
  const mutations = new VaultMutationService(vault, db, sync);
  const conflicts=new GitConflicts(vault,db,sync);
  const index=new NoteIndex(vault,db);
  const indexCoordinator=new IndexCoordinator(vault,db,index);
  const tasks = new TaskService(vault, mutations, undefined, index);
  const notes = new NoteModeService(vault, mutations);
  const noteEditor=new NoteService(vault,mutations),imports=new ImportService(vault,db.chats,mutations),memory=new ChatMemoryService(db.chats,vault);
  const preferences=new PreferencesMemory(vault,mutations,db.chats);
  const modes = new ChatModeService(db.chats, tasks, notes, vault);
  const automationSettings=new AutomationSettingsService(db),tickets=new WsTickets();
  const organizer=new OrganizerService(vault,db,index,providers,sync,mutations,automationSettings);
  const completedEvents=new CompletedEvents(vault,tasks,providers,mutations,sync,automationSettings);
  const notifications=await NotificationService.open(db,cfg,automationSettings,tasks,sync);
  const ledger=new RequestLedger(db);
  const extractionJobs=new ExtractionJobs(db.chats,device=>db.listDevices().some(d=>d.id===device));
  const documentJobs=new DocumentJobs(db.chats,providers,device=>db.listDevices().some(d=>d.id===device));
  const summaryJobs=new SummaryJobs(db.chats,memory,providers,device=>db.listDevices().some(d=>d.id===device));
  const scheduler:Scheduler=new Scheduler(db,automationSettings,{archive_completed:async lease=>{
    const result=await completedEvents.run(lease) as {remaining:number};
    if(result.remaining>0)scheduler.enqueue('archive_completed','archive-continuation:'+lease.job.id,Date.now()+1000,automationSettings.get().version);
    return result;
  },document:lease=>documentJobs.run(lease),summarize:lease=>summaryJobs.run(lease,scheduler),extract:lease=>extractionJobs.run(lease),organize:async lease=>{
    const result=await organizer.run(lease) as {remaining:number};
    if(result.remaining>0){const row=db.sql.prepare('SELECT plan_json FROM organizer_runs WHERE id=?').get('plan_'+lease.job.id) as {plan_json:string};const preview=JSON.parse(row.plan_json);if(!preview.plan.deferredPaths.length)scheduler.enqueue('organize','continuation:'+lease.job.id,Date.now()+1000,lease.job.settingsVersion,{continuation:true});}
    return result;
  },weekly_digest:lease=>notifications.digest(lease)});
  vault.setWriteBackend(mutations);
  await sync.start(false);
  await conflicts.recover();
  await mutations.recoverIncomplete();
  ledger.recover();db.chats.events.recover((device,chat,request)=>ledger.inspect(device,chat,request)?.artifacts??[]);
  await sync.pull().catch(() => {});
  sync.onChanged(()=>vault.notifyChanged());
  await indexCoordinator.start();
  sync.startPolling();
  const eventLoop=monitorEventLoopDelay({resolution:20});eventLoop.enable();
  const diagnostics=new Diagnostics(cfg.diagnostics);

  const auth = makeAuth(db);
  const authAny = makeAuth(db, { kinds: ['app', 'quick'] });
  const adminAuth = makeAdminAuth(cfg.adminSecret);
  const mcp=registerMcp(app,cfg,db,vault);
  app.get('/api/diagnostics',{preHandler:auth},async()=>({...diagnostics.status(),index:indexCoordinator.status()}));
  app.get('/api/mcp/keys',{preHandler:auth},async req=>({enabled:cfg.mcp?.enabled!==false,url:cfg.publicUrl+'/mcp',keys:mcp.keys.list(req.device!.id)}));
  app.post('/api/mcp/keys',{preHandler:auth},async req=>{if(cfg.mcp?.enabled===false)throw new DomainError('MCP_DISABLED','MCP отключён.',409);const b=objectInput(req.body);return {...mcp.keys.create(req.device!.id,b.name,b.days??30),url:cfg.publicUrl+'/mcp'};});
  app.delete<{Params:{id:string}}>('/api/mcp/keys/:id',{preHandler:auth},async req=>{mcp.keys.revoke(req.device!.id,req.params.id);return {ok:true};});

  await app.register(cors, { origin: cfg.publicUrl, credentials: false });
  await app.register(websocket, { options: { maxPayload: 128 * 1024 } });
  app.addContentTypeParser('application/octet-stream', {bodyLimit:MAX_UPLOAD}, (_req,stream,done)=>{const chunks:Buffer[]=[];let size=0,finished=false;const finish=(error:Error|null)=>{if(finished)return;finished=true;done(error,error?undefined:Buffer.concat(chunks,size));};stream.on('data',(chunk:Buffer)=>{if(finished)return;size+=chunk.length;if(size>MAX_UPLOAD){chunks.length=0;finish(new DomainError('FILE_SIZE','Файл превышает 5 МБ.',413));}else chunks.push(chunk);});stream.on('end',()=>finish(null));stream.on('error',()=>finish(new DomainError('UPLOAD_INTERRUPTED','Загрузка файла прервана.',400)));});

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ code: error.code, error: error.message, retryable: false });
    if(error instanceof VaultError)return reply.code(error.code==='NOT_FOUND'?404:error.code==='FORBIDDEN'?403:422).send({code:error.code,error:error.code==='NOT_FOUND'?'Заметка не найдена.':error.code==='FORBIDDEN'?'Доступ к этому пути запрещён.':'Некорректный путь или заметка уже существует.'});
    const failure = error as { code?: string; statusCode?: number; name?: string };
    if (failure.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return reply.code(415).send({ code: 'UNSUPPORTED_MEDIA_TYPE', error: 'Неподдерживаемый формат запроса.' });
    if (typeof failure.statusCode === 'number' && failure.statusCode < 500) return reply.code(failure.statusCode).send({ error: 'Некорректный запрос.' });
    app.log.error({ error: (error as Error).name }, 'request failed');
    return reply.code(500).send({ code: 'INTERNAL_ERROR', error: 'Не удалось выполнить запрос.', retryable: true });
  });
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // Concurrency guard: one agent run at a time per device (simple map)
  const running = new Map<number, { controller: AbortController; chatId:string; requestId:string }>();
  const activeRuns=new Set<Promise<unknown>>();

  const afterWrite = (result: AgentResult) => {
    if (result.actions.length) sync.schedulePush();
  };

  // ---------- public ----------
  app.get('/api/health', async () => ({ ok: true, version: VERSION, sync: sync.getStatus(), requireStandalone: cfg.requireStandalone }));

  app.post<{ Body: { code?: string; name?: string } }>('/api/pair', async (req, reply) => {
    const code = String(req.body?.code ?? '').trim();
    const name = String(req.body?.name ?? 'Телефон').trim();
    if (!code) return reply.code(400).send({ error: 'code required' });
    const res = db.redeemCode(code, name);
    if (!res) return reply.code(401).send({ error: 'invalid or expired code' });
    log(`device paired: #${res.device.id} ${res.device.name}`);
    return { token: res.token, device: res.device };
  });

  // Quick capture (for iOS Shortcuts / HTTP Shortcuts). Accepts app or quick keys.
  app.post<{ Body: { token?: string; text?: string; chat?: string; title?: string } }>(
    '/api/send',
    { preHandler: authAny },
    async (req, reply) => {
      const text = String(req.body?.text ?? '').trim();
      if (!text) return reply.code(400).send({ error: 'text required' });
      const device = req.device!;
      const chat = String(req.body?.chat ?? 'quick');
      let pathOut: string;
      if (chat === 'daily') {
        pathOut = await appendToDaily(vault, text);
      } else {
        const title = String(req.body?.title ?? text.split('\n')[0].slice(0, 60));
        pathOut = (await noteEditor.capture(text,title,device.folder ?? vault.config.inboxFolder ?? '',crypto.randomUUID())).path;
      }
      sync.schedulePush();
      db.addMessage(device.id, 'quick', 'user', text, { path: pathOut });
      return { ok: true, path: pathOut };
    },
  );

  // ---------- device (app) ----------
  app.get('/api/me', { preHandler: auth }, async (req) => ({
    device: req.device,
    vault: {
      inbox: cfg.vault.inboxFolder,
      daily: cfg.vault.dailyFolder,
      privateFolders: cfg.vault.privateFolders,
    },
    model: providers.list().items.find(p => p.id === providers.list().defaultChatProviderId)?.modelId ?? '',
    sync: sync.getStatus(),
    requireStandalone: cfg.requireStandalone,
  }));

  app.get('/api/commands', { preHandler: auth }, async () => ({ commands: [
    { name:'quick',label:'Быстрая заметка',group:'write',hint:'текст заметки' },
    { name:'idea',label:'Идея',group:'write',hint:'текст идеи' },
    { name:'person',label:'Человек',group:'write',hint:'Имя | информация' }
  ] }));

  app.get('/api/chats', {preHandler:auth},async req=>({items:db.chats.sessions(req.device!.id)}));
  app.get('/api/search/status',{preHandler:auth},async()=>indexCoordinator.status());
  app.get<{Querystring:{q?:string}}>('/api/notes',{preHandler:auth},async req=>noteEditor.list(String(req.query.q??'').slice(0,200)));
  app.get('/api/notes/graph',{preHandler:auth},async()=>{
    await sync.pull();
    return notesGraph(vault,await sync.head(),sync.mode);
  });
  app.get<{Querystring:{path?:string}}>('/api/notes/graph/document',{preHandler:auth},async req=>{
    const target=String(req.query.path??'');
    if(isPreferencesPath(target))throw new DomainError('PREFERENCES_PROTECTED','Эта заметка доступна в настройках памяти.',403);
    const note=await vault.readNote(target),parsed=parseMarkdownDocument(note.path,note.content);
    return {path:note.path,title:parsed.title,body:parsed.body};
  });
  app.get<{Querystring:{path?:string}}>('/api/notes/document',{preHandler:auth},async req=>noteEditor.get(String(req.query.path??'')));
  app.get<{Querystring:{target?:string;from?:string}}>('/api/notes/resolve',{preHandler:auth},async req=>{const target=String(req.query.target??''),from=String(req.query.from??'');if(!target||target.length>1000||/[\[\]\r\n]/.test(target))throw new DomainError('VALIDATION_ERROR','Некорректная ссылка.');if(from)await vault.safePath(from);const link=vaultLinks('[['+target+']]')[0];if(!link)throw new DomainError('VALIDATION_ERROR','Некорректная ссылка.');const paths=(await vault.listNotes()).map(n=>n.path),r=resolveVaultLink(link,from,paths);return {paths:r.path?[r.path]:r.ambiguous?paths.filter(p=>p.split('/').pop()!.replace(/\.md$/i,'')===link.target.split('/').pop()!.replace(/\.md$/i,'')):[],anchor:link.anchor??null};});
  app.post('/api/notes',{preHandler:auth},async(req,reply)=>{const b=objectInput(req.body);return reply.code(201).send(await noteEditor.create(b.note,String(b.operationId??'')));});
  app.patch('/api/notes/document',{preHandler:auth},async req=>{const b=objectInput(req.body);return noteEditor.update(String(b.path??''),objectInput(b.edit),String(b.expectedContentHash??''),String(b.operationId??''));});
  app.get<{Params:{id:string}}>('/api/chats/:id/memory',{preHandler:auth},async req=>({...await memory.inspect(req.device!.id,req.params.id),refresh:{state:summaryJobs.status(req.device!.id,req.params.id,scheduler)}}));
  app.post<{Params:{id:string}}>('/api/chats/:id/memory',{preHandler:auth},async req=>{
    const device=req.device!.id,chat=db.chats.get(device,req.params.id),profile=providers.list().items.find(p=>p.id===(chat.providerId??providers.list().defaultChatProviderId));
    db.chats.requestSummary(device,chat.id,profile?.id??null,profile?.version??null,true);summaryJobs.recover(scheduler);
    return {...await memory.inspect(device,chat.id),refresh:{state:'queued'}};
  });
  app.post('/api/chats', {preHandler:auth},async(req,reply)=>{
    const b=objectInput(req.body);
    return reply.code(201).send(db.chats.create(req.device!.id,String(b.entryId??''),b.timezone));
  });
  app.get<{Params:{id:string}}>('/api/chats/:id',{preHandler:auth},async req=>db.chats.get(req.device!.id,req.params.id));
  app.get<{Params:{id:string;requestId:string}}>('/api/chats/:id/runs/:requestId',{preHandler:auth},async req=>{
    const device=req.device!.id,record=ledger.inspect(device,req.params.id,req.params.requestId);if(!record)throw new DomainError('NOT_FOUND','Запрос не найден.',404);
    let live=false;try{db.chats.get(device,req.params.id);live=true;}catch{}
    const run=live?db.chats.run(device,req.params.id,req.params.requestId):null;return {...record,result:run?.result??null,expired:!live||!run,snapshot:live?db.chats.events.snapshot(device,req.params.id,req.params.requestId):null};
  });
  app.patch<{Params:{id:string}}>('/api/chats/:id',{preHandler:auth},async req=>{
    if(running.get(req.device!.id)?.chatId===req.params.id)throw new DomainError('CHAT_BUSY','Дождитесь ответа или отмените запрос перед сменой режима.',409);
    const b=objectInput(req.body);return b.title!==undefined?db.chats.rename(req.device!.id,req.params.id,b.title,b.expectedVersion):db.chats.changeMode(req.device!.id,req.params.id,b.mode,b.expectedVersion);
  });
  app.put<{Params:{id:string}}>('/api/chats/:id/provider',{preHandler:auth},async req=>{if(running.get(req.device!.id)?.chatId===req.params.id)throw new DomainError('CHAT_BUSY','Дождитесь завершения запроса.',409);const b=objectInput(req.body);if(b.providerId!==null&&typeof b.providerId!=='string'||!Number.isInteger(b.expectedVersion))throw new DomainError('VALIDATION_ERROR','Некорректная привязка ИИ.');providers.bindChat(b.providerId as string|null,false)?.release();return db.chats.bindProvider(req.device!.id,req.params.id,b.providerId as string|null,b.expectedVersion as number);});
  app.delete<{Params:{id:string}}>('/api/chats/:id',{preHandler:auth},async req=>{if(running.get(req.device!.id)?.chatId===req.params.id)throw new DomainError('CHAT_BUSY','Дождитесь завершения запроса.',409);db.chats.remove(req.device!.id,req.params.id,objectInput(req.body).expectedVersion);return {ok:true};});
  app.delete<{Params:{id:string}}>('/api/chats/:id/draft',{preHandler:auth},async req=>{
    const current=db.chats.get(req.device!.id,req.params.id), b=objectInput(req.body);
    if(running.get(req.device!.id)?.chatId===req.params.id || !current.pendingTask || current.pendingTask.id!==b.draftId || current.pendingTask.version!==b.draftVersion)throw new DomainError('DRAFT_CONFLICT','Черновик изменился или используется запросом.',409);
    db.chats.setDraft(req.device!.id,req.params.id,null);return db.chats.get(req.device!.id,req.params.id);
  });
  const uploading=new Set<number>();
  app.post<{Querystring:{chatId?:string;name?:string}}>('/api/attachments/queued',{preHandler:auth},async(req,reply)=>{
    if(!Buffer.isBuffer(req.body))throw new DomainError('FILE_FORMAT','Нужен файл application/octet-stream.');
    return reply.code(202).send(await extractionJobs.enqueue(scheduler,req.device!.id,String(req.query.chatId??''),String(req.query.name??''),req.body));
  });
  app.get<{Params:{id:string};Querystring:{chatId?:string}}>('/api/attachments/:id',{preHandler:auth},async req=>{const {bytes:_b,text:_t,report:_r,...f}=db.chats.attachment(req.device!.id,String(req.query.chatId??''),req.params.id);return f;});
  app.post<{Params:{id:string}}>('/api/attachments/:id/analyze',{preHandler:auth},async(req,reply)=>{const b=objectInput(req.body);return reply.code(202).send(documentJobs.enqueue(scheduler,req.device!.id,String(b.chatId??''),req.params.id,b));});
  app.get<{Params:{id:string;requestId:string};Querystring:{chatId:string}}>('/api/attachments/:id/analysis/:requestId',{preHandler:auth},async req=>{const status=documentJobs.status(scheduler,req.device!.id,req.query.chatId,req.params.requestId);if(status.attachmentId!==req.params.id)throw new DomainError('NOT_FOUND','Обработка не найдена.',404);return status;});
  app.post<{Params:{id:string;requestId:string}}>('/api/attachments/:id/analysis/:requestId/cancel',{preHandler:auth},async req=>{const b=objectInput(req.body),chat=String(b.chatId??'');const status=documentJobs.status(scheduler,req.device!.id,chat,req.params.requestId);if(status.attachmentId!==req.params.id)throw new DomainError('NOT_FOUND','Обработка не найдена.',404);return documentJobs.cancel(scheduler,req.device!.id,chat,req.params.requestId);});
  app.get<{Params:{id:string};Querystring:{chatId:string}}>('/api/attachments/:id/extraction',{preHandler:auth},async req=>{const f=db.chats.attachment(req.device!.id,req.query.chatId,req.params.id);return {report:f.report};});
  app.post<{Params:{id:string}}>('/api/attachments/:id/cancel',{preHandler:auth},async req=>{const b=objectInput(req.body),chat=String(b.chatId??''),file=db.chats.attachment(req.device!.id,chat,req.params.id),job=scheduler.find('extract:'+file.id);if(job)scheduler.cancel(job.id);db.chats.extractionState(req.device!.id,chat,file.id,'failed','CANCELLED');return {ok:true};});
  app.post<{Params:{id:string}}>('/api/attachments/:id/retry',{preHandler:auth},async req=>{const b=objectInput(req.body),f=db.chats.attachment(req.device!.id,String(b.chatId??''),req.params.id);const job=scheduler.find('extract:'+f.id);if(!job)throw new DomainError('NOT_FOUND','Задание не найдено.',404);scheduler.retry(job.id);db.chats.extractionState(req.device!.id,f.chatId,f.id,'queued');return {ok:true};});
  app.post<{Querystring:{chatId?:string;name?:string}}>('/api/attachments',{preHandler:auth},async(req,reply)=>{
    const device=req.device!.id;
    if(uploading.has(device)||uploading.size>=2)throw new DomainError('UPLOAD_BUSY','Дождитесь завершения загрузок и повторите.',429);
    if(!Buffer.isBuffer(req.body))throw new DomainError('FILE_FORMAT','Отправьте файл как application/octet-stream.');
    uploading.add(device);
    try{return reply.code(201).send(await upload(db.chats,device,String(req.query.chatId??''),String(req.query.name??''),req.body));}finally{uploading.delete(device);}
  });
  app.get<{Params:{id:string};Querystring:{chatId?:string}}>('/api/attachments/:id/content',{preHandler:auth},async(req,reply)=>{
    const file=db.chats.attachment(req.device!.id,String(req.query.chatId??''),req.params.id);
    return reply.header('Content-Type','application/octet-stream').header('X-Content-Type-Options','nosniff').header('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(file.name)).send(file.bytes);
  });
  app.post<{Params:{id:string}}>('/api/attachments/:id/import',{preHandler:auth},async req=>{
    const device=req.device!.id,b=objectInput(req.body);
    if(uploading.has(device)||uploading.size>=2)throw new DomainError('UPLOAD_BUSY','Дождитесь завершения обработки файлов.',429);
    uploading.add(device);try{return await imports.import(device,String(b.chatId??''),req.params.id,b.note,String(b.operationId??''));}finally{uploading.delete(device);}
  });
  app.get<{Params:{id:string}}>('/api/assets/:id/original',{preHandler:auth},async(req,reply)=>{
    const f=await imports.original(req.params.id);return reply.header('Content-Type','application/octet-stream').header('X-Content-Type-Options','nosniff').header('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(f.name)).send(f.bytes);
  });

  app.get('/api/providers', { preHandler: auth }, async () => providers.list());
  const visibleJob=(id:string,device:number)=>{const row=db.sql.prepare('SELECT kind,payload_json FROM jobs WHERE id=?').get(id) as {kind:string;payload_json:string}|undefined;if(!row)return false;if(!['document','extract','summarize'].includes(row.kind))return true;try{return JSON.parse(row.payload_json).device===device;}catch{return false;}};
  app.get('/api/automation',{preHandler:auth},async(req)=>({settings:automationSettings.get(),jobs:scheduler.list().filter(job=>visibleJob(job.id,req.device!.id)),checkpoint:organizer.checkpoint()}));
  app.put('/api/automation',{preHandler:auth},async req=>{const input=objectInput(req.body),next=validateAutomationSettings(input,automationSettings.get(),Date.now());if(next.organizer.enabled){providers.bindOrganizer().release();if(db.getSetting('organizer.reviewed_policy')!==String(next.organizer.policyVersion))throw new DomainError('DRY_RUN_REQUIRED','Сначала просмотрите и примените пробный план сортировки. Для новых правил сначала выключите автоматический запуск.',409);}return automationSettings.save(input);});
  app.post('/api/organizer/preview',{preHandler:auth},async req=>{const b=objectInput(req.body);return organizer.preview(String(b.runId??''),AbortSignal.timeout(180000));});
  app.post('/api/organizer/apply',{preHandler:auth},async req=>{const b=objectInput(req.body);return organizer.apply(String(b.planId??''),String(b.operationId??''));});
  app.post('/api/organizer/reconcile',{preHandler:auth},async()=>{organizer.reconcile();return {ok:true};});
  app.post('/api/index/backfill',{preHandler:auth},async req=>{const b=objectInput(req.body);return index.backfill(mutations,String(b.operationId??''));});
  app.post<{Params:{id:string}}>('/api/jobs/:id/retry',{preHandler:auth},async req=>{if(!visibleJob(req.params.id,req.device!.id))throw new DomainError('NOT_FOUND','Задание недоступно.',404);return scheduler.retry(req.params.id);});
  app.get('/api/notifications',{preHandler:auth},async req=>({items:notifications.list(req.device!.id)}));
  app.get('/api/notifications/push',{preHandler:auth},async req=>notifications.status(req.device!.id));
  app.post('/api/notifications/push',{preHandler:auth},async req=>{notifications.subscribe(req.device!.id,req.body);return {ok:true};});
  app.delete('/api/notifications/push',{preHandler:auth},async req=>{notifications.unsubscribe(req.device!.id);return {ok:true};});
  app.post<{Params:{id:string}}>('/api/notifications/:id/read',{preHandler:auth},async req=>{notifications.read(req.device!.id,req.params.id);return {ok:true};});
  app.post('/api/ws-ticket',{preHandler:auth},async req=>tickets.issue(req.device!.id));
  app.post<{Params:{id:string;requestId:string}}>('/api/chats/:id/runs/:requestId/cancel',{preHandler:auth},async req=>{db.chats.get(req.device!.id,req.params.id);const active=running.get(req.device!.id);if(active?.chatId===req.params.id&&active.requestId===req.params.requestId)active.controller.abort();return {ok:true};});
  app.get<{Params:{id:string}}>('/api/chats/:id/runs',{preHandler:auth},async req=>{db.chats.get(req.device!.id,req.params.id);return {items:ledger.recent(req.device!.id,req.params.id)};});
  app.get('/api/sync/conflicts',{preHandler:auth},async()=>conflicts.list());
  app.get<{Querystring:{path?:string}}>('/api/sync/conflicts/document',{preHandler:auth},async req=>conflicts.get(String(req.query.path??'')));
  app.post('/api/sync/conflicts/resolve',{preHandler:auth},async req=>{const b=objectInput(req.body);if(b.content!==null&&typeof b.content!=='string'||b.expectedContentHash!==null&&typeof b.expectedContentHash!=='string')throw new DomainError('VALIDATION_ERROR','Нужен текст и версия конфликта.');return conflicts.resolve(String(b.path??''),b.expectedContentHash as string|null,b.content as string|null,String(b.operationId??''));});
  app.post('/api/sync/conflicts/complete',{preHandler:auth},async req=>conflicts.complete(objectInput(req.body).expectedPaths as string[]));
  app.post('/api/providers', { preHandler: auth }, async (req, reply) => {
    const body = objectInput(req.body);
    return reply.code(201).send(providers.create(body.slot, body.provider));
  });
  app.patch<{ Params: { id: string } }>('/api/providers/:id', { preHandler: auth }, async req => providers.update(req.params.id, req.body));
  app.delete<{ Params: { id: string } }>('/api/providers/:id', { preHandler: auth }, async (req, reply) => {
    providers.remove(req.params.id, objectInput(req.body).expectedVersion);
    return reply.code(204).send();
  });
  app.put('/api/providers/default', { preHandler: auth }, async req => {
    const body = objectInput(req.body);
    return providers.select(body.providerId, body.expectedVersion);
  });
  const testingProviders = new Set<string>();
  app.post<{ Params: { id: string } }>('/api/providers/:id/test', { preHandler: auth }, async req => {
    if (testingProviders.has(req.params.id)) throw new DomainError('PROVIDER_TEST_BUSY', 'Проверка этого профиля уже выполняется.', 409);
    testingProviders.add(req.params.id);
    try { return await providers.test(req.params.id); } finally { testingProviders.delete(req.params.id); }
  });

  app.get<{ Querystring: { chat?: string; before?: string; limit?: string } }>('/api/messages', { preHandler: auth }, async (req) => {
    const chat = req.query.chat ?? 'main';
    db.chats.get(req.device!.id,chat);
    const before = req.query.before ? Number(req.query.before) : undefined;
    const limit = Math.min(200, Number(req.query.limit ?? 50) || 50);
    const list = db.listMessages(req.device!.id, chat, limit, before);
    return { messages: list.map((m) => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : null })) };
  });

  app.delete<{ Querystring: { chat?: string } }>('/api/messages', { preHandler: auth }, async (req) => {
    const chat=req.query.chat??'main';db.chats.get(req.device!.id,chat);
    if(running.get(req.device!.id)?.chatId===chat)throw new DomainError('CHAT_BUSY','Дождитесь ответа перед очисткой.',409);
    db.clearMessages(req.device!.id, chat);
    return { ok: true };
  });

  app.get('/api/devices', { preHandler: auth }, async () => ({ devices: db.listDevices() }));

  app.delete<{ Params: { id: string } }>('/api/devices/:id', { preHandler: auth }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!db.revokeDevice(id)) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.post<{ Body: { name?: string; folder?: string } }>('/api/devices/quick', { preHandler: auth }, async (req) => {
    const { token, device } = db.createDevice(String(req.body?.name ?? 'Быстрая запись'), 'quick', req.body?.folder || undefined);
    return { token, device };
  });

  app.post('/api/pairing/new', { preHandler: auth }, async () => db.createPairingCode());

  app.post('/api/sync/pull', { preHandler: auth }, async () => {
    await sync.pull().catch(() => {});
    return sync.getStatus();
  });

  app.get('/api/preferences',{preHandler:auth},async()=>preferences.inspect());
  app.put('/api/preferences',{preHandler:auth},async req=>{const b=objectInput(req.body);if(b.expectedHash!==null&&typeof b.expectedHash!=='string')throw new DomainError('VALIDATION_ERROR','Нужна версия памяти.');return preferences.save(req.device!.id,b.fields,b.expectedHash as string|null,String(b.operationId??''));});
  app.delete('/api/preferences',{preHandler:auth},async req=>{const b=objectInput(req.body);return preferences.remove(req.device!.id,String(b.expectedHash??''),String(b.operationId??''));});
  app.get('/api/preferences/conflicts',{preHandler:auth},async req=>({items:db.chats.preferenceConflicts(req.device!.id)}));
  app.delete<{Params:{id:string}}>('/api/preferences/conflicts/:id',{preHandler:auth},async req=>{db.chats.removePreferenceConflict(req.device!.id,req.params.id);return {ok:true};});
  app.get('/api/tasks', { preHandler: auth }, async () => {
    await sync.pull().catch(() => {});
    return index.tasks();
  });
  app.get('/api/completed-events',{preHandler:auth},async()=>({retentionDays:RETENTION_DAYS,eligible:(await completedEvents.eligible()).length,base:EVENTS_BASE,providerConfigured:providers.list().organizerSafety.status==='different' && providers.list().items.some(profile=>profile.slot==='organizer' && profile.enabled),lastJob:scheduler.list().find(job=>job.kind==='archive_completed')??null}));
  app.post('/api/completed-events',{preHandler:auth},async(req,reply)=>{providers.bindOrganizer().release();return reply.code(202).send(scheduler.enqueue('archive_completed','archive-manual:'+crypto.randomUUID(),Date.now(),automationSettings.get().version));});
  app.get<{ Params: { id: string } }>('/api/tasks/:id', { preHandler: auth }, async req => tasks.get(req.params.id));
  app.get('/api/tasks/legacy',{preHandler:auth},async()=>({items:await tasks.legacy()}));
  app.post('/api/tasks/legacy/convert',{preHandler:auth},async req=>{const b=objectInput(req.body);return tasks.convertLegacy(objectInput(b.source) as unknown as import('@relay/core').LegacyTask,b.task,String(b.operationId??''));});
  app.post('/api/tasks', { preHandler: auth }, async (req, reply) => {
    const body = objectInput(req.body);
    const result = await tasks.create(body.task, String(body.operationId ?? ''));
    return reply.code(201).send(result);
  });
  app.patch<{ Params: { id: string } }>('/api/tasks/:id', { preHandler: auth }, async req => {
    const body = objectInput(req.body);
    return tasks.update(req.params.id, body.patch, String(body.expectedContentHash ?? ''), String(body.operationId ?? ''));
  });

  // HTTP chat (non-streaming) — fallback if WS is blocked
  app.post('/api/chat', { preHandler: auth }, async req => handleMessage(req.device!.id, req.body, () => {},req.authDurationMs));

  // ---------- WebSocket chat ----------
  app.get('/api/ws', { websocket: true }, (socket, req) => {
    const deviceId=tickets.consume(String((req.query as {ticket?:string}).ticket??''));
    const device=deviceId?db.listDevices().find(d=>d.id===deviceId):null;
    if (!device || device.kind !== 'app' || (req.headers.origin && req.headers.origin!==new URL(cfg.publicUrl).origin)) {
      socket.send(JSON.stringify({ type: 'error', text: 'unauthorized' }));
      socket.close();
      return;
    }
    db.touchDevice(device.id);
    const send = (obj: unknown) => {
      if (socket.bufferedAmount > 256 * 1024) { socket.close(1013, 'Resume from cursor'); return; }
      if (socket.readyState === 1) socket.send(JSON.stringify(obj));
    };
    let unsubscribe = () => {};
    socket.once('close', () => unsubscribe());
    const watch = (chat: string, request: string, onFinal=()=>{}) => { unsubscribe(); unsubscribe = db.chats.events.subscribe(device.id, chat, request, event=>{if(event.type==='result')onFinal();send(event);}); };
    send({ type: 'hello', version: VERSION, model: providers.list().items.find(p => p.id === providers.list().defaultChatProviderId)?.modelId ?? '' });
    socket.on('message', async (raw: Buffer) => {
      let msg: Record<string,unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if(!msg || typeof msg!=='object'||Array.isArray(msg))return;
      if(!db.listDevices().some(d=>d.id===device.id)){send({type:'error',text:'unauthorized'});socket.close();return;}
      if (msg.type === 'ping') return send({ type: 'pong', sync: sync.getStatus() });
      if (msg.type === 'resume') {
        const chat=String(msg.chatId??''),request=String(msg.requestId??''),after=Number(msg.lastSequence??0);
        if(!Number.isSafeInteger(after)||after<0)return;
        try {
          db.chats.get(device.id,chat);
          if(!ledger.inspect(device.id,chat,request))return;
          watch(chat,request);
          for(const event of db.chats.events.replay(device.id,chat,request,after))send(event);
          const saved=db.chats.run(device.id,chat,request);
          if(saved?.result)send({type:'result',chatId:chat,requestId:request,...saved.result as object});
        }catch{send({type:'error',chatId:chat,requestId:request,text:'Запрос недоступен.'});}
        return;
      }
      if (msg.type === 'cancel') {
        const active=running.get(device.id);
        if(active && active.chatId===msg.chatId && active.requestId===msg.requestId)active.controller.abort();
        return;
      }
      if (msg.type !== 'message') return;
      const reqId = String(msg.requestId??''); const chatId=String(msg.chatId??'');
      try {
        let delivered=false;
        watch(chatId,reqId,()=>{delivered=true;});
        const result = await handleMessage(device.id, msg, () => {});
        if(!delivered)send({ type: 'result', requestId:reqId,chatId, ...result });
      } catch (e) {
        send({ type: 'error', requestId:reqId,chatId, text:e instanceof DomainError?e.message:'Не удалось выполнить запрос.' });
      }
    });
  });

  function handleMessage(deviceId:number,value:unknown,onEvent:(e:AgentEvent)=>void,authDurationMs?:number){
    const run=measureRun(()=>{if(authDurationMs!==undefined)recordDuration('auth',authDurationMs);return runMessage(deviceId,value,onEvent);},metrics=>{
      const lag=eventLoop.percentile(95)/1e6;app.log.info({metrics:{...metrics,eventLoopP95Ms:lag}},'chat measurements');
      const b=value&&typeof value==='object'?value as Record<string,unknown>:{},chat=typeof b.chatId==='string'?b.chatId:'',request=typeof b.requestId==='string'?b.requestId:'',snapshot=db.chats.events.snapshot(deviceId,chat,request);
      diagnostics.record(metrics,{deviceId,chatId:chat,requestId:request,engine:metrics.providerCalls?snapshot?.engine:'direct',providerId:snapshot?.provider?.id,providerVersion:snapshot?.provider?.version,modelId:snapshot?.provider?.modelId,indexPending:indexCoordinator.status().pendingChanges,eventLoopP95Ms:lag});
    });activeRuns.add(run);run.then(()=>activeRuns.delete(run),()=>activeRuns.delete(run));return run;
  }
  async function runMessage(deviceId: number, value:unknown, onEvent: (e: AgentEvent) => void): Promise<AgentResult & { userMessageId: number; messageId: number; chat:ChatSession }> {
    const startedAt=performance.now();
    const referenceInstant=new Date().toISOString();
    const b=objectInput(value);
    if(typeof b.text!=='string'||b.text.length>20_000||typeof b.chatId!=='string'||typeof b.requestId!=='string'||!Number.isInteger(b.expectedVersion)||!Array.isArray(b.attachmentIds)||b.attachmentIds.length>5||b.attachmentIds.some(id=>typeof id!=='string'))throw new DomainError('INVALID_CHAT_REQUEST','Некорректное сообщение чата.');
    const input:ChatSendInput={chatId:b.chatId,requestId:b.requestId,expectedVersion:b.expectedVersion as number,text:b.text,attachmentIds:b.attachmentIds as string[],...(typeof b.draftId==='string'?{draftId:b.draftId,draftVersion:b.draftVersion as number}:{})}; const chat=input.chatId, text=input.text.trim();
    if(!text && !input.attachmentIds.length)throw new DomainError('EMPTY_MESSAGE','Напишите сообщение или выберите файл.');
    const requestHash=fingerprint(input),known=ledger.inspect(deviceId,chat,input.requestId,requestHash);
    if(known){let sessionExists=false;try{db.chats.get(deviceId,chat);sessionExists=true;}catch{}
      const saved=sessionExists?db.chats.run(deviceId,chat,input.requestId):null;
      if(saved?.result)return saved.result as Awaited<ReturnType<typeof handleMessage>>;
      throw new DomainError(sessionExists&&known.state==='running'?'RUN_UNRESOLVED':'REQUEST_EXPIRED',known.artifacts.length?'Запрос уже выполнялся. Сохранённые результаты: '+known.artifacts.join(', '):'Запрос уже выполнялся; история удалена или исполнение прервано. Повторная запись заблокирована.',known.state==='running'?409:410);
    }
    const session=db.chats.get(deviceId,chat);
    if(session.version!==input.expectedVersion)throw new DomainError('CHAT_VERSION_CONFLICT','Режим чата изменился. Обновите чат.',409);
    if(session.mode==='task' && (input.draftId&&!session.pendingTask || session.pendingTask && (session.pendingTask.id!==input.draftId||session.pendingTask.version!==input.draftVersion)))throw new DomainError('DRAFT_CONFLICT','Уточнение относится к другому или уже завершённому черновику. Обновите чат.',409);
    if (running.has(deviceId)) {
      throw new Error('Предыдущий запрос ещё выполняется. Подождите или отмените его.');
    }
    ledger.reserve(deviceId,chat,input.requestId,requestHash);
    const replay=db.chats.beginRun(deviceId,chat,input.requestId,requestHash);
    if(replay)return replay.result as Awaited<ReturnType<typeof handleMessage>>;
    const engine=cfg.agent?.engine??'mastra';
    db.chats.events.begin(deviceId,chat,input.requestId,engine,Math.min(session.expiresAt,Date.now()+14*86_400_000));
    const emit=(event:AgentEvent)=>{if(event.type==='delta'&&event.text)recordFirstText(performance.now()-startedAt);db.chats.events.emit(deviceId,chat,input.requestId,event);onEvent(event);};
    const ac = new AbortController();
    const deadline = setTimeout(() => ac.abort(), Math.max(1,Math.min(120_000,session.expiresAt-Date.now())));deadline.unref();
    running.set(deviceId, {controller:ac,chatId:chat,requestId:input.requestId});
    let userMessageId=0;
    let binding: ReturnType<ProviderRegistry['bindDefault']> = null;
    try {
      const remember=session.mode==='note'?rememberCommand(text):null;
      if(remember!==null&&input.attachmentIds.length)throw new DomainError('PREFERENCES_LITERAL_ONLY','Команда памяти сохраняет только явно написанное правило. Уберите вложения.');
      const directNote=session.mode==='note'&&(remember!==null||/^\/(?:quick|idea|person)(?:\s|$)/.test(text))&&!input.attachmentIds.length;
      const preferenceSnapshot=await preferences.inspect();
      binding = directNote ? null : providers.bindChat(session.providerId,session.mode==='note');
      db.chats.events.bind(deviceId,chat,input.requestId,binding?{id:binding.profile.id,version:binding.profile.version,modelId:binding.profile.modelId}:null);
      const ids=[...new Set(input.attachmentIds)];
      const files=ids.map(id=>db.chats.attachment(deviceId,chat,id));
      if(files.some(f=>f.processing!=='ready'))throw new DomainError('EXTRACTION_PENDING','Дождитесь распознавания вложений или уберите файл с ошибкой.',409);
      if(files.some(f=>f.kind==='image'&&!f.text.trim())&&!binding?.profile.capabilities.vision)throw new DomainError('VISION_REQUIRED','Текст изображения не распознан. Выберите ИИ с поддержкой изображений.');
      if(files.filter(f=>f.kind==='image').reduce((n,f)=>n+f.size,0)>6*1024*1024)throw new DomainError('CONTEXT_TOO_LARGE','Изображения для одного запроса должны занимать не более 6 МБ.');
      const prompt=(text||'Изучи приложенные файлы и ответь по их содержимому.')+attachmentContext(files,text);
      const parts:ChatMessage['parts']=files.length?[{type:'text',text:prompt},...files.filter(f=>f.kind==='image'&&binding?.profile.capabilities.vision).map(f=>({type:'image_url' as const,image_url:{url:'data:'+f.mediaType+';base64,'+f.bytes.toString('base64')}}))]:undefined;
      const remembered=session.mode==='note'?await measure('context',()=>memory.readContext(deviceId,chat)):null;
      userMessageId=db.addMessage(deviceId,chat,'user',text||'Прикреплены файлы',{attachments:input.attachmentIds.map(id=>{const {bytes:_b,text:_t,report:_r,...f}=db.chats.attachment(deviceId,chat,id);return f;}),mode:session.mode});
      const history = remembered?.history??db
        .listMessages(deviceId, chat, 12)
        .filter((m) => m.id !== userMessageId && (session.mode!=='task' || session.pendingTask!==null && m.createdAt>=session.pendingTask.createdAt))
        .map((m) => ({ role: m.role, content: m.content,createdAt:m.createdAt }));
      const operationId='chatop_'+fingerprint({deviceId,chat,requestId:input.requestId}).slice(0,64);
      const result:AgentResult = remember!==null ? await (async()=>{const saved=await preferences.remember(deviceId,remember,operationId+'_remember');return {text:'Правило сохранено в долговременной памяти.',sources:[],actions:[{kind:'updated' as const,path:saved.receipt.path,label:'Предпочтения сохранены'}],receipts:[saved.receipt]};})() : await modes.run({preferencesContext:preferences.context(preferenceSnapshot),device:deviceId,chat:session,text:prompt,userText:text,contextTools:files.length?[attachmentTool(db.chats,deviceId,chat,ids)]:undefined,history,parts,operationId,referenceInstant,onEvent:emit,engine,maxSteps:cfg.agent?.maxSteps??4,signal:ac.signal,llm:binding?.client??llm,toolsEnabled:binding?.profile.capabilities.toolCalls??false,structuredOutput:binding?.profile.capabilities.structuredOutput??false,extraPrompt:scenarios.systemPrompt,memoryContext:remembered?.context});
      if(preferenceSnapshot.warning)result.warnings=[...(result.warnings??[]),preferenceSnapshot.warning];
      const finalizedAt=performance.now();
      afterWrite(result);
      for(const action of result.actions)emit({type:'artifact.saved',path:action.path});
      const refs=new Map((result.sourceVersions??[]).map(r=>[r.path,r]));
      for(const a of result.actions)try{const n=await vault.readNote(a.path);refs.set(n.path,sourceVersion(n.path,n.content));}catch{}
      result.sourceVersions=[...refs.values()];
      result.tools=db.chats.events.terminalTools(deviceId,chat,input.requestId,result.outcome??'success');
      const messageId = db.addMessage(deviceId, chat, 'assistant', result.text, { tools:result.tools,receipts:result.receipts,outcome:result.outcome??'success',warnings:result.warnings,sources: result.sources, sourceVersions:result.sourceVersions,actions: result.actions, usage: result.usage,
        provider: binding ? { id: binding.profile.id, version: binding.profile.version, modelId: binding.profile.modelId } : null });
      await memory.record(deviceId,chat,result).catch(()=>{});
      const response={ ...result,outcome:result.outcome??'success', userMessageId, messageId,chat:db.chats.get(deviceId,chat),sync:sync.getStatus() };
      db.chats.finishRun(deviceId,chat,input.requestId,response,session.mode==='note'?{providerId:binding?.profile.id??null,providerVersion:binding?.profile.version??null}:undefined);
      ledger.finish(deviceId,chat,input.requestId,result.actions.map(a=>a.path),response.outcome,result.error?.code??null);
      db.chats.events.finish(deviceId,chat,input.requestId,response);
      summaryJobs.recover(scheduler);recordDuration('finalize',performance.now()-finalizedAt);return response;
    } catch (e) {
      const errText = ac.signal.aborted ? 'Запрос отменён.' : e instanceof DomainError?e.message:'Не удалось выполнить запрос к ИИ. Проверьте подключение и попробуйте снова.';
      if(!userMessageId)userMessageId=db.addMessage(deviceId,chat,'user',text||'Прикреплены файлы');

      const artifacts=ledger.artifacts(deviceId,chat,input.requestId),outcome:NonNullable<AgentResult['outcome']>=artifacts.length?'partial':ac.signal.aborted?'cancelled':'failed';
      const code=ac.signal.aborted?'CANCELLED':e instanceof DomainError?e.code:'MODEL_FAILED';
      const tools=db.chats.events.terminalTools(deviceId,chat,input.requestId,outcome);
      const actions=artifacts.map(path=>({kind:'updated' as const,path,label:'Сохранённый результат'}));
      const fullText=errText+(artifacts.length?'\nУже сохранено: '+artifacts.join(', '):'');
      const messageId=db.addMessage(deviceId,chat,'assistant',fullText,{error:true,tools,actions,outcome});
      const response={tools,text:errText+(artifacts.length?'\nУже сохранено: '+artifacts.join(', '):''),sources:[],actions:artifacts.map(path=>({kind:'updated' as const,path,label:'Сохранённый результат'})),outcome,error:{code,retryable:!artifacts.length&&['PROVIDER_TIMEOUT','PROVIDER_BUSY','PROVIDER_NETWORK_ERROR'].includes(code)},userMessageId,messageId,chat:db.chats.get(deviceId,chat)};
      db.chats.finishRun(deviceId,chat,input.requestId,response);ledger.finish(deviceId,chat,input.requestId,artifacts,outcome,code);db.chats.events.finish(deviceId,chat,input.requestId,response);return response;
    } finally {
      clearTimeout(deadline);
      binding?.release();
      running.delete(deviceId);
    }
  }

  // ---------- admin (CLI / bootstrap) ----------
  app.post('/api/admin/pairing', { preHandler: adminAuth }, async () => db.createPairingCode());
  app.post('/api/admin/reset', { preHandler: adminAuth }, async () => {
    db.resetPairingCodes();
    return { revoked: db.revokeAll() };
  });
  app.get('/api/admin/devices', { preHandler: adminAuth }, async () => ({ devices: db.listDevices() }));

  // ---------- static PWA ----------
  const staticDir = cfg.staticDir || path.resolve(import.meta.dirname ?? '.', '../../app/dist');
  const hasStatic = await fs
    .stat(path.join(staticDir, 'index.html'))
    .then(() => true)
    .catch(() => false);
  if (hasStatic) {
    await app.register(fastifyStatic, { root: staticDir, prefix: '/', wildcard: true });
    app.setNotFoundHandler(async (req, reply) => {
      const pathname = req.url.split('?')[0];
      if (pathname.startsWith('/api/') || pathname.startsWith('/assets/') || path.posix.extname(pathname)) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
    log(`serving PWA from ${staticDir}`);
  }

  // housekeeping
  db.pruneMessages();
  notifications.prune();scheduler.recover();documentJobs.recover(scheduler);extractionJobs.recover(scheduler);summaryJobs.recover(scheduler);scheduler.start();
  const prune = setInterval(() => {db.pruneMessages();notifications.prune(false);}, 3600_000);
  prune.unref();

  app.addHook('onClose', async () => {
    clearInterval(prune);
    eventLoop.disable();
    await indexCoordinator.stop();
    summaryJobs.stop();
    documentJobs.stop();extractionJobs.stop();
    await scheduler.stop();
    for(const run of running.values())run.controller.abort();
    await Promise.allSettled([...activeRuns]);
    await mcp.stop();await diagnostics.stop();
    sync.stop();
    await sync.exclusive(async () => {});
    disposeSearch(vault);
    db.close();
  });

  log(`obsidian-relay ${VERSION} on ${cfg.publicUrl} — vault: ${cfg.vault.root} — 3 note commands`);
  if (!db.listDevices().length) {
    const { code, expiresAt } = db.createPairingCode(60 * 60_000);
    log(`No devices yet. Pairing code (valid until ${new Date(expiresAt).toLocaleTimeString()}): ${code}`);
  }
  return app;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = await createServer(cfg);
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await app.listen({ host: cfg.host, port: cfg.port });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
