export const PREFERENCES_PATH = 'System/Assistant/preferences.md';
export const PREFERENCES_MAX_BYTES = 16_384;
export interface PreferenceFields { communication: string; organization: string; rules: string }
export interface PreferenceMemory { path: string; status: 'ready'|'missing'|'invalid'|'unavailable'; hash: string|null; fields: PreferenceFields; warning?: string }
export const emptyPreferences = (): PreferenceFields => ({communication:'',organization:'',rules:''});
export function isPreferencesPath(value:string):boolean {
  const parts:string[]=[];for(const p of value.replace(/\\/g,'/').split('/')){if(p==='..')parts.pop();else if(p&&p!=='.')parts.push(p);}
  return parts.join('/').toLowerCase()===PREFERENCES_PATH.toLowerCase();
}
