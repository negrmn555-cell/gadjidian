import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { DomainError, LlmClient, type ProviderWrite } from '@relay/core';
import { Db } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { ProviderRegistry } from '../src/providers.js';
import { ProviderSecrets } from '../src/provider-secrets.js';
import { guardedTransport, isPublicAddress, validateEndpointPolicy } from '../src/provider-transport.js';
import { createServer } from '../src/index.js';

type Cleanup = { after: (fn: () => Promise<void>) => void };
async function mockApi(t: Cleanup, respond?: (body: Record<string, any>, res: http.ServerResponse) => void) {
  const requests: { body: Record<string, any>; auth?: string }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ body, auth: req.headers.authorization });
    if (respond) return respond(body, res);
    res.setHeader('Content-Type', 'application/json');
    const toolProbe = body.tool_choice?.function?.name === 'relay_ping';
    const jsonProbe = body.messages[0]?.content?.includes('Return only JSON');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: toolProbe ? null : jsonProbe ? '{"status":"ok"}' : 'Ответ модели ' + body.model,
      ...(toolProbe ? { tool_calls: [{ id: 'probe-1', type: 'function', function: { name: 'relay_ping', arguments: '{"marker":"ok"}' } }] } : {}) }, finish_reason: 'stop' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  return { origin, baseUrl: origin + '/v1', requests };
}
async function fixture(t: Cleanup, origins: string[] = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-provider-'));
  const cfg = loadConfig();
  cfg.dataDir = root; cfg.dbPath = path.join(root, 'relay.sqlite'); cfg.vault.root = path.join(root, 'vault');
  cfg.staticDir = path.join(root, 'no-static'); cfg.scenariosFile = path.join(root, 'no-scenarios.json'); cfg.requireStandalone = false;
  cfg.sync = { ...cfg.sync, mode: 'none', remote: '', pullInterval: 0 };
  cfg.llm.apiKey = ''; cfg.providers = { ...cfg.providers, masterKey: Buffer.alloc(32, 7).toString('base64'), allowedOrigins: origins, timeoutMs: 2000 };
  const db = await Db.open(cfg.dbPath);
  t.after(async () => {
    db.close();
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('relay-provider-')) throw new Error('Unsafe cleanup');
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, cfg, db, registry: await ProviderRegistry.open(db, cfg) };
}
function input(baseUrl = 'https://api.openai.com/v1', modelId = 'test-a'): ProviderWrite {
  return { name: 'Тестовый ИИ', adapter: 'openai_compatible', baseUrl, modelId, canonicalModelId: null, enabled: true,
    capabilities: { toolCalls: true, vision: false, structuredOutput: false }, secretUpdate: { action: 'replace', apiKey: 'fake-test-secret-a' } };
}
const code = (expected: string) => (e: unknown) => e instanceof DomainError && e.code === expected;

test('five chat profiles plus one independent organizer, disabled profiles occupy slots', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) f.registry.create('chat', { ...input(), enabled: i !== 4 });
  assert.throws(() => f.registry.create('chat', input()), code('PROVIDER_LIMIT'));
  const organizer = f.registry.create('organizer', { ...input(), modelId: 'different-model' });
  assert.equal(f.registry.list().items.length, 6);
  assert.throws(() => f.registry.create('organizer', input()), code('PROVIDER_LIMIT'));
  assert.throws(() => f.registry.select(organizer.id, organizer.version), code('PROVIDER_UNAVAILABLE'));
  assert.equal(f.registry.list().organizerSafety.status, 'different');
  f.registry.update(organizer.id, { ...input(), expectedVersion: 1 });
  assert.equal(f.registry.list().organizerSafety.status, 'same_model');
});

