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
  meta?: { sources?: string[]; actions?: Action[]; error?: boolean; path?: string } | null;
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
  health: () => req<{ ok: boolean; version: string; sync: SyncStatus }>('GET', '/api/health'),
  pair: (code: string, name: string) => req<{ token: string; device: Device }>('POST', '/api/pair', { code, name }),
  me: () =>
    req<{ device: Device; vault: { inbox: string; daily: string; privateFolders: string[] }; model: string; sync: SyncStatus; requireStandalone: boolean }>(
      'GET',
      '/api/me',
    ),
  commands: () => req<{ commands: Command[] }>('GET', '/api/commands'),
  messages: (chat = 'main', before?: number) =>
    req<{ messages: Message[] }>('GET', `/api/messages?chat=${encodeURIComponent(chat)}${before ? `&before=${before}` : ''}`),
  clearMessages: (chat = 'main') => req<{ ok: true }>('DELETE', `/api/messages?chat=${encodeURIComponent(chat)}`),
  chat: (text: string, chat = 'main') => req<ChatResult>('POST', '/api/chat', { text, chat }),
  devices: () => req<{ devices: Device[] }>('GET', '/api/devices'),
  revoke: (id: number) => req<{ ok: true }>('DELETE', `/api/devices/${id}`),
  quickKey: (folder?: string) => req<{ token: string; device: Device }>('POST', '/api/devices/quick', { folder }),
  newCode: () => req<{ code: string; expiresAt: number }>('POST', '/api/pairing/new'),
  syncPull: () => req<SyncStatus>('POST', '/api/sync/pull'),
  transcribe: (blob: Blob) => req<{ text: string }>('POST', '/api/transcribe', undefined, { data: blob, type: blob.type || 'audio/webm' }),
};

export interface SyncStatus {
  mode: 'none' | 'git';
  lastPull: number | null;
  lastPush: number | null;
  lastError: string | null;
  pending: boolean;
}

export interface ChatResult {
  text: string;
  sources: string[];
  actions: Action[];
  userMessageId: number;
  messageId: number;
}

/** WebSocket chat client with automatic reconnect. */
export class ChatSocket {
  private ws: WebSocket | null = null;
  private timer: number | null = null;
  private closed = false;
  onEvent: (e: Record<string, unknown>) => void = () => {};
  onState: (s: 'connecting' | 'open' | 'closed') => void = () => {};

  connect(): void {
    this.closed = false;
    const token = getToken();
    if (!token) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.onState('connecting');
    const ws = new WebSocket(`${proto}://${location.host}/api/ws?token=${encodeURIComponent(token)}`);
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
