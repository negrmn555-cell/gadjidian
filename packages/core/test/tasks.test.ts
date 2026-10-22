import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, validateTaskCreate, validateDeadline, localDateTimeToInstant, isTaskOverdue, validateTaskPatch } from '../src/contracts.js';
import { createTaskDocument, readTaskDocument, updateTaskDocument } from '../src/task-document.js';

const input = {
  title: 'Подготовить отчёт', description: 'Исходный текст\n\n## Раздел\nСсылка [[Другой файл#Заголовок]].\n',
  category: 'work' as const, priority: 'high' as const,
  deadline: { kind: 'by_date' as const, date: '2026-10-05', timezone: 'Europe/Moscow' },
  keywords: ['отчёт'], tags: ['custom'], relatedNoteIds: [],
};
const id = 'task_' + 'a'.repeat(32);

test('task validation rejects missing/invalid deadlines and unsupported enums', () => {
  for (const deadline of [undefined, { kind: 'by_date', date: '2026-02-30', timezone: 'Europe/Moscow' }, { kind: 'by_date', date: '2026-10-05', timezone: 'Bad/Zone' }, { kind: 'by_time', at: '2026-10-05T24:00:00Z', timezone: 'UTC' }]) {
    assert.throws(() => validateTaskCreate({ ...input, deadline }), DomainError);
  }
  assert.throws(() => validateTaskCreate({ ...input, priority: 'urgent' }), DomainError);
  assert.throws(() => validateTaskPatch({ completedAt: '2026-10-05' }), DomainError);
  assert.throws(() => validateDeadline({ ...input.deadline, at: '2026-10-05T10:00:00Z' }), DomainError);
});

test('timezone conversion is independent from host timezone and rejects DST gaps/folds', () => {
  assert.equal(localDateTimeToInstant('2026-10-05', '00:15', 'Europe/Moscow'), '2026-10-04T21:15:00.000Z');
  assert.equal(localDateTimeToInstant('2026-10-05', '09:00', 'Asia/Kathmandu'), '2026-10-05T03:15:00.000Z');
  assert.throws(() => localDateTimeToInstant('2026-03-08', '02:30', 'America/New_York'), /нет/);
  assert.throws(() => localDateTimeToInstant('2026-11-01', '01:30', 'America/New_York'), /дважды/);
});

test('date-only overdue begins at the next local day, completed tasks are never overdue', () => {
  const task = { deadline: input.deadline, status: 'todo' as const };
  assert.equal(isTaskOverdue(task, new Date('2026-10-05T20:59:59Z')), false);
  assert.equal(isTaskOverdue(task, new Date('2026-10-05T21:00:00Z')), true);
  assert.equal(isTaskOverdue({ ...task, status: 'done' }, new Date('2026-10-06T21:00:00Z')), false);
});

test('task document preserves body, unknown properties and YAML comments on status change', () => {
  const original = createTaskDocument(input, id, '2026-10-02T09:00:00Z').replace('type: task', 'custom_setting: value # keep this\naliases: [Отчёт]\ntype: task');
  const updated = updateTaskDocument(original, 'Areas/Work/Tasks/a.md', { status: 'done' }, '2026-10-03T09:00:00Z');
  assert.match(updated, /custom_setting: value # keep this/);
  assert.match(updated, /aliases:/);
  const task = readTaskDocument(updated, 'Areas/Work/Tasks/a.md')!;
  assert.equal(task.description, input.description);
  assert.equal(task.completedAt, '2026-10-03T09:00:00.000Z');
  assert.deepEqual(task.tags, ['custom', 'area/work', 'priority/high']);
  const reopened = readTaskDocument(updateTaskDocument(updated, task.path, { status: 'todo' }, '2026-10-04T09:00:00Z'), task.path)!;
  assert.equal(reopened.completedAt, null);
});

test('switching deadline kinds removes old metadata and malformed managed tasks are rejected', () => {
  const created = createTaskDocument(input, id, '2026-10-02T09:00:00Z');
  const updated = updateTaskDocument(created, 'task.md', { deadline: { kind: 'by_time', at: '2026-10-05T17:00:00+03:00', timezone: 'Europe/Moscow' } }, '2026-10-02T10:00:00Z');
  assert.doesNotMatch(updated, /deadline_date:/);
  assert.equal(readTaskDocument(updated, 'task.md')!.deadline.kind, 'by_time');
  assert.throws(() => readTaskDocument(created.replace('status: todo', 'status: done'), 'task.md'), /не согласованы/);
  assert.throws(() => readTaskDocument(created.replace('deadline_date: 2026-10-05', 'deadline_date: impossible'), 'task.md'), DomainError);
});

test('series metadata survives document updates and rejects malformed or externally patched membership',()=>{
  const series={id:'series_'+'b'.repeat(32),index:2,anchor:input.deadline,recurrence:{frequency:'weekly' as const,interval:1,weekdays:[1,3]}};
  const content=createTaskDocument({...input,series},id,'2026-10-02T09:00:00Z');
  assert.deepEqual(readTaskDocument(content,'task.md')!.series,series);
  assert.deepEqual(readTaskDocument(updateTaskDocument(content,'task.md',{status:'done'},'2026-10-03T09:00:00Z'),'task.md')!.series,series);
  assert.throws(()=>validateTaskPatch({series}),/Недопустимое/);
  for(const invalid of [{...series,id:'unknown'},{...series,index:-1},{...series,recurrence:{frequency:'daily',interval:1,weekdays:[1]}},{...series,recurrence:{frequency:'weekly',interval:0}}])assert.throws(()=>validateTaskCreate({...input,series:invalid}),DomainError);
});