test('secrets are encrypted, bound to profile/version, and never returned in public DTOs', async t => {
  const f = await fixture(t); const p = f.registry.create('chat', input());
  assert.equal(p.hasSecret, true);
  assert.doesNotMatch(JSON.stringify(f.registry.list()), /fake-test-secret|encrypted_secret|apiKey/);
  const encrypted = f.db.providerRows()[0].secret!;
  assert.doesNotMatch(encrypted, /fake-test-secret/);
  const secrets = await ProviderSecrets.open(f.cfg);
  assert.equal(secrets.decrypt(encrypted, p.id, 1), 'fake-test-secret-a');
  assert.throws(() => secrets.decrypt(encrypted, p.id, 2), code('SECRET_UNAVAILABLE'));
  assert.throws(() => secrets.decrypt(encrypted, 'another-id', 1), code('SECRET_UNAVAILABLE'));
  assert.notEqual(secrets.encrypt('same', p.id, 1), secrets.encrypt('same', p.id, 1));
  const bytes = await fs.readFile(f.cfg.dbPath); assert.equal(bytes.includes(Buffer.from('fake-test-secret-a')), false);
});

test('in-flight binding keeps old model/key, replacement creates a new version and deletion is guarded', async t => {
  const api = await mockApi(t); const f = await fixture(t, [api.origin]);
  const p = f.registry.create('chat', input(api.baseUrl));
  const old = f.registry.bindDefault()!;
  const updated = f.registry.update(p.id, { ...input(api.baseUrl, 'test-b'), secretUpdate: { action: 'replace', apiKey: 'fake-test-secret-b' }, expectedVersion: 1 });
  const current = f.registry.bindDefault()!;
  await old.client.chat([{ role: 'user', content: 'old' }]); await current.client.chat([{ role: 'user', content: 'new' }]);
  assert.deepEqual(api.requests.map(r => [r.body.model, r.auth]), [['test-a', 'Bearer fake-test-secret-a'], ['test-b', 'Bearer fake-test-secret-b']]);
  assert.equal(updated.version, 2);
  f.registry.select(null, undefined);
  assert.throws(() => f.registry.remove(p.id, 2), code('PROVIDER_IN_USE'));
  old.release(); old.release(); current.release();
  f.registry.remove(p.id, 2); assert.equal(f.registry.list().items.length, 0);
});

test('optimistic edits reject stale versions and endpoint changes require explicit secret replacement', async t => {
  const f = await fixture(t); const p = f.registry.create('chat', input());
  f.registry.update(p.id, { ...input(), name: 'Changed', expectedVersion: 1, secretUpdate: { action: 'keep' } });
  assert.throws(() => f.registry.update(p.id, { ...input(), expectedVersion: 1 }), code('PROVIDER_VERSION_CONFLICT'));
  assert.throws(() => f.registry.update(p.id, { ...input('https://another.example/v1'), expectedVersion: 2, secretUpdate: { action: 'keep' } }), code('SECRET_ENDPOINT_CHANGED'));
  assert.throws(() => f.registry.update(p.id, { ...input(), expectedVersion: 2, enabled: false }), code('PROVIDER_IN_USE'));
  const removed = f.registry.update(p.id, { ...input(), expectedVersion: 2, secretUpdate: { action: 'remove' } });
  assert.equal(removed.hasSecret, false);
});

test('ENV is imported once and deleting the imported profile does not resurrect it', async t => {
  const f = await fixture(t);
  f.db.setSetting('providers.env_imported', '0'); f.cfg.llm.apiKey = 'fake-env-secret';
  const imported = await ProviderRegistry.open(f.db, f.cfg);
  const p = imported.list().items[0]; assert.equal(p.hasSecret, true);
  imported.select(null, undefined); imported.remove(p.id, p.version);
  assert.equal((await ProviderRegistry.open(f.db, f.cfg)).list().items.length, 0);
});

test('missing or wrong master key fails closed without replacing existing encrypted credentials', async t => {
  const f = await fixture(t);
  f.cfg.providers.masterKey = ''; f.cfg.providers.keyFile = path.join(f.root, 'secrets', 'provider-master.key');
  const registry = await ProviderRegistry.open(f.db, f.cfg);
  registry.create('chat', input());
  const before = f.db.providerRows()[0].secret;
  const backup = f.cfg.providers.keyFile + '.backup';
  await fs.rename(f.cfg.providers.keyFile, backup);
  await assert.rejects(ProviderRegistry.open(f.db, f.cfg), code('MASTER_KEY_MISSING'));
  assert.equal(f.db.providerRows()[0].secret, before);
  await fs.rename(backup, f.cfg.providers.keyFile);
  f.cfg.providers.masterKey = Buffer.alloc(32, 99).toString('base64');
  await assert.rejects(ProviderRegistry.open(f.db, f.cfg), code('SECRET_UNAVAILABLE'));
  f.cfg.providers.masterKey = '';
  assert.equal((await ProviderRegistry.open(f.db, f.cfg)).list().items[0].hasSecret, true);
});

