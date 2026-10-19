import { DomainError } from '@relay/core';
import type { ChatStore, SummaryRequest } from './chat-store.js';
import type { ChatMemoryService } from './chat-memory.js';
import type { ProviderRegistry } from './providers.js';
import type { Scheduler, JobLease } from './scheduler.js';

/** ChatStore's outbox survives a crash between saving a result and enqueueing a job. */
export class SummaryJobs {
  private readonly controllers = new Set<AbortController>();
  constructor(private readonly store: ChatStore, private readonly memory: ChatMemoryService, private readonly providers: ProviderRegistry, private readonly allowed: (device: number) => boolean) {}
  private key(request:SummaryRequest):string {return `summary:${request.device}:${request.chat}:${request.generation}:${request.target}:${request.revision}:${this.store.memory(request.device,request.chat).throughMessageId}`;}
  status(device:number,chat:string,scheduler:Scheduler):'queued'|'idle'|'failed' {const request=this.store.summaryRequests().find(r=>r.device===device&&r.chat===chat);if(!request)return 'idle';return scheduler.find(this.key(request))?.state==='failed'?'failed':'queued';}
  recover(scheduler: Scheduler): void {
    for (const request of this.store.summaryRequests()) {
      scheduler.enqueue('summarize', this.key(request), Date.now(), 0, { ...request });
    }
    scheduler.wake();
  }
  async run(lease: JobLease, scheduler: Scheduler): Promise<unknown> {
    const payload = lease.payload as unknown as SummaryRequest;
    const request = this.store.summaryRequests().find(r => r.device === payload.device && r.chat === payload.chat && r.generation === payload.generation && r.target === payload.target && r.revision===payload.revision);
    if (!request) return { status: 'obsolete' };
    if (!this.allowed(request.device)) { this.store.completeSummary(request); return { status: 'revoked' }; }
    lease.assert();
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(30_000, request.expiresAt - Date.now()))); timer.unref();
    let binding: ReturnType<ProviderRegistry['bindChat']> = null;
    try {
      const current = this.providers.list().items.find(p => p.id === request.providerId);
      if (current?.enabled && current.version === request.providerVersion) binding = this.providers.bindChat(current.id, false);
      const guard = () => {
        lease.assert();
        if (!this.allowed(request.device) || this.store.memoryGeneration(request.device, request.chat) !== request.generation) throw new DomainError('JOB_CANCELLED', 'Память этого поколения чата уже недоступна.', 409);
      };
      guard();
      const previous = this.store.memory(request.device, request.chat).throughMessageId;
      const result = await this.memory.context(request.device, request.chat, binding?.client ?? null, controller.signal, request.force, 1, guard);
      guard();
      const remaining = this.store.since(request.device, request.chat, result.memory.throughMessageId, 100_000).filter(m => m.id <= request.target);
      if (remaining.length <= (request.force ? 0 : 10)) this.store.completeSummary(request);
      else if (result.memory.throughMessageId === previous) throw new DomainError('PROVIDER_BUSY', 'Суммаризация отложена после изменения контекста.', 429);
      return { status: 'ready', throughMessageId: result.memory.throughMessageId, remaining: remaining.length };
    } catch (e) {
      if (e instanceof DomainError && ['CHAT_NOT_FOUND', 'MEMORY_EXPIRED', 'JOB_CANCELLED'].includes(e.code)) { this.store.completeSummary(request); return { status: 'expired' }; }
      throw e;
    } finally { clearTimeout(timer); binding?.release(); this.controllers.delete(controller); this.recover(scheduler); }
  }
  stop(): void { for (const controller of this.controllers) controller.abort(); }
}
