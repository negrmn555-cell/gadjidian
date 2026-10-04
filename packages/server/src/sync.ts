import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {AsyncLocalStorage} from 'node:async_hooks';
import { DomainError, Vault } from '@relay/core';
import type { ServerConfig } from './config.js';

const run = promisify(execFile);
export interface SyncStatus {
  mode: 'none' | 'git';
  lastPull: number | null;
  lastPush: number | null;
  lastError: string | null;
  pending: boolean;
}

/** One queue owns filesystem mutations AND Git operations for this server process. */
export class GitSync {
  private readonly status: SyncStatus;
  private busy: Promise<void> = Promise.resolve();
  private pushTimer: NodeJS.Timeout | null = null;
  private pullTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;
  private stopped = false;
  private publishObserver?: (head: string) => Promise<void>;
  private readonly scope=new AsyncLocalStorage<{active:boolean}>();
  private readonly vault: Vault;

  constructor(private readonly cfg: ServerConfig, private readonly log: (msg: string) => void = () => {}) {
    this.status = { mode: cfg.sync.mode, lastPull: null, lastPush: null, lastError: null, pending: false };
    this.vault = new Vault(cfg.vault);
  }

  getStatus(): SyncStatus { return { ...this.status }; }
  get mode(): 'none' | 'git' { return this.cfg.sync.mode; }
  onPublished(observer: (head: string) => Promise<void>): void { this.publishObserver = observer; }

  exclusive<T>(work: () => Promise<T>): Promise<T> {
    if(this.scope.getStore()?.active)return work();
    const guarded=()=>{const scope={active:true};return this.scope.run(scope,async()=>{try{return await work();}finally{scope.active=false;}});};
    const next = this.busy.then(guarded, guarded);
    this.busy = next.then(() => undefined, () => undefined);
    return next;
  }

  private git(args: string[]) {
    return run('git', args, {
      cwd: this.cfg.vault.root,
      env: { ...process.env, GIT_AUTHOR_NAME: this.cfg.sync.authorName, GIT_AUTHOR_EMAIL: this.cfg.sync.authorEmail,
        GIT_COMMITTER_NAME: this.cfg.sync.authorName, GIT_COMMITTER_EMAIL: this.cfg.sync.authorEmail, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 16 * 1024 * 1024,
    });
  }

  async start(initialPull = true): Promise<void> {
    this.stopped = false;
    if (this.mode !== 'git') return;
    await this.ensureRepo();
    if (initialPull) await this.pull().catch(() => {});
  }

  startPolling(): void {
    if (this.stopped || this.mode !== 'git' || this.cfg.sync.pullInterval <= 0 || this.pullTimer) return;
    this.pullTimer = setInterval(() => void this.pull().catch(() => {}), this.cfg.sync.pullInterval * 1000);
    this.pullTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.pullTimer) clearInterval(this.pullTimer);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pullTimer = null;
    this.pushTimer = null;
  }

