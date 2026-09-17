import type { SearchHit } from './types.js';
import type { Vault } from './vault.js';

/** Lower-case and strip diacritics/punctuation for tolerant matching. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set([
  'и', 'в', 'на', 'с', 'о', 'об', 'по', 'из', 'за', 'к', 'у', 'не', 'что', 'как', 'для', 'это', 'то', 'а', 'но',
  'я', 'мы', 'ты', 'он', 'она', 'они', 'мой', 'моя', 'мои', 'the', 'a', 'an', 'of', 'in', 'on', 'to', 'for',
  'is', 'are', 'and', 'or', 'my', 'me', 'i', 'about', 'what', 'where', 'when', 'how', 'найди', 'покажи',
  'find', 'show', 'search',
]);

export function tokenize(q: string): string[] {
  return normalizeText(q)
    .split(' ')
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

/** Simple stem: cut common Russian/English endings so "идеи" ~ "идея". */
export function stem(token: string): string {
  if (token.length <= 4) return token;
  return token.replace(/(иями|ями|ами|ием|ием|ого|его|ому|ему|ыми|ими|ах|ях|ов|ев|ей|ой|ый|ий|ая|яя|ое|ее|ые|ие|ам|ям|ом|ем|ах|ах|а|я|ы|и|о|е|у|ю|ь|й|s|es|ed|ing)$/u, '');
}

function makeSnippet(content: string, terms: string[], width = 160): string {
  const lower = normalizeText(content);
  let pos = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (pos === -1 || i < pos)) pos = i;
  }
  const plain = content.replace(/\s+/g, ' ');
  if (pos === -1) return plain.slice(0, width).trim();
  // map roughly: normalized and plain have similar lengths; clamp
  const start = Math.max(0, Math.min(pos, plain.length) - width / 3);
  const snip = plain.slice(start, start + width).trim();
  return (start > 0 ? '…' : '') + snip + (start + width < plain.length ? '…' : '');
}

export interface SearchOptions {
  limit?: number;
  folder?: string;
  /** Only notes modified after this timestamp (ms). */
  since?: number;
}

/**
 * Keyword search over the vault. Scores title matches highest, then body term frequency,
 * with a small recency boost. Good enough for personal vaults (thousands of notes).
 */
export async function searchNotes(vault: Vault, query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  const limit = opts.limit ?? 8;
  const tokens = tokenize(query);
  const stems = Array.from(new Set(tokens.map(stem)));
  const notes = await vault.listNotes(opts.folder ?? '');
  const now = Date.now();
  const hits: SearchHit[] = [];

  if (stems.length === 0) {
    // No usable terms: return most recent notes
    return notes
      .filter((n) => !opts.since || n.mtime >= opts.since)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map((n) => ({ path: n.path, title: n.title, score: 0, snippet: '', mtime: n.mtime }));
  }

  for (const meta of notes) {
    if (opts.since && meta.mtime < opts.since) continue;
    let note;
    try {
      note = await vault.readNote(meta.path);
    } catch {
      continue;
    }
    const title = normalizeText(note.title);
    const body = normalizeText(note.content);
    const pathNorm = normalizeText(note.path);
    let score = 0;
    let matched = 0;
    for (const s of stems) {
      const inTitle = title.includes(s);
      const inPath = pathNorm.includes(s);
      const bodyCount = countOccurrences(body, s);
      if (inTitle) score += 10;
      else if (inPath) score += 4;
      if (bodyCount) score += Math.min(bodyCount, 10) * 1.5;
      if (inTitle || inPath || bodyCount) matched++;
    }
    if (matched === 0) continue;
    // Prefer notes matching all terms
    score *= matched / stems.length;
    if (matched === stems.length) score += 5;
    // recency: up to +3 for notes touched within 30 days
    const ageDays = (now - meta.mtime) / 86_400_000;
    score += Math.max(0, 3 - ageDays / 10);
    hits.push({ path: note.path, title: note.title, score, snippet: makeSnippet(note.content, stems), mtime: meta.mtime });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = hay.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}
