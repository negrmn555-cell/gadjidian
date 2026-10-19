import { useEffect, useMemo, useRef, useState } from 'react';
import {
  categoryLabels, priorityLabels, statusLabels, priorityOrder, isTaskOverdue,
  localDateTimeToInstant, taskDeadlineSortKey, taskCalendarDate, calendarMonthDays,
  type Category, type Priority, type Task, type TaskCreateInput, type LegacyTask,
  type MutationReceipt
} from '@relay/core/contracts';
import { api, ApiError } from '../api';
import { Icon } from '../Icons';

interface Props { onSettings: () => void; onUnauthorized: () => void; addTaskSignal?: number }
type Scope = 'today' | 'upcoming' | 'all' | 'done';
type View = 'list' | 'calendar' | 'kanban';
const emptyForm = {
  title: '', description: '', category: 'personal' as Category, priority: 'medium' as Priority,
  kind: 'by_date' as 'by_date' | 'by_time' | 'at_time', date: '', time: '',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow',
  tags: '', keywords: ''
};
const split = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean);
const todayIn = (timezone: string) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const shortDeadline = (task: Task) => {
  const date = taskCalendarDate(task, task.deadline.timezone);
  const label = new Date(date + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  return task.deadline.kind === 'by_date'
    ? label
    : label + ' · ' + new Date(task.deadline.at).toLocaleTimeString('ru-RU', {
      timeZone: task.deadline.timezone, hour: '2-digit', minute: '2-digit'
    });
};
const fullDeadline = (task: Task) => task.deadline.kind === 'by_date'
  ? 'До ' + task.deadline.date + ' включительно · ' + task.deadline.timezone
  : (task.deadline.kind === 'by_time' ? 'До ' : 'В ') +
    new Date(task.deadline.at).toLocaleString('ru-RU', { timeZone: task.deadline.timezone }) +
    ' · ' + task.deadline.timezone;
function taskForm(task: Task) {
  const date = taskCalendarDate(task, task.deadline.timezone);
  const parts = task.deadline.kind === 'by_date' ? null : Object.fromEntries(
    new Intl.DateTimeFormat('en', { timeZone: task.deadline.timezone, hour: '2-digit',
      minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(task.deadline.at))
      .map(part => [part.type, part.value])
  );
  return {
    title: task.title, description: task.description || task.title.replace(/ #[A-Z0-9]{4,8}$/, ''), category: task.category,
    priority: task.priority, kind: task.deadline.kind, date,
    time: parts ? parts.hour + ':' + parts.minute : '', timezone: task.deadline.timezone,
    tags: task.tags.join(', '), keywords: task.keywords.join(', ')
  };
}

export function Tasks({ onUnauthorized, addTaskSignal }: Props) {
  const [items, setItems] = useState<Task[]>([]);
  const [invalid, setInvalid] = useState<{ path: string; error: string }[]>([]);
  const [legacy, setLegacy] = useState<LegacyTask[]>([]);
  const [showLegacy, setShowLegacy] = useState(false);
  const [source, setSource] = useState<LegacyTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<Task | null>(null);
  const [selected, setSelected] = useState<Task | null>(null);
  const [conflict, setConflict] = useState<Task | null>(null);
  const [receipt, setReceipt] = useState<MutationReceipt | null>(null);
  const [scope, setScope] = useState<Scope>('today');
  const [category, setCategory] = useState<'all' | Category>('all');
  const [filter, setFilter] = useState<'open' | 'done' | 'all'>('open');
  const [sort, setSort] = useState<'deadline' | 'priority' | 'created'>('deadline');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [view, setView] = useState<View>('list');
  const [timezone, setTimezone] = useState(emptyForm.timezone);
  const [selectedDate, setSelectedDate] = useState(todayIn(emptyForm.timezone));
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const requestRef = useRef<{ body: string; id: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const editorTrigger = useRef<HTMLElement | null>(null);
  const updates = useRef(new Map<string, string>());

  const report = (cause: unknown) => {
    setError((cause as Error).message);
    if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
  };
  const reload = async () => {
    setLoading(true);
    try {
      const page = await api.tasks();
      setItems(page.items);
      setInvalid(page.invalidRecords);
    } catch (cause) { report(cause); }
    finally { setLoading(false); }
  };
  useEffect(() => { void reload(); }, []);
  useEffect(() => { if (addTaskSignal) start(); }, [addTaskSignal]);
  useEffect(() => {
    if ((showForm || selected) && dialogRef.current && !dialogRef.current.open) {
      dialogRef.current.showModal();
    }
  }, [showForm, selected]);
  useEffect(() => {
    const content = contentRef.current;
    if (showForm || selected) content?.setAttribute('inert', '');
    else content?.removeAttribute('inert');
    return () => content?.removeAttribute('inert');
  }, [showForm, selected]);
  useEffect(() => {
    if (showForm) formRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  }, [showForm, editing?.id]);
  useEffect(() => {
    if (!showForm && !selected && !busy && editorTrigger.current) {
      editorTrigger.current.focus();
      editorTrigger.current = null;
    }
  }, [showForm, selected, busy]);
  useEffect(() => {
    if (!showForm && !selected) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        if (showForm && !confirm('Закрыть черновик без сохранения?')) return;
        setShowForm(false);
        setSelected(null);
      }
      if (event.key !== 'Tab' || !modalRef.current) return;
      const focusable = Array.from(modalRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)'
      )).filter(element => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first) { event.preventDefault(); modalRef.current.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [showForm, selected, busy]);

  let today: string;
  let days: string[] = [];
  let validZone = true;
  try { today = todayIn(timezone); days = calendarMonthDays(month); }
  catch { validZone = false; today = new Date().toISOString().slice(0, 10); }
  const calendarZone = validZone ? timezone : emptyForm.timezone;
  const visible = useMemo(() => items.filter(task => {
    if (category !== 'all' && task.category !== category) return false;
    if (scope === 'done') return task.status === 'done';
    if (filter === 'done' && task.status !== 'done') return false;
    if (filter === 'open' && (task.status === 'done' || task.status === 'cancelled')) return false;
    const date = taskCalendarDate(task, calendarZone);
    if (scope === 'today') return date <= today;
    if (scope === 'upcoming') return date >= today;
    return true;
  }).sort((left, right) => (
    sort === 'priority' ? priorityOrder[left.priority] - priorityOrder[right.priority]
      : sort === 'created' ? right.createdAt.localeCompare(left.createdAt)
        : taskDeadlineSortKey(left).localeCompare(taskDeadlineSortKey(right))
  ) || left.id.localeCompare(right.id)), [items, category, scope, filter, sort, calendarZone, today]);
  const overdue = visible.filter(task => isTaskOverdue(task));
  const regular = visible.filter(task => !isTaskOverdue(task));

  const start = (task?: Task, old?: LegacyTask) => {
    if (showForm && !confirm('Закрыть текущий черновик?')) return;
    if (!selected) editorTrigger.current = document.activeElement as HTMLElement;
    setSelected(null);
    setEditing(task ?? null);
    setSource(old ?? null);
    setConflict(null);
    setForm(task ? taskForm(task) : { ...emptyForm, title: old?.title ?? '', description: old?.title ?? '', date: view === 'calendar' ? selectedDate : todayIn(emptyForm.timezone) });
    setShowForm(true);
    requestRef.current = null;
    setError('');
  };
  const openDetails = (task: Task) => {
    editorTrigger.current = document.activeElement as HTMLElement;
    setSelected(task);
    setError('');
    window.setTimeout(() => modalRef.current?.querySelector<HTMLButtonElement>('button')?.focus(), 0);
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const task: TaskCreateInput = {
        title: form.description.split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 190) || form.title, description: form.description, category: form.category,
        priority: form.priority, deadline: form.kind === 'by_date'
          ? { kind: 'by_date', date: form.date, timezone: form.timezone }
          : { kind: form.kind, at: localDateTimeToInstant(form.date, form.time, form.timezone), timezone: form.timezone },
        tags: split(form.tags),
        keywords: split(form.keywords).length ? split(form.keywords)
          : [...new Set(form.title.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 8),
        relatedNoteIds: editing?.relatedNoteIds ?? []
      };
      const body = JSON.stringify({ task, source, editing: editing ? { id: editing.id, hash: editing.contentHash } : null });
      if (requestRef.current?.body !== body) requestRef.current = { body, id: crypto.randomUUID() };
      const operationId = requestRef.current.id;
      const result = editing ? await api.updateTask(editing.id, task, editing.contentHash, operationId)
        : source ? await api.convertLegacy(source, task, operationId) : await api.createTask(task, operationId);
      setReceipt(result.receipt);
      setForm(emptyForm);
      setShowForm(false);
      setEditing(null);
      setSource(null);
      setConflict(null);
      requestRef.current = null;
      await reload();
      if (showLegacy) setLegacy((await api.legacyTasks()).items);
    } catch (cause) {
      report(cause);
      if (editing && cause instanceof ApiError && cause.status === 409) {
        try { setConflict(await api.task(editing.id)); } catch { setConflict(null); }
      }
    } finally { setBusy(false); }
  };
  const changeStatus = async (task: Task, status: Task['status']) => {
    if (busy || status === task.status) return;
    setBusy(true);
    setError('');
    const key = task.id + ':' + task.contentHash + ':' + status;
    if (!updates.current.has(key)) updates.current.set(key, crypto.randomUUID());
    try {
      const result = await api.updateTask(task.id, { status }, task.contentHash, updates.current.get(key)!);
      setReceipt(result.receipt);
      updates.current.delete(key);
      setSelected(null);
      await reload();
    } catch (cause) {
      report(cause);
      if (cause instanceof ApiError && cause.status === 409) await reload();
    } finally { setBusy(false); }
  };
  const row = (task: Task) => <div className="task-row" key={task.id} data-od-id={'task-row-' + task.id}>
    <button className={'task-check ' + (task.status === 'done' ? 'is-done' : '')}
      aria-label={(task.status === 'done' ? 'Вернуть в работу: ' : 'Завершить: ') + task.title}
      disabled={busy} onClick={() => void changeStatus(task, task.status === 'done' ? 'todo' : 'done')} />
    <button className="task-row-main" onClick={() => openDetails(task)}><strong>{task.title}</strong><small>{categoryLabels[task.category]} · {statusLabels[task.status]}</small></button>
    <span className={'task-row-date ' + (isTaskOverdue(task) ? 'overdue' : '')}>{shortDeadline(task)}</span>
    <button className="task-row-more" aria-label={'Подробности: ' + task.title} onClick={() => openDetails(task)}><Icon name="chevron" /></button>
  </div>;
  const listSection = (label: string, tasks: Task[]) => tasks.length > 0 &&
    <section className="task-list-section"><h2>{label}<small>{tasks.length}</small></h2><div className="task-list">{tasks.map(row)}</div></section>;
  const calendarItems = items.filter(task => task.status !== 'done' && task.status !== 'cancelled');
  const changeMonth = (offset: number) => { const [year,number]=month.split('-').map(Number); const next=new Date(Date.UTC(year,number-1+offset,1)).toISOString().slice(0,7); setMonth(next); setSelectedDate(next+'-01'); };
  const heading = view === 'calendar' ? 'Календарь' : category !== 'all' ? categoryLabels[category]
    : { today: 'Сегодня', upcoming: 'Предстоящие', all: 'Все задачи', done: 'Завершённые' }[scope];

  return <div className="screen tasks-screen" data-od-id="tasks-screen" data-view={view}>
    <div className="tasks-content" ref={contentRef}>
      <div className="tasks-header"><div>{view !== 'calendar' && <p className="section-kicker">Планирование</p>}<h1 data-od-id="tasks-heading">{heading}</h1>{view !== 'calendar' && <p className="muted">{visible.length} задач</p>}</div><button className="btn" data-od-id="add-task" aria-label="Добавить задачу" disabled={busy} onClick={() => start()}><Icon name="plus" /><span>Добавить задачу</span></button></div>
      {error && <div className="error" role="alert">{error}</div>}
      {receipt && <div className="notice" role="status">{receipt.state === 'synced' ? 'Сохранено и отправлено в Git.' : receipt.state === 'committed' ? 'Сохранено в Git на сервере.' : 'Сохранено на сервере.'}</div>}
      <div className={'task-layout ' + (view === 'calendar' ? 'calendar-layout' : '')}>
        {view !== 'calendar' && <nav className="task-scopes" aria-label="Разделы задач">{(['today', 'upcoming', 'all', 'done'] as const).map(key => <button key={key} className={scope === key && category === 'all' ? 'active' : ''} aria-current={scope === key && category === 'all' ? 'page' : undefined} onClick={() => { setScope(key); setCategory('all'); setFilter(key === 'done' ? 'all' : 'open'); }}>{({ today: 'Сегодня', upcoming: 'Предстоящие', all: 'Все', done: 'Завершённые' })[key]}</button>)}<p>Категории</p>{(Object.entries(categoryLabels) as [Category, string][]).map(([key, label]) => <button key={key} className={category === key ? 'active' : ''} aria-current={category === key ? 'page' : undefined} onClick={() => { setScope('all'); setCategory(key); }}>{label}</button>)}</nav>}
        <div className="task-work">
          <div className="task-viewbar glass" data-od-id="task-toolbar"><div className="view-tabs" role="group" aria-label="Вид задач">{(['list', 'calendar', 'kanban'] as const).map((key, index) => <button key={key} aria-pressed={view === key} data-od-id={'view-' + key} onClick={() => setView(key)}>{['Список', 'Календарь', 'Канбан'][index]}</button>)}</div>{view !== 'calendar' && <button className={'btn secondary small task-filter-toggle' + (category !== 'all' || sort !== 'deadline' || filter !== 'open' ? ' has-filters' : '')} title="Фильтры и сортировка" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(value => !value)}><Icon name="filter" /><span className="filter-label">Фильтры{category !== 'all' || sort !== 'deadline' || filter !== 'open' ? ' · активны' : ''}</span></button>}</div>
          {filtersOpen && view !== 'calendar' && <div className="task-filters"><label>Статус<select className="field" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="open">Открытые</option><option value="done">Готовые</option><option value="all">Все</option></select></label><label>Категория<select className="field" value={category} onChange={event => setCategory(event.target.value as typeof category)}><option value="all">Все</option>{Object.entries(categoryLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>Сортировка<select className="field" value={sort} onChange={event => setSort(event.target.value as typeof sort)}><option value="deadline">По сроку</option><option value="priority">По приоритету</option><option value="created">Новые сначала</option></select></label><button className="btn secondary small" disabled={loading || busy} onClick={() => void reload()}>Обновить задачи</button></div>}
          {loading && <p className="muted" role="status">Обновляю задачи…</p>}
          {view === 'list' && <>{listSection('Просрочено', overdue)}{listSection(scope === 'today' ? 'Сегодня' : heading, regular)}</>}
          {view === 'kanban' && <div className="kanban">{Object.entries(statusLabels).map(([status, label]) => <section className="kanban-column" key={status} aria-label={label} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const task = visible.find(item => item.id === event.dataTransfer.getData('text/relay-task')); if (task) void changeStatus(task, status as Task['status']); }}><h3>{label} · {visible.filter(task => task.status === status).length}</h3>{visible.filter(task => task.status === status).map(task => <div className="kanban-task" key={task.id} draggable={!busy} onDragStart={event => event.dataTransfer.setData('text/relay-task', task.id)}><button onClick={() => openDetails(task)}><strong>{task.title}</strong><small>{shortDeadline(task)} · {categoryLabels[task.category]}</small></button><select aria-label={'Статус: ' + task.title} className="field" value={task.status} disabled={busy} onChange={event => void changeStatus(task, event.target.value as Task['status'])}>{Object.entries(statusLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></div>)}</section>)}</div>}
          {view === 'calendar' && <section className="calendar-view" aria-label="Календарь задач"><div className="calendar-month-nav"><button className="icon-btn" aria-label="Предыдущий месяц" onClick={() => changeMonth(-1)}>‹</button><h2>{new Date(month + '-15T12:00:00').toLocaleDateString('ru-RU', {month:'long',year:'numeric'})}</h2><button className="icon-btn" aria-label="Следующий месяц" onClick={() => changeMonth(1)}>›</button><button className="btn secondary small" onClick={() => { setMonth(today.slice(0,7)); setSelectedDate(today); }}>Сегодня</button></div><div className="calendar-grid" role="group" aria-label="Выбрать день">{['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(day=><span className="calendar-weekday" key={day}>{day}</span>)}{days.map(date=>{const count=calendarItems.filter(task=>taskCalendarDate(task,timezone)===date).length;return <button key={date} className={'calendar-date ' + (!date.startsWith(month)?'outside ':'') + (date===today?'is-today ':'')} aria-label={new Date(date+'T12:00:00').toLocaleDateString('ru-RU') + (count ? ', задач: '+count : '')} aria-pressed={selectedDate===date} onClick={()=>setSelectedDate(date)}><span>{Number(date.slice(-2))}</span>{count>0&&<small>{count}<span className="sr-only"> задач</span></small>}</button>;})}</div><section className="calendar-day-records" aria-label="Задачи выбранного дня"><h2>{new Date(selectedDate+'T12:00:00').toLocaleDateString('ru-RU',{day:'numeric',month:'long',weekday:'long'})}</h2>{calendarItems.filter(task=>taskCalendarDate(task,timezone)===selectedDate).map(row)}{!calendarItems.some(task=>taskCalendarDate(task,timezone)===selectedDate)&&<p className="muted">На этот день задач нет.</p>}</section></section>}          {view !== 'calendar' && !loading && !visible.length && <p className="task-empty">Нет задач для выбранных условий.</p>}
          {view !== 'calendar' && <details className="task-rare" onToggle={event => { if (event.currentTarget.open) { setShowLegacy(true); void api.legacyTasks().then(page => setLegacy(page.items)).catch(report); } else setShowLegacy(false); }}><summary>Старые чекбоксы → задачи со сроком</summary>{legacy.map(old => <div className="legacy-task" key={old.path + ':' + old.line}><p>{old.completed ? '☑' : '☐'} {old.title}<small>{old.path}:{old.line + 1}</small></p><button className="btn secondary small" onClick={() => start(undefined, old)}>Указать срок и преобразовать</button></div>)}{showLegacy && !legacy.length && <p className="muted">Старых чекбоксов нет.</p>}</details>}
          {!!invalid.length && <details className="task-rare"><summary>Не удалось прочитать заметки: {invalid.length}</summary>{invalid.map(result => <p className="muted" key={result.path}>{result.path}: {result.error}</p>)}</details>}
        </div>
      </div>
    </div>
    {(showForm || selected) && <dialog ref={dialogRef} className="editor-overlay task-modal" data-od-id="task-editor-overlay" onCancel={event => event.preventDefault()}><div className="editor-backdrop" onClick={() => { if (!busy && (!showForm || confirm('Закрыть черновик без сохранения?'))) { setShowForm(false); setSelected(null); } }} /><div className="editor-dialog task-detail-dialog" ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={showForm ? editing ? 'Редактирование задачи' : 'Новая задача' : 'Подробности задачи'}>
      {error && <div className="error" role="alert">{error}</div>}
      {selected && !showForm ? <><div className="editor-heading"><h2>{selected.title}</h2><button className="icon-btn" aria-label="Закрыть" onClick={() => setSelected(null)}><Icon name="close" /></button></div><p className="task-detail-deadline">{fullDeadline(selected)}</p>{selected.description && <p className="task-detail-description">{selected.description}</p>}<dl className="task-detail-meta"><dt>Категория</dt><dd>{categoryLabels[selected.category]}</dd><dt>Приоритет</dt><dd>{priorityLabels[selected.priority]}</dd><dt>Метки</dt><dd>{selected.tags.join(', ') || '—'}</dd><dt>Ключевые слова</dt><dd>{selected.keywords.join(', ') || '—'}</dd></dl><label>Статус<select className="field" value={selected.status} disabled={busy} onChange={event => void changeStatus(selected, event.target.value as Task['status'])}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><div className="task-detail-actions"><button className="btn secondary" onClick={() => setSelected(null)}>Закрыть</button><button className="btn" disabled={busy} onClick={() => start(selected)}>Редактировать</button></div></> : <form ref={formRef} className="task-form" onSubmit={save} data-od-id="task-editor"><div className="editor-heading"><h2>{editing ? 'Редактирование задачи' : source ? 'Преобразование старой задачи' : 'Новая задача'}</h2><button type="button" className="icon-btn" aria-label="Закрыть" disabled={busy} onClick={() => { if (confirm('Закрыть черновик без сохранения?')) setShowForm(false); }}><Icon name="close" /></button></div>{source && <p className="muted">Исходный текст сохранится в {source.path}; новая задача получит обязательный срок.</p>}{conflict && <div className="error" role="alert">Задача изменилась. Ваш черновик сохранён.<p>Актуально: {conflict.title} · {fullDeadline(conflict)}</p><pre>{conflict.description}</pre><button type="button" className="btn secondary small" onClick={() => { setEditing(conflict); setForm(taskForm(conflict)); setConflict(null); }}>Загрузить актуальную версию</button><button type="button" className="btn secondary small" onClick={() => { setEditing(conflict); setConflict(null); }}>Сохранить мой черновик поверх этой версии</button></div>}<fieldset disabled={busy || !!conflict}><label>Задача<textarea className="field" required placeholder="Что нужно сделать?" rows={4} maxLength={100000} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label><label>Категория<select className="field" value={form.category} onChange={event => setForm({ ...form, category: event.target.value as Category })}>{Object.entries(categoryLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>Приоритет<select className="field" value={form.priority} onChange={event => setForm({ ...form, priority: event.target.value as Priority })}>{Object.entries(priorityLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>Срок<select className="field" value={form.kind} onChange={event => setForm({ ...form, kind: event.target.value as typeof form.kind })}><option value="by_date">До даты включительно</option><option value="by_time">До указанного времени</option><option value="at_time">В указанное время</option></select></label><label>Дата<input className="field" type="date" required value={form.date} onChange={event => setForm({ ...form, date: event.target.value })} /></label>{form.kind !== 'by_date' && <label>Время<input className="field" type="time" required value={form.time} onChange={event => setForm({ ...form, time: event.target.value })} /></label>}<button className="btn" data-od-id="save-task">{busy ? 'Сохраняю…' : 'Сохранить'}</button></fieldset></form>}
    </div></dialog>}
  </div>;
}
