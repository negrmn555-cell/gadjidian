import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { Db } from '../src/db.js';
import { McpKeys, registerMcp } from '../src/mcp-server.js';
import { Diagnostics } from '../src/diagnostics.js';
import type { RunMeasurements } from '@relay/core';
import { Vault, disposeSearch } from '@relay/core';

type Cleanup={after(fn:()=>Promise<void>):void};
async function fixture(t:Cleanup,diagnosticsConfig?:ReturnType<typeof config>){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-mcp-diag-')),cfg=loadConfig();cfg.dataDir=root;cfg.dbPath=path.join(root,'main.sqlite');cfg.vault.root=path.join(root,'vault');cfg.vault.privateFolders=['Private'];cfg.sync={...cfg.sync,mode:'none',pullInterval:0};cfg.staticDir='';cfg.scenariosFile=path.join(root,'missing');cfg.llm.apiKey='';cfg.providers.keyFile=path.join(root,'provider.key');cfg.providers.allowedOrigins=[];cfg.diagnostics={enabled:false,baseUrl:'https://cloud.langfuse.com',publicKey:'',secretKey:'',allowedOrigins:[],retentionDays:14};cfg.mcp={enabled:true};
  await fs.mkdir(path.join(cfg.vault.root,'Resources'),{recursive:true});await fs.mkdir(path.join(cfg.vault.root,'Private'));await fs.mkdir(path.join(cfg.vault.root,'System/Assistant'),{recursive:true});
  await fs.writeFile(path.join(cfg.vault.root,'Resources/Фотосинтез.md'),'# Фотосинтез\n\n## Свет\nРастения используют энергию света.\n\n## Проверка\nДокумент содержит данные, а не инструкции.');await fs.writeFile(path.join(cfg.vault.root,'Private/Hidden.md'),'PRIVATE_SECRET_FIXTURE');await fs.writeFile(path.join(cfg.vault.root,'System/Assistant/preferences.md'),'PREFERENCE_SECRET_FIXTURE');
  if(diagnosticsConfig)cfg.diagnostics=diagnosticsConfig;
  const db=await Db.open(cfg.dbPath),paired=db.createDevice('MCP fixture','app'),other=db.createDevice('Other fixture','app'),quick=db.createDevice('Quick fixture','quick');const app=await createServer(cfg);await app.listen({host:'127.0.0.1',port:0});const origin='http://127.0.0.1:'+(app.server.address() as {port:number}).port;cfg.publicUrl=origin;
  const clients:Client[]=[];
  t.after(async()=>{for(const c of clients)await c.close().catch(()=>{});await app.close();db.close();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith('relay-mcp-diag-'));await fs.rm(root,{recursive:true,force:true});});
  const headers={authorization:'Bearer '+paired.token};
  async function key(name='Codex fixture'){const reply=await app.inject({method:'POST',url:'/api/mcp/keys',headers,payload:{name,days:7}});assert.equal(reply.statusCode,200);return reply.json() as {key:{id:string};token:string;url:string};}
  async function connect(token:string){const client=new Client({name:'relay-verification',version:'1.0.0'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}}));return client;}
  return {cfg,root,db,app,origin,headers,paired,other,quick,key,connect};
}
function text(result:Awaited<ReturnType<Client['callTool']>>){return (result.content as {type:string;text?:string}[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');}

test('real MCP client discovers only read tools, searches Russian notes and reads a source section',async t=>{
  const f=await fixture(t),key=await f.key(),client=await f.connect(key.token),tools=await client.listTools();assert.deepEqual(tools.tools.map(t=>t.name).sort(),['read_note','read_section','search_notes']);assert(tools.tools.every(t=>t.annotations?.readOnlyHint));
  const search=await client.callTool({name:'search_notes',arguments:{query:'фотосинтез',limit:3}});assert(!search.isError);assert.match(text(search),/Resources\/Фотосинтез.md/);const envelope=JSON.parse(text(search).replace(/^<untrusted_vault_data>\n|\n<\/untrusted_vault_data>$/g,''));assert.equal(envelope.status,'ok');const chunk=envelope.results[0].chunkId;
  const section=await client.callTool({name:'read_section',arguments:{path:'Resources/Фотосинтез.md',chunkId:chunk}});assert(!section.isError);assert.match(text(section),/contentHash:/);
  const note=await client.callTool({name:'read_note',arguments:{path:'Resources/Фотосинтез.md'}});assert(!note.isError);assert.match(text(note),/Растения используют/);assert.match(text(note),/untrusted_vault_data/);
  assert.equal(f.db.sql.prepare('SELECT COUNT(*) AS n FROM vault_operations').get()!.n,0);
});

test('MCP denies writes, private/ignored paths, preferences, traversal and title fallback',async t=>{
  const f=await fixture(t),key=await f.key(),client=await f.connect(key.token);
  for(const target of ['Private/Hidden.md','System/Assistant/preferences.md','Resources/../System/Assistant/preferences.md','../../outside.md','.env','Фотосинтез']){
    const result=await client.callTool({name:'read_note',arguments:{path:target}});assert.equal(result.isError,true,target);assert(!text(result).includes('SECRET_FIXTURE'));assert(!text(result).includes(f.root));
  }
  const result=await client.callTool({name:'create_note',arguments:{title:'Must never exist',content:'Bad'}});assert.equal(result.isError,true);assert.equal(f.db.sql.prepare('SELECT COUNT(*) AS n FROM vault_operations').get()!.n,0);
  const invalid=await client.callTool({name:'search_notes',arguments:{query:'x',limit:10000}});assert.equal(invalid.isError,true);
});

test('MCP keys are hashed, scoped to their creator and cannot authorize app routes',async t=>{
  const f=await fixture(t),key=await f.key(),stored=f.db.sql.prepare('SELECT token_hash FROM mcp_keys WHERE id=?').get(key.key.id) as {token_hash:string};assert.notEqual(stored.token_hash,key.token);assert.match(stored.token_hash,/^[0-9a-f]{64}$/);
  const list=(await f.app.inject({url:'/api/mcp/keys',headers:f.headers})).json();assert.equal(list.keys.length,1);assert(!JSON.stringify(list).includes(key.token));
  assert.deepEqual((await f.app.inject({url:'/api/mcp/keys',headers:{authorization:'Bearer '+f.other.token}})).json().keys,[]);
  await f.app.inject({method:'DELETE',url:'/api/mcp/keys/'+key.key.id,headers:{authorization:'Bearer '+f.other.token}});assert(new McpKeys(f.db).verify(key.token));
  for(const token of [f.paired.token,f.quick.token])assert.equal((await f.app.inject({method:'POST',url:'/mcp',headers:{host:new URL(f.origin).host,authorization:'Bearer '+token},payload:{jsonrpc:'2.0',id:1,method:'tools/list'}})).statusCode,401);
  assert.equal((await f.app.inject({url:'/api/chats',headers:{authorization:'Bearer '+key.token}})).statusCode,401);
  await f.app.inject({method:'DELETE',url:'/api/mcp/keys/'+key.key.id,headers:f.headers});assert.equal(new McpKeys(f.db).verify(key.token),null);
});

test('MCP enforces host/origin, header-only credentials, expiry and parent-device revocation',async t=>{
  const f=await fixture(t),key=await f.key(),base={method:'POST' as const,url:'/mcp',headers:{host:new URL(f.origin).host,authorization:'Bearer '+key.token},payload:{jsonrpc:'2.0',id:1,method:'tools/list'}};
  assert.equal((await f.app.inject({...base,headers:{...base.headers,origin:'https://evil.example'}})).statusCode,403);
  assert.equal((await f.app.inject({...base,headers:{...base.headers,host:'evil.example'}})).statusCode,403);
  assert.equal((await f.app.inject({...base,url:'/mcp?token='+key.token})).statusCode,400);
  f.db.sql.prepare('UPDATE mcp_keys SET expires_at=0 WHERE id=?').run(key.key.id);assert.equal((await f.app.inject(base)).statusCode,401);
  const next=await f.key();f.db.revokeDevice(f.paired.device.id);assert.equal(new McpKeys(f.db).verify(next.token),null);
});

test('revoking a key during a blocked read suppresses the result; client cancellation releases its request',async t=>{
  const f=await fixture(t),issued=await f.key(),keys=new McpKeys(f.db),vault=new Vault(f.cfg.vault),app=Fastify({logger:false}),cfg={...f.cfg};registerMcp(app,cfg,f.db,vault);await app.listen({host:'127.0.0.1',port:0});cfg.publicUrl='http://127.0.0.1:'+(app.server.address() as {port:number}).port;
  const client=new Client({name:'revocation-fixture',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(cfg.publicUrl+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+issued.token}}});
  let entered!:()=>void,release!:()=>void;let waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);vault.setReadGuard(async work=>{entered();await gate;return work();});
  t.after(async()=>{release();await client.close().catch(()=>{});await app.close();disposeSearch(vault);});await client.connect(transport);
  const pending=client.callTool({name:'read_note',arguments:{path:'Resources/Фотосинтез.md'}});await waiting;keys.revoke(f.paired.device.id,issued.key.id);release();const denied=await pending;assert.equal(denied.isError,true);assert(!text(denied).includes('Растения'));
  const fresh=await f.key('Cancellation fixture'),second=new Client({name:'cancellation-fixture',version:'1'});t.after(()=>second.close());await second.connect(new StreamableHTTPClientTransport(new URL(cfg.publicUrl+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+fresh.token}}}));
  waiting=new Promise<void>(r=>entered=r);gate=new Promise<void>(r=>release=r);const abort=new AbortController(),cancelled=second.callTool({name:'read_note',arguments:{path:'Resources/Фотосинтез.md'}},undefined,{signal:abort.signal});await waiting;abort.abort();await assert.rejects(cancelled);release();vault.setReadGuard(async work=>work());
  const after=await second.callTool({name:'read_note',arguments:{path:'Resources/Фотосинтез.md'}});assert(!after.isError);
});