test('transport blocks private/reserved IPv4 and IPv6, URL credentials, insecure origins and private DNS', async t => {
  const api = await mockApi(t);
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1', '192.168.1.2', '100.64.1.2', '192.0.2.1', '198.18.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fd00::1', '2001:db8::1', '2002:7f00:1::']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('8.8.8.8'), true); assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  assert.throws(() => validateEndpointPolicy(api.baseUrl, []), code('ENDPOINT_FORBIDDEN'));
  assert.throws(() => validateEndpointPolicy('https://user:password@api.example/v1', []), code('ENDPOINT_FORBIDDEN'));
  assert.throws(() => validateEndpointPolicy('https://api.example/v1?key=secret', []), code('ENDPOINT_FORBIDDEN'));
  const transport = guardedTransport([], 1000, async () => [{ address: '127.0.0.1', family: 4 }]);
  await assert.rejects(transport('https://public-looking.example/chat/completions', { method: 'POST', body: '{}' }), code('ENDPOINT_FORBIDDEN'));
  assert.equal(api.requests.length, 0);
});

test('upstream redirect is not followed and does not send credentials to another origin', async t => {
  const target = await mockApi(t);
  const source = await mockApi(t, (_body, res) => { res.statusCode = 302; res.setHeader('Location', target.baseUrl); res.end(); });
  const client = new LlmClient({ baseUrl: source.baseUrl, model: 'test', apiKey: 'fake-redirect-secret' }, guardedTransport([source.origin, target.origin], 1000));
  await assert.rejects(client.chat([{ role: 'user', content: 'synthetic' }]), /HTTP 302/);
  assert.equal(source.requests.length, 1); assert.equal(target.requests.length, 0);
});

test('cancelled requests perform no DNS lookup and DNS/socket execution has an overall timeout', async t => {
  let lookups = 0;
  const transport = guardedTransport([], 1000, async () => { lookups++; return await new Promise(() => {}); });
  const ac = new AbortController(); ac.abort();
  await assert.rejects(transport('https://example.test/v1', { signal: ac.signal }), code('PROVIDER_CANCELLED'));
  assert.equal(lookups, 0);
  await assert.rejects(transport('https://example.test/v1'), code('PROVIDER_TIMEOUT'));
  const api = await mockApi(t, () => {});
  await assert.rejects(guardedTransport([api.origin], 1000)(api.baseUrl, { method: 'POST', body: '{}' }), code('PROVIDER_TIMEOUT'));
});

test('transport decodes gzip and limits the decoded size of compressed responses', async t => {
  const small = await mockApi(t, (_body, res) => {
    res.setHeader('Content-Encoding', 'gzip'); res.end(gzipSync('{"ok":true}'));
  });
  const response = await guardedTransport([small.origin], 1000)(small.baseUrl, { method: 'POST', body: '{}' });
  assert.deepEqual(await response.json(), { ok: true });
  const large = await mockApi(t, (_body, res) => {
    res.setHeader('Content-Encoding', 'gzip'); res.end(gzipSync('x'.repeat(3 * 1024 * 1024)));
  });
  await assert.rejects(guardedTransport([large.origin], 1000)(large.baseUrl, { method: 'POST', body: '{}' }), code('PROVIDER_RESPONSE_TOO_LARGE'));
});

