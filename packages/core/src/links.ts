import path from 'node:path';
export interface VaultLink { start:number; end:number; kind:'wiki'|'markdown'; raw:string; target:string; anchor:string; alias:string; embed:boolean }
/** Keep source offsets intact while excluding fenced/inline code from link discovery. */
export function vaultLinks(content:string):VaultLink[] {
  let fence='';let offset=0;let searchable='';
  for(const line of content.split(/(?<=\n)/)) {
    const mark=/^\s*(`{3,}|~{3,})/.exec(line);
    if(mark){if(!fence)fence=mark[1][0];else if(fence===mark[1][0])fence='';searchable+=' '.repeat(line.length);}
    else searchable+=fence?' '.repeat(line.length):line.replace(/(`+)[^\n]*?\1/g,m=>' '.repeat(m.length));
    offset+=line.length;
  }
  const out:VaultLink[]=[];
  const re=/!?\[\[([^\]\n]+)\]\]|!?\[([^\]\n]*)\]\((<[^>\n]+>|[^\s)]+)(?:\s+"[^"\n]*")?\)/g;
  let m:RegExpExecArray|null;
  while((m=re.exec(searchable))) {
    const kind=m[1]!==undefined?'wiki':'markdown';
    const inner=kind==='wiki'?m[1]:m[3].replace(/^<|>$/g,'');
    const split=kind==='wiki'?inner.indexOf('|'):-1;
    const targetPart=split>=0?inner.slice(0,split):inner;
    const anchorAt=targetPart.indexOf('#');
    let target=anchorAt>=0?targetPart.slice(0,anchorAt):targetPart;
    try{target=decodeURIComponent(target);}catch{}
    if(!target||/^[a-z][a-z\d+.-]*:/i.test(target)||target.startsWith('//'))continue;
    out.push({start:m.index,end:m.index+m[0].length,raw:content.slice(m.index,m.index+m[0].length),kind,target,anchor:anchorAt>=0?targetPart.slice(anchorAt):'',alias:split>=0?inner.slice(split):'',embed:m[0][0]==='!'});
  }
  return out;
}
export function resolveVaultLink(link:VaultLink,from:string,paths:string[]):{path:string|null;ambiguous:boolean} {
  const normalize=(s:string)=>path.posix.normalize(s.replace(/\\/g,'/')).replace(/^\//,'');
  if(link.kind==='markdown') {
    const p=normalize(link.target.startsWith('/')?link.target:path.posix.join(path.posix.dirname(from),link.target));
    return {path:p.startsWith('../')?null:p,ambiguous:false};
  }
  const target=normalize(link.target),md=/\.[^/]+$/.test(target)?target:target+'.md';
  const exact=paths.filter(p=>p.toLowerCase()===md.toLowerCase());
  if(exact.length===1)return {path:exact[0],ambiguous:false};
  const local=normalize(path.posix.join(path.posix.dirname(from),md));
  const near=paths.filter(p=>p.toLowerCase()===local.toLowerCase());
  if(near.length===1)return {path:near[0],ambiguous:false};
  const matches=paths.filter(p=>path.posix.basename(p).toLowerCase()===md.toLowerCase());
  return {path:matches.length===1?matches[0]:null,ambiguous:matches.length>1||exact.length>1};
}
export function repairVaultLinks(content:string,from:string,moves:Map<string,string>,paths:string[]):string {
  const newFrom=moves.get(from)??from;
  const edits:{start:number;end:number;value:string}[]=[];
  for(const link of vaultLinks(content)) {
    const resolved=resolveVaultLink(link,from,paths);
    if(resolved.ambiguous){if(newFrom!==from)throw new Error('AMBIGUOUS_LINK:'+from);continue;}
    if(!resolved.path)continue;
    const target=moves.get(resolved.path)??resolved.path;
    if(target===resolved.path&&newFrom===from)continue;
    if(link.kind==='wiki') {
      const p=link.target.toLowerCase().endsWith('.md')?target:target.replace(/\.md$/i,'');
      edits.push({start:link.start,end:link.end,value:(link.embed?'!':'')+'[['+p+link.anchor+link.alias+']]'});
    } else {
      let p=path.posix.relative(path.posix.dirname(newFrom),target);if(!p)p=path.posix.basename(target);
      const encoded=p.split('/').map(encodeURIComponent).join('/')+link.anchor;
      const open=link.raw.indexOf('](')+2,end=link.raw.lastIndexOf(')');
      const old=link.raw.slice(open,end),suffix=old.match(/\s+"[^"\n]*"$/)?.[0]??'';
      edits.push({start:link.start,end:link.end,value:link.raw.slice(0,open)+encoded+suffix+')'});
    }
  }
  for(const e of edits.sort((a,b)=>b.start-a.start))content=content.slice(0,e.start)+e.value+content.slice(e.end);
  return content;
}
