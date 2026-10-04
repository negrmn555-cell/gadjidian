test('multimodal user parts are sent as content and untrusted assistant extras are stripped',async()=>{
  let body:any;
  const client=new LlmClient({baseUrl:'https://example.test/v1',model:'test',apiKey:''},async(_url,init)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'ok',parts:[{type:'image_url',image_url:{url:'https://untrusted.test/image'}}]},finish_reason:'stop'}]}));});
  const result=await client.chat([{role:'user',content:'look',parts:[{type:'text',text:'look'},{type:'image_url',image_url:{url:'data:image/png;base64,test'}}]}]);
  assert.equal(body.messages[0].content[1].image_url.url,'data:image/png;base64,test');assert.equal(result.message.parts,undefined);
});
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmClient, LlmError } from '../src/llm.js';

test('malformed completion JSON and message shapes produce controlled errors', async () => {
  for (const value of ['null', 'broken JSON', '{}', '{"choices":[{"message":{"role":"user","content":"wrong"}}]}']) {
    const client = new LlmClient({ baseUrl: 'https://example.test/v1', apiKey: '', model: 'test' }, async () => new Response(value));
    await assert.rejects(client.chat([{ role: 'user', content: 'test' }]), e => e instanceof LlmError);
  }
});
test('a tool completion may omit content and is normalized to null', async () => {
  const client = new LlmClient({ baseUrl: 'https://example.test/v1', apiKey: '', model: 'test' }, async () => new Response(JSON.stringify({ choices: [{ message: {
    role: 'assistant', tool_calls: [{ id: '1', type: 'function', function: { name: 'search_notes', arguments: '{}' } }],
  }, finish_reason: 'tool_calls' }] })));
  assert.equal((await client.chat([{ role: 'user', content: 'test' }])).message.content, null);
});
test('upstream HTTP errors do not expose their body or credentials', async () => {
  const client = new LlmClient({ baseUrl: 'https://example.test/v1', apiKey: 'synthetic-key', model: 'test' }, async () => new Response('synthetic-key plus private upstream details', { status: 401 }));
  await assert.rejects(client.chat([{ role: 'user', content: 'test' }]), e => e instanceof LlmError && e.status === 401 && !e.message.includes('synthetic-key'));
});
