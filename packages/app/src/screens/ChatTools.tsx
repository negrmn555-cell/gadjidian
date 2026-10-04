import { useEffect, useRef, useState, type ReactNode } from 'react';
import { categoryLabels, type Attachment, type ChatMemory, type ImportResult } from '@relay/core/contracts';
import { api, ApiError } from '../api';
import { Icon } from '../Icons';
export function EditorOverlay({label,children}:{label:string;children:ReactNode}){
  const ref=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null,dialog=ref.current;
    const hiddenSiblings=new Map<Element,boolean>();
    let branch:Element|null=dialog?.parentElement??null;
    while(branch?.parentElement&&branch.parentElement!==document.body){
      for(const sibling of branch.parentElement.children)if(sibling!==branch){hiddenSiblings.set(sibling,sibling.hasAttribute('inert'));sibling.setAttribute('inert','');}
      branch=branch.parentElement;
    }
    (dialog?.querySelector<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)')??dialog)?.focus();
    const key=(e:KeyboardEvent)=>{
      if(!dialog)return;
      if(e.key==='Escape'){e.preventDefault();dialog.querySelector<HTMLButtonElement>('button[aria-label^="Закрыть"]')?.click();}
      if(e.key==='Tab'){const items=Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]')).filter(x=>x.getClientRects().length>0);const first=items[0],last=items.at(-1);if(!items.includes(document.activeElement as HTMLElement)){e.preventDefault();(e.shiftKey?last:first)?.focus();}else if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
    };
    document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);for(const [sibling,wasInert] of hiddenSiblings)if(!wasInert)sibling.removeAttribute('inert');previous?.focus();};
  },[label]);
  return <div className="editor-overlay" role="dialog" aria-modal="true" aria-label={label}><div ref={ref} tabIndex={-1} className="editor-dialog">{children}</div></div>;
}
export function ImportDialog({file,chatId,onClose,onImported,onUnauthorized}:{file:Attachment;chatId:string;onClose:()=>void;onImported:(result:ImportResult)=>void;onUnauthorized:()=>void}){
  const [title,setTitle]=useState(file.name.replace(/\.[^.]+$/,'')),[category,setCategory]=useState('personal'),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const request=useRef<{body:string;id:string}|null>(null);
  const submit=async(e:React.FormEvent)=>{e.preventDefault();if(busy)return;setBusy(true);setError('');const note={title,category},body=JSON.stringify(note);if(request.current?.body!==body)request.current={body,id:crypto.randomUUID()};
    try{onImported(await api.importFile(chatId,file.id,note,request.current.id));}catch(err){setError((err as Error).message);if(err instanceof ApiError&&err.status===401)onUnauthorized();}finally{setBusy(false);}
  };
  return <section className="note-editor"><div className="editor-heading"><h2>Полностью в заметку</h2><button className="icon-btn" aria-label="Закрыть импорт" disabled={busy} onClick={onClose}><Icon name="close"/></button></div>
    <p className="note-path">{file.name}</p><p className="muted">Оригинал, извлечённый текст и отчёт об обработке будут сохранены в Obsidian. Они сохранятся после удаления чата.</p>
    {file.extraction?.status==='partial'&&<p className="notice">Распознавание частичное. Пропуски будут перечислены в заметке.</p>}
    {error&&<p className="error" role="alert">{error}</p>}<form onSubmit={submit}><fieldset disabled={busy}><label>Название заметки<input className="field" required maxLength={200} value={title} onChange={e=>setTitle(e.target.value)}/></label><label>Категория<select className="field" value={category} onChange={e=>setCategory(e.target.value)}>{Object.entries(categoryLabels).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select></label><button className="btn">{busy?'Сохраняю оригинал и текст…':'Перенести полностью'}</button></fieldset></form>
  </section>;
}
const states={current:'Актуальна',changed:'Изменена — нужно перечитать',missing:'Удалена или недоступна',renamed:'Перемещена'};
export function MemoryDialog({chatId,onClose,onOpenNote,onUnauthorized}:{chatId:string;onClose:()=>void;onOpenNote:(path:string)=>void;onUnauthorized:()=>void}){
  const [memory,setMemory]=useState<ChatMemory|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState('');
  const report=(e:unknown)=>{setError((e as Error).message);if(e instanceof ApiError&&e.status===401)onUnauthorized();};
  useEffect(()=>{let stale=false;api.memory(chatId).then(m=>{if(!stale)setMemory(m);}).catch(e=>{if(!stale)report(e);}).finally(()=>{if(!stale)setBusy(false);});return()=>{stale=true;};},[chatId]);
  const update=async()=>{setBusy(true);setError('');try{setMemory(await api.summarize(chatId));}catch(e){report(e);}finally{setBusy(false);}};
  return <section className="note-editor"><div className="editor-heading"><h2>Память этого чата</h2><button className="icon-btn" aria-label="Закрыть память" disabled={busy} onClick={onClose}><Icon name="close"/></button></div><p className="muted">Резюме и ссылки помогают продолжить разговор. Изменённые заметки проверяются заново. Память удаляется вместе с историей через 14 дней.</p>
    {error&&<p className="error" role="alert">{error}</p>}{busy&&<p role="status">Проверяю память…</p>}
    {memory&&<><h3>Краткое резюме</h3><p className="memory-summary">{memory.summary||'Резюме пока нет или его нужно пересобрать после изменения источников.'}</p><p className="muted">Обобщено реплик: {memory.coverage.length}</p><h3>Связанные заметки</h3>{memory.sources.map(s=><button key={s.noteId??s.path} className="card note-choice" disabled={s.state==='missing'||s.noteId?.startsWith('task_')} onClick={()=>onOpenNote(s.path)}><strong>{s.path.replace(/\.md$/,'')}</strong><small>{states[s.state]}</small></button>)}{!memory.sources.length&&<p className="muted">ИИ ещё не обращался к заметкам в этом чате.</p>}</>}
    <button className="btn" disabled={busy} onClick={()=>void update()}>Обновить резюме</button>
  </section>;
}
