/** Check dimensions before the native decoder allocates an image surface. */
export function assertImageDimensions(b:Buffer):void {
  let width=0,height=0;
  if(b.length>=24 && b.toString('ascii',1,4)==='PNG'){width=b.readUInt32BE(16);height=b.readUInt32BE(20);}
  else if(b[0]===255&&b[1]===216){
    let p=2;while(p+3<b.length){if(b[p++]!==255)continue;let marker=b[p++];while(marker===255&&p<b.length)marker=b[p++];if(marker===0||marker===216||marker>=208&&marker<=215)continue;if(marker===217||marker===218)break;const size=b.readUInt16BE(p);if(size<2||p+size>b.length)break;if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&size>=7){height=b.readUInt16BE(p+3);width=b.readUInt16BE(p+5);break;}p+=size;}
  }else if(b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP'){
    const kind=b.toString('ascii',12,16);if(kind==='VP8X'&&b.length>=30){if(b[20]&2)throw new Error('Анимированный WebP пока не поддерживается.');width=1+b.readUIntLE(24,3);height=1+b.readUIntLE(27,3);}
    else if(kind==='VP8 '&&b.length>=30){width=b.readUInt16LE(26)&0x3fff;height=b.readUInt16LE(28)&0x3fff;}
    else if(kind==='VP8L'&&b.length>=25){width=1+(b[21]|(b[22]&63)<<8);height=1+(b[22]>>6|b[23]<<2|(b[24]&15)<<10);}
  }
  if(!width||!height||width*height>16_000_000)throw new Error('Изображение должно содержать не более 16 млн пикселей и корректный заголовок.');
}
