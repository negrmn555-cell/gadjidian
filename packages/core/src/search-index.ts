import { isPreferencesPath } from './preferences.js';
import { watch, type FSWatcher, promises as fs } from 'node:fs';
import { create, insert, remove, search } from '@orama/orama';
import { tokenizer } from '@orama/orama/components';
import { stemmer } from '@orama/stemmers/russian';
import { LRUCache } from 'lru-cache';
import { recordCache } from './metrics.js';
import { createHash } from 'node:crypto';
import { parseMarkdownDocument, PARSER_VERSION, type ParsedDocument } from './markdown-document.js';
import { normalizeRel, type Vault } from './vault.js';
import type { NoteMeta, SearchHit } from './types.js';
import type { SearchOptions } from './search.js';

const normalize = (s: string) => s.normalize('NFC').toLowerCase().replace(/ё/g, 'е');
const schema = { path: 'string', title: 'string', aliases: 'string', heading: 'string', body: 'string', tags: 'string', keywords: 'string', folders: 'enum[]', kind: 'enum', tagFilter: 'enum[]', mtime: 'number' } as const;
function database() { return create({ schema, components: { tokenizer: tokenizer.createTokenizer({ language: 'russian', stemming: true, stemmer, stopWords: false, stemmerSkipProperties: ['path'] }) } }); }
export interface SearchDocument { meta: NoteMeta; parsed: ParsedDocument }

