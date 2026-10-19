import { createRequire } from 'node:module';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
const require=createRequire(import.meta.url);
process.once('message',async(input:{bytes:Uint8Array;pages:number[];format:'pdf'|'images'})=>{
  let dispose:(()=>Promise<void>)|undefined;
  try{
    const bytes=new Uint8Array(input.bytes);if(bytes.length>5*1024*1024||input.pages.length>3)throw new Error('Превышен размер пакета PDF.');
    if(input.format==='pdf'){
      const source=await PDFDocument.load(bytes,{updateMetadata:false});if(source.getPageCount()>100)throw new Error('PDF должен содержать до 100 страниц.');
      if(input.pages.some(p=>!Number.isInteger(p)||p<1||p>source.getPageCount()))throw new Error('Страница отсутствует.');
      const result=await PDFDocument.create();for(const p of await result.copyPages(source,input.pages.map(n=>n-1)))result.addPage(p);
      const data=Buffer.from(await result.save());if(data.length>5*1024*1024)throw new Error('Пакет PDF превышает 5 МБ.');
      process.send?.({result:{pageCount:source.getPageCount(),pdf:data.toString('base64'),pages:input.pages}});
    }else{
      const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs'),root=path.dirname(require.resolve('pdfjs-dist/package.json'));
      const loading=getDocument({data:bytes,disableFontFace:true,useSystemFonts:false,verbosity:0,standardFontDataUrl:path.join(root,'standard_fonts').replaceAll('\\','/')+'/'});dispose=()=>loading.destroy();
      const pdf=await loading.promise;if(pdf.numPages>100)throw new Error('PDF должен содержать до 100 страниц.');
      const images:{number:number;data:string}[]=[];let total=0;
      for(const number of input.pages){
        if(!Number.isInteger(number)||number<1||number>pdf.numPages)throw new Error('Страница отсутствует.');
        const page=await pdf.getPage(number),raw=page.getViewport({scale:1});
        const scale=Math.min(1.5,Math.sqrt(4_000_000/(raw.width*raw.height))),viewport=page.getViewport({scale});
        const factory=pdf.canvasFactory as {create:(w:number,h:number)=>{canvas:any;context:any};destroy:(cc:any)=>void},cc=factory.create(Math.ceil(viewport.width),Math.ceil(viewport.height));
        try{await page.render({canvas:cc.canvas,canvasContext:cc.context,viewport}).promise;const data:Buffer=cc.canvas.toBuffer('image/jpeg',85);total+=data.length;if(total>5*1024*1024)throw new Error('Изображения пакета превышают 5 МБ.');images.push({number,data:data.toString('base64')});}finally{factory.destroy(cc);page.cleanup();}
      }
      process.send?.({result:{pageCount:pdf.numPages,images,pages:input.pages}});
    }
  }catch{process.send?.({error:'Не удалось подготовить PDF. Проверьте формат, страницы и отсутствие пароля.'});}
  finally{await dispose?.();process.disconnect();}
});
