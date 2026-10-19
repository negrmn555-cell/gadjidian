import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import type { Note, NoteMeta, VaultConfig } from './types.js';

const DEFAULT_IGNORES = ['.obsidian', '.git', '.trash', '.sync-conflict', '.relay-server', 'node_modules'];

export class VaultError extends Error {
  constructor(message: string, public readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID' | 'EXISTS') {
    super(message);
    this.name = 'VaultError';
  }
}

export interface VaultWriteInput {
  path: string;
  content: string;
  overwrite: boolean;
  expectedHash?: string;
}

export interface VaultWriteBackend {
  write(input: VaultWriteInput): Promise<string>;
}

/** Normalise a vault-relative path: forward slashes, no leading "./" or "/". */
export function normalizeRel(p: string): string {
  let rel = p.replace(/\\/g, '/').trim();
  rel = rel.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  rel = path.posix.normalize(rel);
  if (rel === '.' || rel === '') return '';
  return rel;
}

export function ensureMd(p: string): string {
  return p.toLowerCase().endsWith('.md') ? p : `${p}.md`;
}

/** Make a string safe for use as a file name. */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'Untitled').slice(0, 120);
}

/**
 * File-system adapter for an Obsidian vault. No Obsidian API required.
 * Enforces path safety and private folders.
 */
export class Vault {
  readonly root: string;
  readonly config: VaultConfig;
  private readonly ignores: Set<string>;
  private readonly privateFolders: string[];
  private writeBackend?: VaultWriteBackend;
  private readGuard?:<T>(work:()=>Promise<T>)=>Promise<T>;
  private readonly changeListeners = new Set<(paths?: string[]) => void>();
  onChange(listener: (paths?: string[]) => void): () => void { this.changeListeners.add(listener); return () => this.changeListeners.delete(listener); }
  notifyChanged(paths?: string[]): void { for (const listener of this.changeListeners) listener(paths); }
  setReadGuard(guard:<T>(work:()=>Promise<T>)=>Promise<T>):void{this.readGuard=guard;}
  readConsistent<T>(work: () => Promise<T>): Promise<T> { return this.readGuard ? this.readGuard(work) : work(); }

  setWriteBackend(backend: VaultWriteBackend): void {
    if (this.writeBackend) throw new Error('Vault write backend is already configured');
    this.writeBackend = backend;
  }

  constructor(config: VaultConfig) {
    this.config = config;
    this.root = path.resolve(config.root);
    this.ignores = new Set([...DEFAULT_IGNORES, ...(config.ignoreFolders ?? [])]);
    this.privateFolders = (config.privateFolders ?? [])
      .map((f) => normalizeRel(f))
      .filter((f) => f.length > 0);
  }

