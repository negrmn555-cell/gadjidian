import type { ChatMessage, LlmConfig, ToolDefinition } from './types.js';

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
  constructor(private readonly cfg: LlmConfig) {}

  get model(): string {
    return this.cfg.model;
  }

  async chat(messages: ChatMessage[], tools?: ToolDefinition[], signal?: AbortSignal): Promise<ChatCompletionResult> {
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      temperature: this.cfg.temperature ?? 0.3,
    };
    if (this.cfg.maxTokens) body.max_tokens = this.cfg.maxTokens;
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    const res = await fetch(url, {
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
      const text = await res.text().catch(() => '');
      throw new LlmError(`LLM request failed: ${res.status} ${text.slice(0, 300)}`, res.status);
    }
    const data = (await res.json()) as {
      choices: { message: ChatMessage; finish_reason: string }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const choice = data.choices?.[0];
    if (!choice) throw new LlmError('LLM returned no choices');
    return {
      message: choice.message,
      finishReason: choice.finish_reason,
      usage: data.usage
        ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
        : undefined,
    };
  }

  /** Transcribe audio via OpenAI-compatible /audio/transcriptions (Whisper). */
  async transcribe(audio: Blob, fileName: string, model = 'whisper-1', language?: string): Promise<string> {
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;
    const form = new FormData();
    form.append('file', audio, fileName);
    form.append('model', model);
    if (language) form.append('language', language);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        ...(this.cfg.headers ?? {}),
      },
      body: form,
    });
    if (!res.ok) throw new LlmError(`Transcription failed: ${res.status}`, res.status);
    const data = (await res.json()) as { text: string };
    return data.text;
  }
}
