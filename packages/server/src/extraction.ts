import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DomainError, type ExtractionReport } from '@relay/core';

export const EXTRACTOR_VERSION='relay-local-ocr-1';
/** Own process: killing it also terminates its OCR threads and native allocations. */
export async function extractFull(kind:string,bytes:Buffer,signal?:AbortSignal):Promise<ExtractionReport> {
  if(signal?.aborted)throw new DomainError('EXTRACTION_EXPIRED','Распознавание отменено или срок хранения истёк.');
  const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'relay-ocr-models-'));
  try{return await new Promise<ExtractionReport>((resolve,reject)=>{
    const child=fork(fileURLToPath(new URL('./extract-process.js',import.meta.url)),[],{execArgv:['--max-old-space-size=512'],serialization:'advanced',stdio:['ignore','ignore','ignore','ipc']});
    let settled=false;
    const abort=()=>finish(new DomainError('EXTRACTION_EXPIRED','Срок распознавания истёк.'));
    const finish=(error:DomainError|null,result?:ExtractionReport)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);child.kill();error?reject(error):resolve(result!);};
    const timer=setTimeout(()=>finish(new DomainError('EXTRACTION_TIMEOUT','Распознавание превысило 3 минуты. Разделите документ и повторите. Оригинал ещё не импортирован.')),180_000);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
    child.on('message',(r:any)=>r.error?finish(new DomainError('EXTRACTION_FAILED',String(r.error))):finish(null,r.report));
    child.on('error',()=>finish(new DomainError('EXTRACTION_FAILED','Не удалось запустить распознавание.')));
    child.on('exit',()=>{if(!settled)finish(new DomainError('EXTRACTION_FAILED','Распознавание прервано.'))});
    child.send({kind,bytes,scratch});
  });}finally{
    if(path.dirname(path.resolve(scratch))!==path.resolve(os.tmpdir())||!path.basename(scratch).startsWith('relay-ocr-models-'))throw new Error('Unsafe OCR cleanup');
    await fs.rm(scratch,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
}
