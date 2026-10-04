import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DomainError } from '@relay/core';
import type { ServerConfig } from './config.js';
import type { Db } from './db.js';

export class ProviderSecrets {
  private constructor(private readonly key: Buffer,private readonly previous:Buffer[]=[]) {}
  static async open(cfg: ServerConfig, allowCreate = true): Promise<ProviderSecrets> {
    let key: Buffer;
    if (cfg.providers.masterKey) {
      if (!/^[A-Za-z0-9+/]{43}=$/.test(cfg.providers.masterKey)) throw new DomainError('MASTER_KEY_INVALID', 'PROVIDER_MASTER_KEY должен содержать 32 байта в base64.', 500);
      key = Buffer.from(cfg.providers.masterKey, 'base64');
    } else {
      const file = path.resolve(cfg.providers.keyFile);
      const rel = path.relative(path.resolve(cfg.vault.root), file);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new DomainError('MASTER_KEY_LOCATION', 'Файл ключа шифрования должен находиться вне vault.', 500);
      if (!allowCreate && !(await fs.stat(file).then(() => true).catch(() => false))) {
        throw new DomainError('MASTER_KEY_MISSING', 'Ключ шифрования профилей отсутствует. Восстановите прежний ключ сервера из резервной копии.', 500);
      }
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      try { await fs.writeFile(file, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      if ((await fs.lstat(file)).isSymbolicLink()) throw new DomainError('MASTER_KEY_LOCATION', 'Файл ключа не должен быть символической ссылкой.', 500);
      key = await fs.readFile(file);
      if(key[0]===123){let ring:{current:string;previous:string[]};try{ring=JSON.parse(key.toString('utf8'));if(typeof ring.current!=='string'||!Array.isArray(ring.previous)||ring.previous.length>8)throw new Error();const current=Buffer.from(ring.current,'base64'),previous=ring.previous.map(k=>Buffer.from(k,'base64'));if([current,...previous].some(k=>k.length!==32))throw new Error();return new ProviderSecrets(current,previous);}catch{throw new DomainError('MASTER_KEY_INVALID','Некорректный файл ключей сервера.',500);}}
    }
    if (key.length !== 32) throw new DomainError('MASTER_KEY_INVALID', 'Некорректный ключ шифрования профилей.', 500);
    return new ProviderSecrets(key);
  }
  encrypt(secret: string, id: string, version: number): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(id + ':' + version));
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return 'v1.' + [iv, cipher.getAuthTag(), encrypted].map(v => v.toString('base64')).join('.');
  }
  decrypt(value: string, id: string, version: number): string {
    for(const key of [this.key,...this.previous])try{return this.decryptWith(key,value,id,version);}catch{}
    throw new DomainError('SECRET_UNAVAILABLE', 'Не удалось расшифровать ключ профиля. Проверьте ключ сервера.', 500);
  }
  private decryptWith(key:Buffer,value:string,id:string,version:number):string{
    try {
      const [format, ...parts] = value.split('.');
      if (format !== 'v1' || parts.length !== 3) throw new Error('Invalid secret format');
      const [iv, tag, encrypted] = parts.map(v => Buffer.from(v, 'base64'));
      const cipher = createDecipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(id + ':' + version)); cipher.setAuthTag(tag);
      return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
    } catch { throw new DomainError('SECRET_UNAVAILABLE', 'Не удалось расшифровать ключ профиля. Проверьте ключ сервера.', 500); }
  }
  static async rotate(cfg:ServerConfig,db:Db):Promise<{rotated:number}>{
    if(cfg.providers.masterKey)throw new DomainError('MASTER_KEY_ENV','Для управляемой ротации используйте файл ключа вместо PROVIDER_MASTER_KEY.',409);
    const old=await ProviderSecrets.open(cfg,false),next=new ProviderSecrets(randomBytes(32));
    const versions=(db.sql.prepare('SELECT provider_id,version,encrypted_secret FROM provider_versions WHERE encrypted_secret IS NOT NULL').all() as {provider_id:string;version:number;encrypted_secret:string}[]).map(r=>({...r,value:next.encrypt(old.decrypt(r.encrypted_secret,r.provider_id,r.version),r.provider_id,r.version)}));
    const vapid=db.getSetting('push.vapid'),vapidValue=vapid?next.encrypt(old.decrypt(vapid,'push-vapid',1),'push-vapid',1):null;
    const subscriptions=(db.sql.prepare('SELECT id,encrypted_json FROM push_subscriptions').all() as {id:string;encrypted_json:string}[]).map(r=>({...r,value:next.encrypt(old.decrypt(r.encrypted_json,'push-'+r.id,1),'push-'+r.id,1)}));
    const file=path.resolve(cfg.providers.keyFile),temp=file+'.rotate.tmp';
    const write=async(previous:Buffer[])=>{const h=await fs.open(temp,'w',0o600);try{await h.writeFile(JSON.stringify({current:next.key.toString('base64'),previous:previous.map(k=>k.toString('base64'))}));await h.sync();}finally{await h.close();}await fs.rename(temp,file);};
    // Key ring first: a crash on either side of the SQLite transaction can still decrypt every row.
    await write([old.key,...old.previous]);
    db.providerTransaction(()=>{for(const r of versions)db.sql.prepare('UPDATE provider_versions SET encrypted_secret=? WHERE provider_id=? AND version=?').run(r.value,r.provider_id,r.version);if(vapidValue)db.setSetting('push.vapid',vapidValue);for(const r of subscriptions)db.sql.prepare('UPDATE push_subscriptions SET encrypted_json=? WHERE id=?').run(r.value,r.id);});
    await write([]);return {rotated:versions.length+subscriptions.length+(vapid?1:0)};
  }
}
