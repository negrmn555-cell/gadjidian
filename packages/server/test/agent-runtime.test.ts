import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGzip } from 'node:zlib';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent, LlmClient, Vault, disposeSearch, sourceVersion, type AgentEvent, type ChatMessage } from '@relay/core';
import { ChatStore, CHAT_RETENTION_MS } from '../src/chat-store.js';
import { mastraLoop } from '../src/mastra-runtime.js';
import { guardedTransport } from '../src/provider-transport.js';
import { loadConfig } from '../src/config.js';
import { Db } from '../src/db.js';
import { createServer } from '../src/index.js';
import { attachmentContext, attachmentTool } from '../src/agent-context.js';

type Cleanup = { after(fn: () => Promise<void> | void): void };
async function folder(_t: Cleanup) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'relay-runtime-'));

  return root;
}
async function removeFolder(root:string){assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith('relay-runtime-'));await fs.rm(root,{recursive:true,force:true});}
function deferred() { let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve}; }
async function bounded<T>(work: Promise<T>, ms=5000): Promise<T> { let timer:ReturnType<typeof setTimeout>;return Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Fixture timed out')),ms);})]).finally(()=>clearTimeout(timer)); }
async function server(t: Cleanup, handler: http.RequestListener) {
  const upstream = http.createServer(handler);await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
  t.after(async()=>{upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));});
  return 'http://127.0.0.1:'+(upstream.address() as {port:number}).port;
}
const frame = (value: unknown) => 'data: '+JSON.stringify(value)+'\n\n';
const chunk = (text: string) => frame({choices:[{delta:{content:text},finish_reason:null}]});
const end = () => frame({choices:[{delta:{},finish_reason:'stop'}]})+frame({choices:[],usage:{prompt_tokens:8,completion_tokens:3}})+'data: [DONE]\n\n';

test('cancelled HTTP error bodies close safely even when upstream is still producing bytes',async t=>{
  let closed=0;
  const origin=await server(t,(_req,res)=>{res.writeHead(503,{'content-type':'application/json'});res.write('{');const timer=setInterval(()=>res.write(' '),2);res.once('close',()=>{closed++;clearInterval(timer);});});
  for(let i=0;i<8;i++){const response=await guardedTransport([origin],3000)(origin);assert.equal(response.status,503);await response.body!.cancel();}
  await new Promise(r=>setTimeout(r,30));assert.equal(closed,8);
});

