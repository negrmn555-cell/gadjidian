import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DomainError, VaultError, hashContent, readTaskDocument, type MutationReceipt, type Vault, type VaultWriteInput } from '@relay/core';
import type { Db, VaultOperation, VaultBatch } from './db.js';
import type { GitSync } from './sync.js';

interface WritePlan { path: string; content: string; baseHash: string | null }
export interface MutationRequest {
  operationId: string;
  request: unknown;
  prepare: () => Promise<WritePlan>;
}
export interface BatchRequest { operationId:string; request:unknown; guard?:()=>void; expectedHead?:string|null; prepare:()=>Promise<{files:{path:string;bytes:Buffer;baseHash:string|null;delete?:boolean}[];result:unknown}> }
export function hashBytes(bytes:Uint8Array):string {return createHash('sha256').update(bytes).digest('hex');}

export function fingerprint(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, val]) => [k, sort(val)]))
    : v;
  return hashContent(JSON.stringify(sort(value)));
}

export class VaultMutationService {
  constructor(private readonly vault: Vault, private readonly db: Db, private readonly sync: GitSync) {
    sync.onPublished(async head => {
      for (const op of db.operationsIn(['committed'])) {
        if (op.commitSha && await sync.isAncestor(op.commitSha, head)) db.updateOperation(op.operationId, 'synced', op.commitSha);
      }
      for(const batch of db.batchesIn(['committed']))if(batch.commitSha && await sync.isAncestor(batch.commitSha,head))db.updateBatch(batch.operationId,'synced',batch.commitSha);
    });
  }

  async write(input: VaultWriteInput): Promise<string> {
    const receipt = await this.mutate({
      operationId: randomUUID(), request: input,
      prepare: async () => {
        const old = await this.readCurrent(input.path);
        if (!input.overwrite && old !== null) throw new VaultError('Note already exists', 'EXISTS');
        if (input.overwrite && (input.expectedHash === undefined || old === null || hashContent(old) !== input.expectedHash)) {
          throw new DomainError('VERSION_CONFLICT', 'Заметка изменилась. Повторите запрос с актуальной версией.', 409);
        }
        return { path: input.path, content: input.content, baseHash: old === null ? null : hashContent(old) };
      },
    });
    return receipt.path;
  }

