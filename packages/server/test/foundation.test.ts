import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { Vault, DomainError, hashContent } from '@relay/core';
import { Db } from '../src/db.js';
import { ChatStore, CHAT_RETENTION_MS } from '../src/chat-store.js';
import { loadConfig } from '../src/config.js';
import { GitSync } from '../src/sync.js';
import { VaultMutationService, fingerprint } from '../src/vault-mutations.js';
import { TaskService } from '../src/tasks.js';
import { createServer } from '../src/index.js';

const run = promisify(execFile);
const taskInput = { title: 'Тестовая задача', description: 'Текст', category: 'work', priority: 'high', deadline: { kind: 'by_date', date: '2026-10-05', timezone: 'Europe/Moscow' } };

async function fixture(t: { after: (fn: () => Promise<void>) => void }, git = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-v2-'));
  const cfg = loadConfig();
  cfg.dataDir = root;
  cfg.dbPath = path.join(root, 'relay.sqlite');
  cfg.providers.keyFile = path.join(root, 'secrets', 'provider-master.key');
  cfg.llm.apiKey = '';
  cfg.vault.root = path.join(root, 'vault');
  cfg.vault.privateFolders = ['Private'];
  cfg.staticDir = path.join(root, 'no-static');
  cfg.scenariosFile = path.join(root, 'no-scenarios.json');
  cfg.sync = { ...cfg.sync, mode: git ? 'git' : 'none', remote: '', pullInterval: 0, branch: 'main', pushDebounce: 3600 };
  cfg.requireStandalone = false;
  await fs.mkdir(cfg.vault.root);
  const db = await Db.open(cfg.dbPath);
  const vault = new Vault(cfg.vault);
  const sync = new GitSync(cfg);
  const mutations = new VaultMutationService(vault, db, sync);
  vault.setWriteBackend(mutations);
  await sync.start(false);
  const tasks = new TaskService(vault, mutations);
  t.after(async () => {
    sync.stop(); db.close();
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('relay-v2-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, cfg, db, vault, sync, mutations, tasks };
}

test('idempotent concurrent task creates yield one Markdown, different request body is rejected', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 5 }, () => f.tasks.create(taskInput, 'create-operation-1')));
  assert.equal(new Set(results.map(r => r.task.id)).size, 1);
  assert.equal((await f.vault.listNotes()).length, 1);
  assert.equal(f.db.operationsIn(['saved_local']).length, 1);
  await assert.rejects(f.tasks.create({ ...taskInput, title: 'Другой текст' }, 'create-operation-1'), (e: unknown) => e instanceof DomainError && e.code === 'IDEMPOTENCY_KEY_REUSED');
});

test('optimistic update preserves external Obsidian edits and does not create invalid tasks', async t => {
  const f = await fixture(t);
  const original = await f.tasks.create(taskInput, 'create-operation-2');
  const abs = f.vault.resolve(original.task.path);
  await fs.appendFile(abs, '\nПравка из Obsidian');
  await assert.rejects(f.tasks.update(original.task.id, { status: 'done' }, original.task.contentHash, 'update-operation-2'), /изменилась/);
  assert.match(await fs.readFile(abs, 'utf8'), /Правка из Obsidian/);
  await assert.rejects(f.tasks.create({ ...taskInput, deadline: undefined }, 'missing-deadline-1'), /срок/);
  assert.equal((await f.tasks.list()).items[0].status, 'todo');
});

test('generic writer enforces task validation and blocks private/ignored/absolute paths', async t => {
  const f = await fixture(t);
  const original = await f.tasks.create(taskInput, 'create-operation-3');
  const note = await f.vault.readNote(original.task.path);
  await assert.rejects(f.vault.writeNote(note.path, note.content.replace('status: todo', 'status: done'), { overwrite: true, expectedHash: hashContent(note.content) }), /не согласованы/);
  await assert.rejects(f.vault.writeNote('private/secret.md', 'secret'), /private/);
  await assert.rejects(f.vault.writeNote('.git/key.md', 'secret'), /ignored/);
  await assert.rejects(f.vault.writeNote(path.join(f.root, 'escape.md'), 'secret'), /Absolute/);
});

