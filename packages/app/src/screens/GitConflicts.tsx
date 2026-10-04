import {useEffect,useState} from 'react';
import {api,ApiError} from '../api';
export function GitConflicts({onUnauthorized}:{onUnauthorized:()=>void}){
  const [list,setList]=useState<{paths:string[];mergePaths:string[]}>({paths:[],mergePaths:[]}),[document,setDocument]=useState<Awaited<ReturnType<typeof api.conflict>>|null>(null),[text,setText]=useState(''),[remove,setRemove]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const fail=(e:unknown)=>{setError((e as Error).message);if(e instanceof ApiError&&e.status===401)onUnauthorized();};
  const refresh=()=>api.conflicts().then(setList).catch(fail);
  useEffect(()=>{void refresh();},[]);
  const open=async(path:string)=>{try{const d=await api.conflict(path);setDocument(d);setText(d.content??'');setRemove(false);setError('');}catch(e){fail(e);}};
  const save=async()=>{if(!document)return;setBusy(true);try{await api.resolveConflict(document.path,document.contentHash,remove?null:text,crypto.randomUUID());setDocument(null);await refresh();}catch(e){fail(e);}finally{setBusy(false);}};
  const complete=async()=>{if(!window.confirm('Создать commit слияния для этих файлов?\n'+list.mergePaths.join('\n')))return;setBusy(true);try{await api.completeMerge(list.mergePaths);await refresh();}catch(e){fail(e);}finally{setBusy(false);}};
  return <div className="card"><h3>Конфликты Git</h3>{error&&<p role="alert" className="error">{error}</p>}<button className="btn secondary small" disabled={busy} onClick={()=>void refresh()}>Проверить конфликты</button>{!list.paths.length&&!list.mergePaths.length&&<p className="muted">Конфликтов нет</p>}{list.paths.map(p=><button className="drawer-link" key={p} disabled={busy} onClick={()=>void open(p)}>{p}</button>)}
    {document&&<><strong>{document.path}</strong><div className="diff-columns"><details><summary>Версия сервера</summary><pre>{document.ours??'Файл удалён'}</pre></details><details><summary>Удалённая версия</summary><pre>{document.theirs??'Файл удалён'}</pre></details></div><details><summary>Общий предок</summary><pre>{document.base??'Нет'}</pre></details><label className="field">Итоговая версия<textarea rows={14} value={text} disabled={busy||remove} onChange={e=>setText(e.target.value)}/></label><label><input type="checkbox" checked={remove} disabled={busy} onChange={e=>setRemove(e.target.checked)}/>Удалить этот файл при слиянии</label><div className="button-row"><button className="btn" disabled={busy} onClick={()=>void save()}>Сохранить разрешение</button><button className="btn secondary" disabled={busy} onClick={()=>setDocument(null)}>Закрыть</button></div></>}
    {!list.paths.length&&list.mergePaths.length>0&&<><p>Файлы для commit слияния:</p><ul>{list.mergePaths.map(p=><li key={p}>{p}</li>)}</ul><button className="btn" disabled={busy} onClick={()=>void complete()}>Завершить слияние</button></>}
  </div>;
}
