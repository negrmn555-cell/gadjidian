import { createHash } from 'node:crypto';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { parseFrontmatter } from './frontmatter.js';
import { vaultLinks, type VaultLink } from './links.js';

export const PARSER_VERSION = 'markdown-1';
export const CHUNKER_VERSION = 'headings-1';
interface AstNode { type: string; depth?: number; value?: string; children?: AstNode[]; position?: { start: { offset?: number }; end: { offset?: number } } }
export interface MarkdownChunk { id: string; headingPath: string[]; start: number; end: number; text: string; oversized: boolean }
export interface ParsedDocument {
  path: string; content: string; contentHash: string; noteId: string | null;
  title: string; body: string; bodyOffset: number; metadata: Record<string, unknown>;
  tags: string[]; aliases: string[]; keywords: string[]; kind: string;
  links: VaultLink[]; chunks: MarkdownChunk[]; ast: AstNode; metadataError: string | null;
}
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : typeof v === 'string' ? [v] : [];
const text = (node: AstNode): string => node.value ?? (node.children ?? []).map(text).join('');

export function parseMarkdownDocument(path: string, content: string, maxChunkChars = 2800): ParsedDocument {
  let body = content, bodyOffset = 0, metadata: Record<string, unknown> = {}, metadataError: string | null = null;
  try { ({ body, bodyOffset, metadata } = parseFrontmatter(content)); }
  catch { metadataError = 'Некорректные метаданные; автоматическое изменение запрещено.'; }
  const ast = processor.parse(body) as AstNode;
  const chunks: MarkdownChunk[] = [], headings: { depth: number; title: string }[] = [];
  let start = -1, end = -1, headingPath: string[] = [];
  const flush = () => {
    if (start < 0) return;
    const value = content.slice(start, end);
    chunks.push({ id: hash(path + ':' + start + ':' + CHUNKER_VERSION + ':' + value), headingPath: [...headingPath], start, end, text: value, oversized: value.length > maxChunkChars });
    start = end = -1;
  };
  for (const node of ast.children ?? []) {
    const a = bodyOffset + (node.position?.start.offset ?? 0), b = bodyOffset + (node.position?.end.offset ?? 0);
    if (node.type === 'heading') {
      flush();
      while (headings.length && headings.at(-1)!.depth >= node.depth!) headings.pop();
      headings.push({ depth: node.depth!, title: text(node) });
      headingPath = headings.map(h => h.title);
    }
    if (start >= 0 && b - start > maxChunkChars) flush();
    if (start < 0) start = a;
    end = b;
  }
  flush();
  if (!chunks.length) chunks.push({ id: hash(path + ':' + CHUNKER_VERSION + ':' + body), headingPath: [], start: bodyOffset, end: content.length, text: body, oversized: body.length > maxChunkChars });
  const rawId = metadata.id ?? metadata.relay_id;
  return { path, content, contentHash: hash(content), noteId: typeof rawId === 'string' ? rawId : null,
    title: typeof metadata.title === 'string' ? metadata.title : text((ast.children ?? []).find(n => n.type === 'heading' && n.depth === 1) ?? { type: 'empty' }) || path.split('/').at(-1)!.replace(/\.md$/i, ''),
    body, bodyOffset, metadata, tags: strings(metadata.tags), aliases: strings(metadata.aliases), keywords: strings(metadata.keywords),
    kind: String(metadata.type ?? (/^People\//i.test(path) ? 'person' : 'quick')), links: vaultLinks(body).map(l => ({ ...l, start: l.start + bodyOffset, end: l.end + bodyOffset })), chunks, ast, metadataError };
}
