import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DomainError } from '@relay/core';
export interface RenderedDocument {pageCount:number;pages:number[];pdf?:string;images?:{number:number;data:string}[]}
export function renderDocument(bytes:Buffer,pages:number[],format:'pdf'|'images',signal:AbortSignal):Promise<RenderedDocument>{
  signal.throwIfAborted();return new Promise((resolve,reject)=>{
    const child=fork(fileURLToPath(new URL('./document-render-process.js',import.meta.url)),[],{execArgv:['--max-old-space-size=384'],serialization:'advanced',stdio:['ignore','ignore','ignore','ipc']});let settled=false;
    const finish=(error:Error|null,result?:RenderedDocument)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);child.kill();error?reject(error):resolve(result!);};
    const abort=()=>finish(new DomainError('DOCUMENT_CANCELLED','Обработка PDF отменена.'));
    const timer=setTimeout(()=>finish(new DomainError('DOCUMENT_TIMEOUT','Подготовка страниц превысила 40 секунд.')),40_000);signal.addEventListener('abort',abort,{once:true});
    child.on('message',(message:any)=>message.error?finish(new DomainError('DOCUMENT_INVALID',String(message.error))):finish(null,message.result));
    child.on('error',()=>finish(new DomainError('DOCUMENT_RENDER_FAILED','Не удалось запустить обработку PDF.')));child.on('exit',()=>{if(!settled)finish(new DomainError('DOCUMENT_RENDER_FAILED','Обработка PDF прервана.'));});
    if(signal.aborted)abort();else child.send({bytes,pages,format});
  });
}
