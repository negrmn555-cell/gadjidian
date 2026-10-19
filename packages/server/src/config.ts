import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { VaultConfig, LlmConfig } from '@relay/core';

export interface ServerConfig {
  diagnostics?: {enabled:boolean;baseUrl:string;publicKey:string;secretKey:string;allowedOrigins:string[];retentionDays:number};
  mcp?: {enabled:boolean};
  agent?: { engine: "mastra"|"legacy"; maxSteps: number };
  host: string;
  port: number;
  /** Public origin, e.g. https://notes.example.com — used for CORS and PWA links. */
  publicUrl: string;
  dataDir: string;
  dbPath: string;
  /** Path to built PWA (served at /). Empty = don't serve. */
  staticDir: string;
  vault: VaultConfig;
  llm: LlmConfig;
  providers: { masterKey: string; keyFile: string; allowedOrigins: string[]; timeoutMs: number };
  sync: {
    /** none | git */
    mode: 'none' | 'git';
    /** Seconds between git pulls. 0 = only on demand. */
    pullInterval: number;
    /** Seconds to wait after a write before commit+push. */
    pushDebounce: number;
    remote: string;
    branch: string;
    authorName: string;
    authorEmail: string;
    freshnessMs?: number;
    timeoutMs?: number;
  };
  /** Optional extra system prompt / user scenarios file (JSON) in dataDir. */
  scenariosFile: string;
  /** If false the app may be opened from a normal browser tab (dev). */
  requireStandalone: boolean;
  /** Bootstrap admin secret for CLI/HTTP admin endpoints. */
  adminSecret: string;
}

function env(name: string, def = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

function envNum(name: string, def: number): number {
  const v = Number(env(name));
  return Number.isFinite(v) && env(name) !== '' ? v : def;
}

function envBool(name: string, def: boolean): boolean {
  const v = env(name).toLowerCase();
  if (!v) return def;
  return v === '1' || v === 'true' || v === 'yes';
}

function list(name: string): string[] {
  return env(name)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): ServerConfig {
  const dataDir = path.resolve(env('DATA_DIR', './data'));
  const vaultRoot = path.resolve(env('VAULT_PATH', path.join(dataDir, 'vault')));
  return {
    diagnostics:{enabled:envBool('LANGFUSE_ENABLED',false),baseUrl:env('LANGFUSE_BASE_URL','https://cloud.langfuse.com'),publicKey:env('LANGFUSE_PUBLIC_KEY'),secretKey:env('LANGFUSE_SECRET_KEY'),allowedOrigins:list('LANGFUSE_ALLOWED_ORIGINS'),retentionDays:Math.max(1,Math.min(14,Math.trunc(envNum('LANGFUSE_RETENTION_DAYS',14))))},
    mcp:{enabled:envBool('MCP_ENABLED',true)},
    agent: {engine:env('AGENT_ENGINE','mastra')==='legacy'?'legacy':'mastra',maxSteps:Math.max(2,Math.min(6,Math.trunc(envNum('AGENT_MAX_STEPS',4))))},
    host: env('HOST', '0.0.0.0'),
    port: envNum('PORT', 8080),
    publicUrl: env('PUBLIC_URL', 'http://localhost:8080').replace(/\/+$/, ''),
    dataDir,
    dbPath: env('DB_PATH', path.join(dataDir, 'relay.sqlite')),
    staticDir: env('STATIC_DIR', ''),
    vault: {
      root: vaultRoot,
      inboxFolder: env('VAULT_INBOX', 'Inbox'),
      dailyFolder: env('VAULT_DAILY_FOLDER', 'Daily'),
      dailyFormat: env('VAULT_DAILY_FORMAT', 'YYYY-MM-DD'),
      dailyTemplate: env('VAULT_DAILY_TEMPLATE') || undefined,
      dailySection: env('VAULT_DAILY_SECTION') || undefined,
      noteTemplate: env('VAULT_NOTE_TEMPLATE') || undefined,
      privateFolders: list('VAULT_PRIVATE_FOLDERS'),
      ignoreFolders: list('VAULT_IGNORE_FOLDERS'),
    },
    llm: {
      baseUrl: env('LLM_BASE_URL', 'https://openrouter.ai/api/v1'),
      apiKey: env('LLM_API_KEY'),
      model: env('LLM_MODEL', 'openai/gpt-4o-mini'),
      temperature: envNum('LLM_TEMPERATURE', 0.3),
      maxTokens: envNum('LLM_MAX_TOKENS', 0) || undefined,
      headers: env('LLM_REFERER') ? { 'HTTP-Referer': env('LLM_REFERER'), 'X-Title': 'obsidian-relay' } : undefined,
    },
    providers: {
      masterKey: env('PROVIDER_MASTER_KEY'),
      keyFile: env('PROVIDER_KEY_FILE', path.join(dataDir, 'secrets', 'provider-master.key')),
      allowedOrigins: list('PROVIDER_ALLOWED_ORIGINS'),
      timeoutMs: envNum('PROVIDER_TIMEOUT_MS', 60_000),
    },
    sync: {
      mode: env('SYNC_MODE', 'none') === 'git' ? 'git' : 'none',
      pullInterval: envNum('SYNC_PULL_INTERVAL', 60),
      pushDebounce: envNum('SYNC_PUSH_DEBOUNCE', 5),
      remote: env('GIT_REMOTE'),
      branch: env('GIT_BRANCH', 'main'),
      authorName: env('GIT_AUTHOR_NAME', 'obsidian-relay'),
      authorEmail: env('GIT_AUTHOR_EMAIL', 'relay@localhost'),
      freshnessMs: Math.max(0, envNum('SYNC_FRESHNESS_MS', 30_000)),
      timeoutMs: Math.max(1000, Math.min(120_000, envNum('GIT_TIMEOUT_MS', 30_000))),
    },
    scenariosFile: env('SCENARIOS_FILE', path.join(dataDir, 'scenarios.json')),
    requireStandalone: envBool('REQUIRE_STANDALONE', true),
    adminSecret: env('ADMIN_SECRET'),
  };
}

export interface Scenarios {
  systemPrompt?: string;
  scenarios?: Record<string, string>;
}

export async function loadScenarios(file: string): Promise<Scenarios> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as Scenarios;
  } catch {
    return {};
  }
}
