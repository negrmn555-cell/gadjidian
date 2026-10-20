import type { NoteGraph } from '@relay/core/contracts';

export interface Particle { path: string; x: number; y: number; vx: number; vy: number; radius: number; degree: number; hues: number[]; fixed?: boolean }
export interface Network { particles: Particle[]; links: [number, number][]; adjacent: number[][]; communities: number[][] }
export const normalizeTag = (tag: string) => tag.replace(/^#/, '').trim().toLocaleLowerCase();
export function hash(value: string): number { let h = 2166136261; for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
export const tagHue = (tag: string) => {let h=hash(normalizeTag(tag));h=Math.imul(h^(h>>>16),0x85ebca6b);h=Math.imul(h^(h>>>13),0xc2b2ae35);return ((h^(h>>>16))>>>0)%360;};
export function makeNetwork(graph: NoteGraph): Network {
  const index = new Map(graph.nodes.map((node, i) => [node.path, i]));
  const adjacent: number[][] = graph.nodes.map(() => []), links: [number, number][] = [];
  for (const edge of graph.edges) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined || a === b) continue;
    links.push([a, b]); adjacent[a].push(b); adjacent[b].push(a);
  }
  const hues = graph.nodes.map(node => [...new Set((node.tags ?? []).map(normalizeTag).filter(Boolean))].sort().map(tagHue));
  // Multi-source BFS gives untagged notes the nearest tagged neighbourhood.
  const queue = graph.nodes.map((_, i) => i).filter(i => hues[i].length).sort((a,b) => graph.nodes[a].path.localeCompare(graph.nodes[b].path));
  const visited = new Set(queue);
  for (let q = 0; q < queue.length; q++) for (const next of adjacent[queue[q]]) if (!visited.has(next)) { visited.add(next); hues[next] = hues[queue[q]]; queue.push(next); }
  for (let i = 0; i < hues.length; i++) if (!visited.has(i)) {
    const component = [i]; visited.add(i);
    for (let q = 0; q < component.length; q++) for (const next of adjacent[component[q]]) if (!visited.has(next)) { visited.add(next); component.push(next); }
    const hue = hash(component.map(n => graph.nodes[n].path).sort()[0]) % 360;
    for (const next of component) hues[next] = [hue];
  }
  const particles = graph.nodes.map((node, i) => {
    const angle = i * 2.3999632297, distance = 22 * Math.sqrt(i + 1), degree = adjacent[i].length;
    return { path: node.path, x: Math.cos(angle)*distance, y: Math.sin(angle)*distance, vx: 0, vy: 0, degree, radius: 3.5 + Math.min(16, Math.sqrt(degree)*2.5), hues: hues[i] };
  });
  const communities = new Map<string,number[]>();
  graph.nodes.forEach((node,i)=>{for(const tag of new Set((node.tags??[]).map(normalizeTag).filter(Boolean))){const members=communities.get(tag)??[];members.push(i);communities.set(tag,members);}});
  return { particles, links, adjacent, communities:[...communities.values()].filter(members=>members.length>1) };
}
export function tick(network: Network): number {
  const { particles: nodes, links } = network;
  // Spatial bins bound repulsion work even when a large vault is opened.
  const cells = new Map<string, number[]>(), cell = 120;
  nodes.forEach((n, i) => { const key = Math.floor(n.x/cell)+','+Math.floor(n.y/cell); const bucket = cells.get(key) ?? []; bucket.push(i); cells.set(key,bucket); });
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i], cx = Math.floor(a.x/cell), cy = Math.floor(a.y/cell);
    for (let x = cx-1; x <= cx+1; x++) for (let y = cy-1; y <= cy+1; y++) for (const j of cells.get(x+','+y) ?? []) {
      if (j <= i) continue;
      const b = nodes[j]; let dx = b.x-a.x, dy = b.y-a.y;
      if (dx*dx+dy*dy < .01) { dx=.1; dy=.1; }
      const distance = Math.sqrt(dx*dx+dy*dy), gap = a.radius+b.radius+12;
      const force = Math.min(3, 620/(distance*distance) + Math.max(0,gap-distance)*.08);
      const fx = dx/distance*force, fy=dy/distance*force;
      if (!a.fixed) { a.vx-=fx; a.vy-=fy; } if (!b.fixed) { b.vx+=fx; b.vy+=fy; }
    }
  }
  for (const [i,j] of links) {
    const a=nodes[i],b=nodes[j],dx=b.x-a.x,dy=b.y-a.y,d=Math.max(.1,Math.hypot(dx,dy));
    const rest=48+a.radius+b.radius, force=Math.max(-4,Math.min(4,(d-rest)*.018));
    const fx=dx/d*force,fy=dy/d*force;
    if(!a.fixed){a.vx+=fx;a.vy+=fy;} if(!b.fixed){b.vx-=fx;b.vy-=fy;}
  }
  // Tags provide a gentle community pull; only real note links draw edges.
  const memberships = new Map<number,number>();
  for(const group of network.communities)for(const i of group)memberships.set(i,(memberships.get(i)??0)+1);
  for(const group of network.communities){const cx=group.reduce((sum,i)=>sum+nodes[i].x,0)/group.length,cy=group.reduce((sum,i)=>sum+nodes[i].y,0)/group.length;for(const i of group){const n=nodes[i];if(!n.fixed){n.vx+=(cx-n.x)*.002/(memberships.get(i)??1);n.vy+=(cy-n.y)*.002/(memberships.get(i)??1);}}}
  let energy=0;
  for(const n of nodes){
    if(n.fixed){n.vx=0;n.vy=0;continue;}
    n.vx=(n.vx-n.x*.0007)*.8;n.vy=(n.vy-n.y*.0007)*.8;
    n.x+=n.vx;n.y+=n.vy;energy+=Math.abs(n.vx)+Math.abs(n.vy);
  }
  return energy;
}
