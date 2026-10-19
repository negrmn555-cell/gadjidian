import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Agent,LlmClient,Vault,disposeSearch,executeTool,AgentRunControl} from '@relay/core';
import {loadConfig} from '../src/config.js';
import {mastraLoop} from '../src/mastra-runtime.js';

for(const engine of ['legacy','mastra'] as const){
 for(const scenario of ['empty','repeat','heavy','quick','tool-error','ignored-final'] as const){
  test(engine+': bounded search '+scenario,async t=>{
   const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-stop-')),cfg=loadConfig();cfg.vault.root=root;
   const vault=new Vault(cfg.vault);t.after(async()=>{disposeSearch(vault);await fs.rm(root,{recursive:true,force:true});});
   for(let i=1;i<=5;i++)await vault.writeNote('Fact'+i+'.md','# Факт\nУникальныймаркер'+i);
   if(scenario==='tool-error')vault.listNotes=async()=>{throw new Error('synthetic private error');};
   let calls=0,writes=0;const requests:any[]=[];
   const client=new LlmClient({baseUrl:'https://fixture.test',model:'fixture',apiKey:''},async(_url,init)=>{
    calls++;const body=JSON.parse(String(init?.body));requests.push(body);
    const reply=(message:unknown)=>new Response(JSON.stringify({choices:[{message,finish_reason:'stop'}]}));
    if(scenario==='quick')return reply({role:'assistant',content:'Что именно нужно изменить: заметку или предыдущий ответ?'});
    if(!body.tools?.length&&scenario!=='ignored-final'){
     assert(body.messages.some((m:any)=>m.role==='system'&&m.content.includes('финальное обращение')));
     return reply({role:'assistant',content:scenario==='tool-error'?'Ошибка проверки; факт не установлен.':'В выполненных поисках нужный факт не найден. Уточните заметку.'});
    }
    return reply({role:'assistant',content:null,tool_calls:[{id:'call'+calls,type:'function',function:{name:'search_notes',arguments:JSON.stringify({query:scenario==='heavy'?'Уникальныймаркер'+calls:scenario==='repeat'?'Уникальныймаркер1':'Несуществующийкварц',limit:2})}}]});
   });
   const result=await new Agent({vault,llm:client,mode:'note',runtime:engine==='mastra'?mastraLoop:undefined,noteWriter:async()=>{writes++;return {text:'saved'};}}).run({text:'Найди факт; если непонятно — уточни'});
   assert.equal(calls,scenario==='quick'?1:scenario==='heavy'?6:scenario==='repeat'?4:scenario==='tool-error'?2:3);
   assert.equal(writes,0);assert.equal(result.actions.length,0);assert(result.text.length>0);assert(!result.text.includes('бюджета шагов'));
   if(scenario!=='quick')assert(!requests.at(-1).tools?.length);
  });
 }
}

test('search envelope distinguishes errors, empty and truncated matches without leaking errors',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-envelope-')),cfg=loadConfig();cfg.vault.root=root;const vault=new Vault(cfg.vault);
 t.after(async()=>{disposeSearch(vault);await fs.rm(root,{recursive:true,force:true});});
 await vault.writeNote('A.md','# Химия\nХимическая реакция');await vault.writeNote('B.md','# Химия\nХимическая реакция');
 const hits=JSON.parse(await executeTool('search_notes',{query:'химия',limit:1},{vault}));assert.equal(hits.status,'ok');assert.equal(hits.returnedCount,1);assert.equal(hits.hasMore,true);assert(hits.results[0].chunkId);
 const empty=JSON.parse(await executeTool('search_notes',{query:'несуществующийкварц'},{vault}));assert.equal(empty.status,'empty');assert.equal(empty.hasMore,false);
 disposeSearch(vault);vault.listNotes=async()=>{throw new Error('PRIVATE_SECRET_FIXTURE');};
 const error=await executeTool('search_notes',{query:'химия'},{vault});assert.equal(JSON.parse(error).status,'error');assert(!error.includes('PRIVATE_SECRET_FIXTURE'));
});

test('two searches without new fragments stop; one empty search permits a reformulation',()=>{
 const c=new AgentRunControl();c.observe('search_notes',{},JSON.stringify({status:'empty',results:[]}));assert.equal(c.finalStep(2,4),false);
 c.observe('search_notes',{},JSON.stringify({status:'ok',results:[{path:'A.md',chunkId:'a'}]}));assert.equal(c.finalStep(3,4),false);
 c.observe('search_notes',{},JSON.stringify({status:'ok',results:[{path:'A.md',chunkId:'a'}]}));assert.equal(c.finalStep(4,4),true);
});