/** All updates and reads observe a complete revision. The index is derived from the vault. */
export class VaultSearchIndex {
  private db = database();
  private readonly records = new Map<string, SearchDocument>();
  private readonly ids = new Map<string, string[]>();
  private readonly chunkPaths = new Map<string, string>();
  private readonly exactPaths = new Map<string, Set<string>>();
  private readonly parseCache = new LRUCache<string, ParsedDocument>({ max: 1000, maxSize: 32 * 1024 * 1024, sizeCalculation: v => Math.max(1, Buffer.byteLength(v.content) + Buffer.byteLength(JSON.stringify(v.ast))) });
  private readonly resultCache = new LRUCache<string, SearchHit[]>({ max: 200, maxSize: 2 * 1024 * 1024, sizeCalculation: v => Math.max(1, Buffer.byteLength(JSON.stringify(v))), ttl: 30_000 });
  private pending = new Set<string>();
  private full = true;
  private initialized = false;
  private reconciledAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private watcher?: FSWatcher;
  private unsubscribe: () => void;
  private closed = false;
  revision = 0;
  constructor(readonly vault: Vault) {
    this.unsubscribe = vault.onChange(paths => this.invalidate(paths));
  }
  startWatching(): void {
    if(this.watcher||this.closed)return;
    try { this.watcher = watch(this.vault.root, { recursive: true, persistent: false }, (_event, file) => {const p=file?String(file).replace(/\\/g,'/'):null;if(!p||!this.vault.isIgnored(p)&&!this.vault.isPrivate(p))this.vault.notifyChanged(p?[p]:undefined);}); this.watcher.unref(); this.watcher.on('error', () => { this.full = true; }); }
    catch { /* Periodic reconciliation also works on filesystems without recursive watching. */ }
  }
  invalidate(paths?: string[]): void {
    if (this.closed) return;
    if (!paths) this.full = true;
    else for (const p of paths) { const rel = normalizeRel(p); if (/\.md$/i.test(rel)) this.pending.add(rel); else if (!rel.includes('.') && !this.vault.isIgnored(rel)) this.full = true; }
    this.resultCache.clear();
  }
  private allowed(p: string): boolean { if(isPreferencesPath(p))return false; try { this.vault.resolve(p); return true; } catch { return false; } }
  private async delete(p: string): Promise<void> {
    const old=this.records.get(p)?.parsed;
    if(old)for(const key of [p,old.title,...old.aliases].map(normalize)){const paths=this.exactPaths.get(key);paths?.delete(p);if(!paths?.size)this.exactPaths.delete(key);}
    for (const id of this.ids.get(p) ?? []) {await remove(this.db, id);this.chunkPaths.delete(id);} this.ids.delete(p); this.records.delete(p);
  }
  private async update(p: string): Promise<void> {
    if (!this.allowed(p)) { await this.delete(p); return; }
    let note; try { note = await this.vault.readNote(p); } catch { await this.delete(p); return; }
    const contentHash = createHash('sha256').update(note.content).digest('hex'), previous = this.records.get(p);
    if (previous?.parsed.contentHash === contentHash) { previous.meta = { path: p, title: previous.parsed.title, mtime: note.mtime, size: note.size }; return; }
    const key = p + ':' + contentHash + ':' + PARSER_VERSION;
    let parsed = this.parseCache.get(key); if (!parsed) { parsed = parseMarkdownDocument(p, note.content); this.parseCache.set(key, parsed); }
    await this.delete(p);
    const ids: string[] = [];
    const segments=p.split('/'),folders=segments.slice(0,-1).map((_,i)=>segments.slice(0,i+1).join('/'));
    for (const chunk of parsed.chunks) {const id=await insert(this.db, { id: chunk.id, path: normalize(p), title: normalize(parsed.title), aliases: normalize(parsed.aliases.join(' ')), heading: normalize(chunk.headingPath.join(' ')), body: normalize(chunk.text), tags: normalize(parsed.tags.join(' ')), keywords: normalize(parsed.keywords.join(' ')),folders,kind:parsed.kind,tagFilter:parsed.tags,mtime:note.mtime });ids.push(id);this.chunkPaths.set(id,p);}
    for(const key of [p,parsed.title,...parsed.aliases].map(normalize)){const paths=this.exactPaths.get(key)??new Set<string>();paths.add(p);this.exactPaths.set(key,paths);}
    this.ids.set(p, ids); this.records.set(p, { meta: { path: p, title: parsed.title, mtime: note.mtime, size: note.size }, parsed: { ...parsed, ast: { type: 'root' } } });
  }
  private async updatePending(force: boolean): Promise<void> {
    if (this.closed) throw new Error('Search index is closed');
    const reconcile = force || this.full || !this.initialized || Date.now() - this.reconciledAt >= 30_000;
    const paths = new Set(this.pending); this.pending.clear(); this.full = false;
    if (reconcile) {
      const notes = await this.vault.listNotes(), live = new Set(notes.map(n => n.path));
      for (const p of this.records.keys()) if (!live.has(p)) paths.add(p);
      for (const note of notes) { const old = this.records.get(note.path); if (force || !old || old.meta.mtime !== note.mtime || old.meta.size !== note.size) paths.add(note.path); }
      this.reconciledAt = Date.now();
    }
    try { for (const p of paths) await this.update(p); } catch (e) { this.full = true; throw e; }
    if (paths.size || !this.initialized) { this.revision++; this.resultCache.clear(); } this.initialized = true;
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> { const result = this.queue.then(work, work); this.queue = result.catch(() => {}); return result; }
  documents(force = false): Promise<SearchDocument[]> { return this.vault.readConsistent(() => this.exclusive(async () => { if(!this.watcher)this.full=true;await this.updatePending(force); return [...this.records.values()].filter(d => this.allowed(d.meta.path)); })); }
  query(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    return this.vault.readConsistent(() => this.exclusive(async () => {
      await this.updatePending(false);
      const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 8))), folder = options.folder ? normalizeRel(options.folder) : '';
      if (folder) this.vault.resolve(folder);
      const cacheKey = JSON.stringify([this.revision, normalize(query), folder, options.since, options.kind, options.tags, limit]);
      let hits = this.resultCache.get(cacheKey);
      recordCache(!!hits);
      if (!hits) {
        const term = normalize(query.trim()), results = term ? await search(this.db, { term, limit: Math.max(100, limit * 16), threshold: 1, properties: ['path', 'title', 'aliases', 'heading', 'body', 'tags', 'keywords'], boost: { title: 5, aliases: 4, heading: 2, path: 2, keywords: 2 },where:{...(folder?{folders:{containsAll:[folder]}}:{}),...(options.kind?{kind:{eq:options.kind}}:{}),...(options.tags?.length?{tagFilter:{containsAll:options.tags}}:{}),...(options.since?{mtime:{gte:options.since}}:{})} }) : null;
        const byChunk = new Map((results?.hits ?? []).map(h => [h.id, h.score]));
        const candidatePaths=term?new Set([...(results?.hits??[]).map(h=>this.chunkPaths.get(h.id)!).filter(Boolean),...(this.exactPaths.get(term)??[])]):new Set(this.records.keys());
        const grouped: SearchHit[] = [];
        for (const candidate of candidatePaths) {
          const {meta,parsed}=this.records.get(candidate)!;
          if (!this.allowed(meta.path) || folder && meta.path !== folder && !meta.path.startsWith(folder + '/') || options.since && meta.mtime < options.since || options.kind && parsed.kind !== options.kind || options.tags?.some(t => !parsed.tags.includes(t))) continue;
          const best = parsed.chunks.filter(c => byChunk.has(c.id)).sort((a, b) => byChunk.get(b.id)! - byChunk.get(a.id)!)[0];
          const exact = term && (normalize(meta.path) === term || normalize(parsed.title) === term || parsed.aliases.some(a => normalize(a) === term));
          if (term && !best && !exact) continue;
          const chunk = best ?? parsed.chunks[0];
          const terms=term.split(/[^\p{L}\p{N}]+/u).filter(t=>t.length>1).map(stemmer),searchText=normalize([meta.path,parsed.title,...parsed.aliases,...parsed.chunks.map(c=>c.text)].join(' '));
          const matched=terms.filter(t=>searchText.includes(t)).length,coverage=terms.length?matched/terms.length:0;
          grouped.push({ path: meta.path, title: parsed.title, score: (best ? byChunk.get(best.id)! : 0) + (exact ? 100 : 0) + coverage*20 + (terms.length>1&&matched===terms.length?25:0), snippet: chunk.text.replace(/\s+/g, ' ').slice(0, 360), mtime: meta.mtime,
            sourceVersion: { path: meta.path, noteId: parsed.noteId, contentHash: parsed.contentHash, state: 'current', checkedAt: Date.now() }, headingPath: chunk.headingPath, chunkId: chunk.id, start: chunk.start, end: chunk.end, indexRevision: this.revision });
        }
        hits = grouped.sort((a, b) => b.score - a.score || b.mtime - a.mtime || a.path.localeCompare(b.path)).slice(0, limit); this.resultCache.set(cacheKey, hits);
      }
      const safe: SearchHit[] = [];
      for (const hit of hits) {
        if (!this.allowed(hit.path)) continue;
        try { const stat = await fs.stat(await this.vault.safePath(hit.path)), record = this.records.get(hit.path); if (!stat.isFile() || !record || stat.mtimeMs !== record.meta.mtime || stat.size !== record.meta.size) { this.pending.add(hit.path); continue; } safe.push(structuredClone(hit)); }
        catch { this.pending.add(hit.path); }
      }
      return safe;
    }));
  }
  close(): void { this.closed = true; this.watcher?.close(); this.unsubscribe(); this.parseCache.clear(); this.resultCache.clear(); this.records.clear();this.chunkPaths.clear();this.exactPaths.clear(); }
}
const indexes = new WeakMap<Vault, VaultSearchIndex>();
export function getSearchIndex(vault: Vault): VaultSearchIndex { let index = indexes.get(vault); if (!index) { index = new VaultSearchIndex(vault); indexes.set(vault, index); } return index; }
export function disposeSearch(vault: Vault): void { indexes.get(vault)?.close(); indexes.delete(vault); }
