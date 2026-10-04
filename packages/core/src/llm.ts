import type { ChatMessage, LlmConfig, ToolDefinition } from './types.js';
import { nativeChat } from './native-llm.js';

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

  async chat(messages: ChatMessage[], tools?: ToolDefinition[], signal?: AbortSignal, options?: { toolChoice?: unknown; responseFormat?: unknown;maxTokens?:number }): Promise<ChatCompletionResult> {
    const maxTokens=options?.maxTokens===undefined?this.cfg.maxTokens:Math.max(1,Math.min(this.cfg.maxTokens??4096,Math.floor(options.maxTokens)));
    if(this.cfg.adapter&&this.cfg.adapter!=='openai_compatible')return nativeChat({...this.cfg,maxTokens},this.transport,messages,tools,signal,options);
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: messages.map(({ parts, nativeParts:_native, ...message }) => ({ ...message, content: parts ?? message.content })),
      temperature: this.cfg.temperature ?? 0.3,
    };
    if (maxTokens) body.max_tokens = maxTokens;
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = options?.toolChoice ?? 'auto';
    }
    if (options?.responseFormat) body.response_format = options.responseFormat;
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
    return {
      message: { role:'assistant',content: choice.message.content ?? null,...(choice.message.tool_calls?{tool_calls:choice.message.tool_calls}:{} ) },
      finishReason: choice.finish_reason,
      usage: data.usage
        ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
        : undefined,
    };
  }

}
