import { useEffect, useState } from 'react';
import { api, type Device, type SyncStatus } from '../api';
import { ProviderSettings } from './ProviderSettings';
import { Icon } from '../Icons';
import { AutomationSettings,Notifications } from './AutomationSettings';
import { GitConflicts } from './GitConflicts';
import { AgentIntegrations } from './AgentIntegrations';
import { CompletedEventsSettings } from './CompletedEventsSettings';

export function Settings({ onBack, onLogout, chatId }: { onBack: () => void; onLogout: () => void; chatId?:string }) {
  const [me, setMe] = useState<Awaited<ReturnType<typeof api.me>> | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [quickKey, setQuickKey] = useState<string | null>(null);
  const [quickFolder, setQuickFolder] = useState('');
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [err, setErr] = useState('');

  const reload = () => {
    api.me().then((m) => {
      setMe(m);
      setSync(m.sync);
    }).catch((e) => setErr(String(e.message)));
    api.devices().then((d) => setDevices(d.devices)).catch(() => {});
  };
  useEffect(reload, []);

  const fmt = (t: number | null) => (t ? new Date(t).toLocaleString('ru-RU') : '—');

  return (
    <div className="screen">
      <div className="header">
        <button className="icon-btn" onClick={onBack} aria-label="Назад">
          <Icon name="back" />
        </button>
        <span className="title">Настройки</span>
      </div>
      <div className="settings">
        {err && <div className="error">{err}</div>}
        <ProviderSettings onUnauthorized={onLogout} />
        <CompletedEventsSettings onUnauthorized={onLogout} />
        <AutomationSettings onUnauthorized={onLogout}/>
        <Notifications onUnauthorized={onLogout}/>
        <GitConflicts onUnauthorized={onLogout}/>
        <AgentIntegrations onUnauthorized={onLogout}/>

        <div className="card">
          <h3>Связь</h3>
          <div className="row">
            <span className="muted">Входящие</span>
            <span>{me?.vault.inbox || '/'}</span>
          </div>
          <div className="row">
            <span className="muted">Ежедневные</span>
            <span>{me?.vault.daily || '/'}</span>
          </div>
          <div className="row">
            <span className="muted">Синхронизация</span>
            <span>{sync?.mode === 'git' ? 'git' : 'только сервер'}</span>
          </div>
          {sync?.mode === 'git' && (
            <>
              <div className="row">
                <span className="muted">Последний pull</span>
                <span>{fmt(sync.lastPull)}</span>
              </div>
              <div className="row">
                <span className="muted">Последний push</span>
                <span>{fmt(sync.lastPush)}{sync.pending ? ' (ожидает)' : ''}</span>
              </div>
              {sync.lastError && <div className="error">{sync.lastError}</div>}
              <button
                className="btn secondary small"
                onClick={() => api.syncPull().then(setSync).catch((e) => setErr(e.message))}
              >
                Проверить связь / обновить
              </button>
            </>
          )}
        </div>

        <div className="card">
          <h3>Подключённые устройства</h3>
          {devices.map((d) => (
            <div className="row" key={d.id}>
              <div>
                <div>
                  {d.kind === 'quick' ? '⚡ ' : '📱 '}
                  {d.name}
                  {me?.device.id === d.id ? ' (это устройство)' : ''}
                </div>
                <div className="muted">был на связи: {fmt(d.lastSeen)}{d.folder ? ` · папка ${d.folder}` : ''}</div>
              </div>
              <button
                className="btn danger small"
                onClick={() => {
                  if (!confirm(`Отключить «${d.name}»?`)) return;
                  api.revoke(d.id).then(() => (me?.device.id === d.id ? onLogout() : reload()));
                }}
              >
                Отключить
              </button>
            </div>
          ))}
          <div style={{ marginTop: 10 }}>
            <button className="btn secondary small" onClick={() => api.newCode().then(setCode).catch((e) => setErr(e.message))}>
              Код для нового устройства
            </button>
            {code && (
              <div style={{ marginTop: 10 }}>
                <div className="code-big">{code.code}</div>
                <div className="muted" style={{ textAlign: 'center', marginTop: 4 }}>
                  действует до {new Date(code.expiresAt).toLocaleTimeString('ru-RU')}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <h3>Быстрая запись (кнопка / виджет)</h3>
          <p className="muted">
            Отдельный ключ, который умеет только создавать заметку. Вставьте его в «Команды» на iPhone или HTTP Shortcuts на Android:
            POST <code>{location.origin}/api/send</code> с JSON <code>{'{"token","text","chat":"quick"}'}</code>.
          </p>
          <input className="field" placeholder="папка (пусто — во входящие)" value={quickFolder} onChange={(e) => setQuickFolder(e.target.value)} />
          <button className="btn secondary small" onClick={() => api.quickKey(quickFolder || undefined).then((r) => { setQuickKey(r.token); reload(); }).catch((e) => setErr(e.message))}>
            Создать ключ
          </button>
          {quickKey && (
            <div style={{ marginTop: 10 }}>
              <div className="mono">{quickKey}</div>
              <div className="muted">Показывается один раз. Скопируйте сейчас.</div>
              <button className="btn secondary small" style={{ marginTop: 6 }} onClick={() => navigator.clipboard?.writeText(quickKey)}>
                Копировать
              </button>
            </div>
          )}
        </div>

        <div className="card">
          <h3>Это устройство</h3>
          <button className="btn secondary small" disabled={!chatId} onClick={() => { if(chatId && confirm('Очистить сообщения и временные файлы текущего чата?'))void api.clearMessages(chatId).then(onBack).catch(e=>setErr(e.message)); }}>
            Очистить текущий чат
          </button>{' '}
          <button className="btn danger small" onClick={() => { if (confirm('Выйти на этом устройстве?')) onLogout(); }}>
            Выйти
          </button>
        </div>
      </div>
    </div>
  );
}