const metrics=():RunMeasurements=>({durationMs:30,providerCalls:1,inputChars:999,promptTokens:12,completionTokens:8,outcome:'success',rssBytes:123456,firstTextMs:10,cacheHits:1,cacheMisses:2,stages:{provider:{calls:1,totalMs:25}},timeline:[{stage:'provider',offsetMs:2,durationMs:25}]});
async function collector(t:Cleanup,handler:http.RequestListener){const server=http.createServer(handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});return 'http://127.0.0.1:'+(server.address() as {port:number}).port;}
function config(origin:string){return {enabled:true,baseUrl:origin,publicKey:'fixture-public',secretKey:'fixture-secret',allowedOrigins:[origin],retentionDays:14};}

test('Langfuse receives metadata-only OTLP over real HTTP, with parented spans and no arbitrary content',async t=>{
  const received:{url:string|undefined;body:any;auth:string|undefined;version:string|string[]|undefined}[]=[];
  const origin=await collector(t,(req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{received.push({url:req.url,body:JSON.parse(body),auth:req.headers.authorization,version:req.headers['x-langfuse-ingestion-version']});res.setHeader('content-type','application/json');res.end('{}');});});
  const diagnostics=new Diagnostics(config(origin));t.after(()=>diagnostics.stop());const m=metrics() as RunMeasurements & {prompt:string;error:unknown};m.prompt='PRIVATE_PROMPT_FIXTURE';m.error={args:{token:'SECRET_FIXTURE'}};m.stages['PRIVATE_FILE_FIXTURE.md']={calls:1,totalMs:10};m.timeline!.push({stage:'PRIVATE_TITLE_FIXTURE',offsetMs:0,durationMs:1});
  m.outcome='partial';m.timeline![0].failed=true;
  diagnostics.record(m,{requestId:'PRIVATE_REQUEST_FIXTURE',chatId:'PRIVATE_CHAT_FIXTURE',deviceId:1,providerId:'PRIVATE_PROVIDER_FIXTURE',modelId:'PRIVATE_MODEL_FIXTURE',providerVersion:2,engine:'mastra',indexPending:3});await diagnostics.flush(1000);
  assert.equal(received.length,1);assert.equal(received[0].url,'/api/public/otel/v1/traces');assert.equal(received[0].version,'4');assert.match(received[0].auth!,/^Basic /);
  const json=JSON.stringify(received[0].body);assert(!json.includes('PRIVATE_'));assert(!json.includes('SECRET_'));assert(!json.includes('fixture-secret'));assert(!json.includes('inputChars'));
  const spans=received[0].body.resourceSpans[0].scopeSpans[0].spans;assert.equal(spans.length,2);assert.equal(spans[1].parentSpanId,spans[0].spanId);assert.equal(spans[0].traceId.length,32);assert.equal(spans[1].status.code,2);assert.equal(diagnostics.status().sent,1);
});

