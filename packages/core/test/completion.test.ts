import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmClient } from '../src/llm.js';
import { vaultLinks,repairVaultLinks } from '../src/links.js';
import { calendarMonthDays,taskCalendarDate,taskDeadlineSortKey } from '../src/contracts.js';
test('calendar keeps date deadlines and converts timed deadlines in the selected timezone',()=>{
  assert.equal(taskCalendarDate({deadline:{kind:'by_date',date:'2026-10-03',timezone:'Pacific/Auckland'}},'America/Los_Angeles'),'2026-10-03');
  assert.equal(taskCalendarDate({deadline:{kind:'at_time',at:'2026-10-03T23:30:00Z',timezone:'UTC'}},'Europe/Moscow'),'2026-10-04');
  assert.equal(calendarMonthDays('2026-10')[0],'2026-09-28');assert.equal(calendarMonthDays('2026-10').length,42);
  assert.equal(taskDeadlineSortKey({deadline:{kind:'by_date',date:'2026-10-04',timezone:'Europe/Moscow'}}),'2026-10-04T20:59:59.999Z');
  assert.equal(taskDeadlineSortKey({deadline:{kind:'by_date',date:'2026-03-08',timezone:'America/New_York'}}),'2026-03-09T03:59:59.999Z');
});
test('link repair preserves target, alias, heading, block, embeds and code examples',()=>{
  const paths=['Inbox/Plan.md','Inbox/Ref.md'];
  const original='[[Inbox/Plan#^block|alias]]\n![[Plan#Heading]]\n[doc](Plan.md#Section "title")\n![photo](../_attachments/img.png)\n`[[Plan]]`\n```md\n[[Plan]]\n```';
  const moved=repairVaultLinks(original,'Inbox/Ref.md',new Map([['Inbox/Plan.md','Areas/Work/Notes/Plan.md'],['Inbox/Ref.md','People/Ref.md']]),paths);
  assert.match(moved,/\[\[Areas\/Work\/Notes\/Plan#\^block\|alias\]\]/);assert.match(moved,/!\[\[Areas\/Work\/Notes\/Plan#Heading\]\]/);
  assert.match(moved,/\[doc\]\(\.\.\/Areas\/Work\/Notes\/Plan.md#Section "title"\)/);assert.match(moved,/!\[photo\]\(\.\.\/_attachments\/img.png\)/);assert.match(moved,/`\[\[Plan\]\]`/);assert.equal(vaultLinks(original).length,4);
});
test('Anthropic adapter maps images, tools, tool results, headers and token usage',async()=>{
  let body:any,headers:any;
  const client=new LlmClient({adapter:'anthropic',baseUrl:'https://api.anthropic.com/v1',apiKey:'fixture',model:'claude-test'},async(url,init)=>{assert.equal(String(url),'https://api.anthropic.com/v1/messages');body=JSON.parse(String(init?.body));headers=init?.headers;return new Response(JSON.stringify({content:[{type:'tool_use',id:'tool-1',name:'read',input:{path:'A.md'}}],stop_reason:'tool_use',usage:{input_tokens:12,output_tokens:3}}));});
  const result=await client.chat([{role:'system',content:'policy'},{role:'user',content:'read'},{role:'assistant',content:null,tool_calls:[{id:'old',type:'function',function:{name:'read',arguments:'{"path":"B.md"}'}}]},{role:'tool',tool_call_id:'old',content:'body'}],[{type:'function',function:{name:'read',description:'read',parameters:{type:'object',properties:{path:{type:'string'}}}}}]);
  assert.equal(headers['x-api-key'],'fixture');assert.equal(headers['anthropic-version'],'2023-06-01');assert.equal(body.messages.at(-1).content[0].tool_use_id,'old');assert.equal(body.tools[0].input_schema.type,'object');assert.equal(result.message.tool_calls![0].id,'tool-1');assert.equal(result.usage!.promptTokens,12);
});
test('Gemini adapter preserves native thought signatures and function-call identifiers',async()=>{
  let sent:any;
  const parts=[{functionCall:{id:'g-1',name:'read',args:{path:'A.md'}},thoughtSignature:'opaque-signature'}];
  const client=new LlmClient({adapter:'gemini',baseUrl:'https://generativelanguage.googleapis.com/v1beta',apiKey:'fixture',model:'gemini-test'},async(url,init)=>{assert.match(String(url),/models\/gemini-test:generateContent$/);sent=JSON.parse(String(init?.body));return new Response(JSON.stringify({candidates:[{content:{parts},finishReason:'STOP'}],usageMetadata:{promptTokenCount:5,candidatesTokenCount:2}}));});
  const result=await client.chat([{role:'user',content:'read'}]);
  await client.chat([{role:'user',content:'read'},result.message,{role:'tool',tool_call_id:'g-1',content:'found'}]);
  assert.equal(sent.contents[1].parts[0].thoughtSignature,'opaque-signature');assert.equal(sent.contents[2].parts[0].functionResponse.id,'g-1');assert.equal(sent.contents[2].parts[0].functionResponse.name,'read');
});
