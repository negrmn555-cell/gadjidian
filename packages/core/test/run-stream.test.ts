import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyRunStream, reduceRunEvent } from '../src/run-stream.js';
import { ToolScheduler, toolSpec, boundedHistory } from '../src/agent-runtime.js';
import { sseData } from '../src/sse.js';

test('tool state deduplicates events and preserves confirmed writes through interruption and snapshots', () => {
  let state=reduceRunEvent(emptyRunStream(),{type:'tool',sequence:1,callId:'write-1',tool:'create_note',text:'Создаю заметку',at:10});
  state=reduceRunEvent(state,{type:'tool',sequence:2,callId:'write-1',tool:'create_note',at:20});assert.equal(state.tools.length,1);
  const receipt={operationId:'confirmed-write',path:'A.md',state:'saved_local',contentHash:'fixture',noteId:'note_fixture'};
  state=reduceRunEvent(state,{type:'artifact.saved',sequence:3,callId:'write-1',receipt});
  state=reduceRunEvent(state,{type:'tool',sequence:4,callId:'read-2',tool:'read_note',text:'Читаю заметку',at:30});
  state=reduceRunEvent(state,{type:'status',kind:'run.interrupted',sequence:5,outcome:'cancelled',at:50});
  assert.deepEqual(state.tools.map(t=>t.state),['succeeded','cancelled']);assert.equal(state.tools[0].receipt?.path,'A.md');
  const snapshot=reduceRunEvent(emptyRunStream(),{type:'snapshot',sequence:5,tools:state.tools,text:'Сохранена часть запроса'});assert.deepEqual(snapshot.tools,state.tools);
});

test('stream reducer deduplicates, requests missing events and replaces drafts with snapshots/final text', () => {
  let state = emptyRunStream();
  state = reduceRunEvent(state, { type:'delta',sequence:1,text:'Черновик' });
  assert.equal(reduceRunEvent(state,{type:'delta',sequence:1,text:'дубль'}).text,'Черновик');
  const gap = reduceRunEvent(state,{type:'delta',sequence:3,text:'потеря'});
  assert.equal(gap.needsResume,true); assert.equal(gap.sequence,1);
  state = reduceRunEvent(gap,{type:'snapshot',sequence:3,text:'Восстановлено'});
  assert.equal(state.needsResume,false);
  state = reduceRunEvent(state,{type:'result',sequence:4,text:'Итог'});
  assert.equal(state.text,'Итог');
});

test('SSE decodes fragmented Cyrillic, split CRLF and rejects incomplete/oversized frames', async () => {
  const bytes=new TextEncoder().encode('data: Привет\r\n\r\ndata: [DONE]\n\n');
  const stream=new ReadableStream<Uint8Array>({start(c){for(const b of bytes)c.enqueue(Uint8Array.of(b));c.close();}});
  const values=[];for await(const data of sseData(stream))values.push(data);
  assert.deepEqual(values,['Привет','[DONE]']);
  for(const text of ['data: unfinished','data: '+'a'.repeat(256001)+'\n\n']){
    await assert.rejects(async()=>{for await(const _ of sseData(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(text));c.close();}}))){};});
  }
});

test('tool scheduler overlaps only independent reads and holds a FIFO barrier around writes', async () => {
  const scheduler=new ToolScheduler(),order:string[]=[];
  let release!:()=>void;const blocked=new Promise<void>(r=>release=r);
  const r1=scheduler.run(toolSpec('read_note'),async()=>{order.push('r1');await blocked;order.push('r1done');});
  const r2=scheduler.run(toolSpec('search_notes'),async()=>{order.push('r2');await blocked;order.push('r2done');});
  const w=scheduler.run(toolSpec('create_note'),async()=>{order.push('write');});
  const r3=scheduler.run(toolSpec('read_section'),async()=>{order.push('r3');});
  assert.deepEqual(order,['r1','r2']);release();await Promise.all([r1,r2,w,r3]);
  assert(order.indexOf('write')>order.indexOf('r1done'));assert(order.indexOf('write')>order.indexOf('r2done'));assert(order.indexOf('r3')>order.indexOf('write'));
  assert.deepEqual(boundedHistory([{role:'user',content:'x'.repeat(30000)},{role:'assistant',content:'recent'}]).map(m=>m.content),['recent']);
});
