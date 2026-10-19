import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault, searchNotes, disposeSearch, getSearchIndex, parseMarkdownDocument, parseFrontmatter, normalizeText } from '../src/index.js';

async function fixture(t: {after(fn:()=>Promise<void>):void}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-search-'));
  const vault=new Vault({root,inboxFolder:'Inbox',dailyFolder:'Daily',dailyFormat:'YYYY-MM-DD',privateFolders:['Private']});
  t.after(async()=>{disposeSearch(vault);assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith('relay-search-'));await fs.rm(root,{recursive:true,force:true});});return vault;
}

test('Markdown chunks preserve heading hierarchy, exact CRLF offsets, tables, math and fenced examples',()=>{
  const content='---\r\ntitle: Экономика\r\ncustom: keep # comment\r\n---\r\n# Курс\r\n## Цены\r\nТекст [[Инфляция#Причины|ссылка]].\r\n\r\n```md\r\n# Это код\r\n[[Не ссылка]]\r\n```\r\n\r\n| A | B |\r\n| - | - |\r\n| 1 | 2 |\r\n\r\n$$\r\nx=1\r\n$$\r\n### Причины\r\nФакторы. ^block\r\n';
  const parsed=parseMarkdownDocument('Course.md',content,75);
  assert.equal(parsed.title,'Экономика');assert.equal(parsed.metadata.custom,'keep');
  assert.equal(parsed.links.length,1);assert.equal(parsed.links[0].raw,'[[Инфляция#Причины|ссылка]]');
  assert(parsed.chunks.some(c=>c.headingPath.join('/')==='Курс/Цены/Причины'));
  assert(!parsed.chunks.some(c=>c.headingPath.includes('Это код')));
  for(const chunk of parsed.chunks)assert.equal(content.slice(chunk.start,chunk.end),chunk.text);
  assert(parsed.chunks.some(c=>c.text.includes('```md')&&c.text.includes('```',5)));
  assert(parsed.chunks.some(c=>c.text.includes('| A | B |')&&c.text.includes('| 1 | 2 |')));
  assert.match(parseFrontmatter(content).doc.toString(),/custom: keep # comment/);
});

test('invalid metadata remains readable but is marked and cannot be parsed for mutation',()=>{
  const content='---\ntitle: A\ntitle: B\n---\n# Материал\nФакты';
  const parsed=parseMarkdownDocument('Broken.md',content);assert(parsed.metadataError);assert.match(parsed.body,/Факты/);assert.throws(()=>parseFrontmatter(content));
});

test('Russian stemming, aliases, exact paths and filters share the same search index',async t=>{
  const v=await fixture(t);
  await v.writeNote('Study/Инфляция.md','---\naliases: [рост цен]\ntags: [экономика]\n---\n# Инфляция\n## Причины\nИзменение стоимости товаров.');
  await v.writeNote('Work/Инфляция.md','---\ntype: idea\ntags: [работа]\n---\n# Инфляция\nРабочий документ.');
  assert.equal((await searchNotes(v,'инфляцией',{folder:'Study'}))[0].path,'Study/Инфляция.md');
  assert.equal((await searchNotes(v,'рост цен'))[0].path,'Study/Инфляция.md');
  assert.equal((await searchNotes(v,'Study/Инфляция.md'))[0].path,'Study/Инфляция.md');
  assert.equal((await searchNotes(v,'инфляция',{kind:'idea',tags:['работа']}))[0].path,'Work/Инфляция.md');
  assert.equal((await searchNotes(v,'инфляция',{since:Date.now()+10000})).length,0);
  assert.equal(normalizeText('Йод и ёж'),'йод и еж');
  assert.equal((await searchNotes(v,'инфляция')).filter(h=>h.path==='Study/Инфляция.md').length,1);
});

test('warm queries read no contents; updates replace one document without mutating its source',async t=>{
  const v=await fixture(t);for(let i=0;i<25;i++)await v.writeNote(`Archive/${i}.md`,`# Наблюдение ${i}\nПогода`);
  await v.writeNote('Target.md','# Уникальный заголовок\nИсходные данные');
  const read=v.readNote.bind(v);let reads=0;v.readNote=async p=>{reads++;return read(p);};
  await searchNotes(v,'Уникальный');reads=0;await searchNotes(v,'заголовок');await searchNotes(v,'Уникальный');assert.equal(reads,0);
  await v.writeNote('Target.md','# Уникальный заголовок\nОбновленные сведения',{overwrite:true});
  const hit=(await searchNotes(v,'Обновленные'))[0];assert.equal(hit.path,'Target.md');assert(reads<5);assert.match(hit.snippet,/Обновленные/);
  assert.equal((await read('Target.md')).content,'# Уникальный заголовок\nОбновленные сведения');
});

test('delete, rename and a changed access policy invalidate cached snippets',async t=>{
  const v=await fixture(t);await v.writeNote('A.md','# Секретный маркер');await searchNotes(v,'маркер');
  await fs.unlink(v.resolve('A.md'));assert.equal((await searchNotes(v,'маркер')).length,0);
  await v.writeNote('Visible/B.md','# Другой маркер');await searchNotes(v,'Другой');
  v.config.privateFolders.push('Visible');assert.equal((await searchNotes(v,'Другой')).length,0);
  v.config.privateFolders=[];await fs.rename(v.resolve('Visible/B.md'),v.resolve('C.md'));v.notifyChanged(['Visible/B.md','C.md']);
  assert.equal((await searchNotes(v,'Другой'))[0].path,'C.md');
  const parsed=(await getSearchIndex(v).documents()).find(d=>d.meta.path==='C.md')!.parsed;assert.equal(parsed.noteId,null);
});
