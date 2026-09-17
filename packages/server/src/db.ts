import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static async open(file: string): Promise<Db> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pairing_codes (
        code TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'app',
        folder TEXT,
        created_at INTEGER NOT NULL,
        last_seen INTEGER,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER NOT NULL,
        chat TEXT NOT NULL DEFAULT 'main',
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        meta TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(device_id, chat, id);
    `);
    return new Db(db);
  }

  // ---- settings ----
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
    const res = this.db
      .prepare('INSERT INTO messages(device_id, chat, role, content, meta, created_at) VALUES(?, ?, ?, ?, ?, ?)')
      .run(deviceId, chat, role, content, meta === undefined ? null : JSON.stringify(meta), Date.now());
    return Number(res.lastInsertRowid);
  }

  listMessages(deviceId: number, chat: string, limit = 50, beforeId?: number): StoredMessage[] {
    const rows = (
      beforeId
        ? this.db
            .prepare('SELECT * FROM messages WHERE device_id = ? AND chat = ? AND id < ? ORDER BY id DESC LIMIT ?')
            .all(deviceId, chat, beforeId, limit)
        : this.db.prepare('SELECT * FROM messages WHERE device_id = ? AND chat = ? ORDER BY id DESC LIMIT ?').all(deviceId, chat, limit)
    ) as { id: number; device_id: number; chat: string; role: 'user' | 'assistant'; content: string; meta: string | null; created_at: number }[];
    return rows
      .reverse()
      .map((r) => ({ id: r.id, deviceId: r.device_id, chat: r.chat, role: r.role, content: r.content, meta: r.meta, createdAt: r.created_at }));
  }

  clearMessages(deviceId: number, chat: string): void {
    this.db.prepare('DELETE FROM messages WHERE device_id = ? AND chat = ?').run(deviceId, chat);
  }

  /** Drop messages older than N days (privacy hygiene). */
  pruneMessages(days = 30): void {
    this.db.prepare('DELETE FROM messages WHERE created_at < ?').run(Date.now() - days * 86_400_000);
  }
}
