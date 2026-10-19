import { stemmer } from '@orama/stemmers/russian';
import type { SearchHit } from './types.js';
import type { Vault } from './vault.js';
import { getSearchIndex } from './search-index.js';
import { measure } from './metrics.js';

export function normalizeText(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
const STOP = new Set(['и', 'в', 'на', 'с', 'о', 'об', 'по', 'из', 'за', 'к', 'у', 'не', 'что', 'как', 'для', 'это', 'а', 'но', 'я', 'мы', 'ты', 'the', 'a', 'an', 'of', 'in', 'on', 'to', 'for', 'is', 'are', 'and', 'or', 'my', 'найди', 'покажи', 'find', 'show', 'search']);
export function tokenize(q: string): string[] { return normalizeText(q).split(' ').filter(t => t.length >= 2 && !STOP.has(t)); }
export function stem(token: string): string { return /[а-яё]/i.test(token) ? stemmer(token) : token.replace(/(ing|ed|es|s)$/, ''); }
export interface SearchOptions { limit?: number; folder?: string; since?: number; kind?: string; tags?: string[] }
export async function searchNotes(vault: Vault, query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  return measure('search',()=>getSearchIndex(vault).query(query, opts));
}
