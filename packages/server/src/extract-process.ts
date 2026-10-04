import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { createWorker, PSM, type Worker } from 'tesseract.js';
import { loadImage, createCanvas } from '@napi-rs/canvas';
import type { ExtractionReport, ExtractionPage } from '@relay/core';
import { EXTRACTOR_VERSION } from './extraction.js';
import { assertImageDimensions } from './image-limits.js';

const require=createRequire(import.meta.url);
const MAX_TEXT=1_000_000,MAX_PIXELS=16_000_000;
let ocr:Worker|undefined;
let modelPath='';
async function recognize(bytes:Buffer):Promise<{text:string;confidence:number}> {
  assertImageDimensions(bytes);
  const image=await loadImage(bytes);
  if(!image.width || !image.height || image.width*image.height>MAX_PIXELS)throw new Error('Изображение должно содержать не более 16 млн пикселей.');
  if(!ocr){
    for(const code of ['rus','eng'])await fs.copyFile(path.join(path.dirname(require.resolve('@tesseract.js-data/'+code)),'4.0.0_best_int',code+'.traineddata.gz'),path.join(modelPath,code+'.traineddata.gz'));
    // Read bundled compact models from one local directory. No network fallback.
    ocr=await createWorker('rus+eng',1,{langPath:modelPath,cacheMethod:'none',errorHandler:()=>{}});
    await ocr.setParameters({tessedit_pageseg_mode:PSM.AUTO,user_defined_dpi:'150',preserve_interword_spaces:'1'});
  }
  const canvas=createCanvas(image.width,image.height);canvas.getContext('2d').drawImage(image,0,0);
  const {data}=await ocr.recognize(canvas.toBuffer('image/png'),{rotateAuto:true});
  return {text:data.text,confidence:data.confidence};
}
function xmlText(xml:string):string {
  if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('Некорректный XML в DOCX.');
  const decode=(s:string)=>s.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi,m=>{const named:Record<string,string>={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};if(named[m])return named[m];const cp=m.startsWith('&#x')?parseInt(m.slice(3,-1),16):parseInt(m.slice(2,-1),10);return cp>0&&cp<=0x10ffff?String.fromCodePoint(cp):'';});
  return [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:(tab|br)\b[^>]*\/?>|<\/w:(p|tc|tr)>/g)].map(m=>m[1]!==undefined?decode(m[1]):m[2]==='tab'||m[3]==='tc'?'\t':'\n').join('');
}
async function extract(kind:string,bytes:Buffer):Promise<ExtractionReport>{
  const report:ExtractionReport={version:EXTRACTOR_VERSION,status:'complete',pages:[],warnings:[],images:[]};
  const page=(p:ExtractionPage)=>{if(report.pages.reduce((n,p)=>n+p.text.length,0)+p.text.length>MAX_TEXT)throw new Error('Извлечённый текст превышает 1 млн символов. Разделите документ.');report.pages.push(p);};
  if(['png','jpg','jpeg','webp'].includes(kind)){
    const r=await recognize(bytes);const warnings=r.confidence<65?['Низкая уверенность OCR: проверьте текст по оригиналу.']:[];
    if(!r.text.trim()){report.status='partial';warnings.push('Текст на изображении не распознан; оригинал сохранится полностью.');}
    page({number:1,method:'ocr',...r,warnings});return report;
  }
  if(kind==='docx'){
    let total=0;
    const files=unzipSync(new Uint8Array(bytes),{filter:f=>{
      const selected=/^word\/(?:document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(f.name)||/^word\/media\/[^/]+$/.test(f.name);
      if(/^(?:word\/(?:charts|embeddings)\/)/.test(f.name)){report.status='partial';report.warnings.push('Объект '+f.name+' доступен в оригинале, отдельно не извлечён.');}
      if(selected){total+=f.originalSize;if(total>25*1024*1024 || f.originalSize>20*1024*1024)throw new Error('DOCX слишком велик после распаковки.');}return selected;
    }});
    if(!files['word/document.xml'])throw new Error('Не найден основной текст DOCX.');
    const names=Object.keys(files).filter(n=>n.endsWith('.xml')).sort((a,b)=>a==='word/document.xml'?-1:b==='word/document.xml'?1:a.localeCompare(b));
    let i=1;for(const name of names)page({number:i++,method:'text',text:(name==='word/document.xml'?'':'['+name+']\n')+xmlText(new TextDecoder('utf-8',{fatal:true}).decode(files[name])),confidence:null,warnings:[]});
    for(const [name,data] of Object.entries(files).filter(([n])=>n.startsWith('word/media/'))){
      const ext=path.extname(name).toLowerCase(),mediaType=ext==='.png'?'image/png':['.jpg','.jpeg'].includes(ext)?'image/jpeg':ext==='.webp'?'image/webp':null;
      if(!mediaType){report.status='partial';report.warnings.push('Рисунок '+name+' сохранён только внутри оригинала DOCX.');continue;}
      report.images.push({name:path.basename(name),mediaType,base64:Buffer.from(data).toString('base64')});
    }
    report.warnings.push('Таблицы перенесены строками и табуляцией; расположение рисунков и оформление смотрите в оригинале.');return report;
  }
  if(kind!=='pdf')throw new Error('Неподдерживаемый формат распознавания.');
  const {getDocument,OPS}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfRoot=path.dirname(require.resolve('pdfjs-dist/package.json'));
  const loading=getDocument({data:new Uint8Array(bytes),disableFontFace:true,useSystemFonts:false,verbosity:0,cMapUrl:path.join(pdfRoot,'cmaps').replaceAll('\\','/')+'/',cMapPacked:true,standardFontDataUrl:path.join(pdfRoot,'standard_fonts').replaceAll('\\','/')+'/'});
  try{
    const pdf=await loading.promise;if(pdf.numPages>100)throw new Error('PDF должен содержать не более 100 страниц.');
    for(let i=1;i<=pdf.numPages;i++){
      try{
        const p=await pdf.getPage(i),tc=await p.getTextContent();
        const text=tc.items.map(item=>'str' in item?item.str+('hasEOL' in item&&item.hasEOL?'\n':' '):'').join('');
        const ops=await p.getOperatorList();const hasImage=ops.fnArray.some(op=>[OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageMaskXObject].includes(op));
        if(text.trim() && !hasImage){page({number:i,method:'text',text,confidence:null,warnings:[]});}
        else{
          const original=p.getViewport({scale:2});const scale=original.width*original.height>MAX_PIXELS?2*Math.sqrt(MAX_PIXELS/(original.width*original.height)):2;
          const viewport=p.getViewport({scale});const factory=pdf.canvasFactory as {create:(w:number,h:number)=>{canvas:any;context:any};destroy:(cc:any)=>void},cc=factory.create(Math.ceil(viewport.width),Math.ceil(viewport.height));
          try{await p.render({canvas:cc.canvas,canvasContext:cc.context,viewport}).promise;const r=await recognize(cc.canvas.toBuffer('image/png'));
            const warnings=r.confidence<65?['Низкая уверенность OCR: проверьте страницу по оригиналу.']:[];
            if(!r.text.trim())warnings.push('На странице не распознан текст.');
            if(hasImage&&text.trim())warnings.push('Смешанная страница распознана целиком, чтобы учесть текст внутри изображений.');
            page({number:i,method:'ocr',...r,warnings});if(!r.text.trim() && hasImage)report.status='partial';
          }finally{factory.destroy(cc);}
        }p.cleanup();
      }catch{report.status='partial';page({number:i,method:'ocr',text:'',confidence:null,warnings:['Не удалось извлечь страницу; она доступна в оригинале.']});}
    }
    report.warnings.push('Порядок текста и таблиц может отличаться от оригинала; графика PDF сохранена внутри оригинала.');return report;
  }finally{await loading.destroy();}
}
process.once('message',async(v:any)=>{
  try{modelPath=String(v.scratch);const report=await extract(String(v.kind),Buffer.from(v.bytes));process.send?.({report});}
  catch(e){process.send?.({error:e instanceof Error?e.message:'Не удалось обработать документ.'});}
  finally{await ocr?.terminate().catch(()=>{});process.disconnect();}
});