test('restart recovery after rename-before-commit finishes exactly one operation', async t => {
  const f = await fixture(t, true);
  const commit = f.sync.commitPaths.bind(f.sync);
  f.sync.commitPaths = async () => { throw new Error('simulated crash before commit'); };
  await assert.rejects(f.tasks.create(taskInput, 'crash-before-commit'), /simulated/);
  assert.equal(f.db.operationsIn(['prepared']).length, 1);
  f.sync.commitPaths = commit;
  await f.mutations.recoverIncomplete();
  const retry = await f.tasks.create(taskInput, 'crash-before-commit');
  assert.equal(retry.receipt.state, 'committed');
  assert.equal((await f.vault.listNotes()).length, 1);
  assert.equal((await run('git', ['rev-list', '--count', 'HEAD'], { cwd: f.cfg.vault.root })).stdout.trim(), '1');
});

test('restart recovery after Git commit does not overwrite later edits or commit twice', async t => {
  const f = await fixture(t, true);
  const update = f.db.updateOperation.bind(f.db);
  f.db.updateOperation = (id, state, sha, error) => { if (state === 'committed') throw new Error('simulated DB crash'); update(id, state, sha, error); };
  await assert.rejects(f.tasks.create(taskInput, 'crash-after-commit'), /simulated/);
  const note = (await f.vault.listNotes())[0];
  await fs.appendFile(f.vault.resolve(note.path), '\nПоздняя правка');
  f.db.updateOperation = update;
  await f.mutations.recoverIncomplete();
  await f.tasks.create(taskInput, 'crash-after-commit');
  assert.match((await f.vault.readNote(note.path)).content, /Поздняя правка/);
  assert.equal((await run('git', ['rev-list', '--count', 'HEAD'], { cwd: f.cfg.vault.root })).stdout.trim(), '1');
});

