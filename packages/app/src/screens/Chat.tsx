import { useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, ChatSession, ChatMode, ChatSendInput, ProviderPage } from '@relay/core/contracts';
import { categoryLabels, priorityLabels } from '@relay/core/contracts';
import { api, ApiError, ChatSocket, type Command, type Message, type ChatResult } from '../api';
import { Markdown } from '../Markdown';
import { Icon } from '../Icons';
import { NoteEditor } from './Notes';
import { EditorOverlay, ImportDialog, MemoryDialog } from './ChatTools';

interface Props { chat: ChatSession; draft: string; onDraft: (text: string) => void; onUpdated: (chat: ChatSession) => void; onUnauthorized: () => void; onBusy: (busy: boolean) => void }
let tempId = -1;

export function Chat({ chat, draft, onDraft, onUpdated, onUnauthorized, onBusy }: Props) {
  const [messages, setMessages] = useState<(Message & { animate?: boolean })[]>([]);
  const [commands, setCommands] = useState<Command[]>([]);
  const [wsState, setWsState] = useState<'connecting' | 'open' | 'closed'>('closed');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [modeMenu, setModeMenu] = useState(false);
  const [files, setFiles] = useState<(Attachment & { animate?: boolean })[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [hasOlder, setHasOlder] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [providers, setProviders] = useState<ProviderPage | null>(null);
  const [importFile, setImportFile] = useState<Attachment | null>(null);
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [showMemory, setShowMemory] = useState(false);
  const [importNotice, setImportNotice] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modeRef = useRef<HTMLDivElement>(null);
  const modeButtonRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<ChatSocket | null>(null);
  const pending = useRef<ChatSendInput | null>(null);
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
    api.messages(chat.id).then(result => { if (!stale) { setMessages(result.messages); setHasOlder(result.messages.length === 50); } }).catch(e => { if (!stale) { setError(e.message); if (e instanceof ApiError && e.status === 401) handlers.current.onUnauthorized(); } }).finally(() => { if (!stale) setLoading(false); });
    api.commands().then(result => { if (!stale) setCommands(result.commands); }).catch(() => {});
    api.providers().then(result => { if (!stale) setProviders(result); }).catch(() => {});
    api.chatRuns(chat.id).then(result => { if (stale) return; const unresolved = result.items.find(item => item.state === 'running'); if (unresolved && !pending.current) { pending.current = { chatId: chat.id, requestId: unresolved.requestId, text: '', attachmentIds: [], expectedVersion: chat.version }; setBusy(true); } const interrupted = result.items.find(item => item.state === 'interrupted'); if (interrupted) setError('Предыдущий запрос прерван. Сохранённые результаты: ' + (interrupted.artifacts.join(', ') || 'нет подтверждённых записей')); }).catch(() => {});
    return () => { stale = true; };
  }, [chat.id, chat.version]);

  const finish = (result: ChatResult) => {
    if (runTimer.current) clearTimeout(runTimer.current);
    pending.current = null;
    setBusy(false);
    setMessages(items => items.filter(item => !item.pending).concat({ id: result.messageId, role: 'assistant', content: result.text, createdAt: Date.now(), meta: { sources: result.sources, actions: result.actions }, animate: true }));
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
    socket.onState = setWsState;
    socket.onEvent = event => {
      if (event.type === 'error' && event.text === 'unauthorized') { handlers.current.onUnauthorized(); return; }
      if (!pending.current || event.chatId !== chat.id || event.requestId !== pending.current.requestId) return;
      if (event.type === 'status' || event.type === 'tool') setMessages(items => items.map(item => item.pending ? { ...item, status: String(event.text ?? '') } : item));
      if (event.type === 'result') finish(event as unknown as ChatResult);
      if (event.type === 'error') { fail(String(event.text ?? 'Ошибка')); void api.getChat(chat.id).then(handlers.current.onUpdated).catch(() => {}); }
    };
    socket.connect();
    socketRef.current = socket;
    const ping = setInterval(() => socket.send({ type: 'ping' }), 25_000);
    return () => { clearInterval(ping); if (runTimer.current) clearTimeout(runTimer.current); socket.close(); };
  }, [chat.id]);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [messages.length, busy]);

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
    const poll = async () => { const current = pending.current; if (!current) return; try { const status = await api.runStatus(current.chatId, current.requestId); if (stale || pending.current?.requestId !== current.requestId) return; if (status.result) finish(status.result); else if (status.expired || status.state === 'interrupted') fail('Запрос прерван. Сохранённые результаты: ' + (status.artifacts.join(', ') || 'нет подтверждённых записей')); } catch (e) { if (e instanceof ApiError && e.status === 401) handlers.current.onUnauthorized(); } };
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
    pending.current = input;
    setBusy(true);
    setError('');
    onDraft('');
    setModeMenu(false);
    setMessages(items => [...items, { id: tempId--, role: 'user', content: input.text || 'Прикреплены файлы', createdAt: Date.now(), meta: { attachments: files }, animate: true }, { id: tempId--, role: 'assistant', content: '', createdAt: Date.now(), pending: true, status: 'Отправляю…', animate: true }]);
    setFiles([]);
    runTimer.current = setTimeout(() => fail('Ответ не получен. Откройте этот чат из истории и проверьте, сохранился ли результат, перед повторной отправкой.'), 130_000);
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

  return <div className="screen" data-od-id="chat-screen">
    <div className="messages" ref={listRef} data-od-id="conversation">
      <div className="chat-memory-toolbar"><label>ИИ чата<select aria-label="ИИ этого чата" disabled={busy || uploading} value={chat.providerId ?? ''} onChange={event => void api.bindChat(chat, event.target.value || null).then(onUpdated).catch(e => setError(e.message))}><option value="">Основной из настроек</option>{providers?.items.filter(provider => provider.slot === 'chat' && provider.enabled).map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label><button className="btn secondary small" disabled={busy || uploading} onClick={() => setShowMemory(true)}>Память чата</button></div>
      {importNotice && <p className="notice" role="status">{importNotice}</p>}
      {hasOlder && <button className="btn secondary small" onClick={() => void older()}>Ранее в этом чате</button>}
      {!messages.length && <div className="chat-empty"><p>{loading ? 'Загружаю чат…' : 'Что запишем сегодня?'}</p><span>{chat.mode === 'task' ? 'Задача с обязательным сроком' : 'Мысли, идеи и важные детали'}</span></div>}
      {messages.map(message => <div key={message.id} className={`msg ${message.role} ${message.meta?.error ? 'error' : ''} ${message.animate ? 'is-new' : ''}`} onAnimationEnd={() => { if (message.animate) setMessages(items => items.map(item => item.id === message.id ? { ...item, animate: false } : item)); }} data-od-id={'message-' + message.id}>{message.pending ? <span className="status">{message.status ?? '…'}</span> : message.role === 'assistant' ? <Markdown text={message.content} /> : message.content}{message.meta?.attachments?.length ? <div className="message-files">{message.meta.attachments.map(file => <button className="chip" key={file.id} disabled={busy || uploading} title="Полностью перенести в заметку" onClick={() => setImportFile(file)}><Icon name="file" />{file.name} · В заметку</button>)}</div> : null}{!message.pending && (message.meta?.actions?.length || message.meta?.sources?.length) ? <div className="meta">{message.meta.actions?.map((action, index) => <button key={'a' + index} className="chip action" disabled={busy || uploading || /^Areas\/[^/]+\/Tasks\//i.test(action.path)} onClick={() => setOpenNote(action.path)}>{action.label}</button>)}{message.meta.sources?.slice(0, 5).map((source, index) => <button key={'s' + index} className="chip" disabled={busy || uploading || /^Areas\/[^/]+\/Tasks\//i.test(source)} onClick={() => setOpenNote(source)}>{source.replace(/\.md$/, '')}</button>)}</div> : null}</div>)}
    </div>
    <div className="composer-wrap">
      {error && <p className="composer-error" role="alert">{error}</p>}
      {chat.mode === 'task' && chat.pendingTask && <div className="task-draft" role="status"><div><strong>{chat.pendingTask.task.title}</strong><span>{categoryLabels[chat.pendingTask.task.category ?? 'personal']} · {priorityLabels[chat.pendingTask.task.priority ?? 'medium']}</span><p>{chat.pendingTask.question}</p></div><button className="icon-btn" disabled={busy || uploading} aria-label="Отменить черновик задачи" onClick={() => void api.cancelDraft(chat).then(onUpdated).catch(e => setError(e.message))}><Icon name="close" /></button></div>}
      {!!files.length && <div className="attachment-strip" aria-label="Прикреплённые файлы">{files.map(file => <div className={"attachment-chip " + (file.animate ? "is-new" : "")} key={file.id} onAnimationEnd={() => setFiles(items => items.map(item => item.id === file.id ? { ...item, animate: false } : item))}><Icon name="file" /><span>{file.name}<small>{Math.ceil(file.size / 1024)} КБ{file.processing && file.processing !== 'ready' ? ' · ' + ({ queued: 'В очереди', running: 'Распознаю', failed: 'Ошибка', ready: 'Готово' } as Record<string, string>)[file.processing] : ''}{file.extraction?.status === 'partial' ? ' · OCR частичный' : ''}</small></span><button className="import-file-button" title="Полностью в заметку" aria-label={'Перенести в заметку ' + file.name} disabled={busy || uploading || filePending} onClick={() => setImportFile(file)}><Icon name="note" /></button>{file.processing === 'failed' && <button className="import-file-button" onClick={() => void api.retryAttachment(chat.id, file.id).then(() => api.attachment(chat.id, file.id)).then(next => setFiles(items => items.map(old => old.id === file.id ? next : old))).catch(e => setError(e.message))}>Повторить</button>}<button aria-label={'Убрать файл ' + file.name} disabled={busy || uploading} onClick={() => setFiles(items => items.filter(old => old.id !== file.id))}><Icon name="close" /></button></div>)}</div>}
      {uploading && <p className="mode-caption" role="status">Загружаю и распознаю файл…</p>}
      {modeMenu && <div ref={modeRef} className="mode-menu" role="menu" aria-label="Режим ИИ"><button role="menuitemradio" aria-checked={chat.mode === 'note'} onClick={() => void changeMode('note')}><Icon name="note" /><span><strong>Заметка</strong><small>Запись, идеи, люди и вопросы</small></span></button><button role="menuitemradio" aria-checked={chat.mode === 'task'} onClick={() => void changeMode('task')}><Icon name="tasks" /><span><strong>Задача</strong><small>Срок, категория и приоритет</small></span></button></div>}
      {slashItems.length > 0 && slashIndex >= 0 && <div className="slash-menu" role="listbox" aria-label="Команды">{slashItems.map((command, index) => <button key={command.name} className={'item ' + (slashIndex === index ? 'active' : '')} role="option" aria-selected={slashIndex === index} onMouseDown={event => event.preventDefault()} onClick={() => pick(command)}><span className="name">/{command.name}</span><span>{command.label}</span><span className="hint">{command.hint}</span></button>)}</div>}
      <div className="mode-caption">{chat.mode === 'task' ? 'Задача' : 'Заметка'}{chat.mode === 'note' ? ' · /quick · /idea · /person' : ''}</div>
      <input ref={fileRef} className="file-picker" type="file" multiple accept=".png,.jpg,.jpeg,.webp,.pdf,.docx,.txt,.md,.csv,.json" aria-label="Фото или документы" onChange={event => void attach(event.target.files)} />
      <div className="composer"><div className="input-pill"><button className="add-button" aria-label="Загрузить файлы" disabled={busy || uploading || loading} onClick={() => fileRef.current?.click()}><Icon name="plus" /></button><textarea ref={inputRef} rows={1} placeholder={chat.mode === 'task' ? 'Что и к какому сроку…' : 'Напишите сообщение…'} aria-label="Сообщение" value={draft} onChange={event => { onDraft(event.target.value); setSlashIndex(0); }} onKeyDown={onKey} enterKeyHint="send" /></div><button ref={modeButtonRef} className="command-button" aria-label={'Режим ИИ: ' + (chat.mode === 'task' ? 'Задача' : 'Заметка')} title="Сменить режим ИИ" aria-haspopup="menu" aria-expanded={modeMenu} disabled={busy || uploading} onClick={() => setModeMenu(value => !value)}><Icon name={chat.mode === 'task' ? 'tasks' : 'note'} /></button>{busy ? <button className="round secondary" aria-label="Отменить" onClick={() => pending.current && void api.cancelRun(chat.id, pending.current.requestId).catch(e => setError(e.message))}><Icon name="close" /></button> : <button className="round" aria-label="Отправить" disabled={loading || uploading || filePending || !draft.trim() && !files.length} onClick={() => void send()}><Icon name="send" /></button>}</div>{wsState !== 'open' && <span className="connection-caption" role="status">{wsState === 'connecting' ? 'Подключаюсь…' : 'Соединение восстанавливается'}</span>}</div>
    {(importFile || openNote || showMemory) && <EditorOverlay label={openNote ? 'Редактор заметки' : importFile ? 'Импорт файла' : 'Память чата'}>{openNote ? <NoteEditor key={openNote} path={openNote} onClose={() => setOpenNote(null)} onUnauthorized={onUnauthorized} /> : importFile ? <ImportDialog file={importFile} chatId={chat.id} onClose={() => setImportFile(null)} onUnauthorized={onUnauthorized} onImported={result => { setImportNotice(result.status === 'complete' ? 'Оригинал и извлечённый текст сохранены.' : 'Оригинал сохранён, распознавание частичное: проверьте замечания в заметке.'); setImportFile(null); setOpenNote(result.notePath); }} /> : <MemoryDialog chatId={chat.id} onClose={() => setShowMemory(false)} onOpenNote={path => { setShowMemory(false); setOpenNote(path); }} onUnauthorized={onUnauthorized} />}</EditorOverlay>}
  </div>;
}
