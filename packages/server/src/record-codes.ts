import { randomBytes } from 'node:crypto';
import { getSearchIndex, sanitizeFileName, type Vault } from '@relay/core';

export const recordCode = (title: string): string | null => / #([A-Z0-9]{4,8})$/.exec(title)?.[1] ?? null;
export function codedTitle(title: string, code: string): string {
  return title.replace(/ #[A-Z0-9]{4,8}$/, '').trim().slice(0, 190) + ' #' + code;
}
export function recordFileName(title: string): string {
  const code = recordCode(title), base = sanitizeFileName(title.replace(/ #[A-Z0-9]{4,8}$/, ''));
  return code ? base.slice(0, 120 - code.length - 3).trimEnd() + ' - ' + code : base;
}
export async function allocateRecordTitle(vault: Vault, title: string, reserved = new Set<string>()): Promise<string> {
  const used = new Set<string>(reserved);
  for (const { parsed, meta } of await getSearchIndex(vault).documents(true)) {
    const code = recordCode(parsed.title);
    if (code) used.add(code);
    const fromFile = /(?: #| - )([A-Z0-9]{4,8})\.md$/i.exec(meta.path)?.[1];
    if (fromFile) used.add(fromFile.toUpperCase());
  }
  const alphabet = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let attempt = 0; ; attempt++) {
    const bytes = randomBytes(attempt < 64 ? 4 : 8);
    const code = [...bytes].map(byte => alphabet[byte % alphabet.length]).join('');
    if (!used.has(code)) { reserved.add(code); return codedTitle(title, code); }
  }
}
