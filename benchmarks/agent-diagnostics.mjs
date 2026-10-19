import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { createServer } from '../packages/server/dist/index.js';
import { loadConfig } from '../packages/server/dist/config.js';
import { Db } from '../packages/server/dist/db.js';
const parent=path.resolve('data');await fs.mkdir(parent,{recursive:true});
const results=[];
for(const enabled of [false,true]){
  const root=await fs.mkdtemp(path.join(parent,'diag-benchmark-'));let app,calls=0,exports=0,leaked=false;
  const upstream=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
    if(req.url==='/api/public/otel/v1/traces'){exports++;leaked ||= raw.includes('PRIVATE_FIXTURE');res.setHeader('content-type','application/json');res.end('{}');return;}
    calls++;res.setHeader('content-type','text/event-stream');res.write('data: '+JSON.stringify({choices:[{delta:{content:'Синтетический ответ'},finish_reason:null}]})+'\n\n');setTimeout(()=>res.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:4}})+'\n\ndata: [DONE]\n\n'),10);
  });});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  try{
    const origin='http://127.0.0.1:'+upstream.address().port,cfg=loadConfig();cfg.dataDir=root;cfg.dbPath=path.join(root,'main.sqlite');cfg.vault.root=path.join(root,'vault');cfg.sync={...cfg.sync,mode:'none',pullInterval:0};cfg.staticDir='';cfg.scenariosFile=path.join(root,'missing');cfg.providers.keyFile=path.join(root,'provider.key');cfg.providers.allowedOrigins=[origin];cfg.llm={baseUrl:origin+'/v1',model:'synthetic-model-v1',apiKey:''};cfg.agent={engine:'mastra',maxSteps:4};cfg.diagnostics={enabled,baseUrl:origin,publicKey:'synthetic-public',secretKey:'synthetic-secret',allowedOrigins:[origin],retentionDays:14};
    const db=await Db.open(cfg.dbPath),paired=db.createDevice('Synthetic benchmark','app');db.close();app=await createServer(cfg);const headers={authorization:'Bearer '+paired.token},times=[];let peak=0;
    for(let i=0;i<22;i++){const chat=(await app.inject({method:'POST',url:'/api/chats',headers,payload:{entryId:'diag-benchmark-'+i,timezone:'UTC'}})).json(),at=performance.now();const result=(await app.inject({method:'POST',url:'/api/chat',headers,payload:{chatId:chat.id,expectedVersion:chat.version,requestId:'PRIVATE_FIXTURE_REQUEST_'+i,text:'PRIVATE_FIXTURE_PROMPT',attachmentIds:[]}})).json();assert.equal(result.outcome,'success');if(i>=2)times.push(performance.now()-at);peak=Math.max(peak,process.memoryUsage().rss);}
    const diagnostics=(await app.inject({url:'/api/diagnostics',headers})).json();times.sort((a,b)=>a-b);await app.close();app=null;assert.equal(leaked,false);
    results.push({enabled,samples:times.length,p50Ms:times[Math.ceil(times.length*.5)-1],p95Ms:times[Math.ceil(times.length*.95)-1],firstTextP95Ms:diagnostics.firstTextP95Ms,eventLoopP95Ms:diagnostics.eventLoopP95Ms,peakRssBytes:peak,providerCalls:calls,exports,errors:diagnostics.errors,dropped:diagnostics.dropped});
  }finally{if(app)await app.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));assert.equal(path.dirname(root),parent);assert(path.basename(root).startsWith('diag-benchmark-'));await fs.rm(root,{recursive:true,force:true});}
}
const report={node:process.version,platform:process.platform,engine:'mastra',model:'synthetic-model-v1',externalLlm:false,collector:'local HTTP OTLP JSON fixture',results,note:'Sequential local process comparison; includes artificial 10ms model delay. Not a production/VPS or real model benchmark. RSS can include retained heap from the preceding mode.'};await fs.writeFile('docs/agent-diagnostics-benchmark.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
