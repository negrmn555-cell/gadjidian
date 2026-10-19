import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import * as React from 'react';
import * as assistantUI from '@assistant-ui/react';
import { guardedTransport } from '../packages/server/dist/provider-transport.js';

let toolCalls=0,streamEnded=false,requests=0;
const server=http.createServer((req,res)=>{
  let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
    requests++;const body=JSON.parse(raw);
    if(body.model==='error-fixture'){res.writeHead(401,{'content-type':'application/json'});res.end('{"error":{"message":"synthetic failure"}}');return;}
    if(body.model==='abort-fixture'){return;}
    const needsTool=JSON.stringify(body.messages).includes('use-fixture-tool')&&!body.messages.some(m=>m.role==='tool');
    const delta=needsTool?{role:'assistant',tool_calls:[{index:0,id:'fixture-call',type:'function',function:{name:'lookup',arguments:'{"query":"инфляция"}'}}]}:{role:'assistant',content:'Проверка пройдена'};
    if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:delta,finish_reason:needsTool?'tool_calls':'stop'}],usage:{prompt_tokens:5,completion_tokens:3}}));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
    setTimeout(()=>{streamEnded=true;res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{},finish_reason:needsTool?'tool_calls':'stop'}],usage:{prompt_tokens:5,completion_tokens:3}})+'\n\ndata: [DONE]\n\n');},30).unref();
  });
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const provider=createOpenAICompatible({name:'relay-fixture',baseURL:origin+'/v1',apiKey:'synthetic-key',fetch:guardedTransport([origin],500)});
const makeAgent=(model='fixture')=>new Agent({id:'relay-compatibility',name:'Relay compatibility',instructions:'Use the lookup tool only when asked. Reply in Russian.',model:provider(model),tools:{lookup:createTool({id:'lookup',description:'Find a synthetic note',inputSchema:z.object({query:z.string()}),execute:async input=>{assert.equal(input.query,'инфляция');toolCalls++;return {path:'Synthetic.md'};}})}});
try {
  assert.match((await makeAgent().generate('plain fixture')).text,/Проверка/);
  assert.match((await makeAgent().generate('use-fixture-tool',{maxSteps:3})).text,/Проверка/);assert.equal(toolCalls,1);
  streamEnded=false;const output=await makeAgent().stream('stream fixture');let text='',firstChunkAfterEnd=null;
  for await(const chunk of output.textStream){if(firstChunkAfterEnd===null)firstChunkAfterEnd=streamEnded;text+=chunk;}
  assert.match(text,/Проверка/);assert.equal(firstChunkAfterEnd,false);
  let errorSeen=false;try{const result=await makeAgent('error-fixture').generate('error');errorSeen=!!result.error||result.finishReason==='error';}catch{errorSeen=true;}assert(errorSeen);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30);let aborted=false;
  try{const result=await makeAgent('abort-fixture').generate('abort',{abortSignal:controller.signal});aborted=controller.signal.aborted||result.finishReason==='error';}catch{aborted=controller.signal.aborted;}finally{clearTimeout(timer);}assert(aborted);
  assert.match(React.version,/^18\./);assert.equal(typeof assistantUI.makeAssistantToolUI,'function');
  const report={node:process.version,react:React.version,text:true,toolCalls,streamAPI:true,transportStreaming:!firstChunkAfterEnd,abort:aborted,error:errorSeen,requests,assistantUIImport:true,provider:'local synthetic HTTP fixture',note:'Guarded transport exposes SSE before upstream completion. Runtime, replay and cancellation are additionally verified by agent-runtime.test.ts.'};
  await mkdir('docs',{recursive:true});await writeFile('docs/agent-compatibility.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
