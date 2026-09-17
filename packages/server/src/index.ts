import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Agent, LlmClient, Vault, createNote, appendToDaily, slashCommands } from '@relay/core';
import type { AgentEvent, AgentResult } from '@relay/core';
import { loadConfig, loadScenarios } from './config.js';
import { Db } from './db.js';
import { GitSync } from './sync.js';
import { makeAdminAuth, makeAuth } from './auth.js';

const VERSION = '0.1.0';

async function main(): Promise<void> {
  const cfg = loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  await fs.mkdir(cfg.vault.root, { recursive: true });

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 25 * 1024 * 1024 });
  const log = (msg: string) => app.log.info(msg);

  const db = await Db.open(cfg.dbPath);
  const vault = new Vault(cfg.vault);
  const llm = new LlmClient(cfg.llm);
  const scenarios = await loadScenarios(cfg.scenariosFile);
  const agent = new Agent({ vault, llm, extraSystemPrompt: scenarios.systemPrompt, scenarios: scenarios.scenarios });
  const sync = new GitSync(cfg, log);
  await sync.start();

  const auth = makeAuth(db);
  const authAny = makeAuth(db, { kinds: ['app', 'quick'] });
  const adminAuth = makeAdminAuth(cfg.adminSecret);

  await app.register(cors, { origin: true, credentials: false });
  await app.register(websocket);

  // Concurrency guard: one agent run at a time per device (simple map)
  const running = new Map<number, AbortController>();

  const afterWrite = (result: AgentResult) => {
    if (result.actions.length) sync.schedulePush();
  };

  // ---------- public ----------
  app.get('/api/health', async () => ({ ok: true, version: VERSION, sync: sync.getStatus() }));

  app.post<{ Body: { code?: string; name?: string } }>('/api/pair', async (req, reply) => {
    const code = String(req.body?.code ?? '').trim();
    const name = String(req.body?.name ?? 'Телефон').trim();
    if (!code) return reply.code(400).send({ error: 'code required' });
    const res = db.redeemCode(code, name);
    if (!res) return reply.code(401).send({ error: 'invalid or expired code' });
    log(`device paired: #${res.device.id} ${res.device.name}`);
    return { token: res.token, device: res.device };
  });

  // Quick capture (for iOS Shortcuts / HTTP Shortcuts). Accepts app or quick keys.
  app.post<{ Body: { token?: string; text?: string; chat?: string; title?: string } }>(
    '/api/send',
    { preHandler: authAny },
    async (req, reply) => {
      const text = String(req.body?.text ?? '').trim();
      if (!text) return reply.code(400).send({ error: 'text required' });
      const device = req.device!;
      const chat = String(req.body?.chat ?? 'quick');
      let pathOut: string;
      if (chat === 'daily') {
        pathOut = await appendToDaily(vault, text);
      } else {
        const title = String(req.body?.title ?? text.split('\n')[0].slice(0, 60));
        pathOut = await createNote(vault, { title, content: text, folder: device.folder ?? undefined });
      }
      sync.schedulePush();
      db.addMessage(device.id, 'quick', 'user', text, { path: pathOut });
      return { ok: true, path: pathOut };
    },
  );

  // ---------- device (app) ----------
  app.get('/api/me', { preHandler: auth }, async (req) => ({
    device: req.device,
    vault: {
      inbox: cfg.vault.inboxFolder,
      daily: cfg.vault.dailyFolder,
      privateFolders: cfg.vault.privateFolders,
    },
    model: cfg.llm.model,
    sync: sync.getStatus(),
    requireStandalone: cfg.requireStandalone,
  }));

  app.get('/api/commands', { preHandler: auth }, async () => ({ commands: agent.listCommands() }));

  app.get<{ Querystring: { chat?: string; before?: string; limit?: string } }>('/api/messages', { preHandler: auth }, async (req) => {
    const chat = req.query.chat ?? 'main';
    const before = req.query.before ? Number(req.query.before) : undefined;
    const limit = Math.min(200, Number(req.query.limit ?? 50) || 50);
    const list = db.listMessages(req.device!.id, chat, limit, before);
    return { messages: list.map((m) => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : null })) };
  });

  app.delete<{ Querystring: { chat?: string } }>('/api/messages', { preHandler: auth }, async (req) => {
    db.clearMessages(req.device!.id, req.query.chat ?? 'main');
    return { ok: true };
  });

  app.get('/api/devices', { preHandler: auth }, async () => ({ devices: db.listDevices() }));

  app.delete<{ Params: { id: string } }>('/api/devices/:id', { preHandler: auth }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!db.revokeDevice(id)) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.post<{ Body: { name?: string; folder?: string } }>('/api/devices/quick', { preHandler: auth }, async (req) => {
    const { token, device } = db.createDevice(String(req.body?.name ?? 'Быстрая запись'), 'quick', req.body?.folder || undefined);
    return { token, device };
  });

  app.post('/api/pairing/new', { preHandler: auth }, async () => db.createPairingCode());

  app.post('/api/sync/pull', { preHandler: auth }, async () => {
    await sync.pull().catch(() => {});
    return sync.getStatus();
  });

  // HTTP chat (non-streaming) — fallback if WS is blocked
  app.post<{ Body: { text?: string; chat?: string } }>('/api/chat', { preHandler: auth }, async (req, reply) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'text required' });
    const chat = String(req.body?.chat ?? 'main');
    const result = await handleMessage(req.device!.id, chat, text, () => {});
    return result;
  });

  // Voice transcription
  app.post('/api/transcribe', { preHandler: auth }, async (req, reply) => {
    const ct = req.headers['content-type'] ?? '';
    const chunks: Buffer[] = [];
    for await (const c of req.raw) chunks.push(c as Buffer);
    const buf = Buffer.concat(chunks);
    if (!buf.length) return reply.code(400).send({ error: 'empty body' });
    const ext = ct.includes('mp4') ? 'mp4' : ct.includes('ogg') ? 'ogg' : ct.includes('wav') ? 'wav' : 'webm';
    const blob = new Blob([buf], { type: ct || 'audio/webm' });
    try {
      const text = await llm.transcribe(blob, `voice.${ext}`, cfg.whisperModel, 'ru');
      return { text };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  // Raw body for audio
  app.addContentTypeParser(/^audio\/.*/, (_req, _payload, done) => done(null));
  app.addContentTypeParser('application/octet-stream', (_req, _payload, done) => done(null));

  // ---------- WebSocket chat ----------
  app.get('/api/ws', { websocket: true }, (socket, req) => {
    const token = (req.query as { token?: string }).token ?? '';
    const device = token ? db.findDevice(token) : null;
    if (!device || device.kind !== 'app') {
      socket.send(JSON.stringify({ type: 'error', text: 'unauthorized' }));
      socket.close();
      return;
    }
    db.touchDevice(device.id);
    const send = (obj: unknown) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(obj));
    };
    send({ type: 'hello', version: VERSION, model: cfg.llm.model });
    socket.on('message', async (raw: Buffer) => {
      let msg: { type?: string; text?: string; chat?: string; id?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'ping') return send({ type: 'pong', sync: sync.getStatus() });
      if (msg.type === 'cancel') {
        running.get(device.id)?.abort();
        return;
      }
      if (msg.type !== 'message' || !msg.text?.trim()) return;
      const chat = msg.chat ?? 'main';
      const reqId = msg.id ?? String(Date.now());
      try {
        const result = await handleMessage(device.id, chat, msg.text, (e) => send({ type: e.type, text: e.text, tool: e.tool, id: reqId }));
        send({ type: 'result', id: reqId, ...result });
      } catch (e) {
        send({ type: 'error', id: reqId, text: (e as Error).message });
      }
    });
  });

  async function handleMessage(deviceId: number, chat: string, text: string, onEvent: (e: AgentEvent) => void): Promise<AgentResult & { userMessageId: number; messageId: number }> {
    if (running.has(deviceId)) {
      throw new Error('Предыдущий запрос ещё выполняется. Подождите или отмените его.');
    }
    const ac = new AbortController();
    running.set(deviceId, ac);
    const userMessageId = db.addMessage(deviceId, chat, 'user', text);
    try {
      const history = db
        .listMessages(deviceId, chat, 12)
        .filter((m) => m.id !== userMessageId)
        .map((m) => ({ role: m.role, content: m.content }));
      // Pull fresh changes from PC before answering (cheap if nothing changed)
      await sync.pull().catch(() => {});
      const result = await agent.run({ text, history, onEvent, signal: ac.signal });
      afterWrite(result);
      const messageId = db.addMessage(deviceId, chat, 'assistant', result.text, { sources: result.sources, actions: result.actions, usage: result.usage });
      return { ...result, userMessageId, messageId };
    } catch (e) {
      const errText = ac.signal.aborted ? 'Запрос отменён.' : `Ошибка: ${(e as Error).message}`;
      const messageId = db.addMessage(deviceId, chat, 'assistant', errText, { error: true });
      return { text: errText, sources: [], actions: [], userMessageId, messageId };
    } finally {
      running.delete(deviceId);
    }
  }

  // ---------- admin (CLI / bootstrap) ----------
  app.post('/api/admin/pairing', { preHandler: adminAuth }, async () => db.createPairingCode());
  app.post('/api/admin/reset', { preHandler: adminAuth }, async () => {
    db.resetPairingCodes();
    return { revoked: db.revokeAll() };
  });
  app.get('/api/admin/devices', { preHandler: adminAuth }, async () => ({ devices: db.listDevices() }));

  // ---------- static PWA ----------
  const staticDir = cfg.staticDir || path.resolve(import.meta.dirname ?? '.', '../../app/dist');
  const hasStatic = await fs
    .stat(path.join(staticDir, 'index.html'))
    .then(() => true)
    .catch(() => false);
  if (hasStatic) {
    await app.register(fastifyStatic, { root: staticDir, prefix: '/', wildcard: false });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
    log(`serving PWA from ${staticDir}`);
  }

  // housekeeping
  const prune = setInterval(() => db.pruneMessages(30), 6 * 3600_000);
  prune.unref();

  const shutdown = async () => {
    sync.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await app.listen({ host: cfg.host, port: cfg.port });
  log(`obsidian-relay ${VERSION} on ${cfg.publicUrl} — vault: ${cfg.vault.root} — model: ${cfg.llm.model} — ${slashCommands.length} commands`);
  if (!db.listDevices().length) {
    const { code, expiresAt } = db.createPairingCode(60 * 60_000);
    log(`No devices yet. Pairing code (valid until ${new Date(expiresAt).toLocaleTimeString()}): ${code}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
