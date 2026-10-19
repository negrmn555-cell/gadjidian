import { DocumentAnalysis } from './DocumentAnalysis';
import { RunProgress, PartialResult, SavedArtifacts } from './RunProgress';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, ChatSession, ChatMode, ChatSendInput, ProviderPage } from '@relay/core/contracts';
import { emptyRunStream, reduceRunEvent, isPreferencesPath, categoryLabels, priorityLabels } from '@relay/core/contracts';
import { api, ApiError, ChatSocket, type Command, type Message, type ChatResult } from '../api';
import { Markdown } from '../Markdown';
import { Icon } from '../Icons';
import { NoteEditor } from './Notes';
import { EditorOverlay, ImportDialog, MemoryDialog } from './ChatTools';
import { ChatWelcome } from './ChatWelcome';
import { ChatThinking } from './ChatThinking';

interface Props { chat: ChatSession; draft: string; controlsOpen: boolean; onCloseControls: () => void; onDraft: (text: string) => void; onUpdated: (chat: ChatSession) => void; onUnauthorized: () => void; onBusy: (busy: boolean) => void }
let tempId = -1;

export function Chat({ chat, draft, controlsOpen, onCloseControls, onDraft, onUpdated, onUnauthorized, onBusy }: Props) {
  const [welcome, setWelcome] = useState<'ready' | 'leaving' | 'hidden'>(() => chat.messageCount === 0 ? 'ready' : 'hidden');
  const [binding, setBinding] = useState(false);
  const welcomeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [messages, setMessages] = useState<(Message & { animate?: boolean })[]>([]);
  const [commands, setCommands] = useState<Command[]>([]);
  const [wsState, setWsState] = useState<'connecting' | 'open' | 'closed'>('closed');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [modeMenu, setModeMenu] = useState(false);
  const [files, setFiles] = useState<(Attachment & { animate?: boolean })[]>(()=>{try{const saved=JSON.parse(sessionStorage.getItem('relay.files.'+chat.id)??'[]');return Array.isArray(saved)?saved.filter(f=>f.chatId===chat.id&&f.expiresAt>Date.now()).slice(0,5):[];}catch{return [];}});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [hasOlder, setHasOlder] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [providers, setProviders] = useState<ProviderPage | null>(null);
  const [analyzeFile,setAnalyzeFile]=useState<Attachment|null>(null);
  const [importFile, setImportFile] = useState<Attachment | null>(null);
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [showMemory, setShowMemory] = useState(false);
  const [importNotice, setImportNotice] = useState('');
  const openSource=(path:string)=>{if(isPreferencesPath(path)){setOpenNote(null);setShowMemory(true);}else setOpenNote(path);};
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => () => { if (welcomeTimer.current) clearTimeout(welcomeTimer.current); }, []);
  useEffect(() => {
    const input = inputRef.current;
    if (input) { input.style.height = '0px'; input.style.height = Math.max(44, Math.min(140, input.scrollHeight)) + 'px'; }
  }, [draft]);
  const modeRef = useRef<HTMLDivElement>(null);
  const modeButtonRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const restoredScroll=useRef(false);
  useEffect(()=>{try{if(files.length)sessionStorage.setItem('relay.files.'+chat.id,JSON.stringify(files));else sessionStorage.removeItem('relay.files.'+chat.id);}catch{}},[files,chat.id]);
  useEffect(()=>{if(loading||restoredScroll.current)return;restoredScroll.current=true;try{const saved=JSON.parse(sessionStorage.getItem('relay.scroll.'+chat.id)??'null');if(saved&&saved.expiresAt>Date.now()&&listRef.current){listRef.current.scrollTop=saved.top;followOutput.current=saved.follow;}}catch{}},[loading,chat.id]);
  const socketRef = useRef<ChatSocket | null>(null);
  const pending = useRef<ChatSendInput | null>(null);
  const stream = useRef(emptyRunStream());
  const runTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!messages.some(item => item.animate) && !files.some(item => item.animate)) return;
    const consume = () => {
      setMessages(items => items.map(item => item.animate ? { ...item, animate: false } : item));
      setFiles(items => items.map(item => item.animate ? { ...item, animate: false } : item));
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { consume(); return; }
    const timer = setTimeout(consume, 200);
    return () => clearTimeout(timer);
  }, [messages, files]);
  const filePending = files.some(file => file.processing && file.processing !== 'ready');
  const waitingIds = files.filter(file => file.processing === 'queued' || file.processing === 'running').map(file => file.id).join(',');

  useEffect(() => {
    if (!waitingIds) return;
    let stale = false;
    const poll = async () => {
      for (const id of waitingIds.split(',')) try {
        const file = await api.attachment(chat.id, id);
        if (!stale) setFiles(items => items.map(old => old.id === id ? { ...file, animate: old.animate } : old));
      } catch (e) { if (!stale) setError((e as Error).message); }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => { stale = true; clearInterval(timer); };
  }, [waitingIds, chat.id]);

  const handlers = useRef({ onUpdated, onUnauthorized });
  handlers.current = { onUpdated, onUnauthorized };

  useEffect(() => { onBusy(busy || uploading); return () => onBusy(false); }, [busy, uploading, onBusy]);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError('');
    api.messages(chat.id).then(result => { if (!stale) { setMessages(result.messages); if (result.messages.length) setWelcome(phase => phase === 'ready' ? 'hidden' : phase); setHasOlder(result.messages.length === 50); } }).catch(e => { if (!stale) { setError(e.message); if (e instanceof ApiError && e.status === 401) handlers.current.onUnauthorized(); } }).finally(() => { if (!stale) setLoading(false); });
    api.commands().then(result => { if (!stale) setCommands(result.commands); }).catch(() => {});
    api.providers().then(result => { if (!stale) setProviders(result); }).catch(() => {});
    api.chatRuns(chat.id).then(result => { if (stale) return; const unresolved = result.items.find(item => item.state === 'running'); if (unresolved && !pending.current) { pending.current = { chatId: chat.id, requestId: unresolved.requestId, text: '', attachmentIds: [], expectedVersion: chat.version }; setBusy(true); } const interrupted = result.items.find(item => item.state === 'interrupted'); if (interrupted) setError('Предыдущий запрос прерван. Сохранённые результаты: ' + (interrupted.artifacts.join(', ') || 'нет подтверждённых записей')); }).catch(() => {});
    return () => { stale = true; };
  }, [chat.id, chat.version]);

  const finish = (result: ChatResult) => {
    if (runTimer.current) clearTimeout(runTimer.current);
    pending.current = null;
    setBusy(false);
    setMessages(items => items.filter(item => !item.pending && item.id !== result.messageId).concat({ id: result.messageId, role: 'assistant', content: result.text, createdAt: Date.now(), meta: { tools:result.tools,receipts:result.receipts,outcome:result.outcome,warnings:result.warnings,sources: result.sources, actions: result.actions }, animate: true }));
    handlers.current.onUpdated(result.chat);
  };

  const fail = (message: string) => {
    if (runTimer.current) clearTimeout(runTimer.current);
    if (pending.current?.text) onDraft(pending.current.text);
    pending.current = null;
    setBusy(false);
    setMessages(items => items.filter(item => !item.pending));
    setError(message);
  };

  useEffect(() => {
    const socket = new ChatSocket();
    socket.onState = state => { setWsState(state); if(state==='open'&&pending.current)socket.send({type:'resume',chatId:chat.id,requestId:pending.current.requestId,lastSequence:stream.current.sequence}); };
    socket.onEvent = event => {
      if (event.type === 'error' && event.text === 'unauthorized') { handlers.current.onUnauthorized(); return; }
      if (!pending.current || event.chatId !== chat.id || event.requestId !== pending.current.requestId) return;
      if (typeof event.sequence === 'number') {
        const previous=stream.current;
        stream.current=reduceRunEvent(previous,event);
        if(stream.current.needsResume){socket.send({type:'resume',chatId:chat.id,requestId:pending.current.requestId,lastSequence:previous.sequence});return;}
        if(event.type!=='snapshot'&&event.sequence<=previous.sequence)return;
        const next=stream.current;
        setMessages(items => items.some(item=>item.pending) ? items.map(item => item.pending ? {...item,content:next.text,status:next.status,meta:{...item.meta,tools:next.tools}} : item) : [...items,{id:tempId--,role:'assistant',content:next.text,status:next.status,createdAt:Date.now(),pending:true,meta:{tools:next.tools}}]);
        if(event.kind==='run.interrupted'){fail('Сервер перезапустился. Проверьте сохранённые результаты запроса.');return;}
      }
      if (event.type === 'result') finish(event as unknown as ChatResult);
      if (event.type === 'error') { fail(String(event.text ?? 'Ошибка')); void api.getChat(chat.id).then(handlers.current.onUpdated).catch(() => {}); }
    };
    socket.connect();
    socketRef.current = socket;
    const ping = setInterval(() => socket.send({ type: 'ping' }), 25_000);
    return () => { clearInterval(ping); if (runTimer.current) clearTimeout(runTimer.current); socket.close(); };
  }, [chat.id]);

  useEffect(() => { if(followOutput.current)listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [messages, busy]);

  useEffect(() => {
    if (!modeMenu) return;
    const buttons = Array.from(modeRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    (buttons.find(button => button.getAttribute('aria-checked') === 'true') ?? buttons[0])?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setModeMenu(false); modeButtonRef.current?.focus(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const current = buttons.findIndex(button => button === document.activeElement);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[index]?.focus();
      }
      if (event.key === 'Tab') { setModeMenu(false); modeButtonRef.current?.focus(); }
    };
    const outside = (event: PointerEvent) => {
      if (!modeRef.current?.contains(event.target as Node) && !modeButtonRef.current?.contains(event.target as Node)) setModeMenu(false);
    };
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside); };
  }, [modeMenu]);

  useEffect(() => {
    if (!busy) return;
    let stale = false;
    const poll = async () => { const current = pending.current; if (!current) return; try { const status = await api.runStatus(current.chatId, current.requestId); if (stale || pending.current?.requestId !== current.requestId) return; if(status.snapshot&&status.snapshot.sequence>=stream.current.sequence){const next=reduceRunEvent(stream.current,{type:'snapshot',...status.snapshot});stream.current=next;setMessages(items=>items.some(i=>i.pending)?items.map(i=>i.pending?{...i,content:next.text,status:next.status,meta:{...i.meta,tools:next.tools}}:i):[...items,{id:tempId--,role:'assistant',content:next.text,status:next.status,createdAt:Date.now(),pending:true}]);} if (status.result) finish(status.result); else if (status.expired || status.state === 'interrupted') fail('Запрос прерван. Сохранённые результаты: ' + (status.artifacts.join(', ') || 'нет подтверждённых записей')); } catch (e) { if (e instanceof ApiError && e.status === 401) handlers.current.onUnauthorized(); } };
    const timer = setInterval(() => void poll(), 3000);
    if (wsState === 'open') void poll();
    return () => { stale = true; clearInterval(timer); };
  }, [busy, wsState, chat.id]);

  const slashQuery = useMemo(() => chat.mode === 'note' ? (/^\/([^\s]*)$/.exec(draft)?.[1].toLowerCase() ?? null) : null, [draft, chat.mode]);
  const slashItems = useMemo(() => slashQuery === null ? [] : commands.filter(command => command.name.startsWith(slashQuery) || command.label.toLowerCase().includes(slashQuery)), [commands, slashQuery]);
  useEffect(() => setSlashIndex(0), [slashQuery]);

  const send = async () => {
    if (busy || uploading || loading || filePending || !draft.trim() && !files.length) return;
    if (!navigator.onLine) { setError('Нет соединения. Текст остаётся в черновике; отправьте его после подключения.'); return; }
    const input: ChatSendInput = { chatId: chat.id, requestId: crypto.randomUUID(), expectedVersion: chat.version, text: draft.trim(), attachmentIds: files.map(file => file.id), ...(chat.mode === 'task' && chat.pendingTask ? { draftId: chat.pendingTask.id, draftVersion: chat.pendingTask.version } : {}) };
    stream.current=emptyRunStream();
    followOutput.current=true;
    pending.current = input;
    setBusy(true);
    setError('');
    onDraft('');
    if (welcome === 'ready') {
      setWelcome('leaving');
      welcomeTimer.current = setTimeout(() => setWelcome('hidden'), window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 150 : 2300);
    }
    setModeMenu(false);
    setMessages(items => [...items, { id: tempId--, role: 'user', content: input.text || 'Прикреплены файлы', createdAt: Date.now(), meta: { attachments: files }, animate: true }, { id: tempId--, role: 'assistant', content: '', createdAt: Date.now(), pending: true, status: 'Отправляю…', animate: true }]);
    setFiles([]);
    runTimer.current = setTimeout(() => setError('Ответ задерживается. Проверяю состояние запроса; повторно отправлять его не нужно.'), 130_000);
    if (!socketRef.current?.send({ type: 'message', ...input })) {
      try { finish(await api.chat(input)); } catch (e) { if (e instanceof ApiError && e.status === 401) onUnauthorized(); fail((e as Error).message); void api.getChat(chat.id).then(onUpdated).catch(() => {}); }
    }
  };

  const changeMode = async (mode: ChatMode) => {
    if (busy || uploading) return;
    setModeMenu(false);
    modeButtonRef.current?.focus();
    if (mode === chat.mode) return;
    setError('');
    try { onUpdated(await api.chatMode(chat, mode)); } catch (e) { setError((e as Error).message); if (e instanceof ApiError && e.status === 401) onUnauthorized(); else void api.getChat(chat.id).then(onUpdated).catch(() => {}); }
  };

  const attach = async (selected: FileList | null) => {
    if (!selected) return;
    setError('');
    if (files.length + selected.length > 5) { setError('Можно прикрепить до пяти файлов к сообщению.'); if (fileRef.current) fileRef.current.value = ''; return; }
    setUploading(true);
    try { for (const file of Array.from(selected)) { if (file.size > 5 * 1024 * 1024) throw new Error('Файл «' + file.name + '» превышает 5 МБ.'); const uploaded = await api.upload(chat.id, file); setFiles(items => [...items, { ...uploaded, animate: true }]); } }
    catch (e) { setError((e as Error).message); if (e instanceof ApiError && e.status === 401) onUnauthorized(); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const pick = (command: Command) => { onDraft('/' + command.name + ' '); setSlashIndex(-1); inputRef.current?.focus(); };
  const onKey = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') { if (slashItems.length) { event.preventDefault(); setSlashIndex(-1); } if (modeMenu) { event.preventDefault(); setModeMenu(false); } return; }
    if (slashItems.length && slashQuery !== null && slashIndex >= 0) { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSlashIndex(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + slashItems.length) % slashItems.length); return; } if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); pick(slashItems[slashIndex]); return; } }
    if (event.key === 'Enter' && !event.shiftKey && !(navigator.maxTouchPoints > 0)) { event.preventDefault(); void send(); }
  };

  const older = async () => { setError(''); try { const result = await api.messages(chat.id, messages[0]?.id); setMessages(items => [...result.messages, ...items]); setHasOlder(result.messages.length === 50); } catch (e) { setError((e as Error).message); } };

  const bindProvider = async (id: string) => {
    setBinding(true); setError('');
    try { onUpdated(await api.bindChat(chat, id || null)); }
    catch (e) { setError((e as Error).message); if (e instanceof ApiError && e.status === 401) onUnauthorized(); else void api.getChat(chat.id).then(onUpdated).catch(() => {}); }
    finally { setBinding(false); }
  };

  return <div className="screen chat-screen" data-od-id="chat-screen" data-welcome={welcome}>
    {welcome !== 'hidden' && <ChatWelcome phase={welcome} />}
    {controlsOpen && <EditorOverlay label="Чат"><section className="chat-controls-panel"><div className="editor-heading"><h2>Чат</h2><button className="icon-btn" aria-label="Закрыть параметры чата" onClick={onCloseControls}><Icon name="close" /></button></div><label>Модель ИИ<select className="field" aria-label="ИИ этого чата" disabled={busy || uploading || binding} value={chat.providerId ?? ''} onChange={event => void bindProvider(event.target.value)}><option value="">Основной из настроек</option>{providers?.items.filter(provider => provider.slot === 'chat' && provider.enabled).map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>{error && <p role="alert" className="error">{error}</p>}<button className="chat-memory-action" disabled={busy || uploading || binding} onClick={() => { onCloseControls(); setShowMemory(true); }}><span><strong>Память чата</strong><small>Резюме, заметки и контекст разговора</small></span><Icon name="chevron" /></button></section></EditorOverlay>}
    <div className="messages" ref={listRef} onScroll={event=>{const node=event.currentTarget;followOutput.current=node.scrollHeight-node.scrollTop-node.clientHeight<80;try{sessionStorage.setItem('relay.scroll.'+chat.id,JSON.stringify({top:node.scrollTop,follow:followOutput.current,expiresAt:chat.expiresAt}));}catch{}}} data-od-id="conversation">
      {importNotice && <p className="notice" role="status">{importNotice}</p>}
      {hasOlder && <button className="btn secondary small" onClick={() => void older()}>Ранее в этом чате</button>}
      {loading && <span className="sr-only" role="status">Загружаю чат…</span>}
      {messages.map(message => <div key={message.id} className={`msg ${message.role} ${message.meta?.error ? 'error' : ''} ${message.animate ? 'is-new' : ''}`} onAnimationEnd={() => { if (message.animate) setMessages(items => items.map(item => item.id === message.id ? { ...item, animate: false } : item)); }} data-od-id={'message-' + message.id}>{message.role==='assistant'&&<RunProgress tools={message.meta?.tools??[]} onOpen={openSource} pending={message.pending}/>}<SavedArtifacts receipts={message.meta?.receipts??[]} onOpen={openSource}/><PartialResult outcome={message.meta?.outcome} actions={message.meta?.actions??[]} receipts={message.meta?.receipts??[]} onOpen={openSource}/>{message.meta?.warnings?.map((warning,i)=><p key={i} className="notice" role="status">{warning}</p>)}{message.pending ? <><Markdown text={message.content} /><ChatThinking status={message.status} streaming={!!message.content} /></> : message.role === 'assistant' ? <Markdown text={message.content} /> : message.content}{message.meta?.attachments?.length ? <div className="message-files">{message.meta.attachments.map(file => <span className="message-file-actions" key={file.id}><button className="chip" key={file.id} disabled={busy || uploading} title="Полностью перенести в заметку" onClick={() => setImportFile(file)}><Icon name="file" />{file.name} · В заметку</button><button className="chip" disabled={busy||uploading||files.length>=5} onClick={()=>void api.attachment(chat.id,file.id).then(next=>setFiles(items=>items.some(old=>old.id===next.id)?items:[...items,next])).catch(e=>setError(e.message))}>Использовать снова</button>{file.mediaType==='application/pdf'&&<button className="chip" onClick={()=>setAnalyzeFile(file)}>Страницы и схемы</button>}</span>)}</div> : null}{!message.pending && (message.meta?.actions?.length || message.meta?.sources?.length) ? <div className="meta">{message.meta.actions?.map((action, index) => <button key={'a' + index} className="chip action" disabled={busy || uploading || /^Areas\/[^/]+\/Tasks\//i.test(action.path)} onClick={() => openSource(action.path)}>{action.label}</button>)}{message.meta.sources?.slice(0, 5).map((source, index) => <button key={'s' + index} className="chip" disabled={busy || uploading || /^Areas\/[^/]+\/Tasks\//i.test(source)} onClick={() => openSource(source)}>{source.replace(/\.md$/, '')}</button>)}</div> : null}</div>)}
    </div>
    <div className="composer-wrap">
      {error && <p className="composer-error" role="alert">{error}</p>}
      {chat.mode === 'task' && chat.pendingTask && <div className="task-draft" role="status"><div><strong>{chat.pendingTask.task.title}</strong><span>{categoryLabels[chat.pendingTask.task.category ?? 'personal']} · {priorityLabels[chat.pendingTask.task.priority ?? 'medium']}</span><p>{chat.pendingTask.question}</p></div><button className="icon-btn" disabled={busy || uploading} aria-label="Отменить черновик задачи" onClick={() => void api.cancelDraft(chat).then(onUpdated).catch(e => setError(e.message))}><Icon name="close" /></button></div>}
      {!!files.length && <div className="attachment-strip" aria-label="Прикреплённые файлы">{files.map(file => <div className={"attachment-chip " + (file.animate ? "is-new" : "")} key={file.id} onAnimationEnd={() => setFiles(items => items.map(item => item.id === file.id ? { ...item, animate: false } : item))}><Icon name="file" /><span>{file.name}<small>{Math.ceil(file.size / 1024)} КБ{file.processing && file.processing !== 'ready' ? ' · ' + ({ queued: 'В очереди', running: 'Распознаю', failed: 'Ошибка', ready: 'Готово' } as Record<string, string>)[file.processing] : ''}{file.extraction?.status === 'partial' ? ' · OCR частичный' : ''}</small></span><button className="import-file-button" title="Полностью в заметку" aria-label={'Перенести в заметку ' + file.name} disabled={busy || uploading || filePending} onClick={() => setImportFile(file)}><Icon name="note" /></button>{file.mediaType==='application/pdf'&&file.processing==='ready'&&<button className="import-file-button" onClick={()=>setAnalyzeFile(file)}>Схемы</button>}{file.processing&&['queued','running'].includes(file.processing)&&<button className="import-file-button" onClick={()=>void api.cancelExtraction(chat.id,file.id).then(()=>api.attachment(chat.id,file.id)).then(next=>setFiles(items=>items.map(old=>old.id===next.id?next:old))).catch(e=>setError(e.message))}>Стоп</button>}{file.processing === 'failed' && <button className="import-file-button" onClick={() => void api.retryAttachment(chat.id, file.id).then(() => api.attachment(chat.id, file.id)).then(next => setFiles(items => items.map(old => old.id === file.id ? next : old))).catch(e => setError(e.message))}>Повторить</button>}<button aria-label={'Убрать файл ' + file.name} disabled={busy || uploading} onClick={() => setFiles(items => items.filter(old => old.id !== file.id))}><Icon name="close" /></button></div>)}</div>}
      {uploading && <p className="mode-caption" role="status">Загружаю и распознаю файл…</p>}
      {modeMenu && <div ref={modeRef} className="mode-menu" role="menu" aria-label="Режим ИИ"><button role="menuitemradio" aria-checked={chat.mode === 'note'} onClick={() => void changeMode('note')}><Icon name="note" /><span><strong>Заметка</strong><small>Запись, идеи, люди и вопросы</small></span></button><button role="menuitemradio" aria-checked={chat.mode === 'task'} onClick={() => void changeMode('task')}><Icon name="tasks" /><span><strong>Задача</strong><small>Срок, категория и приоритет</small></span></button></div>}
      {slashItems.length > 0 && slashIndex >= 0 && <div className="slash-menu" role="listbox" aria-label="Команды">{slashItems.map((command, index) => <button key={command.name} className={'item ' + (slashIndex === index ? 'active' : '')} role="option" aria-selected={slashIndex === index} onMouseDown={event => event.preventDefault()} onClick={() => pick(command)}><span className="name">/{command.name}</span><span>{command.label}</span><span className="hint">{command.hint}</span></button>)}</div>}
      <input ref={fileRef} className="file-picker" type="file" multiple accept=".png,.jpg,.jpeg,.webp,.pdf,.docx,.txt,.md,.csv,.json" aria-label="Фото или документы" onChange={event => void attach(event.target.files)} />
      <div className="composer"><div className="input-pill"><button className="add-button" aria-label="Загрузить файлы" disabled={busy || uploading || loading} onClick={() => fileRef.current?.click()}><Icon name="plus" /></button><textarea ref={inputRef} rows={1} placeholder={chat.mode === 'task' ? 'Что и к какому сроку…' : 'Напишите сообщение…'} aria-label="Сообщение" value={draft} onChange={event => { onDraft(event.target.value); setSlashIndex(0); }} onKeyDown={onKey} enterKeyHint="send" /></div><button ref={modeButtonRef} className="command-button" aria-label={'Режим ИИ: ' + (chat.mode === 'task' ? 'Задача' : 'Заметка')} title="Сменить режим ИИ" aria-haspopup="menu" aria-expanded={modeMenu} disabled={busy || uploading} onClick={() => setModeMenu(value => !value)}><Icon name={chat.mode === 'task' ? 'tasks' : 'note'} /></button>{busy ? <button className="round secondary" aria-label="Отменить" onClick={() => pending.current && void api.cancelRun(chat.id, pending.current.requestId).catch(e => setError(e.message))}><Icon name="close" /></button> : <button className="round" aria-label="Отправить" disabled={loading || uploading || filePending || !draft.trim() && !files.length} onClick={() => void send()}><Icon name="send" /></button>}</div>{wsState !== 'open' && <span className="connection-caption" role="status">{wsState === 'connecting' ? 'Подключаюсь…' : 'Соединение восстанавливается'}</span>}</div>
    {(analyzeFile || importFile || openNote || showMemory) && <EditorOverlay label={analyzeFile?'Разбор PDF':openNote ? 'Редактор заметки' : importFile ? 'Импорт файла' : 'Память чата'}>{analyzeFile?<DocumentAnalysis file={analyzeFile} chatId={chat.id} onClose={()=>setAnalyzeFile(null)} onUpdated={file=>{setAnalyzeFile(file);setFiles(items=>items.map(old=>old.id===file.id?file:old));}} onUnauthorized={onUnauthorized}/>:openNote ? <NoteEditor key={openNote} path={openNote} onClose={() => setOpenNote(null)} onUnauthorized={onUnauthorized} /> : importFile ? <ImportDialog file={importFile} chatId={chat.id} onClose={() => setImportFile(null)} onUnauthorized={onUnauthorized} onImported={result => { setImportNotice(result.status === 'complete' ? 'Оригинал и извлечённый текст сохранены.' : 'Оригинал сохранён, распознавание частичное: проверьте замечания в заметке.'); setImportFile(null); setOpenNote(result.notePath); }} /> : <MemoryDialog chatId={chat.id} onClose={() => setShowMemory(false)} onOpenNote={path => { setShowMemory(false); setOpenNote(path); }} onUnauthorized={onUnauthorized} />}</EditorOverlay>}
  </div>;
}
