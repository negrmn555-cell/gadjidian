import { Document, isMap, parseDocument } from 'yaml';
import { DomainError } from './contracts.js';

/** Parsing never rewrites the source; callers choose whether to apply changes. */
export function parseFrontmatter(content: string) {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(content);
  const match = opening ? /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content) : null;
  if (opening && !match) throw new DomainError('INVALID_FRONTMATTER', 'Не закрыт YAML-блок заметки.');
  const doc = match ? parseDocument(match[1], { uniqueKeys: true }) : new Document({});
  if (doc.errors.length || doc.contents && !isMap(doc.contents)) {
    throw new DomainError('INVALID_FRONTMATTER', 'Некорректный YAML заметки. Данные не изменены.');
  }
  let metadata: Record<string, unknown>;
  try { metadata = doc.toJS({ maxAliasCount: 32 }) ?? {}; }
  catch { throw new DomainError('INVALID_FRONTMATTER', 'Превышена сложность YAML заметки.'); }
  const bodyOffset = match?.[0].length ?? 0;
  return { doc, metadata, bodyOffset, body: content.slice(bodyOffset), hasFrontmatter: !!match };
}
