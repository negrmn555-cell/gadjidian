import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

export interface RunMeasurements {
  durationMs: number; stages: Record<string, { calls: number; totalMs: number }>;
  providerCalls: number; inputChars: number; promptTokens: number; completionTokens: number;
  outcome: string; rssBytes: number;
  firstTextMs?: number;
  cacheHits?:number; cacheMisses?:number;
  timeline?:{stage:string;offsetMs:number;durationMs:number;failed?:boolean}[];
}
const scope = new AsyncLocalStorage<Omit<RunMeasurements, 'durationMs' | 'rssBytes'> & {startedAt:number}>();
export function withoutMeasurements<T>(work:()=>T):T {return scope.exit(work);}
export function recordDuration(stage: string, ms: number,failed=false): void {
  const metrics = scope.getStore(); if (!metrics) return;
  const entry = metrics.stages[stage] ??= { calls: 0, totalMs: 0 }; entry.calls++; entry.totalMs += Math.max(0, ms);
  if((metrics.timeline??=[]).length<64)metrics.timeline.push({stage,offsetMs:Math.max(0,performance.now()-metrics.startedAt-ms),durationMs:Math.max(0,ms),failed});
}
export function recordFirstText(ms: number): void { const metrics=scope.getStore();if(metrics&&metrics.firstTextMs===undefined)metrics.firstTextMs=Math.max(0,ms); }
export function recordCache(hit:boolean):void {const metrics=scope.getStore();if(metrics){const key=hit?'cacheHits':'cacheMisses';metrics[key]=(metrics[key]??0)+1;}}
export async function measure<T>(stage: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now();let failed=false;try { return await work(); } catch(e){failed=true;throw e;}finally { recordDuration(stage, performance.now() - start,failed); }
}
export function recordProvider(inputChars: number, usage?: { promptTokens: number; completionTokens: number }): void {
  const metrics = scope.getStore(); if (!metrics) return;
  metrics.providerCalls++; metrics.inputChars += inputChars; metrics.promptTokens += usage?.promptTokens ?? 0; metrics.completionTokens += usage?.completionTokens ?? 0;
}
export async function measureRun<T>(work: () => Promise<T>, report: (metrics: RunMeasurements) => void): Promise<T> {
  const start = performance.now();
  const metrics = { stages: {}, providerCalls: 0, inputChars: 0, promptTokens: 0, completionTokens: 0, outcome: 'failed',startedAt:start };
  return scope.run(metrics, async () => {
    try { const result = await work(); metrics.outcome = (result as { outcome?: string })?.outcome ?? 'success'; return result; }
    finally { const {startedAt:_start,...safe}=metrics;report({ ...safe, durationMs: performance.now() - start, rssBytes: process.memoryUsage().rss }); }
  });
}
