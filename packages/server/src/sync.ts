import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ServerConfig } from './config.js';

const run = promisify(execFile);

export interface SyncStatus {
  mode: 'none' | 'git';
  lastPull: number | null;
  lastPush: number | null;
  lastError: string | null;
  pending: boolean;
}

/**
 * Keeps the server-side vault copy in sync with a git remote.
 * PC side: obsidian-git plugin (auto commit/push/pull). Server side: this class.
 * When the PC is off nothing breaks — the server commits to the remote and the PC pulls later.
 */
export class GitSync {
  private status: SyncStatus;
  private pushTimer: NodeJS.Timeout | null = null;
  private pullTimer: NodeJS.Timeout | null = null;
  private busy: Promise<void> = Promise.resolve();
  private readonly log: (msg: string) => void;

  constructor(private readonly cfg: ServerConfig, log?: (msg: string) => void) {
    this.status = { mode: cfg.sync.mode, lastPull: null, lastPush: null, lastError: null, pending: false };
    this.log = log ?? (() => {});
  }

  getStatus(): SyncStatus {
    return { ...this.status };
  }

  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return run('git', args, {
      cwd: this.cfg.vault.root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: this.cfg.sync.authorName,
        GIT_AUTHOR_EMAIL: this.cfg.sync.authorEmail,
        GIT_COMMITTER_NAME: this.cfg.sync.authorName,
        GIT_COMMITTER_EMAIL: this.cfg.sync.authorEmail,
        GIT_TERMINAL_PROMPT: '0',
      },
      maxBuffer: 16 * 1024 * 1024,
    });
  }

  /** Serialise git operations. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.busy.then(fn, fn);
    this.busy = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  async start(): Promise<void> {
    if (this.cfg.sync.mode !== 'git') return;
    await this.ensureRepo();
    await this.pull().catch(() => {});
    if (this.cfg.sync.pullInterval > 0) {
      this.pullTimer = setInterval(() => void this.pull().catch(() => {}), this.cfg.sync.pullInterval * 1000);
      this.pullTimer.unref();
    }
  }

  stop(): void {
    if (this.pullTimer) clearInterval(this.pullTimer);
    if (this.pushTimer) clearTimeout(this.pushTimer);
  }

  private async ensureRepo(): Promise<void> {
    const root = this.cfg.vault.root;
    await fs.mkdir(root, { recursive: true });
    const hasGit = await fs
      .stat(path.join(root, '.git'))
      .then(() => true)
      .catch(() => false);
    if (hasGit) return;
    const entries = await fs.readdir(root);
    if (entries.length === 0 && this.cfg.sync.remote) {
      this.log(`cloning ${this.cfg.sync.remote} -> ${root}`);
      await run('git', ['clone', '--branch', this.cfg.sync.branch, this.cfg.sync.remote, root], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }).catch(async (e: Error) => {
        // Empty remote: init and set remote
        this.log(`clone failed (${e.message.split('\n')[0]}), initialising empty repo`);
        await run('git', ['init', '-b', this.cfg.sync.branch, root]);
        await this.git(['remote', 'add', 'origin', this.cfg.sync.remote]);
      });
    } else {
      await run('git', ['init', '-b', this.cfg.sync.branch, root]);
      if (this.cfg.sync.remote) await this.git(['remote', 'add', 'origin', this.cfg.sync.remote]);
    }
    await this.git(['config', 'core.autocrlf', 'false']);
    await this.git(['config', 'pull.rebase', 'false']);
  }

  /** Commit local changes (if any) then pull with merge; conflicts are resolved keeping both sides where possible. */
  pull(): Promise<void> {
    if (this.cfg.sync.mode !== 'git' || !this.cfg.sync.remote) return Promise.resolve();
    return this.enqueue(async () => {
      try {
        await this.commitLocal('relay: local changes');
        try {
          await this.git(['pull', '--no-rebase', '--no-edit', 'origin', this.cfg.sync.branch]);
        } catch (e) {
          const msg = (e as { stderr?: string; message: string }).stderr ?? (e as Error).message;
          if (/CONFLICT/i.test(msg)) {
            this.log('merge conflict — keeping both versions');
            // Keep our version for conflicted files and also save theirs as *.sync-conflict.md
            const { stdout } = await this.git(['diff', '--name-only', '--diff-filter=U']);
            for (const file of stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
              const theirs = await this.git(['show', `:3:${file}`]).then((r) => r.stdout).catch(() => '');
              await this.git(['checkout', '--ours', '--', file]);
              if (theirs) {
                const conflictName = file.replace(/\.md$/i, '') + `.sync-conflict-${new Date().toISOString().slice(0, 10)}.md`;
                await fs.writeFile(path.join(this.cfg.vault.root, conflictName), theirs, 'utf8');
                await this.git(['add', '--', conflictName]);
              }
              await this.git(['add', '--', file]);
            }
            await this.git(['commit', '--no-edit', '-m', 'relay: merge with conflicts kept']);
          } else if (/couldn't find remote ref|no such ref/i.test(msg)) {
            // remote branch does not exist yet — fine
          } else {
            throw e;
          }
        }
        this.status.lastPull = Date.now();
        this.status.lastError = null;
      } catch (e) {
        this.status.lastError = shortErr(e);
        this.log(`pull error: ${this.status.lastError}`);
        throw e;
      }
    });
  }

  private async commitLocal(message: string): Promise<boolean> {
    await this.git(['add', '-A']);
    const { stdout } = await this.git(['status', '--porcelain']);
    if (!stdout.trim()) return false;
    await this.git(['commit', '-q', '-m', message]);
    return true;
  }

  /** Schedule a commit+push shortly after a write (debounced). */
  schedulePush(): void {
    if (this.cfg.sync.mode !== 'git') return;
    this.status.pending = true;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.push().catch(() => {}), this.cfg.sync.pushDebounce * 1000);
    this.pushTimer.unref();
  }

  push(): Promise<void> {
    if (this.cfg.sync.mode !== 'git') return Promise.resolve();
    return this.enqueue(async () => {
      try {
        await this.commitLocal('relay: note from phone');
        if (this.cfg.sync.remote) {
          try {
            await this.git(['push', 'origin', `HEAD:${this.cfg.sync.branch}`]);
          } catch {
            // remote moved on: pull (merge) then push again
            await this.git(['pull', '--no-rebase', '--no-edit', 'origin', this.cfg.sync.branch]).catch(() => {});
            await this.git(['push', 'origin', `HEAD:${this.cfg.sync.branch}`]);
          }
        }
        this.status.lastPush = Date.now();
        this.status.pending = false;
        this.status.lastError = null;
      } catch (e) {
        this.status.lastError = shortErr(e);
        this.log(`push error: ${this.status.lastError}`);
        throw e;
      }
    });
  }
}

function shortErr(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  const text = (err.stderr || err.message || String(e)).trim();
  return text.split('\n').slice(-2).join(' ').slice(0, 300);
}
