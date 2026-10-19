import path from 'node:path';
import { DomainError } from '@relay/core';
import type { ChatStore } from './chat-store.js';
import { decodeUpload,MAX_UPLOAD } from './attachments.js';
import { EXTRACTOR_VERSION } from './extraction.js';
import { hashBytes, fingerprint } from './vault-mutations.js';
import type { JobLease,Scheduler } from './scheduler.js';
export class ExtractionJobs {
  private controllers=new Set<AbortController>();
  constructor(private store:ChatStore,private allowed:(device:number)=>boolean=()=>true){}
  recover(scheduler:Scheduler):void{for(const f of this.store.pendingExtractions())scheduler.enqueue('extract','extract:'+f.id,Date.now(),0,f);}
  async enqueue(scheduler:Scheduler,device:number,chat:string,name:string,bytes:Buffer) {
    this.store.get(device,chat);if(!name||name.length>200||/[\0-\x1f]/.test(name)||!bytes.length||bytes.length>MAX_UPLOAD)throw new DomainError('FILE_NAME','Некорректный файл.');
    const pending=this.store.pendingExtractions();if(pending.length>=64||pending.filter(f=>f.device===device).length>=8)throw new DomainError('UPLOAD_BUSY','Очередь распознавания заполнена. Дождитесь обработки файлов.',429);
    const safe=path.basename(name.replace(/\\/g,'/')),decoded=await decodeUpload(safe,bytes,false,true);
    const file=this.store.putAttachment(device,chat,safe,decoded.mediaType,decoded.kind,bytes,'');this.store.extractionState(device,chat,file.id,'queued');
    scheduler.enqueue('extract','extract:'+file.id,Date.now(),0,{device,chat,id:file.id,expiresAt:file.expiresAt});scheduler.wake();return {...file,processing:'queued' as const};
  }
  async run(lease:JobLease) {
    const {device,chat,id}=lease.payload as {device:number;chat:string;id:string};
    lease.assert();let file;try{file=this.store.attachment(device,chat,id);}catch{return {status:'expired'};}
    const controller=new AbortController();this.controllers.add(controller);
    const guard=()=>{lease.assert();controller.signal.throwIfAborted();if(!this.allowed(device))throw new DomainError('JOB_CANCELLED','Устройство отключено.');this.store.attachment(device,chat,id);};
    const watcher=setInterval(()=>{try{guard();}catch{controller.abort();}},1000);watcher.unref();
    const timer=setTimeout(()=>controller.abort(),Math.max(1,Math.min(180000,file.expiresAt-Date.now())));timer.unref();
    this.store.extractionState(device,chat,id,'running');
    try{
      const fileHash=hashBytes(file.bytes),settingsHash=fingerprint({version:EXTRACTOR_VERSION,kind:path.extname(file.name),languages:'rus+eng',maxPages:100,maxPixels:16_000_000}),key='local:'+fileHash+':'+settingsHash;
      const cached=this.store.cachedExtraction(device,chat,key) as Awaited<ReturnType<typeof decodeUpload>>|null;
      const result=cached??await decodeUpload(file.name,file.bytes,true,false,controller.signal);guard();
      const report={...result.report!,fileHash,settingsHash};this.store.extracted(device,chat,id,result.text,report);
      if(!cached)this.store.cacheExtraction(device,chat,key,{...result,report},file.expiresAt);
      return {status:report.status,pages:report.pages.length,cacheHit:!!cached};
    }catch(e){try{this.store.extractionState(device,chat,id,'failed',controller.signal.aborted?'CANCELLED':e instanceof DomainError?e.code:'EXTRACTION_FAILED');}catch{}if(controller.signal.aborted)throw new DomainError('JOB_CANCELLED','Распознавание остановлено.');throw e;}
    finally{clearInterval(watcher);clearTimeout(timer);this.controllers.delete(controller);}
  }
  stop(){for(const c of this.controllers)c.abort();}
}
