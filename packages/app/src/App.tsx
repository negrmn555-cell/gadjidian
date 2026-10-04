import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatSession, ProviderPage } from '@relay/core/contracts';
import { api, ApiError, getToken, isStandalone, setToken } from './api';
import { Connect } from './screens/Connect';
import { Chat } from './screens/Chat';
import { Settings } from './screens/Settings';
import { InstallGate } from './screens/InstallGate';
import { Tasks } from './screens/Tasks';
import { Icon } from './Icons';
import { Notifications } from './screens/AutomationSettings';
import { NoteLink } from './screens/NoteLink';
import { loadDrafts, saveDraft, clearDrafts } from './browser-state';

const entryId = crypto.randomUUID();

export function App() {
  const [token, setTok] = useState(getToken());
  const [screen, setScreen] = useState<'chat' | 'settings' | 'notifications'>('chat');
  const [tab, setTab] = useState<'chat' | 'tasks'>('chat');
  const [required, setRequired] = useState<boolean | null>(null);
  const [menu, setMenu] = useState(false);
  const [menuClosing, setMenuClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [chat, setChat] = useState<ChatSession | null>(null);
  const [chats, setChats] = useState<ChatSession[]>([]);
  const [error, setError] = useState('');
  const [providers, setProviders] = useState<ProviderPage | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>(loadDrafts);
  const [noteLink, setNoteLink] = useState<{ target: string; from?: string } | null>(null);
  const [unread, setUnread] = useState(0);
  const [editingChat, setEditingChat] = useState<ChatSession | null>(null);
  const [chatTitle, setChatTitle] = useState('');
  const [shared, setShared] = useState('');
  const drawerRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const appShellRef = useRef<HTMLDivElement>(null);
  const latestList = useRef(0);
  const newEntry = useRef(entryId);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuDestination = useRef<'settings' | 'notifications' | null>(null);
  const hadMenu = useRef(false);

  const closeMenu = useCallback(() => {
    if (!menu || menuClosing) return;
    setMenuClosing(true);
    const finish = () => {
      setMenu(false);
      setMenuClosing(false);
      closeTimer.current = null;
      if (menuDestination.current) setScreen(menuDestination.current);
      menuDestination.current = null;
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
    else closeTimer.current = setTimeout(finish, 260);
  }, [menu, menuClosing]);

  const openMenu = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    menuDestination.current = null;
    setMenuClosing(false);
    setMenu(true);
  }, []);

  const navigateFromMenu = (destination: 'settings' | 'notifications') => {
    menuDestination.current = destination;
    closeMenu();
  };
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  const unauthorized = useCallback(() => {
    setToken(null);
    setTok(null);
    setChat(null);
    setChats([]);
    setMenu(false);
    setMenuClosing(false);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    menuDestination.current = null;
    clearDrafts();
    setDrafts({});
    setNoteLink(null);
    newEntry.current = crypto.randomUUID();
  }, []);

  const report = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) unauthorized();
    else setError((e as Error).message);
  }, [unauthorized]);

  const reloadChats = useCallback(async () => {
    const generation = ++latestList.current;
    try {
      const r = await api.chats();
      if (generation === latestList.current) setChats(r.items);
    } catch (e) {
      report(e);
    }
  }, [report]);

  const updated = useCallback((next: ChatSession) => {
    latestList.current++;
    setChat(old => old?.id === next.id && next.version >= old.version ? next : old);
    setChats(old => {
      const previous = old.find(item => item.id === next.id);
      return previous && previous.version > next.version ? old : [next, ...old.filter(item => item.id !== next.id)];
    });
  }, []);

  const makeChat = async (fresh = true) => {
    if (busy || starting) return;
    if (fresh) newEntry.current = crypto.randomUUID();
    setStarting(true);
    setError('');
    try {
      const next = await api.newChat(newEntry.current, Intl.DateTimeFormat().resolvedOptions().timeZone);
      setChat(next);
      setTab('chat');
      if (menu) closeMenu();
      await reloadChats();
    } catch (e) {
      report(e);
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    if (!token) return;
    let stale = false;
    setStarting(true);
    api.newChat(newEntry.current, Intl.DateTimeFormat().resolvedOptions().timeZone)
      .then(next => { if (!stale) { setChat(next); void reloadChats(); } })
      .catch(e => { if (!stale) report(e); })
      .finally(() => { if (!stale) setStarting(false); });
    return () => { stale = true; };
  }, [token, reloadChats, report]);

  useEffect(() => {
    if (token && screen === 'chat') {
      api.providers().then(setProviders).catch(report);
      if (chat) api.getChat(chat.id).then(updated).catch(report);
    }
  }, [token, screen, report, updated]);

  useEffect(() => {
    if (menu) void reloadChats();
  }, [menu, reloadChats]);

  useEffect(() => {
    const clear = (event: Event) => {
      const id = (event as CustomEvent).detail.chat;
      saveDraft(id, '', 0);
      setDrafts(old => { const next = { ...old }; delete next[id]; return next; });
    };
    window.addEventListener('relay-clear-draft', clear);
    return () => window.removeEventListener('relay-clear-draft', clear);
  }, []);

  useEffect(() => {
    if (!token) return;
    const load = () => api.notifications().then(r => setUnread(r.items.filter(item => !item.read).length)).catch(() => {});
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [token, menu, screen]);

  useEffect(() => {
    const note = (event: Event) => setNoteLink((event as CustomEvent).detail);
    const push = (event: MessageEvent) => {
      if (event.data?.type === 'relay-notification') { if (menu) closeMenu(); setScreen('notifications'); }
    };
    window.addEventListener('relay-open-note', note);
    navigator.serviceWorker?.addEventListener('message', push);
    return () => { window.removeEventListener('relay-open-note', note); navigator.serviceWorker?.removeEventListener('message', push); };
  }, [menu, closeMenu]);

  useEffect(() => {
    const url = new URL(location.href);
    if (url.pathname === '/share') {
      setShared([url.searchParams.get('title'), url.searchParams.get('text'), url.searchParams.get('url')].filter(Boolean).join('\n'));
      history.replaceState(null, '', '/');
    } else if (url.searchParams.get('notification') === '1') {
      setScreen('notifications');
      url.searchParams.delete('notification');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  }, []);

  useEffect(() => {
    api.health().then(async health => { setRequired(health.requireStandalone); if (token) await api.me(); })
      .catch(e => { if (e instanceof ApiError && e.status === 401) unauthorized(); else setRequired(value => value ?? true); });
  }, [token, unauthorized]);

  useEffect(() => {
    const shell = appShellRef.current;
    if (menu) shell?.setAttribute('inert', '');
    else shell?.removeAttribute('inert');
    return () => shell?.removeAttribute('inert');
  }, [menu]);

  useEffect(() => {
    if (menu) {
      hadMenu.current = true;
      drawerRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    } else if (hadMenu.current) {
      hadMenu.current = false;
      if (screen === 'chat') menuRef.current?.focus();
      else document.querySelector<HTMLButtonElement>('.screen .header button[aria-label="Назад"]')?.focus();
    }
  }, [menu, screen]);

  useEffect(() => {
    if (!menu) return;
    const drawer = drawerRef.current;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(); return; }
      if (event.key !== 'Tab' || !drawer) return;
      const items = Array.from(drawer.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')).filter(item => item.getClientRects().length > 0);
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [menu, menuClosing, closeMenu]);

  const openChat = async (item: ChatSession) => {
    if (busy || starting) return;
    setStarting(true);
    setError('');
    try { setChat(await api.getChat(item.id)); setTab('chat'); closeMenu(); }
    catch (e) { report(e); await reloadChats(); }
    finally { setStarting(false); }
  };

  const dev = import.meta.env.DEV;
  if (!dev && required === null && !isStandalone()) return <div className="screen"><p className="empty" role="status">Подключаюсь к серверу…</p></div>;
  if (!dev && required !== false && !isStandalone()) return <InstallGate />;
  if (!token) return <Connect onConnected={next => { setToken(next); setTok(next); }} />;
  const selected = providers?.items.find(provider => provider.id === providers.defaultChatProviderId);

  return <>
    {screen === 'settings' && <Settings chatId={chat?.id} onBack={() => setScreen('chat')} onLogout={unauthorized} />}
    {screen === 'notifications' && <div className="screen"><div className="header"><button className="icon-btn" aria-label="Назад" onClick={() => setScreen('chat')}><Icon name="back" /></button><span className="title">Уведомления</span></div><div className="settings"><Notifications onUnauthorized={unauthorized} /></div></div>}
    {noteLink && <NoteLink {...noteLink} onClose={() => setNoteLink(null)} onUnauthorized={unauthorized} />}
    <div ref={appShellRef} className="app-shell" hidden={screen !== 'chat'}>
      <header className="workspace-header" data-od-id="workspace-header">
        <div className="workspace-toolbar"><button ref={menuRef} className="icon-btn" onClick={openMenu} aria-label="Открыть историю чатов" aria-expanded={menu && !menuClosing}><Icon name="menu" /></button></div>
        <nav className={'workspace-switch ' + (tab === 'tasks' ? 'tasks-selected' : '')} aria-label="Рабочие области" data-od-id="workspace-switch"><span className="switch-thumb" /><button aria-label="ИИ-чат" aria-pressed={tab === 'chat'} onClick={() => setTab('chat')}><Icon name="chat" /></button><button aria-label="Задачи" aria-pressed={tab === 'tasks'} onClick={() => setTab('tasks')}><Icon name="tasks" /></button></nav>
        <div className="model-caption" data-od-id="workspace-caption">{tab === 'chat' ? (selected?.name ?? 'ИИ не настроен') : 'Мои задачи'}</div>
      </header>
      {error && <div className="app-error" role="alert">{error}</div>}
      <div className="app-content">
        <div className="app-panel" hidden={tab !== 'chat'}>{chat ? <Chat key={chat.id} chat={chat} draft={drafts[chat.id] ?? (chat.messageCount === 0 ? shared : '')} onDraft={text => { saveDraft(chat.id, text, chat.expiresAt); setDrafts(old => ({ ...old, [chat.id]: text })); setShared(''); }} onUpdated={updated} onUnauthorized={unauthorized} onBusy={setBusy} /> : <div className="empty"><p>{starting ? 'Открываю новый чат…' : 'Не удалось открыть чат.'}</p>{!starting && <button className="btn" onClick={() => void makeChat(false)}>Повторить</button>}</div>}</div>
        <div className="app-panel" hidden={tab !== 'tasks'}><Tasks onSettings={() => { if (menu) closeMenu(); setScreen('settings'); }} onUnauthorized={unauthorized} addTaskSignal={0} /></div>
      </div>
    </div>
    {menu && screen === 'chat' && <div className={'drawer-layer ' + (menuClosing ? 'is-closing' : '')} data-od-id="drawer-layer"><button className="drawer-backdrop" tabIndex={-1} aria-label="Закрыть историю чатов" onClick={closeMenu} /><aside ref={drawerRef} className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title"><div className="drawer-heading"><h2 id="drawer-title">История чатов</h2><button className="icon-btn" aria-label="Закрыть историю чатов" onClick={closeMenu}><Icon name="close" /></button></div><button className="drawer-link new-chat" disabled={busy || starting} onClick={() => void makeChat()}><Icon name="plus" />Новый чат</button><p className="muted history-caption">История хранится 14 дней</p>{chats.filter(item => item.messageCount > 0 || item.id === chat?.id).map(item => <button key={item.id} className={'chat-choice ' + (item.id === chat?.id ? 'active' : '')} disabled={busy || starting} aria-current={item.id === chat?.id ? 'true' : undefined} onClick={() => void openChat(item)}><strong>{item.title}</strong><small>{new Date(item.updatedAt).toLocaleDateString('ru-RU')} · {item.mode === 'task' ? 'Задача' : 'Заметка'}{item.pendingTask ? ' · ждёт срока' : ''}</small></button>)}{!chats.some(item => item.messageCount > 0) && <p className="muted history-caption">Здесь появятся ваши разговоры</p>}{chat && <button className="drawer-link" disabled={busy || starting} onClick={() => { setEditingChat(chat); setChatTitle(chat.title); }}>Название / удалить текущий чат</button>}{editingChat && <form onSubmit={event => { event.preventDefault(); void api.renameChat(editingChat, chatTitle).then(next => { updated(next); setEditingChat(null); void reloadChats(); }).catch(report); }}><label>Название чата<input className="field" maxLength={80} required value={chatTitle} onChange={event => setChatTitle(event.target.value)} /></label><button className="btn small">Сохранить название</button><button type="button" className="btn secondary small" onClick={() => { if (confirm('Удалить историю этого чата? Задачи и заметки сохранятся.')) void api.removeChat(editingChat).then(async () => { saveDraft(editingChat.id, '', 0); setDrafts(old => { const next = { ...old }; delete next[editingChat.id]; return next; }); setEditingChat(null); if (chat?.id === editingChat.id) await makeChat(); else await reloadChats(); }).catch(report); }}>Удалить историю чата</button><button type="button" className="btn secondary small" onClick={() => setEditingChat(null)}>Отмена</button></form>}<button className="drawer-link" onClick={() => { navigateFromMenu('notifications'); }}>Уведомления{unread ? ' · ' + unread : ''}</button><button className="drawer-link drawer-settings" onClick={() => { navigateFromMenu('settings'); }}><Icon name="settings" />Настройки</button></aside></div>}
  </>;
}
