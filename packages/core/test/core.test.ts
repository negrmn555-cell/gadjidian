import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault, VaultError, insertIntoSection, normalizeRel, sanitizeFileName } from '../src/vault.js';
import { searchNotes } from '../src/search.js';
import { appendToDaily, createNote, dailyPath, extractTasks } from '../src/notes.js';
import { formatDate, renderTemplate, cleanForDisplay } from '../src/templates.js';
import { parseSlash } from '../src/commands.js';

async function makeVault(): Promise<Vault> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-vault-'));
  await fs.mkdir(path.join(root, 'Inbox'), { recursive: true });
  await fs.mkdir(path.join(root, 'Daily'), { recursive: true });
  await fs.mkdir(path.join(root, 'Private'), { recursive: true });
  await fs.mkdir(path.join(root, '.obsidian'), { recursive: true });
  await fs.writeFile(path.join(root, 'Areas.md'), '# Areas\n\nБизнес-идеи: сервис для заметок.\n');
  await fs.writeFile(path.join(root, 'Inbox', 'Идея про подкаст.md'), '# Идея про подкаст\n\nЗаписать подкаст про Obsidian.\n');
  await fs.writeFile(path.join(root, 'Private', 'Дневник.md'), 'секрет\n');
  await fs.writeFile(path.join(root, '.obsidian', 'app.json'), '{}');
  return new Vault({
    root,
    inboxFolder: 'Inbox',
    dailyFolder: 'Daily',
    dailyFormat: 'YYYY-MM-DD',
    dailySection: '## Заметки',
    privateFolders: ['Private'],
  });
}

test('normalizeRel & sanitizeFileName', () => {
  assert.equal(normalizeRel('./a\\b/../c.md'), 'a/c.md');
  assert.equal(normalizeRel('/x/y'), 'x/y');
  assert.equal(sanitizeFileName('a/b:c*d?"<>|#^[]'), 'a b c d');
});

test('vault blocks traversal and private folders', async () => {
  const v = await makeVault();
  assert.throws(() => v.resolve('../etc/passwd'), VaultError);
  assert.throws(() => v.resolve('Private/Дневник.md'), VaultError);
  await assert.rejects(v.readNote('Private/Дневник'), /private/);
  const notes = await v.listNotes();
  assert.ok(notes.every((n) => !n.path.startsWith('Private/')));
  assert.ok(notes.some((n) => n.path === 'Areas.md'));
});

test('insertIntoSection', () => {
  const src = '# T\n\n## Заметки\n- a\n\n## Задачи\n- [ ] x\n';
  const out = insertIntoSection(src, '- b', '## Заметки');
  assert.equal(out, '# T\n\n## Заметки\n- a\n- b\n\n## Задачи\n- [ ] x\n');
  const missing = insertIntoSection('# T\n', '- b', '## Лог');
  assert.equal(missing, '# T\n\n## Лог\n- b\n');
  assert.equal(insertIntoSection('', 'x'), 'x\n');
});

test('daily append creates note with section', async () => {
  const v = await makeVault();
  const p = await appendToDaily(v, 'мысль', { withTime: false });
  assert.equal(p, dailyPath(v));
  const note = await v.readNote(p);
  assert.match(note.content, /## Заметки\n- мысль\n/);
  await appendToDaily(v, 'задача', { asTask: true });
  const again = await v.readNote(p);
  assert.match(again.content, /- \[ \] задача/);
  assert.deepEqual(extractTasks(again.content, { openOnly: true }), ['[ ] задача']);
});

test('createNote goes to inbox and avoids duplicates', async () => {
  const v = await makeVault();
  const p1 = await createNote(v, { title: 'Тест', content: 'раз', tags: ['idea'] });
  const p2 = await createNote(v, { title: 'Тест', content: 'два' });
  assert.equal(p1, 'Inbox/Тест.md');
  assert.equal(p2, 'Inbox/Тест 1.md');
  const n = await v.readNote(p1);
  assert.match(n.content, /#idea/);
  await assert.rejects(createNote(v, { title: 'x', content: 'y', folder: 'Private' }), /private/i);
});

test('search finds by stem and title', async () => {
  const v = await makeVault();
  const hits = await searchNotes(v, 'бизнес идеи');
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].path, 'Areas.md');
  const byTitle = await searchNotes(v, 'подкаст');
  assert.equal(byTitle[0].path, 'Inbox/Идея про подкаст.md');
  const none = await searchNotes(v, 'секрет');
  assert.equal(none.length, 0);
});

test('templates', () => {
  const d = new Date(2026, 8, 15, 9, 5);
  assert.equal(formatDate(d, 'YYYY-MM-DD HH:mm'), '2026-09-15 09:05');
  assert.equal(renderTemplate('# {{title}}\n{{date:DD.MM.YYYY}} {{content}}', { title: 'A', content: 'B', date: d }), '# A\n15.09.2026 B');
  assert.equal(cleanForDisplay('---\na: 1\n---\n# Hi\n{{date}}\ntext\n'), '# Hi\ntext');
});

test('parseSlash', () => {
  const p = parseSlash('/daily купить молоко');
  assert.equal(p?.command.name, 'daily');
  assert.equal(p?.arg, 'купить молоко');
  assert.equal(parseSlash('просто текст'), null);
  assert.equal(parseSlash('/nope x'), null);
});
