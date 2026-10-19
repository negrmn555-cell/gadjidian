import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const data=path.resolve('data');await mkdir(data,{recursive:true});
const isolated=await mkdtemp(path.join(data,'production-runtime-'));
try {
  for(const file of ['package.json','package-lock.json'])await cp(file,path.join(isolated,file));
  for(const name of ['core','server','app']){
    const dest=path.join(isolated,'packages',name);await mkdir(dest,{recursive:true});
    await cp('packages/'+name+'/package.json',path.join(dest,'package.json'));
    await cp('packages/'+name+'/dist',path.join(dest,'dist'),{recursive:true});
  }
  const install=process.platform==='win32'?spawnSync('cmd.exe',['/d','/s','/c','npm.cmd ci --omit=dev --ignore-scripts --offline'],{cwd:isolated,encoding:'utf8',timeout:180_000,maxBuffer:2*1024*1024}):spawnSync('npm',['ci','--omit=dev','--ignore-scripts','--offline'],{cwd:isolated,encoding:'utf8',timeout:180_000});
  assert.equal(install.status,0,install.stderr);
  const child=spawnSync(process.execPath,['--input-type=module'],{cwd:isolated,encoding:'utf8',timeout:30_000,env:{...process.env,LOG_LEVEL:'silent'},input:`
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import path from 'node:path';
    import { createServer } from './packages/server/dist/index.js';
    import { loadConfig } from './packages/server/dist/config.js';
    import { Db } from './packages/server/dist/db.js';
    import { Client } from '@modelcontextprotocol/sdk/client/index.js';
    import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
    import { PDFDocument, rgb } from 'pdf-lib';
    import { decodeUpload } from './packages/server/dist/attachments.js';
    import { renderDocument } from './packages/server/dist/document-render.js';
    let calls=0;
    const upstream=http.createServer((req,res)=>{req.resume();req.on('end',()=>{calls++;res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:'Production runtime ready'},finish_reason:null}]})+'\\n\\n'+'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:8,completion_tokens:3}})+'\\n\\ndata: [DONE]\\n\\n');});});
    await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+upstream.address().port;
    const cfg=loadConfig();cfg.dataDir=path.resolve('fixture');cfg.dbPath=path.join(cfg.dataDir,'relay.sqlite');cfg.vault.root=path.join(cfg.dataDir,'vault');cfg.providers.keyFile=path.join(cfg.dataDir,'provider.key');cfg.providers.allowedOrigins=[origin];cfg.llm={baseUrl:origin+'/v1',model:'fixture',apiKey:''};cfg.sync={...cfg.sync,mode:'none',pullInterval:0};cfg.staticDir='';cfg.scenariosFile=path.join(cfg.dataDir,'missing.json');cfg.agent={engine:'mastra',maxSteps:4};cfg.diagnostics={enabled:false,baseUrl:'',publicKey:'',secretKey:'',allowedOrigins:[],retentionDays:14};cfg.mcp={enabled:true};
    const db=await Db.open(cfg.dbPath),paired=db.createDevice('production smoke fixture','app'),chat=db.chats.create(paired.device.id,'production-runtime-entry','UTC');db.close();
    const app=await createServer(cfg),headers={authorization:'Bearer '+paired.token};await app.listen({host:'127.0.0.1',port:0});cfg.publicUrl='http://127.0.0.1:'+app.server.address().port;
    try {
      assert.equal((await app.inject({url:'/api/health'})).statusCode,200);
      const input={chatId:chat.id,expectedVersion:chat.version,requestId:'production-runtime-request',text:'Fixture question',attachmentIds:[]};
      const result=(await app.inject({method:'POST',url:'/api/chat',headers,payload:input})).json();assert.equal(result.outcome,'success');assert.equal(result.text,'Production runtime ready');
      const snapshot=(await app.inject({url:'/api/chats/'+chat.id+'/runs/'+input.requestId,headers})).json();assert.equal(snapshot.snapshot.engine,'mastra');assert.equal(snapshot.snapshot.state,'success');
      const replay=(await app.inject({method:'POST',url:'/api/chat',headers,payload:input})).json();assert.equal(replay.messageId,result.messageId);assert.equal(calls,1);
      const saved=(await app.inject({method:'POST',url:'/api/chat',headers,payload:{...input,requestId:'production-runtime-save',text:'/quick Synthetic production note'}})).json();assert.equal(saved.actions.length,1);assert.equal(calls,1);
      const remembered=(await app.inject({method:'POST',url:'/api/chat',headers,payload:{...input,requestId:'production-runtime-remember',text:'/remember Synthetic preference'}})).json();assert.equal(remembered.actions.length,1);assert.equal(calls,1);
      const preferences=(await app.inject({url:'/api/preferences',headers})).json();assert.match(preferences.fields.rules,/Synthetic preference/);
      const removed=await app.inject({method:'DELETE',url:'/api/preferences',headers,payload:{expectedHash:preferences.hash,operationId:'production-runtime-forget'}});assert.equal(removed.statusCode,200);assert.equal(removed.json().memory.status,'missing');
      const pdf=await PDFDocument.create(),page=pdf.addPage([300,200]);page.drawText('Synthetic PDF');page.drawRectangle({x:20,y:20,width:80,height:60,color:rgb(.7,.8,1)});const bytes=Buffer.from(await pdf.save());
      const decoded=await decodeUpload('fixture.pdf',bytes,true);assert.equal(decoded.report.pages[0].classification,'visual');
      const controller=new AbortController(),subset=await renderDocument(bytes,[1],'pdf',controller.signal),images=await renderDocument(bytes,[1],'images',controller.signal);assert.equal((await PDFDocument.load(Buffer.from(subset.pdf,'base64'))).getPageCount(),1);assert(images.images[0].data.length>100);
      const mcpKey=(await app.inject({method:'POST',url:'/api/mcp/keys',headers,payload:{name:'Synthetic production client',days:1}})).json();
      const mcpClient=new Client({name:'production-smoke',version:'1'});try{await mcpClient.connect(new StreamableHTTPClientTransport(new URL(cfg.publicUrl+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+mcpKey.token}}}));assert.equal((await mcpClient.listTools()).tools.length,3);const found=await mcpClient.callTool({name:'search_notes',arguments:{query:'Synthetic production note'}});assert(!found.isError);}finally{await mcpClient.close();}
      const diagnostics=(await app.inject({url:'/api/diagnostics',headers})).json();assert(diagnostics.sampleCount>=4);
      console.log('SMOKE_REPORT:'+JSON.stringify({health:true,authenticatedMastraRequest:true,streamingAdapter:true,durableSnapshot:true,idempotentReplay:true,directCapture:true,preferencesCreateReadDelete:true,productionPdfExtraction:true,productionPdfSubset:true,productionPdfRendering:true,readOnlyMcpClient:true,diagnosticsStatus:true,providerCalls:calls,externalLlm:false}));
    } finally {await app.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
  `});
  assert.equal(child.status,0,child.stderr+'\n'+child.stdout);
  const line=child.stdout.split('\n').find(line=>line.startsWith('SMOKE_REPORT:'));assert(line);
  const report={node:process.version,platform:process.platform,install:'npm ci --omit=dev --ignore-scripts --offline',isolatedDirectory:true,...JSON.parse(line.slice(13)),dockerBuild:false};
  await writeFile('docs/production-runtime-smoke.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
} finally {
  assert.equal(path.dirname(path.resolve(isolated)),data);assert(path.basename(isolated).startsWith('production-runtime-'));
  await rm(isolated,{recursive:true,force:true,maxRetries:3});
}