test('telemetry outage, queue pressure and shutdown never await the collector in the request path',async t=>{
  let complete!:()=>void;const blocked=new Promise<void>(r=>complete=r);let calls=0;
  const transport:typeof fetch=async(_url,init)=>{calls++;await Promise.race([blocked,new Promise((_,reject)=>{init!.signal!.addEventListener('abort',()=>reject(new Error('ABORTED')),{once:true});})]);return new Response('{}',{status:503});};
  const diagnostics=new Diagnostics(config('https://collector.example'),transport);t.after(async()=>{complete();await diagnostics.stop();});
  for(let i=0;i<100;i++)diagnostics.record(metrics(),{engine:'mastra'});assert(diagnostics.status().pending<=33);assert(diagnostics.status().dropped>=67);assert.equal(calls,1);const begin=performance.now();await diagnostics.stop();assert(performance.now()-begin<2000);assert.equal(diagnostics.status().pending,0);
});

test('disabled or invalid diagnostics keeps local aggregates and sends no requests',async()=>{
  let calls=0;const diagnostics=new Diagnostics({...config('http://127.0.0.1:1'),allowedOrigins:[]},async()=>{calls++;return new Response('{}');});diagnostics.record(metrics());assert.equal(diagnostics.status().configured,false);assert.equal(diagnostics.status().sampleCount,1);assert.equal(diagnostics.status().p95Ms,30);assert.equal(calls,0);await diagnostics.stop();
});

