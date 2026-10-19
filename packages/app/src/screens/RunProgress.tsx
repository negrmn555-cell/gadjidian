import type { ToolProgress, MutationReceipt } from '@relay/core/contracts';
const labels={running:'Выполняется',succeeded:'Готово',failed:'Ошибка',cancelled:'Отменено'};
const isTask=(path:string)=>/^Areas\/[^/]+\/Tasks\//i.test(path);
const saved={saved_local:'Сохранено локально',committed:'Сохранено в Git',synced:'Отправлено в Git',conflict:'Конфликт Git'};
export function SourceList({sources,onOpen}:{sources:{path:string;heading?:string}[];onOpen:(path:string)=>void}){
  return sources.length?<ul className="run-sources" aria-label="Найденные источники">{sources.map((s,i)=><li key={s.path+i}><button className="wiki-link" disabled={isTask(s.path)} onClick={()=>onOpen(s.path)}>{s.path}{s.heading?' · '+s.heading:''}</button></li>)}</ul>:null;
}
export function ToolCallCard({tool,onOpen}:{tool:ToolProgress;onOpen:(path:string)=>void}){
  return <details className={'tool-call tool-'+tool.state} open={tool.state==='running'}><summary><span>{tool.label}</span><small>{labels[tool.state]}{tool.durationMs!==undefined?' · '+(tool.durationMs/1000).toFixed(1)+' с':''}</small></summary><div>{tool.summary&&<p>{tool.summary}</p>}<SourceList sources={tool.sources} onOpen={onOpen}/>{tool.receipt&&<p className="tool-receipt">{saved[tool.receipt.state]} · <button className="wiki-link" disabled={isTask(tool.receipt.path)} onClick={()=>onOpen(tool.receipt!.path)}>{tool.receipt.path}</button></p>}</div></details>;
}
export function RunProgress({tools,onOpen,pending=false}:{tools:ToolProgress[];onOpen:(path:string)=>void;pending?:boolean}){
  return tools.length?<section className="run-progress" aria-label="Ход работы" aria-busy={pending}><span className="sr-only" role="status">{pending?'Ассистент выполняет действия':'Работа завершена'}</span>{tools.map(tool=><ToolCallCard key={tool.id} tool={tool} onOpen={onOpen}/>)}</section>:null;
}
export function SavedArtifacts({receipts,onOpen}:{receipts:MutationReceipt[];onOpen:(path:string)=>void}){return receipts.length?<ul className="saved-artifacts" aria-label="Подтверждённые записи">{receipts.map((r,i)=><li key={r.operationId+i}><button className="wiki-link" disabled={isTask(r.path)} onClick={()=>onOpen(r.path)}>{r.path}</button><small> · {saved[r.state]}</small></li>)}</ul>:null;}
export function PartialResult({outcome,actions,receipts,onOpen}:{outcome?:string;actions:{path:string;label:string}[];receipts:MutationReceipt[];onOpen:(path:string)=>void}){
  return outcome==='partial'?<aside className="partial-result" role="status"><strong>Выполнена часть запроса</strong><p>Сохранённые изменения остаются в хранилище. Проверьте их; новый запрос должен касаться только незавершённой части.</p><ul>{actions.map((a,i)=><li key={a.path+i}><button className="wiki-link" disabled={isTask(a.path)} onClick={()=>onOpen(a.path)}>{a.label} · {a.path}</button>{receipts.find(r=>r.path===a.path)&&<small> · {saved[receipts.find(r=>r.path===a.path)!.state]}</small>}</li>)}</ul></aside>:null;
}
