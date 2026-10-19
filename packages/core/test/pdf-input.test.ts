import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmClient } from '../src/llm.js';
for(const adapter of ['openai_compatible','anthropic','gemini'] as const)test(adapter+' serializes an explicit PDF separately from vision images',async()=>{
  let body:any;const client=new LlmClient({adapter,baseUrl:adapter==='openai_compatible'?'https://openrouter.ai/api/v1':'https://fixture.test/v1',model:'fixture',apiKey:'synthetic'},async(_url,init)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify(adapter==='anthropic'?{content:[{type:'text',text:'ok'}],stop_reason:'end_turn'}:adapter==='gemini'?{candidates:[{content:{parts:[{text:'ok'}]},finishReason:'STOP'}]}:{choices:[{message:{role:'assistant',content:'ok'},finish_reason:'stop'}]}));});
  await client.chat([{role:'user',content:'diagram',parts:[{type:'text',text:'diagram'},{type:'file',file:{filename:'diagram.pdf',file_data:'data:application/pdf;base64,JVBERi0='}}]}]);
  if(adapter==='openai_compatible'){assert.equal(body.messages[0].content[1].type,'file');assert.equal(body.plugins[0].pdf.engine,'native');}
  else if(adapter==='anthropic'){assert.equal(body.messages[0].content[1].type,'document');assert.equal(body.messages[0].content[1].source.media_type,'application/pdf');}
  else assert.equal(body.contents[0].parts[1].inlineData.mimeType,'application/pdf');
});
