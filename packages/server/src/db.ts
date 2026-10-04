import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ChatStore } from './chat-store.js';
import { migrate } from './migrations.js';

export interface VaultOperation {
  operationId: string;
  requestHash: string;
  path: string;
  baseHash: string | null;
  contentHash: string;
  payload: string | null;
  state: 'prepared' | 'saved_local' | 'committed' | 'synced' | 'conflict';
  commitSha: string | null;
  errorCode: string | null;
}
export interface VaultBatch {
  operationId:string; requestHash:string; files:{path:string;baseHash:string|null;contentHash:string;base64:string|null;delete?:boolean}[];
  result:unknown; state:VaultOperation['state']; commitSha:string|null; errorCode:string|null;
}

export interface Device {
  id: number;
  name: string;
  kind: 'app' | 'quick';
  createdAt: number;
  lastSeen: number | null;
  folder: string | null;
}

export interface StoredMessage {
  id: number;
  deviceId: number;
  chat: string;
  role: 'user' | 'assistant';
  content: string;
  meta: string | null;
  createdAt: number;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateCode(len = 12): string {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

export function generateToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

export class Db {
  private db: DatabaseSync;
  get sql(): DatabaseSync { return this.db; }

  private constructor(db: DatabaseSync, readonly chats: ChatStore) {
    this.db = db;
  }

  static async open(file: string): Promise<Db> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;');
      migrate(db);
      const chats = new ChatStore(path.join(path.dirname(file), path.basename(file, path.extname(file)) + '.chats.sqlite'));
      try {
        // Copy before dropping. Repeating after a crash is safe because IDs are preserved.
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get()) {
          const rows = db.prepare('SELECT * FROM messages').all() as Record<string, unknown>[];
          chats.importLegacy(rows.map(r => ({ id: Number(r.id), deviceId: Number(r.device_id), chat: String(r.chat), role: r.role as StoredMessage['role'], content: String(r.content), meta: r.meta as string | null, createdAt: Number(r.created_at) })));
          db.exec('DROP TABLE messages; PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
        }
        return new Db(db, chats);
      } catch (e) { chats.close(); throw e; }
    } catch (e) { db.close(); throw e; }
  }

  // ---- settings ----
  providerTransaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  providerRows(): { id: string; slot: 'chat' | 'organizer'; version: number; config: string; secret: string | null; testResult: string | null }[] {
    return this.db.prepare(`SELECT p.id, p.slot, p.current_version AS version, v.config_json AS config, v.encrypted_secret AS secret, v.test_result_json AS testResult
      FROM providers p JOIN provider_versions v ON v.provider_id = p.id AND v.version = p.current_version ORDER BY p.created_at, p.id`)
      .all() as ReturnType<Db['providerRows']>;
  }

  saveProvider(id: string, slot: 'chat' | 'organizer', version: number, config: string, secret: string | null): void {
    this.db.prepare('INSERT INTO providers(id, slot, current_version, created_at) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET current_version = excluded.current_version')
      .run(id, slot, version, Date.now());
    this.db.prepare('INSERT INTO provider_versions(provider_id, version, config_json, encrypted_secret, created_at) VALUES(?, ?, ?, ?, ?)')
      .run(id, version, config, secret, Date.now());
  }

