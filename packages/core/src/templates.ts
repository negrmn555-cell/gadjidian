/** Minimal date formatting compatible with the Obsidian "Daily notes" format subset. */
export function formatDate(d: Date, fmt: string): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const tokens: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    YY: String(d.getFullYear()).slice(-2),
    MM: pad(d.getMonth() + 1),
    M: String(d.getMonth() + 1),
    DD: pad(d.getDate()),
    D: String(d.getDate()),
    HH: pad(d.getHours()),
    H: String(d.getHours()),
    mm: pad(d.getMinutes()),
    m: String(d.getMinutes()),
    ss: pad(d.getSeconds()),
    dddd: d.toLocaleDateString('ru-RU', { weekday: 'long' }),
    ddd: d.toLocaleDateString('ru-RU', { weekday: 'short' }),
    MMMM: d.toLocaleDateString('ru-RU', { month: 'long' }),
    MMM: d.toLocaleDateString('ru-RU', { month: 'short' }),
  };
  // longest tokens first
  const re = /YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|mm|m|ss|\[[^\]]*\]/g;
  return fmt.replace(re, (t) => {
    if (t.startsWith('[')) return t.slice(1, -1);
    return tokens[t] ?? t;
  });
}

export interface TemplateVars {
  title?: string;
  date?: Date;
  content?: string;
  [key: string]: unknown;
}

/**
 * Render a template. Supports:
 *  {{title}}, {{content}}, {{date}}, {{time}}, {{date:FORMAT}}, {{time:FORMAT}}
 *  (Obsidian core Templates syntax) plus any custom {{key}}.
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  const date = vars.date ?? new Date();
  return template.replace(/\{\{\s*([a-zA-Z_]+)(?::([^}]+))?\s*\}\}/g, (_m, key: string, fmt?: string) => {
    switch (key) {
      case 'date':
        return formatDate(date, fmt ?? 'YYYY-MM-DD');
      case 'time':
        return formatDate(date, fmt ?? 'HH:mm');
      case 'title':
        return vars.title ?? '';
      case 'content':
        return vars.content ?? '';
      default: {
        const v = vars[key];
        return v === undefined || v === null ? '' : String(v);
      }
    }
  });
}

/** Extract YAML frontmatter block (raw) and body. */
export function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return { frontmatter: null, body: content };
  return { frontmatter: m[1], body: content.slice(m[0].length) };
}

/** Strip frontmatter and template placeholders left in a note before showing it to the user. */
export function cleanForDisplay(content: string): string {
  const { body } = splitFrontmatter(content);
  return body
    .split('\n')
    .filter((l) => !/^\s*<%.*%>\s*$/.test(l) && !/^\s*\{\{.*\}\}\s*$/.test(l))
    .join('\n')
    .trim();
}
