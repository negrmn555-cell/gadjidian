import { createHmac, randomBytes } from 'node:crypto';
import type { RunMeasurements } from '@relay/core';
import { guardedTransport, validateEndpointPolicy } from './provider-transport.js';
import type { ServerConfig } from './config.js';

interface TraceContext {requestId?:string;chatId?:string;deviceId?:number;engine?:string;providerId?:string;providerVersion?:number;modelId?:string;indexPending?:number;eventLoopP95Ms?:number}
const outcomes=new Set(['success','failed','partial','cancelled','needs_input']);
const stages=new Set(['auth','context','search','tool','provider','finalize','mutation','queue','sync','sync_freshness','vault_write']);
const number=(value:unknown,max=1e12)=>typeof value==='number'&&Number.isFinite(value)?Math.max(0,Math.min(max,value)):0;
type Attribute={key:string;value:{stringValue:string}|{doubleValue:number}|{boolValue:boolean}};
function attributes(value:Record<string,string|number|boolean>):Attribute[]{return Object.entries(value).map(([key,v])=>({key,value:typeof v==='number'?{doubleValue:v}:typeof v==='boolean'?{boolValue:v}:{stringValue:v}}));}
const nano=(ms:number)=>String(BigInt(Math.round(ms*1e6)));

/** Explicit allowlist before serialization. No automatic SDK/LLM instrumentation. */
export class Diagnostics {
  private salt=randomBytes(32);
  private queue:{body:string;created:number}[]=[];
  private active:Promise<void>|null=null;
  private controller:AbortController|null=null;
  private stopped=false;private configured=false;private endpoint='';
  private sent=0;private dropped=0;private failures=0;private lastSuccess:number|null=null;
  private samples:{durationMs:number;firstTextMs?:number;failed:boolean;rssBytes:number;eventLoopP95Ms:number}[]=[];
  private fetcher:typeof fetch;
  constructor(private config:ServerConfig['diagnostics'],transport?:typeof fetch){
    this.fetcher=transport??guardedTransport(config?.allowedOrigins??[],3000);
    if(config?.enabled&&config.publicKey&&config.secretKey)try{this.endpoint=validateEndpointPolicy(config.baseUrl,config.allowedOrigins).toString().replace(/\/$/,'')+'/api/public/otel/v1/traces';this.configured=true;}catch{}
  }
  private opaque(value:unknown){return createHmac('sha256',this.salt).update(String(value??'')).digest('hex');}
  record(metrics:RunMeasurements,context:TraceContext={}){
    try{
      const duration=number(metrics.durationMs),failed=!['success','needs_input'].includes(metrics.outcome),end=Date.now(),start=end-duration;
      this.samples.push({durationMs:duration,...(metrics.firstTextMs!==undefined?{firstTextMs:number(metrics.firstTextMs)}:{}),failed,rssBytes:number(metrics.rssBytes),eventLoopP95Ms:number(context.eventLoopP95Ms)});this.samples=this.samples.slice(-200);
      if(!this.configured||this.stopped)return;
      const traceId=randomBytes(16).toString('hex'),rootId=randomBytes(8).toString('hex');
      const metadata:Record<string,string|number|boolean>={
        'langfuse.trace.name':'relay.chat','langfuse.trace.public':false,'langfuse.observation.type':'agent','langfuse.release':'agent-9-10',
        'langfuse.trace.metadata.request_ref':this.opaque(context.requestId),'langfuse.session.id':this.opaque(String(context.deviceId)+':'+context.chatId),
        'langfuse.trace.metadata.engine':context.engine==='mastra'?'mastra':context.engine==='legacy'?'legacy':'direct',
        'langfuse.trace.metadata.provider_ref':this.opaque(context.providerId),'langfuse.trace.metadata.provider_version':number(context.providerVersion),
        'langfuse.trace.metadata.model_ref':this.opaque(context.modelId),'langfuse.trace.metadata.prompt_version':'relay-v1',
        'langfuse.trace.metadata.outcome':outcomes.has(metrics.outcome)?metrics.outcome:'failed',
        'langfuse.trace.metadata.provider_calls':number(metrics.providerCalls),'langfuse.trace.metadata.steps':number(metrics.providerCalls),
        'langfuse.trace.metadata.prompt_tokens':number(metrics.promptTokens),'langfuse.trace.metadata.completion_tokens':number(metrics.completionTokens),
        'langfuse.trace.metadata.cache_hits':number(metrics.cacheHits),'langfuse.trace.metadata.cache_misses':number(metrics.cacheMisses),
        'langfuse.trace.metadata.index_pending':number(context.indexPending),'langfuse.trace.metadata.rss_bytes':number(metrics.rssBytes),
        'langfuse.trace.metadata.event_loop_p95_ms':number(context.eventLoopP95Ms),'langfuse.trace.metadata.retention_days':number(this.config?.retentionDays,14),
        ...(metrics.firstTextMs!==undefined?{'langfuse.trace.metadata.first_text_ms':number(metrics.firstTextMs)}:{}),
      };
      const spans=[{traceId,spanId:rootId,name:'relay.chat',kind:1,startTimeUnixNano:nano(start),endTimeUnixNano:nano(end),attributes:attributes(metadata),status:{code:failed?2:1}},
        ...(metrics.timeline??[]).filter(s=>stages.has(s.stage)).slice(0,64).map(s=>{const offset=Math.min(duration,number(s.offsetMs)),length=Math.min(duration-offset,number(s.durationMs));return {traceId,spanId:randomBytes(8).toString('hex'),parentSpanId:rootId,name:'relay.'+s.stage,kind:1,startTimeUnixNano:nano(start+offset),endTimeUnixNano:nano(start+offset+length),attributes:attributes({'langfuse.observation.type':s.stage==='provider'?'generation':'span'}),status:{code:s.failed?2:1}};})];
      const body=JSON.stringify({resourceSpans:[{resource:{attributes:attributes({'service.name':'obsidian-relay'})},scopeSpans:[{scope:{name:'relay.explicit-metadata',version:'1'},spans}]}]});
      if(body.length>128000||this.queue.length>=32){this.dropped++;return;}this.queue.push({body,created:end});this.pump();
    }catch{this.failures++;}
  }
  private pump(){if(this.active||this.stopped||!this.queue.length)return;const work=this.send().catch(()=>{this.failures++;}).finally(()=>{if(this.active===work)this.active=null;this.pump();});this.active=work;}
  private async send(){const item=this.queue.shift()!;if(Date.now()-item.created>30000){this.dropped++;return;}const controller=new AbortController();this.controller=controller;const timeout=setTimeout(()=>controller.abort(),3000);timeout.unref();try{
    const response=await this.fetcher(this.endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:'Basic '+Buffer.from(this.config!.publicKey+':'+this.config!.secretKey).toString('base64'),'x-langfuse-ingestion-version':'4'},body:item.body,signal:controller.signal,redirect:'error'});
    if(!response.ok){await response.body?.cancel();throw new Error('EXPORT_REJECTED');}
    const result=response.status===204?{}:await response.json() as {partialSuccess?:{rejectedSpans?:number|string}};if(Number(result.partialSuccess?.rejectedSpans??0)>0)throw new Error('EXPORT_PARTIAL');
    this.sent++;this.lastSuccess=Date.now();
  }finally{clearTimeout(timeout);if(this.controller===controller)this.controller=null;}}
  status(){const sorted=(key:'durationMs'|'firstTextMs')=>this.samples.map(s=>s[key]).filter((v):v is number=>v!==undefined).sort((a,b)=>a-b),percentile=(values:number[],p:number)=>values.length?values[Math.max(0,Math.ceil(values.length*p)-1)]:null,latencies=sorted('durationMs'),first=sorted('firstTextMs');return {enabled:!!this.config?.enabled,configured:this.configured,mode:'metadata_only' as const,retentionDays:this.config?.retentionDays??14,retentionManagedBy:'langfuse_project' as const,pending:this.queue.length+(this.active?1:0),sent:this.sent,dropped:this.dropped,failures:this.failures,lastSuccess:this.lastSuccess,sampleCount:this.samples.length,p50Ms:percentile(latencies,.5),p95Ms:percentile(latencies,.95),firstTextP95Ms:percentile(first,.95),errors:this.samples.filter(s=>s.failed).length,rssBytes:this.samples.at(-1)?.rssBytes??process.memoryUsage().rss,eventLoopP95Ms:this.samples.at(-1)?.eventLoopP95Ms??0};}
  async flush(timeoutMs=1000){const until=Date.now()+Math.max(0,Math.min(2000,timeoutMs));while((this.active||this.queue.length)&&Date.now()<until){this.pump();await Promise.race([this.active??Promise.resolve(),new Promise(r=>setTimeout(r,Math.min(25,Math.max(1,until-Date.now()))))]);}}
  async stop(){await this.flush(1000);this.stopped=true;this.dropped+=this.queue.length;this.queue=[];this.controller?.abort();await this.active;}
}
