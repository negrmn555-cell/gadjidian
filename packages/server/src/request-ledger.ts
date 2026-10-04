import { DomainError } from '@relay/core';
import type { Db } from './db.js';
import { fingerprint } from './vault-mutations.js';
export class RequestLedger {
  constructor(private db:Db,private now=()=>Date.now()){}
  inspect(device:number,chat:string,request:string,hash?:string):{state:string;artifacts:string[]}|null {
    const row=this.db.sql.prepare('SELECT * FROM request_tombstones WHERE device_id=? AND chat_id=? AND request_id=?').get(device,chat,request) as {input_hash:string;state:string;artifacts_json:string}|undefined;
    if(!row)return null;if(hash&&row.input_hash!==hash)throw new DomainError('IDEMPOTENCY_KEY_REUSED','requestId уже использован для другого сообщения.',409);
    return {state:row.state,artifacts:JSON.parse(row.artifacts_json)};
  }
  reserve(device:number,chat:string,request:string,hash:string):void {
    if(!/^[A-Za-z0-9_-]{8,100}$/.test(request))throw new DomainError('INVALID_REQUEST_ID','Некорректный requestId.');
    const existing=this.inspect(device,chat,request,hash);if(existing)throw new DomainError('RUN_UNRESOLVED','Этот запрос уже был принят. Проверьте его результат; повторный ИИ не запускается.',409);
    this.db.sql.prepare("INSERT INTO request_tombstones(device_id,chat_id,request_id,input_hash,state,created_at) VALUES(?,?,?,?,'running',?)").run(device,chat,request,hash,this.now());
  }
  finish(device:number,chat:string,request:string,artifacts:string[]):void {
    this.db.sql.prepare("UPDATE request_tombstones SET state='completed',artifacts_json=? WHERE device_id=? AND chat_id=? AND request_id=?").run(JSON.stringify([...new Set(artifacts)]),device,chat,request);
  }
  recover():void {
    const rows=this.db.sql.prepare("SELECT device_id,chat_id,request_id FROM request_tombstones WHERE state='running'").all() as {device_id:number;chat_id:string;request_id:string}[];
    for(const r of rows){this.db.sql.prepare("UPDATE request_tombstones SET state='interrupted',artifacts_json=? WHERE device_id=? AND chat_id=? AND request_id=?").run(JSON.stringify(this.artifacts(r.device_id,r.chat_id,r.request_id)),r.device_id,r.chat_id,r.request_id);
    }
  }
  artifacts(deviceId:number,chat:string,requestId:string):string[]{const prefix='chatop_'+fingerprint({deviceId,chat,requestId}).slice(0,64);const paths=this.db.sql.prepare("SELECT path FROM vault_operations WHERE operation_id LIKE ? AND state<>'conflict'").all(prefix+'%') as {path:string}[];const batches=this.db.sql.prepare("SELECT files_json FROM vault_batches WHERE operation_id LIKE ? AND state<>'conflict'").all(prefix+'%') as {files_json:string}[];return [...new Set([...paths.map(p=>p.path),...batches.flatMap(b=>(JSON.parse(b.files_json) as {path:string;delete?:boolean}[]).filter(f=>!f.delete).map(f=>f.path))])];}
  recent(device:number,chat:string):{requestId:string;state:string;artifacts:string[]}[]{return (this.db.sql.prepare("SELECT request_id,state,artifacts_json FROM request_tombstones WHERE device_id=? AND chat_id=? AND created_at>? ORDER BY created_at DESC LIMIT 10").all(device,chat,this.now()-14*86400000) as {request_id:string;state:string;artifacts_json:string}[]).map(r=>({requestId:r.request_id,state:r.state,artifacts:JSON.parse(r.artifacts_json)}));}
}
