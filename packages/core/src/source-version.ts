import { parseFrontmatter } from './frontmatter.js';
import { hashContent } from './task-document.js';
import type { MemorySource } from './contracts.js';
export function sourceVersion(path:string,content:string):MemorySource {
  let noteId:string|null=null;
  try{const {metadata}=parseFrontmatter(content),id=metadata.id??metadata.relay_id;if(typeof id==='string')noteId=id;}catch{}
  return {noteId,path,contentHash:hashContent(content),state:'current',checkedAt:Date.now()};
}
