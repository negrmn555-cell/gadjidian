export interface VaultConfig {
  /** Absolute path to the vault root on disk. */
  root: string;
  /** Folder for quick captures (relative to root). */
  inboxFolder: string;
  /** Folder with daily notes (relative to root). */
  dailyFolder: string;
  /** Daily note file name format, e.g. "YYYY-MM-DD". */
  dailyFormat: string;
  /** Optional template path (relative to root) used when a daily note is created. */
  dailyTemplate?: string;
  /** Heading under which quick lines are appended in a daily note, e.g. "## Заметки". Empty = append to end. */
  dailySection?: string;
  /** Optional template path (relative to root) for new notes. */
  noteTemplate?: string;
  /** Folders (relative to root) the assistant must never read or write. */
  privateFolders: string[];
  /** Additional ignored folder names (defaults include .obsidian, .git, .trash). */
  ignoreFolders?: string[];
}

export interface NoteMeta {
  /** Vault-relative path with forward slashes, e.g. "Areas/Ideas.md". */
  path: string;
  /** File name without extension. */
  title: string;
  mtime: number;
  size: number;
}

export interface Note extends NoteMeta {
  content: string;
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  snippet: string;
  mtime: number;
}

export type AgentEventType = 'status' | 'tool' | 'delta' | 'done' | 'error';

export interface AgentEvent {
  type: AgentEventType;
  /** Human readable status or tool label. */
  text?: string;
  /** Tool name for `tool` events. */
  tool?: string;
  /** Tool arguments summary for `tool` events. */
  args?: Record<string, unknown>;
}

export interface AgentAction {
  kind: 'created' | 'appended' | 'updated';
  path: string;
}

export interface AgentResult {
  text: string;
  /** Notes that were read/searched while answering. */
  sources: string[];
  /** Files that were created or modified. */
  actions: AgentActionWithLabel[];
  usage?: { promptTokens: number; completionTokens: number };
}

export interface AgentActionWithLabel extends AgentAction {
  label: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmConfig {
  /** OpenAI-compatible base URL, e.g. https://openrouter.ai/api/v1 or http://ollama:11434/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** Extra headers (e.g. OpenRouter HTTP-Referer). */
  headers?: Record<string, string>;
}
