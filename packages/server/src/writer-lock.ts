import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DomainError } from '@relay/core';
export class WriterLock {
  private constructor(private file:string,private value:string){}
  static async acquire(root:string):Promise<WriterLock> {
    await fs.mkdir(root,{recursive:true});const canonical=await fs.realpath(root),dir=path.join(canonical,'.relay-server'),file=path.join(dir,'writer.json');
    if(await fs.lstat(dir).then(s=>s.isSymbolicLink()).catch(()=>false))throw new DomainError('WRITER_LOCK_UNSAFE','Служебная папка не должна быть ссылкой.',500);
    await fs.mkdir(dir,{recursive:true});const value=JSON.stringify({pid:process.pid,host:os.hostname(),owner:randomUUID()});
    for(let attempt=0;attempt<2;attempt++)try{await fs.writeFile(file,value,{flag:'wx',mode:0o600});return new WriterLock(file,value);}catch(e){
      if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
      const raw=await fs.readFile(file,'utf8'),old=JSON.parse(raw) as {pid:number;host:string};let dead=false;
      if(old.host===os.hostname()&&Number.isSafeInteger(old.pid)&&old.pid>0)try{process.kill(old.pid,0);}catch(err){dead=(err as NodeJS.ErrnoException).code==='ESRCH';}
      if(!dead)throw new DomainError('VAULT_ALREADY_OPEN','Этот vault уже обслуживается другим сервером. Запускайте один сервер-писатель.',409);
      if(await fs.readFile(file,'utf8')!==raw)throw new DomainError('WRITER_LOCK_CHANGED','Владелец vault изменился. Повторите запуск.',409);
      await fs.unlink(file);
    }
    throw new DomainError('VAULT_ALREADY_OPEN','Не удалось получить владение vault.',409);
  }
  async release():Promise<void>{if(await fs.readFile(this.file,'utf8').catch(()=>null)===this.value)await fs.unlink(this.file);}
}