test('guarded transport exposes gzip/SSE before upstream ends and propagates a late socket error', async t=>{
  const release=deferred();t.after(()=>release.resolve());let ended=false;
  const origin=await server(t,(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream','content-encoding':'gzip'});const zip=createGzip();zip.pipe(res);zip.write(chunk('Привет'));zip.flush();void release.promise.then(()=>{ended=true;zip.end(end());});});
  const response=await bounded(guardedTransport([origin],3000)(origin));assert.equal(ended,false);
  const reader=response.body!.getReader();const first=await bounded(reader.read());assert.equal(ended,false);assert.match(new TextDecoder().decode(first.value),/Привет/);
  release.resolve();while(!(await reader.read()).done){};
  const broken=await server(t,(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write(chunk('part'));setTimeout(()=>res.destroy(),30);});
  const failed=await guardedTransport([broken],3000)(broken);await assert.rejects(failed.text());
});

test('OpenAI SSE assembles fragmented tool arguments and usage, rejects incomplete calls before execution',async()=>{
  const raw=chunk('Текст')+frame({choices:[{delta:{tool_calls:[{index:0,id:'call_1',function:{name:'read_note',arguments:'{"pa'}}]},finish_reason:null}]})+frame({choices:[{delta:{tool_calls:[{index:0,function:{arguments:'th":"A.md"}'}}]},finish_reason:'tool_calls'}]})+frame({choices:[],usage:{prompt_tokens:12,completion_tokens:4}})+'data: [DONE]\n\n';
  const deltas:string[]=[];
  const client=new LlmClient({baseUrl:'https://fixture.test',model:'fixture',apiKey:''},async()=>new Response(new ReadableStream({start(c){for(const byte of new TextEncoder().encode(raw))c.enqueue(Uint8Array.of(byte));c.close();}}),{headers:{'content-type':'text/event-stream'}}));
  const result=await client.chat([{role:'user',content:'fixture'}],undefined,undefined,{onDelta:t=>deltas.push(t)});
  assert.equal(deltas.join(''),'Текст');assert.equal(result.message.tool_calls![0].function.arguments,'{"path":"A.md"}');assert.equal(result.usage?.completionTokens,4);
  const broken=new LlmClient({baseUrl:'https://fixture.test',model:'fixture',apiKey:''},async()=>new Response(raw.replace('data: [DONE]\n\n',''),{headers:{'content-type':'text/event-stream'}}));
  await assert.rejects(broken.chat([],undefined,undefined,{onDelta:()=>{}}),/прерван/);
});

for(const engine of ['legacy','mastra'] as const) {
  test(engine+': cancellation closes the provider socket and starts no extra call',async t=>{
    const closed=deferred();let calls=0;
    const origin=await server(t,(req,res)=>{req.resume();req.on('end',()=>{calls++;res.writeHead(200,{'content-type':'text/event-stream'});res.write(chunk('Начало'));res.once('close',()=>closed.resolve());});});
    const root=await folder(t),cfg=loadConfig();cfg.vault.root=root;const vault=new Vault(cfg.vault);t.after(async()=>{disposeSearch(vault);await removeFolder(root);});
    const controller=new AbortController();
    const client=new LlmClient({baseUrl:origin,model:'fixture',apiKey:''},guardedTransport([origin],3000));
    const work=new Agent({vault,llm:client,mode:'note',toolsEnabled:false,runtime:engine==='mastra'?mastraLoop:undefined}).run({text:'Ответь',signal:controller.signal,onEvent:e=>{if(e.type==='delta')controller.abort();}});
    await assert.rejects(bounded(work));await bounded(closed.promise);assert.equal(calls,1);
  });
  test(engine+': real note loop streams early, performs one validated write and preserves source hashes',async t=>{
    const root=await folder(t),cfg=loadConfig();cfg.vault.root=root;cfg.vault.privateFolders=['Private'];const vault=new Vault(cfg.vault);t.after(()=>disposeSearch(vault));
    t.after(()=>removeFolder(root));await vault.writeNote('A.md','# Факт\nСохранённый факт');
    const release=deferred(),seen=deferred();t.after(()=>release.resolve());let rounds=0,writes=0;const events:AgentEvent[]=[];
    const client=new LlmClient({baseUrl:'https://fixture.test',model:'fixture',apiKey:''},async(_url,init)=>{
      const body=JSON.parse(String(init?.body));rounds++;
      if(rounds<3)return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'call_'+rounds,type:'function',function:{name:rounds===1?'read_note':'create_note',arguments:JSON.stringify(rounds===1?{path:'A.md'}:{title:'Итог',kind:'quick',category:'personal',content:'Факт'})}}]},finish_reason:'tool_calls'}]}));
      assert(body.messages.some((m:ChatMessage)=>m.role==='tool'));
      return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(chunk('Готово')));void release.promise.then(()=>{c.enqueue(new TextEncoder().encode(end()));c.close();});}}),{headers:{'content-type':'text/event-stream'}});
    });
    const agent=new Agent({vault,llm:client,mode:'note',runtime:engine==='mastra'?mastraLoop:undefined,noteWriter:async()=>{writes++;return {text:'Сохранено',path:'Result.md'};}});
    const work=agent.run({text:'Найди факт и создай итог',onEvent:e=>{events.push(e);if(e.type==='delta')seen.resolve();}});
    await bounded(seen.promise);assert.equal(writes,1);release.resolve();const result=await bounded(work);
    assert.equal(result.text,'Готово');assert.equal(rounds,3);assert.equal(writes,1);assert.equal(result.actions.length,1);assert.equal(result.sourceVersions?.[0].contentHash,sourceVersion('A.md','# Факт\nСохранённый факт').contentHash);
    assert(events.some(e=>e.type==='tool.completed'));assert(events.some(e=>e.type==='artifact.saved'));
  });
  test(engine+': invalid arguments and blind full-note replacement never enter the writer; failure after saving is partial',async t=>{
    const root=await folder(t),cfg=loadConfig();cfg.vault.root=root;const vault=new Vault(cfg.vault);t.after(()=>disposeSearch(vault));
    t.after(()=>removeFolder(root));for(const name of ['update_note','create_note']){
      let writes=0;
      const client=new LlmClient({baseUrl:'https://fixture.test',model:'fixture',apiKey:''},async()=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'bad',type:'function',function:{name,arguments:JSON.stringify(name==='update_note'?{path:'A.md',expectedHash:'wrong',content:'overwrite'}:{title:123,content:'bad',kind:'quick'})}}]},finish_reason:'tool_calls'}]})));
      await assert.rejects(new Agent({vault,llm:client,mode:'note',runtime:engine==='mastra'?mastraLoop:undefined,noteWriter:async()=>{writes++;return {text:'bad'};}}).run({text:'write'}));assert.equal(writes,0);
    }
    let rounds=0,writes=0;
    const client=new LlmClient({baseUrl:'https://fixture.test',model:'fixture',apiKey:''},async()=>{if(++rounds>1)throw new Error('Synthetic provider failure');return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'saved',type:'function',function:{name:'create_note',arguments:'{"title":"Saved","content":"ok","kind":"quick"}'}}]},finish_reason:'tool_calls'}]}));});
    const result=await new Agent({vault,llm:client,mode:'note',runtime:engine==='mastra'?mastraLoop:undefined,noteWriter:async()=>{writes++;return {text:'Saved',path:'Saved.md'};}}).run({text:'save'});
    assert.equal(writes,1);assert.equal(result.outcome,'partial');assert.equal(result.actions[0].path,'Saved.md');assert.equal(result.error?.retryable,false);
  });
}

