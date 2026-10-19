import { useState } from 'react';
import { api } from '../api';

export function Connect({ onConnected }: { onConnected: (token: string) => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState(defaultName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api.pair(code, name);
      onConnected(res.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка подключения');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <form className="center" onSubmit={submit}>
        <h1>Подключение к gadjidian</h1>
        <p className="muted">
          Введите код подключения, который выдал сервер (серверная консоль или экран «Настройки» на уже подключённом телефоне).
          Код одноразовый — после входа телефон получит собственный ключ.
        </p>
        <input
          className="field"
          placeholder="код подключения"
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: '0.1em', textAlign: 'center', fontSize: 20 }}
        />
        <input className="field" placeholder="название устройства" value={name} onChange={(e) => setName(e.target.value)} />
        {error && <div className="error">{error}</div>}
        <button className="btn block" disabled={busy || code.replace(/[^A-Z0-9]/g, '').length < 12}>
          {busy ? 'Подключаю…' : 'Подключиться'}
        </button>
      </form>
    </div>
  );
}

function defaultName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  return 'Браузер';
}
