import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NoteGraph as GraphData } from '@relay/core/contracts';
import { api, ApiError } from '../api';
import { Markdown } from '../Markdown';
import { Icon } from '../Icons';
import { makeNetwork, normalizeTag, tagHue, tick } from '../graph-physics';
import { EditorOverlay } from './ChatTools';
import { NoteEditor } from './Notes';

type Point = { x: number; y: number };
type Camera = Point & { k: number; width: number; height: number };
type Gesture = { type: 'pan' | 'node' | 'pinch'; start: Point; camera: Camera; node?: number; offset?: Point; distance?: number; moved: boolean };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const gradientHues = (hues:number[]) => hues.length===1 ? [hues[0],hues[0]] : hues;

export function NoteGraph({ onUnauthorized, active = true }: { onUnauthorized: () => void; active?: boolean }) {
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null), [editing, setEditing] = useState(false);
  const [note, setNote] = useState<{ path: string; title: string; body: string } | null>(null);
  const [reading, setReading] = useState(false), [readError, setReadError] = useState(''), [fullscreen, setFullscreen] = useState(false);
  const svg = useRef<SVGSVGElement>(null), scene = useRef<SVGGElement>(null), stage = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, SVGGElement>()), edges = useRef(new Map<number, SVGLineElement>()), stops = useRef(new Map<string, SVGStopElement>());
  const camera = useRef<Camera>({ x: 0, y: 0, k: 1, width: 1000, height: 660 });
  const fitted = useRef<unknown>(null), heat = useRef(300), gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, Point>()), tapped = useRef<{ at: number; point: Point } | null>(null);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null), request = useRef(0);
  const id = useId().replace(/:/g, ''), [focused, setFocused] = useState(0);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const entrance = useRef<{elapsed:number;seeds:number[]}>({elapsed:0,seeds:[]});
  const model = useMemo(() => { if (!graph) return null; const network = makeNetwork(graph); for (let i=0;i<140;i++) tick(network); return network; }, [graph]);
  const found = useMemo(() => new Set(graph?.nodes.filter(node => (node.title+' '+node.path+' '+(node.tags ?? []).join(' ')).toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(node => node.path)), [graph, query]);
  const neighbors = useMemo(() => new Set(graph?.edges.flatMap(edge => edge.source === selected ? [edge.target] : edge.target === selected ? [edge.source] : []) ?? []), [graph, selected]);
  const tags = useMemo(() => [...new Set(graph?.nodes.flatMap(node => (node.tags ?? []).map(normalizeTag)) ?? [])].sort(), [graph]);
  const reload = async () => {
    const generation=++request.current;setLoading(true);setError('');
    try { const next=await api.noteGraph();if(generation===request.current)setGraph(next); }
    catch(cause){if(generation===request.current)setError((cause as Error).message);if(cause instanceof ApiError&&cause.status===401)onUnauthorized();}
    finally{if(generation===request.current)setLoading(false);}
  };
  useEffect(()=>{if(active&&!graph)void reload();},[active]);
  useEffect(()=>()=>{request.current++;if(tapTimer.current)clearTimeout(tapTimer.current);},[]);
  useEffect(()=>{
    let stale=false;setNote(null);setReadError('');setReading(!!selected);setEditing(false);
    if(selected)api.graphDocument(selected).then(result=>{if(!stale)setNote(result);}).catch(cause=>{if(!stale)setReadError(cause.message);if(cause instanceof ApiError&&cause.status===401)onUnauthorized();}).finally(()=>{if(!stale)setReading(false);});
    return()=>{stale=true;};
  },[selected,graph]);
  useEffect(()=>{if(!active){if(tapTimer.current)clearTimeout(tapTimer.current);tapped.current=null;setFullscreen(false);setSelected(null);}},[active]);

  const paintCamera=()=>{const c=camera.current;scene.current?.setAttribute('transform',`translate(${c.x} ${c.y}) scale(${c.k})`);};
  const fit=()=>{
    if(!model?.particles.length)return;const xs=model.particles.map(n=>n.x),ys=model.particles.map(n=>n.y),c=camera.current;
    const left=Math.min(...xs)-32,right=Math.max(...xs)+32,top=Math.min(...ys)-32,bottom=Math.max(...ys)+32;
    c.k=clamp(Math.min((c.width-36)/(right-left),(c.height-110)/(bottom-top)),.08,1.6);c.x=c.width/2-(left+right)/2*c.k;c.y=c.height/2-(top+bottom)/2*c.k;paintCamera();
  };
  useEffect(()=>{
    const element=svg.current;if(!element||!model)return;
    const resize=()=>{const rect=element.getBoundingClientRect();if(!rect.width||!rect.height)return;const c=camera.current;c.x+=(rect.width-c.width)/2;c.y+=(rect.height-c.height)/2;c.width=rect.width;c.height=rect.height;element.setAttribute('viewBox',`0 0 ${c.width} ${c.height}`);if(fitted.current!==model){fitted.current=model;fit();}else paintCamera();};
    const observer=new ResizeObserver(resize);observer.observe(element);resize();
    const wheel=(event:WheelEvent)=>{event.preventDefault();const rect=element.getBoundingClientRect(),c=camera.current,p={x:event.clientX-rect.left,y:event.clientY-rect.top},k=clamp(c.k*Math.exp(-clamp(event.deltaY,-100,100)*.003),.08,5),ratio=k/c.k;c.x=p.x-(p.x-c.x)*ratio;c.y=p.y-(p.y-c.y)*ratio;c.k=k;paintCamera();};
    element.addEventListener('wheel',wheel,{passive:false});return()=>{observer.disconnect();element.removeEventListener('wheel',wheel);};
  },[model,fullscreen,active]);
  useEffect(()=>{if(active)entrance.current={elapsed:0,seeds:[]};},[active,model]);
  useEffect(()=>{
    if(!active||!model)return;let frame=0,previous=0;const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');if(!entrance.current.seeds.length)entrance.current.seeds=model.particles.map(()=>Math.random()*360);const starts=entrance.current.seeds;heat.current=300;
    const animate=(now:number)=>{
      if(globalThis.document.hidden){previous=0;frame=requestAnimationFrame(animate);return;}
      entrance.current.elapsed+=previous?Math.min(40,now-previous):16;const elapsed=entrance.current.elapsed;previous=now;const t=reduced.matches?1:clamp((elapsed-200)/1600,0,1),blend=t*t*(3-2*t);
      if(heat.current>0){const energy=tick(model);heat.current--;if(energy<.025&&!gesture.current)heat.current=0;}
      model.particles.forEach((node,i)=>{nodes.current.get(node.path)?.setAttribute('transform',`translate(${node.x} ${node.y})`);gradientHues(node.hues).forEach((hue,j)=>{const initial=(starts[i]+j*85)%360,delta=((hue-initial+540)%360)-180,drift=Math.sin(elapsed*.003+j)*28*(1-blend);stops.current.get(i+':'+j)?.setAttribute('stop-color',`hsl(${initial+delta*blend+drift} 75% 67%)`);});});
      model.links.forEach(([a,b],i)=>{const edge=edges.current.get(i);if(!edge)return;const p=model.particles[a],q=model.particles[b];edge.setAttribute('x1',String(p.x));edge.setAttribute('y1',String(p.y));edge.setAttribute('x2',String(q.x));edge.setAttribute('y2',String(q.y));});paintCamera();
      if(heat.current>0||elapsed<1900||gesture.current)frame=requestAnimationFrame(animate);
    };
    const wake=()=>{heat.current=200;cancelAnimationFrame(frame);previous=0;frame=requestAnimationFrame(animate);};
    const moveWake=()=>{if(gesture.current)wake();};
    const element=svg.current;element?.addEventListener('pointerdown',wake);element?.addEventListener('pointermove',moveWake);frame=requestAnimationFrame(animate);
    return()=>{cancelAnimationFrame(frame);element?.removeEventListener('pointerdown',wake);element?.removeEventListener('pointermove',moveWake);pointers.current.clear();gesture.current=null;model.particles.forEach(n=>{n.fixed=false;});};
  },[model,active,fullscreen]);
  useEffect(()=>{
    if(!fullscreen)return;const root=globalThis.document.getElementById('root'),already=root?.hasAttribute('inert');root?.setAttribute('inert','');(stage.current?.querySelector<HTMLElement>('button')??stage.current)?.focus();
    const key=(event:KeyboardEvent)=>{if(selectedRef.current)return;if(event.key==='Escape'){event.preventDefault();setFullscreen(false);}if(event.key==='Tab'){const items=Array.from(stage.current?.querySelectorAll<HTMLElement>('button:not(:disabled),[tabindex="0"]')??[]).filter(e=>e.getClientRects().length),first=items[0],last=items.at(-1);if(event.shiftKey&&globalThis.document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&globalThis.document.activeElement===last){event.preventDefault();first?.focus();}}};
    globalThis.document.addEventListener('keydown',key);return()=>{if(!already)root?.removeAttribute('inert');globalThis.document.removeEventListener('keydown',key);queueMicrotask(()=>{if(svg.current?.getClientRects().length)svg.current.focus();});};
  },[fullscreen]);
  const point=(event:React.PointerEvent<SVGSVGElement>)=>{const rect=event.currentTarget.getBoundingClientRect();return{x:event.clientX-rect.left,y:event.clientY-rect.top};};
  const world=(p:Point)=>({x:(p.x-camera.current.x)/camera.current.k,y:(p.y-camera.current.y)/camera.current.k});
  const begin=(event:React.PointerEvent<SVGSVGElement>)=>{
    if(event.button!==0||!model)return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);const p=point(event);pointers.current.set(event.pointerId,p);
    if(pointers.current.size>=2){if(gesture.current?.node!==undefined)model.particles[gesture.current.node].fixed=false;const[a,b]=[...pointers.current.values()];gesture.current={type:'pinch',start:{x:(a.x+b.x)/2,y:(a.y+b.y)/2},camera:{...camera.current},distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),moved:true};tapped.current=null;if(tapTimer.current)clearTimeout(tapTimer.current);return;}
    const w=world(p);let nearest:number|undefined,distance=Infinity;model.particles.forEach((n,i)=>{const d=Math.hypot(n.x-w.x,n.y-w.y)*camera.current.k;if(d<Math.max(n.radius*camera.current.k+5,event.pointerType==='touch'?20:12)&&d<distance){nearest=i;distance=d;}});
    if(nearest!==undefined){const n=model.particles[nearest];n.fixed=true;gesture.current={type:'node',node:nearest,start:p,offset:{x:n.x-w.x,y:n.y-w.y},camera:{...camera.current},moved:false};}else gesture.current={type:'pan',start:p,camera:{...camera.current},moved:false};
  };
  const move=(event:React.PointerEvent<SVGSVGElement>)=>{
    if(!pointers.current.has(event.pointerId)||!model)return;const p=point(event);pointers.current.set(event.pointerId,p);const g=gesture.current;if(!g)return;
    if(g.type==='pinch'){const[a,b]=[...pointers.current.values()];if(!a||!b)return;const middle={x:(a.x+b.x)/2,y:(a.y+b.y)/2},k=clamp(g.camera.k*Math.hypot(a.x-b.x,a.y-b.y)/g.distance!,.08,5);camera.current={...camera.current,k,x:middle.x-(g.start.x-g.camera.x)*k/g.camera.k,y:middle.y-(g.start.y-g.camera.y)*k/g.camera.k};}
    else{const dx=p.x-g.start.x,dy=p.y-g.start.y;if(Math.hypot(dx,dy)>6)g.moved=true;if(g.type==='pan'){camera.current.x=g.camera.x+dx;camera.current.y=g.camera.y+dy;}else if(g.node!==undefined&&g.moved){const n=model.particles[g.node],w=world(p);n.x=w.x+g.offset!.x;n.y=w.y+g.offset!.y;heat.current=240;}}paintCamera();
  };
  const end=(event:React.PointerEvent<SVGSVGElement>,cancelled=false)=>{
    const g=gesture.current;if(!g)return;const p=point(event);pointers.current.delete(event.pointerId);if(model&&g.node!==undefined)model.particles[g.node].fixed=false;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    if(pointers.current.size){gesture.current={type:'pan',start:[...pointers.current.values()][0],camera:{...camera.current},moved:true};return;}gesture.current=null;if(cancelled||g.moved){tapped.current=null;return;}
    const last=tapped.current,now=performance.now();if(last&&now-last.at<320&&Math.hypot(p.x-last.point.x,p.y-last.point.y)<28){if(tapTimer.current)clearTimeout(tapTimer.current);tapped.current=null;setFullscreen(value=>!value);}else{tapped.current={at:now,point:p};if(tapTimer.current)clearTimeout(tapTimer.current);if(g.node!==undefined&&model){const path=model.particles[g.node].path;tapTimer.current=setTimeout(()=>setSelected(path),330);}}
  };
  const nodeKey=(event:React.KeyboardEvent<SVGGElement>,index:number)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setSelected(graph!.nodes[index].path);}if(['ArrowRight','ArrowDown','ArrowLeft','ArrowUp'].includes(event.key)){event.preventDefault();const next=(index+(['ArrowRight','ArrowDown'].includes(event.key)?1:-1)+graph!.nodes.length)%graph!.nodes.length;setFocused(next);nodes.current.get(graph!.nodes[next].path)?.focus();}};
  const close=()=>{setSelected(null);setEditing(false);};
  const openLink=(target:string)=>{const from=selected;if(!from)return;void api.resolveNote(target,from).then(result=>{if(selectedRef.current!==from)return;if(result.paths.length===1)setSelected(result.paths[0]);else setReadError(result.paths.length?'Есть несколько заметок с этим именем. Используйте полный путь.':'Связанная заметка не найдена.');}).catch(cause=>{setReadError(cause.message);if(cause instanceof ApiError&&cause.status===401)onUnauthorized();});};
  const stageContent=<div ref={stage} tabIndex={-1} className={'graph-stage'+(fullscreen?' is-fullscreen':'')} role={fullscreen?'dialog':undefined} aria-modal={fullscreen||undefined} aria-label={fullscreen?'Граф заметок во весь экран':undefined}>
    <div className="graph-stage-caption"><span>{graph?.nodes.length??0} заметок · {graph?.edges.length??0} связей</span>{fullscreen&&<button className="icon-btn" aria-label="Закрыть полный экран" onClick={()=>setFullscreen(false)}><Icon name="close"/></button>}</div>
    <svg ref={svg} className="vault-graph force-graph" tabIndex={0} role="group" aria-label="Граф заметок: перемещайте узлы и фон, масштабируйте колесом или двумя пальцами. Двойное нажатие переключает полный экран." onPointerDown={begin} onPointerMove={move} onPointerUp={event=>end(event)} onPointerCancel={event=>end(event,true)} onLostPointerCapture={event=>{if(pointers.current.has(event.pointerId))end(event,true);}} onDoubleClick={event=>event.preventDefault()} onKeyDown={event=>{if(event.target!==event.currentTarget)return;if(event.key==='Enter'){event.preventDefault();setFullscreen(value=>!value);}if(event.key==='Home'){event.preventDefault();fit();}}}>
      <defs>{model?.particles.map((node,i)=><linearGradient key={node.path} id={`${id}-node-${i}`} x1="0" y1="0" x2="1" y2="1">{gradientHues(node.hues).map((hue,j)=><stop key={j} ref={element=>{if(element)stops.current.set(i+':'+j,element);else stops.current.delete(i+':'+j);}} offset={`${j/(Math.max(2,node.hues.length)-1)*100}%`} stopColor={`hsl(${hue} 75% 67%)`}/>)}</linearGradient>)}</defs>
      <g ref={scene}>{model?.links.map(([a,b],i)=><line key={i} ref={element=>{if(element)edges.current.set(i,element);else edges.current.delete(i);}} x1={model.particles[a].x} y1={model.particles[a].y} x2={model.particles[b].x} y2={model.particles[b].y} className={'force-edge'+(model.particles[a].path===selected||model.particles[b].path===selected?' is-related':'')} vectorEffect="non-scaling-stroke"/>)}
      {model?.particles.map((particle,i)=>{const node=graph!.nodes[i];return <g ref={element=>{if(element)nodes.current.set(node.path,element);else nodes.current.delete(node.path);}} key={node.path} transform={`translate(${particle.x} ${particle.y})`} data-node={node.path} className={'graph-node force-node'+(selected===node.path?' selected':neighbors.has(node.path)?' neighbor':'')+(query&&!found.has(node.path)?' dimmed':'')} role="button" tabIndex={focused===i?0:-1} aria-label={`${node.title}, связей: ${particle.degree}${node.tags?.length?', метки: '+node.tags.join(', '):''}`} onKeyDown={event=>nodeKey(event,i)}><title>{node.title+' · '+particle.degree+' связей'}</title><circle className="graph-hit" r={particle.radius+9}/><circle className="graph-particle" r={particle.radius} style={{fill:`url(#${id}-node-${i})`}}/><text x={particle.radius+8} y={4}>{node.title.slice(0,48)}</text></g>;})}</g>
    </svg>
    {!graph?.nodes.length&&!loading&&<p className="graph-empty">В хранилище пока нет заметок.</p>}{loading&&<p className="graph-empty" role="status">Собираю связи заметок…</p>}
    <span className="graph-gesture-hint" aria-hidden="true">Двойное нажатие — {fullscreen?'свернуть':'во весь экран'}</span>
  </div>;
  return <section className="note-graph force-graph-section" aria-label="Граф серверного хранилища">
    <div className="graph-toolbar"><label className="graph-search"><span className="sr-only">Поиск по графу</span><input className="field" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Найти заметку или метку…"/></label><button className="btn secondary small" disabled={loading} onClick={()=>void reload()}>Обновить</button></div>
    {error&&<p role="alert" className="error">{error}</p>}{query&&<p className="muted graph-search-status" role="status">Найдено: {found.size}</p>}
    {fullscreen?createPortal(stageContent,globalThis.document.body):stageContent}
    {!!tags.length&&<div className="graph-tag-legend" aria-label="Цвета меток">{tags.map(tag=><span className="graph-tag" key={tag}><i style={{background:`hsl(${tagHue(tag)} 75% 67%)`}}/>#{tag}</span>)}</div>}
    {!!graph?.warnings.length&&<p className="muted graph-status">У {graph.warnings.length} заметок некорректные метаданные; доступен просмотр исходного текста.</p>}
    {selected&&createPortal(<EditorOverlay key={editing ? 'edit' : 'preview'} label="Заметка в графе"><div className="graph-note-window">{editing?<NoteEditor path={selected} onClose={()=>setEditing(false)} onSaved={()=>void reload()} onUnauthorized={onUnauthorized}/>:<><div className="editor-heading"><h2>{note?.title??graph?.nodes.find(node=>node.path===selected)?.title??'Заметка'}</h2><button className="icon-btn" aria-label="Закрыть просмотр заметки" onClick={close}><Icon name="close"/></button></div><div className="graph-note-actions"><button className="btn secondary small" disabled={!note} onClick={()=>setEditing(true)}>Редактировать</button><span className="muted">Markdown · Git</span></div>{reading&&<p role="status">Открываю заметку…</p>}{readError&&<p role="alert">{readError}</p>}{note&&<div className="graph-note-body"><Markdown text={note.body} onWikiLink={openLink}/></div>}{neighbors.size>0&&<div className="graph-note-backlinks"><h3>Связанные заметки</h3>{graph?.nodes.filter(node=>neighbors.has(node.path)).map(node=><button className="chip" key={node.path} onClick={()=>setSelected(node.path)}>{node.title}</button>)}</div>}</>}</div></EditorOverlay>,globalThis.document.body)}
  </section>;
}
