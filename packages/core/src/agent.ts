import type { AgentEvent, AgentResult, ChatMessage, AgentActionWithLabel } from './types.js';
import type { LlmClient } from './llm.js';
import type { Vault } from './vault.js';
import { executeTool, toolDefinitions } from './tools.js';
import { parseSlash, type SlashCommand } from './commands.js';
import { appendToDaily, createNote, dailyPath, extractTasks } from './notes.js';
import { cleanForDisplay, formatDate } from './templates.js';

export interface AgentOptions {
  vault: Vault;
  llm: LlmClient;
  /** Extra instructions appended to the system prompt (user's own rules). */
  extraSystemPrompt?: string;
  /** Max tool-calling rounds. */
  maxRounds?: number;
  /** User-defined scenarios: name -> prompt. Shown before built-ins. */
  scenarios?: Record<string, string>;
  language?: 'ru' | 'en';
}

export interface RunInput {
  text: string;
  /** Previous turns (user/assistant only) for context. */
  history?: { role: 'user' | 'assistant'; content: string }[];
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
}

function actionLabel(kind: AgentActionWithLabel['kind'], path: string): string {
  const title = path.split('/').pop()?.replace(/\.md$/, '') ?? path;
  switch (kind) {
    case 'created':
      return `Создана заметка «${title}»`;
    case 'appended':
      return `Дописано в «${title}»`;
    default:
      return `Изменена «${title}»`;
  }
}

export function buildSystemPrompt(vault: Vault, extra?: string): string {
  const now = new Date();
  const cfg = vault.config;
  return [
    `Ты — личный ассистент пользователя внутри его хранилища заметок Obsidian. Отвечаешь на русском, кратко и по делу, в Markdown.`,
    `Сегодня ${formatDate(now, 'YYYY-MM-DD')} (${formatDate(now, 'dddd')}), время ${formatDate(now, 'HH:mm')}.`,
    `Отвечай ТОЛЬКО на основании заметок пользователя, полученных через инструменты. Если не нашёл — так и скажи, не выдумывай.`,
    `Инструменты: search_notes (поиск по ключевым словам; формулируй 2-5 слов, пробуй синонимы, если пусто), read_note, list_folder, recent_notes, read_daily, list_tasks — для чтения; create_note, append_daily, append_note — для записи.`,
    `Когда тебя просят показать заметку — верни её текст целиком, без пересказа. Если подходит несколько — перечисли названия и спроси, какую.`,
    `Когда просят записать — пиши сразу, без уточняющих вопросов, если смысл ясен. Не создавай дубликаты: для строчки в день используй append_daily, для самостоятельной мысли — create_note.`,
    `В конце ответа, если использовал заметки, укажи их в виде списка ссылок [[Название]].`,
    `Структура хранилища: входящие — "${cfg.inboxFolder || '(корень)'}", ежедневные заметки — "${cfg.dailyFolder || '(корень)'}" с именем "${cfg.dailyFormat}".`,
    cfg.privateFolders.length ? `Папки ${cfg.privateFolders.map((p) => `"${p}"`).join(', ')} недоступны — не пытайся их читать.` : '',
    extra ?? '',
  ]
    .filter(Boolean)
    .join('\n');
}

export class Agent {
  private readonly vault: Vault;
  private readonly llm: LlmClient;
  private readonly opts: AgentOptions;

  constructor(opts: AgentOptions) {
    this.vault = opts.vault;
    this.llm = opts.llm;
    this.opts = opts;
  }

  /** Commands available to the UI (user scenarios first). */
  listCommands(): { name: string; label: string; group: string; hint?: string }[] {
    const user = Object.keys(this.opts.scenarios ?? {}).map((name) => ({ name, label: name, group: 'scenario' }));
    const builtIn = parseSlashList();
    return [...user, ...builtIn];
  }

  async run(input: RunInput): Promise<AgentResult> {
    const emit = input.onEvent ?? (() => {});
    const trimmed = input.text.trim();
    if (!trimmed) return { text: 'Пустое сообщение.', sources: [], actions: [] };

    // 1. user scenarios
    const scen = /^\/([^\s]+)\s*([\s\S]*)$/.exec(trimmed);
    if (scen && this.opts.scenarios?.[scen[1]]) {
      const prompt = `${this.opts.scenarios[scen[1]]}\n\n${scen[2]}`.trim();
      return this.runLlm(prompt, input, emit);
    }

    // 2. built-in slash commands
    const parsed = parseSlash(trimmed);
    if (parsed) {
      if (parsed.command.direct) {
        return this.runDirect(parsed.command, parsed.arg, emit);
      }
      const prompt = parsed.command.prompt!(parsed.arg);
      return this.runLlm(prompt, input, emit);
    }

    // 3. free text
    return this.runLlm(trimmed, input, emit);
  }

