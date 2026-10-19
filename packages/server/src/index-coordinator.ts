import { CHUNKER_VERSION, PARSER_VERSION, getSearchIndex, withoutMeasurements, type Vault } from '@relay/core';
import type { Db } from './db.js';
import type { NoteIndex } from './note-index.js';

/** Durable hints are acknowledged only after a complete projection revision. */
export class IndexCoordinator {
  private timer?: NodeJS.Timeout;
  private wake?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = false;
  private readonly unsubscribe: () => void;
  constructor(private readonly vault: Vault, private readonly db: Db, private readonly index: NoteIndex) {
    this.unsubscribe = vault.onChange(paths => {
      if (this.stopped) return;
      this.db.providerTransaction(() => { for (const p of paths?.length ? paths : ['*']) this.db.sql.prepare('INSERT INTO search_changes(path) VALUES(?)').run(p); });
      if (!this.wake) { this.wake = setTimeout(() => { this.wake = undefined; void this.flush().catch(() => {}); }, 100); this.wake.unref(); }
    });
  }
  async start(): Promise<void> {
    getSearchIndex(this.vault).startWatching();
    await this.flush(true);
    this.timer = setInterval(() => void this.flush().catch(() => {}), 30_000); this.timer.unref();
  }
  flush(force = false): Promise<void> {
    return withoutMeasurements(()=>this.flushInternal(force));
  }
  private flushInternal(force:boolean):Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.active) return this.active.then(() => force ? this.flush(true) : undefined);
    this.active = this.vault.readConsistent(async () => {
      const changes = this.db.sql.prepare('SELECT sequence,path FROM search_changes ORDER BY sequence').all() as {sequence:number;path:string}[];
      const search = getSearchIndex(this.vault);
      if (changes.some(c => c.path === '*')) search.invalidate(); else if (changes.length) search.invalidate(changes.map(c => c.path));
      await this.index.refresh(force);
      this.db.providerTransaction(() => {
        this.db.sql.prepare('INSERT INTO search_checkpoint VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,versions=excluded.versions,updated_at=excluded.updated_at').run(search.revision, JSON.stringify({schema:1,parser:PARSER_VERSION,chunker:CHUNKER_VERSION,tokenizer:'orama-3.1.18-russian'}), Date.now());
        if (changes.length) this.db.sql.prepare('DELETE FROM search_changes WHERE sequence<=?').run(changes.at(-1)!.sequence);
      });
    }).finally(() => { this.active = undefined; });
    return this.active;
  }
  status() { return { revision: getSearchIndex(this.vault).revision, pendingChanges: (this.db.sql.prepare('SELECT COUNT(*) AS n FROM search_changes').get() as {n:number}).n }; }
  async stop(): Promise<void> { this.stopped = true; this.unsubscribe(); if (this.timer) clearInterval(this.timer); if (this.wake) clearTimeout(this.wake); await this.active; }
}
