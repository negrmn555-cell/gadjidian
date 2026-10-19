import type { ChatMessage, LlmConfig, ToolDefinition } from './types.js';
import { nativeChat } from './native-llm.js';
import { measure, recordProvider } from './metrics.js';
import { sseData } from './sse.js';

export interface ChatOptions { toolChoice?: unknown; responseFormat?: unknown; maxTokens?: number; onDelta?: (text: string) => void }

export interface ChatCompletionResult {
  message: ChatMessage;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export class LlmError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Thin OpenAI-compatible chat client (works with OpenAI, OpenRouter, Ollama, LM Studio, vLLM). */
export class LlmClient {
  constructor(private readonly cfg: LlmConfig, private readonly transport: typeof fetch = fetch) {}

  get model(): string {
    return this.cfg.model;
  }

  async chat(messages: ChatMessage[], tools?: ToolDefinition[], signal?: AbortSignal, options?: ChatOptions): Promise<ChatCompletionResult> {
    let usage:ChatCompletionResult['usage'];
    try {const result=await measure('provider',()=>this.complete(messages,tools,signal,options));usage=result.usage;return result;}
    finally {recordProvider(messages.reduce((n,m)=>n+(m.content?.length??0),0),usage);}
  }
  private async complete(messages: ChatMessage[], tools?: ToolDefinition[], signal?: AbortSignal, options?: ChatOptions): Promise<ChatCompletionResult> {
    const maxTokens=options?.maxTokens===undefined?this.cfg.maxTokens:Math.max(1,Math.min(this.cfg.maxTokens??4096,Math.floor(options.maxTokens)));
    if(this.cfg.adapter&&this.cfg.adapter!=='openai_compatible')return nativeChat({...this.cfg,maxTokens},this.transport,messages,tools,signal,options);
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: messages.map(({ parts, nativeParts:_native, ...message }) => ({ ...message, content: parts ?? message.content })),
      temperature: this.cfg.temperature ?? 0.3,
    };
    if(messages.some(m=>m.parts?.some(p=>p.type==='file'))&&new URL(this.cfg.baseUrl).hostname==='openrouter.ai')body.plugins=[{id:'file-parser',pdf:{engine:'native'}}];
    if (maxTokens) body.max_tokens = maxTokens;
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = options?.toolChoice ?? 'auto';
    }
    if (options?.responseFormat) body.response_format = options.responseFormat;
    if (options?.onDelta) { body.stream = true; body.stream_options = { include_usage: true }; }
    const res = await this.transport(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        ...(this.cfg.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new LlmError('LLM request failed: HTTP ' + res.status, res.status);
    }
    if (options?.onDelta && res.headers.get('content-type')?.includes('text/event-stream')) {
      if (!res.body) throw new LlmError('Пустой поток модели.');
      let content = '', finishReason = '', usage: ChatCompletionResult['usage'], complete = false;
      const calls = new Map<number, NonNullable<ChatMessage['tool_calls']>[number]>();
      for await (const data of sseData(res.body)) {
        signal?.throwIfAborted();
        if (data === '[DONE]') { complete = true; break; }
        let frame: any;
        try { frame = JSON.parse(data); } catch { throw new LlmError('Некорректный кадр SSE.'); }
        if (frame.error) throw new LlmError('Ошибка API в потоке модели.');
        const choice = frame.choices?.[0];
        if (typeof choice?.delta?.content === 'string') { content += choice.delta.content; options.onDelta(choice.delta.content); }
        for (const delta of choice?.delta?.tool_calls ?? []) {
          if (!Number.isInteger(delta.index) || delta.index < 0 || delta.index >= 32) throw new LlmError('Некорректный вызов инструмента.');
          const call = calls.get(delta.index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
          call.id += delta.id ?? ''; call.function.name += delta.function?.name ?? ''; call.function.arguments += delta.function?.arguments ?? '';
          if (call.function.arguments.length > 128_000) throw new LlmError('Слишком большие аргументы инструмента.');
          calls.set(delta.index, call);
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (frame.usage) usage = { promptTokens: Number(frame.usage.prompt_tokens ?? 0), completionTokens: Number(frame.usage.completion_tokens ?? 0) };
      }
      if (!complete || !finishReason) throw new LlmError('Поток модели прерван до завершения.');
      for (const c of calls.values()) { if (!c.id || !c.function.name) throw new LlmError('Неполный вызов инструмента.'); try { const a = JSON.parse(c.function.arguments); if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error(); } catch { throw new LlmError('Некорректные аргументы инструмента.'); } }
      return { message: { role: 'assistant', content: content || null, ...(calls.size ? { tool_calls: [...calls.entries()].sort(([a],[b])=>a-b).map(([,call])=>call) } : {}) }, finishReason, usage };
    }
    let data: {
      choices: { message: ChatMessage; finish_reason: string }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    try { data = await res.json() as typeof data; } catch { throw new LlmError('Модель вернула некорректный JSON.'); }
    if (!data || typeof data !== 'object' || !Array.isArray(data.choices)) throw new LlmError('Модель вернула некорректный ответ.');
    const choice = data.choices[0];
    if (!choice || choice.message?.role !== 'assistant' ||
      (choice.message.content !== null && typeof choice.message.content !== 'string' && !(choice.message.content === undefined && choice.message.tool_calls?.length)) ||
      (choice.message.tool_calls !== undefined && (!Array.isArray(choice.message.tool_calls) || choice.message.tool_calls.length > 32 || choice.message.tool_calls.some(c => !c || typeof c.id !== 'string' || c.type !== 'function' || typeof c.function?.name !== 'string' || typeof c.function?.arguments !== 'string')))) {
      throw new LlmError('Модель вернула некорректный ответ.');
    }
    if (options?.onDelta && choice.message.content) options.onDelta(choice.message.content);
    return {
      message: { role:'assistant',content: choice.message.content ?? null,...(choice.message.tool_calls?{tool_calls:choice.message.tool_calls}:{} ) },
      finishReason: choice.finish_reason,
      usage: data.usage
        ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
        : undefined,
    };
  }

}
