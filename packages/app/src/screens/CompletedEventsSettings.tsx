import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';

export function CompletedEventsSettings({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.completedEvents>> | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const report = (cause: unknown) => { setError((cause as Error).message); if(cause instanceof ApiError && cause.status===401)onUnauthorized(); };
  const reload = () => api.completedEvents().then(setStatus).catch(report);
  useEffect(() => { void reload(); }, []);
  return <section className="card"><h3>Прошедшие события</h3><p className="muted">Выполненные задачи остаются в записях 14 дней. Затем отдельный ИИ-сортировщик создаёт сводки для базы Obsidian «прошедшие события», а исходники переносятся в архив. Проверка выполняется каждый час.</p>
    {status && <><p>{status.eligible} задач ожидают обработки.</p>{!status.providerConfigured && <p className="notice">Настройте и включите отдельную модель сортировщика выше. До успешной обработки исходники остаются на месте.</p>}{status.lastJob && <p className="muted">Последняя обработка: {{queued:'в очереди',running:'выполняется',succeeded:'завершена',failed:'ошибка — исходники сохранены',cancelled:'отменена',unknown:'требует проверки'}[status.lastJob.state]}</p>}</>}
    {error && <p className="error" role="alert">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}<div className="task-toolbar"><button className="btn secondary small" disabled={busy} onClick={()=>void reload()}>Обновить состояние</button><button className="btn small" disabled={busy || !status?.providerConfigured || !status.eligible} onClick={async()=>{setBusy(true);setError('');try{await api.processCompleted();setNotice('Обработка поставлена в очередь.');await reload();}catch(cause){report(cause);}finally{setBusy(false);}}}>Обработать сейчас</button></div>
  </section>;
}
