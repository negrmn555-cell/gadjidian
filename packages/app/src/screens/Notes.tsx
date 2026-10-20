import { useEffect, useRef, useState } from 'react';
import { categoryLabels, type NoteCreateInput, type NoteRecord, type NotePage } from '@relay/core/contracts';
import { api, ApiError } from '../api';
import { Icon } from '../Icons';
import { Markdown } from '../Markdown';
import { NoteGraph } from './NoteGraph';
const blank:NoteCreateInput={title:'',body:'',kind:'quick',category:'personal',tags:[],keywords:[],aliases:[],person:{phone:'',email:'',role:''}};
const labels={quick:'Заметка',idea:'Идея',person:'Человек'};
function fields(n:NoteRecord):NoteCreateInput {return {title:n.title,body:n.body,kind:n.kind,category:n.category,tags:n.tags,keywords:n.keywords,aliases:n.aliases,person:n.person};}
function list(value:string):string[]{return value.split(',').map(x=>x.trim()).filter(Boolean);}
export function NoteEditor({path,onClose,onSaved,onUnauthorized}:{path:string|null;onClose:()=>void;onSaved?:()=>void;onUnauthorized:()=>void}){
  const [note,setNote]=useState<NoteRecord|null>(null),[form,setForm]=useState(blank),[raw,setRaw]=useState(''),[rawMode,setRawMode]=useState(false);
  const [loading,setLoading]=useState(!!path),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[latest,setLatest]=useState<NoteRecord|null>(null),[preview,setPreview]=useState(false),[dirty,setDirty]=useState(false);
  const request=useRef<{body:string;id:string}|null>(null);
  const [tagsText,setTagsText]=useState(''),[keywordsText,setKeywordsText]=useState(''),[aliasesText,setAliasesText]=useState('');
  const adopt=(n:NoteRecord)=>{setNote(n);setForm(fields(n));setRaw(n.content);setTagsText(n.tags.join(', '));setKeywordsText(n.keywords.join(', '));setAliasesText(n.aliases.join(', '));setLatest(null);setDirty(false);request.current=null;};
  useEffect(()=>{let stale=false;if(path)api.note(path).then(n=>{if(!stale)adopt(n);}).catch(e=>{if(!stale){setError(e.message);if(e instanceof ApiError&&e.status===401)onUnauthorized();}}).finally(()=>{if(!stale)setLoading(false);});return()=>{stale=true;};},[path]);
  const save=async(e:React.FormEvent)=>{
    e.preventDefault();if(busy||loading)return;setBusy(true);setError('');setNotice('');
    const edit=rawMode?{content:raw}:{fields:form};const body=JSON.stringify({path:note?.path,hash:note?.contentHash,edit});if(request.current?.body!==body)request.current={body,id:crypto.randomUUID()};
    try{const r=note?await api.editNote(note.path,edit,note.contentHash,request.current.id):await api.createNote(form,request.current.id);adopt(r.note);setNotice(r.receipt.state==='synced'?'Сохранено и отправлено в Git.':r.receipt.state==='committed'?'Сохранено в Git на сервере.':'Сохранено на сервере.');onSaved?.();}
    catch(err){setError((err as Error).message);if(err instanceof ApiError&&err.status===401)onUnauthorized();if(err instanceof ApiError&&err.status===409&&note)try{setLatest(await api.note(note.path));}catch{}}
    finally{setBusy(false);}
  };
  const close=()=>{if(busy)return;if(dirty&&!window.confirm('Закрыть редактор без сохранения черновика?'))return;onClose();};
  const assetId=note?.content.match(/^asset_id:\s*"?(asset_[a-f0-9]{64})/m)?.[1];
  return <section className="note-editor" aria-label={path?'Редактирование заметки':'Новая заметка'}>
    <div className="editor-heading"><h2>{note?labels[note.kind]:'Новая заметка'}</h2><button className="icon-btn" disabled={busy} aria-label="Закрыть редактор" onClick={close}><Icon name="close"/></button></div>
    {note&&<p className="muted note-path">{note.path}</p>}
    {error&&<div className="error" role="alert">{error}</div>}{notice&&<p className="notice" role="status">{notice}</p>}
    {latest&&<div className="card conflict-panel"><strong>Заметка изменилась. Ваш текст остаётся в форме.</strong><details><summary>Актуальная версия</summary><pre>{latest.content}</pre></details><button type="button" className="btn secondary small" onClick={()=>{if(window.confirm('Заменить черновик актуальной версией?'))adopt(latest);}}>Загрузить актуальную версию</button><button type="button" className="btn secondary small" onClick={()=>{setNote(latest);setLatest(null);setError('Сравните версии и сохраните объединённый текст.');request.current=null;}}>Я сравнил версии, сохранить мой текст поверх актуальной</button></div>}
    {loading?<p role="status">Загружаю заметку…</p>:<form onSubmit={save} onChange={()=>setDirty(true)}><fieldset disabled={busy||!!path&&!note}>
      {note&&<div className="task-toolbar"><button type="button" className="btn secondary small" disabled={dirty} onClick={()=>{setRawMode(!rawMode);setPreview(false);}}>{rawMode?'Поля заметки':'Исходник Markdown'}</button><button type="button" className="btn secondary small" onClick={()=>setPreview(!preview)}>{preview?'Редактор':'Предпросмотр'}</button>{assetId&&<button type="button" className="btn secondary small" onClick={()=>void api.downloadOriginal(assetId).catch(e=>setError(e.message))}>Скачать оригинал</button>}</div>}
      {preview?<div className="card note-preview"><Markdown text={rawMode?raw:form.body}/></div>:rawMode?<label>Полный исходник (Markdown и YAML)<textarea className="field source-editor" rows={18} maxLength={1100000} value={raw} onChange={e=>setRaw(e.target.value)}/></label>:<>
        <label>Название<input className="field" required maxLength={200} value={form.title} onChange={e=>setForm({...form,title:e.target.value})}/></label>
        <div className="note-field-row"><label>Тип<select className="field" value={form.kind} onChange={e=>setForm({...form,kind:e.target.value as typeof form.kind})}>{Object.entries(labels).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select></label><label>Категория<select className="field" value={form.category} onChange={e=>setForm({...form,category:e.target.value as typeof form.category})}>{Object.entries(categoryLabels).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select></label></div>
        {form.kind==='person'&&<><label>Другие имена (через запятую)<input className="field" value={aliasesText} onChange={e=>{setAliasesText(e.target.value);setForm({...form,aliases:list(e.target.value)});}}/></label>{(['phone','email','role'] as const).map(k=><label key={k}>{{phone:'Телефон',email:'Email',role:'Роль / должность'}[k]}<input className="field" maxLength={300} value={form.person[k]} onChange={e=>setForm({...form,person:{...form.person,[k]:e.target.value}})}/></label>)}</>}
        <label>Текст (Markdown)<textarea className="field" required rows={12} maxLength={1000000} value={form.body} onChange={e=>setForm({...form,body:e.target.value})}/></label>
        <label>Метки (через запятую)<input className="field" value={tagsText} onChange={e=>{setTagsText(e.target.value);setForm({...form,tags:list(e.target.value)});}}/></label>
        <label>Ключевые слова (пусто — определить из текста)<input className="field" value={keywordsText} onChange={e=>{setKeywordsText(e.target.value);setForm({...form,keywords:list(e.target.value)});}}/></label>
      </>}
      <button className="btn" disabled={busy||!!latest}>{busy?'Сохраняю…':note?'Сохранить изменения':'Создать заметку'}</button>
    </fieldset></form>}
  </section>;
}
export function Notes({onBack,onUnauthorized,startNew=false,active=true}:{onBack:()=>void;onUnauthorized:()=>void;startNew?:boolean;active?:boolean}){
  const [view,setView]=useState<'list'|'graph'>('graph');
  useEffect(()=>{if(active)setView('graph');},[active]);
  const [page,setPage]=useState<NotePage>({items:[],invalidRecords:[]}),[q,setQ]=useState(''),[kind,setKind]=useState('all'),[editor,setEditor]=useState<string|null|undefined>(startNew?null:undefined),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const generation=useRef(0);
  const reload=async()=>{const current=++generation.current;setLoading(true);try{const result=await api.notes(q);if(current===generation.current){setPage(result);setError('');}}catch(e){if(current===generation.current)setError((e as Error).message);if(e instanceof ApiError&&e.status===401)onUnauthorized();}finally{if(current===generation.current)setLoading(false);}};
  useEffect(()=>()=>{generation.current++;},[]);
  useEffect(()=>{const timer=setTimeout(()=>void reload(),250);return()=>clearTimeout(timer);},[q]);
  return <div className="screen"><div className="tasks-content notes-content">{editor!==undefined?<NoteEditor key={editor??'new'} path={editor} onClose={()=>setEditor(undefined)} onSaved={()=>void reload()} onUnauthorized={onUnauthorized}/>:<>
    <div className="editor-heading"><h2>Заметки</h2><div className="view-tabs" role="group" aria-label="Вид заметок"><button aria-pressed={view==='graph'} onClick={()=>setView('graph')}>Граф</button><button aria-pressed={view==='list'} onClick={()=>setView('list')}>Список</button></div></div>
    {view==='graph'?<NoteGraph onUnauthorized={onUnauthorized} active={active}/>:<>
    <div className="task-toolbar"><button className="btn small" onClick={()=>setEditor(null)}>Добавить заметку</button><button className="btn secondary small" disabled={loading} onClick={()=>void reload()}>Обновить</button></div>
    <label>Поиск<input className="field" placeholder="Название, имя, метка…" value={q} onChange={e=>setQ(e.target.value)}/></label><label>Тип<select className="field" value={kind} onChange={e=>setKind(e.target.value)}><option value="all">Все</option>{Object.entries(labels).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select></label>
    {error&&<p className="error" role="alert">{error}</p>}{loading&&<p role="status">Загружаю…</p>}
    {!loading&&!page.items.length&&<p className="muted">Здесь появятся заметки и карточки людей из Obsidian.</p>}
    {page.items.filter(n=>kind==='all'||n.kind===kind).map(n=><button className="card note-choice" key={n.path} onClick={()=>setEditor(n.path)}><strong>{n.title}</strong><span>{labels[n.kind]} · {categoryLabels[n.category]}</span><small>{n.path}</small></button>)}
    {!!page.invalidRecords.length&&<details className="card"><summary>Не удалось прочитать {page.invalidRecords.length} заметок</summary>{page.invalidRecords.map(n=><p key={n.path}>{n.path}: {n.error}</p>)}</details>}
  </>}
  </>}</div></div>;
}
