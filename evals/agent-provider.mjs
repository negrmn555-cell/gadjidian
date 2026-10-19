import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { createServer } from '../packages/server/dist/index.js';
import { loadConfig } from '../packages/server/dist/config.js';
import { Db } from '../packages/server/dist/db.js';
import { ProviderRegistry } from '../packages/server/dist/providers.js';

/** Runs the real HTTP chat entry, runtime, domain services and SQLite against synthetic HTTP model responses. */
export default class AgentProvider {
  constructor(options={}){this.engine=options.config?.engine==='legacy'?'legacy':'mastra';}
  id(){return 'relay-agent-'+this.engine;}
  async callApi(scenario){
    const parent=path.resolve('data/evals');await fs.mkdir(parent,{recursive:true});const root=await fs.mkdtemp(path.join(parent,'agent-'));let calls=0,app;
    const started=performance.now();
    const upstream=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
      calls++;const body=JSON.parse(raw),outputs=body.messages.filter(m=>m.role==='tool');res.setHeader('content-type','application/json');
      const finish=content=>res.end(JSON.stringify({choices:[{message:{role:'assistant',content:typeof content==='string'?content:JSON.stringify(content)},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10}}));
      const tool=(name,args)=>res.end(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'fixture-'+calls,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]}));
      if(scenario.startsWith('deadline')){const explicit=scenario==='deadline-explicit';finish({state:'ready',question:'',deadlineEvidence:explicit?'До 5 октября 2030':'завтра',task:{title:'Подготовить доклад',description:'Синтетический сценарий',category:'study',priority:'medium',keywords:[],tags:[],relatedNoteIds:[],deadline:{kind:'by_date',date:'2030-10-05'}}});return;}
      if(scenario==='partial-write'){if(outputs.length){res.statusCode=503;res.end('{}');}else tool('create_note',{kind:'idea',category:'personal',title:'Fixture saved idea',content:'Synthetic idea'});return;}
      if(scenario==='guard-preferences'){tool('append_note',{path:'System/Assistant/preferences.md',text:'Untrusted preference'});return;}
      if(!outputs.length){tool('search_notes',{query:scenario==='private-source'?'PRIVATE_CONTENT_MARKER':'фотосинтез',limit:5});return;}
      if(scenario==='search'&&outputs.length===1){tool('read_section',{path:'Resources/Фотосинтез.md',chunkId:/chunkId: ([^)\s]+)/.exec(outputs[0].content)[1]});return;}
      finish('Проверка завершена.');
    });});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
    try{
      const origin='http://127.0.0.1:'+upstream.address().port,cfg=loadConfig();cfg.dataDir=root;cfg.dbPath=path.join(root,'main.sqlite');cfg.vault.root=path.join(root,'vault');cfg.vault.privateFolders=['Private'];cfg.sync={...cfg.sync,mode:'none',pullInterval:0};cfg.staticDir='';cfg.scenariosFile=path.join(root,'missing');cfg.providers.keyFile=path.join(root,'provider.key');cfg.providers.allowedOrigins=[origin];cfg.llm.apiKey='';cfg.agent={engine:this.engine,maxSteps:4};cfg.diagnostics={enabled:false,baseUrl:'',publicKey:'',secretKey:'',allowedOrigins:[],retentionDays:14};cfg.mcp={enabled:false};
      await fs.mkdir(path.join(cfg.vault.root,'Resources'),{recursive:true});await fs.mkdir(path.join(cfg.vault.root,'Private'));await fs.writeFile(path.join(cfg.vault.root,'Resources/Фотосинтез.md'),'# Фотосинтез\n\n## Свет\nРастения используют энергию света.');await fs.writeFile(path.join(cfg.vault.root,'Private/Hidden.md'),'PRIVATE_CONTENT_MARKER');
      const db=await Db.open(cfg.dbPath),registry=await ProviderRegistry.open(db,cfg);registry.create('chat',{name:'Evaluation fixture',adapter:'openai_compatible',baseUrl:origin+'/v1',modelId:'synthetic-model-v1',canonicalModelId:null,enabled:true,capabilities:{toolCalls:true,vision:false,structuredOutput:true},secretUpdate:{action:'remove'}});const paired=db.createDevice('Eval fixture','app');db.close();
      app=await createServer(cfg);const headers={authorization:'Bearer '+paired.token};let chat=(await app.inject({method:'POST',url:'/api/chats',headers,payload:{entryId:'agent-eval-fixture',timezone:'UTC'}})).json();
      if(scenario.startsWith('deadline'))chat=(await app.inject({method:'PATCH',url:'/api/chats/'+chat.id,headers,payload:{mode:'task',expectedVersion:chat.version}})).json();
      const input={chatId:chat.id,expectedVersion:chat.version,requestId:'agent-eval-request',text:scenario==='remember'?'/remember Отвечай кратко':scenario==='deadline-explicit'?'Подготовить доклад. До 5 октября 2030':'Синтетический сценарий '+scenario,attachmentIds:[]};
      const result=(await app.inject({method:'POST',url:'/api/chat',headers,payload:input})).json(),beforeReplay=calls,replay=(await app.inject({method:'POST',url:'/api/chat',headers,payload:input})).json();
      const tasks=(await app.inject({url:'/api/tasks',headers})).json(),preferences=(await app.inject({url:'/api/preferences',headers})).json();
      return {output:JSON.stringify({outcome:result.outcome,actions:result.actions?.length??0,sources:result.sources?.length??0,tools:result.tools?.length??0,taskCount:tasks.items?.length??0,preferences:preferences.status,replayed:result.messageId===replay.messageId&&beforeReplay===calls,providerCalls:calls,leaked:JSON.stringify(result).includes('PRIVATE_CONTENT_MARKER')}),metadata:{engine:this.engine,promptVersion:'relay-v1',model:'synthetic-model-v1',externalLlm:false,durationMs:performance.now()-started,rssBytes:process.memoryUsage().rss}};
    }finally{if(app)await app.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));if(path.dirname(root)!==parent||!path.basename(root).startsWith('agent-'))throw new Error('Unsafe evaluation cleanup');await fs.rm(root,{recursive:true,force:true});}
  }
}
