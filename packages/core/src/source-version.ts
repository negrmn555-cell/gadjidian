import { parseDocument } from 'yaml';
import { hashContent } from './task-document.js';
import type { MemorySource } from './contracts.js';
export function sourceVersion(path:string,content:string):MemorySource {
  let noteId:string|null=null;
  try{const yaml=/^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];if(yaml){const d=parseDocument(yaml,{uniqueKeys:true});if(!d.errors.length){const v=d.toJS({maxAliasCount:32}),id=v?.id??v?.relay_id;if(typeof id==='string')noteId=id;}}}catch{}
  return {noteId,path,contentHash:hashContent(content),state:'current',checkedAt:Date.now()};
}
