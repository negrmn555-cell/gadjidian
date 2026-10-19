import type { AgentEvent, ChatMessage, ToolDefinition } from './types.js';
import type { ChatCompletionResult, LlmClient } from './llm.js';

export interface AgentLoopInput {
  llm: LlmClient;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  execute: (name: string, args: Record<string, unknown>, callId: string) => Promise<string>;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
  maxSteps: number;
  control?: AgentRunControl;
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
}
export type AgentLoop = (input: AgentLoopInput) => Promise<ChatCompletionResult>;

export const completionRules = `Отсутствие информации — нормальный результат. Отвечай только по найденным данным, не выдумывай отсутствующие факты. Если запрос существенно неоднозначен, задай один конкретный уточняющий вопрос с вариантами; перед записью обязательно уточни объект и требуемое изменение. Не делай запись ради ответа на поисковый вопрос.
search_notes возвращает JSON: status=ok/empty/error, returnedCount, hasMore, results с path/chunkId. Пустой поиск означает отсутствие совпадений по этой формулировке, а не отсутствие информации во всём хранилище. После пустого поиска допустима одна осмысленная переформулировка (синонимы, исправление опечатки, более широкий запрос). После двух поисков без новых источников остановись: ответь по найденному или уточни вопрос. Ошибку инструмента назови ошибкой проверки, не отсутствием информации. Если заметка найдена, но нужного факта в прочитанном тексте нет, скажи именно это. Не повторяй одинаковые вызовы. Если данных достаточно, сразу отвечай.`;

/** Per-run local state; it never makes a classification call or stores note content. */
export class AgentRunControl {
  private sources = new Set<string>();
  private reads = new Set<string>();
  private noProgress = 0;
  private progress = false;
  private extended = false;
  reason: 'search_exhausted' | 'tool_error' | 'step_limit' | undefined;
  observe(name: string, args: Record<string, unknown>, output: string) {
    if (/^Error[: (]/.test(output)) { this.reason = 'tool_error'; this.progress = false; return; }
    if (name === 'search_notes') {
      const result = JSON.parse(output);
      if (result.status === 'error') { this.reason = 'tool_error'; this.progress = false; return; }
      let added = 0;
      for (const hit of result.results ?? []) {
        const id = JSON.stringify([hit.path, hit.chunkId]);
        if (!this.sources.has(id)) { this.sources.add(id); added++; }
      }
      this.progress = added > 0;
      this.noProgress = added ? 0 : this.noProgress + 1;
      if (this.noProgress >= 2) this.reason = 'search_exhausted';
    } else {
      const key = JSON.stringify([name, args]);
      this.progress = !this.reads.has(key); this.reads.add(key);
    }
  }
  finalStep(step: number, base: number): boolean {
    if (this.reason) return true;
    if (step < base) return false;
    if (step === base && base >= 4 && base < 6 && this.progress) this.extended = true;
    if (step < (this.extended ? 6 : base)) return false;
    this.reason = 'step_limit'; return true;
  }
  reminder() {
    return 'Это финальное обращение. Инструменты отключены. Дай ответ по уже полученным данным; укажи, что не удалось проверить, или задай один уточняющий вопрос. Не утверждай, что запись выполнена без подтверждения инструмента. Причина завершения: ' + this.reason;
  }
  fallback() {
    return this.reason === 'tool_error' ? 'Не удалось проверить информацию из-за ошибки инструмента. Достоверный ответ пока дать не могу. Повторите запрос позже.' : this.reason === 'search_exhausted' ? 'По выполненным поискам не удалось получить новые данные для ответа. Уточните формулировку или укажите нужную заметку.' : 'Не удалось завершить проверку всех данных за один запрос. Уточните, какую часть вопроса разобрать в первую очередь.';
  }
}

export interface ToolSpec { name: string; effect: 'read' | 'write'; timeoutMs: number; outputChars: number }
export function toolSpec(name: string): ToolSpec {
  return { name, effect: ['search_notes','read_note','read_section','read_attachment','list_folder','recent_notes','read_daily','list_tasks'].includes(name) ? 'read' : 'write', timeoutMs: 10_000, outputChars: 16_000 };
}
/** FIFO write barriers: two reads may overlap; writes and dependent reads cannot. */
export class ToolScheduler {
  private active = 0;
  private writing = false;
  private queue: { write: boolean; start: () => void }[] = [];
  run<T>(spec: ToolSpec, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const write = spec.effect === 'write';
      this.queue.push({ write, start: () => {
        this.active++; this.writing = write;
        void work().then(resolve, reject).finally(() => { this.active--; this.writing = false; this.drain(); });
      } }); this.drain();
    });
  }
  private drain() {
    while (this.queue.length && !this.writing && this.active < 2) {
      if (this.queue[0].write && this.active) return;
      this.queue.shift()!.start();
    }
  }
}