test('connection probe verifies tools with synthetic input, stores evidence for its version and never executes vault tools', async t => {
  const api = await mockApi(t); const f = await fixture(t, [api.origin]);
  const p = f.registry.create('chat', input(api.baseUrl)); assert.equal(api.requests.length, 0);
  const result = await f.registry.test(p.id);
  assert.equal(result.availability, 'available'); assert.equal(result.verifiedCapabilities.toolCalls, true); assert.equal(result.verifiedCapabilities.vision, null);
  assert.equal(api.requests[0].body.max_tokens, 128); assert.equal(api.requests[0].body.messages.length, 1);
  assert.deepEqual(api.requests[0].body.tools.map((v: any) => v.function.name), ['relay_ping']);
  assert.equal(f.registry.list().items[0].lastTest?.version, 1);
  f.registry.update(p.id, { ...input(api.baseUrl), modelId: 'new-model', expectedVersion: 1, secretUpdate: { action: 'keep' } });
  assert.equal(f.registry.list().items[0].lastTest, null);
});

test('a failed tool probe prevents tools being sent on subsequent chat requests', async t => {
  const api = await mockApi(t, (_body, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'plain text' }, finish_reason: 'stop' }] })); });
  const f = await fixture(t, [api.origin]); const p = f.registry.create('chat', input(api.baseUrl));
  assert.equal((await f.registry.test(p.id)).availability, 'failed');
  assert.throws(() => f.registry.bindDefault(), code('CAPABILITY_UNSUPPORTED'));
  assert.equal(api.requests.length, 1);
});

test('per-profile concurrency remains bounded across revisions and permits release exactly once', async t => {
  const f = await fixture(t); f.registry.create('chat', input());
  const a = f.registry.bindDefault()!; const b = f.registry.bindDefault()!;
  assert.throws(() => f.registry.bindDefault(), code('PROVIDER_BUSY'));
  a.release(); a.release(); const c = f.registry.bindDefault()!;
  b.release(); c.release();
});

test('provider API enforces auth/limits, supports real model switching and preserves the organizer', async t => {
  const upstream = await mockApi(t); const f = await fixture(t, [upstream.origin]);
  const device = f.db.createDevice('test app', 'app'); const quick = f.db.createDevice('quick', 'quick');
  const app = await createServer(f.cfg);
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/providers' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/providers', headers: { authorization: 'Bearer ' + quick.token } })).statusCode, 401);
    const headers = { authorization: 'Bearer ' + device.token };
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => app.inject({ method: 'POST', url: '/api/providers', headers,
      payload: { slot: 'chat', provider: { ...input(upstream.baseUrl, 'model-' + i), name: 'Profile ' + i } } })));
    assert.equal(responses.filter(r => r.statusCode === 201).length, 5); assert.equal(responses.filter(r => r.statusCode === 409).length, 1);
    const profiles = responses.filter(r => r.statusCode === 201).map(r => r.json());
    const organizer = (await app.inject({ method: 'POST', url: '/api/providers', headers, payload: { slot: 'organizer', provider: input(upstream.baseUrl, 'organizer-model') } })).json();
    const chat=(await app.inject({method:'POST',url:'/api/chats',headers,payload:{entryId:'provider-test-entry',timezone:'Europe/Moscow'}})).json();
    const first = await app.inject({ method: 'POST', url: '/api/chat', headers, payload: { chatId:chat.id,expectedVersion:chat.version,requestId:'provider-request-1',text: 'synthetic first',attachmentIds:[] } }); assert.match(first.json().text, /model-0/);
    await app.inject({ method: 'PUT', url: '/api/providers/default', headers, payload: { providerId: profiles[1].id, expectedVersion: profiles[1].version } });
    const second = await app.inject({ method: 'POST', url: '/api/chat', headers, payload: { chatId:chat.id,expectedVersion:chat.version,requestId:'provider-request-2',text: 'synthetic second',attachmentIds:[] } }); assert.match(second.json().text, /model-1/);
    const listed = await app.inject({ method: 'GET', url: '/api/providers', headers });
    assert.equal(listed.json().items.find((p: any) => p.slot === 'organizer').id, organizer.id);
    assert.doesNotMatch(listed.body, /fake-test-secret|apiKey/);
    // Main replies and their summaries use the same immutable provider snapshot.
    assert.equal(upstream.requests.length, 4);
  } finally { await app.close(); }
});
