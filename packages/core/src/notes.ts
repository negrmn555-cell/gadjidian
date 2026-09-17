import { formatDate, renderTemplate } from './templates.js';
import { Vault, VaultError, sanitizeFileName } from './vault.js';

export interface DailyOptions {
  date?: Date;
}

/** Vault-relative path of the daily note for a date. */
export function dailyPath(vault: Vault, date = new Date()): string {
  const name = formatDate(date, vault.config.dailyFormat || 'YYYY-MM-DD');
  const folder = vault.config.dailyFolder?.replace(/\/+$/, '') ?? '';
  return folder ? `${folder}/${name}.md` : `${name}.md`;
}

/** Ensure the daily note exists (creating from template if configured). Returns its path. */
export async function ensureDaily(vault: Vault, opts: DailyOptions = {}): Promise<{ path: string; created: boolean }> {
  const date = opts.date ?? new Date();
  const p = dailyPath(vault, date);
  if (await vault.exists(p)) return { path: p, created: false };
  let content = '';
  if (vault.config.dailyTemplate) {
    try {
      const tpl = await vault.readNote(vault.config.dailyTemplate);
      content = renderTemplate(tpl.content, { title: formatDate(date, vault.config.dailyFormat || 'YYYY-MM-DD'), date });
    } catch {
      content = '';
    }
  }
  if (!content && vault.config.dailySection) {
    content = `${vault.config.dailySection}\n`;
  }
  await vault.writeNote(p, content);
  return { path: p, created: true };
}

/** Append a line to today's daily note (with time prefix). */
export async function appendToDaily(
  vault: Vault,
  text: string,
  opts: DailyOptions & { withTime?: boolean; asTask?: boolean } = {},
): Promise<string> {
  const date = opts.date ?? new Date();
  const { path } = await ensureDaily(vault, { date });
  const now = new Date();
  const prefix = opts.withTime === false ? '' : `**${formatDate(now, 'HH:mm')}** `;
  const line = opts.asTask ? `- [ ] ${text.trim()}` : `- ${prefix}${text.trim()}`;
  await vault.appendToNote(path, line, vault.config.dailySection || undefined);
  return path;
}

export interface CreateNoteInput {
  title: string;
  content: string;
  /** Vault-relative folder. Default: inbox. */
  folder?: string;
  tags?: string[];
  /** Use note template from config. Default true. */
  useTemplate?: boolean;
}

/** Create a new note in the inbox (or given folder), applying the template if any. */
export async function createNote(vault: Vault, input: CreateNoteInput): Promise<string> {
  const folder = (input.folder ?? vault.config.inboxFolder ?? '').replace(/\/+$/, '');
  if (vault.isPrivate(folder)) throw new VaultError('Folder is private', 'FORBIDDEN');
  const title = sanitizeFileName(input.title);
  const rel = folder ? `${folder}/${title}.md` : `${title}.md`;
  let body = input.content.trim();
  if (input.tags?.length) {
    const tagLine = input.tags.map((t) => (t.startsWith('#') ? t : `#${t.replace(/\s+/g, '-')}`)).join(' ');
    body = `${body}\n\n${tagLine}`;
  }
  let content = '';
  if (input.useTemplate !== false && vault.config.noteTemplate) {
    try {
      const tpl = await vault.readNote(vault.config.noteTemplate);
      content = renderTemplate(tpl.content, { title, content: body });
      if (!tpl.content.includes('{{content}}')) content = `${content.replace(/\s+$/, '')}\n\n${body}\n`;
    } catch {
      content = '';
    }
  }
  if (!content) {
    const created = formatDate(new Date(), 'YYYY-MM-DD HH:mm');
    content = `---\ncreated: ${created}\nsource: mobile\n---\n# ${title}\n\n${body}\n`;
  }
  return vault.createUnique(rel, content);
}

/** Return today's open tasks from the daily note plus recent ones from the inbox. */
export function extractTasks(content: string, opts: { openOnly?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const line of content.split('\n')) {
    const m = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (!m) continue;
    const done = m[1] !== ' ';
    if (opts.openOnly && done) continue;
    out.push(`${done ? '[x]' : '[ ]'} ${m[2].trim()}`);
  }
  return out;
}
