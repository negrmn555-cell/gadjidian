import { Fragment, type ReactNode } from 'react';

/** Tiny safe Markdown renderer: headings, lists, bold, code, links, [[wikilinks]]. No HTML passthrough. */
export function Markdown({ text, onWikiLink }: { text: string; onWikiLink?: (target: string) => void }) {
  const inline = (text: string) => renderInline(text, onWikiLink);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let inCode = false;
  let code: string[] = [];
  let tableThrough = -1;
  lines.forEach((line, i) => {
    if (i <= tableThrough) return;
    if (line.trim().startsWith('```')) {
      if (inCode) {
        out.push(
          <pre key={`c${i}`} style={{ overflowX: 'auto', background: 'rgba(255,255,255,0.06)', padding: 8, borderRadius: 8, margin: '6px 0' }}>
            {code.join('\n')}
          </pre>,
        );
        code = [];
      }
      inCode = !inCode;
      return;
    }
    if (inCode) {
      code.push(line);
      return;
    }
    const header = tableCells(line), separator = tableCells(lines[i + 1] ?? '');
    if (line.includes('|') && header.length > 0 && separator.length === header.length && separator.every(cell => /^:?-{3,}:?$/.test(cell))) {
      const rows: string[][] = [];
      let end = i + 2;
      while (end < lines.length && lines[end].includes('|') && lines[end].trim()) rows.push(tableCells(lines[end++]));
      tableThrough = end - 1;
      out.push(<div className="markdown-table" key={'t' + i} tabIndex={0} role="region" aria-label="Таблица"><table><thead><tr>{header.map((cell, c) => <th key={c} scope="col">{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, r) => <tr key={r}>{header.map((_, c) => <td key={c}>{inline(row[c] ?? '')}</td>)}</tr>)}</tbody></table></div>);
      return;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const size = Math.max(15, 21 - h[1].length * 1.5);
      out.push(
        <div key={i} style={{ fontWeight: 700, fontSize: size, margin: '8px 0 2px' }}>
          {inline(h[2])}
        </div>,
      );
      return;
    }
    const task = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (task) {
      out.push(
        <div key={i} style={{ paddingLeft: 4 }}>
          {task[1] === ' ' ? '☐' : '☑'} {inline(task[2])}
        </div>,
      );
      return;
    }
    const li = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (li) {
      out.push(
        <div key={i} style={{ paddingLeft: 4 + Math.min(li[1].length, 8) * 4 }}>
          • {inline(li[2])}
        </div>,
      );
      return;
    }
    const ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (ol) {
      out.push(
        <div key={i} style={{ paddingLeft: 4 }}>
          {ol[1]}. {inline(ol[2])}
        </div>,
      );
      return;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      out.push(
        <div key={i} style={{ borderLeft: '3px solid var(--accent)', paddingLeft: 8, color: 'var(--fg2)' }}>
          {inline(q[1])}
        </div>,
      );
      return;
    }
    if (line.trim() === '') {
      out.push(<div key={i} style={{ height: 6 }} />);
      return;
    }
    out.push(<div key={i}>{inline(line)}</div>);
  });
  if (inCode && code.length) out.push(<pre className="markdown-code" key="unfinished-code">{code.join('\n')}</pre>);
  return <>{out}</>;
}

function tableCells(line: string): string[] {
  const cells: string[] = []; let cell = '', code = false, wiki = false;
  const value = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\' && value[i + 1] === '|') { cell += '|'; i++; continue; }
    if (value[i] === '`') code = !code;
    if (value.slice(i, i + 2) === '[[') wiki = true;
    if (value.slice(i - 1, i + 1) === ']]') wiki = false;
    if (value[i] === '|' && !code && !wiki) { cells.push(cell.trim()); cell = ''; } else cell += value[i];
  }
  cells.push(cell.trim()); return cells;
}

function renderInline(s: string, onWikiLink?: (target: string) => void): ReactNode {
  const parts: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[\[[^\]]+\]\]|\[[^\]]+\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) parts.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) parts.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('[[')) {
      const inner = tok.slice(2, -2);
      const [target, alias] = inner.split('|');
      parts.push(
        <button key={k++} className="wiki-link" onClick={()=>onWikiLink ? onWikiLink(target) : window.dispatchEvent(new CustomEvent('relay-open-note',{detail:{target}}))}>
          {alias ?? target.split('/').pop()}
        </button>,
      );
    } else if (tok.startsWith('[')) {
      const label = tok.slice(1, tok.indexOf(']'));
      parts.push(
        <a key={k++} href={m[2]} target="_blank" rel="noreferrer">
          {label}
        </a>,
      );
    } else {
      parts.push(
        <a key={k++} href={tok} target="_blank" rel="noreferrer">
          {tok}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return <Fragment>{parts}</Fragment>;
}
