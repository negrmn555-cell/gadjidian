import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, ChatSocket, type Action, type Command, type Message } from '../api';
import { Markdown } from '../Markdown';

interface Props {
  onSettings: () => void;
  initialText?: string;
  onUnauthorized: () => void;
}

let tempId = -1;

export function Chat({ onSettings, initialText, onUnauthorized }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState(initialText ?? '');
  const [commands, setCommands] = useState<Command[]>([]);
  const [wsState, setWsState] = useState<'connecting' | 'open' | 'closed'>('closed');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const socketRef = useRef<ChatSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const pendingIdRef = useRef<string | null>(null);

  // load history + commands
  useEffect(() => {
    api
      .messages()
      .then((r) => setMessages(r.messages))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) onUnauthorized();
      });
    api.commands().then((r) => setCommands(r.commands)).catch(() => {});
  }, [onUnauthorized]);

  // websocket
  useEffect(() => {
    const s = new ChatSocket();
    s.onState = setWsState;
    s.onEvent = (e) => {
      const type = e.type as string;
      if (type === 'status' || type === 'tool') {
        setMessages((ms) => ms.map((m) => (m.pending ? { ...m, status: String(e.text ?? '') } : m)));
      } else if (type === 'result') {
        setBusy(false);
        pendingIdRef.current = null;
        const r = e as unknown as { text: string; sources: string[]; actions: Action[]; messageId: number };
        setMessages((ms) =>
          ms
            .filter((m) => !m.pending)
            .concat({ id: r.messageId, role: 'assistant', content: r.text, createdAt: Date.now(), meta: { sources: r.sources, actions: r.actions } }),
        );
      } else if (type === 'error') {
        setBusy(false);
        pendingIdRef.current = null;
        setMessages((ms) =>
          ms.filter((m) => !m.pending).concat({ id: tempId--, role: 'assistant', content: String(e.text ?? 'Ошибка'), createdAt: Date.now(), meta: { error: true } }),
        );
      }
    };
    s.connect();
    socketRef.current = s;
    const ping = setInterval(() => s.send({ type: 'ping' }), 25000);
    return () => {
      clearInterval(ping);
      s.close();
    };
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  useEffect(() => {
    if (initialText) inputRef.current?.focus();
  }, [initialText]);

  const slashQuery = useMemo(() => {
    const m = /^\/([^\s]*)$/.exec(text);
    return m ? m[1].toLowerCase() : null;
  }, [text]);

  const slashItems = useMemo(() => {
    if (slashQuery === null) return [];
    return commands.filter((c) => c.name.toLowerCase().startsWith(slashQuery) || c.label.toLowerCase().includes(slashQuery));
  }, [commands, slashQuery]);

  useEffect(() => setSlashIndex(0), [slashQuery]);

  const pickCommand = (c: Command) => {
    setText(`/${c.name} `);
    inputRef.current?.focus();
    if (!c.hint) {
      // command without argument: send right away
      setTimeout(() => send(`/${c.name}`), 0);
    }
  };

  const send = async (override?: string) => {
    const value = (override ?? text).trim();
    if (!value || busy) return;
    setText('');
    setBusy(true);
    const reqId = String(Date.now());
    pendingIdRef.current = reqId;
    setMessages((ms) => [
      ...ms,
      { id: tempId--, role: 'user', content: value, createdAt: Date.now() },
      { id: tempId--, role: 'assistant', content: '', createdAt: Date.now(), pending: true, status: 'Отправляю…' },
    ]);
    const ok = socketRef.current?.send({ type: 'message', text: value, chat: 'main', id: reqId });
    if (!ok) {
      // HTTP fallback
      try {
        const r = await api.chat(value);
        setMessages((ms) =>
          ms.filter((m) => !m.pending).concat({ id: r.messageId, role: 'assistant', content: r.text, createdAt: Date.now(), meta: { sources: r.sources, actions: r.actions } }),
        );
      } catch (e) {
        setMessages((ms) =>
          ms.filter((m) => !m.pending).concat({ id: tempId--, role: 'assistant', content: (e as Error).message, createdAt: Date.now(), meta: { error: true } }),
        );
      } finally {
        setBusy(false);
      }
    }
  };

  const cancel = () => {
    socketRef.current?.send({ type: 'cancel' });
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashItems.length && slashQuery !== null) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slashItems.length) % slashItems.length);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        pickCommand(slashItems[slashIndex]);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !isTouch()) {
      e.preventDefault();
      void send();
    }
  };

  const toggleRecord = async () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (ev) => chunks.push(ev.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        setBusy(true);
        try {
          const r = await api.transcribe(blob);
          setText((t) => (t ? `${t} ${r.text}` : r.text));
          inputRef.current?.focus();
        } catch (e) {
          alert(`Не удалось расшифровать: ${(e as Error).message}`);
        } finally {
          setBusy(false);
        }
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
    } catch {
      alert('Нет доступа к микрофону');
    }
  };

  return (
    <div className="screen">
      <div className="header">
        <span className={`dot ${wsState}`} title={wsState} />
        <span className="title">Relay</span>
        <button className="icon-btn" onClick={onSettings} aria-label="Настройки">
          ⚙
        </button>
      </div>
      <div className="messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="empty">
            <div>Напишите мысль — она попадёт в хранилище. Спросите — ответ соберётся из ваших заметок.</div>
            <div className="hintbox">
              {commands.slice(0, 6).map((c) => (
                <button key={c.name} className="btn secondary small" onClick={() => pickCommand(c)}>
                  /{c.name} · {c.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role} ${m.meta?.error ? 'error' : ''}`}>
            {m.pending ? (
              <span className="status">{m.status ?? '…'}</span>
            ) : m.role === 'assistant' ? (
              <Markdown text={m.content} />
            ) : (
              m.content
            )}
            {!m.pending && m.meta && (m.meta.actions?.length || m.meta.sources?.length) ? (
              <div className="meta">
                {m.meta.actions?.map((a, i) => (
                  <span key={`a${i}`} className="chip action">
                    {a.label}
                  </span>
                ))}
                {m.meta.sources?.slice(0, 5).map((s, i) => (
                  <span key={`s${i}`} className="chip">
                    {s.replace(/\.md$/, '')}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="composer-wrap">
        {slashItems.length > 0 && (
          <div className="slash-menu">
            {groupBy(slashItems).map(([group, items]) => (
              <div key={group}>
                <div className="group">{groupLabel(group)}</div>
                {items.map((c) => {
                  const idx = slashItems.indexOf(c);
                  return (
                    <button key={c.name} className={`item ${idx === slashIndex ? 'active' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pickCommand(c)}>
                      <span className="name">/{c.name}</span>
                      <span>{c.label}</span>
                      {c.hint && <span className="hint">{c.hint}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
        <div className="composer">
          <textarea
            ref={inputRef}
            rows={1}
            placeholder="Сообщение или / для команд"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            enterKeyHint="send"
          />
          <button className={`round secondary ${recording ? 'rec' : ''}`} onClick={toggleRecord} disabled={busy && !recording} aria-label="Голос">
            {recording ? '■' : '🎤'}
          </button>
          {busy ? (
            <button className="round secondary" onClick={cancel} aria-label="Отменить">
              ✕
            </button>
          ) : (
            <button className="round" onClick={() => void send()} disabled={!text.trim()} aria-label="Отправить">
              ➤
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function isTouch(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

function groupBy(items: Command[]): [string, Command[]][] {
  const map = new Map<string, Command[]>();
  for (const c of items) {
    if (!map.has(c.group)) map.set(c.group, []);
    map.get(c.group)!.push(c);
  }
  return Array.from(map.entries());
}

function groupLabel(g: string): string {
  switch (g) {
    case 'scenario':
      return 'Мои сценарии';
    case 'write':
      return 'Записать';
    case 'read':
      return 'Достать';
    default:
      return g;
  }
}