  /** Vault-relative -> absolute path, or throws on traversal / private access. */
  resolve(rel: string, opts: { allowPrivate?: boolean } = {}): string {
    if (path.isAbsolute(rel) || path.win32.isAbsolute(rel) || rel.includes('\0')) throw new VaultError('Absolute paths are not allowed', 'INVALID');
    const normalized = normalizeRel(rel);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      throw new VaultError(`Invalid path: ${rel}`, 'INVALID');
    }
    if (!opts.allowPrivate && this.isPrivate(normalized)) {
      throw new VaultError(`Path is in a private folder: ${rel}`, 'FORBIDDEN');
    }
    if (this.isIgnored(normalized)) throw new VaultError('Path is in an ignored folder', 'FORBIDDEN');
    const abs = path.resolve(this.root, normalized);
    const relCheck = path.relative(this.root, abs);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      throw new VaultError(`Invalid path: ${rel}`, 'INVALID');
    }
    return abs;
  }

  isPrivate(rel: string): boolean {
    const normalized = normalizeRel(rel).toLowerCase();
    return (this.config.privateFolders ?? []).map(normalizeRel).filter(Boolean).some((pf) => normalized === pf.toLowerCase() || normalized.startsWith(pf.toLowerCase() + '/'));
  }

  isIgnored(rel: string): boolean {
    const parts = normalizeRel(rel).toLowerCase().split('/');
    return parts.some((seg) => [...this.ignores].some(name => name.toLowerCase() === seg) || seg.includes('.sync-conflict'));
  }

  /** Disallow symlinks/junctions in a vault path, including existing parent folders. */
  async safePath(rel: string): Promise<string> {
    const abs = this.resolve(rel);
    const segments = path.relative(this.root, abs).split(path.sep).filter(Boolean);
    let current = this.root;
    for (const segment of segments) {
      current = path.join(current, segment);
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) throw new VaultError('Symbolic links are not allowed in vault paths', 'FORBIDDEN');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw e;
      }
    }
    return abs;
  }

  private toRel(abs: string): string {
    return path.relative(this.root, abs).replace(/\\/g, '/');
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await fs.access(await this.safePath(rel));
      return true;
    } catch {
      return false;
    }
  }

  /** Recursively list markdown notes (skips ignored and private folders). */
  listNotes(folder=''):Promise<NoteMeta[]>{return this.readGuard?this.readGuard(()=>this.listNotesUnlocked(folder)):this.listNotesUnlocked(folder);}
  private async listNotesUnlocked(folder = ''): Promise<NoteMeta[]> {
    const start = await this.safePath(folder);
    const result: NoteMeta[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        const rel = this.toRel(abs);
        if (this.isIgnored(rel) || this.isPrivate(rel)) continue;
        if (entry.isDirectory()) {
          await walk(abs);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          const st = await fs.stat(abs);
          result.push({
            path: rel,
            title: entry.name.replace(/\.md$/i, ''),
            mtime: st.mtimeMs,
            size: st.size,
          });
        }
      }
    };
    await walk(start);
    return result;
  }

  /** List immediate children of a folder (folders and md files). */
  listFolder(folder=''):Promise<{folders:string[];notes:string[]}>{return this.readGuard?this.readGuard(()=>this.listFolderUnlocked(folder)):this.listFolderUnlocked(folder);}
  private async listFolderUnlocked(folder = ''): Promise<{ folders: string[]; notes: string[] }> {
    const abs = await this.safePath(folder);
    const base = normalizeRel(folder);
    const folders: string[] = [];
    const notes: string[] = [];
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      throw new VaultError(`Folder not found: ${folder}`, 'NOT_FOUND');
    }
    for (const e of entries) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (this.isIgnored(rel) || this.isPrivate(rel)) continue;
      if (e.isDirectory()) folders.push(rel);
      else if (e.name.toLowerCase().endsWith('.md')) notes.push(rel);
    }
    folders.sort();
    notes.sort();
    return { folders, notes };
  }

  readNote(rel:string):Promise<Note>{return this.readGuard?this.readGuard(()=>this.readNoteUnlocked(rel)):this.readNoteUnlocked(rel);}
  private async readNoteUnlocked(rel: string): Promise<Note> {
    const p = ensureMd(rel);
    const abs = await this.safePath(p);
    let content: string;
    let st;
    try {
      [content, st] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]);
    } catch {
      throw new VaultError(`Note not found: ${rel}`, 'NOT_FOUND');
    }
    return {
      path: normalizeRel(p),
      title: path.posix.basename(normalizeRel(p)).replace(/\.md$/i, ''),
      content,
      mtime: st.mtimeMs,
      size: st.size,
    };
  }

  /** Atomic write (tmp + rename). Creates parent folders. */
  async writeNote(rel: string, content: string, opts: { overwrite?: boolean; expectedHash?: string } = {}): Promise<string> {
    const p = ensureMd(rel);
    const abs = await this.safePath(p);
    if (this.writeBackend) return this.writeBackend.write({ path: normalizeRel(p), content, overwrite: opts.overwrite ?? false, expectedHash: opts.expectedHash });
    if (!opts.overwrite && (await this.exists(p))) {
      throw new VaultError(`Note already exists: ${p}`, 'EXISTS');
    }
    if (opts.expectedHash !== undefined) {
      const existing = await fs.readFile(abs, 'utf8');
      if (createHash('sha256').update(existing).digest('hex') !== opts.expectedHash) throw new VaultError('Note changed while editing', 'INVALID');
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await this.safePath(p);
    const tmp = `${abs}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, content, 'utf8');
      await fs.rename(tmp, abs);
    } finally { await fs.rm(tmp, { force: true }); }
    this.notifyChanged([normalizeRel(p)]);
    return normalizeRel(p);
  }

  /** Create a note, adding " 1", " 2" suffix if the name is taken. */
  async createUnique(rel: string, content: string): Promise<string> {
    const p = ensureMd(rel);
    const base = p.slice(0, -3);
    let candidate = p;
    for (let i = 1; i < 1000; i++) {
      if (!(await this.exists(candidate))) {
        try { return await this.writeNote(candidate, content); }
        catch (e) { if (!(e instanceof VaultError) || e.code !== 'EXISTS') throw e; }
      }
      candidate = `${base} ${i}.md`;
    }
    throw new VaultError(`Cannot find a free name for ${rel}`, 'EXISTS');
  }

  /**
   * Append text to a note. If `section` is given (a heading line like "## Notes"),
   * inserts at the end of that section; if the heading is missing it is created at the end.
   */
  async appendToNote(rel: string, text: string, section?: string): Promise<void> {
    const p = ensureMd(rel);
    const abs = await this.safePath(p);
    let content = '';
    try {
      content = await fs.readFile(abs, 'utf8');
    } catch {
      throw new VaultError(`Note not found: ${rel}`, 'NOT_FOUND');
    }
    const updated = insertIntoSection(content, text, section);
    await this.writeNote(p, updated, { overwrite: true, expectedHash: createHash('sha256').update(content).digest('hex') });
  }

  async findByTitle(title: string): Promise<NoteMeta[]> {
    const wanted = title.trim().toLowerCase().replace(/\.md$/, '');
    const all = await this.listNotes();
    const exact = all.filter((n) => n.title.toLowerCase() === wanted);
    if (exact.length) return exact;
    return all.filter((n) => n.title.toLowerCase().includes(wanted));
  }
}

/** Pure helper: insert text under a heading (or at end). Exported for tests. */
export function insertIntoSection(content: string, text: string, section?: string): string {
  const body = content.replace(/\r\n/g, '\n');
  const block = text.replace(/\s+$/, '');
  if (!section) {
    const trimmed = body.replace(/\s+$/, '');
    return trimmed ? `${trimmed}\n${block}\n` : `${block}\n`;
  }
  const heading = section.trim();
  const level = (/^#+/.exec(heading)?.[0].length) ?? 2;
  const lines = body.split('\n');
  const idx = lines.findIndex((l) => l.trim().toLowerCase() === heading.toLowerCase());
  if (idx === -1) {
    const trimmed = body.replace(/\s+$/, '');
    return `${trimmed ? trimmed + '\n\n' : ''}${heading}\n${block}\n`;
  }
  // find end of section: next heading with level <= current, or EOF
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  // trim trailing blank lines inside the section
  let insertAt = end;
  while (insertAt > idx + 1 && lines[insertAt - 1].trim() === '') insertAt--;
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  const merged = [...before, block, ...(after.length && after[0].trim() !== '' ? [''] : []), ...after];
  let out = merged.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return out;
}