  private async ensureRepo(): Promise<void> {
    await fs.mkdir(this.cfg.vault.root, { recursive: true });
    if (await fs.stat(path.join(this.cfg.vault.root, '.git')).then(() => true).catch(() => false)) return;
    const entries = await fs.readdir(this.cfg.vault.root);
    if (!entries.length && this.cfg.sync.remote) {
      await run('git', ['clone', this.cfg.sync.remote, this.cfg.vault.root], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      if (await this.head()) await this.git(['checkout', this.cfg.sync.branch]);
      else await this.git(['symbolic-ref', 'HEAD', 'refs/heads/' + this.cfg.sync.branch]);
    } else {
      await run('git', ['init', '-b', this.cfg.sync.branch, this.cfg.vault.root]);
      if (this.cfg.sync.remote) await this.git(['remote', 'add', 'origin', this.cfg.sync.remote]);
    }
    await this.git(['config', 'core.autocrlf', 'false']);
    await this.git(['config', 'pull.rebase', 'false']);
  }

  /** These helpers run inside exclusive(); never enqueue them again. */
  async assertWritable(): Promise<void> {
    if (this.mode !== 'git') return;
    const unmerged = (await this.git(['diff', '--name-only', '--diff-filter=U', '-z'])).stdout;
    const mergePath = (await this.git(['rev-parse', '--git-path', 'MERGE_HEAD'])).stdout.trim();
    const merging = await fs.stat(path.resolve(this.cfg.vault.root, mergePath)).then(() => true).catch(() => false);
    if (unmerged || merging) throw new DomainError('SYNC_CONFLICT', 'В Git есть неразрешённый конфликт. Сначала завершите слияние.', 409);
  }

  async head(): Promise<string | null> {
    if (this.mode !== 'git') return null;
    try { return (await this.git(['rev-parse', '--verify', '--quiet', 'HEAD'])).stdout.trim(); }
    catch (e) { if ((e as { code?: number }).code === 1) return null; throw e; }
  }
  async changedPaths(base:string|null,head:string|null):Promise<string[]> {
    if(!head||!base)return [];
    if(!await this.isAncestor(base,head))throw new DomainError('CHECKPOINT_REWRITTEN','История Git изменена. Нужна сверка индекса и новый базовый план.',409);
    return (await this.git(['diff','--name-only','--no-renames','-z',base,head])).stdout.split('\0').filter(Boolean);
  }
  snapshot():Promise<string|null> {return this.exclusive(async()=>{await this.assertWritable();if(this.mode==='git')await this.commitLocal();return this.head();});}
  async conflictPaths():Promise<string[]> {if(this.mode!=='git')return [];return (await this.git(['diff','--name-only','--diff-filter=U','-z'])).stdout.split('\0').filter(Boolean);}
  async conflictStage(p:string,stage:1|2|3):Promise<string|null> {await this.vault.safePath(p);try{return (await this.git(['show',':'+stage+':'+p])).stdout;}catch{return null;}}
  async stageResolution(p:string):Promise<void> {await this.vault.safePath(p);await this.git(['add','--all','--',p]);}
  async mergePaths():Promise<string[]> {if(this.mode!=='git')return [];return (await this.git(['diff','--cached','--name-only','-z'])).stdout.split('\0').filter(Boolean);}
  async finishMerge():Promise<void> {await this.assertNoUnmerged();try{await this.git(['rev-parse','--verify','MERGE_HEAD']);}catch{throw new DomainError('NO_MERGE','Нет активного слияния Git.',409);}await this.git(['commit','--no-edit']);this.status.lastError=null;this.schedulePush();}
  private async assertNoUnmerged():Promise<void>{if((await this.conflictPaths()).length)throw new DomainError('SYNC_CONFLICT','Сначала разрешите все файлы с конфликтом.',409);}

  async findOperationCommit(operationId: string): Promise<string | null> {
    if (this.mode !== 'git' || !(await this.head())) return null;
    const result = await this.git(['log', '-1', '--format=%H', '--grep', '^Relay-Operation-Id: ' + operationId + '$']);
    return result.stdout.trim() || null;
  }

  async isAncestor(commit: string, head: string): Promise<boolean> {
    try { await this.git(['merge-base', '--is-ancestor', commit, head]); return true; }
    catch { return false; }
  }

  async commitPaths(paths: string[], operationId: string): Promise<string | null> {
    if (this.mode !== 'git') return null;
    await this.assertWritable();
    for (const p of paths) await this.vault.safePath(p);
    await this.git(['add', '--', ...paths]);
    await this.git(['commit', '--allow-empty', '--only', '-m', 'relay: vault operation\n\nRelay-Operation-Id: ' + operationId, '--', ...paths]);
    return this.head();
  }

  private async commitLocal(): Promise<void> {
    await this.assertWritable();
    const results = await Promise.all([
      this.git(['diff', '--name-only', '--no-renames', '-z', 'HEAD']).catch(async () => this.git(['diff', '--cached', '--name-only', '-z'])),
      this.git(['ls-files', '--others', '--exclude-standard', '-z']),
    ]);
    const candidates = [...new Set(results.flatMap(r => r.stdout.split('\0').filter(Boolean)))];
    const allowed: string[] = [];
    for (const file of candidates) {
      if (!file.toLowerCase().endsWith('.md')) continue;
      try { await this.vault.safePath(file); allowed.push(file); } catch { /* Never stage private/ignored/unsafe paths. */ }
    }
    if (!allowed.length) return;
    await this.git(['add', '--all', '--', ...allowed]);
    if (!(await this.git(['diff', '--cached', '--name-only', '-z', '--', ...allowed])).stdout) return;
    await this.git(['commit', '--only', '-m', 'relay: external vault changes', '--', ...allowed]);
  }

  private async pullUnlocked(): Promise<void> {
    await this.commitLocal();
    try { await this.git(['pull', '--no-rebase', '--no-edit', 'origin', this.cfg.sync.branch]); }
    catch (e) {
      const msg = (e as { stderr?: string }).stderr ?? '';
      if (!/couldn't find remote ref|no such ref/i.test(msg)) throw e;
    }
  }

  pull(): Promise<void> {
    if (this.mode !== 'git' || !this.cfg.sync.remote) return Promise.resolve();
    return this.exclusive(async () => {
      try {
        await this.pullUnlocked();
        this.status.lastPull = Date.now();
        this.status.lastError = null;
        if (await this.head()) this.schedulePush();
      } catch (e) { this.recordError('pull', e); throw e; }
    });
  }

  schedulePush(delaySeconds = Math.max(1, this.cfg.sync.pushDebounce)): void {
    if (this.stopped || this.mode !== 'git' || !this.cfg.sync.remote) return;
    this.status.pending = true;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.push().catch(() => {}), delaySeconds * 1000);
    this.pushTimer.unref();
  }

  push(): Promise<void> {
    if (this.mode !== 'git' || !this.cfg.sync.remote) return Promise.resolve();
    return this.exclusive(async () => {
      try {
        await this.commitLocal();
        if (!(await this.head())) return;
        try { await this.git(['push', 'origin', 'HEAD:' + this.cfg.sync.branch]); }
        catch { await this.pullUnlocked(); await this.git(['push', 'origin', 'HEAD:' + this.cfg.sync.branch]); }
        this.status.lastPush = Date.now();
        this.status.pending = false;
        this.status.lastError = null;
        this.retryAttempt = 0;
        await this.publishObserver?.((await this.head())!);
      } catch (e) {
        this.recordError('push', e);
        this.status.pending = true;
        if (!(e instanceof DomainError && e.code === 'SYNC_CONFLICT')) {
          this.retryAttempt++;
          this.schedulePush(Math.min(300, Math.max(5, this.cfg.sync.pushDebounce) * 2 ** Math.min(this.retryAttempt, 6)) + Math.random() * 3);
        }
        throw e;
      }
    });
  }

  private recordError(kind: string, e: unknown): void {
    this.status.lastError = e instanceof DomainError ? e.message : 'Ошибка Git. Проверьте подключение и состояние репозитория.';
    this.log(kind + ': ' + this.status.lastError);
  }
}
