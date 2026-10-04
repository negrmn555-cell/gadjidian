import path from 'node:path';
import { DomainError } from '@relay/core';
import type { ChatStore } from './chat-store.js';
import { decodeUpload,MAX_UPLOAD } from './attachments.js';
import type { JobLease,Scheduler } from './scheduler.js';
export class ExtractionJobs {
  constructor(private store:ChatStore){}
  recover(scheduler:Scheduler):void{for(const f of this.store.pendingExtractions())scheduler.enqueue('extract','extract:'+f.id,Date.now(),0,f);}
  async enqueue(scheduler:Scheduler,device:number,chat:string,name:string,bytes:Buffer) {
    this.store.get(device,chat);if(!name||name.length>200||/[\0-\x1f]/.test(name)||!bytes.length||bytes.length>MAX_UPLOAD)throw new DomainError('FILE_NAME','Некорректный файл.');
    const pending=this.store.pendingExtractions();if(pending.length>=64||pending.filter(f=>f.device===device).length>=8)throw new DomainError('UPLOAD_BUSY','Очередь распознавания заполнена. Дождитесь обработки файлов.',429);
    const safe=path.basename(name.replace(/\\/g,'/')),decoded=await decodeUpload(safe,bytes,false,true);
    const file=this.store.putAttachment(device,chat,safe,decoded.mediaType,decoded.kind,bytes,'');this.store.extractionState(device,chat,file.id,'queued');
    scheduler.enqueue('extract','extract:'+file.id,Date.now(),0,{device,chat,id:file.id,expiresAt:file.expiresAt});return {...file,processing:'queued' as const};
  }
  async run(lease:JobLease) {
    const {device,chat,id}=lease.payload as {device:number;chat:string;id:string};
    lease.assert();let file;try{file=this.store.attachment(device,chat,id);}catch{return {status:'expired'};}
    this.store.extractionState(device,chat,id,'running');
    try{const result=await decodeUpload(file.name,file.bytes,true,false,AbortSignal.timeout(Math.max(1,Math.min(180000,file.expiresAt-Date.now()))));lease.assert();this.store.extracted(device,chat,id,result.text,result.report!);return {status:result.report!.status,pages:result.report!.pages.length};}
    catch(e){try{this.store.extractionState(device,chat,id,'failed',e instanceof DomainError?e.code:'EXTRACTION_FAILED');}catch{}throw e;}
  }
}