  removeProvider(id: string): void { this.db.prepare('DELETE FROM providers WHERE id = ?').run(id); }
  saveProviderTest(id: string, version: number, result: string): void {
    this.db.prepare('UPDATE provider_versions SET test_result_json = ? WHERE provider_id = ? AND version = ?').run(result, id, version);
  }
  pruneProviderVersions(live: Set<string>): void {
    const rows = this.db.prepare('SELECT v.provider_id, v.version FROM provider_versions v JOIN providers p ON p.id = v.provider_id WHERE v.version <> p.current_version').all() as { provider_id: string; version: number }[];
    const remove = this.db.prepare('DELETE FROM provider_versions WHERE provider_id = ? AND version = ?');
    for (const r of rows) if (!live.has(r.provider_id + ':' + r.version)) remove.run(r.provider_id, r.version);
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---- pairing ----
  createPairingCode(ttlMs = 15 * 60_000): { code: string; expiresAt: number } {
    const code = generateCode();
    const now = Date.now();
    this.db.prepare('DELETE FROM pairing_codes WHERE expires_at < ? OR used_at IS NOT NULL').run(now);
    this.db.prepare('INSERT INTO pairing_codes(code, created_at, expires_at) VALUES(?, ?, ?)').run(code, now, now + ttlMs);
    return { code, expiresAt: now + ttlMs };
  }

  activePairingCode(): { code: string; expiresAt: number } | null {
    const row = this.db
      .prepare('SELECT code, expires_at FROM pairing_codes WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1')
      .get(Date.now()) as { code: string; expires_at: number } | undefined;
    return row ? { code: row.code, expiresAt: row.expires_at } : null;
  }

  resetPairingCodes(): void {
    this.db.prepare('DELETE FROM pairing_codes').run();
  }

  /** Consume a code and create an app device. Returns token or null if code invalid. */
  redeemCode(code: string, deviceName: string): { token: string; device: Device } | null {
    const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const formatted = `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8, 12)}`;
    const now = Date.now();
    const row = this.db
      .prepare('SELECT code FROM pairing_codes WHERE code = ? AND used_at IS NULL AND expires_at > ?')
      .get(formatted, now) as { code: string } | undefined;
    if (!row) return null;
    this.db.prepare('UPDATE pairing_codes SET used_at = ? WHERE code = ?').run(now, formatted);
    return this.createDevice(deviceName, 'app');
  }

  // ---- devices ----
  createDevice(name: string, kind: 'app' | 'quick', folder?: string): { token: string; device: Device } {
    const token = generateToken(kind === 'quick' ? 'qk' : 'dv');
    const now = Date.now();
    const res = this.db
      .prepare('INSERT INTO devices(token_hash, name, kind, folder, created_at) VALUES(?, ?, ?, ?, ?)')
      .run(hashToken(token), name.slice(0, 80) || kind, kind, folder ?? null, now);
    const device: Device = { id: Number(res.lastInsertRowid), name, kind, createdAt: now, lastSeen: null, folder: folder ?? null };
    return { token, device };
  }

  findDevice(token: string): Device | null {
    const row = this.db
      .prepare('SELECT id, name, kind, folder, created_at, last_seen FROM devices WHERE token_hash = ? AND revoked_at IS NULL')
      .get(hashToken(token)) as { id: number; name: string; kind: 'app' | 'quick'; folder: string | null; created_at: number; last_seen: number | null } | undefined;
    if (!row) return null;
    return { id: row.id, name: row.name, kind: row.kind, folder: row.folder, createdAt: row.created_at, lastSeen: row.last_seen };
  }

  touchDevice(id: number): void {
    this.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(Date.now(), id);
  }

  listDevices(): Device[] {
    const rows = this.db
      .prepare('SELECT id, name, kind, folder, created_at, last_seen FROM devices WHERE revoked_at IS NULL ORDER BY id')
      .all() as { id: number; name: string; kind: 'app' | 'quick'; folder: string | null; created_at: number; last_seen: number | null }[];
    return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, folder: r.folder, createdAt: r.created_at, lastSeen: r.last_seen }));
  }

  revokeDevice(id: number): boolean {
    const res = this.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id);
    return res.changes > 0;
  }

  revokeAll(): number {
    return Number(this.db.prepare('UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL').run(Date.now()).changes);
  }

  // ---- messages ----
  addMessage(deviceId: number, chat: string, role: 'user' | 'assistant', content: string, meta?: unknown): number {
    return this.chats.add(deviceId, chat, role, content, meta);
  }

  listMessages(deviceId: number, chat: string, limit = 50, beforeId?: number): StoredMessage[] {
    return this.chats.list(deviceId, chat, limit, beforeId);
  }

  clearMessages(deviceId: number, chat: string): void {
    this.chats.clear(deviceId, chat);
  }

  /** Drop messages older than N days (privacy hygiene). */
  pruneMessages(): void {
    this.chats.prune();
    this.db.prepare("UPDATE vault_operations SET payload = NULL WHERE state IN ('saved_local', 'committed', 'synced', 'conflict') AND updated_at <= ?").run(Date.now() - 14 * 86_400_000);
  }

  getOperation(id: string): VaultOperation | null {
    const r = this.db.prepare('SELECT * FROM vault_operations WHERE operation_id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? {
      operationId: String(r.operation_id), requestHash: String(r.request_hash), path: String(r.path),
      baseHash: r.base_hash as string | null, contentHash: String(r.content_hash), payload: r.payload as string | null,
      state: r.state as VaultOperation['state'], commitSha: r.commit_sha as string | null, errorCode: r.error_code as string | null,
    } : null;
  }

  prepareOperation(op: VaultOperation): void {
    const now = Date.now();
    this.db.prepare('INSERT INTO vault_operations(operation_id, request_hash, path, base_hash, content_hash, payload, state, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(op.operationId, op.requestHash, op.path, op.baseHash, op.contentHash, op.payload, op.state, now, now);
  }

  updateOperation(id: string, state: VaultOperation['state'], commitSha: string | null = null, errorCode: string | null = null): void {
    this.db.prepare('UPDATE vault_operations SET state = ?, commit_sha = COALESCE(?, commit_sha), error_code = ?, updated_at = ? WHERE operation_id = ?')
      .run(state, commitSha, errorCode, Date.now(), id);
    if (state === 'synced' || state === 'saved_local') this.db.prepare('UPDATE vault_operations SET payload = NULL WHERE operation_id = ?').run(id);
  }

  operationsIn(states: VaultOperation['state'][]): VaultOperation[] {
    const rows = this.db.prepare('SELECT operation_id FROM vault_operations WHERE state IN (' + states.map(() => '?').join(',') + ') ORDER BY created_at, rowid').all(...states) as { operation_id: string }[];
    return rows.map(r => this.getOperation(r.operation_id)!);
  }

  close(): void {
    this.chats.close();
    this.db.close();
  }
  getBatch(id:string):VaultBatch|null {
    const r=this.db.prepare('SELECT * FROM vault_batches WHERE operation_id=?').get(id) as Record<string,unknown>|undefined;
    return r?{operationId:String(r.operation_id),requestHash:String(r.request_hash),files:JSON.parse(String(r.files_json)),result:JSON.parse(String(r.result_json)),state:r.state as VaultBatch['state'],commitSha:r.commit_sha as string|null,errorCode:r.error_code as string|null}:null;
  }
  batchesIn(states:VaultBatch['state'][]):VaultBatch[] {
    return (this.db.prepare('SELECT operation_id FROM vault_batches WHERE state IN ('+states.map(()=>'?').join(',')+') ORDER BY created_at,rowid').all(...states) as {operation_id:string}[]).map(r=>this.getBatch(r.operation_id)!);
  }
  prepareBatch(b:VaultBatch):void {const now=Date.now();this.db.prepare('INSERT INTO vault_batches VALUES(?,?,?,?,?,?,?,?,?)').run(b.operationId,b.requestHash,JSON.stringify(b.files),JSON.stringify(b.result),b.state,b.commitSha,b.errorCode,now,now);}
  updateBatch(id:string,state:VaultBatch['state'],sha:string|null=null,error:string|null=null):void {
    const b=this.getBatch(id)!;
    if(state!=='prepared' && state!=='conflict')b.files=b.files.map(f=>({...f,base64:null}));
    this.db.prepare('UPDATE vault_batches SET state=?,commit_sha=COALESCE(?,commit_sha),error_code=?,files_json=?,updated_at=? WHERE operation_id=?').run(state,sha,error,JSON.stringify(b.files),Date.now(),id);
  }
}