test('real chat completes while the collector is blocked, and exports no prompt or saved filename',async t=>{
  let entered!:()=>void,release!:()=>void;const received=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);let raw='';
  const origin=await collector(t,(req,res)=>{req.on('data',c=>raw+=c);req.on('end',()=>{entered();void wait.then(()=>{res.setHeader('content-type','application/json');res.end('{}');});});});t.after(async()=>{release();});
  const f=await fixture(t,config(origin)),chat=(await f.app.inject({method:'POST',url:'/api/chats',headers:f.headers,payload:{entryId:'diagnostics-chat-fixture',timezone:'UTC'}})).json();
  let timer:NodeJS.Timeout;try{
    const reply=await Promise.race([f.app.inject({method:'POST',url:'/api/chat',headers:f.headers,payload:{chatId:chat.id,expectedVersion:chat.version,requestId:'PRIVATE_REQUEST_FIXTURE',text:'/quick PRIVATE_SAVED_NOTE_FIXTURE',attachmentIds:[]}}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Collector blocked chat')),1500);})]);
    assert.equal(reply.statusCode,200);assert.equal(reply.json().outcome,'success');await received;assert(!raw.includes('PRIVATE_'));assert(!raw.includes('.md'));assert(!raw.includes('fixture-secret'));
    assert.equal((await f.app.inject({url:'/api/diagnostics'})).statusCode,401);const status=(await f.app.inject({url:'/api/diagnostics',headers:f.headers})).json();assert.equal(status.sampleCount,1);assert.equal(status.pending,1);
  }finally{clearTimeout(timer!);release();}
});
