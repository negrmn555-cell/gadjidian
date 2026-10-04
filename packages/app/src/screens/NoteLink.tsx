import {useEffect,useState} from 'react';
import {api} from '../api';
import {NoteEditor} from './Notes';
import {EditorOverlay} from './ChatTools';
export function NoteLink({target,from,onClose,onUnauthorized}:{target:string;from?:string;onClose:()=>void;onUnauthorized:()=>void}){
  const [paths,setPaths]=useState<string[]>([]),[selected,setSelected]=useState<string|null>(null),[error,setError]=useState('');
  useEffect(()=>{let stale=false;api.resolveNote(target,from).then(r=>{if(stale)return;setPaths(r.paths);if(r.paths.length===1)setSelected(r.paths[0]);if(!r.paths.length)setError('Заметка отсутствует или ссылка ведёт на вложение.');}).catch(e=>{if(!stale)setError(e.message);});return()=>{stale=true;};},[target,from]);
  return <EditorOverlay label="Связанная заметка">{selected?<NoteEditor path={selected} onClose={onClose} onUnauthorized={onUnauthorized}/>:<div className="card"><h3>{target}</h3>{error&&<p role="alert">{error}</p>}{paths.length>1&&<p>Найдено несколько заметок. Выберите нужную:</p>}{paths.map(p=><button className="drawer-link" key={p} onClick={()=>setSelected(p)}>{p}</button>)}<button className="btn secondary" onClick={onClose}>Закрыть</button></div>}</EditorOverlay>;
}
