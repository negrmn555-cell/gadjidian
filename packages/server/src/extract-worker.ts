import { parentPort, workerData } from 'node:worker_threads';
import { unzipSync } from 'fflate';

const max=80_000;
function xmlText(xml:string):string{
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Некорректный DOCX.');
  const decode=(s:string)=>s.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi,m=>{
    const named:Record<string,string>={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};
    if(named[m])return named[m]; const cp=m.startsWith('&#x')?parseInt(m.slice(3,-1),16):parseInt(m.slice(2,-1),10);return cp>0&&cp<=0x10ffff?String.fromCodePoint(cp):'';
  });
  return [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map(p=>[...p[1].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map(t=>decode(t[1])).join('')).join('\n');
}
async function extract():Promise<string>{
  const bytes=new Uint8Array(workerData.bytes);
  if(workerData.kind==='docx'){
    const files=unzipSync(bytes,{filter:f=>{if(f.name==='word/document.xml' && f.originalSize>2_000_000) throw new Error('DOCX слишком велик после распаковки.');return f.name==='word/document.xml';}});
    if(!files['word/document.xml'])throw new Error('Не найден текст DOCX.');
    return xmlText(new TextDecoder('utf-8',{fatal:true}).decode(files['word/document.xml']));
  }
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading=getDocument({data:bytes,disableFontFace:true,useSystemFonts:false,verbosity:0});
  try{
    const pdf=await loading.promise;
    if(pdf.numPages>100)throw new Error('PDF должен содержать не более 100 страниц.');
    let text='',hasText=false;
    for(let i=1;i<=pdf.numPages;i++){
      const page=await pdf.getPage(i);const content=await page.getTextContent();
      const pageText=content.items.map(item=>'str' in item?item.str+('hasEOL' in item&&item.hasEOL?'\n':' '):'').join('');
      hasText ||= !!pageText.trim();text+='\n\n[Страница '+i+']\n'+pageText;page.cleanup();
      if(text.length>max)throw new Error('В документе больше 80 000 символов. Разделите его на части.');
    }
    if(!hasText)throw new Error('В PDF нет текстового слоя. Для сканов пока нужен отдельный OCR.');
    return text;
  }finally{await loading.destroy();}
}
extract().then(text=>{if(!text.trim()||text.length>max)throw new Error('Не удалось извлечь текст. Для сканов пока нужен отдельный OCR.');parentPort?.postMessage({text});}).catch(e=>parentPort?.postMessage({error:e instanceof Error?e.message:'Не удалось прочитать документ.'}));
