import type { DatabaseSync } from 'node:sqlite';
import type { AgentEvent } from '@relay/core';
import { emptyRunStream, reduceRunEvent, finishTools, type ToolProgress } from '@relay/core';

export interface RunEvent { sequence: number; type: string; kind: string; text?: string; [key: string]: unknown }
interface ProfileSnapshot { id: string; version: number; modelId: string }
interface Snapshot { sequence: number; text: string; state: string; engine: string; artifacts: string[]; tools?:ToolProgress[]; status?: string; provider?: ProfileSnapshot | null }
const keyOf = (device: number, chat: string, request: string) => JSON.stringify([device, chat, request]);

/** Same SQLite connection and retention boundary as messages; tokens are flushed in batches. */
export class RunEvents {
  private listeners = new Map<string, Set<(e: RunEvent) => void>>();
  private pending = new Map<string, { text: string; timer: ReturnType<typeof setTimeout>; flush: () => void }>();
  constructor(private db: DatabaseSync, private now = () => Date.now()) {
    db.exec(`CREATE TABLE IF NOT EXISTS run_snapshots(device_id INTEGER NOT NULL,chat TEXT NOT NULL,request_id TEXT NOT NULL,value_json TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(device_id,chat,request_id));
      CREATE TABLE IF NOT EXISTS run_events(device_id INTEGER NOT NULL,chat TEXT NOT NULL,request_id TEXT NOT NULL,sequence INTEGER NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(device_id,chat,request_id,sequence));`);
  }
  begin(device: number, chat: string, request: string, engine: string, expires: number) {
    const snapshot: Snapshot = { sequence: 0, text: '', state: 'running', engine, artifacts: [] };
    this.db.prepare('INSERT INTO run_snapshots VALUES(?,?,?,?,?)').run(device, chat, request, JSON.stringify(snapshot), expires);
    this.append(device, chat, request, { type: 'event', kind: 'run.accepted', engine });
    this.append(device, chat, request, { type: 'event', kind: 'run.started', engine });
  }
  snapshot(device: number, chat: string, request: string): Snapshot | null {
    const r = this.db.prepare('SELECT value_json FROM run_snapshots WHERE device_id=? AND chat=? AND request_id=? AND expires_at>?').get(device, chat, request, this.now()) as { value_json: string } | undefined;
    return r ? JSON.parse(r.value_json) : null;
  }
  bind(device:number,chat:string,request:string,provider:ProfileSnapshot|null) {
    this.append(device,chat,request,{type:'event',kind:'run.bound',provider});
  }
  emit(device: number, chat: string, request: string, event: AgentEvent) {
    const key = keyOf(device, chat, request);
    if (event.type === 'delta') {
      let batch = this.pending.get(key);
      if (!batch) {
        const flush = () => { const b = this.pending.get(key); if (!b) return; clearTimeout(b.timer); this.pending.delete(key); this.append(device, chat, request, { type: 'delta', kind: 'text.delta', text: b.text }); };
        batch = { text: '', timer: setTimeout(flush, 80), flush }; batch.timer.unref(); this.pending.set(key, batch);
      }
      batch.text += event.text ?? '';
      if (batch.text.length >= 1024) batch.flush();
      return;
    }
    this.pending.get(key)?.flush();
    if (event.type === 'done') return; // Completion is published only after the result is committed.
    const kind = event.type === 'tool' ? 'tool.started' : event.type;
    this.append(device, chat, request, { ...event, kind });
  }
  finish(device: number, chat: string, request: string, result: Record<string, unknown>) {
    this.pending.get(keyOf(device, chat, request))?.flush();
    this.append(device, chat, request, { type: 'result', kind: result.outcome === 'cancelled' ? 'run.cancelled' : result.outcome === 'failed' || result.outcome === 'partial' ? 'run.failed' : 'run.completed', ...result });
  }
  private append(device: number, chat: string, request: string, value: Record<string, unknown>) {
    const snapshot = this.snapshot(device, chat, request); if (!snapshot || snapshot.state !== 'running') return;
    const event: RunEvent = { ...value, at:this.now(), type: String(value.type), kind: String(value.kind), sequence: snapshot.sequence + 1, chatId: chat, requestId: request };
    snapshot.tools=reduceRunEvent({...emptyRunStream(),sequence:snapshot.sequence,tools:snapshot.tools??[]},event).tools;
    snapshot.sequence = event.sequence;
    if(event.kind==='run.bound')snapshot.provider=event.provider as ProfileSnapshot|null;
    if (event.kind === 'text.delta') snapshot.text = (snapshot.text + (event.text ?? '')).slice(-128_000);
    if (event.kind === 'status' || event.kind === 'tool.started') snapshot.status = String(event.text ?? '');
    if (event.kind === 'artifact.saved' && typeof event.path === 'string') snapshot.artifacts = [...new Set([...snapshot.artifacts, event.path])];
    if (event.type === 'result') { snapshot.text = String(event.text ?? ''); snapshot.state = String(event.outcome ?? 'success'); }
    if (event.kind === 'run.interrupted') { snapshot.state = 'interrupted'; if(Array.isArray(event.artifacts))snapshot.artifacts=[...new Set([...snapshot.artifacts,...event.artifacts.filter((v):v is string=>typeof v==='string')])]; }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO run_events VALUES(?,?,?,?,?)').run(device, chat, request, event.sequence, JSON.stringify(event));
      this.db.prepare('UPDATE run_snapshots SET value_json=? WHERE device_id=? AND chat=? AND request_id=?').run(JSON.stringify(snapshot), device, chat, request);
      this.db.prepare('DELETE FROM run_events WHERE device_id=? AND chat=? AND request_id=? AND sequence<=?').run(device, chat, request, event.sequence - 512);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    for (const listener of this.listeners.get(keyOf(device, chat, request)) ?? []) { try { listener(event); } catch { /* A disconnected observer must never fail a run. */ } }
  }
  replay(device: number, chat: string, request: string, after: number): RunEvent[] {
    const snapshot = this.snapshot(device, chat, request); if (!snapshot) return [];
    const rows = this.db.prepare('SELECT value_json FROM run_events WHERE device_id=? AND chat=? AND request_id=? AND sequence>? ORDER BY sequence').all(device, chat, request, after) as { value_json: string }[];
    const events = rows.map(r => JSON.parse(r.value_json) as RunEvent);
    if (after > snapshot.sequence || after === 0 || events[0]?.sequence > after + 1) return [{ type: 'snapshot', kind: 'run.snapshot', ...snapshot, chatId: chat, requestId: request }];
    return events;
  }
  subscribe(device: number, chat: string, request: string, listener: (e: RunEvent) => void): () => void {
    const key = keyOf(device, chat, request), set = this.listeners.get(key) ?? new Set();
    set.add(listener); this.listeners.set(key, set);
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(key); };
  }
  terminalTools(device:number,chat:string,request:string,outcome:string):ToolProgress[]{return finishTools(this.snapshot(device,chat,request)?.tools??[],outcome,this.now());}
  recover(artifacts?: (device:number,chat:string,request:string)=>string[]) {
    const rows = this.db.prepare('SELECT device_id,chat,request_id FROM run_snapshots WHERE expires_at>?').all(this.now()) as { device_id: number; chat: string; request_id: string }[];
    for (const r of rows) {
      if (this.snapshot(r.device_id, r.chat, r.request_id)?.state !== 'running') continue;
      const saved = this.db.prepare('SELECT result FROM chat_runs WHERE device_id=? AND chat=? AND request_id=?').get(r.device_id, r.chat, r.request_id) as { result: string | null } | undefined;
      if (saved?.result) this.finish(r.device_id, r.chat, r.request_id, JSON.parse(saved.result));
      else this.append(r.device_id, r.chat, r.request_id, { type: 'event', kind: 'run.interrupted', code: 'SERVER_RESTART', artifacts:artifacts?.(r.device_id,r.chat,r.request_id)??[] });
    }
  }
  prune() {
    this.db.prepare('DELETE FROM run_snapshots WHERE expires_at<=?').run(this.now());
    this.db.exec('DELETE FROM run_events WHERE NOT EXISTS(SELECT 1 FROM run_snapshots s WHERE s.device_id=run_events.device_id AND s.chat=run_events.chat AND s.request_id=run_events.request_id)');
  }
  close() { for (const b of this.pending.values()) b.flush(); this.listeners.clear(); }
}
