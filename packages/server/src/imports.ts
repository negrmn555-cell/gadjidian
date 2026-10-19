import path from 'node:path';
import { promises as fs } from 'node:fs';
import { DomainError, objectInput, hashContent, type Vault, type ImportResult, type ExtractionReport } from '@relay/core';
import type { ChatStore } from './chat-store.js';
import { VaultMutationService, hashBytes } from './vault-mutations.js';
import { decodeUpload } from './attachments.js';
import { noteKeywords } from './notes.js';
import { allocateRecordTitle, recordFileName } from './record-codes.js';
const folders={study:'Study',work:'Work',personal:'Personal'};
interface AssetManifest {schema:1;assetId:string;originalPath:string;originalName:string;originalHash:string;notePath:string;status:'complete'|'partial';extractor:string;languages:string[];pages:{number:number;method:string;characters:number;confidence:number|null;warnings:string[]}[];warnings:string[];files:{path:string;hash:string;size:number}[]}
export class ImportService {
  constructor(private readonly vault:Vault,private readonly store:ChatStore,private readonly mutations:VaultMutationService){}
  async import(device:number,chat:string,fileId:string,value:unknown,operationId:string):Promise<ImportResult> {
    const input=objectInput(value);
    if(typeof input.title!=='string'||!String(input.title).trim()||input.title.length>200||/[\r\n\0]/.test(input.title)||!['study','work','personal'].includes(String(input.category)))throw new DomainError('INVALID_IMPORT','Укажите название и категорию заметки.');
    const request={kind:'full-import',device,chat,fileId,title:String(input.title).trim(),category:input.category};
    const replay=this.mutations.batchResult(operationId,request);if(replay)return {...replay.result as Omit<ImportResult,'receipt'>,receipt:replay.receipt};
    const file=this.store.attachment(device,chat,fileId);
    if(file.processing!=='ready')throw new DomainError('EXTRACTION_PENDING','Дождитесь успешного распознавания файла.',409);
    const report:ExtractionReport=file.report??(await decodeUpload(file.name,file.bytes,true)).report!;
    // Same original and processing policy have one permanent asset, regardless of upload ID/name.
    const sha=hashBytes(file.bytes),assetId='asset_'+hashContent(sha+'\n'+report.version+'\nrus+eng'+(report.pages.some(p=>p.interpretation)?'\n'+hashContent(JSON.stringify(report.pages.map(p=>p.interpretation??null))):'')),root='_attachments/'+assetId;
    const originalPath=root+'/original'+path.extname(file.name).toLowerCase(),manifestPath=root+'/manifest.json';
    const warnings=[...report.warnings,...report.pages.flatMap(p=>p.warnings.map(w=>'Страница / раздел '+p.number+': '+w))];
    const result=await this.mutations.mutateBatch({operationId,request,prepare:async()=>{
      if(await this.vault.exists(manifestPath)){
        const existing=await this.manifest(assetId);await this.verify(existing);
        return {files:[{path:manifestPath,bytes:Buffer.from(JSON.stringify(existing,null,2)+'\n'),baseHash:hashBytes(await fs.readFile(await this.vault.safePath(manifestPath)))}],result:{assetId,notePath:existing.notePath,originalPath:existing.originalPath,manifestPath,status:existing.status,warnings:existing.warnings}};
      }
      const files:{path:string;bytes:Buffer;baseHash:null}[]=[{path:originalPath,bytes:file.bytes,baseHash:null}];
      for(const [i,image] of report.images.entries()){const ext=image.mediaType==='image/png'?'.png':image.mediaType==='image/jpeg'?'.jpg':'.webp';files.push({path:root+'/images/image-'+(i+1)+ext,bytes:Buffer.from(image.base64,'base64'),baseHash:null});}
      const title=await allocateRecordTitle(this.vault,String(input.title).trim());
      const notePath='Areas/'+folders[input.category as keyof typeof folders]+'/Notes/'+recordFileName(title)+'.md';
      const metadata={relay_schema:1,id:'note_'+assetId.slice(6),title,type:'quick',category:input.category,tags:[input.category,'import'],keywords:noteKeywords(input.title+' '+report.pages.map(p=>p.text).join('\n').slice(0,5000)),asset_id:assetId,created_at:new Date().toISOString()};
      const intro='Импорт: **'+(report.status==='complete'?'Все страницы / разделы обработаны':'Частичный — проверьте пропуски')+'**. OCR требует сверки с оригиналом.\n\nОригинал: [['+originalPath+']]\nManifest: [['+manifestPath+']]';
      const content='---\n'+Object.entries(metadata).map(([k,v])=>k+': '+JSON.stringify(v)).join('\n')+'\n---\n\n# '+title+'\n\n'+intro+(warnings.length?'\n\n## Замечания\n'+warnings.map(w=>'- '+w).join('\n'):'')+'\n\n## Полный извлечённый текст\n\n'+report.pages.map(p=>'### Страница / раздел '+p.number+' · '+(p.method==='ocr'?'OCR':'текст')+'\n\n'+(p.text||'[Текст не извлечён — см. оригинал]')+(p.interpretation?'\n\n#### Отдельная интерпретация модели · '+p.interpretation.model+'\n\n'+p.interpretation.text+'\n\nНе заменяет исходный текст и оригинал страницы.':'')).join('\n\n')+(report.images.length?'\n\n## Изображения\n'+files.slice(1).map(f=>'![['+f.path+']]').join('\n'):'')+'\n';
      files.push({path:notePath,bytes:Buffer.from(content),baseHash:null});
      const manifest:AssetManifest={schema:1,assetId,originalPath,originalName:file.name,originalHash:sha,notePath,status:report.status,extractor:report.version,languages:['rus','eng'],pages:report.pages.map(({text,...p})=>({...p,characters:text.length})),warnings,files:files.map(f=>({path:f.path,hash:hashBytes(f.bytes),size:f.bytes.length}))};
      // Manifest is promoted last. Downloads additionally require all original assets to verify.
      files.push({path:manifestPath,bytes:Buffer.from(JSON.stringify(manifest,null,2)+'\n'),baseHash:null});
      return {files,result:{assetId,notePath,originalPath,manifestPath,status:report.status,warnings}};
    }});
    return {...result.result as Omit<ImportResult,'receipt'>,receipt:result.receipt};
  }
  private async manifest(id:string):Promise<AssetManifest>{
    if(!/^asset_[a-f0-9]{64}$/.test(id))throw new DomainError('ASSET_NOT_FOUND','Оригинал не найден.',404);
    let value:AssetManifest;try{value=JSON.parse(await fs.readFile(await this.vault.safePath('_attachments/'+id+'/manifest.json'),'utf8'));}catch{throw new DomainError('ASSET_NOT_FOUND','Импорт ещё не завершён или оригинал не найден.',404);}
    if(value.assetId!==id||value.schema!==1||!value.originalPath.startsWith('_attachments/'+id+'/')||!Array.isArray(value.files))throw new DomainError('ASSET_INVALID','Manifest оригинала повреждён.',409);return value;
  }
  private async verify(m:AssetManifest):Promise<void>{
    // The imported Markdown is editable. Originals/images must remain byte-identical.
    const prefix='_attachments/'+m.assetId+'/';
    if(path.posix.normalize(m.originalPath)!==m.originalPath||!m.originalPath.startsWith(prefix)||!m.files.some(f=>f.path===m.originalPath&&f.hash===m.originalHash))throw new DomainError('ASSET_INVALID','Некорректный путь или checksum оригинала.',409);
    for(const file of m.files.filter(f=>f.path.startsWith(prefix))){if(path.posix.normalize(file.path)!==file.path)throw new DomainError('ASSET_INVALID','Некорректный путь файла импорта.',409);const bytes=await fs.readFile(await this.vault.safePath(file.path));if(hashBytes(bytes)!==file.hash)throw new DomainError('ASSET_INVALID','Оригинал или изображение изменены после импорта.',409);}
    if(!await this.vault.exists(m.notePath))throw new DomainError('ASSET_INVALID','Заметка импорта удалена. Оригинал сохранён.',409);
  }
  async original(id:string):Promise<{name:string;bytes:Buffer}>{const m=await this.manifest(id);await this.verify(m);return {name:m.originalName,bytes:await fs.readFile(await this.vault.safePath(m.originalPath))};}
}
