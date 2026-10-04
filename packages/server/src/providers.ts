import { randomUUID } from 'node:crypto';
import { DomainError, LlmClient, LlmError, validateProviderWrite, type ProviderPage, type ProviderPublic, type ProviderSlot, type ProviderTestResult, type ProviderWrite } from '@relay/core';
import type { Db } from './db.js';
import type { ServerConfig } from './config.js';
import { ProviderSecrets } from './provider-secrets.js';
import { guardedTransport, validateEndpointPolicy } from './provider-transport.js';
import { createCanvas } from '@napi-rs/canvas';

interface Binding { profile: ProviderPublic; client: LlmClient; release: () => void }
export class ProviderRegistry {
  private readonly live = new Map<string, number>();
  private constructor(private readonly db: Db, private readonly secrets: ProviderSecrets, private readonly cfg: ServerConfig) {}
  static async open(db: Db, cfg: ServerConfig): Promise<ProviderRegistry> {
    const secrets = await ProviderSecrets.open(cfg, !db.providerRows().some(row => row.secret));
    for (const row of db.providerRows()) if (row.secret) secrets.decrypt(row.secret, row.id, row.version);
    const registry = new ProviderRegistry(db, secrets, cfg);
    db.pruneProviderVersions(new Set());
    db.providerTransaction(() => {
      if (db.getSetting('providers.env_imported') !== '1') {
        if (!db.providerRows().length && (cfg.llm.apiKey || cfg.providers.allowedOrigins.includes(new URL(cfg.llm.baseUrl).origin))) {
          const profile = registry.create('chat', { name: 'Основной ИИ', adapter: 'openai_compatible', baseUrl: cfg.llm.baseUrl, modelId: cfg.llm.model,
            canonicalModelId: null, enabled: true, capabilities: { toolCalls: true, vision: false, structuredOutput: false },
            secretUpdate: cfg.llm.apiKey ? { action: 'replace', apiKey: cfg.llm.apiKey } : { action: 'remove' } }, false);
          db.setSetting('providers.default_chat', profile.id);
        }
        db.setSetting('providers.env_imported', '1');
      }
    });
    return registry;
  }
  private rows() { return this.db.providerRows(); }
  private publicRow(row: ReturnType<Db['providerRows']>[number]): ProviderPublic {
    return { ...JSON.parse(row.config), id: row.id, slot: row.slot, version: row.version, hasSecret: row.secret !== null, lastTest: row.testResult ? JSON.parse(row.testResult) : null };
  }
  list(): ProviderPage {
    const items = this.rows().map(r => this.publicRow(r));
    const selected = this.db.getSetting('providers.default_chat');
    const defaultChatProviderId = items.some(p => p.id === selected && p.enabled && p.slot === 'chat') ? selected : null;
    const chat = items.find(p => p.id === defaultChatProviderId);
    const organizer = items.find(p => p.slot === 'organizer' && p.enabled);
    const status = !organizer ? 'missing' : !chat?.canonicalModelId || !organizer.canonicalModelId ? 'unverified'
      : chat.canonicalModelId === organizer.canonicalModelId ? 'same_model' : 'different';
    const messages = { missing: 'Сортировщик не настроен.', unverified: 'Различие моделей не проверено. Укажите идентификаторы моделей.', same_model: 'Основной ИИ и сортировщик используют одну модель. Сортировка будет заблокирована.', different: 'Для сортировщика указан другой идентификатор модели.' };
    return { items, defaultChatProviderId, limits: { chat: 5, organizer: 1 }, organizerSafety: { status, message: messages[status] } };
  }
  private normalized(input: unknown, updating = false): ProviderWrite {
    const value = validateProviderWrite(input, updating);
    const endpoint = validateEndpointPolicy(value.baseUrl, this.cfg.providers.allowedOrigins);
    if (endpoint.hostname === 'api.openai.com') value.canonicalModelId = 'openai/' + value.modelId.toLowerCase();
    if (endpoint.hostname === 'openrouter.ai' && value.modelId.includes('/')) value.canonicalModelId = value.modelId.toLowerCase();
    if(value.adapter==='anthropic')value.canonicalModelId='anthropic/'+value.modelId.toLowerCase();
    if(value.adapter==='gemini')value.canonicalModelId='google/'+value.modelId.replace(/^models\//,'').toLowerCase();
    return value;
  }
  create(slot: unknown, input: unknown, transactional = true): ProviderPublic {
    if (slot !== 'chat' && slot !== 'organizer') throw new DomainError('VALIDATION_ERROR', 'Некорректное назначение профиля.');
    const value = this.normalized(input);
    const work = () => {
      if (this.rows().filter(p => p.slot === slot).length >= (slot === 'chat' ? 5 : 1)) throw new DomainError('PROVIDER_LIMIT', slot === 'chat' ? 'Можно добавить до пяти ИИ для чата.' : 'Можно добавить один отдельный сортировщик.', 409);
      const id = 'provider_' + randomUUID();
      this.save(id, slot, 1, value, null);
      if (slot === 'chat' && value.enabled && !this.list().defaultChatProviderId) this.db.setSetting('providers.default_chat', id);
      return this.publicRow(this.rows().find(p => p.id === id)!);
    };
    return transactional ? this.db.providerTransaction(work) : work();
  }
  private save(id: string, slot: ProviderSlot, version: number, value: ProviderWrite, old: { version: number; secret: string | null } | null): void {
    const apiKey = value.secretUpdate.action === 'replace' ? value.secretUpdate.apiKey
      : value.secretUpdate.action === 'keep' && old?.secret ? this.secrets.decrypt(old.secret, id, old.version) : null;
    const { secretUpdate: _secret, expectedVersion: _version, ...config } = value;
    this.db.saveProvider(id, slot, version, JSON.stringify(config), apiKey ? this.secrets.encrypt(apiKey, id, version) : null);
  }
  update(id: string, input: unknown): ProviderPublic {
    const value = this.normalized(input, true);
    return this.db.providerTransaction(() => {
      const row = this.rows().find(p => p.id === id);
      if (!row) throw new DomainError('PROVIDER_NOT_FOUND', 'Профиль не найден.', 404);
      if (row.version !== value.expectedVersion) throw new DomainError('PROVIDER_VERSION_CONFLICT', 'Профиль изменился. Обновите настройки.', 409);
      if (row.secret && value.secretUpdate.action === 'keep' && new URL(value.baseUrl).origin !== new URL(this.publicRow(row).baseUrl).origin) {
        throw new DomainError('SECRET_ENDPOINT_CHANGED', 'При смене сервера API замените или удалите ключ.');
      }
      if (!value.enabled && this.list().defaultChatProviderId === id) throw new DomainError('PROVIDER_IN_USE', 'Сначала выберите другой основной ИИ или снимите выбор.', 409);
      this.save(id, row.slot, row.version + 1, value, row);
      this.prune();
      return this.publicRow(this.rows().find(p => p.id === id)!);
    });
  }
  select(id: unknown, version: unknown): ProviderPage {
    return this.db.providerTransaction(() => {
      if (id !== null) {
        const row = this.rows().find(p => p.id === id);
        if (!row || row.slot !== 'chat' || !this.publicRow(row).enabled) throw new DomainError('PROVIDER_UNAVAILABLE', 'Выберите включённый профиль чата.', 409);
        if (row.version !== version) throw new DomainError('PROVIDER_VERSION_CONFLICT', 'Профиль изменился. Обновите настройки.', 409);
      }
      this.db.setSetting('providers.default_chat', typeof id === 'string' ? id : '');
      return this.list();
    });
  }
  remove(id: string, version: unknown): void {
    this.db.providerTransaction(() => {
      const row = this.rows().find(p => p.id === id);
      if (!row) throw new DomainError('PROVIDER_NOT_FOUND', 'Профиль не найден.', 404);
      if (row.version !== version) throw new DomainError('PROVIDER_VERSION_CONFLICT', 'Профиль изменился. Обновите настройки.', 409);
      if (this.list().defaultChatProviderId === id || this.db.chats.usesProvider(id) || [...this.live.keys()].some(k => k.startsWith(id + ':'))) throw new DomainError('PROVIDER_IN_USE', 'Профиль выбран, закреплён за чатом или используется запросом. Сначала снимите выбор и дождитесь завершения.', 409);
      this.db.removeProvider(id);
    });
  }
  private prune(): void { this.db.pruneProviderVersions(new Set(this.live.keys())); }
  bindDefault(requireTools = true): Binding | null { const id = this.list().defaultChatProviderId; return id ? this.bind(id, false, requireTools) : null; }
  bindChat(id:string|null|undefined,requireTools=true):Binding|null{if(!id)return this.bindDefault(requireTools);if(!this.list().items.some(p=>p.id===id&&p.slot==='chat'))throw new DomainError('PROVIDER_UNAVAILABLE','Профиль чата недоступен.',409);return this.bind(id,false,requireTools);}
  bindOrganizer():Binding {
    const page=this.list(),profile=page.items.find(p=>p.slot==='organizer'&&p.enabled);
    if(!profile||page.organizerSafety.status!=='different')throw new DomainError('ORGANIZER_PROVIDER','Настройте отдельную модель сортировщика, отличную от основного ИИ.',409);
    return this.bind(profile.id,false,false);
  }
  private bind(id: string, probe = false, requireTools = true): Binding {
    if ([...this.live.values()].reduce((a, b) => a + b, 0) >= 8 || [...this.live.entries()].filter(([key]) => key.startsWith(id + ':')).reduce((n, [, count]) => n + count, 0) >= 2) {
      throw new DomainError('PROVIDER_BUSY', 'Лимит одновременных запросов к ИИ достигнут. Повторите позже.', 429);
    }
    const row = this.rows().find(p => p.id === id);
    if (!row) throw new DomainError('PROVIDER_NOT_FOUND', 'Профиль не найден.', 404);
    const profile = this.publicRow(row);
    if (!profile.enabled) throw new DomainError('PROVIDER_UNAVAILABLE', 'Профиль выключен.', 409);
    if (!probe && requireTools && profile.capabilities.toolCalls && profile.lastTest?.verifiedCapabilities.toolCalls === false) {
      throw new DomainError('CAPABILITY_UNSUPPORTED', 'Проверка не подтвердила инструменты. Отключите их в профиле или выберите другую модель.', 422);
    }
    const apiKey = row.secret ? this.secrets.decrypt(row.secret, id, row.version) : '';
    const client = new LlmClient({ adapter:profile.adapter, baseUrl: profile.baseUrl, model: profile.modelId, apiKey, temperature: this.cfg.llm.temperature, maxTokens: probe ? 128 : this.cfg.llm.maxTokens,
      headers: profile.baseUrl === this.cfg.llm.baseUrl ? this.cfg.llm.headers : undefined }, guardedTransport(this.cfg.providers.allowedOrigins, this.cfg.providers.timeoutMs));
    const key = id + ':' + row.version;
    this.live.set(key, (this.live.get(key) ?? 0) + 1);
    let released = false;
    return { profile, client, release: () => { if (released) return; released = true; const left = (this.live.get(key) ?? 1) - 1; if (left) this.live.set(key, left); else this.live.delete(key); this.prune(); } };
  }
  async test(id: string): Promise<ProviderTestResult> {
    const binding = this.bind(id, true); const p = binding.profile;
    const result: ProviderTestResult = { providerId: id, version: p.version, availability: 'failed', checkedAt: new Date().toISOString(),
      verifiedCapabilities: { text: false, toolCalls: null, structuredOutput: null, vision: null }, message: '' };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(this.cfg.providers.timeoutMs, 15_000));
      try {
        const needsTools = p.slot === 'chat' && p.capabilities.toolCalls;
        const needsJson = p.slot === 'organizer';
        const response = await binding.client.chat([{ role: 'user', content: needsTools ? 'Call relay_ping with marker "ok".' : needsJson ? 'Return only JSON: {"status":"ok"}.' : 'Reply with RELAY_OK.' }],
          needsTools ? [{ type: 'function', function: { name: 'relay_ping', description: 'Harmless connection check. No external action.', parameters: { type: 'object', properties: { marker: { type: 'string', enum: ['ok'] } }, required: ['marker'], additionalProperties: false } } }] : undefined,
          controller.signal, { toolChoice: needsTools ? { type: 'function', function: { name: 'relay_ping' } } : undefined, responseFormat: needsJson && p.capabilities.structuredOutput ? { type: 'json_object' } : undefined });
        result.verifiedCapabilities.text = true;
        if (needsTools) result.verifiedCapabilities.toolCalls = response.message.tool_calls?.some(c => c.function.name === 'relay_ping' && JSON.parse(c.function.arguments).marker === 'ok') ?? false;
        if (needsJson) { try { result.verifiedCapabilities.structuredOutput = JSON.parse(response.message.content ?? '').status === 'ok'; } catch { result.verifiedCapabilities.structuredOutput = false; } }
        if(p.capabilities.vision){const canvas=createCanvas(32,32),context=canvas.getContext('2d');context.fillStyle='#ff0000';context.fillRect(0,0,32,32);const image=canvas.toBuffer('image/png').toString('base64');const vision=await binding.client.chat([{role:'user',content:'What is the main solid color? Reply one word: RED, BLUE, GREEN or OTHER.',parts:[{type:'text',text:'What is the main solid color? Reply one word: RED, BLUE, GREEN or OTHER.'},{type:'image_url',image_url:{url:'data:image/png;base64,'+image}}]}],undefined,controller.signal);result.verifiedCapabilities.vision=vision.message.content?.trim().toUpperCase()==='RED';}
        const passed = (!needsTools || result.verifiedCapabilities.toolCalls) && (!needsJson || result.verifiedCapabilities.structuredOutput)&&(!p.capabilities.vision||result.verifiedCapabilities.vision);
        result.availability = passed ? 'available' : 'failed';
        result.message = passed ? 'Подключение и выбранные возможности проверены.' : 'API ответил, но выбранные инструменты, JSON или изображения не подтверждены.';
      } finally { clearTimeout(timer); }
    } catch (e) {
      result.message = e instanceof DomainError ? e.message : e instanceof LlmError ? e.status === 401 || e.status === 403 ? 'API отклонил ключ.' : e.status === 429 ? 'Достигнут лимит API. Повторите позже.' : 'API модели не выполнил проверку.' : 'Некорректный ответ на проверку подключения.';
    } finally { this.db.saveProviderTest(id, p.version, JSON.stringify(result)); binding.release(); }
    return result;
  }
}