test('durable event batches replay with stable sequence, compact to snapshots, recover interruption and obey clear/TTL',async t=>{
  const root=await folder(t),file=path.join(root,'chat.sqlite');let now=Date.now();let store=new ChatStore(file,()=>now);t.after(async()=>{store.close();await removeFolder(root);});const chat=store.create(1,'runtime-events-entry','UTC');
  store.beginRun(1,chat.id,'request-events','hash');store.events.begin(1,chat.id,'request-events','mastra',chat.expiresAt);
  for(let i=0;i<100;i++)store.events.emit(1,chat.id,'request-events',{type:'delta',text:'a'});
  assert.equal(store.events.snapshot(1,chat.id,'request-events')?.sequence,2);
  store.events.emit(1,chat.id,'request-events',{type:'artifact.saved',path:'Saved.md'});
  assert.equal(store.events.snapshot(1,chat.id,'request-events')?.text,'a'.repeat(100));
  const replay=store.events.replay(1,chat.id,'request-events',2);assert.deepEqual(replay.map(e=>e.sequence),[3,4]);
  for(let i=0;i<520;i++)store.events.emit(1,chat.id,'request-events',{type:'status',text:'tick'});
  assert.equal(store.events.replay(1,chat.id,'request-events',2)[0].type,'snapshot');
  assert.equal(store.events.snapshot(2,chat.id,'request-events'),null);
  store.close();store=new ChatStore(file,()=>now);store.events.recover();assert.equal(store.events.snapshot(1,chat.id,'request-events')?.state,'interrupted');assert.deepEqual(store.events.snapshot(1,chat.id,'request-events')?.artifacts,['Saved.md']);
  store.clear(1,chat.id);assert.equal(store.events.snapshot(1,chat.id,'request-events'),null);
  store.beginRun(1,chat.id,'request-expiry','hash');store.events.begin(1,chat.id,'request-expiry','legacy',chat.expiresAt);now+=CHAT_RETENTION_MS;store.prune();assert.equal(store.events.snapshot(1,chat.id,'request-expiry'),null);
});

test('attachment context ranks bounded fragments and continuation obeys selected file, device and TTL',async t=>{
  const root=await folder(t);let now=Date.now();const store=new ChatStore(path.join(root,'files.sqlite'),()=>now);t.after(async()=>{store.close();await removeFolder(root);});
  const chat=store.create(1,'runtime-context-entry','UTC'),text='# Начало\n'+('Обычный текст.\n'.repeat(3500))+'\n# Фотосинтез\nФотосинтез растений преобразует свет.\n'+('Дополнение.\n'.repeat(3500));
  const saved=store.putAttachment(1,chat.id,'Fixture.md','text/markdown','text',Buffer.from(text),text),file=store.attachment(1,chat.id,saved.id);
  const context=attachmentContext([file],'Фотосинтез',6000);assert(context.length<8000);assert.match(context,/complete=false/);assert.match(context,/преобразует свет/);
  const reader=attachmentTool(store,1,chat.id,[file.id]),tail=await reader.execute({fileId:file.id,offset:text.length-100,limit:100});assert.match(tail,/nextOffset=EOF/);assert(tail.endsWith(text.slice(-100)+'\n</untrusted_attachment>'));
  await assert.rejects(reader.execute({fileId:'other-file',offset:0}),/не выбран/);
  await assert.rejects(attachmentTool(store,2,chat.id,[file.id]).execute({fileId:file.id,offset:0}));
  now+=CHAT_RETENTION_MS;await assert.rejects(reader.execute({fileId:file.id,offset:0}));
});

