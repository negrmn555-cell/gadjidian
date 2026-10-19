import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmClient } from '../src/llm.js';

const frame=(v:unknown)=>'data: '+JSON.stringify(v)+'\n\n';
for(const adapter of ['anthropic','gemini'] as const){
  test(adapter+' streams text, preserves native tool/signature parts and usage',async()=>{
    let push!:(text:string)=>void,close!:()=>void,started!:()=>void;
    const first=new Promise<void>(r=>started=r),deltas:string[]=[];
    const stream=new ReadableStream<Uint8Array>({start(c){push=t=>c.enqueue(new TextEncoder().encode(t));close=()=>c.close();}});
    const client=new LlmClient({adapter,baseUrl:'https://fixture.test/v1',model:'fixture',apiKey:'synthetic'},async(url,init)=>{
      assert.equal(JSON.parse(String(init?.body)).stream,adapter==='anthropic'?true:undefined);
      assert.match(String(url),adapter==='anthropic'?/\/messages$/:/streamGenerateContent\?alt=sse$/);
      return new Response(stream,{headers:{'content-type':'text/event-stream'}});
    });
    const work=client.chat([{role:'user',content:'fixture'}],undefined,undefined,{onDelta:t=>{deltas.push(t);started();}});
    if(adapter==='anthropic'){
      push(frame({type:'message_start',message:{usage:{input_tokens:7}}}));push(frame({type:'content_block_start',index:0,content_block:{type:'text',text:''}}));push(frame({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'При'}}));
    }else push(frame({candidates:[{content:{parts:[{text:'При'}]}}]}));
    await first;assert.equal(deltas.join(''),'При');
    if(adapter==='anthropic'){
      push(frame({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'вет'}}));
      push(frame({type:'content_block_start',index:1,content_block:{type:'tool_use',id:'native-call',name:'read_note',input:{}}}));
      push(frame({type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"path":'}}));push(frame({type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'"A.md"}'}}));push(frame({type:'content_block_stop',index:1}));
      push(frame({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:4}}));push(frame({type:'message_stop'}));
    }else push(frame({candidates:[{content:{parts:[{text:'вет'},{functionCall:{id:'native-call',name:'read_note',args:{path:'A.md'}},thoughtSignature:'opaque-fixture'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:7,candidatesTokenCount:4}}));
    close();const result=await work;assert.equal(result.message.content,'Привет');assert.equal(deltas.join(''),'Привет');assert.equal(result.message.tool_calls![0].function.arguments,'{"path":"A.md"}');assert.deepEqual(result.usage,{promptTokens:7,completionTokens:4});
    if(adapter==='gemini')assert.equal((result.message.nativeParts!.at(-1) as any).thoughtSignature,'opaque-fixture');
  });
  test(adapter+' rejects a truncated stream without a terminal message',async()=>{
    const raw=adapter==='anthropic'?frame({type:'content_block_start',index:0,content_block:{type:'text',text:''}}):frame({candidates:[{content:{parts:[{text:'partial'}]}}]});
    const client=new LlmClient({adapter,baseUrl:'https://fixture.test',model:'fixture',apiKey:''},async()=>new Response(raw,{headers:{'content-type':'text/event-stream'}}));
    await assert.rejects(client.chat([],undefined,undefined,{onDelta:()=>{}}),/прерван/);
  });
}
