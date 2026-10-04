import { parseDocument } from 'yaml';
import { DomainError, objectInput } from './contracts.js';

/** JSON.parse checks syntax; the YAML flow parser additionally rejects duplicate keys. */
export function parseModeJson(text: string | null): Record<string, unknown> {
  try {
    const raw=(text??'').trim();
    if (!raw.startsWith('{') || !raw.endsWith('}') || raw.length>100_000) throw new Error();
    const value=objectInput(JSON.parse(raw));
    if (parseDocument(raw,{uniqueKeys:true}).errors.length) throw new Error();
    return value;
  } catch { throw new DomainError('MODEL_OUTPUT_INVALID','ИИ вернул некорректный черновик. Ничего не записано. Повторите запрос.'); }
}