  mutate(input: MutationRequest): Promise<MutationReceipt> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.operationId)) return Promise.reject(new DomainError('VALIDATION_ERROR', 'Некорректный operationId.'));
    const requestHash = fingerprint(input.request);
    return this.sync.exclusive(async () => {
      const existing = this.db.getOperation(input.operationId);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'Этот operationId уже использован для другого запроса.', 409);
        if (existing.state === 'conflict') throw new DomainError('VERSION_CONFLICT', 'Незавершённая операция конфликтует с текущей заметкой.', 409);
        if (existing.state === 'prepared') await this.finish(existing);
        return this.receipt(this.db.getOperation(input.operationId)!);
      }
      for (const pending of this.db.operationsIn(['prepared'])) await this.finish(pending);
      for (const pending of this.db.batchesIn(['prepared'])) await this.finishBatch(pending);
      await this.sync.assertWritable();
      const plan = await input.prepare();
      await this.vault.safePath(plan.path);
      readTaskDocument(plan.content, plan.path);
      const op: VaultOperation = {
        operationId: input.operationId, requestHash, path: plan.path, baseHash: plan.baseHash,
        contentHash: hashContent(plan.content), payload: plan.content, state: 'prepared', commitSha: null, errorCode: null,
      };
      this.db.prepareOperation(op);
      await this.finish(op);
      return this.receipt(this.db.getOperation(op.operationId)!);
    });
  }

  recoverIncomplete(): Promise<void> {
    return this.sync.exclusive(async () => {
      for (const op of this.db.operationsIn(['prepared'])) {
        try { await this.finish(op); }
        catch (e) { if (!(e instanceof DomainError) || !['VERSION_CONFLICT','SYNC_CONFLICT'].includes(e.code)) throw e; }
      }
      for(const batch of this.db.batchesIn(['prepared'])){
        try{await this.finishBatch(batch);}catch(e){if(!(e instanceof DomainError)||!['VERSION_CONFLICT','SYNC_CONFLICT'].includes(e.code))throw e;}
      }
      if (this.db.operationsIn(['committed']).length || this.db.batchesIn(['committed']).length) this.sync.schedulePush();
    });
  }

  private async readCurrent(rel: string): Promise<string | null> {
    const abs = await this.vault.safePath(rel);
    try { return await fs.readFile(abs, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }

  private async finish(op: VaultOperation): Promise<void> {
    const recorded = await this.sync.findOperationCommit(op.operationId);
    if (recorded) {
      this.db.updateOperation(op.operationId, 'committed', recorded);
      this.sync.schedulePush();
      return;
    }
    await this.sync.assertWritable();
    const current = await this.readCurrent(op.path);
    const currentHash = current === null ? null : hashContent(current);
    if (currentHash !== op.contentHash) {
      if (currentHash !== op.baseHash) {
        this.db.updateOperation(op.operationId, 'conflict', null, 'VERSION_CONFLICT');
        throw new DomainError('VERSION_CONFLICT', 'Файл изменился во время операции. Изменения сохранены для разрешения конфликта.', 409);
      }
      if (op.payload === null) throw new DomainError('RECOVERY_FAILED', 'Нет данных для восстановления операции.', 500);
      readTaskDocument(op.payload, op.path);
      const abs = await this.vault.safePath(op.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await this.vault.safePath(op.path);
      const tmp = abs + '.' + op.operationId + '.tmp';
      try {
        const handle = await fs.open(tmp, 'w');
        try { await handle.writeFile(op.payload, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        const latest=await this.readCurrent(op.path),latestHash=latest===null?null:hashContent(latest);
        if(latestHash!==op.baseHash && latestHash!==op.contentHash){this.db.updateOperation(op.operationId,'conflict',null,'VERSION_CONFLICT');throw new DomainError('VERSION_CONFLICT','Файл изменился перед сохранением. Чужие изменения сохранены.',409);}
        if(latestHash!==op.contentHash)await fs.rename(tmp, abs);
      } finally { await fs.rm(tmp, { force: true }); }
    }
    if(hashContent((await this.readCurrent(op.path))??'')!==op.contentHash){this.db.updateOperation(op.operationId,'conflict',null,'VERSION_CONFLICT');throw new DomainError('VERSION_CONFLICT','Файл изменился перед коммитом. Проверьте локальную запись.',409);}
    const commit = await this.sync.commitPaths([op.path], op.operationId);
    this.db.updateOperation(op.operationId, commit ? 'committed' : 'saved_local', commit);
    this.sync.schedulePush();
  }

  private receipt(op: VaultOperation): MutationReceipt {
    return { operationId: op.operationId, path: op.path, contentHash: op.contentHash, commitSha: op.commitSha,
      state: op.state === 'synced' ? 'synced' : op.commitSha ? 'committed' : 'saved_local' };
  }
  batchResult(operationId:string,request:unknown):{result:unknown;receipt:MutationReceipt}|null {
    const b=this.db.getBatch(operationId);if(!b)return null;
    if(b.requestHash!==fingerprint(request))throw new DomainError('IDEMPOTENCY_KEY_REUSED','operationId уже использован для другого импорта.',409);
    if(b.state==='conflict')throw new DomainError('VERSION_CONFLICT','Импорт конфликтует с текущими файлами.',409);
    if(b.state==='prepared')return null;
    return {result:b.result,receipt:this.batchReceipt(b)};
  }
  mutateBatch(input:BatchRequest):Promise<{result:unknown;receipt:MutationReceipt}> {
    if(!/^[A-Za-z0-9_-]{8,128}$/.test(input.operationId))return Promise.reject(new DomainError('VALIDATION_ERROR','Некорректный operationId.'));
    return this.sync.exclusive(async()=>{
      const old=this.db.getBatch(input.operationId),requestHash=fingerprint(input.request);
      if(old){if(old.requestHash!==requestHash)throw new DomainError('IDEMPOTENCY_KEY_REUSED','operationId уже использован для другого импорта.',409);if(old.state==='conflict')throw new DomainError('VERSION_CONFLICT','Импорт конфликтует с текущими файлами.',409);if(old.state==='prepared')await this.finishBatch(old);const b=this.db.getBatch(input.operationId)!;return {result:b.result,receipt:this.batchReceipt(b)};}
      for(const p of this.db.operationsIn(['prepared']))await this.finish(p);
      for(const p of this.db.batchesIn(['prepared']))await this.finishBatch(p);
      await this.sync.assertWritable();input.guard?.();
      if(input.expectedHead!==undefined && await this.sync.head()!==input.expectedHead)throw new DomainError('HEAD_CONFLICT','Git изменился после планирования. Постройте новый план.',409);
      const plan=await input.prepare();
      if(!plan.files.length || plan.files.length>256 || plan.files.reduce((n,f)=>n+f.bytes.length,0)>40*1024*1024)throw new DomainError('IMPORT_LIMIT','Импорт превышает лимит 256 файлов / 40 МБ.');
      const paths=new Set<string>();for(const f of plan.files){await this.vault.safePath(f.path);if(paths.has(f.path.toLowerCase()))throw new DomainError('IMPORT_PATH','Повтор пути в импорте.');paths.add(f.path.toLowerCase());if(f.delete&&f.baseHash===null)throw new DomainError('INVALID_DELETE','Для переноса нужна версия исходного файла.');if(!f.delete&&f.path.endsWith('.md'))readTaskDocument(f.bytes.toString('utf8'),f.path);}
      const b:VaultBatch={operationId:input.operationId,requestHash,files:plan.files.map(f=>({path:f.path,baseHash:f.baseHash,contentHash:hashBytes(f.bytes),base64:f.delete?null:f.bytes.toString('base64'),...(f.delete?{delete:true}:{} )})),result:plan.result,state:'prepared',commitSha:null,errorCode:null};
      input.guard?.();this.db.prepareBatch(b);await this.finishBatch(b,input.guard);const done=this.db.getBatch(b.operationId)!;return {result:done.result,receipt:this.batchReceipt(done)};
    });
  }
  private async finishBatch(b:VaultBatch,guard?:()=>void):Promise<void> {
    const commit=await this.sync.findOperationCommit(b.operationId);
    if(commit){this.db.updateBatch(b.operationId,'committed',commit);this.sync.schedulePush();return;}
    await this.sync.assertWritable();guard?.();
    // Validate every target before changing any of them. Already promoted files are recoverable.
    for(const f of b.files){let current:Buffer|null=null;try{current=await fs.readFile(await this.vault.safePath(f.path));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      const hash=current===null?null:hashBytes(current),resultHash=f.delete?null:f.contentHash;if(hash!==f.baseHash && hash!==resultHash){this.db.updateBatch(b.operationId,'conflict',null,'VERSION_CONFLICT');throw new DomainError('VERSION_CONFLICT','Файл изменился во время импорта. Чужие изменения сохранены.',409);}}
    // Promote new destinations and backlinks before removing the old source paths.
    for(const f of [...b.files].sort((a,b)=>Number(!!a.delete)-Number(!!b.delete))){guard?.();const abs=await this.vault.safePath(f.path);const hash=await fs.readFile(abs).then(hashBytes).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(f.delete){if(hash===null)continue;if(hash!==f.baseHash){this.db.updateBatch(b.operationId,'conflict',null,'VERSION_CONFLICT');throw new DomainError('VERSION_CONFLICT','Исходник переноса изменился.',409);}guard?.();await fs.unlink(abs);continue;}if(hash===f.contentHash)continue;
      if(f.base64===null)throw new DomainError('RECOVERY_FAILED','Нет данных для восстановления импорта.',500);
      await fs.mkdir(path.dirname(abs),{recursive:true});await this.vault.safePath(f.path);const tmp=abs+'.'+b.operationId+'.tmp';
      try{const h=await fs.open(tmp,'w');try{await h.writeFile(Buffer.from(f.base64,'base64'));await h.sync();}finally{await h.close();}
        const latest=await fs.readFile(abs).then(hashBytes).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
        if(latest!==f.baseHash&&latest!==f.contentHash){this.db.updateBatch(b.operationId,'conflict',null,'VERSION_CONFLICT');throw new DomainError('VERSION_CONFLICT','Файл изменился перед сохранением импорта. Проверьте локальные файлы.',409);}
        guard?.();if(latest!==f.contentHash)await fs.rename(tmp,abs);
      }finally{await fs.rm(tmp,{force:true});}
    }
    for(const f of b.files)if(await fs.readFile(await this.vault.safePath(f.path)).then(hashBytes).catch(e=>{if(e.code==='ENOENT')return null;throw e;})!==(f.delete?null:f.contentHash)){this.db.updateBatch(b.operationId,'conflict',null,'VERSION_CONFLICT');throw new DomainError('VERSION_CONFLICT','Файлы импорта изменились перед коммитом. Проверьте локальную запись.',409);}
    guard?.();
    const sha=await this.sync.commitPaths(b.files.map(f=>f.path),b.operationId);this.db.updateBatch(b.operationId,sha?'committed':'saved_local',sha);this.sync.schedulePush();
  }
  private batchReceipt(b:VaultBatch):MutationReceipt {
    const md=b.files.find(f=>!f.delete&&f.path.endsWith('.md'))??b.files[0];return {operationId:b.operationId,path:md.path,contentHash:md.contentHash,commitSha:b.commitSha,state:b.state==='synced'?'synced':b.commitSha?'committed':'saved_local'};
  }
}
