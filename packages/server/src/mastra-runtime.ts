import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { createTool } from '@mastra/core/tools';
import { noopLogger } from '@mastra/core/logger';
import { z } from 'zod';
import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2Content, LanguageModelV2StreamPart } from '@ai-sdk/provider-v5';
import { DomainError, type AgentLoop, type ChatMessage, type ChatCompletionResult } from '@relay/core';

/** Uses the already bound profile client: no environment credentials, SDK fetch or retries. */
export const mastraLoop: AgentLoop = async input => {
  const lifetime = new AbortController();
  const runSignal = AbortSignal.any([lifetime.signal,...(input.signal?[input.signal]:[])]);
  let steps = 0, tokens = 0, last: ChatCompletionResult | undefined;
  let failure: unknown;
  const native = new Map<string, unknown[]>();
  async function complete(options: LanguageModelV2CallOptions, onDelta?: (text: string) => void) {
    if (failure) throw failure;
    if (++steps > input.maxSteps) throw new DomainError('RUN_STEP_BUDGET', 'Исчерпан лимит шагов.');
    runSignal.throwIfAborted();
    const messages: ChatMessage[] = [];
    for (const m of options.prompt) {
      if (m.role === 'system') { messages.push({ role: 'system', content: m.content }); continue; }
      if (m.role === 'tool') {
        for (const p of m.content) messages.push({ role: 'tool', tool_call_id: p.toolCallId, content: p.output.type === 'text' || p.output.type === 'error-text' ? p.output.value : JSON.stringify(p.output.value) });
        continue;
      }
      const text = m.content.flatMap(p => p.type === 'text' ? [p.text] : []).join('');
      const calls = m.content.flatMap(p => p.type === 'tool-call' ? [{ id: p.toolCallId, type: 'function' as const, function: { name: p.toolName, arguments: JSON.stringify(p.input) } }] : []);
      const parts: NonNullable<ChatMessage['parts']> = [{ type: 'text', text }];
      for (const p of m.content) if (p.type === 'file') {
        if(p.mediaType==='application/pdf'){parts.push({type:'file',file:{filename:p.filename??'document.pdf',file_data:p.data instanceof URL?p.data.toString():'data:application/pdf;base64,'+(typeof p.data==='string'?p.data:Buffer.from(p.data).toString('base64'))}});continue;}
        if (!p.mediaType.startsWith('image/') || p.data instanceof URL && p.data.protocol !== 'data:') throw new Error('Недопустимый файл в контексте.');
        parts.push({ type: 'image_url', image_url: { url: p.data instanceof URL ? p.data.toString() : 'data:' + p.mediaType + ';base64,' + (typeof p.data === 'string' ? p.data : Buffer.from(p.data).toString('base64')) } });
      }
      messages.push({ role: m.role, content: text || null, ...(parts.length > 1 ? { parts } : {}), ...(calls.length ? { tool_calls: calls, nativeParts: native.get(calls[0].id) } : {}) });
    }
    const estimated = messages.reduce((n,m) => n + (m.content?.length ?? 0), 0);
    if (tokens + estimated / 2 > 48_000) throw new DomainError('RUN_TOKEN_BUDGET', 'Контекст превысил бюджет запроса.');
    const tools = steps === input.maxSteps ? undefined : options.tools?.filter(t => t.type === 'function').map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema as Record<string, unknown> } }));
    last = await input.llm.chat(messages, tools, AbortSignal.any([runSignal,...(options.abortSignal?[options.abortSignal]:[])]), { onDelta, maxTokens: 4096 });
    if(last.usage)input.onUsage?.(last.usage);
    tokens += (last.usage?.promptTokens ?? Math.ceil(estimated / 2)) + (last.usage?.completionTokens ?? Math.ceil((last.message.content?.length ?? 0) / 2));
    if (tokens > 48_000) throw new DomainError('RUN_TOKEN_BUDGET', 'Исчерпан бюджет токенов запроса.');
    if (last.message.nativeParts) for (const c of last.message.tool_calls ?? []) native.set(c.id, last.message.nativeParts);
    if (steps === input.maxSteps && last.message.tool_calls?.length) throw new DomainError('RUN_STEP_BUDGET', 'Модель превысила лимит шагов.');
    return last;
  }
  function content(result: ChatCompletionResult): LanguageModelV2Content[] {
    return [...(result.message.content ? [{ type: 'text' as const, text: result.message.content }] : []), ...(result.message.tool_calls ?? []).map(c => ({ type: 'tool-call' as const, toolCallId: c.id, toolName: c.function.name, input: c.function.arguments }))];
  }
  const model: LanguageModelV2 = {
    specificationVersion: 'v2', provider: 'relay-profile', modelId: input.llm.model, supportedUrls: { 'image/*': [/^data:/] },
    async doGenerate(options) {
      const result = await complete(options);
      return { content: content(result), finishReason: result.message.tool_calls?.length ? 'tool-calls' : result.finishReason === 'length' ? 'length' : 'stop', usage: { inputTokens: result.usage?.promptTokens, outputTokens: result.usage?.completionTokens, totalTokens: (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0) }, warnings: [] };
    },
    async doStream(options) {
      return { stream: new ReadableStream<LanguageModelV2StreamPart>({ start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] }); controller.enqueue({ type: 'text-start', id: 'answer' });
        void complete(options, delta => controller.enqueue({ type: 'text-delta', id: 'answer', delta })).then(result => {
          // JSON-only compatible endpoints can legitimately decline streaming.
          controller.enqueue({ type: 'text-end', id: 'answer' });
          for (const c of content(result)) if (c.type === 'tool-call') controller.enqueue(c);
          controller.enqueue({ type: 'finish', finishReason: result.message.tool_calls?.length ? 'tool-calls' : result.finishReason === 'length' ? 'length' : 'stop', usage: { inputTokens: result.usage?.promptTokens, outputTokens: result.usage?.completionTokens, totalTokens: (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0) } }); controller.close();
        }, error => { failure = error; controller.error(error); });
      } }) };
    },
  };
  let ordinal = 0;
  const tools = Object.fromEntries(input.tools.map(t => [t.function.name, createTool({
    id: t.function.name, description: t.function.description,
    inputSchema: z.fromJSONSchema({ ...t.function.parameters, additionalProperties: false }),
    execute: async (args,context) => { runSignal.throwIfAborted();context?.abortSignal?.throwIfAborted();if(failure)throw failure;try{return await input.execute(t.function.name, args as Record<string, unknown>, 'tool_' + ++ordinal);}catch(e){failure=e;throw e;} },
  })]));
  const agent = new Agent({ id: 'relay-note', name: 'Relay', instructions: input.messages.filter(m => m.role === 'system').map(m => m.content ?? '').join('\n'), model, tools });
  // Domain errors go through the existing sanitized logger; SDK tool logs can contain note text.
  agent.__setLogger(noopLogger);
  const runtime = new Mastra({ agents: { relay: agent }, logger: false });
  const messages = input.messages.filter(m => m.role !== 'system').map(m => (m.role === 'assistant' ? {role:'assistant' as const,content:m.content??''} : { role: 'user' as const, content: m.parts ? m.parts.map(p => p.type === 'text' ? p : p.type==='file'?{type:'file' as const,data:new URL(p.file.file_data),mediaType:'application/pdf'}:{ type: 'image' as const, image: new URL(p.image_url.url) }) : m.content ?? '' }));
  try {
    const output = await runtime.getAgent('relay').stream(messages, { maxSteps: input.maxSteps, abortSignal: runSignal, toolCallConcurrency: 2, modelSettings: { maxRetries: 0, timeout: { totalMs: 120_000, firstChunkMs: 30_000 } } });
    for await (const text of output.textStream) input.emit({ type: 'delta', text });
    const text = await output.text;
    input.signal?.throwIfAborted();
    if (failure) throw failure;
    if (!last) throw new Error('Mastra не завершила запрос.');
    if (last.message.tool_calls?.length) throw new DomainError('RUN_STEP_BUDGET', 'Запрос не завершён в пределах бюджета шагов.');
    const usage = await output.totalUsage;
    return { ...last, message: { role: 'assistant', content: text || last.message.content }, usage: { promptTokens: usage.inputTokens ?? 0, completionTokens: usage.outputTokens ?? 0 } };
  } finally { lifetime.abort(); await runtime.shutdown(); }
};
