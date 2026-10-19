import { useEffect, useRef, useState } from 'react';
import type { ProviderPage, ProviderPublic, ProviderSlot, ProviderTestResult, ProviderWrite } from '@relay/core/contracts';
import { api, ApiError } from '../api';

interface Editor { id: string | null; slot: ProviderSlot; adapter:ProviderWrite['adapter']; version?: number; name: string; baseUrl: string; modelId: string; canonicalModelId: string;
  enabled: boolean; toolCalls: boolean; structuredOutput: boolean; vision: boolean; nativePdf?:boolean;pdfMaxPages?:number; secretAction: 'keep' | 'replace' | 'remove'; apiKey: string }
function fresh(slot: ProviderSlot): Editor { return { id: null, slot, adapter:'openai_compatible', name: '', baseUrl: 'https://api.openai.com/v1', modelId: '', canonicalModelId: '', enabled: true,
  toolCalls: slot === 'chat', structuredOutput: slot === 'organizer', vision: false,nativePdf:false,pdfMaxPages:3, secretAction: 'replace', apiKey: '' }; }

export function ProviderSettings({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [page, setPage] = useState<ProviderPage | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Record<string, ProviderTestResult>>({});
  const editorRef = useRef<HTMLFormElement>(null);
  const report = (e: unknown) => { setError((e as Error).message); if (e instanceof ApiError && e.status === 401) onUnauthorized(); };
  const reload = async () => { try { setPage(await api.providers()); } catch (e) { report(e); } };
  useEffect(() => { void reload(); }, []);
  useEffect(() => { if (editor) { editorRef.current?.scrollIntoView({ block: 'start' }); editorRef.current?.querySelector<HTMLInputElement>('input')?.focus(); } }, [!!editor, editor?.id, editor?.slot]);
  const work = async (action: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { report(e); if (e instanceof ApiError && e.status === 409) await reload(); }
    finally { setBusy(false); }
  };
  const edit = (p: ProviderPublic) => { setError(''); setNotice(''); setEditor({ id: p.id, slot: p.slot, adapter:p.adapter, version: p.version, name: p.name, baseUrl: p.baseUrl, modelId: p.modelId,
    canonicalModelId: p.canonicalModelId ?? '', enabled: p.enabled, ...p.capabilities, secretAction: 'keep', apiKey: '' }); };
  const save = (e: React.FormEvent) => {
    e.preventDefault(); if (!editor) return;
    const f = editor;
    const body: ProviderWrite = { name: f.name, adapter: f.adapter, baseUrl: f.baseUrl, modelId: f.modelId, canonicalModelId: f.canonicalModelId || null,
      enabled: f.enabled, capabilities: { toolCalls: f.toolCalls, vision: f.vision, structuredOutput: f.structuredOutput,nativePdf:f.nativePdf??false,pdfMaxPages:f.pdfMaxPages??3,pdfMaxBytes:5*1024*1024 }, expectedVersion: f.version,
      secretUpdate: f.secretAction === 'replace' ? { action: 'replace', apiKey: f.apiKey } : { action: f.secretAction } };
    void work(async () => {
      const saved = f.id ? await api.updateProvider(f.id, body) : await api.createProvider(f.slot, body);
      setEditor(null); setResults(rs => { const next = { ...rs }; delete next[saved.id]; return next; });
      await reload(); setNotice('Профиль сохранён.');
    });
  };
  const card = (p: ProviderPublic) => <div className="provider-item" key={p.id}>
    <div className="provider-summary"><div><strong>{p.name}</strong><p className="muted">{p.modelId}</p></div>
      <span className={'chip ' + (p.id === page?.defaultChatProviderId ? 'selected-chip' : '')}>{p.id === page?.defaultChatProviderId ? 'Основной' : p.enabled ? 'Включён' : 'Выключен'}</span></div>
    <p className="provider-url muted">{p.baseUrl}</p><p className="muted">Ключ: {p.hasSecret ? 'сохранён' : 'не задан'}</p>
    <div className="task-toolbar">
      {p.slot === 'chat' && p.enabled && p.id !== page?.defaultChatProviderId && <button className="btn small" disabled={busy} onClick={() => void work(async () => setPage(await api.selectProvider(p)))}>Выбрать</button>}
      {p.id === page?.defaultChatProviderId && <button className="btn secondary small" disabled={busy} onClick={() => void work(async () => setPage(await api.selectProvider(null)))}>Снять выбор</button>}
      <button className="btn secondary small" disabled={busy} onClick={() => edit(p)}>Изменить</button>
      <button className="btn secondary small" disabled={busy || !p.enabled} onClick={() => void work(async () => {
        const result = await api.testProvider(p.id); setResults(rs => ({ ...rs, [p.id]: result }));
      })}>Проверить подключение</button>
      <button className="btn danger-outline small" disabled={busy} onClick={() => {
        if (confirm('Удалить профиль «' + p.name + '»?')) void work(async () => { await api.removeProvider(p.id, p.version); await reload(); });
      }}>Удалить</button>
    </div>
    {(results[p.id] ?? p.lastTest) && <p className={(results[p.id] ?? p.lastTest)!.availability === 'available' ? 'notice' : 'error'} role="status">{(results[p.id] ?? p.lastTest)!.message} <span className="muted">Версия {(results[p.id] ?? p.lastTest)!.version}.</span></p>}
  </div>;
  return <section className="card provider-settings" aria-label="ИИ-провайдеры">
    <h3>ИИ-провайдеры</h3><p className="muted">До пяти ИИ для чата и один отдельный сортировщик. OpenAI-совместимый API, Anthropic и Gemini.</p>
    {error && <p className="error" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    {!page && <p role="status" className="muted">Загружаю профили…</p>}
    {page && <>
      <div className="section-caption">Для чата <span>{page.items.filter(p => p.slot === 'chat').length} / 5</span></div>
      {page.items.filter(p => p.slot === 'chat').map(card)}
      <button className="btn secondary small" disabled={busy || page.items.filter(p => p.slot === 'chat').length >= 5} onClick={() => setEditor(fresh('chat'))}>Добавить ИИ для чата</button>
      <div className="section-caption">Сортировщик <span>{page.items.some(p => p.slot === 'organizer') ? '1' : '0'} / 1</span></div>
      {page.items.filter(p => p.slot === 'organizer').map(card)}
      {!page.items.some(p => p.slot === 'organizer') && <button className="btn secondary small" disabled={busy} onClick={() => setEditor(fresh('organizer'))}>Добавить сортировщик</button>}
      <p className={page.organizerSafety.status === 'same_model' ? 'error' : 'muted'}>{page.organizerSafety.message}</p>
    </>}
    {editor && <form ref={editorRef} className="provider-editor" onSubmit={save}>
      <h3>{editor.id ? 'Изменить профиль' : editor.slot === 'chat' ? 'Новый ИИ для чата' : 'Новый сортировщик'}</h3>
      <fieldset disabled={busy}>
        <label>Протокол API<select className="field" value={editor.adapter} onChange={e=>{const adapter=e.target.value as Editor['adapter'];setEditor({...editor,adapter,baseUrl:adapter==='anthropic'?'https://api.anthropic.com/v1':adapter==='gemini'?'https://generativelanguage.googleapis.com/v1beta':'https://api.openai.com/v1',canonicalModelId:'',apiKey:'',secretAction:'replace'});}}><option value="openai_compatible">OpenAI-совместимый</option><option value="anthropic">Anthropic Messages</option><option value="gemini">Gemini GenerateContent</option></select></label>
        <label>Название профиля<input className="field" required maxLength={80} value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })} /></label>
        <label>Адрес API<input className="field" type="url" required maxLength={1000} placeholder="https://api.openai.com/v1" value={editor.baseUrl} onChange={e => setEditor({ ...editor, baseUrl: e.target.value })} /></label>
        <label>Модель<input className="field" required maxLength={160} placeholder="Точный ID модели из вашего API" value={editor.modelId} onChange={e => setEditor({ ...editor, modelId: e.target.value, canonicalModelId: '' })} /></label>
        <label>Идентификатор модели для сравнения<input className="field" maxLength={200} placeholder="Например: openai/gpt-4o-mini" value={editor.canonicalModelId} onChange={e => setEditor({ ...editor, canonicalModelId: e.target.value })} /></label>
        <p className="muted">Для OpenAI и OpenRouter определяется автоматически. Для других API укажите один идентификатор для одной и той же модели.</p>
        <label>API-ключ<select className="field" value={editor.secretAction} onChange={e => setEditor({ ...editor, apiKey: '', secretAction: e.target.value as Editor['secretAction'] })}>
          {editor.id && <option value="keep">Оставить сохранённый</option>}<option value="replace">{editor.id ? 'Заменить ключ' : 'Добавить ключ'}</option><option value="remove">Без API-ключа</option>
        </select></label>
        {editor.secretAction === 'replace' && <label>Новый API-ключ<input className="field" type="password" required autoComplete="new-password" maxLength={4096} value={editor.apiKey} onChange={e => setEditor({ ...editor, apiKey: e.target.value })} /></label>}
        <p className="muted">Сохранённый ключ не показывается. При смене сервера API введите ключ заново.</p>
        <label className="check-label"><input type="checkbox" checked={editor.enabled} onChange={e => setEditor({ ...editor, enabled: e.target.checked })} />Профиль включён</label>
        <details><summary>Возможности модели</summary>
          <label className="check-label"><input type="checkbox" checked={editor.toolCalls} onChange={e => setEditor({ ...editor, toolCalls: e.target.checked })} />Вызов инструментов для работы с заметками</label>
          <label className="check-label"><input type="checkbox" checked={editor.structuredOutput} onChange={e => setEditor({ ...editor, structuredOutput: e.target.checked })} />Структурированный JSON</label>
          <label className="check-label"><input type="checkbox" checked={editor.nativePdf??false} onChange={e=>setEditor({...editor,nativePdf:e.target.checked})}/>Модель принимает PDF напрямую (отдельно от изображений)</label>
          {editor.nativePdf&&<label>Страниц PDF в одном пакете<input className="field" type="number" min={1} max={3} value={editor.pdfMaxPages??3} onChange={e=>setEditor({...editor,pdfMaxPages:Number(e.target.value)})}/></label>}
          <label className="check-label"><input type="checkbox" checked={editor.vision} onChange={e => setEditor({ ...editor, vision: e.target.checked })} />Изображения (проверяется тестом подключения)</label>
        </details>
        <div className="task-toolbar"><button className="btn" type="submit">{busy ? 'Сохраняю…' : 'Сохранить профиль'}</button><button className="btn secondary" type="button" onClick={() => setEditor(null)}>Отмена</button></div>
      </fieldset>
    </form>}
    <p className="muted probe-caption">«Проверить подключение» отправляет короткий служебный запрос к API и может расходовать его лимит. Ваши заметки и история в проверку не передаются.</p>
  </section>;
}
