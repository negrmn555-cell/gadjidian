import { createHash } from 'node:crypto';
import { parseDocument, Document } from 'yaml';
import { parseFrontmatter } from './frontmatter.js';
import { DomainError, validateTaskCreate, validateTaskStatus, validateTaskSeries, type Task, type TaskCreateInput, type TaskPatch, type TaskSeries } from './contracts.js';

export const hashContent = (content: string): string => createHash('sha256').update(content).digest('hex');
const ID = /^task_[a-f0-9]{32}$/;

function frontmatter(content: string) {
  const parsed = parseFrontmatter(content);
  return parsed.hasFrontmatter ? { doc: parsed.doc, body: parsed.body } : null;
}

export function readTaskDocument(content: string, path: string): Task | null {
  const fm = frontmatter(content);
  if (!fm || fm.doc.get('type') !== 'task') return null;
  const values = fm.doc.toJS() as Record<string, unknown>;
  if (values.relay_schema !== 1 || typeof values.relay_id !== 'string' || !ID.test(values.relay_id)) throw new DomainError('INVALID_METADATA', 'Неподдерживаемая схема или идентификатор задачи.');
  const base = validateTaskCreate({
    title: values.title, description: fm.body, category: values.category, priority: values.priority,
    deadline: values.deadline_kind === 'by_date'
      ? { kind: values.deadline_kind, date: values.deadline_date, timezone: values.deadline_timezone, ...(values.deadline_at !== undefined ? { at: values.deadline_at } : {}) }
      : { kind: values.deadline_kind, at: values.deadline_at, timezone: values.deadline_timezone, ...(values.deadline_date !== undefined ? { date: values.deadline_date } : {}) },
    keywords: values.keywords, tags: values.tags, relatedNoteIds: values.related_note_ids, series: values.task_series,
  });
  const status = validateTaskStatus(values.status);
  const createdAt = timestamp(values.created_at);
  const updatedAt = timestamp(values.updated_at);
  const completedAt = values.completed_at === null || values.completed_at === undefined ? null : timestamp(values.completed_at);
  if ((status === 'done') !== (completedAt !== null)) throw new DomainError('INVALID_METADATA', 'Статус и время завершения задачи не согласованы.');
  return { ...base, id: values.relay_id, status, createdAt, updatedAt, completedAt, path, contentHash: hashContent(content) };
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new DomainError('INVALID_METADATA', 'Некорректное время в метаданных.');
  return new Date(value).toISOString();
}

function setFields(doc: Document, task: TaskCreateInput, status: Task['status'], now: string, completedAt: string | null) {
  const managedTags = task.tags.filter(t => !t.startsWith('area/') && !t.startsWith('priority/'));
  const fields: Record<string, unknown> = {
    type: 'task', relay_schema: 1, title: task.title, category: task.category, priority: task.priority,
    status, updated_at: now, completed_at: completedAt, deadline_kind: task.deadline.kind,
    deadline_timezone: task.deadline.timezone, keywords: task.keywords,
    tags: [...new Set([...managedTags, 'area/' + task.category, 'priority/' + task.priority])],
    related_note_ids: task.relatedNoteIds,
  };
  for (const [key, value] of Object.entries(fields)) doc.set(key, value);
  if (task.series) doc.set('task_series', task.series);
  else doc.delete('task_series');
  if (task.deadline.kind === 'by_date') { doc.set('deadline_date', task.deadline.date); doc.delete('deadline_at'); }
  else { doc.set('deadline_at', task.deadline.at); doc.delete('deadline_date'); }
}

export function createTaskDocument(input: TaskCreateInput, id: string, now: string): string {
  if (!ID.test(id)) throw new DomainError('INVALID_METADATA', 'Некорректный идентификатор задачи.');
  const validated = validateTaskCreate(input);
  const doc = new Document();
  doc.set('relay_id', id);
  doc.set('created_at', now);
  setFields(doc, validated, 'todo', now, null);
  return '---\n' + doc.toString() + '---\n' + validated.description;
}

export function updateTaskDocument(content: string, path: string, patch: TaskPatch, now: string): string {
  const task = readTaskDocument(content, path);
  const fm = frontmatter(content);
  if (!task || !fm) throw new DomainError('NOT_FOUND', 'Задача не найдена.', 404);
  const merged = validateTaskCreate({ ...task, ...patch });
  const status = patch.status ?? task.status;
  setFields(fm.doc, merged, status, now, status === 'done' ? task.completedAt ?? now : null);
  return '---\n' + fm.doc.toString() + '---\n' + (patch.description ?? fm.body);
}

/** Series membership is managed by TaskService, never by generic note edits or task patches. */
export function setTaskSeriesDocument(content:string,path:string,series:TaskSeries,now:string):string {
  if(!readTaskDocument(content,path))throw new DomainError('NOT_FOUND','Задача не найдена.',404);
  const fm=frontmatter(content)!;
  fm.doc.set('task_series',validateTaskSeries(series));
  fm.doc.set('updated_at',now);
  return '---\n'+fm.doc.toString()+'---\n'+fm.body;
}