test('operation commits leave unrelated staged files out of the commit', async t => {
  const f = await fixture(t, true);
  await fs.writeFile(path.join(f.cfg.vault.root, 'unrelated.txt'), 'unrelated');
  await run('git', ['add', 'unrelated.txt'], { cwd: f.cfg.vault.root });
  await f.tasks.create(taskInput, 'scoped-operation-1');
  const files = (await run('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: f.cfg.vault.root })).stdout;
  assert.doesNotMatch(files, /unrelated/);
  const staged = (await run('git', ['diff', '--cached', '--name-only'], { cwd: f.cfg.vault.root })).stdout;
  assert.match(staged, /unrelated.txt/);
});

test('operation commit lookup matches the exact ID rather than a prefix', async t => {
  const f = await fixture(t, true);
  await f.tasks.create(taskInput, 'operation-prefix-long');
  await f.tasks.create(taskInput, 'operation-prefix');
  assert.equal((await f.tasks.list()).items.length, 2);
  assert.equal((await run('git', ['rev-list', '--count', 'HEAD'], { cwd: f.cfg.vault.root })).stdout.trim(), '2');
});

test('failed publish keeps the local commit and a later push marks the operation synced', async t => {
  const f = await fixture(t, true);
  const remote = path.join(f.root, 'remote.git');
  const unavailable = path.join(f.root, 'unavailable.git');
  await run('git', ['init', '--bare', '-b', 'main', remote]);
  f.cfg.sync.remote = remote;
  await run('git', ['remote', 'add', 'origin', remote], { cwd: f.cfg.vault.root });
  await f.sync.pull();
  await run('git', ['remote', 'set-url', 'origin', unavailable], { cwd: f.cfg.vault.root });
  const created = await f.tasks.create(taskInput, 'publish-retry-operation');
  assert.equal(created.receipt.state, 'committed');
  await assert.rejects(f.sync.push());
  assert.equal(f.sync.getStatus().pending, true);
  assert.equal(f.db.getOperation('publish-retry-operation')!.state, 'committed');
  assert.equal((await f.tasks.get(created.task.id)).title, taskInput.title);
  await run('git', ['remote', 'set-url', 'origin', remote], { cwd: f.cfg.vault.root });
  await f.sync.push();
  assert.equal(f.sync.getStatus().pending, false);
  assert.equal(f.db.getOperation('publish-retry-operation')!.state, 'synced');
  assert.equal((await run('git', ['--git-dir', remote, 'rev-parse', 'main'])).stdout.trim(), created.receipt.commitSha);
});

test('vault rejects a directory junction leading outside the vault', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.cfg.vault.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.vault.writeNote('linked/escape.md', 'must not be written'), /[Ss]ymlink|[Ss]ymbolic/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('chat TTL read filter is exact even when cleanup has not run', async t => {
  const f = await fixture(t);
  let now = Date.parse('2026-10-02T09:00:00Z');
  const store = new ChatStore(path.join(f.root, 'clock.chats.sqlite'), () => now);
  try {
    store.add(1, 'main', 'user', 'expires');
    now += CHAT_RETENTION_MS - 1;
    assert.equal(store.list(1, 'main').length, 1);
    now += 1;
    assert.equal(store.list(1, 'main').length, 0);
    store.prune();
  } finally { store.close(); }
});

test('legacy message migration is repeatable, preserves IDs and discards messages older than 14 days', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'legacy.sqlite');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY, device_id INTEGER, chat TEXT, role TEXT, content TEXT, meta TEXT, created_at INTEGER)');
  old.prepare('INSERT INTO messages VALUES(?, ?, ?, ?, ?, ?, ?)').run(7, 1, 'main', 'user', 'recent', null, Date.now());
  old.prepare('INSERT INTO messages VALUES(?, ?, ?, ?, ?, ?, ?)').run(8, 1, 'main', 'user', 'expired', null, Date.now() - CHAT_RETENTION_MS);
  old.close();
  let migrated = await Db.open(file);
  assert.deepEqual(migrated.listMessages(1, 'main').map(m => m.id), [7]);
  migrated.close();
  migrated = await Db.open(file);
  assert.deepEqual(migrated.listMessages(1, 'main').map(m => m.content), ['recent']);
  migrated.close();
  const check = new DatabaseSync(file);
  assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name = 'messages'").get(), undefined);
  assert.equal((check.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n, 8);
  check.close();
});

test('task API requires app auth, validates deadline, preserves retries and supports completion', async t => {
  const f = await fixture(t);
  const appDevice = f.db.createDevice('test', 'app');
  const quick = f.db.createDevice('quick', 'quick');
  const app = await createServer(f.cfg);
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).json().requireStandalone, false);
    assert.equal((await app.inject({ method: 'GET', url: '/api/tasks' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/tasks', headers: { authorization: 'Bearer ' + quick.token } })).statusCode, 401);
    const headers = { authorization: 'Bearer ' + appDevice.token };
    const missing = await app.inject({ method: 'POST', url: '/api/tasks', headers, payload: { operationId: 'api-missing-deadline', task: { ...taskInput, deadline: undefined } } });
    assert.equal(missing.statusCode, 422);
    const payload = { operationId: 'api-create-operation', task: taskInput };
    const created = await app.inject({ method: 'POST', url: '/api/tasks', headers, payload });
    assert.equal(created.statusCode, 201);
    assert.equal(created.headers['cache-control'], 'no-store');
    const task = created.json().task;
    assert.equal((await app.inject({ method: 'POST', url: '/api/tasks', headers, payload })).json().task.id, task.id);
    const completed = await app.inject({ method: 'PATCH', url: '/api/tasks/' + task.id, headers, payload: { operationId: 'api-update-operation', expectedContentHash: task.contentHash, patch: { status: 'done' } } });
    assert.equal(completed.statusCode, 200);
    assert.equal(completed.json().task.status, 'done');
    assert.ok(completed.json().task.completedAt);
    const voice = await app.inject({ method: 'POST', url: '/api/transcribe', headers, payload: {} });
    assert.equal(voice.statusCode, 404);
  } finally { await app.close(); }
});

test('fingerprint is stable across key ordering', () => {
  assert.equal(fingerprint({ a: 1, b: { x: 2, y: 3 } }), fingerprint({ b: { y: 3, x: 2 }, a: 1 }));
});

test('missing PWA assets return 404 instead of cacheable HTML while share keeps its fallback', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.cfg.staticDir, { recursive: true });
  await fs.writeFile(path.join(f.cfg.staticDir, 'index.html'), '<!doctype html><div id="root"></div>');
  const app = await createServer(f.cfg);
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/assets/missing.js' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/missing.css' })).statusCode, 404);
    const share = await app.inject({ method: 'GET', url: '/share?text=test' });
    assert.equal(share.statusCode, 200);
    assert.match(share.headers['content-type']!, /text\/html/);
    await fs.mkdir(path.join(f.cfg.staticDir, 'assets'));
    await fs.writeFile(path.join(f.cfg.staticDir, 'assets', 'new.js'), 'export const value = 1;');
    const added = await app.inject({ method: 'GET', url: '/assets/new.js' });
    assert.equal(added.statusCode, 200);
    assert.match(added.headers['content-type']!, /javascript/);
  } finally { await app.close(); }
});
