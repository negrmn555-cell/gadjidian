import test from 'node:test';
import assert from 'node:assert/strict';
import { makeNetwork, normalizeTag, tagHue, tick } from '../src/graph-physics.ts';
const node = (path: string, tags: string[] = []) => ({path,title:path,kind:'quick',id:null,tags});
const graph = (nodes: ReturnType<typeof node>[], pairs: [string,string][]) => ({nodes,edges:pairs.map(([source,target])=>({source,target})),revision:null,syncMode:'none',warnings:[]});
test('hub sizes follow real degree; dangling and self links cannot corrupt physics',()=>{
  const network=makeNetwork(graph([node('hub'),node('a'),node('b'),node('c')],[['hub','a'],['hub','b'],['hub','c'],['hub','missing'],['hub','hub']]));
  assert.equal(network.particles[0].degree,3);assert.equal(network.links.length,3);assert.ok(network.particles[0].radius>network.particles[1].radius);
  for(let i=0;i<500;i++)tick(network);for(const n of network.particles)assert.ok(Number.isFinite(n.x)&&Number.isFinite(n.y));
});
test('tag colours are stable and multi-tag gradients retain each tag; untagged neighbours inherit',()=>{
  assert.equal(normalizeTag('#Study'),'study');assert.equal(tagHue('study'),tagHue('#Study'));
  const network=makeNetwork(graph([node('a',['#Study','study','work']),node('b'),node('c',['work'])],[['a','b']]));
  assert.deepEqual(network.particles[0].hues,[tagHue('study'),tagHue('work')]);assert.deepEqual(network.particles[1].hues,network.particles[0].hues);
  assert.deepEqual(network.particles[2].hues,[tagHue('work')]);
});
test('dragging a fixed node pulls connected nodes without moving the grabbed node',()=>{
  const network=makeNetwork(graph([node('a'),node('b'),node('c')],[['a','b'],['b','c']]));
  for(let i=0;i<150;i++)tick(network);const [a,b,c]=network.particles,before=b.x,last=c.x;
  a.x+=180;a.fixed=true;const grabbed=a.x;for(let i=0;i<80;i++)tick(network);
  assert.equal(a.x,grabbed);assert.ok(b.x>before+10);assert.ok(c.x>last+5);
});
test('shared tags softly gather a community without inventing note-link edges',()=>{
  const network=makeNetwork(graph([node('a',['study']),node('b',['study']),node('c',['work']),node('d',['work'])],[]));
  const positions=[[-300,0],[0,100],[300,0],[0,-100]];network.particles.forEach((n,i)=>{[n.x,n.y]=positions[i];});
  const distance=()=>Math.hypot(network.particles[0].x-network.particles[1].x,network.particles[0].y-network.particles[1].y),before=distance();
  for(let i=0;i<150;i++)tick(network);
  assert.equal(network.links.length,0);assert.ok(distance()<before*.75);
});
