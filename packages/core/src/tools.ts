import type { ToolDefinition } from './types.js';
import type { Vault } from './vault.js';
import { VaultError } from './vault.js';
import { searchNotes } from './search.js';
import { appendToDaily, createNote, dailyPath, ensureDaily, extractTasks } from './notes.js';
import { cleanForDisplay, formatDate } from './templates.js';

export interface ToolContext {
  vault: Vault;
  /** Called when the tool changes the vault. */
  onAction?: (kind: 'created' | 'appended' | 'updated', path: string) => void;
  onSource?: (path: string) => void;
}

export const toolDefinitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description:
        'Search the vault by keywords. Returns best-matching notes with snippets. Use for any question about what the user wrote.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords (2-6 words work best)' },
          folder: { type: 'string', description: 'Optional folder to restrict search, e.g. "Areas"' },
          days: { type: 'number', description: 'Optional: only notes modified in the last N days' },
          limit: { type: 'number', description: 'Max results (default 8)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_note',
      description: 'Read the full content of a note by its path or title.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault-relative path (e.g. "Projects/Site.md") or note title' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_folder',
      description: 'List sub-folders and notes in a folder. Use "" for vault root.',
      parameters: {
        type: 'object',
        properties: { folder: { type: 'string' } },
        required: ['folder'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recent_notes',
      description: 'List recently modified notes (newest first).',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Look back N days (default 7)' },
          limit: { type: 'number', description: 'Max results (default 15)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_daily',
      description: 'Read the daily note for a date (default today). Returns empty if missing.',
      parameters: {
        type: 'object',
        properties: { date: { type: 'string', description: 'YYYY-MM-DD, or omit for today' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_daily',
      description: "Append a line to today's daily note (creates it if needed).",
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          as_task: { type: 'boolean', description: 'Write as a checkbox task "- [ ] ..."' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_note',
      description:
        'Create a new note. Use for captured thoughts, ideas, links, quotes, people, meetings. Defaults to the inbox folder.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short, descriptive title (no extension)' },
          content: { type: 'string', description: 'Markdown body' },
          folder: { type: 'string', description: 'Optional vault-relative folder' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_note',
      description: 'Append text to an existing note, optionally under a heading.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          text: { type: 'string' },
          section: { type: 'string', description: 'Heading line such as "## Log"' },
        },
        required: ['path', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'Collect checkbox tasks from the daily notes of the last N days and from the inbox.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'default 7' },
          open_only: { type: 'boolean', description: 'default true' },
        },
      },
    },
  },
];

type Args = Record<string, unknown>;

const MAX_NOTE_CHARS = 12_000;

export async function executeTool(name: string, args: Args, ctx: ToolContext): Promise<string> {
  const { vault } = ctx;
  try {
    switch (name) {
      case 'search_notes': {
        const query = String(args.query ?? '');
        const days = typeof args.days === 'number' ? args.days : undefined;
        const hits = await searchNotes(vault, query, {
          folder: typeof args.folder === 'string' ? args.folder : undefined,
          limit: typeof args.limit === 'number' ? args.limit : 8,
          since: days ? Date.now() - days * 86_400_000 : undefined,
        });
        if (!hits.length) return 'No notes found.';
        hits.forEach((h) => ctx.onSource?.(h.path));
        return hits
          .map((h) => `- ${h.path} (modified ${formatDate(new Date(h.mtime), 'YYYY-MM-DD')})\n  ${h.snippet}`)
          .join('\n');
      }
      case 'read_note': {
        const p = String(args.path ?? '');
        let note;
        try {
          note = await vault.readNote(p);
        } catch (e) {
          if (!(e instanceof VaultError) || e.code !== 'NOT_FOUND') throw e;
          const found = await vault.findByTitle(p);
          if (found.length === 0) return `Note not found: ${p}`;
          if (found.length > 1) {
            return `Several notes match "${p}":\n${found.slice(0, 10).map((f) => `- ${f.path}`).join('\n')}\nAsk the user which one, or read the most likely.`;
          }
          note = await vault.readNote(found[0].path);
        }
        ctx.onSource?.(note.path);
        const text = cleanForDisplay(note.content);
        const truncated = text.length > MAX_NOTE_CHARS ? text.slice(0, MAX_NOTE_CHARS) + '\n…[truncated]' : text;
        return `# ${note.path}\n\n${truncated}`;
      }
      case 'list_folder': {
        const { folders, notes } = await vault.listFolder(String(args.folder ?? ''));
        return [
          ...folders.map((f) => `📁 ${f}`),
          ...notes.map((n) => `📄 ${n}`),
        ].join('\n') || '(empty)';
      }
      case 'recent_notes': {
        const days = typeof args.days === 'number' ? args.days : 7;
        const limit = typeof args.limit === 'number' ? args.limit : 15;
        const since = Date.now() - days * 86_400_000;
        const all = (await vault.listNotes()).filter((n) => n.mtime >= since).sort((a, b) => b.mtime - a.mtime);
        if (!all.length) return 'No notes modified in that period.';
        return all
          .slice(0, limit)
          .map((n) => `- ${n.path} (${formatDate(new Date(n.mtime), 'YYYY-MM-DD HH:mm')})`)
          .join('\n');
      }
      case 'read_daily': {
        const date = parseDate(args.date);
        const p = dailyPath(vault, date);
        if (!(await vault.exists(p))) return `Daily note ${p} does not exist yet.`;
        const note = await vault.readNote(p);
        ctx.onSource?.(p);
        return `# ${p}\n\n${cleanForDisplay(note.content)}`;
      }
      case 'append_daily': {
        const p = await appendToDaily(vault, String(args.text ?? ''), { asTask: Boolean(args.as_task) });
        ctx.onAction?.('appended', p);
        return `Appended to ${p}`;
      }
      case 'create_note': {
        const p = await createNote(vault, {
          title: String(args.title ?? 'Untitled'),
          content: String(args.content ?? ''),
          folder: typeof args.folder === 'string' && args.folder ? args.folder : undefined,
          tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
        });
        ctx.onAction?.('created', p);
        return `Created ${p}`;
      }
      case 'append_note': {
        const p = String(args.path ?? '');
        let target = p;
        if (!(await vault.exists(target))) {
          const found = await vault.findByTitle(p);
          if (found.length !== 1) return found.length ? `Ambiguous note "${p}"` : `Note not found: ${p}`;
          target = found[0].path;
        }
        await vault.appendToNote(target, String(args.text ?? ''), typeof args.section === 'string' ? args.section : undefined);
        ctx.onAction?.('appended', target);
        return `Appended to ${target}`;
      }
      case 'list_tasks': {
        const days = typeof args.days === 'number' ? args.days : 7;
        const openOnly = args.open_only !== false;
        const lines: string[] = [];
        for (let i = 0; i < days; i++) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const p = dailyPath(vault, d);
          if (!(await vault.exists(p))) continue;
          const note = await vault.readNote(p);
          const tasks = extractTasks(note.content, { openOnly });
          if (tasks.length) {
            ctx.onSource?.(p);
            lines.push(`## ${p}`, ...tasks.map((t) => `- ${t}`));
          }
        }
        const inbox = vault.config.inboxFolder;
        if (inbox && (await vault.exists(inbox))) {
          for (const n of await vault.listNotes(inbox)) {
            const note = await vault.readNote(n.path);
            const tasks = extractTasks(note.content, { openOnly });
            if (tasks.length) {
              ctx.onSource?.(n.path);
              lines.push(`## ${n.path}`, ...tasks.map((t) => `- ${t}`));
            }
          }
        }
        return lines.length ? lines.join('\n') : 'No tasks found.';
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    if (e instanceof VaultError) return `Error (${e.code}): ${e.message}`;
    return `Error: ${(e as Error).message}`;
  }
}

function parseDate(v: unknown): Date {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date();
}

export { ensureDaily };