export async function withReadTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_,reject) => { timer = setTimeout(() => reject(new Error('Истекло время чтения инструмента.')), ms); timer.unref(); })]); }
  finally { clearTimeout(timer); }
}

/** Current attachments are explicit. History and summaries have separate character budgets. */
export function boundedHistory(history: { role: 'user' | 'assistant'; content: string }[], budget = 24_000): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of history.slice(-10).reverse()) {
    if (m.content.length > budget) break;
    out.unshift({ role: m.role, content: m.content }); budget -= m.content.length;
  }
  return out;
}

/** Validate complete JSON before entering a domain service (also used by the legacy loop). */
export function validateToolArgs(value: unknown, schema: Record<string, any>): asserts value is Record<string, unknown> {
  function check(v: any, s: Record<string, any>): void {
    if (s.enum && !s.enum.includes(v)) throw new Error('Недопустимое значение аргумента.');
    if (s.type === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Аргументы должны быть объектом.');
      for (const k of s.required ?? []) if (!(k in v)) throw new Error('Пропущен обязательный аргумент: ' + k);
      for (const k of Object.keys(v)) { if (!Object.hasOwn(s.properties ?? {}, k)) throw new Error('Неизвестный аргумент: ' + k); check(v[k], s.properties[k]); }
    } else if (s.type === 'array') {
      if (!Array.isArray(v) || v.length > (s.maxItems ?? 100)) throw new Error('Некорректный список аргументов.');
      for (const item of v) if (s.items) check(item, s.items);
    } else if (s.type === 'string') {
      if (typeof v !== 'string' || v.length > (s.maxLength ?? 128_000) || v.length < (s.minLength ?? 0)) throw new Error('Некорректная строка аргумента.');
    } else if (s.type === 'number' || s.type === 'integer') {
      if (typeof v !== 'number' || !Number.isFinite(v) || s.type === 'integer' && !Number.isInteger(v) || v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity)) throw new Error('Некорректное число аргумента.');
    } else if (s.type === 'boolean' && typeof v !== 'boolean') throw new Error('Некорректный флаг аргумента.');
  }
  check(value, schema);
}

export const legacyLoop: AgentLoop = async input => {
  const control = input.control ?? new AgentRunControl();
  let ordinal=0;
  let usage = { promptTokens: 0, completionTokens: 0 };
  for (let step = 0; step < 6; step++) {
    input.signal?.throwIfAborted();
    const estimated=input.messages.reduce((n,m)=>n+(m.content?.length??0),0)/2;
    if(usage.promptTokens+usage.completionTokens+estimated>48_000)throw new Error('Исчерпан бюджет токенов запроса.');
    const final = control.finalStep(step + 1, input.maxSteps);
    if (final) input.messages.push({role:'system',content:control.reminder()});
    const result = await input.llm.chat(input.messages, final ? undefined : input.tools, input.signal, { maxTokens:4096,onDelta: text => input.emit({ type: 'delta', text }) });
    if(result.usage)input.onUsage?.(result.usage);
    if (result.usage) { usage.promptTokens += result.usage.promptTokens; usage.completionTokens += result.usage.completionTokens; }
    else {usage.promptTokens+=Math.ceil(estimated);usage.completionTokens+=Math.ceil((result.message.content?.length??0)/2);}
    if(usage.promptTokens+usage.completionTokens>48_000)throw new Error('Исчерпан бюджет токенов запроса.');
    if (!result.message.tool_calls?.length) return { ...result, usage };
    if (final) return {...result,message:{role:'assistant',content:control.fallback()},usage};
    input.messages.push(result.message);
    for (const call of result.message.tool_calls) {
      const args: unknown = JSON.parse(call.function.arguments);
      const out = await input.execute(call.function.name, args as Record<string, unknown>, 'tool_'+ ++ordinal);
      input.messages.push({ role: 'tool', tool_call_id: call.id, content: out });
    }
  }
  throw new Error('Исчерпан лимит шагов.');
};