  /** Fast path: no LLM involved. */
  private async runDirect(cmd: SlashCommand, arg: string, emit: (e: AgentEvent) => void): Promise<AgentResult> {
    const actions: AgentActionWithLabel[] = [];
    const sources: string[] = [];
    const act = (kind: AgentActionWithLabel['kind'], path: string) =>
      actions.push({ kind, path, label: actionLabel(kind, path) });
    switch (cmd.direct) {
      case 'quick': {
        if (!arg) return { text: 'Напишите текст заметки после /quick.', sources, actions };
        const title = arg.split('\n')[0].slice(0, 60);
        const p = await createNote(this.vault, { title, content: arg });
        act('created', p);
        emit({ type: 'done' });
        return { text: `Записал: [[${p.replace(/\.md$/, '')}]]`, sources, actions };
      }
      case 'daily': {
        if (!arg) return { text: 'Напишите строку после /daily.', sources, actions };
        const p = await appendToDaily(this.vault, arg);
        act('appended', p);
        return { text: `Добавил в сегодняшний день: [[${p.replace(/\.md$/, '')}]]`, sources, actions };
      }
      case 'task': {
        if (!arg) return { text: 'Напишите задачу после /task.', sources, actions };
        const p = await appendToDaily(this.vault, arg, { asTask: true, withTime: false });
        act('appended', p);
        return { text: `Задача добавлена: [[${p.replace(/\.md$/, '')}]]`, sources, actions };
      }
      case 'show': {
        if (!arg) return { text: 'Укажите название заметки после /show.', sources, actions };
        const found = await this.vault.findByTitle(arg);
        if (found.length === 0) return { text: `Не нашёл заметку «${arg}».`, sources, actions };
        if (found.length > 1) {
          return {
            text: `Нашёл несколько, какую открыть?\n${found.slice(0, 10).map((f) => `- /show ${f.path}`).join('\n')}`,
            sources: found.map((f) => f.path),
            actions,
          };
        }
        const note = await this.vault.readNote(found[0].path);
        sources.push(note.path);
        return { text: `**${note.path}**\n\n${cleanForDisplay(note.content)}`, sources, actions };
      }
      case 'last': {
        const all = (await this.vault.listNotes()).sort((a, b) => b.mtime - a.mtime);
        if (!all.length) return { text: 'Хранилище пустое.', sources, actions };
        const note = await this.vault.readNote(all[0].path);
        sources.push(note.path);
        return { text: `**${note.path}**\n\n${cleanForDisplay(note.content)}`, sources, actions };
      }
      case 'today_tasks': {
        const p = dailyPath(this.vault);
        if (!(await this.vault.exists(p))) return { text: 'Сегодняшней заметки ещё нет.', sources, actions };
        const note = await this.vault.readNote(p);
        sources.push(p);
        const tasks = extractTasks(note.content);
        if (!tasks.length) return { text: 'В сегодняшней заметке нет задач.', sources, actions };
        return { text: tasks.map((t) => `- ${t}`).join('\n'), sources, actions };
      }
      default:
        return { text: 'Неизвестная команда.', sources, actions };
    }
  }

  private async runLlm(prompt: string, input: RunInput, emit: (e: AgentEvent) => void): Promise<AgentResult> {
    const sources = new Set<string>();
    const actions: AgentActionWithLabel[] = [];
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(this.vault, this.opts.extraSystemPrompt) },
      ...(input.history ?? []).slice(-10).map((h) => ({ role: h.role, content: h.content }) as ChatMessage),
      { role: 'user', content: prompt },
    ];
    const maxRounds = this.opts.maxRounds ?? 8;
    let usage = { promptTokens: 0, completionTokens: 0 };

    for (let round = 0; round < maxRounds; round++) {
      emit({ type: 'status', text: round === 0 ? 'Думаю…' : 'Читаю заметки…' });
      const res = await this.llm.chat(messages, toolDefinitions, input.signal);
      if (res.usage) {
        usage = {
          promptTokens: usage.promptTokens + res.usage.promptTokens,
          completionTokens: usage.completionTokens + res.usage.completionTokens,
        };
      }
      const msg = res.message;
      messages.push(msg);
      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) {
        emit({ type: 'done' });
        return {
          text: (msg.content ?? '').trim() || '(пустой ответ модели)',
          sources: Array.from(sources),
          actions,
          usage,
        };
      }
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = {};
        }
        emit({ type: 'tool', tool: call.function.name, args, text: describeTool(call.function.name, args) });
        const out = await executeTool(call.function.name, args, {
          vault: this.vault,
          onSource: (p) => sources.add(p),
          onAction: (kind, p) => actions.push({ kind, path: p, label: actionLabel(kind, p) }),
        });
        messages.push({ role: 'tool', tool_call_id: call.id, content: out });
      }
    }
    // Round limit reached: ask for a final answer without tools
    messages.push({ role: 'user', content: 'Сформулируй итоговый ответ на основании уже полученных данных.' });
    const final = await this.llm.chat(messages, undefined, input.signal);
    emit({ type: 'done' });
    return { text: (final.message.content ?? '').trim(), sources: Array.from(sources), actions, usage };
  }
}

function describeTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'search_notes':
      return `Ищу: ${args.query ?? ''}`;
    case 'read_note':
      return `Читаю: ${args.path ?? ''}`;
    case 'read_daily':
      return `Читаю день ${args.date ?? 'сегодня'}`;
    case 'list_folder':
      return `Смотрю папку ${args.folder || '/'}`;
    case 'recent_notes':
      return 'Смотрю недавние заметки';
    case 'list_tasks':
      return 'Собираю задачи';
    case 'create_note':
      return `Создаю заметку «${args.title ?? ''}»`;
    case 'append_daily':
      return 'Дописываю в сегодняшний день';
    case 'append_note':
      return `Дописываю в ${args.path ?? ''}`;
    default:
      return name;
  }
}

import { slashCommands } from './commands.js';
function parseSlashList() {
  return slashCommands.map((c) => ({ name: c.name, label: c.label, group: c.group, hint: c.hint }));
}
