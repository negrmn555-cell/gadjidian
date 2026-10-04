import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { DomainError } from '@relay/core';
import type { ChatStore } from './chat-store.js';
import { extractFull, EXTRACTOR_VERSION } from './extraction.js';
import type { ExtractionReport } from '@relay/core';

export const MAX_UPLOAD=5*1024*1024;
export async function decodeUpload(name:string,bytes:Buffer,full=false,verifyOnly=false,signal?:AbortSignal):Promise<{mediaType:string;kind:'text'|'image';text:string;report?:ExtractionReport}>{
  if(!bytes.length||bytes.length>MAX_UPLOAD)throw new DomainError('FILE_SIZE','Размер файла должен быть от 1 байта до 5 МБ.',413);
  const ext=path.extname(name).toLowerCase();
  const images:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'};
  if(images[ext]){
    const valid=ext==='.png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):ext==='.webp'?bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP':bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
    if(!valid)throw new DomainError('FILE_FORMAT','Содержимое не соответствует формату изображения.');
    if(!full)return {mediaType:images[ext],kind:'image',text:''};
    const report=await extractFull(ext.slice(1),bytes,signal);return {mediaType:images[ext],kind:'image',text:report.pages.map(p=>p.text).join('\n\n'),report};
  }
  if(['.txt','.md','.csv','.json'].includes(ext)){
    let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new DomainError('FILE_ENCODING','Текстовый документ должен быть в UTF-8.');}
    if(text.includes('\0')||!text.trim()||text.length>(full||verifyOnly?1_000_000:80_000))throw new DomainError('FILE_TEXT','Документ превышает лимит текста или содержит бинарные данные.');
    return {mediaType:'text/plain',kind:'text',text,...(full?{report:{version:EXTRACTOR_VERSION,status:'complete' as const,pages:[{number:1,method:'text' as const,text,confidence:null,warnings:[]}],warnings:[],images:[]}}:{})};
  }
  if(ext!=='.pdf'&&ext!=='.docx')throw new DomainError('FILE_FORMAT','Поддерживаются PNG, JPEG, WebP, PDF, DOCX и текстовые файлы TXT/MD/CSV/JSON.');
  if(ext==='.pdf'&&bytes.toString('ascii',0,5)!=='%PDF-'||ext==='.docx'&&bytes.toString('ascii',0,2)!=='PK')throw new DomainError('FILE_FORMAT','Содержимое не соответствует формату документа.');
  if(verifyOnly)return {mediaType:ext==='.pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',kind:'text',text:''};
  if(full){const report=await extractFull(ext.slice(1),bytes,signal);return {mediaType:ext==='.pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',kind:'text',text:report.pages.map(p=>'[Страница / раздел '+p.number+']\n'+p.text).join('\n\n'),report};}
  const text=await new Promise<string>((resolve,reject)=>{
    const worker=new Worker(new URL('./extract-worker.js',import.meta.url),{workerData:{kind:ext.slice(1),bytes},resourceLimits:{maxOldGenerationSizeMb:128}});
    const timer=setTimeout(()=>{void worker.terminate();reject(new DomainError('EXTRACTION_TIMEOUT','Документ обрабатывается слишком долго. Разделите его на части.'));},20_000);
    let settled=false;
    const fail=(message:string)=>{if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();reject(new DomainError('EXTRACTION_FAILED',message));};
    worker.on('message',(r:{text?:string;error?:string})=>{if(r.error)return fail(r.error);if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();resolve(r.text??'');});
    worker.on('error',()=>fail('Не удалось обработать документ.'));worker.on('exit',code=>{if(!settled)fail('Обработка документа прервана.');});
  });
  return {mediaType:ext==='.pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',kind:'text',text};
}
export async function upload(store:ChatStore,device:number,chat:string,name:string,bytes:Buffer){
  store.get(device,chat);
  if(!name||name.length>200||/[\u0000-\u001f]/.test(name))throw new DomainError('FILE_NAME','Некорректное имя файла.');
  const decoded=await decodeUpload(path.basename(name.replace(/\\/g,'/')),bytes,true);
  return store.putAttachment(device,chat,path.basename(name.replace(/\\/g,'/')),decoded.mediaType,decoded.kind,bytes,decoded.text,decoded.report);
}
