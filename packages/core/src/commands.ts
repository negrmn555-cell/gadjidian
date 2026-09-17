/**
 * Built-in slash commands. Each expands a short user input into a full instruction for the agent.
 * `direct` commands are executed without the LLM at all (fast path).
 */
export interface SlashCommand {
  name: string;
  /** Russian label shown in the app. */
  label: string;
  group: 'write' | 'read';
  /** Hint shown for the argument. */
  hint?: string;
  /** If true the command is handled by code (no LLM). */
  direct?: 'quick' | 'daily' | 'task' | 'show' | 'last' | 'today_tasks';
  /** Build the prompt for the LLM. */
  prompt?: (arg: string) => string;
}

export const slashCommands: SlashCommand[] = [
  // ---- write ----
  { name: 'quick', label: 'Быстрая заметка', group: 'write', hint: 'текст', direct: 'quick' },
  { name: 'daily', label: 'Строка в сегодняшний день', group: 'write', hint: 'текст', direct: 'daily' },
  { name: 'task', label: 'Задача', group: 'write', hint: 'что сделать', direct: 'task' },
  {
    name: 'idea',
    label: 'Мысль со связями',
    group: 'write',
    hint: 'мысль',
    prompt: (a) =>
      `Сохрани эту мысль как новую заметку во входящих. Придумай краткий заголовок, оформи текст, ` +
      `найди 2-4 существующие заметки по теме (search_notes) и добавь в конец раздел "## Связано" со ссылками вида [[Название]]. ` +
      `Мысль: ${a}`,
  },
  {
    name: 'meeting',
    label: 'Разговор',
    group: 'write',
    hint: 'с кем и о чём',
    prompt: (a) =>
      `Создай заметку о разговоре/встрече. Заголовок: "Разговор — <с кем> — <дата>". Разделы: Участники, О чём говорили, Решения, Следующие шаги (как чекбоксы). Исходный текст: ${a}`,
  },
  {
    name: 'person',
    label: 'Про человека',
    group: 'write',
    hint: 'имя и факты',
    prompt: (a) =>
      `Найди заметку об этом человеке (search_notes по имени). Если есть — допиши новые факты под заголовком "## Заметки" с датой. ` +
      `Если нет — создай заметку с именем человека как заголовком, разделами "## Кто это", "## Заметки". Текст: ${a}`,
  },
  {
    name: 'link',
    label: 'Ссылка на потом',
    group: 'write',
    hint: 'URL и комментарий',
    prompt: (a) =>
      `Сохрани ссылку во входящих. Заголовок — по смыслу ссылки или комментария. В теле: сама ссылка, комментарий, тег #на-потом. Текст: ${a}`,
  },
  {
    name: 'quote',
    label: 'Цитата',
    group: 'write',
    hint: 'цитата — автор',
    prompt: (a) =>
      `Сохрани цитату как новую заметку во входящих. Заголовок — первые слова цитаты. В теле: цитата блоком "> ", строка "— автор/источник" если указан, тег #цитата. Текст: ${a}`,
  },
  // ---- read ----
  { name: 'show', label: 'Показать заметку', group: 'read', hint: 'название', direct: 'show' },
  {
    name: 'section',
    label: 'Раздел из заметки',
    group: 'read',
    hint: 'заметка / раздел',
    prompt: (a) => `Открой заметку и верни дословно только указанный раздел (по заголовку). Запрос: ${a}`,
  },
  { name: 'last', label: 'Последняя заметка', group: 'read', direct: 'last' },
  { name: 'today', label: 'Задачи на сегодня', group: 'read', direct: 'today_tasks' },
  {
    name: 'continue',
    label: 'С чего продолжить',
    group: 'read',
    prompt: () =>
      `Посмотри последние заметки за 3 дня (recent_notes, read_daily за сегодня и вчера) и предложи 3 конкретных пункта, с чего продолжить работу. Кратко.`,
  },
  {
    name: 'undone',
    label: 'Что не доделано',
    group: 'read',
    prompt: () => `Собери открытые задачи за последние 7 дней (list_tasks) и сгруппируй по темам. Отметь просроченное. Кратко.`,
  },
  {
    name: 'inbox',
    label: 'Разобрать входящие',
    group: 'read',
    prompt: () =>
      `Покажи список заметок во входящих (list_folder), для каждой — одну строку сути и предложение куда её переместить или что с ней сделать. Ничего не перемещай сам.`,
  },
  {
    name: 'day',
    label: 'Итоги дня',
    group: 'read',
    prompt: () => `Прочитай сегодняшнюю ежедневную заметку и заметки, изменённые сегодня. Напиши краткие итоги дня: что сделано, что осталось, о чём думал.`,
  },
  {
    name: 'week',
    label: 'Итоги недели',
    group: 'read',
    prompt: () =>
      `Прочитай ежедневные заметки за 7 дней (read_daily для каждой даты) и заметки, изменённые за неделю (recent_notes). Напиши итоги недели: сделано, не доделано, идеи, главное.`,
  },
  {
    name: 'thinking',
    label: 'О чём я думал последние дни',
    group: 'read',
    prompt: () => `Посмотри заметки за 5 дней (recent_notes и ежедневные) и опиши 3-5 тем, которые меня занимали, с ссылками на заметки.`,
  },
  {
    name: 'habits',
    label: 'Привычки',
    group: 'read',
    prompt: () =>
      `Найди в ежедневных заметках за 14 дней отметки привычек (чекбоксы, поля вида "привычка:: да/нет", эмодзи-трекеры) и покажи таблицу выполнения по дням.`,
  },
  { name: 'find', label: 'Найти в заметках', group: 'read', hint: 'что искать', prompt: (a) => `Найди в заметках: ${a}. Перечисли подходящие заметки с одной строкой пояснения каждая.` },
];

export function findSlashCommand(name: string): SlashCommand | undefined {
  const n = name.toLowerCase().replace(/^\//, '');
  return slashCommands.find((c) => c.name === n);
}

/** Parse "/cmd rest of text" -> { command, arg }. Returns null for plain text. */
export function parseSlash(input: string): { command: SlashCommand; arg: string } | null {
  const m = /^\/([a-zA-Z_]+)\s*([\s\S]*)$/.exec(input.trim());
  if (!m) return null;
  const command = findSlashCommand(m[1]);
  if (!command) return null;
  return { command, arg: m[2].trim() };
}
