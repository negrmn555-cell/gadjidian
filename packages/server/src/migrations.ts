import type { DatabaseSync } from 'node:sqlite';

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pairing_codes (
        code TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'app', folder TEXT, created_at INTEGER NOT NULL, last_seen INTEGER, revoked_at INTEGER
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE vault_operations (
        operation_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        path TEXT NOT NULL,
        base_hash TEXT,
        content_hash TEXT NOT NULL,
        payload TEXT,
        state TEXT NOT NULL CHECK(state IN ('prepared', 'saved_local', 'committed', 'synced', 'conflict')),
        commit_sha TEXT,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_operations_state ON vault_operations(state);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE providers (
        id TEXT PRIMARY KEY, slot TEXT NOT NULL CHECK(slot IN ('chat', 'organizer')),
        current_version INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_single_organizer ON providers(slot) WHERE slot = 'organizer';
      CREATE TABLE provider_versions (
        provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, config_json TEXT NOT NULL, encrypted_secret TEXT, test_result_json TEXT,
        created_at INTEGER NOT NULL, PRIMARY KEY(provider_id, version)
      );
    `,
  },
  {
    version: 4,
    sql: `CREATE TABLE vault_batches (
      operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, files_json TEXT NOT NULL,
      result_json TEXT NOT NULL, state TEXT NOT NULL, commit_sha TEXT, error_code TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); CREATE INDEX idx_batches_state ON vault_batches(state);`,
  },
  { version:5,sql:`
    CREATE TABLE note_index(path TEXT PRIMARY KEY,note_id TEXT,content_hash TEXT NOT NULL,semantic_hash TEXT NOT NULL,value_json TEXT NOT NULL);
    CREATE INDEX note_index_id ON note_index(note_id);
    CREATE TABLE note_links(from_path TEXT NOT NULL,target_path TEXT,ambiguous INTEGER NOT NULL);
    CREATE INDEX note_links_target ON note_links(target_path);
    CREATE TABLE task_projection(task_id TEXT NOT NULL,path TEXT PRIMARY KEY,value_json TEXT NOT NULL);
    CREATE TABLE jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,dedupe_key TEXT UNIQUE NOT NULL,scheduled_for INTEGER NOT NULL,settings_version INTEGER NOT NULL,state TEXT NOT NULL,payload_json TEXT NOT NULL,result_json TEXT,attempt INTEGER NOT NULL DEFAULT 0,lease_owner TEXT,lease_until INTEGER,fencing_token INTEGER NOT NULL DEFAULT 0,last_error TEXT,created_at INTEGER NOT NULL);
    CREATE INDEX jobs_due ON jobs(state,scheduled_for);
    CREATE TABLE organizer_runs(id TEXT PRIMARY KEY,input_head TEXT,policy_version INTEGER NOT NULL,state TEXT NOT NULL,plan_json TEXT NOT NULL,result_json TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE organizer_cache(path TEXT NOT NULL,semantic_hash TEXT NOT NULL,policy_version INTEGER NOT NULL,patch_json TEXT NOT NULL,PRIMARY KEY(path,semantic_hash,policy_version));
    CREATE TABLE request_tombstones(device_id INTEGER NOT NULL,chat_id TEXT NOT NULL,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,state TEXT NOT NULL,artifacts_json TEXT NOT NULL DEFAULT '[]',created_at INTEGER NOT NULL,PRIMARY KEY(device_id,chat_id,request_id));
    CREATE TABLE push_subscriptions(id TEXT PRIMARY KEY,device_id INTEGER NOT NULL,encrypted_json TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE notifications(id TEXT PRIMARY KEY,dedupe_key TEXT UNIQUE NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,result_json TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE notification_reads(notification_id TEXT NOT NULL,device_id INTEGER NOT NULL,PRIMARY KEY(notification_id,device_id));
    CREATE TABLE push_deliveries(notification_id TEXT NOT NULL,subscription_id TEXT NOT NULL,state TEXT NOT NULL,error_code TEXT,PRIMARY KEY(notification_id,subscription_id));
    CREATE TABLE git_resolutions(operation_id TEXT PRIMARY KEY,path TEXT NOT NULL,expected_hash TEXT,result_hash TEXT,payload TEXT,state TEXT NOT NULL,created_at INTEGER NOT NULL);
  `},
  {version:6,sql:`ALTER TABLE request_tombstones ADD COLUMN outcome TEXT; ALTER TABLE request_tombstones ADD COLUMN error_code TEXT;`},
  {version:7,sql:`CREATE TABLE search_changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,path TEXT NOT NULL); CREATE TABLE search_checkpoint(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,versions TEXT NOT NULL,updated_at INTEGER NOT NULL);`},
  {version:8,sql:`CREATE TABLE mcp_keys(id TEXT PRIMARY KEY,device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,token_hash TEXT UNIQUE NOT NULL,name TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,last_seen INTEGER,revoked_at INTEGER); CREATE INDEX mcp_keys_device ON mcp_keys(device_id);`},
];

export function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON; CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const migration of migrations) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(migration.version)) {
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(migration.version, Date.now());
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}
