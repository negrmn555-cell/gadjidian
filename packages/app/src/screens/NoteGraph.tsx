import { useEffect, useMemo, useRef, useState } from 'react';
import type { NoteGraph as GraphData } from '@relay/core/contracts';
import { api, ApiError } from '../api';
import { Markdown } from '../Markdown';

type Point = { x: number; y: number };
export function NoteGraph({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [query, setQuery] = useState(''), [selected, setSelected] = useState<string | null>(null);
  const [document, setDocument] = useState<{ path: string; title: string; body: string } | null>(null);
  const [reading, setReading] = useState(false), [readError, setReadError] = useState('');
  const [zoom, setZoom] = useState(1), [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [listLimit, setListLimit] = useState(40);
  const svg = useRef<SVGSVGElement>(null);
  const article = useRef<HTMLElement>(null);
  const drag = useRef<{ node: string | null; x: number; y: number; start: Point; moved: boolean } | null>(null);
  const request = useRef(0);
  const reload = async () => {
    const generation = ++request.current;
    setLoading(true); setError('');
    try {
      const result = await api.noteGraph();
      if (generation !== request.current) return;
      setGraph(result);
      const next: Record<string, Point> = {};
      const spacing = Math.max(36, 220 / Math.sqrt(Math.max(1, result.nodes.length)));
      result.nodes.forEach((node, i) => { const angle = i * 2.3999632297, radius = spacing * Math.sqrt(i + 1); next[node.path] = { x: 500 + radius * Math.cos(angle), y: 330 + radius * Math.sin(angle) }; });
      setPositions(next); setPan({ x: 0, y: 0 });
      setZoom(Math.min(1, 260 / Math.max(260, 36 * Math.sqrt(result.nodes.length))));
      if (selected && !result.nodes.some(n => n.path === selected)) setSelected(null);
    } catch (cause) { if (generation === request.current) setError((cause as Error).message); if (cause instanceof ApiError && cause.status === 401) onUnauthorized(); }
    finally { if (generation === request.current) setLoading(false); }
  };
  useEffect(() => { void reload(); return () => { request.current++; }; }, []);
  useEffect(() => {
    let stale = false;
    setDocument(null); setReadError(''); setReading(!!selected);
    if (selected) api.graphDocument(selected).then(result => { if (!stale) setDocument(result); }).catch(cause => { if (!stale) setReadError(cause.message); if (cause instanceof ApiError && cause.status === 401) onUnauthorized(); }).finally(() => { if (!stale) setReading(false); });
    return () => { stale = true; };
  }, [selected, graph]);
  useEffect(() => {
    if (document) article.current?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, [document]);
  const matches = useMemo(() => graph?.nodes.filter(n => (n.title + ' ' + n.path).toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [], [graph, query]);
  const found = useMemo(() => new Set(matches.map(n => n.path)), [matches]);
  const neighbors = useMemo(() => new Set(graph?.edges.flatMap(e => e.source === selected ? [e.target] : e.target === selected ? [e.source] : []) ?? []), [graph, selected]);
  const changeZoom = (factor: number) => setZoom(value => Math.min(5, Math.max(.08, value * factor)));
  const startDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    const node = (event.target as Element).closest('[data-node]')?.getAttribute('data-node') ?? null;
    drag.current = { node, x: event.clientX, y: event.clientY, start: node ? positions[node] : pan, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: React.PointerEvent<SVGSVGElement>) => {
    const current = drag.current, rect = svg.current?.getBoundingClientRect();
    if (!current || !rect) return;
    const scale = Math.min(rect.width / 1000, rect.height / 660);
    const dx = (event.clientX - current.x) / scale, dy = (event.clientY - current.y) / scale;
    if (Math.abs(dx) + Math.abs(dy) > 4) current.moved = true;
    if (current.node) setPositions(old => ({ ...old, [current.node!]: { x: current.start.x + dx / zoom, y: current.start.y + dy / zoom } }));
    else setPan({ x: current.start.x + dx, y: current.start.y + dy });
  };
  const finish = () => { if (drag.current?.node && !drag.current.moved) setSelected(drag.current.node); drag.current = null; };
  return <section className="note-graph" aria-label="Граф серверного хранилища">
    <div className="graph-toolbar"><label className="graph-search">Поиск по графу<input className="field" value={query} onChange={event => { setQuery(event.target.value); setListLimit(40); }} placeholder="Название или путь заметки" /></label><button className="btn secondary small" disabled={loading} onClick={() => void reload()}>Обновить из хранилища</button></div>
    {error && <p role="alert" className="error">{error}</p>}
    {loading && <p role="status">Читаю серверное хранилище…</p>}
    {graph && <><p className="muted graph-status">{graph.nodes.length} заметок · {graph.edges.length} связей · {graph.syncMode === 'git' ? 'Git' : 'Серверное хранилище'}{graph.revision ? ' · ' + graph.revision.slice(0, 8) : ''}</p>
      <div className="graph-layout"><div className="graph-canvas"><div className="graph-controls"><button className="icon-btn" aria-label="Приблизить граф" onClick={() => changeZoom(1.25)}>+</button><button className="icon-btn" aria-label="Отдалить граф" onClick={() => changeZoom(.8)}>−</button><button className="btn secondary small" onClick={() => { setPan({ x: 0, y: 0 }); setZoom(Math.min(1, 260 / Math.max(260, 36 * Math.sqrt(graph.nodes.length)))); }}>Вписать</button></div>
        <svg ref={svg} className="vault-graph" viewBox="0 0 1000 660" role="img" aria-label="Связи заметок. Перемещайте узлы и фон; для открытия можно выбрать заметку в списке." onPointerDown={startDrag} onPointerMove={move} onPointerUp={finish} onPointerCancel={() => { drag.current = null; }} onWheel={event => { if (event.ctrlKey || event.metaKey) return; changeZoom(event.deltaY < 0 ? 1.1 : .9); }}>
          <g transform={`translate(${500 + pan.x} ${330 + pan.y}) scale(${zoom}) translate(-500 -330)`}>
            {graph.edges.map((edge, i) => { const a = positions[edge.source], b = positions[edge.target]; return a && b && <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={edge.source === selected || edge.target === selected ? 'graph-edge active' : 'graph-edge'} />; })}
            {graph.nodes.map(node => { const p = positions[node.path]; if (!p) return null; const active = node.path === selected, related = neighbors.has(node.path); return <g key={node.path} data-node={node.path} className={'graph-node ' + (active ? 'selected' : related ? 'neighbor' : '') + (query && !found.has(node.path) ? ' dimmed' : '')} transform={`translate(${p.x} ${p.y})`}><title>{node.title + '\n' + node.path}</title><circle className="graph-hit" r={26} /><circle r={active ? 14 : 10} /><text x={18} y={5}>{node.title.slice(0, 48)}</text></g>; })}
          </g>
        </svg>
        {!graph.nodes.length && <p className="graph-empty">В серверном хранилище пока нет заметок.</p>}
      </div><aside className="graph-browser"><h3>Заметки · {matches.length}</h3><div className="graph-note-list">{matches.slice(0, listLimit).map(node => <button key={node.path} className={'graph-note-item ' + (selected === node.path ? 'active' : '')} onClick={() => setSelected(node.path)}><strong>{node.title}</strong><small>{node.path}</small></button>)}{matches.length > listLimit && <button className="btn secondary small" onClick={() => setListLimit(limit => limit + 80)}>Показать ещё</button>}</div></aside></div>
      {selected && <article ref={article} className="graph-document"><div className="editor-heading"><h3>{document?.title ?? selected}</h3><button className="icon-btn" aria-label="Закрыть просмотр заметки" onClick={() => setSelected(null)}>×</button></div><p className="muted note-path">{selected}</p>{reading && <p role="status">Загружаю заметку с сервера…</p>}{readError && <p role="alert" className="error">{readError}</p>}{document && <Markdown text={document.body} />}{neighbors.size > 0 && <div className="graph-neighbors"><h4>Связанные заметки</h4>{graph.nodes.filter(n => neighbors.has(n.path)).map(n => <button key={n.path} className="btn secondary small" onClick={() => setSelected(n.path)}>{n.title}</button>)}</div>}</article>}
      {!!graph.warnings.length && <p className="muted">Некорректные метаданные: {graph.warnings.length}. Файлы доступны для просмотра в графе.</p>}
    </>}
  </section>;
}