test('WebSocket resume and HTTP snapshot rejoin an existing Mastra run without a second provider call',async t=>{
  const root=await folder(t),release=deferred();t.after(()=>release.resolve());let calls=0;
  const origin=await server(t,(req,res)=>{req.resume();req.on('end',()=>{calls++;res.writeHead(200,{'content-type':'text/event-stream'});res.write(chunk('Первая часть'));void release.promise.then(()=>res.end(end()));});});
  const cfg=loadConfig();cfg.dataDir=root;cfg.dbPath=path.join(root,'relay.sqlite');cfg.vault.root=path.join(root,'vault');cfg.providers.keyFile=path.join(root,'provider.key');cfg.providers.allowedOrigins=[origin];cfg.llm={baseUrl:origin+'/v1',model:'fixture',apiKey:''};cfg.sync={...cfg.sync,mode:'none',pullInterval:0};cfg.staticDir='';cfg.scenariosFile=path.join(root,'missing.json');
  const db=await Db.open(cfg.dbPath),paired=db.createDevice('runtime fixture','app'),chat=db.chats.create(paired.device.id,'runtime-websocket-entry','UTC');db.close();
  const app=await createServer(cfg);t.after(async()=>{for(const client of app.websocketServer.clients)client.terminate();release.resolve();await app.close();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith('relay-runtime-'));await fs.rm(root,{recursive:true,force:true});});await app.ready();const headers={authorization:'Bearer '+paired.token};
  const first=deferred(),events:any[]=[];const ticket=(await app.inject({method:'POST',url:'/api/ws-ticket',headers,payload:{}})).json().ticket;
  const ws=await app.injectWS('/api/ws?ticket='+ticket,{}, {onInit:socket=>socket.on('message',raw=>{const e=JSON.parse(String(raw));events.push(e);if(e.type==='delta')first.resolve();})});
  t.after(()=>ws.terminate());
  const request={chatId:chat.id,requestId:'request-resume-fixture',expectedVersion:chat.version,text:'Ответь',attachmentIds:[]};ws.send(JSON.stringify({type:'message',...request}));await bounded(first.promise);ws.terminate();
  const status=(await app.inject({method:'GET',url:'/api/chats/'+chat.id+'/runs/'+request.requestId,headers})).json();assert.equal(status.state,'running');assert.equal(status.snapshot.text,'Первая часть');
  const duplicate=await app.inject({method:'POST',url:'/api/chat',headers,payload:request});assert.equal(duplicate.statusCode,409);assert.equal(calls,1);
  const restored=deferred(),finished=deferred(),rejoined:any[]=[];const nextTicket=(await app.inject({method:'POST',url:'/api/ws-ticket',headers,payload:{}})).json().ticket;
  const next=await app.injectWS('/api/ws?ticket='+nextTicket,{}, {onInit:socket=>socket.on('message',raw=>{const e=JSON.parse(String(raw));rejoined.push(e);if(e.type==='snapshot')restored.resolve();if(e.type==='result')finished.resolve();})});
  t.after(()=>next.terminate());
  next.send(JSON.stringify({type:'resume',chatId:chat.id,requestId:request.requestId,lastSequence:0}));await bounded(restored.promise);release.resolve();await bounded(finished.promise);next.terminate();
  assert.equal(rejoined.find(e=>e.type==='snapshot').text,'Первая часть');assert.equal(rejoined.find(e=>e.type==='result').outcome,'success');assert.equal(calls,1);
  const saved=(await app.inject({method:'GET',url:'/api/chats/'+chat.id+'/runs/'+request.requestId,headers})).json();assert.equal(saved.result.text,'Первая часть');assert.equal(saved.snapshot.engine,'mastra');
});
