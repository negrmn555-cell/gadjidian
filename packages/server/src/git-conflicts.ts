import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DomainError, hashContent, type Vault } from '@relay/core';
import type { Db } from './db.js';
import type { GitSync } from './sync.js';
export class GitConflicts {
  constructor(private vault:Vault,private db:Db,private sync:GitSync){}
  async list():Promise<{paths:string[];mergePaths:string[]}> {return this.sync.exclusive(async()=>({paths:await this.sync.conflictPaths(),mergePaths:await this.sync.mergePaths()}));}
  async get(p:string) {
    return this.sync.exclusive(async()=>{if(!(await this.sync.conflictPaths()).includes(p))throw new DomainError('NOT_FOUND','Конфликт не найден.',404);if(!p.toLowerCase().endsWith('.md'))throw new DomainError('BINARY_CONFLICT','Бинарный конфликт разрешается вручную на сервере.',422);
      const abs=await this.vault.safePath(p),content=await fs.readFile(abs,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});return {path:p,content,contentHash:content===null?null:hashContent(content),base:await this.sync.conflictStage(p,1),ours:await this.sync.conflictStage(p,2),theirs:await this.sync.conflictStage(p,3)};});
  }
  async resolve(p:string,expected:string|null,content:string|null,operationId:string) {
    if(!p.toLowerCase().endsWith('.md'))throw new DomainError('BINARY_CONFLICT','Бинарный конфликт разрешается вручную на сервере.',422);
    if(!/^[A-Za-z0-9_-]{8,128}$/.test(operationId)||(content!==null&&(typeof content!=='string'||content.length>1000000)))throw new DomainError('VALIDATION_ERROR','Некорректная версия разрешения.');
    return this.sync.exclusive(async()=>{
      const abs=await this.vault.safePath(p),old=await fs.readFile(abs,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;}),hash=old===null?null:hashContent(old),result=content===null?null:hashContent(content);
      const prior=this.db.sql.prepare('SELECT * FROM git_resolutions WHERE operation_id=?').get(operationId) as {path:string;expected_hash:string|null;result_hash:string|null;state:string}|undefined;
      if(prior){if(prior.path!==p||prior.expected_hash!==expected||prior.result_hash!==result)throw new DomainError('IDEMPOTENCY_KEY_REUSED','ID использован для другого разрешения.',409);if(prior.state==='done')return {ok:true};}
      if(hash!==expected&&(!prior||hash!==result))throw new DomainError('VERSION_CONFLICT','Рабочая версия конфликта изменилась.',409);
      if(!(await this.sync.conflictPaths()).includes(p)&&!prior)throw new DomainError('NOT_FOUND','Конфликт уже разрешён.',404);
      if(!prior)this.db.sql.prepare("INSERT INTO git_resolutions VALUES(?,?,?,?,?,'prepared',?)").run(operationId,p,expected,result,content,Date.now());
      const unchanged=async()=>{const current=await fs.readFile(abs,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});if((current===null?null:hashContent(current))!==hash)throw new DomainError('VERSION_CONFLICT','Рабочая версия изменилась во время сохранения.',409);};
      if(hash!==result){if(content===null){await unchanged();await fs.unlink(abs);}else {await fs.mkdir(path.dirname(abs),{recursive:true});const temp=abs+'.'+operationId+'.tmp';try{const h=await fs.open(temp,'w');try{await h.writeFile(content,'utf8');await h.sync();}finally{await h.close();}await unchanged();await fs.rename(temp,abs);}finally{await fs.rm(temp,{force:true});}}}
      await this.sync.stageResolution(p);this.db.sql.prepare("UPDATE git_resolutions SET state='done',payload=NULL WHERE operation_id=?").run(operationId);return {ok:true};
    });
  }
  async complete(expectedPaths:string[]):Promise<unknown> {
    if(!Array.isArray(expectedPaths)||expectedPaths.some(p=>typeof p!=='string'))throw new DomainError('VALIDATION_ERROR','Нужен проверенный список файлов слияния.');
    return this.sync.exclusive(async()=>{const actual=(await this.sync.mergePaths()).sort();if(JSON.stringify(actual)!==JSON.stringify([...expectedPaths].sort()))throw new DomainError('VERSION_CONFLICT','Список изменений слияния изменился. Проверьте его снова.',409);await this.sync.finishMerge();return this.sync.getStatus();});
  }
  async recover():Promise<void>{const rows=this.db.sql.prepare("SELECT operation_id,path,expected_hash,payload FROM git_resolutions WHERE state='prepared'").all() as {operation_id:string;path:string;expected_hash:string|null;payload:string|null}[];for(const r of rows)try{await this.resolve(r.path,r.expected_hash,r.payload,r.operation_id);}catch(e){if(!(e instanceof DomainError)||!['VERSION_CONFLICT','NOT_FOUND'].includes(e.code))throw e;}}
}
